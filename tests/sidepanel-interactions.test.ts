import React from 'react';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROMPT_INJECTION_SETTINGS,
  type PromptInjectionSettings,
} from '../core/prompt/settings';
import {
  PAGE_CONTENT_SCRIPT_MISSING_CODE,
  PROMPT_INPUT_NOT_FOUND_CODE,
} from '../core/messaging/error-code';
import PromptControlPanel from '../entrypoints/sidepanel/components/PromptControlPanel';
import LocalSkillImportPanel from '../entrypoints/sidepanel/components/LocalSkillImportPanel';
import SavedPage from '../entrypoints/sidepanel/pages/SavedPage';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

let container: HTMLDivElement;
let root: Root | null;
let runtimeListeners: Array<(message: unknown) => void>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  runtimeListeners = [];
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container.remove();
  vi.unstubAllGlobals();
});

describe('sidepanel interactions', () => {
  it('sends a saved snippet payload when the save button is clicked', async () => {
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_SAVED_ITEMS') return [];
      if (message.type === 'SAVE_SAVED_ITEM') {
        return {
          id: 'saved-1',
          syncId: 'sync-1',
          kind: 'snippet',
          title: 'Review prompt',
          content: 'Summarize this thread.',
          tags: ['prompt'],
          createdAt: 1,
          updatedAt: 1,
        };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await enterText('标题', 'Review prompt');
    await enterText('Prompt 片段、笔记或可复用文本', 'Summarize this thread.');
    await enterText('标签（逗号分隔）', 'prompt');
    await clickButton('保存');

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'SAVE_SAVED_ITEM',
      payload: {
        kind: 'snippet',
        title: 'Review prompt',
        content: 'Summarize this thread.',
        tags: ['prompt'],
      },
    });
    expect(inputByPlaceholder('标题').value).toBe('');
  });

  it('requests insertion into the active chat when a saved item is clicked', async () => {
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_SAVED_ITEMS') {
        return [{
          id: 'saved-1',
          syncId: 'sync-1',
          kind: 'snippet',
          title: 'Review prompt',
          content: 'Summarize this thread.',
          tags: ['prompt'],
          createdAt: 1,
          updatedAt: 1,
        }];
      }
      if (message.type === 'INSERT_SAVED_PROMPT_INTO_CHAT') return { ok: true };
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await flushPromises();
    await clickButton('插入到对话');

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'INSERT_SAVED_PROMPT_INTO_CHAT',
      payload: { text: 'Summarize this thread.' },
    });
    expect(container.textContent).toContain('已插入当前 Zai 对话');
  });

  it('shows insertion failures from the active chat route', async () => {
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_SAVED_ITEMS') {
        return [{
          id: 'saved-1',
          syncId: 'sync-1',
          kind: 'snippet',
          title: 'Review prompt',
          content: 'Summarize this thread.',
          tags: [],
          createdAt: 1,
          updatedAt: 1,
        }];
      }
      if (message.type === 'INSERT_SAVED_PROMPT_INTO_CHAT') {
        return { ok: false, error: '请先在 chat.z.ai 登录，或刷新 Zai 页面后重试。' };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await flushPromises();
    await clickButton('插入到对话');

    expect(container.textContent).toContain('插入到对话失败：请先在 chat.z.ai 登录，或刷新 Zai 页面后重试。');
  });

  it('renders the reload-input-box copy for a missing page input, not the sign-in copy', async () => {
    // ⚠️⚠️ **两档建议不同**：「页面里找不到输入框」只需刷新；「当前窗口没有 z.ai 页面」
    // 要用户去打开并登录。共用一句时用户会照着错的那句去做。
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_SAVED_ITEMS') {
        return [{
          id: 'saved-1',
          syncId: 'sync-1',
          kind: 'snippet',
          title: 'Review prompt',
          content: 'Summarize this thread.',
          tags: [],
          createdAt: 1,
          updatedAt: 1,
        }];
      }
      if (message.type === 'INSERT_SAVED_PROMPT_INTO_CHAT') {
        return { ok: false, error: PROMPT_INPUT_NOT_FOUND_CODE };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await flushPromises();
    await clickButton('插入到对话');

    expect(container.textContent).toContain('找不到页面输入框');
    expect(container.textContent).not.toContain('请先在 Zai 登录');
    expect(container.textContent).not.toContain(PROMPT_INPUT_NOT_FOUND_CODE);
  });

  it('renders the shared content-script-missing copy when the background returns that code', async () => {
    // ⚠️⚠️ **这条守的是「后台回码、侧边栏翻文案」那条跨边界契约。**
    //
    // 内容脚本不在（扩展刚重载 / 页面还没加载完）时 `chrome.tabs.sendMessage` 抛的是
    // 英文技术串（`Could not establish connection. Receiving end does not exist.`），
    // 后台**不能**直接返回中文（`common` 段不在 `BACKGROUND_LOCALE_SECTIONS` 里），
    // 所以回一个码 `page_content_script_missing`，由这一侧翻成
    // `common.pageContentScriptMissing`。
    //
    // ⚠️ 码的字面量两侧必须同源 —— 生产端在 `entrypoints/background.ts`，
    // 判定端在 `useSavedPageController.ts`，两侧都引
    // `core/messaging/error-code.ts` 的 `PAGE_CONTENT_SCRIPT_MISSING_CODE`。
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_SAVED_ITEMS') {
        return [{
          id: 'saved-1',
          syncId: 'sync-1',
          kind: 'snippet',
          title: 'Review prompt',
          content: 'Summarize this thread.',
          tags: [],
          createdAt: 1,
          updatedAt: 1,
        }];
      }
      if (message.type === 'INSERT_SAVED_PROMPT_INTO_CHAT') {
        return { ok: false, error: PAGE_CONTENT_SCRIPT_MISSING_CODE };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await flushPromises();
    await clickButton('插入到对话');

    // 翻成了中文文案，而不是把裸码或英文技术串透给用户。
    expect(container.textContent).toContain('Zai 页面里没有可用的扩展脚本');
    expect(container.textContent).not.toContain(PAGE_CONTENT_SCRIPT_MISSING_CODE);
    expect(container.textContent).not.toContain('Receiving end does not exist');
  });

  it('wires the production background to actually return that code', () => {
    /**
     * ⚠️⚠️ **上面那条只验「拿到码 → 翻文案」，验不了「后台真的会回这个码」。**
     *
     * `insertPromptIntoActiveZaiTab` 不导出、没有任何测试入口（全仓只在
     * `entrypoints/background.ts` 里出现），所以「`isMissingRuntimeMessageReceiverError`
     * 命中后回码」这个**生产分支**是零覆盖的。
     *
     * ⇒ 用源码断言补这一跳：钉住「`catch` 里那条 return 引的是常量、不是裸字面量」。
     * ⚠️ 判据是**代码行**（剥掉注释后），不是「源码里出现过这个词」——
     * 上面那一大段注释里就有这个常量名，直接搜全文会被自己的注释满足。
     */
    const source = readFileSync('entrypoints/background.ts', 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toMatch(/error:\s*PAGE_CONTENT_SCRIPT_MISSING_CODE/);
    // 反面自检：不许写成裸字面量（那样两侧就不同源了）。
    expect(code).not.toMatch(/error:\s*['"]page_content_script_missing['"]/);
  });

  it('keeps `getPromptInsertionErrorMessage` mapping the code to itself, not to copy', () => {
    /**
     * ⚠️⚠️ **同一条契约的第二档：「找不到输入框」必须原样回码、不在后台翻成登录文案。**
     *
     * ⇒ 判「后台真的会回这个码」，只能扫源码：`getPromptInsertionErrorMessage` 住在
     * `entrypoints/background.ts`（`defineBackground(...)` 的宿主文件），import 它就执行
     * `defineBackground` ⇒ **不能导出后直接调**。
     *
     * ⚠️ **这里刻意用 AST、不用正则**：正则版本写的是
     * `/if \(error === PROMPT_INPUT_NOT_FOUND_CODE\) return PROMPT_INPUT_NOT_FOUND_CODE;/`
     * —— 它把生产代码**绑死在「单行 if」这一种写法**上。实测换成多行 `if`、换成大括号块、
     * 合并成映射表，**三档都会红而行为没变**。判据应该是「这个码有没有被原样返回」，
     * 不是「哪一行长什么样」。
     */
    const source = readFileSync('entrypoints/background.ts', 'utf8');
    const program = parseTypeScriptSource('entrypoints/background.ts', source);
    const fn = findNamedFunction(program, 'getPromptInsertionErrorMessage');
    expect(fn, '应当能找到 getPromptInsertionErrorMessage').toBeDefined();

    // ① 正面：它的出口里必须有一条「原样返回这个码」。
    //    认两种形态 —— `return PROMPT_INPUT_NOT_FOUND_CODE;`（if / switch 各写法都算），
    //    或映射表里 `[PROMPT_INPUT_NOT_FOUND_CODE]: PROMPT_INPUT_NOT_FOUND_CODE`。
    const returnsTheCode: boolean[] = [];
    const mapsToItself: boolean[] = [];
    walkSourceAst(fn!.body, (node) => {
      if (t.isReturnStatement(node) && isIdentifierNamed(node.argument, 'PROMPT_INPUT_NOT_FOUND_CODE')) {
        returnsTheCode.push(true);
      }
      if (t.isObjectProperty(node) && isIdentifierNamed(node.value, 'PROMPT_INPUT_NOT_FOUND_CODE')) {
        mapsToItself.push(true);
      }
    });
    expect(
      returnsTheCode.length > 0 || mapsToItself.length > 0,
      '`getPromptInsertionErrorMessage` 必须有一条把这个码**原样**返回的出口',
    ).toBe(true);

    // ② 反面：这个码**不许**作为任何翻译调用（`backgroundT(...)` / `t(...)`）的实参。
    //    这一条才是真正的契约 —— 翻了文案，侧边栏就拿不到码、也就翻不出正确建议。
    const translatedCodeArguments: string[] = [];
    walkSourceAst(fn!.body, (node) => {
      if (!t.isCallExpression(node)) return;
      const callee = node.callee;
      const calleeName = t.isIdentifier(callee) ? callee.name
        : (t.isMemberExpression(callee) && t.isIdentifier(callee.property) ? callee.property.name : null);
      if (calleeName !== 'backgroundT' && calleeName !== 't') return;
      for (const argument of node.arguments) {
        walkSourceAst(argument as t.Node, (inner) => {
          if (isIdentifierNamed(inner, 'PROMPT_INPUT_NOT_FOUND_CODE')) {
            translatedCodeArguments.push('PROMPT_INPUT_NOT_FOUND_CODE');
          }
        });
      }
    });
    expect(
      translatedCodeArguments,
      '这个码不许被送进翻译函数 —— 后台回码、文案由侧边栏按码映射',
    ).toEqual([]);
  });

  it('shows saved-item repository failures instead of rendering a fake empty state', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_SAVED_ITEMS') {
        return { ok: false, error: 'savedItems.schemaVersion is not supported' };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await flushPromises();

    expect(container.textContent)
      .toContain('保存项操作失败：savedItems.schemaVersion is not supported');
    expect(container.textContent).not.toContain('暂无保存项');
  });

  it('retains the last valid saved item when an update payload is corrupt', async () => {
    const item = {
      id: 'saved-1',
      syncId: 'sync-1',
      kind: 'snippet',
      title: 'Keep confirmed item',
      content: 'Last confirmed content.',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const sendMessage = vi.fn(async (message: { type: string }) => (
      message.type === 'GET_SAVED_ITEMS' ? [item] : null
    ));
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await flushPromises();
    await act(async () => {
      runtimeListeners.forEach((listener) => listener({
        type: 'SAVED_ITEMS_UPDATED',
        savedItems: [{ id: 'corrupt' }],
      }));
    });

    expect(container.textContent).toContain('Keep confirmed item');
    expect(container.textContent).toContain('savedItemsUpdate[0]');
    expect(container.textContent).not.toContain('暂无保存项');
  });

  it('does not let an older saved-item read replace a newer update event', async () => {
    let resolveInitialRead!: (value: unknown) => void;
    const initialRead = new Promise<unknown>((resolve) => {
      resolveInitialRead = resolve;
    });
    const sendMessage = vi.fn((message: { type: string }) => (
      message.type === 'GET_SAVED_ITEMS' ? initialRead : Promise.resolve(null)
    ));
    stubChrome(sendMessage);
    await renderElement(React.createElement(SavedPage));

    await act(async () => {
      runtimeListeners.forEach((listener) => listener({
        type: 'SAVED_ITEMS_UPDATED',
        savedItems: [{
          id: 'saved-new',
          syncId: 'sync-new',
          kind: 'snippet',
          title: 'Newer saved item',
          content: 'Newer content.',
          tags: [],
          createdAt: 2,
          updatedAt: 2,
        }],
      }));
    });
    expect(container.textContent).toContain('Newer saved item');

    await act(async () => {
      resolveInitialRead([{
        id: 'saved-old',
        syncId: 'sync-old',
        kind: 'snippet',
        title: 'Older saved item',
        content: 'Older content.',
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      }]);
      await initialRead;
    });
    expect(container.textContent).toContain('Newer saved item');
    expect(container.textContent).not.toContain('Older saved item');
  });

  it('keeps a saved item visible when repository deletion fails', async () => {
    const item = {
      id: 'saved-1',
      syncId: 'sync-1',
      kind: 'snippet',
      title: 'Keep me',
      content: 'Do not remove this item on failure.',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_SAVED_ITEMS') return [item];
      if (message.type === 'DELETE_SAVED_ITEM') {
        return { ok: false, error: 'delete blocked' };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await flushPromises();
    await clickButtonByLabel('删除');
    await clickButton('删除');
    await flushPromises();

    expect(container.textContent).toContain('保存项操作失败：delete blocked');
    expect(container.textContent).toContain('Keep me');
  });

  it('persists prompt control select changes instead of reverting to defaults', async () => {
    const sendMessage = vi.fn(async (message: { type: string; payload?: PromptInjectionSettings }) => {
      if (message.type === 'GET_PROMPT_INJECTION_SETTINGS') return DEFAULT_PROMPT_INJECTION_SETTINGS;
      if (message.type === 'SAVE_PROMPT_INJECTION_SETTINGS') return message.payload;
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(PromptControlPanel));
    const cadenceSelect = container.querySelector('select');
    expect(cadenceSelect).toBeInstanceOf(HTMLSelectElement);

    await act(async () => {
      setSelectValue(cadenceSelect as HTMLSelectElement, 'every_message');
      cadenceSelect?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'SAVE_PROMPT_INJECTION_SETTINGS',
      payload: {
        ...DEFAULT_PROMPT_INJECTION_SETTINGS,
        presetCadence: 'every_message',
      },
    });
    expect((cadenceSelect as HTMLSelectElement).value).toBe('every_message');
  });

  it('shows prompt control save failures and restores the previous confirmed state', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROMPT_INJECTION_SETTINGS') return DEFAULT_PROMPT_INJECTION_SETTINGS;
      if (message.type === 'SAVE_PROMPT_INJECTION_SETTINGS') {
        return { ok: false, error: 'tabs permission unavailable' };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(PromptControlPanel));
    const memoryToggle = container.querySelector('button');
    expect(memoryToggle).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      memoryToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('保存提示词设置失败：tabs permission unavailable');
    expect((memoryToggle as HTMLButtonElement).getAttribute('style')).toContain('var(--ds-blue)');
  });

  it('explains that non-bundled local Skill resources remain available on demand', async () => {
    // ⚠️ 用**当前 host 真的会发**的措辞。旧版那句 `N local supporting file(s) were omitted.`
    // 已经没有任何生产者（本项目自用、不存在旧 host ⇒ 那层兼容过滤已删），拿它当夹具
    // 等于在测一条走不到的路。
    const skillWarning = 'references/17.md was omitted because the local Skill preview reached the content budget.';
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type !== 'PREVIEW_LOCAL_SKILL_SOURCE') return null;
      return {
        source: {
          id: 'local:demo',
          provider: 'local',
          rootPath: '/Users/me/.codex/skills/demo',
          displayName: 'demo',
          directoryName: 'demo',
          skillPaths: ['SKILL.md'],
          importedSkillNames: ['demo'],
          importedAt: 1,
          updatedAt: 1,
          warnings: [],
        },
        skills: [{
          path: 'SKILL.md',
          name: 'demo',
          importName: 'demo',
          description: 'Demo Skill',
          bytes: 64000,
          bodyBytes: 6000,
          includedFiles: Array.from({ length: 16 }, (_, index) => ({ path: `references/${index + 1}.md`, bytes: 100 })),
          omittedFiles: Array.from({ length: 13 }, (_, index) => ({ path: `references/${index + 17}.md`, bytes: 100 })),
          scriptFiles: [],
          warnings: [skillWarning],
          nameChanged: false,
        }],
        warnings: [],
        truncated: false,
      };
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(LocalSkillImportPanel, {
      onImported: vi.fn(),
      onCancel: vi.fn(),
    }));
    await enterText('/Users/me/.codex/skills/my-skill', '/Users/me/.codex/skills/demo');
    await clickButton('预览');
    await flushPromises();

    expect(container.textContent).toContain('按需读取 13');
    expect(container.textContent).toContain('文件没有被删除');
    // 技能级警告带上技能名做前缀，用户才知道是哪一条技能的问题。
    expect(container.textContent).toContain(`demo: ${skillWarning}`);
  });

  /**
   * ⚠️⚠️ **用户点「取消」不是失败。**
   *
   * 后台的 `pickLocalSkillFolder` 现在把取消折成 `{ path: null }`（不再抛错），
   * 而面板这边必须**什么都不做**：不弹红条、不清已经填好的路径。
   * 改前这里抛 `pickFailed` ⇒ 用户点一下取消就看到一条红色错误。
   */
  it('stays quiet when the user dismisses the folder picker', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'PICK_LOCAL_SKILL_FOLDER') return { path: null };
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(LocalSkillImportPanel, {
      onImported: vi.fn(),
      onCancel: vi.fn(),
    }));
    await enterText('/Users/me/.codex/skills/my-skill', '/Users/me/.codex/skills/demo');
    await clickButton('选择');
    await flushPromises();

    // ⚠️ 判据是**不该出现任何错误条**（`StatusMessage` 只在 `message` 非空时渲染，
    // 而取消时 `message` 必须保持空）。改回「取消就抛错」时这里会红。
    expect(container.querySelectorAll('[style*="--ds-danger-bg"]')).toHaveLength(0);
    // 反面自检：也不能是「静默清空」—— 已填的路径要原样留着。
    expect((inputByPlaceholder('/Users/me/.codex/skills/my-skill') as HTMLInputElement).value)
      .toBe('/Users/me/.codex/skills/demo');
  });

  it('keeps safe local Skills selectable when a sibling needs an unavailable reader', async () => {
    const source = {
      id: 'local:demo',
      provider: 'local' as const,
      rootPath: '/Users/me/.codex/skills/demo',
      displayName: 'demo',
      directoryName: 'demo',
      skillPaths: ['blocked/SKILL.md', 'safe/SKILL.md'],
      importedSkillNames: ['blocked', 'safe'],
      importedAt: 1,
      updatedAt: 1,
      warnings: [],
    };
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'PREVIEW_LOCAL_SKILL_SOURCE') {
        return {
          source,
          skills: [
            {
              path: 'blocked/SKILL.md',
              name: 'blocked',
              importName: 'blocked',
              description: 'Needs an on-demand reader',
              bytes: 64000,
              bodyBytes: 6000,
              includedFiles: Array.from({ length: 16 }, (_, index) => ({ path: `blocked/references/${index + 1}.md`, bytes: 100 })),
              omittedFiles: [{ path: 'blocked/references/17.md', bytes: 100 }],
              scriptFiles: [],
              warnings: [],
              importBlock: {
                code: 'shell_reader_unavailable',
              },
              nameChanged: false,
            },
            {
              path: 'safe/SKILL.md',
              name: 'safe',
              importName: 'safe',
              description: 'Safe to import',
              bytes: 1000,
              bodyBytes: 1000,
              includedFiles: [],
              omittedFiles: [],
              scriptFiles: [],
              warnings: [],
              nameChanged: false,
            },
          ],
          warnings: [],
          truncated: false,
        };
      }
      if (message.type === 'IMPORT_LOCAL_SKILL_SOURCE') {
        return {
          ok: true,
          source,
          imported: [],
          replaced: 0,
          renamed: 0,
          warnings: [],
        };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(LocalSkillImportPanel, {
      onImported: vi.fn(),
      onCancel: vi.fn(),
    }));
    await enterText('/Users/me/.codex/skills/my-skill', '/Users/me/.codex/skills/demo');
    await clickButton('预览');
    await flushPromises();

    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toMatchObject({ checked: false, disabled: true });
    expect(checkboxes[1]).toMatchObject({ checked: true, disabled: false });
    expect(container.textContent).toContain('按需读取器不可用');
    expect(container.textContent).toContain('当前无法按需读取');
    expect(container.textContent).toContain('请将 Shell Local 执行模式设为“自动”');
    expect(container.textContent).not.toContain('Shell MCP on-demand file reading is not available to chat.');
    expect(container.textContent).toContain('未内嵌 1');
    expect(container.textContent).not.toContain('按需读取 1');

    await clickButton('导入选中 Skill');
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'IMPORT_LOCAL_SKILL_SOURCE',
      payload: {
        rootPath: '/Users/me/.codex/skills/demo',
        selectedPaths: ['safe/SKILL.md'],
        selectedImportNames: {
          'safe/SKILL.md': 'safe',
        },
      },
    });
  });

  it('localizes reader failures detected again at import time', async () => {
    const source = {
      id: 'local:demo',
      provider: 'local' as const,
      rootPath: '/Users/me/.codex/skills/demo',
      displayName: 'demo',
      directoryName: 'demo',
      skillPaths: ['SKILL.md'],
      importedSkillNames: ['demo'],
      importedAt: 1,
      updatedAt: 1,
      warnings: [],
    };
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'PREVIEW_LOCAL_SKILL_SOURCE') {
        return {
          source,
          skills: [{
            path: 'SKILL.md',
            name: 'demo',
            importName: 'demo',
            description: 'Reader was available during preview',
            bytes: 64000,
            bodyBytes: 6000,
            includedFiles: [],
            omittedFiles: [{ path: 'references/large.md', bytes: 58000 }],
            scriptFiles: [],
            warnings: [],
            nameChanged: false,
          }],
          warnings: [],
          truncated: false,
        };
      }
      if (message.type === 'IMPORT_LOCAL_SKILL_SOURCE') {
        return {
          ok: false,
          error: 'Shell MCP on-demand file reading is not available to chat.',
          importBlock: {
            code: 'shell_reader_unavailable',
          },
        };
      }
      return null;
    });
    const onImported = vi.fn();
    stubChrome(sendMessage);

    await renderElement(React.createElement(LocalSkillImportPanel, {
      onImported,
      onCancel: vi.fn(),
    }));
    await enterText('/Users/me/.codex/skills/my-skill', '/Users/me/.codex/skills/demo');
    await clickButton('预览');
    await flushPromises();
    await clickButton('导入选中 Skill');
    await flushPromises();

    expect(container.textContent).toContain('按需读取器不可用');
    expect(container.textContent).toContain('请将 Shell Local 执行模式设为“自动”');
    expect(container.textContent).not.toContain('Shell MCP on-demand file reading is not available to chat.');
    expect(onImported).not.toHaveBeenCalled();
  });
});

