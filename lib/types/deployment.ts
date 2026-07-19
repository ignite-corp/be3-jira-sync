// 배포 관련 타입 정의

/**
 * 배포 종류 (Confluence labels 형식)
 */
export type DeploymentType = 'release' | 'adhoc' | 'hotfix';

/**
 * 배포 종류 한글 레이블
 */
export const DEPLOYMENT_TYPE_LABELS: Record<DeploymentType, string> = {
  release: '정기배포',
  adhoc: '비정기배포',
  hotfix: '핫픽스',
} as const;

/**
 * 프로젝트 키 (배포 대상)
 */
export type ProjectKey = 'groupware' | 'hmg-board' | 'cpo';

/**
 * 배포 태그 적용 요청
 */
export interface ApplyDeploymentTagRequest {
  /** 프로젝트 키 */
  project: ProjectKey;
  /** 티켓 키 목록 (예: ['BE3-1234', 'BE3-1235']) */
  ticketKeys: string[];
  /** 배포 태그 (예: '2025-01-15-hotfix') */
  tag: string;
}

/**
 * 배포 태그 적용 응답
 */
export interface ApplyDeploymentTagResponse {
  success: boolean;
  /** 성공한 티켓 목록 */
  successTickets?: string[];
  /** 실패한 티켓 목록 */
  failedTickets?: Array<{
    ticketKey: string;
    error: string;
  }>;
  /** 에러 메시지 */
  error?: string;
}

/**
 * 내 담당 티켓 조회 응답
 */
export interface MyTicketsResponse {
  success: boolean;
  /** 티켓 목록 */
  tickets?: Array<{
    key: string;
    summary: string;
    status: string;
    duedate?: string;
  }>;
  /** 에러 메시지 */
  error?: string;
}

/**
 * 프로젝트별 Jira 프로젝트 키 매핑
 */
export const PROJECT_TO_JIRA_KEY: Record<ProjectKey, string> = {
  groupware: 'AUTOWAY',
  'hmg-board': 'HB',
  cpo: 'KQ',
} as const;

/**
 * 프로젝트별 표시 이름
 */
export const PROJECT_DISPLAY_NAMES: Record<ProjectKey, string> = {
  groupware: 'Groupware (GW)',
  'hmg-board': 'HMG Board (HB)',
  cpo: 'CPO',
} as const;
