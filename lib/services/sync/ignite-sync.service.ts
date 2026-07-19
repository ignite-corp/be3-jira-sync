// Ignite Jira 인스턴스 동기화 (소스 프로젝트 → 같은 인스턴스의 타겟 프로젝트)
// Blocks 링크로 연결된 타겟 티켓을 DB 프로필 매핑에 따라 업데이트

import { JiraIssue } from '@/lib/types/jira';
import { SyncResult, SyncTargetProject } from './types';
import { SyncLogger } from './logger';
import { mapFieldsFromDb } from './db-field-mapper';
import { syncStatusWithPathFromDb } from './transition-helper';
import { jira } from '@/lib/services/jira';

/**
 * Ignite 프로젝트 동기화 서비스
 * 소스 → 같은 Ignite 인스턴스의 타겟 프로젝트 동기화 담당 (DB 프로필 필수)
 */
export class IgniteSyncService {
  constructor(private logger: SyncLogger) {}

  /**
   * 소스 티켓의 연결된 타겟 티켓 찾기 (blocks 관계)
   */
  private findLinkedTickets(
    sourceTicket: JiraIssue,
    targetProject: SyncTargetProject
  ): string[] {
    const issuelinks = sourceTicket.fields.issuelinks;
    if (!issuelinks || issuelinks.length === 0) {
      return [];
    }

    const linkedKeys: string[] = [];
    const projectPrefix = `${targetProject}-`;

    for (const link of issuelinks) {
      // Blocks 관계 확인
      if (link.type?.name === 'Blocks' && link.outwardIssue) {
        const targetKey = link.outwardIssue.key;
        // 프로젝트 prefix 매칭
        if (targetKey.startsWith(projectPrefix)) {
          linkedKeys.push(targetKey);
        }
      }
    }

    return linkedKeys;
  }

  /**
   * 단일 소스 티켓을 대상 프로젝트로 동기화
   */
  async syncTicket(
    sourceTicket: JiraIssue,
    targetProject: SyncTargetProject,
    syncProfileId?: string
  ): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    if (!syncProfileId) {
      this.logger.error(
        `${sourceTicket.key}: 동기화 프로필 없음 - Ignite 동기화는 DB 프로필이 필요합니다`
      );
      return [];
    }

    try {
      // 1. 연결된 티켓 찾기
      const linkedKeys = this.findLinkedTickets(sourceTicket, targetProject);

      if (linkedKeys.length === 0) {
        this.logger.warning(
          `${sourceTicket.key}: ${targetProject}와 연결된 티켓 없음`
        );
        return [];
      }

      this.logger.info(
        `${sourceTicket.key}: ${linkedKeys.length}개의 ${targetProject} 티켓 발견 (${linkedKeys.join(', ')})`
      );

      // 2. 각 연결된 티켓 업데이트
      for (const targetKey of linkedKeys) {
        const result = await this.updateTargetTicket(
          sourceTicket,
          targetKey,
          targetProject,
          syncProfileId
        );
        results.push(result);
      }

      return results;
    } catch (error) {
      this.logger.error(
        `${sourceTicket.key}: 동기화 중 예외 발생 - ${error instanceof Error ? error.message : String(error)}`
      );
      return results;
    }
  }

  /**
   * 대상 티켓 업데이트 (필드 + 상태)
   */
  private async updateTargetTicket(
    sourceTicket: JiraIssue,
    targetKey: string,
    targetProject: SyncTargetProject,
    syncProfileId: string
  ): Promise<SyncResult> {
    try {
      this.logger.info(`${targetKey}: 업데이트 시작... (DB 매핑)`);

      // 1. 필드 매핑 (DB 기반)
      const mappedFields = await mapFieldsFromDb(
        sourceTicket,
        syncProfileId,
        targetProject
      );

      // 2. 필드 업데이트
      const updateResult = await jira.ignite.updateIssueFields(
        targetKey,
        mappedFields
      );

      if (!updateResult.success) {
        throw new Error(updateResult.error || '필드 업데이트 실패');
      }

      this.logger.success(`${targetKey}: 필드 업데이트 완료`);

      // 3. 상태 동기화
      await this.syncIgniteStatus(sourceTicket, targetKey, syncProfileId);

      return {
        sourceKey: sourceTicket.key,
        targetKey,
        targetProject,
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
        targetProject,
        success: false,
        error: errorMessage,
        isNewlyCreated: false,
      };
    }
  }

  /**
   * Ignite 타겟 티켓 상태 동기화 (동적 경로 탐색 사용)
   */
  private async syncIgniteStatus(
    sourceTicket: JiraIssue,
    targetKey: string,
    syncProfileId: string
  ): Promise<void> {
    const sourceStatusId = sourceTicket.fields.status?.id;
    if (!sourceStatusId) return;

    try {
      // 1. 현재 타겟 티켓의 상태 조회
      const targetIssue = await jira.ignite.getIssue(targetKey);
      if (!targetIssue.success || !targetIssue.data) {
        this.logger.warning(`${targetKey}: 상태 조회 실패 - 상태 동기화 스킵`);
        return;
      }

      const currentStatusId = targetIssue.data.fields.status?.id;
      if (!currentStatusId) {
        this.logger.warning(
          `${targetKey}: 현재 상태 ID 없음 - 상태 동기화 스킵`
        );
        return;
      }

      // 2. 동적 경로 탐색 및 순차 실행 (DB 매핑)
      const executeTransitionFn = async (
        issueKey: string,
        transitionId: string
      ) => {
        return await jira.ignite.updateIssueStatus(issueKey, transitionId);
      };

      const getTransitionsFn = async (issueKey: string) => {
        const res = await jira.ignite.getIssueTransitions(issueKey);
        if (res.success && res.data) {
          return (
            (
              res.data as {
                transitions: Array<{
                  id: string;
                  to: { id: string; name: string };
                }>;
              }
            ).transitions || []
          );
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
