/**
 * z.ai 模型清单（自动化表单模型下拉的数据源）。两个站点的清单形状相同、
 * 由调用方指明抓哪一个（见 `ZaiModelCatalogDependencies.resolveOrigin`）。
 *
 * 取法：GET `/api/models`，带 `authorization: Bearer <token>`（登录态 token，取自
 * content script 捕获后**按站点分桶存下**的那一份，见 `core/zai/auth.ts`），
 * 返回按「新 → 旧」排列。
 *
 * **只保留网页模型菜单里可选的对话模型。** `/api/models` 会把服务端全部条目都返回
 * （含非对话的 Z1 / 视觉 / 内部实验 id），直接全列出来会让人选到发出去就失败的 id。
 * 判别字段是 `info.meta.capabilities.reasoning_effort === true` —— 真机实测该字段
 * 恰好命中网页菜单里那几条旗舰模型。**用字段而不是写死 id**，服务端上新模型时
 * 无需改代码。
 */

import { createAbortScope } from '../network/abort';

export interface ZaiModelOption {
  id: string;
  label: string;
}

export interface ZaiModelList {
  models: ZaiModelOption[];
  /**
   * `live` = 清单来自服务端（本次抓到，或 5 分钟 TTL 内命中了上次抓到的缓存）；
   * `stale` = 本次抓取失败，用的是**上一次成功抓到**的过期缓存；
   * `fallback` = 从未抓到过，用的是内置兜底清单。
   * 后两者都意味着「这份清单可能不是最新的」，UI 据此给出提示。
   */
  source: 'live' | 'stale' | 'fallback';
}

/** 模型清单端点（与 completion / chats/new 同源）。 */
export const ZAI_MODEL_LIST_PATH = '/api/models';

/** 模型清单缓存时长。5 分钟内重复打开表单不再打网络，但仍能覆盖服务端上新。 */
export const ZAI_MODEL_LIST_TTL_MS = 5 * 60_000;

/**
 * 抓清单这次请求的上界。
 *
 * ⚠️ **单独一个常量，不复用 MCP 那边的 `requestMs`** —— 那是每个 MCP 服务各自的配置，
 * 改一个服务的超时会连带影响这里；而模型清单是一次简单的 GET，两者的合理量级不同。
 *
 * ⚠️⚠️ **超时必须同时盖住 `fetch` 与 `response.json()`** —— 只包 `fetch` 的话，
 * 「响应头到了、body 迟迟不来」这一段没有上界，而它同样会让下面的 `inFlight` 槽位被占住。
 */
export const ZAI_MODEL_LIST_TIMEOUT_MS = 10_000;

/**
 * 兜底清单：从未抓到过服务端清单（未登录 / 网络不可达 / 接口变更）时用。
 *
 * ⚠️ **id 必须是 `/api/models` 里真实存在的值** —— GLM-5.3-Flash 的 id 是
 * `x-preview-l`，**不是** `glm-5.3-flash`；写错会让自动化请求带着一个不存在的
 * 模型名发出去。
 */
export const ZAI_FALLBACK_MODEL_OPTIONS: readonly ZaiModelOption[] = Object.freeze([
  { id: 'x-preview-l', label: 'GLM-5.3-Flash' },
  { id: 'glm-5.3', label: 'GLM-5.3' },
  { id: 'glm-5.2', label: 'GLM-5.2' },
]);

/**
 * 由清单派生「模型 id → 显示名」的查找函数。
 *
 * **用途**：把落库的模型 id 翻成用户看得懂的名字（用量面板按 id 归类，直接渲染会
 * 把 `x-preview-l` 这种内部 id 显示给用户）。
 *
 * ⚠️ **必须按小写建键与查键** —— 用量侧归类的键是 `modelType.toLowerCase()`
 * （`core/usage/stats.ts` 的 `getUsageModelKey`），而服务端清单里的 id 大小写不统一
 * （实测存在 `GLM-5-Turbo`、`GLM-4.1V-Thinking-FlashX` 这类）。两边都不做归一的话，
 * 带大写的模型会静默查不到、退回显示原始 id。
 *
 * ⚠️ **清单是过滤过的**（只留 `reasoning_effort === true` 的对话模型）⇒ 查不到是
 * **正常返回 null**，调用方必须保留原有显示名作兜底，不能当成错误。
 */
export function createZaiModelLabelLookup(
  models: readonly ZaiModelOption[],
): (id: string | null | undefined) => string | null {
  const byId = new Map(models.map((model) => [model.id.toLowerCase(), model.label]));
  return (id) => {
    if (typeof id !== 'string') return null;
    const key = id.trim().toLowerCase();
    return key ? byId.get(key) ?? null : null;
  };
}

