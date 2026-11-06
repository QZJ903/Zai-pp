/**
 * Bounded in-memory diagnostic log buffer.
 *
 * The extension keeps no durable log store by design; this buffer retains the
 * most recent operational events (tool starts, authorization denials, tool
 * results, transport failures) so the user can export a compact diagnostic
 * payload without exposing secrets. Entries are never written to disk and are
 * cleared when the worker restarts.
 */

export type DiagnosticLogLevel = 'info' | 'warn' | 'error';

export interface DiagnosticLogEntry {
  ts: number;
  level: DiagnosticLogLevel;
  source: string;
  message: string;
  /** Short context (never raw payloads or credentials). */
  details?: string;
}

export interface DiagnosticLogBuffer {
  record(entry: Omit<DiagnosticLogEntry, 'ts'>): void;
  snapshot(): readonly DiagnosticLogEntry[];
  clear(): void;
}

const DEFAULT_MAX_ENTRIES = 1000;

/**
 * 文本预算。
 *
 * ⚠️ **单位是「UTF-16 码元数」，不是字节** —— 量它的是 `JSON.stringify(entry).length`：
 * 中文算 1、emoji 算 2，而字节分别是 3 与 4。这份缓冲只在内存里、不落盘、不跨边界，
 * 所以按字符量就够了；真要按字节会在这里多一次 `TextEncoder` 编码（热路径）。
 */
const DEFAULT_MAX_TEXT_UNITS = 512 * 1024;

export function createDiagnosticLogBuffer(
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxTextUnits = DEFAULT_MAX_TEXT_UNITS,
): DiagnosticLogBuffer {
  let entries: DiagnosticLogEntry[] = [];
  let totalTextUnits = 0;

  const entryTextUnits = (entry: DiagnosticLogEntry): number =>
    JSON.stringify(entry).length;

  const evict = (): void => {
    while (entries.length > 0 && (
      entries.length > maxEntries || totalTextUnits > maxTextUnits
    )) {
      const removed = entries.shift();
      if (removed) totalTextUnits -= entryTextUnits(removed);
    }
  };

  return {
    record(entry) {
      const stamped: DiagnosticLogEntry = { ...entry, ts: Date.now() };
      entries.push(stamped);
      totalTextUnits += entryTextUnits(stamped);
      evict();
    },
    snapshot() {
      return [...entries];
    },
    clear() {
      entries = [];
      totalTextUnits = 0;
    },
  };
}

/** Process-wide buffer used by the background tool runtime. */
export const diagnosticLogBuffer = createDiagnosticLogBuffer();
