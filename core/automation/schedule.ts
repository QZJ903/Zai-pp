import type { AutomationSchedule } from './types';

export const DEFAULT_MINIMUM_INTERVAL_MINUTES = 15;
export const MAX_CRON_LOOKAHEAD_DAYS = 370;

/**
 * 相邻两次命中允许的**最大间隔**（天）。
 *
 * ⚠️⚠️ **超过它的表达式一律拒建** —— 判据不是「某个日期形态」，而是周期长度：
 * cron 五字段里相邻命中间隔大于一年的情况**只有闰日一种**
 * （`0 0 29 2 *`，4 年一次；其余最稀是 `0 0 1 1 *` 的 365 天）。
 *
 * **为什么必须拒**：这类表达式能在 `MAX_CRON_LOOKAHEAD_DAYS = 370` 的窗口内
 * 建出来（只要下一个闰日落在一年内），但**跑完一次之后重算下一次就扫不到了**
 * ⇒ `calculateNextRunAt` 返回 `cron_no_next_run` ⇒ `nextRunAt` 恒为 null
 * ⇒ 每分钟的扫描都会重算一次、失败一次，卡片上「排期无法计算」的红条**常驻**，
 * 而任务永远不会再跑。用户只能手动改排期或删掉它。
 *
 * ⚠️ **判据放上界而不是「拒绝二月二十九日」**：按周期长度判，将来 cron 语义
 * 扩展（加秒字段、支持 `L`/`W` 之类）时这里仍然成立；按日期形态判则会漏。
 *
 * ⚠️ **365 ~ 1460 之间取任何值都等价** —— 五字段 cron 里相邻命中间隔只有两档：
 * 「每年一次」的约 365~366 天，和「闰日」的 1461 天，中间没有别的可能。
 *
 * ⚠️⚠️ **为什么是 366 而不是 365**：年度表达式的间隔**不是恒定 365 天** ——
 * 判据算的是两个时刻的**毫秒差**再除以 `DAY_MS`，而跨夏令时的年度间隔会多出
 * 那一小时的零头。实测 `0 0 10 3 *` 在 `America/New_York` 的锚点对是
 * **365.0417 天**（2026-03-10 → 2027-03-10）；锚点若落在闰年，更是整 366 天。
 * ⇒ 取 365 会**误拒每年一次的表达式**。366 才覆盖得住这两类零头。
 */
export const MAX_CRON_INTERVAL_DAYS = 366;

/**
 * 稀疏判据的扫描窗口（天）。
 *
 * ⚠️⚠️ **必须是独立下限，不能写成 `MAX_CRON_INTERVAL_DAYS * 倍数`** ——
 * 第二跳要看到闰日的下一次命中（2028-02-29 → 2032-02-29）需要 **≥1461 天**窗口，
 * 而 `× 5` 只在阈值 ≥293 时成立。阈值将来一旦下调（比如改成「最多一个月」取 31），
 * 窗口就不够、`findNextCronRun` 扫不到第一次命中、函数走「扫不到就放行」那条分支
 * ⇒ **本判据静默失效、闰日表达式又能建出来**，而 `scheduler.ts` 里那段
 * 「建得进就永远成立」的注释正是建立在它有效之上。洞会无声复活。
 *
 * 取 `max(阈值, 1461) * 2` 而不是写死 1500：阈值若将来调到比 1461 更大，
 * 窗口会跟着放大，不会反过来卡住新阈值。
 */
const SPARSE_LOOKAHEAD_DAYS = Math.max(MAX_CRON_INTERVAL_DAYS, 1461) * 2;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

type RRuleFrequency = 'MINUTELY' | 'HOURLY' | 'DAILY';

interface ParsedCronField {
  values: Set<number>;
  wildcard: boolean;
}

interface ParsedCron {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

interface ParsedRRule {
  frequency: RRuleFrequency;
  interval: number;
  intervalMinutes: number;
}

export type ParsedAutomationSchedule =
  | { kind: 'manual'; timezone: string }
  | { kind: 'cron'; expression: string; timezone: string; cron: ParsedCron }
  | { kind: 'rrule'; expression: string; timezone: string; rrule: ParsedRRule };

export interface ScheduleError {
  code: string;
  message: string;
}

export type ScheduleResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ScheduleError };

type ScheduleFailure = { ok: false; error: ScheduleError };

export interface ScheduleCalculationOptions {
  minimumIntervalMinutes?: number;
  maxLookaheadDays?: number;
}

