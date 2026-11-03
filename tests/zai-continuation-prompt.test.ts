import { describe, expect, it } from 'vitest';
import {
  buildZaiContinuationPrompt,
  buildZaiMisuseNudgePrompt,
  buildZaiNudgePrompt,
  isZaiContinuationPrompt,
  ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW,
} from '../core/zai/continuation';
import { ZAI_TEMPLATE_OPENING_LIST } from '../core/zai/continuation-marker';
import type { ToolExecutionRecord } from '../core/types';

const NO_EXECUTIONS = [] as const;

const SHELL_PROVIDER = {
  kind: 'mcp',
  id: 'shell',
  displayName: 'Shell MCP',
  transport: 'native_messaging',
} as const;

function execution(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    name: 'shell_exec',
    provider: SHELL_PROVIDER,
    result: { ok: true, summary: 'wrote step_2.txt', detail: 'exit 0' },
    ...overrides,
  };
}

function failingExecution(): ToolExecutionRecord {
  return execution({
    result: {
      ok: false,
      summary: '命令执行失败',
      detail: 'python: command not found',
      error: { code: 'spawn_failed', message: 'spawn python ENOENT', retryable: true },
    },
  });
}

/** 从 `<tool_results>` / `<tool_results_so_far>` 块里取回解析后的数组。 */
function readResults(prompt: string, tag: 'tool_results' | 'tool_results_so_far' = 'tool_results') {
  const start = prompt.indexOf(`<${tag}>\n`);
  const end = prompt.indexOf(`\n</${tag}>`);
  expect(start, `${tag} 块没找到`).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(prompt.slice(start + tag.length + 3, end)) as Record<string, unknown>[];
}

describe('browser snapshot detail budget', () => {
  it('keeps browser_snapshot detail up to 24k while action snapshots stay at 4k', () => {
    // ⚠️⚠️ **只有 `browser_snapshot` 吃宽上限** —— 它是模型主动要的整页快照。
    // 动作后自动补的快照（`includeSnapshotAfterActions`，默认开）必须仍走 4_000：
    // 否则连续点击会让最近 4 条全变成 24_000 字符，prompt 直接涨到十万字符
    // （实测 3 步全 browser 时 20_800 → 76 867 字符，+270%）。
    const body = 'B'.repeat(20_000);
    const asSnapshot = buildZaiContinuationPrompt(
      '任务',
      [execution({ name: 'browser_snapshot', result: { ok: true, summary: 'Captured', detail: body } })],
      ['browser_snapshot'],
    );
    const asAction = buildZaiContinuationPrompt(
      '任务',
      [execution({ name: 'browser_click', result: { ok: true, summary: 'Clicked', detail: body } })],
      ['browser_click'],
    );

    const snapshotDetail = readResults(asSnapshot)[0]!.detail as string;
    const actionDetail = readResults(asAction)[0]!.detail as string;

    // 宽档：20_000 字符原样保留（没有 `...[truncated]`）。
    expect(snapshotDetail).toBe(body);
    // 窄档：裁到 4_000 并显式标注。
    expect(actionDetail.length).toBeLessThan(4_100);
    expect(actionDetail).toContain('...[truncated]');
  });

  it('still caps browser_snapshot at 24k when the snapshot is larger', () => {
    // ⚠️ 宽档不是「无上限」—— 24_000 是唯一约束 `browser_snapshot` 贡献量的地方，
    // 因为 `buildZaiContinuationPrompt` 拼完之后到注入之间**没有任何总长检查**。
    const body = 'B'.repeat(30_000);
    const prompt = buildZaiContinuationPrompt(
      '任务',
      [execution({ name: 'browser_snapshot', result: { ok: true, summary: 'Captured', detail: body } })],
      ['browser_snapshot'],
    );
    const detail = readResults(prompt)[0]!.detail as string;
    expect(detail.length).toBeLessThan(24_100);
    expect(detail).toContain('...[truncated]');
  });
});

