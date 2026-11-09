import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SkillPage from '../entrypoints/sidepanel/pages/SkillPage';

/**
 * 技能页「更新本地技能」遇到路径失效时会弹文件夹选择框。**用户点取消不算失败。**
 *
 * ⚠️⚠️ 改前这里是 `catch { return null }` + `showOperationError(relocatePrompt)`：
 * 取消与「选择器坏了」被压成同一个 `null`，于是**用户点一下取消就被告知
 * 「原文件夹已挪动或不存在，请重新选择」** —— 他压根没打算换文件夹。
 *
 * ⚠️ 现在 `relocatePrompt` 改在**弹框之前**当 `info` 提示（用户点「更新」突然弹框，
 * 需要一句解释），所以本用例断言的不是「这句话不出现」，而是**「没有错误条」**。
 */

let container: HTMLDivElement;
let root: Root | null;
let pickResult: { path: string | null };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  pickResult = { path: null };

  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension-id',
      sendMessage: vi.fn(async (message: { type?: string }) => {
        if (message.type === 'GET_SKILL_LIBRARY') return [localSkill];
        if (message.type === 'GET_SKILL_SOURCES') return [localSource];
        if (message.type === 'GET_SKILL_AUTO_ACTIVATION_SETTINGS') {
          return { firstMessage: true, everyMessage: false };
        }
        // 路径失效这一档：`ok:false` + `local_path_unavailable` ⇒ UI 该弹选文件夹。
        if (message.type === 'UPDATE_LOCAL_SKILL_SOURCE') {
          return { ok: false, error: 'gone', importBlock: { code: 'local_path_unavailable' } };
        }
        if (message.type === 'PICK_LOCAL_SKILL_FOLDER') return pickResult;
        throw new Error(`Unexpected command: ${message.type}`);
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('SkillPage local Skill update', () => {
  it('does not report an error when the user cancels the re-pick', async () => {
    await renderSkillPage();
    await expandTheLocalGroup();
    await clickUpdate();

    // ⚠️ 判据：`showOperationError` 走的是 `skillPage.operationFailed`（「Skill 操作失败：{error}」）。
    // 取消不该触发它 —— 改回旧写法时这里会红。
    expect(container.textContent).not.toContain('Skill 操作失败');
    // 也不该停在「同步中」：那个 loading 状态必须被清掉，否则按钮永远转圈。
    expect(container.textContent).not.toContain('同步中');
  });

  it('relocates and reports nothing when the user picks a folder', async () => {
    pickResult = { path: '/Users/me/.codex/skills/renamed' };
    await renderSkillPage();
    await expandTheLocalGroup();
    await clickUpdate();

    const relocate = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      .find(([message]) => (message as { type?: string }).type === 'RELOCATE_LOCAL_SKILL_SOURCE');
    expect(relocate?.[0]).toMatchObject({
      payload: { sourceId: 'local:/Users/me/.codex/skills/demo', newRootPath: '/Users/me/.codex/skills/renamed' },
    });
  });
});

async function renderSkillPage() {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(SkillPage));
  });
  await settle();
}

/** 第三方（本地）技能默认是折叠的，展开才能看到卡片上的「更新」按钮。 */
async function expandTheLocalGroup() {
  const header = container.querySelector('[role="button"][aria-expanded]');
  expect(header, '找不到分组头').toBeTruthy();
  if (header?.getAttribute('aria-expanded') === 'false') {
    await act(async () => {
      header?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
  }
}

async function clickUpdate() {
  const button = container.querySelector('button[aria-label="更新本地 Skill（重读索引）"]');
  expect(button, '找不到本地技能的更新按钮').toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const localSource = {
  id: 'local:/Users/me/.codex/skills/demo',
  provider: 'local' as const,
  rootPath: '/Users/me/.codex/skills/demo',
  displayName: 'demo',
  directoryName: 'demo',
  skillPaths: ['SKILL.md'],
  importedSkillNames: ['demo-local'],
  importedAt: 1,
  updatedAt: 1,
  warnings: [],
};

const localSkill = {
  name: 'demo-local',
  description: 'Demo local Skill',
  instructions: 'do something useful',
  source: 'remote' as const,
  memoryEnabled: false,
  enabled: true,
  remote: {
    provider: 'local' as const,
    sourceId: localSource.id,
    path: 'SKILL.md',
    originalName: 'demo',
    importedAt: 1,
    updatedAt: 1,
    localRootPath: localSource.rootPath,
    localDirectory: localSource.rootPath,
    localDisplayName: 'demo',
    includedFiles: [],
    omittedFiles: [],
    warnings: [],
  },
};