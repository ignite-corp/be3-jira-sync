-- =============================================================================
-- 신규 Supabase 프로젝트 전체 초기화 SQL (2026-07-05 기준)
-- Supabase Dashboard > SQL Editor에 전체 붙여넣고 Run
--
-- 구성:
--   1) db/supabase-init.sql            — 코어 10개 테이블
--   2) supabase/migrations/*           — 배포방/휴일/Tampermonkey (스키마 순서 보정)
--   3) deploy_room_checklist_user_status — 레포에 CREATE문이 없어 코드 기준으로 복원
--   4) 20260429_secure_all_tables      — RLS 일괄 적용 (마지막 실행)
--
-- 제외 (데이터 전제 필요 — FEHG/AUTOWAY/HMGBOARD 프로젝트 등록 후 개별 실행):
--   20260504_add_hmgboard_sync.sql, 20260504_fix_hmgboard_status_mapping.sql,
--   20260508_add_autoway_sprint_mapping.sql, 20260511_add_autoway_hmgboard_start_date.sql
-- =============================================================================

-- ───────────────────────── [1/15] db/supabase-init.sql ─────────────────────────
-- =============================================
-- Jira 통합 관리 도구 - DB 초기 스키마
-- Supabase SQL Editor에서 실행하세요
-- =============================================

-- 1. 프로젝트 테이블
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  jira_project_id TEXT NOT NULL UNIQUE,
  jira_instance TEXT NOT NULL DEFAULT 'ignite' CHECK (jira_instance IN ('ignite', 'hmg')),
  board_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. 팀 테이블
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  source_project_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE teams
  ADD CONSTRAINT fk_teams_source_project
  FOREIGN KEY (source_project_id) REFERENCES projects(id) ON DELETE SET NULL;

-- 3. 사용자 테이블
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  ignite_account_id TEXT NOT NULL DEFAULT '',
  ignite_jira_email TEXT NOT NULL DEFAULT '',
  ignite_jira_api_token TEXT NOT NULL DEFAULT '',
  hmg_account_id TEXT NOT NULL DEFAULT '',
  hmg_jira_email TEXT NOT NULL DEFAULT '',
  hmg_jira_api_token TEXT NOT NULL DEFAULT '',
  hmg_user_id TEXT NOT NULL DEFAULT '',
  h_chat_api_key TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. 프로젝트-팀 연결 (N:N)
CREATE TABLE project_teams (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, team_id)
);

-- 5. 동기화 프로필
CREATE TABLE sync_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  source_project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  target_project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  link_field TEXT,
  source_link_field TEXT,
  use_epic_prefix BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. 팀별 동기화 대상 프로젝트
CREATE TABLE team_target_projects (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sync_profile_id UUID REFERENCES sync_profiles(id) ON DELETE SET NULL,
  PRIMARY KEY (team_id, project_id)
);

-- 7. 필드 매핑 규칙
CREATE TABLE sync_field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
  source_field TEXT NOT NULL,
  source_field_name TEXT NOT NULL DEFAULT '',
  target_field TEXT NOT NULL,
  target_field_name TEXT NOT NULL DEFAULT '',
  transform_type TEXT,
  transform_config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. 상태 ID 매핑
CREATE TABLE sync_profile_status_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
  source_status_id TEXT NOT NULL,
  source_status_name TEXT NOT NULL DEFAULT '',
  target_status_id TEXT NOT NULL,
  target_status_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. 워크플로우 전이 규칙
CREATE TABLE sync_profile_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
  from_status_id TEXT NOT NULL,
  from_status_name TEXT NOT NULL DEFAULT '',
  to_status_id TEXT NOT NULL,
  to_status_name TEXT NOT NULL DEFAULT '',
  transition_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10. 동기화 허용 에픽 목록
CREATE TABLE sync_profile_allowed_epics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
  epic_key TEXT NOT NULL,
  epic_summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================
-- 트리거: updated_at 자동 갱신
-- =============================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_teams_updated_at
  BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- 인덱스
-- =============================================

CREATE INDEX idx_users_team_id ON users(team_id);
CREATE INDEX idx_team_target_projects_team ON team_target_projects(team_id);
CREATE INDEX idx_team_target_projects_project ON team_target_projects(project_id);
CREATE INDEX idx_project_teams_project ON project_teams(project_id);
CREATE INDEX idx_project_teams_team ON project_teams(team_id);

-- =============================================
-- RLS (개발용 전체 허용)
-- =============================================

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_target_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_field_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_profile_status_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_profile_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_profile_allowed_epics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for projects" ON projects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for teams" ON teams FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for users" ON users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for project_teams" ON project_teams FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for team_target_projects" ON team_target_projects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for sync_profiles" ON sync_profiles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for sync_field_mappings" ON sync_field_mappings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for sync_profile_status_mappings" ON sync_profile_status_mappings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for sync_profile_workflows" ON sync_profile_workflows FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for sync_profile_allowed_epics" ON sync_profile_allowed_epics FOR ALL USING (true) WITH CHECK (true);

-- ───────────────────────── 20260410_deploy_room.sql ─────────────────────────
-- 배포방 (Deploy Room) 기능 스키마
-- 실행: Supabase SQL Editor에 붙여넣고 Run

-- 1) 세션 (공유 링크의 ID)
create table if not exists public.deploy_room_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  template_id text not null,
  deploy_date date not null,
  confluence_page_url text,
  status text not null default 'preparing',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deploy_room_sessions_deploy_date_idx
  on public.deploy_room_sessions (deploy_date desc);

-- 2) 체크리스트 항목
create table if not exists public.deploy_room_checklist_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.deploy_room_sessions(id) on delete cascade,
  order_index int not null,
  title text not null,
  description text,
  checked boolean not null default false,
  checked_by text,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists deploy_room_checklist_items_session_idx
  on public.deploy_room_checklist_items (session_id, order_index);

-- 3) 담당 MR
create table if not exists public.deploy_room_mrs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.deploy_room_sessions(id) on delete cascade,
  gitlab_project_path text not null,
  mr_iid int not null,
  title text not null,
  url text not null,
  author_name text,
  source_branch text,
  target_branch text,
  included boolean not null default false,
  owner_user_id text,
  status text not null default 'pending',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, gitlab_project_path, mr_iid)
);

create index if not exists deploy_room_mrs_session_idx
  on public.deploy_room_mrs (session_id);

-- 4) 타임라인 (자동 기록)
create table if not exists public.deploy_room_timeline (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.deploy_room_sessions(id) on delete cascade,
  actor_user_id text,
  action text not null,
  target text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists deploy_room_timeline_session_idx
  on public.deploy_room_timeline (session_id, created_at desc);

-- 5) Realtime 구독을 위한 replica identity 설정
alter table public.deploy_room_sessions replica identity full;
alter table public.deploy_room_checklist_items replica identity full;
alter table public.deploy_room_mrs replica identity full;
alter table public.deploy_room_timeline replica identity full;

-- 6) Realtime publication 추가 (Supabase는 기본 publication이 supabase_realtime)
-- 이미 등록되어 있으면 에러 없이 넘어가도록 do 블록 사용
do $$
begin
  begin
    alter publication supabase_realtime add table public.deploy_room_sessions;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.deploy_room_checklist_items;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.deploy_room_mrs;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.deploy_room_timeline;
  exception when duplicate_object then null;
  end;
end $$;

-- ───────────────────────── 20260414_deploy_room_assignee.sql ─────────────────────────
-- deploy_room_mrs 테이블에 assignee_name 컬럼 추가
alter table public.deploy_room_mrs
  add column if not exists assignee_name text;

-- ───────────────────────── 20260415_deploy_room_templates.sql ─────────────────────────
-- 배포 시나리오 템플릿 테이블 생성
create table if not exists public.deploy_room_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  project text not null,
  deploy_type text not null,
  gitlab_projects text[] not null default '{}',
  team_members text[] not null default '{}',
  checklist jsonb not null default '[]',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deploy_room_templates_project_type_idx
  on public.deploy_room_templates (project, deploy_type);

-- 체크리스트 항목에 assignee 컬럼 추가
alter table public.deploy_room_checklist_items
  add column if not exists assignee text not null default 'all';

-- 기존 4개 템플릿 초기 데이터
insert into public.deploy_room_templates (name, project, deploy_type, gitlab_projects, team_members, checklist) values
('GW 정기배포', 'groupware', 'regular', array['https://gitlab.hmc.co.kr/hmg-groupware/hmg-groupware-portal/assemble-fe'], array['서성주','조한빈','손현지','한준호','박성찬','김찬영','김가빈'], '[{"title":"배포대장 및 배포 전 할 일 확인","assignee":"all"},{"title":"feature -> release 머지 확인","assignee":"member"},{"title":"release -> main 머지","assignee":"leader"},{"title":"배포 의존도 확인","assignee":"all"},{"title":"main 로컬 구동 모니터링","assignee":"all"},{"title":"블랙덕/소나큐브 확인","assignee":"member"},{"title":"배포 후 할 일 확인","assignee":"all"},{"title":"배포 태그 발행","assignee":"leader"},{"title":"배포 후 운영계 모니터링","assignee":"all"},{"title":"main -> stage(stage2), dev, release 현행화/배포","assignee":"member"}]'::jsonb),
('GW 비정기배포', 'groupware', 'adhoc', array['https://gitlab.hmc.co.kr/hmg-groupware/hmg-groupware-portal/assemble-fe'], array['서성주','조한빈','손현지','한준호','박성찬','김찬영','김가빈'], '[{"title":"배포대장 및 배포 전 할 일 확인","assignee":"all"},{"title":"feature -> release 머지 확인","assignee":"member"},{"title":"release -> main 머지","assignee":"leader"},{"title":"배포 의존도 확인","assignee":"all"},{"title":"main 로컬 구동 모니터링","assignee":"all"},{"title":"블랙덕/소나큐브 확인","assignee":"member"},{"title":"배포 후 할 일 확인","assignee":"all"},{"title":"배포 태그 발행","assignee":"leader"},{"title":"배포 후 운영계 모니터링","assignee":"all"},{"title":"main -> stage(stage2), dev, release 현행화/배포","assignee":"member"}]'::jsonb),
('GW 핫픽스', 'groupware', 'hotfix', array['https://gitlab.hmc.co.kr/hmg-groupware/hmg-groupware-portal/assemble-fe'], array['서성주','조한빈','손현지','한준호','박성찬','김찬영','김가빈'], '[{"title":"배포대장 및 배포 전 할 일 확인","assignee":"all"},{"title":"feature -> release 머지 확인","assignee":"member"},{"title":"release -> main 머지","assignee":"leader"},{"title":"배포 의존도 확인","assignee":"all"},{"title":"main 로컬 구동 모니터링","assignee":"all"},{"title":"블랙덕/소나큐브 확인","assignee":"member"},{"title":"배포 후 할 일 확인","assignee":"all"},{"title":"배포 태그 발행","assignee":"leader"},{"title":"배포 후 운영계 모니터링","assignee":"all"},{"title":"main -> stage(stage2), dev, release 현행화/배포","assignee":"member"}]'::jsonb),
('CPO 정기배포', 'cpo', 'regular', array['https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-bo-web','https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-partner-web'], array[]::text[], '[{"title":"배포대장 및 배포 전 할 일 확인","assignee":"all"},{"title":"feature -> release 머지 확인","assignee":"member"},{"title":"release -> main 머지","assignee":"leader"},{"title":"배포 의존도 확인","assignee":"all"},{"title":"main 로컬 구동 모니터링","assignee":"all"},{"title":"블랙덕/소나큐브 확인","assignee":"member"},{"title":"배포 후 할 일 확인","assignee":"all"},{"title":"배포 태그 발행","assignee":"leader"},{"title":"배포 후 운영계 모니터링","assignee":"all"},{"title":"main -> stage(stage2), dev, release 현행화/배포","assignee":"member"}]'::jsonb);

-- ───────────────────────── 20260415_session_deploy_type.sql ─────────────────────────
-- 세션에 배포유형 컬럼 추가
alter table public.deploy_room_sessions
  add column if not exists deploy_type text not null default 'regular';

-- ───────────────────────── 20260415_session_team.sql ─────────────────────────
-- 세션에 팀 연결
alter table public.deploy_room_sessions
  add column if not exists team_id uuid references public.teams(id) on delete set null;

-- ───────────────────────── 20260415_teams_leader.sql ─────────────────────────
-- teams 테이블에 팀장(leader) 컬럼 추가
alter table public.teams
  add column if not exists leader_id uuid references public.users(id) on delete set null;

-- ───────────────────────── deploy_room_checklist_user_status (복원) ─────────────────────────
-- 레포의 어떤 SQL에도 CREATE문이 없어 코드 사용처 기준으로 복원:
--   app/api/deploy-room/checklist-user-status/route.ts (upsert onConflict: checklist_item_id,user_name)
--   lib/services/deploy-room/mappers.ts UserStatusRow
--   lib/types/deploy-room.ts ChecklistItemStatus = 'pending' | 'in_progress' | 'done'
create table if not exists public.deploy_room_checklist_user_status (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.deploy_room_sessions(id) on delete cascade,
  checklist_item_id uuid not null references public.deploy_room_checklist_items(id) on delete cascade,
  user_name text not null,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'done')),
  updated_at timestamptz not null default now(),
  unique (checklist_item_id, user_name)
);

create index if not exists deploy_room_checklist_user_status_session_idx
  on public.deploy_room_checklist_user_status (session_id);

alter table public.deploy_room_checklist_user_status replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.deploy_room_checklist_user_status;
  exception when duplicate_object then null;
  end;
end $$;

-- ───────────────────────── 20260513_renormalize_user_status.sql ─────────────────────────
-- 운영 DB에 정규화 안 된 row가 잔존하는 문제 정리 (20260430 마이그레이션 재실행).
-- "김찬영/FE1/이그나이트" 같은 raw row가 "김찬영" row와 공존하면서
-- namesMatch + 최신 updatedAt 로직에서 raw row가 화면 표시를 가로채는 버그 수정.
-- 정책: (session_id, checklist_item_id, normalized_name) 기준 가장 최신 row만 남기고 나머지 삭제.

-- 1) 중복 row 제거 — 같은 (session, item, normalized_user)에 대해 가장 최신 updated_at만 유지
with ranked as (
  select
    id,
    btrim(split_part(user_name, '/', 1)) as norm_name,
    row_number() over (
      partition by session_id, checklist_item_id, btrim(split_part(user_name, '/', 1))
      order by updated_at desc, id desc
    ) as rn
  from public.deploy_room_checklist_user_status
)
delete from public.deploy_room_checklist_user_status
where id in (select id from ranked where rn > 1);

-- 2) 남은 row의 user_name을 정규화된 형태로 갱신
update public.deploy_room_checklist_user_status
set user_name = btrim(split_part(user_name, '/', 1))
where user_name <> btrim(split_part(user_name, '/', 1));

-- 3) 향후 같은 사고 방지를 위한 트리거: insert/update 시 user_name을 자동 정규화
create or replace function public.normalize_deploy_room_user_status_name()
returns trigger as $$
begin
  new.user_name = btrim(split_part(new.user_name, '/', 1));
  return new;
end;
$$ language plpgsql;

drop trigger if exists tr_normalize_deploy_room_user_status_name
  on public.deploy_room_checklist_user_status;

create trigger tr_normalize_deploy_room_user_status_name
before insert or update on public.deploy_room_checklist_user_status
for each row execute function public.normalize_deploy_room_user_status_name();

-- ───────────────────────── 20260506_holidays.sql ─────────────────────────
-- 휴일/휴가 마커 테이블
-- Jira 타임라인 등 외부 도구에서 휴일/휴가 표시용으로 사용
-- 같은 날짜에 여러 항목 등록 가능 (예: 같은 날 여러 명 휴가)

create table if not exists public.holidays (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  name text not null,
  type text not null check (type in ('holiday', 'vacation')),
  created_at timestamptz not null default now()
);

create index if not exists holidays_type_date_idx
  on public.holidays (type, date);

create index if not exists holidays_date_idx
  on public.holidays (date);

-- RLS 활성화 + anon 전체 접근 허용 (다른 테이블과 동일 패턴)
alter table public.holidays enable row level security;

drop policy if exists "anon_full_access" on public.holidays;
create policy "anon_full_access"
  on public.holidays
  for all
  to anon
  using (true)
  with check (true);

-- ───────────────────────── 20260506_holidays_seed.sql (seed 후 event_type 이전 순서 유지) ─────────────────────────
-- 휴일/휴가 초기 데이터 시드
-- 기존 Tampermonkey 스크립트(v0.4.1)에 하드코딩되어 있던 데이터 이관
-- 같은 (date, name, type) 조합이 이미 있으면 스킵 (재실행 안전)

insert into public.holidays (date, name, type)
select v.date::date, v.name, v.type
from (values
  -- 공휴일
  ('2026-02-16', '크리스마스', 'holiday'),
  ('2026-02-17', '크리스마스', 'holiday'),
  ('2026-02-18', '크리스마스', 'holiday'),
  ('2026-05-01', '노동절', 'holiday'),
  ('2026-05-05', '어린이날', 'holiday'),
  ('2026-05-25', '부처님오신날 대체휴일', 'holiday'),
  ('2026-06-11', '전사 워크샵', 'holiday'),
  ('2026-06-12', '전사 워크샵', 'holiday'),

  -- 휴가
  ('2026-02-04', '김찬영 휴가', 'vacation'),
  ('2026-02-05', '김찬영 오전반차', 'vacation'),
  ('2026-02-09', '손현지 오후반차', 'vacation'),
  ('2026-02-19', '손현지/조한빈/서성주 휴가', 'vacation'),
  ('2026-02-20', '손현지/조한빈 휴가', 'vacation'),
  ('2026-02-27', '서성주 휴가', 'vacation'),
  ('2026-03-30', '손현지 휴가', 'vacation'),
  ('2026-04-03', '서성주 휴가', 'vacation'),
  ('2026-04-24', '서성주 휴가', 'vacation'),
  ('2026-04-27', '손현지 휴가', 'vacation'),
  ('2026-05-04', '손현지 휴가', 'vacation'),
  ('2026-05-04', '조한빈 휴가', 'vacation'),
  ('2026-05-07', '한준호 오후반차', 'vacation'),
  ('2026-05-11', '한준호 오후반차', 'vacation'),
  ('2026-05-14', '한준호 오후반차', 'vacation'),
  ('2026-05-15', '조한빈 연차', 'vacation')
) as v(date, name, type)
where not exists (
  select 1 from public.holidays h
  where h.date = v.date::date
    and h.name = v.name
    and h.type = v.type
);

-- ───────────────────────── 20260506_holidays_add_event_type.sql ─────────────────────────
-- 'event' type 추가 (사내 이벤트: 워크샵, 행사 등)
-- 기존 holidays 테이블의 check constraint를 확장하고
-- 이미 시드된 '전사 워크샵' 항목을 event 타입으로 이전

-- 1) check constraint 갱신
alter table public.holidays
  drop constraint if exists holidays_type_check;

alter table public.holidays
  add constraint holidays_type_check
  check (type in ('holiday', 'vacation', 'event'));

-- 2) 기존 워크샵 항목을 event로 이전 (이름에 '워크샵' 포함된 holiday만)
update public.holidays
set type = 'event'
where type = 'holiday'
  and name like '%워크샵%';

-- ───────────────────────── 20260506_tampermonkey_scripts.sql ─────────────────────────
-- Tampermonkey 스크립트 관리 테이블
-- 어드민 페이지에서 코드 보기/수정/복사 가능하도록 DB로 이관

create table if not exists public.tampermonkey_scripts (
  id text primary key,
  name text not null,
  description text,
  code text not null,
  updated_at timestamptz not null default now()
);

-- RLS (다른 테이블과 동일 패턴)
alter table public.tampermonkey_scripts enable row level security;

drop policy if exists "anon_full_access" on public.tampermonkey_scripts;
create policy "anon_full_access"
  on public.tampermonkey_scripts
  for all
  to anon
  using (true)
  with check (true);

-- 초기 시드: Jira Timeline Day Marker v0.6.0
insert into public.tampermonkey_scripts (id, name, description, code)
values (
  'jira-timeline-day-marker',
  'Jira Timeline Day Marker',
  'Jira 타임라인에 공휴일/휴가/사내 이벤트를 색상으로 표시. fe1-web의 /api/holidays에서 데이터를 가져옴.',
  $code$// ==UserScript==
// @name         Jira Timeline Day Marker (API, holiday+vacation+event, month-bridge fix)
// @namespace    http://tampermonkey.net/
// @version      0.6.0
// @description  Holiday/vacation/event marker via fe1-web API
// @match        https://ignitecorp.atlassian.net/jira/software/projects/*/boards/*/timeline*
// @run-at       document-end
// @grant        none
// @connect      fe1-jira-sync.vercel.app
// ==/UserScript==

(function () {
  'use strict';

  const API_URL = 'https://fe1-jira-sync.vercel.app/api/holidays';
  const CACHE_KEY = 'jira-timeline-day-marker-cache';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  let HOLIDAY_MAP = new Map();
  let VACATION_MAP = new Map();
  let EVENT_MAP = new Map();

  const style = document.createElement('style');
  style.textContent = `
    span[data-testid*="calendar-cells.week.day-"].holiday {
      background-color: red !important;
      color: #fff !important;
      border-radius: 4px !important;
    }
    span[data-testid*="calendar-cells.week.day-"].vacation {
      background-color: blue !important;
      color: #fff !important;
      border-radius: 4px !important;
    }
    span[data-testid*="calendar-cells.week.day-"].event {
      background-color: #9333ea !important;
      color: #fff !important;
      border-radius: 4px !important;
    }
  `;
  document.head.appendChild(style);

  const pad2 = (n) => String(n).padStart(2, '0');
  const monthNameToMM = (name, year) => {
    const d = new Date(`${(name || '').trim()} 1, ${year}`);
    return Number.isNaN(d.getTime()) ? null : d.getMonth() + 1;
  };
  const prevMonth = (mm, yy) => (mm === 1 ? { mm: 12, yy: yy - 1 } : { mm: mm - 1, yy });
  const nextMonth = (mm, yy) => (mm === 12 ? { mm: 1, yy: yy + 1 } : { mm: mm + 1, yy });
  const appendTitle = (el, text) => {
    if (!text) return;
    const prev = el.getAttribute('title');
    el.setAttribute('title', prev ? `${prev} | ${text}` : text);
  };

  function buildMaps(data) {
    const make = (arr) => {
      const m = new Map();
      for (const { date, name } of arr || []) {
        if (!m.has(date)) m.set(date, []);
        m.get(date).push(name);
      }
      return m;
    };
    return {
      hMap: make(data.holidays),
      vMap: make(data.vacations),
      eMap: make(data.events),
    };
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (Date.now() - parsed.savedAt > CACHE_TTL_MS) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  function saveCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
    } catch {}
  }

  async function fetchData() {
    const res = await fetch(API_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'unknown');
    return {
      holidays: json.holidays || [],
      vacations: json.vacations || [],
      events: json.events || [],
    };
  }

  function mark() {
    let applied = 0;

    document.querySelectorAll('div[role="columnheader"]').forEach((header) => {
      let monthEl =
        header.querySelector('small span.css-tmya5') ||
        header.querySelector('small span.css-6cu6fo') ||
        header.querySelector('small span') ||
        header.querySelector('small');
      const monthTxt = monthEl?.textContent?.trim();
      if (!monthEl || !monthTxt) return;

      const aria = header.getAttribute('aria-label') || '';
      const labelYear = Number(aria.match(/\b(20\d{2})\b/)?.[1] || new Date().getFullYear());
      const labelMonth = monthNameToMM(monthTxt, labelYear);
      if (!labelMonth) return;

      const daySpans = Array.from(
        header.querySelectorAll('span[data-testid*="calendar-cells.week.day-"]')
      );
      if (!daySpans.length) return;

      const dayNums = daySpans.map((s) => Number((s.textContent || '').trim()));
      const idx1 = dayNums.indexOf(1);
      const total = daySpans.length;

      let labelSide = 'all';
      if (idx1 >= 0) {
        const leftCount = idx1;
        const rightCount = total - idx1;
        labelSide = leftCount > rightCount ? 'left' : 'right';
      }

      daySpans.forEach((daySpan, i) => {
        const dd = dayNums[i];
        if (!dd || dd < 1 || dd > 31) return;

        let mm = labelMonth;
        let yy = labelYear;

        if (idx1 >= 0) {
          if (labelSide === 'right') {
            if (i < idx1) {
              const p = prevMonth(labelMonth, labelYear);
              mm = p.mm; yy = p.yy;
            }
          } else if (labelSide === 'left') {
            if (i >= idx1) {
              const n = nextMonth(labelMonth, labelYear);
              mm = n.mm; yy = n.yy;
            }
          }
        }

        const key = `${yy}-${pad2(mm)}-${pad2(dd)}`;

        const holidayNames = HOLIDAY_MAP.get(key);
        if (holidayNames && holidayNames.length) {
          daySpan.classList.add('holiday');
          appendTitle(daySpan, holidayNames.join(', '));
          applied++;
        }

        const vacationNames = VACATION_MAP.get(key);
        if (vacationNames && vacationNames.length) {
          daySpan.classList.add('vacation');
          appendTitle(daySpan, `${vacationNames.join(', ')} 휴가`);
          applied++;
        }

        const eventNames = EVENT_MAP.get(key);
        if (eventNames && eventNames.length) {
          daySpan.classList.add('event');
          appendTitle(daySpan, eventNames.join(', '));
          applied++;
        }
      });
    });

    return applied;
  }

  function startPolling() {
    const START = Date.now();
    const TIMEOUT_MS = 50000;
    const POLL_MS = 400;

    const timer = setInterval(() => {
      const ready = document.querySelector('span[data-testid*="calendar-cells.week.day-"]');
      if (ready) {
        const count = mark();
        if (count > 0) clearInterval(timer);
      }
      if (Date.now() - START > TIMEOUT_MS) {
        clearInterval(timer);
        mark();
      }
    }, POLL_MS);
  }

  (async () => {
    const cached = loadCache();
    if (cached) {
      const { hMap, vMap, eMap } = buildMaps(cached);
      HOLIDAY_MAP = hMap; VACATION_MAP = vMap; EVENT_MAP = eMap;
    }

    try {
      const fresh = await fetchData();
      const { hMap, vMap, eMap } = buildMaps(fresh);
      HOLIDAY_MAP = hMap; VACATION_MAP = vMap; EVENT_MAP = eMap;
      saveCache(fresh);
    } catch (err) {
      console.warn('[Day Marker] API 실패, 캐시 사용:', err);
    }

    startPolling();
  })();
})();
$code$
)
on conflict (id) do nothing;

-- ───────────────────────── 20260506_tampermonkey_script_v5.sql (v2~v4는 v5로 대체) ─────────────────────────
-- Jira Timeline Day Marker 스크립트 v0.6.4
-- 변경: tooltip을 fixed-positioned body 직속 element로 변경
--   - 부모 overflow:hidden 영향 안 받음
--   - 마우스 enter/leave에 따라 위치 동적 계산 (viewport 경계 처리 포함)

update public.tampermonkey_scripts
set code = $code$// ==UserScript==
// @name         Jira Timeline Day Marker (API, holiday+vacation+event, month-bridge fix)
// @namespace    http://tampermonkey.net/
// @version      0.6.4
// @description  Holiday/vacation/event marker via fe1-web API
// @match        https://ignitecorp.atlassian.net/jira/software/projects/*/boards/*/timeline*
// @run-at       document-end
// @grant        none
// @connect      fe1-jira-sync.vercel.app
// ==/UserScript==

(function () {
  'use strict';

  const API_URL = 'https://fe1-jira-sync.vercel.app/api/holidays';

  let HOLIDAY_MAP = new Map();
  let VACATION_MAP = new Map();
  let EVENT_MAP = new Map();

  const style = document.createElement('style');
  style.textContent = `
    span[data-testid*="calendar-cells.week.day-"].holiday {
      background-color: red !important;
      color: #fff !important;
      border-radius: 4px !important;
    }
    span[data-testid*="calendar-cells.week.day-"].vacation {
      background-color: blue !important;
      color: #fff !important;
      border-radius: 4px !important;
    }
    span[data-testid*="calendar-cells.week.day-"].event {
      background-color: #9333ea !important;
      color: #fff !important;
      border-radius: 4px !important;
    }
    #__day_marker_tooltip {
      position: fixed;
      top: 0;
      left: 0;
      display: none;
      background: rgba(17, 24, 39, 0.95);
      color: #fff;
      padding: 5px 9px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      line-height: 1.4;
      max-width: 320px;
      z-index: 2147483647;
      pointer-events: none;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);

  // 단일 fixed-positioned tooltip element
  const tooltipEl = document.createElement('div');
  tooltipEl.id = '__day_marker_tooltip';
  document.body.appendChild(tooltipEl);

  const tooltipAttached = new WeakSet();

  function showTooltip(targetEl) {
    const text = targetEl.dataset.tooltipText;
    if (!text) return;
    tooltipEl.textContent = text;
    tooltipEl.style.display = 'block';

    const rect = targetEl.getBoundingClientRect();
    const tipRect = tooltipEl.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.top - tipRect.height - 8;

    // viewport 경계 처리
    const margin = 8;
    if (left < margin) left = margin;
    if (left + tipRect.width > window.innerWidth - margin) {
      left = window.innerWidth - tipRect.width - margin;
    }
    if (top < margin) top = rect.bottom + 8; // 위 공간 부족 → 아래로

    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  }

  function hideTooltip() {
    tooltipEl.style.display = 'none';
  }

  function attachTooltipOnce(el) {
    if (tooltipAttached.has(el)) return;
    tooltipAttached.add(el);
    el.addEventListener('mouseenter', () => showTooltip(el));
    el.addEventListener('mouseleave', hideTooltip);
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const monthNameToMM = (name, year) => {
    const d = new Date(`${(name || '').trim()} 1, ${year}`);
    return Number.isNaN(d.getTime()) ? null : d.getMonth() + 1;
  };
  const prevMonth = (mm, yy) => (mm === 1 ? { mm: 12, yy: yy - 1 } : { mm: mm - 1, yy });
  const nextMonth = (mm, yy) => (mm === 12 ? { mm: 1, yy: yy + 1 } : { mm: mm + 1, yy });

  const appendTooltip = (el, text) => {
    if (!text) return;
    const prev = el.dataset.tooltipText;
    el.dataset.tooltipText = prev ? `${prev} | ${text}` : text;
    attachTooltipOnce(el);
  };

  function buildMaps(data) {
    const make = (arr) => {
      const m = new Map();
      for (const { date, name } of arr || []) {
        if (!m.has(date)) m.set(date, []);
        m.get(date).push(name);
      }
      return m;
    };
    return {
      hMap: make(data.holidays),
      vMap: make(data.vacations),
      eMap: make(data.events),
    };
  }

  async function fetchData() {
    const res = await fetch(API_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'unknown');
    return {
      holidays: json.holidays || [],
      vacations: json.vacations || [],
      events: json.events || [],
    };
  }

  function mark() {
    let applied = 0;

    // 모든 day 셀의 마킹 초기화
    document.querySelectorAll('span[data-testid*="calendar-cells.week.day-"]').forEach((el) => {
      el.classList.remove('holiday', 'vacation', 'event');
      el.removeAttribute('title');
      delete el.dataset.tooltipText;
    });

    document.querySelectorAll('div[role="columnheader"]').forEach((header) => {
      let monthEl =
        header.querySelector('small span.css-tmya5') ||
        header.querySelector('small span.css-6cu6fo') ||
        header.querySelector('small span') ||
        header.querySelector('small');
      const monthTxt = monthEl?.textContent?.trim();
      if (!monthEl || !monthTxt) return;

      const aria = header.getAttribute('aria-label') || '';
      const labelYear = Number(aria.match(/\b(20\d{2})\b/)?.[1] || new Date().getFullYear());
      const labelMonth = monthNameToMM(monthTxt, labelYear);
      if (!labelMonth) return;

      const daySpans = Array.from(
        header.querySelectorAll('span[data-testid*="calendar-cells.week.day-"]')
      );
      if (!daySpans.length) return;

      const dayNums = daySpans.map((s) => Number((s.textContent || '').trim()));
      const idx1 = dayNums.indexOf(1);
      const total = daySpans.length;

      let labelSide = 'all';
      if (idx1 >= 0) {
        const leftCount = idx1;
        const rightCount = total - idx1;
        labelSide = leftCount > rightCount ? 'left' : 'right';
      }

      daySpans.forEach((daySpan, i) => {
        const dd = dayNums[i];
        if (!dd || dd < 1 || dd > 31) return;

        let mm = labelMonth;
        let yy = labelYear;

        if (idx1 >= 0) {
          if (labelSide === 'right') {
            if (i < idx1) {
              const p = prevMonth(labelMonth, labelYear);
              mm = p.mm; yy = p.yy;
            }
          } else if (labelSide === 'left') {
            if (i >= idx1) {
              const n = nextMonth(labelMonth, labelYear);
              mm = n.mm; yy = n.yy;
            }
          }
        }

        const key = `${yy}-${pad2(mm)}-${pad2(dd)}`;

        const holidayNames = HOLIDAY_MAP.get(key);
        if (holidayNames && holidayNames.length) {
          daySpan.classList.add('holiday');
          appendTooltip(daySpan, holidayNames.join(', '));
          applied++;
        }

        const vacationNames = VACATION_MAP.get(key);
        if (vacationNames && vacationNames.length) {
          daySpan.classList.add('vacation');
          appendTooltip(daySpan, `${vacationNames.join(', ')} 휴가`);
          applied++;
        }

        const eventNames = EVENT_MAP.get(key);
        if (eventNames && eventNames.length) {
          daySpan.classList.add('event');
          appendTooltip(daySpan, eventNames.join(', '));
          applied++;
        }
      });
    });

    return applied;
  }

  function startPolling() {
    const START = Date.now();
    const TIMEOUT_MS = 50000;
    const POLL_MS = 400;

    const timer = setInterval(() => {
      const ready = document.querySelector('span[data-testid*="calendar-cells.week.day-"]');
      if (ready) {
        const count = mark();
        if (count > 0) clearInterval(timer);
      }
      if (Date.now() - START > TIMEOUT_MS) {
        clearInterval(timer);
        mark();
      }
    }, POLL_MS);
  }

  (async () => {
    try {
      const fresh = await fetchData();
      const { hMap, vMap, eMap } = buildMaps(fresh);
      HOLIDAY_MAP = hMap; VACATION_MAP = vMap; EVENT_MAP = eMap;
    } catch (err) {
      console.warn('[Day Marker] API 실패:', err);
    }

    startPolling();
  })();
})();
$code$,
    updated_at = now()
where id = 'jira-timeline-day-marker';

-- ───────────────────────── 20260429_secure_all_tables.sql (RLS 일괄 — 마지막) ─────────────────────────
-- =============================================================================
-- 모든 public 테이블 RLS 일괄 보안 (idempotent)
-- 실행 위치: Supabase Dashboard → SQL Editor
-- =============================================================================
-- 목적:
--   1. public 스키마 모든 테이블에 RLS 강제 활성화
--   2. users 테이블: 정책 없이 RLS만 → anon 완전 차단 (service_role만 접근)
--   3. 나머지 테이블: anon_full_access 정책으로 anon 허용 (앱 동작 유지)
--   4. 옛 정책(Allow all for *, Allow all access for anon) 제거
--
-- service_role은 RLS를 자동 bypass → 서버 사이드 API Route는 영향 없음
-- 이 SQL은 idempotent — 안전하게 여러 번 실행해도 결과 동일
-- =============================================================================

-- ── 0. 안전장치: trigger 함수가 있는지 확인 (init.sql 미실행 환경 보호) ─────
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'update_updated_at') then
    raise notice 'update_updated_at function 없음 — db/supabase-init.sql 먼저 실행하세요';
  end if;
end $$;

-- ── 1. 옛 정책 일괄 제거 (DROP IF EXISTS) ────────────────────────────────────
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and (
        policyname like 'Allow all for %'
        or policyname = 'Allow all access for anon'
        or policyname = 'anon_full_access'
      )
  loop
    execute format('drop policy if exists %I on %I.%I',
                   r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- ── 2. 모든 public 테이블에 RLS 활성화 (동적) ─────────────────────────────────
-- 새 테이블 누락 방지: 코드 추가/제거에 강건
do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end $$;

-- ── 3. users 외 모든 테이블: anon_full_access 정책 부여 ────────────────────
-- (users는 정책 없이 두면 anon 자동 차단)
do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> 'users'
  loop
    execute format(
      'create policy "anon_full_access" on public.%I for all to anon using (true) with check (true)',
      r.tablename
    );
  end loop;
end $$;

-- =============================================================================
-- ✅ 검증 쿼리 (실행 결과 보고 OK 여부 판단)
-- =============================================================================

-- 검증 1: public 테이블의 RLS 활성화 상태
-- 모든 row의 rls_enabled = true 여야 함
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relname;

-- 검증 2: 정책 목록
-- users 빼고 모두 anon_full_access 1개씩 있어야 함
select
  tablename,
  policyname,
  roles,
  cmd
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 검증 3: ⚠️ users 테이블에는 정책이 0개여야 함 (있으면 anon 차단 안 됨)
select count(*) as users_policy_count
from pg_policies
where schemaname = 'public'
  and tablename = 'users';
-- ↑ 이 값이 0 이면 정상

-- 검증 4: RLS 비활성 테이블 (있으면 즉시 fix 필요 — 정상이면 0 row)
select c.relname as table_without_rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relrowsecurity = false;

-- ───────────────────────── 운영 DB drift 컬럼 복원 (레포 SQL에 없음) ─────────────────────────
-- 코드 사용처 기준:
--   users.gitlab_token                         — app/api/users/route.ts (사용자 등록/조회)
--   deploy_room_sessions.confluence_tasks      — lib/services/deploy-room/session.service.ts (jsonb: {before,after})
--   deploy_room_sessions.inactive_participants — 〃 (text[])
alter table public.users
  add column if not exists gitlab_token text not null default '';

alter table public.deploy_room_sessions
  add column if not exists confluence_tasks jsonb,
  add column if not exists inactive_participants text[] not null default '{}';
