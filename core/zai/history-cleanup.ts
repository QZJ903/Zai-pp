/**
 * 历史响应清洗（**主世界**）：把我们注入的内部文本与工具 XML 从会话历史里剥掉。
 *
 * 背景：z.ai 会**原样存下** `messages.content`（我们替换后的增广文本），刷新会话时
 * 页面从服务端把它读回来渲染 ⇒ 用户看到的是整段系统提示词 + 工具 schema + 提示词
 * 标记。模型吐的工具 XML（`<shell_exec>{…}</shell_exec>`）同理，一直留在正文里。
 *
 * 两个端点、两种形状（真机实测，2026-10）：
 *
 * | 端点 | 正文在哪 | 谁有正文 |
 * |---|---|---|
 * | `GET /api/v1/chats/{id}` | `chat.history.messages.<uuid>.content`（字符串） | **只有 user** |
 * | `POST /api/v1/chats/{id}/messages/batch` | `data.<uuid>.content` + `data.<uuid>.content_blocks[].content` | 两者都有 |
 *
 * ⚠️⚠️ **本模块跑在页面主世界**（被 `core/zai/fetch-hook.ts` 调用）—— 所以
 * **不许 import 任何带 i18n 资源链或 chrome API 的模块**。这正是「可见用户提示词」
 * 那段逻辑被抽到零依赖的 `core/prompt/visible-user-prompt.ts` 的原因
 * （`core/prompt/visibility.ts` 为「提醒段识别」拖了约 80 KB 的 i18n 资源）。
 *
 * ⚠️⚠️ **只剥，不「恢复」** —— 上游在剥的同时会生成 `ToolCallRestoreRecord`、
 * 刷新后把工具卡片重新渲染回页面。那套逻辑的锚点是 `.ds-message`（z.ai 没有），
 * 且要处理内联 agent（本项目首版就没移植那 23 文件）。**本项目只做剥离。**
 */

import { extractVisibleUserPrompt } from '../prompt/visible-user-prompt';
import {
  ZAI_CONTINUATION_PLACEHOLDER,
  isZaiContinuationPlaceholder,
  isZaiContinuationPrompt,
} from './continuation-marker';
import { findZaiToolXmlStripRanges } from './tool-xml';

export interface ZaiHistoryCleanupStats {
  /** 被还原成用户原文的消息数（增广文本）。 */
  restoredUserMessages: number;
  /** 被替换成占位符的**续跑 / nudge 模板**消息数。 */
  replacedContinuationMessages: number;
  /** 被剥掉工具 XML 的文本字段数（`content` 与各 `content_block.content` 分开计）。 */
  strippedToolFields: number;
  /** 被删掉的工具块总数。 */
  strippedToolBlocks: number;
  /**
   * 本次剥出来的**工具调用归属记录**条数（= 有工具块、且认得出消息 id 的消息数）。
   *
   * ⚠️ 与 `strippedToolFields` **不是一回事**：那个按「文本字段」计，这个是按「消息」计
   * （一条 assistant 消息可能既有 `content` 又有多个 `content_blocks`，但只出一条记录）。
   */
  collectedToolRecords: number;
}

/**
 * 一条「这条消息调用过哪些工具」的记录 —— **面板跨刷新恢复的锚点来源**。
 *
 * ⚠️⚠️ **它是剥工具 XML 的副产物，零额外解析成本**：`findZaiToolXmlStripRanges`
 * 本来就要扫全文、本来就知道每个块的起止与名字，只是从前的调用方把那个信息扔了
 * （`stripZaiToolCalls` 只返回 `{text, strippedBlocks}`）。
 */
export interface ZaiHistoryToolRecord {
  /** 消息 id（两个端点的消息记录**自己就带 `id` 字段**，不必从字典的键取）。 */
  messageId: string;
  /** 父消息 id（`parentId` / `parent_id` 任一）。 */
  parentMessageId: string | null;
  /** 这条消息**剥完之后的正文** —— 用作「按内容片段定位」的锚点。 */
  content: string;
  /** 调用过的工具：名字 + 块的 XML 原文（原文用于与存储腿对齐）。 */
  calls: { name: string; raw: string }[];
}

export interface ZaiHistoryCleanupOptions {
  /**
   * 要剥的工具标签名。
   *
   * ⚠️ **取自全局快照**（`hookState.toolDescriptorNames`，由隔离世界经
   * `SYNC_HOOK_STATE` 同步），与上游同口径。⇒ **用户删掉某个 MCP 工具后，
   * 历史里那个工具的 XML 不会被剥**（快照里已经没它了）。上游同样如此。
   * ⚠️ 用户消息那一半**不受这个限制** —— 它按我们自己的标记剥、与工具名无关。
   */
  toolNames: readonly string[];
  /**
   * 剥出工具块时，把「这条消息调用过哪些工具」回调出去。
   *
   * ⚠️ **刻意用回调、不改返回值形状** —— 返回值是 `ZaiHistoryCleanupStats`
   * （一个平铺的计数对象），把它改成「计数 + 记录数组」会让调用点与现有断言
   * 一起跟着动；而这条收集是**可选增强**（没人接就什么都不发生）。
   * ⚠️ **回调在每次清洗时都可能触发**（历史端点会被反复拉），所以接的一方
   * **必须按 `messageId` 去重**，不能每来一次就重挂一遍。
   */
  onToolRecords?: (records: readonly ZaiHistoryToolRecord[]) => void;
}

