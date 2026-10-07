import { DEFAULT_LOCALE, type SupportedLocale } from '../i18n/background';
import { createMemoryToolDescriptors } from './memory';
import { createWebSearchToolDescriptors } from './web-search';
import type { ToolCall, ToolDescriptor, ToolError, ToolPayload } from './types';
import { findFirstXmlToolTag } from './xml-tags';

export function createDefaultToolDescriptors(
  locale: SupportedLocale = DEFAULT_LOCALE,
): readonly ToolDescriptor[] {
  return [
    ...createMemoryToolDescriptors(locale),
    ...createWebSearchToolDescriptors(locale),
  ];
}

export const DEFAULT_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = createDefaultToolDescriptors(DEFAULT_LOCALE);

export interface ToolInvocationCatalog {
  descriptors: readonly ToolDescriptor[];
  invocationNames: string[];
  descriptorByInvocationName: Map<string, ToolDescriptor>;
  descriptorByName: Map<string, ToolDescriptor>;
  invocationNamesByDescriptorId: Map<string, string[]>;
}

export interface ToolParsingInput {
  descriptors?: readonly ToolDescriptor[];
}

const catalogCache = new WeakMap<readonly ToolDescriptor[], ToolInvocationCatalog>();
const xmlRegexSourceCache = new WeakMap<ToolInvocationCatalog, string>();

export function createToolInvocationCatalog(
  descriptors: readonly ToolDescriptor[] = DEFAULT_TOOL_DESCRIPTORS,
): ToolInvocationCatalog {
  const cached = catalogCache.get(descriptors);
  if (cached) return cached;

  const descriptorByInvocationName = new Map<string, ToolDescriptor>();
  const descriptorByName = new Map<string, ToolDescriptor>();
  const invocationNamesByDescriptorId = new Map<string, string[]>();
  const toolNameCounts = new Map<string, number>();

  for (const descriptor of descriptors) {
    const name = descriptor.name.trim();
    if (!isValidToolTagName(name)) continue;
    toolNameCounts.set(name, (toolNameCounts.get(name) ?? 0) + 1);
  }

  for (const descriptor of descriptors) {
    const invocationName = descriptor.invocationName.trim();
    const acceptedNames: string[] = [];
    if (isValidToolTagName(invocationName)) {
      addInvocationName(descriptorByInvocationName, acceptedNames, invocationName, descriptor);
    }

    const name = descriptor.name.trim();
    if (name && !descriptorByName.has(name)) {
      descriptorByName.set(name, descriptor);
    }

    if (
      name &&
      name !== invocationName &&
      isValidToolTagName(name) &&
      toolNameCounts.get(name) === 1
    ) {
      addInvocationName(descriptorByInvocationName, acceptedNames, name, descriptor);
    }

    invocationNamesByDescriptorId.set(descriptor.id, acceptedNames);
  }

  const catalog: ToolInvocationCatalog = {
    descriptors,
    invocationNames: [...descriptorByInvocationName.keys()],
    descriptorByInvocationName,
    descriptorByName,
    invocationNamesByDescriptorId,
  };
  catalogCache.set(descriptors, catalog);
  return catalog;
}

/**
 * ⚠️ **捕获组两侧不能加 `\s*`** —— `\s*([\s\S]*?)\s*` 里两个量词都能吃空白、
 * 彼此重叠，在「开标签后跟连续空白、且无配对闭合标签」时**灾难性回溯**
 * （实测 4,000 空白 6.4s / 8,000 空白 >20s）。标签名两侧的 `\s*` 保留 ——
 * 那是刻意支持 `< name >` 这类带空格标签的写法，且不参与重叠。
 *
 * 去掉后是近线性（4000 空白 0ms）。⚠️ **代价是捕获组会带上尾部空白**
 * （原先由 `\s*` 吃掉）—— 调用方需自行 `trim()`。本函数当前无生产消费者，
 * 唯一的用法在 `scripts/web-search-smoke.mjs`，那里本来就 `.trim()`。
 */
export function createXmlToolCallRegex(catalog: ToolInvocationCatalog): RegExp {
  if (catalog.invocationNames.length === 0) return /$a/g;
  let source = xmlRegexSourceCache.get(catalog);
  if (!source) {
    const names = catalog.invocationNames.map(escapeRegExp).join('|');
    source = `<\\s*(${names})\\s*>([\\s\\S]*?)<\\/\\s*\\1\\s*>`;
    xmlRegexSourceCache.set(catalog, source);
  }
  return new RegExp(source, 'g');
}

export function createToolCallFromInvocation(
  invocationName: string,
  payload: ToolPayload,
  raw: string,
  catalog: ToolInvocationCatalog,
  options?: { parseError?: ToolError; id?: string; localSkillDir?: string },
): ToolCall {
  const descriptor =
    catalog.descriptorByInvocationName.get(invocationName) ||
    catalog.descriptorByName.get(invocationName);

  const call: ToolCall = {
    name: descriptor?.name ?? invocationName,
    invocationName: descriptor?.invocationName ?? invocationName,
    payload,
    raw,
    descriptorId: descriptor?.id,
    provider: descriptor?.provider,
    parseError: options?.parseError,
  };
  if (options?.id) call.id = options.id;
  // localSkillDir is only a trusted internal injection point for the "request-
  // level cwd hint": its source is the parser's activeLocalSkillDir (upstream
  // requestContext.activeLocalSkillDir, injected by content.ts's augment result
  // via fetch-hook, NOT the page/model message body). The untrusted page field
  // is stripped at runtime.ts:resolveToolCallPayload.
  if (options?.localSkillDir) call.localSkillDir = options.localSkillDir;
  return call;
}

export function getToolInvocationNames(
  descriptor: ToolDescriptor,
  catalog: ToolInvocationCatalog = createToolInvocationCatalog([descriptor]),
): string[] {
  const names = catalog.invocationNamesByDescriptorId.get(descriptor.id);
  if (names?.length) return names;
  return descriptor.invocationName ? [descriptor.invocationName] : [];
}

export function getPreferredToolInvocationName(
  descriptor: ToolDescriptor,
  catalog: ToolInvocationCatalog = createToolInvocationCatalog([descriptor]),
): string {
  const names = getToolInvocationNames(descriptor, catalog);
  const directName = descriptor.name.trim();
  if (directName && names.includes(directName)) return directName;
  return names[0] ?? descriptor.invocationName;
}

export function getToolInvocationLabel(
  name: string,
  catalog: ToolInvocationCatalog = createToolInvocationCatalog(),
): string {
  const descriptor =
    catalog.descriptorByInvocationName.get(name) ||
    catalog.descriptorByName.get(name);
  return descriptor?.title || name;
}

export function getToolOpenTag(invocationName: string): string {
  return `<${invocationName}>`;
}

export function getToolCloseTag(invocationName: string): string {
  return `</${invocationName}>`;
}

export function hasXmlToolMarker(text: string, catalog: ToolInvocationCatalog): boolean {
  const names = new Set(catalog.invocationNames);
  return Boolean(
    findFirstXmlToolTag(text, names, { closing: false }) ||
    findFirstXmlToolTag(text, names, { closing: true }),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addInvocationName(
  descriptorByInvocationName: Map<string, ToolDescriptor>,
  acceptedNames: string[],
  invocationName: string,
  descriptor: ToolDescriptor,
) {
  acceptedNames.push(invocationName);
  if (descriptorByInvocationName.has(invocationName)) return;
  descriptorByInvocationName.set(invocationName, descriptor);
}

function isValidToolTagName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value);
}