describe('zai continuation prompt recognition', () => {
  it('recognizes the continuation template', () => {
    const prompt = buildZaiContinuationPrompt('do the thing', NO_EXECUTIONS, ['shell_exec']);
    expect(isZaiContinuationPrompt(prompt)).toBe(true);
  });

  it('recognizes the nudge template', () => {
    const prompt = buildZaiNudgePrompt('do the thing', 'I will read the file.', NO_EXECUTIONS, 1, []);
    expect(isZaiContinuationPrompt(prompt)).toBe(true);
  });

  it('recognizes the misuse-correction template', () => {
    // ⚠️ **三个 builder 一个都不能漏** —— 严格档认的是「模板的固定开场话术」，
    // 而这句话是**每个 builder 各自写的**。漏一个 ⇒ 那一轮不被认作续跑轮 ⇒
    // 下一轮走原生轮分支、新建一个 `taskId` 为 null 的循环覆盖掉它，后台任务收不到终态。
    const prompt = buildZaiMisuseNudgePrompt('do the thing', 'shell_exec', undefined, NO_EXECUTIONS);
    expect(isZaiContinuationPrompt(prompt)).toBe(true);
  });

  it('does not treat an ordinary user prompt as a continuation', () => {
    expect(isZaiContinuationPrompt('帮我读一下这个文件')).toBe(false);
    expect(isZaiContinuationPrompt('<original_task>only one tag</original_task>')).toBe(false);
    expect(isZaiContinuationPrompt('<tool_results>[]</tool_results>')).toBe(false);
  });

  it('does not treat a prompt that merely quotes the tags as a continuation', () => {
    expect(isZaiContinuationPrompt('explain the tag <tool_results> in isolation')).toBe(false);
  });

  /**
   * ⚠️⚠️ **这条守的是「用户的消息不能消失」** —— 只认结构标签时，用户只要在消息里
   * 同时提到那两个标签就会被判成我们注入的模板：历史清洗把它换成不可见占位符、
   * 气泡隐藏给它加 `display:none` ⇒ **用户那条消息从对话里消失**，且没有任何东西会报错。
   * 判据是「我们模板的固定开场话术」，用户不会说那句话。
   */
  it('does not treat a user message that mentions both tags as a continuation', () => {
    expect(isZaiContinuationPrompt(
      '请解释 <original_task> 和 <tool_results> 这两个标签是干什么的',
    )).toBe(false);
    expect(isZaiContinuationPrompt(
      '我看了 `<original_task>` 和 `<tool_results>`，它们有什么区别？',
    )).toBe(false);
    // 反面对照：用户**贴一整段真模板**来问，仍然会命中 —— 这个面收窄不掉，如实钉住。
    const pasted = buildZaiContinuationPrompt('任务', NO_EXECUTIONS, ['shell_exec']);
    expect(isZaiContinuationPrompt(`我贴一段日志：\n${pasted}\n这段为什么被隐藏了？`)).toBe(true);
  });

  /**
   * ⚠️⚠️ **反向守卫：清单里每一句都必须是「我们模板的身份句」，不能是用户会说的话。**
   *
   * 上面那几条守的是**正向**（改模板措辞 ⇒ 严格档失配 ⇒ 红）。而这一档要防的是**反向**：
   * `ZAI_TEMPLATE_OPENINGS` 里**多认一句**普通的、用户可能打的字 ⇒ 那条用户消息会被
   * 历史清洗换成占位符 + 气泡隐藏成 `display:none` ⇒ **从对话里消失且无报错**。
   *
   * 判据分两半：
   * ① **每一句 + 两个标签 ⇒ true** —— 证明它确实在起「身份句」的作用（而不是加了一句没用过的）；
   * ② **用户自然语言 + 同一句 + 两个标签 ⇒ false** —— 证明它前面加了正常的话也不会被误认。
   *    ⚠️ 这是**弱判据**：`includes` 只看子串，用户只要原样打出那句就会被命中（与「贴整段真模板」
   *    同一类残余，收窄不掉）。所以这一半钉的是「这句本身够不够独特」，不是「绝对不误判」。
   */
  it('每一句开场话术都是「模板身份句」，不是用户会说的话', () => {
    const openings = ZAI_TEMPLATE_OPENING_LIST;
    expect(openings.length, '清单不该是空的').toBeGreaterThan(0);
    for (const opening of openings) {
      // ① 它 + 两个结构标签 ⇒ 认得出（说明它确实在起作用）
      expect(
        isZaiContinuationPrompt(
          `${opening}…\n<original_task>\n任务\n</original_task>\n<tool_results>\n[]\n</tool_results>`,
        ),
        `「${opening}」应当能单独撑起「这是我方模板」这个结论`,
      ).toBe(true);
      // ② 它不是任何一句常见用户提问的子串 —— 用一个**不含该句**的普通问法做对照
      expect(
        isZaiContinuationPrompt(
          `帮我看看这个配置文件\n<original_task>\n任务\n</original_task>\n<tool_results>\n[]\n</tool_results>`,
        ),
        '不带开场话术、只提结构标签的文本必须判否（这是「用户消息不能消失」的底线）',
      ).toBe(false);
    }
  });

  it('清单里的每一句都真的出现在某个 builder 的输出里（没有僵尸条目）', () => {
    // ⚠️ 反向的另一半：**只在清单里、没有任何 builder 产出过它** ⇒ 这一句是死判据
    // （多认一句就多一分误判风险，而它一分收益也没有）。改模板措辞时这条会红。
    const built = [
      buildZaiContinuationPrompt('任务', NO_EXECUTIONS, ['shell_exec']),
      buildZaiNudgePrompt('任务', '正文', NO_EXECUTIONS, 1, ['shell_exec']),
      buildZaiMisuseNudgePrompt('任务', 'shell_exec', undefined, NO_EXECUTIONS),
    ];
    for (const opening of ZAI_TEMPLATE_OPENING_LIST) {
      expect(
        built.some((text) => text.includes(opening)),
        `「${opening}」不在任何 builder 的输出里 —— 它是死条目，只增加误判风险`,
      ).toBe(true);
    }
  });
});

