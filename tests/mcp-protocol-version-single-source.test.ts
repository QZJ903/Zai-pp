// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MCP_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS } from '../core/mcp/constants';

/**
 * **`MCP_PROTOCOL_VERSION` 这一条事实只能有一个值，虽然它物理上必然有多份拷贝。**
 *
 * ⚠️⚠️ 它没法收敛成一份 import：宿主是**独立的 npm 包**（`packages/shell-host` 打进安装
 * 目录，跨包 import 不成立）、`scripts/*.mjs` 是直接 `node` 跑的、不经过构建。所以
 * 「改一处忘另一处」是结构性风险 —— 而失配的表现是**静默的**：扩展发 `2025-06-18`、
 * 宿主回 `2025-11-25`，`initialize` 直接判 `mcp_protocol_version_unsupported`，
 * 用户只看到「连不上」。
 *
 * ⇒ 既然无法去掉拷贝，就用一条测试把它们钉在一起（判据同 B9：手抄的第二份清单必然分叉）。
 *
 * ⚠️ **读的是源码字面量而不是 import 值** —— 后两者不是 TS 模块。这也意味着
 * 「格式化改了引号」会让它红：那正是要的，说明有人动过。
 */

const extensions: Record<string, string> = {
  'packages/shell-host/native/contracts.mjs': "const MCP_PROTOCOL_VERSION = '",
  'scripts/mcp-smoke.mjs': "const MCP_PROTOCOL_VERSION = '",
};

function literalAfter(source: string, prefix: string): string | null {
  const start = source.indexOf(prefix);
  if (start < 0) return null;
  const valueStart = start + prefix.length;
  const valueEnd = source.indexOf("'", valueStart);
  return valueEnd < 0 ? null : source.slice(valueStart, valueEnd);
}

describe('MCP protocol version single source', () => {
  it('keeps every declared constant in sync with the extension', () => {
    for (const [file, prefix] of Object.entries(extensions)) {
      const literal = literalAfter(readFileSync(file, 'utf8'), prefix);
      expect(literal, `${file} 里应当有 ${prefix}…`).not.toBeNull();
      expect(literal, `${file} 的版本号与 MCP_PROTOCOL_VERSION 不一致`).toBe(MCP_PROTOCOL_VERSION);
    }
  });

  it('keeps the smoke-script inline literals in sync', () => {
    // `shell-smoke.mjs` 直接内联在请求体里，没有具名常量 —— 按出现次数逐个核。
    const source = readFileSync('scripts/shell-smoke.mjs', 'utf8');
    const occurrences = source.match(/protocolVersion:\s*'([^']*)'/g) ?? [];
    expect(occurrences.length, 'shell-smoke 里应当有内联的 protocolVersion').toBeGreaterThan(0);
    for (const occurrence of occurrences) {
      expect(occurrence, 'shell-smoke 的内联版本号过期了').toContain(`'${MCP_PROTOCOL_VERSION}'`);
    }
    const assertion = source.match(/protocolVersion === '([^']*)'/);
    if (assertion) {
      expect(assertion[1], 'shell-smoke 的断言必须钉当前版本').toBe(MCP_PROTOCOL_VERSION);
    }
  });

  it('keeps the live mock in sync', () => {
    const source = readFileSync('scripts/mcp-live-mock.mjs', 'utf8');
    const occurrences = source.match(/protocolVersion:\s*'([^']*)'/g) ?? [];
    expect(occurrences.length).toBeGreaterThan(0);
    for (const occurrence of occurrences) {
      expect(occurrence).toContain(`'${MCP_PROTOCOL_VERSION}'`);
    }
  });

  it('keeps the released contract fixture in sync', () => {
    // 冻结契约里的 `requestVersion` 必须就是生产请求的版本；支持清单由
    // `mcp-external-contract.test.ts` 直接对常量断言，不重复。
    const source = readFileSync('tests/fixtures/external-runtime/mcp.ts', 'utf8');
    const requestVersion = literalAfter(source, "requestVersion: '");
    expect(requestVersion).toBe(MCP_PROTOCOL_VERSION);
    // 请求的那个版本必须在支持清单里 —— 否则「发得出、收不回」。
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toContain(MCP_PROTOCOL_VERSION);
  });
});
