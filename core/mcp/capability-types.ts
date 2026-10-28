import type { ToolDescriptor } from '../tool/types';

export const MCP_CAPABILITY_EXPOSURE_MODES = [
  'direct',
  'adaptive',
  'on_demand',
] as const;

export type McpCapabilityExposureMode = typeof MCP_CAPABILITY_EXPOSURE_MODES[number];

export const MCP_CAPABILITY_SETTINGS_VERSION = 1 as const;

export interface McpCapabilityServerSettings {
  mode: McpCapabilityExposureMode;
  pinnedDescriptorIds: string[];
}

/**
 * This is deliberately separate from the MCP server/cache record. Exposure
 * affects only the model-facing projection; server enablement, allowlists and
 * execution policy remain the authoritative execution policy in MCP storage.
 */
export interface McpCapabilitySettings {
  version: typeof MCP_CAPABILITY_SETTINGS_VERSION;
  adaptiveMaxDirectTools: number;
  adaptiveMaxPromptBytes: number;
  servers: Record<string, McpCapabilityServerSettings>;
}

export interface McpCapabilitySettingsPatch {
  adaptiveMaxDirectTools?: number;
  adaptiveMaxPromptBytes?: number;
}

export interface McpCapabilityProjection {
  /**
   * 本轮投给模型的目录。
   *
   * ⚠️ **生产代码唯一读的字段**（`background.ts` 的 `getPromptToolDescriptors`
   * 只取 `.descriptors`）。
   */
  descriptors: ToolDescriptor[];
  /**
   * ⚠️⚠️ **以下三个字段生产零消费者，是「测试的观察面」，不是死字段。**
   *
   * 它们只被 `tests/mcp-capability-projection.test.ts` 读来验证**投影的中间决策**：
   * - `directDescriptorIds`：本轮直投的是谁。`descriptors` 验不出「直投 vs 隐藏」的区别
   *   （两者都在或都不在 `descriptors` 里，位置不同但断言读不出成因）。
   * - `hiddenDescriptorIds`：被隐藏的是谁。`descriptors` 只能验「不含」，
   *   而「不含」有两个成因（被隐藏 / 压根没进候选），区分不出来。
   * - `usesCatalog`：是否走了能力目录（三个 helper 有没有被追加）。
   *
   * ⚠️ **删它们 = 删掉那两条用例的判别力**（adapt 模式的「pinned 直投 / 未 pin 隐藏」、
   * on_demand 模式的「隐藏集合恰好是谁」）。产物里已被 tree-shake，删了只省约 100 字节，
   * 而那 100 字节不在任何尺寸门禁里。
   */
  directDescriptorIds: string[];
  hiddenDescriptorIds: string[];
  usesCatalog: boolean;
}
