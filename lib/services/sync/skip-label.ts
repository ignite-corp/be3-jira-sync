// HMG 미러 신규 생성 제외 라벨 판정 (순수 함수 — 단위 테스트 대상)

export const DEFAULT_SKIP_LABEL = 'hmg-sync-skip';

export function resolveSkipLabel(env: string | undefined = process.env.HMG_SYNC_SKIP_LABEL): string {
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
