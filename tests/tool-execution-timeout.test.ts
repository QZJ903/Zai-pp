import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolDescriptor } from '../core/types';

vi.mock('../core/mcp/discovery', () => ({
  executeMcpToolCall: vi.fn(),
  getMcpToolDescriptors: vi.fn(async () => []),
  refreshMcpServerDiscovery: vi.fn(),
}));

vi.mock('../core/mcp/store', () => ({
  getAllMcpServers: vi.fn(async () => []),
}));

vi.mock('../core/memory/store', () => ({
  deleteMemory: vi.fn(),
  getMemoryById: vi.fn(),
  saveMemory: vi.fn(),
  updateMemory: vi.fn(),
}));

vi.mock('../core/tool/history', () => ({
  appendToolCallHistory: vi.fn(),
}));

import { executeMcpToolCall, getMcpToolDescriptors } from '../core/mcp/discovery';
import { executeRuntimeToolCall } from './helpers/production-tool-runtime';

/**
 * **描述符声明的两道上界都必须真的生效**：`execution.timeoutMs`（时长）与
 * `execution.maxResultBytes`（体积）。
 *
 * ⚠️⚠️ 这两条在改造前都是**静默空转**的：本地 provider 链上没有任何地方读它们 ——
 * 唯一读取点在 `core/mcp/discovery.ts`（MCP 链自己的）。
 * - 时长那一半：`chrome.debugger.sendCommand` 本身没有超时，一条挂住的 CDP 命令
 *   能让整条 `EXECUTE_TOOL_CALL` 永不返回 ⇒ 内容脚本的 `pendingExecutions` 永不减
 *   ⇒ 续跑循环停在 `running`。
 * - 体积那一半：18 个浏览器工具写的 40 000 / 60 000、`memory_*` 与 `skill_*` 的 4096
 *   全部不生效 ⇒ 一条结果能任意大。
 */

describe('tool execution timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})) } },
    });
  });

  it('turns a hung provider into a non-retryable timeout result', async () => {
    const descriptor = makeDescriptor({ timeoutMs: 30 });
    vi.mocked(getMcpToolDescriptors).mockResolvedValue([descriptor]);
    // provider 永不 settle —— 模拟挂住的 CDP 命令。
    vi.mocked(executeMcpToolCall).mockImplementation(() => new Promise(() => {}));

    const started = Date.now();
    const result = await executeRuntimeToolCall(makeCall(descriptor), trusted(), 'en');
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(
      result.error?.code,
      '超时必须有自己的错误码，不能折成 background_tool_execution_failed',
    ).toBe('tool_execution_timeout');
    // ⚠️ **不可重试** —— 自动重跑只会再等一遍同样长的时间。
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.details).toMatchObject({ timeoutMs: 30 });
    expect(elapsed, '必须在预算附近返回，而不是一直等').toBeLessThan(1_000);
  });

  it('does not impose a timeout when the descriptor declares none', async () => {
    // ⚠️ 反向用例：`memory_*` / `skill_*` 那几个工具本来就不声明 `timeoutMs`，
    // 不能在运行时凭空给它们造一个上限。
    const descriptor = makeDescriptor({});
    vi.mocked(getMcpToolDescriptors).mockResolvedValue([descriptor]);
    vi.mocked(executeMcpToolCall).mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, summary: 'slow but fine' }), 120);
    }));

    const result = await executeRuntimeToolCall(makeCall(descriptor), trusted(), 'en');

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('slow but fine');
  });

  it('keeps the caller-supplied budget when it is tighter than the descriptor', async () => {
    // ⚠️ `options.timeoutMs`（调用方显式传的）优先于描述符 —— 自动化租约那边
    // 传的是剩余时间，比工具自己的默认值更准确。
    const descriptor = makeDescriptor({ timeoutMs: 60_000 });
    vi.mocked(getMcpToolDescriptors).mockResolvedValue([descriptor]);
    vi.mocked(executeMcpToolCall).mockImplementation(() => new Promise(() => {}));

    const result = await executeRuntimeToolCall(makeCall(descriptor), trusted(), 'en', {
      timeoutMs: 30,
    });

    expect(result.error?.code).toBe('tool_execution_timeout');
    expect(result.error?.details).toMatchObject({ timeoutMs: 30 });
  });
});

