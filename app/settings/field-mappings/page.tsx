'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  Plus,
  Pencil,
  Trash2,
  Loader2,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  X,
  Info,
  Link2,
  Check,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { db } from '@/lib/db';
import { jiraFetch } from '@/lib/jira-fetch';

// ── 타입 ──

interface Project {
  id: string;
  name: string;
  jiraInstance: 'ignite' | 'hmg';
}

interface SyncProfile {
  id: string;
  name: string;
  sourceProjectId: string;
  targetProjectId: string;
  createdAt: string;
  mappingCount: number;
  linkField: string | null;
  sourceLinkField: string | null;
  useEpicPrefix: boolean;
  epicCount: number;
  statusMappingCount: number;
  workflowCount: number;
}

interface StatusMapping {
  sourceStatusId: string;
  sourceStatusName: string;
  targetStatusId: string;
  targetStatusName: string;
}

interface WorkflowEdge {
  fromStatusId: string;
  fromStatusName: string;
  toStatusId: string;
  toStatusName: string;
  transitionId: string;
}

interface AllowedEpic {
  key: string;
  summary: string;
}

interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type: string; custom?: string; items?: string };
}

interface FieldMapping {
  sourceField: string;
  sourceFieldName: string;
  targetField: string;
  targetFieldName: string;
  sourceType: string;
  targetType: string;
}

// ── 타입 호환성 ──

function getFieldType(field: JiraField): string {
  if (!field.schema) return 'any';
  if (field.schema.type === 'array') return `array:${field.schema.items || 'any'}`;
  return field.schema.type;
}

function isTypeCompatible(sourceType: string, targetType: string): boolean {
  if (sourceType === 'any' || targetType === 'any') return true;
  if (sourceType === targetType) return true;

  // 날짜 계열 호환
  const dateTypes = ['date', 'datetime', 'string'];
  if (dateTypes.includes(sourceType) && dateTypes.includes(targetType)) return true;

  // number ↔ number
  if (
    ['number', 'integer'].includes(sourceType) &&
    ['number', 'integer'].includes(targetType)
  )
    return true;

  // array 내부 타입 비교
  if (sourceType.startsWith('array:') && targetType.startsWith('array:')) {
    const sInner = sourceType.split(':')[1];
    const tInner = targetType.split(':')[1];
    return isTypeCompatible(sInner, tInner);
  }

  return false;
}

// ── 헬퍼 컴포넌트 ──

