// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { McpProtocolError, unwrapMcpResponse } from '../core/mcp';
import { isToolCallHistoryRecord } from '../core/messaging/tool-record-codec';

const PROVIDER = { kind: 'mcp', id: 'shell-local', displayName: 'Shell Local', transport: 'native_messaging' };

/** Mirror `sanitizeResult` in core/tool/history.ts so the record shape matches production. */
function toHistoryRecord(errorDetails: Record<string, unknown>) {
  return {
    id: 'record-1',
    call: { name: 'shell_exec', payload: { command: 'x' }, raw: '<shell_exec>{}</shell_exec>' },
    result: {
      ok: false,
      summary: 'MCP 工具调用失败',
      detail: 'boom',
      name: 'shell_exec',
      provider: PROVIDER,
      descriptorId: 'mcp:shell-local:shell_exec',
      output: {},
      error: { code: 'mcp_tool_call_failed', message: 'boom', retryable: true, details: errorDetails },
    },
    source: 'manual_chat',
    createdAt: 1,
  };
}

function captureDetails(response: unknown): Record<string, unknown> {
  try {
    unwrapMcpResponse(response as never, 'mcp_tool_call_failed');
  } catch (error) {
    expect(error).toBeInstanceOf(McpProtocolError);
    return (error as McpProtocolError).details as Record<string, unknown>;
  }
  throw new Error('expected unwrapMcpResponse to throw');
}

describe('MCP error details stay a legal JSON object', () => {
  // A JSON-RPC error without `data` used to produce `details.data === undefined`.
  // `undefined` is not a JSON value, so the tool-history codec rejected the whole
  // record and the user saw "execution history could not be persisted" instead of
  // the real provider error.
  it('omits the data key entirely when the server sent none', () => {
    const details = captureDetails({
      jsonrpc: '2.0',
      id: 'r1',
      error: { code: -32603, message: 'Native response is too large.' },
    });

    expect('data' in details).toBe(false);
    expect(Object.values(details).every((value) => value !== undefined)).toBe(true);
    expect(isToolCallHistoryRecord(toHistoryRecord(details))).toBe(true);
  });

  it('keeps the data payload when the server did send one', () => {
    const details = captureDetails({
      jsonrpc: '2.0',
      id: 'r2',
      error: { code: -32602, message: 'Unknown tool: future_tool', data: { tool: 'future_tool' } },
    });

    expect(details.data).toEqual({ tool: 'future_tool' });
    expect(isToolCallHistoryRecord(toHistoryRecord(details))).toBe(true);
  });

  it('still records a plain protocol error without a JSON-RPC data field', () => {
    // The `!('result' in response)` branch never carried `data`; keep it that way.
    const details = captureDetails({ jsonrpc: '2.0', id: 'r3' } as never);

    expect('data' in details).toBe(false);
    expect(isToolCallHistoryRecord(toHistoryRecord(details))).toBe(true);
  });
});