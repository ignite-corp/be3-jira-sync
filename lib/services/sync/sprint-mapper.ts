// 스프린트 매핑 로직 (캐싱 포함)

import { SprintInfo } from './types';
import { JiraClient } from '@/lib/services/jira/client';
import { dbServer } from '@/lib/db';

type JiraInstance = 'ignite' | 'hmg';

/**
 * 스프린트 캐시 클래스
 * 동기화 세션 동안 스프린트 목록을 캐싱하여 API 호출 최소화
 * 인스턴스별로 별도 클라이언트 사용 (Ignite/HMG)
 */
class SprintCache {
  private cache = new Map<string, SprintInfo[]>();
  private clients: Record<JiraInstance, JiraClient> = {
    ignite: new JiraClient('ignite'),
    hmg: new JiraClient('hmg'),
  };

  private cacheKey(instance: JiraInstance, boardId: number): string {
    return `${instance}:${boardId}`;
  }

  async getSprintsForBoard(
    boardId: number,
    instance: JiraInstance = 'ignite'
  ): Promise<SprintInfo[]> {
    const key = this.cacheKey(instance, boardId);
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const sprints = await this.fetchSprints(boardId, instance);
    this.cache.set(key, sprints);
    return sprints;
  }

  private async fetchSprints(
    boardId: number,
    instance: JiraInstance
  ): Promise<SprintInfo[]> {
    try {
      const result = await this.clients[instance].get<{
        values: Array<{
          id: number;
          name: string;
          state: 'active' | 'future' | 'closed';
        }>;
      }>(`agile/1.0/board/${boardId}/sprint`, {
        state: 'active,future',
        maxResults: '50',
      });

      if (result.success && result.data?.values) {
        return result.data.values.map((sprint) => ({
          ...sprint,
          boardId,
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  clear() {
    this.cache.clear();
  }
}

// 싱글톤 인스턴스
const sprintCache = new SprintCache();

// 프로젝트별 board_id + instance 캐시 (DB 조회 결과)
const boardInfoCache = new Map<string, { boardId: number; instance: JiraInstance }>();

async function getBoardInfo(
  projectKey: string
): Promise<{ boardId: number; instance: JiraInstance } | null> {
  if (boardInfoCache.has(projectKey)) {
    return boardInfoCache.get(projectKey)!;
  }

  const { data } = await dbServer
    .from('projects')
    .select('board_id, jira_instance')
    .eq('name', projectKey)
    .single();

  if (data?.board_id) {
    const info = {
      boardId: data.board_id,
      instance: (data.jira_instance === 'hmg' ? 'hmg' : 'ignite') as JiraInstance,
    };
    boardInfoCache.set(projectKey, info);
    return info;
  }
  return null;
}


/**
 * 소스 프로젝트 스프린트 이름에서 기간 추출
 * 예: "BE3 2604" → "2604"
 * 프로젝트명과 기간을 공백으로 구분
 */
function extractSprintPeriod(sprintName: string): string | null {
  const parts = sprintName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const period = parts[parts.length - 1];
  return /^\d+$/.test(period) ? period : null;
}

/**
 * 기간을 전체 연월 형식으로 변환
 * 예: "2511" → "202511"
 */
function convertToFullYearMonth(period: string): string {
  if (period.length === 4) {
    return '20' + period;
  }
  return period;
}

/**
 * 대상 프로젝트의 스프린트 이름 생성
 * 예: "GIDPDVO", "202511" → "GIDPDVO 202511"
 */
function buildTargetSprintName(projectKey: string, yearMonth: string): string {
  return `${projectKey} ${yearMonth}`;
}

/**
 * 소스 스프린트를 대상 프로젝트 스프린트로 매핑
 * 소스 스프린트 이름의 기간(YYMM/YYYYMM)을 추출해
 * "{대상 프로젝트 키} {YYYYMM}" 이름의 스프린트를 대상 보드에서 찾는다
 */
export async function mapSprintToTarget(
  sourceSprintName: string | null,
  targetProject: string
): Promise<number | null> {
  if (!sourceSprintName) return null;

  // 1. 소스 스프린트 이름에서 기간 추출
  const period = extractSprintPeriod(sourceSprintName);
  if (!period) return null;

  // 2. 전체 연월로 변환
  const fullYearMonth = convertToFullYearMonth(period);

  // 3. 대상 프로젝트 스프린트 이름 생성
  const targetSprintName = buildTargetSprintName(targetProject, fullYearMonth);

  // 4. 대상 보드의 스프린트 조회 (캐시 사용, 인스턴스별)
  const boardInfo = await getBoardInfo(targetProject);
  if (!boardInfo) return null;
  const targetSprints = await sprintCache.getSprintsForBoard(
    boardInfo.boardId,
    boardInfo.instance
  );

  // 5. 이름으로 매칭
  const matchedSprint = targetSprints.find(
    (sprint) => sprint.name === targetSprintName
  );

  return matchedSprint?.id || null;
}

/**
 * 캐시 초기화 (동기화 시작 시 호출)
 */
export function initSprintCache() {
  sprintCache.clear();
  boardInfoCache.clear();
}

/**
 * 스프린트 캐시 프리로드 (선택적)
 */
export async function preloadSprintCache(projects: string[]): Promise<void> {
  const infos = await Promise.all(projects.map((p) => getBoardInfo(p)));
  await Promise.all(
    infos
      .filter((info): info is { boardId: number; instance: JiraInstance } => info !== null)
      .map((info) => sprintCache.getSprintsForBoard(info.boardId, info.instance))
  );
}
