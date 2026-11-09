import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolPanelController, type ToolPanelDependencies } from '../core/zai/tool-panel';
import {
  formatZaiToolDetail,
  formatZaiToolStatus,
  getZaiMessageOwnText,
  listZaiAssistantMessages,
  messageCarriesZaiAnchorId,
  readZaiMessageId,
  resolveZaiResponseHost,
  zaiMessageAnchorClass,
  ZAI_RESPONSE_HOST_SELECTOR,
} from '../core/zai/tool-block-adapter';
import type { ToolCardResult, ToolExecutionRecord } from '../core/types';

const CHAT_SESSION = 'chat-1';
const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

/** 造一条「像真机」的助手消息：wrapper(message-uuid) > .chat-assistant > #response-content-container > .markdown-prose */
function buildRealisticMessage(uuid: string, text = '正文内容足够长用于锚定'): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = `flex w-full message-${uuid} gap-4 relative svelte-1qscqw6`;
  const bubble = document.createElement('div');
  bubble.className = 'chat-assistant w-full min-w-full markdown-prose svelte-1qscqw6';
  const inner = document.createElement('div');
  const host = document.createElement('div');
  host.id = 'response-content-container';
  host.className = 'flex relative flex-col w-full';
  const prose = document.createElement('div');
  prose.className = 'markdown-prose';
  const thinking = document.createElement('div');
  thinking.className = 'w-full thinking-chain-container my-4 svelte-bugqhi';
  thinking.textContent = '思考过程';
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  prose.append(thinking, paragraph);
  host.appendChild(prose);
  inner.appendChild(host);
  bubble.appendChild(inner);
  wrapper.appendChild(bubble);
  document.body.appendChild(wrapper);
  return bubble;
}

/**
 * 造一条**不带 `message-<uuid>` 锚点**的助手消息。
 *
 * ⚠️⚠️ **它是「只能靠签名合流」那一格的载体，不是省事的写法** —— 实时腿的块 id 是
 * 「有锚点用 `history:<uuid>`、没有才退回 `live:<requestId>`」，而历史腿恒为
 * `history:<uuid>`。**气泡带 uuid 时两条腿同 id、走 `refresh` 那条路**，
 * 于是「实时腿的签名对不对」这件事**根本参与不到判定里**（签名只在跨 id 合流时用）。
 * ⇒ 凡是要验「`raw` 有没有真的登记进去」的用例，**都必须用这个 helper**。
 */
function buildMessageWithoutAnchor(text = '这是一段足够长的助手正文内容'): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'flex w-full gap-4';   // ⚠️ 刻意不带 message-<uuid>
  const bubble = document.createElement('div');
  bubble.className = 'chat-assistant w-full min-w-full markdown-prose';
  const host = document.createElement('div');
  host.id = 'response-content-container';
  const prose = document.createElement('div');
  prose.className = 'markdown-prose';
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  prose.appendChild(paragraph);
  host.appendChild(prose);
  bubble.appendChild(host);
  wrapper.appendChild(bubble);
  document.body.appendChild(wrapper);
  return bubble;
}

/**
 * 让恢复编排层的调度跑完。
 *
 * ⚠️⚠️ **不能只等一次宏任务** —— 编排层的重试间隔是 250ms（生产值），
 * 而「首跑发现宿主不可用 → 排重试」之后，**新记录到达时那次 `schedule` 会被
 * 已在飞的 timer 挡回**（`if (timer !== null) return`）⇒ 必须让那个 timer 真的到期。
 * 第一版只等一次 `setTimeout(…, 0)`，于是「合流后有没有重画」这件事根本没被观察到。
 * ⚠️ 测试里把 `retryDelayMs` 压到 1ms（生产是 250ms，那是与「页面重建 DOM 需要多久」
 * 相称的值，缩短会把重试次数在 DOM 就绪前耗光）。
 * ⚠️ **这里是真实墙钟等待**（不是 `vi.useFakeTimers()`）：面板的调度链上挂着
 * `requestAnimationFrame` 与 `queueMicrotask`，把它们全换成假时钟要连编排层与
 * observer 一起接管，收益不抵风险。等待量（20ms）比链上最长的间隔（1ms）高一个量级，
 * 连跑多轮无抖动 —— 若将来要收紧，改法是换假时钟，**不是把 20 调小**。
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

function statusLabels() {
  return { running: 'RUNNING', executed: 'EXECUTED', failed: 'FAILED' };
}

function deps(overrides: Partial<ToolPanelDependencies> = {}): ToolPanelDependencies {
  return {
    statusLabels,
    formatTitle: (count) => `${count} tools`,
    getChatSessionId: () => 'chat-1',
    loadToolHistory: async () => [],
    observeRoot: () => document.body,
    retryDelayMs: 1,
    document,
    ...overrides,
  };
}

function execution(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    callId: 'xml:aaa',
    name: 'shell_exec',
    result: { ok: true, summary: 'EXECUTED' } as ToolCardResult,
    ...overrides,
  };
}

/**
 * 本用例创建过的控制器，收尾统一 `dispose`。
 *
 * ⚠️⚠️ **不 dispose 会跨用例污染**：编排层的重试定时器还挂着，下一个用例已经把 DOM
 * 清空、它却会把块**重新挂回新 DOM**；而 observer 也还在监听。第一版没做这一步，
 * 于是单独跑每条都绿、一起跑就红。
 */
const livePanels: { dispose: () => void }[] = [];

function makePanel(overrides: Partial<ToolPanelDependencies> = {}) {
  const panel = createToolPanelController(deps(overrides));
  livePanels.push(panel);
  return panel;
}

afterEach(() => {
  while (livePanels.length > 0) livePanels.pop()!.dispose();
  document.body.innerHTML = '';
  document.getElementById('zpp-tool-block-css')?.remove();
  vi.restoreAllMocks();
});

