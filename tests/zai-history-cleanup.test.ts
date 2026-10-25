import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ZAI_BUILTIN_HISTORY_TOOL_NAMES,
  ZAI_RETIRED_TOOL_NAMES,
  resolveHistoryToolNames,
} from '../core/zai/history-tool-names';
import { stripZaiHistoryResponse } from '../core/zai/history-cleanup';
import { ZAI_CONTINUATION_PLACEHOLDER } from '../core/zai/continuation-marker';
import {
  buildZaiContinuationPrompt,
  buildZaiNudgePrompt,
} from '../core/zai/continuation';
import { installZaiFetchHook, updateZaiHookState } from '../core/zai/fetch-hook';
import {
  findZaiToolXmlStripRanges,
  stripZaiToolCalls,
} from '../core/zai/tool-xml';
import { createDefaultToolDescriptors } from '../core/tool/invocation';
import { SHELL_TOOL_NAMES } from '../core/shell/contracts';
import { createSkillCreatorToolDescriptors } from '../core/skill/creator-tool';
import { createMemoryImportToolDescriptors } from '../core/memory/import-tool';
import { BROWSER_CONTROL_TOOL_NAMES } from '../core/browser-control/types';

/**
 * **历史剥离**（历史侧）。
 *
 * ⚠️ 真机实测的形状：
 * - `GET /api/v1/chats/{id}` → `chat.history.messages.<uuid>`，**只有 user 有 `content`**
 * - `POST /api/v1/chats/{id}/messages/batch` → `data.<uuid>`，user 在 `content`、
 *   assistant 在 `content_blocks[].content`（`type ∈ {reasoning, text}`）
 */

const UUID_A = '4636417d-6084-4203-9a7a-f9246d5ed027';
const UUID_B = '46e47678-0b4f-4c55-a972-21abd4e64a70';

const NAMES = ['shell_exec', 'memory_save', 'local_file_write'];

describe('zai history tool name baseline', () => {
  // ⚠️⚠️ **这份手抄清单必须与「真工厂派生集合 ∪ 已退役工具名」恰好相等** ——
  // 主世界不能 import 那些工厂（会拖整条 i18n 资源链，约 80 KB），
  // 所以只能手抄；而「手抄必然分叉」，唯一防线就是这条对账。
  // 加了新内置工具却忘了往清单里补 ⇒ 这条立刻红。
  it('matches the set derived from the real descriptor factories', () => {
    const derived = new Set<string>();
    for (const descriptor of createDefaultToolDescriptors('en')) derived.add(descriptor.name);
    for (const name of SHELL_TOOL_NAMES) derived.add(name);
    for (const descriptor of createSkillCreatorToolDescriptors('en')) derived.add(descriptor.name);
    for (const descriptor of createMemoryImportToolDescriptors('en')) derived.add(descriptor.name);
    // ⚠️⚠️ **浏览器控制的 18 个名字曾经漏在这份派生清单之外** —— 于是基线也没收它们，
    // 而动态快照在页面加载早期是空集 ⇒ 历史侧请求早于同步时**浏览器工具的 XML 剥不掉**
    // （症状：XML 与面板一起显示，而 shell / memory / skill 的都正常）。
    // 这条守卫的价值就在于：漏一个，这里立刻红。
    for (const name of BROWSER_CONTROL_TOOL_NAMES) derived.add(name);

    // 基线 = 真工厂派生集合 ∪ 已退役工具名（后者只为剥离老会话里残留的 XML）。
    for (const name of ZAI_RETIRED_TOOL_NAMES) derived.add(name);
    expect([...ZAI_BUILTIN_HISTORY_TOOL_NAMES].sort()).toEqual([...derived].sort());
  });

  it('unions the baseline with the dynamic snapshot instead of replacing it', () => {
    // 页面加载早期快照是空集 ⇒ 只靠快照会一个块都剥不掉（失败方向静默）。
    const early = resolveHistoryToolNames(new Set<string>());
    expect(early).toContain('shell_exec');
    expect(early).toContain('memory_save');
    // 动态快照带来用户自配的 MCP 工具名。
    const withMcp = resolveHistoryToolNames(new Set(['mcp_t_abc_some_tool']));
    expect(withMcp).toContain('mcp_t_abc_some_tool');
    expect(withMcp).toContain('shell_exec');
    // 去重：并集里没有重复项。
    expect(new Set(withMcp).size).toBe(withMcp.length);
  });
});

