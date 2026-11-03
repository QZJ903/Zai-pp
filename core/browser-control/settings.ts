import { createSerialOperationQueue } from '../persistence/serial-operation-queue';
import {
  BROWSER_CONTROL_STORAGE_KEY,
  type BrowserControlSettings,
} from './types';

/**
 * 这一个存储键的写入串行队列。
 *
 * ⚠️⚠️ **`saveBrowserControlSettings` 是「读 → 合并 → 写」，必须串行** ——
 * 并发时后写者会拿自己的旧快照覆盖前者的改动。真实场景：`browser_navigate { newTab:true }`
 * 内部 `await saveBrowserControlSettings({ targetTabId })`，同时侧边栏
 * `savePatch({ maxSnapshotNodes })` ⇒ 先落地的那次被整条覆盖掉。
 * ⚠️ **按「一个存储键一条队列」建**，不要与 `keepalive-settings` 共用 ——
 * 两个键互不相干，共用一个队列只会把它们的写序耦合起来。
 */
const browserControlSettingsOperations = createSerialOperationQueue();

export const DEFAULT_BROWSER_CONTROL_SETTINGS: BrowserControlSettings = {
  enabled: false,
  targetTabId: null,
  includeSnapshotAfterActions: true,
  maxSnapshotNodes: 400,
  maxSnapshotTextBytes: 24_000,
};

const MIN_SNAPSHOT_NODES = 50;
const MAX_SNAPSHOT_NODES = 1_500;
const MIN_SNAPSHOT_TEXT_BYTES = 4_000;
/**
 * 快照文本预算的上界。
 *
 * ⚠️⚠️ **曾经是 80_000** —— 而进模型的 `detail` 在续跑模板里只裁 4_000 字符
 * （`core/zai/continuation.ts`），滑块 4_000–80_000 那一段约 5/6 的行程是零收益。
 * 实测：预算 4000 → 模型看到 3970 字符（99%）；预算 80000 → 模型看到 3970 字符（5%）。
 *
 * ⚠️ **现在取 24_000，不是 4_000** —— 因为 `browser_snapshot`（模型主动要的整页快照）
 * 在续跑模板里有一条**更宽的 24_000 字符**上限，动作后的快照仍只给 4_000。
 * 24_000 字节在中文页面上约 229 个节点、英文约 301 个，两者都装得进 24_000 字符的
 * detail 上限（中文 24000 字节 ≈ 8000 字符，英文 ≈ 24000 字符）。
 * ⚠️ **单位是字节**（见 `snapshot.ts` 的 `utf8Length`）—— 与 `maxResultBytes` 同单位，
 * 不要改回 `text.length`。
 * ⚠️ **别再抬回去**：`maxResultBytes`（`browser_snapshot` 声明 40_000）**已经有消费者了**
 * —— `core/tool/runtime.ts` 的 `applyResultByteBudget` 会按它裁 `detail`。现在 24000 字节
 * 的快照总载荷约 24_300 字节，**刚好卡在 40_000 那个声明之下**；抬到 40000 就会超掉声明，
 * 被那道预算从后面截一刀（截出来的还是一份残缺快照，比现在主动截断更糟）。
 */
const MAX_SNAPSHOT_TEXT_BYTES = 24_000;

export function normalizeBrowserControlSettings(input: unknown): BrowserControlSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_BROWSER_CONTROL_SETTINGS };
  }

  const partial = input as Partial<BrowserControlSettings>;
  return {
    enabled: partial.enabled === true,
    targetTabId: typeof partial.targetTabId === 'number' && Number.isInteger(partial.targetTabId)
      ? partial.targetTabId
      : null,
    includeSnapshotAfterActions: partial.includeSnapshotAfterActions !== false,
    maxSnapshotNodes: clampInteger(
      partial.maxSnapshotNodes,
      DEFAULT_BROWSER_CONTROL_SETTINGS.maxSnapshotNodes,
      MIN_SNAPSHOT_NODES,
      MAX_SNAPSHOT_NODES,
    ),
    maxSnapshotTextBytes: clampInteger(
      partial.maxSnapshotTextBytes,
      DEFAULT_BROWSER_CONTROL_SETTINGS.maxSnapshotTextBytes,
      MIN_SNAPSHOT_TEXT_BYTES,
      MAX_SNAPSHOT_TEXT_BYTES,
    ),
  };
}

export async function getBrowserControlSettings(): Promise<BrowserControlSettings> {
  const data = await chrome.storage.local.get(BROWSER_CONTROL_STORAGE_KEY) as Record<string, unknown>;
  return normalizeBrowserControlSettings(data[BROWSER_CONTROL_STORAGE_KEY]);
}

export async function saveBrowserControlSettings(
  patch: Partial<BrowserControlSettings>,
): Promise<BrowserControlSettings> {
  return updateBrowserControlSettingsWith(() => patch);
}

/**
 * **在读盘那一刻才决定改什么** —— 与 `saveBrowserControlSettings` 的区别只在时序。
 *
 * ⚠️⚠️ **它存在的唯一理由是「不能拿旧快照做写决策」**：
 * `closeTab` 尾部原来是 ``const settings = await getBrowserControlSettings()`` 之后
 * 中间 `await tabs.remove`，再用**开函数时读的** `settings.targetTabId` 判断要不要清空
 * ⇒ 若 `remove` 期间侧边栏把 target 改成了另一条标签，这里会把它**覆盖成 null**
 *（实测：target 12 → 关 12 期间改成 13 → 结果 null）。
 *
 * ⚠️ **`createPatch` 返回 `null` = 不写盘**，返回 `{}` = 按当前值重写一遍（幂等）。
 * 这个区分是从 `updateAutomationRuntimeWith`（`core/automation/store.ts`）借来的口径 ——
 * 那条修的是同一类缺陷（U2-4），两处保持同形。
 *
 * ⚠️ **必须在串行队列里求值** —— 读与写之间不能有别人插进来，否则「读到了新值、
 * 写的时候又被插队」的中间态照旧存在。`browserControlSettingsOperations` 保证这一点。
 */
export async function updateBrowserControlSettingsWith(
  createPatch: (current: BrowserControlSettings) => Partial<BrowserControlSettings> | null,
): Promise<BrowserControlSettings> {
  return browserControlSettingsOperations.run(async () => {
    const current = await getBrowserControlSettings();
    const patch = createPatch(current);
    if (patch === null) return current;
    const next = normalizeBrowserControlSettings({ ...current, ...patch });
    await chrome.storage.local.set({ [BROWSER_CONTROL_STORAGE_KEY]: next });
    return next;
  });
}

export async function setBrowserControlEnabled(enabled: boolean): Promise<BrowserControlSettings> {
  return saveBrowserControlSettings({ enabled });
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
