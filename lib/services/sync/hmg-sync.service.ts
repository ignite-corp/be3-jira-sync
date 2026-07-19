// HMG Jira 인스턴스 동기화 (소스 프로젝트 → HMG 타겟 프로젝트)
// 매핑 규칙은 전부 DB sync_profile 기반

import { JiraIssue, JiraIssueCreatePayload } from '@/lib/types/jira';
import { SyncResult } from './types';
import { SyncLogger } from './logger';
import { mapFieldsFromDb, getSyncProfileInfo, SyncProfileInfo } from './db-field-mapper';
import { SyncOptions } from './types';
import { syncStatusWithPathFromDb } from './transition-helper';
import { jira } from '@/lib/services/jira';
import { JIRA_ENDPOINTS } from '@/lib/constants/jira';
import { ensureTargetEpic } from './epic-resolver';

// HMG Jira의 Epic Link 커스텀 필드 (자식 → 부모 에픽 연결)
const HMG_EPIC_LINK_FIELD = 'customfield_10014';

/**
 * HMG 프로젝트별 이슈타입 ID 캐시
 * - 프로젝트마다 허용되는 이슈타입이 다름
 */
const createIssueTypeIdCache: Map<string, string> = new Map();

/**
 * 신규 생성 시 선호 이슈타입 이름 (위에서부터 우선 매칭)
 */
const PREFERRED_ISSUETYPE_NAMES = [
  '작업',
  'Task',
  '업무',
  '스토리',
  'Story',
  '버그',
  'Bug',
];

/**
 * HMG 프로젝트 동기화 서비스
 * 소스 티켓 → HMG 타겟 프로젝트 동기화 담당 (DB 프로필 필수)
 */
export class HMGSyncService {
  constructor(private logger: SyncLogger) {}

  /**
   * 소스 부모 에픽이 있으면 대상 프로젝트의 동일 이름 에픽을 찾거나 신규 생성해서
   * mappedFields에 Epic Link(customfield_10014)를 주입.
   * 규칙: target summary = "[{소스 키}] " + 소스 부모 summary
   *       (프로필 use_epic_prefix가 false면 말머리 없이 소스 summary 그대로)
   */
  private async injectEpicLink(
    sourceTicket: JiraIssue,
    targetProjectKey: string,
    mappedFields: Record<string, unknown>,
    syncProfileId: string | undefined,
    usePrefix: boolean,
    linkField: string | null
  ): Promise<void> {
    const parent = sourceTicket.fields.parent;
    if (!parent?.key || !parent.fields?.summary) {
      return;
    }
    const epicKey = await ensureTargetEpic(
      { key: parent.key, summary: parent.fields.summary },
      targetProjectKey,
      this.logger,
      syncProfileId,
      usePrefix,
      linkField
    );
    if (epicKey) {
      mappedFields[HMG_EPIC_LINK_FIELD] = epicKey;
    }
  }