export function parseAutomationSchedule(
  schedule: AutomationSchedule,
): ScheduleResult<ParsedAutomationSchedule> {
  const timezone = schedule.timezone || 'UTC';
  if (!isValidTimeZone(timezone)) {
    return error('invalid_timezone', `Invalid schedule timezone: ${timezone}`);
  }

  if (!schedule.enabled || schedule.kind === 'manual') {
    return { ok: true, value: { kind: 'manual', timezone } };
  }

  const expression = schedule.expression?.trim();
  if (!expression) {
    return error('missing_expression', 'Schedule expression is required.');
  }

  if (schedule.kind === 'rrule') {
    const parsed = parseRRule(expression);
    if (isScheduleFailure(parsed)) return failure(parsed);
    return {
      ok: true,
      value: {
        kind: 'rrule',
        expression,
        timezone,
        rrule: parsed.value,
      },
    };
  }

  if (schedule.kind === 'cron') {
    const parsed = parseCron(expression);
    if (isScheduleFailure(parsed)) return failure(parsed);
    return {
      ok: true,
      value: {
        kind: 'cron',
        expression,
        timezone,
        cron: parsed.value,
      },
    };
  }

  return error('unsupported_schedule', `Unsupported schedule kind: ${schedule.kind}`);
}

export function calculateNextRunAt(
  schedule: AutomationSchedule,
  referenceAt: number,
  options: ScheduleCalculationOptions = {},
): ScheduleResult<number | null> {
  const parsed = parseAutomationSchedule(schedule);
  if (isScheduleFailure(parsed)) return failure(parsed);
  if (parsed.value.kind === 'manual') return { ok: true, value: null };

  const minimumIntervalMinutes = Math.max(
    DEFAULT_MINIMUM_INTERVAL_MINUTES,
    schedule.minimumIntervalMinutes,
    options.minimumIntervalMinutes ?? 0,
  );

  if (parsed.value.kind === 'rrule') {
    if (parsed.value.rrule.intervalMinutes < minimumIntervalMinutes) {
      return error(
        'schedule_too_frequent',
        `Schedule interval must be at least ${minimumIntervalMinutes} minutes.`,
      );
    }
    return {
      ok: true,
      value: referenceAt + parsed.value.rrule.intervalMinutes * MINUTE_MS,
    };
  }

  const first = findNextCronRun(parsed.value.cron, parsed.value.timezone, referenceAt, options);
  if (isScheduleFailure(first)) return failure(first);
  if (first.value == null) return first;

  if (isCronTooFrequent(parsed.value.cron, parsed.value.timezone, minimumIntervalMinutes)) {
    return error(
      'schedule_too_frequent',
      `Schedule interval must be at least ${minimumIntervalMinutes} minutes.`,
    );
  }

  if (isCronTooSparse(parsed.value.cron, parsed.value.timezone)) {
    return error(
      'schedule_too_sparse',
      `Schedule interval must be at most ${MAX_CRON_INTERVAL_DAYS} days.`,
    );
  }

  return first;
}

/**
 * 稀疏判据：相邻两次命中的间隔**超过 `MAX_CRON_INTERVAL_DAYS`** 即拒。
 *
 * ⚠️⚠️ **窗口必须够长** —— 默认 370 天从锚点起**扫不到闰日的第一次命中**
 * （`0 0 29 2 *` 从 2026-01-01 起要等到 2028-02-29），于是 `first` 直接是
 * `cron_no_next_run`、判据被静默跳过。窗口常量见 `SPARSE_LOOKAHEAD_DAYS`。
 *
 * ⚠️ **锚点与 `isCronTooFrequent` 共用同一个**（`localMidnightTimestamp`），
 * 否则同一条表达式会在两个判据里看到不同的「第一次命中」。
 *
 * ⚠️ **锚点窗口内扫不到命中时返回 `false`（放行）** —— 那种情况由随后的
 * `findNextCronRun` 按 `referenceAt` 如实报 `cron_no_next_run`（该建不进来还是建不进来）。
 * 这里只负责「建得进、但滚不动」那一档。
 *
 * ⚠️ **成本**：只在「月字段不是全部 12 个月」时才走 —— 每月都跑的表达式不可能
 * 稀疏，直接跳过。而长窗口里绝大多数日子被「整日跳过」快路径 O(1) 干掉。
 * 实测（`calculateNextRunAt` 整体、含稀疏判据那两跳）：闰日表达式
 * **UTC 约 5.5ms / America/New_York 约 7.5ms**，年度表达式（`0 0 1 11 *`）NY 约 12ms；
 * 对照每天一次 `0 9 * * *` 约 2.2ms。
 * ⚠️ **只在创建与刷新排期时跑，不在每分钟的扫描热路径上** —— 后者走的是
 * `findNextCronRun`（单跳），不吃这个开销。
 */
