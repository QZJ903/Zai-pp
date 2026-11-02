import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAutomation, resolveAutomationReusableSessionId } from '../core/automation/scheduler';
import { createAutomation, getAutomationById, updateAutomation, updateAutomationRuntime } from '../core/automation/store';
import { createAutomationRunnerFailure } from '../core/automation/messages';
import type { AutomationRunnerRequest, AutomationRunnerResult } from '../core/automation/types';

function createChromeStub() {
  const storage = new Map<string, unknown>();
  return {
    storage,
    chromeStub: {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            for (const [key, storedValue] of Object.entries(value)) storage.set(key, storedValue);
          }),
        },
      },
    },
  };
}

async function createTestAutomation() {
  return createAutomation({
    name: 'Automation',
    prompt: 'Run once.',
    schedule: {
      kind: 'manual',
      expression: null,
      timezone: 'UTC',
      enabled: false,
      minimumIntervalMinutes: 15,
    },
    promptOptions: {
      model: null,
      fixedSession: false,
    },
  });
}

function failureWithSession(
  request: AutomationRunnerRequest,
  chatSessionId: string | null,
  /** 本次运行落在哪个站；默认国际站（与下面断言的 URL 一致）。 */
  siteOrigin: string | null = 'https://chat.z.ai',
): AutomationRunnerResult {
  // 模拟「内容脚本回传 error: 'cancelled'」经 coordinator 定档后的真实形状：
  // code 仍是 `dom_automation_cancelled`（background 拼的），**phase 是 `'cancelled'`**
  // —— `scheduler.completeRun` 现在只认 phase（见那里的说明）。
  return createAutomationRunnerFailure(
    request,
    'dom_automation_cancelled',
    'cancelled',
    'cancelled',
    false,
    Date.now(),
    { externalOutcome: 'ambiguous', retrySafe: false },
    chatSessionId,
    siteOrigin,
  );
}

describe('automation failure persists the live session', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', createChromeStub().chromeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores chatSessionId and sessionUrl when a run fails after the session was created', async () => {
    const automation = await createTestAutomation();
    const executor = vi.fn(async (request: AutomationRunnerRequest) =>
      failureWithSession(request, 'session-created-then-paused'));

    const completed = await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    expect(completed?.status).toBe('cancelled');
    const stored = await getAutomationById(automation.id);
    expect(stored?.zai.chatSessionId).toBe('session-created-then-paused');
    // 会话 URL 必须一起写：侧边栏的「打开会话」按钮判的是 sessionUrl。
    expect(stored?.zai.sessionUrl).toBe('https://chat.z.ai/c/session-created-then-paused');
  });

  it('keeps the previous session when the failure carries no session id', async () => {
    const automation = await createTestAutomation();
    const executor = vi.fn(async (request: AutomationRunnerRequest) =>
      createAutomationRunnerFailure(
        request,
        'dom_automation_busy',
        'busy',
        'tab',
        false,
        Date.now(),
        { externalOutcome: 'ambiguous', retrySafe: false },
        null,
      ));

    const completed = await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    expect(completed?.status).toBe('failed');
    const stored = await getAutomationById(automation.id);
    expect(stored?.zai.chatSessionId).toBeNull();
    expect(stored?.zai.sessionUrl).toBeNull();
  });

  it('falls back to the request session id when no override is supplied', async () => {
    const automation = await createTestAutomation();
    const executor = vi.fn(async (request: AutomationRunnerRequest) =>
      createAutomationRunnerFailure(
        { ...request, chatSessionId: 'request-session' },
        'dom_automation_failed',
        'failed',
        'runner',
        false,
      ));

    const completed = await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    expect(completed?.status).toBe('failed');
    expect(completed?.result?.chatSessionId).toBe('request-session');
  });

  it('keeps the session persisted mid-run when the failure result carries none', async () => {
    const automation = await createTestAutomation();
    // 模拟运行期间 persistAutomationSession 已经把会话写进去了。
    await updateAutomationRuntime(automation.id, {
      zai: {
        chatSessionId: 'persisted-mid-run',
        sessionUrl: 'https://chat.z.ai/c/persisted-mid-run',
        siteOrigin: null,
      },
    });

    const executor = vi.fn(async (request: AutomationRunnerRequest) =>
      createAutomationRunnerFailure(
        request,
        'automation_run_timeout',
        'timed out',
        'runner',
        false,
        Date.now(),
        { timeoutMs: 30_000, externalOutcome: 'ambiguous', retrySafe: false },
        null,
      ));

    const completed = await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    expect(completed?.status).toBe('timeout');
    const stored = await getAutomationById(automation.id);
    expect(stored?.zai.chatSessionId).toBe('persisted-mid-run');
    expect(stored?.zai.sessionUrl).toBe('https://chat.z.ai/c/persisted-mid-run');
  });

  it('repairs a sessionUrl that does not match the stored session id', async () => {
    const automation = await createTestAutomation();
    // 早期版本留下的不一致记录：id 是新会话、url 指向上一次的会话。
    await updateAutomationRuntime(automation.id, {
      zai: {
        chatSessionId: 'new-session',
        sessionUrl: 'https://chat.z.ai/c/old-session',
        siteOrigin: null,
      },
    });

    const executor = vi.fn(async (request: AutomationRunnerRequest) =>
      createAutomationRunnerFailure(
        request,
        'dom_automation_busy',
        'busy',
        'tab',
        false,
        Date.now(),
        { externalOutcome: 'ambiguous', retrySafe: false },
        null,
      ));

    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    const stored = await getAutomationById(automation.id);
    expect(stored?.zai.chatSessionId).toBe('new-session');
    // 必须重写成与 id 一致的 URL，否则「打开会话」会跳到 old-session。
    expect(stored?.zai.sessionUrl).toBe('https://chat.z.ai/c/new-session');
  });
});

