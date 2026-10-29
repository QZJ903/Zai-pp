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
  /**
   * 本请求的**模型可见工具目录**（调用方必须自己过滤好，见 `modelFacingDescriptorsFor`）。
   *
   * ⚠️⚠️ **必填，刻意不给默认值** —— 缺省时曾经回落成 `createDefaultToolDescriptors()`，
   * 而那只有 `memory_save` / `memory_update` / `memory_delete` **三个**记忆工具 ⇒ 漏传的后果是
   * 「提示词里只有记忆工具、但看起来一切正常」（`renderedToolCount: 3`、提醒段照常注入）。
   * 这类静默失效只能靠类型挡住：**漏传会让 `tsc` 报错，而不是产出一份看似合理的提示词。**
   * ⚠️ `renderToolSchemas` / `renderToolFormatReminder` 的默认参数**保留** —— 它们服务的是
   * 单独渲染某个目录（测试与诊断），不是这条主路径。
   */
  toolDescriptors: readonly ToolDescriptor[];
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
  options: PromptAugmentationOptions,
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
    toolDescriptors,
  } = options;
  const visiblePromptMetadata = options.visibleUserPrompt === undefined
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
  // 之后、`## 本地工具` 之前）—— 这样它才与工具用法同处一段、且排在工具清单之前。
  // ⚠️ **它随 `systemPromptEnabled` 一起出现或消失**（见 `system` 数组那里的说明）；
  // 目录里没有本地 Shell 工具时它本身返回空串。
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
    // ⚠️⚠️ **沙箱段只在 `systemPromptEnabled` 为真时存在** —— 它就落在 `systemChat` 的
    // `{sandboxHost}` 占位里，开关一关整段跟着消失。**刻意不在这里补一份**：
    // 那段正文里有三处写「以 `### 可用工具` 清单为准」，而那个清单同样在 `systemChat` 里
    // ⇒ 补回来会得到一段**指向不存在的清单**的说明，模型反而无从判断走哪条通道。
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

/** UTF-8 字节数 —— `TextEncoder` 建一次就够，别每次现 new。 */
const UTF8_ENCODER = new TextEncoder();

/** 两个工具 schema 之间的分隔符（`renderToolSchemas` 用 `join('\n\n')`）。 */
const TOOL_SCHEMA_SEPARATOR_BYTES = UTF8_ENCODER.encode('\n\n').byteLength;

/**
 * **量**一个描述符在提示词里实际占多少字节 —— 给 MCP 的 adaptive 预算闸门用。
 *
 * ⚠️⚠️ **不是估算，是拿真渲染器渲染一遍量 UTF-8 长度。** 原先
 * `capability-projection.ts` 里那个 `estimateMcpCapabilityPromptBytes` 是「描述符文本 +
 * schema×2 + 固定 1024」，实测**系统性高估 2–3 倍**：示例 payload 只有 required 字段的
 * 短值（远小于一整份 schema），而每个描述符的真实框架开销只有 40–213 字节、不是 1024。
 * 后果是 adaptive 模式的预算闸门严重偏保守 —— 实测默认 24000 预算下只放出 13/40 个工具，
 * 而按真实字节能放 31 个。
 *
 * ⚠️ **必须传「整批」的 catalog，不能只传这个描述符** —— 同名工具会被加上
 * `mcp_<serverId>_` 前缀（`createToolInvocationCatalog` 按整批判重），名字长度会变，
 * 用单元素 catalog 量出来的是**错的**（偏小）。
 *
 * ⚠️ **不含分隔符**：调用方按「每个工具一条」累加时自己加 `TOOL_SCHEMA_SEPARATOR_BYTES`。
 * ⚠️ **不含 shell / python hint**：那两段是「整批里有没有 native 工具」的产物、
 * 只出现一次，由调用方用 `measureToolHintBytes` 单独扣一次。
 */
export function measureToolSchemaBytes(
  descriptor: ToolDescriptor,
  catalog: ToolInvocationCatalog,
): number {
  return UTF8_ENCODER.encode(renderToolSchema(descriptor, catalog)).byteLength;
}

/** 分隔符字节数（导出给调用方累加用，避免它手抄 `2`）。 */
export const TOOL_SCHEMA_JOINER_BYTES = TOOL_SCHEMA_SEPARATOR_BYTES;

/**
 * 量「这一批目录会额外带出来的固定段」有多少字节 —— 现在只有 shell / python 两段 hint。
 *
 * ⚠️ **这两段与具体选了哪些工具无关，只看「这一批里有没有」** ⇒ 调用方在循环前扣一次即可。
 * ⚠️ 用真渲染器算，别在这里另写一份长度估算（那正是原来那个估算器出错的方式）。
 */
export function measureToolHintBytes(
  descriptors: readonly ToolDescriptor[],
  locale: SupportedLocale = DEFAULT_LOCALE,
): number {
  const catalog = createToolInvocationCatalog(descriptors);
  const shellHint = renderShellMcpHint(descriptors, catalog, locale);
  const pythonHint = renderPythonMcpHint(descriptors, catalog, locale);
  // 每段 hint 与后面的 schemas 之间也有一个分隔符（`filter(Boolean).join('\n\n')`）。
  return [shellHint, pythonHint]
    .filter(Boolean)
    .reduce((total, hint) => total + UTF8_ENCODER.encode(hint).byteLength + TOOL_SCHEMA_SEPARATOR_BYTES, 0);
}

