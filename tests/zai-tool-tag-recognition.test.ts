import { afterEach, describe, expect, it } from 'vitest';
import { installZaiFetchHook, updateZaiHookState } from '../core/zai/fetch-hook';
import type { ZaiDetectedToolCall } from '../core/zai/fetch-hook';
import { ZAI_CONTENT_TO_MAIN } from '../core/zai/messages';

/**
 * 工具 XML 标签的识别名单 = **本请求注入提示词的那一份**（增广结果回传的
 * `toolDescriptorNames`），而不是全局 `hookState.toolDescriptorNames`（「最后一次同步」）。
 *
 * 分叉的后果是静默的：用户刚加 MCP 工具、`TOOL_DESCRIPTORS_UPDATED` 广播还没落地时，
 * 提示词列了 A、识别器不认 A ⇒ 模型调它**静默不执行**（不报错、不失败、界面上什么都看不出）。
 *
 * ⚠️ 三条契约分开守，缺一条都有绕过路径：
 * ① 本请求名单**优先于**全局快照；
 * ② 增广成功但目录为空（`[]`）**不得回落**全局 —— 否则会识别出本请求提示词里根本没列的标签；
 * ③ 只有 `undefined`（未增广：增广失败 / 结果非法）才回落全局，
 *    否则老会话里已有的 XML 会一个都识别不出来。
 */

const COMPLETION_URL = 'https://chat.z.ai/api/v2/chat/completions?requestId=r1&user_id=u1';
const REQUEST_BODY = JSON.stringify({
  model: 'x-preview-l',
  messages: [{ role: 'user', content: '提问' }],
  signature_prompt: '提问',
});
const DONE_FRAME = 'data: {"type":"chat:completion","data":{"phase":"done","done":true}}\n';
const SKILL_BLOCK = '<skill_draft_create>{"title":"x"}</skill_draft_create>';
const MEMORY_BLOCK = '<memory_save>{"text":"y"}</memory_save>';

function answerFrame(text: string): string {
  return `data: ${JSON.stringify({
    type: 'chat:completion',
    data: { phase: 'answer', delta_content: text },
  })}\n`;
}

const originalFetch = window.fetch;
afterEach(() => {
  window.fetch = originalFetch;
});

interface HookRun {
  toolCalls: ZaiDetectedToolCall[];
  /** 页面实际读到的字节（拼成一串）。 */
  pageText: string;
}

/**
 * 装 hook 并跑完一轮 completion。
 *
 * `perRequest` 传 `undefined` 表示**未增广**（`onRequestBody` 只回 body、不带名单）；
 * 传数组表示增广成功、本请求注入的就是这份目录（空数组 = 增广成功但目录为空）。
 */
async function runTurn(
  frames: string[],
  opts: { hookSnapshot: string[]; perRequest: string[] | undefined },
): Promise<HookRun> {
  const toolCalls: ZaiDetectedToolCall[] = [];
  updateZaiHookState({
    toolDescriptorNames: new Set(opts.hookSnapshot),
    onRequestBody: async (body, requestId) => ({
      body,
      requestId,
      ...(opts.perRequest === undefined
        ? {}
        : { toolDescriptorNames: [...opts.perRequest] }),
    }),
    onHeadersCaptured: () => undefined,
    onToolCall: (call) => { toolCalls.push(call); },
    onUsageSnapshot: () => undefined,
    onHtmlChallenge: () => undefined,
    onRequestTerminal: () => undefined,
    onResponseComplete: () => undefined,
    onHistoryToolRecords: () => undefined,
  });

  const payload = frames.join('');
  window.fetch = (async () => new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })) as unknown as typeof window.fetch;

  const uninstall = installZaiFetchHook();
  let pageText = '';
  try {
    const response = await window.fetch(COMPLETION_URL, { method: 'POST', body: REQUEST_BODY });
    const decoder = new TextDecoder();
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) pageText += decoder.decode(value, { stream: true });
      }
      pageText += decoder.decode();
    }
  } finally {
    uninstall();
  }
  return { toolCalls, pageText };
}

