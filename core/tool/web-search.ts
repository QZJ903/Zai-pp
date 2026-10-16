import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import { createAbortScope } from '../network/abort';
import type {
  JsonValue,
  ToolCall,
  ToolDescriptor,
  ToolProviderIdentity,
  ToolResult,
} from './types';

export const WEB_SEARCH_TOOL_PROVIDER: ToolProviderIdentity = {
  kind: 'local',
  id: 'web',
  displayName: translate(DEFAULT_LOCALE, 'tool.web.providerName'),
  transport: 'in_process',
};

export const WEB_SEARCH_TOOL_NAMES = ['web_search', 'web_fetch'] as const;

export type WebSearchToolName = typeof WEB_SEARCH_TOOL_NAMES[number];

export function createWebSearchToolProviderIdentity(
  locale: SupportedLocale = DEFAULT_LOCALE,
): ToolProviderIdentity {
  return {
    ...WEB_SEARCH_TOOL_PROVIDER,
    displayName: translate(locale, 'tool.web.providerName'),
  };
}

export function createWebSearchToolDescriptors(
  locale: SupportedLocale = DEFAULT_LOCALE,
): ToolDescriptor[] {
  const provider = createWebSearchToolProviderIdentity(locale);
  return [{
    id: 'local:web:web_search',
    provider,
    name: 'web_search',
    invocationName: 'web_search',
    title: translate(locale, 'tool.web.searchTitle'),
    description: translate(locale, 'tool.web.searchDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: translate(locale, 'tool.web.queryDescription') },
        topK: { type: 'integer', description: translate(locale, 'tool.web.topKDescription') },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'low',
    },
  },
  {
    id: 'local:web:web_fetch',
    provider,
    name: 'web_fetch',
    invocationName: 'web_fetch',
    title: translate(locale, 'tool.web.fetchTitle'),
    description: translate(locale, 'tool.web.fetchDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: translate(locale, 'tool.web.urlDescription') },
      },
      required: ['url'],
      additionalProperties: false,
    },
    execution: {
      // web_fetch's consent mechanism is the host-permission banner (one-click
      // grant + retry); the scheme whitelist in performWebFetch bounds what it
      // can reach.
      mode: 'auto',
      enabled: true,
      risk: 'medium',
    },
  },
  ];
}

export const WEB_SEARCH_TOOL_DESCRIPTORS: ToolDescriptor[] = createWebSearchToolDescriptors(DEFAULT_LOCALE);

