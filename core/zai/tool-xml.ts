import { findFirstXmlToolTag } from '../tool/xml-tags';

export interface ZaiToolXmlBlock {
  /** 开标签里的工具名（与文本里写的字面一致，可能是短名/别名）。 */
  name: string;
  /** 从开标签到闭标签的整段原文。 */
  raw: string;
  /** 标签之间的正文（已 `trim`）。 */
  body: string;
}

/**
 * 找出文本里所有完整的 `<工具名>…</工具名>` 块。
 *
 * ⚠️⚠️ **必须用线性扫描，绝不能用 `[\s\S]*?` 正则。**
 * 那族正则（`<\s*(名)\s*>\s*([\s\S]*?)\s*<\/\s*\1\s*>`）在
 * 「开标签后跟**连续空白**、且全文没有配对闭合标签」时**灾难性回溯**。
 * 实测（Node，逐字复刻该正则）：1,000 空白 116ms / 2,000 空白 872ms /
 * 4,000 空白 6.5s / **8,000 空白 49s**。
 * ⚠️ **触发条件是「纯空白连续段」** —— 中间插一个非空白字符、或末尾补上闭合标签，
 * 都会立刻回到 0ms。所以这不是「长文本慢」，是 `\s*` 与 `[\s\S]*?\s*` 量词重叠回溯。
 * 上游同一处也是这么修的（`core/interceptor/tool-parser.ts` 的线性扫描器），
 * 回归用例见上游 `tool-parser-redos-regression`。
 *
 * ⚠️ **未闭合时要从开标签之后继续找，不能 `break`** —— 后面可能还有完整的块。
 */
export function findZaiToolXmlBlocks(
  text: string,
  names: readonly string[],
): ZaiToolXmlBlock[] {
  const blocks: ZaiToolXmlBlock[] = [];
  if (!text || names.length === 0) return blocks;
  const nameSet = new Set(names);

  let fromIndex = 0;
  while (fromIndex < text.length) {
    const open = findFirstXmlToolTag(text, nameSet, { closing: false, fromIndex });
    if (!open) break;
    // 闭合标签只在**同名**里找（与正则的 `\1` 反向引用同义）。
    const close = findFirstXmlToolTag(
      text,
      new Set([open.name]),
      { closing: true, fromIndex: open.endIndex },
    );
    if (!close) {
      fromIndex = open.endIndex;
      continue;
    }
    blocks.push({
      name: open.name,
      raw: text.slice(open.index, close.endIndex),
      body: text.slice(open.endIndex, close.index).trim(),
    });
    fromIndex = close.endIndex;
  }
  return blocks;
}

/**
 * 找出文本里要**删掉**的 `<工具名>…</工具名>` 区间（左闭右开）。
 *
 * 与 `findZaiToolXmlBlocks` 的差别只在**未闭合块的处置**：那个函数对未闭合块
 * `continue`（不认它是块，因为「识别出可执行调用」不能靠半截标签）；
 * 这个函数把**被截断在标签里的**那一段也算进来 —— 那半截标签同样是内部协议、
 * 不该给用户看。
 *
 * ⚠️⚠️ **未闭合块不能无条件吃到文本末尾** —— 上游 `history-cleanup.ts` 是
 * `end: text.length`，那是**流式**语义（流里还没有后文）。这里是**完整的历史文本**，
 * 模型写「关于 `<shell_exec>` 这个标签，它用于执行命令」这类**提及**时后面还有正文，
 * 无条件吃到底会**静默删掉用户可见的正文**。
 *
 * ⇒ 判据是**开标签之后那段（trim 后）像不像 JSON 载荷的开头**：
 * - `<shell_exec>\n{"command":"ls"`（截断在载荷里）→ 以 `{` 开头 ⇒ 删到末尾；
 * - `<shell_exec>`（开标签就断了）→ 空 ⇒ 删到末尾；
 * - `关于 <shell_exec> 这个标签…`（提及）→ 以散文开头 ⇒ **不删**。
 *
 * ⚠️ 两条失败方向都**不静默**：漏删只让 XML 多留一会儿（用户看得见），
 * 误删会让正文消失（也看得见）。选前者。
 *
 * ⚠️ 返回的区间**保证互不重叠且按位置递增**（`findFirstXmlToolTag` 每次都从上一个
 * 闭合标签之后继续扫）。
 */
export interface ZaiToolXmlRange {
  start: number;
  end: number;
  name: string;
  /** 未找到配对闭合标签、且被判定为「截断在标签里」（见上方判据）。 */
  unterminated: boolean;
}

/**
 * 未闭合块「像不像被截断的载荷」。
 *
 * ⚠️ 只认 `{` / `[` / 空 —— **不认别的形态**：多认一种就多一分误删正文的风险，
 * 而工具载荷按提示词约定**必须是 JSON 对象**。
 */
function looksLikeTruncatedPayload(after: string): boolean {
  const trimmed = after.trim();
  return trimmed === '' || trimmed.startsWith('{') || trimmed.startsWith('[');
}

export function findZaiToolXmlStripRanges(
  text: string,
  names: readonly string[],
): ZaiToolXmlRange[] {
  const ranges: ZaiToolXmlRange[] = [];
  if (!text || names.length === 0) return ranges;
  const nameSet = new Set(names);

  let fromIndex = 0;
  while (fromIndex < text.length) {
    const open = findFirstXmlToolTag(text, nameSet, { closing: false, fromIndex });
    if (!open) break;
    const close = findFirstXmlToolTag(
      text,
      new Set([open.name]),
      { closing: true, fromIndex: open.endIndex },
    );
    if (close) {
      ranges.push({ start: open.index, end: close.endIndex, name: open.name, unterminated: false });
      fromIndex = close.endIndex;
      continue;
    }
    if (looksLikeTruncatedPayload(text.slice(open.endIndex))) {
      ranges.push({ start: open.index, end: text.length, name: open.name, unterminated: true });
    }
    fromIndex = open.endIndex;
  }
  return ranges;
}

/**
 * 从文本里删掉所有工具 XML 块，返回剩下的可见文本。
 *
 * ⚠️ **只删块本身，不做空行折叠** —— 剥完可能留下连续的 `\n\n\n\n`。
 * 上游有一整套跨帧围栏状态机专门折叠它（9 条用例），那是**流式**才需要的：
 * 逐帧剥时空白会散落在不同帧里、必须跨帧记账。这里是**一次性处理完整文本**，
 * markdown 渲染下连续空行本来就只呈现为一个空行，**先不做**（真机看效果再定）。
 *
 * ⚠️ 与 `parseToolXml` 的**方向相反**：那个是「找出可执行调用」，这个是「把调用删掉」。
 * 两者共用同一个线性扫描器（`findFirstXmlToolTag`），**不要在这里另写正则** ——
 * `[\s\S]*?` 那族正则在「开标签后跟连续空白、且无配对闭合标签」时灾难性回溯
 * （见本文件顶部的实测数据）。
 */
export function stripZaiToolCalls(
  text: string,
  names: readonly string[],
): { text: string; strippedBlocks: number } {
  const ranges = findZaiToolXmlStripRanges(text, names);
  if (ranges.length === 0) return { text, strippedBlocks: 0 };
  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    parts.push(text.slice(cursor, range.start));
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(''), strippedBlocks: ranges.length };
}
