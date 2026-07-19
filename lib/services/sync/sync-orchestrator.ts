// 동기화 오케스트레이터 - 전체 프로세스 조율
// 소스/타겟/매핑 규칙은 전부 DB sync_profile 기반

import { JiraIssue } from '@/lib/types/jira';
import { SyncOptions, SyncSummary, SyncResult, SyncLog, SyncTargetProject } from './types';
import { SyncLogger } from './logger';
import { IgniteSyncService } from './ignite-sync.service';
import { HMGSyncService } from './hmg-sync.service';
import { chunkArray } from './field-mapper';
import { initSprintCache, preloadSprintCache } from './sprint-mapper';
import {
  clearDbMappingCache,
  getSyncProfileInfo,
  getSourceFieldsFromDb,
  getAllowedEpicsFromDb,
  SyncProfileInfo,
} from './db-field-mapper';
import { clearTransitionCache } from './transition-helper';
import { clearEpicCache } from './epic-resolver';
import { jira } from '@/lib/services/jira';
import { dbServer } from '@/lib/db';

// 동기화 대상 프로필 (타겟 프로젝트 + 매핑 정보 + 허용 에픽)
interface TargetProfileEntry {
  target: SyncTargetProject;
  profile: SyncProfileInfo;
  allowedEpics: string[];
}

/**
 * 동기화 오케스트레이터
 * 전체 동기화 프로세스를 관리하고 조율
 */
export class SyncOrchestrator {
  private logger: SyncLogger;
  private igniteSyncService: IgniteSyncService;
  private hmgSyncService: HMGSyncService;

  constructor(onLog?: (log: SyncLog) => void) {
    this.logger = new SyncLogger(onLog);
    this.igniteSyncService = new IgniteSyncService(this.logger);
    this.hmgSyncService = new HMGSyncService(this.logger);
  }

  /**
   * 동기화 대상 마감일 기준일 계산 (현재 시점 - 1개월)
   * 예: 오늘이 4/8이면 3/8 반환
   */
  static getCutoffDate(): string {
    const now = new Date();
    now.setMonth(now.getMonth() - 1);
    return now.toISOString().slice(0, 10);
  }

  /**
   * 동기화 실행
   */
  async execute(options: SyncOptions): Promise<SyncSummary> {
    const startTime = Date.now();
    const allResults: SyncResult[] = [];

    try {
      // 캐시 초기화
      initSprintCache();
      clearDbMappingCache();
      clearTransitionCache();
      clearEpicCache();

      // 1. 소스 프로젝트 키 결정 (DB 기반)
      const sourceProjectKey = await this.resolveSourceProjectKey(options);
      if (!sourceProjectKey) {
        this.logger.error(
          '소스 프로젝트를 결정할 수 없습니다 - DB에 sync_profile을 등록하거나 sourceProjectKey를 전달하세요'
        );
        return this.createSummary(allResults, startTime);
      }

      this.logger.info(`동기화 시작 (소스 프로젝트: ${sourceProjectKey})`);

      // 2. 동기화 대상 프로필 로드 (DB 기반)
      let targetEntries = await this.loadTargetProfiles(
        sourceProjectKey,
        options.targetProjects
      );

      if (targetEntries.length === 0) {
        this.logger.warning(
          `${sourceProjectKey}: 동기화 프로필이 없습니다 - 설정 > 필드 매핑에서 프로필을 등록하세요`
        );
        return this.createSummary(allResults, startTime);
      }

      // 에픽 지정 모드: 허용 에픽 목록으로 대상 프로필 필터
      if (options.epicId) {
        const epicKey = `${sourceProjectKey}-${options.epicId}`;
        targetEntries = targetEntries.filter(
          (e) => e.allowedEpics.length === 0 || e.allowedEpics.includes(epicKey)
        );
        this.logger.info(
          `에픽 기반 대상 프로젝트 결정: ${targetEntries.map((e) => e.target).join(', ') || '없음'}`
        );
        if (targetEntries.length === 0) {
          return this.createSummary(allResults, startTime);
        }
      }

      this.logger.info(
        `동기화 대상: ${targetEntries.map((e) => `${e.target}(${e.profile.targetInstance})`).join(', ')}`
      );

      // 3. 스프린트 캐시 프리로드 (병렬) - 모든 대상 프로젝트
      this.logger.info('스프린트 정보 프리로드 중...');
      await preloadSprintCache(targetEntries.map((e) => e.target));
      this.logger.success('스프린트 정보 프리로드 완료');

      // 4. 소스 티켓 조회
      const sourceTickets = await this.fetchSourceTickets(
        sourceProjectKey,
        targetEntries,
        options
      );

      if (sourceTickets.length === 0) {
        this.logger.warning('동기화 대상 티켓이 없습니다');
        return this.createSummary(allResults, startTime);
      }

      this.logger.success(
        `${sourceTickets.length}개의 소스 티켓 발견 - 동기화 시작`
      );

      // 5. 티켓별 대상 프로젝트 분류 (1회 순회)
      this.logger.info('티켓별 동기화 대상 분석 중...');
      const ticketsByProject = this.classifyTicketsByTargetProject(
        sourceTickets,
        targetEntries
      );

      // 6. 프로젝트별 동기화 실행
      for (const entry of targetEntries) {
        const projectTickets = ticketsByProject.get(entry.target) || [];
        if (projectTickets.length === 0) {
          this.logger.info(`${entry.target}: 동기화 대상 티켓 없음 - 스킵`);
          continue;
        }

        const results = await this.syncToProject(
          projectTickets,
          entry,
          options.chunkSize || 15,
          options.teamUsers
        );
        allResults.push(...results);
      }

      return this.createSummary(allResults, startTime);
    } catch (error) {
      this.logger.error(
        `동기화 중 치명적 오류: ${error instanceof Error ? error.message : String(error)}`
      );
      return this.createSummary(allResults, startTime);
    }
  }

