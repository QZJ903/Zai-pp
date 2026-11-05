/**
 * 工具结果的**字节预算**（`execution.maxResultBytes` 的落地实现）。
 *
 * ⚠️⚠️ **这是全仓唯一一份「按 UTF-8 字节截断」的实现** —— 原来它私有在
 * `core/mcp/client.ts` 的 `truncateUtf8ToByteLimit`，而 `execution.maxResultBytes`
 * 在**本地 provider 链**上零消费者（`core/tool/runtime.ts` 只是把值往下传，
 * 没有任何一处按它裁）⇒ 18 个浏览器工具声明的 40 000 / 60 000 全部空转，
 * 连 `memory_*` 那几个 `4096` 也是。
 * 抽到这里之后 MCP 链与本地链共用同一份，口径不会分叉。
 *
 * ## 为什么要「回退到字符边界」而不是直接 `slice`
 *
 * `TextEncoder().encode(x).subarray(0, n)` 的最后一个字节可能落在多字节字符中间
 * （中文 3 字节、emoji 4 字节）。直接用 `TextDecoder` 解，坏字符会变成 **U+FFFD** ——
 * 而这是**会进模型**的正文，一个替换符顶掉一个汉字，等于内容被悄悄改了。
 * 所以从 `n` 往回退到第一个非延续字节（`10xxxxxx`）。
 */

export interface ByteTruncation {
  value: string;
  truncated: boolean;
}

/**
 * Character budget for one tool result's `output` payload.
 *
 * ⚠️⚠️ **The producer and the consumers must share this number, not each carry a copy.**
 * Three places clamp the same value and they have to agree:
 * ① the continuation template (`core/zai/continuation.ts`) — what the model actually sees;
 * ② the persisted history (`core/tool/history.ts`) — what the panel restores after a reload;
 * ③ producers that build the payload (`mcp_discover`) — which must **shape** their output to
 *    fit, because a payload that only gets clamped later is a **half-truncated JSON string**
 *    the model cannot parse, not a shorter list it can still use.
 *
 * ⚠️ The unit is **characters of `JSON.stringify(output)`**, not bytes — every consumer
 * above slices the serialized string with `.length`. Measuring bytes here and slicing
 * characters there would make the two disagree by 3–4× on CJK text.
 */
export const TOOL_OUTPUT_MAX_CHARS = 8_000;

/**
 * 把 `value` 截到 **UTF-8 `maxBytes` 字节以内**，边界回退到完整字符。
 *
 * ⚠️ **不加 `...[truncated]` 标记** —— 这一层只回答「值超没超」，标记由各自的
 * 展示层负责（续跑模板的 `clamp`、面板的 `clampDetailText` 各有各的措辞）。
 * 调用方拿 `truncated` 置 `ToolResult.truncated`。
 */
export function truncateUtf8ToByteLimit(value: string, maxBytes: number): ByteTruncation {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= limit) return { value, truncated: false };

  let boundary = limit;
  while (boundary > 0 && isUtf8ContinuationByte(bytes[boundary])) boundary -= 1;
  return {
    value: new TextDecoder().decode(bytes.subarray(0, boundary)),
    truncated: true,
  };
}

/**
 * UTF-8 **字节**长度。
 *
 * ⚠️ `string.length` 数的是 UTF-16 单元：中文 1 字 = 3 字节、emoji 1 个 = 4 字节。
 * 任何与 `*_BYTES` 常量比较、或要按字节累加的量都必须走这里，不能拿 `.length` 顶替 ——
 * 换过来之后「上限」才真的是上限，中文场景下差三倍。
 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** `10xxxxxx` 是 UTF-8 的**延续字节**（多字节字符的后续），不是字符起点。 */
function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0b1100_0000) === 0b1000_0000;
}