describe('zai adapter: site facts', () => {
  it('reads and matches the anchor through one shared class-name builder', () => {
    // ⚠️⚠️ **「抽锚点」与「比锚点」必须同源**：
    // `readZaiMessageId` 用 `[0-9a-f-]{36}` 的正则抽（要有形状才敢认），
    // 而定位那条腿是**逐字比类名**（id 从记录里来、不必再猜形状）。
    // 两处各写一遍 `message-${id}` 时，服务端 id 若不是标准 uuid 形态
    // ⇒ 一边认得出、一边认不得，**而失败是静默的**（锚点腿整条失效）。
    // 现在两边共用 `zaiMessageAnchorClass`，这条用例把两个入口一起钉住。
    const message = buildRealisticMessage(UUID_A);
    expect(readZaiMessageId(message)).toBe(UUID_A);
    expect(messageCarriesZaiAnchorId(message, UUID_A)).toBe(true);
    expect(zaiMessageAnchorClass(UUID_A)).toBe(`message-${UUID_A}`);

    // 非 36 位 id：**抽不到**（正则不认形状）但**比得到**（逐字比）——
    // 这是有意的差异，写下来免得以后有人「统一」成一条判据。
    const oddWrapper = document.createElement('div');
    oddWrapper.className = 'flex w-full message-msg-abc';
    const oddBubble = document.createElement('div');
    oddBubble.className = 'chat-assistant';
    oddWrapper.appendChild(oddBubble);
    document.body.appendChild(oddWrapper);
    expect(readZaiMessageId(oddBubble)).toBeNull();
    expect(messageCarriesZaiAnchorId(oddBubble, 'msg-abc')).toBe(true);

    // 空 id 一律不认（`message-` 前缀会匹配到一堆别的类）。
    expect(messageCarriesZaiAnchorId(message, '')).toBe(false);

    // ⚠️ **「锚点不存在」必须是 false** —— 少了这一条，判据写成恒真也能全绿
    //（变异验证抓出来的：把循环体改成 `return true` 时，只有这条会红）。
    const other = buildRealisticMessage(UUID_B);
    expect(messageCarriesZaiAnchorId(other, UUID_A)).toBe(false);
    expect(messageCarriesZaiAnchorId(message, UUID_B)).toBe(false);
  });

  it('uses the stable id as the response host', () => {
    const bubble = buildRealisticMessage(UUID_A);
    expect(resolveZaiResponseHost(bubble)?.id).toBe('response-content-container');
    expect(ZAI_RESPONSE_HOST_SELECTOR).toBe('#response-content-container');
  });

  it('reads the message uuid from the wrapper, not the bubble', () => {
    const bubble = buildRealisticMessage(UUID_A);
    // ⚠️ 锚点在 wrapper 上、bubble 自己不带 —— 这条钉住「要往上找几层」。
    expect(bubble.classList.contains(`message-${UUID_A}`)).toBe(false);
    expect(readZaiMessageId(bubble)).toBe(UUID_A);
  });

  it('returns null for a message without the anchor', () => {
    const bubble = document.createElement('div');
    bubble.className = 'chat-assistant';
    expect(readZaiMessageId(bubble)).toBeNull();
  });

  it('excludes our injected UI and the thinking block from the own text', () => {
    const bubble = buildRealisticMessage(UUID_A, '真正的正文');
    const host = resolveZaiResponseHost(bubble)!;
    const panel = document.createElement('div');
    panel.className = 'zpp-tool-block';
    panel.textContent = 'shell_exec 已执行 详情内容';
    host.appendChild(panel);

    const own = getZaiMessageOwnText(bubble);
    // ⚠️⚠️ 面板里的文本会进 `textContent` ⇒ 不排除的话，「按内容片段定位」这条腿
    // 会让已挂过的消息因为包含自己而再次命中（上游那条腿漏了这一步）。
    expect(own).toContain('真正的正文');
    expect(own).not.toContain('shell_exec');
    // 思考过程同样排除（它与正文无关，不排除会在多条消息上乱命中）。
    expect(own).not.toContain('思考过程');
  });

  it('lists assistant messages in DOM order', () => {
    buildRealisticMessage(UUID_A);
    buildRealisticMessage('22222222-2222-2222-2222-222222222222');
    expect(listZaiAssistantMessages()).toHaveLength(2);
  });

  it('maps execution state to the three status labels', () => {
    const labels = statusLabels();
    expect(formatZaiToolStatus(execution({ pending: true }), labels)).toBe('RUNNING');
    expect(formatZaiToolStatus(execution(), labels)).toBe('EXECUTED');
    expect(formatZaiToolStatus(
      execution({ result: { ok: false, summary: 'x' } as ToolCardResult }),
      labels,
    )).toBe('FAILED');
  });

  it('extracts a readable line out of a JSON error detail', () => {
    expect(formatZaiToolDetail({
      ok: false,
      summary: 'failed',
      detail: JSON.stringify({ error: { message: '权限不足' } }),
    } as ToolCardResult)).toBe('failed\n权限不足');
  });

  it('keeps the raw detail when it is not a recognizable error shape', () => {
    expect(formatZaiToolDetail({
      ok: false,
      summary: 'failed',
      detail: '{"weird":true}',
    } as ToolCardResult)).toBe('failed\n{"weird":true}');
  });

  it('appends detail and output after the summary (three-part formula)', () => {
    // ⚠️ 口径来自上游 inline-agent 控制台的 `getToolResultDetailText`：
    // summary + detail + `output: JSON` 三段**无条件拼接**。
    // 旧口径（`.zpp-tool-block` 的「有 detail 就不看 output」）下，正文放在
    // `output` 而 `detail` 只有一句概述的工具，正文永远进不了面板。
    expect(formatZaiToolDetail({
      ok: true, summary: '已获取 url', detail: '页面长度 3323 字符',
      output: { url: 'u', content: '正文' },
    } as ToolCardResult)).toBe(
      '已获取 url\n页面长度 3323 字符\noutput: {"url":"u","content":"正文"}',
    );
    // 只有 output 时（detail 为空）也要给出来。
    expect(formatZaiToolDetail({
      ok: true, summary: 's', output: { a: 1 },
    } as ToolCardResult)).toBe('s\noutput: {"a":1}');
  });

  it('drops the error segment when it would repeat the reason already shown', () => {
    // ⚠️ **去重是这条改动的承重行为**：`finalizePending` 构造的 `error.message`
    // 恰好等于 `detail`（同一个字符串），不去重就是同一句话在面板里出现两遍。
    // 判据按**归一后的文本**比（去首尾标点与多余空白），不按字面 ——
    // `extractReadableError` 抽出来的句子常常少一个句号。
    const formatted = formatZaiToolDetail({
      ok: false,
      summary: 'failed',
      detail: '未完成（回答被中断）',
      error: { code: 'tool_call_incomplete', message: '未完成（回答被中断）', retryable: false },
    } as ToolCardResult);
    expect(formatted).toBe('failed\n未完成（回答被中断）');
    expect(formatted).not.toContain('error: ');

    // 差异只在标点时同样算同一句。
    const punctuation = formatZaiToolDetail({
      ok: false,
      summary: 'failed',
      detail: '{"error":{"message":"权限不足"}}',
      error: { code: 'x', message: '权限不足。', retryable: false },
    } as ToolCardResult);
    expect(punctuation).not.toContain('error: ');

    // 真正不同的两句仍要各出现一次（宁可多一行，也不吞掉有差异的信息）。
    const differing = formatZaiToolDetail({
      ok: false,
      summary: 'failed',
      detail: '连接超时',
      error: { code: 'x', message: '宿主未安装', retryable: false },
    } as ToolCardResult);
    expect(differing).toContain('连接超时');
    expect(differing).toContain('error: 宿主未安装');
  });

  it('extracts a readable sentence from a JSON detail and never dumps the error object', () => {
    // ⚠️ **失败分支保留「从 JSON detail 里抽可读错误」**（上游 `.dpp-tool-block` 的
    // 祖先行为）—— 抽取只在第三方 MCP 把 JSON 塞进 content 文本时命中。
    // ⚠️ 本例里 `error.message` 恰好等于 detail 原文（MCP 失败即如此）⇒ `error:` 段被去重，
    // 面板里只剩抽出来的那句。**这不是丢信息**，同一个串本来就在上面。
    const error = { code: 'mcp_tool_result_error', message: '{"error":{"message":"权限不足"}}', retryable: false };
    const formatted = formatZaiToolDetail({
      ok: false, summary: 'failed',
      detail: JSON.stringify({ error: { message: '权限不足' } }),
      error,
    } as ToolCardResult);
    expect(formatted).toContain('权限不足');
    // ⚠️ 面板里只显示 `error.message` —— 整对象序列化（`{code,retryable,details}`）
    // 对用户没有信息量，还占掉详情框的大半。`code` 仍留在存储里供排查。
    expect(formatted).not.toContain('mcp_tool_result_error');
    expect(formatted).not.toContain('"retryable"');
    expect(formatted.startsWith('failed\n权限不足')).toBe(true);
  });

  it('truncates the detail and output segments with an explicit marker', () => {
    // ⚠️ 第三方 MCP 的 `output.content` 可达数万字符 —— 不截就是一条把面板撑爆。
    const formatted = formatZaiToolDetail({
      ok: true,
      summary: 's',
      detail: 'D'.repeat(3_000),
      output: { content: 'C'.repeat(6_000) },
    } as ToolCardResult);
    // 两段各截一次 ⇒ 标记出现两次（缺标记时读的人会以为这就是全部）。
    expect(formatted.split('...[truncated]')).toHaveLength(3);
    // detail 段截到 2000（前面还有 summary 那一行）。
    expect(formatted.startsWith(`s\n${'D'.repeat(2_000)}\n...[truncated]\n`)).toBe(true);
    // output 段截到 4000，且是最后一段。
    const outputSegment = formatted.slice(formatted.indexOf('output: '));
    expect(outputSegment.endsWith(`\n...[truncated]`)).toBe(true);
    expect(outputSegment.length).toBe('output: '.length + 4_000 + '\n...[truncated]'.length);
  });
});

