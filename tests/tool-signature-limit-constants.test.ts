// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * **「一条工具调用的 raw 截到多少」这个数字有两份拷贝，它们必须相等。**
 *
 * 两处服务同一件事的两半：
 * - 写库侧 `core/tool/history.ts` 的 `sanitizeCall` 把 `raw` 截到 N 字符 + `\n...[truncated]`；
 * - 合流侧 `core/ui/tool-block-restore.ts` 的 `signatureOf` 也截到 N 字符再拼签名。
 *
 * ⚠️⚠️ **失配的表现是静默的**：两侧上限不同时，超长调用的两条腿签名必然不等 ⇒
 * 存储腿那条**永远合流不上** ⇒ 刷新后「写了大文件、看不到结果」（面板退化成只有工具名）。
 * 不报错、不崩，只是真结果不见了。
 *
 * ⚠️ **为什么必须另写一条**：既有的那条用例（`matches a truncated raw against its full form`）
 * 是**在测试里自己硬编码 4000** 造夹具的，两侧一起改成 3000 它照样绿 —— 实测确认：
 * 把 `SIGNATURE_RAW_LIMIT` 或 `sanitizeCall` 单独改成 3_000，**42 条全绿**。
 * 只有「往上改」（4000 → 5000）才会被那条用例抓住，因为那时截断方向才真的错。
 *
 * ⚠️ **读源码字面量、不求值** —— 与 `cross-package-limit-constants.test.ts` 同形态：
 * 两处都是字面量，归一数字分隔符后逐字比。写成算式或引用别的常量会让它红，
 * 那正是要的（说明有人动过）。
 */
const SIGNATURE_FILE = 'core/ui/tool-block-restore.ts';
const HISTORY_FILE = 'core/tool/history.ts';

/** 去掉数字分隔符与多余空白，便于逐字比较。 */
function normalize(text: string): string {
  return text.replace(/_/g, '').replace(/\s+/g, '');
}

/** 合流侧的签名截断上限（`const SIGNATURE_RAW_LIMIT = N;`）。 */
function signatureLimit(): string {
  const source = readFileSync(SIGNATURE_FILE, 'utf8');
  const match = /const SIGNATURE_RAW_LIMIT = ([\d_]+);/.exec(source);
  expect(
    match,
    `${SIGNATURE_FILE} 里应当有 \`const SIGNATURE_RAW_LIMIT = <数字>;\` —— `
    + '改写成算式或引用别的常量时这条对账要跟着改',
  ).not.toBeNull();
  return normalize(match![1]);
}

/**
 * 写库侧的 raw 截断上限。
 *
 * ⚠️ **取 `raw.length > N` 那一个** —— 同一行里 `slice(0, N)` 的 `0` 是起始下标、
 * 不是上限，按「找出所有数字」收会把 `0` 也算进来（第一版就是这么红的）。
 * 取完再单独断言那一行里的 `slice` 用的是同一个数。
 */
function sanitizeRawLimit(): string {
  const source = readFileSync(HISTORY_FILE, 'utf8');
  const body = /function sanitizeCall\([\s\S]*?\n}/.exec(source);
  expect(body, `${HISTORY_FILE} 里应当有 \`function sanitizeCall(\``).not.toBeNull();
  const rawLine = body![0].split('\n').find((line) => line.trim().startsWith('raw:'));
  expect(rawLine, `${HISTORY_FILE} 的 sanitizeCall 里应当有一行 \`raw: …\``).toBeDefined();
  const limit = /\.length > ([\d_]+)/.exec(rawLine!);
  expect(limit, `${HISTORY_FILE} 的 raw 截断行里应当有 \`.length > <数字>\``).not.toBeNull();
  // 截断那一半必须用同一个数（`slice(0, N)`）—— 两处写成不同的数时
  // 「超长判定」与「实际切多少」会分叉，而那比两侧上限不同更难发现。
  const slice = /\.slice\(0, ([\d_]+)\)/.exec(rawLine!);
  expect(slice, `${HISTORY_FILE} 的 raw 截断行里应当有 \`.slice(0, <数字>)\``).not.toBeNull();
  expect(normalize(slice![1]), `${HISTORY_FILE} 的 raw 截断行里「判定上限」与「切片长度」不一致`)
    .toBe(normalize(limit![1]));
  return normalize(limit![1]);
}

describe('工具调用 raw 的截断上限对账', () => {
  it('合流签名与写库截断用的是同一个上限', () => {
    expect(
      signatureLimit(),
      `${SIGNATURE_FILE} 的 SIGNATURE_RAW_LIMIT 与 ${HISTORY_FILE} 的 sanitizeCall 不一致 —— `
      + '改一侧必须同改另一侧，否则超长调用的两条腿签名永远对不上、'
      + '刷新后那条工具记录会静默消失（只剩工具名、没有结果）',
    ).toBe(sanitizeRawLimit());
  });
});