/**
 * 沙盒 vs 宿主机提示：目录里有本地 Shell 工具时才返回正文。
 *
 * ⚠️ **「返回正文」不等于「一定会被注入」** —— 它只填 `systemChat` 的 `{sandboxHost}`
 * 占位，而那个模板整段受 `systemPromptEnabled` 控制（见 `system` 数组那里的说明）。
 * ⚠️ 要求目录里有本地 Shell 工具 —— 没有本地工具时这段「两套工具怎么分工」
 * 就无从谈起，注入只会让模型去找不存在的 `shell_exec`。
 */
function renderSandboxHostGuidance(
  descriptors: readonly ToolDescriptor[],
  locale: SupportedLocale,
): string {
  const needsLocalHostGuidance = descriptors.some(
    (descriptor) =>
      isLocalShellTool(descriptor)
      && (descriptor.name === 'shell_exec' || descriptor.name === 'local_file_read'),
  );
  if (!needsLocalHostGuidance) return '';
  return translate(locale, 'prompt.sandboxHostSection');
}

function renderPythonMcpHint(
  descriptors: readonly ToolDescriptor[],
  catalog: ToolInvocationCatalog,
  locale: SupportedLocale,
): string {
  const pythonExec = descriptors.find(
    (descriptor) => isLocalShellTool(descriptor) && descriptor.name === 'python_exec',
  );
  const pythonStatus = descriptors.find(
    (descriptor) => isLocalShellTool(descriptor) && descriptor.name === 'python_status',
  );
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

/**
 * 这个描述符是不是**本地 Shell MCP** 的工具。
 *
 * ⚠️⚠️ **判据必须是 transport，不能是工具名** —— 一个第三方 MCP 服务只要恰好提供一个
 * 叫 `shell_exec` / `python_exec` 的工具，按名字判就会触发整段「Shell MCP 能力」，
 * 而里面「Shell MCP 已通过扩展连接」「Windows 下 Shell Local 默认使用 PowerShell」
 * 这些**只对本地 host 成立**。
 * ⚠️ **也不能判 `provider.id`** —— 那是 `createMcpServer` 里的 `crypto.randomUUID()`，
 * 每次安装都不同；`'shell-local'` 只出现在测试夹具里。按 id 判会永远不命中、整段静默消失。
 * ⚠️ `native_messaging` 是「本机 native host」这种传输形态，本项目只有 Shell Local 用它
 * （MCP 页不提供新建入口），所以这个判据与「就是 Shell Local」等价。
 */
function isLocalShellTool(descriptor: ToolDescriptor): boolean {
  return descriptor.provider.transport === 'native_messaging';
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
  const shellExec = descriptors.find(
    (descriptor) => isLocalShellTool(descriptor) && descriptor.name === 'shell_exec',
  );
  if (!shellExec) return '';

  const shellStatus = descriptors.find(
    (descriptor) => isLocalShellTool(descriptor) && descriptor.name === 'shell_status',
  );
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
    translate(locale, 'prompt.shellHintNames', { names: renderShellToolNameList(descriptors) }),
  ].filter(Boolean).join('\n');
}

/**
 * 提示词里那份「可识别的 shell 工具名」清单 —— **从本轮目录派生，不用常量**。
 *
 * ⚠️⚠️ **曾经传的是 `EXPOSED_SHELL_TOOL_NAMES`（常量 11 个名字）**，而实际目录可能只有
 * 其中几个：`maxToolCount` 会在发现阶段截断尾部工具、用户也能在 MCP 页逐个关掉。
 * 后果是模型被告知有若干个它**看不见**的工具名 —— 而这份清单的用途正是「告诉模型哪些名字
 * 可以写成 XML 标签」，点名一个调不到的工具等于给它一个必然失败的选项。
 * ⚠️ **上游同样是常量**，但上游的前提是「Shell Local 全量暴露」；本项目有上限截断与
 * 用户级 allowlist ⇒ 前提不成立（「上游错了照抄也是错」）。
 *
 * ⚠️ **顺序按 `EXPOSED_SHELL_TOOL_NAMES` 的既有顺序排**，不按 `descriptors` 的发现顺序 ——
 * 顺序变了提示词字节就变，而那是无意义的噪声（换个顺序没有任何收益）。
 * ⚠️ **守卫不是黄金文件** —— `tests/prompt-output-contract.test.ts` 那条用例传的是
 * `toolDescriptors: []`，`renderToolSchemas` 渲染出空串、**根本不含 shell hint**，
 * 它锁不到这里。真正钉住顺序的是 `tests/prompt-shell-tool-names.test.ts` 的
 * 「keeps the canonical order instead of the discovery order」那条。
 */
function renderShellToolNameList(descriptors: readonly ToolDescriptor[]): string {
  // ⚠️ **必须同时过 `isLocalShellTool`** —— 与 shell hint / python hint / 沙箱段同一个判据。
  // 只按名字的话，一个第三方 MCP 恰好提供 `local_file_read` 时，那个名字会被列进
  // 「shell 工具名」清单（它能当标签调，但不是本地 shell 能力，列进来与另三处不一致）。
  const present = new Set(
    descriptors.filter(isLocalShellTool).map((descriptor) => descriptor.name),
  );
  return EXPOSED_SHELL_TOOL_NAMES.filter((name) => present.has(name)).join(', ');
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
