// cwd 归一化的真实形状回归：`resolveToolCallPayload` 必须从 grant 派生 cwd，
// 且**按工具名**（`call.name`）判断是不是命令型工具。
//
// ⚠️ 本文件存在的理由：`local-skill-cwd.test.ts` 只测纯函数，它手写
// `invocationName: 'shell_exec'` 的 descriptor —— 而**生产里 Shell Local 的工具永远不是这个形状**。
// 它们经 MCP 通道发布，`normalizeMcpToolDescriptor`（core/mcp/client.ts）把
// `invocationName` 设为 `mcp_<sanitized server id>_<tool name>`，server id 又是
// `crypto.randomUUID()`（core/mcp/store.ts）⇒ 实际值是 `mcp_t_<uuid>_shell_exec`。
// 于是「拿 invocationName 比白名单」的判据在真实形状下**恒不命中**：cwd 静默落到 homedir()，
// 调用方给的错 cwd 也不会被覆盖，而提示词里那句「initial cwd set to the Skill directory path」
// 照旧在。纯函数测试与手写 fixture 都拦不住它 —— 所以这里用**真实形状**走端到端。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SKILL_DIR = '/skills/demo';
// 真实 server id 形状：`createMcpServer` 用的是 `crypto.randomUUID()`。
const SHELL_SERVER_ID = '41095031-b1ee-41b9-92bf-89fc9314b0ab';

// 在导入 runtime 之前拦截 getGrantLocalSkillDir，避免触碰真实授权 state。
vi.mock('../core/tool/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/tool/authorization')>();
  return {
    ...actual,
    getGrantLocalSkillDir: vi.fn(async (grantId: string): Promise<string | undefined> => (
      grantId === 'grant-1' ? TEST_SKILL_DIR : undefined
    )),
    authorizeToolExecution: vi.fn(),
    completeToolExecutionAuthorization: vi.fn(async () => undefined),
  };
});

// provider 执行后的历史落盘与本模块无关，mock 避免触碰真实 storage。
vi.mock('../core/tool/history', () => ({
  appendToolCallHistory: vi.fn(async () => undefined),
}));

import { createRuntimeToolRuntime, resolveToolCallPayload } from '../core/tool/runtime';
import { ToolProviderRegistry, type RuntimeToolProvider } from '../core/tool/provider-registry';
import type { ToolCall, ToolDescriptor, ToolResult } from '../core/tool/types';
import { createToolInvocationCatalog, createToolCallFromInvocation } from '../core/tool/invocation';
import { authorizeToolExecution } from '../core/tool/authorization';
import { createMcpInvocationName } from '../core/mcp/descriptor-identity';
import {
  appendExternalizedToolPayloadChunk,
  createExternalizedToolPayload,
} from '../core/tool/externalized-payload';

// 真实形状：MCP 长 invocation name（由生产同一个函数派生，不手抄）。
const SHELL_EXEC_INVOCATION_NAME = createMcpInvocationName(SHELL_SERVER_ID, 'shell_exec');

/** 真实形状的 shell_exec descriptor：短 name + MCP 长 invocationName。 */
const shellExecDescriptor: ToolDescriptor = {
  id: `mcp:${SHELL_SERVER_ID}:shell_exec`,
  provider: { kind: 'mcp', id: SHELL_SERVER_ID, displayName: 'Shell Local', transport: 'native_messaging' },
  name: 'shell_exec',
  invocationName: SHELL_EXEC_INVOCATION_NAME,
  title: 'Execute Shell Command',
  description: 'Execute a command in the shell reported by shell_status.',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' }, cwd: { type: 'string' } },
    required: ['command'],
    additionalProperties: false,
  },
  execution: { mode: 'auto', enabled: true, risk: 'high' },
};

function shellCall(cwd?: string): ToolCall {
  const payload: Record<string, unknown> = { command: 'pwd' };
  if (cwd !== undefined) payload.cwd = cwd;
  return {
    id: 'call-1',
    descriptorId: shellExecDescriptor.id,
    provider: shellExecDescriptor.provider,
    name: shellExecDescriptor.name,
    invocationName: shellExecDescriptor.invocationName,
    payload: payload as ToolCall['payload'],
    raw: '<shell_exec>{"command":"pwd"}</shell_exec>',
  };
}

describe('descriptor 的真实形状（前置事实）', () => {
  it('shell_exec 的 invocationName 是 MCP 长名，不是工具名', () => {
    // 这条钉住本文件赖以成立的前提：一旦哪天 shell 工具改走本地 provider
    // （invocationName === 'shell_exec'），下面的用例就不再是「真实形状」，
    // 需要连同 fixture 一起重写，而不是让它们继续绿着。
    expect(shellExecDescriptor.name).toBe('shell_exec');
    expect(shellExecDescriptor.invocationName).toBe(SHELL_EXEC_INVOCATION_NAME);
    expect(shellExecDescriptor.invocationName).not.toBe(shellExecDescriptor.name);
  });
});

