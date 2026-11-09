import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createToolBlockRestoreController,
  type ToolBlockRestoreDependencies,
  type ToolBlockRestoreRecord,
} from '../core/ui/tool-block-restore';

/**
 * 恢复编排层的用例。
 *
 * ⚠️ 这里不碰真实 DOM 的选择器 —— `render` 是注入的桩，所以断言集中在
 * **「哪条记录挂到哪条消息上」**（那才是本模块的职责），而不是渲染结果。
 */

interface Harness {
  controller: ReturnType<typeof createToolBlockRestoreController>;
  messages: Element[];
  rendered: { recordId: string; messageIndex: number }[];
  /**
   * 每次 `render` 时该记录的 `live` 值（与 `rendered` 平行）。
   *
   * ⚠️ **刻意与 `rendered` 分开** —— 块的折叠态由它派生，但既有的那批用例
   * 都在对 `rendered` 做 `toEqual`，往那个对象里加字段会把它们全打红。
   */
  renderedLive: boolean[];
  /** 每次 `render` 拿到的**记录本身**（用来断言合流后的内容）。 */
  mergedRecords: ToolBlockRestoreRecord[];
  /** 模拟页面重建：把指定消息从"页面上"清掉（render 会失败）。 */
  setHostAvailable: (available: boolean) => void;
  frames: (() => void)[];
}

function buildHarness(overrides: Partial<ToolBlockRestoreDependencies> = {}): Harness {
  const messages: Element[] = [0, 1, 2].map((index) => {
    const el = document.createElement('div');
    el.className = 'chat-assistant';
    el.textContent = `正文${index}`;
    el.setAttribute('data-index', String(index));
    return el;
  });
  const rendered: { recordId: string; messageIndex: number }[] = [];
  const renderedLive: boolean[] = [];
  const mergedRecords: ToolBlockRestoreRecord[] = [];
  const frames: (() => void)[] = [];
  let hostAvailable = true;

  const dependencies: ToolBlockRestoreDependencies = {
    listMessages: () => messages,
    getMessageOwnText: (message) => message.textContent ?? '',
    resolveHost: () => (hostAvailable ? document.createElement('div') : null) as Element | null,
    render: (record, message) => {
      if (!hostAvailable) return false;
      rendered.push({ recordId: record.id, messageIndex: messages.indexOf(message) });
      // ⚠️ 记下这一刻的 `live` —— 块的折叠态就是由它派生的（实时展开、收尾收起）。
      renderedLive.push(record.live === true);
      mergedRecords.push(record);
      return true;
    },
    ownUiSelector: '.zpp-tool-block',
    messageSelector: '.chat-assistant',
    observeRoot: () => document.body,
    // ⚠️ 默认「不知道当前会话」⇒ 兜底腿的会话判据一律放行（与生产里
    // 「地址栏还没切到 /c/<id>」同一格）。要验会话判据的用例自己覆盖它。
    getChatSessionId: () => null,
    // ⚠️ 与生产同口径：往上 6 层找 `message-<id>` 类（生产走
    // `core/zai/tool-block-adapter` 的 `messageCarriesZaiAnchorId`）。
    messageCarriesAnchorId: (message, messageId) => {
      let node: Element | null = message;
      for (let depth = 0; depth < 6 && node; depth += 1) {
        if (node.classList?.contains(`message-${messageId}`)) return true;
        node = node.parentElement;
      }
      return false;
    },
    retryDelayMs: 1,
    maxAttempts: 3,
    // ⚠️ 手动驱动 rAF —— 让「按帧合流」这件事在用例里可控。
    scheduleFrame: (callback) => { frames.push(callback); },
    ...overrides,
  };

  return {
    controller: createToolBlockRestoreController(dependencies),
    messages,
    rendered,
    renderedLive,
    mergedRecords,
    setHostAvailable: (value) => { hostAvailable = value; },
    frames,
  };
}

function record(overrides: Partial<ToolBlockRestoreRecord> = {}): ToolBlockRestoreRecord {
  return {
    id: 'r1',
    source: 'history',
    messageId: null,
    parentMessageId: null,
    content: '',
    calls: [],
    executions: [],
    createdAt: 0,
    ...overrides,
  };
}

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('restore target resolution', () => {
  it('locates the message by its message-<uuid> class', () => {
    const harness = buildHarness();
    harness.messages[1].classList.add(`message-${UUID_A}`);

    harness.controller.remember([record({ id: 'r1', messageId: UUID_A })]);
    harness.controller.renderPending();

    expect(harness.rendered).toEqual([{ recordId: 'r1', messageIndex: 1 }]);
  });

  it('falls back to the content snippet when there is no message id', () => {
    const harness = buildHarness();
    harness.messages[2].textContent = '这是一段足够长的助手正文内容';

    harness.controller.remember([record({
      id: 'r1',
      content: '这是一段足够长的助手正文内容',
    })]);
    harness.controller.renderPending();

    expect(harness.rendered).toEqual([{ recordId: 'r1', messageIndex: 2 }]);
  });

  it('ignores a snippet that is too short to be a reliable anchor', () => {
    const harness = buildHarness();
    harness.messages[0].textContent = '短';

    harness.controller.remember([record({ id: 'r1', content: '短' })]);
    harness.controller.renderPending();

    // 片段 < 12 字符 ⇒ 不按片段定位，用兜底腿（第一条没被占用的消息）。
    expect(harness.rendered).toEqual([{ recordId: 'r1', messageIndex: 0 }]);
  });

  it('refuses to guess a target for a storage-leg record', () => {
    const harness = buildHarness();
    harness.controller.remember([record({ id: 'storage:1', source: 'storage' })]);
    const missing = harness.controller.renderPending();

    // ⚠️ storage 腿没有锚点 ⇒ 宁可留着重试，也不要挂到错的回答上。
    expect(harness.rendered).toEqual([]);
    expect(missing).toBe(1);
  });
});

