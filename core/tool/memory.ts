import type { Memory, MemoryType, NewMemory } from '../types';
import { MEMORY_CONTENT_MAX_CHARS } from '../constants';
import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import type {
  JsonValue,
  ToolCall,
  ToolDescriptor,
  ToolProviderIdentity,
  ToolResult,
} from './types';

const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'topic', 'reference'];

export const MEMORY_TOOL_PROVIDER: ToolProviderIdentity = {
  kind: 'local',
  id: 'memory',
  displayName: translate(DEFAULT_LOCALE, 'tool.memory.providerName'),
  transport: 'in_process',
};

export const MEMORY_TOOL_NAMES = ['memory_save', 'memory_update', 'memory_delete'] as const;

export type MemoryToolName = typeof MEMORY_TOOL_NAMES[number];

export interface MemoryToolSaveConfirmation {
  id: number;
}

export interface MemoryToolRuntime {
  saveMemory(input: NewMemory): Promise<MemoryToolSaveConfirmation | null>;
  getMemoryById(id: number): Promise<Memory | null>;
  updateMemory(memory: Memory): Promise<void>;
  deleteMemory(id: number): Promise<void>;
}

export function createMemoryToolProviderIdentity(
  locale: SupportedLocale = DEFAULT_LOCALE,
): ToolProviderIdentity {
  return {
    ...MEMORY_TOOL_PROVIDER,
    displayName: translate(locale, 'tool.memory.providerName'),
  };
}

export function createMemoryToolDescriptors(
  locale: SupportedLocale = DEFAULT_LOCALE,
): ToolDescriptor[] {
  const provider = createMemoryToolProviderIdentity(locale);
  return [{
    id: 'local:memory:memory_save',
    provider,
    name: 'memory_save',
    invocationName: 'memory_save',
    title: translate(locale, 'tool.memory.saveTitle'),
    description: translate(locale, 'tool.memory.saveDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: MEMORY_TYPES,
          description: translate(locale, 'tool.memory.typeDescription'),
        },
        name: { type: 'string', description: translate(locale, 'tool.memory.nameDescription') },
        content: {
          type: 'string',
          maxLength: MEMORY_CONTENT_MAX_CHARS,
          description: translate(locale, 'tool.memory.contentDescription'),
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: translate(locale, 'tool.memory.tagsDescription'),
        },
      },
      required: ['type', 'name', 'content', 'tags'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'low',
    },
  },
  {
    id: 'local:memory:memory_update',
    provider,
    name: 'memory_update',
    invocationName: 'memory_update',
    title: translate(locale, 'tool.memory.updateTitle'),
    description: translate(locale, 'tool.memory.updateDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: translate(locale, 'tool.memory.idDescription') },
        type: { type: 'string', enum: MEMORY_TYPES, description: translate(locale, 'tool.memory.typeDescription') },
        name: { type: 'string', description: translate(locale, 'tool.memory.updatedNameDescription') },
        content: {
          type: 'string',
          maxLength: MEMORY_CONTENT_MAX_CHARS,
          description: translate(locale, 'tool.memory.updatedContentDescription'),
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: translate(locale, 'tool.memory.tagsDescription'),
        },
      },
      required: ['id', 'type', 'name', 'content', 'tags'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'medium',
    },
  },
  {
    id: 'local:memory:memory_delete',
    provider,
    name: 'memory_delete',
    invocationName: 'memory_delete',
    title: translate(locale, 'tool.memory.deleteTitle'),
    description: translate(locale, 'tool.memory.deleteDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: translate(locale, 'tool.memory.idDescription') },
      },
      required: ['id'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'medium',
    },
  },
  ];
}

export const MEMORY_TOOL_DESCRIPTORS: ToolDescriptor[] = createMemoryToolDescriptors(DEFAULT_LOCALE);

export function isMemoryToolName(name: string): name is MemoryToolName {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}

export async function executeMemoryToolCall(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale = DEFAULT_LOCALE,
): Promise<ToolResult> {
  if (call.name === 'memory_save') {
    return saveMemory(runtime, call, locale);
  }

  if (call.name === 'memory_update') {
    return updateExistingMemory(runtime, call, locale);
  }

  if (call.name === 'memory_delete') {
    return deleteExistingMemory(runtime, call, locale);
  }

  return {
    ok: false,
    name: call.name,
    summary: translate(locale, 'tool.memory.unsupported'),
    error: {
      code: 'memory_tool_unsupported',
      message: `Unsupported memory tool: ${call.name}`,
      retryable: false,
    },
  };
}