/**
 * 沙箱措辞分模式。
 *
 * chat 模式没有服务端沙箱，说「别用沙箱工具」是压住模型凭空造工具名；
 * **agent 模式的服务端沙箱是原生通路**（首条消息的 `prompt.sandboxHostSection`
 * 要求中间处理走沙箱、只有涉及用户本机时才输出本地工具 XML），
 * 继续喊「别用沙箱工具」会与那段直接冲突。
 *
 * ⚠️ 要守的不止「别用沙箱」那一句，而是**整类排他断言** —— 凡把 XML 工具标签说成
 * 全称唯一通道的句子，在 agent 模式都会把沙箱一起否掉。所以下面既查正面措辞，
 * 也查**负面**（agent 里不许出现排他句）。
 */
/**
 * 沙箱措辞**只有一套**（站点只剩 agent 模式，2026-10-19 删掉按模式分叉）。
 *
 * 判据是「措辞不能排他」—— 排他句（「只输出可执行 XML 工具标签」）会把服务端沙箱
 * 这条原生通路一并否掉。下面既查**正面**（必须收窄到本地工具），也查**负面**。
 */
describe('zai continuation prompt sandbox wording', () => {
  const toolNames = ['shell_exec', 'local_file_read'];

  it('narrows the continue instruction to local tools', () => {
    const prompt = buildZaiContinuationPrompt('task', NO_EXECUTIONS, toolNames);
    expect(prompt).not.toContain('别用沙箱工具');
    expect(prompt).toContain('本地工具调用必须输出可执行 XML 工具标签');
    // ⚠️ 「只输出可执行 XML 工具标签」是对「需要继续操作」的全称排他断言 ——
    // agent 模式下沙箱也是「继续操作」的一种，这句话会把沙箱通道一并否掉。
    expect(prompt).not.toContain('只输出可执行 XML 工具标签');
  });

  it('lists only the local tool tags without re-explaining the sandbox', () => {
    const prompt = buildZaiContinuationPrompt('task', NO_EXECUTIONS, toolNames);
    // 两套通道的分工由每轮注入的 sandboxHostSection 负责，这里不重复交代
    // （重复就是两处定义同一条规则，必然漂移），所以只列名字。
    expect(prompt).toContain('本轮可输出的本地工具标签：shell_exec, local_file_read');
  });

  it('uses the same wording for the nudge prompt', () => {
    const nudge = buildZaiNudgePrompt('task', 'text', NO_EXECUTIONS, 1, toolNames);
    expect(nudge).not.toContain('别用沙箱工具');
    expect(nudge).toContain('服务端沙箱工具直接调用（无需 XML）');
  });

  it('does not claim to have observed server-side sandbox tool calls', () => {
    // ⚠️ 我们**从来不观察**沙箱工具调用（`shouldNudgeZai` 里 executions 是 void 的，
    // assistantText 也只含答案相位）⇒ 声称「没有观察到」是一句与事实相反的话，
    // 模型刚调过沙箱工具时会读到它。
    const nudge = buildZaiNudgePrompt('task', 'text', NO_EXECUTIONS, 1, toolNames);
    expect(nudge).not.toContain('也没有观察到服务端沙箱工具的调用');
    expect(nudge).toContain('上一轮回复没有输出可执行的本地工具 XML');
    expect(nudge).toContain('如果任务已经完成，忽略这条提示');
  });

  it('does not ask for a task_complete signal', () => {
    // ⚠️ 提示词从没教过模型这个约定（i18n 资源零命中），而且与「忽略这条提示」冲突。
    const nudge = buildZaiNudgePrompt('task', 'text', NO_EXECUTIONS, 1, toolNames);
    expect(nudge).not.toContain('task_complete');
  });
});