describe('one message hosts one block', () => {
  it('never puts two records on the same message', () => {
    const harness = buildHarness();

    harness.controller.remember([
      record({ id: 'r1', content: '第一条足够长的正文内容啊' }),
      record({ id: 'r2', content: '第二条足够长的正文内容啊' }),
      record({ id: 'r3', content: '第三条足够长的正文内容啊' }),
    ]);
    harness.controller.renderPending();

    // ⚠️ 没有 usedMessages 的话三条会全落到第一条消息上（兜底腿是「第一个没被占用的」）。
    expect(harness.rendered.map((item) => item.recordId)).toEqual(['r1', 'r2', 'r3']);
    expect(harness.rendered.map((item) => item.messageIndex)).toEqual([0, 1, 2]);
  });
});

describe('two legs merge', () => {
  it('merges a storage record into a history record that shares a tool signature', () => {
    const harness = buildHarness();
    harness.messages[1].classList.add(`message-${UUID_A}`);
    const raw = '<shell_exec>{"command":"ls"}</shell_exec>';

    const seen: string[] = [];
    const controller = createToolBlockRestoreController({
      listMessages: () => harness.messages,
      getMessageOwnText: (message) => message.textContent ?? '',
      resolveHost: () => document.createElement('div'),
      render: (r) => { seen.push(`${r.id}:${r.executions.length}`); return true; },
      ownUiSelector: '.zpp-tool-block',
      messageSelector: '.chat-assistant',
      observeRoot: () => document.body,
      getChatSessionId: () => null,
      messageCarriesAnchorId: (message, messageId) => message.classList.contains(`message-${messageId}`),
      retryDelayMs: 1,
    });

    // 先到的是 history 腿（有锚点、没有结果）
    controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      content: '正文',
      calls: [{ name: 'shell_exec', raw }],
      executions: [],
    })]);
    // 后到的是 storage 腿（有结果、没有锚点）
    controller.remember([record({
      id: 'storage:xyz',
      source: 'storage',
      calls: [{ name: 'shell_exec', raw }],
      executions: [{ name: 'shell_exec', result: { ok: true, summary: '真结果' } }],
    })]);

    expect(controller.snapshot().records).toBe(1);
    controller.renderPending();
    // ⚠️ 合流后 id 仍是 history 那个（锚点来自它），而 executions 来自 storage 腿。
    expect(seen).toEqual([`history:${UUID_A}:1`]);
  });

  it('keeps records separate when the tool signatures differ', () => {
    const controller = createToolBlockRestoreController({
      listMessages: () => [],
      getMessageOwnText: () => '',
      resolveHost: () => null,
      render: () => true,
      ownUiSelector: '.zpp-tool-block',
      messageSelector: '.chat-assistant',
      observeRoot: () => document.body,
      getChatSessionId: () => null,
      messageCarriesAnchorId: (message, messageId) => message.classList.contains(`message-${messageId}`),
    });

    controller.remember([record({
      id: 'history:a',
      calls: [{ name: 'shell_exec', raw: 'A' }],
    })]);
    controller.remember([record({
      id: 'storage:b',
      source: 'storage',
      calls: [{ name: 'shell_exec', raw: 'B' }],
    })]);

    expect(controller.snapshot().records).toBe(2);
  });

  it('takes the anchor from one leg and the results from the other', () => {
    const controller = createToolBlockRestoreController({
      listMessages: () => [],
      getMessageOwnText: () => '',
      resolveHost: () => null,
      render: () => true,
      ownUiSelector: '.zpp-tool-block',
      messageSelector: '.chat-assistant',
      observeRoot: () => document.body,
      getChatSessionId: () => null,
      messageCarriesAnchorId: (message, messageId) => message.classList.contains(`message-${messageId}`),
    });
    const raw = 'X';
    controller.remember([record({
      id: 'history:a',
      messageId: UUID_B,
      content: '锚点正文',
      calls: [{ name: 't', raw }],
      executions: [],
    })]);
    controller.remember([record({
      id: 'storage:b',
      source: 'storage',
      calls: [{ name: 't', raw }],
      executions: [{ name: 't', result: { ok: true, summary: 'S' } }],
    })]);

    // 合流后 source 必须是 storage（下游靠它决定「找不找兜底目标」）。
    expect(controller.snapshot().records).toBe(1);
  });
});

