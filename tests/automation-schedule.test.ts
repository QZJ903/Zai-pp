import { describe, expect, it } from 'vitest';
import {
  calculateNextRunAt,
  parseAutomationSchedule,
  validateAutomationSchedule,
} from '../core/automation/schedule';
import type { AutomationSchedule } from '../core/automation/types';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function cron(expression: string, timezone = 'UTC'): AutomationSchedule {
  return { kind: 'cron', expression, timezone, enabled: true, minimumIntervalMinutes: 0 };
}

function rrule(expression: string, timezone = 'UTC'): AutomationSchedule {
  return { kind: 'rrule', expression, timezone, enabled: true, minimumIntervalMinutes: 0 };
}

/** 取 cron 的下次触发时刻；窗口内无命中返回 null（与错误分支同语义）。 */
function nextCronRun(expression: string, timezone: string, referenceAt: number): number | null {
  const result = calculateNextRunAt(cron(expression, timezone), referenceAt, {
    minimumIntervalMinutes: 0,
  });
  if (result.ok) return result.value;
  if (result.error.code === 'cron_no_next_run') return null;
  throw new Error(result.error.message);
}

/** 取某时刻在该时区的当地日期（`YYYY-MM-DD`）。 */
function localDayKey(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp));
}

/**
 * 求「`timestamp` 当地日期的次日」（`YYYY-MM-DD`）。
 *
 * ⚠️ **不能写成 `localDayKey(timestamp + DAY_MS)`**：回拨日当地一天有 25 小时，
 * `+ 24h` 之后仍落在同一天，期望值会算错、把正确的实现判成失败。
 * 正确做法是先把当地日期解析出来、在**日历上加一天**，不经过时间戳。
 */
function nextLocalDayKey(timestamp: number, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
  );
  const next = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/**
 * 三个起点：普通工作日下午、跨年附近、闰年年初。
 * 覆盖月末 / 年初 / 闰日 / 夏令时切换前后。
 */
const REFERENCES = [1788208440000, 1805277000000, 1830398400000] as const;

/**
 * 黄金表：由**独立实现**（Python `zoneinfo`，逐分钟扫描）算出的期望值。
 * 与下面的实现共享同一套 cron 语义，但不共享任何代码 —— 用来交叉验证。
 */
const GOLDEN: Array<[string, string, Array<number | null>]> = [
  ['0,20,40 * * * *', 'UTC', [1788208800000, 1805277600000, 1830399600000]],
  ['0 9 * * *', 'UTC', [1788253200000, 1805360400000, 1830416400000]],
  ['0 9 * * *', 'Asia/Shanghai', [1788224400000, 1805331600000, 1830474000000]],
  ['*/30 9-18 * * 1-5', 'Asia/Shanghai', [1788224400000, 1805277600000, 1830474000000]],
  ['0 0 1 * *', 'UTC', [1788220800000, 1806537600000, 1832976000000]],
  ['0 0 1 * *', 'Asia/Shanghai', [1790784000000, 1806508800000, 1832947200000]],
  ['0 0 1 1 *', 'UTC', [1798761600000, 1830297600000, 1861920000000]],
  ['15 3 29 2 *', 'UTC', [null, 1835406900000, 1835406900000]],
  ['0 0 1 1,7 *', 'UTC', [1798761600000, 1814400000000, 1846022400000]],
  ['59 23 31 12 *', 'Asia/Shanghai', [1798732740000, 1830268740000, 1861891140000]],
  ['0 12 * * 0', 'America/New_York', [1788710400000, 1805644800000, 1830445200000]],
  ['30 2 * * *', 'America/New_York', [1788244200000, 1805351400000, 1830411000000]],
  ['0 0 13 * 5', 'UTC', [1788480000000, 1805414400000, 1830816000000]],
  ['0 6 ? * 3', 'UTC', [1788328800000, 1805868000000, 1830664800000]],
  ['5,35 * * * *', 'UTC', [1788208500000, 1805277900000, 1830398700000]],
  ['0 0-23/6 * * *', 'UTC', [1788220800000, 1805284800000, 1830405600000]],
];