describe('zai continuation prompt tool results', () => {
  it('carries provider, error and truncated so a failure can be diagnosed', () => {
    const [result] = readResults(
      buildZaiContinuationPrompt('task', [failingExecution()], ['shell_exec']),
    );

    expect(result).toMatchObject({
      tool: 'shell_exec',
      provider: 'Shell MCP',
      ok: false,
      summary: '命令执行失败',
      detail: 'python: command not found',
      truncated: false,
      // ⚠️ 只给 `ok: false` 时模型看不到错误码与可重试性，只能瞎猜参数或直接放弃。
      error: { code: 'spawn_failed', message: 'spawn python ENOENT', retryable: true },
    });
  });

  it('omits the error field entirely on success instead of writing null', () => {
    const [result] = readResults(buildZaiContinuationPrompt('task', [execution()], ['shell_exec']));
    expect(result).not.toHaveProperty('error');
    expect(result.truncated).toBe(false);
  });

  it('marks a truncated tool result so the model knows detail was cut', () => {
    const [result] = readResults(
      buildZaiContinuationPrompt(
        'task',
        [execution({ result: { ok: true, summary: 'ok', truncated: true } })],
        ['shell_exec'],
      ),
    );
    expect(result.truncated).toBe(true);
  });

  it('bounds the error message instead of forwarding an unbounded blob', () => {
    const [result] = readResults(
      buildZaiContinuationPrompt(
        'task',
        [execution({
          result: {
            ok: false,
            summary: 'failed',
            error: { code: 'boom', message: 'x'.repeat(2_000), retryable: false },
          },
        })],
        ['shell_exec'],
      ),
    );
    const error = result.error as { message: string };
    expect(error.message.length).toBeLessThan(600);
    expect(error.message).toContain('...[truncated]');
  });

  it('adds the failure-recovery line only when something actually failed', () => {
    const ok = buildZaiContinuationPrompt('task', [execution()], ['shell_exec']);
    const failed = buildZaiContinuationPrompt('task', [failingExecution()], ['shell_exec']);

    expect(ok).not.toContain('至少一个工具执行失败');
    expect(failed).toContain('至少一个工具执行失败');
    // 那句明确点名 error 字段 —— 字段缺失时它指向空气，所以两者必须同批存在。
    expect(failed).toContain('summary/detail/error');
  });
});

/**
 * 窗口化：续跑每轮把整个执行历史重发一遍，不加窗口时上下文随步数线性增长
 * （25 步上限下实测约 90KB）。窗口化后稳定在常数级。
 */