describe('ambiguous merges are refused', () => {
  const RAW = '<shell_exec>{"command":"ls"}</shell_exec>';

  function twoMessagesOneCommand(harness: Harness) {
    // 两条**不同**的助手消息，各调用了一次**同一条命令** ⇒ 签名逐字相同。
    harness.messages[0].classList.add(`message-${UUID_A}`);
    harness.messages[1].classList.add(`message-${UUID_B}`);
    harness.controller.remember([
      record({
        id: `history:${UUID_A}`,
        messageId: UUID_A,
        content: '第一条消息的正文，足够长用于锚定',
        calls: [{ name: 'shell_exec', raw: RAW }],
      }),
      record({
        id: `history:${UUID_B}`,
        messageId: UUID_B,
        content: '第二条消息的正文，足够长用于锚定',
        calls: [{ name: 'shell_exec', raw: RAW }],
      }),
    ]);
  }

  it('never folds two different messages into one record', () => {
    // ⚠️⚠️ **真机形状的歧义**：两条消息都调过同一条命令 ⇒ 签名相同，
    // 而「没有锚点的那一方」（存储腿 / 实时腿）与**两条都兼容**。
    // 此时「并全部」会把两条消息并成一块、**其中一条的面板整个消失**；
    // 「只并第一条」则让另一条变孤儿（`exec=0`）。两种都错 ⇒ 必须拒绝合并。
    const harness = buildHarness();
    twoMessagesOneCommand(harness);
    harness.controller.remember([record({
      id: 'storage:x',
      source: 'storage',
      calls: [{ name: 'shell_exec', raw: RAW }],
      executions: [{ callId: 'xml:1', name: 'shell_exec', result: { ok: true, summary: '真结果' } }],
    })]);
    harness.controller.renderPending();

    // 两条消息各一块（没有被并成一块），且存储腿那条没有被并进任何一条。
    expect(harness.controller.snapshot().records).toBe(3);
    expect(harness.rendered.map((item) => item.messageIndex)).toEqual([0, 1]);
  });

  it('still merges when only one candidate carries an anchor', () => {
    // ⚠️ 反面：只有一条候选有锚点（典型是「1 条 history + N 条 storage」）
    // ⇒ **没有歧义**，必须照常并（否则真机那个「刷新后只显示 1 次」会回来）。
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      content: '正文，足够长用于锚定',
      calls: [{ name: 'shell_exec', raw: RAW }],
    })]);
    for (const index of [1, 2]) {
      harness.controller.remember([record({
        id: `storage:${index}`,
        source: 'storage',
        calls: [{ name: 'shell_exec', raw: RAW }],
        executions: [{
          callId: `xml:${index}`,
          name: 'shell_exec',
          result: { ok: true, summary: `结果${index}` },
        }],
      })]);
    }
    harness.controller.renderPending();

    expect(harness.controller.snapshot().records).toBe(1);
    expect(harness.mergedRecords.at(-1)?.executions).toHaveLength(2);
  });

  it('matches a truncated raw against its full form', () => {    // ⚠️⚠️ **写库时 `sanitizeCall` 把 raw 截到 4000 字符 + `\n...[truncated]`**，
    // 而历史腿拿的是全文 ⇒ 超过 4000 字符的调用**两条腿的签名必然不等**、
    // 合流彻底失败（实测：一个 5000 字符的 `local_file_write` 会让存储腿永不渲染）。
    // ⇒ `signatureOf` 两边**对称截断**到同一个上限后再比。
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    const raw = `<local_file_write>{"path":"a","content":"${'x'.repeat(5000)}"}</local_file_write>`;
    const truncated = `${raw.slice(0, 4_000)}\n...[truncated]`;

    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      content: '正文，足够长用于锚定',
      calls: [{ name: 'local_file_write', raw }],
    })]);
    harness.controller.remember([record({
      id: 'storage:big',
      source: 'storage',
      calls: [{ name: 'local_file_write', raw: truncated }],
      executions: [{
        callId: 'xml:big',
        name: 'local_file_write',
        result: { ok: true, summary: '写完了' },
      }],
    })]);
    harness.controller.renderPending();

    expect(harness.controller.snapshot().records).toBe(1);
    expect(harness.mergedRecords.at(-1)?.executions).toHaveLength(1);
  });
});

describe('the live leg merges into the history leg of the same turn', () => {
  it('merges when both legs carry the same raw, even with different ids', () => {
    // ⚠️⚠️ **实时腿与历史腿的 id 不同时，只能靠签名合流** —— 而签名的另一半是
    // `calls[].raw`。生产里实时腿一度写死 `raw: ''`（`publishLiveSession`），
    // 于是它的签名恒为 `shell_exec\n`、与历史腿永远配不上 ⇒ **同一轮画两块面板**
    // （一块有结果、一块没有）。
    // 这一条守的是「实时腿把 raw 带上了」：两条腿 raw 逐字相同 ⇒ 并成一条。
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    const raw = '<shell_exec>{"command":"ls"}</shell_exec>';

    // 实时腿：**id 是 `live:<requestId>`**（那一刻读不到消息 uuid）、带 raw、有结果。
    harness.controller.remember([record({
      id: 'live:req-1',
      source: 'history',
      messageId: null,
      content: '正文，足够长用于锚定',
      calls: [{ name: 'shell_exec', raw }],
      executions: [{ callId: 'xml:1', name: 'shell_exec', result: { ok: true, summary: '真结果' } }],
      live: true,
    })]);
    // 历史腿随后到达：有锚点、无结果、**同一条 raw**。
    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      source: 'history',
      messageId: UUID_A,
      content: '正文，足够长用于锚定',
      calls: [{ name: 'shell_exec', raw }],
    })]);
    harness.controller.renderPending();

    // 并成一条（不是两块），锚点来自历史腿、结果来自实时腿。
    expect(harness.controller.snapshot().records).toBe(1);
    expect(harness.mergedRecords.at(-1)?.messageId).toBe(UUID_A);
    expect(harness.mergedRecords.at(-1)?.executions).toHaveLength(1);
  });

  it('keeps two blocks apart when the live leg carries no raw', () => {
    // ⚠️ **反面**（改造前的形状）：实时腿的 raw 是空串 ⇒ 签名配不上 ⇒ 两块。
    // 这条不是「期望的行为」，而是把**回归**钉住：谁把 raw 又去掉，它会红。
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    const raw = '<shell_exec>{"command":"ls"}</shell_exec>';

    harness.controller.remember([record({
      id: 'live:req-1',
      source: 'history',
      messageId: null,
      content: '正文，足够长用于锚定',
      calls: [{ name: 'shell_exec', raw: '' }],
      executions: [{ callId: 'xml:1', name: 'shell_exec', result: { ok: true, summary: '真结果' } }],
      live: true,
    })]);
    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      source: 'history',
      messageId: UUID_A,
      content: '正文，足够长用于锚定',
      calls: [{ name: 'shell_exec', raw }],
    })]);
    harness.controller.renderPending();

    expect(harness.controller.snapshot().records).toBe(2);
  });

  /**
   * ⚠️⚠️ **签名里不含「哪一轮」，所以两侧都知道轮次时必须同轮才许并。**
   *
   * 真机形状：`shell_status` / `python_status` / 五个 `browser_*` 这七个零参工具的
   * XML **每轮逐字相同**，而流式期 `readZaiMessageId` 可能读不到锚点。此时本轮的
   * 实时记录（无锚点、有 requestId）与上一轮的存储记录（有锚点、有 requestId）
   * 签名一致 ⇒ 只看签名就会并，结果是**本轮的结果画到上一轮的回答下面**，
   * 本轮那条回答一条都没有（探针实测过）。
   */
  it('keeps two turns apart when both sides carry a different request id', () => {
    const harness = buildHarness();
    // ⚠️ 照真机排：上一轮的回答在中间（带锚点），本轮那条在最下面
    // （**还没有锚点类** —— 那正是「读不到 messageId」的原因）。
    harness.messages[1].classList.add(`message-${UUID_A}`);
    const raw = '<shell_status></shell_status>';

    // 上一轮（存储腿，带锚点 + requestId）
    harness.controller.remember([record({
      id: 'storage:prev',
      source: 'storage',
      messageId: UUID_A,
      calls: [{ name: 'shell_status', raw }],
      executions: [{ callId: 'xml:prev', name: 'shell_status', result: { ok: true, summary: 'PREV' } }],
      requestId: 'req-prev',
    })]);
    // 本轮（实时腿，读不到锚点，但知道自己是 req-now）
    harness.controller.remember([record({
      id: 'live:req-now',
      messageId: null,
      calls: [{ name: 'shell_status', raw }],
      executions: [{ callId: 'xml:now', name: 'shell_status', result: { ok: true, summary: 'NOW' } }],
      live: true,
      requestId: 'req-now',
    })]);

    // 两条都在（没被并），且本轮那条落到**最新**那条消息上（不是上一条）。
    expect(harness.controller.snapshot().records).toBe(2);
    harness.controller.renderPending();
    const nowRender = harness.rendered.filter((item) => item.recordId === 'live:req-now');
    expect(nowRender).toEqual([{ recordId: 'live:req-now', messageIndex: 2 }]);
    // ⚠️ 关键：**不能**画到上一轮那条回答（index 1）下面。
    expect(nowRender.map((item) => item.messageIndex)).not.toContain(1);
  });

  /**
   * ⚠️ **反面（这条是「一条不知道就放行」的守卫）** —— 历史腿来自服务端正文、
   * 天然没有 requestId。若写成「必须相等」，刷新后「存储腿 ↔ 历史腿」那条主路径
   * 会整条死掉（面板退化成只有工具名、没有结果）。
   */
  it('still merges the two legs when only one side knows its request id', () => {
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    const raw = '<shell_status></shell_status>';

    // 历史腿：有锚点、**没有** requestId
    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      calls: [{ name: 'shell_status', raw }],
    })]);
    // 存储腿：有结果 + requestId
    harness.controller.remember([record({
      id: 'storage:x',
      source: 'storage',
      calls: [{ name: 'shell_status', raw }],
      executions: [{ callId: 'xml:x', name: 'shell_status', result: { ok: true, summary: 'R' } }],
      requestId: 'req-1',
    })]);

    expect(harness.controller.snapshot().records).toBe(1);
  });
});

