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

/**
 * 保留错误码的版本 —— 给「期望它被拒」的用例用。
 *
 * ⚠️ `nextCronRun` 遇到非 `cron_no_next_run` 的错误会 throw（那是给「应当成功」的
 * 用例用的守卫）。判「某表达式该被拒」时必须能读出**是哪个**错误码，
 * 否则「因为别的原因被拒」也会让断言通过。
 */
function nextCronRunOrError(
  expression: string,
  timezone: string,
  referenceAt: number,
): { ok: true; value: number | null } | { ok: false; code: string } {
  const result = calculateNextRunAt(cron(expression, timezone), referenceAt, {
    minimumIntervalMinutes: 0,
  });
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, code: result.error.code };
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
  // ⚠️ 原来的 `['15 3 29 2 *', ...]`（闰日）已移出黄金表 —— 它现在被
  // `MAX_CRON_INTERVAL_DAYS` 拒掉（相邻命中间隔 4 年），见下方
  // 「rejects an expression whose consecutive runs are more than a year apart」。
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
    // ⚠️ **闰日表达式现在整条被拒**（相邻命中间隔 4 年 > `MAX_CRON_INTERVAL_DAYS`）。
    // 两条错误码分属两个判据，**都是拒绝**，但成因不同：
    //   ① 下一个闰日**在** 370 天窗口内 ⇒ 先算出下一次，再由稀疏判据拒（`schedule_too_sparse`）；
    //   ② 下一个闰日**在**窗口外 ⇒ `findNextCronRun` 当场报 `cron_no_next_run`，
    //      稀疏判据根本没机会执行（它排在第一次查找之后）。
    // ⚠️ 两者都拒 = 建不出来，所以「建得进、滚不动」那条路从两头都堵上了。
    expect(nextCronRunOrError('0 0 29 2 *', 'UTC', Date.UTC(2028, 0, 1, 0, 0, 0)))
      .toEqual({ ok: false, code: 'schedule_too_sparse' });
    expect(nextCronRunOrError('0 0 29 2 *', 'UTC', Date.UTC(2026, 8, 23, 0, 0, 0)))
      .toEqual({ ok: false, code: 'cron_no_next_run' });
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
      ['0 9/3 * * *', 'UTC'],
      ['0 9-18/3 * * *', 'UTC'],
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

  it('treats "n/step" as "from n up to the field max, stepping by step"', () => {
    // 标准 cron 语义：`n/step` 等价于 `n-max/step`，而不是「只匹配 n」。
    // 早先的实现把终点取成 n、把 step 静默丢掉，`0/5 * * * *` 于是每小时只在 :00 触发。
    const start = Date.UTC(2026, 9, 28, 0, 0, 0);
    expect(collectRuns('0 9/3 * * *', 'UTC', start, 4))
      .toEqual([9, 12, 15, 18].map((hour) => Date.UTC(2026, 9, 28, hour, 0, 0)));
    // 带范围的写法不受影响。
    expect(collectRuns('0 9-18/3 * * *', 'UTC', start, 4))
      .toEqual([9, 12, 15, 18].map((hour) => Date.UTC(2026, 9, 28, hour, 0, 0)));
    // 纯数字仍是单值 —— 别把「没写 /」也当成上界。
    expect(collectRuns('5 * * * *', 'UTC', start, 2))
      .toEqual([Date.UTC(2026, 9, 28, 0, 5), Date.UTC(2026, 9, 28, 1, 5)]);
  });

  it('rejects a token with extra "-" or "/" segments instead of silently dropping them', () => {
    // ⚠️ 解构 `const [a, b] = token.split('-')` 会把多出来的段**静默丢掉**：
    // `1-2-3` 只剩 `1-2`、`1-2/3/4` 只剩 `1-2/3`，两者都返回 ok。
    // 用户以为写了个复杂表达式，实际只生效一部分，界面上没有任何提示。
    for (const expression of [
      '1-2-3 * * * *',
      '1-2-3-4 * * * *',
      '1-2/3/4 * * * *',
      '1/2/3 * * * *',
    ]) {
      const parsed = parseAutomationSchedule(cron(expression));
      expect(parsed.ok, expression).toBe(false);
    }
    // 合法形态不受影响。
    for (const expression of [
      '1-2 * * * *',
      '1-2/3 * * * *',
      '*/5 * * * *',
      '0/5 * * * *',
      '5 * * * *',
      '0,20,40 * * * *',
    ]) {
      expect(parseAutomationSchedule(cron(expression)).ok, expression).toBe(true);
    }
  });

  it('rejects an expression whose consecutive runs are more than a year apart', () => {
    // ⚠️⚠️ **闰日表达式能「建得进、滚不动」** —— 只要下一个闰日落在 370 天窗口内
    // 它就能通过创建校验，但**跑完一次之后重算下一次就扫不到了**：
    // `nextRunAt` 恒为 null ⇒ 每分钟扫描重算一次、失败一次 ⇒ 卡片上「排期无法计算」
    // 的红条常驻，而任务永远不会再跑。
    //
    // ⚠️ 判据按**周期长度**（`MAX_CRON_INTERVAL_DAYS = 366`）而不是按日期形态 ——
    // cron 五字段里间隔 > 一年的情况只有闰日一种，但按周期判将来加秒字段也不会漏。
    for (const referenceAt of [
      Date.UTC(2027, 5, 1),   // 下一个闰日在窗口内 ⇒ 修之前能建
      Date.UTC(2028, 0, 1),   // 同上
    ]) {
      const result = calculateNextRunAt(cron('0 0 29 2 *'), referenceAt);
      expect(result.ok, new Date(referenceAt).toISOString()).toBe(false);
      expect(result.ok ? null : result.error.code).toBe('schedule_too_sparse');
    }

    // 时区无关：闰日在任何时区都拒。
    for (const timezone of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Australia/Sydney']) {
      const result = calculateNextRunAt(cron('0 0 29 2 *', timezone), Date.UTC(2028, 0, 1));
      expect(result.ok, timezone).toBe(false);
    }

    // ⚠️ **「每年一次」必须放行** —— 间隔 365/366 天，正好在上界以内。
    // 这条是反面自检：判据写宽了（比如上限取 365）会误拒它。
    for (const referenceAt of [
      Date.UTC(2026, 9, 28),
      Date.UTC(2027, 5, 1),
      Date.UTC(2028, 0, 1),
    ]) {
      const result = calculateNextRunAt(cron('0 0 1 1 *'), referenceAt);
      expect(result.ok, new Date(referenceAt).toISOString()).toBe(true);
    }

    // 每月 / 每周 / 每天都不受影响。
    for (const expression of ['0 0 1 * *', '0 9 * * 1', '0 9 * * *', '0 0 1 1,7 *']) {
      expect(calculateNextRunAt(cron(expression), Date.UTC(2026, 9, 28)).ok, expression).toBe(true);
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

  it('gives the same verdict regardless of the reference time', () => {
    // ⚠️ 频率是**表达式自身的属性**，不该随「此刻几点」变。这条用例守两个后果：
    // ① **校验不稳定** —— 早先的判据从 referenceAt 起数头两次命中，`0,10 9 * * *`
    //    （09:00 与 09:10 相隔 10 分钟）在 08:00 被拒、在 09:05 被放行；
    // ② **建成后每天只有 10 分钟有效** —— 收尾时用完成时刻重算下一次，
    //    越过 09:10 之后一律判 too_frequent、`nextRunAt` 被打回 null。
    const verdicts = new Map<string, Set<boolean>>();
    const expressions = [
      '0,10 9 * * *',
      '0,10 * * * *',
      '0 9 * * *',
      '*/30 * * * *',
      '5,35 * * * *',
      '* * * * *',
    ];
    // 一天里均匀取样，覆盖「命中前后」与「离命中很远」两类参考点。
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const referenceAt = Date.UTC(2026, 9, 28) + minute * MINUTE_MS;
      for (const expression of expressions) {
        const ok = calculateNextRunAt(cron(expression), referenceAt).ok;
        const seen = verdicts.get(expression) ?? new Set<boolean>();
        seen.add(ok);
        verdicts.set(expression, seen);
      }
    }
    for (const [expression, seen] of verdicts) {
      expect(seen.size, `${expression} 的结论随参考点变化了`).toBe(1);
    }
    // 并且方向要对：过密的拒、正常的放行。
    expect(calculateNextRunAt(cron('0,10 9 * * *'), Date.UTC(2026, 9, 28, 9, 5)).ok).toBe(false);
    expect(calculateNextRunAt(cron('0 9 * * *'), Date.UTC(2026, 9, 28, 9, 5)).ok).toBe(true);
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

/** 从 `start` 起连续取 `count` 次命中。 */
function collectRuns(
  expression: string,
  timezone: string,
  start: number,
  count: number,
): number[] {
  const runs: number[] = [];
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    const next = nextCronRun(expression, timezone, cursor);
    if (next === null) throw new Error(`no run for ${expression} after ${cursor}`);
    runs.push(next);
    cursor = next;
  }
  return runs;
}

/**
 * 逐分钟暴力扫描，仅用于密集表达式的对照。
 *
 * ⚠️⚠️ **它验的是「扫描有没有漏拍」，验不了「`n/step` 的解释对不对」。**
 * 下面 `expand` 里那段 `end = endRaw == null ? (stepPart == null ? start : max) : …`
 * 与生产 `parseCronToken` 是**同一套解释**（被本轮的 `n/step` 修复同步改过）——
 * 两侧同源 ⇒ 生产把 `n/step` 解释错了，这里会跟着错、对照照样绿
 * （**A 与 B 同源，断言恒真**）。
 *
 * ⇒ **`n/step` 的语义由单独用例守**（`treats "n/step" as "from n up to the field max…"`，
 * 直接钉 `0 9/3 * * *` → 9,12,15,18）。别把这条 oracle 当成那个语义的守卫。
 */
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
        // `n/step` 的终点是字段上界（标准 cron 语义），纯数字仍是单值。
        end = endRaw == null
          ? (stepPart == null ? start : max)
          : Number.parseInt(endRaw, 10);
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
