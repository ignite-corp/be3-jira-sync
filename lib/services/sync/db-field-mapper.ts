// DB 기반 필드 매핑 로직
// sync_field_mappings 테이블에서 매핑 규칙을 읽어 필드를 변환

import { JiraIssue } from '@/lib/types/jira';
import { dbServer } from '@/lib/db';
import { mapSprintToTarget } from './sprint-mapper';
import { stripAdfMediaNodes } from './field-mapper';

interface DbFieldMapping {
  source_field: string;
  target_field: string;
  transform_type: string; // 'copy' | 'sprint_map' | 'account_map' | 'custom'
  transform_config: Record<string, unknown> | null;
}

// 프로필별 매핑 캐시 (동기화 세션 동안 유지)
const mappingCache = new Map<string, DbFieldMapping[]>();

// Jira REST가 fields 페이로드로 설정을 허용하지 않는 필드 — 매핑에 있어도 제외
// (comment/worklog/attachment는 전용 엔드포인트로만 추가 가능)
const NON_FIELD_UPDATABLE = ['comment', 'worklog', 'attachment'];

/**
 * 프로필의 필드 매핑 조회 (캐시)
 */
async function getFieldMappings(profileId: string): Promise<DbFieldMapping[]> {
  if (mappingCache.has(profileId)) {
    return mappingCache.get(profileId)!;
  }

  const { data } = await dbServer
    .from('sync_field_mappings')
    .select('source_field, target_field, transform_type, transform_config')
    .eq('profile_id', profileId);

  const mappings = (data || []).filter(
    (m) => !NON_FIELD_UPDATABLE.includes(m.target_field)
  );
  mappingCache.set(profileId, mappings);
  return mappings;
}

/**
 * 프로필의 매핑된 source 필드 목록 조회
 * 소스 티켓 조회 시 어떤 필드를 가져와야 하는지 결정하는 데 사용
 */
export async function getSourceFieldsFromDb(profileId: string): Promise<string[]> {
  const mappings = await getFieldMappings(profileId);
  return mappings.map((m) => m.source_field);
}

/**
 * DB 매핑 캐시 초기화
 */
export function clearDbMappingCache() {
  mappingCache.clear();
  accountMapCache.clear();
  profileInfoCache.clear();
  allowedEpicsCache.clear();
}

/**
 * DB 기반 필드 매핑 실행
 * sync_field_mappings에 저장된 규칙에 따라 소스 티켓 필드를 대상 필드로 변환
 */
const ACCOUNT_FIELDS = ['assignee', 'reporter', 'creator'];

/**
 * 팀 사용자 정보 (브라우저 환경에서 account_map 폴백용)
 * - dbServer는 브라우저에서 anon key로 동작 → users 테이블 RLS에 막힘
 * - teamUsers를 메모리에서 먼저 lookup하면 브라우저에서도 매핑 가능
 */
export interface TeamUserForMapping {
  igniteAccountId: string;
  hmgAccountId: string;
}

export async function mapFieldsFromDb(
  sourceTicket: JiraIssue,
  profileId: string,
  targetProjectKey: string,
  teamUsers?: TeamUserForMapping[]
): Promise<Record<string, unknown>> {
  const mappings = await getFieldMappings(profileId);
  const fields: Record<string, unknown> = {};
  const sourceFields = sourceTicket.fields;

  // 프로필의 소스/타겟 인스턴스가 다른지 확인
  const profileInfo = await getSyncProfileInfo(profileId);
  const isCrossInstance =
    profileInfo != null &&
    profileInfo.sourceInstance !== profileInfo.targetInstance;

  for (const mapping of mappings) {
    const { source_field, target_field, transform_type } = mapping;

    // 안전장치: 스프린트 필드가 copy로 되어 있으면 sprint_map으로 보정
    // (프로젝트마다 스프린트 ID가 다르므로 단순 복사 불가)
    const isSprintField = source_field === 'customfield_10020';

    // 안전장치: cross-instance에서 사람 필드가 copy로 되어 있으면 account_map으로 보정
    const effectiveTransformType =
      transform_type === 'copy' && isSprintField
        ? 'sprint_map'
        : transform_type === 'copy' &&
            isCrossInstance &&
            ACCOUNT_FIELDS.includes(source_field)
          ? 'account_map'
          : transform_type;

    switch (effectiveTransformType) {
      case 'copy': {
        // 단순 복사
        const value = getFieldValue(sourceTicket, sourceFields, source_field);
        if (value !== undefined && value !== null) {
          // assignee는 accountId 형태로 래핑
          if (source_field === 'assignee' && typeof value === 'object' && value !== null && 'accountId' in value) {
            fields[target_field] = { accountId: (value as { accountId: string }).accountId };
          } else if (source_field === 'description' && typeof value === 'object') {
            // description ADF에서 미디어 노드 제거
            fields[target_field] = stripAdfMediaNodes(value);
          } else {
            fields[target_field] = value;
          }
        }
        break;
      }

      case 'sprint_map': {
        // 스프린트 매핑 (소스 스프린트 이름 → 대상 프로젝트 스프린트 ID)
        const sprint = sourceFields[source_field] as
          | Array<{ id: number; name: string }>
          | undefined;

        if (sprint && sprint.length > 0) {
          const mappedSprintId = await mapSprintToTarget(
            sprint[0].name,
            targetProjectKey
          );
          if (mappedSprintId) {
            fields[target_field] = mappedSprintId;
          }
        }
        break;
      }

      case 'account_map': {
        // 계정 매핑 (Ignite accountId → HMG accountId)
        const sourceValue = getFieldValue(sourceTicket, sourceFields, source_field);
        if (sourceValue && typeof sourceValue === 'object' && 'accountId' in sourceValue) {
          const igniteAccountId = (sourceValue as { accountId: string }).accountId;

          // 1순위: teamUsers 메모리 lookup (브라우저 환경에서 RLS 우회)
          let hmgAccountId: string | null =
            teamUsers?.find((u) => u.igniteAccountId === igniteAccountId)
              ?.hmgAccountId ?? null;

          // 2순위: DB lookup (서버 환경, teamUsers 미제공 시)
          if (!hmgAccountId) {
            hmgAccountId = await lookupHmgAccountId(igniteAccountId);
          }

          if (hmgAccountId) {
            fields[target_field] = { accountId: hmgAccountId };
          }
        }
        break;
      }

      default: {
        // 알 수 없는 transform_type → copy로 폴백
        const fallbackValue = getFieldValue(sourceTicket, sourceFields, source_field);
        if (fallbackValue !== undefined && fallbackValue !== null) {
          fields[target_field] = fallbackValue;
        }
        break;
      }
    }
  }

  return fields;
}