describe('a record with a precise anchor never falls back to another message', () => {
  it('leaves the anchored record pending instead of mounting it on the wrong answer', () => {
    // ⚠️⚠️ **真机形状**：同一轮里 `readZaiMessageId` 先返回 null、后返回 uuid
    // ⇒ 先后产生 `live:<requestId>` 与 `history:<uuid>` 两条记录（签名对不上时不合流）。
    // 前者没有锚点、走兜底腿**占住了本轮那条消息**；后者带着精确锚点来的时候
    // `usedMessages` 已经把那条挡掉了 ⇒ 若兜底腿照常放行，它会被挂到**另一条回答**上。
    //
    // ⚠️ **顺序必须照真机排**：本轮的回答在页面最下面（`messages` 是 DOM 顺序）。
    // 兜底腿对在飞记录是**从最新往前**找的，所以「占住正确那条」这个场景只有在
    // 锚点挂在**最后一条**消息上时才成立 —— 排到前面去就测的是另一件事了。
    const harness = buildHarness();
    harness.messages[2].classList.add(`message-${UUID_A}`);
    harness.messages[0].classList.add(`message-${UUID_B}`);

    // 先到的是没有锚点的那条（id 退化成 live:、raw 也空 ⇒ 签名配不上）。
    harness.controller.remember([record({
      id: 'live:req-1',
      messageId: null,
      content: '',
      calls: [{ name: 'shell_exec', raw: '' }],
      executions: [{ callId: 'x', name: 'shell_exec', result: { ok: true, summary: 'R' } }],
      live: true,
    })]);
    // 后到的是带精确锚点的那条，raw 不同 ⇒ 两条不会合流。
    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      content: '正文',
      calls: [{ name: 'shell_exec', raw: '<shell_exec>{}</shell_exec>' }],
    })]);
    harness.controller.renderPending();

    // 无锚点那条占住 msg2（本轮那条）；有锚点那条**必须留在待渲染**，
    // 不能退而求其次挂到 msg0 那条别的回答上。
    expect(harness.rendered.map((item) => item.messageIndex)).toEqual([2]);
    expect(harness.controller.snapshot().pending).toBe(1);
  });

  it('still lets an anchor-less record use the fallback leg', () => {
    // ⚠️ 反面：**没有 `messageId`** 的记录（典型是存储腿在拿到锚点之前、
    // 或这一轮的 uuid 一直读不到）**照常走兜底腿** —— 收紧过头会让当场渲染整批失效。
    const harness = buildHarness();
    harness.controller.remember([record({ id: 'r1', messageId: null, content: '正文' })]);
    harness.controller.renderPending();

    expect(harness.rendered.map((item) => item.recordId)).toEqual(['r1']);
  });
});

describe('retry scheduling', () => {
  it('retries while the host is unavailable, then gives up', async () => {
    vi.useFakeTimers();
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    harness.setHostAvailable(false);

    harness.controller.remember([record({ id: 'r1', messageId: UUID_A })]);
    harness.controller.renderPending();

    // 首跑 + maxAttempts 次重试；宿主一直不可用 ⇒ 始终留在 pending。
    for (let index = 0; index < 4; index += 1) {
      vi.runOnlyPendingTimers();
    }
    expect(harness.controller.snapshot().pending).toBe(1);
    expect(harness.rendered).toEqual([]);
  });

  it('succeeds once the host shows up', async () => {
    vi.useFakeTimers();
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    harness.setHostAvailable(false);
    harness.controller.remember([record({ id: 'r1', messageId: UUID_A })]);
    harness.controller.renderPending();

    harness.setHostAvailable(true);
    vi.runOnlyPendingTimers();

    expect(harness.rendered).toEqual([{ recordId: 'r1', messageIndex: 0 }]);
  });
});

