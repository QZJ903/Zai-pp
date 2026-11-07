import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationRecentRunsOptions,
  AutomationRunListOptions,
  AutomationStatus,
  AutomationUpdateInput,
} from '../../core/automation/types';
import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import { defineBackgroundPayloadRuntimeCommandHandler } from './runtime-handler';

type AutomationDomainFailure = { ok: false; error: string };

export interface AutomationRuntimeHandlerDependencies {
  getAllAutomations(): Promise<Automation[]>;
  getAutomationRuns(options: AutomationRunListOptions): Promise<AutomationRun[]>;
  getRecentAutomationRuns(options: AutomationRecentRunsOptions): Promise<Record<string, AutomationRun[]>>;
  createAutomation(input: AutomationCreateInput): Promise<Automation>;
  updateAutomation(id: string, patch: AutomationUpdateInput): Promise<Automation | null>;
  setAutomationStatus(id: string, status: AutomationStatus): Promise<Automation | null>;
  /**
   * 只写 `lastError: null`，**不碰 nextRunAt**。
   *
   * ⚠️ 与 `updateAutomation` 分开是因为它们的 patch 类型不同：
   * `lastError` 属 `AutomationRuntimeUpdate`，不在 `UPDATE_AUTOMATION` 的
   * patch 白名单里（那是用户编辑字段）。
   */
  clearAutomationError(id: string): Promise<Automation | null>;
  deleteAutomation(id: string): Promise<void>;
  refreshAutomationNextRunAt(id: string): Promise<Automation | null>;
  cancelActiveAutomationRun(id: string): void;
  runAutomationNow(id: string, excludeTabId?: number): Promise<AutomationRun | AutomationDomainFailure>;
  broadcastAutomationUpdate(excludeTabId?: number): Promise<void>;
  broadcastAutomationRunsUpdate(excludeTabId?: number): Promise<void>;
}

export function createAutomationRuntimeHandlers(
  dependencies: AutomationRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    definePayloadlessRuntimeCommandHandler('GET_AUTOMATIONS', () => (
      dependencies.getAllAutomations()
    )),
    defineBackgroundPayloadRuntimeCommandHandler('GET_AUTOMATION_RUNS', (payload) => (
      dependencies.getAutomationRuns(payload)
    )),
    defineBackgroundPayloadRuntimeCommandHandler('GET_AUTOMATION_RUNS_BATCH', (payload) => (
      dependencies.getRecentAutomationRuns(payload)
    )),
    defineBackgroundPayloadRuntimeCommandHandler('CREATE_AUTOMATION', async (input, context) => {
      const automation = await dependencies.createAutomation(input);
      const refreshed = await dependencies.refreshAutomationNextRunAt(automation.id);
      await dependencies.broadcastAutomationUpdate(context.tabId);
      return refreshed ?? automation;
    }),
    defineBackgroundPayloadRuntimeCommandHandler('UPDATE_AUTOMATION', async ({ id, patch }, context) => {
      const automation = await dependencies.updateAutomation(id, patch);
      if (!automation) return { ok: false as const, error: 'automation_not_found' };
      const refreshed = await dependencies.refreshAutomationNextRunAt(id);
      await dependencies.broadcastAutomationUpdate(context.tabId);
      return refreshed ?? automation;
    }),
    defineBackgroundPayloadRuntimeCommandHandler('SET_AUTOMATION_STATUS', async (request, context) => {
      if (!request.ok) return request;
      const automation = await dependencies.setAutomationStatus(request.id, request.status);
      if (!automation) return { ok: false as const, error: 'automation_not_found' };
      const refreshed = await dependencies.refreshAutomationNextRunAt(request.id);
      await dependencies.broadcastAutomationUpdate(context.tabId);
      return refreshed ?? automation;
    }),
    defineBackgroundPayloadRuntimeCommandHandler('DELETE_AUTOMATION', async ({ id }, context) => {
      dependencies.cancelActiveAutomationRun(id);
      await dependencies.deleteAutomation(id);
      await dependencies.broadcastAutomationUpdate(context.tabId);
      await dependencies.broadcastAutomationRunsUpdate(context.tabId);
      return { ok: true as const };
    }),
    /**
     * 清掉任务的失败记录（用户在卡片上按「关闭」）。
     *
     * ⚠️ **不能复用 `SET_AUTOMATION_STATUS`**：那条会连带 `refreshAutomationNextRunAt`，
     * 而它对「排期无效」的任务会**立刻把 schedule 错误写回 `lastError`** ——
     * 用户按了关闭、红条马上又出现。这里只写 `lastError: null`，不碰 nextRunAt。
     * ⚠️ 也不走 `UPDATE_AUTOMATION`：那个 patch 的白名单里没有 `lastError`
     * （它是运行期字段，不是用户编辑字段）。
     * ⚠️ **幂等**：任务不存在也回 `{ ok: true }`（契约族是 `ack`，没有域失败位；
     * 而「关掉一条已删任务的错误」本来就无事可做）。下一轮 `GET_AUTOMATIONS` 会把
     * 真实列表带回来，UI 不需要靠这条的返回值判断。
     */
    defineBackgroundPayloadRuntimeCommandHandler('CLEAR_AUTOMATION_ERROR', async ({ id }, context) => {
      await dependencies.clearAutomationError(id);
      await dependencies.broadcastAutomationUpdate(context.tabId);
      return { ok: true as const };
    }),
    defineBackgroundPayloadRuntimeCommandHandler('RUN_AUTOMATION_NOW', ({ id }, context) => (
      dependencies.runAutomationNow(id, context.tabId)
    )),
  ]);
}
