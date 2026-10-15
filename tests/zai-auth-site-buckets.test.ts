import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_READ_TIMEOUT_MS,
  ZAI_AUTH_SITE_STORAGE_KEY_PREFIX,
  ZAI_AUTH_STORAGE_KEY,
  clearZaiAuthFromStorage,
  loadZaiAuthFromStorage,
  mergeZaiAuthFromCapture,
  normalizeZaiAuth,
  saveZaiAuthToStorage,
  zaiAuthStorageKeyForSite,
} from '../core/zai/auth';
import { ZAI_SITES, resolveZaiSiteOrigin } from '../core/zai/contracts';

/**
 * 登录态**按站点分桶**的守卫。
 *
 * 两个站点（国区站 `zchat.z.ai` / 国际站 `chat.z.ai`）的 token **互不认**，
 * 而 `chrome.storage.local` 是扩展级共享的、两站的页面 `localStorage` 各自独立 ——
 * 只存一份 token 时，后加载的那一站会把另一站的覆盖掉，另一站读回来必然 401。
 *
 * 这里守的是三件事，每件漏了都**不报错**：
 *   ① **写侧按捕获页面的 origin 分桶**（ground truth，不做任何推断）；
 *   ② **一桶一个 storage key** —— 不能把 `{ [origin]: ZaiAuth }` 装进一个键，
 *      否则两个内容脚本实例「读整表 → 改自己那格 → 写回整表」会互相覆盖；
 *   ③ **单槽的只读兜底要过站点归属闸门** —— 存量值不知道属于哪一站，
 *      判得出属于别站就不能给（但判不出/访客一律放行，见下）。
 */

const CN_ORIGIN = ZAI_SITES.cn.origin;
const GLOBAL_ORIGIN = ZAI_SITES.global.origin;
const CN_KEY = `${ZAI_AUTH_SITE_STORAGE_KEY_PREFIX}cn`;
const GLOBAL_KEY = `${ZAI_AUTH_SITE_STORAGE_KEY_PREFIX}global`;

