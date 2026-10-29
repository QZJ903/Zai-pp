import { describe, expect, it } from 'vitest';
import { buildPromptAugmentation } from '../core/prompt';
import { normalizeMcpToolDescriptor, type McpServerConfig, type McpToolDefinition } from '../core/mcp';

/**
 * **系统提示词总开关关掉时，提示词里不该留下指向不存在段落的说明。**
 *
 * 具体形态：沙箱段（`## 沙盒与宿主机`）正文里有三处写「以 `### 可用工具` 清单为准」，
 * 而那个清单与沙箱段本身都住在 `systemChat` 模板里 ⇒ 开关一关，**两者一起消失**才对。
 *
 * ⚠️⚠️ **曾经的行为是「沙箱段单独补一份」** —— 于是关掉开关后，模型读到的是一段
 * 完整保留 12 个子标题的沙箱说明，里面三次告诉它「以那份清单为准」，而全文根本没有那份清单。
 * 沙箱段的核心判据是「清单里的走 XML、清单外的走 tool_call」；清单没了这条判据就没有依据。
 *
 * ⚠️ **对齐上游**：上游 `buildPromptAugmentation` 没有这个补偿分支（它连沙箱段都没有），
 * 关掉系统提示词时只保留「预设 / skill 上下文 / 独立记忆段 / 强制语言 / 用户提示词」。
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

function augment(systemPromptEnabled: boolean): string {
  const descriptors = [
    normalizeMcpToolDescriptor(shellServer(), shellTool('shell_exec')),
    normalizeMcpToolDescriptor(shellServer(), shellTool('local_file_read')),
  ];
  return buildPromptAugmentation('列出当前目录。', {
    memories: [],
    toolDescriptors: descriptors,
    locale: 'zh-CN',
    systemPromptEnabled,
  }).augmented;
}

describe('sandbox section follows the system prompt switch', () => {
  it('injects both the tool list and the sandbox section when the switch is on', () => {
    const text = augment(true);
    const lines = text.split('\n');

    // ⚠️ **必须断言「整行等于标题」，不能只 `toContain('### 可用工具')`** ——
    // 沙箱段正文里就有一句「以 `### 可用工具` 清单为准」，只查子串时**清单真的缺失也照样绿**。
    expect(lines.some((line) => line.trim() === '### 可用工具'), '### 可用工具 清单应当注入').toBe(true);
    expect(lines.some((line) => line.trim() === '## 沙盒与宿主机'), '## 沙盒与宿主机 应当注入').toBe(true);
    expect(text, '沙箱段应当引用工具清单').toContain('以 `### 可用工具` 清单为准');
  });

  it('drops the sandbox section together with the tool list when the switch is off', () => {
    const text = augment(false);
    const lines = text.split('\n');

    expect(lines.some((line) => line.trim() === '### 可用工具'), '### 可用工具 清单不该注入').toBe(false);
    expect(lines.some((line) => line.trim() === '## 沙盒与宿主机'), '## 沙盒与宿主机 不该注入').toBe(false);
    // ⚠️ 这一条是**意图**的直接表达：不能留下指向不存在的清单的句子。
    // ⚠️ **它与上面那条「段不该注入」当前是同一个判据的两种说法**（那句引用只出现在沙箱段里）
    // —— 实测删掉它，上面那条仍然拦得住。留着是因为将来若有人把引用挪出沙箱段，
    // 上面那条会绿而这一条会红。
    expect(text, '不该留下对工具清单的引用').not.toContain('以 `### 可用工具` 清单为准');
    // 用户原文照常在。
    expect(text).toContain('列出当前目录。');
  });

  it('keeps the segments that have their own switch when the system prompt is off', () => {
    // 对齐上游语义：总开关只管 `systemChat` 那一段。
    // 预设 / 独立记忆段 / 强制语言各有自己的开关，不随它一起失效。
    const text = buildPromptAugmentation('列出当前目录。', {
      memories: [{
        id: 1,
        syncId: 'sync-1',
        type: 'user',
        name: '身份',
        content: '我是前端工程师',
        description: '',
        tags: [],
        pinned: true,
        createdAt: 1,
        updatedAt: 1,
        accessCount: 1,
        lastAccessedAt: 1,
      }],
      presetContent: '你是代号「铁匠」的工程助手。',
      forceResponseLanguage: 'en',
      memoryEnabled: true,
      systemPromptEnabled: false,
      toolDescriptors: [],
      locale: 'zh-CN',
    }).augmented;

    expect(text, '预设应当照常注入').toContain('你是代号「铁匠」的工程助手。');
    expect(text, '独立记忆段应当照常注入').toContain('## 已有记忆');
    expect(text, '记忆条目应当照常注入').toContain('我是前端工程师');
    expect(text, '强制回复语言应当照常注入').toContain('## 回复语言');
    expect(text, '`## 角色` 不该出现').not.toContain('## 角色');
  });
});
