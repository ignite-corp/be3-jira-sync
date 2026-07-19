/**
 * 동적 상태 전이(Transition) 헬퍼
 * DB sync_profile 매핑 기반으로 소스 상태 → 타겟 상태 전이를 수행
 * BFS를 사용하여 현재 상태에서 타겟 상태까지의 최단 경로를 찾아 순차 실행
 */

import { dbServer } from '@/lib/db';

export type JiraInstance = 'ignite' | 'hmg';

// DB 기반 캐시 (동기화 세션 동안 유지)
const dbStatusMappingCache = new Map<string, Record<string, string>>();
const dbWorkflowCache = new Map<string, Record<string, Record<string, string>>>();

export function clearTransitionCache() {
  dbStatusMappingCache.clear();
  dbWorkflowCache.clear();
}

/**
 * DB에서 프로필별 상태 매핑 조회 (캐시)
 */
async function getDbStatusMapping(profileId: string): Promise<Record<string, string>> {
  if (dbStatusMappingCache.has(profileId)) {
    return dbStatusMappingCache.get(profileId)!;
  }

  const { data } = await dbServer
    .from('sync_profile_status_mappings')
    .select('source_status_id, target_status_id')
    .eq('profile_id', profileId);

  const mapping: Record<string, string> = {};
  data?.forEach((row) => {
    mapping[row.source_status_id] = row.target_status_id;
  });

  dbStatusMappingCache.set(profileId, mapping);
  return mapping;
}

/**
 * DB에서 프로필별 워크플로우 그래프 조회 (캐시)
 */
async function getDbWorkflow(profileId: string): Promise<Record<string, Record<string, string>>> {
  if (dbWorkflowCache.has(profileId)) {
    return dbWorkflowCache.get(profileId)!;
  }

  const { data } = await dbServer
    .from('sync_profile_workflows')
    .select('from_status_id, to_status_id, transition_id')
    .eq('profile_id', profileId);

  const workflow: Record<string, Record<string, string>> = {};
  data?.forEach((row) => {
    if (!workflow[row.from_status_id]) {
      workflow[row.from_status_id] = {};
    }
    workflow[row.from_status_id][row.to_status_id] = row.transition_id;
  });

  dbWorkflowCache.set(profileId, workflow);
  return workflow;
}

/**
 * DB 기반 BFS 경로 탐색
 */
export async function findTransitionPathFromDb(
  profileId: string,
  currentStatusId: string,
  targetStatusId: string
): Promise<TransitionPath | null> {
  if (currentStatusId === targetStatusId) {
    return { statusPath: [], transitionPath: [] };
  }

  const workflow = await getDbWorkflow(profileId);

  const queue: Array<{ statusId: string; path: string[]; transitions: string[] }> = [
    { statusId: currentStatusId, path: [], transitions: [] },
  ];
  const visited = new Set<string>([currentStatusId]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const nextTransitions = workflow[current.statusId];
    if (!nextTransitions) continue;

    for (const [nextStatusId, transitionId] of Object.entries(nextTransitions)) {
      if (visited.has(nextStatusId)) continue;

      const newPath = [...current.path, nextStatusId];
      const newTransitions = [...current.transitions, transitionId];

      if (nextStatusId === targetStatusId) {
        return { statusPath: newPath, transitionPath: newTransitions };
      }

      visited.add(nextStatusId);
      queue.push({ statusId: nextStatusId, path: newPath, transitions: newTransitions });
    }
  }

  return null;
}

/**
 * DB 기반 상태 동기화 통합 함수
 * DB 워크플로우는 BFS 경로 탐색에만 사용하고,
 * 실제 transition 실행 시에는 Jira API로 available transitions를 조회하여
 * 목표 상태에 맞는 transition을 찾아 실행 (이슈 타입별 워크플로우 차이 대응)
 */
export async function syncStatusWithPathFromDb(
  profileId: string,
  issueKey: string,
  sourceStatusId: string,
  currentTargetStatusId: string,
  executeTransition: (issueKey: string, transitionId: string) => Promise<{ success: boolean; error?: string }>,
  logger?: { info: (msg: string) => void; error: (msg: string) => void; success: (msg: string) => void },
  getAvailableTransitions?: (issueKey: string) => Promise<Array<{ id: string; to: { id: string; name: string } }>>
): Promise<TransitionResult> {
  const mapping = await getDbStatusMapping(profileId);
  const targetStatusId = mapping[sourceStatusId] || null;

  if (!targetStatusId) {
    const error = `${sourceStatusId}: 매핑된 타겟 상태 없음 (DB)`;
    logger?.error(`${issueKey}: ${error}`);
    return { success: false, stepsExecuted: 0, error };
  }

  if (currentTargetStatusId === targetStatusId) {
    logger?.info(`${issueKey}: 이미 타겟 상태 (${targetStatusId})`);
    return { success: true, stepsExecuted: 0, finalStatusId: targetStatusId };
  }

  // getAvailableTransitions가 제공된 경우: 런타임 BFS (Jira API 기반)
  if (getAvailableTransitions) {
    return await runtimeBfsTransition(
      issueKey,
      currentTargetStatusId,
      targetStatusId,
      executeTransition,
      getAvailableTransitions,
      logger
    );
  }

  // 폴백: DB 정적 워크플로우 기반 BFS
  const path = await findTransitionPathFromDb(profileId, currentTargetStatusId, targetStatusId);

  if (!path) {
    const error = `${currentTargetStatusId} → ${targetStatusId}: 전이 경로 없음 (DB)`;
    logger?.error(`${issueKey}: ${error}`);
    return { success: false, stepsExecuted: 0, error };
  }

  logger?.info(
    `${issueKey}: 상태 전이 경로 발견 (${path.transitionPath.length}단계: ${path.transitionPath.join(' → ')})`
  );

  const result = await executeTransitionPath(issueKey, path.transitionPath, executeTransition);

  if (result.success) {
    logger?.success(`${issueKey}: 상태 동기화 완료 (${result.stepsExecuted}단계 실행)`);
  } else {
    logger?.error(`${issueKey}: 상태 동기화 실패 - ${result.error}`);
  }

  return result;
}

