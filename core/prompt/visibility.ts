import { SUPPORTED_LOCALES, translate } from '../i18n/background';

export const VISIBLE_USER_PROMPT_START = '<!-- glm-visible-user-prompt:start -->';
export const VISIBLE_USER_PROMPT_END = '<!-- glm-visible-user-prompt:end -->';
const VISIBLE_USER_PROMPT_METADATA_PREFIX = '<!-- glm-visible-user-prompt:value=';
const VISIBLE_USER_PROMPT_METADATA_SUFFIX = ' -->';

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
  'Do not use <invoke name="...">',
  'Do not put executable tool XML',
];

export function markVisibleUserPrompt(prompt: string): string {
  return `${VISIBLE_USER_PROMPT_START}\n${prompt}\n${VISIBLE_USER_PROMPT_END}`;
}

export function markVisibleUserPromptMetadata(prompt: string): string {
  return `${VISIBLE_USER_PROMPT_METADATA_PREFIX}${encodeURIComponent(JSON.stringify(prompt))}${VISIBLE_USER_PROMPT_METADATA_SUFFIX}`;
}

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

function trimSingleBoundaryNewline(text: string): string {
  let next = text;
  if (next.startsWith('\r\n')) next = next.slice(2);
  else if (next.startsWith('\n')) next = next.slice(1);

  if (next.endsWith('\r\n')) next = next.slice(0, -2);
  else if (next.endsWith('\n')) next = next.slice(0, -1);

  return next;
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
