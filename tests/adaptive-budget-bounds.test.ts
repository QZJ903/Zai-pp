import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MCP_CAPABILITY_SETTINGS,
  MAX_ADAPTIVE_DIRECT_TOOLS,
  MAX_ADAPTIVE_PROMPT_BYTES,
  MIN_ADAPTIVE_DIRECT_TOOLS,
  MIN_ADAPTIVE_PROMPT_BYTES,
  decodeMcpCapabilitySettings,
} from '../core/mcp/capability-settings';

/**
 * 自适应预算的上下界**只有一份**，而两侧都必须真的用它。
 *
 * ⚠️⚠️ 守的是一个静默分叉：UI 曾经手抄了 `1 / 64 / 2_000 / 256_000` 四个数字。
 * 两侧一旦不一致：
 * - 放宽后台区间 ⇒ UI 仍然拒绝新值（用户看到「数值无效」而配置其实合法）；
 * - 收窄后台区间 ⇒ UI 放行后 `boundedInteger` 抛 `mcp_capability_settings_corrupt`
 *   ⇒ 读设置整条失败 ⇒ **整个 MCP 页只剩一条错误横幅**。
 *
 * ⚠️ 判据分两半：
 * ① **行为**：后台解码在边界上收、越界即拒（这是「区间本身」的定义）；
 * ② **源码**：UI 的文件里不许再出现那四个数字的字面量 —— 它必须走 import。
 * 只做 ① 抓不到「UI 又抄了一份」，只做 ② 抓不到「常量本身被改坏」。
 */

describe('adaptive budget bounds', () => {
  const settings = (patch: Record<string, number>) => ({
    version: DEFAULT_MCP_CAPABILITY_SETTINGS.version,
    adaptiveMaxDirectTools: DEFAULT_MCP_CAPABILITY_SETTINGS.adaptiveMaxDirectTools,
    adaptiveMaxPromptBytes: DEFAULT_MCP_CAPABILITY_SETTINGS.adaptiveMaxPromptBytes,
    servers: {},
    ...patch,
  });

  it('accepts both ends of the range and rejects one step outside', () => {
    expect(() => decodeMcpCapabilitySettings(settings({
      adaptiveMaxDirectTools: MIN_ADAPTIVE_DIRECT_TOOLS,
      adaptiveMaxPromptBytes: MIN_ADAPTIVE_PROMPT_BYTES,
    }))).not.toThrow();

    expect(() => decodeMcpCapabilitySettings(settings({
      adaptiveMaxDirectTools: MAX_ADAPTIVE_DIRECT_TOOLS,
      adaptiveMaxPromptBytes: MAX_ADAPTIVE_PROMPT_BYTES,
    }))).not.toThrow();

    expect(() => decodeMcpCapabilitySettings(settings({
      adaptiveMaxDirectTools: MIN_ADAPTIVE_DIRECT_TOOLS - 1,
    }))).toThrow();
    expect(() => decodeMcpCapabilitySettings(settings({
      adaptiveMaxDirectTools: MAX_ADAPTIVE_DIRECT_TOOLS + 1,
    }))).toThrow();
    expect(() => decodeMcpCapabilitySettings(settings({
      adaptiveMaxPromptBytes: MIN_ADAPTIVE_PROMPT_BYTES - 1,
    }))).toThrow();
    expect(() => decodeMcpCapabilitySettings(settings({
      adaptiveMaxPromptBytes: MAX_ADAPTIVE_PROMPT_BYTES + 1,
    }))).toThrow();
  });

  it('keeps the MCP form from hand-copying those four numbers', () => {
    const source = readFileSync('entrypoints/sidepanel/pages/McpPage.tsx', 'utf8');
    // 去掉注释再判 —— 解释性注释里会写这些数字，那不算手抄。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // ⚠️ 只认**这几个字段的上下界**那两处写法，不能裸 grep `2000` ——
    // `discoveryMs: '20000'` 里就含它（第一版就是这么假红的）。
    const forbidden = [
      /min="1"[\s\S]{0,80}?max="64"/,          // 直接工具数
      /min="2000"[\s\S]{0,80}?max="256000"/,   // Schema 字节数
      /<\s*1\s*\|\|/,                          // adaptiveMaxDirectTools < 1
      />\s*64\s*\|\|/,                         // adaptiveMaxDirectTools > 64
      /<\s*2_000\s*\|\|/,                      // adaptiveMaxPromptBytes < 2_000
      />\s*256_000\b/,                         // adaptiveMaxPromptBytes > 256_000
    ];
    for (const pattern of forbidden) {
      expect(code, `McpPage 里仍手抄了边界字面量：${pattern}`).not.toMatch(pattern);
    }
    // 正面：四个常量真的被 import 进来并用了。
    for (const name of [
      'MIN_ADAPTIVE_DIRECT_TOOLS',
      'MAX_ADAPTIVE_DIRECT_TOOLS',
      'MIN_ADAPTIVE_PROMPT_BYTES',
      'MAX_ADAPTIVE_PROMPT_BYTES',
    ]) {
      expect(code).toContain(name);
    }
  });
});