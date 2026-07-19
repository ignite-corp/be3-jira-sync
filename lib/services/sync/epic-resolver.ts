// 소스 부모 에픽 → HMG 타겟 프로젝트 에픽 매칭 또는 신규 생성 + 상태 동기화
//
// 룰 (해석 우선순위):
//   1) 소스 에픽의 link field(프로필 link_field)에 타겟 프로젝트 키 패턴이 있으면 그 키 재사용
//      (타겟에 실제 존재하는지 확인, 조회 실패 시 경고 후 2)로 폴백)
//   2) target summary = "[{소스 프로젝트 키}] " + 소스 부모 summary (이미 해당 prefix면 그대로)
//      (프로필 use_epic_prefix가 false면 말머리 없이 소스 summary 그대로 사용)
//      대상 프로젝트에서 동일 summary 에픽이 있으면 그 키 사용
//   3) 없으면 신규 생성 (summary + description + duedate; assignee는 비워둠)
//   - 2)/3)으로 정해지면 소스 에픽의 link field에 타겟 에픽 browse URL을 write-back
//     (URL 타입 필드라 값 1개만 저장 — 비어 있을 때만 기록, 실패해도 동기화는 계속)
//   - 동일 에픽에 대한 동시 요청은 단일 Promise로 합침 (중복 생성 방지)
//   - 매칭/생성 완료 후 소스 부모 에픽의 상태를 대상 에픽에도 동기화 (세션당 1회)
//   - 대상 에픽이 closed(statusCategory.key === 'done') 상태면 transition 스킵 (보호 정책)

import { jira } from '@/lib/services/jira';
import { JIRA_ENDPOINTS } from '@/lib/constants/jira';
import { SyncLogger } from './logger';
import { stripAdfMediaNodes } from './field-mapper';
import { syncStatusWithPathFromDb } from './transition-helper';

const DEFAULT_EPIC_ISSUETYPE_ID = '10000'; // HMG Jira "에픽" 기본 id (프로젝트별 조회 실패 시 폴백)

export interface SourceParentInfo {
  key: string;
  summary: string;
}

// 대상 프로젝트 에픽 목록 캐시: projectKey → (exact summary → epic key)
const targetEpicsCache = new Map<string, Map<string, string>>();

// 대상 프로젝트별 에픽 이슈타입 id 캐시
const epicIssueTypeCache = new Map<string, string>();

// 매칭/생성 중복 방지: `${targetProjectKey}::${sourceEpicKey}` → in-flight Promise
const pendingResolves = new Map<string, Promise<string | null>>();

// summary 매칭/생성 구간 dedup: `${targetProjectKey}::${targetSummary}` → in-flight Promise
// (소스 에픽 키는 다르지만 summary가 같은 동시 호출의 중복 생성 방지 — 기존 dedup 체계 유지)
const pendingSummaryResolves = new Map<string, Promise<string | null>>();

// 소스 에픽 link field 값 캐시: `${sourceEpicKey}::${linkField}` → 필드 값 (빈 값은 '', 조회 실패는 null)
const sourceEpicLinkValueCache = new Map<string, string | null>();

// link field write-back 직렬화: `${sourceEpicKey}::${linkField}` → 마지막 write Promise
// (한 소스 에픽이 여러 타겟 프로젝트로 동시에 동기화될 때 read-modify-write 유실 방지)
const linkWriteBackChains = new Map<string, Promise<void>>();

// 상태 동기화 dedup: 세션당 동일 target epic 1회만 transition
const syncedStatusEpicKeys = new Set<string>();

export function clearEpicCache() {
  targetEpicsCache.clear();
  epicIssueTypeCache.clear();
  pendingResolves.clear();
  pendingSummaryResolves.clear();
  sourceEpicLinkValueCache.clear();
  linkWriteBackChains.clear();
  syncedStatusEpicKeys.clear();
}

