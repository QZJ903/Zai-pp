/**
 * 记忆内容的**归一化去重键**。
 *
 * 独立成一个零依赖模块，是因为它有两个消费者、而它们的依赖闭包完全不同：
 * - `core/memory/importer.ts` 跑在后台，可以随意引 store；
 * - **内容脚本**（判断「这批记忆是不是已经导入过」）不能引 `importer.ts` ——
 *   它会经 `./store` 把 repository + IndexedDB 层整块拖进内容脚本的产物。
 *
 * ⚠️ **两份实现必然分叉**：判「已导入」与判「重复」用的必须是同一个归一化，
 * 否则会出现「预览说没有重复、卡片说已经导入过」这种自相矛盾。
 */

/**
 * 内容归一化：**Unicode 兼容归一化** + 小写 + 空白折叠 + 去首尾。
 * 空串表示这条记忆没有可比对的内容。
 *
 * ⚠️ **NFKC 是承重的** —— 只做小写与空白折叠时，「记忆（重要）」与「记忆(重要)」、
 * 「ＡＢＣ」与「ABC」、NFC 与 NFD 的「café」都会判成**不同内容**，于是同一段记忆
 * 换个来源粘贴就被判成新条目、重复导入。同仓 `normalizeSearchText` 用的也是 NFKC。
 */
export function memoryDedupeKey(content: string): string {
  return content.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