/**
 * 런타임 상태 전이: Jira API에서 available transitions를 조회하며
 * 타겟 상태까지 순차 전이 실행 (visited 추적으로 루프 방지)
 */
async function runtimeBfsTransition(
  issueKey: string,
  currentStatusId: string,
  targetStatusId: string,
  executeTransition: (issueKey: string, transitionId: string) => Promise<{ success: boolean; error?: string }>,
  getAvailableTransitions: (issueKey: string) => Promise<Array<{ id: string; to: { id: string; name: string } }>>,
  logger?: { info: (msg: string) => void; error: (msg: string) => void; success: (msg: string) => void },
  maxSteps: number = 10
): Promise<TransitionResult> {
  let stepsExecuted = 0;
  let currentStatus = currentStatusId;
  const visited = new Set<string>([currentStatusId]);

  for (let step = 0; step < maxSteps; step++) {
    const transitions = await getAvailableTransitions(issueKey);

    // 1. 직접 타겟으로 가는 transition 찾기
    const directTransition = transitions.find((t) => t.to.id === targetStatusId);
    if (directTransition) {
      logger?.info(
        `${issueKey}: 상태 전이 실행 (${currentStatus} → ${targetStatusId} "${directTransition.to.name}", transition=${directTransition.id})`
      );
      const result = await executeTransition(issueKey, directTransition.id);
      if (result.success) {
        stepsExecuted++;
        logger?.success(`${issueKey}: 상태 동기화 완료 (${stepsExecuted}단계 실행)`);
        return { success: true, stepsExecuted, finalStatusId: targetStatusId };
      } else {
        logger?.error(`${issueKey}: 상태 전이 실패 - ${result.error}`);
        return { success: false, stepsExecuted, error: result.error };
      }
    }

    // 2. 방문하지 않은 중간 상태로 이동
    const unvisitedTransitions = transitions.filter((t) => !visited.has(t.to.id));
    if (unvisitedTransitions.length === 0) {
      const error = `${currentStatus}: 타겟(${targetStatusId})으로 갈 수 있는 경로 없음 (방문 가능한 상태 소진)`;
      logger?.error(`${issueKey}: ${error}`);
      return { success: false, stepsExecuted, error };
    }

    const nextTransition = unvisitedTransitions[0];
    logger?.info(
      `${issueKey}: 중간 상태 전이 (${currentStatus} → ${nextTransition.to.id} "${nextTransition.to.name}", transition=${nextTransition.id})`
    );
    const result = await executeTransition(issueKey, nextTransition.id);
    if (!result.success) {
      logger?.error(`${issueKey}: 중간 상태 전이 실패 - ${result.error}`);
      return { success: false, stepsExecuted, error: result.error };
    }
    stepsExecuted++;
    currentStatus = nextTransition.to.id;
    visited.add(currentStatus);

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const error = `최대 전이 단계(${maxSteps}) 초과`;
  logger?.error(`${issueKey}: ${error}`);
  return { success: false, stepsExecuted, error };
}

interface TransitionPath {
  /** 거쳐야 할 상태 ID 목록 (현재 상태 제외, 타겟 상태 포함) */
  statusPath: string[];
  /** 실행해야 할 transition ID 목록 */
  transitionPath: string[];
}

interface TransitionResult {
  success: boolean;
  stepsExecuted: number;
  finalStatusId?: string;
  error?: string;
}

/**
 * 순차적으로 transition 실행
 * @param issueKey 이슈 키
 * @param transitionPath 실행할 transition ID 목록
 * @param executeTransition transition 실행 함수 (의존성 주입)
 * @param getCurrentStatus 현재 상태 조회 함수 (의존성 주입, 검증용)
 * @param delayMs 각 transition 사이 딜레이 (ms)
 */
export async function executeTransitionPath(
  issueKey: string,
  transitionPath: string[],
  executeTransition: (issueKey: string, transitionId: string) => Promise<{ success: boolean; error?: string }>,
  getCurrentStatus?: (issueKey: string) => Promise<string | null>,
  delayMs: number = 100
): Promise<TransitionResult> {
  if (transitionPath.length === 0) {
    return { success: true, stepsExecuted: 0 };
  }

  let stepsExecuted = 0;

  for (const transitionId of transitionPath) {
    try {
      const result = await executeTransition(issueKey, transitionId);

      if (!result.success) {
        return {
          success: false,
          stepsExecuted,
          error: result.error || `Transition ${transitionId} 실패`,
        };
      }

      stepsExecuted++;

      // 다음 transition 전 약간의 딜레이 (Jira API 안정성)
      if (stepsExecuted < transitionPath.length && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      return {
        success: false,
        stepsExecuted,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // 최종 상태 검증 (선택적)
  let finalStatusId: string | undefined;
  if (getCurrentStatus) {
    finalStatusId = (await getCurrentStatus(issueKey)) || undefined;
  }

  return {
    success: true,
    stepsExecuted,
    finalStatusId,
  };
}
