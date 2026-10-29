import { describe, expect, it } from 'vitest';
import {
  TOOL_SCHEMA_JOINER_BYTES,
  measureToolHintBytes,
  measureToolSchemaBytes,
  renderToolSchemas,
} from '../core/prompt';
import { projectMcpCapabilityDescriptors } from '../core/mcp/capability-projection';
import { createMcpCapabilityToolDescriptors } from '../core/mcp/capability-tools';
import { createToolInvocationCatalog } from '../core/tool/invocation';
import { normalizeMcpToolDescriptor, type McpServerConfig, type McpToolDefinition } from '../core/mcp';
import { SHELL_TOOL_NAMES } from '../core/shell/contracts';
import type { McpCapabilitySettings } from '../core/types';

/**
 * **adaptive 的字节预算闸门量的是真值，不是估算。**
 *
 * ⚠️⚠️ **原先的估算器实测系统性高估 2–3 倍**：它按「描述符文本 + schema×2 + 固定 1024」
 * 算，而实际渲染里示例 payload 只有 required 字段的短值（远小于一整份 schema），
 * 每个描述符的框架开销只有 40–213 字节（不是 1024）。
 * 后果是**预算闸门严重偏保守**：默认 24000 下只放出 13/40 个工具，而按真实字节能放 31 个
 * ⇒ 模型「不知道有这些工具」，且不报错。
 *
 * ⚠️ **判据是真等号**（`measure*` 之和 === `renderToolSchemas` 的字节数），不是不等式 ——
 * 不等式只能守住「不低估」，高估多少都照样绿，那正是原断言放过这个缺陷的原因。
 */

function server(id: string, kind: 'native' | 'http'): McpServerConfig {
  return {
    version: 1,
    id,
    displayName: id,
    enabled: true,
    transport: kind === 'native'
      ? { kind: 'native_messaging', nativeHost: 'com.zai_pp.shell' }
      : { kind: 'streamable_http', url: 'https://example.test/mcp' },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 5_000, requestMs: 60_000, discoveryMs: 10_000 },
    limits: { maxResultBytes: 128_000, maxToolCount: 64 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'ready',
    lastConnectedAt: 0,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function tool(name: string, fields = 5): McpToolDefinition {
  return {
    name,
    title: name,
    description: `${name} does something useful`,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: fields }, (_, i) => [
        `f${i}`,
        { type: 'string', description: `field ${i}` },
      ])),
      required: Array.from({ length: fields }, (_, i) => `f${i}`),
      additionalProperties: false,
    },
    annotations: { risk: 'low' },
  };
}

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

function adaptiveSettings(serverId: string, maxBytes: number): McpCapabilitySettings {
  return {
    version: 1,
    adaptiveMaxDirectTools: 64,
    adaptiveMaxPromptBytes: maxBytes,
    servers: { [serverId]: { mode: 'adaptive', pinnedDescriptorIds: [] } },
  };
}

