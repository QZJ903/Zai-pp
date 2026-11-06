export function unwrapRuntimeResponse<T>(response: unknown, missingMessage: string): T {
  if (isRuntimeFailure(response)) throwRuntimeFailure(response, missingMessage);
  if (response === null || response === undefined) throw new Error(missingMessage);
  return response as T;
}

export function decodeRuntimeResponse<T>(
  response: unknown,
  decode: (value: unknown) => T,
  missingMessage: string,
): T {
  if (response === undefined) throw new Error(missingMessage);
  try {
    return decode(response);
  } catch (decodeError) {
    if (isRuntimeFailure(response)) throwRuntimeFailure(response, missingMessage);
    throw decodeError;
  }
}

export function isRuntimeFailure(response: unknown): response is { ok: false; error?: unknown } {
  return Boolean(
    response &&
    typeof response === 'object' &&
    (response as { ok?: unknown }).ok === false,
  );
}

/**
 * 后台以 `{ ok: false, error }` 表示领域失败（**不是抛错**）。
 * 统一成异常，让调用点能用 try/catch 而不是各自校验形状 —— 漏校验的表现是
 * 「失败被当成功、界面只是重绘一次、没有任何提示」。
 */
export class RuntimeCommandError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RuntimeCommandError';
    this.code = code;
  }
}

/**
 * 从任意抛出物里取一句话。
 *
 * ⚠️ **`undefined` / `null` 表示「没有话可说」，返回空串** —— 不能落到 `String(value)`
 * 那条路上：它俩会变成字面量 `'undefined'` / `'null'`，长得像个错误码，
 * 最后渲染成「操作失败（undefined）」。空串由调用方的兜底文案接住。
 */
export function getRuntimeErrorMessage(error: unknown): string {
  if (error === undefined || error === null) return '';
  return error instanceof Error ? error.message : String(error);
}

function throwRuntimeFailure(
  response: { ok: false; error?: unknown },
  missingMessage: string,
): never {
  throw new Error(response.error ? String(response.error) : missingMessage);
}
