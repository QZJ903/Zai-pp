import { describe, expect, it } from 'vitest';
import { renderToolSchemas } from '../core/prompt';
import { EXPOSED_SHELL_TOOL_NAMES } from '../core/shell/contracts';
import { normalizeMcpToolDescriptor, type McpServerConfig, type McpToolDefinition } from '../core/mcp';

/**
 * **提示词里点名的 shell 工具必须真的在目录里。**
 *
 * 那段「可识别的 shell 工具名：…」的用途是告诉模型「哪些名字可以写成 XML 标签」。
 * 点名一个调不到的工具，等于给它一个必然失败的选项 —— 而这份清单曾经是**常量**
 * （`EXPOSED_SHELL_TOOL_NAMES`，11 个），与目录里实际有几个毫无关系：
 * `maxToolCount` 会在发现阶段截断尾部工具，用户也能在 MCP 页逐个关掉。
 *
 * ⚠️ **上游同样是常量**，但上游的前提是「Shell Local 全量暴露」；本项目有上限截断与
 * 用户级 allowlist ⇒ 前提不成立（「上游错了照抄也是错」）。
 */

function shellServer(): McpServerConfig {
  return {
    version: 1,
    id: 'shell-local',
    displayName: 'Shell Local',
    enabled: true,
    transport: { kind: 'native_messaging', nativeHost: 'com.zai_pp.shell' },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 5_000, requestMs: 60_000, discoveryMs: 10_000 },
    limits: { maxResultBytes: 128_000, maxToolCount: 16 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'ready',
    lastConnectedAt: 0,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function shellTool(name: string): McpToolDefinition {
  return {
    name,
    title: name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    annotations: { risk: 'low' },
  };
}

/** 把 `可识别的 shell 工具名：a, b, c` 这一行解析成名字数组；没有那一行时返回 `null`。 */
function renderedShellToolNames(names: readonly string[]): string[] | null {
  const descriptors = names.map((name) => normalizeMcpToolDescriptor(shellServer(), shellTool(name)));
  const line = renderToolSchemas(descriptors, 'zh-CN')
    .split('\n')
    .find((candidate) => candidate.startsWith('可识别的 shell 工具名：'));
  if (!line) return null;
  return line.slice('可识别的 shell 工具名：'.length).split(',').map((name) => name.trim());
}

describe('shell tool names in the prompt follow the actual catalog', () => {
  it('lists exactly the shell tools that are present', () => {
    const listed = renderedShellToolNames(['shell_exec', 'shell_status']);

    expect(listed).toEqual(['shell_exec', 'shell_status']);
  });

  it('never names a shell tool that is absent from the catalog', () => {
    const present = ['shell_exec', 'shell_status', 'local_file_read'] as const;
    const listed = renderedShellToolNames(present) ?? [];

    // ⚠️ 判据写成「列出来的 ⊆ 实际有的」而不是「等于某个期望数组」——
    // 后者会在增删工具时变成一条要跟着改的清单（手抄必然分叉）。
    expect(listed.length).toBeGreaterThan(0);
    for (const name of listed) {
      expect(present as readonly string[], `${name} 不在本轮目录里却被点名`).toContain(name);
    }
  });

  it('matches the historical constant when every exposed tool is present', () => {
    // ⚠️ **这条守的是「黄金文件不受影响」** —— 提示词是逐字节被
    // `tests/prompt-output-contract.test.ts` 钉住的。全量目录下输出必须与改造前
    // 完全一致（同样的名字、同样的顺序），否则那次改动会顺带改掉一份无关的黄金文件。
    const listed = renderedShellToolNames(EXPOSED_SHELL_TOOL_NAMES);

    expect(listed).toEqual([...EXPOSED_SHELL_TOOL_NAMES]);
  });

  it('keeps the canonical order instead of the discovery order', () => {
    // 目录顺序反过来喂进去，列出来的顺序仍按 `EXPOSED_SHELL_TOOL_NAMES` —— 顺序变了
    // 提示词字节就变了，而那是无意义的噪声。
    const reversed = [...EXPOSED_SHELL_TOOL_NAMES].reverse();
    const listed = renderedShellToolNames(reversed);

    expect(listed).toEqual([...EXPOSED_SHELL_TOOL_NAMES]);
  });
});
