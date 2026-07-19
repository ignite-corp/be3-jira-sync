// 필드 변환 공용 유틸리티
// 필드 매핑 자체는 DB 기반 (db-field-mapper.ts) 으로만 수행

/**
 * ADF에서 HMG Jira와 호환되지 않는 노드 제거
 * - 미디어 노드 (mediaGroup, mediaSingle, media)
 * - 빈 content 배열을 가진 노드 (HMG Jira INVALID_INPUT 유발)
 *
 * 순서: 먼저 자식을 재귀 정리 → 그 결과로 빈 노드가 되면 제거
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stripAdfMediaNodes(adf: any): any {
  if (!adf || typeof adf !== 'object') return adf;
  if (!adf.content || !Array.isArray(adf.content)) return adf;

  const REMOVE_TYPES = ['mediaGroup', 'mediaSingle', 'media'];

  const cleaned = adf.content
    .filter((node: { type?: string }) => !REMOVE_TYPES.includes(node.type || ''))
    .map((node: { content?: unknown[] }) =>
      node.content ? stripAdfMediaNodes(node) : node
    )
    .filter((node: { content?: unknown[] }) =>
      !(Array.isArray(node.content) && node.content.length === 0)
    );

  return { ...adf, content: cleaned };
}

/**
 * 청크 분할 유틸리티
 */
export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}