describe('tool panel: live leg (L1)', () => {
  it('shows a running row when a tool starts', () => {
    const bubble = buildRealisticMessage(UUID_A);
    const panel = makePanel();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    expect(panel.snapshot().livePending).toBe(1);

    // 渲染要等编排层跑一轮（它有自己的调度）。
    panel.snapshot();
    expect(panel.snapshot().livePending).toBe(1);
    expect(listZaiAssistantMessages()).toContain(bubble);
  });

  it('replaces the running row with the real result', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    panel.completeToolCall('req-1', execution(), CHAT_SESSION);
    await settle();
    expect(panel.snapshot().livePending).toBe(0);

    const names = [...document.querySelectorAll('.zpp-tool-block-item-name')].map((el) => el.textContent);
    expect(names).toEqual(['shell_exec']);
    const statuses = [...document.querySelectorAll('.zpp-tool-block-item-status')].map((el) => el.textContent);
    expect(statuses).toEqual(['EXECUTED']);
  });

  it('matches the pending row by name when the call ids disagree', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    // ⚠️ 两侧的 callId 计算口径不同（一个是 TOOL_CALL 的原始 XML、一个是解析后的
    // 单块哈希）⇒ 必须能退回按名字匹配，否则「同一个工具显示两遍、一条永远转圈」。
    panel.beginToolCall('req-1', { callId: 'xml:from-tool-call', name: 'shell_exec' }, CHAT_SESSION);
    panel.completeToolCall('req-1', execution({ callId: 'xml:from-parser' }), CHAT_SESSION);
    await settle();

    expect(document.querySelectorAll('.zpp-tool-block-item')).toHaveLength(1);
    expect(panel.snapshot().livePending).toBe(0);
  });

  it('does not create a duplicate row for the same call id', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    panel.completeToolCall('req-1', execution(), CHAT_SESSION);
    await settle();
    expect(document.querySelectorAll('.zpp-tool-block-item')).toHaveLength(1);
  });

  it('keeps pending rows that the final result does not cover', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    panel.beginToolCall('req-1', { callId: 'xml:bbb', name: 'web_search' }, CHAT_SESSION);
    // 只有 shell_exec 有结果 ⇒ web_search 那行仍应是「执行中」。
    panel.rememberExecutions('req-1', [execution()], '正文', CHAT_SESSION);
    await settle();

    expect(panel.snapshot().livePending).toBe(1);
    const statuses = [...document.querySelectorAll('.zpp-tool-block-item-status')].map((el) => el.textContent);
    expect(statuses).toContain('RUNNING');
    expect(statuses).toContain('EXECUTED');
  });
});

describe('tool panel: pending finalize (todo 64)', () => {
  it('turns a running row into a failed one', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    panel.finalizePending('req-1', 'FAILED', '未完成（回答被中断）');
    await settle();

    expect(panel.snapshot().livePending).toBe(0);
    const status = document.querySelector('.zpp-tool-block-item-status');
    expect(status?.textContent).toBe('FAILED');
    expect(status?.className).toContain('error');
    const detail = document.querySelector('.zpp-tool-block-item-detail');
    // 三段式：summary + 原因 + `error:` 段。⚠️ 但 `finalizePending` 构造的 `error.message`
    // **恰好等于** `detail`（同一个字符串）⇒ `formatZaiToolDetail` 会去重、不重复列一段。
    expect(detail?.textContent).toContain('FAILED');
    expect(detail?.textContent).toContain('未完成（回答被中断）');
    expect(detail?.textContent).not.toContain('error: ');
    expect((detail as HTMLElement)?.hidden).toBe(true);
  });

  it('is a no-op when there is nothing pending', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    // 绝大多数轮次都没有 pending —— 不该为这种情况产生任何写入。
    panel.finalizePending('req-unknown', 'FAILED', 'x');
    expect(document.querySelector('.zpp-tool-block')).toBeNull();
  });

  it('drains every session on dispose', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    panel.beginToolCall('req-2', { callId: 'xml:bbb', name: 'web_search' }, CHAT_SESSION);
    panel.finalizeAllPending('FAILED', 'interrupted');
    await settle();

    expect(panel.snapshot().livePending).toBe(0);
  });

  /**
   * ⚠️⚠️ **`dispose` 必须先把「执行中」收成失败再拆** —— 扩展重载 / 卸载时内容脚本
   * 被拆除，但它挂进页面的 DOM 还在。只 `clear()` 容器的话，页面上留几行**永远转圈**
   * 的「执行中」，而这一轮再也不会有人来收尾。
   */
  it('turns running rows into failed ones on dispose', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel({ drainTexts: () => ({ failureSummary: 'FAILED', message: 'interrupted' }) });
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    await settle();
    expect(document.querySelector('.zpp-tool-block-item-status')?.textContent).toBe('RUNNING');

    panel.dispose();

    // 拆完之后页面上那行必须是「失败」，不是「执行中」。
    const status = document.querySelector('.zpp-tool-block-item-status');
    expect(status?.textContent).toBe('FAILED');
    expect(status?.className).toContain('error');
  });

  it('falls back to dropping the rows when no drain texts are injected', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    await settle();

    // 不注入文案 ⇒ 退化成改造前的行为（直接丢弃），不该抛。
    expect(() => panel.dispose()).not.toThrow();
  });
});