  /**
   * 소스 프로젝트 키 결정
   * 1) 옵션으로 전달된 값 → 2) 프로필의 소스 → 3) DB의 첫 sync_profile 소스
   */
  private async resolveSourceProjectKey(
    options: SyncOptions
  ): Promise<string | null> {
    if (options.sourceProjectKey) return options.sourceProjectKey;

    if (options.syncProfileId) {
      const profileInfo = await getSyncProfileInfo(options.syncProfileId);
      if (profileInfo) return profileInfo.sourceProjectKey;
    }

    // DB의 아무 프로필에서 소스 프로젝트 조회
    const { data } = await dbServer
      .from('sync_profiles')
      .select('source:source_project_id(name)')
      .limit(1)
      .maybeSingle();

    const source = data?.source as unknown as { name: string } | null;
    return source?.name ?? null;
  }

  /**
   * 소스 프로젝트의 동기화 프로필 목록 로드 (DB 기반)
   * targetProjects가 지정되면 해당 대상만 필터
   */
  private async loadTargetProfiles(
    sourceProjectKey: string,
    targetProjects?: SyncTargetProject[]
  ): Promise<TargetProfileEntry[]> {
    const { data: sourceProject } = await dbServer
      .from('projects')
      .select('id')
      .eq('name', sourceProjectKey)
      .maybeSingle();

    if (!sourceProject) {
      this.logger.warning(
        `${sourceProjectKey}: projects 테이블에 등록되지 않은 프로젝트입니다`
      );
      return [];
    }

    const { data: profiles } = await dbServer
      .from('sync_profiles')
      .select('id')
      .eq('source_project_id', sourceProject.id);

    if (!profiles || profiles.length === 0) return [];

    const entries: TargetProfileEntry[] = [];
    for (const { id } of profiles) {
      const profile = await getSyncProfileInfo(id);
      if (!profile) continue;
      if (targetProjects && !targetProjects.includes(profile.targetProjectKey)) {
        continue;
      }
      entries.push({
        target: profile.targetProjectKey,
        profile,
        allowedEpics: await getAllowedEpicsFromDb(id),
      });
    }

    // 지정한 대상 중 프로필이 없는 것 경고
    if (targetProjects) {
      for (const target of targetProjects) {
        if (!entries.some((e) => e.target === target)) {
          this.logger.warning(
            `${target}: 동기화 프로필을 찾을 수 없어 대상에서 제외됩니다`
          );
        }
      }
    }

    return entries;
  }

