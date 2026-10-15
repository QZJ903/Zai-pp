import { describe, expect, it, vi } from 'vitest';
import { navigateToZaiConversation } from '../core/zai/project-nav';

/**
 * 项目面板里「点一条会话」的导航。
 *
 * ⚠️ **这条守卫对应一个真实缺陷**：页面内的项目面板点一条会话时，原来按
 * 「与当前页同源」判 —— 在国际站的页面上点一条**国区站**的会话，会被拼成
 * 当前站的 `/c/<id>`，而那一站没有这条会话 ⇒ **跳转失败**。
 * 两个站各有一份会话，**同一条会话只存在于它自己那一站**，所以正确行为是换站跳过去。
 *
 * 这段逻辑写在内容脚本里时无法被测试 import（模块顶层执行 `defineContentScript`），
 * 所以抽成 `core/zai/project-nav.ts` 后才有了下面这些行为断言。
 */
describe('navigateToZaiConversation: which site the panel jumps to', () => {
  it('jumps to the conversation record site, not the current page', () => {
    const assign = vi.fn();
    navigateToZaiConversation(
      { conversationId: 'c1', url: 'https://zchat.z.ai/c/c1' },
      { currentOrigin: 'https://chat.z.ai', assign },
    );

    // ⚠️ 当前页在国际站，但这条会话属于国区站 ⇒ 必须**换站**跳过去。
    // 按同源判（旧实现）会 assign 到 `https://chat.z.ai/c/c1` —— 那一站没有它。
    expect(assign).toHaveBeenCalledWith('https://zchat.z.ai/c/c1');
  });

  it('works in the mirror direction as well', () => {
    const assign = vi.fn();
    navigateToZaiConversation(
      { conversationId: 'c1', url: 'https://chat.z.ai/c/c1' },
      { currentOrigin: 'https://zchat.z.ai', assign },
    );

    expect(assign).toHaveBeenCalledWith('https://chat.z.ai/c/c1');
  });

  it('rebuilds from the id on the current site when the record has no URL', () => {
    const assign = vi.fn();
    navigateToZaiConversation(
      { conversationId: 'c 1', url: '' },
      { currentOrigin: 'https://chat.z.ai', assign },
    );

    // 记录里连 url 都没有 ⇒ 只能假设会话在本页这一站；id 要编码。
    expect(assign).toHaveBeenCalledWith('https://chat.z.ai/c/c%201');
  });

  it('refuses to navigate anywhere but one of our sites', () => {
    // ⚠️ 存储里的 url 可能来自同步快照导入（存储层只要求它是字符串）。
    // 直接 `location.assign` 会让 `javascript:` 被执行 ⇒ 非站点集合一律回退。
    for (const url of ['javascript:alert(1)', 'https://chat.z.ai.evil.test/c/c1']) {
      const assign = vi.fn();
      navigateToZaiConversation({ conversationId: 'c1', url }, { currentOrigin: 'https://chat.z.ai', assign });
      expect(assign).toHaveBeenCalledWith('https://chat.z.ai/c/c1');
    }
  });
});