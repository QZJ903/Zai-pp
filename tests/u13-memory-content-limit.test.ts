import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_CONTENT_MAX_CHARS } from '../core/constants';
import { MEMORY_DATABASE_NAME } from '../core/memory/schema';
import { deleteIndexedDb } from './helpers/indexeddb';

/**
 * The one content limit, enforced on every write path.
 *
 * The tool calls and the memory form already refused an over-long body; the JSON
 * import in the data page went through the same decoder, but that decoder only
 * checked for emptiness — so a hand-edited file could store a record the other
 * two paths reject.
 */

beforeAll(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

beforeEach(async () => {
  const { db } = await import('../core/memory/store');
  if (!db.isOpen()) await db.open();
});

afterEach(async () => {
  const { db } = await import('../core/memory/store');
  db.close();
  await deleteIndexedDb(MEMORY_DATABASE_NAME);
  vi.restoreAllMocks();
});

function draft(content: string) {
  return {
    type: 'topic' as const,
    name: 'n',
    content,
    description: 'n',
    tags: [],
    pinned: false,
  };
}

describe('memory content limit', () => {
  // ⚠️ 错误文案里的数字也引常量 —— 写死 8000 会在改上限时变成一条指向错误的红
  // （文案已经是新值，断言还在找旧值）。
  const overLimitPattern = new RegExp(`at most ${MEMORY_CONTENT_MAX_CHARS} characters`);

  it('accepts exactly the limit and rejects one unit more', async () => {
    const { getAllMemories, importMemoriesAtomically } = await import('../core/memory/store');

    await expect(importMemoriesAtomically([draft('x'.repeat(MEMORY_CONTENT_MAX_CHARS))]))
      .resolves.toHaveLength(1);
    await expect(importMemoriesAtomically([draft('x'.repeat(MEMORY_CONTENT_MAX_CHARS + 1))]))
      .rejects.toThrow(overLimitPattern);

    expect(await getAllMemories()).toHaveLength(1);
  });

  it('measures the limit the same way the form does', async () => {
    const { importMemoriesAtomically } = await import('../core/memory/store');
    // The limit is `string.length` — UTF-16 units — which is the same unit
    // HTML's `maxLength` applies to the form's textarea. An astral character
    // therefore counts twice, and that is exactly what keeps the form and the
    // import path accepting the same input.
    const emoji = '😀';
    const atLimit = emoji.repeat(MEMORY_CONTENT_MAX_CHARS / 2);
    expect(atLimit.length).toBe(MEMORY_CONTENT_MAX_CHARS);
    await expect(importMemoriesAtomically([draft(atLimit)])).resolves.toHaveLength(1);
    await expect(importMemoriesAtomically([draft(atLimit + emoji)]))
      .rejects.toThrow(overLimitPattern);
  });
});
