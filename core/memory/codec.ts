import type { Memory, MemoryType, NewMemory } from '../types';

const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'topic', 'reference'];

export function decodePersistedMemoryRecord(
  value: unknown,
  path = 'memory',
): Memory {
  const object = objectValue(value, path);
  const id = positiveSafeInteger(object.id, `${path}.id`);
  return {
    ...decodeStoredMemory(object, path),
    id,
  };
}

export function decodeStoredMemory(
  value: unknown,
  path = 'memory',
): Omit<Memory, 'id'> {
  const object = objectValue(value, path);
  // `scope` / `projectId` 是已退役字段：老记录里可能还带着，读时直接丢弃
  // （它们只服务已删除的项目功能）。
  const { id: _id, scope: _scope, projectId: _projectId, ...additiveFields } = object;
  return {
    ...additiveFields,
    syncId: nonEmptyString(object.syncId, `${path}.syncId`),
    type: enumValue(object.type, MEMORY_TYPES, `${path}.type`),
    name: nonEmptyString(object.name, `${path}.name`),
    content: nonEmptyString(object.content, `${path}.content`),
    description: stringValue(object.description, `${path}.description`),
    tags: stringArray(object.tags, `${path}.tags`),
    pinned: booleanValue(object.pinned, `${path}.pinned`),
    createdAt: finiteNumber(object.createdAt, `${path}.createdAt`),
    updatedAt: finiteNumber(object.updatedAt, `${path}.updatedAt`),
    accessCount: finiteNumber(object.accessCount, `${path}.accessCount`),
    lastAccessedAt: finiteNumber(object.lastAccessedAt, `${path}.lastAccessedAt`),
  } as Omit<Memory, 'id'>;
}

export function decodeImportedMemory(
  value: unknown,
  path = 'memory',
): NewMemory {
  const object = objectValue(value, path);
  return {
    syncId: object.syncId === undefined
      ? undefined
      : nonEmptyString(object.syncId, `${path}.syncId`),
    type: enumValue(object.type, MEMORY_TYPES, `${path}.type`),
    name: nonEmptyString(object.name, `${path}.name`),
    content: nonEmptyString(object.content, `${path}.content`),
    description: stringValue(object.description, `${path}.description`),
    tags: stringArray(object.tags, `${path}.tags`),
    pinned: booleanValue(object.pinned, `${path}.pinned`),
  };
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${path} must be a string array`);
  }
  return [...value];
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${path} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}