const EMPTY_STATS: ZaiHistoryCleanupStats = {
  restoredUserMessages: 0,
  replacedContinuationMessages: 0,
  strippedToolFields: 0,
  strippedToolBlocks: 0,
  collectedToolRecords: 0,
};

/**
 * 就地清洗一份历史响应。**不认识的形状一律原样返回**（`stats` 全 0）。
 *
 * ⚠️ **「不认识就原样返回」是刻意的失败方向** —— 剥错会打碎页面渲染，
 * 而漏剥只是「还看得见 XML」。两者代价不对称。
 *
 * ⚠️⚠️ **它同时是「工具记录收集」的唯一入口**（`options.onToolRecords`）——
 * 因为工具块的**起止与名字**只在这趟扫描里被算出来（见 `ZaiHistoryToolRecord` 的说明）。
 */
export function stripZaiHistoryResponse(
  json: unknown,
  options: ZaiHistoryCleanupOptions,
): ZaiHistoryCleanupStats {
  const root = asRecord(json);
  if (!root) return { ...EMPTY_STATS };

  const stats: ZaiHistoryCleanupStats = { ...EMPTY_STATS };
  // 整趟共用一份收集结果 —— 一次响应里可能有几十条消息，逐条回调会让接的一方
  // 反复做去重；攒齐了发一次，接的一方只需要处理一批。
  const collected: ZaiHistoryToolRecord[] = [];

  // `GET /api/v1/chats/{id}`：chat.history.messages
  const chat = asRecord(root.chat);
  const history = chat ? asRecord(chat.history) : null;
  const detailMessages = history ? asRecord(history.messages) : null;
  if (detailMessages) {
    for (const message of Object.values(detailMessages)) {
      cleanMessage(message, options, stats, collected);
    }
  }

  // `POST /api/v1/chats/{id}/messages/batch`：data
  const batchData = asRecord(root.data);
  if (batchData) {
    for (const message of Object.values(batchData)) {
      cleanMessage(message, options, stats, collected);
    }
  }

  // 攒齐了发一次（没人接就什么都不发生）。⚠️ **必须在返回之前**，
  // 且**即使 stats 全 0 也要发** —— 工具块可能在上一趟就被剥掉了，而这一趟
  // 仍然要能把记录补回来（页面会反复拉历史端点）。
  if (collected.length > 0) options.onToolRecords?.(collected);

  return stats;
}

function cleanMessage(
  message: unknown,
  options: ZaiHistoryCleanupOptions,
  stats: ZaiHistoryCleanupStats,
  collected: ZaiHistoryToolRecord[],
): void {
  const record = asRecord(message);
  if (!record) return;

  // 本消息级的收集槽 —— 一条消息里可能既有 `content` 又有多个 `content_blocks`，
  // 它们**同属一次回答**，所以攒成一条记录、最后一次性推出去。
  const calls: { name: string; raw: string }[] = [];
  const strip = (holder: Record<string, unknown>, key: string): void => {
    stripText(holder, key, options, stats, calls);
  };

  // ① 用户消息：续跑模板换占位符；普通增广文本还原成用户原文。
  if (typeof record.content === 'string' && isUserRole(record)) {
    // ⚠️⚠️ **续跑 / nudge 模板要先认出来** —— 它是**我们自己注入的**（DOM 注入让页面
    // 发出去），内容里带完整工具结果 JSON，而且**不含** `zai-visible-user-prompt` 标记
    // （续跑轮走的是「透传 body」那条分支，不经过 `augmentPrompt`）。
    // ⇒ 不单独处理的话，刷新会话时它会作为一条**用户消息**原样显示出来。
    //
    // ⚠️ **替换成不可见占位符、不是清空** —— 服务端按 parent/child 链组织消息，
    // 空内容会让那条链断掉（表现是刷新后那条消息整个消失）。
    // ⚠️ **幂等**：历史清洗会被反复调用，而占位符不含任何标签 ⇒ 第二次不会再命中
    // `isZaiContinuationPrompt`（这里仍显式判一次，是为了让 stats 不把「本来就已是
    // 占位符」算成一次替换）。
    //
    // ⚠️ **刻意用 `else if` 而不是提前 `return`** —— 提前返回会连带跳过下面 ② 的
    // 工具 XML 剥离。当前形状下续跑模板不会有 `content_blocks`，但那是**数据的性质**、
    // 不是这条分支该背的假设；少一层隐含前提就少一处将来会静默失效的地方。
    if (isZaiContinuationPrompt(record.content)) {
      if (!isZaiContinuationPlaceholder(record.content)) {
        record.content = ZAI_CONTINUATION_PLACEHOLDER;
        stats.replacedContinuationMessages += 1;
      }
    } else {
      const visible = extractVisibleUserPrompt(record.content);
      if (visible !== null && visible !== record.content) {
        record.content = visible;
        stats.restoredUserMessages += 1;
      }
    }
  }

  // ② 工具 XML：`content` 与 `content_blocks[].content` 都过一遍。
  //    ⚠️ **不按 `content_blocks[].type` 分叉**（`reasoning` / `text` 一视同仁）——
  //    上游对所有文本 fragment 也是这个口径；且实测 `reasoning` 块零工具块，
  //    特判只会多一条将来会漂移的判据。
  //    ⚠️ **逐块原地改、绝不把多块合并写回第一块** —— 合并会把推理与正文揉成一段
  //    （上游注释专门警告过：交付物会变成纯推理文本）。
  if (typeof record.content === 'string') {
    strip(record, 'content');
  }
  if (Array.isArray(record.content_blocks)) {
    for (const block of record.content_blocks) {
      const blockRecord = asRecord(block);
      if (!blockRecord || typeof blockRecord.content !== 'string') continue;
      strip(blockRecord, 'content');
    }
  }

  // ③ 收集归属记录（可选增强，见 `options.onToolRecords` 的说明）。
  //    ⚠️ **只收 assistant 侧**：用户消息的增广文本里也可能出现工具标签
  //    （提示词里的示例），那不是「调用过」。
  //    ⚠️ **只收认得出消息 id 的**：没有 id 就没有锚点，收了也挂不上去。
  if (calls.length === 0 || isUserRole(record)) return;
  const messageId = firstString(record.id, record.message_id, record.messageId);
  if (!messageId) return;
  collected.push({
    messageId,
    parentMessageId: firstString(record.parentId, record.parent_id, record.parentMessageId) ?? null,
    content: collectVisibleContent(record),
    calls,
  });
  stats.collectedToolRecords += 1;
}

