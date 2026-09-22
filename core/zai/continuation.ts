/**
 * z.ai 续跑 prompt 构建。
 *
 * 与 glm 版 buildContinuationPrompt 的关键区别：**不重灌工具目录**。
 * 续跑是 DOM 注入让页面自己发的（captcha 墙），工具目录只需要在首条消息注入一次，
 * 续跑 prompt 保持紧凑：original_task + tool_results + 一行工具名提醒。
 */

import type { ToolExecutionRecord } from '../types';

export const ZAI_INLINE_AGENT_MAX_STEPS = 25;
export const ZAI_CONTINUATION_DELAY_MS = 2_500;
export const ZAI_INLINE_AGENT_MAX_NUDGES = 8;

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

export function buildZaiContinuationPrompt(
  originalTask: string,
  executions: readonly ToolExecutionRecord[],
  toolNames: readonly string[],
): string {
  const results = executions.map((execution) => ({
    tool: execution.name,
    ok: execution.result.ok,
    summary: execution.result.summary,
    detail: clamp(execution.result.detail, 4_000),
    output: clamp(
      execution.result.output === undefined
        ? undefined
        : JSON.stringify(execution.result.output),
      8_000,
    ),
  }));

  const toolReminder =
    toolNames.length > 0
      ? `本轮可用的本地工具标签（只输出这些，别用沙箱工具）：${toolNames.join(', ')}`
      : '';

  return [
    '以下是工具续跑任务刚刚执行的工具结果。请像真正的 Agent 一样，基于原始任务和这些工具结果继续推进。',
    '如果结果已经足够，请直接输出最终结论；只有确实需要更多信息、验证或文件修改时才继续调用工具。',
    '不要要求用户点击继续，也不要输出伪工具调用 JSON；需要继续操作时只输出可执行 XML 工具标签。',
    toolReminder,
    '',
    '<original_task>',
    clamp(originalTask, ORIGINAL_TASK_MAX_CHARS),
    '</original_task>',
    '',
    '<tool_results>',
    JSON.stringify(results, null, 2),
    '</tool_results>',
  ].filter(Boolean).join('\n');
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

const ZAI_TASK_COMPLETE_RE = /<task_complete>\s*([\s\S]*?)\s*<\/task_complete>/;
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
): string {
  const results = executions.map((execution) => ({
    tool: execution.name,
    ok: execution.result.ok,
    summary: execution.result.summary,
    detail: clamp(execution.result.detail, 4_000),
  }));

  const toolReminder =
    toolNames.length > 0
      ? `本轮可用的本地工具标签（只输出这些，别用沙箱工具）：${toolNames.join(', ')}`
      : '';

  return [
    '上一轮回复没有包含可执行的工具 XML，续跑无法继续。',
    '请根据原始任务和工具结果二选一：',
    '1. 如果任务还没完成，这一轮必须直接输出下一个可执行的 XML 工具标签。',
    '2. 如果任务已经完成，输出 <task_complete>{"summary":"..."}</task_complete>。',
    `这是第 ${nudgeCount} 次无工具纠正。`,
    toolReminder,
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
    JSON.stringify(results, null, 2),
    '</tool_results_so_far>',
  ].filter(Boolean).join('\n');
}