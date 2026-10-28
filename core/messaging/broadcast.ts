export interface RuntimeBroadcastTab {
  id?: number | null;
}

export interface RuntimeBroadcastDependencies {
  tabUrlPattern: string;
  /** 除 tabUrlPattern 外，额外参与广播的 tab URL 匹配模式。 */
  additionalTabUrlPatterns?: readonly string[];
  sendRuntimeMessage(payload: Record<string, unknown>): Promise<unknown>;
  queryTabsByUrl(urlPattern: string): Promise<readonly RuntimeBroadcastTab[]>;
  sendTabMessage(tabId: number, payload: Record<string, unknown>): Promise<unknown>;
  reportError(code: string, error: unknown): void;
}

export async function broadcastRuntimeUpdate(
  payload: Record<string, unknown>,
  excludeTabId: number | undefined,
  dependencies: RuntimeBroadcastDependencies,
): Promise<void> {
  deliverRuntimeMessageBestEffort(
    dependencies.sendRuntimeMessage(payload),
    'broadcast_runtime_delivery_failed',
    dependencies.reportError,
  );

  const patterns = [dependencies.tabUrlPattern, ...(dependencies.additionalTabUrlPatterns ?? [])];
  let tabs: RuntimeBroadcastTab[] = [];
  for (const pattern of patterns) {
    try {
      const matched = await dependencies.queryTabsByUrl(pattern);
      tabs.push(...matched);
    } catch (error) {
      dependencies.reportError('broadcast_tabs_query_failed', error);
    }
  }
  if (tabs.length === 0) {
    if (excludeTabId) {
      deliverRuntimeMessageBestEffort(
        dependencies.sendTabMessage(excludeTabId, payload),
        'broadcast_tab_delivery_failed',
        dependencies.reportError,
      );
    }
    return;
  }

  // 去重（同一 tab 可能被多个 pattern 命中）。
  const seen = new Set<number>();
  for (const tab of tabs) {
    if (typeof tab.id === 'number' && tab.id !== excludeTabId && !seen.has(tab.id)) {
      seen.add(tab.id);
      deliverRuntimeMessageBestEffort(
        dependencies.sendTabMessage(tab.id, payload),
        'broadcast_tab_delivery_failed',
        dependencies.reportError,
      );
    }
  }
  if (excludeTabId) {
    deliverRuntimeMessageBestEffort(
      dependencies.sendTabMessage(excludeTabId, payload),
      'broadcast_tab_delivery_failed',
      dependencies.reportError,
    );
  }
}

export function deliverRuntimeMessageBestEffort(
  delivery: Promise<unknown>,
  errorCode: string,
  reportError: RuntimeBroadcastDependencies['reportError'],
): void {
  void delivery.catch((error) => {
    if (isExpectedMissingRuntimeMessageReceiverError(error)) return;
    reportError(errorCode, error);
  });
}

/**
 * 「这个标签页里没有活着的内容脚本」—— `chrome.tabs.sendMessage` 抛的就是它。
 *
 * ⚠️ **与下面那条宽松判据分开**：`message port closed` 是「接收端在、但没在应答前
 * 保持住端口」，`No tab with id` 是「标签页已经没了」。三者的处置完全不同
 * （前者是内容脚本缺失、中者是响应超时、后者该换标签），合并成一个判据会让调用方
 * 无法区分该刷新页面还是该重挑标签。
 */
const MISSING_RECEIVER_FRAGMENTS = ['Receiving end does not exist'] as const;

/** 接收端**根本不存在**（内容脚本未注入 / 扩展重载后成了孤儿）。 */
export function isMissingRuntimeMessageReceiverError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return MISSING_RECEIVER_FRAGMENTS.some((fragment) => message.includes(fragment));
}

/**
 * 广播场景下「预期内的投递失败」—— 不必报错的那几类。
 *
 * ⚠️ **判据从 `MISSING_RECEIVER_FRAGMENTS` 派生**，不另抄一遍：两处各写一份字面量时，
 * 改一处另一处不报错，只会让某类失败突然开始刷日志（或反过来被静默吞掉）。
 */
export function isExpectedMissingRuntimeMessageReceiverError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    ...MISSING_RECEIVER_FRAGMENTS,
    'The message port closed before a response was received',
    'No tab with id',
  ].some((fragment) => message.includes(fragment));
}
