import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_SITE_READ_TIMEOUT_MS,
  readCurrentZaiSiteOrigin,
} from '../core/zai/current-site';
import {
  ZAI_VIEWED_SITE_STORAGE_KEY,
  rememberViewedZaiSite,
} from '../core/zai/viewed-site';

/**
 * 「用户此刻在看哪一站」的读取。
 *
 * ⚠️ 这条链的失败方向全是**静默**的：拿错站不会报错，只会让模型清单列错站、或让自动化
 * 在错的那一站开标签页。所以每条断言都成对钉住「取值顺序」与「拿不到时退到什么」。
 *
 * ⚠️ **三段顺序不可颠倒**：
 * ① 实时查「最后聚焦窗口的当前标签页」；② 查不到 → 内容脚本记下的历史值；③ 再查不到 → 默认站。
 */

const CN = 'https://zchat.z.ai';
const GLOBAL = 'https://chat.z.ai';

let store: Record<string, unknown>;
let queryImpl: () => Promise<Array<{ id?: number; url?: string }>>;
let getImpl: () => Promise<Record<string, unknown>>;

beforeEach(() => {
  store = {};
  queryImpl = async () => [];
  getImpl = async () => ({ ...store });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn((keys: string | string[]) => {
          void keys;
          return getImpl();
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
      },
    },
    tabs: {
      query: vi.fn(() => queryImpl()),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('readCurrentZaiSiteOrigin: the current tab wins over the remembered one', () => {
  it('returns the site of the focused window’s active tab', async () => {
    queryImpl = async () => [{ id: 7, url: `${GLOBAL}/c/abc` }];
    store[ZAI_VIEWED_SITE_STORAGE_KEY] = { origin: CN, at: 1 };

    // ⚠️ 历史值记的是国区站，但用户此刻在国际站 ⇒ 必须答国际站。
    // 这正是「后台标签页刷新会把记录写歪」那个缺陷的兜底面。
    await expect(readCurrentZaiSiteOrigin()).resolves.toBe(GLOBAL);
  });

  it('asks with lastFocusedWindow, not currentWindow', async () => {
    // ⚠️ 判据是「用户在看哪个窗口」 —— `lastFocusedWindow` 是明确要求；
    // `currentWindow` 依赖「无窗口上下文时退化为最后聚焦窗口」这一隐含行为。
    queryImpl = async () => [{ id: 7, url: GLOBAL }];
    await readCurrentZaiSiteOrigin();
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
  });

  it('ignores a current tab that is not one of our sites', async () => {
    queryImpl = async () => [{ id: 3, url: 'https://example.test/whatever' }];
    store[ZAI_VIEWED_SITE_STORAGE_KEY] = { origin: CN, at: 1 };

    // 用户在看非 z.ai 页面 ⇒ 退到「上一次真正看着的站」。
    await expect(readCurrentZaiSiteOrigin()).resolves.toBe(CN);
  });
});

describe('readCurrentZaiSiteOrigin: fallbacks', () => {
  it('falls back to the remembered site when the tab query finds nothing', async () => {
    queryImpl = async () => [];
    store[ZAI_VIEWED_SITE_STORAGE_KEY] = { origin: GLOBAL, at: 1 };
    await expect(readCurrentZaiSiteOrigin()).resolves.toBe(GLOBAL);
  });

  it('falls back to the remembered site when the tab query throws', async () => {
    queryImpl = async () => { throw new Error('tabs_query_failed'); };
    store[ZAI_VIEWED_SITE_STORAGE_KEY] = { origin: GLOBAL, at: 1 };
    await expect(readCurrentZaiSiteOrigin()).resolves.toBe(GLOBAL);
  });

  it('falls back to the default site when there is no usable record at all', async () => {
    // 从没记录过 / 记录不合法 / storage 抛错 —— 三条都必须落到默认站，且**不 reject**。
    await expect(readCurrentZaiSiteOrigin()).resolves.toBe(CN);

    store[ZAI_VIEWED_SITE_STORAGE_KEY] = { origin: 'https://evil.test', at: 1 };
    await expect(readCurrentZaiSiteOrigin()).resolves.toBe(CN);

    store[ZAI_VIEWED_SITE_STORAGE_KEY] = { origin: 42 };
    await expect(readCurrentZaiSiteOrigin()).resolves.toBe(CN);

    getImpl = async () => { throw new Error('Extension context invalidated'); };
    await expect(readCurrentZaiSiteOrigin()).resolves.toBe(CN);
  });
});

describe('readCurrentZaiSiteOrigin: the optional upper bound', () => {
  it('returns within the bound when the tab query never settles', async () => {
    // ⚠️ 调用方里有一个持有 `inFlight` 槽位的（模型清单抓取器）—— 拿不到答案会让那个槽位
    // 一直被占、之后每次触发都返回同一个未完成的 promise。所以上界是必需的。
    vi.useFakeTimers();
    queryImpl = () => new Promise(() => { /* 永不 settle */ });

    const pending = readCurrentZaiSiteOrigin(CURRENT_SITE_READ_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(CURRENT_SITE_READ_TIMEOUT_MS);
    await expect(pending).resolves.toBe(CN);
  });

  it('still falls back to the remembered site when only the tab query is slow', async () => {
    // ⚠️⚠️ **这条是「超时不能直接给默认站」的守卫** —— `tabs.query` 慢的典型场景是扩展上下文
    // 出问题，而那一刻 `storage.local` 往往还通。若超时分支直接返回默认站，用户在国际站
    // 就会拿到国区站的 origin ⇒ 取不到 token ⇒ 模型下拉退化成内置三条。
    // 判据：**超时只让第一段「查不到」，第 2 段仍要试。**
    vi.useFakeTimers();
    queryImpl = () => new Promise(() => { /* 永不 settle */ });
    store[ZAI_VIEWED_SITE_STORAGE_KEY] = { origin: GLOBAL, at: 1 };

    const pending = readCurrentZaiSiteOrigin(CURRENT_SITE_READ_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(CURRENT_SITE_READ_TIMEOUT_MS + 10);

    // 必须答国际站（记录里的），不是默认的国区站。
    await expect(pending).resolves.toBe(GLOBAL);
  });

  it('returns within the bound when the tab query hangs too', async () => {
    vi.useFakeTimers();
    queryImpl = () => new Promise(() => { /* 永不 settle */ });
    const pending = readCurrentZaiSiteOrigin(CURRENT_SITE_READ_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(CURRENT_SITE_READ_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBe(CN);
    // 上界很短：它只是两次本地 API 往返，不该等到网络量级。
    expect(CURRENT_SITE_READ_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('rememberViewedZaiSite', () => {
  it('writes only origins that belong to the site table', async () => {
    await expect(rememberViewedZaiSite(GLOBAL)).resolves.toBe(true);
    expect(store[ZAI_VIEWED_SITE_STORAGE_KEY]).toMatchObject({ origin: GLOBAL });

    // 认不出就不写 —— 留着上一条记录，比写进一条永远认不出的值好。
    await expect(rememberViewedZaiSite('https://zcode.z.ai')).resolves.toBe(false);
    await expect(rememberViewedZaiSite('https://evil.test')).resolves.toBe(false);
    expect(store[ZAI_VIEWED_SITE_STORAGE_KEY]).toMatchObject({ origin: GLOBAL });
  });

  it('records a timestamp that nothing reads', async () => {
    // ⚠️ `at` **只留痕、没有消费者** —— 读取侧不看新鲜度（语义就是「上一次」）。
    // 这条用例钉的是「它确实写进去了」，不是「它参与判断」。
    await rememberViewedZaiSite(CN);
    const record = store[ZAI_VIEWED_SITE_STORAGE_KEY] as { at?: unknown };
    expect(typeof record.at).toBe('number');
  });

  it('swallows storage failures', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          set: vi.fn(async () => { throw new Error('Extension context invalidated'); }),
        },
      },
    });
    await expect(rememberViewedZaiSite(CN)).resolves.toBe(false);
  });
});