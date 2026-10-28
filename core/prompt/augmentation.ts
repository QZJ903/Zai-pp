import { EXPOSED_SHELL_TOOL_NAMES } from '../shell/contracts';
import type { Memory, ToolDescriptor } from '../types';
import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import {
  createDefaultToolDescriptors,
  createToolInvocationCatalog,
  getPreferredToolInvocationName,
  getToolInvocationNames,
  type ToolInvocationCatalog,
} from '../tool';
import { estimateTokens, formatMemoriesBlock, getMemoryBudget, selectMemories } from '../memory/selector';
import { markVisibleUserPrompt, markVisibleUserPromptMetadata } from './visibility';

export interface PromptAugmentationOptions {
  memories?: readonly Memory[];
  identityOnly?: boolean;
  visibleUserPrompt?: string;
  /** @deprecated 上游遗留字段，z.ai 不使用也不参与任何逻辑。 */
  thinkingEnabled?: boolean;
  // System context for local indexed skills ("activation instruction + index"): injected into the
  // system-instruction region (like the ## Tools section), fixing the issue where implicit matches were
  // treated as visible user input (passive chit-chat) and ignored the disk-read instruction (Bug ②).
  skillSystemContext?: string | null;
  presetContent?: string | null;
  toolDescriptors?: readonly ToolDescriptor[];
  locale?: SupportedLocale;
  memoryEnabled?: boolean;
  systemPromptEnabled?: boolean;
  forceResponseLanguage?: SupportedLocale | null;
}

export interface PromptAugmentationResult {
  augmented: string;
  usedMemoryIds: number[];
  renderedToolCount: number;
}

export function buildPromptAugmentation(
  originalPrompt: string,
  options?: PromptAugmentationOptions,
): PromptAugmentationResult {
  const {
    memories = [],
    identityOnly = false,
    skillSystemContext = null,
    presetContent = null,
    locale = DEFAULT_LOCALE,
    memoryEnabled = true,
    systemPromptEnabled = true,
    forceResponseLanguage = null,
  } = options ?? {};
  const toolDescriptors = options?.toolDescriptors ?? createDefaultToolDescriptors(locale);
  const visiblePromptMetadata = options?.visibleUserPrompt === undefined
    ? ''
    : `${markVisibleUserPromptMetadata(options.visibleUserPrompt)}\n`;

  const promptTokens = estimateTokens(originalPrompt);
  const budget = getMemoryBudget(promptTokens);
  const selected = memoryEnabled
    ? selectMemories(originalPrompt, [...memories], { budget, identityOnly, locale })
    : [];
  const memBlock = memoryEnabled
    ? formatMemoriesBlock(selected, locale)
    : translate(locale, 'prompt.memoryDisabled');
  const toolsBlock = systemPromptEnabled ? renderToolSchemas(toolDescriptors, locale) : '';
  // ⚠️ **沙箱段的位置在 `systemChat` 模板里**（`{sandboxHost}` 占位，落在「已有记忆」
  // 之后、`## Tools` 之前）—— 这样它才与工具用法同处一段、且排在工具清单之前。
  // 站点只有 agent 模式，这段**始终注入**（目录里没有本地 Shell 工具时返回空串）。
  const sandboxHost = renderSandboxHostGuidance(toolDescriptors, locale);
  // ⚠️⚠️ **系统提示词预设替换 `## 角色` 的正文**（不是叠加）——
  // `presetContent` 非空表示「预设已激活且本轮命中注入频率」（判据在调用方
  // `shouldInjectPresetForTurn`，所以「预设注入频率」这一项对角色段照常生效）。
  // 为空时填默认文案 ⇒ **没有预设时输出与改造前逐字节相同**。
  // ⚠️ **空串 / 纯空白也走默认** —— 预设的 `content` 在存储契约里只校验「是字符串」
  // （`core/preset/codec.ts` 的 `stringValue`），「非空」只是 UI 约定；不兜的话
  // 一条空预设会把角色段换成空段。
  const roleText = presetContent && presetContent.trim()
    ? presetContent
    : translate(locale, 'prompt.defaultRole');
  const baseSystem = systemPromptEnabled
    ? translate(locale, 'prompt.systemChat', {
      role: roleText,
      memories: memBlock,
      tools: toolsBlock,
      sandboxHost: sandboxHost ? `\n\n${sandboxHost}` : '',
    })
    : '';
  const standaloneMemories = !systemPromptEnabled && memoryEnabled
    ? translate(locale, 'prompt.standaloneMemories', { memories: memBlock })
    : '';
  const system = [
    baseSystem,
    skillSystemContext ? renderSkillSystemContext(skillSystemContext, locale) : '',
    standaloneMemories,
    // `systemPromptEnabled=false` 时 `systemChat` 整段不注入，沙箱段在那个模板里就没有
    // 落脚点了 —— 单独补一条，保持「沙箱段与 systemPrompt 开关无关」这个既有行为。
    systemPromptEnabled ? '' : sandboxHost,
    renderForcedResponseLanguage(forceResponseLanguage, locale),
  ].filter(Boolean).join('\n\n');
  // ⚠️ **预设已经填进 `{role}`，这里只兜「系统提示词总开关关掉」那一档** ——
  // 那时 `systemChat` 整段不注入，`{role}` 也就没有落脚点；若不在这里补一段，
  // 用户关掉系统提示词之后预设会**静默失效**（而它明明是独立于那段模板的设置）。
  const presetPrefix = !systemPromptEnabled && presetContent ? `${presetContent}\n\n---\n\n` : '';
  const toolReminder = systemPromptEnabled ? renderToolFormatReminder(toolDescriptors, locale) : '';
  const systemPrefix = system ? `${system}\n\n` : '';

  return {
    augmented: presetPrefix + systemPrefix + visiblePromptMetadata + markVisibleUserPrompt(originalPrompt) + toolReminder,
    usedMemoryIds: selected.map((entry) => entry.memory.id!).filter(Boolean),
    renderedToolCount: systemPromptEnabled ? toolDescriptors.length : 0,
  };
}

