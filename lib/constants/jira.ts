// Jira 엔드포인트 및 상수
//
// 동기화 소스/타겟 프로젝트, 필드 매핑, 상태 매핑, 사용자 정보는
// 전부 Supabase DB(sync_profiles, sync_field_mappings, teams, users 등) 기반으로 관리됩니다.

export const JIRA_ENDPOINTS = {
  IGNITE: 'https://ignitecorp.atlassian.net',
  HMG: 'https://hmg.atlassian.net',
  HMG_OLD: 'https://jira.hmg-corp.io', // 구 URL (deprecated)
} as const;

export const JIRA_API_VERSION = '/rest/api/3';

export const JIRA_ROUTES = {
  // 서버 정보
  SERVER_INFO: '/serverInfo',

  // 프로젝트 관련
  PROJECTS: '/project',
  PROJECT_BY_KEY: (key: string) => `/project/${key}`,

  // 이슈 관련
  ISSUE: (issueIdOrKey: string) => `/issue/${issueIdOrKey}`,
  ISSUE_SEARCH: '/search/jql', // Jira Cloud API v3 업데이트
  ISSUE_TRANSITIONS: (issueIdOrKey: string) =>
    `/issue/${issueIdOrKey}/transitions`,

  // 사용자 관련
  MYSELF: '/myself',
  USER_SEARCH: '/user/search',

  // 스프린트 관련 (Jira Software API)
  SPRINT: (sprintId: number) => `/sprint/${sprintId}`,
  BOARD_SPRINTS: (boardId: number) => `/board/${boardId}/sprint`,
} as const;

// JQL 쿼리 빌더 헬퍼
export const JQL = {
  project: (key: string) => `project = ${key}`,
  assignee: (email: string) => `assignee = "${email}"`,
  status: (status: string) => `status = "${status}"`,
  statusNot: (status: string) => `status != "${status}"`,
  and: (...conditions: string[]) => conditions.join(' AND '),
  or: (...conditions: string[]) => conditions.join(' OR '),
  orderBy: (field: string, order: 'ASC' | 'DESC' = 'DESC') =>
    `ORDER BY ${field} ${order}`,
} as const;

// Ignite Jira 커스텀 필드
export const IGNITE_CUSTOM_FIELDS = {
  START_DATE: 'customfield_10015', // 시작일
  SPRINT: 'customfield_10020', // 스프린트
} as const;

// 기본 설정
export const JIRA_CONFIG = {
  MAX_RESULTS: 100,
  DEFAULT_FIELDS: [
    'summary',
    'description',
    'status',
    'assignee',
    'reporter',
    'priority',
    'created',
    'updated',
    'issuetype',
    'project',
    'parent',
    'subtasks',
    'issuelinks',
    'duedate',
    'timetracking',
    IGNITE_CUSTOM_FIELDS.START_DATE, // 시작일
    IGNITE_CUSTOM_FIELDS.SPRINT, // 스프린트
  ],
} as const;
