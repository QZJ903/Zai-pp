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
 * ⚠️⚠️ **三处消费者共用这一份**：自动化失败卡片、侧边栏通用失败提示、
 * 工具结果卡片（内容脚本）。各写一份必然分叉，而分叉时没有报错。
 * 放在 `core/` 是因为第三个消费者在内容脚本的 bundle 里，引不到 `entrypoints/`。
 */
const LOOKS_LIKE_ERROR_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function looksLikeErrorCode(value: string): boolean {
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