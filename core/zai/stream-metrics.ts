/**
 * 一轮 completion 的用量快照。
 *
 * z.ai 与 DeepSeek 的取数方式完全不同：DeepSeek 要在流式补丁里累加
 * `accumulated_token_usage`，而 z.ai 的 SSE 直接给出权威用量 —— `phase:"other"`
 * 帧带 `usage:{prompt_tokens,completion_tokens,total_tokens}`（真机抓包与第三方
 * 桥接项目两处独立记录一致）。所以这里不移植上游的补丁解析，只按 z.ai 的形状取。
 *
 * 速度判据与上游一致：**服务端的 usage 含 prompt/context，绝不用来算生成速度**，
 * 速度只用流式正文的估算量除以解码窗口。
 */

import { estimateTokenUnits } from '../token/estimator';
import type { TokenMetricSource } from '../usage/types';
import type { ZaiSseEvent } from './stream-codec';

export interface ZaiServerTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number;
}

export interface ZaiUsageSnapshot {
  requestId: string;
  modelType: string | null;
  totalTokens: number;
  tokenSource: TokenMetricSource;
  tps: number;
  speedSource: TokenMetricSource;
  elapsedMs: number;
  estimatedTokens: number;
}

export interface ZaiUsageTracker {
  /** 每个 SSE 帧调用一次：从中读服务端用量。 */
  observeEvent(event: ZaiSseEvent | null | undefined): void;
  /** 每段新增正文调用一次：只为标记解码起点。 */
  appendText(text: string): void;
  /** 流终止（正常 / 出错 / 被取消）调用一次，返回快照或 null。 */
  finish(finalText: string): ZaiUsageSnapshot | null;
}

/**
 * 从一帧 SSE 里读服务端用量。
 *
 * **不按 phase 过滤**：`other` 是实测的承载帧，但只认「字段齐全且 total_tokens
 * 为正」的对象 —— 形状校验才是安全网，写死 phase 只会在服务端改相位名时静默失效。
 */
export function readZaiServerTokenUsage(
  event: ZaiSseEvent | null | undefined,
): ZaiServerTokenUsage | null {
  const usage = event?.parsed?.usage;
  if (!isRecord(usage)) return null;
  const total = readNonNegativeNumber(usage.total_tokens);
  if (total === null || total <= 0) return null;
  return {
    promptTokens: readNonNegativeNumber(usage.prompt_tokens),
    completionTokens: readNonNegativeNumber(usage.completion_tokens),
    totalTokens: Math.round(total),
  };
}

/**
 * 一轮响应的用量跟踪器。解码窗口从**第一段正文**起算（不含排队/预填充延迟），
 * 与上游同一口径 —— 否则首帧会被前面的等待时间拉低。
 */
export function createZaiUsageTracker(
  requestId: string,
  modelType: string | null,
  options: { now?: () => number } = {},
): ZaiUsageTracker {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  let firstTextAt: number | null = null;
  let serverUsage: ZaiServerTokenUsage | null = null;
  let finished = false;

  return {
    observeEvent(event) {
      const usage = readZaiServerTokenUsage(event);
      if (usage) serverUsage = usage;
    },
    appendText(text) {
      if (!text) return;
      if (firstTextAt === null) firstTextAt = now();
    },
    finish(finalText) {
      if (finished) return null;
      finished = true;

      const finishedAt = now();
      // 正文三语义（追加 / 整体替换 / 局部替换）会让累积文本**不单调**，
      // 所以估算只在流结束时对最终正文做一次，而不是逐帧累加 —— 逐帧累加会高估。
      const estimatedTokens = Math.round(estimateTokenUnits(finalText));
      const authoritative = serverUsage;
      const hasServerUsage = authoritative !== null && authoritative.totalTokens > 0;
      if (!hasServerUsage && estimatedTokens <= 0) return null;

      const decodeMs = firstTextAt === null ? 0 : Math.max(finishedAt - firstTextAt, 0);
      const tps = decodeMs > 0 ? (estimatedTokens / decodeMs) * 1000 : 0;

      return {
        requestId,
        modelType,
        totalTokens: hasServerUsage ? authoritative.totalTokens : estimatedTokens,
        tokenSource: hasServerUsage ? 'server' : 'estimated',
        tps: Number.isFinite(tps) && tps > 0 ? tps : 0,
        speedSource: 'estimated',
        // 口径是「响应头到达 → 流结束」：tracker 在 await responsePromise 之后构造，
        // TTFB（排队/预填充）不在内。UI 不读这个字段，只是存着。
        elapsedMs: Math.max(finishedAt - startedAt, 1),
        estimatedTokens,
      };
    },
  };
}

/** 校验过桥的快照（MAIN world → 隔离世界，跨世界边界不做任何信任）。 */
export function decodeZaiUsageSnapshot(value: unknown): ZaiUsageSnapshot | null {
  if (!isRecord(value)) return null;
  const requestId = typeof value.requestId === 'string' ? value.requestId.trim() : '';
  if (!requestId) return null;
  const totalTokens = readNonNegativeNumber(value.totalTokens);
  if (totalTokens === null || totalTokens <= 0) return null;
  const elapsedMs = readNonNegativeNumber(value.elapsedMs);
  const estimatedTokens = readNonNegativeNumber(value.estimatedTokens);
  const tps = readNonNegativeNumber(value.tps);
  const modelType = typeof value.modelType === 'string' && value.modelType.trim()
    ? value.modelType.trim()
    : null;
  return {
    requestId,
    modelType,
    totalTokens: Math.round(totalTokens),
    tokenSource: value.tokenSource === 'server' ? 'server' : 'estimated',
    tps: tps ?? 0,
    // 速度恒为估算：服务端总量含 prompt，拿它算生成速度是错的。这里只做形状对齐，
    // 保留 'server' 分支是为了兼容未来真的按 server 计时的情况。
    speedSource: value.speedSource === 'server' ? 'server' : 'estimated',
    elapsedMs: elapsedMs ?? 0,
    estimatedTokens: estimatedTokens === null ? 0 : Math.round(estimatedTokens),
  };
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