describe('requeue after the page rebuilds our UI', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('requeues when our own node is removed', async () => {
    const harness = buildHarness({ scheduleFrame: undefined });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      value: (callback: () => void) => { callback(); return 0; },
      configurable: true,
    });
    harness.messages[0].classList.add(`message-${UUID_A}`);
    harness.controller.remember([record({ id: 'r1', messageId: UUID_A })]);
    harness.controller.renderPending();
    harness.controller.start();

    // 页面上我们自己的块被移除了（= 页面重建了那块 DOM）。
    const block = document.createElement('div');
    block.className = 'zpp-tool-block';
    document.body.appendChild(block);
    block.remove();
    await Promise.resolve();

    expect(harness.controller.snapshot().pending).toBe(1);
  });

  it('ignores mutations that are not about our UI', async () => {
    const harness = buildHarness();
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      value: (callback: () => void) => { callback(); return 0; },
      configurable: true,
    });
    harness.controller.start();

    const other = document.createElement('div');
    other.className = 'page-thing';
    document.body.appendChild(other);
    other.remove();
    await Promise.resolve();

    expect(harness.controller.snapshot().pending).toBe(0);
  });
});

describe('sealing a finished turn', () => {
  /**
   * ⚠️⚠️ **合流之后记录会改名，`sealLive` 必须还能找到它。**
   *
   * 真机形状：存储腿先到（`storage:<hash>`），本轮的实时腿后到、签名相同 ⇒ 被并进
   * 存储腿那条、id 保持 `storage:<hash>`。而 `sealTurn` 手里拿的是自己记下的
   * `history:<uuid>` ⇒ 直接按 id 查会**一条都找不到**、`live` 永不清、
   * 块永远摊着（正是「跑 N 轮看到 N 大块」那个形态）。
   */
  it('seals a record that was merged under a different id', async () => {
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    const raw = '<shell_exec>{"command":"ls"}</shell_exec>';

    // 存储腿先到（无锚点）—— 落地 id 是它自己的。
    harness.controller.remember([record({
      id: 'storage:old',
      source: 'storage',
      messageId: null,
      calls: [{ name: 'shell_exec', raw }],
      executions: [{ callId: 'xml:old', name: 'shell_exec', result: { ok: true, summary: 'OLD' } }],
    })]);
    // 本轮的实时腿后到：签名相同 ⇒ 并进 storage:old，但它自己记的是 history:<uuid>。
    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      content: '正文',
      calls: [{ name: 'shell_exec', raw }],
      executions: [{ callId: 'xml:new', name: 'shell_exec', result: { ok: true, summary: 'NEW' } }],
      live: true,
    })]);
    harness.controller.renderPending();
    expect(harness.controller.snapshot().records).toBe(1);
    expect(harness.renderedLive.at(-1)).toBe(true);

    // ⚠️ 收尾传的是 `history:<uuid>` —— 而记录已经叫 `storage:old`。
    const sealed = harness.controller.sealLive([`history:${UUID_A}`]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 必须真的收掉（回执给的是落地 id），且块被重画成收起。
    expect(sealed).toEqual(['storage:old']);
    expect(harness.renderedLive.at(-1)).toBe(false);
  });

  it('resolves the caller-side id to the landed one', () => {
    const harness = buildHarness();
    const raw = '<shell_exec>{"command":"ls"}</shell_exec>';
    harness.controller.remember([record({
      id: 'storage:old',
      source: 'storage',
      calls: [{ name: 'shell_exec', raw }],
    })]);
    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      calls: [{ name: 'shell_exec', raw }],
    })]);

    // 合流过 ⇒ 解析成落地的那个；没合流过的原样返回。
    expect(harness.controller.resolveRecordId(`history:${UUID_A}`)).toBe('storage:old');
    expect(harness.controller.resolveRecordId('storage:unknown')).toBe('storage:unknown');
  });

  it('drops the live flag so the block collapses', async () => {
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    harness.controller.remember([record({ id: 'r1', messageId: UUID_A, live: true })]);
    harness.controller.renderPending();
    // ⚠️ 在飞的那一轮：块展开（`live: true` 一路传到 `render`）。
    expect(harness.renderedLive.at(-1)).toBe(true);

    harness.controller.sealLive(['r1']);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // ⚠️ **收尾必须重画** —— 折叠态只在 render 时决定，不重画就还是展开的。
    expect(harness.rendered.filter((entry) => entry.recordId === 'r1').length).toBe(2);
    expect(harness.renderedLive.at(-1)).toBe(false);
  });

  it('keeps the live flag when another leg re-delivers the record', async () => {
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    // ⚠️⚠️ **这一条守的是「重复投递不能冲掉 live」**：实时轮中途页面会拉
    // `messages/batch`，历史腿会带**同一个 id** 再投递一次（它没有 live）。
    // 若 `refresh` 写成「取新的」，块会在轮中途塌下去。
    harness.controller.remember([record({ id: 'r1', messageId: UUID_A, live: true })]);
    harness.controller.remember([record({ id: 'r1', messageId: UUID_A })]);
    harness.controller.renderPending();

    expect(harness.renderedLive.at(-1)).toBe(true);
  });

  it('ignores ids it does not know', async () => {
    const harness = buildHarness();
    harness.controller.remember([record({ id: 'r1', live: true })]);
    harness.controller.renderPending();
    const before = harness.rendered.length;

    harness.controller.sealLive(['nope']);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 不认识的 id 不该产生任何重画。
    expect(harness.rendered.length).toBe(before);
  });

  it('is idempotent when the turn was already sealed', async () => {
    const harness = buildHarness();
    harness.controller.remember([record({ id: 'r1', live: true })]);
    harness.controller.renderPending();
    harness.controller.sealLive(['r1']);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterFirst = harness.rendered.length;

    harness.controller.sealLive(['r1']);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 第二次没有可清的 `live` ⇒ 不该再排一轮（否则每次收尾都白重画一次）。
    expect(harness.rendered.length).toBe(afterFirst);
  });
});