describe('tool tag recognition uses the per-request descriptor names', () => {
  it('recognizes a tool that only the per-request list knows about', async () => {
    // 广播还没落地：全局快照是空的，而本轮提示词已经列了 skill_draft_create。
    const run = await runTurn([answerFrame(SKILL_BLOCK), DONE_FRAME], {
      hookSnapshot: [],
      perRequest: ['skill_draft_create'],
    });
    expect(run.toolCalls.map((call) => call.name)).toEqual(['skill_draft_create']);
  });

  it('does not recognize a tool that only the stale global snapshot knows about', async () => {
    // 增广成功、目录为空 ⇒ 必须按空目录处理。回落全局会让「提示词没列的工具」被执行。
    const run = await runTurn([answerFrame(SKILL_BLOCK), DONE_FRAME], {
      hookSnapshot: ['skill_draft_create'],
      perRequest: [],
    });
    expect(run.toolCalls).toEqual([]);
  });

  it('falls back to the global snapshot when the request was not augmented', async () => {
    // 未增广（增广失败 / 结果非法）⇒ 拿不到本请求名单，回落全局；
    // 否则老会话里已有的 XML 会一个都识别不出来，而失败方向是静默的。
    const run = await runTurn([answerFrame(SKILL_BLOCK), DONE_FRAME], {
      hookSnapshot: ['skill_draft_create'],
      perRequest: undefined,
    });
    expect(run.toolCalls.map((call) => call.name)).toEqual(['skill_draft_create']);
  });

  it('strips a tool XML block whose name only the per-request list carries', async () => {
    // ⚠️ 名字必须**不在内置基线**（`ZAI_BUILTIN_HISTORY_TOOL_NAMES`）里 ——
    // 基线里的名字无论名单如何都会被剥，用它测不出剥离器有没有读本请求名单。
    const mcpBlock = '<mcp__demo__echo>{"x":1}</mcp__demo__echo>';
    const run = await runTurn([answerFrame(`我看看。${mcpBlock}`), DONE_FRAME], {
      hookSnapshot: [],
      perRequest: ['mcp__demo__echo'],
    });
    expect(run.toolCalls.map((call) => call.name)).toEqual(['mcp__demo__echo']);
    expect(run.pageText).not.toContain('mcp__demo__echo');
  });
});

/**
 * 跨世界那一跳：主世界解 `AUGMENT_REQUEST_BODY_RESULT` 的 `toolDescriptorNames`，
 * 送进 hook 状态、并让识别器用上它。
 *
 * ⚠️ 这段只能端到端跑 —— 把字段名写错（`toolNamez`）、或把校验与回传整段删掉，
 * 两边都不会报错：`decodeAugmentResult` 读到 `undefined` 按缺省处理，形状校验照样通过。
 *
 * ⚠️ 整组共用一个模块实例（`main()` 重复调用会重复挂 `window` 监听 ⇒ 一条消息应答两次），
 * 所以下面两轮跑在同一个 hook 上，靠 `postMessage` 的捕获窗口分段断言。
 */
