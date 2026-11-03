/**
 * 从 **SSE wire 原文**里推出「页面最终看到的助手正文」。
 *
 * ## 为什么需要它
 *
 * hook 吐出来的 `wire` 是**逐帧的 SSE 文本**，正文在 JSON 字符串里：
 * `data: {"…","delta_content":"…"}`。三个直接后果，每一个都让「对 wire 做字符串断言」
 * 变成错的：
 *
 * 1. **引号是转义形态** —— 页面上的 `<shell_exec id="1">` 在 wire 里是
 *    `<shell_exec id=\"1\">`。拿原串 `toContain` 必然失败，**而生产代码其实完全正确**。
 * 2. **正文被拆成多帧** —— 标签的一半可能在上一帧、另一半在下一帧。对 wire 找
 *    「完整标签」找不到，不代表剥离器漏了。
 * 3. **`content` 是整体替换、`delta_content` 是追加** —— 只看其中一种会得到错的正文。
 *
 * ⇒ **要断言「页面上看得见什么」，必须先按帧解码、拼出正文再判。**
 * 判「通知侧有没有发出 `TOOL_CALL`」走 `onToolCall` 回调，那个不用解码。
 *
 * ## 口径来源
 *
 * 与 [[zai-site]] §2.1 的相位表一致：`answer` 相位的 `delta_content` 追加进正文；
 * 带 `content` 的帧是**整体替换**（页面用自己的 state 覆盖）。两条都按到达顺序推演。
 * ⚠️ 解析不了的帧（半截 JSON / 未来新增的帧型）**跳过不抛** —— 这一层只回答
 * 「能确定的那部分正文是什么」，不该因为一个不认识的帧把整条用例炸掉。
 */

/** 把 wire 拆成 `data:` 行的 JSON payload（只留能解析的，`[DONE]` 与空行跳过）。 */
export function ssePayloadsOf(wire: string): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  for (const line of wire.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payloads.push(parsed as Record<string, unknown>);
      }
    } catch {
      // 半截帧 / 非 JSON 的 data 行 —— 跳过。
    }
  }
  return payloads;
}

/**
 * 页面最终看到的正文：`delta_content` 追加、`content` 整体替换，按到达顺序推演。
 *
 * ⚠️ **两者的优先级是「谁后到谁生效」**，不是「`content` 恒赢」—— 真机上两种帧会
 * 混着来（流式阶段 delta、收尾阶段 content）。
 */
export function sseVisibleText(wire: string): string {
  let text = '';
  for (const payload of ssePayloadsOf(wire)) {
    const data = payload.data as Record<string, unknown> | undefined;
    if (typeof data?.delta_content === 'string') {
      text += data.delta_content;
      continue;
    }
    if (typeof data?.content === 'string') {
      text = data.content;
      continue;
    }
  }
  return text;
}

/** 跨多次 push / finish 累积页面最终看到的正文（测试里逐块喂 wire 时用）。 */
export function sseAccumulatedText(...wires: string[]): string {
  return sseVisibleText(wires.join(''));
}