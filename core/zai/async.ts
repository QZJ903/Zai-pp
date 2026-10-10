/**
 * z.ai 层的异步原语。
 */

/** 等待 `ms` 毫秒（内容脚本与 DOM 任务协调器共用，避免两份逐字节相同的实现）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}