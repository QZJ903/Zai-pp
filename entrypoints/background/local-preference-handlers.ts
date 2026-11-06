import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import type {
  BackgroundConfig,
} from '../../core/types';
import {
  definePersistencePayloadRuntimeCommandHandler,
} from './runtime-handler';

/**
 * 「本机偏好」这一组命令（背景配置）。
 *
 * ⚠️⚠️ **本组只发 `BACKGROUND_UPDATED`，不刷 `STATE_UPDATED`，这是有意的。**
 * `STATE_UPDATED` 的载荷是记忆 / 技能 / 预设 / 提示词设置 / 技能自动激活五项，
 * **不含背景配置**；背景的唯一通道就是这里这条 `BACKGROUND_UPDATED`
 * （内容脚本的 `BACKGROUND_UPDATED` 分支直接 `applyBackground`，侧边栏走 `GET_BACKGROUND` 重读）。
 * ⇒ 想「顺手把状态也刷一下」的念头是多余的：那条广播里没有背景字段可刷。
 * 真要加，得同时改 `broadcastStateUpdate` 的载荷与两个消费端，不是在依赖里补一个位就完事。
 */
export interface LocalPreferenceRuntimeHandlerDependencies {
  getBackgroundConfig(): Promise<BackgroundConfig | null>;
  saveBackgroundConfig(config: BackgroundConfig): Promise<void>;
  clearBackgroundConfig(): Promise<void>;
  broadcastBackgroundUpdate(config: BackgroundConfig | null): Promise<void>;
}

export function createLocalPreferenceRuntimeHandlers(
  dependencies: LocalPreferenceRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    definePayloadlessRuntimeCommandHandler('GET_BACKGROUND', () => (
      dependencies.getBackgroundConfig()
    )),
    definePersistencePayloadRuntimeCommandHandler('SAVE_BACKGROUND', async (config) => {
      await dependencies.saveBackgroundConfig(config);
      await dependencies.broadcastBackgroundUpdate(config);
      return { ok: true as const };
    }),
    definePayloadlessRuntimeCommandHandler('CLEAR_BACKGROUND', async () => {
      await dependencies.clearBackgroundConfig();
      await dependencies.broadcastBackgroundUpdate(null);
      return { ok: true as const };
    }),
  ]);
}