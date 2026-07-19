'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefreshCw, User, Plus, ExternalLink, LogOut, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import {
  JIRA_ENDPOINTS,
} from '@/lib/constants/jira';
import { useCurrentUser, type AppUser } from '@/contexts/user-context';
import {
  SyncOrchestrator,
  SyncLog,
  SyncSummary,
  SyncResult,
  SyncTargetProject,
  SyncLogger,
  executeEpicSync,
  EpicSyncMode,
} from '@/lib/services/sync';
import { db } from '@/lib/db';
import { jira } from '@/lib/services/jira';
import { JiraIssue } from '@/lib/types/jira';

const LOG_HIGHLIGHT_PATTERN =
  '([A-Z]+-\\d+|성공|실패|경고|오류|에러|동기화|완료)';

function emphasizeLogMessage(message: string): ReactNode[] {
  const regex = new RegExp(LOG_HIGHLIGHT_PATTERN, 'g');
  const segments: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(message)) !== null) {
    if (match.index > lastIndex) {
      segments.push(message.slice(lastIndex, match.index));
    }

    segments.push(
      <span key={`${match.index}-${match[0]}`} className="font-semibold">
        {match[0]}
      </span>
    );

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < message.length) {
    segments.push(message.slice(lastIndex));
  }

  return segments.length > 0 ? segments : [message];
}