describe('stripZaiToolCalls', () => {
  it('removes every complete block and keeps the surrounding text', () => {
    const text = '先看看。\n\n<shell_exec>\n{"command":"ls"}\n</shell_exec>\n\n完成。';
    const result = stripZaiToolCalls(text, NAMES);
    expect(result.strippedBlocks).toBe(1);
    expect(result.text).toBe('先看看。\n\n\n\n完成。');
    expect(result.text).not.toContain('shell_exec');
  });

  it('removes several blocks of different tools', () => {
    const text = '<memory_save>{"a":1}</memory_save>中间<local_file_write>{"b":2}</local_file_write>';
    const result = stripZaiToolCalls(text, NAMES);
    expect(result.strippedBlocks).toBe(2);
    expect(result.text).toBe('中间');
  });

  it('leaves text with no tool block untouched (and reports zero)', () => {
    const text = '这是一段普通回答，提到了 shell_exec 但没有标签。';
    const result = stripZaiToolCalls(text, NAMES);
    expect(result.strippedBlocks).toBe(0);
    expect(result.text).toBe(text);
  });

  // ⚠️⚠️ **未闭合块只在「开标签之后一直到文末都没有别的非空白内容」时才删** ——
  // 模型写「我用 `<shell_exec>` 标签来执行」这类**提及**时后面还有正文，
  // 无条件吃到底会把正文一起删掉。
  it('removes an unterminated block only when nothing follows it', () => {
    const truncated = '正在执行。\n\n<shell_exec>\n{"command":"ls"}';
    const removed = stripZaiToolCalls(truncated, NAMES);
    expect(removed.strippedBlocks).toBe(1);
    expect(removed.text).toBe('正在执行。\n\n');

    // 反面对照：开标签后面还有正文 ⇒ **不删**（那是提及，不是调用）。
    const mentioned = '关于 <shell_exec> 这个标签，它用于执行命令。';
    const kept = stripZaiToolCalls(mentioned, NAMES);
    expect(kept.strippedBlocks).toBe(0);
    expect(kept.text).toBe(mentioned);
  });

  it('does not remove tags that are not in the name list', () => {
    const text = '<unknown_tool>{"a":1}</unknown_tool>正文。';
    const result = stripZaiToolCalls(text, NAMES);
    expect(result.strippedBlocks).toBe(0);
    expect(result.text).toBe(text);
  });

  it('supports whitespace-padded open tags (the scanner allows them)', () => {
    const text = '前< shell_exec >{"command":"ls"}</ shell_exec>后';
    const result = stripZaiToolCalls(text, NAMES);
    expect(result.strippedBlocks).toBe(1);
    expect(result.text).toBe('前后');
  });

  it('reports ranges that are ordered and non-overlapping', () => {
    const text = 'a<shell_exec>1</shell_exec>b<memory_save>2</memory_save>c';
    const ranges = findZaiToolXmlStripRanges(text, NAMES);
    expect(ranges.map((r) => r.name)).toEqual(['shell_exec', 'memory_save']);
    expect(ranges[0]!.end).toBeLessThanOrEqual(ranges[1]!.start);
    expect(ranges.every((r) => !r.unterminated)).toBe(true);
  });

  it('is a no-op when the name list is empty', () => {
    const text = '<shell_exec>{"command":"ls"}</shell_exec>';
    expect(stripZaiToolCalls(text, []).strippedBlocks).toBe(0);
  });

  // ⚠️ **扫描器必须保持线性** —— 这条形态在旧正则下是灾难性回溯
  // （`\s*` 与 `[\s\S]*?\s*` 量词重叠），实测 8,000 空白 49 秒。
  it('stays linear on a long whitespace run without a closing tag', () => {
    const text = `<shell_exec>${' '.repeat(120_000)}`;
    const t0 = performance.now();
    const result = stripZaiToolCalls(text, NAMES);
    expect(performance.now() - t0).toBeLessThan(500);
    // 开标签之后全是空白 ⇒ 判为「截断在标签里」⇒ 整段删掉。
    expect(result.text).toBe('');
  });
});

