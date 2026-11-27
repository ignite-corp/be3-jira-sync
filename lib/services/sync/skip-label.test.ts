import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SKIP_LABEL,
  hasSkipLabel,
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