describe('tool panel: live session lifecycle', () => {
  it('releases the per-request container once the turn is sealed', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    panel.completeToolCall('req-1', execution(), CHAT_SESSION);
    await settle();
    expect(panel.snapshot().liveSessions).toBe(1);

    panel.sealTurn('req-1');
    await settle();

    // ⚠️⚠️ **一轮结束就释放容器** —— 否则这个表按 requestId 无界增长
    // （一次 25 步自动化 = 25 条，每条带 detail ≤4k + output ≤8k），
    // 而出口只有换会话 / 页面重载。
    expect(panel.snapshot().liveSessions).toBe(0);
  });

  it('keeps other in-flight turns when one is sealed', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    panel.beginToolCall('req-2', { callId: 'xml:bbb', name: 'web_search' }, CHAT_SESSION);
    await settle();

    panel.sealTurn('req-1');
    await settle();

    // 另一轮还在跑 ⇒ 它的容器必须留着（否则那一轮的结果就丢了）。
    expect(panel.snapshot().liveSessions).toBe(1);
    expect(panel.snapshot().livePending).toBe(1);
  });

  /**
   * ⚠️⚠️ **一条「只有 raw、没有画行」的轮次也必须能被收尾释放。**
   *
   * 真形态：`noteToolCallRaw` 会 `getOrCreateSession`（它只登记合流签名的一半，
   * **不调 `publishLiveSession`**），所以 `recordIds` 是空的。若那之后整轮被打断
   * （`completeToolCall` / `rememberExecutions` 都没走到），留下的就是一个空壳。
   *
   * 判据：**「要不要 seal」与「释放条目」是两件事** —— 空壳没有块要收，但条目必须删，
   * 否则「按 requestId 无界增长」那一条等于没修。
   */
  it('releases an empty container that only ever registered a raw', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    // 只有 raw、没有 beginToolCall ⇒ recordIds 为空
    panel.noteToolCallRaw('req-orphan', { callId: 'xml:raw-only', raw: '<shell_exec>{}</shell_exec>' }, CHAT_SESSION);
    await settle();
    expect(panel.snapshot().liveSessions).toBe(1);

    panel.sealTurn('req-orphan');
    await settle();

    expect(panel.snapshot().liveSessions).toBe(0);
  });
});

describe('tool panel: block collapse state', () => {
  function blockOf(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.zpp-tool-block');
  }

  it('expands the block while the turn is in flight', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    panel.completeToolCall('req-1', execution(), CHAT_SESSION);
    await settle();

    // ⚠️ 在飞 ⇒ 展开（用户当场要看见在跑什么）—— 上游 `.dpp-tool-block`
    // 实时面板不传 `collapsed`（缺省展开），同口径。
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('false');
  });

  it('collapses the block once the turn is sealed', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    panel.completeToolCall('req-1', execution(), CHAT_SESSION);
    await settle();
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('false');

    panel.sealTurn('req-1');
    await settle();

    // ⚠️⚠️ **这是「跑 N 轮不再看到 N 大块」的关键**：一轮结束就收起，
    // 页面上留下的是一行块头。上游同口径（sealed group 收起）。
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('true');
  });

  it('collapses a restored block that never ran in this page session', async () => {
    buildRealisticMessage(UUID_A, '这是一段足够长的助手正文内容');
    const panel = makePanel();
    await panel.install();

    panel.rememberHistoryRecords([{
      messageId: UUID_A,
      parentMessageId: null,
      content: '这是一段足够长的助手正文内容',
      calls: [{ name: 'shell_exec', raw: '<shell_exec>{}</shell_exec>' }],
    }], 'chat-1');
    await settle();

    // ⚠️ 恢复（历史 / 存储腿）⇒ 收起。上游恢复面板传 `collapsed: true`，同口径。
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('true');
  });

  it('drops the previous session records and reloads the storage leg on session change', async () => {
    buildRealisticMessage(UUID_A, '这是一段足够长的助手正文内容');
    const loadToolHistory = vi.fn(async () => []);
    let sessionId = 'chat-1';
    const panel = makePanel({
      loadToolHistory,
      getChatSessionId: () => sessionId,
    });
    await panel.install();

    panel.rememberHistoryRecords([{
      messageId: UUID_A,
      parentMessageId: null,
      content: '这是一段足够长的助手正文内容',
      calls: [{ name: 'shell_exec', raw: '<shell_exec>{}</shell_exec>' }],
    }], 'chat-1');
    await settle();
    expect(panel.snapshot().records).toBe(1);
    const callsBefore = loadToolHistory.mock.calls.length;

    // 切到另一条会话。
    sessionId = 'chat-2';
    panel.handleSessionChange();
    await settle();

    // ⚠️⚠️ **旧会话的记录必须丢掉** —— 真机实测：不清的话它们会被兜底腿挂到
    // 新会话的消息上（旧会话的 web_fetch / web_search / shell_status 出现在新会话）。
    expect(panel.snapshot().records).toBe(0);
    // ⚠️ 且**顺序是「先清、再拉」**：反过来的话新拉到的会被紧接着的清空删掉。
    expect(loadToolHistory.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('keeps the records when the session id did not actually change', async () => {
    // ⚠️⚠️ 会话通知是 1 秒轮询驱动的，而页面刚加载时**必然**触发一次「假变化」
    // （上一次通知的会话 id 初值是 null）。那一刻若一律清空，`install()` 刚拉到的
    // 存储腿记录会连同 pending 一起被丢掉 ⇒ 面板只剩历史腿那份摘要
    // （没有详情、没有保存按钮），而且**不会自愈**（存储腿只在这两处拉）。
    buildRealisticMessage(UUID_A, '这是一段足够长的助手正文内容');
    const panel = makePanel({ getChatSessionId: () => 'chat-1' });
    await panel.install();

    panel.rememberHistoryRecords([{
      messageId: UUID_A,
      parentMessageId: null,
      content: '这是一段足够长的助手正文内容',
      calls: [{ name: 'shell_exec', raw: '<shell_exec>{}</shell_exec>' }],
    }], 'chat-1');
    await settle();
    expect(panel.snapshot().records).toBe(1);

    // 同一个会话 id 再通知一次（= 启动时那次假变化）。
    panel.handleSessionChange();
    await settle();

    expect(panel.snapshot().records, '会话没变 ⇒ 记录必须留着').toBe(1);
    expect(document.querySelectorAll('.zpp-tool-block-item-name')).toHaveLength(1);
  });

  it('does not render a tool that finishes after the user switched conversation', async () => {
    // ⚠️⚠️ **真机缺陷的回归守卫** —— 切走之后工具才跑完：
    // ① 面板不许把这一轮的记录盖上「新会话」的戳（会话由调用方给，不是此刻地址栏）；
    // ② 也不许拿新会话最后一条助手消息的 uuid 当锚点。
    // 判据是「这一轮冻结的会话 ≠ 当前会话 ⇒ 编排层的 `isRecordOnCurrentSession` 拒掉、
    // 什么都不画」。失败方向是「切走期间跑完的工具不显示」，刷新后由存储腿补上。
    buildRealisticMessage(UUID_A, '旧会话的助手正文内容足够长');
    buildRealisticMessage(UUID_B, '新会话的助手正文内容足够长');
    let sessionId = 'chat-1';
    const panel = makePanel({ getChatSessionId: () => sessionId });
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, 'chat-1');
    await settle();

    // 用户在工具跑完之前切到 chat-2。
    sessionId = 'chat-2';
    panel.handleSessionChange();
    await settle();

    // 工具这才跑完 —— 结果仍然属于 chat-1。
    panel.completeToolCall('req-1', execution(), 'chat-1');
    await settle();

    expect(document.querySelectorAll('.zpp-tool-block-item-name'), '切走期间跑完的工具不许画到当前会话上')
      .toHaveLength(0);
    expect(panel.snapshot().livePending).toBe(0);
  });

  it('renders the same tool normally when the conversation did not change', async () => {
    // 对照：不切会话时同一套调用必须照常渲染（防止上一条靠「永远不画」通过）。
    buildRealisticMessage(UUID_A, '助手正文内容足够长用于锚定');
    const panel = makePanel({ getChatSessionId: () => 'chat-1' });
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, 'chat-1');
    panel.completeToolCall('req-1', execution(), 'chat-1');
    await settle();

    const names = [...document.querySelectorAll('.zpp-tool-block-item-name')].map((el) => el.textContent);
    expect(names).toEqual(['shell_exec']);
  });

  it('drops records from another conversation but keeps the current one', async () => {
    // 真换会话时的判据是「记录自己冻结的 chatSessionId」—— 与当前会话严格相等才留。
    buildRealisticMessage(UUID_A, '这是一段足够长的助手正文内容');
    buildRealisticMessage(UUID_B, '另一条足够长的助手正文内容');
    let sessionId = 'chat-1';
    const panel = makePanel({ getChatSessionId: () => sessionId });
    await panel.install();

    panel.rememberHistoryRecords([{
      messageId: UUID_A,
      parentMessageId: null,
      content: '这是一段足够长的助手正文内容',
      calls: [{ name: 'shell_exec', raw: '<shell_exec>{}</shell_exec>' }],
    }], 'chat-1');
    await settle();

    sessionId = 'chat-2';
    panel.handleSessionChange();
    await settle();

    // 旧会话那条不匹配 ⇒ 丢掉；表里不残留。
    expect(panel.snapshot().records).toBe(0);
  });
});