describe('adaptive budget measures rendered bytes exactly', () => {
  it('per-descriptor measurement sums to the batch render byte-for-byte', () => {
    // ⚠️ catalog 必须按整批建：同名工具会被加上 `mcp_<serverId>_` 前缀，
    // 用单元素 catalog 量出来的名字更短、总和会偏小。
    const descriptors = [
      normalizeMcpToolDescriptor(server('srv', 'http'), tool('alpha')),
      normalizeMcpToolDescriptor(server('srv', 'http'), tool('beta')),
    ];
    const catalog = createToolInvocationCatalog(descriptors);

    const measured = descriptors
      .reduce((total, descriptor) => total + measureToolSchemaBytes(descriptor, catalog), 0)
      + TOOL_SCHEMA_JOINER_BYTES;

    expect(measured).toBe(bytes(renderToolSchemas(descriptors, 'en')));
  });

  it('keeps the adaptive subset inside the budget', () => {
    const helpers = createMcpCapabilityToolDescriptors('en');
    const tools = Array.from({ length: 40 }, (_, index) => (
      normalizeMcpToolDescriptor(server('big', 'http'), tool(`tool_${index}`))
    ));
    const budget = 24_000;

    const projection = projectMcpCapabilityDescriptors({
      descriptors: [...helpers, ...tools],
      settings: adaptiveSettings('big', budget),
      intent: 'tool',
      locale: 'en',
    });
    const shown = projection.descriptors.filter((descriptor) => descriptor.provider.id === 'big');
    const catalog = createToolInvocationCatalog(projection.descriptors);
    const adaptiveBytes = shown
      .reduce((total, descriptor) => total + measureToolSchemaBytes(descriptor, catalog)
        + TOOL_SCHEMA_JOINER_BYTES, 0)
      + measureToolHintBytes(projection.descriptors, 'en');

    expect(shown.length).toBeGreaterThan(0);
    expect(adaptiveBytes, `adaptive 子集 ${adaptiveBytes} 字节超出预算 ${budget}`)
      .toBeLessThanOrEqual(budget);
    // ⚠️ 反面自检：若闸门退回旧的估价口径，这条会掉到 13 附近。
    expect(shown.length, '预算闸门不该只放出零星几个工具').toBeGreaterThan(25);
  });

  it('counts the native shell hint once, not per descriptor', () => {
    const helpers = createMcpCapabilityToolDescriptors('en');
    const names = ['shell_exec', 'shell_status', 'local_file_read'];
    // ⚠️ **两个 server id 必须等长** —— 工具名会带 `mcp_<serverId>_` 前缀，
    // 长度不等会让每个工具差几个字节，把 hint 的差值算歪（实测差 3 字节）。
    const nativeTools = names.map((name) => (
      normalizeMcpToolDescriptor(server('srvnat', 'native'), tool(name, 1))
    ));
    // 对照组用**同名**的第三方工具：schema 逐字相同，唯一差别是 transport
    // ⇒ 渲染字节之差就是 hint 那几段，其余全抵消。
    const httpTools = names.map((name) => (
      normalizeMcpToolDescriptor(server('srvhtt', 'http'), tool(name, 1))
    ));

    const nativeHint = measureToolHintBytes([...helpers, ...nativeTools], 'en');
    const httpHint = measureToolHintBytes([...helpers, ...httpTools], 'en');
    const actualDelta = bytes(renderToolSchemas([...helpers, ...nativeTools], 'en'))
      - bytes(renderToolSchemas([...helpers, ...httpTools], 'en'));

    expect(nativeHint, 'native 目录应当带出 hint 字节').toBeGreaterThan(0);
    expect(httpHint, '第三方目录不该带 hint').toBe(0);
    // 真等号：量出来的 hint 字节数必须与「实际渲染之差」逐字节相等。
    expect(nativeHint).toBe(actualDelta);

    // ⚠️ **hint 是「整批一次」，不是「每个描述符一次」** —— 三个 native 工具渲染出来
    // 只有一个 `### Shell MCP Capability` 标题（`locale: 'en'`）。若按描述符累加，
    // 标题会出现三次、字节数翻倍。
    const headings = renderToolSchemas([...helpers, ...nativeTools], 'en')
      .split('\n')
      .filter((line) => line.trim() === '### Shell MCP Capability');
    expect(headings).toHaveLength(1);
  });

  it('reserves the hint bytes before spending the budget on native tools', () => {
    // ⚠️ **这条专治「hint 忘了扣」** —— 上面那条用的是第三方工具（hint 为 0），
    // 把扣 hint 的那行删掉它照样绿。这里换成 native 工具，并让预算卡在
    // 「不扣 hint 刚好装得下、扣了就装不下」的区间。
    const helpers = createMcpCapabilityToolDescriptors('en');
    // ⚠️ 必须有一个叫 `shell_exec` —— hint 是由「目录里有没有它」触发的，
    // 全是 `tool_N` 的话 hint 为 0，这条用例就退化成空断言。
    const nativeTools = [
      normalizeMcpToolDescriptor(server('shellsvr', 'native'), tool('shell_exec', 1)),
      ...Array.from({ length: 11 }, (_, index) => (
        normalizeMcpToolDescriptor(server('shellsvr', 'native'), tool(`tool_${index}`, 1))
      )),
    ];
    const budget = 4_000;
    const allDescriptors = [...helpers, ...nativeTools];

    const projection = projectMcpCapabilityDescriptors({
      descriptors: allDescriptors,
      settings: adaptiveSettings('shellsvr', budget),
      intent: 'tool',
      locale: 'en',
    });
    const shown = projection.descriptors.filter((descriptor) => descriptor.provider.id === 'shellsvr');
    const catalog = createToolInvocationCatalog(projection.descriptors);
    // ⚠️ 分隔符按「n 个工具之间只有 n-1 个」算 —— 实现用的就是这个口径（见
    // `selectAdaptiveDescriptors` 里 `selected.length > 0 ?` 那一半）。
    const schemasBytes = shown
      .reduce((total, descriptor) => total + measureToolSchemaBytes(descriptor, catalog), 0)
      + Math.max(0, shown.length - 1) * TOOL_SCHEMA_JOINER_BYTES;
    // ⚠️ **hint 按「边际量」算**：整批 hint − 不含 adaptive 那批时的 hint。
    // 这个场景 helpers 里没有 native 工具，所以边际量就是整段 hint。
    const hintBytes = measureToolHintBytes(allDescriptors, 'en')
      - measureToolHintBytes(helpers, 'en');
    const total = schemasBytes + hintBytes;

    expect(shown.length, '不该选出 0 个（兜底至少给一条）').toBeGreaterThan(0);
    expect(hintBytes, 'native 目录必须带出 hint 字节').toBeGreaterThan(1_000);
    // 真判据：**schema + hint 一起**才算这批占了预算
    expect(total, `adaptive 子集 ${schemasBytes} + hint ${hintBytes} 超出预算 ${budget}`)
      .toBeLessThanOrEqual(budget);
    // ⚠️ **反面自检：不扣 hint 的话必然超** —— 这正是「忘了扣」那个变异的形态。
    const withoutReservation = Math.floor(budget / (schemasBytes / shown.length));
    expect(
      withoutReservation * (schemasBytes / shown.length) + hintBytes,
      '这个场景必须让「不扣 hint」真的超预算，否则这条用例证明不了什么',
    ).toBeGreaterThan(budget);
  });

  it('does not charge a direct-mode native tool against the adaptive budget', () => {
    // ⚠️⚠️ **这条守「不串账」** —— hint 曾经按**整批**扣，所以 Shell Local 走 `direct` 时，
    // 它那 2172 字节的 hint 也被算进 adaptive 预算。实测后果：一个**完全无关**的
    // adaptive 服务在预算 2000 时一个工具都拿不到，且没有任何报错。
    const helpers = createMcpCapabilityToolDescriptors('zh-CN');
    const shellTools = ['shell_exec', 'shell_status', 'local_file_read'].map((name) => (
      normalizeMcpToolDescriptor(server('shellsvr', 'native'), tool(name, 1))
    ));
    const otherTools = ['alpha', 'beta', 'gamma'].map((name) => (
      normalizeMcpToolDescriptor(server('other', 'http'), tool(name, 1))
    ));
    const budget = 2_000;

    const projection = projectMcpCapabilityDescriptors({
      descriptors: [...helpers, ...shellTools, ...otherTools],
      settings: {
        version: 1,
        adaptiveMaxDirectTools: 8,
        adaptiveMaxPromptBytes: budget,
        servers: {
          shellsvr: { mode: 'direct', pinnedDescriptorIds: [] },
          other: { mode: 'adaptive', pinnedDescriptorIds: [] },
        },
      },
      intent: 'alpha',
      locale: 'zh-CN',
    });
    const shownOther = projection.descriptors.filter((descriptor) => descriptor.provider.id === 'other');

    // ⚠️ **判据必须是「> 1」，不能是「> 0」** —— 兜底那条会给到 1 个，
    // 所以「> 0」在「hint 按整批扣」那个错误实现下**照样绿**（实测）。
    // 三个 other 工具的真实字节远小于 2000 ⇒ 正确的边际记账下三个都该进。
    expect(shownOther.length, '无关的 adaptive 服务不该被 Shell 的 hint 挤成 0 个')
      .toBe(otherTools.length);

    // 只按 other 的 schema 量，也应当装得下（hint 在 direct 那一侧，不属于这边）。
    const catalog = createToolInvocationCatalog(projection.descriptors);
    const otherBytes = shownOther
      .reduce((total, descriptor) => total + measureToolSchemaBytes(descriptor, catalog), 0)
      + Math.max(0, shownOther.length - 1) * TOOL_SCHEMA_JOINER_BYTES;
    expect(otherBytes).toBeLessThanOrEqual(budget);
  });

  it('falls back to the top-ranked tool when the hint alone exceeds the budget', () => {
    // ⚠️ 预算下限是 2000（`MIN_ADAPTIVE_PROMPT_BYTES`），而两段 hint 约 2172 字节
    // ⇒ **不兜底就会选出 0 个**。静默给 0 比轻微超预算糟得多（用户看不出是预算太小
    // 还是服务坏了），所以至少给排名第一那条。
    const helpers = createMcpCapabilityToolDescriptors('zh-CN');
    // ⚠️ **必须是全量 shell 工具**：hint 的字节数取决于目录里有多少个名字被点名
    // —— 只有 2 个工具时 hint 仅 1419 字节（装得下），**12 个才是 2172**（超过预算下限 2000）。
    // 用 2 个工具写这条，删掉兜底它照样绿（实测）。
    const shellTools = SHELL_TOOL_NAMES.map((name) => (
      normalizeMcpToolDescriptor(server('shellsvr', 'native'), tool(name, 1))
    ));

    const projection = projectMcpCapabilityDescriptors({
      descriptors: [...helpers, ...shellTools],
      settings: adaptiveSettings('shellsvr', 2_000),
      intent: 'shell_exec',
      locale: 'zh-CN',
    });
    const shown = projection.descriptors.filter((descriptor) => descriptor.provider.id === 'shellsvr');

    expect(shown.length, 'hint 单独就超预算时也要给出至少一个工具').toBeGreaterThan(0);
  });

  it('does not under-count when two servers expose the same tool name', () => {
    // 同名工具在整批 catalog 里会带 `mcp_<serverId>_` 前缀，名字更长；
    // 用单元素 catalog 量会偏小，这条守住那个坑。
    const a = normalizeMcpToolDescriptor(server('server-a', 'http'), tool('shared'));
    const b = normalizeMcpToolDescriptor(server('server-b', 'http'), tool('shared'));

    const batchCatalog = createToolInvocationCatalog([a, b]);
    const exact = measureToolSchemaBytes(a, batchCatalog)
      + measureToolSchemaBytes(b, batchCatalog)
      + TOOL_SCHEMA_JOINER_BYTES;
    expect(exact).toBe(bytes(renderToolSchemas([a, b], 'en')));

    const soloCatalog = createToolInvocationCatalog([a]);
    expect(measureToolSchemaBytes(a, soloCatalog), '单元素 catalog 量出来的应当更小')
      .toBeLessThan(measureToolSchemaBytes(a, batchCatalog));
  });

  it('the projection measures against the batch catalog, not just the adaptive candidates', () => {
    // ⚠️ **这条才拦得住「catalog 传成候选集」这个变异** —— 上面那条不能：
    // 两个同名工具都在 adaptive 集里时，两种 catalog 都会加前缀、量出来一样。
    //
    // 真正会分叉的是**跨模式重名**：一个 `direct` 工具与一个 adaptive 工具同名。
    // - 整批 catalog（正确）⇒ adaptive 那个也带 `mcp_<serverId>_` 前缀；
    // - 只拿候选集建（错误）⇒ 候选集里只有一个、不带前缀 ⇒ 量出来**偏小** ⇒ 低估 ⇒ 选多。
    //
    // ⚠️ **server id 故意取长** —— 前缀长度 = 名字字节差；id 太短的话差异淹没在
    // 预算余量里，变异不会红（实测 8 字符 id 时两种口径都能装下同样多的工具）。
    const helpers = createMcpCapabilityToolDescriptors('en');
    const longServerId = 'adaptive-server-with-a-very-long-identifier';
    const budget = 4_000;
    const adaptiveTools = Array.from({ length: 20 }, (_, index) => (
      normalizeMcpToolDescriptor(server(longServerId, 'http'), tool(`shared_${index}`, 1))
    ));
    // 同名的 direct 工具：让整批 catalog 里每个名字都带前缀
    const directTools = Array.from({ length: 20 }, (_, index) => (
      normalizeMcpToolDescriptor(server('direct-srv', 'http'), tool(`shared_${index}`, 1))
    ));

    const projection = projectMcpCapabilityDescriptors({
      descriptors: [...helpers, ...directTools, ...adaptiveTools],
      settings: {
        version: 1,
        adaptiveMaxDirectTools: 64,
        adaptiveMaxPromptBytes: budget,
        servers: {
          [longServerId]: { mode: 'adaptive', pinnedDescriptorIds: [] },
          'direct-srv': { mode: 'direct', pinnedDescriptorIds: [] },
        },
      },
      intent: 'shared',
      locale: 'en',
    });
    const shown = projection.descriptors.filter(
      (descriptor) => descriptor.provider.id === longServerId,
    );
    const catalog = createToolInvocationCatalog(projection.descriptors);
    const adaptiveBytes = shown
      .reduce((total, descriptor) => total + measureToolSchemaBytes(descriptor, catalog)
        + TOOL_SCHEMA_JOINER_BYTES, 0);

    expect(shown.length).toBeGreaterThan(0);
    // 真判据：用**整批 catalog** 量的字节数必须仍在预算内。
    // 若实现误用候选集 catalog（名字不带前缀、偏小），会多选几个 ⇒ 这里超预算 ⇒ 红。
    expect(adaptiveBytes, `同名场景下 ${adaptiveBytes} 字节超出预算 ${budget}`)
      .toBeLessThanOrEqual(budget);
  });
});
describe('adaptive budget honours the requested locale', () => {
  it('measures the hint in the requested locale, not the default one', () => {
    // ⚠️⚠️ **这条专治「locale 参数没接上」** —— 四条预算用例都传 `locale: 'en'`，但
    // zh 的 hint **更短**（实测 12 个 shell 工具：zh 2172 / en 2329）⇒ 若实现忽略 locale、
    // 恒按 zh 量，它扣得更少、选得更多，「总量 ≤ 预算」照样成立
    // ⇒ **没有一条能区分出这个洞**。
    //
    // ⚠️ **不写死「哪个预算下选几个」** —— 那要手算排名与逐条字节，改一个文案就假红。
    // 判据改成「**存在**一个预算，让两种语言选出不同数量」：只要实现真读了 locale，
    // 那 157 字节的差值一定能在某个预算档上体现出来。
    const helpers = createMcpCapabilityToolDescriptors('en');
    const shellTools = SHELL_TOOL_NAMES.map((name) => (
      normalizeMcpToolDescriptor(server('shellsvr', 'native'), tool(name, 1))
    ));
    const allDescriptors = [...helpers, ...shellTools];

    // 前提下：两种语言的 hint 确实不同（否则这条判据没有分辨力）。
    expect(measureToolHintBytes(allDescriptors, 'en'))
      .not.toBe(measureToolHintBytes(allDescriptors, 'zh-CN'));

    const countIn = (locale: 'en' | 'zh-CN', budget: number) => (
      projectMcpCapabilityDescriptors({
        descriptors: allDescriptors,
        settings: adaptiveSettings('shellsvr', budget),
        intent: 'shell_exec',
        locale,
      }).descriptors.filter((descriptor) => descriptor.provider.id === 'shellsvr').length
    );

    const divergenceBudgets: number[] = [];
    for (let budget = 2_000; budget <= 6_000; budget += 25) {
      if (countIn('en', budget) !== countIn('zh-CN', budget)) divergenceBudgets.push(budget);
    }

    expect(
      divergenceBudgets.length,
      '没有任何预算能让 en / zh-CN 选出不同数量 —— 说明实现忽略了 locale',
    ).toBeGreaterThan(0);
  });
});
