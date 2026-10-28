export const MEMORY_V1_RECORD = {
  id: 7,
  type: 'topic',
  name: 'Memory schema contract',
  content: 'Preserve this historical memory.',
  description: 'Historical v1 record',
  tags: ['compatibility'],
  pinned: false,
  createdAt: 100,
  updatedAt: 110,
  accessCount: 2,
  lastAccessedAt: 120,
} as const;

export const MEMORY_V2_RECORD = {
  ...MEMORY_V1_RECORD,
  syncId: '00000000-0000-4000-8000-000000000007',
} as const;

/** v3 历史形状：带 `scope`（项目功能已移除，但它仍是已发布的落盘形态）。 */
export const MEMORY_V3_RECORD = {
  ...MEMORY_V2_RECORD,
  scope: 'global',
} as const;

/** v3 里属于项目作用域的记录 —— 升到 v4 时**整条删除**。 */
export const MEMORY_V3_PROJECT_RECORD = {
  ...MEMORY_V2_RECORD,
  id: 8,
  syncId: '00000000-0000-4000-8000-000000000008',
  scope: 'project',
  projectId: 'project-v2',
} as const;

/** v4 形状：`scope` / `projectId` 已随项目功能移除。 */
export const MEMORY_V4_RECORD = {
  ...MEMORY_V2_RECORD,
} as const;

export const MEMORY_V1_ADDITIVE_RECORD = {
  ...MEMORY_V1_RECORD,
  futureRecordField: { source: 'v1', preserve: true },
} as const;

export const MEMORY_V2_ADDITIVE_RECORD = {
  ...MEMORY_V2_RECORD,
  futureRecordField: { source: 'v2', preserve: true },
} as const;

export const MEMORY_V3_PROJECT_ADDITIVE_RECORD = {
  ...MEMORY_V3_PROJECT_RECORD,
  futureRecordField: { source: 'v3', preserve: true },
} as const;

export const MEMORY_IMPORT_PREVIEW_RECORD = {
  type: 'reference',
  name: 'Preview-style memory',
  content: 'A preview result has no persisted identity or timestamps yet.',
  description: '',
  tags: ['preview'],
  pinned: false,
} as const;

export const MEMORY_HISTORICAL_EXPORT_RECORD = {
  ...MEMORY_V4_RECORD,
  id: 41,
  syncId: '00000000-0000-4000-8000-000000000041',
  name: 'Historical exported memory',
  description: '',
  createdAt: 410,
  updatedAt: 420,
  accessCount: 4,
  lastAccessedAt: 430,
} as const;

/**
 * 一条**当前 schema 解不开**的原始记录 —— 用于守「损坏态下所有读写都失败、原样保留」。
 *
 * ⚠️ 坏在哪一格要选**当前 schema 仍然校验**的字段：项目功能删除后 `scope` 已被忽略，
 * 拿它当损坏触发点会让这条记录变成合法记录（整组断言静默失效）。
 */
export const MEMORY_CORRUPT_RAW_RECORD = {
  ...MEMORY_V4_RECORD,
  id: 91,
  syncId: '00000000-0000-4000-8000-000000000091',
  type: 'future-type',
  recoveryOnlyField: { preserve: true },
} as const;

export const MEMORY_BOUNDED_GAPS = [
  {
    name: 'sync rollback restores raw rows but IndexedDB does not rewind its hidden auto-increment generator',
    currentBehavior: 'next-memory-id-may-skip-after-rollback',
    disposition: 'bounded-out-of-scope-no-second-allocator',
    target: 'preserve-released-auto-increment-and-allow-id-gaps',
  },
] as const;
