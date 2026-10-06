import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * z.ai 的**纯 codec** 必须与运行时、被动拦截层、entrypoint 解耦。
 *
 * **为什么要有这条**：这几个模块是**纯函数层** —— 它们只做「形状 ↔ 值」的翻译，
 * 不碰 DOM、不发请求、不读扩展 API。一旦有人顺手在里面 `import` 一个带副作用的模块
 * （拦截器 / 自动化 / entrypoint），会同时发生两件坏事：
 * ① 它们被拖进内容脚本的 bundle（体积与启动开销）；
 * ② 更隐蔽的是**它们不再可测** —— 纯函数层一旦引到 `chrome` / `document`，
 *    单测就得先造一整套环境桩，之后没人愿意为它写测试。
 *
 * ⚠️ 上游对应文件是 `tests/deepseek-import-boundary.test.ts`。⚠️ 上游那 4 条里
 * **只有第 1 条在本项目有落点**（另 3 条测 `active-client` / `adapter` / 自动化 runner，
 * 那三个模块本项目没有 —— 我们是 DOM 注入，不发后台 HTTP）。
 *
 * ⚠️ **2026-10-06 实测：这三条对本项目全部通过**（写这条测试时已逐条核过）。
 * 所以它是**守卫**、不是「修一个已知的坏」—— 价值在于防止以后被破坏。
 */
const PURE_CODECS = [
  'core/zai/request-codec.ts',
  'core/zai/stream-codec.ts',
  'core/zai/chat-session.ts',
] as const;

describe('zai pure codec import boundary', () => {
  it('keeps pure codecs independent from runtime, interceptor, and entrypoint modules', () => {
    for (const path of PURE_CODECS) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toMatch(/from ['"].*interceptor/);
      expect(source, path).not.toMatch(/from ['"].*automation/);
      expect(source, path).not.toMatch(/from ['"].*entrypoints/);
    }
  });

  it('keeps pure codecs free of browser and extension globals', () => {
    for (const path of PURE_CODECS) {
      const source = readFileSync(path, 'utf8');
      // ⚠️ 只扫**代码**，注释里出现这些词是正常的（例如解释「后台读不到 localStorage」）。
      const code = stripComments(source);
      expect(code, path).not.toMatch(/\b(?:chrome|document|localStorage)\b/);
    }
  });

  it('keeps pure codecs free of network access', () => {
    for (const path of PURE_CODECS) {
      const source = readFileSync(path, 'utf8');
      const code = stripComments(source);
      expect(code, path).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it('only imports from its own contracts module', () => {
    // ⚠️ 收窄到「相对 import 的目标」这一层：把允许集写成显式清单，
    // 新加一个依赖就会红 —— 这正是这条守卫要拦的（顺手 import 是主要破坏方式）。
    for (const path of PURE_CODECS) {
      const source = readFileSync(path, 'utf8');
      const targets = [...source.matchAll(/from ['"](\.[^'"]+)['"]/g)].map((match) => match[1]);
      for (const target of targets) {
        expect(target, `${path} imports ${target}`).toBe('./contracts');
      }
    }
  });
});

/**
 * 去掉 `//` 行注释与 `/* *\/` 块注释。
 *
 * ⚠️ **为什么要去注释**：断言的目标是**代码**，不是「这段源码里出现过这个词」。
 * 这些文件的注释里**将来**可能（也确实合理地会）提到 `chrome` / `localStorage`
 * —— 例如解释「origin 由调用方保证」或「后台读不到 localStorage」—— 直接 `toMatch`
 * 会把正确的注释判成违规。这是「断言目标收窄」的一个实例。
 *
 * ⚠️ **行尾注释也要剥**（`code; // note`）：只锚行首的 `/^\s*\/\/.*$/` 会漏掉它，
 * 将来有人往这三个文件里写尾注释就会被误判成违规。所以用「前面不是 `:`」的写法，
 * 既覆盖行尾、又不会把 `https://…` 这类协议前缀当注释起点。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
