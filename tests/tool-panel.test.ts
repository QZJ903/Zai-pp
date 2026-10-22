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
    // ⚠️⚠️ **「抽锚点」与「比锚点」必须同源**（P2-1 报的那条不对称）：
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

  it('adds an error segment for failures and keeps the extracted reason in detail', () => {
    // ⚠️ **失败分支保留「从 JSON detail 里抽可读错误」**（上游 `.dpp-tool-block` 的
    // 祖先行为）—— 抽取只在第三方 MCP 把 JSON 塞进 content 文本时命中。
    // ⚠️ **不丢信息**：抽出来的可读句在 detail 段，原文仍在 `error:` 段。
    const error = { code: 'mcp_tool_result_error', message: '{"error":{"message":"权限不足"}}', retryable: false };
    const formatted = formatZaiToolDetail({
      ok: false, summary: 'failed',
      detail: JSON.stringify({ error: { message: '权限不足' } }),
      error,
    } as ToolCardResult);
    expect(formatted).toContain('权限不足');
    expect(formatted).toContain(`error: ${JSON.stringify(error)}`);
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

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' });
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

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' });
    panel.completeToolCall('req-1', execution());
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
    panel.beginToolCall('req-1', { callId: 'xml:from-tool-call', name: 'shell_exec' });
    panel.completeToolCall('req-1', execution({ callId: 'xml:from-parser' }));
    await settle();

    expect(document.querySelectorAll('.zpp-tool-block-item')).toHaveLength(1);
    expect(panel.snapshot().livePending).toBe(0);
  });

  it('does not create a duplicate row for the same call id', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' });
    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' });
    panel.completeToolCall('req-1', execution());
    await settle();
    expect(document.querySelectorAll('.zpp-tool-block-item')).toHaveLength(1);
  });

  it('keeps pending rows that the final result does not cover', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' });
    panel.beginToolCall('req-1', { callId: 'xml:bbb', name: 'web_search' });
    // 只有 shell_exec 有结果 ⇒ web_search 那行仍应是「执行中」。
    panel.rememberExecutions('req-1', [execution()], '正文');
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

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' });
    panel.finalizePending('req-1', 'FAILED', '未完成（回答被中断）');
    await settle();

    expect(panel.snapshot().livePending).toBe(0);
    const status = document.querySelector('.zpp-tool-block-item-status');
    expect(status?.textContent).toBe('FAILED');
    expect(status?.className).toContain('error');
    const detail = document.querySelector('.zpp-tool-block-item-detail');
    // 三段式：summary + 原因 + `error: JSON`（详情框默认收起，但文本已在 DOM 里）。
    expect(detail?.textContent).toContain('FAILED');
    expect(detail?.textContent).toContain('未完成（回答被中断）');
    expect(detail?.textContent).toContain('error: ');
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

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' });
    panel.beginToolCall('req-2', { callId: 'xml:bbb', name: 'web_search' });
    panel.finalizeAllPending('FAILED', 'interrupted');
    await settle();

    expect(panel.snapshot().livePending).toBe(0);
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

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' });
    panel.completeToolCall('req-1', execution());
    await settle();

    // ⚠️ 在飞 ⇒ 展开（用户当场要看见在跑什么）—— 上游 `.dpp-tool-block`
    // 实时面板不传 `collapsed`（缺省展开），同口径。
    expect(blockOf()?.getAttribute('data-collapsed')).toBe('false');
  });

  it('collapses the block once the turn is sealed', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel();
    await panel.install();

    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec' });
    panel.completeToolCall('req-1', execution());
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

  it('stays silent when the storage read fails', async () => {
    buildRealisticMessage(UUID_A);
    const panel = makePanel({
      loadToolHistory: async () => { throw new Error('boom'); },
    });
    // 读不到只是「没有真结果」，不该抛出去打断启动链。
    await expect(panel.install()).resolves.toBeUndefined();
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

    panel.noteToolCallRaw('req-1', { callId: 'xml:aaa', raw });
    await settle();

    // ⚠️ **不画行**（这是那条路径的语义）——连块都不该出现。
    expect(document.querySelectorAll('.zpp-tool-block-item')).toHaveLength(0);
    expect(panel.snapshot().livePending).toBe(0);

    // 但它登记到了会话里：随后 `completeToolCall` 投出去的记录**带 raw**。
    panel.completeToolCall('req-1', execution());
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
    panel.beginToolCall('req-1', { callId: 'xml:aaa', name: 'shell_exec', raw });
    panel.completeToolCall('req-1', execution());
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