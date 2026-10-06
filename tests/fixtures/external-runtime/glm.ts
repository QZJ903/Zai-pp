/**
 * z.ai SSE 的**已知缺口**清单（`tests/live-gap-ownership.test.ts` 消费）。
 *
 * ⚠️ **本文件曾经还装着 9 个从上游照抄的 fixture**（`GLM_ROUTE_CONTRACT` /
 * `LEGAL_GLM_ROUTE_FIXTURES` / `GLM_ACTIVE_ROUTE_METHOD_FIXTURES` /
 * `REJECTED_GLM_ROUTE_FIXTURES` / `GLM_REQUEST_BODY_FIXTURE` /
 * `GLM_ACTIVE_COMPLETION_BODY_FIXTURE` / `LEGAL_GLM_SSE_FIXTURES` /
 * `CRLF_GLM_SSE_FIXTURE` / `UNKNOWN_GLM_SSE_EVENT`），**2026-10-06 已删除**。
 * 它们全仓零消费者、且内容是 **deepseek 协议**（9 条路由写的是 `/api/v0/chat/...`、
 * `bypassHeader` 是 `X-DPP-Bypass-Hook`），与本项目真实使用的
 * `/api/v1/chats/new` + `/api/v2/chat/completions` 对不上。
 *
 * ⚠️ **删除的依据**：它们本来要喂的契约面，本项目已用自己的形状覆盖 ——
 * 路由接受/拒绝面在 `tests/zai.test.ts`（38 条，用真实路由）、
 * 工具 XML 块扫描在 `tests/zai-tool-xml-scanner.test.ts`、
 * 流式解码在 `tests/zai.test.ts` + `tests/zai-usage-snapshot.test.ts`。
 * 上游那三份测试（`deepseek-protocol-contract` / `deepseek-active-protocol` /
 * `xml-tool-stream-filter`，共 682 行）**从未评估过**这件事，记在
 * `GLM++开发日志.md` 与记忆 `zai-build` 的 §4.33 第四节，**不再由本文件承载**。
 */

/**
 * 当前已知、**刻意不修**的协议缺口。每条都要有明确的 `owner` 与 `target`，
 * 由 `tests/live-gap-ownership.test.ts` 断言「不是历史遗留、有主、且目标不是内部代号」。
 *
 * ⚠️ 这一条**对 z.ai 成立**（与上游那份 deepseek fixture 不同）：`parseZaiSseData`
 * 在 `JSON.parse` 失败时**静默返回 null**、不留任何痕迹
 * （`core/zai/stream-codec.ts` 的 `catch { return null; }`）。
 */
export const GLM_SSE_CURRENT_GAPS = [
  {
    name: 'malformed event JSON is silently represented as null',
    wire: 'data: {bad json}\n\n',
    currentBehavior: 'parse-null-without-diagnostic',
    status: 'deferred',
    owner: 'deferred:glm-stream-observability',
    target: 'observable-protocol-error',
  },
] as const;
