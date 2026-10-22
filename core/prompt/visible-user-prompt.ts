/**
 * 「可见用户提示词」的标记与提取 —— **零依赖纯字符串模块**。
 *
 * ⚠️⚠️ **为什么单独成文件**：这段逻辑有两个消费者，它们的**加载环境完全不同**：
 * - `core/prompt/augmentation.ts`（隔离世界 / 后台）—— 负责**写**标记；
 * - `core/zai/history-cleanup.ts`（**页面主世界**）—— 负责**读**标记，把历史响应里
 *   被我们注入过的文本还原成用户原文。
 *
 * 主世界的代码跑在**每一个 z.ai 页面**上，多拉一个模块就是页面多一份开销。
 * 而 `core/prompt/visibility.ts` 为了「提醒段识别」从 i18n 资源派生常量
 * （`SUPPORTED_LOCALES.map(...)`），**整条 i18n 资源链（约 80 KB）会跟着进来**。
 * 这里只做字符串比对、**不需要任何文案**，所以抽出来。
 *
 * ⚠️ **导出面必须与原位置完全一致** —— `visibility.ts` 继续 re-export 本文件的全部导出，
 * 既有 import 路径（`from './visibility'` / `from '../core/prompt/visibility'`）不变。
 */

export const VISIBLE_USER_PROMPT_START = '<!-- zai-visible-user-prompt:start -->';
export const VISIBLE_USER_PROMPT_END = '<!-- zai-visible-user-prompt:end -->';
export const VISIBLE_USER_PROMPT_METADATA_PREFIX = '<!-- zai-visible-user-prompt:value=';
export const VISIBLE_USER_PROMPT_METADATA_SUFFIX = ' -->';

export function markVisibleUserPrompt(prompt: string): string {
  return `${VISIBLE_USER_PROMPT_START}\n${prompt}\n${VISIBLE_USER_PROMPT_END}`;
}

export function markVisibleUserPromptMetadata(prompt: string): string {
  return `${VISIBLE_USER_PROMPT_METADATA_PREFIX}${encodeURIComponent(JSON.stringify(prompt))}${VISIBLE_USER_PROMPT_METADATA_SUFFIX}`;
}

/**
 * 从增广文本里取回**用户真正输入的那句话**；没有任何标记时返回 `null`。
 *
 * 两条路，metadata 优先：
 * - **metadata 行**（`markVisibleUserPromptMetadata`）：里面是**原始用户输入**的
 *   编码副本。自定义 skill 那一档会走这条 —— 标记对内是 skill 的合并 prompt，
 *   而 metadata 里才是用户原文。
 * - **START/END 标记对**：普通对话那一档走这条，标记对里就是用户原文。
 *
 * ⚠️ **调用方必须区分「返回 null」与「返回空串」** —— null 是「这段文本没有标记、
 * 不是我们注入的」，空串是「标记对里确实是空的」。
 */
export function extractVisibleUserPrompt(text: string): string | null {
  const metadataPrompt = extractVisibleUserPromptMetadata(text);
  if (metadataPrompt !== null) return metadataPrompt;

  const start = text.indexOf(VISIBLE_USER_PROMPT_START);
  if (start === -1) return null;

  const contentStart = start + VISIBLE_USER_PROMPT_START.length;
  const end = text.indexOf(VISIBLE_USER_PROMPT_END, contentStart);
  if (end === -1) return null;

  return trimSingleBoundaryNewline(text.slice(contentStart, end));
}

/**
 * metadata 行必须**紧邻** START 标记的上一行。
 *
 * ⚠️ **`text[visiblePromptStart - 1] !== '\n'` 那一判不能省** —— 少了它，
 * 任意位置出现过的 metadata 前缀都会被当成本次标记的元数据。
 */
function extractVisibleUserPromptMetadata(text: string): string | null {
  const visiblePromptStart = text.indexOf(VISIBLE_USER_PROMPT_START);
  if (visiblePromptStart === -1 || text[visiblePromptStart - 1] !== '\n') return null;

  const metadataLineEnd = visiblePromptStart - 1;
  const metadataLineStart = text.lastIndexOf('\n', metadataLineEnd - 1) + 1;
  const metadataLine = text.slice(metadataLineStart, metadataLineEnd);
  if (!metadataLine.startsWith(VISIBLE_USER_PROMPT_METADATA_PREFIX) ||
    !metadataLine.endsWith(VISIBLE_USER_PROMPT_METADATA_SUFFIX)) {
    return null;
  }

  const contentStart = VISIBLE_USER_PROMPT_METADATA_PREFIX.length;
  const contentEnd = metadataLine.length - VISIBLE_USER_PROMPT_METADATA_SUFFIX.length;

  try {
    const decoded = JSON.parse(decodeURIComponent(metadataLine.slice(contentStart, contentEnd)));
    return typeof decoded === 'string' ? decoded : null;
  } catch {
    return null;
  }
}

/** 标记对与内容之间各有一个换行（`markVisibleUserPrompt` 写的），剥掉它们。 */
function trimSingleBoundaryNewline(text: string): string {
  let next = text;
  if (next.startsWith('\r\n')) next = next.slice(2);
  else if (next.startsWith('\n')) next = next.slice(1);

  if (next.endsWith('\r\n')) next = next.slice(0, -2);
  else if (next.endsWith('\n')) next = next.slice(0, -1);

  return next;
}
