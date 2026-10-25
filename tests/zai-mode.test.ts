import { describe, expect, it } from 'vitest';
import { ZAI_AGENT_HOME_PATH } from '../core/zai/mode';

/**
 * **新会话落点**（收成一个常量）。
 *
 * ## 为什么只剩这一条
 *
 * 这里原本有 4 条 DOM 用例，测 `readZaiSidebarAgentMode` 从 `#sidebar` 的
 * `data-active` 按钮里读当前模式。**那个前提已被真机推翻**：侧边栏现在只有
 * `['false','文件夹']` 与 `['true','网页端']` 两个 `data-active` 按钮，
 * 没有 Chat / Agent 两个模式 tab。
 *
 * ⇒ 站点只剩 agent 模式，落点写成常量；判定函数与选择器一起删掉。
 *
 * ⚠️ **这条断言不是「测常量等于字面量」的同义反复** —— 它钉的是**页面契约**：
 * `/?mode=agent` 是 z.ai 页面自己的入口（入口读到 query 后设 `$APP_SCENE`
 * 并删掉该参数）。改成别的写法（比如 `/agent`）页面认不出，会静默落回默认场景。
 */
describe('zai new-conversation path', () => {
  it('always points at the page-owned agent entry', () => {
    expect(ZAI_AGENT_HOME_PATH).toBe('/?mode=agent');
  });
});