/**
 * 夏令时边界：美国 2026-11-01 回拨、2027-03-14 前拨；欧洲 2026-10-25 回拨。
 * 起点都取切换前一天中午。
 */
const DST_REFERENCES = [1793448000000, 1804939200000, 1792843200000] as const;

const DST_GOLDEN: Array<[string, string, Array<number | null>]> = [
  ['30 2 * * *', 'America/New_York', [1793518200000, 1805092200000, 1792909800000]],
  ['0 0 * * *', 'America/New_York', [1793505600000, 1805000400000, 1792900800000]],
  ['0 12 * * *', 'America/New_York', [1793462400000, 1804957200000, 1792857600000]],
  ['0 9 * * *', 'Europe/Berlin', [1793520000000, 1805011200000, 1792915200000]],
];

describe('cron next-run calculation', () => {
  it('matches an independently computed golden table', () => {
    for (const [expression, timezone, expected] of GOLDEN) {
      expected.forEach((value, index) => {
        const referenceAt = REFERENCES[index]!;
        expect(
          nextCronRun(expression, timezone, referenceAt),
          `${expression} @ ${timezone} from ${new Date(referenceAt).toISOString()}`,
        ).toBe(value);
      });
    }
  });

  it('matches an independently computed golden table across DST transitions', () => {
    for (const [expression, timezone, expected] of DST_GOLDEN) {
      expected.forEach((value, index) => {
        const referenceAt = DST_REFERENCES[index]!;
        expect(
          nextCronRun(expression, timezone, referenceAt),
          `${expression} @ ${timezone} from ${new Date(referenceAt).toISOString()}`,
        ).toBe(value);
      });
    }
  });

  it('skips across a DST day without losing or duplicating a run', () => {
    // 前拨当天 02:30 不存在 → 跳过当天；回拨当天 01:30 出现两次 → 取第一次。
    const springForwardDay = Date.UTC(2027, 2, 14, 0, 0, 0);
    const next = nextCronRun('30 2 * * *', 'America/New_York', springForwardDay);
    expect(next).not.toBeNull();
    // 结果必须严格落在起点之后，且当地时刻确实是 02:30。
    expect(next!).toBeGreaterThan(springForwardDay);
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date(next!));
    const parts = Object.fromEntries(local.map((part) => [part.type, part.value]));
    expect(`${parts.hour}:${parts.minute}`).toBe('02:30');
  });

  it('never skips a calendar day while jumping across DST', () => {
    // 「整日跳过」是加速路径。若它算错，表现是**整天丢失**。
    //
    // ⚠️ 起点必须落在**凌晨窗口内**（当地 00:00–04:00）才是有效的对照 ——
    // 早先这条用的起点换算到当地正好是 08:00 / 14:00，**永远落在故障窗口之外**，
    // 于是它一直通过、给了假信心。这里改成**逐分钟**扫切换日。
    for (const timezone of ['America/New_York', 'Europe/Berlin', 'Asia/Shanghai']) {
      // 两个切换日 + 前后各一天，起点逐分钟扫（每 17 分钟取一个）。
      for (const day of [Date.UTC(2026, 9, 24), Date.UTC(2026, 9, 25), Date.UTC(2026, 9, 26),
        Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 2)]) {
        for (let minute = 0; minute < 24 * 60; minute += 17) {
          const cursor = day + minute * MINUTE_MS;
          const next = nextCronRun('0 0 * * *', timezone, cursor);
          expect(next, `${timezone} @ ${new Date(cursor).toISOString()}`).not.toBeNull();
          expect(next!).toBeGreaterThan(cursor);

          // 下一个命中的当地日期，必须恰好是**起点当地日期的次日**。
          // ⚠️ 不能拿 `cursor + 24h` 当「次日」：回拨日有 25 小时，+24h 仍落在同一天。
          const label = `${timezone} @ ${new Date(cursor).toISOString()}`;
          expect(localDayKey(next!, timezone), label).toBe(nextLocalDayKey(cursor, timezone));
        }
      }
    }
  });

  it('does not miss the second occurrence of a repeated local hour on fall-back days', () => {
    // 回拨日当地某小时出现**两次**，而「当天已过最后一个可命中分钟」这条快路径按
    // **当地墙钟**判断 —— 墙钟在回拨日不单调，第一次过后判据就为真。
    // 这里断言「第二次命中」不会被跳掉。
    const cases: Array<[string, string, number, number]> = [
      // Berlin 回拨日：当地 02:30 出现两次（00:30Z 与 01:30Z）
      ['30 2 * * *', 'Europe/Berlin', Date.UTC(2026, 9, 25, 0, 32), Date.UTC(2026, 9, 25, 1, 30)],
      ['30 2 * * *', 'Europe/Berlin', Date.UTC(2026, 9, 25, 0, 45), Date.UTC(2026, 9, 25, 1, 30)],
      // NY 回拨日：当地 01:30 出现两次（05:30Z 与 06:30Z）
      ['30 1 * * *', 'America/New_York', Date.UTC(2026, 10, 1, 5, 33), Date.UTC(2026, 10, 1, 6, 30)],
      ['0 1 * * *', 'America/New_York', Date.UTC(2026, 10, 1, 5, 8), Date.UTC(2026, 10, 1, 6, 0)],
    ];
    for (const [expression, timezone, from, expected] of cases) {
      expect(nextCronRun(expression, timezone, from),
        `${expression} @ ${timezone} from ${new Date(from).toISOString()}`).toBe(expected);
    }
  });

  it('never skips a day on fall-back days when the start is inside the repeated hour', () => {
    // 起点从各自窗口开头逐分钟扫，**每条腿都必须跨过自己的切换时刻**，
    // 否则第二次出现的那一小时根本没被扫到（就是这条测试最初的模样）。
    // ⚠️ 三地窗口起点换算到当地并不同一：Berlin/NY 落在当地 00:00，
    // Santiago 落在**前一日** 21:00 —— 别按「当地 00:00 起」去推窗口长度。
    // 240 分钟是三条腿里最长的那条（Berlin/Santiago 的切换时刻都在起点后 180 分钟）所需。
    const cases: Array<[string, string, number]> = [
      ['0 0 * * *', 'Europe/Berlin', Date.UTC(2026, 9, 24, 22, 0)],
      ['0 0 * * *', 'America/New_York', Date.UTC(2026, 10, 1, 4, 0)],
      ['0 0 * * *', 'America/Santiago', Date.UTC(2027, 3, 4, 0, 0)],
    ];
    for (const [expression, timezone, windowStart] of cases) {
      for (let i = 0; i < 240; i += 1) {
        const cursor = windowStart + i * MINUTE_MS;
        const next = nextCronRun(expression, timezone, cursor);
        const label = `${timezone} @ ${new Date(cursor).toISOString()}`;
        expect(localDayKey(next!, timezone), label).toBe(nextLocalDayKey(cursor, timezone));
      }
    }
  });

  it('keeps the same-day fast path exact at the last matching minute', () => {
    // 起点正好落在当天最后一个可命中分钟之后 → 必须跳到下一天，而不是回退。
    expect(nextCronRun('0 9 * * *', 'UTC', Date.UTC(2026, 8, 23, 9, 1, 0)))
      .toBe(Date.UTC(2026, 8, 24, 9, 0, 0));
    // 起点正好是命中分钟 → 取下一次（严格大于起点）。
    expect(nextCronRun('0 9 * * *', 'UTC', Date.UTC(2026, 8, 23, 9, 0, 0)))
      .toBe(Date.UTC(2026, 8, 24, 9, 0, 0));
    // 起点在当天最后一个命中分钟之前 → 命中当天。
    expect(nextCronRun('0 9 * * *', 'UTC', Date.UTC(2026, 8, 23, 8, 59, 0)))
      .toBe(Date.UTC(2026, 8, 23, 9, 0, 0));
  });

  it('skips whole non-matching days without losing a match', () => {
    const start = Date.UTC(2026, 8, 23, 12, 0, 0);
    expect(nextCronRun('0 0 1 * *', 'UTC', start)).toBe(Date.UTC(2026, 9, 1, 0, 0, 0));
    expect(nextCronRun('0 0 1 1 *', 'UTC', start)).toBe(Date.UTC(2027, 0, 1, 0, 0, 0));
  });

  it('handles the leap day that only exists every four years', () => {
    // 起点在 2028 年之前不久 → 能扫到 2028-02-29。
    expect(nextCronRun('0 0 29 2 *', 'UTC', Date.UTC(2028, 0, 1, 0, 0, 0)))
      .toBe(Date.UTC(2028, 1, 29, 0, 0, 0));
    // 起点离下一个闰日超过 370 天 → 如实报「窗口内无命中」，而不是硬等。
    expect(nextCronRun('0 0 29 2 *', 'UTC', Date.UTC(2026, 8, 23, 0, 0, 0))).toBeNull();
  });

  it('agrees with a brute-force scan on the dense expressions', () => {
    // 稀疏表达式的暴力对照要跑几十万次 Intl（改造前正是因此卡住 UI），
    // 这里只用「当天/次日必命中」的密集表达式做逐分钟对照。
    const cases: Array<[string, string]> = [
      ['0,20,40 * * * *', 'UTC'],
      ['5,35 * * * *', 'UTC'],
      ['0 9 * * *', 'Asia/Shanghai'],
      ['*/30 9-18 * * 1-5', 'Asia/Shanghai'],
      ['0 0-23/6 * * *', 'UTC'],
    ];
    for (const [expression, timezone] of cases) {
      for (const referenceAt of REFERENCES) {
        expect(
          nextCronRun(expression, timezone, referenceAt),
          `${expression} @ ${timezone} from ${new Date(referenceAt).toISOString()}`,
        ).toBe(bruteForceNextCronRun(expression, timezone, referenceAt));
      }
    }
  });

  it('reports no run when the expression cannot match inside the lookahead window', () => {
    const result = calculateNextRunAt(cron('0 0 30 2 *'), Date.UTC(2026, 0, 1), {
      minimumIntervalMinutes: 0,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a timezone the runtime does not know', () => {
    expect(parseAutomationSchedule(cron('0 9 * * *', 'Mars/Olympus')).ok).toBe(false);
  });
});

