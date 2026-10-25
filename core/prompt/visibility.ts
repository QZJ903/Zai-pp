import { SUPPORTED_LOCALES, translate } from '../i18n/background';

// 「可见用户提示词」的标记与提取在**零依赖**的 `visible-user-prompt.ts` 里 ——
// 主世界（`core/zai/history-cleanup.ts`）也要用它，而本文件为「提醒段识别」
// 拖了整条 i18n 资源链（约 80 KB）。这里原样转出，**既有 import 路径全部不变**。
export {
  VISIBLE_USER_PROMPT_END,
  VISIBLE_USER_PROMPT_START,
  extractVisibleUserPrompt,
  markVisibleUserPrompt,
  markVisibleUserPromptMetadata,
} from './visible-user-prompt';

import {
  VISIBLE_USER_PROMPT_METADATA_PREFIX,
  VISIBLE_USER_PROMPT_START,
  extractVisibleUserPrompt,
} from './visible-user-prompt';

/**
 * 提醒段的识别特征，**按 locale 从资源派生**（标题行 + 必现行）。
 *
 * ⚠️ **不能在这里另抄一份字面量** —— 曾经抄过，en 的标题改成
 * 「Local tool call format reminder:」之后这份常量没跟上，于是
 * `containsToolFormatReminder` 对 en 恒为 false，剥离守卫静默失效。
 * 更早还漏了「必现行」也是分语言的（zh 是「可用工具标签名：」）。
 * 文案由 `core/i18n/resources/<locale>/prompt.ts` 决定，这里只做投影。
 */
const TOOL_REMINDER_SIGNATURES: readonly { heading: string; requiredLine: string }[] =
  SUPPORTED_LOCALES.flatMap((locale) => {
    const lines = translate(locale, 'prompt.toolFormatReminder').split('\n');
    // 模板首行是 `---` 分隔符，标题在第 2 行、必现行在第 3 行。
    const heading = lines[1]?.trim() ?? '';
    const requiredLine = lines[2]?.trim() ?? '';
    // 必现行带 `{names}` 占位，比对时只用占位之前的部分。
    const literal = requiredLine.split('{')[0]!.trim();
    return heading && literal ? [{ heading, requiredLine: literal }] : [];
  });

const TOOL_REMINDER_FRAGMENT_PREFIXES = [
  ...TOOL_REMINDER_SIGNATURES.map((signature) => signature.heading),
  ...TOOL_REMINDER_SIGNATURES.map((signature) => signature.requiredLine),
  'These listed tools are executable by the extension.',
  // ⚠️ 前缀要跟着文案走：这句从「To call a tool」变成了「To call a local tool」。
  // 取共同前缀，免得每次给动词加限定都要同步这里。
  'To call a',
  'For MCP tools, prefer the short tag name',
  'For local file paths, use forward slashes',
  // ⚠️ **这一条当前匹配不到任何文案**（`toolFormatReminder` 里那句负例清单已经删了）。
  // **刻意保留**：`isToolReminderOnly` 也用来判**服务端历史里存着的旧提醒段**
  // （那些是旧措辞发出去的），删掉它会让历史里的老提醒剥不干净。
  // 下一次怀疑「提醒段剥不掉」时，先确认是不是这一档，别急着删。
  'Do not use <invoke name="...">',
  'Do not put executable tool XML',
];

/**
 * 剥掉我们注入的内部提示词文本，还原成**用户真正看到的那句话**。
 *
 * ⚠️ **主世界不用这个函数**（它要用 i18n 派生的提醒段识别，而主世界不该拖 i18n）——
 * 主世界只做标记提取（`extractVisibleUserPrompt`）。两条路的判据不同、**方向一致**：
 * 都返回用户原文，差别只在「没有标记时怎么办」：
 * 这里会继续尝试剥提醒段，主世界那边则原样返回。
 */
export function sanitizeInternalPromptText(
  text: string,
  fallbackVisiblePrompt?: string,
): string {
  const visiblePrompt = extractVisibleUserPrompt(text);
  if (visiblePrompt !== null) return visiblePrompt;

  if (isToolReminderOnly(text)) return '';

  if (containsToolFormatReminder(text)) {
    return fallbackVisiblePrompt ?? stripToolFormatReminder(text);
  }

  return text;
}

export function containsInternalPromptMarker(text: string): boolean {
  return text.includes(VISIBLE_USER_PROMPT_START) ||
    text.includes(VISIBLE_USER_PROMPT_METADATA_PREFIX) ||
    containsToolFormatReminder(text) ||
    isToolReminderOnly(text);
}

function containsToolFormatReminder(text: string): boolean {
  return TOOL_REMINDER_SIGNATURES.some((signature) => (
    text.includes(signature.heading) && text.includes(signature.requiredLine)
  ));
}

/** 文本里第一个提醒段标题的位置；没有任何一套 locale 的标题命中时返回 -1。 */
function findToolReminderHeading(text: string): number {
  let earliest = -1;
  for (const signature of TOOL_REMINDER_SIGNATURES) {
    const index = text.indexOf(signature.heading);
    if (index === -1) continue;
    if (earliest === -1 || index < earliest) earliest = index;
  }
  return earliest;
}

function stripToolFormatReminder(text: string): string {
  const headingIndex = findToolReminderHeading(text);
  if (headingIndex === -1) return text;

  const delimiterIndex = text.lastIndexOf('\n---', headingIndex);
  const cutIndex = delimiterIndex === -1 ? headingIndex : delimiterIndex;
  return text.slice(0, cutIndex).trim();
}

function isToolReminderOnly(text: string): boolean {
  const normalized = text.trimStart();
  if (!normalized) return false;

  return TOOL_REMINDER_FRAGMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
