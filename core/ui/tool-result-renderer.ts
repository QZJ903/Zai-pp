/**
 * 工具结果卡片的渲染注册表。
 *
 * 模型返回的某些工具结果是**结构化对象**而不是一行文本 —— 它们需要一张卡片
 * 才能用：Skill 起草要给「保存」按钮，记忆导入预览要给「导入」按钮。
 * 每个渲染器拿到结果对象，能画就画并返回 true，画不了返回 false，由调用方
 * 退回纯文本展示。
 *
 * ⚠️ **本模块是纯 DOM 的，不直接碰 runtime** —— 写库动作由调用方以依赖形式注入
 * （见 `ToolResultRendererActions`）。这样做的直接好处是运行时命令字面量留在
 * 内容脚本里：`tests/runtime-boundary.test.ts` 用 AST 从内容脚本抓「实际发出的
 * 命令」，再与白名单做双向比对；命令字面量若藏在这里就抓不到、不变式会红。
 */

import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import type { Skill, ToolCardResult } from '../types';
import { injectInjectedThemeStyles, syncInjectedTheme } from './injected-theme';

export type ToolResultRendererInput = {
  target: HTMLElement;
  result: ToolCardResult;
  locale?: SupportedLocale;
};

export type ToolResultRenderer = (input: ToolResultRendererInput) => boolean;

/**
 * 卡片动作的落库通道。由内容脚本注入 —— 两个返回值的形状与后台 handler 一致：
 * 领域失败是 `{ok:false,error}` 而不是抛错，所以要判 `ok` 而不是只 catch。
 */
export interface ToolResultRendererActions {
  saveSkill: (draft: Skill) => Promise<{ ok?: boolean; error?: string } | undefined>;
  importMemories: (
    memories: unknown[],
  ) => Promise<{ ok?: boolean; count?: number; error?: string } | undefined>;
}

const renderers: ToolResultRenderer[] = [];

/**
 * 当前生效的动作通道。
 *
 * ⚠️ **用可变持有者而不是每次注册新闭包**：`registerDefaultToolResultRenderers`
 * 每轮回答结束都会被调一次，若每次 push 一个新的箭头函数，`includes` 永远不命中
 * → 注册表无限增长、同一张卡片被画多次。所以注册只做一次，动作从这里取。
 */
let currentActions: ToolResultRendererActions | null = null;

export function registerToolResultRenderer(renderer: ToolResultRenderer): void {
  if (!renderers.includes(renderer)) renderers.push(renderer);
}

export function renderToolResultWithRegistry(input: ToolResultRendererInput): boolean {
  for (const renderer of renderers) {
    if (renderer(input)) return true;
  }
  return false;
}

export function registerDefaultToolResultRenderers(actions: ToolResultRendererActions): void {
  currentActions = actions;
  if (renderers.length > 0) return;
  registerToolResultRenderer(renderSkillDraftResult);
  registerToolResultRenderer(renderMemoryImportPreviewResult);
}

function requireActions(): ToolResultRendererActions | null {
  return currentActions;
}

/**
 * 卡片上的动作（保存 Skill / 导入记忆）只允许由**真实用户手势**触发：
 * 页面世界合成的 click 是一条持久化投毒路径 —— 模型自己吐一段 XML、
 * 再合成一次点击，就能在没有用户确认的情况下写库。
 *
 * 用一个可变持有者而不是直接读 `event.isTrusted`，是为了让单元测试能覆盖两个
 * 分支（jsdom 无法合成 trusted 事件）；默认实现就是真实检查。
 */
export const userClickGuard: { isTrusted(event: Event): boolean } = {
  isTrusted(event: Event) {
    return event.isTrusted;
  },
};

export function isTrustedUserClick(event: Event): boolean {
  return userClickGuard.isTrusted(event);
}

/**
 * 结果卡片只画**成功**的结构化结果。
 *
 * ⚠️ **失败结果也可能带完整的 `output` 形状** —— 那时画出来的按钮是可点的，
 * 而背后其实没有可保存的东西。当前上游的失败分支都不带 `output`，所以这条
 * 守的是将来：一个「失败但带 output」的结果不该给出可点的动作。
 */
function isRenderableResult(input: ToolResultRendererInput): boolean {
  return input.result.ok === true;
}

function renderSkillDraftResult(input: ToolResultRendererInput): boolean {
  if (!isRenderableResult(input)) return false;
  const draft = getSkillDraftOutput(input.result.output);
  if (!draft) return false;

  const locale = input.locale ?? DEFAULT_LOCALE;
  const memoryKey = draft.draft.memoryEnabled
    ? 'tool.skillCreator.result.memoryOn'
    : 'tool.skillCreator.result.memoryOff';
  const wrapper = createResultPanel('zpp-skill-draft-result');
  const meta = document.createElement('div');
  meta.className = 'zpp-result-meta';
  meta.textContent = `/${draft.draft.name} · ${translate(locale, memoryKey)}`;
  const description = document.createElement('div');
  description.className = 'zpp-result-text';
  description.textContent = draft.draft.description;
  const button = createSmallButton(translate(locale, 'tool.skillCreator.result.saveSkill'));
  button.addEventListener('click', (event) => {
    if (!isTrustedUserClick(event)) return;
    const actions = requireActions();
    if (!actions) return;
    void saveSkillDraft(draft.draft, actions, button, locale);
  });
  wrapper.append(meta, description, button);
  input.target.appendChild(wrapper);
  ensureResultStyles();
  return true;
}