describe('stripZaiHistoryResponse: chat detail endpoint', () => {
  const toolNames = resolveHistoryToolNames(new Set<string>());

  function detailBody(content: string, role: string): unknown {
    return {
      id: UUID_A,
      title: 't',
      chat: {
        history: {
          messages: {
            [UUID_A]: { id: UUID_A, parentId: null, role, timestamp: 1, content, models: ['glm-4.7'] },
          },
          currentId: UUID_A,
        },
      },
    };
  }

  it('restores the augmented user message back to the visible prompt', () => {
    const augmented = [
      '## 角色',
      '你是用户的私人 AI 助手。',
      '',
      '## Tools',
      '### Tool memory_save',
      '<memory_save>{"type":"user"}</memory_save>',
      '',
      '<!-- zai-visible-user-prompt:value=%22hi%22 -->',
      '<!-- zai-visible-user-prompt:start -->',
      'hi',
      '<!-- zai-visible-user-prompt:end -->',
      '',
      '---',
      '本地工具调用格式提醒：',
    ].join('\n');
    const body = detailBody(augmented, 'user');
    const stats = stripZaiHistoryResponse(body, { toolNames });

    expect(stats.restoredUserMessages).toBe(1);
    const message = (body as any).chat.history.messages[UUID_A];
    expect(message.content).toBe('hi');
  });

  it('does not restore an assistant message that merely quotes the marker', () => {
    // ⚠️ 还原只对**我们注入过的用户消息**有意义 —— 对 assistant 跑提取会在模型
    // 恰好复述了那段标记时把它的回复替换成用户原文。
    const quoted = '<!-- zai-visible-user-prompt:start -->\nhi\n<!-- zai-visible-user-prompt:end -->';
    const body = detailBody(quoted, 'assistant');
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.restoredUserMessages).toBe(0);
    expect((body as any).chat.history.messages[UUID_A].content).toBe(quoted);
  });

  it('leaves a message with no marker untouched', () => {
    const body = detailBody('普通的一条用户消息', 'user');
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.restoredUserMessages).toBe(0);
    expect((body as any).chat.history.messages[UUID_A].content).toBe('普通的一条用户消息');
  });

  it('strips tool XML from a user message content too', () => {
    const body = detailBody('看这个 <shell_exec>{"command":"ls"}</shell_exec> 输出', 'user');
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.strippedToolBlocks).toBe(1);
    expect((body as any).chat.history.messages[UUID_A].content).toBe('看这个  输出');
  });
});

describe('stripZaiHistoryResponse: messages batch endpoint', () => {
  const toolNames = resolveHistoryToolNames(new Set<string>());

  function batchBody(): unknown {
    return {
      chat_id: UUID_A,
      data: {
        [UUID_A]: { id: UUID_A, role: 'user', content: '看桌面', content_blocks: null },
        [UUID_B]: {
          id: UUID_B,
          role: 'assistant',
          content: null,
          content_blocks: [
            { type: 'reasoning', content: '我需要列目录。', started_at: 1 },
            { type: 'text', content: '好的。\n\n<shell_exec>\n{"command":"ls"}\n</shell_exec>', started_at: 2 },
          ],
        },
      },
      message_version: 1,
    };
  }

  it('strips tool XML out of a text content block', () => {
    const body = batchBody();
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.strippedToolBlocks).toBe(1);
    const blocks = (body as any).data[UUID_B].content_blocks;
    expect(blocks[1].content).toBe('好的。\n\n');
    expect(blocks[1].content).not.toContain('shell_exec');
  });

  it('also strips a tool block written inside a reasoning block', () => {
    // ⚠️ **刻意不按 `type` 分叉** —— 上游对所有文本 fragment 一视同仁；
    // 实测 reasoning 块零工具块，特判只会多一条将来会漂移的判据。
    const body = batchBody();
    // 把 text 块清空，只留 reasoning 块里的工具块 —— 否则会数到两个。
    (body as any).data[UUID_B].content_blocks[1].content = '好的。';
    (body as any).data[UUID_B].content_blocks[0].content =
      '我打算 <shell_exec>{"command":"ls"}</shell_exec> 一下。';
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.strippedToolBlocks).toBe(1);
    expect((body as any).data[UUID_B].content_blocks[0].content).toBe('我打算  一下。');
  });

  it('edits each block in place instead of merging them into the first', () => {
    // ⚠️ 上游注释专门警告过：把多块合并写回第一块会让交付物变成纯推理文本、
    // 原生代码块/图表渲染消失。这条把「逐块原地改」钉死。
    const body = batchBody();
    (body as any).data[UUID_B].content_blocks[0].content = '推理里也有 <shell_exec>{"command":"x"}</shell_exec>';
    stripZaiHistoryResponse(body, { toolNames });
    const blocks = (body as any).data[UUID_B].content_blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('reasoning');
    expect(blocks[1].type).toBe('text');
    expect(blocks[0].content).toBe('推理里也有 ');
    expect(blocks[1].content).toBe('好的。\n\n');
  });

  it('counts each stripped field separately from the blocks it contained', () => {
    const body = batchBody();
    (body as any).data[UUID_B].content_blocks[0].content = '<shell_exec>{"command":"a"}</shell_exec>';
    const stats = stripZaiHistoryResponse(body, { toolNames });
    // 两个字段各含一个块。
    expect(stats.strippedToolFields).toBe(2);
    expect(stats.strippedToolBlocks).toBe(2);
  });
});