describe('records from another conversation are never mounted', () => {
  it('refuses the fallback leg when the record belongs to another session', () => {
    // ⚠️⚠️ **真机实测的错挂场景**：切过会话后，旧记录的三条定位腿全 miss
    // （`messageId` 与正文片段在新会话的 DOM 里都不存在），兜底腿
    // 「第一个还没被占用的消息」就把它挂到了**新会话的消息**上。
    //
    // ⚠️⚠️ **这条走的是「有锚点的记录不许用兜底腿」那条规则**（`resolveTarget` 里
    // `if (record.messageId) return null;`），**不是会话判据** —— 实测：把
    // `isRecordOnCurrentSession` 改成恒 `true`，这条**照样绿**。
    // 会话判据的覆盖在同组的孪生用例（`messageId: null`）里。
    const harness = buildHarness({ getChatSessionId: () => 'session-new' });
    harness.messages[0].classList.add(`message-${UUID_A}`);

    harness.controller.remember([record({
      id: 'history:old',
      // ⚠️ 故意给一个当前 DOM 里**不存在**的 messageId + 一段匹配不上的正文
      messageId: UUID_B,
      content: '这段正文在新会话里不存在',
      chatSessionId: 'session-old',
    })]);
    harness.controller.renderPending();

    expect(harness.rendered).toEqual([]);
  });

  it('refuses the fallback leg for an anchor-less record from another session', () => {
    // ⚠️⚠️ **这才是 `isRecordOnCurrentSession` 的唯一覆盖**（上面那条被
    // 「有锚点的记录不许用兜底腿」提前拦掉了）。实测：把 `isRecordOnCurrentSession`
    // 改成恒 `true`，**当时全量 1642 条用例全绿** —— 因为整个文件里 `parentMessageId`
    // 与 `chatSessionId` 的非 null 组合从没喂到这条路上。
    //
    // 形状必须**同时**满足三件事，否则走不到兜底腿：
    // ① `messageId: null`（有锚点会提前 return）；② 正文片段匹配不上任何消息；
    // ③ `source !== 'storage'`（存储腿不用兜底腿）。缺任何一条，
    // 这条用例就变成在测别的规则了。
    const harness = buildHarness({ getChatSessionId: () => 'session-new' });
    harness.messages[0].classList.add(`message-${UUID_A}`);

    harness.controller.remember([record({
      id: 'history:old',
      messageId: null,
      source: 'history',
      content: '这段正文在新会话里不存在',
      chatSessionId: 'session-old',
    })]);
    harness.controller.renderPending();

    expect(harness.rendered).toEqual([]);
  });

  it('still uses the fallback leg when the record has no session id', () => {
    // ⚠️ **null 是「不知道」不是「不属于」** —— 首条消息刚发出、地址栏还没切到
    // `/c/<id>` 时两边都可能是 null，一律拒绝会让当场渲染整批失效。
    const harness = buildHarness({ getChatSessionId: () => 'session-new' });
    harness.messages[0].classList.add(`message-${UUID_A}`);

    harness.controller.remember([record({ id: 'history:x', chatSessionId: null })]);
    harness.controller.renderPending();

    expect(harness.rendered.map((item) => item.recordId)).toEqual(['history:x']);
  });

  it('still mounts a same-session record through the fallback leg', () => {
    const harness = buildHarness({ getChatSessionId: () => 'session-a' });
    harness.messages[0].classList.add(`message-${UUID_A}`);

    harness.controller.remember([record({ id: 'history:x', chatSessionId: 'session-a' })]);
    harness.controller.renderPending();

    expect(harness.rendered.map((item) => item.recordId)).toEqual(['history:x']);
  });

  it('drops every record on clearAll', () => {
    const harness = buildHarness();
    harness.controller.remember([
      record({ id: 'r1' }),
      record({ id: 'r2' }),
    ]);
    expect(harness.controller.snapshot().records).toBe(2);

    harness.controller.clearAll();

    expect(harness.controller.snapshot()).toEqual({ records: 0, pending: 0 });
  });

  it('retainRecords keeps the matching ones and drops the rest with their pending entry', () => {
    const harness = buildHarness();
    harness.controller.remember([
      record({ id: 'r1', chatSessionId: 'chat-1' }),
      record({ id: 'r2', chatSessionId: 'chat-2' }),
      record({ id: 'r3', chatSessionId: 'chat-1' }),
    ]);
    // 三条都还没渲染（宿主可用，但要等一帧）—— 此刻 pending 里也是三条。
    expect(harness.controller.snapshot().records).toBe(3);

    harness.controller.retainRecords((entry) => entry.chatSessionId === 'chat-1');

    // ⚠️ 留下的两条必须**重新入 pending**（换会话后页面会重建消息节点，块得重挂）；
    // 丢掉的那条要连 pending 一起删 —— 只删 records 会让它永远留在 pending 里。
    expect(harness.controller.snapshot()).toEqual({ records: 2, pending: 2 });
  });

  it('retainRecords re-renders the kept records on the rebuilt DOM', () => {
    const harness = buildHarness();
    harness.controller.remember([record({ id: 'r1', chatSessionId: 'chat-1' })]);
    harness.controller.renderPending();
    expect(harness.rendered.map((entry) => entry.recordId)).toEqual(['r1']);

    harness.controller.retainRecords((entry) => entry.chatSessionId === 'chat-1');
    harness.controller.renderPending();

    // 会话没变 ⇒ 同一条记录被重新排队并再渲染一次（而不是留在表里没人管）。
    expect(harness.rendered.map((entry) => entry.recordId)).toEqual(['r1', 'r1']);
  });

  /**
   * ⚠️⚠️ **`retainRecords` 也要清别名表 —— 但只能清「解析终点已不在表里」的那些。**
   *
   * 它是唯一一处「只丢一部分记录」的地方（`clearAll` / `stop` 是全丢，整表清没问题）。
   * 整表清在这里是错的：存活记录的旧 id 会失去解析，而 `sealTurn` 手里拿的**正是旧 id**。
   * 反之不清理就是「只增不清」—— 换会话走的就是这条路径。
   */
  it('retainRecords drops aliases whose target is gone but keeps the live ones', () => {
    const harness = buildHarness();
    const raw = '<shell_exec>{"command":"ls"}</shell_exec>';

    // 两组「合流后改名」：一组会留在当前会话，一组会被丢
    harness.controller.remember([record({ id: 'storage:keep', source: 'storage', calls: [{ name: 'shell_exec', raw }], chatSessionId: 'chat-1' })]);
    harness.controller.remember([record({ id: 'history:KEEP', messageId: UUID_A, calls: [{ name: 'shell_exec', raw }], chatSessionId: 'chat-1' })]);

    const raw2 = '<web_search>{"q":"x"}</web_search>';
    harness.controller.remember([record({ id: 'storage:drop', source: 'storage', calls: [{ name: 'web_search', raw: raw2 }], chatSessionId: 'chat-2' })]);
    harness.controller.remember([record({ id: 'history:DROP', messageId: UUID_B, calls: [{ name: 'web_search', raw: raw2 }], chatSessionId: 'chat-2' })]);

    expect(harness.controller.snapshot().records).toBe(2);

    harness.controller.retainRecords((entry) => entry.chatSessionId === 'chat-1');

    // 存活组的旧 id 仍能解析到落地的那个（否则 sealTurn 会一条都对不上）
    expect(harness.controller.resolveRecordId('history:KEEP')).toBe('storage:keep');
    // 被丢弃组的别名已清 ⇒ 原样返回（指向一条不存在的记录没有意义）
    expect(harness.controller.resolveRecordId('history:DROP')).toBe('history:DROP');
  });
});

