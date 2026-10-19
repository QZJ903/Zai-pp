import { describe, expect, it } from 'vitest';
import { buildPromptAugmentation } from '../core/prompt';
import { translate } from '../core/i18n/background';
import {
  createWebSearchToolDescriptors,
  createWebSearchToolProviderIdentity,
  isExtensionWebToolDescriptor,
} from '../core/tool/web-search';
import type { ToolDescriptor } from '../core/tool/types';

/**
 * 联网搜索引导的**注入判据**。
 *
 * `renderWebSearchGuidance` 的第二个门是「目录里有没有 web_search」，而这段引导讲的是
 * 「输出 web_search 工具调用、结果会自动回传给你」—— **只对扩展自带的联网成立**。
 * 第三方 MCP 服务完全可以暴露一个恰好叫 `web_search` 的工具，那与我们的联网策略无关；
 * 按名字判会把这段扩展专属的引导**误注入**给它（模型会照着我们写的流程期待一个
 * 根本不存在的结果回传通道）。
 *
 * ⚠️ 这个判据与**模型侧裁剪**（`core/zai/model-facing.ts`）问的是同一个问题，
 * 必须**同源** —— 两边各自写一遍时，一边改了另一边不会报错，表现是
 * 「工具已被裁掉、引导却还在注入」（或反过来）。
 */

const WEB_PROVIDER = createWebSearchToolProviderIdentity('en');

/** 第三方 MCP 服务暴露的、恰好同名的工具。 */
function mcpLookalike(name: 'web_search' | 'web_fetch'): ToolDescriptor {
  return {
    id: `mcp:browser-tools:${name}`,
    provider: {
      kind: 'mcp',
      id: 'browser-tools',
      displayName: 'Browser Tools',
      transport: 'streamable_http',
    },
    name,
    invocationName: `browser_tools_${name}`,
    title: name,
    description: `${name} exposed by a third-party MCP server.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}

function renderPrompt(descriptors: readonly ToolDescriptor[], locale: 'zh-CN' | 'en'): string {
  return buildPromptAugmentation('帮我查一下最新的消息。', {
    memories: [],
    toolDescriptors: descriptors,
    locale,
  }).augmented;
}

describe('web search guidance injection', () => {
  const guidanceZh = translate('zh-CN', 'prompt.webSearchGuidance');
  const guidanceEn = translate('en', 'prompt.webSearchGuidance');

  // ⚠️⚠️ **站点只剩 agent 模式（2026-10-19）后，这段引导恒不注入** ——
  // agent 的联网由服务端沙箱承担，扩展自带的 web 工具在模型目录里被恒裁
  // （`core/zai/model-facing.ts`），引导自然不该出现。
  // ⇒ 下面三条把「无论目录里有什么，都不注入」钉死。

  it('never injects the guidance even when the extension-owned web tools are in the catalog', () => {
    const descriptors = createWebSearchToolDescriptors('zh-CN');
    // 前置事实：这几条描述符**仍然**被判成扩展自带（那是 provider 契约判据，没变）。
    expect(descriptors.every(isExtensionWebToolDescriptor)).toBe(true);

    const zh = renderPrompt(descriptors, 'zh-CN');
    expect(zh).not.toContain(guidanceZh);
    // 场景自检：目录本身**是**进了提示词的 —— 否则「没注入引导」只是因为工具都没列，
    // 这条用例就退化成「什么都不注入也通过」。
    expect(zh).toContain('web_search');
    expect(renderPrompt(descriptors, 'en')).not.toContain(guidanceEn);
  });

  it('does not inject the guidance for a third-party tool that merely shares the name', () => {
    const lookalike = mcpLookalike('web_search');
    // 前置事实：它**不是**扩展自带的 —— 若判据退化成「按名字」，这里先红。
    expect(isExtensionWebToolDescriptor(lookalike)).toBe(false);

    const prompt = renderPrompt([lookalike], 'zh-CN');
    expect(prompt).not.toContain(guidanceZh);
    // 场景自检：目录本身**是**进了提示词的（否则这条用例退化成「什么都不注入也通过」）。
    expect(prompt).toContain('browser_tools_web_search');
  });

  it('does not inject the guidance when the extension tools are present alongside a lookalike', () => {
    const descriptors = [
      ...createWebSearchToolDescriptors('zh-CN'),
      mcpLookalike('web_search'),
    ];
    // 同名工具混在一起时，provider 判据仍按**各自**的 provider 分别得出结果。
    expect(descriptors.map(isExtensionWebToolDescriptor)).toEqual([true, true, false]);

    expect(renderPrompt(descriptors, 'zh-CN')).not.toContain(guidanceZh);
  });

  it('judges the extension web tools by provider contract, not by name alone', () => {
    // 直接钉住判据本体：同一个名字，provider 不同 → 结论不同。
    // ⚠️ 这条判据**仍然承重** —— 模型侧裁剪（`core/zai/model-facing.ts`）用它区分
    // 「扩展自带的 web 工具」（恒裁）与「第三方 MCP 的同名工具」（不裁）。
    const own: ToolDescriptor = {
      ...mcpLookalike('web_search'),
      provider: WEB_PROVIDER,
      invocationName: 'web_search',
    };
    expect(isExtensionWebToolDescriptor(own)).toBe(true);
    expect(isExtensionWebToolDescriptor(mcpLookalike('web_search'))).toBe(false);
    // 名字对但 provider id 不同（同 kind）也不能算 —— 判据是两个字段一起比。
    expect(isExtensionWebToolDescriptor({
      ...own,
      provider: { ...WEB_PROVIDER, id: 'web-other' },
    })).toBe(false);
  });
});