describe('stripZaiHistoryResponse: shape tolerance', () => {
  const toolNames = resolveHistoryToolNames(new Set<string>());

  // ⚠️ **「不认识就原样返回」是刻意的失败方向** —— 剥错会打碎页面渲染，
  // 而漏剥只是「还看得见 XML」。两者代价不对称。
  it.each([
    ['null', null],
    ['a string', 'not json'],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['a body with a different shape', { result: { items: [] } }],
  ])('returns zero stats for %s', (_name, input) => {
    expect(stripZaiHistoryResponse(input, { toolNames })).toEqual({
      restoredUserMessages: 0,
      replacedContinuationMessages: 0,
      strippedToolFields: 0,
      strippedToolBlocks: 0,
      collectedToolRecords: 0,
    });
  });

  it('does not touch a message whose content is not a string', () => {
    const body = { data: { [UUID_A]: { role: 'user', content: { nested: true } } } };
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.strippedToolBlocks).toBe(0);
    expect((body as any).data[UUID_A].content).toEqual({ nested: true });
  });

  it('handles content_blocks that is not an array', () => {
    const body = { data: { [UUID_A]: { role: 'assistant', content_blocks: 'nope' } } };
    expect(() => stripZaiHistoryResponse(body, { toolNames })).not.toThrow();
  });

  // ⚠️⚠️ **「除落点外全部不变」用路径级 diff** ——
  // 逐字段抽查只覆盖「想到并写下来」的那几个，而契约是「其余一律不动」，
  // 含**将来服务端新加的、我们不认识的字段**。
  it('changes exactly the content paths and nothing else', () => {
    const body = {
      chat_id: UUID_A,
      message_version: 7,
      future_sibling: { keep: true },
      data: {
        [UUID_A]: {
          id: UUID_A,
          role: 'assistant',
          model: 'glm-5.3',
          future_field: [1, 2],
          content_blocks: [
            { type: 'reasoning', content: '想', started_at: 1 },
            { type: 'text', content: '答 <shell_exec>{"command":"ls"}</shell_exec>', started_at: 2 },
          ],
        },
      },
    };
    const before = snapshot(body);
    stripZaiHistoryResponse(body, { toolNames });
    expect(changedPaths(before, snapshot(body))).toEqual([`data.${UUID_A}.content_blocks[1].content`]);
  });

  it('changes exactly the restored content path on the detail endpoint', () => {
    const augmented = '系统段\n<!-- zai-visible-user-prompt:start -->\nhi\n<!-- zai-visible-user-prompt:end -->\n提醒段';
    const body = {
      id: UUID_A,
      chat: { history: { messages: { [UUID_A]: { id: UUID_A, role: 'user', content: augmented, models: ['m'] } }, currentId: UUID_A } },
      meta: { flags: null },
    };
    const before = snapshot(body);
    stripZaiHistoryResponse(body, { toolNames });
    expect(changedPaths(before, snapshot(body))).toEqual([`chat.history.messages.${UUID_A}.content`]);
  });
});

