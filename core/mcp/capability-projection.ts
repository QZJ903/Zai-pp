import type { ToolDescriptor } from '../tool/types';
import { createToolInvocationCatalog } from '../tool/invocation';
import { DEFAULT_LOCALE, type SupportedLocale } from '../i18n/background';
import {
  TOOL_SCHEMA_JOINER_BYTES,
  measureToolHintBytes,
  measureToolSchemaBytes,
} from '../prompt/augmentation';
import { isExtensionInternalTool } from './internal-tools';
import {
  getMcpCapabilityServerSettings,
} from './capability-settings';
import type {
  McpCapabilityProjection,
  McpCapabilitySettings,
} from './capability-types';
import {
  getMcpCapabilityOperation,
  isMcpCapabilityDescriptor,
  MCP_CAPABILITY_OPERATIONS,
  type McpCapabilityOperation,
} from './capability-contract';

// The prompt renderer emits the JSON Schema and a generated example payload.
// Reserve a second schema-sized block plus its fixed XML/instruction framing so
// the adaptive budget remains an upper bound instead of a rough average.
const PROMPT_DESCRIPTOR_FIXED_OVERHEAD_BYTES = 1_024;

export interface McpCapabilityProjectionInput {
  descriptors: readonly ToolDescriptor[];
  settings: McpCapabilitySettings;
  intent: string;
  /**
   * 当前界面语言 —— **只影响 adaptive 预算里那两段 hint 的字节数**
   * （`renderShellMcpHint` / `renderPythonMcpHint` 会 `translate`）。
   *
   * ⚠️ 不传时按 `DEFAULT_LOCALE`（zh-CN）算。**中英差异是百字节量级、不是几十**：
   * 实测 12 个 shell 工具时 zh 2172 字节 / en 2329 字节（en 反而更长）——
   * 所以恒用 zh 是**少扣**，预算可被轻微突破。
   */
  locale?: SupportedLocale;
}

/**
 * 把 `intent` 命中的 MCP 描述符按**真实渲染字节**预算裁剪出来。
 *
 * ⚠️⚠️ **这里量的是真值，不是估算** —— 见 `measureToolSchemaBytes` 的说明。
 * 原先那个「描述符文本 + schema×2 + 固定 1024」的估算器实测系统性高估 2–3 倍，
 * 导致默认 24000 预算下只放出 13/40 个工具，而按真实字节能放 31 个。
 *
 * ⚠️ **catalog 必须按「整批」建** —— 同名工具会被加上 `mcp_<serverId>_` 前缀，
 * 用单元素 catalog 量出来的名字更短、字节数偏小。
 *
 * ⚠️⚠️ **hint 只按「adaptive 额外造成的增量」扣，不按整批扣** ——
 * 这是修过一个真问题的：`direct` / `on_demand` 里的 native 工具**本来就会**（或本来就不会）
 * 出现在提示词里，它们的 hint 不属于 adaptive 的选择成本。按整批扣会**串账**：
 * 实测「Shell 走 direct + 另一个服务走 adaptive + 预算 2000」时，那个**完全无关**的
 * adaptive 服务会因为 Shell 的 2172 字节 hint 而一个工具都拿不到。
 * 现在用 `整批 hint − 不含 adaptive/on_demand 时的 hint` 求边际量。
 *
 * ⚠️ **兜底**：hint 单独就超过预算时（预算下限 2000 < 两段 hint 约 2172），
 * 若不兜底会选出 0 个 —— 静默给 0 比轻微超预算糟得多，所以至少给排名第一那条。
 */
function selectAdaptiveDescriptors(
  descriptors: readonly ToolDescriptor[],
  catalogDescriptors: readonly ToolDescriptor[],
  /** 一定会进最终提示词的那批（`direct` 模式 + 非 MCP 的本地工具）—— 用来求 hint 的边际量。 */
  alwaysVisibleDescriptors: readonly ToolDescriptor[],
  intent: string,
  pinnedDescriptorIds: ReadonlySet<string>,
  maxTools: number,
  maxBytes: number,
  locale: SupportedLocale,
): ToolDescriptor[] {
  const selected: ToolDescriptor[] = [];
  // ⚠️ 目录按**整批**建（与最终 `renderToolSchemas` 的口径一致）。
  const catalog = createToolInvocationCatalog(catalogDescriptors);
  const marginalHintBytes = Math.max(
    0,
    measureToolHintBytes(catalogDescriptors, locale)
      - measureToolHintBytes(alwaysVisibleDescriptors, locale),
  );
  let consumedBytes = marginalHintBytes;
  for (const descriptor of rankMcpCapabilityDescriptors(descriptors, intent, pinnedDescriptorIds)) {
    // ⚠️ **`maxTools` 判据必须在量字节之前** —— 满了就该停，不该继续给剩下的候选
    // 每个渲染一遍 schema + 示例 payload 再丢掉（默认 8 个、候选可能上百）。
    if (selected.length >= maxTools) break;
    const bytes = measureToolSchemaBytes(descriptor, catalog)
      + (selected.length > 0 ? TOOL_SCHEMA_JOINER_BYTES : 0);
    if (consumedBytes + bytes > maxBytes) continue;
    selected.push(descriptor);
    consumedBytes += bytes;
  }
  // ⚠️ **兜底：hint 单独就吃光预算时至少给一条** —— 否则那个 adaptive 服务
  // 一个工具都不出现、且没有任何报错（用户看不出是预算太小还是服务坏了）。
  if (selected.length === 0 && descriptors.length > 0) {
    const [first] = rankMcpCapabilityDescriptors(descriptors, intent, pinnedDescriptorIds);
    if (first) selected.push(first);
  }
  return selected;
}

