/**
 * z.ai 续跑 prompt 构建。
 *
 * 与 glm 版 buildContinuationPrompt 的关键区别：**不重灌工具目录**。
 * 续跑是 DOM 注入让页面自己发的（captcha 墙），工具目录只需要在首条消息注入一次，
 * 续跑 prompt 保持紧凑：original_task + tool_results + 一行工具名提醒。
 *
 * ⚠️ **沙箱措辞必须分模式** —— chat 模式没有服务端沙箱，说「别用沙箱工具」是防
 * 模型凭空造出沙箱工具名；而 **agent 模式的服务端沙箱是原生通路**
 * （首条消息的 `prompt.sandboxHostSection` 明确要求中间处理用沙箱工具、只有涉及
 * 用户本机时才输出本地工具 XML）。在 agent 模式继续喊「别用沙箱工具」会与那段
 * 直接冲突，模型要么困惑、要么把本该走沙箱的活全推给本地 shell。
 *
 * ⚠️⚠️ **真正的判据是「排他措辞」，不止「别用沙箱」那一句** —— 凡是把 XML 工具标签
 * 说成全称唯一通道的句子（「**只**输出可执行 XML 工具标签」「必须**直接**输出工具 XML」），
 * 在 agent 模式都会把沙箱通道一起否掉。所以这里按模式分叉的不是某一个词，而是**整类
 * 断言**：chat 可以排他（那里 XML 确实是唯一通道），agent 必须收窄成「本地工具如何表达」。
 *
 * ⚠️ **本文件不重复交代两套工具的分工** —— 「中间处理走沙箱、涉及本机才用本地工具」
 * 那条规则在 `prompt.sandboxHostSection` 里、且每轮都注入。这里再讲一遍就是两处定义
 * 同一条规则，将来必然漂移。续跑与 nudge 只需要**不否定它**。
 */

import type { ToolError, ToolExecutionRecord } from '../types';

export const ZAI_INLINE_AGENT_MAX_STEPS = 25;
export const ZAI_CONTINUATION_DELAY_MS = 2_500;
export const ZAI_INLINE_AGENT_MAX_NUDGES = 8;

/**
 * 最近多少条工具结果按**完整字段**渲染；更早的压缩成有界摘要。
 *
 * 续跑每一轮都会把整个 `toolExecutions` 重新发一遍，所以不加窗口时
 * 上下文随步数**线性增长**（25 步上限下实测约 90KB，其中大头是每次调用的
 * detail 与 output）。窗口化之后稳定在常数级（约 18KB）。
 */
export const ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW = 4;

/**
 * 续跑轮识别：带 `<original_task>`，且带 `<tool_results>` 或 `<tool_results_so_far>`。
 *
 * 两个标签都要认：`buildZaiContinuationPrompt` 用 `<tool_results>`，
 * `buildZaiNudgePrompt` 用 `<tool_results_so_far>`。漏认后者会把 nudge 轮当成原生轮，
 * 于是新起一个 `taskId` 为 null 的续跑循环覆盖掉原循环，原循环再也无人推进，
 * 自动化任务收不到终态、一直挂在「运行中」。
 */
export function isZaiContinuationPrompt(content: string): boolean {
  if (!content.includes('<original_task>')) return false;
  return content.includes('<tool_results>') || content.includes('<tool_results_so_far>');
}

const ORIGINAL_TASK_MAX_CHARS = 8_000;
const NUDGE_PREVIOUS_TEXT_MAX_CHARS = 4_000;
const TOOL_DETAIL_MAX_CHARS = 4_000;
const TOOL_OUTPUT_MAX_CHARS = 8_000;
const COMPRESSED_SUMMARY_MAX_CHARS = 400;
const TOOL_ERROR_MESSAGE_MAX_CHARS = 400;

export interface ZaiContinuationPromptOptions {
  /**
   * 本轮是不是 agent 模式。决定沙箱措辞（见文件头说明）。
   * 缺省按 chat 处理 —— 与 `core/zai/mode.ts` 的失败方向一致（读不到就按 chat）。
   */
  isAgent?: boolean;
}