async function saveMemory(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const parsed = parseMemorySavePayload(call, locale);
  if (!parsed.ok) return parsed.result;

  const saved = await runtime.saveMemory({
    type: parsed.memory.type,
    name: parsed.memory.name,
    content: parsed.memory.content,
    description: parsed.memory.name,
    tags: parsed.memory.tags,
    pinned: false,
  });

  if (!saved?.id) {
    return failure(
      call,
      'memory_save_failed',
      translate(locale, 'tool.memory.saveFailed'),
      translate(locale, 'tool.memory.saveMissingConfirmation'),
      true,
    );
  }

  return success(call, locale, translate(locale, 'tool.memory.saved'), parsed.memory.name, { id: saved.id });
}

function parseMemorySavePayload(
  call: ToolCall,
  locale: SupportedLocale,
): { ok: true; memory: Pick<NewMemory, 'type' | 'name' | 'content' | 'tags'> } | { ok: false; result: ToolResult } {
  const payload = call.payload;
  const type = memoryTypeValue(payload.type);
  if (!type) {
    return {
      ok: false,
      result: failure(
        call,
        'memory_invalid_payload',
        translate(locale, 'tool.memory.invalidPayload'),
        translate(locale, 'tool.memory.invalidType'),
        false,
      ),
    };
  }

  const name = requiredStringValue(payload.name);
  if (!name) {
    return {
      ok: false,
      result: failure(
        call,
        'memory_invalid_payload',
        translate(locale, 'tool.memory.invalidPayload'),
        translate(locale, 'tool.memory.invalidName'),
        false,
      ),
    };
  }

  const content = requiredStringValue(payload.content);
  if (!content) {
    return {
      ok: false,
      result: failure(
        call,
        'memory_invalid_payload',
        translate(locale, 'tool.memory.invalidPayload'),
        translate(locale, 'tool.memory.invalidContent'),
        false,
      ),
    };
  }

  if (content.length > MEMORY_CONTENT_MAX_CHARS) {
    return {
      ok: false,
      result: failure(
        call,
        'memory_invalid_payload',
        translate(locale, 'tool.memory.invalidPayload'),
        translate(locale, 'tool.memory.invalidContentTooLong', {
          max: String(MEMORY_CONTENT_MAX_CHARS),
        }),
        false,
      ),
    };
  }

  if (!Array.isArray(payload.tags) || !payload.tags.every((item) => typeof item === 'string')) {
    return {
      ok: false,
      result: failure(
        call,
        'memory_invalid_payload',
        translate(locale, 'tool.memory.invalidPayload'),
        translate(locale, 'tool.memory.invalidTags'),
        false,
      ),
    };
  }

  return {
    ok: true,
    memory: {
      type,
      name,
      content,
      tags: [...payload.tags],
    },
  };
}

