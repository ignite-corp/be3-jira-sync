// 동기화 오케스트레이터 - 전체 프로세스 조율

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

// 고정 분류 규칙(issuelinks/[GW]/[HB] 에픽 접두사)을 갖는 대상 — 그 외는 DB 프로필 기반 일반 분류
const FIXED_TARGETS = new Set<string>(['KQ', 'HDD', 'AUTOWAY', 'HMGBOARD']);

/**
 * 동기화 오케스트레이터
 * 전체 동기화 프로세스를 관리하고 조율
 */
export class SyncOrchestrator {
  private logger: SyncLogger;
  private igniteSyncService: IgniteSyncService;
  private hmgSyncService: HMGSyncService;
  private _sourceProjectKey: string | null = null;

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

      // 소스 프로젝트 키 결정 (execute 시작 시 1회, 이후 모든 내부 메서드에서 재사용)
      this._sourceProjectKey = options.sourceProjectKey || await this.resolveSourceProjectKey(options.syncProfileId);

      this.logger.info(`동기화 시작 (소스 프로젝트: ${this._sourceProjectKey})`);

      // HMG 동기화 프로필 조회 (DB 기반): AUTOWAY([GW]), HMGBOARD([HB])
      const autowayProfile = await this.findHmgProfileByTarget('AUTOWAY');
      if (autowayProfile) {
        this.logger.info(
          `AUTOWAY 프로필 로드 완료: link_field=${autowayProfile.linkField}, 에픽 필터=[GW] 접두사 기반`
        );
      }
      const hmgboardProfile = await this.findHmgProfileByTarget('HMGBOARD');
      if (hmgboardProfile) {
        this.logger.info(
          `HMGBOARD 프로필 로드 완료: link_field=${hmgboardProfile.linkField}, 에픽 필터=[HB] 접두사 기반`
        );
      }

      // 1. 대상 프로젝트 결정
      let targetProjects = options.targetProjects;

      // 에픽 지정 모드일 때는 에픽 정보를 기반으로 대상 프로젝트 결정
      if (options.epicId && !targetProjects) {
        targetProjects = await this.determineTargetProjectsForEpic(
          options.epicId
        );
        this.logger.info(
          `에픽 기반 대상 프로젝트 결정: ${targetProjects.join(', ')}`
        );
      }

      // 티켓 지정 모드일 때는 티켓 정보를 기반으로 대상 프로젝트 결정
      if (options.ticketId && !targetProjects) {
        targetProjects = await this.determineTargetProjectsForTicket(
          options.ticketId
        );
        if (targetProjects.length === 0) {
          this.logger.warning(
            '티켓 지정: 동기화 대상 프로젝트 없음 - 작업 종료'
          );
          return this.createSummary(allResults, startTime);
        }
        this.logger.info(
          `티켓 기반 대상 프로젝트 결정: ${targetProjects.join(', ')}`
        );
      }

      // 기본값: 전체 프로젝트 (HB는 HMGBOARD로 이관)
      if (!targetProjects) {
        targetProjects = ['KQ', 'HDD', 'AUTOWAY', 'HMGBOARD'];
      }

      // 2. 스프린트 캐시 프리로드 (병렬) - 모든 대상 프로젝트
      const sprintProjects = targetProjects;
      if (sprintProjects.length > 0) {
        this.logger.info('스프린트 정보 프리로드 중...');
        await preloadSprintCache(sprintProjects);
        this.logger.success('스프린트 정보 프리로드 완료');
      }

      // 3. FEHG 티켓 조회
      const fehgTickets = await this.fetchFehgTickets(options);

      if (fehgTickets.length === 0) {
        this.logger.warning('동기화 대상 티켓이 없습니다');
        return this.createSummary(allResults, startTime);
      }

      this.logger.success(
        `${fehgTickets.length}개의 소스 티켓 발견 - 동기화 시작`
      );

      // 4. 티켓별 대상 프로젝트 결정 (1회 순회)
      this.logger.info('티켓별 동기화 대상 분석 중...');
      const ticketsByProject = await this.classifyTicketsByTargetProject(
        fehgTickets,
        targetProjects
      );

