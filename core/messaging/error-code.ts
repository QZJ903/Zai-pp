/**
 * 「这个字符串是一个错误码」而不是自然语言句子。
 *
 * 判据刻意收得很紧：**全小写、无空格、无标点**。
 * ⚠️ **单个小写词也算码**（`busy` / `cancelled` 就是本仓真实存在的单码）——
 * 不能要求「必须含下划线」。
 * ⚠️ **英文句子必须原样放行** —— 那批人写的句子
 * （`Automation run exceeded 300 seconds.`）比任何通用兜底文案都有信息量。
 * 句子带大写首字母与空格，天然不匹配这条正则。
 *
 * ⚠️⚠️ **三处消费者共用这一份**：自动化失败卡片、侧边栏通用失败提示、
 * 工具结果卡片（内容脚本）。各写一份必然分叉，而分叉时没有报错。
 * 放在 `core/` 是因为第三个消费者在内容脚本的 bundle 里，引不到 `entrypoints/`。
 */
const LOOKS_LIKE_ERROR_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function looksLikeErrorCode(value: string): boolean {
  return LOOKS_LIKE_ERROR_CODE.test(value);
}