function InstanceBadge({ instance }: { instance: 'ignite' | 'hmg' }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        instance === 'hmg'
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
          : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
      }`}
    >
      {instance === 'hmg' ? 'HMG' : 'Ignite'}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-mono bg-muted text-muted-foreground">
      {type}
    </span>
  );
}

// ── 선택형 필드 목록 (외부 컴포넌트) ──

function SelectableFieldList({
  fields,
  isLoading,
  label,
  selectedFieldId,
  mappedIds,
  compatibleFilter,
  onFieldClick,
  search,
  onSearchChange,
}: {
  fields: JiraField[];
  isLoading: boolean;
  label: string;
  selectedFieldId: string | null;
  mappedIds: Set<string>;
  compatibleFilter: ((field: JiraField) => boolean) | null;
  onFieldClick: (field: JiraField) => void;
  search: string;
  onSearchChange: (v: string) => void;
}) {
  const filtered = useMemo(() => {
    if (!search.trim()) return fields;
    const q = search.toLowerCase();
    return fields.filter(
      (f) => f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q)
    );
  }, [fields, search]);

  const standardFields = filtered.filter((f) => !f.custom);
  const customFields = filtered.filter((f) => f.custom);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {label} 필드 조회 중...
      </div>
    );
  }

  if (fields.length === 0) return null;

  const getFieldState = (field: JiraField): 'selected' | 'mapped' | 'disabled' | 'normal' => {
    if (mappedIds.has(field.id)) return 'mapped';
    if (selectedFieldId === field.id) return 'selected';
    if (compatibleFilter && !compatibleFilter(field)) return 'disabled';
    return 'normal';
  };

  const FieldRow = ({ field }: { field: JiraField }) => {
    const state = getFieldState(field);
    const type = getFieldType(field);

    return (
      <button
        type="button"
        className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-xs text-left transition-colors overflow-hidden ${
          state === 'selected'
            ? 'bg-primary/10 ring-1 ring-inset ring-primary/30'
            : state === 'mapped'
              ? 'bg-muted/60 opacity-40 cursor-not-allowed'
              : state === 'disabled'
                ? 'opacity-25 cursor-not-allowed'
                : 'hover:bg-muted/40 cursor-pointer'
        }`}
        onClick={() => onFieldClick(field)}
        disabled={state === 'mapped' || state === 'disabled'}
        title={`${field.id} — ${field.name} (${type})`}
      >
        <span className="truncate flex-1 min-w-0">{field.name}</span>
        <TypeBadge type={type} />
      </button>
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {label} ({fields.length})
        </span>
      </div>

      <Input
        placeholder="필드 검색..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="h-7 text-xs"
      />

      {/* 표준 필드 */}
      <div className="border rounded-md overflow-hidden">
        <div className="bg-muted/50 px-3 py-1.5 text-xs font-medium">
          표준 필드 ({standardFields.length})
        </div>
        <div className="max-h-52 overflow-y-auto divide-y">
          {standardFields.map((f) => (
            <FieldRow key={f.id} field={f} />
          ))}
          {standardFields.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              검색 결과 없음
            </div>
          )}
        </div>
      </div>

      {/* 커스텀 필드 */}
      {customFields.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <div className="bg-muted/50 px-3 py-1.5 text-xs font-medium">
            커스텀 필드 ({customFields.length})
          </div>
          <div className="max-h-52 overflow-y-auto divide-y">
            {customFields.map((f) => (
              <FieldRow key={f.id} field={f} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 메인 컴포넌트 ──

export default function FieldMappingsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [profiles, setProfiles] = useState<SyncProfile[]>([]);
  const [loading, setLoading] = useState(true);
  // 기준 프로젝트로 사용 중인 프로젝트 ID 목록 (소스 프로젝트 후보)
  const [sourceProjectIds, setSourceProjectIds] = useState<Set<string>>(new Set());

  // 추가/편집 폼
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [sourceProjectId, setSourceProjectId] = useState('');
  const [targetProjectId, setTargetProjectId] = useState('');
  const [saving, setSaving] = useState(false);

  // 필드 조회
  const [sourceFields, setSourceFields] = useState<JiraField[]>([]);
  const [targetFields, setTargetFields] = useState<JiraField[]>([]);
  const [loadingSourceFields, setLoadingSourceFields] = useState(false);
  const [loadingTargetFields, setLoadingTargetFields] = useState(false);

  // 필드 매핑 선택
  const [selectedSourceField, setSelectedSourceField] = useState<JiraField | null>(null);
  const [selectedTargetField, setSelectedTargetField] = useState<JiraField | null>(null);
  const [pendingMappings, setPendingMappings] = useState<FieldMapping[]>([]);

  // 필드 검색
  const [sourceSearch, setSourceSearch] = useState('');
  const [targetSearch, setTargetSearch] = useState('');

  // HMG 대상 설정
  const [linkField, setLinkField] = useState('');
  const [linkFieldSearch, setLinkFieldSearch] = useState('');
  const [linkFieldDropdownOpen, setLinkFieldDropdownOpen] = useState(false);
  const [sourceLinkField, setSourceLinkField] = useState('');
  const [sourceLinkFieldSearch, setSourceLinkFieldSearch] = useState('');
  const [sourceLinkFieldDropdownOpen, setSourceLinkFieldDropdownOpen] = useState(false);
  const [useEpicPrefix, setUseEpicPrefix] = useState(true);
  const [selectedEpics, setSelectedEpics] = useState<AllowedEpic[]>([]);
  const [sourceEpics, setSourceEpics] = useState<{ key: string; summary: string }[]>([]);
  const [loadingEpics, setLoadingEpics] = useState(false);
  const [epicSearch, setEpicSearch] = useState('');

  // 상태 매핑
  const [sourceStatuses, setSourceStatuses] = useState<{ id: string; name: string }[]>([]);
  const [targetStatuses, setTargetStatuses] = useState<{ id: string; name: string }[]>([]);
  const [loadingSourceStatuses, setLoadingSourceStatuses] = useState(false);
  const [loadingTargetStatuses, setLoadingTargetStatuses] = useState(false);
  const [pendingStatusMappings, setPendingStatusMappings] = useState<StatusMapping[]>([]);
  const [selectedSourceStatus, setSelectedSourceStatus] = useState<{ id: string; name: string } | null>(null);

  // 편집 시 원본 스냅샷 (변경분 비교용)
  const snapshotRef = useRef<{
    mappings: string;
    statusMappings: string;
    epics: string;
  } | null>(null);

  // 목록에서 펼치기
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedMappings, setExpandedMappings] = useState<FieldMapping[]>([]);
  const [loadingExpanded, setLoadingExpanded] = useState(false);

  // ── 데이터 로드 ──

  const fetchData = useCallback(async () => {
    const [projectsRes, profilesRes, mappingsRes, epicsRes, statusRes, workflowRes, teamsRes] = await Promise.all([
      db.from('projects').select('id, name, jira_instance').order('name'),
      db
        .from('sync_profiles')
        .select('*')
        .order('created_at', { ascending: false }),
      db.from('sync_field_mappings').select('profile_id'),
      db.from('sync_profile_allowed_epics').select('profile_id'),
      db.from('sync_profile_status_mappings').select('profile_id'),
      db.from('sync_profile_workflows').select('profile_id'),
      db.from('teams').select('source_project_id').not('source_project_id', 'is', null),
    ]);

    // 팀에서 기준 프로젝트로 사용 중인 프로젝트 ID 수집
    if (teamsRes.data) {
      setSourceProjectIds(new Set(teamsRes.data.map((t) => t.source_project_id).filter(Boolean)));
    }

    if (projectsRes.data) {
      setProjects(
        projectsRes.data.map((p) => ({
          id: p.id,
          name: p.name,
          jiraInstance: p.jira_instance || 'ignite',
        }))
      );
    }

    // 프로필별 매핑 개수 카운트
    const countMap: Record<string, number> = {};
    mappingsRes.data?.forEach((m) => {
      countMap[m.profile_id] = (countMap[m.profile_id] || 0) + 1;
    });

    // 프로필별 에픽 개수 카운트
    const epicCountMap: Record<string, number> = {};
    epicsRes.data?.forEach((e) => {
      epicCountMap[e.profile_id] = (epicCountMap[e.profile_id] || 0) + 1;
    });

    // 프로필별 상태 매핑 / 워크플로우 개수 카운트
    const statusCountMap: Record<string, number> = {};
    statusRes.data?.forEach((s) => {
      statusCountMap[s.profile_id] = (statusCountMap[s.profile_id] || 0) + 1;
    });
    const workflowCountMap: Record<string, number> = {};
    workflowRes.data?.forEach((w) => {
      workflowCountMap[w.profile_id] = (workflowCountMap[w.profile_id] || 0) + 1;
    });

    if (profilesRes.data) {
      setProfiles(
        profilesRes.data.map((p) => ({
          id: p.id,
          name: p.name,
          sourceProjectId: p.source_project_id,
          targetProjectId: p.target_project_id,
          createdAt: p.created_at,
          mappingCount: countMap[p.id] || 0,
          linkField: p.link_field || null,
          sourceLinkField: p.source_link_field || null,
          // 컬럼 미존재/null이면 true(기존 동작: 말머리 사용)
          useEpicPrefix: p.use_epic_prefix ?? true,
          epicCount: epicCountMap[p.id] || 0,
          statusMappingCount: statusCountMap[p.id] || 0,
          workflowCount: workflowCountMap[p.id] || 0,
        }))
      );
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Jira 필드 조회 ──

  const fetchFields = async (
    project: Project,
    setter: (fields: JiraField[]) => void,
    setLoaderState: (v: boolean) => void
  ) => {
    setLoaderState(true);
    setter([]);

    try {
      const res = await jiraFetch(`/api/jira/${project.jiraInstance}/field`);
      const result = await res.json();

      if (result.success && Array.isArray(result.data)) {
        const fields: JiraField[] = result.data
          .map(
            (f: {
              id: string;
              name: string;
              custom: boolean;
              schema?: { type: string; custom?: string; items?: string };
            }) => ({
              id: f.id,
              name: f.name,
              custom: f.custom,
              schema: f.schema,
            })
          )
          .sort((a: JiraField, b: JiraField) => {
            if (a.custom !== b.custom) return a.custom ? 1 : -1;
            return a.name.localeCompare(b.name);
          });
        setter(fields);
      } else {
        toast.error(`필드 조회 실패: ${result.error || '알 수 없는 오류'}`);
      }
    } catch {
      toast.error('Jira API 호출에 실패했습니다.');
    } finally {
      setLoaderState(false);
    }
  };

  const handleSourceSelect = (projectId: string) => {
    setSourceProjectId(projectId);
    setSourceFields([]);
    setSourceStatuses([]);
    setSelectedSourceField(null);
    setSelectedTargetField(null);
    setSelectedSourceStatus(null);
    if (projectId) {
      const project = projects.find((p) => p.id === projectId);
      if (project) {
        fetchFields(project, setSourceFields, setLoadingSourceFields);
        fetchProjectStatuses(project.name, project.jiraInstance, setSourceStatuses, setLoadingSourceStatuses);
      }
    }
  };

  const handleTargetSelect = (projectId: string) => {
    setTargetProjectId(projectId);
    setTargetFields([]);
    setTargetStatuses([]);
    setSelectedSourceField(null);
    setSelectedTargetField(null);
    setSelectedSourceStatus(null);
    setLinkField('');
    setLinkFieldSearch('');
    setLinkFieldDropdownOpen(false);
    setSourceLinkField('');
    setSourceLinkFieldSearch('');
    setSourceLinkFieldDropdownOpen(false);
    setUseEpicPrefix(true);
    setSelectedEpics([]);
    if (projectId) {
      const project = projects.find((p) => p.id === projectId);
      if (project) {
        fetchFields(project, setTargetFields, setLoadingTargetFields);
        fetchProjectStatuses(project.name, project.jiraInstance, setTargetStatuses, setLoadingTargetStatuses);
      }
    }
  };

  // 대상 프로젝트의 인스턴스
  const targetInstance = targetProjectId
    ? projects.find((p) => p.id === targetProjectId)?.jiraInstance
    : null;
  const isHmgTarget = targetInstance === 'hmg';

  // 소스 프로젝트의 에픽 목록 조회 (HMG 대상 시, 페이지네이션 자동 처리)
  const loadSourceEpics = useCallback(async () => {
    if (!sourceProjectId) return;
    const sourceName = projects.find((p) => p.id === sourceProjectId)?.name;
    if (!sourceName) return;

    setLoadingEpics(true);
    setSourceEpics([]);
    try {
      const jql = `project = "${sourceName}" AND issuetype = 에픽 ORDER BY created DESC`;
      const allEpics: { key: string; summary: string }[] = [];
      let nextPageToken: string | undefined;
      let isLast = false;

      while (!isLast) {
        const params = new URLSearchParams({
          jql,
          maxResults: '100',
          fields: 'summary',
        });
        if (nextPageToken) params.set('nextPageToken', nextPageToken);

        const res = await jiraFetch(`/api/jira/ignite/search/jql?${params.toString()}`);
        const result = await res.json();

        if (!result.success || !result.data?.issues) {
          toast.error(`에픽 조회 실패: ${result.error || '알 수 없는 오류'}`);
          break;
        }

        allEpics.push(
          ...result.data.issues.map((issue: { key: string; fields: { summary: string } }) => ({
            key: issue.key,
            summary: issue.fields.summary,
          }))
        );

        isLast = result.data.isLast ?? true;
        nextPageToken = result.data.nextPageToken;
      }

      setSourceEpics(allEpics);
      if (allEpics.length > 0) {
        toast.success(`${allEpics.length}개 에픽을 조회했습니다.`);
      }
    } catch (err) {
      toast.error(`에픽 목록 조회에 실패했습니다: ${err instanceof Error ? err.message : '네트워크 오류'}`);
    } finally {
      setLoadingEpics(false);
    }
  }, [sourceProjectId, projects]);

  // ── 프로젝트 상태 조회 ──

  const fetchProjectStatuses = async (
    projectName: string,
    instance: 'ignite' | 'hmg',
    setter: (statuses: { id: string; name: string }[]) => void,
    setLoading: (v: boolean) => void
  ) => {
    setLoading(true);
    setter([]);
    try {
      const res = await jiraFetch(`/api/jira/${instance}/project/${projectName}/statuses`);
      const result = await res.json();
      if (result.success && Array.isArray(result.data)) {
        // 모든 이슈타입의 상태를 합쳐서 중복 제거
        const statusMap = new Map<string, string>();
        for (const issueType of result.data) {
          for (const status of issueType.statuses || []) {
            if (!statusMap.has(status.id)) {
              statusMap.set(status.id, status.name);
            }
          }
        }
        setter(Array.from(statusMap.entries()).map(([id, name]) => ({ id, name })));
      }
    } catch {
      toast.error('상태 목록 조회에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  // 대상 프로젝트의 워크플로우(전이 그래프)를 자동 생성 (병렬 처리)
  const autoGenerateWorkflows = async (
    targetProjectName: string,
    targetInst: 'ignite' | 'hmg',
    statuses: { id: string; name: string }[]
  ): Promise<WorkflowEdge[]> => {
    const statusNameMap = new Map(statuses.map((s) => [s.id, s.name]));

    const results = await Promise.all(
      statuses.map(async (status): Promise<WorkflowEdge[]> => {
        try {
          // 해당 상태의 이슈 1개 찾기
          const jql = `project = "${targetProjectName}" AND status = ${status.id}`;
          const searchRes = await jiraFetch(
            `/api/jira/${targetInst}/search/jql?jql=${encodeURIComponent(jql)}&maxResults=1&fields=status`
          );
          const searchResult = await searchRes.json();
          const issue = searchResult.data?.issues?.[0];
          if (!issue) return [];

          // 해당 이슈의 가능한 전이 조회
          const transRes = await jiraFetch(
            `/api/jira/${targetInst}/issue/${issue.key}/transitions`
          );
          const transResult = await transRes.json();
          const transitions = transResult.data?.transitions || [];

          const edges: WorkflowEdge[] = [];
          for (const t of transitions) {
            const toStatusId = t.to?.id;
            const toStatusName = t.to?.name || statusNameMap.get(toStatusId) || '';
            if (toStatusId && toStatusId !== status.id) {
              edges.push({
                fromStatusId: status.id,
                fromStatusName: status.name,
                toStatusId,
                toStatusName,
                transitionId: t.id,
              });
            }
          }
          return edges;
        } catch {
          return [];
        }
      })
    );

    return results.flat();
  };

  // ── 필드 선택 로직 ──

  const selectedSourceType = selectedSourceField
    ? getFieldType(selectedSourceField)
    : null;

  // 이미 매핑된 필드 ID 세트
  const mappedTargetIds = useMemo(
    () => new Set(pendingMappings.map((m) => m.targetField)),
    [pendingMappings]
  );

  const handleSourceFieldClick = (field: JiraField) => {
    if (selectedSourceField?.id === field.id) {
      setSelectedSourceField(null);
      setSelectedTargetField(null);
    } else {
      setSelectedSourceField(field);
      setSelectedTargetField(null);
    }
  };

  const handleTargetFieldClick = (field: JiraField) => {
    if (mappedTargetIds.has(field.id)) return;
    if (!selectedSourceField) return;
    const targetType = getFieldType(field);
    if (!isTypeCompatible(selectedSourceType!, targetType)) return;

    if (selectedTargetField?.id === field.id) {
      setSelectedTargetField(null);
    } else {
      setSelectedTargetField(field);
    }
  };

  const handleAddMapping = () => {
    if (!selectedSourceField || !selectedTargetField) return;

    const mapping: FieldMapping = {
      sourceField: selectedSourceField.id,
      sourceFieldName: selectedSourceField.name,
      targetField: selectedTargetField.id,
      targetFieldName: selectedTargetField.name,
      sourceType: getFieldType(selectedSourceField),
      targetType: getFieldType(selectedTargetField),
    };

    setPendingMappings((prev) => [...prev, mapping]);
    setSelectedSourceField(null);
    setSelectedTargetField(null);
  };

  const handleRemoveMapping = (index: number) => {
    setPendingMappings((prev) => prev.filter((_, i) => i !== index));
  };

  // ── 저장 ──

  const handleSave = async () => {
    if (!formName.trim()) {
      toast.error('매핑 이름을 입력해주세요.');
      return;
    }
    if (!sourceProjectId || !targetProjectId) {
      toast.error('소스/대상 프로젝트를 모두 선택해주세요.');
      return;
    }
    if (sourceProjectId === targetProjectId) {
      toast.error('소스와 대상 프로젝트가 같을 수 없습니다.');
      return;
    }

    setSaving(true);

    // 현재 상태의 직렬화 키 (변경 비교용)
    const sortKey = (arr: object[]) =>
      JSON.stringify([...arr].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    const currentMappingsKey = sortKey(pendingMappings.map((m) => ({ sourceField: m.sourceField, targetField: m.targetField })));
    const currentStatusKey = sortKey(pendingStatusMappings.map((s) => ({ sourceStatusId: s.sourceStatusId, targetStatusId: s.targetStatusId })));
    const currentEpicsKey = sortKey(selectedEpics.map((e) => ({ key: e.key })));

    const snap = snapshotRef.current;
    const mappingsChanged = !snap || snap.mappings !== currentMappingsKey;
    const statusChanged = !snap || snap.statusMappings !== currentStatusKey;
    const epicsChanged = !snap || snap.epics !== currentEpicsKey;

    try {
      let profileId = editingId;

      if (editingId) {
        // 프로필 업데이트
        const { error } = await db
          .from('sync_profiles')
          .update({
            name: formName.trim(),
            source_project_id: sourceProjectId,
            target_project_id: targetProjectId,
            link_field: isHmgTarget && linkField ? linkField : null,
            source_link_field: isHmgTarget && sourceLinkField ? sourceLinkField : null,
            use_epic_prefix: isHmgTarget ? useEpicPrefix : true,
            updated_at: new Date().toISOString(),
          })
          .eq('id', editingId);

        if (error) {
          toast.error(`저장 실패: ${error.message}`);
          setSaving(false);
          return;
        }

        // 변경된 항목만 삭제 후 재삽입
        if (mappingsChanged) {
          await db.from('sync_field_mappings').delete().eq('profile_id', editingId);
        }
        if (epicsChanged && isHmgTarget) {
          await db.from('sync_profile_allowed_epics').delete().eq('profile_id', editingId);
        }
        if (statusChanged) {
          await Promise.all([
            db.from('sync_profile_status_mappings').delete().eq('profile_id', editingId),
            db.from('sync_profile_workflows').delete().eq('profile_id', editingId),
          ]);
        }
      } else {
        // 새 프로필 생성
        const { data, error } = await db
          .from('sync_profiles')
          .insert({
            name: formName.trim(),
            source_project_id: sourceProjectId,
            target_project_id: targetProjectId,
            link_field: isHmgTarget && linkField ? linkField : null,
            source_link_field: isHmgTarget && sourceLinkField ? sourceLinkField : null,
            use_epic_prefix: isHmgTarget ? useEpicPrefix : true,
          })
          .select('id')
          .single();

        if (error || !data) {
          if (error?.code === '23505') {
            toast.error('이미 동일한 소스 → 대상 매핑이 존재합니다.');
          } else {
            toast.error(`저장 실패: ${error?.message || '알 수 없는 오류'}`);
          }
          setSaving(false);
          return;
        }
        profileId = data.id;
      }

      // 필드 매핑 저장 (변경된 경우만)
      if (mappingsChanged && pendingMappings.length > 0 && profileId) {
        const { error: mappingError } = await db
          .from('sync_field_mappings')
          .insert(
            pendingMappings.map((m) => {
              const ACCOUNT_FIELDS = ['assignee', 'reporter', 'creator'];
              const isCrossInstance =
                projects.find((p) => p.id === sourceProjectId)?.jiraInstance !==
                projects.find((p) => p.id === targetProjectId)?.jiraInstance;
              const isAccountField = ACCOUNT_FIELDS.includes(m.sourceField);
              const transformType =
                isCrossInstance && isAccountField ? 'account_map' : 'copy';

              return {
                profile_id: profileId,
                source_field: m.sourceField,
                source_field_name: m.sourceFieldName,
                target_field: m.targetField,
                target_field_name: m.targetFieldName,
                transform_type: transformType,
              };
            })
          );

        if (mappingError) {
          toast.error(`필드 매핑 저장 실패: ${mappingError.message}`);
          setSaving(false);
          return;
        }
      }

      // HMG: 허용 에픽 저장 (변경된 경우만)
      if (epicsChanged && isHmgTarget && selectedEpics.length > 0 && profileId) {
        const { error: epicError } = await db
          .from('sync_profile_allowed_epics')
          .insert(
            selectedEpics.map((e) => ({
              profile_id: profileId,
              epic_key: e.key,
              epic_summary: e.summary,
            }))
          );
        if (epicError) {
          toast.error(`에픽 저장 실패: ${epicError.message}`);
          setSaving(false);
          return;
        }
      }

      // 상태 매핑 & 워크플로우 저장 (변경된 경우만)
      if (statusChanged) {
        if (pendingStatusMappings.length > 0 && profileId) {
          const { error: smError } = await db
            .from('sync_profile_status_mappings')
            .insert(
              pendingStatusMappings.map((s) => ({
                profile_id: profileId,
                source_status_id: s.sourceStatusId,
                source_status_name: s.sourceStatusName,
                target_status_id: s.targetStatusId,
                target_status_name: s.targetStatusName,
              }))
            );
          if (smError) {
            toast.error(`상태 매핑 저장 실패: ${smError.message}`);
            setSaving(false);
            return;
          }
        }

        // 워크플로우 자동 생성 (상태 매핑이 변경된 경우만 실행)
        if (pendingStatusMappings.length > 0 && profileId && targetStatuses.length > 0) {
          const targetProject = projects.find((p) => p.id === targetProjectId);
          if (targetProject) {
            const workflows = await autoGenerateWorkflows(
              targetProject.name,
              targetProject.jiraInstance,
              targetStatuses
            );
            if (workflows.length > 0) {
              const { error: wfError } = await db
                .from('sync_profile_workflows')
                .insert(
                  workflows.map((w) => ({
                    profile_id: profileId,
                    from_status_id: w.fromStatusId,
                    from_status_name: w.fromStatusName,
                    to_status_id: w.toStatusId,
                    to_status_name: w.toStatusName,
                    transition_id: w.transitionId,
                  }))
                );
              if (wfError) {
                toast.error(`워크플로우 저장 실패: ${wfError.message}`);
              } else {
                toast.success(`워크플로우 ${workflows.length}개 전이 자동 생성`);
              }
            }
          }
        }
      }

      toast.success(
        editingId
          ? '동기화 방식이 수정되었습니다.'
          : '동기화 방식이 추가되었습니다.'
      );
      resetForm();
      fetchData();
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (profile: SyncProfile) => {
    setEditingId(profile.id);
    setFormName(profile.name);
    setIsAdding(false);
    setSelectedSourceField(null);
    setSelectedTargetField(null);

    // 프로젝트 선택 + 필드 로드
    setSourceProjectId(profile.sourceProjectId);
    setTargetProjectId(profile.targetProjectId);

    const sourceProject = projects.find((p) => p.id === profile.sourceProjectId);
    const targetProject = projects.find((p) => p.id === profile.targetProjectId);
    if (sourceProject) {
      fetchFields(sourceProject, setSourceFields, setLoadingSourceFields);
      fetchProjectStatuses(sourceProject.name, sourceProject.jiraInstance, setSourceStatuses, setLoadingSourceStatuses);
    }
    if (targetProject) {
      fetchFields(targetProject, setTargetFields, setLoadingTargetFields);
      fetchProjectStatuses(targetProject.name, targetProject.jiraInstance, setTargetStatuses, setLoadingTargetStatuses);
    }

    // HMG 대상인 경우 link_field, source_link_field 및 allowed epics 로드
    setLinkField(profile.linkField || '');
    setSourceLinkField(profile.sourceLinkField || '');
    setUseEpicPrefix(profile.useEpicPrefix);
    let epicsData: { epic_key: string; epic_summary?: string }[] | null = null;
    const targetInst = projects.find((p) => p.id === profile.targetProjectId)?.jiraInstance;
    if (targetInst === 'hmg') {
      // 허용 에픽 로드
      const { data } = await db
        .from('sync_profile_allowed_epics')
        .select('epic_key, epic_summary')
        .eq('profile_id', profile.id);
      epicsData = data;
      if (epicsData) {
        setSelectedEpics(
          epicsData.map((e) => ({ key: e.epic_key, summary: e.epic_summary || '' }))
        );
      }
    }

    // 상태 매핑 & 워크플로우 로드
    const { data: statusData } = await db
      .from('sync_profile_status_mappings')
      .select('source_status_id, source_status_name, target_status_id, target_status_name')
      .eq('profile_id', profile.id);
    if (statusData) {
      setPendingStatusMappings(
        statusData.map((s) => ({
          sourceStatusId: s.source_status_id,
          sourceStatusName: s.source_status_name || '',
          targetStatusId: s.target_status_id,
          targetStatusName: s.target_status_name || '',
        }))
      );
    }

    // 기존 매핑 로드
    const { data } = await db
      .from('sync_field_mappings')
      .select('source_field, target_field')
      .eq('profile_id', profile.id);

    const mappings = data
      ? data.map((m) => ({
          sourceField: m.source_field,
          sourceFieldName: m.source_field,
          targetField: m.target_field,
          targetFieldName: m.target_field,
          sourceType: '',
          targetType: '',
        }))
      : [];
    setPendingMappings(mappings);

    // 원본 스냅샷 저장 (저장 시 변경 여부 비교용)
    const sortKey = (arr: { sourceField?: string; sourceStatusId?: string; key?: string }[]) =>
      JSON.stringify([...arr].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    snapshotRef.current = {
      mappings: sortKey(mappings.map((m) => ({ sourceField: m.sourceField, targetField: m.targetField }))),
      statusMappings: sortKey(
        (statusData ?? []).map((s) => ({
          sourceStatusId: s.source_status_id,
          targetStatusId: s.target_status_id,
        }))
      ),
      epics: sortKey(
        (epicsData ?? []).map((e: { epic_key: string }) => ({ key: e.epic_key }))
      ),
    };
  };

  // 필드 로드 완료 시 pending 매핑의 이름 resolve
  useEffect(() => {
    if (sourceFields.length === 0 && targetFields.length === 0) return;
    if (pendingMappings.length === 0) return;

    const needsResolve = pendingMappings.some(
      (m) => m.sourceFieldName === m.sourceField || m.targetFieldName === m.targetField
    );
    if (!needsResolve) return;

    setPendingMappings((prev) =>
      prev.map((m) => {
        const sf = sourceFields.find((f) => f.id === m.sourceField);
        const tf = targetFields.find((f) => f.id === m.targetField);
        return {
          ...m,
          sourceFieldName: sf?.name || m.sourceField,
          targetFieldName: tf?.name || m.targetField,
          sourceType: sf ? getFieldType(sf) : m.sourceType,
          targetType: tf ? getFieldType(tf) : m.targetType,
        };
      })
    );
  }, [sourceFields, targetFields]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = async (profile: SyncProfile) => {
    const { error } = await db
      .from('sync_profiles')
      .delete()
      .eq('id', profile.id);
    if (error) {
      toast.error(`삭제 실패: ${error.message}`);
      return;
    }
    toast.success('동기화 방식이 삭제되었습니다.');
    if (expandedId === profile.id) setExpandedId(null);
    fetchData();
  };

  const resetForm = () => {
    setIsAdding(false);
    setEditingId(null);
    setFormName('');
    setSourceProjectId('');
    setTargetProjectId('');
    setSourceFields([]);
    setTargetFields([]);
    setSelectedSourceField(null);
    setSelectedTargetField(null);
    setPendingMappings([]);
    setSourceSearch('');
    setTargetSearch('');
    setLinkField('');
    setLinkFieldSearch('');
    setLinkFieldDropdownOpen(false);
    setSourceLinkField('');
    setSourceLinkFieldSearch('');
    setSourceLinkFieldDropdownOpen(false);
    setUseEpicPrefix(true);
    setSelectedEpics([]);
    setSourceEpics([]);
    setEpicSearch('');
    setSourceStatuses([]);
    setTargetStatuses([]);
    setPendingStatusMappings([]);
    setSelectedSourceStatus(null);
    snapshotRef.current = null;
  };

  // 목록에서 프로필 펼칠 때 매핑 로드 (이름은 DB에 저장됨)
  const handleToggleExpand = async (profileId: string) => {
    if (expandedId === profileId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(profileId);
    setLoadingExpanded(true);
    setExpandedMappings([]);

    const { data } = await db
      .from('sync_field_mappings')
      .select('source_field, source_field_name, target_field, target_field_name, transform_type')
      .eq('profile_id', profileId);

    setExpandedMappings(
      (data || []).map((m) => ({
        sourceField: m.source_field,
        sourceFieldName: m.source_field_name || m.source_field,
        targetField: m.target_field,
        targetFieldName: m.target_field_name || m.target_field,
        sourceType: m.transform_type || '',
        targetType: '',
      }))
    );
    setLoadingExpanded(false);
  };

  // ── 헬퍼 ──

  const getProjectName = (id: string) =>
    projects.find((p) => p.id === id)?.name ?? '?';

  const getProjectInstance = (id: string) =>
    projects.find((p) => p.id === id)?.jiraInstance ?? 'ignite';

  // ── 타겟 필드 호환성 필터 ──

  const targetCompatibleFilter = useCallback(
    (field: JiraField) => {
      if (!selectedSourceField) return true;
      const targetType = getFieldType(field);
      return isTypeCompatible(getFieldType(selectedSourceField), targetType);
    },
    [selectedSourceField]
  );

  // ── 폼 UI ──

  const bothFieldsLoaded =
    sourceFields.length > 0 && targetFields.length > 0;
  const canAddMapping = !!selectedSourceField && !!selectedTargetField;

  const formUI = (
    <div className="border rounded-lg overflow-hidden">
      {/* ── STEP 1: 기본 설정 ── */}
      <div className="bg-muted/30 border-b px-5 py-4 space-y-4">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">1</span>
          <span className="text-sm font-semibold">기본 설정</span>
        </div>

        {/* 매핑 이름 */}
        <div className="space-y-1 pl-7">
          <label className="text-xs font-medium">
            매핑 이름 <span className="text-destructive">*</span>
          </label>
          <Input
            placeholder="예: BE3 -> DEVOPS"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            className="max-w-md"
            autoFocus
          />
        </div>

        {/* 프로젝트 선택 */}
        <div className="grid grid-cols-[1fr,auto,1fr] gap-3 items-end pl-7">
        <div className="space-y-1">
          <label className="text-xs font-medium">
            소스 프로젝트 <span className="text-destructive">*</span>
          </label>
          <Select
            value={sourceProjectId}
            onValueChange={(value) => handleSourceSelect(value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="선택..." />
            </SelectTrigger>
            <SelectContent>
              {(() => {
                const candidates = projects.filter((p) => sourceProjectIds.has(p.id));
                if (candidates.length === 0) {
                  return (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      기준 프로젝트로 설정된 프로젝트가 없습니다
                    </div>
                  );
                }
                return candidates.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex items-center gap-1.5">
                      {p.name}
                      <InstanceBadge instance={p.jiraInstance} />
                    </span>
                  </SelectItem>
                ));
              })()}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            팀의 기준 프로젝트만 선택 가능
          </p>
        </div>
        <div className="pb-7">
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium">
            대상 프로젝트 <span className="text-destructive">*</span>
          </label>
          <Select
            value={targetProjectId}
            onValueChange={(value) => handleTargetSelect(value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="선택..." />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem
                  key={p.id}
                  value={p.id}
                  disabled={p.id === sourceProjectId}
                >
                  <span className="flex items-center gap-1.5">
                    {p.name}
                    <InstanceBadge instance={p.jiraInstance} />
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            소스 프로젝트와 다른 프로젝트 선택
          </p>
        </div>
      </div>

      </div>

      {/* ── STEP 2: 대상 프로젝트 설정 ── */}
      {targetProjectId && targetInstance && (
        <div className="border-b px-5 py-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">2</span>
            <span className="text-sm font-semibold">대상 프로젝트 설정</span>
          </div>

          <div className="pl-7">
          {!isHmgTarget ? (
            /* Ignite 대상: 안내 메시지 */
            <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30 px-3 py-2.5 text-xs text-blue-700 dark:text-blue-400">
              <Info className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <span className="font-medium">Ignite 프로젝트 동기화</span>
                <p className="mt-0.5 text-blue-600 dark:text-blue-500">
                  blocks 관계로 연결된 티켓들을 아래 필드 매핑 규칙으로 업데이트합니다.
                </p>
              </div>
            </div>
          ) : (
            /* HMG 대상: 연결 필드 + 에픽 선택 */
            <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20 p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                <Link2 className="h-3.5 w-3.5" />
                HMG 프로젝트 추가 설정
              </div>

              {/* 연결 필드 선택 */}
              <div className="space-y-1">
                <label className="text-xs font-medium">
                  연결관계로 사용할 필드
                </label>
                <div className="relative max-w-md z-20">
                  {/* 선택된 값 또는 검색 인풋 */}
                  {linkField && !linkFieldDropdownOpen ? (
                    <div
                      className="flex items-center justify-between w-full rounded-md border bg-background px-3 py-2 text-sm cursor-pointer hover:bg-muted/30"
                      onClick={() => setLinkFieldDropdownOpen(true)}
                    >
                      <span>
                        {sourceFields.find((f) => f.id === linkField)?.name || linkField}
                        <code className="ml-1.5 text-[10px] text-muted-foreground font-mono">
                          ({linkField})
                        </code>
                      </span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setLinkField('');
                          setLinkFieldSearch('');
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        placeholder="필드 검색... (이름 또는 ID)"
                        value={linkFieldSearch}
                        onChange={(e) => {
                          setLinkFieldSearch(e.target.value);
                          setLinkFieldDropdownOpen(true);
                        }}
                        onFocus={() => setLinkFieldDropdownOpen(true)}
                        className="pl-8 h-9 text-sm"
                      />
                    </div>
                  )}

                  {/* 드롭다운 목록 */}
                  {linkFieldDropdownOpen && (
                    <>
                      <div
                        className="fixed inset-0"
                        onClick={() => setLinkFieldDropdownOpen(false)}
                      />
                      <div className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-background shadow-lg overflow-hidden">
                        <div className="max-h-48 overflow-y-auto">
                          {sourceFields
                            .filter((f) => f.custom)
                            .filter((f) => {
                              if (!linkFieldSearch.trim()) return true;
                              const q = linkFieldSearch.toLowerCase();
                              return (
                                f.name.toLowerCase().includes(q) ||
                                f.id.toLowerCase().includes(q)
                              );
                            })
                            .map((f) => (
                              <button
                                key={f.id}
                                type="button"
                                className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-muted/40 transition-colors ${
                                  linkField === f.id ? 'bg-primary/10' : ''
                                }`}
                                onClick={() => {
                                  setLinkField(f.id);
                                  setLinkFieldSearch('');
                                  setLinkFieldDropdownOpen(false);
                                }}
                              >
                                <span className="truncate flex-1">{f.name}</span>
                                <code className="text-[10px] font-mono text-muted-foreground shrink-0">
                                  {f.id}
                                </code>
                              </button>
                            ))}
                          {sourceFields.filter((f) => f.custom).length === 0 && (
                            <div className="px-3 py-2 text-xs text-muted-foreground">
                              {loadingSourceFields ? '필드 로딩 중...' : '커스텀 필드 없음'}
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  소스 티켓에서 HMG 티켓 키를 저장하는 커스텀 필드를 선택하세요.
                </p>
              </div>

              {/* 소스 티켓 링크 저장 필드 선택 */}
              <div className="space-y-1">
                <label className="text-xs font-medium">
                  소스 티켓 링크 저장 필드
                </label>
                <div className="relative max-w-md z-10">
                  {sourceLinkField && !sourceLinkFieldDropdownOpen ? (
                    <div
                      className="flex items-center justify-between w-full rounded-md border bg-background px-3 py-2 text-sm cursor-pointer hover:bg-muted/30"
                      onClick={() => setSourceLinkFieldDropdownOpen(true)}
                    >
                      <span>
                        {targetFields.find((f) => f.id === sourceLinkField)?.name || sourceLinkField}
                        <code className="ml-1.5 text-[10px] text-muted-foreground font-mono">
                          ({sourceLinkField})
                        </code>
                      </span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSourceLinkField('');
                          setSourceLinkFieldSearch('');
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        placeholder="타겟 필드 검색... (이름 또는 ID)"
                        value={sourceLinkFieldSearch}
                        onChange={(e) => {
                          setSourceLinkFieldSearch(e.target.value);
                          setSourceLinkFieldDropdownOpen(true);
                        }}
                        onFocus={() => setSourceLinkFieldDropdownOpen(true)}
                        className="pl-8 h-9 text-sm"
                      />
                    </div>
                  )}

                  {sourceLinkFieldDropdownOpen && (
                    <>
                      <div
                        className="fixed inset-0"
                        onClick={() => setSourceLinkFieldDropdownOpen(false)}
                      />
                      <div className="absolute z-10 top-full left-0 right-0 mt-1 border rounded-md bg-background shadow-lg overflow-hidden">
                        <div className="max-h-48 overflow-y-auto">
                          {targetFields
                            .filter((f) => f.custom && (f.schema?.type === 'url' || (f.schema?.type === 'string' && f.schema?.custom?.includes(':textfield'))))
                            .filter((f) => {
                              if (!sourceLinkFieldSearch.trim()) return true;
                              const q = sourceLinkFieldSearch.toLowerCase();
                              return (
                                f.name.toLowerCase().includes(q) ||
                                f.id.toLowerCase().includes(q)
                              );
                            })
                            .map((f) => (
                              <button
                                key={f.id}
                                type="button"
                                className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-muted/40 transition-colors ${
                                  sourceLinkField === f.id ? 'bg-primary/10' : ''
                                }`}
                                onClick={() => {
                                  setSourceLinkField(f.id);
                                  setSourceLinkFieldSearch('');
                                  setSourceLinkFieldDropdownOpen(false);
                                }}
                              >
                                <span className="truncate flex-1">{f.name}</span>
                                <code className="text-[10px] font-mono text-muted-foreground shrink-0">
                                  {f.id}
                                </code>
                              </button>
                            ))}
                          {targetFields.filter((f) => f.custom && (f.schema?.type === 'url' || (f.schema?.type === 'string' && f.schema?.custom?.includes(':textfield')))).length === 0 && (
                            <div className="px-3 py-2 text-xs text-muted-foreground">
                              {loadingTargetFields ? '필드 로딩 중...' : '텍스트/URL 타입 커스텀 필드 없음'}
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  타겟(HMG) 티켓에서 소스 티켓 원본 링크를 저장할 텍스트/URL 타입 커스텀 필드를 선택하세요.
                </p>
              </div>

              {/* 에픽 말머리 사용 여부 */}
              <div className="space-y-1">
                <button
                  type="button"
                  className="flex items-center gap-2 text-xs font-medium cursor-pointer"
                  onClick={() => setUseEpicPrefix((prev) => !prev)}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                      useEpicPrefix
                        ? 'bg-amber-500 border-amber-500 text-white'
                        : 'border-muted-foreground/25 bg-background'
                    }`}
                  >
                    {useEpicPrefix && <Check className="h-3 w-3" />}
                  </span>
                  에픽 말머리([소스키]) 사용
                </button>
                <p className="text-[11px] text-muted-foreground pl-6">
                  켜면 타겟 에픽을 &quot;[소스 프로젝트 키] 소스 에픽 이름&quot;으로 매칭/생성합니다.
                  끄면 말머리 없이 소스 에픽 이름 그대로 타겟의 기존 에픽을 재활용합니다.
                </p>
              </div>

              {/* 에픽 선택 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium">대상 에픽</label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs px-2.5"
                    onClick={loadSourceEpics}
                    disabled={loadingEpics || !sourceProjectId}
                  >
                    {loadingEpics ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                    ) : null}
                    {sourceEpics.length > 0 ? '새로고침' : '에픽 목록 조회'}
                  </Button>
                </div>

                {/* 선택된 에픽 (에픽 목록 조회 전에도 표시) */}
                {selectedEpics.length > 0 && sourceEpics.length === 0 && !loadingEpics && (
                  <div className="border rounded-md overflow-hidden bg-background">
                    <div className="flex items-center justify-between px-2.5 py-1.5 bg-muted/30 border-b">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        등록된 에픽 ({selectedEpics.length}개)
                      </span>
                      <button
                        type="button"
                        className="text-[10px] text-muted-foreground hover:text-destructive"
                        onClick={() => setSelectedEpics([])}
                      >
                        전체 해제
                      </button>
                    </div>
                    <div className="max-h-40 overflow-y-auto divide-y">
                      {selectedEpics.map((epic) => (
                        <div
                          key={epic.key}
                          className="flex items-center gap-2 px-2.5 py-1.5 text-xs"
                        >
                          <span className="font-mono text-[11px] text-muted-foreground shrink-0 w-20">
                            {epic.key}
                          </span>
                          <span className="truncate flex-1">
                            {epic.summary || epic.key}
                          </span>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-destructive shrink-0"
                            onClick={() =>
                              setSelectedEpics((prev) =>
                                prev.filter((e) => e.key !== epic.key)
                              )
                            }
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {loadingEpics && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-3 justify-center">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    에픽 목록 조회 중...
                  </div>
                )}

                {/* 에픽 목록이 로드된 경우 */}
                {!loadingEpics && sourceEpics.length > 0 && (
                  <div className="border rounded-md overflow-hidden bg-background">
                    {/* 헤더: 검색 + 카운트 */}
                    <div className="flex items-center gap-2 border-b px-2 py-1.5 bg-muted/30">
                      <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <input
                        type="text"
                        placeholder="에픽 검색..."
                        value={epicSearch}
                        onChange={(e) => setEpicSearch(e.target.value)}
                        className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
                      />
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {selectedEpics.length}/{sourceEpics.length} 선택
                      </span>
                    </div>

                    {/* 선택된 에픽 태그 */}
                    {selectedEpics.length > 0 && (
                      <div className="flex flex-wrap gap-1 px-2 py-1.5 border-b bg-muted/10">
                        {selectedEpics.map((epic) => (
                          <span
                            key={epic.key}
                            className="inline-flex items-center gap-1 rounded bg-amber-100 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-300"
                            title={epic.summary}
                          >
                            {epic.key}
                            <span className="font-normal text-amber-700/70 dark:text-amber-400/70 max-w-[120px] truncate">
                              {epic.summary}
                            </span>
                            <button
                              type="button"
                              className="ml-0.5 hover:text-destructive"
                              onClick={() =>
                                setSelectedEpics((prev) =>
                                  prev.filter((e) => e.key !== epic.key)
                                )
                              }
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </span>
                        ))}
                        <button
                          type="button"
                          className="text-[10px] text-muted-foreground hover:text-destructive px-1"
                          onClick={() => setSelectedEpics([])}
                        >
                          전체 해제
                        </button>
                      </div>
                    )}

                    {/* 에픽 리스트 */}
                    <div className="max-h-56 overflow-y-auto divide-y">
                      {sourceEpics
                        .filter((epic) => {
                          if (!epicSearch.trim()) return true;
                          const q = epicSearch.toLowerCase();
                          return (
                            epic.key.toLowerCase().includes(q) ||
                            epic.summary.toLowerCase().includes(q)
                          );
                        })
                        .map((epic) => {
                          const isSelected = selectedEpics.some(
                            (e) => e.key === epic.key
                          );
                          return (
                            <button
                              key={epic.key}
                              type="button"
                              className={`w-full flex items-center gap-2 px-2.5 py-2 text-xs text-left transition-colors ${
                                isSelected
                                  ? 'bg-amber-50 dark:bg-amber-950/20'
                                  : 'hover:bg-muted/30'
                              }`}
                              onClick={() => {
                                if (isSelected) {
                                  setSelectedEpics((prev) =>
                                    prev.filter((e) => e.key !== epic.key)
                                  );
                                } else {
                                  setSelectedEpics((prev) => [
                                    ...prev,
                                    { key: epic.key, summary: epic.summary },
                                  ]);
                                }
                              }}
                            >
                              <span
                                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                                  isSelected
                                    ? 'bg-amber-500 border-amber-500 text-white'
                                    : 'border-muted-foreground/25'
                                }`}
                              >
                                {isSelected && <Check className="h-3 w-3" />}
                              </span>
                              <span className="font-mono text-[11px] text-muted-foreground shrink-0 w-20">
                                {epic.key}
                              </span>
                              <span className="truncate">
                                {epic.summary}
                              </span>
                            </button>
                          );
                        })}
                    </div>
                  </div>
                )}

                <p className="text-[11px] text-muted-foreground">
                  동기화 대상이 될 에픽을 선택합니다. 선택된 에픽에 속한 티켓만 HMG로 동기화됩니다.
                </p>
              </div>
            </div>
          )}
          </div>
        </div>
      )}

      {/* ── STEP 3: 필드 매핑 ── */}
      {bothFieldsLoaded && (
        <div className="border-b px-5 py-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">3</span>
            <span className="text-sm font-semibold">필드 매핑</span>
          </div>

          {/* 안내 */}
          <div className="text-xs text-muted-foreground bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded-md px-3 py-2 ml-7">
            왼쪽(소스)에서 필드를 선택하면 오른쪽(대상)에서 호환 가능한 필드만 활성화됩니다.
            양쪽 모두 선택 후 &quot;매핑 추가&quot; 버튼을 눌러주세요.
          </div>

          {/* 필드 선택 + 추가 버튼 */}
          <div className="grid grid-cols-[minmax(0,1fr),auto,minmax(0,1fr)] gap-3 items-start ml-7">
            <SelectableFieldList
              fields={sourceFields}
              isLoading={loadingSourceFields}
              label="소스 필드"
              selectedFieldId={selectedSourceField?.id ?? null}
              mappedIds={new Set<string>()}
              compatibleFilter={null}
              onFieldClick={handleSourceFieldClick}
              search={sourceSearch}
              onSearchChange={setSourceSearch}
            />

            <div className="flex flex-col items-center gap-2 pt-20">
              <Button
                size="sm"
                variant={canAddMapping ? 'default' : 'outline'}
                disabled={!canAddMapping}
                onClick={handleAddMapping}
                className="whitespace-nowrap"
              >
                <Plus className="mr-1 h-3 w-3" />
                매핑 추가
              </Button>
              {selectedSourceField && !selectedTargetField && (
                <span className="text-[10px] text-muted-foreground text-center max-w-[80px]">
                  대상 필드를 선택하세요
                </span>
              )}
            </div>

            <SelectableFieldList
              fields={targetFields}
              isLoading={loadingTargetFields}
              label="대상 필드"
              selectedFieldId={selectedTargetField?.id ?? null}
              mappedIds={mappedTargetIds}
              compatibleFilter={selectedSourceField ? targetCompatibleFilter : null}
              onFieldClick={handleTargetFieldClick}
              search={targetSearch}
              onSearchChange={setTargetSearch}
            />
          </div>

          {/* 추가된 매핑 목록 */}
          {pendingMappings.length > 0 && (
            <div className="space-y-2 ml-7">
              <div className="text-xs font-medium flex items-center gap-1.5">
                <Check className="h-3 w-3 text-emerald-500" />
                등록된 매핑 ({pendingMappings.length}개)
              </div>
              <div className="border border-emerald-200 dark:border-emerald-900 rounded-md divide-y overflow-hidden bg-emerald-50/50 dark:bg-emerald-950/10">
                {pendingMappings.map((m, i) => (
                  <div
                    key={`${m.sourceField}-${m.targetField}`}
                    className="flex items-center gap-2 px-3 py-2 text-xs overflow-hidden"
                    title={`${m.sourceField} → ${m.targetField}`}
                  >
                    <div className="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
                      <span className="truncate font-medium">
                        {m.sourceFieldName}
                      </span>
                      <code className="text-[10px] font-mono text-muted-foreground shrink-0">
                        ({m.sourceField})
                      </code>
                    </div>

                    <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />

                    <div className="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
                      <span className="truncate font-medium">
                        {m.targetFieldName}
                      </span>
                      <code className="text-[10px] font-mono text-muted-foreground shrink-0">
                        ({m.targetField})
                      </code>
                    </div>

                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0"
                      onClick={() => handleRemoveMapping(i)}
                    >
                      <X className="h-3 w-3 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 로딩 중 */}
      {(loadingSourceFields || loadingTargetFields) &&
        !bothFieldsLoaded && (
          <div className="flex items-center justify-center py-4 text-sm text-muted-foreground border-b">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            필드 목록을 불러오는 중...
          </div>
        )}

      {/* ── STEP 4: 상태 매핑 ── */}
      {sourceProjectId && targetProjectId && (sourceStatuses.length > 0 || targetStatuses.length > 0 || loadingSourceStatuses || loadingTargetStatuses || pendingStatusMappings.length > 0) && (
        <div className="border-b px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">4</span>
              <span className="text-sm font-semibold">상태 매핑</span>
            </div>
            <span className="text-[10px] text-muted-foreground">
              저장 시 워크플로우(전이 경로)가 자동 생성됩니다
            </span>
          </div>

          {(loadingSourceStatuses || loadingTargetStatuses) && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2 justify-center ml-7">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              상태 목록 조회 중...
            </div>
          )}

          {/* 매핑된 상태 목록 */}
          {pendingStatusMappings.length > 0 && (
            <div className="border border-emerald-200 dark:border-emerald-900 rounded-md divide-y overflow-hidden bg-emerald-50/50 dark:bg-emerald-950/10 ml-7">
              {pendingStatusMappings.map((s, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="font-medium">{s.sourceStatusName}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">({s.sourceStatusId})</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="font-medium">{s.targetStatusName}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">({s.targetStatusId})</span>
                  <Button
                    size="icon" variant="ghost" className="h-5 w-5 ml-auto shrink-0"
                    onClick={() => setPendingStatusMappings((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <X className="h-3 w-3 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* 시각적 상태 선택 */}
          {sourceStatuses.length > 0 && targetStatuses.length > 0 && (
            <div className="grid grid-cols-[1fr,auto,1fr] gap-3 items-start ml-7">
              {/* 소스 상태 */}
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">소스 상태</span>
                <div className="border rounded-md divide-y overflow-hidden">
                  {sourceStatuses.map((status) => {
                    const isMapped = pendingStatusMappings.some((m) => m.sourceStatusId === status.id);
                    const isSelected = selectedSourceStatus?.id === status.id;
                    return (
                      <button
                        key={status.id}
                        type="button"
                        className={`w-full flex items-center gap-2 px-2.5 py-2 text-xs text-left transition-colors ${
                          isSelected
                            ? 'bg-primary/10 ring-1 ring-inset ring-primary/30'
                            : isMapped
                              ? 'bg-muted/60 opacity-40 cursor-not-allowed'
                              : 'hover:bg-muted/40 cursor-pointer'
                        }`}
                        disabled={isMapped}
                        onClick={() => setSelectedSourceStatus(isSelected ? null : status)}
                      >
                        <span className="font-medium flex-1">{status.name}</span>
                        <span className="text-[10px] font-mono text-muted-foreground">{status.id}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 화살표 + 안내 */}
              <div className="flex flex-col items-center gap-1 pt-8">
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                {selectedSourceStatus && (
                  <span className="text-[10px] text-muted-foreground text-center max-w-[60px]">
                    대상 상태를 선택하세요
                  </span>
                )}
              </div>

              {/* 대상 상태 */}
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">대상 상태</span>
                <div className="border rounded-md divide-y overflow-hidden">
                  {targetStatuses.map((status) => {
                    const isMapped = pendingStatusMappings.some((m) => m.targetStatusId === status.id);
                    return (
                      <button
                        key={status.id}
                        type="button"
                        className={`w-full flex items-center gap-2 px-2.5 py-2 text-xs text-left transition-colors ${
                          isMapped
                            ? 'bg-muted/60 opacity-40 cursor-not-allowed'
                            : !selectedSourceStatus
                              ? 'opacity-50 cursor-not-allowed'
                              : 'hover:bg-muted/40 cursor-pointer'
                        }`}
                        disabled={isMapped || !selectedSourceStatus}
                        onClick={() => {
                          if (!selectedSourceStatus) return;
                          setPendingStatusMappings((prev) => [
                            ...prev,
                            {
                              sourceStatusId: selectedSourceStatus.id,
                              sourceStatusName: selectedSourceStatus.name,
                              targetStatusId: status.id,
                              targetStatusName: status.name,
                            },
                          ]);
                          setSelectedSourceStatus(null);
                        }}
                      >
                        <span className="font-medium flex-1">{status.name}</span>
                        <span className="text-[10px] font-mono text-muted-foreground">{status.id}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 버튼 (푸터) */}
      <div className="flex items-center justify-between bg-muted/20 px-5 py-3 border-t">
        <span className="text-xs text-muted-foreground">
          {pendingMappings.length > 0
            ? `${pendingMappings.length}개 필드 매핑`
            : '필드 매핑을 추가해주세요'}
          {pendingStatusMappings.length > 0 && ` · ${pendingStatusMappings.length}개 상태 매핑`}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={resetForm}
            disabled={saving}
          >
            취소
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !formName.trim() || !sourceProjectId || !targetProjectId}
          >
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {editingId ? '저장' : '완료'}
          </Button>
        </div>
      </div>
    </div>
  );

  // ── 렌더링 ──

  const isFormMode = isAdding || !!editingId;

  // 폼 뷰 (추가/편집)
  if (isFormMode) {
    return (
      <div className="max-w-5xl">
        <Card>
          <CardHeader>
            <div className="space-y-1">
              <CardTitle>
                {editingId ? '동기화 방식 편집' : '동기화 방식 추가'}
              </CardTitle>
              <CardDescription>
                소스와 대상 프로젝트를 선택하고 필드 매핑 규칙을 설정합니다.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>{formUI}</CardContent>
        </Card>
      </div>
    );
  }

  // 목록 뷰
  return (
    <div className="max-w-5xl">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <div className="space-y-1">
            <CardTitle>동기화 방식 관리</CardTitle>
            <CardDescription>
              프로젝트 간 동기화 시 필드 매핑 규칙을 관리합니다.
            </CardDescription>
          </div>
          <Button
            onClick={() => {
              resetForm();
              setIsAdding(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            동기화 방식 추가
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : profiles.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              등록된 동기화 방식이 없습니다. &quot;동기화 방식 추가&quot; 버튼으로 시작하세요.
            </div>
          ) : (
            <div className="space-y-2">
              {profiles.map((profile) => {
                const isExpanded = expandedId === profile.id;
                return (
                  <div
                    key={profile.id}
                    className="border rounded-lg overflow-hidden"
                  >
                    <div
                      className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                      onClick={() => handleToggleExpand(profile.id)}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}

                      <span className="font-medium text-sm">
                        {profile.name}
                      </span>

                      <span className="text-xs text-muted-foreground">
                        {profile.mappingCount}개 매핑
                        {profile.epicCount > 0 && (
                          <span className="ml-1.5">· {profile.epicCount}개 에픽</span>
                        )}
                        {profile.statusMappingCount > 0 && (
                          <span className="ml-1.5">· 상태 {profile.statusMappingCount}</span>
                        )}
                        {profile.workflowCount > 0 && (
                          <span className="ml-1.5">· 전이 {profile.workflowCount}</span>
                        )}
                      </span>

                      <div className="flex items-center gap-1.5 ml-auto mr-2">
                        <InstanceBadge
                          instance={getProjectInstance(profile.sourceProjectId)}
                        />
                        <span className="font-mono text-xs font-medium">
                          {getProjectName(profile.sourceProjectId)}
                        </span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        <InstanceBadge
                          instance={getProjectInstance(profile.targetProjectId)}
                        />
                        <span className="font-mono text-xs font-medium">
                          {getProjectName(profile.targetProjectId)}
                        </span>
                      </div>

                      <div className="flex gap-1 shrink-0">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEdit(profile);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(profile);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="border-t px-4 py-3 bg-muted/20">
                        {loadingExpanded ? (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            매핑 정보 로드 중...
                          </div>
                        ) : expandedMappings.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            등록된 필드 매핑이 없습니다.
                          </p>
                        ) : (
                          <div className="space-y-1">
                            {expandedMappings.map((m, i) => (
                              <div
                                key={i}
                                className="flex items-center gap-2 text-xs py-0.5"
                              >
                                <span className="font-medium">{m.sourceFieldName}</span>
                                <code className="text-[10px] font-mono text-muted-foreground">
                                  ({m.sourceField})
                                </code>
                                <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                                <span className="font-medium">{m.targetFieldName}</span>
                                <code className="text-[10px] font-mono text-muted-foreground">
                                  ({m.targetField})
                                </code>
                                {m.sourceType && m.sourceType !== 'copy' && (
                                  <TypeBadge type={m.sourceType} />
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