/**
 * 收集时的「正文」—— 用作按内容片段定位的锚点。
 *
 * ⚠️ **取的是剥完之后的文本**（调用点在剥离之后）—— 剥前那份带着整段工具 XML，
 * 而页面渲染的是剥后那份，拿剥前的去比对会永远失配。
 */
function collectVisibleContent(record: Record<string, unknown>): string {
  if (typeof record.content === 'string') return record.content;
  if (!Array.isArray(record.content_blocks)) return '';
  return record.content_blocks
    .map((block) => asRecord(block)?.content)
    .filter((value): value is string => typeof value === 'string')
    .join('\n\n');
}

/**
 * 剥一个文本字段里的工具 XML，并把剥出来的块**记进 `calls`**。
 *
 * ⚠️⚠️ **这里直接调 `findZaiToolXmlStripRanges` 而不是 `stripZaiToolCalls`** ——
 * 后者只返回 `{text, strippedBlocks}`，**把块的起止与名字丢掉了**，而名字正是
 * 面板要显示的东西。改它的返回值会动到已经稳定的流式剥离链（它另有三处调用点），
 * 所以在这里自己走一遍：同一个线性扫描器，多拿一份 range 列表。
 * ⚠️ **不要在这里另写正则** —— 那族 `\s*[\s\S]*?\s*` 在「开标签后跟连续空白」时
 * 灾难性回溯（见 `core/zai/tool-xml.ts` 顶部的实测数据）。
 */
function stripText(
  holder: Record<string, unknown>,
  key: string,
  options: ZaiHistoryCleanupOptions,
  stats: ZaiHistoryCleanupStats,
  calls: { name: string; raw: string }[],
): void {
  const current = holder[key];
  if (typeof current !== 'string' || !current) return;
  const ranges = findZaiToolXmlStripRanges(current, options.toolNames);
  if (ranges.length === 0) return;

  for (const range of ranges) {
    calls.push({ name: range.name, raw: current.slice(range.start, range.end) });
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    parts.push(current.slice(cursor, range.start));
    cursor = range.end;
  }
  parts.push(current.slice(cursor));

  holder[key] = parts.join('');
  stats.strippedToolFields += 1;
  stats.strippedToolBlocks += ranges.length;
}

/** 取第一个非空字符串（多别名兼容 —— 两个端点的字段名不完全一致）。 */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * 角色判据：`role` / `message_role` 任一为 `'user'`（大小写不敏感）。
 *
 * ⚠️ **不认识的角色不还原** —— 还原只对「我们注入过的用户消息」有意义；
 * 对 assistant 消息跑 `extractVisibleUserPrompt` 会在模型恰好复述了那段标记时
 * 把它的回复替换成用户原文。
 */
function isUserRole(record: Record<string, unknown>): boolean {
  const role = typeof record.role === 'string'
    ? record.role
    : (typeof record.message_role === 'string' ? record.message_role : '');
  return role.toLowerCase() === 'user';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
