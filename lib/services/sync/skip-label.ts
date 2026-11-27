// HMG 미러 신규 생성 제외 라벨 판정 (순수 함수 — 단위 테스트 대상)

export const DEFAULT_SKIP_LABEL = 'hmg-sync-skip';

// UI(브라우저) 동기화에서도 읽히도록 NEXT_PUBLIC_ 변수를 우선하고, 배치는 HMG_SYNC_SKIP_LABEL 도 허용
export function resolveSkipLabel(
  env: string | undefined = process.env.NEXT_PUBLIC_HMG_SYNC_SKIP_LABEL ||
    process.env.HMG_SYNC_SKIP_LABEL
): string {
  const trimmed = env?.trim();
  return trimmed ? trimmed : DEFAULT_SKIP_LABEL;
}

export function hasSkipLabel(labels: unknown, skipLabel: string): boolean {
  if (!Array.isArray(labels)) return false;
  const target = skipLabel.toLowerCase();
  return labels.some((l) => typeof l === 'string' && l.toLowerCase() === target);
}

// 신규 미러 생성만 막는다: 이미 HMG 링크가 있는 티켓은 라벨이 있어도 대상 유지
export function shouldSkipMirrorCreation(
  hasTargetLink: boolean,
  labels: unknown,
  skipLabel: string
): boolean {
  return !hasTargetLink && hasSkipLabel(labels, skipLabel);
}

// link 필드 원시값(string | string[] | { value }) 을 문자열로 정규화 (hmg-sync.service 와 동일 규칙)
export function normalizeLinkValue(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) return raw[0] ? String(raw[0]).trim() : '';
  if (raw && typeof raw === 'object' && 'value' in raw) {
    return String((raw as { value?: unknown }).value ?? '').trim();
  }
  return '';
}

// link 필드 값에 대상 프로젝트 키(예: HMG-123)가 있으면 이미 미러가 있는 것으로 본다
export function hasTargetLinkValue(raw: unknown, targetProjectKey: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${targetProjectKey}-\\d+`).test(normalizeLinkValue(raw));
}