      // 5. 프로젝트별 동기화 실행
      for (const targetProject of targetProjects) {
        const projectTickets = ticketsByProject.get(targetProject) || [];
        if (projectTickets.length === 0) {
          this.logger.info(`${targetProject}: 동기화 대상 티켓 없음 - 스킵`);
          continue;
        }

        const results = await this.syncToProject(
          projectTickets,
          targetProject,
          options.assigneeAccountId || '',
          options.chunkSize || 15,
          options.teamUsers,
          options.syncProfileId
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
   * FEHG 티켓 조회
   * DB sync_field_mappings에서 source_field 목록을 가져와 Jira API 요청 시 사용
   */
  private async fetchFehgTickets(options: SyncOptions): Promise<JiraIssue[]> {
    // 소스 프로젝트 키: execute()에서 이미 결정된 값 사용
    const sourceProjectKey = this.getSourceProjectKey();

    // DB 매핑 기반 필드 목록 결정
    const fields = await this.resolveSourceFields(options.syncProfileId);

    // 에픽 단위 동기화 모드 (담당자 무관)
    if (options.epicId && options.syncAllInEpic) {
      this.logger.info(
        `${sourceProjectKey}-${options.epicId} 에픽 하위 전체 티켓 조회 중 (담당자 무관)...`
      );
      const jql = `"Epic Link" = ${sourceProjectKey}-${options.epicId} ORDER BY updated DESC`;
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
      const jql = `"Epic Link" = ${sourceProjectKey}-${options.epicId} AND assignee = "${options.assigneeAccountId}" ORDER BY updated DESC`;
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
      const result = await jira.ignite.getIssue(`${sourceProjectKey}-${options.ticketId}`, fields);
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
   * - DB sync_field_mappings의 source_field 값들
   * - 동기화 로직에 필수인 시스템 필드 (분류, 상태 동기화 등)
   */
  private async resolveSourceFields(syncProfileId?: string): Promise<string[]> {
    // 동기화 분류/처리에 항상 필요한 시스템 필드
    const systemFields = [
      'summary',
      'status',
      'project',
      'issuetype',
      'parent',       // 에픽 분류
      'issuelinks',   // 타겟 프로젝트 분류
    ];

    // 모든 프로필의 source fields를 수집
    const allSourceFields = new Set<string>(systemFields);

    // syncProfileId가 있으면 해당 프로필의 매핑 필드 추가
    if (syncProfileId) {
      const dbFields = await getSourceFieldsFromDb(syncProfileId);
      dbFields.forEach((f) => allSourceFields.add(f));

      // 프로필의 link field도 추가 (분류에 필요)
      const profileInfo = await getSyncProfileInfo(syncProfileId);
      if (profileInfo?.linkField) {
        allSourceFields.add(profileInfo.linkField);
      }
    }

    // Ignite 타겟 프로젝트(KQ/HDD) 프로필의 소스 필드도 포함
    // syncToProject에서 auto-discover되는 프로필의 필드를 미리 fetch해야
    // 스프린트 등 커스텀 필드가 Jira 조회에 포함됨
    const igniteTargets: Array<'KQ' | 'HDD'> = ['KQ', 'HDD'];
    for (const target of igniteTargets) {
      const profileId = await this.findProfileForTarget(target);
      if (profileId && profileId !== syncProfileId) {
        const dbFields = await getSourceFieldsFromDb(profileId);
        dbFields.forEach((f) => allSourceFields.add(f));
      }
    }

    // HMG 프로필(AUTOWAY/HMGBOARD)이 있으면 해당 매핑 필드도 추가
    const hmgTargets: Array<'AUTOWAY' | 'HMGBOARD'> = ['AUTOWAY', 'HMGBOARD'];
    for (const target of hmgTargets) {
      const prof = await this.findHmgProfileByTarget(target);
      if (prof) {
        const profFields = await getSourceFieldsFromDb(prof.id);
        profFields.forEach((f) => allSourceFields.add(f));

        if (prof.linkField) {
          allSourceFields.add(prof.linkField);
        }
      }
    }

    const fields = Array.from(allSourceFields);
    this.logger.info(`소스 필드 목록 (${fields.length}개): ${fields.join(', ')}`);
    return fields;
  }

  /**
   * 소스 프로젝트 키 반환 (execute에서 이미 결정된 값 우선)
   */
  private getSourceProjectKey(): string {
    return this._sourceProjectKey || 'FEHG';
  }

  /**
   * 소스 프로젝트 키 결정 (DB 또는 기본값)
   */
  private async resolveSourceProjectKey(syncProfileId?: string): Promise<string> {
    if (this._sourceProjectKey) return this._sourceProjectKey;
    if (syncProfileId) {
      const profileInfo = await getSyncProfileInfo(syncProfileId);
      if (profileInfo) return profileInfo.sourceProjectKey;
    }
    // syncProfileId 없어도 아무 프로필에서 소스 프로젝트를 가져올 수 있음
    const autowayProf = await this.findHmgProfileByTarget('AUTOWAY');
    if (autowayProf) return autowayProf.sourceProjectKey;
    const hmgboardProf = await this.findHmgProfileByTarget('HMGBOARD');
    if (hmgboardProf) return hmgboardProf.sourceProjectKey;
    return 'FEHG'; // 최종 폴백
  }

  /**
   * 티켓별 대상 프로젝트 분류 (1회 순회로 효율화)
   */
  private async classifyTicketsByTargetProject(
    fehgTickets: JiraIssue[],
    targetProjects: SyncTargetProject[]
  ): Promise<Map<SyncTargetProject, JiraIssue[]>> {
    const classification = new Map<SyncTargetProject, JiraIssue[]>();

    // 초기화
    targetProjects.forEach((project) => classification.set(project, []));

    // 고정 대상(KQ/HDD/AUTOWAY/HMGBOARD) 외의 대상은 DB 프로필 기반으로 분류 준비
    const genericTargets: Array<{
      target: SyncTargetProject;
      profile: SyncProfileInfo;
      allowedEpics: string[];
    }> = [];
    for (const target of targetProjects) {
      if (FIXED_TARGETS.has(target)) continue;
      let profile = await this.findHmgProfileByTarget(target);
      if (!profile) {
        // HMG 프로필이 없으면 인스턴스 무관 프로필 조회 (Ignite 대상 포함)
        const profileId = await this.findProfileForTarget(target);
        if (profileId) profile = await getSyncProfileInfo(profileId);
      }
      if (!profile) {
        this.logger.warning(
          `${target}: 동기화 프로필을 찾을 수 없어 분류에서 제외됩니다`
        );
        continue;
      }
      genericTargets.push({
        target,
        profile,
        allowedEpics: await getAllowedEpicsFromDb(profile.id),
      });
    }

    // 1회 순회로 각 티켓의 대상 프로젝트 결정
    for (const ticket of fehgTickets) {
      const targets: SyncTargetProject[] = [];

      // 1. 연결된 티켓 확인 (issuelinks - KQ/HDD)
      if (ticket.fields.issuelinks) {
        for (const link of ticket.fields.issuelinks) {
          if (link.type.name === 'Blocks' && link.outwardIssue) {
            const key = link.outwardIssue.key;
            if (key.startsWith('KQ-') && targetProjects.includes('KQ')) {
              targets.push('KQ');
            } else if (
              key.startsWith('HDD-') &&
              targetProjects.includes('HDD')
            ) {
              targets.push('HDD');
            }
            // HB-* 링크는 무시 (옛 Ignite HB 프로젝트는 HMGBOARD로 이관됨)
          }
        }
      }

      const parentSummary = ticket.fields.parent?.fields?.summary ?? '';

      // 2. AUTOWAY 확인 (link field 또는 에픽 이름 [GW] 접두사)
      if (targetProjects.includes('AUTOWAY')) {
        const autowayProf = await this.findHmgProfileByTarget('AUTOWAY');
        const linkFieldId = autowayProf?.linkField || 'customfield_10306';
        const targetKey = autowayProf?.targetProjectKey || 'AUTOWAY';

        const hmgLink = ticket.fields[linkFieldId] as string | undefined;
        const hasTargetLink = hmgLink && new RegExp(`${targetKey}-\\d+`).test(hmgLink);

        // 에픽 이름이 [GW]로 시작하면 AUTOWAY 동기화 대상
        const isGwEpic = parentSummary.startsWith('[GW]');

        if (hasTargetLink || isGwEpic) {
          targets.push('AUTOWAY');
        }
      }

      // 3. HMGBOARD 확인 (link field 또는 에픽 이름 [HB] 접두사)
      if (targetProjects.includes('HMGBOARD')) {
        const hmgboardProf = await this.findHmgProfileByTarget('HMGBOARD');
        const linkFieldId = hmgboardProf?.linkField || 'customfield_10306';
        const targetKey = hmgboardProf?.targetProjectKey || 'HMGBOARD';

        const hmgLink = ticket.fields[linkFieldId] as string | undefined;
        const hasTargetLink = hmgLink && new RegExp(`${targetKey}-\\d+`).test(hmgLink);

        // 에픽 이름이 [HB]로 시작하면 HMGBOARD 동기화 대상
        const isHbEpic = parentSummary.startsWith('[HB]');

        if (hasTargetLink || isHbEpic) {
          targets.push('HMGBOARD');
        }
      }

      // 4. 그 외 대상: DB 프로필 기반 일반 분류
      //    - Ignite 대상: KQ/HDD와 동일하게 Blocks 링크 prefix로 분류 (링크 기반 업데이트 동기화)
      //    - HMG 대상: link field에 대상 티켓 링크가 있거나 허용 에픽에 부합하면 대상
      //      (sync_profile_allowed_epics가 비어있으면 모든 티켓이 대상)
      for (const { target, profile, allowedEpics } of genericTargets) {
        if (profile.targetInstance !== 'hmg') {
          const hasBlocksLink = (ticket.fields.issuelinks ?? []).some(
            (link) =>
              link.type.name === 'Blocks' &&
              link.outwardIssue?.key.startsWith(`${profile.targetProjectKey}-`)
          );
          if (hasBlocksLink) {
            targets.push(target);
          }
          continue;
        }

        const rawLink = profile.linkField
          ? ticket.fields[profile.linkField]
          : undefined;
        const hasTargetLink =
          typeof rawLink === 'string' &&
          new RegExp(`${profile.targetProjectKey}-\\d+`).test(rawLink);

        const parentKey = ticket.fields.parent?.key ?? '';
        const isAllowedEpic =
          allowedEpics.length === 0 || allowedEpics.includes(parentKey);

        if (hasTargetLink || isAllowedEpic) {
          targets.push(target);
        }
      }

      // 5. 각 대상 프로젝트에 티켓 추가
      targets.forEach((target) => {
        classification.get(target)?.push(ticket);
      });
    }

    // 분류 결과 로그
    targetProjects.forEach((project) => {
      const count = classification.get(project)?.length || 0;
      if (count > 0) {
        this.logger.info(`${project}: ${count}개 티켓 동기화 대상`);
      }
    });

    return classification;
  }

  /**
   * 특정 프로젝트로 동기화 (청킹 적용)
   * 이미 분류된 티켓만 받음 - 필터링 불필요
   */
  private async syncToProject(
    fehgTickets: JiraIssue[],
    targetProject: SyncTargetProject,
    assigneeAccountId: string,
    chunkSize: number,
    teamUsers?: SyncOptions['teamUsers'],
    syncProfileId?: string
  ): Promise<SyncResult[]> {
    // syncProfileId가 없으면 소스/타겟 프로젝트 기준으로 DB에서 자동 검색
    let effectiveProfileId = syncProfileId;
    if (!effectiveProfileId) {
      const prof = await this.findHmgProfileByTarget(targetProject);
      if (prof) {
        effectiveProfileId = prof.id;
      } else {
        effectiveProfileId = await this.findProfileForTarget(targetProject);
      }
    }

    // 대상 인스턴스 결정: 고정 HMG 대상이거나, 프로필의 target 인스턴스가 hmg인 경우
    const profileInfo = effectiveProfileId
      ? await getSyncProfileInfo(effectiveProfileId)
      : null;
    const isHmgInstance =
      targetProject === 'AUTOWAY' ||
      targetProject === 'HMGBOARD' ||
      profileInfo?.targetInstance === 'hmg';

    this.logger.info(
      `━━━ ${targetProject} 동기화 시작${effectiveProfileId ? ' (DB 매핑)' : ''} ━━━`
    );

    const allResults: SyncResult[] = [];
    const chunks = chunkArray(fehgTickets, chunkSize);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      this.logger.info(
        `${targetProject}: ${i + 1}/${chunks.length} 청크 처리 중 (${chunk.length}개 티켓)`
      );

      // 청크 단위 병렬 처리
      const chunkResults = await Promise.allSettled(
        chunk.map((ticket) =>
          isHmgInstance
            ? this.hmgSyncService.syncTicket(ticket, assigneeAccountId, teamUsers, effectiveProfileId)
            : this.igniteSyncService.syncTicket(ticket, targetProject as 'KQ' | 'HDD', effectiveProfileId)
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
      `${targetProject}: 완료 (성공: ${successCount}, 실패: ${failCount})`
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
        `실패한 티켓: ${failedResults.map((r) => `${r.fehgKey}→${r.targetKey || '생성실패'}`).join(', ')}`
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
   * 티켓 정보 기반으로 대상 프로젝트 결정
   */
  private async determineTargetProjectsForTicket(
    ticketId: string
  ): Promise<Array<'KQ' | 'HDD' | 'AUTOWAY' | 'HMGBOARD'>> {
    const srcKey = this.getSourceProjectKey();
    try {
      // 티켓 조회
      this.logger.info(`${srcKey}-${ticketId}: 티켓 정보 조회 중...`);
      const ticketResult = await jira.ignite.getIssue(`${srcKey}-${ticketId}`);

      if (!ticketResult.success || !ticketResult.data) {
        this.logger.error(`${srcKey}-${ticketId}: 티켓 조회 실패 - 동기화 중단`);
        return [];
      }

      const ticket = ticketResult.data;
      const targets: Array<'KQ' | 'HDD' | 'AUTOWAY' | 'HMGBOARD'> = [];

      // 1. 연결된 티켓 확인 (issuelinks - KQ/HDD)
      // HB-* 링크는 무시 (옛 Ignite HB는 HMGBOARD로 이관됨)
      if (ticket.fields.issuelinks) {
        for (const link of ticket.fields.issuelinks) {
          if (link.type.name === 'Blocks' && link.outwardIssue) {
            const outwardKey = link.outwardIssue.key;
            if (outwardKey.startsWith('KQ-')) targets.push('KQ');
            else if (outwardKey.startsWith('HDD-')) targets.push('HDD');
          }
        }
      }

      // 2. AUTOWAY link field 확인 (DB 기반)
      const autowayProf = await this.findHmgProfileByTarget('AUTOWAY');
      const autowayLinkFieldId = autowayProf?.linkField || 'customfield_10306';
      const autowayTargetKey = autowayProf?.targetProjectKey || 'AUTOWAY';

      const autowayLink = ticket.fields[autowayLinkFieldId] as string | undefined;
      if (autowayLink && new RegExp(`${autowayTargetKey}-\\d+`).test(autowayLink)) {
        targets.push('AUTOWAY');
      }

      // 3. HMGBOARD link field 확인 (DB 기반)
      const hmgboardProf = await this.findHmgProfileByTarget('HMGBOARD');
      const hmgboardLinkFieldId = hmgboardProf?.linkField || 'customfield_10306';
      const hmgboardTargetKey = hmgboardProf?.targetProjectKey || 'HMGBOARD';

      const hmgboardLink = ticket.fields[hmgboardLinkFieldId] as string | undefined;
      if (hmgboardLink && new RegExp(`${hmgboardTargetKey}-\\d+`).test(hmgboardLink)) {
        if (!targets.includes('HMGBOARD')) targets.push('HMGBOARD');
      }

      // 4. 상위 에픽 이름 prefix로 라우팅 (link field 없을 때만 보강)
      const parentSummary = ticket.fields.parent?.fields?.summary ?? '';
      if (parentSummary.startsWith('[GW]') && !targets.includes('AUTOWAY')) {
        targets.push('AUTOWAY');
      }
      if (parentSummary.startsWith('[HB]') && !targets.includes('HMGBOARD')) {
        targets.push('HMGBOARD');
      }

      if (targets.length > 0) {
        this.logger.info(
          `${srcKey}-${ticketId}: 동기화 대상 → ${targets.join(', ')}`
        );
        return targets;
      }

      this.logger.warning(
        `${srcKey}-${ticketId}: 동기화 대상 아님 (연결 티켓 없음, link field 없음, [GW]/[HB] 에픽 아님)`
      );
      return [];
    } catch (error) {
      this.logger.error(
        `티켓 정보 조회 실패: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  /**
   * 에픽 정보 기반으로 대상 프로젝트 결정
   */
  private async determineTargetProjectsForEpic(
    epicId: string
  ): Promise<Array<'KQ' | 'HDD' | 'AUTOWAY' | 'HMGBOARD'>> {
    const srcKey = this.getSourceProjectKey();
    try {
      const epicKey = `${srcKey}-${epicId}`;

      // 1. 에픽 정보 조회하여 summary 확인
      this.logger.info(`${epicKey}: 에픽 정보 조회 중...`);
      const epicResult = await jira.ignite.getIssue(epicKey);

      if (!epicResult.success || !epicResult.data) {
        this.logger.warning(
          `${epicKey}: 에픽 조회 실패 - 기본 프로젝트(KQ, HDD)로 동기화`
        );
        return ['KQ', 'HDD'];
      }

      const epicSummary = epicResult.data.fields.summary;
      this.logger.info(`${epicKey}: "${epicSummary}"`);

      // 2. Summary에서 프로젝트 prefix 확인 (시작 prefix 우선)
      if (epicSummary.startsWith('[GW]')) {
        this.logger.info('에픽 summary [GW] 접두사 → AUTOWAY만 동기화');
        return ['AUTOWAY'];
      }
      if (epicSummary.startsWith('[HB]')) {
        this.logger.info('에픽 summary [HB] 접두사 → HMGBOARD만 동기화');
        return ['HMGBOARD'];
      }
      if (epicSummary.includes('[KQ]')) {
        this.logger.info('에픽 summary에 [KQ] 발견 → KQ만 동기화');
        return ['KQ'];
      }
      if (epicSummary.includes('[HDD]')) {
        this.logger.info('에픽 summary에 [HDD] 발견 → HDD만 동기화');
        return ['HDD'];
      }

      // 3. prefix 없으면 모든 Ignite 프로젝트로 동기화
      this.logger.info(
        '에픽 summary에 프로젝트 prefix 없음 → KQ, HDD 전체 동기화'
      );
      return ['KQ', 'HDD'];
    } catch (error) {
      this.logger.error(
        `에픽 정보 조회 실패: ${error instanceof Error ? error.message : String(error)} - 기본 프로젝트로 동기화`
      );
      return ['KQ', 'HDD'];
    }
  }

  /**
   * 소스/타겟 프로젝트 기준으로 DB에서 sync_profile 검색
   */
  private async findProfileForTarget(targetProjectKey: string): Promise<string | undefined> {
    const sourceKey = this.getSourceProjectKey();
    // projects 테이블에서 이름으로 소스/타겟 프로젝트 ID 조회
    const { data: projects } = await dbServer
      .from('projects')
      .select('id, name')
      .in('name', [sourceKey, targetProjectKey]);

    if (!projects || projects.length < 2) return undefined;

    const sourceProjectId = projects.find((p) => p.name === sourceKey)?.id;
    const targetProjectId = projects.find((p) => p.name === targetProjectKey)?.id;
    if (!sourceProjectId || !targetProjectId) return undefined;

    const { data: profile } = await dbServer
      .from('sync_profiles')
      .select('id')
      .eq('source_project_id', sourceProjectId)
      .eq('target_project_id', targetProjectId)
      .limit(1)
      .single();

    if (profile) {
      this.logger.info(`${sourceKey} → ${targetProjectKey}: DB 프로필 자동 발견 (${profile.id})`);
      return profile.id;
    }
    return undefined;
  }

  /**
   * HMG 인스턴스 프로필 조회 (target project key별 캐시)
   * 예: 'AUTOWAY', 'HMGBOARD'
   */
  private hmgProfileCache: Map<string, Awaited<ReturnType<typeof getSyncProfileInfo>>> = new Map();

  private async findHmgProfileByTarget(targetProjectKey: string) {
    if (this.hmgProfileCache.has(targetProjectKey)) {
      return this.hmgProfileCache.get(targetProjectKey)!;
    }

    // 해당 target project (HMG 인스턴스)의 sync_profile 조회
    const { data: project } = await dbServer
      .from('projects')
      .select('id')
      .eq('name', targetProjectKey)
      .eq('jira_instance', 'hmg')
      .maybeSingle();

    if (!project) {
      this.hmgProfileCache.set(targetProjectKey, null);
      return null;
    }

    const { data } = await dbServer
      .from('sync_profiles')
      .select('id')
      .eq('target_project_id', project.id)
      .limit(1)
      .maybeSingle();

    const info = data ? await getSyncProfileInfo(data.id) : null;
    this.hmgProfileCache.set(targetProjectKey, info);
    return info;
  }

  /**
   * 로그 가져오기
   */
  getLogs(): SyncLog[] {
    return this.logger.getLogs();
  }
}
