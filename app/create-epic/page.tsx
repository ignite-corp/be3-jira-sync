'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { jiraFetch } from '@/lib/jira-fetch';
import { db } from '@/lib/db';
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
  Plus,
  ExternalLink,
  Copy,
  Network,
} from 'lucide-react';
import { toast } from 'sonner';
import { JIRA_ENDPOINTS } from '@/lib/constants/jira';
import { useCurrentUser } from '@/contexts/user-context';

/** 소스 프로젝트 기준 HMG 타겟 동기화 프로필 */
interface HmgSyncProfile {
  id: string;
  name: string;
  targetProjectName: string;
}

export default function CreateEpicPage() {
  const { currentUser } = useCurrentUser();
  const sourceProject = currentUser?.sourceProject || '';

  // 입력 필드
  const [summary, setSummary] = useState<string>('');

  // HMG 동기화 프로필 (허용 에픽 등록 대상)
  const [hmgProfiles, setHmgProfiles] = useState<HmgSyncProfile[]>([]);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<string>>(
    new Set()
  );

  // 생성 상태
  const [isCreating, setIsCreating] = useState(false);
  const [createdEpicKey, setCreatedEpicKey] = useState<string>('');
  const [registeredProfileNames, setRegisteredProfileNames] = useState<
    string[]
  >([]);

  // 소스 프로젝트 기준 HMG 타겟 동기화 프로필 조회
  useEffect(() => {
    if (!sourceProject) return;

    const loadProfiles = async () => {
      setIsLoadingProfiles(true);
      try {
        // 소스 프로젝트 ID 조회
        const { data: project } = await db
          .from('projects')
          .select('id')
          .eq('name', sourceProject)
          .eq('jira_instance', 'ignite')
          .single();

        if (!project) return;

        // 소스 프로젝트를 사용하는 동기화 프로필 조회 (타겟이 HMG인 것만)
        const { data: profiles } = await db
          .from('sync_profiles')
          .select('id, name, target:target_project_id(name, jira_instance)')
          .eq('source_project_id', project.id);

        if (!profiles) return;

        setHmgProfiles(
          profiles
            .map((p) => {
              const target = p.target as unknown as {
                name: string;
                jira_instance: string;
              } | null;
              return {
                id: p.id as string,
                name: p.name as string,
                targetProjectName: target?.name || '?',
                targetInstance: target?.jira_instance || '',
              };
            })
            .filter((p) => p.targetInstance === 'hmg')
            .map(({ id, name, targetProjectName }) => ({
              id,
              name,
              targetProjectName,
            }))
        );
      } finally {
        setIsLoadingProfiles(false);
      }
    };

    loadProfiles();
  }, [sourceProject]);

  const toggleProfile = (profileId: string) => {
    setSelectedProfileIds((prev) => {
      const next = new Set(prev);
      if (next.has(profileId)) {
        next.delete(profileId);
      } else {
        next.add(profileId);
      }
      return next;
    });
  };

  /**
   * 에픽 생성 핸들러
   */
  const handleCreateEpic = async () => {
    // 유효성 검증
    if (!summary.trim()) {
      toast.error('에픽 제목을 입력해주세요.');
      return;
    }
    if (!sourceProject) {
      toast.error('소스 프로젝트가 설정되지 않았습니다. 팀의 기준 프로젝트를 먼저 설정해주세요.');
      return;
    }

    setIsCreating(true);
    setCreatedEpicKey('');
    setRegisteredProfileNames([]);

    try {
      toast.info(`"${summary}" 에픽 생성을 시작합니다...`);

      // 1. 소스 프로젝트 에픽 생성
      const payload = {
        fields: {
          project: { key: sourceProject },
          summary,
          issuetype: { id: '10365' }, // 에픽 타입 ID
        },
      };

      const response = await jiraFetch('/api/jira/ignite/issue', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!result.success || !result.data) {
        toast.error(result.error || `${sourceProject} 에픽 생성에 실패했습니다.`);
        return;
      }

      const epicKey = result.data.key;
      setCreatedEpicKey(epicKey);
      toast.success(`${sourceProject} 에픽이 생성되었습니다! (${epicKey})`, {
        duration: 3000,
      });

      // 2. 선택한 HMG 동기화 프로필에 허용 에픽으로 등록
      if (selectedProfileIds.size > 0) {
        toast.info('동기화 프로필에 허용 에픽을 등록하는 중...');

        const { error: insertError } = await db
          .from('sync_profile_allowed_epics')
          .insert(
            Array.from(selectedProfileIds).map((profileId) => ({
              profile_id: profileId,
              epic_key: epicKey,
              epic_summary: summary,
            }))
          );

        if (insertError) {
          toast.warning(
            `허용 에픽 등록에 실패했습니다: ${insertError.message}. 설정 > 필드 매핑에서 수동으로 등록해주세요.`,
            { duration: 5000 }
          );
        } else {
          const names = hmgProfiles
            .filter((p) => selectedProfileIds.has(p.id))
            .map((p) => p.name);
          setRegisteredProfileNames(names);
          toast.success(
            `허용 에픽으로 등록되었습니다! (${names.join(', ')})`,
            { duration: 3000 }
          );
        }
      }

      // 최종 성공 메시지
      toast.success('에픽 생성이 완료되었습니다!', { duration: 5000 });

      // 입력 필드 초기화 (다음 에픽 생성 준비)
      setSummary('');
      setSelectedProfileIds(new Set());
    } catch (error) {
      toast.error(
        `에픽 생성 중 오류가 발생했습니다: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsCreating(false);
    }
  };

  /**
   * 생성된 에픽 링크 복사
   */
  const handleCopyEpicLink = async () => {
    if (!createdEpicKey) return;
    const url = `${JIRA_ENDPOINTS.IGNITE}/browse/${createdEpicKey}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(`${sourceProject} 에픽 링크가 복사되었습니다!`);
    } catch {
      toast.error('복사에 실패했습니다.');
    }
  };

  return (
    <main className="min-h-screen bg-background">
      {/* Page Context Header */}
      <div className="border-b">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">{sourceProject} 에픽 생성</h1>
            <p className="text-sm text-muted-foreground">
              새로운 {sourceProject} 에픽을 생성합니다 (팀장용)
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/flow-chart">
              <Button variant="outline" size="sm">
                <Network className="mr-1.5 h-3.5 w-3.5" />
                Flow Chart
              </Button>
            </Link>
            <Link href="/create-ticket">
              <Button variant="outline" size="sm">
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                티켓 생성
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-8 max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle>에픽 정보</CardTitle>
            <CardDescription>
              에픽 제목을 입력하고, 필요 시 HMG 동기화 프로필에 허용 에픽으로
              등록하세요
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* 에픽 제목 입력 */}
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-1">
                에픽 제목 (Summary)
                <span className="text-red-500">*</span>
              </label>
              <Input
                placeholder="에픽 제목을 입력하세요"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                maxLength={200}
              />
              <p className="text-xs text-muted-foreground">
                {summary.length}/200자
              </p>
            </div>

            {/* HMG 동기화 프로필 허용 에픽 등록 (선택) */}
            <div className="space-y-3">
              <label className="text-sm font-medium">
                HMG 동기화 허용 에픽 등록 (선택)
              </label>
              {isLoadingProfiles ? (
                <p className="text-xs text-muted-foreground">
                  동기화 프로필을 불러오는 중...
                </p>
              ) : hmgProfiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {sourceProject
                    ? `${sourceProject}를 소스로 하는 HMG 동기화 프로필이 없습니다. 설정 > 필드 매핑에서 프로필을 먼저 생성하세요.`
                    : '소스 프로젝트가 설정되지 않았습니다.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {hmgProfiles.map((profile) => (
                    <label
                      key={profile.id}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedProfileIds.has(profile.id)}
                        onChange={() => toggleProfile(profile.id)}
                        className="w-4 h-4 cursor-pointer"
                      />
                      <span className="text-sm">
                        {profile.name}
                        <span className="ml-1 text-xs text-muted-foreground">
                          (→ {profile.targetProjectName})
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {selectedProfileIds.size > 0
                  ? '✅ 생성된 에픽이 선택한 프로필의 동기화 대상(허용 에픽)으로 등록됩니다'
                  : `ℹ️ 선택하지 않으면 ${sourceProject || '소스 프로젝트'}에만 에픽이 생성됩니다`}
              </p>
            </div>

            {/* 생성 버튼 */}
            <div className="pt-4 border-t">
              <Button
                onClick={handleCreateEpic}
                disabled={isCreating || !summary.trim() || !sourceProject}
                className="w-full"
                size="lg"
              >
                <Plus
                  className={`mr-2 h-4 w-4 ${isCreating ? 'animate-spin' : ''}`}
                />
                {isCreating ? '에픽 생성 중...' : '에픽 생성'}
              </Button>
            </div>

            {/* 생성 결과 */}
            {createdEpicKey && (
              <div className="pt-4 border-t space-y-4">
                {/* 소스 프로젝트 에픽 */}
                <div className="p-4 bg-green-50 border border-green-200 rounded-lg space-y-3">
                  <p className="text-sm font-semibold text-green-900">
                    ✓ {sourceProject} 에픽 생성 완료!
                  </p>
                  <div className="flex flex-col gap-2">
                    <a
                      href={`${JIRA_ENDPOINTS.IGNITE}/browse/${createdEpicKey}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline inline-flex items-center gap-1 font-medium"
                    >
                      {createdEpicKey} 에픽으로 이동
                      <ExternalLink className="h-4 w-4" />
                    </a>
                    <Button
                      onClick={handleCopyEpicLink}
                      variant="outline"
                      size="sm"
                      className="w-fit"
                    >
                      <Copy className="mr-2 h-3 w-3" />
                      {sourceProject} 링크 복사
                    </Button>
                  </div>
                </div>

                {/* 허용 에픽 등록 결과 */}
                {registeredProfileNames.length > 0 && (
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
                    <p className="text-sm font-semibold text-blue-900">
                      ✓ 동기화 허용 에픽 등록 완료!
                    </p>
                    <p className="text-xs text-muted-foreground">
                      등록된 프로필: {registeredProfileNames.join(', ')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      등록된 허용 에픽은 메인 화면의 에픽 동기화 실행 시 타겟
                      프로젝트에 매칭/생성됩니다.
                    </p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