export function isWebSearchToolName(name: string): name is WebSearchToolName {
  return (WEB_SEARCH_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * 是不是**扩展自带的** web 工具（`web_search` / `web_fetch`）。
 *
 * ⚠️⚠️ **判据是「名字 **且** provider 契约」，不能只看名字。** 围绕 web 工具的每一条策略
 * （agent 模式恒裁、联网开关关着就不进模型目录、要不要注入联网引导）**都只对扩展自带的
 * 联网成立**；第三方 MCP 服务完全可以把工具命名为 `web_search`，那与我们的联网策略无关 ——
 * 只按名字判会让**用户的工具凭空消失**（失败方向静默），或让扩展专属的引导被误注入。
 *
 * ⚠️ 这是**判据的唯一实现**：判断「某个 descriptor 属不属于扩展自带联网」的地方**都调它**，
 * 别各自写一遍（两份判据分叉时没有任何报错）。
 * ⚠️ 判「属于哪一类」时 `name` 不保证唯一，要连 provider 一起看；要**按 id 定位**时用
 * `descriptorId`。判据的完整理由见 `core/zai/model-facing.ts`。
 */
export function isExtensionWebToolDescriptor(descriptor: ToolDescriptor): boolean {
  if (!isWebSearchToolName(descriptor.name)) return false;
  return descriptor.provider?.kind === WEB_SEARCH_TOOL_PROVIDER.kind
    && descriptor.provider?.id === WEB_SEARCH_TOOL_PROVIDER.id;
}

/**
 * 扩展 web 工具单次响应体的**字节上限**（内存保护）。
 *
 * `web_search` 与 `web_fetch` 共用这一个值：两者都是「取回一份文档再解析」，
 * 而实测 Bing 搜索页约 96 KB、普通网页的 HTML 文档多在数百 KB 量级 ——
 * 2 MiB 相对正常流量有 10~40 倍余量。这一层拦的是**异常大的响应**，
 * 不是正常流量；正常页面永远不会碰到它。
 *
 * 为什么需要它：`await response.text()` 会把**整个**响应先读进内存，
 * 之后那句 `slice(0, 50_000)` 只是截断**结果**，拦不住读取阶段的内存占用。
 * 这里改成边读边判上限，超过就停止读取并取消 body。
 */
export const WEB_TOOL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface WebResponseBodyRead {
  text: string;
  /** 是否因为超过 `WEB_TOOL_MAX_RESPONSE_BYTES` 而**提前停止读取**（不是读完了才截断）。 */
  byteLimited: boolean;
}

/**
 * 按字节上限流式读取响应体。
 *
 * ⚠️ **这个实现刻意留在本文件内**，没有复用 `core/mcp/transports/common.ts` 的
 * `readResponseTextWithLimit` —— 那一份与上游逐字相同，把它的语义改成共用会把
 * 「移植件」的边界再开一个口子（同 `core/sandbox/` 的取舍）。两者需求也不同：
 * MCP 那份要「超限即报错」（协议响应完整性），这里要「超限即截断后继续解析」。
 *
 * 中文/emoji 等多字节字符可能跨块，所以解码走 `{ stream: true }` 并在末尾 flush
 * —— 在截断点切到半个字符时，flush 会产出替换字符，属预期。
 */
async function readWebResponseBody(
  response: Response,
  maxBytes: number = WEB_TOOL_MAX_RESPONSE_BYTES,
): Promise<WebResponseBodyRead> {
  // 没有可流式读取的 body 时（测试替身、特殊响应）退回一次性读取并跳过上限判定
  // —— 没有 body 就没有「边读边判」的落点，这与改动前的行为一致。
  if (!response.body) {
    return { text: await response.text(), byteLimited: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const decoded: string[] = [];
  let totalBytes = 0;
  let byteLimited = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      // 先判上限、再决定要不要这段：宁可少读一块，也不让单块把缓冲顶穿上限。
      if (totalBytes + value.byteLength > maxBytes) {
        byteLimited = true;
        break;
      }
      totalBytes += value.byteLength;
      decoded.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    // 提前 break 时必须取消上游 body，否则这条连接会挂着等 GC
    // —— `abortScope.cleanup()` 只清超时定时器，**不**中止请求。
    // 取消失败是良性的（我们已经有要的文本了），故不打印噪音。
    if (byteLimited) {
      await reader.cancel().catch(() => undefined);
    }
  }

  decoded.push(decoder.decode());
  return { text: decoded.join(''), byteLimited };
}

export async function executeWebSearchToolCall(
  call: ToolCall,
  locale: SupportedLocale = DEFAULT_LOCALE,
  options?: { signal?: AbortSignal },
): Promise<ToolResult> {
  switch (call.name) {
    case 'web_search':
      return performWebSearch(call, locale, options?.signal);
    case 'web_fetch':
      return performWebFetch(call, locale, options?.signal);
    default:
      return {
        ok: false,
        name: call.name,
        provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
        summary: translate(locale, 'tool.web.unsupported'),
        error: {
          code: 'web_tool_unsupported',
          message: `Unsupported web tool: ${call.name}`,
          retryable: false,
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Web Search via Bing without requiring an API key.
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function performWebSearch(
  call: ToolCall,
  locale: SupportedLocale,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const query = typeof call.payload.query === 'string' ? call.payload.query.trim() : '';
  if (!query) {
    return {
      ok: false,
      name: call.name,
      provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
      summary: translate(locale, 'tool.web.emptyQuery'),
      error: { code: 'empty_query', message: 'query is required', retryable: false },
    };
  }

  const topK = typeof call.payload.topK === 'number'
    ? Math.min(Math.max(1, Math.floor(call.payload.topK)), 10)
    : 5;

  // Try multiple Bing domains as fallback.
  // Each domain times out in 8s; total stays under 20s.
  const domains = ['cn.bing.com', 'www.bing.com'];
  let lastError: string | null = null;
  const startTime = Date.now();

  for (let i = 0; i < domains.length; i++) {
    throwIfWebToolAborted(signal);
    // Guard: if we've been searching for >18s, give up
    if (Date.now() - startTime > 18_000) {
      lastError = lastError || 'Search timed out (>18s)';
      break;
    }
    try {
      const results = await bingSearch(domains[i], query, topK, locale, signal);
      if (results.length === 0) {
        lastError = `${domains[i]} returned no parseable search results`;
        continue;
      }
      return {
        ok: true,
        name: call.name,
        provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
        summary: translate(locale, 'tool.web.searchComplete', { count: results.length }),
        output: results as unknown as JsonValue,
        detail: results
          .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`)
          .join('\n'),
      };
    } catch (error) {
      throwIfWebToolAborted(signal);
      lastError = error instanceof Error ? error.message : String(error);
      // On permission error don't retry — user needs to reload the extension
      if (lastError.includes('opaque') || lastError.includes('status 0')) break;
      // On other errors try the next domain
    }
  }

  const isPermissionError =
    lastError?.includes('Failed to fetch') ||
    lastError?.includes('NetworkError') ||
    lastError?.includes('opaque') ||
    lastError?.includes('status 0');
  const hasNoParseableResults = lastError?.includes('no parseable search results') === true;

  return {
    ok: false,
    name: call.name,
    provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
    summary: hasNoParseableResults
      ? translate(locale, 'tool.web.searchNoResults')
      : translate(locale, 'tool.web.searchFailed'),
    detail: isPermissionError
      ? translate(locale, 'tool.web.permissionDenied')
      : hasNoParseableResults
        ? translate(locale, 'tool.web.noParseableResults', { error: lastError ?? 'unknown error' })
        : translate(locale, 'tool.web.searchFailedDetail', { error: lastError ?? 'unknown error' }),
    error: {
      code: isPermissionError
        ? 'search_permission_denied'
        : hasNoParseableResults
          ? 'search_no_results'
          : 'search_failed',
      message: lastError ?? 'unknown error',
      retryable: !isPermissionError,
    },
  };
}

async function bingSearch(
  domain: string,
  query: string,
  topK: number,
  locale: SupportedLocale,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  let url: URL;
  try {
    url = new URL(`https://${domain}/search`);
    url.searchParams.set('q', query);
  } catch {
    throw new Error(`Invalid search domain: ${domain}`);
  }

  const abortScope = createAbortScope(signal, 8_000);
  try {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': locale === 'en' ? 'en-US,en;q=0.9,zh-CN;q=0.6' : 'zh-CN,zh;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: abortScope.signal,
    });

    if (!response.ok) {
      if (response.status === 0) {
        throw new Error(`Host permission denied (opaque response) for ${domain}`);
      }
      throw new Error(`${domain} returned status ${response.status}`);
    }

    let html: string;
    let byteLimited: boolean;
    try {
      ({ text: html, byteLimited } = await readWebResponseBody(response));
    } catch {
      throwIfWebToolAborted(signal);
      throw new Error(`${domain} response body unreadable`);
    }
    // 搜索页按上限截断就是不可信的输入：实测正常 Bing SERP 约 96 KB，
    // 真顶到 2 MiB 的只可能是插页/错误页。宁可报错换域重试，也不拿半截 HTML 解析出
    // 「看起来有结果、其实被切掉一半」的假结果。
    if (byteLimited) {
      throw new Error(`${domain} response exceeded ${WEB_TOOL_MAX_RESPONSE_BYTES} bytes`);
    }
    if (html.length < 200) {
      throw new Error(`${domain} returned an empty or blocked response (${html.length} bytes)`);
    }
    return parseBingResults(html, topK);
  } finally {
    abortScope.cleanup();
  }
}

function parseBingResults(html: string, topK: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Bing search results structure:
  // <li class="b_algo">
  //   <h2><a href="URL">Title</a></h2>
  //   <div class="b_caption"><p>Snippet...</p></div>
  // </li>
  const algoRegex = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;

  let match: RegExpExecArray | null;
  while ((match = algoRegex.exec(html)) !== null && results.length < topK) {
    const block = match[1];

    // Extract title link: <h2><a href="URL">Title</a></h2>
    const titleLink = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i.exec(block);
    if (!titleLink) continue;

    let url = titleLink[1];
    const title = stripHtml(titleLink[2]).replace(/\s+/g, ' ').trim();

    // Extract snippet from b_caption
    const captionBlock = /<div[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    let snippet = '';
    if (captionBlock) {
      // Try <p> inside caption first, otherwise full caption text
      const paraText = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(captionBlock[1]);
      snippet = paraText
        ? stripHtml(paraText[1]).replace(/\s+/g, ' ').trim()
        : stripHtml(captionBlock[1]).replace(/\s+/g, ' ').trim();
    }

    // Bing results sometimes have protocol-relative URLs
    if (url.startsWith('//')) url = 'https:' + url;

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Web Fetch: download a URL and extract visible text
// ---------------------------------------------------------------------------

async function performWebFetch(
  call: ToolCall,
  locale: SupportedLocale,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const url = typeof call.payload.url === 'string' ? call.payload.url.trim() : '';
  if (!url) {
    return {
      ok: false,
      name: call.name,
      provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
      summary: translate(locale, 'tool.web.emptyUrl'),
      error: { code: 'empty_url', message: 'url is required', retryable: false },
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      ok: false,
      name: call.name,
      provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
      summary: translate(locale, 'tool.web.invalidUrl'),
      detail: translate(locale, 'tool.web.invalidUrlDetail', { url }),
      error: { code: 'invalid_url', message: `Invalid URL: ${url}`, retryable: false },
    };
  }

  // Scheme whitelist: only http/https may be fetched. file:, data:, and other
  // schemes bypass the host-permission/CORS model entirely and must not
  // be reachable through web_fetch.
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return {
      ok: false,
      name: call.name,
      provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
      summary: translate(locale, 'tool.web.invalidUrl'),
      detail: translate(locale, 'tool.web.invalidUrlDetail', { url }),
      error: {
        code: 'unsupported_url_scheme',
        message: `Unsupported URL scheme: ${parsedUrl.protocol}`,
        retryable: false,
      },
    };
  }

  try {
    throwIfWebToolAborted(signal);
    const abortScope = createAbortScope(signal, 15_000);
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: abortScope.signal,
      });

      if (!response.ok) {
        await cancelUnusedWebResponseBody(response);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      let text: string;
      let byteLimited: boolean;

      if (contentType.includes('text/html') || contentType.includes('text/plain') || contentType.includes('application/json')) {
        // 流式读取 + 字节上限：`await response.text()` 会先把整个响应读进内存，
        // 之后那句 `slice(0, 50_000)` 只截断结果、拦不住读取阶段。
        ({ text, byteLimited } = await readWebResponseBody(response));
      } else {
        await cancelUnusedWebResponseBody(response);
        return {
          ok: true,
          name: call.name,
          provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
          summary: translate(locale, 'tool.web.contentType', { contentType }),
          detail: translate(locale, 'tool.web.contentTypeDetail', { contentType, url }),
          output: { url, contentType } as unknown as JsonValue,
        };
      }

      const extracted = contentType.includes('text/html') ? extractTextFromHtml(text) : text;
      const maxLength = 50_000;
      const truncated = extracted.length > maxLength || byteLimited;
      const outputText = extracted.length > maxLength
        ? extracted.slice(0, maxLength) + translate(locale, 'tool.web.truncated', { count: extracted.length })
        : extracted;

      return {
        ok: true,
        name: call.name,
        provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
        summary: translate(locale, 'tool.web.fetchComplete', { url }),
        // 顶层 `truncated` 会经 `core/zai/continuation.ts` 的 `renderToolResult` 传给模型
        // —— 让它知道「拿到的是残篇」，别把截断当成页面全部内容。
        truncated,
        detail: byteLimited
          ? translate(locale, 'tool.web.fetchByteLimitedDetail', {
            length: extracted.length,
            maxBytes: WEB_TOOL_MAX_RESPONSE_BYTES,
          })
          : extracted.length > maxLength
            ? translate(locale, 'tool.web.fetchTruncatedDetail', { length: extracted.length, maxLength })
            : translate(locale, 'tool.web.fetchLengthDetail', { length: extracted.length }),
        output: { url, content: outputText, contentType, truncated } as unknown as JsonValue,
      };
    } finally {
      abortScope.cleanup();
    }
  } catch (error) {
    throwIfWebToolAborted(signal);
    const message = error instanceof Error ? error.message : String(error);
    const isPermissionError =
      message.includes('Failed to fetch') ||
      message.includes('NetworkError') ||
      message.includes('opaque') ||
      message.includes('status 0');
    return {
      ok: false,
      name: call.name,
      provider: call.provider ?? createWebSearchToolProviderIdentity(locale),
      summary: translate(locale, 'tool.web.fetchFailed'),
      detail: isPermissionError
        ? translate(locale, 'tool.web.missingHostPermission', { url })
        : message,
      error: {
        code: isPermissionError ? 'fetch_permission_denied' : 'fetch_failed',
        message: isPermissionError
          ? `Host permission for ${parsedUrl.origin} is not granted.`
          : message,
        retryable: isPermissionError,
      },
    };
  }
}

async function cancelUnusedWebResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch (error) {
    console.warn('[Zai++] Failed to cancel an unused web response body:', error);
  }
}

function throwIfWebToolAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Web tool execution was aborted.', 'AbortError');
}

function extractTextFromHtml(html: string): string {
  // Strip scripts and styles
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ');
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ');
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');

  // Collapse whitespace
  text = text.replace(/[\r\n]+/g, '\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}