function buildTargetEpicSummary(
  sourceParentSummary: string,
  sourceProjectKey: string,
  usePrefix: boolean
): string {
  const trimmed = sourceParentSummary.trim();
  if (!usePrefix) return trimmed;
  const prefix = `[${sourceProjectKey}]`;
  return trimmed.startsWith(prefix) ? trimmed : `${prefix} ${trimmed}`;
}

/**
 * link field 원시 값을 문자열로 정규화 (string / array / { value } 형태 지원)
 */
function normalizeLinkFieldValue(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) return raw[0] ? String(raw[0]).trim() : '';
  if (raw && typeof raw === 'object' && 'value' in raw) {
    return String((raw as { value?: unknown }).value ?? '').trim();
  }
  return '';
}

/**
 * 소스 에픽의 link field 값 조회 (같은 실행 내 재조회 방지 캐시)
 * @returns 필드 값 (빈 값은 ''), 조회 실패 시 null
 */
async function getSourceEpicLinkValue(
  sourceEpicKey: string,
  linkField: string,
  logger: SyncLogger
): Promise<string | null> {
  const cacheKey = `${sourceEpicKey}::${linkField}`;
  const cached = sourceEpicLinkValueCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let value: string | null = null;
  const result = await jira.ignite.getIssue(sourceEpicKey, [linkField]);
  if (result.success && result.data) {
    value = normalizeLinkFieldValue(
      (result.data.fields as Record<string, unknown>)[linkField]
    );
  } else {
    logger.warning(
      `${sourceEpicKey}: 링크 필드(${linkField}) 조회 실패 - summary 매칭으로 진행`
    );
  }
  sourceEpicLinkValueCache.set(cacheKey, value);
  return value;
}

/**
 * 소스 에픽 link field에 저장된 타겟 에픽 키 해석 (우선순위 1)
 * - 값에 `<targetProjectKey>-\d+` 패턴이 있으면 그 키를 재사용
 * - 타겟에 실제 존재하는지 확인, 조회 실패 시 null 반환 (summary 매칭으로 폴백)
 */
async function resolveEpicByLinkField(
  sourceEpicKey: string,
  targetProjectKey: string,
  linkField: string,
  logger: SyncLogger
): Promise<string | null> {
  const value = await getSourceEpicLinkValue(sourceEpicKey, linkField, logger);
  if (!value) return null;

  const match = value.match(new RegExp(`(${targetProjectKey}-\\d+)`));
  if (!match) return null;
  const candidateKey = match[1];

  const check = await jira.hmg.getIssue(candidateKey, ['summary']);
  if (!check.success || !check.data) {
    logger.warning(
      `${sourceEpicKey}: 링크 필드의 ${candidateKey} 조회 실패 (${check.error ?? '알 수 없음'}) - summary 매칭으로 폴백`
    );
    return null;
  }

  logger.info(
    `에픽 링크 매칭: ${sourceEpicKey} → ${candidateKey} (링크 필드)`
  );
  return candidateKey;
}

/**
 * summary 매칭/생성으로 정해진 타겟 에픽의 browse URL을 소스 에픽 link field에 write-back
 * - 기존 값에 이 타겟 프로젝트 키 패턴이 이미 있으면 덮어쓰지 않음
 * - URL 타입 필드라 값 1개만 허용 — 다른 값이 이미 있으면 기록 스킵
 * - 실패해도 동기화는 실패시키지 않음 (경고 로그만)
 * - 동일 소스 에픽에 대한 write는 Promise 체인으로 직렬화
 */