describe('tool panel: history leg (L3) and storage leg (L2)', () => {
  it('renders a history record with a name-only summary', async () => {
    buildRealisticMessage(UUID_A, '这是一段足够长的助手正文内容');
    const panel = makePanel();
    await panel.install();

    panel.rememberHistoryRecords([{
      messageId: UUID_A,
      parentMessageId: null,
      content: '这是一段足够长的助手正文内容',
      calls: [{ name: 'shell_exec', raw: '<shell_exec>{}</shell_exec>' }],
    }], 'chat-1');
    // 编排层有自己的调度，手动跑一轮。
    await settle();

    const names = [...document.querySelectorAll('.zpp-tool-block-item-name')].map((el) => el.textContent);
    expect(names).toEqual(['shell_exec']);
    // ⚠️ 历史腿没有真实结果 ⇒ 只给「已执行」，不假装有结果。
    expect(document.querySelector('.zpp-tool-block-item-status')?.textContent).toBe('EXECUTED');
    // ⚠️ **没有详情的行不给开关**（死控件）—— 详情框在 DOM 里都不该出现。
    expect(document.querySelector('.zpp-tool-block-item-chevron')).toBeNull();
    expect(document.querySelector('.zpp-tool-block-item-detail')).toBeNull();
  });

  it('drops storage records from other conversations', async () => {
    buildRealisticMessage(UUID_A);
    const loadToolHistory = vi.fn(async () => [
      {
        id: 'h1',
        call: { name: 'shell_exec', raw: 'A', source: { chatSessionId: 'other-chat' } },
        result: { ok: true, summary: 'S' } as ToolCardResult,
        createdAt: 1,
      },
      {
        id: 'h2',
        call: { name: 'web_search', raw: 'B', source: { chatSessionId: 'chat-1' } },
        result: { ok: true, summary: 'S' } as ToolCardResult,
        createdAt: 2,
      },
    ]);
    const panel = makePanel({ loadToolHistory });
    await panel.install();

    // 只有本会话那条被收下 —— 宁可不显示，也不要跨会话乱挂。
    expect(panel.snapshot().records).toBe(1);
  });

  it('retries the storage read once, then stays silent when both attempts fail', async () => {
    buildRealisticMessage(UUID_A);
    const loadToolHistory = vi.fn(async () => { throw new Error('boom'); });
    const panel = makePanel({ loadToolHistory });
    // ⚠️ 读不到只是「没有真结果」，不该抛出去打断启动链 —— 但**必须先重试一次**：
    // 启动那一刻是最挤的窗口（页面刚刷新、后台可能冷启动、batch 同时在打），
    // 而这条链只在 install / 换会话时各跑一次，一次失败就再无机会。
    await expect(panel.install()).resolves.toBeUndefined();
    expect(loadToolHistory, '首次 + 一次重试').toHaveBeenCalledTimes(2);
    expect(panel.snapshot().records).toBe(0);
  });

  it('draws the real result when the retry succeeds', async () => {
    buildRealisticMessage(UUID_A, '这是一段足够长的助手正文内容');
    const raw = '<shell_exec>{"command":"ls"}</shell_exec>';
    let attempt = 0;
    const panel = makePanel({
      loadToolHistory: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('cold start');
        return [{
          id: 'h1',
          call: {
            id: 'xml:ls',
            name: 'shell_exec',
            raw,
            // ⚠️ 存储腿必须自带锚点才会被渲染（`resolveTarget` 对 storage 腿禁用兜底腿）。
            source: { chatSessionId: 'chat-1', assistantMessageId: UUID_A },
          },
          result: { ok: true, summary: '真实结果', detail: 'ls 的真实输出' } as ToolCardResult,
          createdAt: 5,
        }];
      },
    });
    await panel.install();
    await settle();

    // 重试救回来的那一批必须真的画出真结果（有 detail 才是真结果，不是历史腿的摘要）。
    expect(panel.snapshot().records).toBe(1);
    expect(document.querySelector('.zpp-tool-block-item-detail')?.textContent)
      .toContain('ls 的真实输出');
  });

  it('skips the storage leg entirely without a conversation id', async () => {
    const loadToolHistory = vi.fn(async () => []);
    const panel = makePanel({ getChatSessionId: () => null, loadToolHistory });
    await panel.install();
    expect(loadToolHistory).not.toHaveBeenCalled();
  });

  it('merges the storage leg into the history leg so the row gains a real result', async () => {
    buildRealisticMessage(UUID_A, '这是一段足够长的助手正文内容');
    const raw = '<shell_exec>{"command":"ls"}</shell_exec>';
    const panel = makePanel({
      loadToolHistory: async () => [{
        id: 'h1',
        // ⚠️ **`id` 是合流去重的首选键**（见 `unionExecutions`）—— 真机那个
        // 「用了好几次、刷新后只显示 1 次」的缺陷有一半就出在这个字段没被带上。
        call: { id: 'xml:ls', name: 'shell_exec', raw, source: { chatSessionId: 'chat-1' } },
        // ⚠️ 状态文案来自 `formatStatus`（按 locale 给的三档），**不是** `result.summary`
        // ⇒ 要区分「真结果」与「历史腿合成的摘要」，得看 **detail**（只有真结果才有）。
        result: { ok: true, summary: '真实结果', detail: 'ls 的真实输出' } as ToolCardResult,
        createdAt: 5,
      }],
    });
    await panel.install();

    panel.rememberHistoryRecords([{
      messageId: UUID_A,
      parentMessageId: null,
      content: '这是一段足够长的助手正文内容',
      calls: [{ name: 'shell_exec', raw }],
    }], 'chat-1');
    await settle();

    // 合流后只剩一条记录（不是两条），且**详情来自 storage 腿** ——
    // history 腿合成的摘要没有 detail，所以出现 detail 就证明真结果接上了。
    expect(document.querySelectorAll('.zpp-tool-block-item')).toHaveLength(1);
    const detail = document.querySelector('.zpp-tool-block-item-detail');
    expect(detail?.textContent).toContain('ls 的真实输出');
    // ⚠️ **整块重画保住展开态**：storage 腿的合流会再画一次，默认收起。
    expect((detail as HTMLElement)?.hidden).toBe(true);
    // 行内同时给出结果摘要（三段式的第一段就是它）。
    expect(document.querySelector('.zpp-tool-block-item-summary')?.textContent).toBe('真实结果');
  });

  it('mounts a storage record through its own anchor, without waiting for the history leg', async () => {
    // ⚠️⚠️ **存储腿自带锚点**（`call.source.assistantMessageId`，上游
    // `metadata.assistantMessageId` 同义）：有它就能**直接挂到那条消息上**，
    // 不必等历史腿来合流。
    // 这条用例**故意不投任何历史腿记录** —— 改造前存储腿没有锚点、
    // `resolveTarget` 又不给它用兜底腿 ⇒ 它**永远不渲染**（面板根本不出现）。
    buildRealisticMessage(UUID_A, '这是一段足够长的助手正文内容');
    const raw = '<shell_exec>{"command":"ls"}</shell_exec>';
    const panel = makePanel({
      loadToolHistory: async () => [{
        id: 'h1',
        call: {
          id: 'xml:ls',
          name: 'shell_exec',
          raw,
          source: { chatSessionId: 'chat-1', assistantMessageId: UUID_A },
        },
        result: { ok: true, summary: '真实结果', detail: 'ls 的真实输出' } as ToolCardResult,
        createdAt: 5,
      }],
    });
    await panel.install();
    await settle();

    // 没有历史腿也画出来了，而且行里是那条真结果。
    expect(document.querySelectorAll('.zpp-tool-block-item')).toHaveLength(1);
    expect(document.querySelector('.zpp-tool-block-item-summary')?.textContent).toBe('真实结果');
  });

  it('keeps every execution of a multi-call turn from the storage leg', async () => {
    // ⚠️⚠️ **真机缺陷的 tool-panel 层那一半**：一轮用了 3 次工具、刷新后只显示 1 次。
    // 存储腿是**一次调用一条记录**，合流做的是「并集」⇒ 去重键必须能区分三次调用。
    // 键优先用 `callId`（执行时算的 `xml:<hash>`）；**tool-panel 若不把 `item.call.id`
    // 传进去**，键就退化成「名字 + 摘要」，而同一个工具三次调用的摘要**是同一句话**
    // （「MCP 工具已执行」）⇒ 三次被合并成一次。
    // ⚠️ 这条守的是 tool-panel 的接线（`callId: item.call.id`），不是
    // `unionExecutions` 本身 —— 那个由 `tool-block-restore.test.ts` 守。
    buildRealisticMessage(UUID_A, '这是一段足够长的助手正文内容');
    const raws = [
      '<shell_exec>{"command":"a"}</shell_exec>',
      '<shell_exec>{"command":"b"}</shell_exec>',
      '<shell_exec>{"command":"c"}</shell_exec>',
    ];
    const panel = makePanel({
      loadToolHistory: async () => raws.map((raw, index) => ({
        id: `h${index}`,
        call: {
          id: `xml:${index}`,
          name: 'shell_exec',
          raw,
          source: { chatSessionId: 'chat-1' },
        },
        // ⚠️ 三次的摘要**逐字相同**（MCP 工具的 summary 是固定文案）。
        result: { ok: true, summary: 'MCP 工具已执行' } as ToolCardResult,
        createdAt: 5 + index,
      })),
    });
    await panel.install();

    panel.rememberHistoryRecords([{
      messageId: UUID_A,
      parentMessageId: null,
      content: '这是一段足够长的助手正文内容',
      calls: raws.map((raw) => ({ name: 'shell_exec', raw })),
    }], 'chat-1');
    await settle();

    // 三次调用 ⇒ 三行（不是一行）。
    expect(document.querySelectorAll('.zpp-tool-block-item')).toHaveLength(3);
  });

  it('registers a raw without drawing a running row', async () => {
    // ⚠️⚠️ **原生轮那条兜底执行路径**（`handleResponseComplete` 里
    // `executionsByRequest` 为空时现场 `executeDetected`）**刻意不调 `beginToolCall`**
    // —— 那时这一轮已快结束，塞一行「执行中」只会给用户一个稍纵即逝的闪烁。
    // 但 `raw` 是**合流签名的一半**，只有 `beginToolCall` 会写它 ⇒ 那条路上
    // 实时腿的签名恒为「工具名 + 空串」、**与历史腿永远配不上** ⇒ 同一轮画两块面板。
    // ⇒ 把「画不画 pending 行」与「登记不登记 raw」解耦，这条用例守后者。
    //
    // ⚠️⚠️ **必须用「不带锚点」的气泡**（见 `buildMessageWithoutAnchor`）：带 uuid 时
    // 两条腿同 id、走 `refresh` 那条路，**签名根本不参与判定** ⇒ 这条用例会变成同义反复
    // （实测：把 `noteToolCallRaw` 改成存空串，带锚点版本**照样全绿**）。
    // ⚠️ **判据用记录条数而不是块数**：块数在这里其实也能区分（没合上时历史腿会走
    // **内容片段腿**自己画出一块 ⇒ 2），但它受「正文片段有没有命中」影响，
    // 多一个无关变量；`records` 直接量的是合流结果本身。
    buildMessageWithoutAnchor();
    const raw = '<shell_exec>{"command":"ls"}</shell_exec>';
    const panel = makePanel();
    await panel.install();

    panel.noteToolCallRaw('req-1', { callId: 'xml:aaa', raw }, CHAT_SESSION);
    await settle();

    // ⚠️ **不画行**（这是那条路径的语义）——连块都不该出现。
    expect(document.querySelectorAll('.zpp-tool-block-item')).toHaveLength(0);
    expect(panel.snapshot().livePending).toBe(0);

    // 但它登记到了会话里：随后 `completeToolCall` 投出去的记录**带 raw**。
    panel.completeToolCall('req-1', execution(), CHAT_SESSION);
    await settle();
    expect(document.querySelectorAll('.zpp-tool-block-item')).toHaveLength(1);

    // 拿历史腿来验签名能配上（同一条 raw ⇒ 并成一块）。
    panel.rememberHistoryRecords([{
      messageId: UUID_A,
      parentMessageId: null,
      content: '这是一段足够长的助手正文内容',
      calls: [{ name: 'shell_exec', raw }],
    }], 'chat-1');
    await settle();
    expect(panel.snapshot().records, '两条腿必须按签名合成一条（没合上 = 2）').toBe(1);
    expect(document.querySelectorAll('.zpp-tool-block')).toHaveLength(1);
  });

  it('carries the tool call raw into the live record so the legs can merge', async () => {
    // ⚠️⚠️ **这条守的是 tool-panel 那一半**：`beginToolCall` 收到的 `raw` 必须被
    // 记进会话、并在投给编排层时填进 `calls[].raw`。写死空串的话实时腿的签名
    // 恒为「工具名 + 空串」，与历史腿永远配不上。
    //
    // ⚠️ **必须造「读不到消息 uuid」那一格**（见 `buildMessageWithoutAnchor`）——
    // 那时实时腿的 id 退化成 `live:<requestId>`，与历史腿的 `history:<uuid>` 不同，
    // **只能靠签名合流** ⇒ raw 有没有带上就决定了「一块还是两块」。
    // 气泡带 uuid 时两条腿同 id、走 refresh 那条路，raw 对不对都看不出来。
    buildMessageWithoutAnchor();

    const panel = makePanel();
    await panel.install();

    const raw = '<shell_exec>{"command":"ls"}</shell_exec>';
    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec', raw }, CHAT_SESSION);
    panel.completeToolCall('req-1', execution(), CHAT_SESSION);
    await settle();

    // 历史腿随后到达（有锚点、无结果、**同一条 raw**）。
    panel.rememberHistoryRecords([{
      messageId: UUID_A,
      parentMessageId: null,
      content: '这是一段足够长的助手正文内容',
      calls: [{ name: 'shell_exec', raw }],
    }], 'chat-1');
    await settle();

    // ⚠️ 两块并成一块（不是「一块有结果 + 一块没有」）⇒ 证明 raw 真的带上了。
    expect(document.querySelectorAll('.zpp-tool-block')).toHaveLength(1);
  });
});
describe('tool panel: block-level default state', () => {
  function blockOf(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.zpp-tool-block');
  }

  /**
   * 造一个「详情会画成卡片」的 renderDetail —— 判据与生产同形：
   * 只有带结构化 `output` 的结果才认。
   */
  function cardRenderer() {
    return (target: HTMLElement, result: ToolCardResult): boolean => {
      if (!result.output || typeof result.output !== 'object') return false;
      target.textContent = 'CARD';
      return true;
    };
  }

  function cardExecution(): ToolExecutionRecord {
    return execution({
      callId: 'xml:card',
      name: 'skill_draft_create',
      result: {
        ok: true,
        summary: 'Skill 草稿已就绪',
        detail: 'greeting',
        output: { kind: 'skill_draft' },
      } as ToolCardResult,
    });
  }

  it('collapses the block after sealing even when a row drew an actionable card', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel({ renderDetail: cardRenderer() });
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:card', name: 'skill_draft_create' }, CHAT_SESSION);
    panel.completeToolCall('req-1', cardExecution(), CHAT_SESSION);
    await settle();
    // 在飞时展开 —— 这一条不变。
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('false');

    panel.sealTurn('req-1');
    await settle();

    // ⚠️⚠️ **块的口径是「只展开一次」** —— 收尾后必须收起，卡片行也不例外。
    // 曾经的「有可操作卡片就展开」让带 Skill 草稿的块**永久展开**：刷新一次、切会话回来
    // 又摊开，跑 N 轮就是 N 块全展开。按钮本身仍默认展开在行里，只是要先展开这一块。
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('true');
    // ⚠️ 收起的只是**块**，行级的展开态没被动过 —— 展开块之后按钮就在那儿。
    const rowToggle = blockOf()?.querySelector<HTMLElement>('.zpp-tool-block-item-toggle');
    expect(rowToggle?.getAttribute('aria-expanded'), '卡片行自己仍然默认展开').toBe('true');
  });

  it('keeps a restored card block collapsed on reload', async () => {
    // ⚠️ 刷新 / 切会话回来走的正是这条恢复路径（存储腿 `live` 缺省为假）——
    // 它就是用户报的那个症状：「保存草稿后刷新，面板还是展开的」。
    buildRealisticMessage(UUID_A);
    const panel = makePanel({
      renderDetail: cardRenderer(),
      loadToolHistory: async () => [{
        id: 'h1',
        call: {
          id: 'xml:card',
          name: 'skill_draft_create',
          raw: '',
          // ⚠️ **存储腿必须带锚点才会被渲染** —— `resolveTarget` 对
          // `source === 'storage'` 刻意禁用兜底腿（宁可不显示，也不挂到错的消息上）。
          source: { chatSessionId: 'chat-1', assistantMessageId: UUID_A },
        },
        result: {
          ok: true,
          summary: 'Skill 草稿已就绪',
          // ⚠️ **`detail` 必须与 `summary` 不同** —— `hasDetail` 的判据是
          // `detail !== '' && detail !== summary`，两者相同时整行没有详情框，
          // 渲染器根本不会被调用（这条用例就会变成「没画卡片也不展开」的假绿）。
          detail: 'greeting',
          output: { kind: 'skill_draft' },
        } as ToolCardResult,
        createdAt: 5,
      }],
    });
    await panel.install();
    await settle();

    // ⚠️ 存储腿记录**真的画出了卡片**（否则这条用例测不到那个判据）。
    expect(document.querySelector('.zpp-tool-block-item-detail')?.textContent).toBe('CARD');
    // 恢复 ⇒ 收起（与「卡片行不撑开块」是同一条判据的两个入口）。
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('true');
  });

  it('still collapses a sealed block whose rows have only text details', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel({ renderDetail: cardRenderer() });
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' }, CHAT_SESSION);
    panel.completeToolCall('req-1', execution({
      result: { ok: true, summary: 'EXECUTED', detail: 'ls 的输出' } as ToolCardResult,
    }), CHAT_SESSION);
    await settle();
    panel.sealTurn('req-1');
    await settle();

    // 没有卡片行时保持原口径（跑 N 轮看到 N 行块头）。
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('true');
  });

  it('respects the user collapsing a card block, and keeps it collapsed across redraws', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel({ renderDetail: cardRenderer() });
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:card', name: 'skill_draft_create' }, CHAT_SESSION);
    panel.completeToolCall('req-1', cardExecution(), CHAT_SESSION);
    await settle();
    const header = blockOf()?.querySelector<HTMLElement>('.zpp-tool-block-header');
    header?.click();
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('true');

    // ⚠️ 再投递一次同一条记录（实时链路每执行一步都会重画一次）。
    panel.rememberExecutions('req-1', [cardExecution()], '', CHAT_SESSION);
    await settle();
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('true');
  });
});

