import { Buffer } from 'node:buffer';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeMcpToolDescriptor, type McpServerConfig, type McpToolDefinition } from '../core/mcp';
import { buildPromptAugmentation } from '../core/prompt';
import {
  createMemoryToolDescriptors,
  createToolInvocationCatalog,
  getToolCloseTag,
  getToolOpenTag,
} from '../core/tool';
import {
  appendExternalizedToolPayloadChunk,
  takeExternalizedToolPayloadText,
} from '../core/tool/externalized-payload';
import { findFirstXmlToolTag, getPartialXmlToolTagTailLength } from '../core/tool/xml-tags';
import type { Memory, ToolDescriptor } from '../core/types';

const CONTRACT_DATE = Date.UTC(2026, 6, 13);

describe('prompt output compatibility contract', () => {
  it('freezes the exact Chinese chat prompt without tools', () => {
    const result = buildPromptAugmentation('请总结兼容性计划。', {
      memories: [],
      thinkingEnabled: false,
      presetContent: null,
      toolDescriptors: [],
      locale: 'zh-CN',
      forceResponseLanguage: 'zh-CN',
    });

    expectUtf8Golden('prompt/zh-chat-no-tools.txt', [
      result.augmented,
      `usedMemoryIds=${JSON.stringify(result.usedMemoryIds)}`,
      `renderedToolCount=${result.renderedToolCount}`,
    ].join('\n'));
  });
});

describe('tool XML compatibility contract', () => {
  it('freezes rendered names and complete or partial XML tag matches', () => {
    const descriptors = createRepresentativeToolDescriptors();
    const catalog = createToolInvocationCatalog(descriptors);
    const names = new Set(catalog.invocationNames);
    const text = [
      'before',
      '< mcp_browser_tools_capture_page >',
      '{"url":"https://example.test"}',
      '< / mcp_browser_tools_capture_page >',
      'after',
    ].join('\n');

    expectUtf8Golden('tools/catalog-and-tags.json', JSON.stringify({
      invocationNames: catalog.invocationNames,
      tags: catalog.invocationNames.map((name) => [getToolOpenTag(name), getToolCloseTag(name)]),
      opening: findFirstXmlToolTag(text, names, { closing: false }),
      closing: findFirstXmlToolTag(text, names, { closing: true }),
      partialOpeningTail: getPartialXmlToolTagTailLength('prefix < mcp_shell_local_shell', names, { closing: false }),
      partialClosingTail: getPartialXmlToolTagTailLength('prefix < / mcp_shell_local_shell', names, { closing: true }),
      partialOpeningEightSpaces: getPartialXmlToolTagTailLength(`<${' '.repeat(8)}mcp_shell_local_shell`, names, { closing: false }),
      partialOpeningNineSpaces: getPartialXmlToolTagTailLength(`<${' '.repeat(9)}mcp_shell_local_shell`, names, { closing: false }),
      completeOpeningNineSpaces: findFirstXmlToolTag(`<${' '.repeat(9)}shell_exec>`, names, { closing: false }),
    }, null, 2));
  });

  it('freezes one-shot deletion after an externalized payload name mismatch', () => {
    appendExternalizedToolPayloadChunk(
      'contract-mismatched-take',
      'capture_page',
      '{"url":"https://example.test/contracts"}',
    );

    expect(takeExternalizedToolPayloadText('contract-mismatched-take', 'shell_exec')).toBeNull();
    expect(takeExternalizedToolPayloadText('contract-mismatched-take', 'capture_page')).toBeNull();
  });
});

function expectUtf8Golden(relativePath: string, value: string): void {
  const goldenPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'prompt-output',
    relativePath,
  );
  expect(value).not.toContain('\r');
  expect(value).not.toContain('\uFEFF');
  expect(Buffer.from(value, 'utf8').toString('utf8')).toBe(value);

  if (process.env.ZAI_PP_UPDATE_PROMPT_GOLDENS === '1') {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, value, 'utf8');
  }

  expect(existsSync(goldenPath), `Missing prompt golden: ${relativePath}`).toBe(true);
  const expectedBytes = readFileSync(goldenPath);
  assertCanonicalGoldenBytes(expectedBytes);
  expect(value).toBe(expectedBytes.toString('utf8'));
  expect(Buffer.from(value, 'utf8').equals(expectedBytes)).toBe(true);
}

function assertCanonicalGoldenBytes(value: Buffer): void {
  expect(value.includes(0x0d)).toBe(false);
  expect(value.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
}

function createRepresentativeToolDescriptors(): ToolDescriptor[] {
  const memorySave = createMemoryToolDescriptors('en')[0];
  const browserServer = mcpServer('browser-tools', 'Browser Tools', 'streamable_http');
  const shellServer = mcpServer('shell-local', 'Shell Local', 'native_messaging');

  return [
    memorySave,
    normalizeMcpToolDescriptor(browserServer, {
      name: 'capture_page',
      title: 'Capture page',
      description: 'Capture a browser page for compatibility evidence.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Page URL' },
          fullPage: { type: 'boolean', description: 'Capture the full page' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      annotations: { risk: 'low' },
    }),
    normalizeMcpToolDescriptor(shellServer, shellToolDefinition()),
  ];
}

function shellToolDefinition(): McpToolDefinition {
  return {
    name: 'shell_exec',
    title: 'Execute command',
    description: 'Execute a local shell command and return stdout, stderr, and the exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command' },
        cwd: { type: 'string', description: 'Working directory file path' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: { risk: 'high' },
  };
}

function mcpServer(
  id: string,
  displayName: string,
  transportKind: 'streamable_http' | 'native_messaging',
): McpServerConfig {
  return {
    version: 1,
    id,
    displayName,
    enabled: true,
    transport: transportKind === 'native_messaging'
      ? { kind: transportKind, nativeHost: 'com.zai_pp.shell' }
      : { kind: transportKind, url: 'https://example.test/mcp' },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 5_000, requestMs: 60_000, discoveryMs: 10_000 },
    limits: { maxResultBytes: 128_000, maxToolCount: 16 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'ready',
    lastConnectedAt: CONTRACT_DATE,
    lastError: null,
    createdAt: CONTRACT_DATE,
    updatedAt: CONTRACT_DATE,
  };
}

function memory(
  id: number,
  name: string,
  content: string,
  pinned = false,
): Memory {
  return {
    id,
    syncId: `memory-${id}`,
    type: 'reference',
    name,
    content,
    description: '',
    tags: ['compatibility'],
    pinned,
    createdAt: CONTRACT_DATE,
    updatedAt: CONTRACT_DATE,
    accessCount: id,
    lastAccessedAt: CONTRACT_DATE,
  };
}
