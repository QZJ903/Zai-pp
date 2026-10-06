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
    expect(GLM_CONTENT_RUNTIME_COMMANDS.size).toBe(23);
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

    expect([...produced].sort()).toEqual([...GLM_CONTENT_RUNTIME_COMMANDS].sort());
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

  // ⚠️ 内容脚本侧**每一处**入站监听都要过闸门 —— 只守一处等于没守：
  // 上游同一位置的注释写明「runtime.sendMessage reaches every extension context.
  // A content receiver must not answer a content-to-background RPC before the background
  // does」，即不过闸门的接收端会**抢在后台前面应答**（答的还可能是别的标签页的状态）。
  it('accepts the background sender path and rejects every other extension page', () => {
    // ⚠️⚠️ **这条是「闸门判据本身」的运行期覆盖，补的是上一版只有 AST 断言的洞**：
    // 闸门挂在 `zai.content.ts` 里、不能直接 import（加载即执行 `defineContentScript`），
    // 所以这里用**同一套判据**（`createExtensionRuntimeMessageContext` +
    // `BACKGROUND_RUNTIME_PATHNAMES`）跑三档真实 sender —— 闸门内部调的就是它。
    //
    // ⚠️ 它守的是闸门**误拒后台广播**这个最危险的失效形态：若后台发消息时 `sender.url`
    // 不是 `/background.js`，闸门会把 STATE_UPDATED / BACKGROUND_UPDATED /
    // TOOL_DESCRIPTORS_UPDATED / PROJECT_CONTEXT_UPDATED 全部静默拒掉
    // （表现：侧边栏改了记忆/技能/背景，页面不更新、要刷新才生效）。
    // ⚠️ **这条测的是「判据对这类 sender 的判定」**，不是「真机投递时 url 确实是这个值」——
    // 后者只有真机能验（见交接文档的待验证项）。
    const backgroundSender = {
      id: POLICY.runtimeId,
      url: 'chrome-extension://runtime-contract/background.js',
      origin: 'chrome-extension://runtime-contract',
      documentLifecycle: 'active',
    };
    expect(createExtensionRuntimeMessageContext(backgroundSender, {
      runtimeId: POLICY.runtimeId,
      extensionOrigin: POLICY.extensionOrigin,
      allowedPathnames: BACKGROUND_RUNTIME_PATHNAMES,
    }).surface).toBe('extension_context');

    // 扩展自己的**其它**页面（侧边栏）不是后台 ⇒ 必须拒。
    expect(() => createExtensionRuntimeMessageContext({
      ...backgroundSender,
      url: 'chrome-extension://runtime-contract/sidepanel.html',
    }, {
      runtimeId: POLICY.runtimeId,
      extensionOrigin: POLICY.extensionOrigin,
      allowedPathnames: BACKGROUND_RUNTIME_PATHNAMES,
    })).toThrow('path is not authorized');

    // 内容脚本自己（网页来源）也不是后台 ⇒ 必须拒。
    expect(() => createExtensionRuntimeMessageContext(GLM_SENDER, {
      runtimeId: POLICY.runtimeId,
      extensionOrigin: POLICY.extensionOrigin,
      allowedPathnames: BACKGROUND_RUNTIME_PATHNAMES,
    })).toThrow('not an extension context');
  });

  it('gates every content runtime receiver before its privileged branches', () => {
    const content = readFileSync('entrypoints/zai.content.ts', 'utf8');
    const program = parseTypeScriptSource('entrypoints/zai.content.ts', content);

    // ① 找出全部 chrome.runtime.onMessage.addListener(...) 调用
    const listeners: t.CallExpression[] = [];
    walkSourceAst(program, (node) => {
      if (!t.isCallExpression(node)) return;
      const callee = node.callee;
      if (
        t.isMemberExpression(callee)
        && t.isIdentifier(callee.property, { name: 'addListener' })
        && t.isMemberExpression(callee.object)
        && t.isIdentifier(callee.object.property, { name: 'onMessage' })
      ) {
        listeners.push(node);
      }
    });

    // 数量断言：多一处或少一处都说明有人新加了未守的接收端（或删掉了已守的）。
    expect(listeners).toHaveLength(2);

    // ② 每一处的回调体里都必须出现闸门调用
    for (const listener of listeners) {
      const [callback] = listener.arguments;
      expect(t.isArrowFunctionExpression(callback) || t.isFunctionExpression(callback)).toBe(true);
      const body = (callback as t.ArrowFunctionExpression | t.FunctionExpression).body;
      let gated = false;
      walkSourceAst(body, (node) => {
        if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: 'isAuthorizedInboundRuntimeMessage' })) {
          gated = true;
        }
      });
      const line = content.slice(0, listener.start ?? 0).split('\n').length;
      expect(gated, `listener at line ${line} does not pass the inbound runtime gate`).toBe(true);
    }

    // ③ 闸门本体：与后台侧同源，且**静默拒绝**
    const gate = findFunctionDeclaration(program, 'isAuthorizedInboundRuntimeMessage');
    expect(gate, 'missing isAuthorizedInboundRuntimeMessage').toBeDefined();
    const gateSource = content.slice(gate!.start ?? 0, gate!.end ?? 0);
    expect(gateSource).toContain('decodeRuntimeMessageEnvelope(message)');
    expect(gateSource).toContain('createExtensionRuntimeMessageContext(sender');
    expect(gateSource).toContain('allowedPathnames: BACKGROUND_RUNTIME_PATHNAMES');
    expect(gateSource).toContain('error instanceof RuntimeBoundaryError');
    // ⚠️ 反向断言：拒绝时**不能**回响应 —— 回一条错误响应同样算「应答」、照样赢下竞速。
    // ⚠️⚠️ **判据必须用函数体里才可能出现的写法**：`createRuntimeBoundaryErrorResponse`
    // 恰好只出现在这段 JSDoc 里，而 babel 的 `node.start` **不含前置注释** ⇒ 那条断言
    // 把正确性押在「解析器的注释归属」上（注释一挪进函数体它就假红）。
    // `sendResponse(` 是**只可能在函数体里**的调用形态，锚它才是稳的。
    expect(gateSource).not.toContain('sendResponse(');
  });

});

function findFunctionDeclaration(
  program: t.Program,
  name: string,
): t.FunctionDeclaration | undefined {
  let found: t.FunctionDeclaration | undefined;
  walkSourceAst(program, (node) => {
    if (t.isFunctionDeclaration(node) && node.id?.name === name) found = node;
  });
  return found;
}

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
