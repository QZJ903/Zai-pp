export const MEMORY_DATABASE_NAME = 'ZaiPP';
export const MEMORY_DATABASE_VERSION = 4 as const;
export const MEMORY_TABLE_NAME = 'memories';

export const MEMORY_TABLE_SCHEMAS = {
  1: '++id, type, name, pinned, createdAt, updatedAt, lastAccessedAt',
  2: '++id, type, name, pinned, createdAt, updatedAt, lastAccessedAt, syncId',
  3: '++id, type, name, pinned, createdAt, updatedAt, lastAccessedAt, syncId, scope, projectId',
  4: '++id, type, name, pinned, createdAt, updatedAt, lastAccessedAt, syncId',
} as const;

export type PersistedMemoryRecord = Record<string, unknown>;

export function migrateMemoryV1RecordToV2(
  memory: PersistedMemoryRecord,
  syncId: string,
): PersistedMemoryRecord {
  return { ...memory, syncId };
}

export function migrateMemoryV2RecordToV3(memory: PersistedMemoryRecord): PersistedMemoryRecord {
  const { projectId: _projectId, ...rest } = memory;
  return { ...rest, scope: 'global' };
}

/**
 * v3 → v4 的删除判据：作用域不是 `global` 的记录只服务已删除的项目功能，
 * 留着会作为孤儿数据永久占位。缺省 `scope` 视为 `global`（v2 时代的记录没有这个字段）。
 */
export function shouldDeleteMemoryV3Record(memory: PersistedMemoryRecord): boolean {
  return memory.scope !== undefined && memory.scope !== 'global';
}

/** v3 → v4 的字段剥离：`scope` / `projectId` 两个字段随项目功能一起移除。 */
export function migrateMemoryV3RecordToV4(memory: PersistedMemoryRecord): PersistedMemoryRecord {
  // ⚠️ **必须原地删键** —— 调用方用 `Object.assign` 把返回值合并回原记录，
  // 而 `Object.assign` 只会新增/覆盖、**不会删除**：返回一个不含 `scope` 的新对象
  // 并不能把它从落盘记录里去掉（实测：升级后 `scope` 仍留在行上）。
  delete memory.scope;
  delete memory.projectId;
  return memory;
}