describe('resolveToolCallPayload cwd 归一化 — 普通（内联 XML）分支', () => {
  it('经 Skill 授权的 shell_exec → cwd 被注入为 grant 的 skillDir', async () => {
    const out = await resolveToolCallPayload(shellCall(), 'grant-1');
    expect((out.payload as { cwd?: string }).cwd).toBe(TEST_SKILL_DIR);
  });

  it('给了错误 cwd（≠ skillDir）→ 被 grant 的 skillDir 覆盖', async () => {
    const out = await resolveToolCallPayload(shellCall('C:\\'), 'grant-1');
    expect((out.payload as { cwd?: string }).cwd).toBe(TEST_SKILL_DIR);
  });

  it('已给正确 cwd（=== skillDir）→ 幂等保留', async () => {
    const out = await resolveToolCallPayload(shellCall(TEST_SKILL_DIR), 'grant-1');
    expect((out.payload as { cwd?: string }).cwd).toBe(TEST_SKILL_DIR);
  });

  it('非命令型工具（local_file_read）→ cwd 不注入', async () => {
    const call: ToolCall = {
      ...shellCall(),
      name: 'local_file_read',
      invocationName: `mcp_t_${SHELL_SERVER_ID.replace(/-/g, '_')}_local_file_read`,
      payload: { rootPath: TEST_SKILL_DIR, selectedPaths: ['SKILL.md'] } as ToolCall['payload'],
    };
    const out = await resolveToolCallPayload(call, 'grant-1');
    expect((out.payload as { cwd?: string }).cwd).toBeUndefined();
  });

  it('未绑定 Skill 授权（无 namespace）→ cwd 不注入', async () => {
    const out = await resolveToolCallPayload(shellCall(), undefined);
    expect((out.payload as { cwd?: string }).cwd).toBeUndefined();
  });

  it('grant 上没有 skillDir → cwd 不注入', async () => {
    const out = await resolveToolCallPayload(shellCall(), 'no-skill-grant');
    expect((out.payload as { cwd?: string }).cwd).toBeUndefined();
  });
});

describe('resolveToolCallPayload cwd 归一化 — 外部化载荷分支', () => {
  // 外部化分支的 cwd 判据同样取 `call.name`：载荷自带的 `invocationName` 是标签原文
  // （`createExternalizedToolPayload` 记的那个），拿它比白名单会重蹈同一个坑。
  it('外部化 shell_exec 载荷 → cwd 仍被归一化（判据不取自载荷里的标签名）', async () => {
    const callId = 'call-external-cwd';
    // 分块条目按 `namespace\0ref` 存（namespace 就是 grant.id），与 runtime 的取法一致。
    appendExternalizedToolPayloadChunk(
      callId,
      SHELL_EXEC_INVOCATION_NAME,
      '{"command":"pwd","cwd":"C:\\\\"}',
      'grant-1',
    );
    const call: ToolCall = {
      id: callId,
      descriptorId: shellExecDescriptor.id,
      provider: shellExecDescriptor.provider,
      name: shellExecDescriptor.name,
      invocationName: shellExecDescriptor.invocationName,
      payload: createExternalizedToolPayload(callId, SHELL_EXEC_INVOCATION_NAME),
      raw: '<shell_exec>...[payload externalized]</shell_exec>',
    };

    const out = await resolveToolCallPayload(call, 'grant-1');
    expect(out.parseError).toBeUndefined();
    expect((out.payload as { cwd?: string }).cwd).toBe(TEST_SKILL_DIR);
  });
});

describe('resolveToolCallPayload cwd 归一化 — 解析器→runtime 端到端', () => {
  // 用真实解析器产出 call（模型吐的是短标签 `<shell_exec>`，而 catalog 会把它
  // 归一到 descriptor 的权威 invocationName —— 这正是长名进入调用链的入口）。
  const xmlText = '<shell_exec>{"command":"pwd","cwd":"C:\\\\"}</shell_exec>';

  beforeEach(() => {
    vi.mocked(authorizeToolExecution).mockImplementation(async (call, _context, descriptors) => ({
      call: call as ToolCall,
      descriptor:
        (descriptors as readonly ToolDescriptor[]).find(
          (d) => d.id === (call as ToolCall).descriptorId,
        ) ?? shellExecDescriptor,
      externalPayloadNamespace: 'grant-1',
      reservation: { grantId: 'grant-1', callId: (call as ToolCall).id ?? 'call-1' },
      trigger: 'manual_chat',
    }));
  });

  it('模型写短标签 → 解析出的 call 带长 invocationName，但 cwd 仍被归一化', async () => {
    const catalog = createToolInvocationCatalog([shellExecDescriptor]);
    expect(catalog.invocationNames).toContain('shell_exec');
    expect(catalog.invocationNames).toContain(SHELL_EXEC_INVOCATION_NAME);

    const parsed = createToolCallFromInvocation(
      'shell_exec',
      { command: 'pwd', cwd: 'C:\\' },
      xmlText,
      catalog,
      { id: 'call-1' },
    );
    // 解析器把 invocationName 归一到权威长名（授权快照按它比对，所以这是不可绕的）。
    expect(parsed.invocationName).toBe(SHELL_EXEC_INVOCATION_NAME);
    expect(parsed.name).toBe('shell_exec');
    expect((parsed.payload as { cwd?: string }).cwd).toBe('C:\\');

    const providerCalls: ToolCall[] = [];
    const provider: RuntimeToolProvider = {
      registration: { kind: 'mcp' },
      listTools: vi.fn(async () => [shellExecDescriptor]),
      execute: vi.fn(async (authorizedCall: ToolCall) => {
        providerCalls.push(authorizedCall);
        return { ok: true, summary: 'provider completed' } as ToolResult;
      }),
    };
    const runtime = createRuntimeToolRuntime(new ToolProviderRegistry([provider]));

    await runtime.executeToolCall(parsed, 'manual_chat');

    expect(providerCalls).toHaveLength(1);
    expect((providerCalls[0].payload as { cwd?: string }).cwd).toBe(TEST_SKILL_DIR);
  });
});
