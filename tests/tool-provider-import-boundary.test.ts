import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import {
  getModuleSpecifiers,
  parseTypeScriptSource,
  walkSourceAst,
} from './helpers/typescript-source';

/**
 * 工具提供者的**导入边界**：provider registry 与 runtime 必须与实际 provider 解耦，
 * 工具/MCP 契约切片里不能有静态循环依赖，生产侧只允许一个注册数组。
 *
 * 与上游版的三处差异（都是本项目的站点适配，不是漏改）：
 *  ① 上游第 4 个用例读 `entrypoints/content.ts` / `main-world.content.ts` /
 *    `isolated-bridge-controller.ts` —— **这三个文件本项目没有**（首版就未移植
 *    上游那套 content 分层）。该用例的等价契约在 `entrypoints/zai.content.ts`，
 *    但断言值完全不同（本项目刻意用宽松的 `sendRuntimeMessage`，见下面的用例 4）。
 *  ② 上游断言 `runtime.ts` 的 import 清单含 `'./local-skill-cwd'` —— 本项目也有，逐字相同。
 *  ③ 上游的 `registryConstructionShape` 会遍历全仓；本项目 `tests/` 下有 6 个文件也构造
 *    注册表，所以过滤 `tests/` 这一步是**必要**的（上游同样过滤，逻辑一致）。
 */

const ROOT = process.cwd();
const CORE_ROOT = resolve(ROOT, 'core');
const TARGET_PREFIXES = ['core/tool/', 'core/mcp/'];
const TARGET_FILES = new Set(['core/constants.ts', 'core/types.ts']);