function renderForcedResponseLanguage(
  forceResponseLanguage: SupportedLocale | null,
  locale: SupportedLocale,
): string {
  if (!forceResponseLanguage) return '';
  const language = forceResponseLanguage === 'en'
    ? translate(locale, 'prompt.responseLanguageEnglish')
    : translate(locale, 'prompt.responseLanguageChinese');
  return translate(locale, 'prompt.forceResponseLanguage', { language });
}

function renderSkillSystemContext(context: string, locale: SupportedLocale): string {
  const header = translate(locale, 'prompt.localSkillSystemContextHeader');
  return `${header}\n\n${context}`;
}

export function renderToolSchemas(
  descriptors?: readonly ToolDescriptor[],
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  const resolvedDescriptors = descriptors ?? createDefaultToolDescriptors(locale);
  const catalog = createToolInvocationCatalog(resolvedDescriptors);
  const shellHint = renderShellMcpHint(resolvedDescriptors, catalog, locale);
  const pythonHint = renderPythonMcpHint(resolvedDescriptors, catalog, locale);
  const schemas = resolvedDescriptors
    .map((descriptor) => renderToolSchema(descriptor, catalog))
    .join('\n\n');
  return [shellHint, pythonHint, schemas].filter(Boolean).join('\n\n');
}

/**
 * 沙盒 vs 宿主机提示：**始终尝试注入**（站点只有 agent 模式）。
 *
 * ⚠️ 仍然要求目录里有本地 Shell 工具 —— 没有本地工具时这段「两套工具怎么分工」
 * 就无从谈起，注入只会让模型去找不存在的 `shell_exec`。
 */
function renderSandboxHostGuidance(
  descriptors: readonly ToolDescriptor[],
  locale: SupportedLocale,
): string {
  const needsLocalHostGuidance = descriptors.some(
    (descriptor) =>
      descriptor.name === 'shell_exec' || descriptor.name === 'local_file_read',
  );
  if (!needsLocalHostGuidance) return '';
  return translate(locale, 'prompt.sandboxHostSection');
}