/**
 * Produces the model-facing MCP projection. It never creates, alters or
 * re-authorizes a real descriptor; execution always resolves against the full
 * current runtime descriptor set later.
 */
export function projectMcpCapabilityDescriptors(
  input: McpCapabilityProjectionInput,
): McpCapabilityProjection {
  const helpers = input.descriptors.filter(isMcpCapabilityDescriptor);
  const eligibleMcp = input.descriptors.filter(isExecutableMcpDescriptor);
  const serverModes = new Map(eligibleMcp.map((descriptor) => [
    descriptor.id,
    getMcpCapabilityServerSettings(input.settings, descriptor.provider.id),
  ]));
  const adaptive = eligibleMcp.filter((descriptor) => serverModes.get(descriptor.id)?.mode === 'adaptive');
  const onDemand = eligibleMcp.filter((descriptor) => serverModes.get(descriptor.id)?.mode === 'on_demand');
  const direct = eligibleMcp.filter((descriptor) => serverModes.get(descriptor.id)?.mode === 'direct');
  const pinned = new Set(
    adaptive.flatMap((descriptor) => serverModes.get(descriptor.id)?.pinnedDescriptorIds ?? []),
  );
  const selectedAdaptive = selectAdaptiveDescriptors(
    adaptive,
    // ⚠️ **catalog 按整批建**（与最终渲染同口径）—— 同名工具会带 `mcp_<serverId>_` 前缀，
    // 用单元素 catalog 量出来的名字更短、字节数偏小。
    input.descriptors,
    // ⚠️ 「一定会进提示词」的那批 = 非 MCP 的本地工具 + `direct` 模式的 MCP 工具。
    // 用来求 hint 的**边际量**（见 `selectAdaptiveDescriptors` 的说明）。
    [
      ...input.descriptors.filter(
        (descriptor) => !isMcpDescriptor(descriptor) && !isMcpCapabilityDescriptor(descriptor),
      ),
      ...direct,
    ],
    input.intent,
    pinned,
    input.settings.adaptiveMaxDirectTools,
    input.settings.adaptiveMaxPromptBytes,
    input.locale ?? DEFAULT_LOCALE,
  );
  const selectedIds = new Set([...direct, ...selectedAdaptive].map((descriptor) => descriptor.id));
  const hidden = [...onDemand, ...adaptive.filter((descriptor) => !selectedIds.has(descriptor.id))];

  if (hidden.length === 0) {
    // Default settings are direct. Preserve the released descriptor order and
    // exclude the internal catalog controls so legacy prompt bytes stay stable.
    return {
      descriptors: input.descriptors.filter(
        (descriptor) => !isMcpCapabilityDescriptor(descriptor) && !isInternalDescriptor(descriptor),
      ),
      directDescriptorIds: eligibleMcp.map((descriptor) => descriptor.id),
      hiddenDescriptorIds: [],
      usesCatalog: false,
    };
  }

  assertCompleteCapabilityHelperSet(helpers);
  const descriptors = [
    ...input.descriptors.filter((descriptor) => (
      !isMcpCapabilityDescriptor(descriptor) &&
      // ⚠️ **内部工具在这里也要排掉** —— 它恒 `enabled: true`（MCP 页不显示、用户没有开关），
      // 而下面的 `!isExecutableMcpDescriptor(...)` 对它是**真**（已由那条判据排除）
      // ⇒ 不加这一条它反而会被「保留」进 descriptors。
      !isInternalDescriptor(descriptor) &&
      (!isMcpDescriptor(descriptor) || !isExecutableMcpDescriptor(descriptor) || selectedIds.has(descriptor.id))
    )),
    ...helpers,
  ];
  return {
    descriptors,
    directDescriptorIds: [...selectedIds],
    hiddenDescriptorIds: hidden.map((descriptor) => descriptor.id),
    usesCatalog: true,
  };
}

export function rankMcpCapabilityDescriptors(
  descriptors: readonly ToolDescriptor[],
  query: string,
  pinnedDescriptorIds: ReadonlySet<string> = new Set(),
): ToolDescriptor[] {
  const normalizedQuery = normalizeSearchText(query);
  const queryTerms = tokenize(normalizedQuery);
  return descriptors
    .map((descriptor, index) => ({
      descriptor,
      index,
      score: scoreDescriptor(descriptor, normalizedQuery, queryTerms, pinnedDescriptorIds.has(descriptor.id)),
    }))
    .sort((left, right) => (
      right.score - left.score ||
      compareLexical(
        normalizeSearchText(left.descriptor.title),
        normalizeSearchText(right.descriptor.title),
      ) ||
      compareLexical(
        normalizeSearchText(left.descriptor.name),
        normalizeSearchText(right.descriptor.name),
      ) ||
      left.index - right.index
    ))
    .map((entry) => entry.descriptor);
}

