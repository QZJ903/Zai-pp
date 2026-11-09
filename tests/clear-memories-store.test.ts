import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_DATABASE_NAME } from '../core/memory/schema';
import { deleteIndexedDb } from './helpers/indexeddb';

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

function draft(index: number) {
  return {
    type: 'topic' as const,
    name: `n${index}`,
    content: `content ${index}`,
    description: `n${index}`,
    tags: [],
    pinned: false,
  };
}

describe('clearMemories', () => {
  it('removes every row in one transaction', async () => {
    const { clearMemories, getAllMemories, importMemoriesAtomically } = await import('../core/memory/store');
    await importMemoriesAtomically([draft(1), draft(2), draft(3)]);
    expect(await getAllMemories()).toHaveLength(3);

    await clearMemories();

    expect(await getAllMemories()).toEqual([]);
  });

  it('is a no-op on an empty store', async () => {
    const { clearMemories, getAllMemories } = await import('../core/memory/store');
    await expect(clearMemories()).resolves.toBeUndefined();
    expect(await getAllMemories()).toEqual([]);
  });

  it('still fails closed on a corrupted row instead of clearing it silently', async () => {
    const { clearMemories, importMemoriesAtomically, db } = await import('../core/memory/store');
    const { MEMORY_TABLE_NAME } = await import('../core/memory/schema');
    await importMemoriesAtomically([draft(1)]);
    // Write a row the decoder rejects, then confirm the clear reports it rather
    // than dropping data the user might still be able to recover.
    await db.transaction('rw', db.table(MEMORY_TABLE_NAME), async (tx) => {
      await tx.table(MEMORY_TABLE_NAME).put({ ...draft(9), id: 999, type: 'future-type' });
    });

    await expect(clearMemories()).rejects.toThrow();
  });
});
