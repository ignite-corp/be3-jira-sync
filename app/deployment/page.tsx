'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  FileText,
  Tag,
  Plus,
  ExternalLink,
  Copy,
  Rocket,
} from 'lucide-react';
import { toast } from 'sonner';
import { useCurrentUser } from '@/contexts/user-context';

type TabType = 'document' | 'tagging';
type DeploymentType = 'release' | 'adhoc' | 'hotfix';
type ProjectKey = 'groupware' | 'hmg-board' | 'cpo';

const DEPLOYMENT_TYPE_LABELS: Record<DeploymentType, string> = {
  release: '정기배포',
  adhoc: '비정기배포',
  hotfix: '핫픽스',
};

interface Ticket {
  key: string;
  summary: string;
  status: string;
  duedate: string | null;
  labels: string[];
}

// 현재 날짜를 YYYY-MM 형식으로 가져오기
const getCurrentMonth = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

export default function DeploymentPage() {
  const { currentUser } = useCurrentUser();

  // 탭 상태
  const [activeTab, setActiveTab] = useState<TabType>('document');

  // 팀 사용자 이름 목록 (DB 조회 — 담당자 드롭다운용)
  const [teamUserNames, setTeamUserNames] = useState<string[]>([]);

  useEffect(() => {
    if (!currentUser?.teamId) return;

    // 사용자 목록 조회 (API route 경유 — users 테이블은 anon RLS 차단됨)
    fetch('/api/users')
      .then((r) => r.json())
      .then((res: { success: boolean; data?: Array<{ name: string; teamId: string }> }) => {
        if (res.success && res.data) {
          setTeamUserNames(
            res.data
              .filter((u) => u.teamId === currentUser.teamId)
              .map((u) => u.name)
          );
        }
      })
      .catch(() => {
        // 조회 실패 시 드롭다운 비움 (선택 불가)
      });
  }, [currentUser?.teamId]);

  // === 탭1: 배포대장 문서 생성 ===
  const [docProject, setDocProject] = useState<ProjectKey>('groupware');
  const [deploymentType, setDeploymentType] = useState<DeploymentType | ''>('');
  const [baseDate, setBaseDate] = useState<string>('');
  const [isCreatingDoc, setIsCreatingDoc] = useState(false);
  const [createdDocUrl, setCreatedDocUrl] = useState<string>('');
  const [createdDocTitle, setCreatedDocTitle] = useState<string>('');
  const [existingDocUrl, setExistingDocUrl] = useState<string>('');
  const [recommendedDocs, setRecommendedDocs] = useState<
    Array<{
      id: string;
      title: string;
      url: string;
      type: string;
      date: string;
    }>
  >([]);
  const [upcomingDocs, setUpcomingDocs] = useState<
    Array<{
      id: string;
      title: string;
      url: string;
      type: string;
      date: string;
    }>
  >([]);
  const [pastDocs, setPastDocs] = useState<
    Array<{
      id: string;
      title: string;
      url: string;
      type: string;
      date: string;
    }>
  >([]);
  const [isLoadingDocs, setIsLoadingDocs] = useState(false);

  // === 탭2: 배포 대상 티켓 선정 ===
  const [tagProject, setTagProject] = useState<ProjectKey>('groupware');
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [baseMonth, setBaseMonth] = useState<string>(getCurrentMonth());
  const [isLoadingTickets, setIsLoadingTickets] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedTickets, setSelectedTickets] = useState<string[]>([]);
  const [deploymentLabel, setDeploymentLabel] = useState<string>('');
  const [needsQA, setNeedsQA] = useState<boolean>(false);
  const [isApplyingTags, setIsApplyingTags] = useState(false);
  const [appliedTickets, setAppliedTickets] = useState<string[]>([]);

  // 배포대장 문서 목록 조회
  useEffect(() => {
    const loadDeploymentDocs = async () => {
      setIsLoadingDocs(true);
      try {
        const response = await fetch('/api/deployment/list-documents');
        const result = await response.json();

        if (result.success) {
          setRecommendedDocs(result.recommended || []);
          setUpcomingDocs(result.upcoming || []);
          setPastDocs(result.past || []);
        }
      } catch {
        // 조용히 실패 처리
      } finally {
        setIsLoadingDocs(false);
      }
    };

    loadDeploymentDocs();
  }, []);

  // 배포대장 문서 생성 핸들러
  const handleCreateDocument = async () => {
    // 유효성 검증
    if (!docProject) {
      toast.error('프로젝트를 선택해주세요.');
      return;
    }
    if (!deploymentType) {
      toast.error('배포 종류를 선택해주세요.');
      return;
    }
    if (!baseDate) {
      toast.error('기준 날짜를 선택해주세요.');
      return;
    }

    setIsCreatingDoc(true);
    setCreatedDocUrl('');
    setCreatedDocTitle('');
    setExistingDocUrl('');

    try {
      const deploymentLabel = DEPLOYMENT_TYPE_LABELS[deploymentType];
      toast.info(
        `배포대장 문서를 생성하는 중... (${deploymentLabel} ${baseDate})`
      );

      const response = await fetch('/api/deployment/create-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: docProject,
          deploymentType: deploymentType,
          date: baseDate,
        }),
      });

      const result = await response.json();

      if (result.success) {
        setCreatedDocUrl(result.pageUrl);
        setCreatedDocTitle(`${deploymentType} ${baseDate}`);
        toast.success('배포대장 문서가 생성되었습니다!', { duration: 5000 });
      } else {
        // 중복 페이지가 있는 경우
        if (result.existingPageUrl) {
          setExistingDocUrl(result.existingPageUrl);
          toast.error('이미 같은 배포 종류와 날짜의 배포대장이 존재합니다.', {
            duration: 5000,
          });
        } else {
          toast.error(result.error || '문서 생성에 실패했습니다.');
        }
      }
    } catch (error) {
      toast.error(
        `문서 생성 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsCreatingDoc(false);
    }
  };

  // 배포대장 문서 링크 복사
  const handleCopyDocUrl = async () => {
    if (!createdDocUrl) return;
    try {
      await navigator.clipboard.writeText(createdDocUrl);
      toast.success('문서 링크가 복사되었습니다!');
    } catch {
      toast.error('복사에 실패했습니다.');
    }
  };

  // 티켓 조회 핸들러
  const handleFetchTickets = async () => {
    // 유효성 검증
    if (!tagProject) {
      toast.error('프로젝트를 선택해주세요.');
      return;
    }
    if (!selectedUser) {
      toast.error('담당자를 선택해주세요.');
      return;
    }
    if (!baseMonth) {
      toast.error('기준 월을 선택해주세요.');
      return;
    }

    setIsLoadingTickets(true);
    setTickets([]);
    setSelectedTickets([]);
    setAppliedTickets([]);

    try {
      toast.info('티켓을 조회하는 중...');

      const response = await fetch(
        `/api/deployment/my-tickets?project=${tagProject}&userName=${encodeURIComponent(selectedUser)}&baseMonth=${baseMonth}`
      );
      const result = await response.json();

      if (result.success && result.tickets) {
        setTickets(result.tickets);
        toast.success(`${result.tickets.length}개 티켓을 조회했습니다!`, {
          duration: 3000,
        });
      } else {
        toast.error(result.error || '티켓 조회에 실패했습니다.');
      }
    } catch (error) {
      toast.error(
        `티켓 조회 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsLoadingTickets(false);
    }
  };

  // 티켓 선택/해제
  const handleTicketToggle = (ticketKey: string) => {
    setSelectedTickets((prev) =>
      prev.includes(ticketKey)
        ? prev.filter((key) => key !== ticketKey)
        : [...prev, ticketKey]
    );
  };

  // 전체 선택/해제
  const handleSelectAll = () => {
    if (selectedTickets.length === tickets.length) {
      setSelectedTickets([]);
    } else {
      setSelectedTickets(tickets.map((t) => t.key));
    }
  };

  // 상태별 색상 클래스 반환
  const getStatusColorClass = (status: string) => {
    if (status === '완료' || status === 'Done') {
      return 'bg-green-100 text-green-700';
    } else if (status === '진행 중' || status === 'In Progress') {
      return 'bg-blue-100 text-blue-700';
    } else {
      return 'bg-gray-100 text-gray-700';
    }
  };

  // 배포태그 적용 핸들러
  const handleApplyTags = async () => {
    // 유효성 검증
    if (selectedTickets.length === 0) {
      toast.error('배포 대상 티켓을 선택해주세요.');
      return;
    }
    if (!deploymentLabel.trim()) {
      toast.error('배포 fixVersion을 입력해주세요.');
      return;
    }

    setIsApplyingTags(true);
    setAppliedTickets([]);

    try {
      toast.info(
        `${selectedTickets.length}개 티켓에 배포태그를 적용하는 중...`
      );

      // 적용할 fixVersion과 labels 구성
      const fixVersion = deploymentLabel.trim(); // 예: 'release_260226'
      const labels: string[] = ['FE', fixVersion];
      if (needsQA) {
        labels.push('QA필요');
      }

      const response = await fetch('/api/deployment/apply-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketKeys: selectedTickets,
          fixVersion: fixVersion,
          labels: labels,
        }),
      });

      const result = await response.json();

      if (result.success && result.successTickets) {
        setAppliedTickets(result.successTickets);

        if (result.failedTickets && result.failedTickets.length > 0) {
          toast.warning(
            `${result.successTickets.length}개 성공, ${result.failedTickets.length}개 실패`,
            { duration: 5000 }
          );
        } else {
          toast.success(
            `${result.successTickets.length}개 티켓에 배포태그가 적용되었습니다!`,
            { duration: 5000 }
          );
        }

        if (tagProject && selectedUser && baseMonth) {
          await handleFetchTickets();
        }
      } else {
        toast.error(result.error || '배포태그 적용에 실패했습니다.');
      }
    } catch (error) {
      toast.error(
        `배포태그 적용 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsApplyingTags(false);
    }
  };

  // 라벨 제거 핸들러
  const handleRemoveLabels = async () => {
    // 유효성 검증
    if (selectedTickets.length === 0) {
      toast.error('라벨을 제거할 티켓을 선택해주세요.');
      return;
    }

    // 확인 대화상자
    if (
      !window.confirm(
        `선택한 ${selectedTickets.length}개 티켓의 모든 라벨을 제거하시겠습니까?`
      )
    ) {
      return;
    }

    setIsApplyingTags(true);
    setAppliedTickets([]);

    try {
      toast.info(`${selectedTickets.length}개 티켓의 라벨을 제거하는 중...`);

      const response = await fetch('/api/deployment/apply-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketKeys: selectedTickets,
          labels: [], // 빈 배열로 라벨 제거
        }),
      });

      const result = await response.json();

      if (result.success && result.successTickets) {
        setAppliedTickets(result.successTickets);

        if (result.failedTickets && result.failedTickets.length > 0) {
          toast.warning(
            `${result.successTickets.length}개 성공, ${result.failedTickets.length}개 실패`,
            { duration: 5000 }
          );
        } else {
          toast.success(
            `${result.successTickets.length}개 티켓의 라벨이 제거되었습니다!`,
            { duration: 5000 }
          );
        }

        // 티켓 목록 새로고침 (라벨이 제거된 것을 반영)
        if (tagProject && selectedUser && baseMonth) {
          await handleFetchTickets();
        }
      } else {
        toast.error(result.error || '라벨 제거에 실패했습니다.');
      }
    } catch (error) {
      toast.error(
        `라벨 제거 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsApplyingTags(false);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">배포 대장 관리</h1>
            <p className="text-sm text-muted-foreground">
              배포대장 문서 생성 및 배포 대상 티켓 관리
            </p>
          </div>
          <Link href="/create-ticket">
            <Button variant="outline" size="sm">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              티켓 생성
            </Button>
          </Link>
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-8 max-w-5xl">
        {/* Tab Navigation */}
        <div className="flex gap-2 mb-6 border-b">
          <button
            onClick={() => setActiveTab('document')}
            className={`px-4 py-2 font-medium transition-colors relative ${
              activeTab === 'document'
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <FileText className="inline-block mr-2 h-4 w-4" />
            배포대장 문서 생성
            {activeTab === 'document' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('tagging')}
            className={`px-4 py-2 font-medium transition-colors relative ${
              activeTab === 'tagging'
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Tag className="inline-block mr-2 h-4 w-4" />
            배포 대상 티켓 선정
            {activeTab === 'tagging' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
            )}
          </button>
        </div>

        {/* Tab 1: 배포대장 문서 생성 */}
        {activeTab === 'document' && (
          <Card>
            <CardHeader>
              <CardTitle>배포대장 문서 자동 생성</CardTitle>
              <CardDescription>
                프로젝트, 배포 종류, 기준 날짜를 선택하면 Confluence 문서가
                자동으로 생성됩니다
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* 프로젝트 선택 */}
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-1">
                  프로젝트 선택
                  <span className="text-red-500">*</span>
                </label>
                <Select
                  value={docProject}
                  onValueChange={(value) => setDocProject(value as ProjectKey)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="프로젝트를 선택하세요" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="groupware">Groupware (GW)</SelectItem>
                    <SelectItem value="hmg-board" disabled>
                      HMG Board (HB)
                    </SelectItem>
                    <SelectItem value="cpo" disabled>
                      CPO
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  현재는 Groupware만 가능합니다.
                </p>
              </div>

              {/* 배포 종류 선택 */}
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-1">
                  배포 종류 선택
                  <span className="text-red-500">*</span>
                </label>
                <Select
                  value={deploymentType}
                  onValueChange={(value) =>
                    setDeploymentType(value as DeploymentType)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="배포 종류를 선택하세요" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="release">정기배포 (release)</SelectItem>
                    <SelectItem value="adhoc">비정기배포 (adhoc)</SelectItem>
                    <SelectItem value="hotfix">핫픽스 (hotfix)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* 기준 날짜 선택 */}
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-1">
                  기준 날짜 선택
                  <span className="text-red-500">*</span>
                </label>
                <Input
                  type="date"
                  value={baseDate}
                  onChange={(e) => setBaseDate(e.target.value)}
                />
                {baseDate && deploymentType && (
                  <p className="text-xs text-blue-600">
                    → 생성될 제목: Dev) 배포 관리 - {deploymentType} {baseDate}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  선택한 날짜를 기준으로 배포대장이 생성됩니다
                </p>
              </div>

              {/* 생성 버튼 */}
              <div className="pt-4 border-t">
                <Button
                  onClick={handleCreateDocument}
                  disabled={
                    isCreatingDoc || !docProject || !deploymentType || !baseDate
                  }
                  className="w-full"
                  size="lg"
                >
                  <Rocket
                    className={`mr-2 h-4 w-4 ${isCreatingDoc ? 'animate-spin' : ''}`}
                  />
                  {isCreatingDoc ? '문서 생성 중...' : '배포대장 문서 생성'}
                </Button>
              </div>

              {/* 생성 결과 */}
              {createdDocUrl && (
                <div className="pt-4 border-t">
                  <div className="p-4 bg-green-50 border border-green-200 rounded-lg space-y-3">
                    <p className="text-sm font-semibold text-green-900">
                      ✓ 배포대장 문서가 생성되었습니다!
                    </p>
                    {createdDocTitle && (
                      <p className="text-sm text-green-900/90">
                        <span className="font-medium">제목:</span> Dev) 배포
                        관리 - {createdDocTitle}
                      </p>
                    )}
                    <div className="flex flex-col gap-2">
                      <a
                        href={createdDocUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline inline-flex items-center gap-1 font-medium text-sm break-all"
                      >
                        배포대장으로 이동
                        <ExternalLink className="h-4 w-4 flex-shrink-0" />
                      </a>
                      <div className="flex gap-2">
                        <Button
                          onClick={handleCopyDocUrl}
                          variant="outline"
                          size="sm"
                          className="w-fit"
                        >
                          <Copy className="mr-2 h-3 w-3" />
                          문서 링크 복사
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 중복 페이지 경고 */}
              {existingDocUrl && (
                <div className="pt-4 border-t">
                  <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg space-y-3">
                    <p className="text-sm font-semibold text-yellow-900">
                      ⚠️ 이미 존재하는 배포대장
                    </p>
                    <p className="text-sm text-yellow-900/90">
                      같은 배포 종류와 날짜의 배포대장이 이미 존재합니다.
                    </p>
                    <div className="flex flex-col gap-2">
                      <a
                        href={existingDocUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline inline-flex items-center gap-1 font-medium text-sm break-all"
                      >
                        기존 배포대장으로 이동
                        <ExternalLink className="h-4 w-4 flex-shrink-0" />
                      </a>
                    </div>
                  </div>
                </div>
              )}

              {/* 기존 배포대장 목록 */}
              <div className="pt-6 border-t space-y-6">
                {/* 헤더 */}
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">배포대장 목록</h3>
                  {isLoadingDocs && (
                    <span className="text-xs text-muted-foreground">
                      로딩 중...
                    </span>
                  )}
                </div>

                {/* 추천 배포대장 */}
                {recommendedDocs.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-blue-700 flex items-center gap-1">
                      <span>⭐</span>
                      추천 배포대장
                    </h4>
                    <div className="grid grid-cols-1 gap-2">
                      {recommendedDocs.map((doc) => (
                        <a
                          key={doc.id}
                          href={doc.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-between gap-2 p-3 rounded-lg border border-blue-300 bg-blue-50 hover:bg-blue-100 transition-colors shadow-sm"
                        >
                          <span className="text-sm font-semibold text-blue-900">
                            {doc.title}
                          </span>
                          <ExternalLink className="h-4 w-4 flex-shrink-0 text-blue-700" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {/* 전체 배포대장 (미래) */}
                {upcomingDocs.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-muted-foreground">
                      전체 배포대장
                    </h4>
                    <div className="space-y-1">
                      {upcomingDocs.map((doc) => (
                        <a
                          key={doc.id}
                          href={doc.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-between gap-2 p-2 rounded border border-gray-200 bg-white hover:bg-gray-50 transition-colors"
                        >
                          <span className="text-sm text-foreground truncate">
                            {doc.title}
                          </span>
                          <ExternalLink className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {/* 지나간 배포대장 */}
                {pastDocs.length > 0 && (
                  <details className="space-y-2">
                    <summary className="text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground">
                      지나간 배포대장 ({pastDocs.length}개)
                    </summary>
                    <div className="space-y-1 mt-2 max-h-96 overflow-y-auto">
                      {pastDocs.map((doc) => (
                        <a
                          key={doc.id}
                          href={doc.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-between gap-2 p-2 rounded border border-gray-200 bg-gray-50/50 hover:bg-gray-100/50 transition-colors opacity-75"
                        >
                          <span className="text-xs text-muted-foreground truncate">
                            {doc.title}
                          </span>
                          <ExternalLink className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                        </a>
                      ))}
                    </div>
                  </details>
                )}

                {/* 로딩 완료 후 배포대장이 없는 경우 */}
                {!isLoadingDocs &&
                  recommendedDocs.length === 0 &&
                  upcomingDocs.length === 0 &&
                  pastDocs.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      배포대장이 없습니다
                    </p>
                  )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tab 2: 배포 대상 티켓 선정 */}
        {activeTab === 'tagging' && (
          <Card>
            <CardHeader>
              <CardTitle>배포 대상 티켓 선정</CardTitle>
              <CardDescription>
                담당자와 기준 월을 선택하여 티켓을 조회하고 배포태그를
                적용합니다
              </CardDescription>
              <p className="text-xs text-amber-600 mt-1">
                현재는 팀의 기준 프로젝트(예: BE3) 티켓만 지원합니다
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* 프로젝트 선택 */}
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-1">
                  프로젝트 선택
                  <span className="text-red-500">*</span>
                </label>
                <Select
                  value={tagProject}
                  onValueChange={(value) => {
                    setTagProject(value as ProjectKey);
                    setTickets([]);
                    setSelectedTickets([]);
                    setAppliedTickets([]);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="프로젝트를 선택하세요" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="groupware">Groupware (GW)</SelectItem>
                    <SelectItem value="hmg-board">HMG Board (HB)</SelectItem>
                    <SelectItem value="cpo" disabled>
                      CPO
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* 담당자 선택 */}
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-1">
                  담당자 선택
                  <span className="text-red-500">*</span>
                </label>
                <Select
                  value={selectedUser}
                  onValueChange={(value) => {
                    setSelectedUser(value);
                    setTickets([]);
                    setSelectedTickets([]);
                    setAppliedTickets([]);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="담당자를 선택하세요" />
                  </SelectTrigger>
                  <SelectContent>
                    {teamUserNames.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 기준 월 선택 */}
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-1">
                  기준 월 선택
                  <span className="text-red-500">*</span>
                </label>
                <Input
                  type="month"
                  value={baseMonth}
                  onChange={(e) => {
                    setBaseMonth(e.target.value);
                    setTickets([]);
                    setSelectedTickets([]);
                    setAppliedTickets([]);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  선택한 월의 티켓만 조회됩니다
                </p>
              </div>

              {/* 티켓 조회 버튼 */}
              <div className="pt-4 border-t">
                <Button
                  onClick={handleFetchTickets}
                  disabled={
                    isLoadingTickets ||
                    !tagProject ||
                    !selectedUser ||
                    !baseMonth
                  }
                  className="w-full"
                  size="lg"
                >
                  <Tag
                    className={`mr-2 h-4 w-4 ${isLoadingTickets ? 'animate-spin' : ''}`}
                  />
                  {isLoadingTickets ? '조회 중...' : '티켓 조회'}
                </Button>
              </div>

              {/* 티켓 목록 */}
              {tickets.length > 0 && (
                <>
                  <div className="pt-4 border-t space-y-4">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium flex items-center gap-1">
                        배포 대상 티켓 선택
                        <span className="text-red-500">*</span>
                      </label>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleSelectAll}
                      >
                        {selectedTickets.length === tickets.length
                          ? '전체 해제'
                          : '전체 선택'}
                      </Button>
                    </div>

                    <div className="border rounded-lg p-4 space-y-2 max-h-96 overflow-y-auto">
                      {tickets.map((ticket) => (
                        <label
                          key={ticket.key}
                          className="flex items-start gap-3 p-2 rounded hover:bg-muted cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selectedTickets.includes(ticket.key)}
                            onChange={() => handleTicketToggle(ticket.key)}
                            className="mt-1 cursor-pointer"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <a
                                href={`https://hmg.atlassian.net/browse/${ticket.key}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-xs text-blue-600 hover:text-blue-800 hover:underline font-medium inline-flex items-center gap-1"
                              >
                                {ticket.key}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                              {ticket.labels && ticket.labels.length > 0 && (
                                <div className="flex gap-1 flex-wrap">
                                  {ticket.labels.slice(0, 3).map((label) => (
                                    <span
                                      key={label}
                                      className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium"
                                    >
                                      {label}
                                    </span>
                                  ))}
                                  {ticket.labels.length > 3 && (
                                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                                      +{ticket.labels.length - 3}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className="text-sm font-medium text-foreground truncate">
                              {ticket.summary}
                            </div>
                            <div className="text-xs mt-1 flex gap-2 items-center">
                              <span
                                className={`px-2 py-0.5 rounded-full font-medium ${getStatusColorClass(ticket.status)}`}
                              >
                                {ticket.status}
                              </span>
                              {ticket.duedate && (
                                <span className="text-muted-foreground">
                                  종료일: {ticket.duedate}
                                </span>
                              )}
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>

                    <p className="text-xs text-muted-foreground">
                      {selectedTickets.length}개 티켓 선택됨
                    </p>
                  </div>

                  {/* fixVersion 입력 */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center gap-1">
                      배포 fixVersion
                      <span className="text-red-500">*</span>
                    </label>
                    <Input
                      placeholder="예: release_260226"
                      value={deploymentLabel}
                      onChange={(e) => setDeploymentLabel(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      배포 종류와 날짜를 조합한 fixVersion을 입력하세요 (예:
                      release_260226, hotfix_260101, adhoc_251225)
                    </p>
                  </div>

                  {/* QA 필요 체크박스 */}
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={needsQA}
                        onChange={(e) => setNeedsQA(e.target.checked)}
                        className="cursor-pointer"
                      />
                      <span className="text-sm font-medium">
                        QA 필요 (QA필요 레이블 자동 추가)
                      </span>
                    </label>
                    <p className="text-xs text-muted-foreground pl-6">
                      체크 시 &apos;QA필요&apos; 레이블이 자동으로 추가되며,
                      &apos;FE&apos; 레이블은 기본으로 추가됩니다
                    </p>
                  </div>

                  {/* 적용 버튼 */}
                  <div className="pt-4 border-t space-y-2">
                    <Button
                      onClick={handleApplyTags}
                      disabled={
                        isApplyingTags ||
                        selectedTickets.length === 0 ||
                        !deploymentLabel.trim()
                      }
                      className="w-full"
                      size="lg"
                    >
                      <Tag
                        className={`mr-2 h-4 w-4 ${isApplyingTags ? 'animate-spin' : ''}`}
                      />
                      {isApplyingTags
                        ? '적용 중...'
                        : '배포대장에 티켓 추가하기'}
                    </Button>
                    <Button
                      onClick={handleRemoveLabels}
                      disabled={isApplyingTags || selectedTickets.length === 0}
                      variant="outline"
                      className="w-full"
                      size="lg"
                    >
                      <Tag
                        className={`mr-2 h-4 w-4 ${isApplyingTags ? 'animate-spin' : ''}`}
                      />
                      {isApplyingTags
                        ? '처리 중...'
                        : '선택한 티켓의 라벨 제거'}
                    </Button>
                    <p className="text-xs text-muted-foreground text-center">
                      라벨 제거 시 선택한 티켓의 모든 라벨이 삭제됩니다
                    </p>
                  </div>

                  {/* 적용 결과 */}
                  {appliedTickets.length > 0 && (
                    <div className="pt-4 border-t">
                      <div className="p-4 bg-green-50 border border-green-200 rounded-lg space-y-3">
                        <p className="text-sm font-semibold text-green-900">
                          ✓ {appliedTickets.length}개 티켓에 배포태그가
                          적용되었습니다!
                        </p>
                        <div className="text-xs text-muted-foreground">
                          적용된 fixVersion: {deploymentLabel}, labels: FE
                          {needsQA && ', QA필요'}
                        </div>
                        <div className="space-y-1 max-h-48 overflow-y-auto">
                          {appliedTickets.map((ticketKey) => (
                            <a
                              key={ticketKey}
                              href={`https://hmg.atlassian.net/browse/${ticketKey}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline inline-flex items-center gap-1 text-sm block"
                            >
                              {ticketKey}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* 티켓 조회 전 안내 */}
              {tickets.length === 0 && !isLoadingTickets && (
                <div className="text-center py-8 text-muted-foreground">
                  <Tag className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">
                    담당자와 기준 월을 선택한 후 &apos;티켓 조회&apos; 버튼을
                    클릭하세요
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
