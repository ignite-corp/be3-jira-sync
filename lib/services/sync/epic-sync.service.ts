// 에픽 전용 동기화 서비스
// - 자식 티켓 sync와 독립적으로, DB sync_profile의 허용 에픽들을
//   HMG 타겟 프로젝트에 매칭/생성 + 상태 동기화 수행
// - 모드: all(모든 타겟) | 특정 타겟 프로젝트 키 | single(에픽 키 직접 지정)

import { JiraIssue } from '@/lib/types/jira';
import { dbServer } from '@/lib/db';
import { jira } from '@/lib/services/jira';
import { SyncLogger } from './logger';
import { ensureTargetEpic, clearEpicCache } from './epic-resolver';
import {
  clearDbMappingCache,
  getSyncProfileInfo,
  getAllowedEpicsFromDb,
  SyncProfileInfo,
} from './db-field-mapper';
import { clearTransitionCache } from './transition-helper';

// 'all' | 'single' | 특정 타겟 프로젝트 키 (예: 'GIDPDVO')
export type EpicSyncMode = 'all' | 'single' | (string & {});

export interface EpicSyncOptions {
  mode: EpicSyncMode;
  /** 'single' 모드일 때 필수 (예: "BE3-2") */
  epicKey?: string;
  /** 소스 프로젝트 키 (예: 'BE3'). 생략 시 DB 프로필에서 유도 */
  sourceProjectKey?: string;
}

export interface EpicSyncResult {
  sourceKey: string;
  sourceSummary: string;
  targetProject: string;
  targetKey: string | null;
  success: boolean;
  error?: string;
}

export interface EpicSyncSummary {
  totalProcessed: number;
  totalSuccess: number;
  totalFailed: number;
  results: EpicSyncResult[];
}

/**
 * 소스 프로젝트의 cross-instance(HMG 타겟) 프로필 목록 조회
 */
async function loadHmgProfiles(
  sourceProjectKey: string | undefined,
  logger: SyncLogger
): Promise<SyncProfileInfo[]> {
  const { data: profiles } = await dbServer
    .from('sync_profiles')
    .select('id, source:source_project_id(name)');
  if (!profiles) return [];

  const infos: SyncProfileInfo[] = [];
  for (const row of profiles) {
    const source = row.source as unknown as { name: string } | null;
    if (sourceProjectKey && source?.name !== sourceProjectKey) continue;
    const info = await getSyncProfileInfo(row.id);
    if (!info) continue;
    if (info.targetInstance !== 'hmg') continue;
    infos.push(info);
  }

  if (infos.length === 0) {
    logger.warning(
      `${sourceProjectKey ?? '(소스 미지정)'}: HMG 타겟 동기화 프로필이 없습니다`
    );
  }
  return infos;
}

async function fetchEpicIssue(
  epicKey: string,
  logger: SyncLogger
): Promise<JiraIssue | null> {
  const result = await jira.ignite.getIssue(epicKey, [
    'summary',
    'status',
    'description',
    'duedate',
  ]);
  if (!result.success || !result.data) {
    logger.error(`${epicKey} 조회 실패: ${result.error}`);
    return null;
  }
  return result.data;
}

export async function executeEpicSync(
  options: EpicSyncOptions,
  logger: SyncLogger
): Promise<EpicSyncSummary> {
  // 캐시 초기화 (동기화 세션 시작)
  clearEpicCache();
  clearDbMappingCache();
  clearTransitionCache();

  const results: EpicSyncResult[] = [];

  // HMG 타겟 프로필 로드
  let profiles = await loadHmgProfiles(options.sourceProjectKey, logger);
  if (options.mode !== 'all' && options.mode !== 'single') {
    // 특정 타겟 프로젝트 키 모드
    profiles = profiles.filter((p) => p.targetProjectKey === options.mode);
    if (profiles.length === 0) {
      logger.warning(`${options.mode}: 해당 타겟의 동기화 프로필 없음`);
      return emptySummary();
    }
  }
  if (profiles.length === 0) return emptySummary();

  // 처리할 (소스 에픽, 프로필) 페어 결정
  const pairs: Array<{ epic: JiraIssue; profile: SyncProfileInfo }> = [];

  if (options.mode === 'single') {
    if (!options.epicKey) {
      logger.error('단일 에픽 모드: epicKey 필요');
      return emptySummary();
    }
    const epic = await fetchEpicIssue(options.epicKey, logger);
    if (!epic) return emptySummary();

    for (const profile of profiles) {
      const allowedEpics = await getAllowedEpicsFromDb(profile.id);
      if (allowedEpics.length === 0 || allowedEpics.includes(epic.key)) {
        pairs.push({ epic, profile });
      }
    }
    if (pairs.length === 0) {
      logger.warning(
        `${options.epicKey}: 이 에픽을 허용하는 동기화 프로필 없음 (sync_profile_allowed_epics 확인)`
      );
      return emptySummary();
    }
  } else {
    // all 또는 특정 타겟: 각 프로필의 허용 에픽 목록 기반
    for (const profile of profiles) {
      const allowedEpics = await getAllowedEpicsFromDb(profile.id);
      if (allowedEpics.length === 0) {
        logger.warning(
          `${profile.name}: 허용 에픽 미등록 - 에픽 동기화 스킵 (sync_profile_allowed_epics에 등록 필요)`
        );
        continue;
      }
      logger.info(`${profile.name}: 허용 에픽 ${allowedEpics.length}개`);
      for (const epicKey of allowedEpics) {
        const epic = await fetchEpicIssue(epicKey, logger);
        if (epic) pairs.push({ epic, profile });
      }
    }
  }

  if (pairs.length === 0) {
    logger.warning('동기화 대상 에픽 없음');
    return emptySummary();
  }

  logger.info(`총 ${pairs.length}개 에픽 동기화 시작`);

  // 순차 처리 — 동시성은 ensureTargetEpic 내부 Promise dedup으로 충분히 처리됨
  for (const { epic, profile } of pairs) {
    try {
      const targetKey = await ensureTargetEpic(
        { key: epic.key, summary: epic.fields.summary },
        profile.targetProjectKey,
        logger,
        profile.id,
        profile.useEpicPrefix,
        profile.linkField
      );
      results.push({
        sourceKey: epic.key,
        sourceSummary: epic.fields.summary,
        targetProject: profile.targetProjectKey,
        targetKey,
        success: !!targetKey,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`${epic.key}: 에픽 동기화 실패 - ${msg}`);
      results.push({
        sourceKey: epic.key,
        sourceSummary: epic.fields.summary,
        targetProject: profile.targetProjectKey,
        targetKey: null,
        success: false,
        error: msg,
      });
    }
  }

  const totalSuccess = results.filter((r) => r.success).length;
  const totalFailed = results.length - totalSuccess;
  logger.success(
    `에픽 동기화 완료 (성공: ${totalSuccess}, 실패: ${totalFailed})`
  );

  return {
    totalProcessed: results.length,
    totalSuccess,
    totalFailed,
    results,
  };
}

function emptySummary(): EpicSyncSummary {
  return { totalProcessed: 0, totalSuccess: 0, totalFailed: 0, results: [] };
}