/**
 * 动作按钮的三种终态。
 *
 * ⚠️ **成功是终态，不回到可点状态** —— 写库已经发生，把文案改回「保存 Skill」
 * 会让用户以为没存上、再点一次。只有失败才回到可重试。
 */
async function runCardAction(
  button: HTMLButtonElement,
  labels: { busy: string; done: string; failed: string },
  action: () => Promise<void>,
): Promise<void> {
  button.disabled = true;
  button.textContent = labels.busy;
  try {
    await action();
    // 成功：保持禁用 + 终态文案，不恢复。写库已经发生，改回可点状态会让用户以为没存上。
    // `done` 为空表示动作自己写了终态文案（比如带条数的「已导入 N 条」），此时不覆盖。
    if (labels.done) button.textContent = labels.done;
  } catch (error) {
    // 失败：显示原因并恢复可点（重试时会被「进行中」文案覆盖）。
    button.textContent = error instanceof Error ? error.message : labels.failed;
    button.disabled = false;
  }
}

async function saveSkillDraft(
  draft: Skill,
  actions: ToolResultRendererActions,
  button: HTMLButtonElement,
  locale: SupportedLocale,
): Promise<void> {
  await runCardAction(button, {
    busy: translate(locale, 'tool.skillCreator.result.saving'),
    done: translate(locale, 'tool.skillCreator.result.saved'),
    failed: translate(locale, 'tool.skillCreator.result.saveFailed'),
  }, async () => {
    const result = await actions.saveSkill(draft);
    // 领域失败是 `{ok:false,error}` 而不是抛错，所以要判 ok。
    if (result?.ok !== true) {
      throw new Error(result?.error || translate(locale, 'tool.skillCreator.result.saveFailed'));
    }
  });
}

function renderMemoryImportPreviewResult(input: ToolResultRendererInput): boolean {
  if (!isRenderableResult(input)) return false;
  const preview = getMemoryImportPreviewOutput(input.result.output);
  if (!preview) return false;

  const locale = input.locale ?? DEFAULT_LOCALE;
  const wrapper = createResultPanel('zpp-memory-import-result');
  const meta = document.createElement('div');
  meta.className = 'zpp-result-meta';
  meta.textContent = translate(locale, 'tool.memoryImport.result.metaSummary', {
    count: preview.memories.length,
    duplicates: preview.duplicates,
  });
  const list = document.createElement('div');
  list.className = 'zpp-result-text';
  // 只列有名字的条目 —— 结果对象是外部输入，元素缺 `name` 时直接拼会渲染出 `- undefined`。
  list.textContent = preview.memories
    .filter((memory) => typeof memory?.name === 'string' && memory.name.trim())
    .slice(0, 5)
    .map((memory) => `- ${memory.name}`)
    .join('\n');
  const button = createSmallButton(translate(locale, 'tool.memoryImport.result.importMemories'));
  button.disabled = preview.memories.length === 0;
  button.addEventListener('click', (event) => {
    if (!isTrustedUserClick(event)) return;
    const actions = requireActions();
    if (!actions) return;
    void importMemoryDrafts(preview.memories, actions, button, locale);
  });
  wrapper.append(meta, list, button);
  input.target.appendChild(wrapper);
  ensureResultStyles();
  return true;
}

/**
 * 已知**领域失败码** → 用户可读文案。
 *
 * ⚠️ 后台的领域失败是 `{ok:false, error}`，其中 `error` 有时是**错误码**
 * （如 `invalid_memories`），有时是抛出来的**原始消息**。错误码直接当按钮文案
 * 对用户没意义，所以这里做一层映射；**映射不到的仍回落到原文** —— 原始消息
 * 通常比一个笼统的「失败」更有信息量。
 */
const MEMORY_IMPORT_FAILURE_KEYS: Record<string, 'tool.memoryImport.result.invalidDrafts'> = {
  invalid_memories: 'tool.memoryImport.result.invalidDrafts',
};

/** 领域失败码映射到文案；映射不到就回落到原始消息（它通常比「失败」更有信息量）。 */
function readMemoryImportFailure(error: unknown, locale: SupportedLocale): string {
  const code = typeof error === 'string' ? error : '';
  const key = MEMORY_IMPORT_FAILURE_KEYS[code];
  if (key) return translate(locale, key);
  return code || translate(locale, 'tool.memoryImport.result.importFailed');
}