export function buildZaiContinuationPrompt(
  originalTask: string,
  executions: readonly ToolExecutionRecord[],
  toolNames: readonly string[],
  options?: ZaiContinuationPromptOptions,
): string {
  const hasFailures = executions.some((execution) => !execution.result.ok);
  const isAgent = options?.isAgent === true;

  return [
    '以下是工具续跑任务刚刚执行的工具结果。请像真正的 Agent 一样，基于原始任务和这些工具结果继续推进。',
    '如果结果已经足够，请输出最终结论；只有确实需要更多信息、验证或文件修改时才继续调用工具。',
    renderContinueInstruction(isAgent),
    renderToolReminder(toolNames, isAgent),
    '',
    '<original_task>',
    clamp(originalTask, ORIGINAL_TASK_MAX_CHARS),
    '</original_task>',
    // 失败恢复只在真有失败时加 —— 无条件加会让模型在一切正常时也去翻 error 字段。
    ...(hasFailures ? [renderFailureRecovery()] : []),
    '',
    '<tool_results>',
    JSON.stringify(renderWindowedToolResults(executions), null, 2),
    '</tool_results>',
  ].filter(Boolean).join('\n');
}

/**
 * 「怎么继续」那一条。**排他措辞按模式分叉**（见文件头说明）。
 *
 * chat 模式 XML 是唯一通道，可以说「只输出」；agent 模式还有服务端沙箱这条原生通路，
 * 同一个「只」会把沙箱一并否掉，所以收窄成「**本地**工具调用必须输出 XML」——
 * 对沙箱保持沉默，既不声称它存在、也不声称它不存在。
 */
function renderContinueInstruction(isAgent: boolean): string {
  const deliverables = '文件、HTML 页面与图表等交付物请直接用 Markdown 围栏代码块输出（如 ```html、```mermaid）。';
  return isAgent
    ? `不要要求用户点击继续，也不要输出伪工具调用 JSON；本地工具调用必须输出可执行 XML 工具标签。${deliverables}`
    : `不要要求用户点击继续，也不要输出伪工具调用 JSON；需要继续操作时只输出可执行 XML 工具标签。${deliverables}`;
}

/**
 * 工具名提醒。**措辞随模式变**（见文件头说明）。
 *
 * chat 模式要压住「沙箱工具」—— 那条通路在 chat 模式不存在，模型提它只会浪费轮次，
 * 所以说「只输出这些，别用沙箱工具」。
 *
 * agent 模式只列名字：两套通道的分工由 `prompt.sandboxHostSection` 负责，这里再交代一遍
 * 既是重复、又只能用排他措辞表达（「只输出这些」），反而与沙箱冲突。
 */
function renderToolReminder(toolNames: readonly string[], isAgent: boolean): string {
  if (toolNames.length === 0) return '';
  return isAgent
    ? `本轮可输出的本地工具标签：${toolNames.join(', ')}`
    : `本轮可用的本地工具标签（只输出这些，别用沙箱工具）：${toolNames.join(', ')}`;
}

function renderFailureRecovery(): string {
  return '至少一个工具执行失败。不要因为可恢复错误就停止；先阅读 summary/detail/error，并修正参数或改用合适的下一步继续完成任务。';
}

/**
 * 渲染工具结果：最近 {@link ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW} 条保完整字段，
 * 更早的压缩成有界摘要（丢掉 `detail` / `output` 这两个大头，`summary` 收到 400 字）。
 *
 * ⚠️ **压缩条目带 `windowed: true`** —— 让模型知道「这条是被裁过的」，而不是
 * 以为工具本来就没返回细节。
 */
function renderWindowedToolResults(executions: readonly ToolExecutionRecord[]) {
  if (executions.length <= ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW) {
    return executions.map(renderToolResult);
  }
  const older = executions.slice(0, -ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW);
  const recent = executions.slice(-ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW);
  return [
    ...older.map(renderCompressedToolResult),
    ...recent.map(renderToolResult),
  ];
}

