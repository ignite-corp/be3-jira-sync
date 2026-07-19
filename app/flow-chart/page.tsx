'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Download, Plus } from 'lucide-react';

// Mermaid 타입 정의
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mermaid?: any;
  }
}

export default function FlowChartPage() {
  const [activeTab, setActiveTab] = useState<number>(1);
  const mermaidRef = useRef<HTMLDivElement>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [svgContent, setSvgContent] = useState<string>('');

  // Mermaid 초기화
  useEffect(() => {
    const loadMermaid = async () => {
      if (typeof window !== 'undefined') {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'default',
          flowchart: {
            curve: 'basis',
            padding: 20,
          },
          themeVariables: {
            primaryColor: '#3b82f6',
            primaryTextColor: '#fff',
            primaryBorderColor: '#2563eb',
            lineColor: '#64748b',
            secondaryColor: '#10b981',
            tertiaryColor: '#ef4444',
            fontSize: '14px',
          },
        });
        window.mermaid = mermaid;
        setIsLoaded(true);
      }
    };

    loadMermaid();
  }, []);

  const flowCharts = [
    {
      id: 1,
      title: '1. 전체 동기화 플로우',
      description:
        '담당자 선택 → 전체 → 동기화 버튼 (DB sync_profile 기반, 소스 프로젝트: BE3)',
      diagram: `
flowchart TD
    Start([사용자: 담당자 선택]) --> SelectType[동기화 타입: 전체 선택]
    SelectType --> ClickBtn[동기화 버튼 클릭]

    ClickBtn --> Validate{검증}
    Validate -->|실패| ErrorToast[Toast 에러 표시]
    ErrorToast --> End([종료])

    Validate -->|성공| HandleSync[handleSync 실행]
    HandleSync --> CreateOrch[SyncOrchestrator 생성<br/>+ 로그 콜백 설정]

    CreateOrch --> Execute[orchestrator.execute]

    Execute --> InitCache[캐시 초기화<br/>스프린트 / DB 매핑 / 전이 / 에픽]
    InitCache --> ResolveSource[소스 프로젝트 결정<br/>DB sync_profiles 기반]
    ResolveSource --> LoadProfiles[동기화 프로필 로드<br/>타겟 프로젝트 + 필드 매핑 + 허용 에픽]

    LoadProfiles --> PreloadSprint{스프린트 프리로드<br/>projects.board_id}

    PreloadSprint -.병렬.-> LoadT1[타겟 프로젝트 1<br/>스프린트 조회]
    PreloadSprint -.병렬.-> LoadT2[타겟 프로젝트 2<br/>스프린트 조회]
    PreloadSprint -.병렬.-> LoadTN[타겟 프로젝트 N<br/>스프린트 조회]

    LoadT1 --> SprintDone[프리로드 완료]
    LoadT2 --> SprintDone
    LoadTN --> SprintDone

    SprintDone --> FetchSource[소스 티켓 조회<br/>JQL: project = BE3 AND assignee = ...<br/>AND due 컷오프 이후]

    FetchSource --> CheckTickets{티켓 존재?}
    CheckTickets -->|없음| Warning[경고 로그 + 종료]
    Warning --> Summary

    CheckTickets -->|있음| Classify[티켓 분류 1회 순회<br/>같은 인스턴스: Blocks 링크 prefix<br/>HMG: link_field 또는 허용 에픽]

    Classify --> ClassifyResult{프로젝트별 분류 완료}

    ClassifyResult --> ProjectSync[타겟 프로젝트별 순차 동기화]

    ProjectSync --> SyncEach[각 타겟 프로젝트<br/>청크 단위 병렬 처리]

    SyncEach --> AllComplete[모든 프로젝트 완료]
    AllComplete --> Summary[결과 요약 생성]

    Summary --> CalcStats[통계 계산<br/>• 총 처리<br/>• 성공/실패<br/>• 신규 생성/업데이트]

    CalcStats --> UIUpdate[UI 업데이트<br/>• 로그 표시<br/>• 링크 생성<br/>• Toast 알림]

    UIUpdate --> End

    style Start fill:#3b82f6,color:#fff
    style End fill:#10b981,color:#fff
    style ErrorToast fill:#ef4444,color:#fff
    style Warning fill:#f59e0b,color:#fff
    style Execute fill:#8b5cf6,color:#fff
    style PreloadSprint fill:#ec4899,color:#fff
    style ProjectSync fill:#8b5cf6,color:#fff
    style SyncEach fill:#ec4899,color:#fff
    style Summary fill:#10b981,color:#fff
`,
    },
    {
      id: 2,
      title: '2-1. 같은 인스턴스 동기화',
      description:
        '소스 프로젝트(BE3) → 같은 Jira 내 타겟 프로젝트 (Blocks 링크 기반 업데이트)',
      diagram: `
flowchart TD
    Start([담당자 선택])
    Start --> GetUser[사용자 정보 조회<br/>DB users 테이블]
    GetUser --> UserInfo[ignite_account_id 추출]

    UserInfo --> ClickBtn[동기화 버튼]

    ClickBtn --> Execute[orchestrator.execute]
    Execute --> LoadProfile[동기화 프로필 로드<br/>DB sync_profiles]

    LoadProfile --> PreloadSprint[스프린트 캐싱<br/>projects.board_id 보드 조회]
    PreloadSprint --> SprintCache[캐시 저장<br/>Map boardId to SprintInfo]
    SprintCache --> FetchSource[소스 티켓 조회<br/>BE3]

    FetchSource --> Classify[issuelinks 확인<br/>Blocks 관계 + 타겟 키 prefix]
    Classify --> FindLinked[타겟 프로젝트 티켓 찾기]

    FindLinked --> SyncTicket[IgniteSyncService.syncTicket]
    SyncTicket --> MapFields[필드 매핑<br/>DB sync_field_mappings]

    MapFields --> Transform[transform_type별 변환<br/>copy / 스프린트 등]
    Transform --> SprintMap[스프린트 매핑<br/>캐시에서 이름 매칭 후 ID 조회]

    SprintMap --> UpdateFields[jira.ignite.updateIssueFields<br/>PUT /rest/api/3/issue]
    UpdateFields --> StatusSync[상태 동기화]

    StatusSync --> MapStatus[sync_profile_status_mappings<br/>소스 상태 to 타겟 상태]
    MapStatus --> BFS[BFS 전이 경로 탐색<br/>sync_profile_workflows + 런타임]
    BFS --> Transition[jira.ignite.updateIssueStatus<br/>POST transitions]

    Transition --> Complete[동기화 완료]
    Complete --> End([종료])

    style Start fill:#3b82f6,color:#fff
    style End fill:#10b981,color:#fff
    style Execute fill:#8b5cf6,color:#fff
    style SprintCache fill:#f59e0b,color:#fff
    style MapFields fill:#ec4899,color:#fff
    style SprintMap fill:#f59e0b,color:#fff
    style UpdateFields fill:#10b981,color:#fff
    style Transition fill:#10b981,color:#fff
`,
    },
    {
      id: 3,
      title: '2-2. HMG 인스턴스 동기화',
      description:
        '소스 프로젝트(BE3) → HMG 타겟 프로젝트 (GIDPDVO 등) 생성/업데이트',
      diagram: `
flowchart TD
    Start([담당자 선택])
    Start --> GetUser[사용자 정보 조회<br/>DB users 테이블]
    GetUser --> UserInfo[ignite_account_id<br/>hmg_account_id 추출]

    UserInfo --> ClickBtn[동기화 버튼]

    ClickBtn --> Execute[HMGSyncService.syncTicket]
    Execute --> CheckField[프로필 link_field 확인]

    CheckField --> HasLink{타겟 티켓 링크<br/>존재?}

    HasLink -->|없음| EnsureEpic[부모 에픽 확보<br/>타겟에서 소스키 prefix<br/>summary 매칭]
    EnsureEpic --> EpicFound{동일 summary<br/>에픽 존재?}
    EpicFound -->|없음| CreateEpic[타겟 에픽 신규 생성]
    EpicFound -->|있음| EpicStatus[에픽 상태 동기화<br/>완료 상태면 스킵]
    CreateEpic --> EpicStatus

    EpicStatus --> MapCreate[필드 매핑<br/>DB sync_field_mappings]
    MapCreate --> CreateTicket[jira.hmg.createIssue<br/>POST /rest/api/3/issue]
    CreateTicket --> SaveLink[소스 티켓 link_field에<br/>타겟 티켓 URL 저장]
    SaveLink --> StatusSync[상태 동기화]

    HasLink -->|있음| UpdateFlow[기존 티켓 업데이트 플로우]
    UpdateFlow --> ExtractKey[타겟 키 추출<br/>정규식 매칭]
    ExtractKey --> MapUpdate[필드 매핑<br/>생성과 동일]

    MapUpdate --> UpdateTicket[jira.hmg.updateIssue<br/>PUT /rest/api/3/issue]
    UpdateTicket --> StatusSync

    StatusSync --> MapStatus[sync_profile_status_mappings<br/>소스 상태 to 타겟 상태]
    MapStatus --> BFS[런타임 BFS transition<br/>multi-step 자동 처리]

    BFS --> Complete[동기화 완료]
    Complete --> End([종료])

    style Start fill:#3b82f6,color:#fff
    style End fill:#10b981,color:#fff
    style CheckField fill:#8b5cf6,color:#fff
    style EnsureEpic fill:#ec4899,color:#fff
    style UpdateFlow fill:#06b6d4,color:#fff
    style CreateTicket fill:#10b981,color:#fff
    style SaveLink fill:#f59e0b,color:#fff
    style MapStatus fill:#f59e0b,color:#fff
    style BFS fill:#10b981,color:#fff
`,
    },
    {
      id: 4,
      title: '3. 에픽 지정 동기화',
      description: '담당자 선택 → 에픽 지정 → BE3-123 입력 → 동기화 버튼',
      diagram: `
flowchart TD
    Start([담당자 선택])
    Start --> InputEpic[에픽 번호 입력]
    InputEpic --> ClickBtn[동기화 버튼]

    ClickBtn --> HandleSync[handleSync]
    HandleSync --> Execute[execute]
    Execute --> FilterProfiles[허용 에픽으로 대상 프로필 필터<br/>sync_profile_allowed_epics]

    FilterProfiles --> FetchTickets[하위 티켓 조회<br/>JQL: parent = 에픽 키]
    FetchTickets --> Classify[티켓 분류]

    Classify --> SyncLoop[프로젝트별 동기화]
    SyncLoop --> Summary[결과 요약]
    Summary --> End([종료])

    style Start fill:#3b82f6,color:#fff
    style End fill:#10b981,color:#fff
    style Execute fill:#8b5cf6,color:#fff
    style SyncLoop fill:#ec4899,color:#fff
    style Summary fill:#10b981,color:#fff
`,
    },
    {
      id: 5,
      title: '4. 티켓 지정 동기화',
      description: '담당자 선택 → 티켓 지정 → BE3-456 입력 → 동기화 버튼',
      diagram: `
flowchart TD
    Start([담당자 선택])
    Start --> InputTicket[티켓 번호 입력]
    InputTicket --> ClickBtn[동기화 버튼]

    ClickBtn --> HandleSync[handleSync]
    HandleSync --> Execute[execute]
    Execute --> DetermineTicket[티켓 대상 결정]

    DetermineTicket --> FetchTicket[티켓 조회]
    FetchTicket --> CheckLinks[분류 확인<br/>Blocks 링크 / link_field / 허용 에픽]
    CheckLinks --> SyncSingle[동기화 실행]

    SyncSingle --> Summary[결과 요약]
    Summary --> End([종료])

    style Start fill:#3b82f6,color:#fff
    style End fill:#10b981,color:#fff
    style Execute fill:#8b5cf6,color:#fff
    style SyncSingle fill:#ec4899,color:#fff
    style Summary fill:#10b981,color:#fff
`,
    },
  ];

  const currentChart = flowCharts.find((chart) => chart.id === activeTab);

  // 탭 변경 시 Mermaid 다시 렌더링
  useEffect(() => {
    const renderDiagram = async () => {
      const chart = flowCharts.find((c) => c.id === activeTab);
      if (isLoaded && window.mermaid && chart) {
        try {
          // 타임아웃 설정 (10초)
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Rendering timeout')), 10000);
          });

          const uniqueId = `mermaid-${activeTab}-${Date.now()}`;
          const renderPromise = window.mermaid.render(uniqueId, chart.diagram);

          const { svg } = (await Promise.race([
            renderPromise,
            timeoutPromise,
          ])) as { svg: string };
          setSvgContent(svg);
        } catch (error) {
          console.error(`❌ Chart ${activeTab} rendering error:`, error);
          console.error('Diagram content:', chart.diagram.substring(0, 200));
          setSvgContent(
            '<div style="padding:20px;color:red;text-align:center;">차트 렌더링 실패. 콘솔을 확인하세요.</div>'
          );
        }
      }
    };

    renderDiagram();
    // flowCharts는 정적 배열이므로 의존성 불필요
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, isLoaded]);

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">티켓 동기화 Flow Chart</h1>
            <p className="text-sm text-muted-foreground">
              자동화 작업의 전체 흐름을 시각화합니다 (DB sync_profile 기반)
            </p>
          </div>
          <Link href="/create-epic">
            <Button variant="outline" size="sm">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              에픽 생성
            </Button>
          </Link>
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-8">
        {/* Tab Navigation */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {flowCharts.map((chart) => (
            <Button
              key={chart.id}
              variant={activeTab === chart.id ? 'default' : 'outline'}
              onClick={() => setActiveTab(chart.id)}
              className="whitespace-nowrap"
            >
              {chart.title}
            </Button>
          ))}
        </div>

        {/* Chart Card */}
        {currentChart && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>{currentChart.title}</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    {currentChart.description}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const svg = mermaidRef.current?.querySelector('svg');
                    if (svg) {
                      const svgData = new XMLSerializer().serializeToString(
                        svg
                      );
                      const blob = new Blob([svgData], {
                        type: 'image/svg+xml',
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `flow-chart-${currentChart.id}.svg`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }
                  }}
                >
                  <Download className="mr-2 h-4 w-4" />
                  SVG 다운로드
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div
                ref={mermaidRef}
                className="overflow-x-auto bg-white rounded-lg p-6"
                dangerouslySetInnerHTML={{ __html: svgContent }}
              />

              {/* 범례 */}
              <div className="mt-6 p-4 bg-muted rounded-lg">
                <h3 className="font-semibold mb-3">범례</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-blue-500 rounded"></div>
                    <span>시작/주요 단계</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-green-500 rounded"></div>
                    <span>성공/완료</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-red-500 rounded"></div>
                    <span>에러/실패</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-pink-500 rounded"></div>
                    <span>병렬 처리</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-purple-500 rounded"></div>
                    <span>핵심 로직</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-yellow-500 rounded"></div>
                    <span>경고</span>
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t">
                  <p className="text-xs text-muted-foreground">
                    • 실선 화살표: 순차 실행 | 점선 화살표: 병렬 실행 또는 내부
                    처리
                  </p>
                  <p className="text-xs text-muted-foreground">
                    • 다이아몬드 &#9830;: 조건 분기 | 둥근 사각형: 프로세스
                  </p>
                </div>
              </div>

              {/* 주요 포인트 설명 */}
              <div className="mt-6 space-y-4">
                {activeTab === 1 && (
                  <>
                    <div className="p-4 bg-blue-50 border-l-4 border-blue-500 rounded">
                      <h4 className="font-semibold text-blue-900 mb-2">
                        🔵 병렬 처리 구간
                      </h4>
                      <ul className="text-sm text-blue-800 space-y-1">
                        <li>
                          • <strong>스프린트 프리로드</strong>: 모든 타겟
                          프로젝트의 스프린트 정보를 동시에 조회
                          (projects.board_id 기준)
                        </li>
                        <li>
                          • <strong>청크 내부 병렬 처리</strong>: 각
                          프로젝트에서 15개씩 묶어 동시 처리
                          (Promise.allSettled)
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-red-50 border-l-4 border-red-500 rounded">
                      <h4 className="font-semibold text-red-900 mb-2">
                        🔴 에러 처리
                      </h4>
                      <ul className="text-sm text-red-800 space-y-1">
                        <li>
                          • <strong>검증 단계</strong>: 담당자 미선택 시 즉시
                          종료
                        </li>
                        <li>
                          • <strong>프로필 없음</strong>: DB에 sync_profile이
                          없으면 경고 후 종료 (설정 &gt; 필드 매핑에서 등록)
                        </li>
                        <li>
                          • <strong>Promise.allSettled</strong>: 일부 티켓
                          실패해도 나머지 계속 진행
                        </li>
                        <li>
                          • <strong>결과 요약</strong>: 성공/실패 구분하여 통계
                          제공
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                      <h4 className="font-semibold text-green-900 mb-2">
                        🟢 최적화 포인트
                      </h4>
                      <ul className="text-sm text-green-800 space-y-1">
                        <li>
                          • <strong>세션 캐싱</strong>: 스프린트/DB 매핑/전이
                          경로/에픽 목록을 동기화 세션 동안 재사용
                        </li>
                        <li>
                          • <strong>1회 순회 분류</strong>: 티켓을 한 번만
                          순회하여 타겟 프로젝트별 분류
                        </li>
                        <li>
                          • <strong>청킹 전략</strong>: API 부하 방지를 위해
                          15개씩 나눠서 처리
                        </li>
                      </ul>
                    </div>
                  </>
                )}

                {activeTab === 2 && (
                  <>
                    <div className="p-4 bg-yellow-50 border-l-4 border-yellow-500 rounded">
                      <h4 className="font-semibold text-yellow-900 mb-2">
                        🟡 담당자 매핑
                      </h4>
                      <ul className="text-sm text-yellow-800 space-y-1">
                        <li>
                          • UI에서 선택한 담당자 → DB users 테이블에서 조회
                        </li>
                        <li>
                          • ignite_account_id 추출 (같은 인스턴스는 동일 ID
                          사용)
                        </li>
                        <li>• assignee 필드에 accountId 객체로 전달</li>
                      </ul>
                    </div>

                    <div className="p-4 bg-orange-50 border-l-4 border-orange-500 rounded">
                      <h4 className="font-semibold text-orange-900 mb-2">
                        🟠 스프린트 캐싱 & 매핑
                      </h4>
                      <ul className="text-sm text-orange-800 space-y-1">
                        <li>
                          • <strong>캐싱</strong>: 동기화 시작 시
                          Map&lt;boardId, SprintInfo[]&gt; 생성
                          (projects.board_id 기준)
                        </li>
                        <li>
                          • <strong>매핑</strong>: 소스 스프린트 이름을 타겟
                          규칙으로 변환 후 캐시에서 ID 조회
                        </li>
                        <li>
                          • <strong>성능</strong>: 한 번만 조회하고 재사용
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-blue-50 border-l-4 border-blue-500 rounded">
                      <h4 className="font-semibold text-blue-900 mb-2">
                        🔵 업데이트 필드
                      </h4>
                      <ul className="text-sm text-blue-800 space-y-1">
                        <li>
                          • DB sync_field_mappings에 등록된 필드만 동기화
                        </li>
                        <li>
                          • source_field → target_field 매핑 +
                          transform_type/transform_config 변환 규칙 적용
                        </li>
                        <li>
                          • 설정 &gt; 필드 매핑 페이지에서 코드 수정 없이 관리
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                      <h4 className="font-semibold text-green-900 mb-2">
                        🟢 상태 동기화 (Transition)
                      </h4>
                      <ul className="text-sm text-green-800 space-y-1">
                        <li>
                          • sync_profile_status_mappings로 소스 상태 → 타겟
                          목표 상태 결정
                        </li>
                        <li>
                          • sync_profile_workflows + 런타임 BFS로 최단 전이
                          경로 계산 (multi-step 자동 처리)
                        </li>
                        <li>• POST /rest/api/3/issue/{'{key}'}/transitions</li>
                      </ul>
                    </div>
                  </>
                )}

                {activeTab === 3 && (
                  <>
                    <div className="p-4 bg-yellow-50 border-l-4 border-yellow-500 rounded">
                      <h4 className="font-semibold text-yellow-900 mb-2">
                        🟡 담당자 매핑 (Cross-Instance)
                      </h4>
                      <ul className="text-sm text-yellow-800 space-y-1">
                        <li>
                          • ignite_account_id (소스 조회용) → hmg_account_id
                          (타겟 설정용)
                        </li>
                        <li>• DB users 테이블에서 두 ID 모두 보관</li>
                        <li>
                          • assignee와 reporter 모두 hmg_account_id로 설정
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-purple-50 border-l-4 border-purple-500 rounded">
                      <h4 className="font-semibold text-purple-900 mb-2">
                        🟣 프로필 link_field 핵심 로직
                      </h4>
                      <ul className="text-sm text-purple-800 space-y-1">
                        <li>
                          • <strong>비어있음</strong>: 타겟 티켓 신규 생성 후
                          소스 티켓의 link_field에 URL 저장
                        </li>
                        <li>
                          • <strong>타겟 링크 있음</strong>: 정규식으로 키 추출
                          후 업데이트
                        </li>
                        <li>
                          • link_field는 sync_profiles 테이블에서 프로필별로
                          설정
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-cyan-50 border-l-4 border-cyan-500 rounded">
                      <h4 className="font-semibold text-cyan-900 mb-2">
                        🔷 부모 에픽 자동 확보
                      </h4>
                      <ul className="text-sm text-cyan-800 space-y-1">
                        <li>
                          • 신규 생성 시 소스 부모 에픽을 타겟에서
                          &quot;[소스키] 에픽 제목&quot; 이름으로 매칭
                        </li>
                        <li>
                          • 없으면 타겟 프로젝트에 에픽 신규 생성 (동시 요청은
                          Promise dedup으로 중복 방지)
                        </li>
                        <li>
                          • 에픽 상태도 동기화 (타겟 에픽이 이미 완료 상태면
                          보호 정책으로 스킵)
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                      <h4 className="font-semibold text-green-900 mb-2">
                        🟢 상태 동기화 (HMG)
                      </h4>
                      <ul className="text-sm text-green-800 space-y-1">
                        <li>
                          • sync_profile_status_mappings로 목표 상태 결정
                        </li>
                        <li>
                          • 런타임 BFS transition으로 multi-step 전이 자동
                          처리
                        </li>
                        <li>• 신규 생성 후에도 상태 동기화 수행</li>
                      </ul>
                    </div>
                  </>
                )}

                {activeTab === 4 && (
                  <>
                    <div className="p-4 bg-purple-50 border-l-4 border-purple-500 rounded">
                      <h4 className="font-semibold text-purple-900 mb-2">
                        🟣 에픽 기반 대상 결정
                      </h4>
                      <ul className="text-sm text-purple-800 space-y-1">
                        <li>
                          • <strong>허용 에픽 확인</strong>:
                          sync_profile_allowed_epics에 해당 에픽이 있는
                          프로필만 동기화 대상
                        </li>
                        <li>
                          • <strong>목록이 비어있으면</strong>: 모든 에픽이
                          해당 프로필의 동기화 대상
                        </li>
                        <li>
                          • 허용하는 프로필이 하나도 없으면 동기화 없이 종료
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-blue-50 border-l-4 border-blue-500 rounded">
                      <h4 className="font-semibold text-blue-900 mb-2">
                        🔵 에픽 하위 티켓만 처리
                      </h4>
                      <ul className="text-sm text-blue-800 space-y-1">
                        <li>
                          • JQL: parent = BE3-123 AND assignee = ... (에픽 전체
                          모드에서는 담당자 무관)
                        </li>
                        <li>• 에픽에 속한 티켓만 선별적으로 동기화</li>
                        <li>
                          • 에픽 단위 통계 제공 (신규 생성, 업데이트, 실패)
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                      <h4 className="font-semibold text-green-900 mb-2">
                        🟢 사용 사례
                      </h4>
                      <ul className="text-sm text-green-800 space-y-1">
                        <li>• 특정 에픽(기능 단위) 전체를 동기화할 때</li>
                        <li>
                          • 신규 에픽을 생성하고 하위 티켓을 일괄 동기화할 때
                        </li>
                        <li>
                          • 특정 타겟 프로필 전용 에픽의 티켓들을 동기화할 때
                        </li>
                      </ul>
                    </div>
                  </>
                )}

                {activeTab === 5 && (
                  <>
                    <div className="p-4 bg-cyan-50 border-l-4 border-cyan-500 rounded">
                      <h4 className="font-semibold text-cyan-900 mb-2">
                        🔷 대상 결정 로직
                      </h4>
                      <ul className="text-sm text-cyan-800 space-y-1">
                        <li>
                          • <strong>같은 인스턴스 타겟</strong>: issuelinks의
                          Blocks 관계 + 타겟 키 prefix 확인
                        </li>
                        <li>
                          • <strong>HMG 타겟</strong>: 프로필 link_field에 타겟
                          티켓 링크 확인
                        </li>
                        <li>
                          • <strong>허용 에픽</strong>: 상위 에픽이
                          sync_profile_allowed_epics에 있는지 확인 (비어있으면
                          전체 허용)
                        </li>
                        <li>
                          • 모두 해당 없으면 &quot;동기화 대상 아님&quot; 경고
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-blue-50 border-l-4 border-blue-500 rounded">
                      <h4 className="font-semibold text-blue-900 mb-2">
                        🔵 단일 티켓 처리
                      </h4>
                      <ul className="text-sm text-blue-800 space-y-1">
                        <li>
                          • <strong>청크 불필요</strong>: 1개 티켓만 처리하므로
                          즉시 동기화
                        </li>
                        <li>
                          • <strong>빠른 응답</strong>: 불필요한 대기 시간 없이
                          즉시 결과 확인
                        </li>
                        <li>
                          • <strong>디버깅 용이</strong>: 특정 티켓의 동기화
                          문제 추적에 최적
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                      <h4 className="font-semibold text-green-900 mb-2">
                        🟢 사용 사례
                      </h4>
                      <ul className="text-sm text-green-800 space-y-1">
                        <li>• 특정 티켓의 동기화가 실패했을 때 재시도</li>
                        <li>• 신규 티켓을 생성 직후 즉시 동기화할 때</li>
                        <li>• 동기화 로직 테스트 및 검증 목적</li>
                      </ul>
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