// 계정 매핑 캐시 (동기화 세션 동안 유지)
const accountMapCache = new Map<string, string | null>();

/**
 * Ignite accountId → HMG accountId 조회 (캐시)
 */
async function lookupHmgAccountId(igniteAccountId: string): Promise<string | null> {
  if (accountMapCache.has(igniteAccountId)) {
    return accountMapCache.get(igniteAccountId)!;
  }

  const { data } = await dbServer
    .from('users')
    .select('hmg_account_id')
    .eq('ignite_account_id', igniteAccountId)
    .single();

  const hmgAccountId = data?.hmg_account_id || null;
  accountMapCache.set(igniteAccountId, hmgAccountId);
  return hmgAccountId;
}

/**
 * 동기화 프로필 정보 조회 (link_field, 타겟 프로젝트 정보)
 */
export interface SyncProfileInfo {
  id: string;
  name: string;
  linkField: string | null;
  sourceLinkField: string | null;
  targetProjectKey: string;
  targetInstance: string;
  sourceProjectKey: string;
  sourceInstance: string;
  /** 에픽 말머리("[소스키] ") 사용 여부. 컬럼 미존재/null이면 true(기존 동작) */
  useEpicPrefix: boolean;
}

const profileInfoCache = new Map<string, SyncProfileInfo>();

export async function getSyncProfileInfo(profileId: string): Promise<SyncProfileInfo | null> {
  if (profileInfoCache.has(profileId)) {
    return profileInfoCache.get(profileId)!;
  }

  // use_epic_prefix는 컬럼 명시 대신 *로 조회
  // (마이그레이션 미적용 환경에서도 select 에러 없이 동작 → undefined → true 폴백)
  const { data } = await dbServer
    .from('sync_profiles')
    .select(`
      *,
      source:source_project_id(name, jira_instance),
      target:target_project_id(name, jira_instance)
    `)
    .eq('id', profileId)
    .single();

  if (!data) return null;

  const source = data.source as unknown as { name: string; jira_instance: string };
  const target = data.target as unknown as { name: string; jira_instance: string };

  const info: SyncProfileInfo = {
    id: data.id,
    name: data.name,
    linkField: data.link_field,
    sourceLinkField: data.source_link_field || null,
    targetProjectKey: target.name,
    targetInstance: target.jira_instance,
    sourceProjectKey: source.name,
    sourceInstance: source.jira_instance,
    useEpicPrefix:
      (data as { use_epic_prefix?: boolean | null }).use_epic_prefix ?? true,
  };

  profileInfoCache.set(profileId, info);
  return info;
}

/**
 * DB에서 허용된 에픽 키 목록 조회
 */
const allowedEpicsCache = new Map<string, string[]>();

export async function getAllowedEpicsFromDb(profileId: string): Promise<string[]> {
  if (allowedEpicsCache.has(profileId)) {
    return allowedEpicsCache.get(profileId)!;
  }

  const { data } = await dbServer
    .from('sync_profile_allowed_epics')
    .select('epic_key')
    .eq('profile_id', profileId);

  const keys = data?.map((row) => row.epic_key) || [];
  allowedEpicsCache.set(profileId, keys);
  return keys;
}

/**
 * 소스 티켓에서 필드 값 추출
 */
function getFieldValue(
  ticket: JiraIssue,
  fields: JiraIssue['fields'],
  fieldId: string
): unknown {
  // 표준 필드
  switch (fieldId) {
    case 'summary':
      return ticket.fields.summary;
    case 'assignee':
      return ticket.fields.assignee;
    case 'duedate':
      return fields.duedate;
    case 'timetracking':
      return fields.timetracking;
    default:
      // 커스텀 필드 (customfield_XXXXX)
      return fields[fieldId];
  }
}