describe('the main world forwards the augment result names into the hook state', () => {
  // WXT 的 `defineContentScript` 只在构建期存在 —— 测试里补一个桩才能加载入口模块。
  (globalThis as Record<string, unknown>).defineContentScript = (definition: unknown) => definition;

  it('recognizes names that only arrived through the bridge, and rejects a malformed list', async () => {
    const wire = answerFrame(`${SKILL_BLOCK}${MEMORY_BLOCK}`) + DONE_FRAME;
    // ⚠️ 必须先换底层 fetch、再装 hook —— hook 包的是「装的那一刻」的 `window.fetch`。
    window.fetch = (async () => new Response(wire, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof window.fetch;

    const module = await import('../entrypoints/zai-main-world.content');
    await (module.default as { main: () => Promise<void> }).main();

    /** 本轮主世界发回隔离世界的消息。 */
    let posted: Record<string, unknown>[] = [];
    /** 本轮隔离世界回给主世界的增广结果（按轮次换）。 */
    let augmentResult: Record<string, unknown> = {};

    window.postMessage = ((message: Record<string, unknown>) => {
      posted.push(message);
      if (message.type === 'AUGMENT_REQUEST_BODY') {
        window.dispatchEvent(new MessageEvent('message', {
          source: window,
          data: {
            source: ZAI_CONTENT_TO_MAIN,
            type: 'AUGMENT_REQUEST_BODY_RESULT',
            id: message.id,
            ok: true,
            result: augmentResult,
          },
        }));
      }
    }) as unknown as typeof window.postMessage;

    const drain = async (): Promise<void> => {
      const response = await window.fetch(COMPLETION_URL, { method: 'POST', body: REQUEST_BODY });
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
    };
    const recognizedNames = (): (string | undefined)[] => posted
      .filter((message) => message.type === 'TOOL_CALL')
      .map((message) => (message.data as { name?: string } | undefined)?.name);

    // 第一轮：名单只经桥过来（全局快照里一个都没有）⇒ 两个标签都该被识别。
    updateZaiHookState({ toolDescriptorNames: new Set<string>() });
    augmentResult = {
      body: REQUEST_BODY,
      requestId: 'r1',
      toolDescriptorNames: ['skill_draft_create', 'memory_save'],
    };
    await drain();
    expect(recognizedNames()).toEqual(['skill_draft_create', 'memory_save']);

    // 第二轮：名单里混进非字符串 ⇒ `decodeAugmentResult` 判否、整条当「没增广」，
    // 于是回落全局快照（这里只有 memory_save）—— skill_draft_create 不该被识别。
    posted = [];
    updateZaiHookState({ toolDescriptorNames: new Set(['memory_save']) });
    augmentResult = {
      body: REQUEST_BODY,
      requestId: 'r1',
      toolDescriptorNames: ['skill_draft_create', 42],
    };
    await drain();
    expect(recognizedNames()).toEqual(['memory_save']);
  });
});

/**
 * **「什么算一个工具块」只能有一份口径。**
 *
 * ⚠️⚠️ 通知侧曾经是一条手写正则 `<name\b[^>]*>[\s\S]*?</name>`，而**解析**与**剥离**
 * 走的是 `core/zai/tool-xml.ts` 的线性扫描器。两者对边缘输入的判法不同：
 *
 * | 形态 | 手写正则 | 线性扫描器 |
 * |---|---|---|
 * | `<shell_exec id="1">{…}</shell_exec>` | 认 | **不认**（`>` 前只允许空白） |
 * | `< shell_exec >{…}</ shell_exec>` | **不认** | 认 |
 *
 * 后果分别是：
 * - 「正则认、扫描器不认」⇒ 发了一条 `TOOL_CALL`，下游解析不出来，**只在 console 留一行**；
 * - 「扫描器认、正则不认」⇒ XML 被剥掉了、却**没有 `TOOL_CALL` 发出** ⇒ 静默不执行。
 *
 * ⇒ 本组钉的是「三处口径一致」，**不是**「让三处都去认」：
 * 带属性那一档两边都该**不认**，带空白那一档两边都该**认**。
 */
describe('tool block recognition agrees with the parser and the stripper', () => {
  it('does not recognize a tag with attributes, and leaves it visible', async () => {
    // 扫描器（解析 / 剥离）不认 `id="1"` ⇒ 通知侧也不该认，且页面该看得见这段 XML。
    const block = '<shell_exec id="1">{"command":"ls"}</shell_exec>';
    const run = await runTurn([answerFrame(`前${block}后`), DONE_FRAME], {
      hookSnapshot: ['shell_exec'],
      perRequest: ['shell_exec'],
    });
    expect(run.toolCalls).toEqual([]);
    expect(run.pageText).toContain('<shell_exec id="1">');
  });

  it('recognizes a whitespace-padded tag, and strips it from the page stream', async () => {
    // 扫描器认 `< shell_exec >` ⇒ 通知侧也必须认，否则「剥了但不执行」。
    const block = '< shell_exec >{"command":"ls"}</ shell_exec>';
    const run = await runTurn([answerFrame(`前${block}后`), DONE_FRAME], {
      hookSnapshot: ['shell_exec'],
      perRequest: ['shell_exec'],
    });
    expect(run.toolCalls.map((call) => call.name)).toEqual(['shell_exec']);
    expect(run.pageText).not.toContain('shell_exec');
  });

  it('recognizes a plain block and strips it (control)', async () => {
    const block = '<shell_exec>{"command":"ls"}</shell_exec>';
    const run = await runTurn([answerFrame(`前${block}后`), DONE_FRAME], {
      hookSnapshot: ['shell_exec'],
      perRequest: ['shell_exec'],
    });
    expect(run.toolCalls.map((call) => call.name)).toEqual(['shell_exec']);
    expect(run.pageText).not.toContain('shell_exec');
  });
});