  private async resolveCreateIssueType(targetProjectKey: string): Promise<
    { id: string } | { name: string }
  > {
    // 이미 한번 찾았으면 재사용 (프로젝트별)
    const cached = createIssueTypeIdCache.get(targetProjectKey);
    if (cached) {
      return { id: cached };
    }

    const fallbackName = PREFERRED_ISSUETYPE_NAMES[0];

    try {
      const projectResult = await jira.hmg.getProject(targetProjectKey);
      const projectData = projectResult.success ? projectResult.data : null;

      // Jira /project/{key} 응답에는 issueTypes가 포함됨(타입 정의엔 빠져있어서 any 캐스팅)
      const issueTypes = (projectData as unknown as { issueTypes?: unknown })
        ?.issueTypes as Array<{
        id: string;
        name: string;
        subtask?: boolean;
      }> | null;

      if (!issueTypes || issueTypes.length === 0) {
        this.logger.warning(
          `${targetProjectKey}: 프로젝트 issueTypes 조회 실패(비어있음) → issuetype name으로 fallback ("${fallbackName}")`
        );
        return { name: fallbackName };
      }

      const nonSubtaskTypes = issueTypes.filter((t) => !t.subtask);

      // 선호 이름 순서대로 매칭 (먼저 나오는 게 더 우선)
      let preferred: typeof nonSubtaskTypes[number] | undefined;
      for (const name of PREFERRED_ISSUETYPE_NAMES) {
        preferred = nonSubtaskTypes.find((t) => t.name === name);
        if (preferred) break;
      }

      const chosen = preferred ?? nonSubtaskTypes[0] ?? issueTypes[0];

      createIssueTypeIdCache.set(targetProjectKey, chosen.id);
      this.logger.info(
        `${targetProjectKey}: issuetype 선택 → "${chosen.name}" (id=${chosen.id})`
      );
      return { id: chosen.id };
    } catch (e) {
      this.logger.warning(
        `${targetProjectKey}: issuetype 조회 중 예외 → name fallback ("${fallbackName}") - ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      return { name: fallbackName };
    }
  }

  /**
   * 소스 티켓을 HMG 타겟 프로젝트로 동기화 (DB 프로필 필수)
   */
  async syncTicket(
    sourceTicket: JiraIssue,
    teamUsers?: SyncOptions['teamUsers'],
    syncProfileId?: string
  ): Promise<SyncResult | null> {
    try {
      // DB 프로필에서 link_field와 target project 조회
      const profileInfo = syncProfileId ? await getSyncProfileInfo(syncProfileId) : null;
      if (!syncProfileId || !profileInfo) {
        this.logger.error(
          `${sourceTicket.key}: 동기화 프로필 없음 - HMG 동기화는 DB 프로필이 필요합니다`
        );
        return null;
      }

      const linkFieldId = profileInfo.linkField;
      const targetProjectKey = profileInfo.targetProjectKey;

      if (!linkFieldId) {
        this.logger.error(
          `${sourceTicket.key}: 프로필(${profileInfo.name})에 link_field 미설정 - 동기화 불가`
        );
        return null;
      }

      const customFields = sourceTicket.fields;
      const rawLink = customFields[linkFieldId];
      const targetLinkValue =
        typeof rawLink === 'string'
          ? rawLink.trim()
          : Array.isArray(rawLink)
            ? rawLink[0]
              ? String(rawLink[0]).trim()
              : ''
            : rawLink && typeof rawLink === 'object' && 'value' in rawLink
              ? String((rawLink as { value?: unknown }).value ?? '').trim()
              : '';

      if (targetLinkValue) {
        this.logger.info(
          `${sourceTicket.key}: ${linkFieldId} 감지됨 → ${targetLinkValue}`
        );
      } else {
        this.logger.info(
          `${sourceTicket.key}: ${linkFieldId} 비어 있음 → 신규 생성`
        );
      }

      // link field 확인 및 분기
      const targetKeyPattern = new RegExp(`${targetProjectKey}-\\d+`);
      if (!targetLinkValue || !targetKeyPattern.test(targetLinkValue)) {
        return await this.createAndLinkTicket(
          sourceTicket,
          teamUsers,
          syncProfileId,
          profileInfo
        );
      }

      // 기존 티켓 업데이트 플로우
      const match = targetLinkValue.match(new RegExp(`(${targetProjectKey}-\\d+)`));
      const targetKey = match ? match[1] : null;
      if (!targetKey) {
        this.logger.warning(
          `${sourceTicket.key}: ${targetProjectKey} 키 추출 실패 (${targetLinkValue}) - 신규 생성`
        );
        return await this.createAndLinkTicket(
          sourceTicket,
          teamUsers,
          syncProfileId,
          profileInfo
        );
      }

      return await this.updateTicket(
        sourceTicket,
        targetKey,
        teamUsers,
        syncProfileId,
        profileInfo
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `${sourceTicket.key}: HMG 동기화 실패 - ${errorMessage}`
      );
      return null;
    }
  }

  /**
   * HMG 타겟 티켓 신규 생성 및 소스 티켓에 링크
   */
  private async createAndLinkTicket(
    sourceTicket: JiraIssue,
    teamUsers: SyncOptions['teamUsers'],
    syncProfileId: string,
    profileInfo: SyncProfileInfo
  ): Promise<SyncResult> {
    const targetProjectKey = profileInfo.targetProjectKey;
    const linkFieldId = profileInfo.linkField!;

    try {
      this.logger.info(`${sourceTicket.key}: ${targetProjectKey} 티켓 생성 시작... (DB 매핑)`);

      // 1. 필드 매핑 (DB 기반)
      const mappedFields = await mapFieldsFromDb(
        sourceTicket,
        syncProfileId,
        targetProjectKey,
        teamUsers
      );

      // 1-1. 부모 에픽 주입 (소스 부모 에픽이 있으면 대상 측 에픽 매칭/생성/상태동기화)
      await this.injectEpicLink(
        sourceTicket,
        targetProjectKey,
        mappedFields,
        syncProfileId,
        profileInfo.useEpicPrefix,
        profileInfo.linkField
      );

      const targetIssueType = await this.resolveCreateIssueType(targetProjectKey);

      // 2. 소스 링크 필드 병합
      const sourceLinkFields = this.getSourceLinkFields(sourceTicket.key, profileInfo);

      // 3. 티켓 생성
      const createPayload: JiraIssueCreatePayload = {
        fields: {
          project: { key: targetProjectKey },
          issuetype: targetIssueType,
          summary: sourceTicket.fields.summary,
          ...mappedFields,
          ...sourceLinkFields,
        },
      };

      const createResult = await jira.hmg.createIssue(createPayload);

      if (!createResult.success || !createResult.data) {
        const errorDetails = (
          createResult as { details?: unknown; error?: string }
        ).details;
        if (errorDetails) {
          this.logger.error(
            `${sourceTicket.key}: Jira API 에러 상세 → ${JSON.stringify(errorDetails)}`
          );
        }
        throw new Error(createResult.error || `${targetProjectKey} 티켓 생성 실패`);
      }

      const createdKey = createResult.data.key;
      this.logger.success(`${createdKey}: ${targetProjectKey} 티켓 생성 완료`);

      // 4. 소스 티켓의 link field에 URL 저장
      const targetUrl = `${JIRA_ENDPOINTS.HMG}/browse/${createdKey}`;
      const linkResult = await jira.ignite.updateIssueFields(sourceTicket.key, {
        [linkFieldId]: targetUrl,
      });

      if (!linkResult.success) {
        this.logger.warning(
          `${sourceTicket.key}: ${targetProjectKey} 링크 저장 실패 (티켓은 생성됨)`
        );
      } else {
        this.logger.success(`${sourceTicket.key}: ${targetProjectKey} 링크 저장 완료`);
      }

      // 5. 상태 동기화
      await this.syncTargetStatus(sourceTicket, createdKey, syncProfileId);

      return {
        sourceKey: sourceTicket.key,
        targetKey: createdKey,
        targetProject: targetProjectKey,
        success: true,
        message: '신규 생성 및 동기화 완료',
        isNewlyCreated: true,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `${sourceTicket.key}: ${targetProjectKey} 생성 실패 - ${errorMessage}`
      );

      return {
        sourceKey: sourceTicket.key,
        targetKey: '',
        targetProject: targetProjectKey,
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 기존 HMG 타겟 티켓 업데이트
   */
  private async updateTicket(
    sourceTicket: JiraIssue,
    targetKey: string,
    teamUsers: SyncOptions['teamUsers'],
    syncProfileId: string,
    profileInfo: SyncProfileInfo
  ): Promise<SyncResult> {
    const targetProjectKey = profileInfo.targetProjectKey;

    try {
      this.logger.info(`${targetKey}: 업데이트 시작... (DB 매핑)`);

      // 1. 필드 매핑 (DB 기반)
      const mappedFields = await mapFieldsFromDb(
        sourceTicket,
        syncProfileId,
        targetProjectKey,
        teamUsers
      );

      // 1-1. 부모 에픽 주입 (소스 부모 에픽이 있으면 대상 측 에픽 매칭/생성/상태동기화)
      await this.injectEpicLink(
        sourceTicket,
        targetProjectKey,
        mappedFields,
        syncProfileId,
        profileInfo.useEpicPrefix,
        profileInfo.linkField
      );

      // 2. 소스 링크 필드 병합
      const sourceLinkFields = this.getSourceLinkFields(sourceTicket.key, profileInfo);
      const allFields = { ...mappedFields, ...sourceLinkFields };

      // 3. 필드 매핑 로그
      this.logger.info(
        `${targetKey}: 업데이트 필드 → ${JSON.stringify(Object.keys(allFields))}`
      );

      // 4. 필드 업데이트
      const updateResult = await jira.hmg.updateIssue(targetKey, {
        fields: allFields,
      });

      if (!updateResult.success) {
        const errorDetails = (
          updateResult as { details?: unknown; error?: string }
        ).details;
        if (errorDetails) {
          this.logger.error(
            `${targetKey}: Jira API 에러 상세 → ${JSON.stringify(errorDetails)}`
          );
        }
        throw new Error(updateResult.error || '필드 업데이트 실패');
      }

      this.logger.success(`${targetKey}: 필드 업데이트 완료`);

      // 5. 상태 동기화
      await this.syncTargetStatus(sourceTicket, targetKey, syncProfileId);

      return {
        sourceKey: sourceTicket.key,
        targetKey,
        targetProject: targetProjectKey,
        success: true,
        message: '동기화 완료',
        isNewlyCreated: false,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`${targetKey}: 업데이트 실패 - ${errorMessage}`);

      return {
        sourceKey: sourceTicket.key,
        targetKey,
        targetProject: targetProjectKey,
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 소스 티켓 원본 링크 필드를 반환 (mappedFields에 병합용)
   */
  private getSourceLinkFields(
    sourceKey: string,
    profileInfo?: { sourceLinkField?: string | null } | null
  ): Record<string, string> {
    const sourceLinkField = profileInfo?.sourceLinkField;
    if (!sourceLinkField) return {};
    return { [sourceLinkField]: `${JIRA_ENDPOINTS.IGNITE}/browse/${sourceKey}` };
  }

  /**
   * HMG 타겟 티켓 상태 동기화 (동적 경로 탐색 사용)
   */
  private async syncTargetStatus(
    sourceTicket: JiraIssue,
    targetKey: string,
    syncProfileId: string
  ): Promise<void> {
    const sourceStatusId = sourceTicket.fields.status?.id;
    if (!sourceStatusId) return;

    try {
      // 1. 현재 타겟 티켓의 상태 조회
      const targetIssue = await jira.hmg.getIssue(targetKey);
      if (!targetIssue.success || !targetIssue.data) {
        this.logger.warning(`${targetKey}: 상태 조회 실패 - 상태 동기화 스킵`);
        return;
      }

      const currentStatusId = targetIssue.data.fields.status?.id;
      if (!currentStatusId) {
        this.logger.warning(`${targetKey}: 현재 상태 ID 없음 - 상태 동기화 스킵`);
        return;
      }

      // 2. DB 기반 상태 동기화
      const executeTransitionFn = async (issueKey: string, transitionId: string) => {
        return await jira.hmg.updateIssueStatus(issueKey, transitionId);
      };

      const getTransitionsFn = async (issueKey: string) => {
        const res = await jira.hmg.getIssueTransitions(issueKey);
        if (res.success && res.data) {
          return (res.data as { transitions: Array<{ id: string; to: { id: string; name: string } }> }).transitions || [];
        }
        return [];
      };

      const result = await syncStatusWithPathFromDb(
        syncProfileId,
        targetKey,
        sourceStatusId,
        currentStatusId,
        executeTransitionFn,
        this.logger,
        getTransitionsFn
      );

      if (!result.success && result.stepsExecuted > 0) {
        this.logger.warning(
          `${targetKey}: 상태 동기화 부분 완료 (${result.stepsExecuted}단계 실행 후 실패)`
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.warning(
        `${targetKey}: 상태 동기화 실패 (필드는 업데이트됨) - ${errorMessage}`
      );
    }
  }
}