/**
 * **成功运行拿不到会话 id 时，不许把记录写坏。**
 *
 * `AutomationRunnerSuccess.chatSessionId` 是可空的（`null` = 本次没拿到：新会话首轮、
 * 内容脚本还没读到 `/c/<id>`）。三种写错的方式都会静默：
 *
 * ① 落成**空串** —— 下一次 `resolveAutomationReusableSessionId` 判「有没有可复用的
 *    会话」用的是 `!== null`，空串会被当成「有值」⇒ `request.siteOrigin` 非 null
 *    ⇒ 协调器跳过「跟当前标签页」的判定，把新对话**开到记录里那一站**。
 * ② 用 `null` **覆盖**记录里已有的会话 —— 用户视角是「固定会话的链接突然没了」。
 * ③ 用 `null` 覆盖已有的 `sessionUrl`，但 `chatSessionId` 留着 ⇒ 有会话却点不开。
 *
 * 所以这里把三条一起钉住：**结果为空时两个字段都保留原值**。
 */
describe('a successful run without a session id keeps the stored session intact', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', createChromeStub().chromeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the stored session id and url instead of blanking them', async () => {
    const automation = await createTestAutomation();
    await updateAutomationRuntime(automation.id, {
      zai: {
        chatSessionId: 'c-old',
        sessionUrl: 'https://chat.z.ai/c/c-old',
        siteOrigin: 'https://chat.z.ai',
      },
    });

    const executor = vi.fn(async () => ({
      ok: true as const,
      chatSessionId: null,
      sessionUrl: null,
      siteOrigin: 'https://chat.z.ai',
      assistantText: 'done',
      completedAt: Date.now(),
    }));

    const completed = await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    expect(completed?.status).toBe('succeeded');
    const stored = await getAutomationById(automation.id);
    expect(stored?.zai.chatSessionId).toBe('c-old');
    expect(stored?.zai.sessionUrl).toBe('https://chat.z.ai/c/c-old');
  });

  it('stores null (not an empty string) when the first run never gets a session', async () => {
    const automation = await createTestAutomation();
    const executor = vi.fn(async () => ({
      ok: true as const,
      chatSessionId: null,
      sessionUrl: null,
      siteOrigin: 'https://chat.z.ai',
      assistantText: 'done',
      completedAt: Date.now(),
    }));

    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor,
    });

    const stored = await getAutomationById(automation.id);
    // ⚠️ **必须是 `null` 而不是 `''`** —— 空串在「有没有可用会话」的判据上算「有值」。
    expect(stored?.zai.chatSessionId).toBeNull();
    expect(stored?.zai.sessionUrl).toBeNull();
  });

  it('never hands a blank reusable session to the next run', () => {
    // 判据落在 `resolveAutomationReusableSessionId` 上：它是「本次运行去哪个站」的
    // 唯一判定入口，空串必须归成 `null`（否则下一次新对话被送去记录站）。
    expect(resolveAutomationReusableSessionId({
      promptOptions: { model: null, fixedSession: true },
      zai: { chatSessionId: '', sessionUrl: null, siteOrigin: 'https://chat.z.ai' },
    })).toBeNull();
    expect(resolveAutomationReusableSessionId({
      promptOptions: { model: null, fixedSession: true },
      zai: { chatSessionId: 'c-1', sessionUrl: null, siteOrigin: 'https://chat.z.ai' },
    })).toBe('c-1');
    // 没开固定会话时恒 null（与实现同口径，防止将来被「顺手放宽」）
    expect(resolveAutomationReusableSessionId({
      promptOptions: { model: null, fixedSession: false },
      zai: { chatSessionId: 'c-1', sessionUrl: null, siteOrigin: 'https://chat.z.ai' },
    })).toBeNull();
  });

  /**
   * **历史遗留的空串要能自愈。**
   *
   * `resolveAutomationReusableSessionId` 那侧已确立「空串不是会话 id」，但收尾那边
   * 原本直接写 `result.chatSessionId ?? automation.zai.chatSessionId` ⇒ 记录里是 `''`
   * 时 `'' ?? ''` 仍是 `''`，那条脏值**永远不会被冲掉**（判定侧靠 `|| null` 兜住了，
   * 所以没有功能损伤，但它一直是脏的）。
   *
   * 判据：升级后**第一次成功运行**就把它归一成 `null` —— 不需要写迁移层。
   */
  it('normalises a legacy empty session id to null on the next successful run', async () => {
    const automation = await createTestAutomation();
    await updateAutomationRuntime(automation.id, {
      zai: { chatSessionId: '', sessionUrl: null, siteOrigin: 'https://chat.z.ai' },
    });

    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor: async () => ({
        ok: true as const,
        chatSessionId: null,
        sessionUrl: null,
        siteOrigin: 'https://chat.z.ai',
        assistantText: 'done',
        completedAt: Date.now(),
      }),
    });

    const stored = await getAutomationById(automation.id);
    expect(stored?.zai.chatSessionId, '空串应当归一成 null').toBeNull();
  });
});

