// 「可见用户提示词」的标记与提取在**零依赖**的 `visible-user-prompt.ts` 里 ——
// 主世界（`core/zai/history-cleanup.ts`）也要用它，而本文件拖了整条 i18n 资源链。
// 这里原样转出，**既有 import 路径全部不变**。
//
// ⚠️ 本文件曾经还有一整套「提醒段剥离」实现（`sanitizeInternalPromptText` /
// `containsInternalPromptMarker` / `isToolReminderOnly` / `stripToolFormatReminder` 等），
// 已整体删除：**生产侧零消费者**，且实测它要处理的那段文本从来不会落到需要它的位置上
// （工具格式提醒排在 `VISIBLE_USER_PROMPT_END` **之后**，而 `extractVisibleUserPrompt`
// 只切 START..END 之间 ⇒ 天然不含它）。**别再按「上游有三处调用」把它加回来** ——
// 上游那三处服务的是它自己的补丁文本清洗链，本项目没有那条链。
export {
  VISIBLE_USER_PROMPT_END,
  VISIBLE_USER_PROMPT_START,
  extractVisibleUserPrompt,
  markVisibleUserPrompt,
  markVisibleUserPromptMetadata,
} from './visible-user-prompt';
