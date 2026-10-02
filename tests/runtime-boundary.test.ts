import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import {
  authorizeRuntimeMessage,
  BACKGROUND_RUNTIME_PATHNAMES,
  createExtensionRuntimeMessageContext,
  createRuntimeBoundaryErrorResponse,
  createRuntimeMessageContext,
  decodeRuntimeMessageEnvelope,
  GLM_CONTENT_RUNTIME_COMMANDS,
  refreshGLMContentRuntimeContext,
  RUNTIME_BOUNDARY_ERROR_CODES,
  type RuntimeMessageSenderLike,
} from '../core/messaging/runtime-boundary';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

const POLICY = {
  runtimeId: 'runtime-contract',
  extensionOrigin: 'chrome-extension://runtime-contract/',
  glmOrigin: 'https://chat.z.ai',
} as const;

const EXTENSION_SENDER: RuntimeMessageSenderLike = {
  id: POLICY.runtimeId,
  url: 'chrome-extension://runtime-contract/sidepanel.html',
  origin: 'chrome-extension://runtime-contract',
  documentId: 'extension-document-1',
  documentLifecycle: 'active',
};

const GLM_SENDER: RuntimeMessageSenderLike = {
  id: POLICY.runtimeId,
  url: 'https://chat.z.ai/c/session-contract',
  origin: 'https://chat.z.ai',
  frameId: 0,
  documentId: 'zai-document-1',
  documentLifecycle: 'active',
  tab: {
    id: 17,
    url: 'https://chat.z.ai/c/session-contract',
  },
};

