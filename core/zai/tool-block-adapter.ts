/**
 * 工具面板与 z.ai 站点之间的**粘合层**：把 `core/ui/` 那两个注入式模块
 * （`tool-block.ts` 纯 DOM / `tool-block-restore.ts` 编排）接到真实页面上。
 *
 * 分工：本模块管「站点事实」（选择器、正文提取、会话归属），
 * `core/ui/` 那两个只管「结构与调度」。
 *
 * ⚠️ **本模块跑在内容脚本（隔离世界）** —— 与 `core/ui/tool-result-cards.ts` 同环境。
 */

import type { ToolCardResult, ToolExecutionRecord } from '../types';

/**
 * 面板的挂载宿主：**响应内容容器**。
 *
 * ⚠️ **用这个稳定 id，不要用 `.markdown-prose`** —— 真机实测（探针 9 第二轮）：
 * `.chat-assistant` **自己就带 `markdown-prose` 类**，而 `querySelector` 返回第一个匹配，
 * 于是会挑到「只有一个子元素的外层」；`#response-content-container` 是语义 id
 * （不是构建哈希），每条助手消息**恰好一个**（实测 5/5），且 `overflow: visible`。
 */
export const ZAI_RESPONSE_HOST_SELECTOR = '#response-content-container';

/** 助手消息容器（与 `core/ui/tool-result-cards.ts` 同口径，已真机验证）。 */
export const ZAI_ASSISTANT_MESSAGE_SELECTOR = '.chat-assistant';

/**
 * 我们自己的注入 UI —— 被这些选择器命中的子树**不算消息自己的正文**。
 *
 * ⚠️⚠️ **这条判据是必需的不是讲究**：面板里的工具名与详情会进 `textContent`，
 * 而定位有一条腿是「消息正文里含内容片段」⇒ 不排除的话，**已挂过的消息会因为
 * 包含自己而再次命中**（上游那条腿漏了这一步，见 `tool-block-restore.ts` 的说明）。
 */
export const ZAI_INJECTED_UI_SELECTOR = [
  '.dpp-tool-block',
  '[data-dpp-result-cards]',
  '[data-dpp-hidden-continuation]',
  '.dpp-project-panel',
].join(', ');

/** 取页面上的全部助手消息（按 DOM 顺序）。 */
export function listZaiAssistantMessages(root: ParentNode = document): Element[] {
  return [...root.querySelectorAll(ZAI_ASSISTANT_MESSAGE_SELECTOR)];
}

/** 取某条消息的响应内容宿主。找不到返回 null（由调度层重试）。 */
export function resolveZaiResponseHost(message: Element): Element | null {
  return message.querySelector(ZAI_RESPONSE_HOST_SELECTOR);
}

/**
 * 取一条消息**自己的**正文 —— 排除我们注入的 UI 子树、排除折叠的思考过程。
 *
 * ⚠️ **思考过程（`.thinking-chain-container`）也要排除**：它渲染出来的文本
 * 与正文无关，把它算进来会让「按片段定位」在多条消息上乱命中。
 */
export function getZaiMessageOwnText(message: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.matches(ZAI_INJECTED_UI_SELECTOR)) return;
    if (element.matches('.thinking-chain-container')) return;
    for (const child of Array.from(element.childNodes)) walk(child);
  };
  walk(message);
  return parts.join(' ');
}

/**
 * 消息 wrapper 上那个锚点类名 —— **类名构造的唯一入口**。
 *
 * ⚠️ **读锚点与比锚点必须用同一个构造**：`readZaiMessageId` 从页面上**抽**id，
 * 而定位那条腿要判「这条消息带不带 `<id>`」—— 两处各写一遍 `message-${id}`
 * 会在改格式时静默分叉（一边抽得出、另一边比不中 ⇒ 锚点腿整条失效）。
 */
export function zaiMessageAnchorClass(messageId: string): string {
  return `message-${messageId}`;
}

/**
 * 取消息的 `message-<uuid>` 锚点里的 uuid。
 *
 * ⚠️ **锚点在 wrapper 上、不在 `.chat-assistant` 自己身上**（真机实测：wrapper 是
 * `div.flex.w-full.message-<uuid>…`，`.chat-assistant` 是它的后代）⇒ 要往上找几层。
 * ⚠️ **只对助手消息成立** —— user 消息的 wrapper 不带这个类。
 */
