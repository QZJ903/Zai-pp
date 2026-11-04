import { describe, expect, it } from 'vitest';
import { previewMemoryImport } from '../core/memory/importer';

describe('memory import preview truncation signal', () => {
  it('counts drafts dropped by the preview limit instead of discarding them silently', () => {
    const content = Array.from({ length: 150 }, (_, index) => `记忆条目 ${index} 的正文内容`).join('\n\n');
    const preview = previewMemoryImport({ content });
    expect(preview.memories).toHaveLength(100);
    expect(preview.omitted).toBe(50);
  });

  it('reports zero omitted when everything fits', () => {
    const preview = previewMemoryImport({ content: '只有一条记忆' });
    expect(preview.omitted).toBe(0);
  });
});