async function renderElement(element: React.ReactElement) {
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
}

function stubChrome(sendMessage: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => void) => {
          runtimeListeners.push(listener);
        }),
        removeListener: vi.fn((listener: (message: unknown) => void) => {
          runtimeListeners = runtimeListeners.filter((item) => item !== listener);
        }),
      },
    },
  });
}

async function enterText(placeholder: string, value: string) {
  const field = inputByPlaceholder(placeholder);
  await act(async () => {
    setTextControlValue(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function clickButton(label: string) {
  const button = buttonByText(label);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function clickButtonByLabel(label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

function inputByPlaceholder(placeholder: string): HTMLInputElement | HTMLTextAreaElement {
  const input = container.querySelector(`input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`);
  expect(input).toBeTruthy();
  return input as HTMLInputElement | HTMLTextAreaElement;
}

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent === label);
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

function setTextControlValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(input, value);
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
}

/** 顶层具名函数声明 —— 只认 `function name(...) {}`，与守卫要断言的那个形态一致。 */
function findNamedFunction(program: t.Program, name: string): t.FunctionDeclaration | undefined {
  for (const statement of program.body) {
    if (t.isFunctionDeclaration(statement) && statement.id?.name === name) return statement;
  }
  return undefined;
}

/** 节点是不是「名字为 `name` 的标识符」；`undefined` / 其它形态一律 false。 */
function isIdentifierNamed(node: t.Node | null | undefined, name: string): boolean {
  return Boolean(node && t.isIdentifier(node, { name }));
}