/**
 * **两条腿没合流时也不许在同一条回答里叠两块。**
 *
 * 真机症状：刷新后同一条回答上下两个「已调用工具（2 次）」，上面那个点不开详情
 * （历史腿合出来的行没有 detail）、下面那个才有真结果（存储腿）。
 */
describe('tool panel: one block per message when the legs fail to merge', () => {
  it('keeps the storage result when the history leg arrives first and is redrawn', async () => {
    buildRealisticMessage(UUID_A, '这是一段足够长的助手正文内容');
    // ⚠️ 反向顺序：历史腿先画（只有工具名），存储腿后到（有真结果）。
    const panel = makePanel({
      loadToolHistory: async () => [],
    });
    await panel.install();
    await settle();

    panel.rememberHistoryRecords([{
      messageId: UUID_A,
      parentMessageId: null,
      content: '这是一段足够长的助手正文内容',
      calls: [{ name: 'shell_exec', raw: '<shell_exec>{"command":"ls"}</shell_exec>' }],
    }], 'chat-1');
    await settle();
    // 历史腿单独画出来时：一行、没有详情框（只有工具名与「已执行」）。
    expect(document.querySelectorAll('.zpp-tool-block')).toHaveLength(1);
    expect(document.querySelector('.zpp-tool-block-item-detail')).toBeNull();

    // 存储腿带着真结果补到（锚点相同 ⇒ 走同一个块）。
    panel.rememberExecutions('req-x', [{
      callId: 'xml:ls',
      name: 'shell_exec',
      result: { ok: true, summary: '真实结果', detail: 'ls 的真实输出' } as ToolCardResult,
    }], '', CHAT_SESSION);
    await settle();

    // 仍然只有一块，且真结果落进去了。
    expect(document.querySelectorAll('.zpp-tool-block')).toHaveLength(1);
    expect(document.querySelector('.zpp-tool-block-item-detail')?.textContent).toContain('ls 的真实输出');
  });
});