export default function Home() {
  const { currentUser, setCurrentUser } = useCurrentUser();
  const router = useRouter();


  const selectedUser = currentUser?.name ?? '';
  const sourceProject = currentUser?.sourceProject || '';
  const [syncType, setSyncType] = useState<string>('전체'); // 기본값: 전체
  const [epicOrTicketId, setEpicOrTicketId] = useState<string>('');
  const [isSyncing, setIsSyncing] = useState(false);

  // 에픽 동기화 전용 상태
  const [epicSyncMode, setEpicSyncMode] = useState<EpicSyncMode>('all');
  const [epicSyncId, setEpicSyncId] = useState<string>('');
  const [isEpicSyncing, setIsEpicSyncing] = useState(false);

  // 동기화 로그 및 결과
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([]);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);

  // 팀 사용자 목록 (DB 조회)
  const [teamUsers, setTeamUsers] = useState<{ name: string; igniteAccountId: string; hmgAccountId: string; hmgUserId: string }[]>([]);

  // 팀 동기화 대상 (DB 기반)
  interface TeamSyncTarget {
    projectId: string;
    projectName: string;
    syncProfileId: string;
    syncProfileName: string;
    sourceProjectName: string;
  }
  const [teamSyncTargets, setTeamSyncTargets] = useState<TeamSyncTarget[]>([]);
  const [isLoadingTargets, setIsLoadingTargets] = useState(true);
  // 프로젝트 이름 → Jira 인스턴스('ignite' | 'hmg') 맵 (결과 링크 엔드포인트 판별용)
  const [projectInstanceMap, setProjectInstanceMap] = useState<Record<string, string>>({});

  // 에픽 목록 (에픽 지정 모드용)
  const [epicList, setEpicList] = useState<JiraIssue[]>([]);
  const [isLoadingEpics, setIsLoadingEpics] = useState(false);

  useEffect(() => {
    if (!currentUser?.teamId) return;

    // 사용자 목록 조회 (API route 경유 — users 테이블은 anon RLS 차단됨)
    fetch('/api/users')
      .then((r) => r.json())
      .then((res: { success: boolean; data?: Array<{ name: string; teamId: string; igniteAccountId: string; hmgAccountId: string; hmgUserId: string }> }) => {
        if (res.success && res.data) {
          setTeamUsers(
            res.data
              .filter((u) => u.teamId === currentUser.teamId)
              .map((u) => ({
                name: u.name,
                igniteAccountId: u.igniteAccountId || '',
                hmgAccountId: u.hmgAccountId || '',
                hmgUserId: u.hmgUserId || '',
              }))
          );
        }
      });

    // 팀 동기화 대상 + 필드 매핑 조회
    const loadTeamTargets = async () => {
      // 팀의 기준 프로젝트 조회
      const { data: teamData } = await db
        .from('teams')
        .select('source_project_id')
        .eq('id', currentUser.teamId)
        .single();

      if (!teamData?.source_project_id) return;

      // 프로젝트 이름 맵
      const { data: projects } = await db
        .from('projects')
        .select('id, name, jira_instance');
      const projectMap = new Map(projects?.map((p) => [p.id, p.name]) || []);

      // 프로젝트 이름 → 인스턴스 맵 (결과 링크 엔드포인트 판별용)
      setProjectInstanceMap(
        Object.fromEntries(projects?.map((p) => [p.name, p.jira_instance]) || [])
      );

      // 팀 대상 프로젝트 + sync_profile 조회
      const { data: targets } = await db
        .from('team_target_projects')
        .select('project_id, sync_profile_id')
        .eq('team_id', currentUser.teamId);

      if (!targets) return;

      // sync_profile 이름 조회
      const profileIds = targets
        .map((t) => t.sync_profile_id)
        .filter(Boolean) as string[];

      const profileMap = new Map<string, string>();
      if (profileIds.length > 0) {
        const { data: profiles } = await db
          .from('sync_profiles')
          .select('id, name')
          .in('id', profileIds);
        profiles?.forEach((p) => profileMap.set(p.id, p.name));
      }

      const sourceProjectName = projectMap.get(teamData.source_project_id) || '?';

      setTeamSyncTargets(
        targets
          .filter((t) => t.sync_profile_id) // 매핑이 설정된 것만
          .map((t) => ({
            projectId: t.project_id,
            projectName: projectMap.get(t.project_id) || '?',
            syncProfileId: t.sync_profile_id!,
            syncProfileName: profileMap.get(t.sync_profile_id!) || '?',
            sourceProjectName,
          }))
      );
    };

    loadTeamTargets().finally(() => setIsLoadingTargets(false));
  }, [currentUser?.teamId]);

  // 에픽 목록 로드 (에픽 지정 선택 시)
  useEffect(() => {
    if (syncType !== '에픽 지정' || epicList.length > 0 || !sourceProject) return;

    const loadEpics = async () => {
      setIsLoadingEpics(true);
      try {
        const result = await jira.ignite.getIncompleteEpicsByProject(sourceProject);
        if (result.success && result.data) {
          setEpicList(result.data.issues);
        }
      } catch {
        toast.error('에픽 목록을 불러올 수 없습니다.');
      } finally {
        setIsLoadingEpics(false);
      }
    };

    loadEpics();
  }, [syncType, sourceProject, epicList.length]);

  // @deprecated 정적 분석 - 관리자 페이지로 이전 예정
  const resultScrollRef = useRef<HTMLDivElement | null>(null);
  const previousLogCountRef = useRef(0);

  useEffect(() => {
    const viewport = resultScrollRef.current?.querySelector<HTMLDivElement>(
      '[data-radix-scroll-area-viewport]'
    );

    if (!viewport) return;

    const behavior: ScrollBehavior =
      syncLogs.length > previousLogCountRef.current ? 'smooth' : 'auto';
    previousLogCountRef.current = syncLogs.length;

    const scrollToBottom = () =>
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior,
      });

    if (behavior === 'smooth') {
      requestAnimationFrame(scrollToBottom);
    } else {
      scrollToBottom();
    }
  }, [syncLogs]);

  useEffect(() => {
    if (!syncSummary) return;

    const viewport = resultScrollRef.current?.querySelector<HTMLDivElement>(
      '[data-radix-scroll-area-viewport]'
    );

    if (!viewport) return;

    requestAnimationFrame(() =>
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: 'smooth',
      })
    );
  }, [syncSummary]);

  // 티켓/에픽 지정 모드인지 확인
  const isSpecificMode = syncType === '티켓 지정' || syncType === '에픽 지정';

  // 동기화 타입 변경 시 추가 입력 초기화
  const handleSyncTypeChange = (value: string) => {
    setSyncType(value);
    if (value !== '티켓 지정' && value !== '에픽 지정') {
      setEpicOrTicketId('');
    }
  };

  // 숫자만 입력 가능하도록 처리
  const handleIdInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/[^0-9]/g, '').slice(0, 10);
    setEpicOrTicketId(value);
  };

  const isTicketSyncReady =
    !!currentUser &&
    !!sourceProject &&
    (!isSpecificMode || epicOrTicketId.trim() !== '') &&
    !isLoadingTargets;

  const resetResultArea = () => {
    setSyncLogs([]);
    setSyncSummary(null);
  };

  const handleSync = async () => {
    // 사용자 선택 검증
    if (!currentUser) {
      toast.error('사용자가 선택되지 않았습니다. 홈에서 사용자를 선택해주세요.');
      return;
    }

    // 소스 프로젝트 검증
    if (!sourceProject) {
      toast.error('소스 프로젝트가 설정되지 않았습니다. 팀의 기준 프로젝트를 먼저 설정해주세요.');
      return;
    }

    // 동기화 타입 검증
    if (!syncType) {
      toast.error('동기화 유형을 선택해주세요.');
      return;
    }

    // 티켓/에픽 지정 모드일 때 추가 검증
    if (isSpecificMode) {
      if (!epicOrTicketId) {
        toast.error(syncType === '에픽 지정' ? '에픽을 선택해주세요.' : '티켓 번호를 입력해주세요.');
        return;
      }
    }

    resetResultArea();
    setIsSyncing(true);

    try {
      // 최신 사용자 정보에서 소스 프로젝트 키 조회
      let freshSourceProject = sourceProject;
      try {
        const usersRes = await fetch('/api/users');
        const usersJson = await usersRes.json();
        if (usersJson.success && Array.isArray(usersJson.data)) {
          const freshUser = usersJson.data.find((u: AppUser) => u.id === currentUser.id);
          if (freshUser?.sourceProject) {
            freshSourceProject = freshUser.sourceProject;
            // currentUser도 갱신
            if (freshUser.sourceProject !== currentUser.sourceProject) {
              setCurrentUser(freshUser);
            }
          }
        }
      } catch {
        // API 실패 시 기존 값 사용
      }

      // 대상 프로젝트 결정
      let syncLabel = syncType;
      const orchestrator = new SyncOrchestrator((log) => {
        setSyncLogs((prev) => [...prev, log]);
      });

      if (syncType === '전체') {
        // DB 기반 전체 동기화: 팀의 모든 대상 프로젝트를 순회
        if (teamSyncTargets.length === 0) {
          toast.error('동기화 대상이 아직 로드되지 않았습니다. 잠시 후 다시 시도해주세요.');
          setIsSyncing(false);
          return;
        }
        syncLabel = '전체 (팀 설정 기반)';
        toast.success(`${selectedUser} 담당자 - "${syncLabel}" 동기화를 시작합니다.`);

        let totalSuccess = 0;
        let totalFailed = 0;
        let totalUpdated = 0;
        let totalCreated = 0;
        const allResults: SyncResult[] = [];
        const allFailedResults: SyncResult[] = [];

        for (const target of teamSyncTargets) {
          const label = `${target.sourceProjectName} → ${target.projectName}`;
          setSyncLogs((prev) => [
            ...prev,
            {
              timestamp: new Date().toLocaleTimeString('ko-KR'),
              level: 'info' as const,
              message: `━━━ ${label} (${target.syncProfileName}) 동기화 시작 ━━━`,
            },
          ]);

          const summary = await orchestrator.execute({
            assigneeAccountId: currentUser.igniteAccountId,
            assigneeName: currentUser.name,
            teamUsers,
            targetProjects: [target.projectName as SyncTargetProject],
            syncProfileId: target.syncProfileId,
            sourceProjectKey: freshSourceProject,
            chunkSize: 15,
          });

          totalSuccess += summary.totalSuccess;
          totalFailed += summary.totalFailed;
          totalUpdated += summary.totalUpdated;
          totalCreated += summary.totalCreated;
          allResults.push(...summary.results);
          allFailedResults.push(...summary.failedResults);
        }

        const finalSummary: SyncSummary = {
          totalProcessed: totalSuccess + totalFailed,
          totalSuccess,
          totalFailed,
          totalUpdated,
          totalCreated,
          results: allResults,
          failedResults: allFailedResults,
        };
        setSyncSummary(finalSummary);

        if (totalFailed === 0) {
          toast.success(`전체 동기화 완료! 총 ${totalSuccess}개 티켓 처리`);
        } else {
          toast.warning(`전체 동기화 완료 (성공: ${totalSuccess}, 실패: ${totalFailed})`);
        }
        setIsSyncing(false);
        return;
      }

      let targetProjects: SyncTargetProject[] | undefined;
      let syncProfileId: string | undefined;

      if (syncType.startsWith('db:')) {
        // DB 기반 개별 프로젝트 동기화
        const dbTarget = teamSyncTargets.find(
          (t) => `db:${t.projectId}` === syncType
        );
        if (dbTarget) {
          targetProjects = [dbTarget.projectName as SyncTargetProject];
          syncProfileId = dbTarget.syncProfileId;
          syncLabel = `${dbTarget.sourceProjectName} → ${dbTarget.projectName} (${dbTarget.syncProfileName})`;
        }
      }

      // 동기화 시작 메시지
      let message = `${selectedUser} 담당자 - "${syncLabel}" 동기화를 시작합니다.`;
      if (isSpecificMode) {
        const ticketKey = `${freshSourceProject}-${epicOrTicketId}`;
        message = `${selectedUser} 담당자 - ${ticketKey} 동기화를 시작합니다.`;
      }
      toast.success(message);

      const summary = await orchestrator.execute({
        assigneeAccountId: currentUser.igniteAccountId,
        assigneeName: currentUser.name,
        teamUsers,
        targetProjects,
        syncProfileId,
        sourceProjectKey: freshSourceProject,
        epicId: syncType === '에픽 지정' ? epicOrTicketId : undefined,
        ticketId: syncType === '티켓 지정' ? epicOrTicketId : undefined,
        syncAllInEpic: syncType === '에픽 지정' ? true : undefined,
        chunkSize: 15,
      });

      setSyncSummary(summary);

      // 결과 토스트
      if (summary.totalFailed === 0) {
        toast.success(`동기화 완료! 총 ${summary.totalSuccess}개 티켓 처리`);
      } else {
        toast.warning(
          `동기화 완료 (성공: ${summary.totalSuccess}, 실패: ${summary.totalFailed})`
        );
      }
    } catch (error) {
      toast.error(
        `동기화 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsSyncing(false);
    }
  };

  // 에픽 동기화 핸들러 — 동기화 프로필의 허용 에픽을 HMG 타겟 프로젝트에
  // 매칭 또는 생성하고 상태를 동기화 (자식 티켓 sync와 독립)
  const handleEpicSync = async () => {
    if (!sourceProject) {
      toast.error('소스 프로젝트가 설정되지 않았습니다. 팀의 기준 프로젝트를 먼저 설정해주세요.');
      return;
    }

    if (epicSyncMode === 'single' && !epicSyncId) {
      toast.error('에픽 번호를 입력해주세요.');
      return;
    }

    resetResultArea();
    setIsEpicSyncing(true);

    try {
      const epicKey =
        epicSyncMode === 'single' ? `${sourceProject}-${epicSyncId}` : undefined;

      const logger = new SyncLogger((log) => {
        setSyncLogs((prev) => [...prev, log]);
      });

      const modeLabel =
        epicSyncMode === 'all' ? '전체' : `단일 에픽 (${epicKey})`;

      toast.success(`에픽 동기화 시작 — ${modeLabel}`);

      const summary = await executeEpicSync(
        {
          mode: epicSyncMode,
          epicKey,
          sourceProjectKey: sourceProject,
        },
        logger
      );

      if (summary.totalFailed === 0) {
        toast.success(
          `에픽 동기화 완료 — ${summary.totalSuccess}개 처리`
        );
      } else {
        toast.warning(
          `에픽 동기화 완료 (성공: ${summary.totalSuccess}, 실패: ${summary.totalFailed})`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`에픽 동기화 실패: ${msg}`);
    } finally {
      setIsEpicSyncing(false);
    }
  };

  // AUTOWAY 동기화 대상 확인 (필요시 주석 해제하여 사용)
  /* const handleCheckAutowayTargets = async () => {
    // ... (전체 로직 생략)
  }; */

  // 구 HMG URL → 신 HMG URL 마이그레이션 (마이그레이션 완료로 현재 미사용)
  // 필요시 주석 해제하여 사용
  /* const handleMigrateOldHmgLinks = async () => {
    // 사용자 선택 검증
    if (!selectedUser) {
      setUserSelectError(true);
      toast.error('담당자를 선택해주세요.');
      userSelectRef.current?.focus();
      return;
    }

    setUserSelectError(false);
    setIsSyncing(true);
    setSyncLogs([]);
    setSyncSummary(null);

    try {
      if (!currentUser) {
        toast.error('사용자 정보를 찾을 수 없습니다.');
        return;
      }

      setSyncLogs([
        {
          timestamp: new Date().toLocaleTimeString('ko-KR'),
          level: 'info',
          message: `→ ${selectedUser} 담당자의 구 HMG 링크 마이그레이션 시작...`,
        },
      ]);

      // 기준 프로젝트 티켓 조회 (모든 상태)
      const jql = `project = ${sourceProject} AND assignee = "${currentUser.igniteAccountId}" ORDER BY updated DESC`;
      const result = await jira.ignite.searchAllIssues(jql);

      if (!result.success || !result.data) {
        setSyncLogs((prev) => [
          ...prev,
          {
            timestamp: new Date().toLocaleTimeString('ko-KR'),
            level: 'error',
            message: `✗ 티켓 조회 실패: ${result.error || '알 수 없는 오류'}`,
          },
        ]);
        return;
      }

      const allTickets = result.data.issues;
      setSyncLogs((prev) => [
        ...prev,
        {
          timestamp: new Date().toLocaleTimeString('ko-KR'),
          level: 'success',
          message: `✓ 총 ${allTickets.length}개 티켓 조회 완료`,
        },
      ]);

      // 구 HMG URL이 있는 티켓 필터링
      const oldHmgTickets = allTickets.filter((ticket) => {
        const link = ticket.fields[IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK] as
          | string
          | undefined;
        return link && link.includes(JIRA_ENDPOINTS.HMG_OLD);
      });

      setSyncLogs((prev) => [
        ...prev,
        {
          timestamp: new Date().toLocaleTimeString('ko-KR'),
          level: 'info',
          message: `→ 구 HMG 링크 티켓: ${oldHmgTickets.length}개 발견`,
        },
      ]);

      if (oldHmgTickets.length === 0) {
        setSyncLogs((prev) => [
          ...prev,
          {
            timestamp: new Date().toLocaleTimeString('ko-KR'),
            level: 'warning',
            message: '⚠ 마이그레이션 대상 티켓이 없습니다',
          },
        ]);
        toast.warning('마이그레이션 대상 티켓이 없습니다');
        return;
      }

      setSyncLogs((prev) => [
        ...prev,
        {
          timestamp: new Date().toLocaleTimeString('ko-KR'),
          level: 'info',
          message: `━━━ 링크 마이그레이션 시작 (${oldHmgTickets.length}개) ━━━`,
        },
      ]);

      // 각 티켓의 링크 업데이트
      let successCount = 0;
      let failCount = 0;

      for (const ticket of oldHmgTickets) {
        const oldLink = ticket.fields[IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK] as
          | string
          | undefined;
        if (!oldLink) continue;

        // 구 URL → 신 URL 변경
        const newLink = oldLink.replace(
          JIRA_ENDPOINTS.HMG_OLD,
          JIRA_ENDPOINTS.HMG
        );

        try {
          const updateResult = await jira.ignite.updateIssueFields(ticket.key, {
            [IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK]: newLink,
          });

          if (updateResult.success) {
            setSyncLogs((prev) => [
              ...prev,
              {
                timestamp: new Date().toLocaleTimeString('ko-KR'),
                level: 'success',
                message: `✓ ${ticket.key}: ${oldLink} → ${newLink}`,
              },
            ]);
            successCount++;
          } else {
            setSyncLogs((prev) => [
              ...prev,
              {
                timestamp: new Date().toLocaleTimeString('ko-KR'),
                level: 'error',
                message: `✗ ${ticket.key}: 업데이트 실패 - ${updateResult.error}`,
              },
            ]);
            failCount++;
          }
        } catch (error) {
          setSyncLogs((prev) => [
            ...prev,
            {
              timestamp: new Date().toLocaleTimeString('ko-KR'),
              level: 'error',
              message: `✗ ${ticket.key}: 오류 발생 - ${error instanceof Error ? error.message : String(error)}`,
            },
          ]);
          failCount++;
        }
      }

      // 최종 결과
      setSyncLogs((prev) => [
        ...prev,
        {
          timestamp: new Date().toLocaleTimeString('ko-KR'),
          level: 'success',
          message: `━━━ 마이그레이션 완료: 성공 ${successCount}개, 실패 ${failCount}개 ━━━`,
        },
      ]);

      if (failCount === 0) {
        toast.success(
          `링크 마이그레이션 완료! ${successCount}개 티켓 업데이트`
        );
      } else {
        toast.warning(
          `링크 마이그레이션 완료 (성공: ${successCount}, 실패: ${failCount})`
        );
      }
    } catch (error) {
      setSyncLogs((prev) => [
        ...prev,
        {
          timestamp: new Date().toLocaleTimeString('ko-KR'),
          level: 'error',
          message: `✗ 오류 발생: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
      toast.error('링크 마이그레이션 중 오류가 발생했습니다');
    } finally {
      setIsSyncing(false);
    }
  }; */

  return (
    <main className="h-screen bg-background flex flex-col">
      {/* Page Context Header */}
      <div className="border-b">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">Jira 통합 관리</h1>
            <p className="text-sm text-muted-foreground">
              여러 Jira 인스턴스를 자동화하고 관리합니다
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/templates">
              <Button variant="outline" size="sm">
                배포 템플릿
              </Button>
            </Link>
            <Link href="/generate-ticket">
              <Button variant="outline" size="sm">
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                AI 티켓 생성
              </Button>
            </Link>
            <Link href="/create-ticket">
              <Button size="sm">
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                티켓 생성
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {/* Main Content: 2-Column Layout */}
      <div className="flex-1 container mx-auto px-6 py-6 overflow-hidden">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 h-full">
          {/* Left: Action Area */}
          <Card className="flex h-full flex-col overflow-hidden">
            <CardHeader>
              <CardTitle>작업 영역</CardTitle>
              <CardDescription>
                자동화 작업을 설정하고 실행합니다
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 space-y-6 overflow-y-auto pr-4">
              {/* User Display - 읽기 전용 */}
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-2">
                  <User className="h-4 w-4" />
                  담당자
                </label>
                {currentUser ? (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                      <span className="font-medium">{currentUser.name}</span>
                      {currentUser.teamName && (
                        <span className="text-xs text-muted-foreground rounded-full bg-secondary px-2 py-0.5">
                          {currentUser.teamName}
                        </span>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        router.push('/select-user?switch=true');
                      }}
                      title="사용자 변경"
                    >
                      <LogOut className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-muted-foreground">
                      사용자가 선택되지 않았습니다.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => router.push('/select-user')}
                    >
                      사용자 선택
                    </Button>
                  </div>
                )}
              </div>

              {/* 자동화 작업 */}
              <div className="border-t pt-6">
                <h3 className="text-sm font-semibold mb-4">자동화 작업</h3>

                {/* Ticket Sync Action */}
                <div className="space-y-3">
                  <label className="text-sm font-medium">티켓 동기화</label>
                  <div className="flex gap-2">
                    <Select
                      value={syncType}
                      onValueChange={handleSyncTypeChange}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="동기화 유형을 선택하세요" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="전체">전체</SelectItem>
                          {teamSyncTargets.map((target) => (
                            <SelectItem
                              key={target.projectId}
                              value={`db:${target.projectId}`}
                            >
                              {target.sourceProjectName} → {target.projectName}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                        <SelectSeparator />
                        <SelectGroup>
                          <SelectLabel>개별 지정</SelectLabel>
                          <SelectItem value="티켓 지정">티켓 지정</SelectItem>
                          <SelectItem value="에픽 지정">에픽 지정</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Button
                      onClick={handleSync}
                      disabled={!isTicketSyncReady || isSyncing}
                      className="min-w-[100px]"
                    >
                      <RefreshCw
                        className={`mr-2 h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`}
                      />
                      {isSyncing ? '동기화 중...' : '동기화'}
                    </Button>
                  </div>

                  {/* 티켓 지정 시 번호 입력 */}
                  {syncType === '티켓 지정' && (
                    <div className="space-y-2 pl-4 pb-3 border-l-2 border-muted">
                      <label className="text-sm font-medium text-muted-foreground">
                        {sourceProject} 티켓 번호
                      </label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        placeholder={`번호를 입력하세요 (예: 123 → ${sourceProject}-123)`}
                        value={epicOrTicketId}
                        onChange={handleIdInput}
                        maxLength={10}
                      />
                      <p className="text-xs text-muted-foreground">
                        숫자만 입력 (최대 10자) • {sourceProject}-{epicOrTicketId || 'XXX'} 형태로 조회
                      </p>
                    </div>
                  )}

                  {/* 에픽 지정 시 에픽 선택 */}
                  {syncType === '에픽 지정' && (
                    <div className="space-y-2 pl-4 pb-3 border-l-2 border-muted">
                      <label className="text-sm font-medium text-muted-foreground">
                        {sourceProject} 에픽 선택
                      </label>
                      <Select
                        value={epicOrTicketId}
                        onValueChange={(value) => setEpicOrTicketId(value)}
                        disabled={isLoadingEpics}
                      >
                        <SelectTrigger>
                          <SelectValue
                            placeholder={
                              isLoadingEpics
                                ? '에픽 목록 로딩 중...'
                                : '에픽을 선택하세요'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {epicList.map((epic) => {
                            const epicNum = epic.key.split('-')[1];
                            return (
                              <SelectItem key={epic.key} value={epicNum}>
                                <span className="font-medium">{epic.key}</span>
                                <span className="ml-2 text-muted-foreground">
                                  {epic.fields.summary}
                                </span>
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      {epicOrTicketId && (
                        <p className="text-xs text-muted-foreground">
                          {sourceProject}-{epicOrTicketId} 에픽 하위 티켓을 동기화합니다
                        </p>
                      )}
                    </div>
                  )}

                  {/* AUTOWAY 대상 확인 버튼 (필요시 사용) */}
                  {/* <div className="pt-3 border-t space-y-2">
                    <Button
                      onClick={handleCheckAutowayTargets}
                      disabled={isSyncing}
                      variant="outline"
                      className="w-full"
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      AUTOWAY 동기화 대상 확인
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      담당자의 허용된 에픽 하위 티켓만 조회합니다
                    </p>
                  </div> */}
                </div>

                {/* Epic Sync Action */}
                <div className="space-y-3 mt-6 pt-6 border-t">
                  <label className="text-sm font-medium">에픽 동기화</label>
                  <div className="flex gap-2">
                    <Select
                      value={epicSyncMode}
                      onValueChange={(value) =>
                        setEpicSyncMode(value as EpicSyncMode)
                      }
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="범위를 선택하세요" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">전체</SelectItem>
                        <SelectItem value="single">에픽 번호 입력</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      onClick={handleEpicSync}
                      disabled={isEpicSyncing || isSyncing || !sourceProject}
                      className="min-w-[100px]"
                    >
                      <RefreshCw
                        className={`mr-2 h-4 w-4 ${isEpicSyncing ? 'animate-spin' : ''}`}
                      />
                      {isEpicSyncing ? '동기화 중...' : '동기화'}
                    </Button>
                  </div>

                  {epicSyncMode === 'single' && (
                    <div className="space-y-2 pl-4 pb-3 border-l-2 border-muted">
                      <label className="text-sm font-medium text-muted-foreground">
                        {sourceProject} 에픽 번호
                      </label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        placeholder={`번호 입력 (예: 3340 → ${sourceProject}-3340)`}
                        value={epicSyncId}
                        onChange={(e) =>
                          setEpicSyncId(e.target.value.replace(/[^0-9]/g, ''))
                        }
                        maxLength={10}
                      />
                      <p className="text-xs text-muted-foreground">
                        동기화 프로필의 허용 에픽 설정으로 대상 결정 • {sourceProject}-
                        {epicSyncId || 'XXX'}
                      </p>
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground">
                    동기화 프로필의 허용 에픽을 HMG 타겟 프로젝트에 매칭/생성하고 상태를 동기화합니다.
                  </p>
                </div>

              </div>

              {/* @deprecated 정적 분석 - 관리자 페이지로 이전 예정 */}
            </CardContent>
          </Card>

          {/* Right: Result Area */}
          <Card className="flex h-full flex-col overflow-hidden">
            <CardHeader>
              <CardTitle>결과 영역</CardTitle>
              <CardDescription>실시간 로그 및 실행 결과</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-hidden">
              <ScrollArea ref={resultScrollRef} className="h-full px-6 pb-6">
                <div className="space-y-3 font-mono text-sm leading-relaxed break-all">
                  {/* @deprecated 정적 분석 결과 - 관리자 페이지로 이전 예정
                  {Object.keys(staticAnalysisResults).length > 0 && (
                    <>
                      <div className="text-muted-foreground opacity-50">
                        ─────────────────────────────────
                      </div>
                      <div className="font-semibold text-foreground">
                        🔎 정적 분석 결과
                      </div>

                      <div className="space-y-3 font-sans">
                        {Object.entries(staticAnalysisResults).map(
                          ([projectKey, result]) => {
                            const blackduck = result.blackduck;
                            if (!blackduck) return null;

                            const categories =
                              blackduck.riskProfile?.raw?.categories ?? {};
                            const license = categories.LICENSE ?? {};
                            const vuln = categories.VULNERABILITY ?? {};

                            const licenseCritical = license.CRITICAL ?? 0;
                            const licenseHigh = license.HIGH ?? 0;
                            const vulnCritical = vuln.CRITICAL ?? 0;
                            const vulnHigh = vuln.HIGH ?? 0;

                            const totalActionTargets =
                              licenseCritical +
                              licenseHigh +
                              vulnCritical +
                              vulnHigh;

                            const badgeClass =
                              totalActionTargets > 0
                                ? 'text-red-700 bg-red-50 border-red-200'
                                : 'text-green-700 bg-green-50 border-green-200';

                            const highlightCount = (value: number) =>
                              value > 0
                                ? 'text-red-700 font-semibold'
                                : 'text-muted-foreground';

                            return (
                              <div
                                key={projectKey}
                                className="p-4 bg-muted/30 rounded-lg border space-y-2"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <div className="font-semibold">
                                      Black Duck ·{' '}
                                      {projectKey === 'hmg-board'
                                        ? 'HB'
                                        : projectKey}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      {blackduck.project?.name ?? '-'} ·{' '}
                                      {blackduck.version?.name ?? '-'}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      Scan:{' '}
                                      {blackduck.scan?.scannedAt
                                        ? new Date(
                                            blackduck.scan.scannedAt
                                          ).toLocaleString('ko-KR')
                                        : '-'}
                                    </div>
                                  </div>
                                  <div
                                    className={`text-xs font-semibold px-2 py-1 rounded border whitespace-nowrap ${badgeClass}`}
                                  >
                                    조치 대상 {totalActionTargets}
                                  </div>
                                </div>

                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                  <div className="text-sm">
                                    <div className="font-medium">LICENSE</div>
                                    <div className="text-xs text-muted-foreground">
                                      <span
                                        className={highlightCount(
                                          licenseCritical
                                        )}
                                      >
                                        CRITICAL {licenseCritical}
                                      </span>
                                      <span className="text-muted-foreground">
                                        {' '}
                                        ·{' '}
                                      </span>
                                      <span
                                        className={highlightCount(licenseHigh)}
                                      >
                                        HIGH {licenseHigh}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="text-sm">
                                    <div className="font-medium">
                                      VULNERABILITY
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      <span
                                        className={highlightCount(vulnCritical)}
                                      >
                                        CRITICAL {vulnCritical}
                                      </span>
                                      <span className="text-muted-foreground">
                                        {' '}
                                        ·{' '}
                                      </span>
                                      <span
                                        className={highlightCount(vulnHigh)}
                                      >
                                        HIGH {vulnHigh}
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                {blackduck.project?.url && (
                                  <div className="pt-1 flex justify-end">
                                    <Button variant="outline" size="sm" asChild>
                                      <a
                                        href={blackduck.project.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        <ExternalLink className="h-3 w-3" />
                                        조치하러 가기
                                      </a>
                                    </Button>
                                  </div>
                                )}
                              </div>
                            );
                          }
                        )}

                        {Object.entries(staticAnalysisResults).map(
                          ([projectKey, result]) => {
                            const sonarqube = result.sonarqube;
                            if (!sonarqube) return null;

                            const failed = (sonarqube.conditions ?? []).filter(
                              (c) => c.status && c.status !== 'OK'
                            );

                            return (
                              <div
                                key={`${projectKey}-sonarqube`}
                                className="p-4 bg-muted/30 rounded-lg border space-y-2"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <div className="font-semibold">
                                      SonarQube ·{' '}
                                      {projectKey === 'hmg-board'
                                        ? 'HB'
                                        : projectKey}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      {sonarqube.projectKey}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      Scan:{' '}
                                      {sonarqube.analysisDate
                                        ? new Date(
                                            sonarqube.analysisDate
                                          ).toLocaleString('ko-KR')
                                        : '-'}
                                    </div>
                                  </div>
                                  <div
                                    className={`text-xs font-semibold px-2 py-1 rounded border whitespace-nowrap ${
                                      sonarqube.ok
                                        ? 'text-green-700 bg-green-50 border-green-200'
                                        : 'text-red-700 bg-red-50 border-red-200'
                                    }`}
                                  >
                                    {sonarqube.qualityGateStatus}
                                  </div>
                                </div>

                                {failed.length > 0 && (
                                  <div className="text-xs text-muted-foreground space-y-1">
                                    {failed.slice(0, 5).map((c, idx) => (
                                      <div
                                        key={idx}
                                        className="flex items-center justify-between gap-3"
                                      >
                                        <span className="truncate">
                                          {c.metricKey ?? 'metric'}:{' '}
                                          {c.actualValue ?? '-'}
                                        </span>
                                        <span className="text-red-700 font-semibold">
                                          {c.status}
                                        </span>
                                      </div>
                                    ))}
                                    {failed.length > 5 && (
                                      <div>... (총 {failed.length}개)</div>
                                    )}
                                  </div>
                                )}

                                {(sonarqube.projectUrl ||
                                  sonarqube.baseUrl) && (
                                  <div className="pt-1 flex justify-end">
                                    <Button variant="outline" size="sm" asChild>
                                      <a
                                        href={
                                          sonarqube.projectUrl ||
                                          sonarqube.baseUrl
                                        }
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        <ExternalLink className="h-3 w-3" />
                                        조치하러 가기
                                      </a>
                                    </Button>
                                  </div>
                                )}
                              </div>
                            );
                          }
                        )}
                      </div>
                    </>
                  )} */}

                  {syncLogs.length === 0 &&
                  !isSyncing ? (
                    <>
                      <div className="text-muted-foreground">
                        <span className="text-green-500">[00:00:00]</span>{' '}
                        시스템 준비 완료...
                      </div>
                      <div className="text-muted-foreground">
                        <span className="text-blue-500">[00:00:01]</span> 작업
                        대기 중...
                      </div>
                      <div className="text-muted-foreground opacity-50">
                        ─────────────────────────────────
                      </div>
                      <div className="text-muted-foreground italic">
                        담당자를 선택하고 동기화 유형을 선택한 후
                        &ldquo;동기화&rdquo; 버튼을 클릭하세요
                      </div>
                    </>
                  ) : (
                    <>
                      {syncLogs.map((log, idx) => (
                        <div
                          key={idx}
                          className={`${
                            log.level === 'success'
                              ? 'text-green-600'
                              : log.level === 'error'
                                ? 'text-red-600'
                                : log.level === 'warning'
                                  ? 'text-yellow-600'
                                  : 'text-blue-600'
                          }`}
                        >
                          <span className="text-muted-foreground">
                            [{log.timestamp}]
                          </span>{' '}
                          <span className="whitespace-pre-wrap">
                            {emphasizeLogMessage(log.message)}
                          </span>
                        </div>
                      ))}

                    </>
                  )}
                </div>

                {/* 동기화 완료 후 결과 박스 */}
                {syncSummary && syncSummary.results.length > 0 && (
                  <div className="mt-4 px-1 text-sm font-sans">
                    <div className="font-semibold text-foreground mb-2">
                      📊 동기화 결과
                    </div>
                    <div className="mb-4 p-4 bg-muted/30 rounded-lg border border-muted space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">필드 동기화</span>
                        <span className="font-bold text-base">{syncSummary.totalUpdated}개</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">신규 생성</span>
                        <span className="font-bold text-base text-green-600">{syncSummary.totalCreated}개</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">동기화 실패</span>
                        <span className="font-bold text-base text-red-600">{syncSummary.totalFailed}개</span>
                      </div>
                    </div>
                    <div className="text-muted-foreground mb-2 font-semibold">
                      상세 결과
                    </div>
                    <div className="space-y-1">
                      {syncSummary.results.map((result, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <span className={result.success ? 'text-green-600' : 'text-red-600'}>
                            {result.success ? '✓' : '✗'}
                          </span>
                          <a
                            href={`${JIRA_ENDPOINTS.IGNITE}/browse/${result.sourceKey}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline inline-flex items-center gap-1"
                          >
                            {result.sourceKey}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          <span className="text-muted-foreground">→</span>
                          {result.targetKey ? (
                            <>
                              <a
                                href={`${
                                  projectInstanceMap[result.targetProject] === 'hmg'
                                    ? JIRA_ENDPOINTS.HMG
                                    : JIRA_ENDPOINTS.IGNITE
                                }/browse/${result.targetKey}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline inline-flex items-center gap-1"
                              >
                                {result.targetKey}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                              {result.isNewlyCreated && (
                                <span className="text-xs font-semibold text-green-600 bg-green-50 px-2 py-0.5 rounded">
                                  신규
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-red-600">생성 실패</span>
                          )}
                          {result.error && (
                            <span className="text-xs text-red-500">({result.error})</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