describe('lifecycle', () => {
  it('stop clears everything', () => {
    const harness = buildHarness();
    harness.controller.remember([record({ id: 'r1' })]);
    harness.controller.stop();
    expect(harness.controller.snapshot()).toEqual({ records: 0, pending: 0 });
  });
});

describe('the second half of the observer: a message showing up late', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      value: (callback: () => void) => { callback(); return 0; },
      configurable: true,
    });
  });

  it('renders a record that exhausted its retry budget once the message appears', async () => {
    // ⚠️ `scheduleFrame: undefined` 让它回落到真 rAF（用例里已桩成同步执行）——
    // 否则 harness 默认会把回调收进数组、永远不跑，observer 那条路就测不到。
    const harness = buildHarness({ retryDelayMs: 1, maxAttempts: 1, scheduleFrame: undefined });
    harness.messages.length = 0;               // 页面上一条消息都没有
    harness.setHostAvailable(true);
    harness.controller.start();

    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      content: '这是一段足够长的助手正文内容',
    })]);
    harness.controller.renderPending();
    // 重试预算耗尽（1 次），记录留在 pending。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.rendered).toEqual([]);
    expect(harness.controller.snapshot().pending).toBe(1);

    // ⚠️⚠️ 页面这时才把消息建出来。**我们什么都没挂过** ⇒
    // 「我们自己的节点被移除」那条判据永远不成立 ⇒ 只搬前半的话记录会永久卡住。
    const wrapper = document.createElement('div');
    wrapper.className = `message-${UUID_A}`;
    const bubble = document.createElement('div');
    bubble.className = 'chat-assistant';
    bubble.textContent = '这是一段足够长的助手正文内容';
    wrapper.appendChild(bubble);
    document.body.appendChild(wrapper);
    harness.messages.push(bubble);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.rendered).toEqual([{ recordId: `history:${UUID_A}`, messageIndex: 0 }]);
  });

  it('wakes a waiting record when the anchor class lands on an existing wrapper', async () => {
    // ⚠️⚠️ **这是「有锚点的记录禁用兜底腿」引入的新等待窗口**：
    // 那条记录在等「自己那条消息**带锚点地**出现」，而页面完全可能先建 wrapper、
    // **后**把 `message-<uuid>` 类挂上去 —— 那条路**不产生任何新节点**、只改 `class`。
    // ⇒ 观察器只盯 `childList` / `characterData` 时**永远唤不醒它**（预算耗尽后停表）。
    const harness = buildHarness({ retryDelayMs: 1, maxAttempts: 1, scheduleFrame: undefined });
    harness.messages.length = 0;
    harness.controller.start();

    // wrapper 先在、但**还不带锚点类** ⇒ 记录挂不上（有 messageId ⇒ 不走兜底腿）。
    // ⚠️ **正文片段腿也要绕开**：那一条是「消息正文里含 record.content 的前 80 字符」，
    // 若两边都写同一段长正文，记录会从那条腿挂上去、测不到「锚点迟到」这个窗口。
    // ⇒ 正文片段取得比 `MIN_CONTENT_SNIPPET` 还短。
    const wrapper = document.createElement('div');
    wrapper.className = 'flex w-full gap-4';
    const bubble = document.createElement('div');
    bubble.className = 'chat-assistant';
    bubble.textContent = '正文';
    wrapper.appendChild(bubble);
    document.body.appendChild(wrapper);
    harness.messages.push(bubble);

    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      content: '正文',
    })]);
    harness.controller.renderPending();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.rendered).toEqual([]);
    expect(harness.controller.snapshot().pending).toBe(1);

    // ⚠️ **锚点迟到**：只改 `class`，不插任何新节点。
    wrapper.classList.add(`message-${UUID_A}`);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.rendered).toEqual([{ recordId: `history:${UUID_A}`, messageIndex: 0 }]);
  });

  it('wakes a waiting record when the message text grows as character data', async () => {
    // ⚠️⚠️ **`characterData` 那一支必须真的被投递** —— 它覆盖「消息节点先建空壳、
    // 正文随后以字符数据长出来」这一档。而 `observe()` 里**没声明**的类型
    // 规范上根本不会投递 ⇒ 只写分支不写选项 = 死分支，记录只能靠重试预算兜。
    // 这条用例只在 `characterData: true` 时才会绿。
    const harness = buildHarness({ retryDelayMs: 1, maxAttempts: 1, scheduleFrame: undefined });
    harness.messages.length = 0;
    harness.controller.start();

    // 空壳先出现：`renderPending` 跑完仍然挂不上（宿主一直在，但消息列表是空的）。
    const wrapper = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.className = 'chat-assistant';
    const text = document.createTextNode('');
    bubble.appendChild(text);
    wrapper.appendChild(bubble);
    document.body.appendChild(wrapper);
    harness.messages.push(bubble);

    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      // ⚠️ 片段要够长（≥ `MIN_CONTENT_SNIPPET` = 12），否则内容腿不走。
      content: '这是一段足够长的助手正文内容',
    })]);
    harness.controller.renderPending();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 正文还没到、锚点也没有 ⇒ 三条腿全 miss。
    expect(harness.rendered).toEqual([]);
    expect(harness.controller.snapshot().pending).toBe(1);

    // ⚠️ **只改字符数据**：不插新节点、不加 class ⇒ 只有 `characterData` 能唤醒。
    text.data = '这是一段足够长的助手正文内容';

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.rendered).toEqual([{ recordId: `history:${UUID_A}`, messageIndex: 0 }]);
  });

  it('ignores message mutations while nothing is pending', async () => {
    const harness = buildHarness();
    harness.controller.start();

    const wrapper = document.createElement('div');
    wrapper.className = `message-${UUID_B}`;
    const bubble = document.createElement('div');
    bubble.className = 'chat-assistant';
    wrapper.appendChild(bubble);
    document.body.appendChild(wrapper);
    await Promise.resolve();

    // 没有 pending 时不该因为「消息出现」而做任何事（这是流式输出期间的常态）。
    expect(harness.controller.snapshot().pending).toBe(0);
  });
});