/**
 * **实时腿用 `live:<requestId>`、历史腿用 `history:<uuid>`，落在同一条回答上。**
 *
 * ⚠️⚠️ 这是真机那个「同一条回答上下叠两个面板、上面那个点不开详情」的**最短复现**：
 * 实时腿在 `readZaiMessageId` 拿不到 uuid 的那一刻出生 ⇒ 键是 `live:<requestId>`；
 * 历史腿后来带着锚点到达 ⇒ 键是 `history:<uuid>`。两个键不同，按 key 谁都找不到对方，
 * 于是同一条消息里出现两块 —— 上面那块只有工具名（没有 detail ⇒ 没有展开箭头）。
 */
describe('tool panel: live leg and history leg collide on one message', () => {
  it('keeps a single block and lets the history leg take it over', async () => {
    // 气泡没有 `message-<uuid>` 锚点 ⇒ 实时腿那一刻读不到 uuid。
    buildMessageWithoutAnchor();
    const panel = makePanel();
    await panel.install();

    // ⚠️ **两边的 raw 刻意不同** —— 否则签名一致、两条记录会先合流成一条，
    // 那样 `findToolBlock(record.id)` 自己就能命中，**根本测不到「按宿主兜底」**。
    // 真机合流失败的形态正是这样：两边各拿到一份措辞略有出入的 raw。
    panel.beginToolCall('req-1', {
      callId: 'xml:aaa',
      name: 'shell_exec',
      raw: '<shell_exec>{"command":"ls"}</shell_exec>',
    }, CHAT_SESSION);
    // ⚠️ 实时腿的结果**带 detail** —— 那是「真结果」的唯一标志（历史腿合成的行没有它）。
    // 后面用它验「历史腿接管时不许把真结果冲掉」。
    panel.completeToolCall('req-1', execution({
      result: { ok: true, summary: '真实结果', detail: 'ls 的真实输出' } as ToolCardResult,
    }), CHAT_SESSION);
    await settle();
    // 实时腿画的块：键是 `live:req-1`，有真结果。
    expect(document.querySelectorAll('.zpp-tool-block')).toHaveLength(1);
    expect(document.querySelector('.zpp-tool-block-item-detail')?.textContent).toContain('ls 的真实输出');

    // 历史腿到达：**同一条消息**（同一 `.chat-assistant`）、键是 `history:<uuid>`。
    const message = document.querySelector('.chat-assistant') as Element;
    message.parentElement?.classList.add(`message-${UUID_A}`);
    panel.rememberHistoryRecords([{
      messageId: UUID_A,
      parentMessageId: null,
      content: '',
      calls: [{ name: 'shell_exec', raw: '<shell_exec>{"command": "ls"}</shell_exec>' }],
    }], 'chat-1');
    await settle();

    // ⚠️⚠️ **仍然只有一块** —— 后到的那条必须接管已有的块，不新建第二块。
    expect(document.querySelectorAll('.zpp-tool-block')).toHaveLength(1);
    // 接管之后块键归一成历史腿的那个。
    expect(document.querySelector('.zpp-tool-block')?.getAttribute('data-zpp-tool-key'))
      .toBe(`history:${UUID_A}`);
    // ⚠️⚠️ **真结果不能被历史腿的空结果冲掉** —— 它只有工具名（`executions` 恒空），
    // 用它重画会把实时腿带进来的 detail 换成合成的「已执行」。
    // 这条守的是 `RICH_CONTENT_ATTR`：没有它，刷新后面板会退回「只有工具名」。
    expect(document.querySelector('.zpp-tool-block-item-detail')?.textContent).toContain('ls 的真实输出');
  });
});

