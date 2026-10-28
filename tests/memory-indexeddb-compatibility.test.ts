import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MEMORY_DATABASE_NAME,
  MEMORY_TABLE_NAME,
  MEMORY_TABLE_SCHEMAS,
} from '../core/memory/schema';
import {
  MEMORY_V1_ADDITIVE_RECORD,
  MEMORY_IMPORT_PREVIEW_RECORD,
  MEMORY_V2_ADDITIVE_RECORD,
  MEMORY_V2_RECORD,
  MEMORY_V3_PROJECT_ADDITIVE_RECORD,
  MEMORY_V3_PROJECT_RECORD,
  MEMORY_V4_RECORD,
} from './fixtures/persistence-contract/memory';
import {
  addIndexedDbRecords,
  createIndexedDbAtVersion,
  createStore,
  deleteIndexedDb,
  readIndexedDbRecords,
} from './helpers/indexeddb';

const indexedDbFactory = new IDBFactory();

beforeAll(() => {
  vi.stubGlobal('indexedDB', indexedDbFactory);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(MEMORY_V2_RECORD.syncId);
});

afterEach(async () => {
  const { db } = await import('../core/memory/store');
  db.close();
  await deleteIndexedDb(MEMORY_DATABASE_NAME);
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Memory historical IndexedDB compatibility', () => {
  it('executes v1→v4 and v2→v4 upgrades while preserving additive fields across reopen', async () => {
    await seedMemoryDatabase(1, MEMORY_V1_ADDITIVE_RECORD);
    const {
      captureRawMemoryRecordsForSyncRecovery,
      db,
      replaceAllMemories,
      restoreRawMemoryRecordsForSyncRecovery,
    } = await import('../core/memory/store');
    const memories = db.table(MEMORY_TABLE_NAME);

    await db.open();
    expect(await memories.toArray()).toEqual([{
      ...MEMORY_V4_RECORD,
      futureRecordField: MEMORY_V1_ADDITIVE_RECORD.futureRecordField,
    }]);
    db.close();
    await db.open();
    expect(await memories.toArray()).toEqual([{
      ...MEMORY_V4_RECORD,
      futureRecordField: MEMORY_V1_ADDITIVE_RECORD.futureRecordField,
    }]);

    db.close();
    await deleteIndexedDb(MEMORY_DATABASE_NAME);
    await seedMemoryDatabase(2, MEMORY_V2_ADDITIVE_RECORD);

    await db.open();
    expect(await memories.toArray()).toEqual([{
      ...MEMORY_V4_RECORD,
      futureRecordField: MEMORY_V2_ADDITIVE_RECORD.futureRecordField,
    }]);
    await memories.add({
      ...MEMORY_V3_PROJECT_ADDITIVE_RECORD,
      tags: [...MEMORY_V3_PROJECT_ADDITIVE_RECORD.tags],
    });
    db.close();

    await db.open();
    expect(await memories.orderBy('id').toArray()).toEqual([
      {
        ...MEMORY_V4_RECORD,
        futureRecordField: MEMORY_V2_ADDITIVE_RECORD.futureRecordField,
      },
      MEMORY_V3_PROJECT_ADDITIVE_RECORD,
    ]);
    expect(db.name).toBe(MEMORY_DATABASE_NAME);
    expect(memories.schema.primKey).toMatchObject({ name: 'id', auto: true });

    await memories.update(MEMORY_V4_RECORD.id, { recoveryFutureField: { preserve: true } } as never);
    const rawBefore = await captureRawMemoryRecordsForSyncRecovery();
    await replaceAllMemories([{ ...MEMORY_V4_RECORD, id: 99, tags: [...MEMORY_V4_RECORD.tags] }]);
    await restoreRawMemoryRecordsForSyncRecovery(rawBefore);
    expect(await memories.orderBy('id').toArray()).toEqual(rawBefore);
    const { id: _id, ...newMemory } = MEMORY_V3_PROJECT_RECORD;
    const nextIdAfterRollback = await memories.add({
      ...newMemory,
      syncId: '00000000-0000-4000-8000-000000000009',
      tags: [...newMemory.tags],
    });
    expect(nextIdAfterRollback).toBe(100);
  });

  it('drops project-scoped rows and their scope fields when upgrading from v3', async () => {
    await createIndexedDbAtVersion(MEMORY_DATABASE_NAME, 30, (db) => {
      createStore(db, MEMORY_TABLE_NAME, memorySeedSpec(3));
    });
    await addIndexedDbRecords(MEMORY_DATABASE_NAME, MEMORY_TABLE_NAME, [
      { ...MEMORY_V3_PROJECT_ADDITIVE_RECORD },
    ]);

    const { db } = await import('../core/memory/store');
    const memories = db.table(MEMORY_TABLE_NAME);
    await db.open();

    // 项目作用域的记录整条消失；其余记录保留，`scope` 字段被剥掉。
    expect(await memories.orderBy('id').toArray()).toEqual([]);

    db.close();
    await deleteIndexedDb(MEMORY_DATABASE_NAME);
    await createIndexedDbAtVersion(MEMORY_DATABASE_NAME, 30, (db) => {
      createStore(db, MEMORY_TABLE_NAME, memorySeedSpec(3));
    });
    await addIndexedDbRecords(MEMORY_DATABASE_NAME, MEMORY_TABLE_NAME, [
      { ...MEMORY_V2_RECORD, scope: 'global' },
    ]);
    await db.open();
    expect(await memories.toArray()).toEqual([MEMORY_V4_RECORD]);
  });

  it('rejects a future database version without overwriting its raw rows', async () => {
    const futureRecord = {
      ...MEMORY_V4_RECORD,
      futureDatabaseField: { preserve: true },
    };
    await createIndexedDbAtVersion(MEMORY_DATABASE_NAME, 50, (db) => {
      createStore(db, MEMORY_TABLE_NAME, memorySeedSpec(4));
    });
    await addIndexedDbRecords(MEMORY_DATABASE_NAME, MEMORY_TABLE_NAME, [futureRecord]);

    const {
      db,
      getAllMemories,
      importMemoriesAtomically,
    } = await import('../core/memory/store');
    await expect(getAllMemories()).rejects.toBeInstanceOf(Error);
    await expect(importMemoriesAtomically([{
      ...MEMORY_IMPORT_PREVIEW_RECORD,
      tags: [...MEMORY_IMPORT_PREVIEW_RECORD.tags],
    }])).rejects.toBeInstanceOf(Error);
    db.close();

    expect(await readIndexedDbRecords(MEMORY_DATABASE_NAME, MEMORY_TABLE_NAME))
      .toEqual([futureRecord]);
  });
});

async function seedMemoryDatabase(version: 1 | 2, record: Record<string, unknown>): Promise<void> {
  await createIndexedDbAtVersion(MEMORY_DATABASE_NAME, version * 10, (db) => {
    createStore(db, MEMORY_TABLE_NAME, memorySeedSpec(version));
  });
  await addIndexedDbRecords(MEMORY_DATABASE_NAME, MEMORY_TABLE_NAME, [{ ...record }]);
}

function memorySeedSpec(version: 1 | 2 | 3 | 4): {
  keyPath: string;
  autoIncrement: boolean;
  indexes: readonly string[];
} {
  const schema = MEMORY_TABLE_SCHEMAS[version];
  const [primaryKey, ...indexes] = schema.split(',').map((token) => token.trim());
  if (!primaryKey?.startsWith('++')) {
    throw new Error(`Memory seed schema must declare an auto-increment key: ${schema}`);
  }
  return {
    keyPath: primaryKey.slice(2),
    autoIncrement: true,
    indexes,
  };
}
