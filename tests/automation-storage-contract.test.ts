import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOMATION_STORAGE_KEY,
  AutomationStorageContractError,
  decodeAutomationStorageState,
} from '../core/automation/storage-codec';
import {
  createAutomation,
  getAllAutomations,
  setAutomationStatus,
} from '../core/automation/store';
import type { Automation, AutomationCreateInput, AutomationRun } from '../core/automation/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('automation storage contract', () => {
  it('accepts a record that predates fixedSession while keeping error.retryable strict', async () => {
    // `fixedSession` 是后加字段 ⇒ 缺省视为 false。
    const rawAutomation = makeAutomation();
    delete (rawAutomation.promptOptions as { fixedSession?: boolean }).fixedSession;

    const decoded = decodeAutomationStorageState({
      version: 1,
      automations: [rawAutomation],
      runs: [],
    });
    expect(decoded.automations[0].promptOptions.fixedSession).toBe(false);

    // `schedule.enabled` 缺省时按 `kind` 兜底（两者在写入侧是派生关系）——
    // 取 `false` 会让一条 `kind: 'cron'` 的任务**永不排期**，且看不出异常。
    const withoutEnabled = makeAutomation();
    withoutEnabled.schedule = {
      ...withoutEnabled.schedule,
      kind: 'cron',
      expression: '0 * * * *',
    };
    delete (withoutEnabled.schedule as { enabled?: boolean }).enabled;
    expect(decodeAutomationStorageState({
      version: 1,
      automations: [withoutEnabled],
      runs: [],
    }).automations[0].schedule.enabled).toBe(true);

    const manualWithoutEnabled = makeAutomation();
    delete (manualWithoutEnabled.schedule as { enabled?: boolean }).enabled;
    expect(decodeAutomationStorageState({
      version: 1,
      automations: [manualWithoutEnabled],
      runs: [],
    }).automations[0].schedule.enabled).toBe(false);

    // ⚠️ 而「给了个非布尔值」仍然必须判 corrupt —— 宽容只覆盖「缺省」这一档。
    const badEnabled = makeAutomation();
    (badEnabled.schedule as { enabled: unknown }).enabled = 'yes';
    expect(() => decodeAutomationStorageState({
      version: 1,
      automations: [badEnabled],
      runs: [],
    })).toThrow(AutomationStorageContractError);

    // `error.retryable` 也一直必填 ⇒ 缺了必须判 corrupt。
    const withoutRetryable = makeRun({
      status: 'failed',
      result: { ok: false, chatSessionId: null, siteOrigin: null, error: { code: 'x', message: 'y', phase: 'runner', at: 1 }, completedAt: 2 } as never,
    });
    delete ((withoutRetryable.result as { error: { retryable?: boolean } }).error).retryable;
    expect(() => decodeAutomationStorageState({
      version: 1,
      automations: [],
      runs: [withoutRetryable],
    })).toThrow(AutomationStorageContractError);
  });

  it('treats only a missing key as empty and performs no eager write', async () => {
    const { chromeStub } = createChromeStub();
    vi.stubGlobal('chrome', chromeStub);

    await expect(getAllAutomations()).resolves.toEqual([]);
    expect(chromeStub.storage.local.set).not.toHaveBeenCalled();
  });

  it('projects released aliases while preserving additive fields', () => {
    const requestedAt = 1_000_000;
    const rawAutomation = {
      ...makeAutomation(),
      zai: undefined,
      additiveAutomationField: { retained: true },
    };
    delete rawAutomation.zai;
    const decoded = decodeAutomationStorageState({
      version: 1,
      additiveRootField: 'retained',
      automations: [rawAutomation],
      runs: [makeRun({
        status: 'succeeded',
        request: {
          runId: 'run-1',
          automationId: 'auto-1',
          prompt: 'Run',
          trigger: 'manual',
          chatSessionId: null,
          // 上游遗留字段：本项目已删，解码器必须**容忍但不读取**（旧记录里可能还带着）。
          parentMessageId: '42',
          promptOptions: makeAutomation().promptOptions,
          requestedAt,
        } as never,
        result: {
          ok: true,
          chatSessionId: 'chat-1',
          sessionUrl: null,
          // 同上：已删字段，容忍不报错。
          parentMessageId: '',
          assistantMessageId: '',
          history: { chatSessionId: 'chat-1', messageCount: 2, verifiedAt: requestedAt + 10 },
          assistantText: 'done',
          completedAt: requestedAt + 10,
        } as never,
        completedAt: requestedAt + 10,
      })],
    });

    expect(decoded.additiveRootField).toBe('retained');
    expect((decoded.automations[0] as Automation & { additiveAutomationField: unknown }).additiveAutomationField)
      .toEqual({ retained: true });
    expect(decoded.automations[0].zai).toEqual({
      chatSessionId: null,
      sessionUrl: null,
      // ⚠️ **`zai` 整块缺失时的新字段也要投影成 null**（旧记录没有它）——
      // `createEmptyZaiSession()` 与 `decodeZaiSession()` 两条路要同形，
      // 否则「有 zai 字段」与「没有」的旧记录解出来形状不同，下游得处理两种缺省。
      siteOrigin: null,
    });
    // 遗留的 deadlineAt 别名仍投影（这个别名还在用）。
    expect(decoded.runs[0].request).toMatchObject({
      deadlineAt: requestedAt + 180_000,
    });
    // 已删字段不再被校验/投影为类型化字段 —— 旧记录里的值原样透传（`...value`），
    // 解码不报错即可（容忍不读取）。
    expect(decoded.runs[0].result).toMatchObject({ chatSessionId: 'chat-1', assistantText: 'done' });
  });

  it('preserves root and record additions through an authorized mutation', async () => {
    const original = {
      version: 1,
      additiveRootField: { retained: true },
      automations: [{ ...makeAutomation(), additiveAutomationField: 'retained' }],
      runs: [],
    };
    const { storage, chromeStub } = createChromeStub({ [AUTOMATION_STORAGE_KEY]: original });
    vi.stubGlobal('chrome', chromeStub);

    await setAutomationStatus('auto-1', 'paused');

    expect(storage.get(AUTOMATION_STORAGE_KEY)).toMatchObject({
      version: 1,
      additiveRootField: { retained: true },
      automations: [{
        id: 'auto-1',
        status: 'paused',
        additiveAutomationField: 'retained',
      }],
    });
  });

  it.each([
    ['future root', { version: 2, automations: [], runs: [] }, 'automation_storage_version_unsupported'],
    ['future record', {
      version: 1,
      automations: [{ ...makeAutomation(), version: 2 }],
      runs: [],
    }, 'automation_storage_version_unsupported'],
    ['missing version', { automations: [], runs: [] }, 'automation_storage_corrupt'],
    ['corrupt rows', { version: 1, automations: [{ id: 'broken' }], runs: [] }, 'automation_storage_corrupt'],
    ['duplicate ids', {
      version: 1,
      automations: [makeAutomation(), makeAutomation()],
      runs: [],
    }, 'automation_storage_corrupt'],
  ])('rejects %s without overwriting the original value', async (_label, original, expectedCode) => {
    const { storage, chromeStub } = createChromeStub({ [AUTOMATION_STORAGE_KEY]: original });
    vi.stubGlobal('chrome', chromeStub);

    const read = getAllAutomations();
    await expect(read).rejects.toMatchObject({
      name: AutomationStorageContractError.name,
      code: expectedCode,
    });
    await expect(createAutomation(makeCreateInput('new'))).rejects.toMatchObject({ code: expectedCode });
    expect(chromeStub.storage.local.set).not.toHaveBeenCalled();
    expect(storage.get(AUTOMATION_STORAGE_KEY)).toBe(original);
  });

  it('accepts historical orphan runs created by the pre-serialization writer race', () => {
    const run = makeRun();

    expect(decodeAutomationStorageState({
      version: 1,
      automations: [],
      runs: [run],
    }).runs).toEqual([run]);
  });

  it('serializes concurrent mutations and reads the exact state after module restart', async () => {
    const { storage, chromeStub } = createChromeStub();
    vi.stubGlobal('chrome', chromeStub);

    const created = await Promise.all([
      createAutomation(makeCreateInput('first')),
      createAutomation(makeCreateInput('second')),
    ]);
    expect(new Set(created.map((automation) => automation.id)).size).toBe(2);
    expect((storage.get(AUTOMATION_STORAGE_KEY) as { automations: Automation[] }).automations)
      .toHaveLength(2);

    const writesBeforeRestart = chromeStub.storage.local.set.mock.calls.length;
    vi.resetModules();
    const restartedStore = await import('../core/automation/store');
    const afterRestart = await restartedStore.getAllAutomations();

    expect(afterRestart.map((automation) => automation.id).sort())
      .toEqual(created.map((automation) => automation.id).sort());
    expect(chromeStub.storage.local.set).toHaveBeenCalledTimes(writesBeforeRestart);
  });
});