async function importMemoryDrafts(
  memories: unknown[],
  actions: ToolResultRendererActions,
  button: HTMLButtonElement,
  locale: SupportedLocale,
): Promise<void> {
  await runCardAction(button, {
    busy: translate(locale, 'tool.memoryImport.result.importing'),
    done: '',
    failed: translate(locale, 'tool.memoryImport.result.importFailed'),
  }, async () => {
    const result = await actions.importMemories(memories);
    // ⚠️ **判 `!== true` 而不是 `=== false`** —— 传输层失败（扩展上下文失效、
    // `sendMessage` 抛错）返回的是 `undefined`，而 `undefined?.ok === false` 为假。
    // 那样会跳过抛错、直接写「已导入 N 条」，**而库里什么都没写**。
    if (result?.ok !== true) {
      throw new Error(readMemoryImportFailure(result?.error, locale));
    }
    // 成功文案要带导入条数，只有拿到结果才知道 —— 所以在这里就地写，
    // 并让 runCardAction 的 done 保持空串（空串不覆盖）。
    // 条数只在真的是数字时采用，否则退回本次提交的条数。
    button.textContent = translate(locale, 'tool.memoryImport.result.imported', {
      count: typeof result.count === 'number' ? result.count : memories.length,
    });
  });
}

/**
 * 结果对象是**外部输入**（模型给的内容经后台回传），所以按形状窄化而不是断言 ——
 * 形状不对就返回 null，让调用方退回纯文本。
 */
function getSkillDraftOutput(value: unknown): {
  kind: 'skill_draft';
  draft: Skill;
} | null {
  if (!value || typeof value !== 'object') return null;
  const output = value as { kind?: unknown; draft?: unknown };
  if (output.kind !== 'skill_draft' || !output.draft || typeof output.draft !== 'object') return null;
  const draft = output.draft as Partial<Skill>;
  if (
    typeof draft.name !== 'string'
    || typeof draft.description !== 'string'
    || typeof draft.instructions !== 'string'
  ) {
    return null;
  }
  return value as { kind: 'skill_draft'; draft: Skill };
}

function getMemoryImportPreviewOutput(value: unknown): {
  kind: 'memory_import_preview';
  memories: Array<{ name: string }>;
  duplicates: number;
  rejected: number;
} | null {
  if (!value || typeof value !== 'object') return null;
  const output = value as {
    kind?: unknown;
    memories?: unknown;
    duplicates?: unknown;
    rejected?: unknown;
  };
  if (output.kind !== 'memory_import_preview' || !Array.isArray(output.memories)) return null;
  if (typeof output.duplicates !== 'number' || typeof output.rejected !== 'number') return null;
  return value as {
    kind: 'memory_import_preview';
    memories: Array<{ name: string }>;
    duplicates: number;
    rejected: number;
  };
}
function createResultPanel(className: string): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = `zpp-rich-result ${className}`;
  return wrapper;
}

function createSmallButton(text: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'zpp-result-action';
  button.textContent = text;
  return button;
}

const RESULT_STYLE_ID = 'zpp-result-css';

/**
 * 变量块与主题同步都在这里自己调一次，不依赖内容脚本启动时的
 * `installInjectedThemeWatch()` —— 那样卡片就隐式依赖「谁先谁后」，顺序一变
 * 所有 `var(--zpp-ui-*)` 都会解析成空值（深色页面上表现为卡片整体看不见）。
 * 两处调用都是幂等的（样式节点按 id 去重、同步是纯赋值），重复调用没有代价。
 */
function ensureResultStyles(): void {
  injectInjectedThemeStyles();
  syncInjectedTheme();
  if (document.getElementById(RESULT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = RESULT_STYLE_ID;
  style.textContent = `
.zpp-rich-result {
  display: block;
  padding: 8px 10px;
  border: 1px solid var(--zpp-ui-border);
  border-radius: 8px;
  background: var(--zpp-ui-accent-panel);
}
.zpp-result-meta {
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--zpp-ui-text);
}
.zpp-result-text {
  margin-top: 6px;
  white-space: pre-wrap;
  font-size: 12px;
  color: var(--zpp-ui-text-muted);
}
.zpp-result-action {
  margin-top: 8px;
  border: 0;
  border-radius: 7px;
  background: var(--zpp-ui-accent);
  /* ⚠️ **不能写 white** —— 两套主题的 accent 都偏亮（浅色 #497ef7 / 深色 #80acff），
   * 白字压上去分别只有 3.74:1 与 2.27:1，深色下基本读不出来。
   */
  color: var(--zpp-ui-accent-contrast);
  font-size: 11px;
  font-weight: 600;
  padding: 5px 9px;
  cursor: pointer;
}
.zpp-result-action:disabled {
  opacity: 0.65;
  cursor: default;
}
`;
  document.head.appendChild(style);
}