function isCronTooSparse(cron: ParsedCron, timezone: string): boolean {
  // 月字段是全集 ⇒ 每月都有机会命中 ⇒ 间隔上界只受日/周字段影响，最稀也 ≤ 366 天。
  if (cron.month.values.size === 12) return false;

  const options = { maxLookaheadDays: SPARSE_LOOKAHEAD_DAYS };
  const anchor = localMidnightTimestamp(timezone) - MINUTE_MS;
  const first = findNextCronRun(cron, timezone, anchor, options);
  if (isScheduleFailure(first) || first.value == null) return false;
  const second = findNextCronRun(cron, timezone, first.value, options);
  if (isScheduleFailure(second) || second.value == null) return false;
  return (second.value - first.value) / DAY_MS > MAX_CRON_INTERVAL_DAYS;
}

/**
 * 固定锚点：`2026-01-01` 当地 00:00（再往前挪一分钟，让「当地 00:00 命中」也算进头两次）。
 *
 * ⚠️⚠️ **频率判据必须与调用方的 `referenceAt` 无关** —— 同一份表达式在任何时刻
 * 都应得到同一个结论。早先的实现拿 `referenceAt` 当起点数头两次命中，于是
 * `0,10 9 * * *`（09:00 与 09:10 相隔 10 分钟）在 08:00 被拒、在 09:05 被放行；
 * 而自动化任务收尾时是用「完成时刻」重算下一次的 ⇒ **每小时有 50 分钟被判
 * `schedule_too_frequent`、`nextRunAt` 恒为 null**，界面上反复出现「排期间隔太短」。
 *
 * ⚠️ **代价（刻意接受）**：只数「固定锚点之后头两次命中」，因此「跨午夜的那一对」
 * （如 23:55 与次日 00:00）数不到 —— 失败方向是**放行**一个过密的表达式，
 * 不会误拒正常表达式。要覆盖那一档得扫完整个周期，成本远高于收益。
 */
const FREQUENCY_ANCHOR_DATE = { year: 2026, month: 0, day: 1 } as const;

/**
 * 频率判据：从**固定锚点**起数头两次命中的间隔，短于下限即判过密。
 *
 * ⚠️ **锚点处扫不到命中时返回 `false`（放行）** —— 闰日这类表达式从锚点起
 * 370 天窗口内无命中，频率无从判断；此时不该把它当成「过密」拒掉，
 * 「窗口内无命中」由随后的 `findNextCronRun` 按它自己的 `referenceAt` 如实报。
 */
function isCronTooFrequent(
  cron: ParsedCron,
  timezone: string,
  minimumIntervalMinutes: number,
): boolean {
  // 快判：同一小时内至多命中一次（分钟字段只有一个值）⇒ 相邻命中至少隔 60 分钟。
  // 这一步把「每天/每月一次」这类最常见表达式的判据降到零成本 —— 否则每次调用
  // 都要为锚点扫一遍那一天的 1440 分钟。⚠️ 只在下限 ≤ 60 时成立。
  if (cron.minute.values.size === 1 && minimumIntervalMinutes <= 60) return false;

  const anchor = localMidnightTimestamp(timezone) - MINUTE_MS;
  const first = findNextCronRun(cron, timezone, anchor, {});
  if (isScheduleFailure(first) || first.value == null) return false;
  const second = findNextCronRun(cron, timezone, first.value, {});
  if (isScheduleFailure(second) || second.value == null) return false;
  return (second.value - first.value) / MINUTE_MS < minimumIntervalMinutes;
}

/** 求固定锚点那一天在 `timezone` 里的当地 00:00 时刻。 */
function localMidnightTimestamp(timezone: string): number {
  let candidate = Date.UTC(
    FREQUENCY_ANCHOR_DATE.year,
    FREQUENCY_ANCHOR_DATE.month,
    FREQUENCY_ANCHOR_DATE.day,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = getZonedDateParts(candidate, timezone);
    const offsetMs = (parts.hour * 60 + parts.minute) * MINUTE_MS;
    if (offsetMs === 0) return candidate;
    candidate -= offsetMs;
  }
  return candidate;
}