/**
 * **`request.chatSessionId` 只承载「本次要复用的会话」，不是「记录里留着什么」。**
 *
 * 两者在两个格子上分叉：**非固定会话**（本轮是新对话）与 **固定会话但记录里是空串**。
 * 抄记录原值的后果不止是「表达不一致」，**会写坏数据**：
 *
 * ```
 * 非固定会话 + 记录留着上一轮的 c-old
 *   → 本轮新对话，运行中 persistAutomationSession 写进 c-new
 *   → 失败收尾时 createAutomationRunnerFailure 没有 sessionIdOverride ⇒ 回落 request.chatSessionId
 *   → 拿到 c-old ⇒ 收尾把记录写回 c-old
 * ```
 *
 * 用户看到的是「会话那一格退回上一轮的对话」。
 */
describe('request.chatSessionId carries only the session this run reuses', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', createChromeStub().chromeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is null for a non-fixed session even when the record still has one', async () => {
    const automation = await createTestAutomation();
    await updateAutomationRuntime(automation.id, {
      zai: { chatSessionId: 'c-old', sessionUrl: 'https://chat.z.ai/c/c-old', siteOrigin: 'https://chat.z.ai' },
    });

    const observed: AutomationRunnerRequest[] = [];
    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor: async (request) => {
        observed.push(request);
        return {
          ok: true as const,
          chatSessionId: 'c-new',
          sessionUrl: null,
          siteOrigin: 'https://chat.z.ai',
          assistantText: 'done',
          completedAt: Date.now(),
        };
      },
    });

    // ⚠️ 这一档是「新对话」⇒ 请求里不该带任何会话 id，与 `siteOrigin === null` 同口径。
    expect(observed[0]?.chatSessionId).toBeNull();
    expect(observed[0]?.siteOrigin).toBeNull();
  });

  it('is the recorded session for a fixed session (that is what the switch means)', async () => {
    const automation = await createTestAutomation();
    await updateAutomation(automation.id, { promptOptions: { model: null, fixedSession: true } });
    await updateAutomationRuntime(automation.id, {
      zai: { chatSessionId: 'c-keep', sessionUrl: 'https://chat.z.ai/c/c-keep', siteOrigin: 'https://chat.z.ai' },
    });

    const observed: AutomationRunnerRequest[] = [];
    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor: async (request) => {
        observed.push(request);
        return {
          ok: true as const,
          chatSessionId: 'c-keep',
          sessionUrl: null,
          siteOrigin: 'https://chat.z.ai',
          assistantText: 'done',
          completedAt: Date.now(),
        };
      },
    });

    // ⚠️ **固定会话就是「在上一个会话继续跑」** —— 这一档必须是记录里那个 id，
    // 而且站点提示也要跟着给（两者同源）。
    expect(observed[0]?.chatSessionId).toBe('c-keep');
    expect(observed[0]?.siteOrigin).toBe('https://chat.z.ai');
  });

  it('does not let a stale recorded session overwrite one created during the run', async () => {
    const automation = await createTestAutomation();
    await updateAutomationRuntime(automation.id, {
      zai: { chatSessionId: 'c-old', sessionUrl: 'https://chat.z.ai/c/c-old', siteOrigin: 'https://chat.z.ai' },
    });

    await runAutomation({
      automationId: automation.id,
      trigger: 'manual',
      scheduledFor: null,
      timeoutMs: 30_000,
      executor: async (request) => {
        // 运行期间：新对话建出来了，`persistAutomationSession` 写进 c-new。
        await updateAutomationRuntime(automation.id, {
          zai: { chatSessionId: 'c-new', sessionUrl: 'https://chat.z.ai/c/c-new', siteOrigin: 'https://chat.z.ai' },
        });
        // 这一轮失败，且内容脚本**没有**回传会话 id（不传 `sessionIdOverride`）。
        return createAutomationRunnerFailure(
          request,
          'dom_automation_x',
          'x',
          'runner',
          false,
          Date.now(),
          { externalOutcome: 'ambiguous', retrySafe: false },
        );
      },
    });

    // ⚠️ 抄记录原值时这里会退回 `c-old` —— 那才是这条用例要守的东西。
    expect((await getAutomationById(automation.id))?.zai.chatSessionId).toBe('c-new');
  });
});
