/**
 * z.ai SSE 的**已知缺口**清单（`tests/live-gap-ownership.test.ts` 消费）。
 *
 * 本文件只放 z.ai 自己的 fixture。上游那批 fixture 是 **deepseek 协议**
 * （9 条路由写的是 `/api/v0/chat/...`、`bypassHeader` 是 `X-DPP-Bypass-Hook`），
 * 与本项目真实使用的 `/api/v1/chats/new` + `/api/v2/chat/completions` 对不上，
 * 不能直接搬。
 *
 * 它们要喂的契约面，本项目用自己的形状覆盖 ——
 * 路由接受/拒绝面在 `tests/zai.test.ts`（38 条，用真实路由）、
 * 工具 XML 块扫描在 `tests/zai-tool-xml-scanner.test.ts`、
 * 流式解码在 `tests/zai.test.ts` + `tests/zai-usage-snapshot.test.ts`。
 */

/**
 * 当前已知、**刻意不修**的协议缺口。每条都要有明确的 `owner` 与 `target`，
 * 由 `tests/live-gap-ownership.test.ts` 断言「不是历史遗留、有主、且目标不是内部代号」。
 *
 * ⚠️ 这一条**对 z.ai 成立**（与上游那份 deepseek fixture 不同）：`parseZaiSseData`
 * 在 `JSON.parse` 失败时**静默返回 null**、不留任何痕迹
 * （`core/zai/stream-codec.ts` 的 `catch { return null; }`）。
 */
export const ZAI_SSE_CURRENT_GAPS = [
  {
    name: 'malformed event JSON is silently represented as null',
    wire: 'data: {bad json}\n\n',
    currentBehavior: 'parse-null-without-diagnostic',
    status: 'deferred',
    owner: 'deferred:zai-stream-observability',
    target: 'observable-protocol-error',
  },
] as const;