function renderToolResult(execution: ToolExecutionRecord) {
  return {
    tool: execution.name,
    provider: execution.provider?.displayName,
    ok: execution.result.ok,
    summary: execution.result.summary,
    detail: clamp(execution.result.detail, TOOL_DETAIL_MAX_CHARS),
    // ⚠️ **失败原因必须给全** —— 只给 `ok: false` 时模型看不到错误码与可重试性，
    // 只能瞎猜参数，往往直接放弃。`details` 刻意丢掉（可能很大，且不是判据）。
    error: boundToolError(execution.result.error),
    output: clamp(
      execution.result.output === undefined
        ? undefined
        : JSON.stringify(execution.result.output),
      TOOL_OUTPUT_MAX_CHARS,
    ),
    truncated: execution.result.truncated === true,
  };
}

function renderCompressedToolResult(execution: ToolExecutionRecord) {
  return {
    tool: execution.name,
    provider: execution.provider?.displayName,
    ok: execution.result.ok,
    summary: clamp(execution.result.summary, COMPRESSED_SUMMARY_MAX_CHARS),
    error: boundToolError(execution.result.error),
    windowed: true,
    truncated: execution.result.truncated === true,
  };
}

function boundToolError(error: ToolError | undefined): ToolError | undefined {
  if (!error) return undefined;
  return {
    code: error.code,
    message: clamp(error.message, TOOL_ERROR_MESSAGE_MAX_CHARS) ?? '',
    retryable: error.retryable,
  };
}

function clamp(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return value;
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

/**
 * shouldNudge：判断模型是否「还有待办」。与 ds++ 的 shouldNudge 同源，
 * 这里是 z.ai 独立实现（自带中文话术正则，不依赖外部 locale 翻译上下文）。
 *
 * 判定模型回复末尾是否还有「接下来我要做 X」这类未完成的动作承诺：
 *  - 有 `<task_complete>` 信号 → 明确结束，不 nudge。
 *  - 文本为空 → 需要 nudge。
 *  - 末尾有「待办话术」且后面没有跟渲染产物 → 需要 nudge。
 */
const ZAI_PENDING_ACTION_RE = /(?:我(?:将|会|想|要|先|让|再|直接|现在|继续|尝试|开始|需要|还需要|仍需|打算|计划|马上|随后|稍后|先去|先来|接下来).{0,48}(?:调用|创建|编辑|检查|验证|生成|保存|尝试|搜索|获取|打开|执行|查看|访问|读取|抓取|下载|上传|修改|更新|删除|写入|分析|比对|比较|监控|查询|发送|提交|安装|启动|停止|清理|转换|解析|提取|汇总|整理|核对|核实|扫描|截屏|渲染)|(?:接下来|下一步|然后|让我|先让我).{0,48}(?:调用|创建|编辑|检查|验证|生成|保存|尝试|搜索|获取|打开|执行|查看|访问|读取|抓取|下载|上传|修改|更新|删除|写入|分析|比对|比较|监控|查询|发送|提交|安装|启动|停止|清理|转换|解析|提取|汇总|整理|核对|核实|扫描|截屏|渲染)|(?:(?:现在|这就|马上|随后|稍后|立即|立刻|先|直接))?(?:为|帮)(?:你|您)(?:创建|生成|制作|输出|编写|绘制|渲染)(?!了|好|完|成|过|的)|(?:i(?:'ll| will|'m| am|'d| would| want to| should| have to| (?:still\s+)?need to|'m going to| am going to|'m about to| am about to|'ve got to| have got to)|let me|let's|next,? (?:i|we)|we(?:'ll| will| need to| can)|(?:my|the) next step is to).{0,64}(?:call|create|edit|inspect|validate|generate|save|try|search|fetch|open|run|browse|read|check|look|use|verify|test|download|write|update|review|analyze|extract|query|send|post|investigate|monitor|compare|install|start|stop|convert|parse|list|collect|request|retry|scroll|click|type|navigate))/gi;