describe('runtime sender and envelope boundary', () => {
  it('preserves a legal extension sender and browser-owned document context', () => {
    expect(createRuntimeMessageContext(EXTENSION_SENDER, POLICY)).toEqual({
      runtimeId: POLICY.runtimeId,
      surface: 'extension_context',
      senderUrl: 'chrome-extension://runtime-contract/sidepanel.html',
      senderOrigin: 'chrome-extension://runtime-contract',
      tabId: undefined,
      tabUrl: undefined,
      frameId: undefined,
      documentId: 'extension-document-1',
      documentLifecycle: 'active',
      documentSessionId: 'extension-document-1',
    });
    expect(createExtensionRuntimeMessageContext(EXTENSION_SENDER, POLICY).surface)
      .toBe('extension_context');
    expect(() => createExtensionRuntimeMessageContext(GLM_SENDER, POLICY))
      .toThrow('not an extension context');
    expect(() => createExtensionRuntimeMessageContext(EXTENSION_SENDER, {
      ...POLICY,
      allowedPathnames: BACKGROUND_RUNTIME_PATHNAMES,
    })).toThrow('path is not authorized');
    expect(createExtensionRuntimeMessageContext({
      ...EXTENSION_SENDER,
      url: 'moz-extension://runtime-contract/_generated_background_page.html',
      origin: 'moz-extension://runtime-contract',
    }, {
      runtimeId: POLICY.runtimeId,
      extensionOrigin: 'moz-extension://runtime-contract/',
      allowedPathnames: BACKGROUND_RUNTIME_PATHNAMES,
    }).senderUrl).toBe('moz-extension://runtime-contract/_generated_background_page.html');
  });

  it('preserves a legal GLM top-frame sender and derives its route session', () => {
    expect(createRuntimeMessageContext(GLM_SENDER, POLICY)).toEqual({
      runtimeId: POLICY.runtimeId,
      surface: 'glm_content',
      senderUrl: 'https://chat.z.ai/c/session-contract',
      senderOrigin: 'https://chat.z.ai',
      tabId: 17,
      tabUrl: 'https://chat.z.ai/c/session-contract',
      frameId: 0,
      documentId: 'zai-document-1',
      documentLifecycle: 'active',
      documentSessionId: 'zai-document-1',
      chatSessionId: 'session-contract',
    });
  });

  it('uses the browser-owned current tab route across a same-origin GLM SPA navigation', () => {
    const context = createRuntimeMessageContext({
      ...GLM_SENDER,
      url: 'https://chat.z.ai/',
      tab: {
        id: 17,
        url: 'https://chat.z.ai/c/new-session',
      },
    }, POLICY);

    expect(context).toMatchObject({
      surface: 'glm_content',
      senderUrl: 'https://chat.z.ai/',
      tabUrl: 'https://chat.z.ai/c/new-session',
      documentSessionId: 'zai-document-1',
      chatSessionId: 'new-session',
    });
  });

  it('refreshes a stale sender tab snapshot from the current browser tab before grant binding', () => {
    const staleContext = createRuntimeMessageContext({
      ...GLM_SENDER,
      url: 'https://chat.z.ai/',
      tab: {
        id: 17,
        url: 'https://chat.z.ai/',
      },
    }, POLICY);

    const context = refreshGLMContentRuntimeContext(staleContext, {
      id: 17,
      url: 'https://chat.z.ai/c/live-session',
    }, POLICY);

    expect(context).toMatchObject({
      senderUrl: 'https://chat.z.ai/',
      documentSessionId: 'zai-document-1',
      tabUrl: 'https://chat.z.ai/c/live-session',
      chatSessionId: 'live-session',
    });
  });

  it.each([
    ['another tab', { id: 18, url: 'https://chat.z.ai/c/live-session' }],
    ['another origin', { id: 17, url: 'https://example.test/c/live-session' }],
    ['missing URL', { id: 17 }],
  ])('rejects a refreshed browser tab from %s', (_name, tab) => {
    const context = createRuntimeMessageContext(GLM_SENDER, POLICY);
    expect(() => refreshGLMContentRuntimeContext(context, tab, POLICY)).toThrow();
  });

  it('accepts a missing frameId only with matching top-level tab evidence', () => {
    const context = createRuntimeMessageContext({ ...GLM_SENDER, frameId: undefined }, POLICY);
    expect(context.frameId).toBe(0);
    expect(() => createRuntimeMessageContext({
      ...GLM_SENDER,
      frameId: undefined,
      tab: { id: 17 },
    }, POLICY)).toThrow('no top-level frame evidence');
  });

  it.each([
    ['other extension id', { ...EXTENSION_SENDER, id: 'other-extension' }],
    ['native application', { ...EXTENSION_SENDER, nativeApplication: 'native-host' }],
    ['inactive document', { ...EXTENSION_SENDER, documentLifecycle: 'cached' }],
    ['origin mismatch', { ...EXTENSION_SENDER, origin: 'chrome-extension://other-extension' }],
    ['invalid document id', { ...EXTENSION_SENDER, documentId: '' }],
    ['invalid extension tab id', { ...EXTENSION_SENDER, tab: { id: -1 } }],
    ['web origin', { ...EXTENSION_SENDER, url: 'https://example.test/sidepanel.html', origin: 'https://example.test' }],
    ['GLM child frame', { ...GLM_SENDER, frameId: 2 }],
    ['GLM non-GLM tab', { ...GLM_SENDER, tab: { id: 17, url: 'https://example.test/a/chat/s/other' } }],
  ] as const)('rejects unauthorized sender context: %s', (_name, sender) => {
    expect(() => createRuntimeMessageContext(sender, POLICY)).toThrow();
  });

  it.each([
    null,
    [],
    'GET_MEMORIES',
    {},
    { type: '' },
    { type: 7 },
  ])('rejects malformed runtime envelope: %j', (message) => {
    expect(() => decodeRuntimeMessageEnvelope(message)).toThrow(
      'Runtime message must be a plain object with a non-empty type.',
    );
  });

  it('authorizes only the frozen content command surface before routing', () => {
    const extensionContext = createRuntimeMessageContext(EXTENSION_SENDER, POLICY);
    const contentContext = createRuntimeMessageContext(GLM_SENDER, POLICY);
    expect(GLM_CONTENT_RUNTIME_COMMANDS.size).toBe(25);
    expect(() => authorizeRuntimeMessage({ type: 'GET_MEMORIES' }, contentContext)).not.toThrow();
    expect(() => authorizeRuntimeMessage({ type: 'GET_SYNC_CONFIG' }, contentContext))
      .toThrow('not authorized for GLM content');
    expect(() => authorizeRuntimeMessage({ type: 'GET_SYNC_CONFIG' }, extensionContext)).not.toThrow();
  });

  it('matches the exact command literals emitted by GLM content producers', () => {
    const producerFiles = [
      'entrypoints/zai.content.ts',
    ];
    const produced = new Set(producerFiles.flatMap(extractContentRuntimeCommands));
    // DOM_TASK_NEEDS_ACTION / DOM_TASK_PROGRESS are part of the authorized content
    // surface (registered in the contracts and handled in
    // entrypoints/background/dom-task-handlers.ts) but no content producer emits them
    // yet. Keep them listed explicitly so the exact-match invariant below stays honest.
    const reservedDomTaskEvents = new Set(['DOM_TASK_NEEDS_ACTION', 'DOM_TASK_PROGRESS']);

    expect([...produced].sort()).toEqual(
      [...GLM_CONTENT_RUNTIME_COMMANDS]
        .filter((type) => !reservedDomTaskEvents.has(type))
        .sort(),
    );
    for (const type of reservedDomTaskEvents) {
      expect(GLM_CONTENT_RUNTIME_COMMANDS.has(type)).toBe(true);
    }
  });

  it('returns a non-retryable ToolResult-shaped boundary rejection for execution commands', () => {
    const context = createRuntimeMessageContext(GLM_SENDER, POLICY);
    let error: unknown;
    try {
      authorizeRuntimeMessage({ type: 'GET_SYNC_CONFIG' }, context);
    } catch (caught) {
      error = caught;
    }
    expect(createRuntimeBoundaryErrorResponse(error, { type: 'EXECUTE_TOOL_CALL' })).toEqual({
      ok: false,
      summary: 'Runtime request rejected',
      detail: 'Runtime command GET_SYNC_CONFIG is not authorized for GLM content.',
      error: {
        code: RUNTIME_BOUNDARY_ERROR_CODES.unauthorizedSender,
        message: 'Runtime command GET_SYNC_CONFIG is not authorized for GLM content.',
        retryable: false,
      },
    });
  });

  it('gates background dispatch before its privileged handlers', () => {
    const background = readFileSync('entrypoints/background.ts', 'utf8');

    expectInOrder(background, [
      'decodeRuntimeMessageEnvelope(message)',
      'createRuntimeMessageContext(sender',
      'authorizeRuntimeMessage(envelope, context)',
      'handleMessage(envelope, currentContext)',
    ]);
  });

});