export function validateAutomationSchedule(
  schedule: AutomationSchedule,
  referenceAt: number = Date.now(),
  options: ScheduleCalculationOptions = {},
): ScheduleResult<ParsedAutomationSchedule> {
  const parsed = parseAutomationSchedule(schedule);
  if (isScheduleFailure(parsed)) return failure(parsed);
  const next = calculateNextRunAt(schedule, referenceAt, options);
  if (isScheduleFailure(next)) return failure(next);
  return parsed;
}

function parseRRule(expression: string): ScheduleResult<ParsedRRule> {
  const normalized = expression.replace(/^RRULE:/i, '');
  const parts = new Map<string, string>();

  for (const part of normalized.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    const key = rawKey?.trim().toUpperCase();
    const value = rawValue?.trim().toUpperCase();
    if (!key || !value) {
      return error('invalid_rrule', 'RRULE parts must use KEY=VALUE format.');
    }
    parts.set(key, value);
  }

  const frequency = parts.get('FREQ');
  if (!isRRuleFrequency(frequency)) {
    return error('invalid_rrule_frequency', 'RRULE FREQ must be MINUTELY, HOURLY, or DAILY.');
  }

  const intervalRaw = parts.get('INTERVAL') ?? '1';
  const interval = Number.parseInt(intervalRaw, 10);
  if (!Number.isInteger(interval) || interval < 1) {
    return error('invalid_rrule_interval', 'RRULE INTERVAL must be a positive integer.');
  }

  const unsupported = [...parts.keys()].filter((key) => key !== 'FREQ' && key !== 'INTERVAL');
  if (unsupported.length > 0) {
    return error('unsupported_rrule_part', `Unsupported RRULE part: ${unsupported.join(', ')}.`);
  }

  return {
    ok: true,
    value: {
      frequency,
      interval,
      intervalMinutes: intervalToMinutes(frequency, interval),
    },
  };
}

function parseCron(expression: string): ScheduleResult<ParsedCron> {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return error('invalid_cron', 'Cron expression must have 5 fields.');
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const parsedMinute = parseCronField(minute, 0, 59);
  const parsedHour = parseCronField(hour, 0, 23);
  const parsedDayOfMonth = parseCronField(dayOfMonth, 1, 31);
  const parsedMonth = parseCronField(month, 1, 12);
  const parsedDayOfWeek = parseCronField(dayOfWeek, 0, 7, normalizeDayOfWeek);

  if (isScheduleFailure(parsedMinute)) return failure(parsedMinute);
  if (isScheduleFailure(parsedHour)) return failure(parsedHour);
  if (isScheduleFailure(parsedDayOfMonth)) return failure(parsedDayOfMonth);
  if (isScheduleFailure(parsedMonth)) return failure(parsedMonth);
  if (isScheduleFailure(parsedDayOfWeek)) return failure(parsedDayOfWeek);

  return {
    ok: true,
    value: {
      minute: parsedMinute.value,
      hour: parsedHour.value,
      dayOfMonth: parsedDayOfMonth.value,
      month: parsedMonth.value,
      dayOfWeek: parsedDayOfWeek.value,
    },
  };
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  normalize: (value: number) => number = (value) => value,
): ScheduleResult<ParsedCronField> {
  const values = new Set<number>();
  const wildcard = field === '*' || field === '?';

  for (const token of field.split(',')) {
    const parsed = parseCronToken(token.trim(), min, max);
    if (isScheduleFailure(parsed)) return failure(parsed);
    for (let value = parsed.value.start; value <= parsed.value.end; value += parsed.value.step) {
      values.add(normalize(value));
    }
  }

  if (values.size === 0) {
    return error('invalid_cron_field', `Cron field "${field}" does not select any values.`);
  }

  return { ok: true, value: { values, wildcard } };
}