/**
 * **「有未点按钮就保持展开、刷新后不展开」** —— 用户口径的精确落点。
 *
 * ⚠️ 判据不是「卡片行」，而是「详情里还有没有可点的东西」：
 * - 本页面会话内跑完的那一轮、按钮还在 ⇒ 保持展开（不然用户不知道有按钮）；
 * - 刷新页面 / 切会话后从历史恢复 ⇒ 一律收起，哪怕按钮还在；
 * - 点过保存（按钮换成状态行）⇒ 下次重画就收起。
 */
describe('tool panel: block stays expanded only while an unsaved action is visible', () => {
  /** 本 describe 自己用的块查询（不跨 describe 借用 helper）。 */
  function blockOf(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.zpp-tool-block');
  }

  /** 一条带 `skill_draft_create` 结果的执行（本 describe 自带，不跨块借用）。 */
  function cardExecution(): ToolExecutionRecord {
    return execution({
      callId: 'xml:card',
      name: 'skill_draft_create',
      result: {
        ok: true,
        summary: 'Skill 草稿已就绪',
        detail: 'greeting',
        output: { kind: 'skill_draft' },
      } as ToolCardResult,
    });
  }

  /** 真实形态：详情里画出一个可点的 `.zpp-result-action` 按钮。 */
  function actionableCardRenderer() {
    return (target: HTMLElement, result: ToolCardResult): boolean => {
      if (!result.output || typeof result.output !== 'object') return false;
      const button = document.createElement('button');
      button.className = 'zpp-result-action';
      button.textContent = '保存';
      target.appendChild(button);
      return true;
    };
  }

  it('keeps the block expanded after sealing while the save button is still there', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel({ renderDetail: actionableCardRenderer() });
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:card', name: 'skill_draft_create' }, CHAT_SESSION);
    panel.completeToolCall('req-1', cardExecution(), CHAT_SESSION);
    await settle();
    panel.sealTurn('req-1');
    await settle();

    // ⚠️ 轮次结束**不收起** —— 按钮还在，藏起来等于没交付。
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('false');
    expect(blockOf()?.querySelector('.zpp-result-action')).not.toBeNull();
  });

  it('collapses after sealing once the button is gone (already saved)', async () => {
    buildRealisticMessage(UUID_A);
    // 这张卡片「没有可点的动作」（模拟点过保存之后的状态行）。
    const statusOnlyRenderer = (target: HTMLElement, result: ToolCardResult): boolean => {
      if (!result.output || typeof result.output !== 'object') return false;
      const status = document.createElement('div');
      status.className = 'zpp-result-status';
      status.textContent = '已保存';
      target.appendChild(status);
      return true;
    };
    const panel = makePanel({ renderDetail: statusOnlyRenderer });
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:card', name: 'skill_draft_create' }, CHAT_SESSION);
    panel.completeToolCall('req-1', cardExecution(), CHAT_SESSION);
    await settle();
    panel.sealTurn('req-1');
    await settle();

    // 没有可点的东西 ⇒ 按普通口径收起。
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('true');
  });

  it('collapses a restored block on reload even when the button is still there', async () => {
    // ⚠️⚠️ **这条是「刷新后不展开」的守卫** —— 恢复路径进来的记录不在
    // `sealedThisSessionIds` 里，所以哪怕按钮还在也收起。
    buildRealisticMessage(UUID_A);
    const panel = makePanel({
      renderDetail: actionableCardRenderer(),
      loadToolHistory: async () => [{
        id: 'h1',
        call: {
          id: 'xml:card',
          name: 'skill_draft_create',
          raw: '',
          source: { chatSessionId: 'chat-1', assistantMessageId: UUID_A },
        },
        result: {
          ok: true,
          summary: 'Skill 草稿已就绪',
          detail: 'greeting',
          output: { kind: 'skill_draft' },
        } as ToolCardResult,
        createdAt: 5,
      }],
    });
    await panel.install();
    await settle();

    // 按钮确实画出来了（否则这条用例测不到判据）。
    expect(blockOf()?.querySelector('.zpp-result-action')).not.toBeNull();
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('true');
  });
});