  /**
   * 소스 티켓 조회
   * DB sync_field_mappings에서 source_field 목록을 가져와 Jira API 요청 시 사용
   */
  private async fetchSourceTickets(
    sourceProjectKey: string,
    targetEntries: TargetProfileEntry[],
    options: SyncOptions
  ): Promise<JiraIssue[]> {
    // DB 매핑 기반 필드 목록 결정
    const fields = await this.resolveSourceFields(targetEntries);

    // 에픽 단위 동기화 모드 (담당자 무관)
    if (options.epicId && options.syncAllInEpic) {
      this.logger.info(
        `${sourceProjectKey}-${options.epicId} 에픽 하위 전체 티켓 조회 중 (담당자 무관)...`
      );
      const jql = `parent = ${sourceProjectKey}-${options.epicId} ORDER BY updated DESC`;
      const result = await jira.ignite.searchAllIssues(jql, fields);
      if (result.success && result.data) {
        this.logger.info(`에픽 하위 전체 티켓: ${result.data.issues.length}개`);
        return result.data.issues;
      }
      return [];
    }

    // 에픽 지정 모드 (특정 담당자)
    if (options.epicId) {
      this.logger.info(`${sourceProjectKey}-${options.epicId} 에픽 하위 티켓 조회 중...`);
      const jql = `parent = ${sourceProjectKey}-${options.epicId} AND assignee = "${options.assigneeAccountId}" ORDER BY updated DESC`;
      const result = await jira.ignite.searchAllIssues(jql, fields);
      if (result.success && result.data) {
        this.logger.info(
          `에픽 하위 티켓: ${result.data.issues.length}개 (전체: ${result.data.total}개)`
        );
        return result.data.issues;
      }
      return [];
    }

    // 티켓 지정 모드
    if (options.ticketId) {
      this.logger.info(`${sourceProjectKey}-${options.ticketId} 티켓 조회 중...`);
      const result = await jira.ignite.getIssue(
        `${sourceProjectKey}-${options.ticketId}`,
        fields
      );
      return result.success && result.data ? [result.data] : [];
    }

    // 일반 모드: 담당자의 모든 티켓 (완료 포함, 페이지네이션 자동 처리)
    this.logger.info('담당자의 모든 티켓 조회 중...');
    const cutoffDate = SyncOrchestrator.getCutoffDate();
    const jql = `project = ${sourceProjectKey} AND assignee = "${options.assigneeAccountId}" AND due >= "${cutoffDate}" ORDER BY updated DESC`;
    this.logger.info(`마감일 기준: ${cutoffDate} 이후`);

    this.logger.info(`담당자: ${options.assigneeName || '알 수 없음'}`);

    const result = await jira.ignite.searchAllIssues(jql, fields);
    if (result.success && result.data) {
      this.logger.info(
        `티켓 조회 완료: ${result.data.issues.length}개 (Jira 전체: ${result.data.total}개)`
      );
      return result.data.issues;
    }
    return [];
  }

  /**
   * DB 매핑 기반으로 소스 티켓 조회 시 필요한 필드 목록 결정
   * - 각 프로필의 sync_field_mappings source_field + link_field
   * - 동기화 로직에 필수인 시스템 필드 (분류, 상태 동기화 등)
   */
  private async resolveSourceFields(
    targetEntries: TargetProfileEntry[]
  ): Promise<string[]> {
    // 동기화 분류/처리에 항상 필요한 시스템 필드
    const systemFields = [
      'summary',
      'status',
      'project',
      'issuetype',
      'parent',       // 에픽 분류
      'issuelinks',   // 타겟 프로젝트 분류
    ];

    const allSourceFields = new Set<string>(systemFields);

    for (const { profile } of targetEntries) {
      const dbFields = await getSourceFieldsFromDb(profile.id);
      dbFields.forEach((f) => allSourceFields.add(f));

      // 프로필의 link field도 추가 (분류에 필요)
      if (profile.linkField) {
        allSourceFields.add(profile.linkField);
      }
    }

    const fields = Array.from(allSourceFields);
    this.logger.info(`소스 필드 목록 (${fields.length}개): ${fields.join(', ')}`);
    return fields;
  }

  /**
   * 티켓별 대상 프로젝트 분류 (1회 순회, DB 프로필 기반)
   * - Ignite(동일 인스턴스) 대상: Blocks 링크 prefix로 분류
   * - HMG(cross-instance) 대상: link field에 대상 티켓 링크가 있거나 허용 에픽에 부합하면 대상
   *   (sync_profile_allowed_epics가 비어있으면 모든 티켓이 대상)
   */
  private classifyTicketsByTargetProject(
    sourceTickets: JiraIssue[],
    targetEntries: TargetProfileEntry[]
  ): Map<SyncTargetProject, JiraIssue[]> {
    const classification = new Map<SyncTargetProject, JiraIssue[]>();
    targetEntries.forEach((e) => classification.set(e.target, []));

    for (const ticket of sourceTickets) {
      for (const { target, profile, allowedEpics } of targetEntries) {
        if (this.isTicketForTarget(ticket, profile, allowedEpics)) {
          classification.get(target)?.push(ticket);
        }
      }
    }

    // 분류 결과 로그
    targetEntries.forEach(({ target }) => {
      const count = classification.get(target)?.length || 0;
      if (count > 0) {
        this.logger.info(`${target}: ${count}개 티켓 동기화 대상`);
      }
    });

    return classification;
  }

