import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SKIP_LABEL,
  hasSkipLabel,
  hasTargetLinkValue,
  normalizeLinkValue,
  resolveSkipLabel,
  shouldSkipMirrorCreation,
} from './skip-label.ts';

test('라벨이 있으면 true', () => {
  assert.equal(hasSkipLabel(['a', 'hmg-sync-skip'], DEFAULT_SKIP_LABEL), true);
});

test('라벨이 없으면 false', () => {
  assert.equal(hasSkipLabel(['a', 'b'], DEFAULT_SKIP_LABEL), false);
  assert.equal(hasSkipLabel([], DEFAULT_SKIP_LABEL), false);
});

test('대소문자 무시', () => {
  assert.equal(hasSkipLabel(['HMG-Sync-Skip'], DEFAULT_SKIP_LABEL), true);
  assert.equal(hasSkipLabel(['hmg-sync-skip'], 'HMG-SYNC-SKIP'), true);
});

test('labels 필드가 없거나 배열이 아니면 false', () => {
  assert.equal(hasSkipLabel(undefined, DEFAULT_SKIP_LABEL), false);
  assert.equal(hasSkipLabel(null, DEFAULT_SKIP_LABEL), false);
  assert.equal(hasSkipLabel('hmg-sync-skip', DEFAULT_SKIP_LABEL), false);
});

test('부분 일치는 제외하지 않음', () => {
  assert.equal(hasSkipLabel(['hmg-sync-skip-x'], DEFAULT_SKIP_LABEL), false);
});

test('설정값: 미설정·공백이면 기본값, 설정 시 그 값', () => {
  assert.equal(resolveSkipLabel(undefined), DEFAULT_SKIP_LABEL);
  assert.equal(resolveSkipLabel('  '), DEFAULT_SKIP_LABEL);
  assert.equal(resolveSkipLabel(' my-skip '), 'my-skip');
});

test('라벨 있고 링크 없음 → 제외', () => {
  assert.equal(shouldSkipMirrorCreation(false, ['hmg-sync-skip'], DEFAULT_SKIP_LABEL), true);
});

test('라벨 있고 링크 있음 → 대상 유지', () => {
  assert.equal(shouldSkipMirrorCreation(true, ['hmg-sync-skip'], DEFAULT_SKIP_LABEL), false);
});

test('라벨 없음 → 기존과 동일(제외 안 함)', () => {
  assert.equal(shouldSkipMirrorCreation(false, ['x'], DEFAULT_SKIP_LABEL), false);
  assert.equal(shouldSkipMirrorCreation(true, [], DEFAULT_SKIP_LABEL), false);
});

test('link 값 정규화: 문자열·배열·{ value }·그 외', () => {
  assert.equal(normalizeLinkValue(' https://x/browse/HMG-1 '), 'https://x/browse/HMG-1');
  assert.equal(normalizeLinkValue(['HMG-2']), 'HMG-2');
  assert.equal(normalizeLinkValue({ value: 'HMG-3' }), 'HMG-3');
  assert.equal(normalizeLinkValue(undefined), '');
  assert.equal(normalizeLinkValue([]), '');
});

test('에픽: 라벨 있고 HMG 링크 없음 → 신규 생성 안 함', () => {
  const link = '';
  assert.equal(
    shouldSkipMirrorCreation(hasTargetLinkValue(link, 'HMG'), ['hmg-sync-skip'], DEFAULT_SKIP_LABEL),
    true
  );
});

test('에픽: 라벨 있어도 HMG 링크 있으면 기존 동기화 유지', () => {
  const link = 'https://jira.example/browse/HMG-77';
  assert.equal(hasTargetLinkValue(link, 'HMG'), true);
  assert.equal(
    shouldSkipMirrorCreation(hasTargetLinkValue(link, 'HMG'), ['hmg-sync-skip'], DEFAULT_SKIP_LABEL),
    false
  );
  assert.equal(hasTargetLinkValue({ value: link }, 'HMG'), true);
});

test('에픽: 다른 프로젝트 키 링크는 HMG 링크로 보지 않음', () => {
  assert.equal(hasTargetLinkValue('https://x/browse/ABC-1', 'HMG'), false);
});

test('자식 티켓 판정은 부모 라벨과 무관 (자신의 라벨만 본다)', () => {
  assert.equal(shouldSkipMirrorCreation(false, [], DEFAULT_SKIP_LABEL), false);
});