function makeAutomation(): Automation {
  return {
    id: 'auto-1',
    name: 'Automation',
    prompt: 'Run safely.',
    status: 'active',
    schedule: {
      kind: 'manual',
      expression: null,
      timezone: 'UTC',
      enabled: false,
      minimumIntervalMinutes: 0,
    },
    promptOptions: {
      model: null,
      fixedSession: false,
    },
    zai: {
      chatSessionId: null,
      sessionUrl: null,
      siteOrigin: null,
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    version: 1,
  };
}

function makeCreateInput(name: string): AutomationCreateInput {
  const automation = makeAutomation();
  return {
    name,
    prompt: automation.prompt,
    schedule: automation.schedule,
    promptOptions: automation.promptOptions,
  };
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    trigger: 'manual',
    status: 'running',
    scheduledFor: null,
    attempt: 1,
    request: null,
    result: null,
    error: null,
    createdAt: 1_000_000,
    startedAt: 1_000_000,
    completedAt: null,
    updatedAt: 1_000_000,
    ...overrides,
  };
}

function createChromeStub(initial: Record<string, unknown> = {}) {
  const storage = new Map<string, unknown>(Object.entries(initial));
  return {
    storage,
    chromeStub: {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
          set: vi.fn(async (values: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(values)) storage.set(key, value);
          }),
          remove: vi.fn(async (key: string) => {
            storage.delete(key);
          }),
        },
      },
    },
  };
}
