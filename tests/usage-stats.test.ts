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
import {
  decodeUsageRecords,
  encodeUsageRecords,
} from '../core/usage/codec';
import { normalizeUsageTurnInput } from '../core/usage/input-codec';
import type { UsageTurnInput, UsageTurnRecord } from '../core/usage/types';

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

/**
 * ⚠️ 窗口必须覆盖**恰好 `rangeDays` 个日历日**，而日历日不是等长的 ——
 * 夏令时前拨日当地一天只有 23 小时。用 `now - n * 86400000` 推进时，
 * 跨过前拨日那一步会落回**前一天的 23:00**，那个日历日整天从窗口里消失，
 * 它名下的记录会被 `summarizeUsage` 当作「不在范围内」丢掉。
 *
 * ⚠️ **必须在 DST 时区下跑** —— 宿主时区是 Asia/Shanghai（无 DST）时这个缺陷
 * 完全不可见，所以这组用例显式改 `process.env.TZ`，跑完恢复。
 */
describe('summarizeUsage across DST transitions', () => {
  const originalTimeZone = process.env.TZ;

  afterEach(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  });

  /**
   * ⚠️⚠️ **必须先证明时区切换真的生效，否则这组用例全是假绿。**
   *
   * 若运行时忽略运行期 `process.env.TZ` 变更（或在首次取时区后就缓存），用例会退化成
   * 宿主时区（本项目是 Asia/Shanghai，无 DST）下跑 —— 而那时 `days` 仍连续、
   * 仍含 `2026-03-08`、`currentStreak` 仍是 4 ⇒ **断言照样全绿，守不住任何东西**
   * （断言的前提与它要证的东西同源，等于自证）。
   *
   * 判据用 `getTimezoneOffset()`：纽约 2026-03-08 已进入夏令时，偏移是 **300**（UTC-5）。
   * 宿主时区是 +480，无 DST 的时区也给不出 300 ⇒ 这条断言能真正区分「切成功 / 没切」。
   */
  function assertNewYorkInEffect(): void {
    expect(
      new Date(2026, 2, 8).getTimezoneOffset(),
      'process.env.TZ 未生效（时区切换失败时这组用例会假绿）',
    ).toBe(300);
  }

  it('keeps the whole calendar-day window across a spring-forward day', () => {
    // America/New_York 2026-03-08 02:00 前拨（当地一天 23 小时）。
    process.env.TZ = 'America/New_York';
    assertNewYorkInEffect();
    const now = new Date(2026, 2, 10, 12).getTime();
    const records = [
      makeRecord({ id: 'before', day: '2026-03-07', totalTokens: 100 }),
      makeRecord({ id: 'spring-forward', day: '2026-03-08', totalTokens: 777 }),
      makeRecord({ id: 'after', day: '2026-03-09', totalTokens: 100 }),
      makeRecord({ id: 'today', day: '2026-03-10', totalTokens: 100 }),
    ];

    const seven = summarizeUsage(records, { rangeDays: 7, now });
    expect(seven.days).toHaveLength(7);
    expect(seven.days.map((day) => day.day)).toContain('2026-03-08');
    expect(seven.totalTokens).toBe(1077);
    expect(seven.activeDays).toBe(4);
    expect(seven.currentStreak).toBe(4);

    const thirty = summarizeUsage(records, { rangeDays: 30, now });
    expect(thirty.days).toHaveLength(30);
    expect(thirty.days.map((day) => day.day)).toContain('2026-03-08');
    expect(thirty.totalTokens).toBe(1077);
  });

  it('keeps the whole calendar-day window across a fall-back day', () => {
    // America/New_York 2026-11-01 回拨（当地一天 25 小时）。
    process.env.TZ = 'America/New_York';
    assertNewYorkInEffect();
    const now = new Date(2026, 10, 3, 12).getTime();
    const records = [
      makeRecord({ id: 'a', day: '2026-10-31', totalTokens: 100 }),
      makeRecord({ id: 'fall-back', day: '2026-11-01', totalTokens: 200 }),
      makeRecord({ id: 'b', day: '2026-11-02', totalTokens: 100 }),
    ];

    const summary = summarizeUsage(records, { rangeDays: 7, now });
    expect(summary.days).toHaveLength(7);
    expect(summary.totalTokens).toBe(400);
    expect(summary.activeDays).toBe(3);
    // 今天（11-03）没有用量 ⇒ 连续天数从末尾数第一步就断。
    expect(summary.currentStreak).toBe(0);
  });

  it('returns strictly consecutive, duplicate-free day keys around a DST change', () => {
    process.env.TZ = 'America/New_York';
    assertNewYorkInEffect();
    const now = new Date(2026, 2, 10, 12).getTime();
    for (const rangeDays of [7, 30] as const) {
      const days = summarizeUsage([], { rangeDays, now }).days.map((day) => day.day);
      expect(new Set(days).size, `rangeDays=${rangeDays}`).toBe(rangeDays);
      // 逐项比对「日历上的次日」，不经过时间戳加法。
      for (let index = 1; index < days.length; index += 1) {
        const [year, month, date] = days[index - 1]!.split('-').map(Number) as [number, number, number];
        const expected = new Date(Date.UTC(year, month - 1, date + 1));
        const pad = (value: number) => String(value).padStart(2, '0');
        expect(days[index], `${days[index - 1]} 的次日`)
          .toBe(`${expected.getUTCFullYear()}-${pad(expected.getUTCMonth() + 1)}-${pad(expected.getUTCDate())}`);
      }
    }
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

describe('usage write/read round trip', () => {
  /**
   * 写入侧（`normalizeUsageTurnInput`）产出的记录，落盘后过的是**读回侧**
   * （`decodeUsageRecords`）的判据。两侧对「什么是合法整数」的分歧，
   * 表现是「写进去了、读不出来」—— 而读回失败会抛 `UsageStorageContractError`
   * 并且**刻意不改写**存储 ⇒ 整份 usage 打不开。
   *
   * ⇒ 这里直接串起来跑，输入挑两侧判据最容易分叉的那几个边界。
   */
  const EDGE_INPUTS: Array<[string, Partial<UsageTurnInput>]> = [
    ['fractional messageCount', { messageCount: 0.4 }],
    ['messageCount above safe range', { messageCount: 2 ** 53 }],
    ['totalTokens above safe range', { totalTokens: 2 ** 53 }],
    ['totalTokens at the huge end', { totalTokens: 1e300 }],
    ['totalTokens fractional', { totalTokens: 0.5 }],
    ['assistantMessageId above safe range', { assistantMessageId: 2 ** 53 }],
    ['assistantMessageId fractional', { assistantMessageId: 1.5 }],
    ['zero totalTokens', { totalTokens: 0 }],
    ['negative tps', { tps: -3 }],
  ];

  for (const [label, override] of EDGE_INPUTS) {
    it(`keeps ${label} readable whenever the write side accepts it`, () => {
      const input: UsageTurnInput = {
        id: `edge-${label}`,
        source: 'glm-web',
        totalTokens: 100,
        tokenSource: 'estimated',
        tps: 10,
        speedSource: 'estimated',
        elapsedMs: 1_000,
        ...override,
      };
      let written: UsageTurnRecord;
      try {
        written = normalizeUsageTurnInput(input);
      } catch {
        // 写入侧直接拒收也是合法结局 —— 只要它**不会**把读回侧收不了的值写进去。
        return;
      }
      // 契约：写侧产出的东西，读回侧必须收。
      expect(() => decodeUsageRecords(encodeUsageRecords([written]))).not.toThrow();
    });
  }

  it('round-trips a plain record unchanged', () => {
    const written = normalizeUsageTurnInput({
      id: 'plain',
      source: 'glm-web',
      totalTokens: 120,
      tokenSource: 'server',
      tps: 30,
      speedSource: 'estimated',
      elapsedMs: 4_000,
      messageCount: 2,
    });
    expect(decodeUsageRecords(encodeUsageRecords([written]))).toEqual([written]);
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
