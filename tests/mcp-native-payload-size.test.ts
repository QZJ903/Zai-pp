// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createMcpNativeMessagingTransport } from '../core/mcp';
import type { McpServerConfig } from '../core/mcp';

const SHELL_NATIVE_HOST = 'com.zai_pp.shell';
// Chrome caps a single native message at 1 MiB; the transport refuses anything past it.
const MAX_NATIVE_MESSAGE_BYTES = 1 * 1024 * 1024;
const MAX_LOCAL_FILE_WRITE_BYTES = 900_000;

function shellServer(): McpServerConfig {
  return {
    version: 1,
    id: 'shell-local',
    displayName: 'Shell Local',
    enabled: true,
    transport: { kind: 'native_messaging', nativeHost: SHELL_NATIVE_HOST },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 5_000, requestMs: 120_000, discoveryMs: 10_000 },
    limits: { maxResultBytes: 128_000, maxToolCount: 12 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'ready',
    lastConnectedAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as McpServerConfig;
}

function localFileWrite(content: string) {
  return {
    jsonrpc: '2.0' as const,
    id: 'write-1',
    method: 'tools/call',
    params: { name: 'local_file_write', arguments: { path: '/tmp/out.txt', content } },
  };
}

function frameBytes(content: string): number {
  const envelope = {
    protocol: 'zai-pp-mcp-native',
    version: 1,
    server: { id: 'shell-local', command: undefined, args: undefined, cwd: undefined, env: undefined },
    message: localFileWrite(content),
  };
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8');
}

describe('Native payload size guard', () => {
  // The content cap alone is not enough: JSON escaping inflates the payload, so a
  // body that passes the 900 KB content check can still overflow the 1 MiB frame.
  // Emitting it makes the host exit, which drops every open shell session.
  it('rejects a local_file_write whose escaping pushes the envelope past the frame cap', async () => {
    // ~900 KB of JSON-ish text: each `"` becomes `\"`, so the frame lands ~1.15 MB.
    const content = '{"key":"value","n":123},\n'
      .repeat(Math.ceil(MAX_LOCAL_FILE_WRITE_BYTES / 27))
      .slice(0, MAX_LOCAL_FILE_WRITE_BYTES);

    // Sanity: the content itself is legal, only the escaped envelope is not.
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(MAX_LOCAL_FILE_WRITE_BYTES);
    expect(frameBytes(content)).toBeGreaterThan(MAX_NATIVE_MESSAGE_BYTES);

    const transport = createMcpNativeMessagingTransport(shellServer());
    const pending = transport.request(localFileWrite(content));

    await expect(pending).rejects.toMatchObject({ code: 'mcp_native_payload_too_large' });
    await expect(pending).rejects.toThrow(/after escaping/);
    // The rejection must tell the caller how to proceed, not just that it failed.
    await expect(pending).rejects.toThrow(/append=true/);
  });

  it('rejects content past the content cap even when the envelope would fit', async () => {
    const content = '"'.repeat(MAX_LOCAL_FILE_WRITE_BYTES + 1);
    const transport = createMcpNativeMessagingTransport(shellServer());

    await expect(transport.request(localFileWrite(content)))
      .rejects.toThrow(/local_file_write content is too large/);
  });

  it('lets a large but safely-escaped write through to the transport', async () => {
    // 900 KB of plain text escapes 1:1, so the frame stays under the cap.
    const content = 'A'.repeat(MAX_LOCAL_FILE_WRITE_BYTES);
    expect(frameBytes(content)).toBeLessThan(MAX_NATIVE_MESSAGE_BYTES);

    const posted: unknown[] = [];
    let releaseDisconnect: (() => void) | undefined;
    vi.stubGlobal('chrome', {
      runtime: {
        connectNative: vi.fn(() => ({
          postMessage: vi.fn((value: unknown) => posted.push(value)),
          onMessage: { addListener: vi.fn() },
          onDisconnect: { addListener: vi.fn((listener: () => void) => { releaseDisconnect = listener; }) },
        })),
        lastError: undefined,
      },
    });

    try {
      const transport = createMcpNativeMessagingTransport(shellServer());
      // It gets past the size guard and posts; the reply never arrives, so let the
      // pending request reject once we tear the stub down.
      const pending = transport.request(localFileWrite(content)).catch(() => undefined);
      await vi.waitFor(() => expect(posted).toHaveLength(1));

      releaseDisconnect?.();
      await pending;
    } finally {
      vi.unstubAllGlobals();
    }
  });
});