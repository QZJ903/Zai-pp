import { describe, expect, it } from 'vitest';
import {
  buildZaiContinuationPrompt,
  buildZaiNudgePrompt,
  isZaiContinuationPrompt,
  ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW,
} from '../core/zai/continuation';
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

describe('zai continuation prompt recognition', () => {
  it('recognizes the continuation template', () => {
    const prompt = buildZaiContinuationPrompt('do the thing', NO_EXECUTIONS, ['shell_exec']);
    expect(isZaiContinuationPrompt(prompt)).toBe(true);
  });

  it('recognizes the nudge template', () => {
    const prompt = buildZaiNudgePrompt('do the thing', 'I will read the file.', NO_EXECUTIONS, 1, []);
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
describe('zai continuation prompt sandbox wording follows the mode', () => {
  const toolNames = ['shell_exec', 'local_file_read'];

  it('tells chat mode not to use sandbox tools', () => {
    const prompt = buildZaiContinuationPrompt('task', NO_EXECUTIONS, toolNames, { isAgent: false });
    expect(prompt).toContain('别用沙箱工具');
    expect(prompt).toContain('需要继续操作时只输出可执行 XML 工具标签');
  });

  it('narrows the continue instruction to local tools in agent mode', () => {
    const prompt = buildZaiContinuationPrompt('task', NO_EXECUTIONS, toolNames, { isAgent: true });
    expect(prompt).not.toContain('别用沙箱工具');
    expect(prompt).toContain('本地工具调用必须输出可执行 XML 工具标签');
    // ⚠️ 「只输出可执行 XML 工具标签」是对「需要继续操作」的全称排他断言 ——
    // agent 模式下沙箱也是「继续操作」的一种，这句话会把沙箱通道一并否掉。
    expect(prompt).not.toContain('只输出可执行 XML 工具标签');
  });

  it('lists only the local tool tags in agent mode without re-explaining the sandbox', () => {
    const prompt = buildZaiContinuationPrompt('task', NO_EXECUTIONS, toolNames, { isAgent: true });
    // 两套通道的分工由每轮注入的 sandboxHostSection 负责，这里不重复交代
    // （重复就是两处定义同一条规则，必然漂移），所以只列名字。
    expect(prompt).toContain('本轮可输出的本地工具标签：shell_exec, local_file_read');
  });

  it('defaults to chat wording when the mode is unknown', () => {
    // 与 core/zai/mode.ts 的失败方向一致：读不到就按 chat。
    const prompt = buildZaiContinuationPrompt('task', NO_EXECUTIONS, toolNames);
    expect(prompt).toContain('别用沙箱工具');
  });

  it('applies the same mode wording to the nudge prompt', () => {
    const agent = buildZaiNudgePrompt('task', 'text', NO_EXECUTIONS, 1, toolNames, { isAgent: true });
    const chat = buildZaiNudgePrompt('task', 'text', NO_EXECUTIONS, 1, toolNames, { isAgent: false });
    expect(agent).not.toContain('别用沙箱工具');
    expect(chat).toContain('别用沙箱工具');
  });

  it('does not equate "no XML" with "cannot continue" in agent mode', () => {
    // ⚠️ agent 模式下沙箱调用本来就不产生 XML —— 只说「没输出 XML」是事实错误，
    // 必须并列「两条通道都没观察到」。
    const agent = buildZaiNudgePrompt('task', 'text', NO_EXECUTIONS, 1, toolNames, { isAgent: true });
    const chat = buildZaiNudgePrompt('task', 'text', NO_EXECUTIONS, 1, toolNames, { isAgent: false });

    expect(agent).toContain('也没有观察到服务端沙箱工具的调用');
    expect(agent).not.toContain('必须直接输出下一步可执行工具 XML');
    expect(agent).toContain('服务端沙箱工具直接调用（无需 XML）');
    // chat 保持原口径（那里 XML 确实是唯一通道）。
    expect(chat).toContain('必须直接输出下一步可执行工具 XML');
    expect(chat).not.toContain('也没有观察到服务端沙箱工具的调用');
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
