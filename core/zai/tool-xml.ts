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
