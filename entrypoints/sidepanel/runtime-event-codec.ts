export function isSidepanelRuntimeEvent<TType extends string>(
  value: unknown,
  types: readonly TType[],
): value is { type: TType } {
  const record = plainRecord(value);
  return record !== null
    && typeof record.type === 'string'
    && types.includes(record.type as TType);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}