/** 造一条只有 payload 有意义的 JWT（`atob` 解得出第二段即可）。 */
function makeToken(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  let binary = '';
  for (const byte of new TextEncoder().encode(json)) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${encoded}.signature`;
}

function authRecord(token: string) {
  return {
    token,
    userId: 'u1',
    feVersion: null,
    deviceId: null,
    capturedAt: 1,
    expiresAt: null,
  };
}

let store: Record<string, unknown>;
let setImpl: (items: Record<string, unknown>) => Promise<void>;

beforeEach(() => {
  store = {};
  setImpl = async (items) => {
    Object.assign(store, items);
  };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) {
            if (key in store) out[key] = store[key];
          }
          return out;
        }),
        set: vi.fn((items: Record<string, unknown>) => setImpl(items)),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('site bucket keys', () => {
  it('derives one storage key per site', () => {
    expect(zaiAuthStorageKeyForSite(CN_ORIGIN)).toBe(CN_KEY);
    expect(zaiAuthStorageKeyForSite(GLOBAL_ORIGIN)).toBe(GLOBAL_KEY);
    // 站点的 origin 与 URL 都认（同一个判定函数），且两站的键**互不相同**。
    expect(zaiAuthStorageKeyForSite(`${CN_ORIGIN}/c/abc`)).toBe(CN_KEY);
    expect(CN_KEY).not.toBe(GLOBAL_KEY);
  });

  it('falls back to the default site for an unrecognised origin', () => {
    // 认不出的 origin 不能拼出一个「永远不会被读到」的键（那会让读取静默空值），
    // 也不能落在站点表之外 —— 按默认站收口，与 `ZAI_DEFAULT_SITE_ID` 同口径。
    // ⚠️ **这是读侧的键派生**：写侧不跟着收口，见下面那组拒写断言。
    expect(zaiAuthStorageKeyForSite('https://zcode.z.ai')).toBe(
      zaiAuthStorageKeyForSite(ZAI_SITES.cn.origin),
    );
    expect(resolveZaiSiteOrigin(CN_ORIGIN)).toBe(CN_ORIGIN);
  });
});

describe('writes refuse an unrecognised site instead of polluting the default bucket', () => {
  // ⚠️ 键派生函数对认不出的 origin 会收口到默认站（读侧需要），而写侧若跟着收口，
  // 就会把**别站的 token 写进默认站的桶** —— 那个站之后读回来的就是不属于它的 token。
  // 拒写的最坏结果只是「这次没写进去」，方向严格更安全。
  it('does not write anything when the site is not one of ours', async () => {
    for (const origin of ['https://zcode.z.ai', 'https://evil.test', '', 'not a url']) {
      const stored = await saveZaiAuthToStorage(authRecord('token-1'), origin);
      expect(stored, `${origin} 不该被写进去`).toBe(false);
    }
    // 一个键都没碰过 —— 尤其是默认站那个桶。
    expect(Object.keys(store)).toEqual([]);
  });

  it('still writes when the site is recognised', async () => {
    // 与上面那条成对：拒写只针对「认不出」，正常站点照写不误。
    await expect(saveZaiAuthToStorage(authRecord('cn-token'), CN_ORIGIN)).resolves.toBe(true);
    expect((store[CN_KEY] as { token: string }).token).toBe('cn-token');
  });

  it('rejects an entry with no usable token before it ever looks at the site', async () => {
    // 两种 false 的来源之一（另一种是「认不出站点」）：没有 token 就不写。
    await expect(saveZaiAuthToStorage(authRecord('   '), CN_ORIGIN)).resolves.toBe(false);
    expect(Object.keys(store)).toEqual([]);
  });
});

describe('writes are bucketed by the capturing page', () => {
  it('writes to the bucket of the site the capture came from', async () => {
    await mergeZaiAuthFromCapture({ token: 'cn-token' }, CN_ORIGIN);

    expect(setImpl).toBeTruthy();
    expect(store[CN_KEY]).toMatchObject({ token: 'cn-token' });
    // ⚠️ **一桶一个键**：这次写入碰到的键**只有** cn 那一个。
    // 若改成「一张表装进一个键」，写入侧就会变成「读整表再写回整表」，
    // 两站并发时后写者会吞掉前者 —— 这条断言就是拦那个改法的。
    expect(Object.keys(store)).toEqual([CN_KEY]);
  });

  it('keeps the two sites in separate keys, so one cannot overwrite the other', async () => {
    await mergeZaiAuthFromCapture({ token: 'cn-token' }, CN_ORIGIN);
    await mergeZaiAuthFromCapture({ token: 'global-token' }, GLOBAL_ORIGIN);

    expect((store[CN_KEY] as { token: string }).token).toBe('cn-token');
    expect((store[GLOBAL_KEY] as { token: string }).token).toBe('global-token');
  });

  it('never touches the legacy slot when writing', async () => {
    store[ZAI_AUTH_STORAGE_KEY] = authRecord('legacy-token');

    await mergeZaiAuthFromCapture({ token: 'cn-token' }, CN_ORIGIN);

    // 存量槽是**只读兜底**，写入不搬迁、不改写它（否则「不动现有 zaiCachedAuth」就不成立了）。
    expect((store[ZAI_AUTH_STORAGE_KEY] as { token: string }).token).toBe('legacy-token');
  });

  it('reuses only the same site bucket to backfill the other fields', async () => {
    store[GLOBAL_KEY] = { ...authRecord('global-token'), feVersion: 'prod-fe-9.9.9' };

    await mergeZaiAuthFromCapture({ token: 'cn-token' }, CN_ORIGIN);

    // 旧字段从**本桶**取 —— 这里本桶还没有值，所以 feVersion 不该把国际站那份带过来。
    expect((store[CN_KEY] as { feVersion: string | null }).feVersion).toBeNull();
    expect((store[GLOBAL_KEY] as { feVersion: string | null }).feVersion).toBe('prod-fe-9.9.9');
  });

  it('returns false and writes nothing when there is no token to store', async () => {
    const stored = await mergeZaiAuthFromCapture({ token: '   ' }, CN_ORIGIN);
    expect(stored).toBe(false);
    expect(Object.keys(store)).toEqual([]);
  });
});

describe('reads prefer the target site', () => {
  it('returns the site bucket without consulting the legacy slot', async () => {
    store[CN_KEY] = authRecord('cn-token');
    store[ZAI_AUTH_STORAGE_KEY] = authRecord(makeToken({ region: 'global' }));

    await expect(loadZaiAuthFromStorage(undefined, CN_ORIGIN)).resolves.toMatchObject({
      token: 'cn-token',
    });
  });

  it('reads each site its own token', async () => {
    store[CN_KEY] = authRecord('cn-token');
    store[GLOBAL_KEY] = authRecord('global-token');

    await expect(loadZaiAuthFromStorage(undefined, CN_ORIGIN)).resolves.toMatchObject({
      token: 'cn-token',
    });
    await expect(loadZaiAuthFromStorage(undefined, GLOBAL_ORIGIN)).resolves.toMatchObject({
      token: 'global-token',
    });
  });

  it('falls back to the legacy slot when the target bucket is empty', async () => {
    store[ZAI_AUTH_STORAGE_KEY] = authRecord(makeToken({ region: 'cn' }));

    await expect(loadZaiAuthFromStorage(undefined, CN_ORIGIN)).resolves.toMatchObject({
      token: expect.stringContaining('.'),
    });
  });

  it('still returns the legacy record when no site is asked for', async () => {
    store[ZAI_AUTH_STORAGE_KEY] = authRecord('legacy-token');

    // 不带站点 = 只读存量值，不过闸门（今天的行为）。
    await expect(loadZaiAuthFromStorage()).resolves.toMatchObject({ token: 'legacy-token' });
  });

  it('resolves null when neither the bucket nor the legacy slot has anything', async () => {
    await expect(loadZaiAuthFromStorage(undefined, CN_ORIGIN)).resolves.toBeNull();
  });
});

describe('the legacy slot gates on the region claim', () => {
  it('refuses a legacy token whose region belongs to the other site', async () => {
    store[ZAI_AUTH_STORAGE_KEY] = authRecord(makeToken({ region: 'global' }));

    // 存量值是国际站登录态 ⇒ 国区站这一侧的读必须拿不到它（否则一定 401）。
    await expect(loadZaiAuthFromStorage(undefined, CN_ORIGIN)).resolves.toBeNull();
    await expect(loadZaiAuthFromStorage(undefined, GLOBAL_ORIGIN)).resolves.toMatchObject({
      token: expect.stringContaining('.'),
    });
  });

  it('refuses the mirror case as well', async () => {
    store[ZAI_AUTH_STORAGE_KEY] = authRecord(makeToken({ region: 'cn' }));

    await expect(loadZaiAuthFromStorage(undefined, GLOBAL_ORIGIN)).resolves.toBeNull();
  });

  it('lets a guest token through even when its region names the other site', async () => {
    // ⚠️ 实测**国区站的 guest token 也带 `region: "global"`**，而它在国区站是能用的。
    // 拿 region 硬判会把国区站自己的 guest 挡掉 ⇒ 访客一律放行。
    // ⚠️ 真机抓到的访客邮箱首字母是**大写**（`Guest-…@guest.com`），判据必须大小写不敏感。
    for (const email of ['Guest-1766969509951@guest.com', 'guest-123@guest.com']) {
      store[ZAI_AUTH_STORAGE_KEY] = authRecord(makeToken({ region: 'global', email }));

      await expect(loadZaiAuthFromStorage(undefined, CN_ORIGIN)).resolves.toMatchObject({
        token: expect.stringContaining('.'),
      });
    }
  });

  it('lets a non-guest address on another domain through', async () => {
    store[ZAI_AUTH_STORAGE_KEY] = authRecord(
      makeToken({ region: 'global', email: 'someone@notguest.example' }),
    );

    // 邮箱不是访客 ⇒ 照 region 判，仍然拒绝。
    await expect(loadZaiAuthFromStorage(undefined, CN_ORIGIN)).resolves.toBeNull();
  });

  it('lets an undecidable legacy token through', async () => {
    // 判不出归属时**放行**：代价只是「用了别站的 token → 401 → 该链降级」，
    // 而拦错会把国区站自己的登录态也挡掉。两害相权取误伤小的那一侧。
    for (const payload of [
      {},                                   // 没有 region
      { region: 'somewhere-else' },         // region 值不认识
      { region: 'cn', email: 42 },          // email 不是字符串
    ]) {
      store[ZAI_AUTH_STORAGE_KEY] = authRecord(makeToken(payload));
      await expect(loadZaiAuthFromStorage(undefined, CN_ORIGIN)).resolves.toMatchObject({
        token: expect.stringContaining('.'),
      });
    }

    // 连 JWT 形状都不是（单段）⇒ 解不出 claim ⇒ 同样放行。
    store[ZAI_AUTH_STORAGE_KEY] = authRecord('not-a-jwt');
    await expect(loadZaiAuthFromStorage(undefined, CN_ORIGIN)).resolves.toMatchObject({
      token: 'not-a-jwt',
    });
  });
});

describe('clearing wipes every bucket', () => {
  it('removes both site buckets and the legacy slot', async () => {
    store[CN_KEY] = authRecord('cn-token');
    store[GLOBAL_KEY] = authRecord('global-token');
    store[ZAI_AUTH_STORAGE_KEY] = authRecord('legacy-token');

    await clearZaiAuthFromStorage();

    expect(Object.keys(store)).toEqual([]);
  });
});

describe('the read deadline is orthogonal to the site argument', () => {
  it('gives up instead of hanging when storage never settles', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(() => new Promise(() => {})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
    });

    vi.useFakeTimers();
    try {
      const pending = loadZaiAuthFromStorage(AUTH_READ_TIMEOUT_MS, CN_ORIGIN);
      await vi.advanceTimersByTimeAsync(AUTH_READ_TIMEOUT_MS + 1);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('normalisation still rejects junk', () => {
  it('returns null for shapes without a usable token', () => {
    expect(normalizeZaiAuth(null)).toBeNull();
    expect(normalizeZaiAuth({ token: '' })).toBeNull();
    expect(normalizeZaiAuth('nope')).toBeNull();
  });
});