function parseCronToken(
  token: string,
  min: number,
  max: number,
): ScheduleResult<{ start: number; end: number; step: number }> {
  if (!token) return error('invalid_cron_field', 'Cron field contains an empty token.');

  /**
   * ⚠️ **多出来的段必须拒绝，不能静默丢弃** —— `split` 的解构会把它们扔掉：
   * `1-2-3` 只剩 `1-2`、`1-2/3/4` 只剩 `1-2/3`，两者都**返回 ok**。
   * 用户写了个自以为复杂的表达式，实际只生效一部分，表现是「任务跑得比预期少」，
   * 界面上没有任何提示。标准 cron 里这两种写法都是非法的。
   */
  const slashParts = token.split('/');
  if (slashParts.length > 2) {
    return error('invalid_cron_range', `Invalid cron token "${token}": at most one "/" is allowed.`);
  }
  const [rangePart, stepPart] = slashParts;
  const step = stepPart == null ? 1 : Number.parseInt(stepPart, 10);
  if (!Number.isInteger(step) || step < 1) {
    return error('invalid_cron_step', `Invalid cron step "${stepPart}".`);
  }

  if (rangePart === '*' || rangePart === '?') {
    return { ok: true, value: { start: min, end: max, step } };
  }

  const rangeParts = (rangePart as string).split('-');
  if (rangeParts.length > 2) {
    return error('invalid_cron_range', `Invalid cron range "${rangePart}": at most one "-" is allowed.`);
  }
  const [startRaw, endRaw] = rangeParts;
  const start = Number.parseInt(startRaw as string, 10);
  /**
   * ⚠️ **`n/step` 的终点是字段上界，不是 `n` 本身** —— 标准 cron 里 `0/5` 等价于
   * 「从 0 到 59、每 5 分钟」，而早先的实现把 `end` 取成 `start`，`step` 被静默丢弃：
   * `0/5 * * * *` 只在每小时 :00 触发一次，用户看到的是「怎么一小时才跑一次」，
   * 既不报错也没有任何提示。只有**带 `/` 且没写范围**时才取上界，
   * 纯数字 `5` 仍然是「只匹配 5」。
   */
  const end = endRaw == null
    ? (stepPart == null ? start : max)
    : Number.parseInt(endRaw, 10);

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
    return error('invalid_cron_range', `Invalid cron range "${rangePart}".`);
  }

  return { ok: true, value: { start, end, step } };
}

/**
 * 找下一次命中的 cron 时刻。
 *
 * 逐分钟暴力扫描在「日级或更稀」的表达式上代价极高（实测 `0 0 1 * *` 约 4 万次、
 * `0 0 1 1 *` 约 23 万次 Intl 调用，单次 2~10 秒；而 `calculateNextRunAt` 会调用
 * 本函数两次，最坏情况接近一分钟）。这里做两件事，结果与逐分钟扫描完全等价：
 *   1. 缓存 `Intl.DateTimeFormat`（按 timezone）—— 原先每次取日期部件都重建格式化器，
 *      这是最大的开销来源；
 *   2. 当天不可能命中时**整日跳过** —— 只有「当天可能命中」的日子才逐分钟走。
 */
