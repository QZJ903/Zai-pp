import { describe, expect, it } from 'vitest';
import type { ToolDescriptor } from '../core/types';
import { createTranslator } from '../core/i18n';
import { SHELL_TOOL_NAMES } from '../core/shell';
import {
  describeMcpTool,
  riskBadgeLabelKey,
} from '../entrypoints/sidepanel/controllers/mcp-tools-controller';

/**
 * 工具卡片上给人看的那两行字（标题 + 一句话说明）与风险徽章。
 *
 * ⚠️ **这条守的是「显示层」，不是工具 schema** —— 后者由
 * `tests/tool-schema-language.test.ts` 钉住必须英文、且与卡片无关。
 * 两边共用同一个 `ToolDescriptor`，改错对象很容易：把中文写进 `descriptor.title`
 * 会让 schema 那条红，而把卡片改成直接渲染 `tool.description` 会让本文件红。
 */

const t = createTranslator('zh-CN').t;

function descriptor(name: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: `mcp:server-1:${name}`,
    provider: {
      id: 'server-1',
      kind: 'mcp',
      displayName: 'Shell Local',
      transport: 'native_messaging',
    },
    name,
    invocationName: `mcp_server_1_${name}`,
    title: 'HOST TITLE',
    description: 'HOST DESCRIPTION',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execution: { mode: 'auto', enabled: true, risk: 'high' },
    ...overrides,
  } as ToolDescriptor;
}

describe('MCP tool card presentation', () => {
  it('resolves a Chinese label and summary for every built-in Shell tool', () => {
    for (const name of SHELL_TOOL_NAMES) {
      const presentation = describeMcpTool(descriptor(name), t);
      // 回落就等于没写 —— 服务端给的是英文，中文界面里会出现两行英文。
      expect(presentation.label, `${name} 回落到服务端 title`).not.toBe('HOST TITLE');
      expect(presentation.summary, `${name} 回落到服务端 description`).not.toBe('HOST DESCRIPTION');
      expect(presentation.label.trim().length, name).toBeGreaterThan(0);
      expect(presentation.summary.trim().length, name).toBeGreaterThan(0);
      expect(/[一-鿿]/.test(presentation.label), `${name} 的标题不是中文`).toBe(true);
    }
  });

  it('keeps the risk badge independent from the machine risk level', () => {
    // ⚠️ native host 把 shell_exec 与 local_file_write 都标成 risk: 'high'，
    // 而这两件事对人的含义完全不同 —— 徽章若从 execution.risk 派生，这两条会相等。
    expect(describeMcpTool(descriptor('shell_exec'), t).risk).toBe('execute');
    expect(describeMcpTool(descriptor('local_file_write'), t).risk).toBe('write');
    expect(describeMcpTool(descriptor('shell_status'), t).risk).toBe('read');
    expect(describeMcpTool(descriptor('shell_exec'), t).risk)
      .not.toBe(describeMcpTool(descriptor('local_file_write'), t).risk);
  });

  it('falls back to the server-provided text for third-party tools', () => {
    const presentation = describeMcpTool(
      descriptor('some_external_tool', {
        execution: { mode: 'auto', enabled: true, risk: 'low' },
      }),
      t,
    );
    expect(presentation.label).toBe('HOST TITLE');
    expect(presentation.summary).toBe('HOST DESCRIPTION');
    expect(presentation.risk).toBe('read');
  });

  it('resolves a label for each of the three risk badges', () => {
    const labels = (['read', 'write', 'execute'] as const).map((risk) => t(riskBadgeLabelKey(risk)));
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(3);
  });
});