describe('only the newest accessibility snapshot keeps its body', () => {
  /** 造一条「带快照」的结果 —— 两种形态都要能被判出来。 */
  const snapshotExecution = (
    name: string,
    body: string,
    meta: { urls?: string } = {},
  ): ToolExecutionRecord => ({
    name,
    provider: { kind: 'local', id: 'browser_control', displayName: 'Browser', transport: 'in_process' },
    result: {
      ok: true,
      summary: `Captured in ${name}`,
      detail: `action done\n\n${body}`,
      output: name === 'browser_snapshot'
        // 主动快照：元数据在顶层
        ? { url: meta.urls ?? 'https://x', title: 't', nodeCount: 400, truncated: false }
        // 动作后补拍：元数据在 output.snapshot
        : { tabId: 12, action: 'click', snapshot: { url: meta.urls ?? 'https://x', title: 't', nodeCount: 400, truncated: false } },
    },
  });

  it('compresses older snapshots so their stale uids cannot mislead the model', () => {
    // ⚠️⚠️ **这不是体积问题，是正确性问题** —— 快照的 uid 是 `e{序号}`（第 N 个节点），
    // 而 `uidToBackendNodeId` 每次拍新快照都会 clear ⇒ 只有最新那份的 uid 有效。
    // 旧快照留在 prompt 里，模型照着它的 e1 去点会**静默点到另一个元素**。
    const results = readResults(buildZaiContinuationPrompt('任务', [
      snapshotExecution('browser_click', '<OLD> e1 = 提交订单'),
      snapshotExecution('browser_click', '<OLD2> e1 = 取消订单'),
      snapshotExecution('browser_snapshot', '<NEWEST> e1 = 下一步'),
    ], ['browser_click', 'browser_snapshot']));

    // 最新那份保正文
    expect(results[2]!.detail).toContain('<NEWEST>');
    expect(results[2]!.windowed).toBeUndefined();
    // 更早的两份：正文丢掉、带 windowed 标记
    expect(results[0]!.windowed).toBe(true);
    expect(results[1]!.windowed).toBe(true);
    expect(results[0]!.detail).toBeUndefined();
    expect(results[1]!.detail).toBeUndefined();
    expect(JSON.stringify(results.slice(0, 2))).not.toContain('<OLD');
  });

  it('recognizes an action snapshot too, not just browser_snapshot', () => {
    // ⚠️ 判 `output` 的形状而不是工具名 —— `includeSnapshotAfterActions` 默认开着，
    // 所以 `browser_click` 也会带快照。按工具名判会漏掉这一整类。
    const results = readResults(buildZaiContinuationPrompt('任务', [
      snapshotExecution('browser_click', '<STALE>'),
      snapshotExecution('browser_click', '<FRESH>'),
    ], ['browser_click']));

    expect(results[0]!.windowed).toBe(true);
    expect(results[1]!.detail).toContain('<FRESH>');
  });

  it('does not compress anything when results carry no snapshot', () => {
    // 反向用例：shell_exec 那类结果里没有快照 ⇒ 窗口内全部保完整。
    const results = readResults(buildZaiContinuationPrompt('任务', [
      execution({ name: 'shell_exec', result: { ok: true, summary: 'a', detail: 'd1' } }),
      execution({ name: 'shell_exec', result: { ok: true, summary: 'b', detail: 'd2' } }),
    ], ['shell_exec']));

    expect(results.every((entry) => entry.windowed === undefined)).toBe(true);
    expect(results.every((entry) => entry.detail !== undefined)).toBe(true);
  });

  it('bounds the summary of a full-detail entry too', () => {
    // ⚠️ **完整档的 summary 原来完全没有上界** —— 压缩档有 400 的 clamp，完整档没有。
    // 本地工具的 summary 是我们自己生成的固定串，但 MCP 那条路径的来自服务端。
    // 没有这条 clamp 时，「压缩摘要」这件事对完整档不成立（实测 2000 字原样进 prompt）。
    const results = readResults(buildZaiContinuationPrompt('任务', [
      execution({ name: 'shell_exec', result: { ok: true, summary: 'y'.repeat(2_000), detail: 'd' } }),
    ], ['shell_exec']));

    expect(results[0]!.windowed, '这条在窗口内、没有快照 ⇒ 走完整档').toBeUndefined();
    expect((results[0]!.summary as string).length).toBeLessThan(600);
  });

  it('keeps an old snapshot compressed even when it falls inside the recency window', () => {
    // ⚠️ **两条规则叠加**：窗口内（最近 4 条）但含旧快照 ⇒ 仍压缩。
    const executions = [
      snapshotExecution('browser_snapshot', '<FIRST>'),
      execution({ name: 'shell_exec', result: { ok: true, summary: 's', detail: 'd' } }),
      snapshotExecution('browser_snapshot', '<SECOND>'),
      execution({ name: 'shell_exec', result: { ok: true, summary: 's2', detail: 'd2' } }),
    ];
    const results = readResults(buildZaiContinuationPrompt('任务', executions, ['browser_snapshot', 'shell_exec']));

    expect(results).toHaveLength(4);
    // 全部 4 条都在窗口内，但只有第二份快照（index 2）保正文。
    expect(results[0]!.windowed).toBe(true);
    expect(results[2]!.detail).toContain('<SECOND>');
    expect(results[1]!.detail).toBe('d');
    expect(results[3]!.detail).toBe('d2');
  });
});