/**
 * ⚠️⚠️ **已不再用于预算裁剪 —— 保留只为兼容旧断言，别再拿它当判据。**
 *
 * 它是「描述符文本 + schema×2 + 固定 1024」的**估算**，实测系统性高估 2–3 倍：
 * 示例 payload 只有 required 字段的短值（远小于一整份 schema），而每个描述符的
 * 真实框架开销只有 40–213 字节、不是 1024。用它裁剪的实际后果是
 * 默认 24000 预算下只放出 13/40 个工具（按真实字节能放 31 个）。
 *
 * ⇒ 预算裁剪现在走 `measureToolSchemaBytes` / `measureToolHintBytes`（真渲染量字节），
 * 见 `selectAdaptiveDescriptors`。
 */
export function estimateMcpCapabilityPromptBytes(descriptor: ToolDescriptor): number {
  const descriptorText = [
    descriptor.invocationName,
    descriptor.title,
    descriptor.description,
  ].join('\n');
  const encoder = new TextEncoder();
  const schemaBytes = encoder.encode(JSON.stringify(descriptor.inputSchema)).byteLength;
  return encoder.encode(descriptorText).byteLength +
    schemaBytes * 2 +
    PROMPT_DESCRIPTOR_FIXED_OVERHEAD_BYTES;
}

export function isMcpDescriptor(descriptor: ToolDescriptor): boolean {
  return descriptor.provider.kind === 'mcp';
}

/**
 * 这条描述符是不是**扩展内部工具**（`core/mcp/internal-tools.ts`）。
 *
 * ⚠️ **判据同时看 `name` 与 `invocationName`** —— 与 `core/zai/model-facing.ts`
 * 和 `applyMcpToolPolicy` 同口径，三层不许各判一套。
 */
function isInternalDescriptor(descriptor: ToolDescriptor): boolean {
  return isExtensionInternalTool(descriptor.name)
    || isExtensionInternalTool(descriptor.invocationName);
}

/**
 * 这条 MCP 描述符**能不能被投给模型 / 被 `mcp_invoke` 调到**。
 *
 * ⚠️⚠️ **必须排除内部工具**（`core/mcp/internal-tools.ts`）—— 这条判据是**能力目录那条通道**
 * 的总闸：`eligibleMcp`、adaptive 直投、`mcp_discover` 候选池、`mcp_invoke` 租约全走它。
 * 内部工具由扩展自己调用（读技能文件夹）、对模型退役，但它**在 `applyMcpToolPolicy` 里恒为
 * `enabled: true`**（因为 MCP 页不显示它 ⇒ 用户没有开关能关它）⇒ 少了这一条，它会经由
 * 「恒 enabled」漏进能力目录，变成**默认开、无开关可关**的模型可见工具。
 * ⚠️ 与 `core/zai/model-facing.ts` 是**两条独立通道**，两边都要裁（那层管注入给模型的目录）。
 */
export function isExecutableMcpDescriptor(descriptor: ToolDescriptor): boolean {
  return isMcpDescriptor(descriptor)
    && !isInternalDescriptor(descriptor)
    && descriptor.execution.enabled
    && descriptor.execution.mode !== 'disabled';
}

function scoreDescriptor(
  descriptor: ToolDescriptor,
  normalizedQuery: string,
  queryTerms: readonly string[],
  pinned: boolean,
): number {
  const name = normalizeSearchText(`${descriptor.name} ${descriptor.invocationName}`);
  const title = normalizeSearchText(descriptor.title);
  const description = normalizeSearchText(descriptor.description);
  let score = pinned ? 10_000 : 0;
  if (normalizedQuery) {
    if (name.includes(normalizedQuery)) score += 1_000;
    if (title.includes(normalizedQuery)) score += 700;
    if (description.includes(normalizedQuery)) score += 250;
  }
  for (const term of queryTerms) {
    if (name.includes(term)) score += 120;
    if (title.includes(term)) score += 80;
    if (description.includes(term)) score += 25;
  }
  return score;
}

function assertCompleteCapabilityHelperSet(helpers: readonly ToolDescriptor[]): void {
  const operations = new Set(
    helpers.map(getMcpCapabilityOperation).filter((value): value is McpCapabilityOperation => value !== null),
  );
  const missing = MCP_CAPABILITY_OPERATIONS.filter((operation) => !operations.has(operation));
  if (missing.length === 0) return;
  throw new Error(`MCP capability catalog is incomplete: missing ${missing.join(', ')}.`);
}

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}

function compareLexical(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function tokenize(value: string): string[] {
  const matches = value.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(matches.filter((term) => term.length >= 2))];
}
