import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * **`service.ts` 里每一条 `sendCommand` 都必须把 signal 传下去。**
 *
 * ⚠️⚠️ 这条守的是 P1-1 的修法本身。`BrowserControlService` 是模块级单例，
 * 取消信号曾经是个 `activeSignal` 实例字段 —— 两个 z.ai 标签并发调 `browser_*` 时，
 * 后进的那个会覆盖先进那个挂上的 signal，A 的后续命令读到 B 的、B 取消后 A 被误判
 * `browser_control_aborted`（且还原是链式的，越错越乱）。
 * 修法是把 signal 改成逐层传的参数。
 *
 * ⚠️ **为什么必须用源码断言**：`sendCommand` 的第三参**是可选的**，
 * 漏传 `tsc` 不报（实测：把 `Page.navigate` 那一跳改成 `undefined`，`tsc` 仍然 0 错、
 * `browser-control.test.ts` 41 条全绿）。而任何**行为**用例都抓不到它 —— 要抓得
 * 造两个并发 `execute` 且让其中一个在中间插入，那种用例又慢又不稳。
 *
 * ⚠️ **判据是「每一条 `sendCommand` 调用都带了第三参」**，不是「文件里出现过 `signal`」。
 */
const SERVICE_SOURCE = 'core/browser-control/service.ts';

/** 把注释剥掉 —— 注释里就有 `sendCommand` 这个词（本文件头与字段说明里各一处）。 */
function readCodeOnly(): string {
  return readFileSync(SERVICE_SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 收集每一处 `sendCommand(...)` 调用的实参文本。
 *
 * ⚠️ 手写括号配对而不是整段正则：实参里有嵌套的对象字面量（`{ url }` / `{ entryId }`），
 * 正则数不清逗号。
 */
function collectSendCommandCalls(code: string): string[] {
  const calls: string[] = [];
  const marker = '.sendCommand';
  let index = code.indexOf(marker);
  while (index >= 0) {
    // ⚠️ **`(` 必须紧跟其后** —— `isSupported()` 里有个
    // `readOptionalChromeApi(() => chromeApi?.debugger?.sendCommand)` 的**能力探测**，
    // 那不是调用；不判这一下会从它后面那个 `(` 开始配对，扫出一段无关代码。
    let cursor = index + marker.length;
    while (code[cursor] === ' ' || code[cursor] === '\n') cursor += 1;
    if (code[cursor] !== '(') {
      index = code.indexOf(marker, index + marker.length);
      continue;
    }
    const start = cursor + 1;
    let depth = 1;
    cursor += 1;
    while (cursor < code.length && depth > 0) {
      const char = code[cursor];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      if (depth === 0) break;
      cursor += 1;
    }
    calls.push(code.slice(start, cursor));
    index = code.indexOf(marker, cursor);
  }
  return calls;
}

/** 顶层逗号切分（跳过括号 / 方括号 / 花括号内部与字符串内部）。 */
function splitTopLevelArguments(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] as string;
    if (quote !== null) {
      current += char;
      if (char === '\\') { current += raw[i + 1] ?? ''; i += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') { quote = char; current += char; continue; }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

describe('browser control service passes the abort signal explicitly', () => {
  it('does not keep a module-level signal field anymore', () => {
    // 修法的另一半：字段必须删掉，否则「显式传参」与「实例字段」会并存、互相打脸。
    const code = readCodeOnly();
    expect(code).not.toMatch(/this\.activeSignal/);
    expect(code, '`activeSignal` 字段声明必须删掉').not.toMatch(/private\s+activeSignal\s*:/);
  });

  it('gives every sendCommand call the signal as its third argument', () => {
    const calls = collectSendCommandCalls(readCodeOnly());
    // 反面自检：一处都找不到说明扫描逻辑失效（那时下面那条恒真）。
    expect(calls.length, '应当能扫到多处 sendCommand 调用').toBeGreaterThan(10);

    const missing = calls
      .filter((raw) => {
        const args = splitTopLevelArguments(raw);
        return args.length < 3 || args[2] === 'undefined';
      });
    expect(
      missing,
      '这些 sendCommand 调用没把 signal 传下去 —— 漏传 tsc 不报，只能靠这条守',
    ).toEqual([]);
  });
});