function findNextCronRun(
  cron: ParsedCron,
  timezone: string,
  referenceAt: number,
  options: ScheduleCalculationOptions,
): ScheduleResult<number | null> {
  const maxLookaheadMs = (options.maxLookaheadDays ?? MAX_CRON_LOOKAHEAD_DAYS) * DAY_MS;
  const endAt = referenceAt + maxLookaheadMs;
  let candidate = Math.floor(referenceAt / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const lastMinuteOfDay = lastMatchingMinuteOfDay(cron);

  while (candidate <= endAt) {
    const parts = getZonedDateParts(candidate, timezone);
    if (!matchesCronDay(cron, parts)) {
      candidate = advanceToNextLocalDayStart(candidate, timezone);
      continue;
    }
    if (matchesCron(cron, parts)) return { ok: true, value: candidate };
    // 当天已过最后一个可命中分钟 → 剩下的分钟不可能命中，直接跳下一天。
    if (parts.hour * 60 + parts.minute >= lastMinuteOfDay) {
      candidate = advanceToNextLocalDayStart(candidate, timezone);
      continue;
    }
    candidate += MINUTE_MS;
  }

  return error('cron_no_next_run', 'No cron run was found within the lookahead window.');
}

/** 一天里最后一个可能命中的分钟序号（0~1439）。 */
function lastMatchingMinuteOfDay(cron: ParsedCron): number {
  return Math.max(...cron.hour.values) * 60 + Math.max(...cron.minute.values);
}

/** cron 的「日」条件：月 + 日/星期（含标准 cron 的「或」语义）。 */
function matchesCronDay(cron: ParsedCron, parts: ZonedDateParts): boolean {
  const dayOfMonthMatches = cron.dayOfMonth.values.has(parts.dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.values.has(parts.dayOfWeek);
  const dayMatches =
    !cron.dayOfMonth.wildcard && !cron.dayOfWeek.wildcard
      ? dayOfMonthMatches || dayOfWeekMatches
      : dayOfMonthMatches && dayOfWeekMatches;
  return cron.month.values.has(parts.month) && dayMatches;
}

function matchesCron(cron: ParsedCron, parts: ZonedDateParts): boolean {
  return (
    cron.minute.values.has(parts.minute) &&
    cron.hour.values.has(parts.hour) &&
    matchesCronDay(cron, parts)
  );
}

/**
 * 求 `timestamp` 之后、该时区中「次日 00:00」的时刻（分钟对齐）。
 *
 * 先按 24 小时推进到「约次日同一时刻」，再迭代减去当地的时刻部分，收敛到某个当地 00:00。
 *
 * ## ⚠️ 末尾那个「+ 一分钟」退化不能改成「正确地跳到次日」（别再简化）
 *
 * 它同时是**两个**缺陷的修复机制，删任何一个都会让另一个复现：
 *
 * 1. **收敛可能落回今天。** 夏令时回拨日当地一天有 25 小时，`- 当地时刻 + 24h` 得到的
 *    候选落回**今天**的某个 00:00（早于起点），此时必须退让 —— 若不判 `candidate > timestamp`
 *    就返回，调用方会拿到一个「还是今天」的值、随即又跳一次，整整跳掉一天。
 * 2. **快路径按当地墙钟判断，而墙钟在回拨日不单调。** 调用方的 `lastMatchingMinuteOfDay`
 *    认为「当地时刻已过最后一个可命中分钟」就当当天结束，但回拨日当地 02:30 会出现**两次**，
 *    第一次过后该判据已为真。正是这里的 +1 分钟退化让循环重新逐分钟前进，第二次命中才不被跳掉。
 *
 * 所以：**不要**把 `timestamp + MINUTE_MS` 改成「直接跳到次日 00:00」（那会打破第 2 条），
 * 也**不要**去掉 `candidate > timestamp` 的判断（那会打破第 1 条）。
 *
 * 代价有界：只在受影响的那些天（每年至多两天）退化成逐分钟，其余日子仍是 O(1)。
 */
function advanceToNextLocalDayStart(timestamp: number, timezone: string): number {
  const parts = getZonedDateParts(timestamp, timezone);
  const todayStart = timestamp - (parts.hour * 60 + parts.minute) * MINUTE_MS;
  let candidate = todayStart + DAY_MS;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidateParts = getZonedDateParts(candidate, timezone);
    const offsetMs = (candidateParts.hour * 60 + candidateParts.minute) * MINUTE_MS;
    if (offsetMs === 0) {
      return candidate > timestamp ? candidate : timestamp + MINUTE_MS;
    }
    candidate -= offsetMs;
  }
  return timestamp + MINUTE_MS;
}

interface ZonedDateParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

/**
 * 取某时刻在指定时区的日期部件。
 *
 * `Intl.DateTimeFormat` 的构造是本函数最大的开销（远大于 `formatToParts` 本身），
 * 而调度计算会对同一时区反复取部件（逐分钟扫描时是几万次）—— 所以按 timezone 缓存。
 */
const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getZonedDateParts(timestamp: number, timezone: string): ZonedDateParts {
  let formatter = zonedFormatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    zonedFormatterCache.set(timezone, formatter);
  }

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
  );

  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: weekdayToNumber(parts.weekday),
  };
}

function isRRuleFrequency(value: string | undefined): value is RRuleFrequency {
  return value === 'MINUTELY' || value === 'HOURLY' || value === 'DAILY';
}

function intervalToMinutes(frequency: RRuleFrequency, interval: number): number {
  if (frequency === 'MINUTELY') return interval;
  if (frequency === 'HOURLY') return interval * 60;
  return interval * 24 * 60;
}

function normalizeDayOfWeek(value: number): number {
  return value === 7 ? 0 : value;
}

function weekdayToNumber(value: string | undefined): number {
  switch (value) {
    case 'Sun':
      return 0;
    case 'Mon':
      return 1;
    case 'Tue':
      return 2;
    case 'Wed':
      return 3;
    case 'Thu':
      return 4;
    case 'Fri':
      return 5;
    case 'Sat':
      return 6;
    default:
      return 0;
  }
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function error<T = never>(code: string, message: string): ScheduleResult<T> {
  return { ok: false, error: { code, message } };
}

function failure<T>(result: ScheduleFailure): ScheduleResult<T> {
  return { ok: false, error: result.error };
}

function isScheduleFailure<T>(result: ScheduleResult<T>): result is ScheduleFailure {
  return result.ok === false;
}
