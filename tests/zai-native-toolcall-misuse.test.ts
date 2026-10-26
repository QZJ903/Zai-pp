import { afterEach, describe, expect, it } from 'vitest';
import { installZaiFetchHook, updateZaiHookState } from '../core/zai/fetch-hook';
import type { ZaiResponseCompletePayload } from '../core/zai/fetch-hook';

/**
 * 误用检测：把本地工具写进 agent 原生 `tool_call` 的那一轮要能被认出来。
 *
 * ⚠️ **判据是 `delta_name` 落在本请求的模型可见目录里** —— 服务端自己的 tool_call
 * （`delta_name: "Bash"` 这类沙箱工具）是**正常流量**，不能按「出现 tool_call 相位」判。
 * 这一组把两种流量都喂进去，守的就是这条边界。
 */

const COMPLETION_URL = 'https://chat.z.ai/api/v2/chat/completions?requestId=r1&user_id=u1';
const REQUEST_BODY = JSON.stringify({
  model: 'glm-5.3',
  messages: [{ role: 'user', content: '提问' }],
  signature_prompt: '提问',
});

/** 造一条 SSE 帧。 */
function frame(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type: 'chat:completion', data })}\n`;
}

const TOOL_CALL_SANDBOX = frame({
  phase: 'tool_call',
  delta_name: 'Bash',
  metadata: { tool_call_id: 'call_a', type: 'function' },
});

const TOOL_CALL_LOCAL = frame({
  phase: 'tool_call',
  delta_name: 'skill_draft_create',
  metadata: { tool_call_id: 'call_b', type: 'function' },
});

/**
 * 真机抓包一：`delta_name` 带着模型自造的 XML 尾巴（闭合标签是 `</arg_value>`，
 * 不在我们的任何提示词里），`delta_arguments` 未闭合，**整轮没有 `tool_response`**。
 *
 * ⚠️⚠️ 这一帧是判据从「整串相等」改成边界匹配的**唯一理由** —— 别删。
 */
const TOOL_CALL_CAPTURED_A = frame({
  phase: 'tool_call',
  delta_name: 'shell_status>\n{}\n</arg_value>',
  delta_arguments: '{',
  metadata: { tool_call_id: 'call_captured_a', type: 'function' },
});

/** 真机抓包二：同样的尾巴，`delta_arguments` 完整，后面跟 `sandbox:status` 与服务端回执。 */
const TOOL_CALL_CAPTURED_B = frame({
  phase: 'tool_call',
  delta_name: 'shell_status>{}</arg_value>',
  delta_arguments: '{}',
  metadata: { tool_call_id: 'call_captured_b', type: 'function' },
});

/**
 * 抓包二里服务端的回执 —— ⚠️ **`tool_name` 也被原样回显成那串垃圾**，
 * 所以「改读服务端回执拿干净名字」这条路不成立（见 `matchCatalogToolName` 的说明）。
 */
const TOOL_RESPONSE_CAPTURED_B = frame({
  phase: 'tool_response',
  delta_content: 'tool call failed: shell_status>{}</arg_value>',
  tool_name: 'shell_status>{}</arg_value>',
  status: 'error',
  metadata: { is_error: true, tool_call_id: 'call_captured_b' },
});

const USAGE = frame({
  phase: 'other',
  usage: { prompt_tokens: 39692, completion_tokens: 1502, total_tokens: 41194 },
});

const DONE = frame({ phase: 'done', done: true });

const TOOL_RESPONSE_ERROR = frame({
  phase: 'tool_response',
  delta_content: 'tool call failed: skill_draft_create',
  tool_name: 'skill_draft_create',
  status: 'error',
  metadata: { is_error: true, tool_call_id: 'call_b' },
});

const ANSWER = frame({ phase: 'answer', delta_content: '好的。' });

const originalFetch = window.fetch;

afterEach(() => {
  window.fetch = originalFetch;
});

interface HookRun {
  complete: ZaiResponseCompletePayload | null;
}

/**
 * 装 hook 并跑一轮。
 *
 * `toolNames` 传 `undefined` 表示**未增广**（那条路径不判误用）；
 * 传数组表示本请求实际注入的模型可见目录。
 */
async function runTurn(
  frames: string[],
  toolNames: readonly string[] | undefined,
): Promise<HookRun> {
  let complete: ZaiResponseCompletePayload | null = null;
  updateZaiHookState({
    toolDescriptorNames: new Set<string>(),
    onRequestBody: async (body, id) => ({
      body,
      requestId: id,
      ...(toolNames === undefined ? {} : { toolDescriptorNames: [...toolNames] }),
    }),
    onHeadersCaptured: () => undefined,
    onToolCall: () => undefined,
    onUsageSnapshot: () => undefined,
    onHtmlChallenge: () => undefined,
    onRequestTerminal: () => undefined,
    onResponseComplete: (payload) => { complete = payload; },
    onHistoryToolRecords: () => undefined,
  });

  const body = frames.join('');
  const stubFetch = async (): Promise<Response> => new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  window.fetch = stubFetch as unknown as typeof window.fetch;
  const uninstall = installZaiFetchHook();
  try {
    const response = await window.fetch(COMPLETION_URL, { method: 'POST', body: REQUEST_BODY });
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
  } finally {
    uninstall();
  }
  return { complete };
}

describe('native tool_call misuse detection', () => {
  it('records a local tool name that arrives through the native tool_call phase', async () => {
    const run = await runTurn([TOOL_CALL_LOCAL, TOOL_RESPONSE_ERROR], ['skill_draft_create']);
    expect(run.complete?.misusedNativeToolNames).toEqual(['skill_draft_create']);
  });

  it('ignores the server own sandbox tool calls', async () => {
    // ⚠️ **这是正常流量** —— agent 每轮联网都会发。按「出现 tool_call」判会每次都误报。
    const run = await runTurn([TOOL_CALL_SANDBOX, ANSWER], ['skill_draft_create']);
    expect(run.complete?.misusedNativeToolNames).toBeUndefined();
  });

  it('ignores tool_call frames when the request was not augmented', async () => {
    // 未增广时拿不到「本轮注入了哪些本地工具」，判下去会把沙箱工具误报成本地工具。
    const run = await runTurn([TOOL_CALL_LOCAL], undefined);
    expect(run.complete?.misusedNativeToolNames).toBeUndefined();
  });

  it('deduplicates repeated frames for the same misused tool', async () => {
    const run = await runTurn(
      [TOOL_CALL_LOCAL, TOOL_CALL_LOCAL, TOOL_RESPONSE_ERROR],
      ['skill_draft_create'],
    );
    expect(run.complete?.misusedNativeToolNames).toEqual(['skill_draft_create']);
  });

  it('leaves a normal turn untouched', async () => {
    const run = await runTurn([ANSWER], ['skill_draft_create']);
    expect(run.complete?.misusedNativeToolNames).toBeUndefined();
    expect(run.complete?.assistantText).toBe('好的。');
  });

  it('a misused turn carries an empty assistant text', async () => {
    // ⚠️ 这条是首轮纠错的**前提**：`tool_call` / `tool_response` 两个相位都被挖掉，
    // 所以这一轮没有任何可执行内容 —— 不纠错的话就是一次静默失败。
    const run = await runTurn([TOOL_CALL_LOCAL, TOOL_RESPONSE_ERROR], ['skill_draft_create']);
    expect(run.complete?.assistantText).toBe('');
  });

  it('detects the misuse in a real captured turn whose delta_name carries an XML tail', async () => {
    // 抓包一：`tool_call` → `usage` → `done`，**没有 `tool_response`、没有 `answer`**。
    // 整串相等判据在这种帧上一条都命中不了（这正是纠错链曾经整条失效的原因）。
    const run = await runTurn(
      [TOOL_CALL_CAPTURED_A, USAGE, DONE],
      ['shell_status', 'shell_exec'],
    );
    expect(run.complete?.misusedNativeToolNames).toEqual(['shell_status']);
    // 用户看到「模型不回复」的那一轮：没有任何可执行正文。
    expect(run.complete?.assistantText).toBe('');
  });

  it('detects the misuse even though the server echoes the polluted name back', async () => {
    // 抓包二：服务端回执的 `tool_name` 同样是那串垃圾 ⇒ 检测只能靠 `tool_call` 帧本身。
    const run = await runTurn(
      [TOOL_CALL_CAPTURED_B, USAGE, TOOL_RESPONSE_CAPTURED_B],
      ['shell_status', 'shell_exec'],
    );
    expect(run.complete?.misusedNativeToolNames).toEqual(['shell_status']);
  });

  it('does not mistake a sandbox tool with an XML tail for a local one', async () => {
    // 沙箱工具同样可能带尾巴 —— 它不在本轮目录里，不该被误判成本地工具。
    const sandboxWithTail = frame({
      phase: 'tool_call',
      delta_name: 'Bash>{}</arg_value>',
      delta_arguments: '{}',
      metadata: { tool_call_id: 'call_d', type: 'function' },
    });
    const run = await runTurn([sandboxWithTail, ANSWER], ['skill_draft_create']);
    expect(run.complete?.misusedNativeToolNames).toBeUndefined();
  });
});
