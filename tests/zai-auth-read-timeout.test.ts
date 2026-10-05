import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_READ_TIMEOUT_MS,
  ZAI_AUTH_STORAGE_KEY,
  loadZaiAuthFromStorage,
} from '../core/zai/auth';
import { createZaiConversationTitleResolver } from '../core/zai/conversation-title';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

/**
 * 「读登录态」这条腿的上界。
 *
 * ⚠️ **要守的不是网络腿** —— `conversation-title.ts` 的 `AbortSignal.timeout`
 * 只盖住 `fetch`，而它前面还有一次 `chrome.storage.local.get`。扩展上下文半死时
 * 那个 promise **不是 reject，而是永不 settle**：外层 `try/catch` 接不到它，
 * 于是 `fetchTitle` 卡在第一个 await，`inFlight` 的 `finally` 永远走不到。
 *
 * 后果**不可自愈**：面板的 `backfillAttemptedIds` 与解析器的 `inFlight` 一起被占住，
 * 之后每次触发都落「已尝试」跳过分支。所以这里的断言是「上界内返回 + 槽位释放 +
 * 下一次还能重试」，不是「不报错」。
 */

const AUTH = {
  token: 'tok-from-storage',
  userId: 'u1',
  feVersion: null,
  deviceId: null,
  capturedAt: 1,
  expiresAt: null,
};

let getImpl: () => Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.useFakeTimers();
  getImpl = async () => ({ [ZAI_AUTH_STORAGE_KEY]: AUTH });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(() => getImpl()),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 让竞速里的定时器有机会触发，同时不真的等 5 秒。 */
async function advancePastTimeout() {
  await vi.advanceTimersByTimeAsync(AUTH_READ_TIMEOUT_MS + 1);
}

describe('loadZaiAuthFromStorage timeout', () => {
  it('reads the record as before when no timeout is passed', async () => {
    await expect(loadZaiAuthFromStorage()).resolves.toMatchObject({ token: 'tok-from-storage' });
  });

  it('still resolves with the record when storage answers in time', async () => {
    await expect(loadZaiAuthFromStorage(AUTH_READ_TIMEOUT_MS))
      .resolves.toMatchObject({ token: 'tok-from-storage' });
  });

  it('gives up instead of hanging when storage never settles', async () => {
    // 半死的扩展上下文：promise 永不落地（既不 resolve 也不 reject）。
    getImpl = () => new Promise<Record<string, unknown>>(() => {});

    const pending = loadZaiAuthFromStorage(AUTH_READ_TIMEOUT_MS);
    await advancePastTimeout();

    await expect(pending).resolves.toBeNull();
  });

  it('still resolves to null when storage rejects', async () => {
    // ⚠️ 重构前这里是 try/catch、现在是 `.catch(() => null)` —— 行为必须一致：
    // 读失败与读超时一样，都是「当没有」，不能把异常抛给调用方。
    // 传超时与不传超时两条路都要保住这条语义（不传那条没有 finally 兜底）。
    getImpl = async () => { throw new Error('storage unavailable'); };

    await expect(loadZaiAuthFromStorage(AUTH_READ_TIMEOUT_MS)).resolves.toBeNull();
    await expect(loadZaiAuthFromStorage()).resolves.toBeNull();
  });

  it('does not impose a deadline when the caller opts out', async () => {
    // ⚠️ 写路径（`mergeZaiAuthFromCapture`）刻意不传超时：它要读旧记录再覆盖写，
    // 「读不到当没有」会把 userId / feVersion / deviceId / expiresAt 一起写成 null。
    getImpl = () => new Promise<Record<string, unknown>>(() => {});

    let settled = false;
    void loadZaiAuthFromStorage().then(() => { settled = true; });
    await advancePastTimeout();

    expect(settled).toBe(false);
  });
});

describe('conversation title resolver with a stalled auth read', () => {
  it('releases the in-flight slot so the next attempt can still request', async () => {
    let attempts = 0;
    const resolver = createZaiConversationTitleResolver({
      // 第一次读 token 永不落地；超时后这次调用应放弃并释放槽位。
      // 形状与真实注入点一致（`zai.content.ts` 的 `loadToken`）。
      loadToken: async () => {
        attempts += 1;
        if (attempts === 1) {
          return (await loadZaiAuthFromStorage(AUTH_READ_TIMEOUT_MS))?.token ?? null;
        }
        return 'tok-later';
      },
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: 'c1', user_id: 'u1', title: '真实会话名', chat: { id: 'c1' } }),
      })),
    });

    getImpl = () => new Promise<Record<string, unknown>>(() => {});

    const first = resolver.resolve('c1');
    await advancePastTimeout();
    await expect(first).resolves.toBeNull();

    // 槽位已释放 ⇒ 第二次触发能真的走到网络，而不是被 in-flight 合流吃掉。
    await expect(resolver.resolve('c1')).resolves.toBe('真实会话名');
  });
});

/**
 * 上面那组测的是「机制在」，这一组测「**接线在**」。
 *
 * ⚠️ 分开的理由：把注入点改回不传超时（`loadZaiAuthFromStorage()`），
 * 上面六条**全都还是绿的** —— 它们自己传了参数，测的是函数的行为，不是生产代码有没有用它。
 * 而「函数支持上界」与「两个注入点真的传了」是两件事，后者才是这次修复的目的。
 */
describe('auth read deadline wiring', () => {
  function callArgsOfLoadZaiAuth(file: string): (t.Node | null | undefined)[][] {
    const program = parseTypeScriptSource(file, readFileSync(file, 'utf8'));
    const calls: t.CallExpression[] = [];
    walkSourceAst(program, (node) => {
      if (!t.isCallExpression(node)) return;
      const callee = node.callee;
      if (t.isIdentifier(callee) && callee.name === 'loadZaiAuthFromStorage') calls.push(node);
    });
    return calls.map((call) => call.arguments);
  }

  function isDeadlineConstant(node: t.Node | null | undefined): boolean {
    return t.isIdentifier(node) && node.name === 'AUTH_READ_TIMEOUT_MS';
  }

  it('passes the deadline at both token-reading call sites', () => {
    // 两个有 inFlight 槽位的调用方：内容脚本的标题解析器、后台的模型清单抓取器。
    // 少传任何一个，那一处的槽位就还会被永久占住。
    for (const file of ['entrypoints/zai.content.ts', 'entrypoints/background.ts']) {
      const calls = callArgsOfLoadZaiAuth(file);
      expect(calls.length, `${file} should read the auth record`).toBeGreaterThan(0);
      for (const args of calls) {
        expect(isDeadlineConstant(args[0]), `${file} must pass AUTH_READ_TIMEOUT_MS`).toBe(true);
      }
    }
  });

  it('keeps the merge-and-write path without a deadline', () => {
    // ⚠️ 写路径**必须不传**：它读旧记录再覆盖写，读到 null 会把 userId / feVersion /
    // deviceId / expiresAt 一起写成 null。这条与上面那条是一对，改一边要改另一边。
    const calls = callArgsOfLoadZaiAuth('core/zai/auth.ts');
    expect(calls.length).toBe(1);
    expect(calls[0]).toHaveLength(0);
  });
});