/** 解析后的中间形状：带上「网页菜单是否列它」的判定结果。 */
interface ParsedZaiModel extends ZaiModelOption {
  /** 该条目的能力位是否可读；读不到就没法判断要不要保留。 */
  capabilitiesKnown: boolean;
  /** 是否属于网页模型菜单里的旗舰档（可被自动化选用）。 */
  selectable: boolean;
}

/**
 * 解析 `/api/models` 上游响应，只返回网页菜单里可选的对话模型。
 *
 * 结构：`{ data: [{ id, name, info: { name, meta: { capabilities } } }] }`。
 * 若整个响应里**没有任何条目**带可读的能力位（形状不认识），返回空数组 ——
 * 调用方据此走兜底清单，而不是把一堆来路不明的 id 列给用户。
 */
export function parseZaiUpstreamModels(raw: unknown): ZaiModelOption[] {
  const data = readDataArray(raw);
  if (!data) return [];
  const parsed = data
    .map(parseZaiModelEntry)
    .filter((entry): entry is ParsedZaiModel => entry !== null);
  if (!parsed.some((entry) => entry.capabilitiesKnown)) return [];
  return parsed
    .filter((entry) => entry.selectable)
    .map(({ id, label }) => ({ id, label }));
}

/** 校验运行时命令响应（`GET_ZAI_MODELS`）的形状；不合规即抛错。 */
export function decodeZaiModelListResponse(raw: unknown, label = 'ZAI model list'): ZaiModelList {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const record = raw as Record<string, unknown>;
  const source = record.source === 'live' || record.source === 'stale' || record.source === 'fallback'
    ? record.source
    : (() => { throw new Error(`${label}.source must be live, stale, or fallback.`); })();
  if (!Array.isArray(record.models)) throw new Error(`${label}.models must be an array.`);
  const models = record.models.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label}.models[${index}] must be a plain object.`);
    }
    const option = entry as Record<string, unknown>;
    if (typeof option.id !== 'string' || !option.id.trim()) {
      throw new Error(`${label}.models[${index}].id must be a non-empty string.`);
    }
    if (typeof option.label !== 'string' || !option.label.trim()) {
      throw new Error(`${label}.models[${index}].label must be a non-empty string.`);
    }
    return { id: option.id, label: option.label };
  });
  return { models, source };
}

function readDataArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return null;
  const data = (raw as Record<string, unknown>).data;
  return Array.isArray(data) ? data : null;
}

function parseZaiModelEntry(entry: unknown): ParsedZaiModel | null {
  const record = readRecord(entry);
  if (!record) return null;
  const id = readNonEmptyString(record.id) ?? readNonEmptyString(record.model);
  if (!id) return null;
  const info = readRecord(record.info);
  const label = readNonEmptyString(record.name)
    ?? readNonEmptyString(info?.name)
    ?? id;
  const capabilities = readRecord(readRecord(info?.meta)?.capabilities);
  return {
    id,
    label,
    capabilitiesKnown: capabilities !== null,
    // 旗舰档标记：真机实测该能力位恰好圈出网页菜单里的对话模型。
    selectable: capabilities?.reasoning_effort === true,
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export interface ZaiModelCatalogDependencies {
  /**
   * 读取**指定站点**的登录态 token；没有则返回 null（此时直接走兜底清单）。
   *
   * ⚠️ **站点的来源是 `resolveOrigin()`，不是 token 自己** —— 两站的 token 互不认，
   * 拿别站的 token 打这一站只会 401。所以这里收站点、再由实现去取那一站的桶。
   *
   * ⚠️⚠️ **实现必须自带超时** —— `fetchLive` 外面那个 `inFlight` 槽位是在 `finally` 里释放的，
   * 而这两次读排在 `fetch` 的 abort scope **之前**（scope 只罩网络腿）⇒ 它们挂住会让槽位
   * 永久占住、清单再也刷不出来，且**没有任何报错**。
   * 现成的用法是 `loadZaiAuthFromStorage(AUTH_READ_TIMEOUT_MS, origin)`。
   */
  loadToken(origin: string): Promise<string | null>;
  fetchImpl(input: string, init: RequestInit): Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
  /**
   * 抓哪个站的清单（**不含尾斜杠**）。
   *
   * ⚠️ **必须注入、不能吃 `ZAI_WEB_ORIGIN`** —— 后者是**默认站点**（国区站）。
   * 这个抓取器跑在**后台**、没有页面上下文，所以它的选择只有两个：
   * ① 跟随「用户此刻在看哪一站」（`readCurrentZaiSiteOrigin()` —— 实时查当前标签页，
   *    查不到才退回内容脚本记下的历史值，见 `core/zai/current-site.ts`）；
   * ② 记录里带的站点（自动化那条链有明确归属时）。
   * 这里是 ① —— 清单服务的是**自动化表单的下拉**，用户眼下在看哪个站就该列哪个站的模型。
   *
   * ⚠️⚠️ **实现必须自带超时**，理由同 `loadToken` —— 它也排在 abort scope 之前。
   * 现成的用法是 `readCurrentZaiSiteOrigin(CURRENT_SITE_READ_TIMEOUT_MS)`。
   */
  resolveOrigin(): Promise<string>;
  now?(): number;
}

export interface ZaiModelCatalog {
  /** 取模型清单：缓存新鲜则直接返回缓存，否则打一次网络。 */
  list(): Promise<ZaiModelList>;
}

/**
 * 模型清单抓取器（带缓存与兜底）。并发调用共享同一次在飞请求，避免表单
 * 反复打开时打出一串重复请求。
 *
 * ⚠️⚠️ **缓存是跨站点的单一槽** —— 前提是**两站在 `/api/models` 上返回同一份清单**
 * （实测两站完全相同）。所以 TTL 命中时**不重新解析站点**，那是有意的：
 * 若将来两站分叉，这里会拿**另一站**的清单（表现是下拉里出现该站没有的模型、
 * 选了发出去失败），而**没有任何报错指向这个缓存**。真要分叉了，
 * 就得把 `cached` 换成按 origin 分桶的 Map —— 代价是 TTL 命中不再是零 I/O
 * （每次都要先解析站点，那是一次 `chrome.storage.local` 读）。
 */
export function createZaiModelCatalog(
  dependencies: ZaiModelCatalogDependencies,
): ZaiModelCatalog {
  const now = dependencies.now ?? (() => Date.now());
  let cached: { models: ZaiModelOption[]; at: number } | null = null;
  let inFlight: Promise<ZaiModelList> | null = null;

  const fetchLive = async (): Promise<ZaiModelList> => {
    // ⚠️ **先定站点、再取那一站的 token** —— 反过来（先取 token 再定站点）会让
    // 两次读各自发生，中间可以被「用户切站」插进来 ⇒ token 与请求 URL 分属两站。
    const origin = await dependencies.resolveOrigin();
    const token = await dependencies.loadToken(origin);
    if (!token) return { models: [...ZAI_FALLBACK_MODEL_OPTIONS], source: 'fallback' };
    // ⚠️⚠️ **上界必须罩住「取响应 + 读 body」整段**（见 `ZAI_MODEL_LIST_TIMEOUT_MS`）——
    // 挂住时 `inFlight` 的 `finally` 走不到，槽位会被永久占住：之后每次 `list()` 都返回
    // 同一个未完成的 promise，下拉一直是空的、连「不是最新」的提示都不出现。
    const scope = createAbortScope(null, ZAI_MODEL_LIST_TIMEOUT_MS);
    try {
      const response = await dependencies.fetchImpl(`${origin}${ZAI_MODEL_LIST_PATH}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
        credentials: 'omit',
        cache: 'no-store',
        signal: scope.signal,
      });
      if (!response.ok) {
        throw new Error(`Model list request failed with status ${response.status}.`);
      }
      const models = parseZaiUpstreamModels(await response.json());
      if (models.length === 0) {
        throw new Error('Model list response contained no usable entries.');
      }
      return { models, source: 'live' };
    } finally {
      scope.cleanup();
    }
  };

  return Object.freeze({
    async list(): Promise<ZaiModelList> {
      if (cached && now() - cached.at < ZAI_MODEL_LIST_TTL_MS) {
        // 缓存新鲜期内的命中：清单仍是**上次真抓到**的服务端结果，所以算 live
        // （`stale` 特指「抓取失败、退回过期缓存」，两者不同——UI 只对 stale/fallback 提示）。
        return { models: [...cached.models], source: 'live' };
      }
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const result = await fetchLive();
          if (result.source === 'live') cached = { models: result.models, at: now() };
          return result;
        } catch {
          // 抓不到就退：有上次成功抓到的缓存 → 用缓存（标 stale，比内置清单准但可能过期）；
          // 从未抓到过 → 内置兜底清单。两者都让 UI 能给出「不是最新」的提示。
          if (cached) return { models: [...cached.models], source: 'stale' };
          return { models: [...ZAI_FALLBACK_MODEL_OPTIONS], source: 'fallback' };
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  });
}