export function readZaiMessageId(message: Element, maxDepth = 6): string | null {
  let node: Element | null = message;
  for (let depth = 0; depth < maxDepth && node; depth += 1) {
    for (const className of node.classList ?? []) {
      const matched = /^message-([0-9a-f-]{36})$/i.exec(className);
      if (matched) return matched[1];
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * 这条消息**带不带**指定的锚点 id（往上找 `maxDepth` 层）。
 *
 * ⚠️⚠️ **它是「比锚点」的唯一实现**（`core/ui/tool-block-restore.ts` 通过依赖注入用它）——
 * 与 `readZaiMessageId` 放同一个文件，是为了让「抽」与「比」两侧共用
 * `zaiMessageAnchorClass` 这一个类名构造，不会各自演化。
 * ⚠️ **判据比 `readZaiMessageId` 宽**：那边用 `[0-9a-f-]{36}` 的正则**抽**（要有形状才敢认），
 * 这边是**逐字比类名**（id 已经从记录里来、不需要再猜形状）。
 * 两者不同源时，服务端 id 若不是标准 uuid 形态 ⇒ 一边认得、一边认不得。
 */
export function messageCarriesZaiAnchorId(
  message: Element,
  messageId: string,
  maxDepth = 6,
): boolean {
  if (!messageId) return false;
  const anchor = zaiMessageAnchorClass(messageId);
  let node: Element | null = message;
  for (let depth = 0; depth < maxDepth && node; depth += 1) {
    if (node.classList?.contains(anchor)) return true;
    node = node.parentElement;
  }
  return false;
}

/** 状态文案三档 —— 由调用方按 locale 给。 */
export interface ToolBlockStatusLabels {
  running: string;
  executed: string;
  failed: string;
}

/**
 * 一行状态。
 *
 * ⚠️ **判据是 `result.ok`，不是 `pending`** —— pending 行是**编排层**塞进来的占位
 * （它 `ok: true`，因为「还没失败」），而「执行中」这个文案要按 `pending` 单独判。
 * 两者的优先级：**pending 优先**（执行中还没结果），其次才看 ok。
 */
export function formatZaiToolStatus(
  execution: ToolExecutionRecord,
  labels: ToolBlockStatusLabels,
): string {
  if (execution.pending) return labels.running;
  return execution.result.ok ? labels.executed : labels.failed;
}

/** 标题（「已调用工具（N 次）」）—— 由调用方按 locale 给。 */
export type ToolBlockTitleFormatter = (count: number) => string;

/**
 * 详情的文本形态：**三段式**（`summary` + `detail` + `output: JSON`）。
 *
 * ⚠️⚠️ **口径来自上游 inline-agent 控制台的 `getToolResultDetailText`，不是
 * `.dpp-tool-block` 的 `formatToolResultDetail`。** 两者的差别是根本性的：
 * 后者是「有 `detail` 就不看 `output`」（我们原先照搬的就是它），
 * 前者**三段无条件拼接**。之所以换口径：取回正文类工具成功时 `detail` 只是
 * 「页面长度 N 字符」这种摘要、正文在 `output.content` 里 ⇒ 旧口径下正文
 * **永远进不了面板**（全仓除续跑链无人读 `output.content`）。
 *
 * ⚠️ **三段式会带来一处重复，这是照搬上游的代价、已知且接受**：MCP 类工具
 * （Shell Local / 用户自配的第三方 MCP）成功时 `detail` 按构造就是 `output`
 * 的缩进渲染（`core/mcp/client.ts` 的 `normalizeMcpToolResult`：
 * `detail = stringifyOutput(output)`）⇒ 同一份数据以「缩进 JSON」与
 * 「`output:` 紧凑 JSON」两种形态各出现一次。
 * ⚠️ **不要试图用判据消掉它**：`output` 过了一次跨上下文序列化，**键被排成字母序**
 * （`detail` 是插入序），所以「拿 detail 与重新序列化的 output 比字符串」恒不相等；
 * 而按 provider 判「detail 即 output 的渲染」在大 payload 上会**丢掉更长的那份**
 * （detail 在渲染层截 2000、output 截 4000）⇒ 判据只在「重复本来就不碍事」的
 * 小 payload 上生效，方向是反的。
 * ⇒ **重复由详情框的 `max-height: 160px` 兜住**（与上游同值），二者是配套的一对。
 *
 * ⚠️ **截断是必须的**：取回正文类工具的 `output.content` 上限 50_000 字符，
 * 不截就是一条把面板撑爆。取值与上游一致（detail / error 各 2000、output 4000）。
 */
export function formatZaiToolDetail(result: ToolCardResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(result.summary);
    if (result.detail) lines.push(clampDetailText(result.detail, DETAIL_MAX_CHARS));
  } else {
    // ⚠️ **失败分支保留「从 JSON detail 里抽可读错误」**（`looksLikeJson` +
    // `extractReadableError`）—— 那两个函数是上游 `.dpp-tool-block` 自己的，
    // 我们面板的祖先行为，不是本项目新加的。
    // 为什么保留：抽取只在一种场景命中 —— 第三方 MCP 服务把 JSON 塞进 content 文本
    // （`{"error":{"message":"…"}}`）。而我们自己的工具失败时 detail 全是纯文本
    // （memory 是译文、creator/import 是 `error.message`、browser 是
    // `normalized.message`、runtime 边界是 `message`）⇒ **成本为零，收益落在唯一
    // 一个我们无法自测的场景上**。
    // ⚠️ **不丢信息**：MCP 失败时 `error.message` 恰好等于 detail 那段原文
    // （`normalizeMcpToolResult` 里 `message: detail || …`）⇒ 抽出来的可读句在
    // detail 段、原文仍在下面的 `error:` 段，两份都在，只是详略分开。
    // ⇒ **这是与上游控制台公式唯一有意的分叉**，出处写明在此。
    const reason = readFailureReason(result).trim()
      || (result.error?.message ?? '').trim();
    if (!reason || reason === result.summary.trim()) {
      lines.push(result.summary);
    } else {
      lines.push(`${result.summary}\n${reason}`);
    }
    if (result.error) {
      lines.push(`error: ${clampDetailText(JSON.stringify(result.error), DETAIL_MAX_CHARS)}`);
    }
  }
  if (result.output !== undefined) {
    lines.push(`output: ${clampDetailText(JSON.stringify(result.output), OUTPUT_MAX_CHARS)}`);
  }
  return lines.filter(Boolean).join('\n');
}

/** 详情 / 错误段的字符上限（与上游 `clampDisplayText(…, 2000)` 同值）。 */
const DETAIL_MAX_CHARS = 2_000;
/** `output` 段的字符上限（与上游 `clampDisplayText(…, 4000)` 同值）。 */
const OUTPUT_MAX_CHARS = 4_000;

/**
 * 超限即截断并**显式标注**（上游 `clampDisplayText`）。
 *
 * ⚠️ **标记不能省** —— 不标的话读的人会以为「这就是全部」。
 * 与 `core/tool/execution-restore.ts` 的 `clampText` 同形（同一套 `...[truncated]` 约定）。
 */
function clampDetailText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

/**
 * 失败时 detail 的可读形态：**JSON 形状才尝试抽取，抽不出就原样返回**。
 *
 * ⚠️ **只认几种明确形状，认不出就返回原文**（`extractReadableError` 的契约）——
 * 猜错的代价是「把有用的原文换成一句没用的」，比不抽更糟。
 */
function readFailureReason(result: ToolCardResult): string {
  const detail = result.detail ?? '';
  if (detail && looksLikeJson(detail)) {
    const extracted = extractReadableError(detail);
    if (extracted) return extracted;
  }
  return detail;
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * 从错误的 JSON 文本里抽出人能读的那句。
 *
 * ⚠️ **只认几种明确形状，认不出就返回 null**（让调用方原样展示）——
 * 猜错的代价是「把有用的原文换成一句没用的」，比不抽更糟。
 */
function extractReadableError(jsonText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) {
    const texts = parsed
      .filter((item): item is { type?: unknown; text?: unknown } => Boolean(item) && typeof item === 'object')
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text as string);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
    if (record.error && typeof record.error === 'object') {
      const nested = (record.error as Record<string, unknown>).message;
      if (typeof nested === 'string') return nested;
    }
  }
  return null;
}

