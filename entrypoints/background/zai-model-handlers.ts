import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import type { ZaiModelList } from '../../core/zai/models';

export interface ZaiModelRuntimeHandlerDependencies {
  getModelList(): Promise<ZaiModelList>;
}

/** z.ai 模型清单（自动化表单的模型下拉数据源，带缓存与内置兜底）。站点由抓取器决定。 */
export function createZaiModelRuntimeHandlers(
  dependencies: ZaiModelRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    definePayloadlessRuntimeCommandHandler('GET_ZAI_MODELS', () => (
      dependencies.getModelList()
    )),
  ]);
}
