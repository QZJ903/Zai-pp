/**
 * 草稿保护：**注入前把用户留在输入框里的内容记下来，注入失败或收尾时还回去**。
 *
 * ## 为什么单独成文件
 *
 * 这段逻辑原来内联在 `entrypoints/zai.content.ts` 的 `captureComposerDraft` 里，而
 * 那个文件**加载即执行 `defineContentScript`**、不可 import ⇒ 只能靠「按结构数调用点」
 * 的 AST 断言盯着。那种断言有两个洞：
 *
 * ① 它锁的是**调用点形状**，不是**恢复语义** —— 把 `restore()` 的条件改错（例如去掉
 *    「当前值是空的才算我们那份」这个守卫），断言照绿；
 * ② 它要求「恰好一次调用」，所以把 `clear(); restore();` 抽成一个助手就假红。
 *
 * 抽出来之后，语义可以用**真输入**喂满（假 textarea + 三档当前值），接线仍由 AST 守卫
 * 盯着 —— 两者分工是「行为用例防语义错、结构守卫防漏接」，谁也替不了谁。
 * ⚠️ 与 `event-wait.ts` / `send-evidence.ts` / `continuation-marker.ts` 抽出来是**同一条理由**。
 *
 * ## 恢复的三档判据（本文件的全部内容）
 *
 * | 当前输入框里的值 | 处置 | 为什么 |
 * |---|---|---|
 * | 空 | **写回草稿** | 页面已经清过（或还没写回），框是空的，还回去最安全 |
 * | 等于我们刚注入的 `injected` | **写回草稿** | 页面把我们的 prompt 留在框里（或反向同步回来了），那份本来就不该给用户看 |
 * | 其它（用户新打的字） | **放弃** | 已经有人在用这个框了；写回会把他的新输入冲掉 |
 *
 * ⚠️ **拿不到输入框时（`resolveInput()` 返回 null）不置「已恢复」标记** —— 页面在注入
 * 之后可能把这一小块 DOM 重建掉，那一刻框是 null。提前置位的话，`finally` 里那次兜底
 * 也不会再试，而它本来还有机会救回来。
 * ⚠️ **「用户新打了字」那一档要置位**（放弃就是终局）—— 不置位的话，万一他随后又清空了，
 * 兜底那次会把**旧草稿**塞回一个他刚发完消息的空输入框里。
 */

/** 一次注入的草稿保护器。 */
export interface ComposerDraftGuard {
  /** 把我们改写之前用户留在输入框里的那份草稿还回去（幂等，最多写回一次）。 */
  restore: () => void;
}

/** 本模块需要的两个外部动作，由调用方注入（与 `skill-popup-wiring` 同一做法）。 */
export interface ComposerDraftDeps {
  /** **现取**当前输入框 —— 页面会重建它，缓存引用会指向已脱连的旧节点。 */
  resolveInput: () => HTMLTextAreaElement | null;
  /** 写值原语。**必须与注入侧同一个**，否则页面 bound-value 会与 DOM 分叉。 */
  writeValue: (textarea: HTMLTextAreaElement, text: string) => void;
}

/**
 * 记下 `textarea` 此刻的内容，返回一个「按需还回」的保护器。
 *
 * ⚠️ **必须在「锁住输入框」之后、写值之前调用** —— 再往前用户还在打字（捕获到半截），
 * 再往后值已经被我们覆盖。
 * ⚠️ **空值不算草稿** —— `textarea.value` 为空白串时 `draft` 是 `null`，`restore()`
 * 直接 no-op（否则会把一堆空格写回去）。
 */
export function captureComposerDraft(
  textarea: HTMLTextAreaElement,
  injected: string,
  deps: ComposerDraftDeps,
): ComposerDraftGuard {
  const draft = textarea.value && textarea.value.trim() ? textarea.value : null;
  let restored = false;
  return {
    restore: () => {
      if (restored || draft === null) return;
      const live = deps.resolveInput();
      // ⚠️ 拿不到框 ⇒ 不置位，留一次机会给后面的兜底调用。
      if (!live) return;
      // ⚠️ 从这里开始「放弃就是终局」。
      restored = true;
      if (live.value !== '' && live.value !== injected) return;
      deps.writeValue(live, draft);
    },
  };
}