// ⚠️ **捕获组两侧不能加 `\s*`** —— `<task_complete>\s*([\s\S]*?)\s*<\/task_complete>`
// 会在「开标签后跟连续空白、且无配对闭合标签」时灾难性回溯（`\s*` 与 `[\s\S]*?\s*`
// 量词重叠；实测 4,000 空白 6.4s / 8,000 空白 >20s）。输入是 `complete.assistantText`
// 全文，来自桥消息、没有长度上限。去掉这两个 `\s*` 后是近线性（100 万空白 0.1ms）。
// 对 `.test()` 的布尔结果**完全等价**（穷举 8.7 万条 + 随机 30 万条零差异），
// 因为这里只用 `.test()`、不取捕获组，且无 `g` flag。守卫见
// `tests/zai-nudge-task-complete-redos.test.ts`。
const ZAI_TASK_COMPLETE_RE = /<task_complete>([\s\S]*?)<\/task_complete>/;
const ZAI_NUDGE_DECISION_TAIL_MAX_CHARS = 600;
const ZAI_PENDING_ACTION_AFTER_MAX_CHARS = 80;

export function shouldNudgeZai(
  originalTask: string,
  executions: readonly ToolExecutionRecord[],
  visibleText: string,
): boolean {
  void originalTask;
  void executions;
  if (ZAI_TASK_COMPLETE_RE.test(visibleText)) return false;
  if (!visibleText) return true;
  return hasPendingActionAtTail(getNudgeDecisionText(visibleText));
}

function getNudgeDecisionText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ZAI_NUDGE_DECISION_TAIL_MAX_CHARS
    ? trimmed.slice(-ZAI_NUDGE_DECISION_TAIL_MAX_CHARS)
    : trimmed;
}

function hasPendingActionAtTail(text: string): boolean {
  const matches = [...text.matchAll(ZAI_PENDING_ACTION_RE)];
  const lastMatch = matches[matches.length - 1];
  if (!lastMatch || lastMatch.index === undefined) return false;
  const afterPendingAction = text.slice(lastMatch.index + lastMatch[0].length).trim();
  if (afterPendingAction.length > ZAI_PENDING_ACTION_AFTER_MAX_CHARS) return false;
  if (afterPendingAction.includes('```')) return false;
  return true;
}

/** 构建 nudge prompt：上一轮没输出可执行工具 XML，提醒模型「要么继续调工具、要么 task_complete 结束」。 */
export function buildZaiNudgePrompt(
  originalTask: string,
  previousText: string,
  executions: readonly ToolExecutionRecord[],
  nudgeCount: number,
  toolNames: readonly string[] = [],
  options?: ZaiContinuationPromptOptions,
): string {
  const isAgent = options?.isAgent === true;

  return [
    // ⚠️ chat 的「没输出 XML 就等于续跑无法继续」在 agent 模式**是事实错误** ——
    // 那里沙箱调用本来就不产生 XML，所以要并列「两条通道都没观察到」。
    isAgent
      ? '上一轮回复没有包含可执行的本地工具 XML，也没有观察到服务端沙箱工具的调用，因此续跑无法继续执行。'
      : '上一轮回复没有包含任何可执行工具 XML，因此自动化续跑无法继续执行。',
    '请根据原始任务和工具结果二选一：',
    isAgent
      ? '1. 如果任务仍未完成，本轮必须给出下一步的可执行调用：本地工具输出可执行 XML 工具标签，服务端沙箱工具直接调用（无需 XML）。'
      : '1. 如果任务仍未完成，本轮必须直接输出下一步可执行工具 XML。',
    '2. 如果任务已经完成，输出 <task_complete>{"summary":"..."}</task_complete>。文件、HTML 页面与图表等交付物用 Markdown 围栏代码块输出（如 ```html、```mermaid）。',
    `这是第 ${nudgeCount} 次无工具调用纠偏。`,
    renderToolReminder(toolNames, isAgent),
    '',
    '<original_task>',
    clamp(originalTask, ORIGINAL_TASK_MAX_CHARS),
    '</original_task>',
    '',
    '<previous_assistant_text>',
    clamp(previousText, NUDGE_PREVIOUS_TEXT_MAX_CHARS),
    '</previous_assistant_text>',
    '',
    '<tool_results_so_far>',
    // 与续跑轮共用同一个渲染 —— 两处各写一份会让窗口化只在一半链路上生效。
    JSON.stringify(renderWindowedToolResults(executions), null, 2),
    '</tool_results_so_far>',
  ].filter(Boolean).join('\n');
}