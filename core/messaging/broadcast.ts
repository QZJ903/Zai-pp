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

export function isExpectedMissingRuntimeMessageReceiverError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'Receiving end does not exist',
    'The message port closed before a response was received',
    'No tab with id',
  ].some((fragment) => message.includes(fragment));
}