describe('tool result byte budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})) } },
    });
  });

  it('truncates an oversized detail down to the declared byte budget', async () => {
    // ⚠️ 预算按 **UTF-8 字节**算 —— 中文一个字符 3 字节。用 3_000 个「细」
    // （9_000 字节）配 100 字节预算，按字符判会剩 100 字符（=300 字节），
    // 按字节判只会剩约 33 字符。断言上界是字节数，两种判据在这里分叉。
    const descriptor = makeDescriptor({ maxResultBytes: 100 });
    vi.mocked(getMcpToolDescriptors).mockResolvedValue([descriptor]);
    vi.mocked(executeMcpToolCall).mockResolvedValue({
      ok: true,
      summary: 'big',
      detail: '细'.repeat(3_000),
    });

    const result = await executeRuntimeToolCall(makeCall(descriptor), trusted(), 'en');

    expect(result.ok).toBe(true);
    expect(result.truncated, '超预算必须置 truncated').toBe(true);
    expect(Buffer.byteLength(result.detail ?? '', 'utf8')).toBeLessThanOrEqual(100);
    // ⚠️ 不能切出半个字符 —— 截断点必须回退到 UTF-8 边界（否则是 U+FFFD）。
    expect(result.detail).not.toContain('\uFFFD');
    // 全是同一个字符，所以开头一定还是它（证明没有整段被清空）。
    expect(result.detail!.startsWith('细')).toBe(true);
  });

  it('leaves a within-budget result untouched', async () => {
    // 反向用例：不超预算时**不能**置 truncated、也不能改 detail。
    const descriptor = makeDescriptor({ maxResultBytes: 10_000 });
    vi.mocked(getMcpToolDescriptors).mockResolvedValue([descriptor]);
    vi.mocked(executeMcpToolCall).mockResolvedValue({ ok: true, summary: 'small', detail: '简短' });

    const result = await executeRuntimeToolCall(makeCall(descriptor), trusted(), 'en');

    expect(result.detail).toBe('简短');
    expect(result.truncated).toBeUndefined();
  });

  it('keeps structured output intact even when detail overflows', async () => {
    // ⚠️⚠️ **`output` 绝不能跟着被裁** —— 它是结构化结果，消费方按对象形状判
    // （`skill_draft_create` 的「保存」按钮、`memory_import_preview` 的「导入」按钮）。
    // 把它裁成字符串等于让按钮静默消失。MCP 链的既有口径也是只裁 `detail`。
    const descriptor = makeDescriptor({ maxResultBytes: 50 });
    vi.mocked(getMcpToolDescriptors).mockResolvedValue([descriptor]);
    const structured = { kind: 'skill_draft', draft: { name: 'x'.repeat(500) } };
    vi.mocked(executeMcpToolCall).mockResolvedValue({
      ok: true,
      summary: 'draft',
      detail: '细节'.repeat(1_000),
      output: structured,
    });

    const result = await executeRuntimeToolCall(makeCall(descriptor), trusted(), 'en');

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.detail ?? '', 'utf8')).toBeLessThanOrEqual(50);
    expect(result.output, 'output 必须仍是原来的对象').toEqual(structured);
    expect(typeof result.output).toBe('object');
  });

  it('does not impose a byte budget when the descriptor declares none', async () => {
    // `memory_*` 那三个工具都不声明 maxResultBytes —— 不能凭空造上限。
    const descriptor = makeDescriptor({});
    vi.mocked(getMcpToolDescriptors).mockResolvedValue([descriptor]);
    const detail = '长'.repeat(100_000);
    vi.mocked(executeMcpToolCall).mockResolvedValue({ ok: true, summary: 'long', detail });

    const result = await executeRuntimeToolCall(makeCall(descriptor), trusted(), 'en');

    expect(result.detail).toBe(detail);
    expect(result.truncated).toBeUndefined();
  });
});

function makeDescriptor(execution: Partial<ToolDescriptor['execution']>): ToolDescriptor {
  return {
    id: 'mcp:timeout-server:slow_tool',
    provider: {
      kind: 'mcp',
      id: 'timeout-server',
      displayName: 'Timeout Server',
      transport: 'native_messaging',
    },
    name: 'slow_tool',
    invocationName: 'mcp_timeout_server_slow_tool',
    title: 'Slow tool',
    description: 'A tool that may hang.',
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low', ...execution },
  };
}

function makeCall(descriptor: ToolDescriptor): ToolCall {
  return {
    id: 'call-timeout',
    descriptorId: descriptor.id,
    provider: descriptor.provider,
    name: descriptor.name,
    invocationName: descriptor.invocationName,
    payload: {},
    raw: `<${descriptor.invocationName}>{}</${descriptor.invocationName}>`,
  };
}

function trusted() {
  return {
    kind: 'trusted' as const,
    trigger: 'test' as const,
    requestId: 'request-timeout',
    chatSessionId: null,
  };
}
