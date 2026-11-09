import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBanner, useConfirm } from '../entrypoints/sidepanel/components/settings/primitives';
import { looksLikeErrorCode } from '../core/messaging/error-code';
import { getRuntimeErrorMessage, formatRuntimeError } from '../entrypoints/sidepanel/runtime-response';

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('confirm() that gets superseded', () => {
  /**
   * 第二次 `confirm()` 会把 state 整个覆盖掉。若还沿用旧实现，第一个 Promise 的
   * resolver 就此丢失、那个 `await confirm(...)` 永远挂着，调用方 await 之后的清理
   * （清 loading、删 sourceActions 条目）也就永远不跑。
   */
  it(' settles the superseded call instead of leaving it pending', async () => {
    const answers: Array<Promise<boolean>> = [];
    function Harness() {
      const { confirm, node } = useConfirm();
      const opened = React.useRef(false);
      React.useEffect(() => {
        if (opened.current) return;
        opened.current = true;
        answers.push(confirm({ title: 'a', message: 'a', confirmLabel: 'ok', cancelLabel: 'no' }));
        answers.push(confirm({ title: 'b', message: 'b', confirmLabel: 'ok', cancelLabel: 'no' }));
      });
      return node;
    }
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness));
    });

    expect(answers).toHaveLength(2);
    // 第一个以「取消」收尾，而不是永远挂着。
    await expect(answers[0]).resolves.toBe(false);
    // 第二个仍在等用户回答。
    const second = await Promise.race([
      answers[1].then(() => 'settled'),
      Promise.resolve('pending'),
    ]);
    expect(second).toBe('pending');
  });

  it('settles a pending confirm on unmount', async () => {
    const answers: Array<Promise<boolean>> = [];
    function Harness() {
      const { confirm, node } = useConfirm();
      const opened = React.useRef(false);
      React.useEffect(() => {
        if (opened.current) return;
        opened.current = true;
        answers.push(confirm({ title: 'a', message: 'a', confirmLabel: 'ok', cancelLabel: 'no' }));
      });
      return node;
    }
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness));
    });
    await act(async () => { root?.unmount(); root = null; });

    await expect(answers[0]).resolves.toBe(false);
  });
});

describe('useBanner timer lifecycle', () => {
  it('clears its dismiss timer on unmount', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    let show: ((tone: 'success', text: string) => void) | null = null;

    function Harness() {
      const banner = useBanner();
      show = banner.show;
      return banner.node;
    }
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness));
    });
    await act(async () => { show?.('success', 'done'); });
    expect(clearSpy).not.toHaveBeenCalled();

    await act(async () => { root?.unmount(); root = null; });
    expect(clearSpy).toHaveBeenCalled();
  });
});

describe('error message projection', () => {
  it('treats a missing error as "nothing to say", not as a code', () => {
    // `String(undefined)` / `String(null)` 长得像错误码，照原样走会渲染成
    // 「操作失败（undefined）」。
    expect(getRuntimeErrorMessage(undefined)).toBe('');
    expect(getRuntimeErrorMessage(null)).toBe('');
    expect(looksLikeErrorCode('undefined')).toBe(false);
    expect(looksLikeErrorCode('null')).toBe(false);
    // 真实单码仍然要认。
    expect(looksLikeErrorCode('busy')).toBe(true);
  });

  it('formats the three documented branches', () => {
    const t = ((key: string, params?: { code?: string }) => (
      params?.code ? `<${key}:${params.code}>` : `<${key}>`
    )) as Parameters<typeof formatRuntimeError>[1];

    // ① 裸码 ⇒ 套外壳
    expect(formatRuntimeError(new Error('busy'), t)).toBe('<common.operationFailedWithCode:busy>');
    // ② 自然语言 ⇒ 原样
    expect(formatRuntimeError(new Error('Automation run exceeded 300 seconds.'), t))
      .toBe('Automation run exceeded 300 seconds.');
    // ③ bare ⇒ 只给码
    expect(formatRuntimeError(new Error('busy'), t, { bare: true })).toBe('busy');
    // ④ 缺失 ⇒ 空串（由调用方的兜底文案接住），绝不能是 'undefined'
    expect(formatRuntimeError(undefined, t)).toBe('');
    expect(formatRuntimeError(null, t)).toBe('');
  });
});

describe('single source for the plus icon', () => {
  /**
   * 这条只能做源码级断言：把内联路径换回常量，**渲染结果逐字节相同**，
   * 任何行为用例都区分不出来。所以守的是「别再手抄回去」。
   */
  it('keeps the plus glyph in constants.ts only', () => {
    const offenders: string[] = [];
    const visit = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { visit(path); continue; }
        if (!/\.tsx?$/.test(name)) continue;
        if (path.endsWith(join('sidepanel', 'constants.ts'))) continue;
        if (readFileSync(path, 'utf8').includes('M12 4v16m8-8H4')) offenders.push(path);
      }
    };
    visit('entrypoints/sidepanel');
    expect(offenders).toEqual([]);
  });
});