function renderPythonMcpHint(
  descriptors: readonly ToolDescriptor[],
  catalog: ToolInvocationCatalog,
  locale: SupportedLocale,
): string {
  const pythonExec = descriptors.find((descriptor) => descriptor.name === 'python_exec');
  const pythonStatus = descriptors.find((descriptor) => descriptor.name === 'python_status');
  if (!pythonExec && !pythonStatus) return '';

  const execName = pythonExec ? getPreferredToolInvocationName(pythonExec, catalog) : null;
  const statusName = pythonStatus ? getPreferredToolInvocationName(pythonStatus, catalog) : null;

  return [
    translate(locale, 'prompt.pythonHintTitle'),
    execName
      ? translate(locale, 'prompt.pythonHintExec', { execName })
      : '',
    statusName
      ? translate(locale, 'prompt.pythonHintStatus', { statusName })
      : '',
    translate(locale, 'prompt.pythonHintAvailability'),
    translate(locale, 'prompt.pythonHintSafety'),
  ].filter(Boolean).join('\n');
}

function renderToolSchema(descriptor: ToolDescriptor, catalog: ToolInvocationCatalog): string {
  const examplePayload = createExamplePayload(descriptor);
  const preferredName = getPreferredToolInvocationName(descriptor, catalog);
  const acceptedNames = getToolInvocationNames(descriptor, catalog);
  const lines = [
    `### Tool ${preferredName}`,
    `Title: ${descriptor.title}`,
    `Description: ${descriptor.description}`,
    acceptedNames.length > 1 ? `Accepted tag names: ${acceptedNames.join(', ')}` : '',
    `Valid call format for ${preferredName}:`,
    `<${preferredName}>`,
    JSON.stringify(examplePayload, null, 2),
    `</${preferredName}>`,
    `Call it as a direct XML tag in the answer body — not as a native tool_call.`,
    `Parameters JSON Schema: ${JSON.stringify(descriptor.inputSchema)}`,
  ];
  return lines.filter(Boolean).join('\n');
}

function renderShellMcpHint(
  descriptors: readonly ToolDescriptor[],
  catalog: ToolInvocationCatalog,
  locale: SupportedLocale,
): string {
  const shellExec = descriptors.find((descriptor) => descriptor.name === 'shell_exec');
  if (!shellExec) return '';

  const shellStatus = descriptors.find((descriptor) => descriptor.name === 'shell_status');
  const execName = getPreferredToolInvocationName(shellExec, catalog);
  const statusName = shellStatus ? getPreferredToolInvocationName(shellStatus, catalog) : null;

  return [
    translate(locale, 'prompt.shellHintTitle'),
    translate(locale, 'prompt.shellHintConnected'),
    translate(locale, 'prompt.shellHintExec', { execName }),
    statusName
      ? translate(locale, 'prompt.shellHintStatus', { statusName })
      : '',
    translate(locale, 'prompt.shellHintWindows'),
    translate(locale, 'prompt.shellHintSession'),
    translate(locale, 'prompt.shellHintNames', { names: EXPOSED_SHELL_TOOL_NAMES.join(', ') }),
  ].filter(Boolean).join('\n');
}

export function renderToolFormatReminder(
  descriptors?: readonly ToolDescriptor[],
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  const catalog = createToolInvocationCatalog(descriptors ?? createDefaultToolDescriptors(locale));
  const names = catalog.invocationNames;
  if (names.length === 0) return '';
  return `\n\n${translate(locale, 'prompt.toolFormatReminder', { names: names.join(', ') })}`;
}

function createExamplePayload(descriptor: ToolDescriptor): Record<string, unknown> {
  const properties = descriptor.inputSchema.properties ?? {};
  const required = descriptor.inputSchema.required ?? Object.keys(properties);
  const payload: Record<string, unknown> = {};

  for (const key of required) {
    payload[key] = exampleValue(properties[key]);
  }

  return payload;
}

function exampleValue(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return 'value';
  const value = schema as Record<string, unknown>;
  const type = value.type;
  if (Array.isArray(type)) return exampleValue({ ...value, type: type[0] });
  if (value.enum && Array.isArray(value.enum) && value.enum.length > 0) return value.enum[0];
  switch (type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    case 'string':
    default: {
      const desc = typeof value.description === 'string' ? value.description.toLowerCase() : '';
      if (type === 'string' && (desc.includes('file path') || desc.includes('file_path') || desc.includes('filepath'))) {
        if (desc.includes('.pptx')) return './example.pptx';
        if (desc.includes('.docx')) return './example.docx';
        if (desc.includes('.xlsx')) return './example.xlsx';
        return './example.txt';
      }
      return 'value';
    }
  }
}
