import { describe, expect, it } from 'vitest';
import {
  ZAI_AGENT_HOME_PATH,
  ZAI_CHAT_HOME_PATH,
  ZAI_SIDEBAR_MODE_TAB_SELECTOR,
  readZaiSidebarAgentMode,
  zaiNewConversationPath,
} from '../core/zai/mode';

/**
 * 页面把两个模式 tab 的顺序写死（Chat 在前、Agent 在后），标签文案随语言变。
 * 这里用真实顺序搭最小 DOM。
 */
function mountSidebar(agentActive: boolean): HTMLElement {
  document.body.innerHTML = `
    <div id="sidebar">
      <button data-active="${agentActive ? 'false' : 'true'}">Chat 模式</button>
      <button data-active="${agentActive ? 'true' : 'false'}">Agent 模式</button>
      <button id="nux-user-menu-btn">account</button>
    </div>
  `;
  return document.body;
}

describe('zai sidebar mode detection', () => {
  it('reads agent mode from the second mode tab', () => {
    expect(readZaiSidebarAgentMode(mountSidebar(true))).toBe(true);
    expect(readZaiSidebarAgentMode(mountSidebar(false))).toBe(false);
  });

  it('falls back to chat when the sidebar or the mode tabs are missing', () => {
    document.body.innerHTML = '<div id="app"></div>';
    expect(readZaiSidebarAgentMode(document.body)).toBe(false);

    // 只有一个 tab（页面结构变了）→ 同样按 chat 处理，不猜。
    document.body.innerHTML = `
      <div id="sidebar"><button data-active="true">Chat 模式</button></div>
    `;
    expect(readZaiSidebarAgentMode(document.body)).toBe(false);
  });

  it('ignores the extension project panel\'s own data-active buttons', () => {
    // 面板就插在 #sidebar 里，它的图标按钮激活时也写 data-active="true"。
    // 不排除的话，面板按钮一旦排到模式 tab 前面就会被当成 Agent 模式读走。
    document.body.innerHTML = `
      <div id="sidebar">
        <div data-dpp-project-panel="true">
          <button data-active="true">归属</button>
          <button data-active="true">新会话</button>
        </div>
        <button data-active="true">Chat 模式</button>
        <button data-active="false">Agent 模式</button>
      </div>
    `;
    expect(readZaiSidebarAgentMode(document.body)).toBe(false);

    // 反向：排除面板后仍能正确读出 agent。
    document.body.innerHTML = `
      <div id="sidebar">
        <div data-dpp-project-panel="true">
          <button data-active="true">归属</button>
        </div>
        <button data-active="false">Chat 模式</button>
        <button data-active="true">Agent 模式</button>
      </div>
    `;
    expect(readZaiSidebarAgentMode(document.body)).toBe(true);
  });

  it('ignores data-active buttons outside the sidebar', () => {
    document.body.innerHTML = `
      <div id="sidebar">
        <button data-active="false">Chat 模式</button>
        <button data-active="false">Agent 模式</button>
      </div>
      <div id="elsewhere"><button data-active="true">别的开关</button></div>
    `;
    expect(readZaiSidebarAgentMode(document.body)).toBe(false);
  });

  it('maps the detected mode to the new-conversation path', () => {
    expect(zaiNewConversationPath(true)).toBe(ZAI_AGENT_HOME_PATH);
    expect(zaiNewConversationPath(false)).toBe(ZAI_CHAT_HOME_PATH);
    expect(ZAI_AGENT_HOME_PATH).toBe('/?mode=agent');
    expect(ZAI_SIDEBAR_MODE_TAB_SELECTOR).toBe('#sidebar button[data-active]');
  });
});