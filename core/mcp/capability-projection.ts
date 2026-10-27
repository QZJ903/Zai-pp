import type { ToolDescriptor } from '../tool/types';
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
    input.intent,
    pinned,
    input.settings.adaptiveMaxDirectTools,
    input.settings.adaptiveMaxPromptBytes,
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

function selectAdaptiveDescriptors(
  descriptors: readonly ToolDescriptor[],
  intent: string,
  pinnedDescriptorIds: ReadonlySet<string>,
  maxTools: number,
  maxBytes: number,
): ToolDescriptor[] {
  const selected: ToolDescriptor[] = [];
  let consumedBytes = 0;
  for (const descriptor of rankMcpCapabilityDescriptors(descriptors, intent, pinnedDescriptorIds)) {
    const bytes = estimateMcpCapabilityPromptBytes(descriptor);
    if (selected.length >= maxTools || consumedBytes + bytes > maxBytes) continue;
    selected.push(descriptor);
    consumedBytes += bytes;
  }
  return selected;
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