async function updateExistingMemory(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const payload = call.payload;
  const id = numberValue(payload.id);
  if (!id) return failure(call, 'memory_invalid_id', translate(locale, 'tool.memory.invalidId'), undefined, false);

  const existing = await runtime.getMemoryById(id);
  if (!existing) {
    return failure(
      call,
      'memory_not_found',
      translate(locale, 'tool.memory.notFound'),
      translate(locale, 'tool.memory.notFoundDetail', { id }),
      false,
    );
  }

  /**
   * ⚠️⚠️ **「空白」与「省略」是两件事，判据必须分开写。**
   *
   * `stringValue` 对非字符串给 `''`、对 `'   '` 原样返回 ⇒ 只判 `length > 0` 的话，
   * 一个纯空白的 `name` 会**一路穿透到 store**，在 `decodePersistedMemoryRecord` 的
   * `nonEmptyString` 才抛 `memory.name must be a non-empty string`（**英文**）。
   * 那条异常冒泡到 `executeRuntimeToolCall` 的 catch，被 `createBackgroundErrorResponse`
   * 包成 `background_tool_execution_failed` 连同英文 message 回给模型 ——
   * 而 `memory_save` 走 `requiredStringValue`（trim 过）挡得住，**两者不对称**。
   *
   * ⚠️ **判据只能写成「给了、且 trim 后为空」，不能写成「trim 后为空就拒」** ——
   * 后者会把「省略 `name` 只改正文」这条合法路径用 `''` 拦下来。与下面 `content`
   * 那条超长判据同族（都是「先区分省略与给值，再判值本身」）。
   */
  const providedName = stringValue(payload.name);
  if (providedName.length > 0 && providedName.trim().length === 0) {
    return failure(
      call,
      'memory_invalid_payload',
      translate(locale, 'tool.memory.invalidPayload'),
      translate(locale, 'tool.memory.invalidName'),
      false,
    );
  }
  const name = providedName || existing.name;
  /**
   * ⚠️⚠️ **只校验「调用方改出来的新正文」，不校验「原样带回来的旧正文」。**
   *
   * 两个都放过，缺一不可 —— 它们是**同一个问题的两个形状**：
   * ① **省略 `content`**（`stringValue` 给 `''` ⇒ 沿用旧值）；
   * ② **原样回传旧 `content`** —— 这才是**契约要求的形状**：
   *    `memory_update` 的 `inputSchema.required` 含 `content`，内置 `/memory` 技能也明写
   *    「所有字段均为必填，未变更的字段保持原值」（`core/skill/builtin.ts`），
   *    并把同一份 schema 塞给模型 ⇒ **模型一定会把旧正文原样带回来**。
   *
   * 只挡①的话，一条存量超长记忆（本判据落地之前 `memory_save` 与表单都没有长度上限）
   * **仍然改不动**：用户只想改个名字，模型按契约回传旧正文，却被回「content 太长」。
   * ⇒ 判据必须是「**给了、且和旧值不同、且超长**」才拒。
   *
   * ⚠️ **这不是兼容层**（本项目自用、不写迁移）：挡的是**新写入的超长值**，
   * 存量记录只要不改正文就一直能改其它字段。
   */
  const providedContent = stringValue(payload.content);
  // 空白正文与空白名字同理（见上面 `providedName` 那段）：给了纯空白就拒，
  // 省略则沿用旧值。**顺序必须在超长判据之前** —— 空白串本来就短，先判它能把
  // 「给了一个没意义的值」和「给了一个太大的值」分成两种文案。
  if (providedContent.length > 0 && providedContent.trim().length === 0) {
    return failure(
      call,
      'memory_invalid_payload',
      translate(locale, 'tool.memory.invalidPayload'),
      translate(locale, 'tool.memory.invalidContent'),
      false,
    );
  }
  const changesContent = providedContent.length > 0 && providedContent !== existing.content;
  if (changesContent && providedContent.length > MEMORY_CONTENT_MAX_CHARS) {
    return failure(
      call,
      'memory_invalid_payload',
      translate(locale, 'tool.memory.invalidPayload'),
      translate(locale, 'tool.memory.invalidContentTooLong', {
        max: String(MEMORY_CONTENT_MAX_CHARS),
      }),
      false,
    );
  }
  const content = providedContent || existing.content;
  await runtime.updateMemory({
    ...existing,
    type: memoryTypeValue(payload.type) || existing.type,
    name,
    content,
    /**
     * ⚠️ **这一行恒等于 `name`，不是笔误。**
     *
     * `name` 至少是 `existing.name`，而它由 `nonEmptyString` 保证非空 ⇒
     * `name || existing.description` 的右半边**永远走不到**。效果是每次
     * `memory_update` 都把 `description` 覆盖成当前名字。
     *
     * ⚠️ **目前没有可见后果** —— `Memory.description` 在全仓**没有任何读者**：
     * 卡片（`MemoryCard`）只渲染 name / content / tags，表单（`MemoryForm`）只有
     * 三个输入框，检索打分（`selector.ts`）只用 tags / name / content，
     * 同步（`local-state-browser.ts`）还把它列进「非 additive」剥掉。
     * ⇒ 真正会被冲掉的只有**导入器**写进去的外部描述（`importer.ts`），
     * 而它没有显示面、用户感知不到。
     *
     * ⚠️ **要动它之前先想清楚「description 该由谁维护」** —— 三选一：
     * 恒等于 name（现状）、沿用 `existing.description`、或者干脆删字段。
     * 删字段要连带处理落盘的老记录（`codec.ts` 里它是必填），而本项目自用、
     * 不写数据迁移，所以**没删**。
     */
    description: name || existing.description,
    tags: Array.isArray(payload.tags) ? stringArrayValue(payload.tags) : existing.tags,
  });

  return success(call, locale, translate(locale, 'tool.memory.updated'), name);
}

async function deleteExistingMemory(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const id = numberValue(call.payload.id);
  if (!id) return failure(call, 'memory_invalid_id', translate(locale, 'tool.memory.invalidId'), undefined, false);

  await runtime.deleteMemory(id);
  return success(call, locale, translate(locale, 'tool.memory.deleted'), `#${id}`);
}

function success(
  call: ToolCall,
  locale: SupportedLocale,
  summary: string,
  detail?: string,
  output?: JsonValue,
): ToolResult {
  return {
    ok: true,
    name: call.name,
    callId: call.id,
    descriptorId: call.descriptorId,
    provider: call.provider ?? createMemoryToolProviderIdentity(locale),
    summary,
    detail,
    output,
  };
}

function failure(
  call: ToolCall,
  code: string,
  summary: string,
  detail: string | undefined,
  retryable: boolean,
): ToolResult {
  return {
    ok: false,
    name: call.name,
    callId: call.id,
    descriptorId: call.descriptorId,
    provider: call.provider ?? MEMORY_TOOL_PROVIDER,
    summary,
    detail,
    error: {
      code,
      message: detail ?? summary,
      retryable,
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requiredStringValue(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : '';
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function memoryTypeValue(value: unknown): MemoryType | null {
  return typeof value === 'string' && MEMORY_TYPES.includes(value as MemoryType)
    ? value as MemoryType
    : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
