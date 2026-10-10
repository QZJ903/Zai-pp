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
import { stripZaiToolCalls } from './tool-xml';

export interface ZaiHistoryCleanupStats {
  /** 被还原成用户原文的消息数（增广文本）。 */
  restoredUserMessages: number;
  /** 被剥掉工具 XML 的文本字段数（`content` 与各 `content_block.content` 分开计）。 */
  strippedToolFields: number;
  /** 被删掉的工具块总数。 */
  strippedToolBlocks: number;
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
}

const EMPTY_STATS: ZaiHistoryCleanupStats = {
  restoredUserMessages: 0,
  strippedToolFields: 0,
  strippedToolBlocks: 0,
};

/**
 * 就地清洗一份历史响应。**不认识的形状一律原样返回**（`stats` 全 0）。
 *
 * ⚠️ **「不认识就原样返回」是刻意的失败方向** —— 剥错会打碎页面渲染，
 * 而漏剥只是「还看得见 XML」。两者代价不对称。
 */
export function stripZaiHistoryResponse(
  json: unknown,
  options: ZaiHistoryCleanupOptions,
): ZaiHistoryCleanupStats {
  const root = asRecord(json);
  if (!root) return { ...EMPTY_STATS };

  const stats: ZaiHistoryCleanupStats = { ...EMPTY_STATS };

  // `GET /api/v1/chats/{id}`：chat.history.messages
  const chat = asRecord(root.chat);
  const history = chat ? asRecord(chat.history) : null;
  const detailMessages = history ? asRecord(history.messages) : null;
  if (detailMessages) {
    for (const message of Object.values(detailMessages)) {
      cleanMessage(message, options, stats);
    }
  }

  // `POST /api/v1/chats/{id}/messages/batch`：data
  const batchData = asRecord(root.data);
  if (batchData) {
    for (const message of Object.values(batchData)) {
      cleanMessage(message, options, stats);
    }
  }

  return stats;
}

function cleanMessage(
  message: unknown,
  options: ZaiHistoryCleanupOptions,
  stats: ZaiHistoryCleanupStats,
): void {
  const record = asRecord(message);
  if (!record) return;

  // ① 用户消息：整段还原成用户原文（顺带丢掉系统段、工具 schema 与提醒段）。
  if (typeof record.content === 'string' && isUserRole(record)) {
    const visible = extractVisibleUserPrompt(record.content);
    if (visible !== null && visible !== record.content) {
      record.content = visible;
      stats.restoredUserMessages += 1;
    }
  }

  // ② 工具 XML：`content` 与 `content_blocks[].content` 都过一遍。
  //    ⚠️ **不按 `content_blocks[].type` 分叉**（`reasoning` / `text` 一视同仁）——
  //    上游对所有文本 fragment 也是这个口径；且实测 `reasoning` 块零工具块，
  //    特判只会多一条将来会漂移的判据。
  //    ⚠️ **逐块原地改、绝不把多块合并写回第一块** —— 合并会把推理与正文揉成一段
  //    （上游注释专门警告过：交付物会变成纯推理文本）。
  if (typeof record.content === 'string') {
    stripText(record, 'content', options, stats);
  }
  if (Array.isArray(record.content_blocks)) {
    for (const block of record.content_blocks) {
      const blockRecord = asRecord(block);
      if (!blockRecord || typeof blockRecord.content !== 'string') continue;
      stripText(blockRecord, 'content', options, stats);
    }
  }
}

function stripText(
  holder: Record<string, unknown>,
  key: string,
  options: ZaiHistoryCleanupOptions,
  stats: ZaiHistoryCleanupStats,
): void {
  const current = holder[key];
  if (typeof current !== 'string' || !current) return;
  const result = stripZaiToolCalls(current, options.toolNames);
  if (result.strippedBlocks === 0) return;
  holder[key] = result.text;
  stats.strippedToolFields += 1;
  stats.strippedToolBlocks += result.strippedBlocks;
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