  /**
   * 단일 티켓이 해당 프로필의 동기화 대상인지 판단
   */
  private isTicketForTarget(
    ticket: JiraIssue,
    profile: SyncProfileInfo,
    allowedEpics: string[]
  ): boolean {
    // 같은 인스턴스 대상: Blocks 링크 prefix로 분류 (링크 기반 업데이트 동기화)
    if (profile.targetInstance === profile.sourceInstance) {
      return (ticket.fields.issuelinks ?? []).some(
        (link) =>
          link.type.name === 'Blocks' &&
          link.outwardIssue?.key.startsWith(`${profile.targetProjectKey}-`)
      );
    }

    // cross-instance(HMG) 대상: link field 또는 허용 에픽 기반
    const rawLink = profile.linkField
      ? ticket.fields[profile.linkField]
      : undefined;
    const hasTargetLink =
      typeof rawLink === 'string' &&
      new RegExp(`${profile.targetProjectKey}-\\d+`).test(rawLink);

    const parentKey = ticket.fields.parent?.key ?? '';
    const isAllowedEpic =
      allowedEpics.length === 0 || allowedEpics.includes(parentKey);

    return hasTargetLink || isAllowedEpic;
  }

  /**
   * 특정 프로젝트로 동기화 (청킹 적용)
   * 이미 분류된 티켓만 받음 - 필터링 불필요
   */
  private async syncToProject(
    sourceTickets: JiraIssue[],
    entry: TargetProfileEntry,
    chunkSize: number,
    teamUsers?: SyncOptions['teamUsers']
  ): Promise<SyncResult[]> {
    const { target, profile } = entry;
    const isHmgInstance = profile.targetInstance === 'hmg';

    this.logger.info(`━━━ ${target} 동기화 시작 (DB 매핑) ━━━`);

    const allResults: SyncResult[] = [];
    const chunks = chunkArray(sourceTickets, chunkSize);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      this.logger.info(
        `${target}: ${i + 1}/${chunks.length} 청크 처리 중 (${chunk.length}개 티켓)`
      );

      // 청크 단위 병렬 처리
      const chunkResults = await Promise.allSettled(
        chunk.map((ticket) =>
          isHmgInstance
            ? this.hmgSyncService.syncTicket(ticket, teamUsers, profile.id)
            : this.igniteSyncService.syncTicket(ticket, target, profile.id)
        )
      );

      // 결과 수집
      for (const result of chunkResults) {
        if (result.status === 'fulfilled' && result.value) {
          if (Array.isArray(result.value)) {
            allResults.push(...result.value);
          } else {
            allResults.push(result.value);
          }
        }
      }
    }

    const successCount = allResults.filter((r) => r.success).length;
    const failCount = allResults.filter((r) => !r.success).length;

    this.logger.success(
      `${target}: 완료 (성공: ${successCount}, 실패: ${failCount})`
    );

    return allResults;
  }

  /**
   * 동기화 결과 요약 생성
   */
  private createSummary(results: SyncResult[], startTime: number): SyncSummary {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const successResults = results.filter((r) => r.success);
    const failedResults = results.filter((r) => !r.success);
    const createdResults = successResults.filter((r) => r.isNewlyCreated);
    const updatedResults = successResults.filter((r) => !r.isNewlyCreated);

    this.logger.success(
      `동기화 완료 (${duration}초 소요) - 총 ${results.length}개 처리 (동기화: ${updatedResults.length}, 생성: ${createdResults.length}, 실패: ${failedResults.length})`
    );

    if (failedResults.length > 0) {
      this.logger.warning(
        `실패한 티켓: ${failedResults.map((r) => `${r.sourceKey}→${r.targetKey || '생성실패'}`).join(', ')}`
      );
    }

    return {
      totalProcessed: results.length,
      totalSuccess: successResults.length,
      totalFailed: failedResults.length,
      totalUpdated: updatedResults.length,
      totalCreated: createdResults.length,
      results,
      failedResults,
    };
  }

  /**
   * 로그 가져오기
   */
  getLogs(): SyncLog[] {
    return this.logger.getLogs();
  }
}
