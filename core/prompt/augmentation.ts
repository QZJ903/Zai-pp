import { EXPOSED_SHELL_TOOL_NAMES } from '../shell/contracts';
import type { Memory, ToolDescriptor } from '../types';
import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import {
  DEFAULT_TOOL_DESCRIPTORS,
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
  /** @deprecated glm 遗留字段，z.ai 不使用也不参与任何逻辑（systemThinking 切换已移除）。 */
  thinkingEnabled?: boolean;
  // System context for local indexed skills ("activation instruction + index"): injected into the
  // system-instruction region (like the ## Tools section), fixing the issue where implicit matches were
  // treated as visible user input (passive chit-chat) and ignored the disk-read instruction (Bug ②).
  skillSystemContext?: string | null;
  presetContent?: string | null;
  projectContext?: string | null;
  toolDescriptors?: readonly ToolDescriptor[];
  locale?: SupportedLocale;
  memoryEnabled?: boolean;
  systemPromptEnabled?: boolean;
  forceResponseLanguage?: SupportedLocale | null;
  /** z.ai agent 模式（chatNew.type/flags == general_agent）；用于按需注入沙盒段、抑制 chat 段。 */
  isAgent?: boolean;
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
    projectContext = null,
    locale = DEFAULT_LOCALE,
    memoryEnabled = true,
    systemPromptEnabled = true,
    forceResponseLanguage = null,
    isAgent = false,
  } = options ?? {};
  const toolDescriptors = options?.toolDescriptors ?? createDefaultToolDescriptors(locale);
  const visiblePromptMetadata = options?.visibleUserPrompt === undefined
    ? ''
    : `${markVisibleUserPromptMetadata(options.visibleUserPrompt)}\n`;

  const promptTokens = estimateTokens(originalPrompt);
  const budget = getMemoryBudget(promptTokens);
  const selected = memoryEnabled
    ? selectMemories(originalPrompt, [...memories], { budget, identityOnly })
    : [];
  const memBlock = memoryEnabled
    ? formatMemoriesBlock(selected, locale)
    : translate(locale, 'prompt.memoryDisabled');
  const toolsBlock = systemPromptEnabled ? renderToolSchemas(toolDescriptors, locale) : '';
  const baseSystem = systemPromptEnabled
    ? translate(locale, 'prompt.systemChat', { memories: memBlock, tools: toolsBlock })
    : '';
  const standaloneMemories = !systemPromptEnabled && memoryEnabled
    ? translate(locale, 'prompt.standaloneMemories', { memories: memBlock })
    : '';
  const system = [
    baseSystem,
    skillSystemContext ? renderSkillSystemContext(skillSystemContext, locale) : '',
    standaloneMemories,
    renderProjectContext(projectContext),
    systemPromptEnabled ? renderWebSearchGuidance(isAgent, toolDescriptors, locale) : '',
    renderSandboxHostGuidance(isAgent, toolDescriptors, locale),
    renderForcedResponseLanguage(forceResponseLanguage, locale),
  ].filter(Boolean).join('\n\n');
  const presetPrefix = presetContent ? `${presetContent}\n\n---\n\n` : '';
  const toolReminder = systemPromptEnabled ? renderToolFormatReminder(toolDescriptors, locale) : '';
  const systemPrefix = system ? `${system}\n\n` : '';

  return {
    augmented: presetPrefix + systemPrefix + visiblePromptMetadata + markVisibleUserPrompt(originalPrompt) + toolReminder,
    usedMemoryIds: selected.map((memory) => memory.id!).filter(Boolean),
    renderedToolCount: systemPromptEnabled ? toolDescriptors.length : 0,
  };
}

function renderProjectContext(projectContext?: string | null): string {
  const trimmed = typeof projectContext === 'string' ? projectContext.trim() : '';
  return trimmed;
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
 * 联网搜索引导：chat 模式、目录里有扩展自带的 web_search 描述符就注入。
 *
 * 两个门：
 * 1. `isAgent` —— agent 模式的联网由服务端沙箱承担，不注入（其工具也已被
 *    core/zai/model-facing.ts 的 AGENT_ONLY_FILTERED_TOOL_NAMES 裁掉，
 *    所以这一门是双保险：即使将来过滤名单变了，引导也不会漏进 agent）。
 * 2. 工具在不在 —— 用户在侧边栏关掉 web 工具时，目录里没有 web_search，
 *    引导也应随之消失。
 */
function renderWebSearchGuidance(
  isAgent: boolean,
  descriptors: readonly ToolDescriptor[],
  locale: SupportedLocale,
): string {
  if (isAgent) return '';
  const hasWebSearch = descriptors.some((descriptor) => descriptor.name === 'web_search');
  if (!hasWebSearch) return '';
  return translate(locale, 'prompt.webSearchGuidance');
}

/**
 * 沙盒 vs 宿主机提示：仅在 agent 模式（服务端沙箱语境）下追加，
 * 避免 chat 模式被「沙箱工具」措辞误导而拐去 shell_exec 等本地工具。
 */
function renderSandboxHostGuidance(
  isAgent: boolean,
  descriptors: readonly ToolDescriptor[],
  locale: SupportedLocale,
): string {
  if (!isAgent) return '';
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
    `Invalid formats: <invoke name="${preferredName}">...</invoke>, <tool_call>...</tool_call>`,
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
