import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_LOCALE_SECTIONS,
  backgroundLocaleResources,
  type LocaleMessageKey,
} from '../core/i18n/background';
import { resolveMessageIn } from '../core/i18n/runtime';

/**
 * Guards the background i18n slice: every locale key used by
 * a background-reachable module must resolve inside the slim background
 * resource set. A key drifting out of the four sections (or a module switching
 * to a full-tree key) fails this test instead of throwing at runtime.
 *
 * ⚠️ **清单的判据是「这个文件在不在后台/内容脚本包里」，不是「它现在有没有 import 切片」。**
 * 后者会诱导人删掉「暂时零调用」的条目 —— 而它们**已经在射程内**（后台可达约 170 个文件），
 * 随时可能加一句 `backgroundT(...)`，那时覆盖应当是自动的。**只有目录都不存在的条目才该清。**
 *
 * ⚠️⚠️ **`entrypoints/zai.content.ts` 必须在清单里** —— 它同样 import
 * `core/i18n/background` 的 `translate`，用着 21 个 `content.projectPanel.*` 键。
 * 它不在 `entrypoints/background*` 底下，所以容易被这份清单的写法漏掉：
 * 清单隐含假设「用切片的模块都在 `core/` 或 `entrypoints/background*` 下」，
 * 而本项目的**内容脚本就在 `entrypoints/` 根目录**，那个假设不成立。
 * 漏了它 ⇒ 那些键漂出四段时**测试不会红**，只有真机上面板渲染时才抛。
 */
const ROOT = process.cwd();
const SCAN_PATHS = [
  'entrypoints/background.ts',
  'entrypoints/background',
  // ⚠️ 内容脚本与后台共享同一份精简资源集，它也是「background-reachable」的那类模块。
  'entrypoints/zai.content.ts',
  'core/tool',
  'core/automation',
  'core/sync',
  'core/mcp',
  'core/memory',
  'core/skill',
  'core/prompt',
  'core/messaging',
  'core/browser-control',
  'core/network',
  'core/interceptor',
  'core/ui',
  'core/project',
  'core/saved-items',
  'core/usage',
  'core/background',
  'core/token',
  'core/diagnostics',
  'core/platform',
  'core/shell',
  'core/preset',
  'core/persistence',
  'core/constants.ts',
  'core/version.ts',
  'core/whats-new.ts',
];

function collectSourceFiles(): string[] {
  const files: string[] = [];
  for (const target of SCAN_PATHS) {
    const absolute = resolve(ROOT, target);
    if (!statSync(absolute, { throwIfNoEntry: false })) continue;
    const visit = (path: string) => {
      const stats = statSync(path);
      if (stats.isDirectory()) {
        for (const entry of readdirSync(path)) {
          if (entry === 'node_modules') continue;
          visit(join(path, entry));
        }
      } else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.spec.ts')) {
        files.push(path);
      }
    };
    visit(absolute);
  }
  return files;
}

function extractTranslateKeys(source: string): string[] {
  const keys = new Set<string>();
  const patterns = [
    // first-argument form: translate('key') / t('key') / ta('key') / backgroundT('key')
    /(?:translate|backgroundT|\bt\b|\bta\b)\(\s*'([a-z][A-Za-z0-9.]*)'/g,
    // second-argument form: translate(locale, 'key')
    /(?:translate|backgroundT|\bt\b|\bta\b)\(\s*[^,)]*,\s*'([a-z][A-Za-z0-9.]*)'/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) keys.add(match[1]!);
  }
  return [...keys];
}

describe('background i18n slice', () => {
  it('keeps every background-reachable locale key inside the slim resource set', () => {
    expect([...BACKGROUND_LOCALE_SECTIONS].sort()).toEqual(['background', 'content', 'prompt', 'tool']);

    const files = collectSourceFiles();
    expect(files.length).toBeGreaterThan(100);

    const missing = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const key of extractTranslateKeys(source)) {
        try {
          resolveMessageIn(backgroundLocaleResources, 'en', key);
        } catch {
          missing.add(`${relative(ROOT, file)}: ${key}`);
        }
      }
    }

    expect([...missing].sort()).toEqual([]);
  });

  it('narrows the background key type to the four sections', () => {
    // Compile-time sanity: the exported key type must reject a sidepanel key.
    const typeCheck: LocaleMessageKey = 'tool.memory.providerName';
    expect(typeCheck).toBe('tool.memory.providerName');
  });
});