describe('stripZaiHistoryResponse: continuation / nudge templates', () => {
  const toolNames = resolveHistoryToolNames(new Set<string>());

  /** 模板里那条工具结果的真实形状（与生产 `ToolExecutionRecord` 同形）。 */
  function execution(overrides: Record<string, unknown> = {}) {
    return {
      name: 'shell_exec',
      result: { ok: true, summary: '列出 3 个文件' },
      ...overrides,
    } as never;
  }

  /**
   * 续跑 / nudge 模板 —— **真渲染派生，不手抄文案**。
   *
   * ⚠️⚠️ **为什么必须派生**（同批的 `zai-continuation-bubble.test.ts` 已把这条写成守则）：
   * 这两份文本是**我们自己拼的**，生产端唯一的真源是 `buildZaiContinuationPrompt` /
   * `buildZaiNudgePrompt`。手抄一份的失效形态是**静默**的 —— 改模板（换一句话、
   * 加一段失败恢复、改 `isAgent` 分支的措辞、甚至换掉结构标签）之后，
   * 这里的 fixture 仍是旧的，于是**这些用例开始测一个生产里已经不存在的字符串**，
   * 而它们恰好是「刷新后用户看得见」那一半的唯一守卫。
   * ⚠️ 实测：把 `continuation.ts` 的结构标签从 `<original_task>` 换成别的，
   * 手抄版的 47 条用例**全绿**、而派生版的气泡侧用例**红 11 条**。
   */
  const CONTINUATION_TEMPLATE = buildZaiContinuationPrompt(
    '看看桌面有什么',
    [execution()],
    ['memory_save', 'shell_exec'],
  );

  /** nudge 模板（用的是 `<tool_results_so_far>`，与续跑模板只差这一个标签）。 */
  const NUDGE_TEMPLATE = buildZaiNudgePrompt(
    '看看桌面有什么',
    '上轮正文',
    [],
    1,
    ['memory_save', 'shell_exec'],
  );

  function userMessageBody(content: string): unknown {
    return { data: { [UUID_A]: { id: UUID_A, role: 'user', content } } };
  }

  it('replaces a stored continuation template with the invisible placeholder', () => {
    // ⚠️ 这是本次修复的**目的**：续跑 prompt 是我们注入的，刷新后会作为一条用户消息
    // 原样显示（用户报的现象）。
    const body = userMessageBody(CONTINUATION_TEMPLATE);
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.replacedContinuationMessages).toBe(1);
    const content = (body as any).data[UUID_A].content;
    // ⚠️ **不能是空串** —— 服务端按 parent/child 链组织消息，空内容会让链断掉。
    expect(content).not.toBe('');
    expect(content).toBe(ZAI_CONTINUATION_PLACEHOLDER);
    expect(content).not.toContain('original_task');
    expect(content).not.toContain('工具续跑任务');
  });

  it('replaces a stored nudge template too (tool_results_so_far)', () => {
    // ⚠️ 只认 `<tool_results>` 会漏掉 nudge 轮 —— 那是**同一份判据**的第二个标签，
    // 漏认的表现是「nudge 轮的气泡刷新后照旧可见」。
    const body = userMessageBody(NUDGE_TEMPLATE);
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.replacedContinuationMessages).toBe(1);
    expect((body as any).data[UUID_A].content).toBe(ZAI_CONTINUATION_PLACEHOLDER);
  });

  it('is idempotent across repeated cleanups', () => {
    // 历史清洗会被反复调用（切会话、每轮回答结束）⇒ 第二次拿到的是已替换过的内容。
    const body = userMessageBody(CONTINUATION_TEMPLATE);
    stripZaiHistoryResponse(body, { toolNames });
    const second = stripZaiHistoryResponse(body, { toolNames });
    expect(second.replacedContinuationMessages).toBe(0);
    expect((body as any).data[UUID_A].content).toBe(ZAI_CONTINUATION_PLACEHOLDER);
  });

  it('does not touch an ordinary user message that merely mentions the tags', () => {
    // ⚠️ **只带一个标签不算模板** —— 用户可能就是在讨论这套机制。
    const single = '我看了 `<original_task>` 这个标签，它是干嘛的？';
    const body = userMessageBody(single);
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.replacedContinuationMessages).toBe(0);
    expect((body as any).data[UUID_A].content).toBe(single);
  });

  it('prefers the continuation branch over the visible-prompt restore', () => {
    // 万一一条消息同时带标记与模板标签（不该发生），判据必须**先认模板** ——
    // 否则会把它还原成标记对里的内容（那是模板的一部分），等于没处理。
    const both = `${CONTINUATION_TEMPLATE}\n<!-- zai-visible-user-prompt:start -->\nhi\n<!-- zai-visible-user-prompt:end -->`;
    const body = userMessageBody(both);
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.replacedContinuationMessages).toBe(1);
    expect(stats.restoredUserMessages).toBe(0);
    expect((body as any).data[UUID_A].content).toBe(ZAI_CONTINUATION_PLACEHOLDER);
  });

  it('still processes content_blocks on a template message (no early return)', () => {
    // ⚠️⚠️ 模板分支**刻意用 `else if` 而不是提前 `return`** —— 提前返回会连带跳过
    // 工具 XML 剥离。这条把「两个清洗不是互斥的」钉死：模板换占位符 **且**
    // `content_blocks` 里的工具块被剥。
    // ⚠️ 当前形状下续跑模板不会有 `content_blocks`，但那是**数据的性质**、不是这条
    // 分支该背的假设 —— 少一层隐含前提就少一处将来会静默失效的地方。
    const body = {
      data: {
        [UUID_A]: {
          id: UUID_A,
          role: 'user',
          content: CONTINUATION_TEMPLATE,
          content_blocks: [
            { type: 'text', content: '附带一句 <shell_exec>{"command":"ls"}</shell_exec> 说明' },
          ],
        },
      },
    };
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.replacedContinuationMessages).toBe(1);
    expect(stats.strippedToolBlocks).toBe(1);
    expect((body as any).data[UUID_A].content).toBe(ZAI_CONTINUATION_PLACEHOLDER);
    expect((body as any).data[UUID_A].content_blocks[0].content).toBe('附带一句  说明');
  });

  it('still strips tool XML from a non-template message', () => {
    // 反面对照：非模板消息走 else 分支，工具 XML 照样要剥。
    const body = userMessageBody('看这个 <shell_exec>{"command":"ls"}</shell_exec> 输出');
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.strippedToolBlocks).toBe(1);
    expect((body as any).data[UUID_A].content).toBe('看这个  输出');
  });

  it('does not replace a continuation template on an assistant message', () => {
    // 判据只在 user 分支里 —— assistant 消息里的模板标签（模型复述）不该被动。
    const body = { data: { [UUID_A]: { id: UUID_A, role: 'assistant', content: CONTINUATION_TEMPLATE } } };
    const stats = stripZaiHistoryResponse(body, { toolNames });
    expect(stats.replacedContinuationMessages).toBe(0);
    expect((body as any).data[UUID_A].content).toBe(CONTINUATION_TEMPLATE);
  });
});

