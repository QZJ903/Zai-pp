import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('sidepanel lazy route boundaries', () => {
  it('keeps top-level pages out of the static sidepanel entry graph', () => {
    const source = readFileSync('entrypoints/sidepanel/App.tsx', 'utf8');

    for (const page of [
      'LibraryPage',
      'ProjectsPage',
      'SettingsPage',
      'CapabilitiesPage',
    ]) {
      expect(source).toContain(`lazy(() => import('./pages/${page}'))`);
      expect(source).not.toMatch(new RegExp(`import\\s+${page}\\s+from`));
    }
    expect(source).toContain('fallback={<RouteFallback />}');
    expect(source).not.toContain("from './components/settings/primitives'");
  });

  it('loads each capability page from its own navigation boundary', () => {
    const source = readFileSync('entrypoints/sidepanel/pages/CapabilitiesPage.tsx', 'utf8');

    for (const page of [
      'SkillPage',
      'McpPage',
      'BrowserControlPage',
      'AutomationPage',
    ]) {
      expect(source).toContain(`lazy(() => import('./${page}'))`);
      expect(source).not.toMatch(new RegExp(`import\\s+${page}\\s+from`));
    }
    expect(source).toContain('<Suspense fallback={<RouteFallback />}>');
  });

  it('keeps the tools page gone (its per-tool shortcut duplicated the MCP page)', () => {
    // 工具页原本只放 Python 解释器一张卡片，而那张卡片做的三件事（开关 / 创建 / 刷新）
    // MCP 页的 Shell 服务里全都有 ⇒ 整块删除，不再有 `tools` 子标签。
    // ⚠️ 判据锚在「模块是否存在」，不是「字符串有没有被引用」——
    // 后者在文件被删之后恒真，等于没守。
    expect(existsSync('entrypoints/sidepanel/pages/ToolsPage.tsx')).toBe(false);
    expect(existsSync('entrypoints/sidepanel/controllers/useToolsPageController.ts')).toBe(false);

    const capabilities = readFileSync('entrypoints/sidepanel/pages/CapabilitiesPage.tsx', 'utf8');
    expect(capabilities).not.toContain("tabs.tools");
    expect(capabilities).not.toContain('ToolsPage');
  });

  it('loads each settings section independently after the settings route opens', () => {
    const source = readFileSync('entrypoints/sidepanel/pages/SettingsPage.tsx', 'utf8');

    for (const page of [
      'GeneralSubPage',
      'PresetSubPage',
      'PromptSubPage',
      'UsageSubPage',
      'AboutSubPage',
    ]) {
      expect(source).toContain(`lazy(() => import('../components/settings/${page}'))`);
      expect(source).not.toMatch(new RegExp(`import\\s+${page}\\s+from`));
    }
    expect(source).toContain('<Suspense fallback={<RouteFallback />}>');
  });

  it('retains independent Memory, Saved and Data chunks inside Library', () => {
    const source = readFileSync('entrypoints/sidepanel/pages/LibraryPage.tsx', 'utf8');

    expect(source).toContain("lazy(() => import('./MemoryPage'))");
    expect(source).toContain("lazy(() => import('./SavedPage'))");
    expect(source).toContain("lazy(() => import('../components/settings/DataSubPage'))");
    expect(source).toContain('<Suspense fallback={<RouteFallback />}>');
  });
});