describe('rrule next-run calculation', () => {
  it('adds the interval to the reference time for each supported frequency', () => {
    const start = Date.UTC(2026, 8, 23, 12, 0, 0);
    expect(calculateNextRunAt(rrule('FREQ=MINUTELY;INTERVAL=30'), start, {
      minimumIntervalMinutes: 0,
    })).toEqual({ ok: true, value: start + 30 * MINUTE_MS });
    expect(calculateNextRunAt(rrule('RRULE:FREQ=HOURLY;INTERVAL=2'), start, {
      minimumIntervalMinutes: 0,
    })).toEqual({ ok: true, value: start + 120 * MINUTE_MS });
    expect(calculateNextRunAt(rrule('FREQ=DAILY;INTERVAL=1'), start, {
      minimumIntervalMinutes: 0,
    })).toEqual({ ok: true, value: start + 24 * 60 * MINUTE_MS });
  });

  it('rejects frequencies outside MINUTELY/HOURLY/DAILY and unknown parts', () => {
    expect(parseAutomationSchedule(rrule('FREQ=WEEKLY;INTERVAL=1')).ok).toBe(false);
    expect(parseAutomationSchedule(rrule('FREQ=DAILY;BYHOUR=9')).ok).toBe(false);
    expect(parseAutomationSchedule(rrule('FREQ=DAILY;INTERVAL=0')).ok).toBe(false);
  });
});