/** 把对象摊平成 `路径 → 值` 的快照（路径级 diff 用）。 */
function snapshot(value: unknown, path = '', out: Record<string, string> = {}): Record<string, string> {
  if (value === null || typeof value !== 'object') {
    out[path] = JSON.stringify(value);
    return out;
  }
  if (Array.isArray(value)) {
    out[path] = `Array(${value.length})`;
    value.forEach((item, index) => snapshot(item, `${path}[${index}]`, out));
    return out;
  }
  const record = value as Record<string, unknown>;
  out[path] = `{${Object.keys(record).join(',')}}`;
  for (const key of Object.keys(record)) {
    snapshot(record[key], path ? `${path}.${key}` : key, out);
  }
  return out;
}

function changedPaths(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

/**
 * **接线守卫**：纯函数测试全绿**不构成「这条链被验证过」** ——
 * 上面那些断言喂的是 `stripZaiHistoryResponse`，而真正决定「用户看不看得见」
 * 的是 `fetch-hook` 有没有把它**接在历史路由上**。这一组走**真 hook**。
 *
 * ⚠️ **实测价值**：把 `fetch-hook` 里那个 `isZaiHistoryRoute` 分支改成直接透传，
 * 上面 28 条**全部照绿**（它们不经过 hook），只有这一组会红。
 */
describe('the real fetch hook cleans history responses', () => {
  const originalFetch = window.fetch;

  afterEach(() => {
    window.fetch = originalFetch;
  });

  const DETAIL_URL = `https://chat.z.ai/api/v1/chats/${UUID_A}`;
  const BATCH_URL = `https://chat.z.ai/api/v1/chats/${UUID_A}/messages/batch`;

  async function runThroughHook(url: string, body: unknown, method: string): Promise<unknown> {
    updateZaiHookState({
      toolDescriptorNames: new Set<string>(),
      onRequestBody: async (payload, requestId) => ({ body: payload, requestId }),
      onHeadersCaptured: () => undefined,
      onToolCall: () => undefined,
      onResponseComplete: () => undefined,
      onRequestTerminal: () => undefined,
      onHtmlChallenge: () => undefined,
      onUsageSnapshot: () => undefined,
    });
    const wire = JSON.stringify(body);
    window.fetch = (async () => new Response(wire, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof window.fetch;

    const uninstall = installZaiFetchHook();
    try {
      const response = await window.fetch(url, { method, body: method === 'POST' ? '{"ids":[]}' : undefined });
      return await response.json();
    } finally {
      uninstall();
    }
  }

  it('cleans a chat detail response fetched through the hook', async () => {
    const augmented = '系统段\n<!-- zai-visible-user-prompt:start -->\nhi\n<!-- zai-visible-user-prompt:end -->\n提醒段';
    const body = {
      id: UUID_A,
      title: 't',
      chat: { history: { messages: { [UUID_A]: { id: UUID_A, role: 'user', content: augmented } }, currentId: UUID_A } },
    };
    const out = await runThroughHook(DETAIL_URL, body, 'GET') as any;
    expect(out.chat.history.messages[UUID_A].content).toBe('hi');
  });

  it('cleans a messages/batch response fetched through the hook', async () => {
    const body = {
      chat_id: UUID_A,
      data: {
        [UUID_B]: {
          id: UUID_B,
          role: 'assistant',
          content_blocks: [{ type: 'text', content: '好的。<shell_exec>{"command":"ls"}</shell_exec>' }],
        },
      },
      message_version: 1,
    };
    const out = await runThroughHook(BATCH_URL, body, 'POST') as any;
    expect(out.data[UUID_B].content_blocks[0].content).toBe('好的。');
    // 其余字段原样保留。
    expect(out.message_version).toBe(1);
    expect(out.data[UUID_B].role).toBe('assistant');
  });

  it('does not run the augmentation branch for a history route', async () => {
    // ⚠️⚠️ **这条是最要紧的** —— `POST /messages/batch` 的 body 是 `{"ids":[…]}`，
    // 若它被当成可增强路由，`rewriteZaiLastUserMessage` 会**无条件写上
    // `signature_prompt`**，请求体变成 `{"ids":[…],"signature_prompt":"<两万字>"}`。
    // 这里断言「请求原样发出」= 增广没跑（`onRequestBody` 不被调用）。
    let augmentationCalls = 0;
    updateZaiHookState({
      toolDescriptorNames: new Set<string>(),
      onRequestBody: async (payload, requestId) => { augmentationCalls += 1; return { body: payload, requestId }; },
      onHeadersCaptured: () => undefined,
      onToolCall: () => undefined,
      onResponseComplete: () => undefined,
      onRequestTerminal: () => undefined,
      onHtmlChallenge: () => undefined,
      onUsageSnapshot: () => undefined,
    });
    const sent: string[] = [];
    window.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent.push(String(init?.body ?? ''));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof window.fetch;

    const uninstall = installZaiFetchHook();
    try {
      await window.fetch(BATCH_URL, { method: 'POST', body: '{"ids":["x"]}' });
      await window.fetch(DETAIL_URL, { method: 'GET' });
    } finally {
      uninstall();
    }
    expect(augmentationCalls).toBe(0);
    expect(sent[0]).toBe('{"ids":["x"]}');
  });

  it('rebuilds the response instead of handing back a drained body', async () => {
    // ⚠️⚠️ `await response.text()` 之后原 Response 就**读干了** —— 每一条后续路径
    // 都必须重建。返回已读干的响应给页面，表现是**整个会话加载不出来**。
    const body = { chat_id: UUID_A, data: {}, message_version: 1 };
    const out = await runThroughHook(BATCH_URL, body, 'POST');
    expect(out).toEqual(body);
  });

  it('passes a non-JSON history response through untouched', async () => {
    updateZaiHookState({
      toolDescriptorNames: new Set<string>(),
      onRequestBody: async (payload, requestId) => ({ body: payload, requestId }),
      onHeadersCaptured: () => undefined,
      onToolCall: () => undefined,
      onResponseComplete: () => undefined,
      onRequestTerminal: () => undefined,
      onHtmlChallenge: () => undefined,
      onUsageSnapshot: () => undefined,
    });
    window.fetch = (async () => new Response('<html>challenge</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof window.fetch;
    const uninstall = installZaiFetchHook();
    try {
      const response = await window.fetch(DETAIL_URL, { method: 'GET' });
      expect(await response.text()).toBe('<html>challenge</html>');
    } finally {
      uninstall();
    }
  });
});

describe('stripZaiHistoryResponse: tool record collection (panel anchors)', () => {
  const toolNames = resolveHistoryToolNames(new Set<string>());
  const ASSISTANT = 'aaaaaaaa-1111-2222-3333-444444444444';
  const USER = 'bbbbbbbb-1111-2222-3333-444444444444';
  const RAW = '<shell_exec>{"command":"ls"}</shell_exec>';

  it('collects one record per assistant message that had tool blocks', () => {
    const body = {
      data: {
        [ASSISTANT]: {
          id: ASSISTANT,
          parent_id: USER,
          role: 'assistant',
          content_blocks: [{ type: 'text', content: `前缀\n${RAW}\n后缀` }],
        },
      },
    };
    const collected: any[] = [];
    const stats = stripZaiHistoryResponse(body, {
      toolNames,
      onToolRecords: (records) => collected.push(...records),
    });

    expect(collected).toHaveLength(1);
    expect(stats.collectedToolRecords).toBe(1);
    expect(collected[0].messageId).toBe(ASSISTANT);
    expect(collected[0].parentMessageId).toBe(USER);
    // ⚠️ 调用记录要带**工具名与原文** —— 名字是面板要显示的，原文是与存储腿对齐的依据。
    expect(collected[0].calls).toEqual([{ name: 'shell_exec', raw: RAW }]);
  });

  it.each(['id', 'message_id', 'messageId'])(
    'accepts the message-id alias `%s`',
    (key) => {
      // ⚠️⚠️ **服务端在两个端点上用的是不同的键名**（`GET /chats/{id}` 的
      // `chat.history.messages.<uuid>` 与 `POST …/messages/batch` 的 `data.<uuid>`
      // 形状不同，同端点不同版本也漂过），所以收集侧用 `firstString` 兼容三个别名。
      // **只喂其中一个别名时，另外两个是零覆盖** —— 实测：把 `firstString` 里的
      // `record.messageId` 那一项删掉，只喂 `message_id` 的版本**照样全绿**，
      // 而真机上那条路径会静默变成「这条消息没有 id」⇒ 面板失去锚点。
      const body = {
        data: {
          [ASSISTANT]: {
            [key]: ASSISTANT,
            role: 'assistant',
            content_blocks: [{ type: 'text', content: `前缀\n${RAW}\n后缀` }],
          },
        },
      };
      const collected: any[] = [];
      stripZaiHistoryResponse(body, { toolNames, onToolRecords: (r) => collected.push(...r) });
      expect(collected, `消息 id 走 \`${key}\` 时应当收到一条记录`).toHaveLength(1);
      expect(collected[0].messageId, `\`${key}\` 应当被认成消息 id`).toBe(ASSISTANT);
    },
  );

  it.each(['parentId', 'parent_id', 'parentMessageId'])(
    'accepts the parent-message-id alias `%s`',
    (key) => {
      // ⚠️⚠️ 与上面那条同源：`parentMessageId` 在**桥的那一侧**也叫这个名字
      // （`ZaiHistoryToolRecord.parentMessageId`），最容易被误当成唯一形状。
      // 实测：把 `firstString` 里的 `record.parentMessageId` 那一项删掉，
      // 只喂 `parent_id` 的版本**全绿**。
      const body = {
        data: {
          [ASSISTANT]: {
            id: ASSISTANT,
            [key]: USER,
            role: 'assistant',
            content_blocks: [{ type: 'text', content: `前缀\n${RAW}\n后缀` }],
          },
        },
      };
      const collected: any[] = [];
      stripZaiHistoryResponse(body, { toolNames, onToolRecords: (r) => collected.push(...r) });
      expect(collected, `父消息 id 走 \`${key}\` 时应当收到一条记录`).toHaveLength(1);
      expect(collected[0].parentMessageId, `\`${key}\` 应当被认成父消息 id`).toBe(USER);
    },
  );

  it('anchors on the text that remains after stripping', () => {
    const body = {
      data: {
        [ASSISTANT]: {
          id: ASSISTANT,
          role: 'assistant',
          content_blocks: [{ type: 'text', content: `可见正文\n${RAW}` }],
        },
      },
    };
    const collected: any[] = [];
    stripZaiHistoryResponse(body, { toolNames, onToolRecords: (r) => collected.push(...r) });

    // ⚠️ 锚点必须是**剥完**的那份 —— 页面渲染的就是它；拿剥前那份去比对永远失配。
    expect(collected[0].content).toContain('可见正文');
    expect(collected[0].content).not.toContain('shell_exec');
  });

  it('never collects from a user message even if it quotes a tool tag', () => {
    const body = {
      data: {
        [USER]: {
          id: USER,
          role: 'user',
          content: `提示词示例：${RAW}`,
        },
      },
    };
    const collected: any[] = [];
    stripZaiHistoryResponse(body, { toolNames, onToolRecords: (r) => collected.push(...r) });

    // ⚠️ 用户消息里出现工具标签是**提示词示例**，不是「调用过」。
    expect(collected).toEqual([]);
  });

  it('skips a message with no id at all', () => {
    const body = {
      data: { x: { role: 'assistant', content_blocks: [{ content: RAW }] } },
    };
    const collected: any[] = [];
    stripZaiHistoryResponse(body, { toolNames, onToolRecords: (r) => collected.push(...r) });
    // 没有 id 就没有锚点，收了也挂不上。
    expect(collected).toEqual([]);
  });

  it('does not call back when nothing was stripped', () => {
    const onToolRecords = vi.fn();
    stripZaiHistoryResponse({ data: {} }, { toolNames, onToolRecords });
    expect(onToolRecords).not.toHaveBeenCalled();
  });

  it('merges several blocks of the same message into one record', () => {
    const body = {
      data: {
        [ASSISTANT]: {
          id: ASSISTANT,
          role: 'assistant',
          content_blocks: [
            { type: 'text', content: '<memory_save>{"a":1}</memory_save>' },
            { type: 'text', content: '<memory_update>{"b":2}</memory_update>' },
          ],
        },
      },
    };
    const collected: any[] = [];
    stripZaiHistoryResponse(body, { toolNames, onToolRecords: (r) => collected.push(...r) });
    // ⚠️ 同一条消息的多个块**同属一次回答** ⇒ 一条记录、两个 calls。
    expect(collected).toHaveLength(1);
    expect(collected[0].calls.map((call: any) => call.name)).toEqual(['memory_save', 'memory_update']);
  });
});
