/**
 * 原生 `tool_call` 里那个工具名到底是不是**本轮目录里的本地工具** —— 零依赖纯函数。
 *
 * ⚠️ **为什么单独成文件**：它跑在**页面主世界**（`fetch-hook.ts` 的流式回调里）。
 * 而工具名的合法字符集与「按目录解析工具名」这两件事都在 `core/tool/` 里，
 * 那边的模块要拖整条 i18n 资源链（约 80–92 KB）⇒ **不能 import**。
 * 先例：`history-tool-names.ts` / `continuation-marker.ts` / `send-evidence.ts`
 * 都是零依赖 + 独立测试；`tests/tool-provider-import-boundary.test.ts` 也钉住
 * fetch-hook 的源码里不得出现 `DEFAULT_TOOL_DESCRIPTORS`。
 *
 * ## 为什么需要它（判据为什么不能是「整串相等」）
 *
 * `delta_name` 在真机上**不保证是干净的工具名** —— 实测两份抓包都是
 * 「工具名 + 模型自造的 XML 尾巴」，且闭合标签是 `</arg_value>`（不在我们的任何提示词里）：
 *
 * ```
 * shell_status>\n{}\n</arg_value>      （另一份是 shell_status>{}</arg_value>）
 * ```
 *
 * 而 `tool_response` 那条路**也堵了**：服务端的 `tool_name` 同样被原样回显成那串垃圾，
 * 且有一份样本整轮**根本没有 `tool_response`**。⇒ 判据只能建立在 `tool_call` 帧上，
 * 且不能要求「整串相等」，也不能去枚举形态（今天补 `>`、明天可能是别的）。
 */

/**
 * 工具名之后**还能算作名字一部分**的字符。
 *
 * ⚠️ 与 `core/tool/invocation.ts` 的 `isValidToolTagName`
 * （`/^[A-Za-z_][A-Za-z0-9_.:-]*$/`）**同一套字符集** —— 这样「名字的一部分」与
 * 「名字之后的垃圾」用同一把尺子分。改那边要同步这边（两份字面量，跨不过去）。
 */
const NAME_CHAR = /[A-Za-z0-9_.:-]/;

/**
 * 从 `delta_name` 这样的原始串里认出**本轮目录中的**那个工具名；认不出返回 `null`。
 *
 * 判据：串（trim 后）以某个目录内工具名**开头**，且紧跟其后的字符
 * **不是** `NAME_CHAR`（或已到串尾）。
 *
 * ⚠️ **不做「包含」匹配** —— `something>shell_status` 这种名字出现在中段的不认。
 * 方向是**宁可漏判不可误判**：漏判只是少一次纠错，误判会让一轮正常回答收到
 * 一条「你把工具用错了」的错误提示。
 * ⚠️ **沙箱工具（`Bash` / `Read` 这类）天然不命中** —— 它们不在本轮目录里，
 * 这条判据不需要单独为它们开分支。
 * ⚠️ **取第一个命中的即可，不依赖目录顺序** —— 边界判据已经排除了「短名遮蔽长名」：
 * 若目录里同时有 `shell` 与 `shell_exec`，遇到 `shell_exec…` 时短名会在
 * 「下一个字符是 `_`（`NAME_CHAR`）」这一条上被挡掉，只剩长名能命中。
 * ⚠️ 这条不变式**与边界判据是同一件事的两面** —— 谁把边界检查去掉，
 * 目录顺序就会开始影响结论（`tests/zai-tool-name-match.test.ts` 有对应用例）。
 */
export function matchCatalogToolName(
  raw: unknown,
  catalogNames: Iterable<string>,
): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  for (const candidate of catalogNames) {
    if (typeof candidate !== 'string' || !candidate) continue;
    if (!value.startsWith(candidate)) continue;
    const next = value.charAt(candidate.length);
    if (next !== '' && NAME_CHAR.test(next)) continue;
    return candidate;
  }
  return null;
}
