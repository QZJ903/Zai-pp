/**
 * 「这个字符串是一个错误码」而不是自然语言句子。
 *
 * 判据刻意收得很紧：**全小写、无空格、无标点**。
 * ⚠️ **单个小写词也算码**（`busy` / `cancelled` 就是本仓真实存在的单码）——
 * 不能要求「必须含下划线」。
 * ⚠️ **英文句子必须原样放行** —— 那批人写的句子
 * （`Automation run exceeded 300 seconds.`）比任何通用兜底文案都有信息量。
 * 句子带大写首字母与空格，天然不匹配这条正则。
 *
 * ⚠️⚠️ **`String(undefined)` / `String(null)` 的产物（`'undefined'` / `'null'`）也匹配这条
 * 正则** —— 它们真的长得像码。调用方拿一个缺失的 `error` 进来时，正确语义是「没有话可说」，
 * 不是「这里有个叫 undefined 的错误码」。所以这两个字面量要显式排除，否则界面会出现
 * 「操作失败（undefined）」。
 *
 * ⚠️⚠️ **三处消费者共用这一份**：自动化失败卡片、侧边栏通用失败提示、
 * 工具结果卡片（内容脚本）。各写一份必然分叉，而分叉时没有报错。
 * 放在 `core/` 是因为第三个消费者在内容脚本的 bundle 里，引不到 `entrypoints/`。
 */
const LOOKS_LIKE_ERROR_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** `String(value)` 对这两个值给出的字面量，不对应任何真实错误码。 */
const STRINGIFIED_ABSENT_VALUES: ReadonlySet<string> = new Set(['undefined', 'null']);

export function looksLikeErrorCode(value: string): boolean {
  if (STRINGIFIED_ABSENT_VALUES.has(value)) return false;
  return LOOKS_LIKE_ERROR_CODE.test(value);
}

/**
 * 「标签页里没有活着的内容脚本」—— 后台把它回给侧边栏，由侧边栏翻成
 * `common.pageContentScriptMissing`。
 *
 * ⚠️⚠️ **这个码是跨边界的，两处必须同源**：生产端在 `entrypoints/background.ts`
 * （`getPromptInsertionErrorMessage` 判定 `chrome.tabs.sendMessage` 抛的错误串后返回它），
 * 判定端在 `entrypoints/sidepanel/controllers/useSavedPageController.ts`
 * （`insertPrompt` 拿它去查文案）。**两边各写一遍字面量就是「生产端与判定端各写一遍」
 * 的老形态** —— 改一处另一处不报错，只会让那条文案静默退回英文技术串。
 * （同族先例：`core/zai/contracts.ts` 的 `ZAI_DOM_TASK_CANCELLED_CODE`。）
 *
 * ⚠️ **为什么后台不直接返回中文**：`BACKGROUND_LOCALE_SECTIONS` 只含
 * `content` / `background` / `tool` / `prompt` 四段，`common` 不在里面 ——
 * 那是把侧边栏资源挡在 service worker 包外的结构预算。
 */
export const PAGE_CONTENT_SCRIPT_MISSING_CODE = 'page_content_script_missing';

/**
 * 「要改 / 要删的那条记忆已经不在了」。
 *
 * ⚠️⚠️ **生产端与判定端必须同源**：生产端在 `core/memory/store.ts` 的
 * `updateMemory`（`update()` 返回 0）与 `deleteMemory`（事务内 `get` 查不到），
 * 判定端在侧边栏两条链路 —— `useMemoryPageController` 的保存与**单条删除**失败分支
 * （都拿它换可读文案）。两边各写一遍字面量就是「生产端与判定端各写一遍」
 * 的老形态 —— 改一处另一处不报错，只会让那条文案静默退回英文技术串。
 *
 * ⚠️⚠️ **同一条码在「清空全部」里有相反的处置，那是有意的**：
 * `useSettingsController.handleClearAllMemories` 遇到它**跳过继续**
 * （遍历清空的目标就是「让这些 id 都不存在」，已经不在了 ⇒ 目标已达成；
 * 当失败会让整个清空中断在半路）。
 */
export const MEMORY_RECORD_MISSING_CODE = 'memory_record_missing';

/**
 * 「z.ai 页面里找不到输入框」—— 由内容脚本的 `insertPromptText` 判定，经后台转给侧边栏。
 *
 * ⚠️⚠️ **生产端与判定端必须同源**：生产端在 `entrypoints/background.ts` 的
 * `getPromptInsertionErrorMessage`（把它原样回出去，不在后台翻文案），判定端在侧边栏
 * `useSavedPageController`（换成「请刷新 Zai 页面后重试」那一句）。
 *
 * ⚠️ **不能与「当前窗口没有 z.ai 页面」共用一句建议** —— 后者该让用户去打开并登录，
 * 前者只需要刷新。混成一句时用户会照着错的那句去做。
 *
 * ⚠️ **为什么后台回码、不回文案**：`BACKGROUND_LOCALE_SECTIONS` 只含
 * `content` / `background` / `tool` / `prompt` 四段，侧边栏那批文案不在里面。
 */
export const PROMPT_INPUT_NOT_FOUND_CODE = 'prompt_input_not_found';