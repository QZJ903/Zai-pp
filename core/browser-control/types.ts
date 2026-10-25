import type { ToolProviderIdentity } from '../tool/types';

export const BROWSER_CONTROL_STORAGE_KEY = 'zai_pp_browser_control_settings';

export const BROWSER_CONTROL_TOOL_PROVIDER_ID = 'browser_control';

export const BROWSER_CONTROL_TOOL_NAMES = [
  'browser_navigate',
  'browser_go_back',
  'browser_go_forward',
  'browser_refresh',
  'browser_list_tabs',
  'browser_select_tab',
  'browser_close_tab',
  'browser_snapshot',
  'browser_click',
  'browser_hover',
  'browser_fill',
  'browser_fill_form',
  'browser_key',
  'browser_type',
  'browser_attach_file',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_evaluate_script',
] as const;

export type BrowserControlToolName = typeof BROWSER_CONTROL_TOOL_NAMES[number];

export const BROWSER_CONTROL_TOOL_SET = new Set<string>(BROWSER_CONTROL_TOOL_NAMES);

export const BROWSER_CONTROL_PROVIDER: ToolProviderIdentity = {
  kind: 'local',
  id: BROWSER_CONTROL_TOOL_PROVIDER_ID,
  displayName: 'Browser Control',
  transport: 'in_process',
};

export interface BrowserControlSettings {
  enabled: boolean;
  targetTabId: number | null;
  includeSnapshotAfterActions: boolean;
  maxSnapshotNodes: number;
  maxSnapshotTextBytes: number;
}

export interface BrowserControlTarget {
  id: number;
  windowId: number;
  groupId: number;
  groupName?: string;
  active: boolean;
  currentWindow: boolean;
  title: string;
  url: string;
  controllable: boolean;
  reason?: string;
}

export interface BrowserControlState {
  supported: boolean;
  enabled: boolean;
  attached: boolean;
  targetTabId: number | null;
  target: BrowserControlTarget | null;
  targets: BrowserControlTarget[];
  error: string | null;
}

export interface BrowserActionResult {
  ok: boolean;
  summary: string;
  detail?: string;
  output?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  snapshot?: BrowserSnapshotResult;
}

export interface BrowserSnapshotNode {
  uid: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  disabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  checked?: boolean | 'mixed';
  level: number;
  backendDOMNodeId?: number;
}

export interface BrowserSnapshotResult {
  url: string;
  title: string;
  text: string;
  nodes: BrowserSnapshotNode[];
  truncated: boolean;
}

export interface BrowserDialogState {
  type: string;
  message: string;
  defaultPrompt?: string;
  seenAt: number;
}

export interface BrowserControlDependencies {
  chromeApi?: typeof chrome;
  now?: () => number;
  /**
   * 续跑保活会话（只读它的「这条标签有没有被我保活着」）。
   *
   * 默认用模块级单例；注入口只为可测性存在 —— 单例在模块加载时就把 `chrome` 抓走了，
   * 而测试是加载之后才 `vi.stubGlobal` 的，没法通过它造出「正保活着某个标签」的状态。
   *
   * ⚠️ **判据是 `isKeepingAlive(tabId)`，不是「有没有唯一那条」** —— 保活是**按标签**
   * 的（并发跑两个自动化时同时挂着两条），见 `tab-keepalive.ts` 的文件头。
   */
  tabKeepAlive?: { isKeepingAlive(tabId: number): boolean };
}