describe('tool provider import boundary', () => {
  it('keeps registry and runtime independent from concrete providers', () => {
    expect(relativeImports('core/tool/provider-registry.ts').sort()).toEqual([
      '../i18n',
      './types',
    ]);
    expect(relativeImports('core/tool/runtime.ts').sort()).toEqual([
      '../diagnostics/log-buffer',
      '../i18n/background',
      '../messaging/tool-record-codec',
      // ⚠️ **`../network/abort` 是执行超时的落地依赖** —— `executeRuntimeToolCall` 按
      // 描述符的 `execution.timeoutMs` 建 `createAbortScope`，把 signal 一路传到
      // provider（浏览器控制那条最终落到 `cdp.sendCommand`）。
      // ⚠️ 它是**纯工具模块**（只导出一个 `AbortScope` 工厂，不 import 任何 provider），
      // 加进来不破坏这条用例守的东西：runtime 仍然不认识任何具体 provider。
      '../network/abort',
      './authorization',
      './execution-error',
      './externalized-payload',
      './history',
      './local-skill-cwd',
      './provider-registry',
      // ⚠️ **`./result-bytes` 是 `maxResultBytes` 的落地实现** —— 与 `../network/abort`
      // 同一个来由（一个是时长上界、一个是体积上界）。它是纯工具模块，不 import 任何 provider。
      './result-bytes',
      './types',
    ]);
  });

  it('has no static SCC in the migrated tool/MCP contract slice', () => {
    const files = listSourceFiles(CORE_ROOT);
    const graph = new Map(files.map((file) => [file, resolveImports(file, files)]));
    const cycles = stronglyConnectedComponents(graph)
      .filter((component) => component.length > 1 || graph.get(component[0])?.has(component[0]))
      .filter((component) => component.some((file) => {
        const relative = toRelative(file);
        return TARGET_FILES.has(relative) || TARGET_PREFIXES.some((prefix) => relative.startsWith(prefix));
      }))
      .map((component) => component.map(toRelative).sort());

    expect(cycles).toEqual([]);
  });

  it('keeps the only production registration array in Background composition', () => {
    const productionFiles = listSourceFiles(ROOT)
      .filter((file) => !toRelative(file).startsWith('tests/'));
    const owners = productionFiles
      .filter((file) => registryConstructionShape(file).count > 0)
      .map(toRelative);

    expect(owners).toEqual(['entrypoints/background/tool-provider-composition.ts']);
    expect(registryConstructionShape(resolve(
      ROOT,
      'entrypoints/background/tool-provider-composition.ts',
    ))).toEqual({ count: 1, inlineProviderArrays: 1 });
    expect(relativeImports('entrypoints/background.ts')).toContain('./background/tool-provider-composition');
  });

  it('keeps the content-side tool descriptor catalog fail-closed', () => {
    // ⚠️ **本用例的断言值是本项目的实际契约，不是上游那份**。
    // 上游用 `sendRuntimeMessageStrict` + 「同步失败即禁用工具执行」；本项目刻意改用
    // **宽松的 `sendRuntimeMessage`**（采集类读取失败当空值，属既定取舍，见 §4.8 的
    // 两个封装对照表），且没有「禁用工具执行」这个状态。
    //
    // 所以这条守的是**本项目自己的 fail-closed 形态**：拿不到目录时落**空目录**
    // （而不是保留旧目录、也不是回落到内置默认目录）—— 空目录意味着主世界认不出任何
    // 工具标签，模型即使吐了也不会执行，方向与上游一致。
    const source = readFileSync(resolve(ROOT, 'entrypoints/zai.content.ts'), 'utf8');

    // ① 目录的初值是空数组（不是 DEFAULT_TOOL_DESCRIPTORS）
    expect(source).toContain('let currentToolDescriptors: ToolDescriptor[] = [];');
    expect(source).not.toContain('DEFAULT_TOOL_DESCRIPTORS');
    // ② 读取结果必须是「非数组即空」，不能是「非数组即默认目录」
    expect(source).toMatch(
      /sendRuntimeMessage<ToolDescriptor\[\]>\(\{\s*type:\s*'GET_TOOL_DESCRIPTORS',?\s*\}\)\.then\(\(v\)\s*=>\s*\(Array\.isArray\(v\)\s*\?\s*v\s*:\s*\[\]\)\)/,
    );
    // ③ 同步必须过闸门（详见 tests/zai-content-tool-execution-contract.test.ts 的同名契约）
    expect(source).toContain('const toolDescriptorSyncGate = createLatestSyncGate();');
    expect(source).toMatch(/syncLease\.commit\(\(\)\s*=>\s*\{/);

    // ④ 主世界的初始 hook 状态也是空目录
    const mainWorldSource = readFileSync(resolve(ROOT, 'entrypoints/zai-main-world.content.ts'), 'utf8');
    expect(mainWorldSource).toContain('new Set(state.toolDescriptorNames)');
  });

  it('keeps DEFAULT_TOOL_DESCRIPTORS out of every executable path', () => {
    // 上游的同类断言（`hookSource` 里不许出现 DEFAULT_TOOL_DESCRIPTORS）在本项目要拆开看：
    // **fetch-hook 是我们自己的**（`core/zai/fetch-hook.ts`），要求它不引用内置默认目录；
    // `core/tool/index.ts` 里那个 `DEFAULT_TOOL_DESCRIPTORS` 常量本身仍然存在（barrel 导出），
    // 但**不能出现在任何执行链上** —— 一旦出现，模型就能看到一组与后台投影无关的工具。
    const hookSource = readFileSync(resolve(ROOT, 'core/zai/fetch-hook.ts'), 'utf8');
    expect(hookSource).not.toContain('DEFAULT_TOOL_DESCRIPTORS');
    expect(hookSource).toContain('toolDescriptorNames');

    const contentSource = readFileSync(resolve(ROOT, 'entrypoints/zai.content.ts'), 'utf8');
    expect(contentSource).not.toContain('DEFAULT_TOOL_DESCRIPTORS');
  });
});

function registryConstructionShape(file: string): { count: number; inlineProviderArrays: number } {
  const source = readFileSync(file, 'utf8');
  const program = parseTypeScriptSource(file, source);
  const localNames = new Set<string>();
  for (const node of program.body) {
    if (!t.isImportDeclaration(node)) continue;
    for (const specifier of node.specifiers) {
      if (!t.isImportSpecifier(specifier)) continue;
      const imported = t.isIdentifier(specifier.imported)
        ? specifier.imported.name
        : specifier.imported.value;
      if (imported === 'ToolProviderRegistry') {
        localNames.add(specifier.local.name);
      }
    }
  }
  let count = 0;
  let inlineProviderArrays = 0;
  walkSourceAst(program, (node) => {
    if (
      t.isNewExpression(node)
      && t.isIdentifier(node.callee)
      && localNames.has(node.callee.name)
    ) {
      count += 1;
      if (node.arguments.length === 1 && t.isArrayExpression(node.arguments[0])) {
        inlineProviderArrays += 1;
      }
    }
  });
  return { count, inlineProviderArrays };
}

function relativeImports(path: string): string[] {
  return parseModuleSpecifiers(resolve(ROOT, path)).filter((specifier) => specifier.startsWith('.'));
}

function resolveImports(file: string, files: readonly string[]): Set<string> {
  const fileSet = new Set(files);
  const result = new Set<string>();
  for (const specifier of parseModuleSpecifiers(file)) {
    if (!specifier.startsWith('.')) continue;
    const candidate = resolve(dirname(file), specifier);
    const resolved = [
      candidate,
      `${candidate}.ts`,
      `${candidate}.tsx`,
      join(candidate, 'index.ts'),
      join(candidate, 'index.tsx'),
    ].find((item) => fileSet.has(normalize(item)));
    if (resolved) result.add(normalize(resolved));
  }
  return result;
}

function parseModuleSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return getModuleSpecifiers(parseTypeScriptSource(file, source));
}

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.output' || entry === 'dist' || entry === '.wxt') continue;
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (path.endsWith('.ts') || path.endsWith('.tsx')) {
      files.push(normalize(path));
    }
  }
  return files.sort();
}

function stronglyConnectedComponents(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string) => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(dependency)!));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component);
  };

  for (const node of graph.keys()) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

function toRelative(path: string): string {
  const normalizedRoot = normalize(ROOT).replace(/\\/g, '/');
  return normalize(path).replace(/\\/g, '/').slice(`${normalizedRoot}/`.length);
}