function expectInOrder(source: string, fragments: Array<string | RegExp>): void {
  let previous = -1;
  for (const fragment of fragments) {
    const index = typeof fragment === 'string'
      ? source.indexOf(fragment)
      : source.search(fragment);
    expect(index, `missing ${String(fragment)}`).toBeGreaterThan(previous);
    previous = index;
  }
}

function extractContentRuntimeCommands(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const program = parseTypeScriptSource(path, source);
  const commands: string[] = [];

  walkSourceAst(program, (node) => {
    if (t.isCallExpression(node) && isContentRuntimeSend(node.callee)) {
      const [message] = node.arguments;
      if (t.isObjectExpression(message)) {
        for (const property of message.properties) {
          if (
            t.isObjectProperty(property)
            && !property.computed
            && t.isIdentifier(property.key, { name: 'type' })
            && t.isStringLiteral(property.value)
          ) {
            commands.push(property.value.value);
          }
        }
      }
    }
  });
  return commands;
}

function isContentRuntimeSend(expression: t.CallExpression['callee']): boolean {
  if (t.isIdentifier(expression)) {
    return expression.name === 'sendRuntimeMessage' ||
      expression.name === 'sendRuntimeMessageStrict' ||
      expression.name === 'sendMessage';
  }
  return t.isMemberExpression(expression)
    && !expression.computed
    && t.isIdentifier(expression.property, { name: 'sendMessage' })
    && t.isMemberExpression(expression.object)
    && !expression.object.computed
    && t.isIdentifier(expression.object.property, { name: 'runtime' })
    && t.isIdentifier(expression.object.object, { name: 'chrome' });
}
