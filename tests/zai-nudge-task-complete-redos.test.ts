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

/**
 * 待办判定的**主语分档**。
 *
 * ## 它修的是什么
 *
 * 一条正则把「接下来」这类无主语引导词与「我将…」一视同仁时，会把建议当成待办：
 * 任务完成时模型常写「报告已生成。**接下来你可以**打开它查看。」——
 * 主语是**用户**、是建议、不是待办，却照样命中 ⇒ 弹出 nudge。
 *
 * ## 分档方向：宁可多 nudge，不可漏 nudge
 *
 * **漏判 = 任务提前收尾**（模型承诺了本地动作却没做，循环直接结束），
 * 代价远高于「多跑一轮」。所以：
 *  - **强信号**（主语明确是模型）**无条件判待办**，不加任何附加条件；
 *  - 只有**弱信号**（`接下来/下一步/然后` + 动词，主语不明）才看上下文，
 *    且窗口只有命中处前后 12 字。
 */
describe('shouldNudgeZai: 主语分档', () => {
  const nudge = (text: string): boolean => shouldNudgeZai('原始任务', [], text);

  describe('强信号（主语是模型）→ 一律 nudge', () => {
    it.each([
      '我会调用 web_search 获取最新行情。',
      'I still need to call search next.',
      '我想下载这份报告。',
      '我打算先核对一下刚才的结果。',
      "I'm going to look up the latest price.",
      'I need to check the file now.',
      "Let's fetch the second page.",
      '让我再抓取雪球那篇详尽的24个月梳理文章。',
      '让我先搜索一下最新行情。',
      '我再抓取一次页面确认数据。',
      '先让我调用 web_fetch 获取详情。',
      '现在为你创建一份包含折线图的可视化报告。',
      '为你创建一个包含汇总分析的 HTML 页面。',
      '现在为您生成一份包含汇总分析的 HTML 页面。',
      '这就帮你绘制交互式折线图。',
      // 无主语但语气明确（原实现会漏判的那一档）
      '我现在去读取文件。',
      '马上调用工具。',
      '我这就开始处理。',
      '还需要检查一下输出。',
      '我准备搜索一下。',
      '再试一次获取数据。',
      '接下来执行。',
      '下一步我会验证结果。',
      '我继续分析剩下的部分。',
      '我将重新运行测试。',
      'Let me try again.',
      "I'm about to fetch the page.",
      'We will need to retry the request.',
      'My next step is to validate the output.',
      // 已完成第一步、但后面仍有承诺 ⇒ 仍要 nudge
      '我已经完成了第一步。接下来我会继续处理剩下的数据。',
      // ⚠️ **强信号在前、弱建议在后** —— 早前「只看最后一条命中」会把前面的强信号丢掉。
      '我将生成报告。接下来你可以下载它。',
      '我会创建文件。接下来你可以编辑它。',
      // ⚠️ `到` / `后` 是目的补语与顺序词，不是过去时
      '我将把报告保存到桌面。',
      '我会下载到本地。',
      '我将修改后通知你。',
      // ⚠️ `好` 后面还有宾语 ⇒ 尚未发生
      '我将整理好数据。',
      // ⚠️ 无主语、语气明确（现在/随后/稍后 已移出强信号，但 `马上` 这类仍在）
      '现在检查一下输出。',
      // ⚠️ **无主语待办，宾语里有「你」** —— 早前「窗口里有『你』就算建议」会把这些整体放过，
      // 而它们是**模型自己要做的事**（「你给的链接」「你可以访问的地址」都是宾语/定语）。
      '接下来把结果推送到你可以访问的地址并生成一个链接。',
      '接下来读取你给的链接里的内容并生成摘要。',
      '然后运行你给出的那条命令并检查日志。',
      '然后检查你提供的那几个文件。',
      '接下来把生成的报告保存到你可以访问的目录。',
      // ⚠️ 反语序的「完成 + 顺序」（`后` 之后 20 字内未必有「了」）—— 现状全对，用它们钉住。
      '我将检查完剩余部分再继续。',
      '我将分析好结果后提交。',
      '我将检查完这些文件后再生成总结。',
      '我将检查后通知你。',
      '我将检查后再检查一遍。',
      '我将检查完测试并部署。',
      // ⚠️⚠️ **多行承诺** —— 这三条钉住「窗口必须能跨行」。
      // 曾经五处窗口写的是 `.{0,N}`（不匹配换行）⇒ 分点 / 编号列表 / 冒号换行**整条漏判**
      // ⇒ 循环按「任务已完成」收尾，而模型其实承诺了还要继续。
      // 语料里原本 77 条**全是单行**，所以这个缺陷能长期潜伏。
      '我将\n读取文件',
      '我将：\n读取文件',
      '任务完成。\n\n接下来我会：\n- 读取配置文件\n- 生成报告\n- 汇总结果',
      '我会：\n1. 检查日志\n2. 生成报告',
      "I'll:\n1. read the file\n2. generate the report",
      '马上\n调用工具',
      '接下来\n检查日志',
    ])('%s', (text) => {
      expect(nudge(text)).toBe(true);
    });
  });

  describe('弱信号但主语是用户 → 不 nudge', () => {
    it.each([
      '报告已生成。接下来你可以打开它查看。',
      '已保存到桌面。接下来你可以随时编辑。',
      '下一步你可以查看报告详情。',
      '分析完成。接下来你可以查看图表。',
      '项目已完成部署。接下来你可以访问预览链接查看效果。',
      '代码已提交。接下来你可以运行 npm run dev 查看。',
      '网站已上线。接下来你可以访问 www.example.com 查看。',
      'The report is ready. Next, you can open it.',
      '接下来你可以直接使用这些文件。',
      '然后你可以运行这个脚本。',
      // ⚠️ `现在/随后/稍后` 同样常出现在给用户的建议里（原实现把它们当强信号）
      '报告已生成。现在你可以打开它查看。',
      '已保存。随后你可以下载它。',
      '已完成。稍后你可以查看结果。',
      // ⚠️ 引导词后紧跟「请」同样是建议/指令给用户
      '接下来，请查看结果。',
    ])('%s', (text) => {
      expect(nudge(text)).toBe(false);
    });
  });

  describe('过去时 / 完成态 → 不 nudge', () => {
    it.each([
      '我读取了配置文件。',
      '我检查了所有文件。',
      '我生成了报告并保存。',
      '我运行了测试。',
      '我分析了数据。',
      '我已经调用了 web_search。',
      '我继续分析后得出了结论。',
      '随后数据被写入文件。',
      '然后结果是全部通过。',
      '接下来是结论部分：一切正常。',
      'I already called the API.',
      'We have completed all steps.',
      '我已经获得了大量数据。',
      '让我来总结一下结论。',
      '我已经为你创建好了 HTML 页面。',
    ])('%s', (text) => {
      expect(nudge(text)).toBe(false);
    });
  });

  it('保留原有语义：命中之后还有大段内容就不算空承诺', () => {
    const text = '我会调用 web_search 获取最新行情。结果如下：' + '今天股市上涨。'.repeat(30);
    expect(nudge(text)).toBe(false);
  });

  it('保留原有语义：命中之后紧跟代码围栏（交付物）也不算空承诺', () => {
    expect(nudge('我将生成页面：\n```html\n<div>x</div>\n```')).toBe(false);
  });
});