describe('minimum interval guard', () => {
  it('enforces the 15-minute floor for both kinds', () => {
    const referenceAt = Date.UTC(2026, 8, 23, 12, 0, 0);
    expect(calculateNextRunAt(rrule('FREQ=MINUTELY;INTERVAL=5'), referenceAt).ok).toBe(false);
    expect(calculateNextRunAt(cron('* * * * *'), referenceAt).ok).toBe(false);
    expect(calculateNextRunAt(cron('*/30 * * * *'), referenceAt).ok).toBe(true);
    expect(calculateNextRunAt(rrule('FREQ=MINUTELY;INTERVAL=15'), referenceAt).ok).toBe(true);
  });

  it('validates a schedule end to end', () => {
    expect(validateAutomationSchedule(cron('0 9 * * *'), Date.UTC(2026, 8, 23)).ok).toBe(true);
    expect(validateAutomationSchedule(cron('bad'), Date.UTC(2026, 8, 23)).ok).toBe(false);
    expect(validateAutomationSchedule({
      kind: 'manual',
      expression: null,
      timezone: 'UTC',
      enabled: false,
      minimumIntervalMinutes: 0,
    }, Date.UTC(2026, 8, 23)).ok).toBe(true);
  });
});

/** 逐分钟暴力扫描（改造前的判定逻辑），仅用于密集表达式的对照。 */
function bruteForceNextCronRun(
  expression: string,
  timezone: string,
  referenceAt: number,
  maxDays = 370,
): number | null {
  const fields = expression.trim().split(/\s+/);
  const [minuteField, hourField, domField, monthField, dowField] = fields as [
    string, string, string, string, string,
  ];

  const expand = (
    field: string,
    min: number,
    max: number,
    normalize: (value: number) => number = (value) => value,
  ): { values: Set<number>; wildcard: boolean } => {
    const values = new Set<number>();
    for (const token of field.split(',')) {
      const [rangePart, stepPart] = token.split('/');
      const step = stepPart == null ? 1 : Number.parseInt(stepPart, 10);
      let start: number;
      let end: number;
      if (rangePart === '*' || rangePart === '?') {
        start = min;
        end = max;
      } else {
        const [startRaw, endRaw] = (rangePart as string).split('-');
        start = Number.parseInt(startRaw as string, 10);
        end = endRaw == null ? start : Number.parseInt(endRaw, 10);
      }
      for (let value = start; value <= end; value += step) values.add(normalize(value));
    }
    return { values, wildcard: field === '*' || field === '?' };
  };

  const minute = expand(minuteField, 0, 59);
  const hour = expand(hourField, 0, 23);
  const dayOfMonth = expand(domField, 1, 31);
  const month = expand(monthField, 1, 12);
  const dayOfWeek = expand(dowField, 0, 7, (value) => (value === 7 ? 0 : value));

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  const weekdayToNumber = (value: string | undefined): number => {
    switch (value) {
      case 'Sun': return 0;
      case 'Mon': return 1;
      case 'Tue': return 2;
      case 'Wed': return 3;
      case 'Thu': return 4;
      case 'Fri': return 5;
      case 'Sat': return 6;
      default: return 0;
    }
  };

  const endAt = referenceAt + maxDays * DAY_MS;
  let candidate = Math.floor(referenceAt / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  while (candidate <= endAt) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]),
    );
    const dayOfMonthMatches = dayOfMonth.values.has(Number(parts.day));
    const dayOfWeekMatches = dayOfWeek.values.has(weekdayToNumber(parts.weekday));
    const dayMatches =
      !dayOfMonth.wildcard && !dayOfWeek.wildcard
        ? dayOfMonthMatches || dayOfWeekMatches
        : dayOfMonthMatches && dayOfWeekMatches;
    if (
      minute.values.has(Number(parts.minute))
      && hour.values.has(Number(parts.hour))
      && month.values.has(Number(parts.month))
      && dayMatches
    ) {
      return candidate;
    }
    candidate += MINUTE_MS;
  }
  return null;
}