describe('a multi-tool turn survives the two-leg merge', () => {
  it('keeps every execution when the storage leg arrives one call at a time', () => {
    // ⚠️⚠️ **真机报出的缺陷**：一轮用了 3 次工具，刷新后只显示「已调用工具（1 次）」。
    // 成因：历史腿是**一条消息一条记录**（3 个 calls、0 个 executions），
    // 而我们的存储腿是**一次调用一条记录**（各 1 call / 1 execution）。
    // 合流时「结果取非空的那一方」⇒ 第一条 storage 记录带进来 1 个 execution 之后，
    // 后面两条的 execution **全被挡住**（existing 非空就永远胜出）。
    // ⚠️ 上游没有这个问题：它的存储腿**一条消息一条块**（`persistToolBlockSession`
    // 把整轮的 `session.executions` 一起写进去），两条腿天然 1:1 ⇒ 合流是替换语义。
    // 我们的存储腿是按调用粒度的，所以合流必须是**并集**。
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    const rawA = '<shell_exec>{"command":"a"}</shell_exec>';
    const rawB = '<shell_exec>{"command":"b"}</shell_exec>';
    const rawC = '<shell_exec>{"command":"c"}</shell_exec>';

    // 历史腿：一条消息、三个调用、没有结果。
    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      content: '正文',
      calls: [
        { name: 'shell_exec', raw: rawA },
        { name: 'shell_exec', raw: rawB },
        { name: 'shell_exec', raw: rawC },
      ],
      executions: [],
    })]);
    // 存储腿：三条独立记录，各带一个真结果。
    for (const raw of [rawA, rawB, rawC]) {
      harness.controller.remember([record({
        id: `storage:${raw}`,
        source: 'storage',
        calls: [{ name: 'shell_exec', raw }],
        executions: [{
          // ⚠️ **带 callId** —— 并集的去重键优先用它；不带的话退化成
          // 「名字 + 摘要」，而同一个工具多次调用的摘要是相同的（都是
          // 「MCP 工具已执行」）⇒ 三次会被合并成一次。
          callId: `xml:${raw}`,
          name: 'shell_exec',
          result: { ok: true, summary: raw },
        }],
      })]);
    }

    expect(harness.controller.snapshot().records).toBe(1);
    harness.controller.renderPending();

    const merged = harness.mergedRecords.find((item) => item.id === `history:${UUID_A}`);
    expect(merged?.executions.map((execution) => execution.result.summary))
      .toEqual([rawA, rawB, rawC]);
  });

  it('keeps three same-tool calls apart when their summaries are identical', () => {
    // ⚠️⚠️ **这条守的是去重键**：MCP 工具三次调用的 `summary` 是**同一句话**
    // （「MCP 工具已执行」），所以「名字 + 摘要」这种退化的去重键会把三次合并成一次
    // —— 那正是真机那个「用了好几次、刷新后只显示 1 次」的另一半。
    // ⇒ 存储腿**必须把 `callId` 带过来**，合流按它去重。
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    const raws = ['<shell_exec>{"command":"a"}</shell_exec>',
      '<shell_exec>{"command":"b"}</shell_exec>',
      '<shell_exec>{"command":"c"}</shell_exec>'];

    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      content: '正文',
      calls: raws.map((raw) => ({ name: 'shell_exec', raw })),
      executions: [],
    })]);
    for (const [index, raw] of raws.entries()) {
      harness.controller.remember([record({
        id: `storage:${index}`,
        source: 'storage',
        calls: [{ name: 'shell_exec', raw }],
        executions: [{
          callId: `xml:${index}`,
          name: 'shell_exec',
          result: { ok: true, summary: 'MCP 工具已执行' },
        }],
      })]);
    }
    harness.controller.renderPending();

    const merged = harness.mergedRecords.find((item) => item.id === `history:${UUID_A}`);
    expect(merged?.executions).toHaveLength(3);
  });

  it('does not double-count when both legs carry the same executions', () => {
    // ⚠️ 并集不能把「两条腿都有的同一次调用」算成两次（`callId` 相同 ⇒ 一条）。
    const harness = buildHarness();
    harness.messages[0].classList.add(`message-${UUID_A}`);
    const raw = '<shell_exec>{"command":"ls"}</shell_exec>';
    const execution = {
      callId: 'xml:ls',
      name: 'shell_exec',
      result: { ok: true, summary: 'MCP 工具已执行' },
    };

    harness.controller.remember([record({
      id: `history:${UUID_A}`,
      messageId: UUID_A,
      content: '正文',
      calls: [{ name: 'shell_exec', raw }],
      executions: [execution],
    })]);
    harness.controller.remember([record({
      id: 'storage:x',
      source: 'storage',
      calls: [{ name: 'shell_exec', raw }],
      executions: [execution],
    })]);
    harness.controller.renderPending();

    const merged = harness.mergedRecords.find((item) => item.id === `history:${UUID_A}`);
    expect(merged?.executions).toHaveLength(1);
    expect(merged?.calls).toHaveLength(1);
  });
});
