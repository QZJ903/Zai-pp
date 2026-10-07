import { describe, expect, it } from 'vitest';
import { shouldNudgeZai } from '../core/zai/continuation';

/**
 * `shouldNudgeZai` 的输入**必须线性**。
 *
 * ⚠️⚠️ **背景**：它第一件事就是拿 `ZAI_TASK_COMPLETE_RE` 跑一遍 `visibleText` 全文。
 * 那条正则原本写成 `<task_complete>\s*([\s\S]*?)\s*<\/task_complete>` ——
 * 捕获组两侧的 `\s*` 与 `[\s\S]*?` **量词重叠**，在「开标签后跟**连续空白**、
 * 且全文没有配对闭合标签」时**灾难性回溯**（实测 2,000 空白 0.9s /
 * 4,000 空白 6.4s / 8,000 空白 >20s）。
 *
 * ⚠️ **为什么这是真缺陷**：`visibleText` 是 `complete.assistantText`
 * （`zai.content.ts` 的 `handleResponseComplete`），来自桥消息，**没有长度上限**
 * （`decodeZaiResponseCompleteMessage` 只判 `typeof === 'string'`）
 * ⇒ 模型输出一段「`<task_complete>` + 大段缩进/空行」就能让内容脚本卡死数十秒。
 *
 * ⚠️ **触发条件是「纯空白连续段」** —— 中间插一个非空白字符、或末尾补上闭合标签，
 * 都会立刻回到 0ms。所以判据不是「文本长」，是「空白量词重叠」。
 *
 * ## 为什么分「小档 / 大档」两段测
 *
 * ⚠️⚠️ **缺陷存在时，大档会把进程挂死，而挂死的测试不算「红」。** 回溯是指数级的：
 * 3,000 空白约 2.8s，而 120,000 空白按同一倍率外推是**十几万秒**——不是「慢」，
 * 是**永远出不来**。所以先用小档（3,000）拿到一个**能终止的明确红**，
 * 只有小档过了才跑大档去证明线性。
 *
 * ⚠️ **阈值（500ms）是刻意的宽松值**：修好后 120,000 空白是 **0.02ms 量级**，
 * 与阈值差 4 个数量级 ⇒ 不会因机器快慢抖动，只会因「有人把 `\s*` 加回去」而红。
 */
const BUDGET_MS = 500;
/** 小档：缺陷存在时约 2.8s 就能拿到红（可终止）。 */
const PROBE_WHITESPACE = 3_000;
/** 大档：只有小档过了才跑，用来证明线性。 */
const LONG_WHITESPACE = 120_000;

function elapsed(text: string): { ms: number; nudge: boolean } {
  const t0 = performance.now();
  const nudge = shouldNudgeZai('原始任务', [], text);
  return { ms: performance.now() - t0, nudge };
}

/**
 * 小档拿结论，过了才跑大档。
 * ⚠️ 传入的是**构造器**而不是拼接好的前缀 —— 否则「前缀里已经含一长段空白」的用例
 * 会让小档本身也变成大输入、同样挂死（本文件第一版就是这么写的，实测挂住）。
 */
function expectLinear(build: (n: number) => string, label: string): void {
  expect(elapsed(build(PROBE_WHITESPACE)).ms, `${label} 小档 ${PROBE_WHITESPACE}`)
    .toBeLessThan(BUDGET_MS);
  expect(elapsed(build(LONG_WHITESPACE)).ms, `${label} 大档 ${LONG_WHITESPACE}`)
    .toBeLessThan(BUDGET_MS);
}

describe('shouldNudgeZai does not backtrack on whitespace runs', () => {
  it('handles an opening tag followed by a long space run', () => {
    expectLinear((n) => `<task_complete>${' '.repeat(n)}`, '空格');
    // 没有配对闭合标签 ⇒ 不构成结束信号 ⇒ 落回「末尾有待办话术」那条，
    // 此处无待办话术 ⇒ false。
    expect(elapsed(`<task_complete>${' '.repeat(LONG_WHITESPACE)}`).nudge).toBe(false);
  });

  it('handles newlines and tabs just as fast', () => {
    for (const whitespace of ['\n', '\t']) {
      expectLinear((n) => `<task_complete>${whitespace.repeat(n)}`, JSON.stringify(whitespace));
    }
  });

  it('handles a truncated closing tag after a long whitespace run', () => {
    for (const tail of ['</task_compl', '</ task_complete', '<']) {
      expectLinear((n) => `<task_complete>${' '.repeat(n)}${tail}`, tail);
    }
  });
});

describe('shouldNudgeZai keeps its decision semantics', () => {
  it('treats a complete signal as finished', () => {
    // 正常闭合形态必须仍被认成「结束」—— 这是去掉 `\s*` 之后要守住的语义。
    expect(shouldNudgeZai('原始任务', [], '好 <task_complete>完成</task_complete>')).toBe(false);
  });

  it('accepts whitespace and newlines inside a well-formed signal', () => {
    expect(shouldNudgeZai('原始任务', [], '<task_complete>\n完成\n</task_complete>')).toBe(false);
    expect(shouldNudgeZai('原始任务', [], '<task_complete>完成 </task_complete>')).toBe(false);
  });

  it('asks for a nudge when the answer is empty or ends on a pending action', () => {
    expect(shouldNudgeZai('原始任务', [], '')).toBe(true);
    expect(shouldNudgeZai('原始任务', [], '接下来我将调用 shell_exec')).toBe(true);
  });

  it('does not treat an unterminated opening tag as a completion signal', () => {
    // ⚠️ 这一档正是 ReDoS 的触发输入，也是行为上最容易搞错的一档。
    // 判据必须用**带待办话术**的文本：只有那样，`false` 才能被解释成
    // 「认出了结束信号」—— 否则 `false` 也可能只是「既非空、又没待办话术」。
    const pending = '接下来我将调用 shell_exec';
    expect(shouldNudgeZai('原始任务', [], pending)).toBe(true);
    expect(shouldNudgeZai('原始任务', [], `<task_complete>${pending}`)).toBe(true);
    expect(shouldNudgeZai('原始任务', [], `<task_complete>完成</task_complete>${pending}`)).toBe(false);
  });
});