function writeBackEpicLink(
  sourceEpicKey: string,
  targetEpicKey: string,
  targetProjectKey: string,
  linkField: string,
  logger: SyncLogger
): Promise<void> {
  const cacheKey = `${sourceEpicKey}::${linkField}`;
  const prev = linkWriteBackChains.get(cacheKey) ?? Promise.resolve();

  const next = prev.then(async () => {
    try {
      const existing = await getSourceEpicLinkValue(
        sourceEpicKey,
        linkField,
        logger
      );
      // 조회 실패(null) 시 기존 값을 알 수 없으므로 덮어쓰기 방지를 위해 기록 스킵
      if (existing === null) {
        logger.warning(
          `${sourceEpicKey}: 기존 링크 필드 값 확인 불가 - ${targetEpicKey} 기록 스킵 (동기화는 계속)`
        );
        return;
      }
      // 기존 값에 이 타겟 프로젝트의 키가 이미 있으면 기록하지 않음
      if (new RegExp(`${targetProjectKey}-\\d+`).test(existing)) return;

      // URL 타입 필드라 값 1개만 허용 — 다른 타겟의 링크가 이미 있으면 기록 스킵
      if (existing) {
        logger.warning(
          `${sourceEpicKey}: 링크 필드(${linkField})에 다른 값이 이미 있어 ${targetEpicKey} 기록 스킵 (URL 필드는 1개만 저장 가능)`
        );
        return;
      }
      const newValue = `${JIRA_ENDPOINTS.HMG}/browse/${targetEpicKey}`;
      const result = await jira.ignite.updateIssueFields(sourceEpicKey, {
        [linkField]: newValue,
      });
      if (result.success) {
        sourceEpicLinkValueCache.set(cacheKey, newValue);
        logger.info(
          `${sourceEpicKey}: 링크 필드(${linkField})에 ${targetEpicKey} 기록 완료`
        );
      } else {
        logger.warning(
          `${sourceEpicKey}: 링크 필드(${linkField}) 기록 실패 (동기화는 계속) - ${result.error ?? '알 수 없음'}`
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warning(
        `${sourceEpicKey}: 링크 필드(${linkField}) 기록 실패 (동기화는 계속) - ${msg}`
      );
    }
  });

  linkWriteBackChains.set(cacheKey, next);
  return next;
}

/**
 * 대상 프로젝트의 에픽 이슈타입 id 조회 (이름 "에픽"/"Epic" 매칭, 폴백 10000)
 */
async function resolveEpicIssueTypeId(projectKey: string): Promise<string> {
  const cached = epicIssueTypeCache.get(projectKey);
  if (cached) return cached;

  let id = DEFAULT_EPIC_ISSUETYPE_ID;
  try {
    const projectResult = await jira.hmg.getProject(projectKey);
    const issueTypes = (projectResult.data as unknown as { issueTypes?: unknown })
      ?.issueTypes as Array<{ id: string; name: string }> | undefined;
    const epicType = issueTypes?.find(
      (t) => t.name === '에픽' || t.name.toLowerCase() === 'epic'
    );
    if (epicType) id = epicType.id;
  } catch {
    // 폴백 유지
  }
  epicIssueTypeCache.set(projectKey, id);
  return id;
}

async function loadTargetEpics(
  projectKey: string,
  logger: SyncLogger
): Promise<Map<string, string>> {
  const cached = targetEpicsCache.get(projectKey);
  if (cached) return cached;

  const epicIssueTypeId = await resolveEpicIssueTypeId(projectKey);
  // 페이지네이션 자동 처리
  const jql = `project = ${projectKey} AND issuetype = ${epicIssueTypeId}`;
  const result = await jira.hmg.searchAllIssues(jql, ['summary']);

  const map = new Map<string, string>();
  if (result.success && result.data) {
    for (const issue of result.data.issues) {
      // 비교 키는 trim해서 사용 — 소스 summary도 trim되므로 앞뒤 공백 차이로 중복 생성되지 않도록
      const summaryKey = issue.fields.summary.trim();
      // 중복 summary가 있으면 먼저 등장한(=최근 생성된) 키 유지
      if (!map.has(summaryKey)) {
        map.set(summaryKey, issue.key);
      }
    }
    logger.info(`${projectKey} 에픽 목록 로드 (${map.size}개)`);
  } else {
    logger.warning(`${projectKey} 에픽 목록 로드 실패: ${result.error}`);
  }

  targetEpicsCache.set(projectKey, map);
  return map;
}

async function createTargetEpic(
  sourceParentKey: string,
  targetProjectKey: string,
  targetSummary: string,
  logger: SyncLogger
): Promise<string | null> {
  // 소스 부모 에픽의 description/duedate 조회
  const detail = await jira.ignite.getIssue(sourceParentKey, [
    'summary',
    'description',
    'duedate',
  ]);
  if (!detail.success || !detail.data) {
    logger.warning(`소스 부모 ${sourceParentKey} 조회 실패 - 에픽 생성 스킵`);
    return null;
  }
  const pf = detail.data.fields;

  const extra: Record<string, unknown> = {};
  if (pf.description) {
    extra.description = stripAdfMediaNodes(pf.description);
  }
  if (pf.duedate) {
    extra.duedate = pf.duedate;
  }
  // assignee는 비워둠 (사용자 결정)

  const epicIssueTypeId = await resolveEpicIssueTypeId(targetProjectKey);
  const result = await jira.hmg.createIssue({
    fields: {
      project: { key: targetProjectKey },
      issuetype: { id: epicIssueTypeId },
      summary: targetSummary,
      ...extra,
    },
  });
  if (!result.success || !result.data) {
    const details = (result as { details?: unknown }).details;
    logger.error(
      `에픽 생성 실패 (${targetProjectKey} "${targetSummary}"): ${result.error}` +
        (details ? ` / ${JSON.stringify(details)}` : '')
    );
    return null;
  }

  logger.success(
    `에픽 신규 생성: ${result.data.key} "${targetSummary}" (소스 ${sourceParentKey} 기준)`
  );
  return result.data.key;
}

/**
 * 소스 부모 에픽 상태를 대상 에픽으로 동기화 (세션당 1회)
 * - 대상 에픽이 closed(statusCategory.key === 'done')면 보호 정책으로 스킵
 * - 런타임 BFS로 multi-step transition 처리
 */
async function syncEpicStatus(
  sourceParentKey: string,
  targetEpicKey: string,
  syncProfileId: string | undefined,
  logger: SyncLogger
): Promise<void> {
  if (syncedStatusEpicKeys.has(targetEpicKey)) return;
  syncedStatusEpicKeys.add(targetEpicKey);

  if (!syncProfileId) {
    logger.info(`${targetEpicKey}: 동기화 프로필 없음 - 에픽 상태 동기화 스킵`);
    return;
  }

  try {
    // 1. 소스 부모 에픽 상태 조회
    const sourceEpic = await jira.ignite.getIssue(sourceParentKey, ['status']);
    if (!sourceEpic.success || !sourceEpic.data) {
      logger.warning(`소스 부모 ${sourceParentKey} 상태 조회 실패 - 에픽 상태 동기화 스킵`);
      return;
    }
    const sourceStatusId = sourceEpic.data.fields.status?.id;
    if (!sourceStatusId) return;

    // 2. 대상 에픽 현재 상태 조회 (statusCategory까지)
    const targetEpic = await jira.hmg.getIssue(targetEpicKey, ['status']);
    if (!targetEpic.success || !targetEpic.data) {
      logger.warning(`${targetEpicKey} 상태 조회 실패 - 에픽 상태 동기화 스킵`);
      return;
    }
    const targetStatus = targetEpic.data.fields.status as
      | {
          id?: string;
          name?: string;
          statusCategory?: { key?: string };
        }
      | undefined;
    const currentStatusId = targetStatus?.id;
    if (!currentStatusId) return;

    // 3. 보호 정책: 대상 에픽이 이미 closed면 덮어쓰지 않음
    if (targetStatus?.statusCategory?.key === 'done') {
      logger.info(
        `${targetEpicKey}: 이미 완료 상태(${targetStatus.name}) - 에픽 상태 동기화 스킵`
      );
      return;
    }

    // 4. transition 실행 (runtime BFS — 에픽 워크플로우의 multi-step 자동 처리)
    const executeTransitionFn = async (
      issueKey: string,
      transitionId: string
    ) => {
      return await jira.hmg.updateIssueStatus(issueKey, transitionId);
    };
    const getTransitionsFn = async (issueKey: string) => {
      const res = await jira.hmg.getIssueTransitions(issueKey);
      if (res.success && res.data) {
        return (
          (res.data as {
            transitions: Array<{ id: string; to: { id: string; name: string } }>;
          }).transitions || []
        );
      }
      return [];
    };

    await syncStatusWithPathFromDb(
      syncProfileId,
      targetEpicKey,
      sourceStatusId,
      currentStatusId,
      executeTransitionFn,
      logger,
      getTransitionsFn
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warning(`${targetEpicKey}: 에픽 상태 동기화 실패 - ${msg}`);
  }
}

/**
 * summary 완전일치 매칭 또는 신규 생성 (우선순위 2/3)
 * - `${targetProjectKey}::${targetSummary}` 단위 dedup으로 동시 호출 시 중복 생성 방지
 */
function resolveEpicBySummary(
  sourceParentKey: string,
  targetProjectKey: string,
  targetSummary: string,
  logger: SyncLogger
): Promise<string | null> {
  const dedupKey = `${targetProjectKey}::${targetSummary}`;
  const inflight = pendingSummaryResolves.get(dedupKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const targetEpics = await loadTargetEpics(targetProjectKey, logger);
    const existing = targetEpics.get(targetSummary);
    if (existing) {
      logger.info(
        `에픽 매칭: ${sourceParentKey} → ${existing} "${targetSummary}"`
      );
      return existing;
    }

    const newKey = await createTargetEpic(
      sourceParentKey,
      targetProjectKey,
      targetSummary,
      logger
    );
    if (newKey) {
      targetEpics.set(targetSummary, newKey);
    }
    return newKey;
  })();

  pendingSummaryResolves.set(dedupKey, promise);
  return promise;
}

/**
 * 소스 부모 에픽에 대응하는 대상 프로젝트 에픽 키를 반환.
 * 해석 우선순위:
 *   1) linkField가 있으면 소스 에픽의 link field에 저장된 타겟 키 재사용
 *   2) summary 완전일치 매칭
 *   3) 신규 생성
 * 2)/3)으로 정해지면 linkField에 타겟 키를 write-back (기록 실패는 경고만).
 * 동시 호출은 단일 Promise로 dedup. 반환 후 상태 동기화도 수행 (세션당 1회).
 */
export async function ensureTargetEpic(
  sourceParent: SourceParentInfo,
  targetProjectKey: string,
  logger: SyncLogger,
  syncProfileId?: string,
  usePrefix: boolean = true,
  linkField: string | null = null
): Promise<string | null> {
  // 소스 프로젝트 키는 부모 에픽 키에서 유도 (예: "BE3-2" → "BE3")
  const sourceProjectKey = sourceParent.key.split('-')[0];
  const targetSummary = buildTargetEpicSummary(
    sourceParent.summary,
    sourceProjectKey,
    usePrefix
  );
  const dedupKey = `${targetProjectKey}::${sourceParent.key}`;

  const inflight = pendingResolves.get(dedupKey);
  if (inflight) {
    const key = await inflight;
    if (key) await syncEpicStatus(sourceParent.key, key, syncProfileId, logger);
    return key;
  }

  const promise = (async () => {
    // 1) link field 우선 매칭
    if (linkField) {
      const linkedKey = await resolveEpicByLinkField(
        sourceParent.key,
        targetProjectKey,
        linkField,
        logger
      );
      if (linkedKey) return linkedKey;
    }

    // 2) summary 매칭 → 3) 신규 생성
    const resolvedKey = await resolveEpicBySummary(
      sourceParent.key,
      targetProjectKey,
      targetSummary,
      logger
    );

    // write-back: 2)/3)으로 정해진 키를 소스 에픽 link field에 기록
    if (resolvedKey && linkField) {
      await writeBackEpicLink(
        sourceParent.key,
        resolvedKey,
        targetProjectKey,
        linkField,
        logger
      );
    }
    return resolvedKey;
  })();

  pendingResolves.set(dedupKey, promise);
  const key = await promise;
  if (key) await syncEpicStatus(sourceParent.key, key, syncProfileId, logger);
  return key;
}
