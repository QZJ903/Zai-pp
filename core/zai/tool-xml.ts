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
 * ⚠️⚠️ **这组数据只对「带 `\s*` 的形态」成立，不能平移到别的正则上** ——
 * 那条「通知侧」正则（`<name\b[^>]*>[\s\S]*?</name>`）**没有 `\s*`**，
 * 实测「开标签 + 4,000 空白」**0.005 ms**（与上面 6.5 s 差六个数量级）。
 * ⚠️ 它**已在本轮删除** —— 通知侧改走本模块的 `findZaiToolXmlBlocks`（见 U4-2），
 * 现在全仓没有第二份「扫工具块」的正则。这组对照数据留在这里只说明一件事：
 * 判某个正则会不会退化，**按字面形态单独跑**，别引用邻近的实测数字。
 * 上游同一处也是这么修的（`core/interceptor/tool-parser.ts` 的线性扫描器），
 * 回归用例见上游 `tool-parser-redos-regression`。
 *
 * ⚠️ **未闭合时要从开标签之后继续找，不能 `break`** —— 后面可能还有完整的块。
 *
 * ⚠️⚠️ **复杂度闸门与 `findZaiToolXmlStripRanges` 同款**：每个名字只允许「找不到闭标签」一次。
 * 形态是模型在正文里反复**提及**标签（`关于 <shell_exec> 这个标签 …`），每个开标签都要再找
 * 一次闭标签，而找不到时那次搜索会一路扫到文末 ⇒ O(k·n)。
 * 实测 3,200 个提及 / 66 KB：**加闸门前 1,335 ms**、加闸门后与 `findZaiToolXmlStripRanges`
 * 同级（~1 ms）。本函数被**通知侧**（`fetch-hook` 的 `extractAndNotifyToolCalls`）调用，
 * 输入是无长度上限的 `assistantText` ⇒ 没有闸门时这条路径会被一次回复卡住 1.3 秒。
 * 失败方向与那个函数一致：**少剥一次**（用户看得见 XML）优于「误删正文」。
 */
export function findZaiToolXmlBlocks(
  text: string,
  names: readonly string[],
): ZaiToolXmlBlock[] {
  const blocks: ZaiToolXmlBlock[] = [];
  if (!text || names.length === 0) return blocks;
  const nameSet = new Set(names);
  const missedClose = new Set<string>();

  let fromIndex = 0;
  while (fromIndex < text.length) {
    const open = findFirstXmlToolTag(text, nameSet, { closing: false, fromIndex });
    if (!open) break;
    if (missedClose.has(open.name)) break;
    // 闭合标签只在**同名**里找（与正则的 `\1` 反向引用同义）。
    const close = findFirstXmlToolTag(
      text,
      new Set([open.name]),
      { closing: true, fromIndex: open.endIndex },
    );
    if (!close) {
      missedClose.add(open.name);
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
 * 闭合标签之后继续扫；未闭合那条一旦命中就 `break` —— 它已经吃到文末，不可能再与
 * 后面的区间重叠）。
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
 *
 * ⚠️ **`stream-strip.ts` 直接 import 这一个** —— 它本来就要 import `tool/xml-tags`，
 * 而本模块**只**依赖 `xml-tags`（`history-cleanup` 是反过来依赖本模块的）
 * ⇒ 共用不新增任何依赖链，也就不需要再抄第二份。
 */
export function looksLikeTruncatedPayload(text: string, fromIndex: number): boolean {
  const head = text.slice(fromIndex).trimStart().charAt(0);
  return head === '' || head === '{' || head === '[';
}

export function findZaiToolXmlStripRanges(
  text: string,
  names: readonly string[],
): ZaiToolXmlRange[] {
  const ranges: ZaiToolXmlRange[] = [];
  if (!text || names.length === 0) return ranges;
  const nameSet = new Set(names);

  // ⚠️⚠️ **每个名字只允许「找不到闭标签」一次** —— 这是本函数的复杂度闸门。
  // 形态：模型在正文里反复**提及**标签（`关于 <shell_exec> 这个标签 …`），每个开标签
  // 都要找一次闭标签，而找不到时那次搜索会一路扫到文末 ⇒ O(n²)。
  // 实测 3,200 个提及 / 66 KB ⇒ **1.25 秒**（单看「扫开标签」只要 3.9 ms）。
  // 真实数据里「同名开标签出现很多次、且都没有闭标签」不可能是载荷，所以每个名字
  // **第二次**出现无闭合时直接结束扫描 —— 失败方向是「少剥一次」（用户看得见 XML），
  // 与「误删正文」相比是安全的那一侧。
  const missedClose = new Set<string>();

  let fromIndex = 0;
  while (fromIndex < text.length) {
    const open = findFirstXmlToolTag(text, nameSet, { closing: false, fromIndex });
    if (!open) break;
    if (missedClose.has(open.name)) break;
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
    if (looksLikeTruncatedPayload(text, open.endIndex)) {
      ranges.push({ start: open.index, end: text.length, name: open.name, unterminated: true });
      // ⚠️⚠️ **命中就结束** —— 这一条已经吃到文末，后面不可能再有「能被正确切分」的块。
      // 继续扫会让第二个未闭合开标签也产出一条 `[x, text.length]`，两条**互相嵌套**：
      // 剥文本的结果碰巧还对，但 `strippedBlocks` 会多算、`calls` 会多报
      // （history 侧把它渲染成两个工具，而实际只有一个半截标签）。
      break;
    }
    missedClose.add(open.name);
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
