import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getUsageModelKey,
  getUsageModelLabel,
  summarizeUsage,
  toLocalDayKey,
} from '../core/usage/stats';
import {
  getUsageSummary,
  recordUsageTurn,
} from '../core/usage/store';
import type { UsageTurnRecord } from '../core/usage/types';

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('summarizeUsage', () => {
  it('aggregates recent tokens, sessions, streak and model distribution', () => {
    const now = new Date(2026, 5, 18, 12).getTime();
    const yesterday = now - DAY_MS;
    const outsideRange = now - 8 * DAY_MS;

    const summary = summarizeUsage([
      makeRecord({ id: 'old', recordedAt: outsideRange, totalTokens: 999 }),
      makeRecord({ id: 'flash', recordedAt: yesterday, chatSessionId: 'session-a', modelType: 'x-preview-l', totalTokens: 100 }),
      makeRecord({ id: 'flagship', recordedAt: now, chatSessionId: 'session-b', modelType: 'glm-5.3', totalTokens: 240 }),
    ], { rangeDays: 7, now });

    expect(summary.days).toHaveLength(7);
    expect(summary.heatmap).toHaveLength(7);
    expect(summary.totalTokens).toBe(340);
    expect(summary.sessionCount).toBe(2);
    expect(summary.messageCount).toBe(4);
    expect(summary.turnCount).toBe(2);
    expect(summary.activeDays).toBe(2);
    expect(summary.currentStreak).toBe(2);
    expect(summary.serverTokenRecordCount).toBe(2);
    // 落库的是模型 id，标签由调用方查清单补（见下方 getUsageModelLabel 的用例）。
    expect(summary.mostUsedModel?.modelLabel).toBe('glm-5.3');
    expect(summary.modelUsage.map((model) => model.modelLabel)).toEqual([
      'glm-5.3',
      'x-preview-l',
    ]);
  });

  it('breaks the current streak when today has no usage', () => {
    const now = new Date(2026, 5, 18, 12).getTime();
    const summary = summarizeUsage([
      makeRecord({ id: 'yesterday', recordedAt: now - DAY_MS, totalTokens: 100 }),
    ], { rangeDays: 7, now });

    expect(summary.activeDays).toBe(1);
    expect(summary.currentStreak).toBe(0);
  });
});

describe('usage store', () => {
  it('upserts later server metrics for the same request id', async () => {
    const { chromeStub } = createChromeStub();
    vi.stubGlobal('chrome', chromeStub);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 18, 12));

    await recordUsageTurn({
      id: 'req-1',
      source: 'glm-web',
      totalTokens: 12,
      tokenSource: 'estimated',
      tps: 4,
      speedSource: 'estimated',
      elapsedMs: 3000,
    });
    await recordUsageTurn({
      id: 'req-1',
      source: 'glm-web',
      totalTokens: 3302,
      tokenSource: 'server',
      tps: 1061.7,
      speedSource: 'server',
      elapsedMs: 3110,
      modelType: 'glm-5.2',
    });

    const summary = await getUsageSummary(30);
    expect(summary.turnCount).toBe(1);
    expect(summary.totalTokens).toBe(3302);
    expect(summary.serverTokenRecordCount).toBe(1);
    expect(summary.mostUsedModel?.modelLabel).toBe('glm-5.2');
  });
});

describe('getUsageModelLabel', () => {
  it('falls back to a readable name only when the record carries no model', () => {
    expect(getUsageModelLabel(null)).toBe('GLM Chat');
    expect(getUsageModelLabel(undefined)).toBe('GLM Chat');
    expect(getUsageModelLabel('')).toBe('GLM Chat');
    expect(getUsageModelLabel('   ')).toBe('GLM Chat');
  });

  it('passes a real model id through untouched', () => {
    // ⚠️ 本项目落库的是 `body.model` 的真 id（`x-preview-l` / `glm-5.3` / `glm-4.7`），
    // 不认上游 DeepSeek 的 `default` / `expert` / `vision` 三档 —— 那三档在本项目
    // 不可能产生（全史 grep `model_type` 零命中）。友好名由调用方查 `GET_ZAI_MODELS`
    // 清单补（`createZaiModelLabelLookup`），不在这里硬编码。
    expect(getUsageModelLabel('x-preview-l')).toBe('x-preview-l');
    expect(getUsageModelLabel('glm-5.3')).toBe('glm-5.3');
    expect(getUsageModelLabel('glm-4.7')).toBe('glm-4.7');
    expect(getUsageModelLabel('  glm-5.2  ')).toBe('glm-5.2');
  });

  it('does not translate the upstream-only model types', () => {
    // 反向断言：上游那三档被删掉之后，它们**不再**被翻译成 `GLM Chat/Expert/Vision`，
    // 而是像任何其它不认识的 id 一样原样透出。这是有意与上游不同（见函数注释）。
    expect(getUsageModelLabel('default')).toBe('default');
    expect(getUsageModelLabel('expert')).toBe('expert');
    expect(getUsageModelLabel('vision')).toBe('vision');
  });
});

describe('getUsageModelKey', () => {
  it('lowercases a real id and buckets an absent model under a stable key', () => {
    expect(getUsageModelKey('GLM-5-Turbo')).toBe('glm-5-turbo');
    expect(getUsageModelKey('x-preview-l')).toBe('x-preview-l');
    expect(getUsageModelKey(null)).toBe('glm-default');
    expect(getUsageModelKey('  ')).toBe('glm-default');
  });
});

function makeRecord(overrides: Partial<UsageTurnRecord>): UsageTurnRecord {
  const recordedAt = overrides.recordedAt ?? Date.now();
  return {
    id: overrides.id ?? 'record',
    recordedAt,
    day: overrides.day ?? toLocalDayKey(recordedAt),
    source: overrides.source ?? 'glm-web',
    chatSessionId: overrides.chatSessionId ?? 'session',
    assistantMessageId: overrides.assistantMessageId ?? 1,
    modelType: overrides.modelType ?? null,
    totalTokens: overrides.totalTokens ?? 0,
    tokenSource: overrides.tokenSource ?? 'server',
    tps: overrides.tps ?? 10,
    speedSource: overrides.speedSource ?? 'server',
    elapsedMs: overrides.elapsedMs ?? 1000,
    messageCount: overrides.messageCount ?? 2,
  };
}

function createChromeStub() {
  const storage = new Map<string, unknown>();
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
