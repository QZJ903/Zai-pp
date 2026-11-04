import type { TrustedToolExecutionContext } from '../../core/tool/types';

/**
 * 后台自己发起工具调用时用的身份对象。
 *
 * ⚠️ **`executeToolCall` 的第二参只收 `RuntimeToolAuthorizationContext`** ——
 * 它曾经还接受一个裸的 trigger 字符串，那是个便利入口：拿字符串就地构造一份
 * trusted 上下文。现在那条路删了（生产从来没有这样调用过，而它自带一份与生产
 * 不同规则的 `requestId` 回落），测试也跟着走生产形状。
 *
 * ⚠️ **`requestId` 必须给** —— 它是 tool capability scope 的 `scopeId` 兜底，
 * 缺了 `createRuntimeCapabilityScope` 会抛「missing its authorized request identity」。
 */
export function trustedContext(
  trigger: TrustedToolExecutionContext['trigger'],
  overrides: Partial<TrustedToolExecutionContext> = {},
): TrustedToolExecutionContext {
  return {
    kind: 'trusted',
    trigger,
    requestId: 'test-request',
    ...overrides,
  };
}
