-- =============================================================================
-- sync_profiles에 에픽 말머리 사용 여부(use_epic_prefix) 컬럼 추가
-- 실행 위치: Supabase Dashboard → SQL Editor
-- =============================================================================
-- 배경:
--   에픽 동기화 시 타겟 에픽 summary에 항상 "[소스프로젝트키] " 말머리를 붙여
--   매칭/생성하고 있음. 타겟 프로젝트에 이미 존재하는(말머리 없는) 에픽을
--   그대로 재활용하고 싶은 경우를 위해 프로필 단위로 말머리를 끌 수 있는
--   옵션을 추가.
--
--   - true(기본값): 기존과 동일 — "[소스키] 소스에픽summary"로 매칭/생성
--   - false: 소스 에픽 summary 그대로(말머리 없이) 매칭/생성
--
-- 정책:
--   - ADD COLUMN IF NOT EXISTS로 idempotent
--   - NOT NULL DEFAULT true → 기존 프로필은 전부 기존 동작 유지
-- =============================================================================

alter table public.sync_profiles
  add column if not exists use_epic_prefix boolean not null default true;

-- =============================================================================
-- ✅ 검증 쿼리
-- =============================================================================
select sp.name, sp.use_epic_prefix
from public.sync_profiles sp
order by sp.name;