describe('zai continuation prompt windows long tool result lists', () => {
  const many = (count: number) => Array.from(
    { length: count },
    (_, index) => execution({
      name: `shell_exec`,
      result: {
        ok: true,
        summary: `第 ${index + 1} 步完成`,
        detail: `detail-${index + 1}-${'x'.repeat(500)}`,
        output: { step: index + 1 },
      },
    }),
  );

  it('keeps every entry in full detail while the list fits the window', () => {
    const results = readResults(
      buildZaiContinuationPrompt('task', many(ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW), ['shell_exec']),
    );
    expect(results).toHaveLength(ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW);
    expect(results.every((entry) => entry.detail !== undefined)).toBe(true);
    expect(results.some((entry) => entry.windowed === true)).toBe(false);
  });

  it('compresses the oldest entries once the list exceeds the window', () => {
    const window = ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW;
    const results = readResults(
      buildZaiContinuationPrompt('task', many(window + 2), ['shell_exec']),
    );

    expect(results).toHaveLength(window + 2);
    // 最早的 2 条被压缩：丢掉 detail / output，打上 windowed 标记。
    expect(results.slice(0, 2).map((entry) => entry.windowed)).toEqual([true, true]);
    expect(results.slice(0, 2).every((entry) => entry.detail === undefined)).toBe(true);
    expect(results.slice(0, 2).every((entry) => entry.output === undefined)).toBe(true);
    // 最近 window 条保完整。
    expect(results.slice(2).every((entry) => entry.windowed === undefined)).toBe(true);
    expect(results.slice(2).every((entry) => entry.detail !== undefined)).toBe(true);
  });

  it('keeps ok and summary on compressed entries so failures stay visible', () => {
    const window = ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW;
    const executions = [
      failingExecution(),
      ...many(window),
    ];
    const [oldest] = readResults(
      buildZaiContinuationPrompt('task', executions, ['shell_exec']),
    );

    expect(oldest).toMatchObject({
      tool: 'shell_exec',
      ok: false,
      windowed: true,
      error: { code: 'spawn_failed', retryable: true },
    });
  });

  it('bounds the compressed summary so a long one cannot reintroduce the growth', () => {
    const window = ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW;
    const longSummary = execution({ result: { ok: true, summary: 'y'.repeat(2_000) } });
    const results = readResults(
      buildZaiContinuationPrompt('task', [longSummary, ...many(window)], ['shell_exec']),
    );
    expect((results[0]!.summary as string).length).toBeLessThan(600);
  });

  it('applies the same window to the nudge prompt', () => {
    const window = ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW;
    const prompt = buildZaiNudgePrompt('task', 'text', many(window + 1), 1, ['shell_exec']);
    const results = readResults(prompt, 'tool_results_so_far');

    expect(results).toHaveLength(window + 1);
    expect(results[0]!.windowed).toBe(true);
    expect(results[1]!.windowed).toBeUndefined();
  });
});
