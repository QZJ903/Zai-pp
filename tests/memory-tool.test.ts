import { describe, expect, it } from 'vitest';
import { MEMORY_CONTENT_MAX_CHARS } from '../core/constants';
import {
  createMemoryToolDescriptors,
  executeMemoryToolCall,
  type MemoryToolRuntime,
} from '../core/tool/memory';
import type { ToolCall } from '../core/tool/types';
import { MEMORY_RECORD_MISSING_CODE } from '../core/messaging/error-code';

function memorySaveCall(payload: Record<string, unknown>): ToolCall {
  return {
    name: 'memory_save',
    payload,
    raw: '<memory_save />',
  };
}

function schemaPropertyDescription(
  descriptor: ReturnType<typeof createMemoryToolDescriptors>[number],
  propertyName: string,
): string {
  const property = descriptor.inputSchema.properties?.[propertyName];
  if (!property || typeof property !== 'object' || Array.isArray(property)) {
    throw new Error(`Missing schema property ${propertyName}`);
  }
  const description = property.description;
  if (typeof description !== 'string') {
    throw new Error(`Missing schema description for ${propertyName}`);
  }
  return description;
}

describe('memory tool validation', () => {
  it('localizes memory descriptors without changing tool protocol names', () => {
    const english = createMemoryToolDescriptors('en');
    const chinese = createMemoryToolDescriptors('zh-CN');

    expect(english[0].name).toBe('memory_save');
    expect(english[0].invocationName).toBe('memory_save');
    expect(english[0].title).toBe('Save memory');
    expect(schemaPropertyDescription(english[0], 'type')).toContain('Memory type');

    expect(chinese[0].name).toBe('memory_save');
    expect(chinese[0].invocationName).toBe('memory_save');
    expect(chinese[0].title).toBe('Save memory');
    expect(schemaPropertyDescription(chinese[0], 'type')).toContain('Memory type');
  });

  it('does not persist invalid memory_save payloads', async () => {
    let saveCalls = 0;
    const runtime: MemoryToolRuntime = {
      async saveMemory() {
        saveCalls++;
        return { id: 1 };
      },
      async getMemoryById() {
        return null;
      },
      async updateMemory() {},
      async deleteMemory() {},
    };

    const result = await executeMemoryToolCall(runtime, memorySaveCall({
      type: 'topic',
      name: '',
      content: 'content',
      tags: [],
    }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('memory_invalid_payload');
    expect(saveCalls).toBe(0);
  });

  it('returns localized memory validation errors', async () => {
    let saveCalls = 0;
    const runtime: MemoryToolRuntime = {
      async saveMemory() {
        saveCalls++;
        return { id: 1 };
      },
      async getMemoryById() {
        return null;
      },
      async updateMemory() {},
      async deleteMemory() {},
    };

    const english = await executeMemoryToolCall(runtime, memorySaveCall({
      type: 'topic',
      name: '',
      content: 'content',
      tags: [],
    }), 'en');

    const chinese = await executeMemoryToolCall(runtime, memorySaveCall({
      type: 'topic',
      name: '',
      content: 'content',
      tags: [],
    }), 'zh-CN');

    expect(english.summary).toBe('Invalid memory payload');
    expect(english.detail).toBe('name must be a non-empty string');
    expect(chinese.summary).toBe('记忆格式错误');
    expect(chinese.detail).toBe('name 必须是非空字符串');
    expect(saveCalls).toBe(0);
  });

  it('returns localized memory success summaries', async () => {
    const runtime: MemoryToolRuntime = {
      async saveMemory() {
        return { id: 42 };
      },
      async getMemoryById() {
        return null;
      },
      async updateMemory() {},
      async deleteMemory() {},
    };

    const result = await executeMemoryToolCall(runtime, memorySaveCall({
      type: 'topic',
      name: 'Pinned decision',
      content: 'Keep tool names stable.',
      tags: ['i18n'],
    }), 'en');

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Saved');
    expect(result.detail).toBe('Pinned decision');
  });
});

/**
 * 单条记忆正文的长度上限。
 *
 * ⚠️ **上限只有一个真源**（`MEMORY_CONTENT_MAX_CHARS`）—— 导入、模型保存、表单手填
 * 三条写入路径必须同值，否则会出现「导入能进来、保存被拒」这种不一致。
 */
describe('memory content length limit', () => {
  function countingRuntime(existingContent = 'existing content') {
    const calls: string[] = [];
    const runtime: MemoryToolRuntime = {
      async saveMemory(mem) {
        calls.push(mem.content);
        return { id: 1 };
      },
      async getMemoryById() {
        return {
          id: 7,
          type: 'topic',
          name: 'existing',
          content: existingContent,
          description: 'existing',
          tags: [],
          pinned: false,
          syncId: 's',
          createdAt: 1,
          updatedAt: 1,
          accessCount: 0,
          lastAccessedAt: 1,
        };
      },
      async updateMemory(mem) {
        calls.push(mem.content);
      },
      async deleteMemory() {},
    };
    return { runtime, calls };
  }

  it('advertises the limit in both write schemas', () => {
    for (const descriptor of createMemoryToolDescriptors('en')) {
      const content = descriptor.inputSchema.properties?.content;
      if (descriptor.name === 'memory_delete') continue;
      expect(content, descriptor.name).toMatchObject({ maxLength: MEMORY_CONTENT_MAX_CHARS });
    }
  });

  it('rejects an oversized memory_save instead of persisting it', async () => {
    const { runtime, calls } = countingRuntime();
    const result = await executeMemoryToolCall(runtime, memorySaveCall({
      type: 'topic',
      name: 'too long',
      content: 'x'.repeat(MEMORY_CONTENT_MAX_CHARS + 1),
      tags: [],
    }), 'en');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('memory_invalid_payload');
    expect(result.detail).toContain(String(MEMORY_CONTENT_MAX_CHARS));
    expect(calls).toHaveLength(0);
  });

  it('rejects an oversized memory_update instead of persisting it', async () => {
    const { runtime, calls } = countingRuntime();
    const result = await executeMemoryToolCall(runtime, {
      name: 'memory_update',
      payload: {
        id: 7,
        content: 'x'.repeat(MEMORY_CONTENT_MAX_CHARS + 1),
      },
      raw: '<memory_update />',
    }, 'en');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('memory_invalid_payload');
    expect(calls).toHaveLength(0);
  });

  it('accepts a memory whose content is exactly at the limit', async () => {
    const { runtime, calls } = countingRuntime();
    const content = 'x'.repeat(MEMORY_CONTENT_MAX_CHARS);
    const result = await executeMemoryToolCall(runtime, memorySaveCall({
      type: 'topic',
      name: 'at the limit',
      content,
      tags: [],
    }), 'en');

    expect(result.ok).toBe(true);
    expect(calls).toEqual([content]);
  });

  it('still updates a stored memory whose old content is already over the limit', async () => {
    // ⚠️⚠️ **这是 P1 的回归守卫。**
    //
    // 判据若写成「先合并、再判长度」，一条**存量超长**记忆就再也改不动了。
    // 而存量确实可能超长：本判据落地之前，`memory_save` 与表单都没有长度上限。
    //
    // ⚠️⚠️ **两个形状都要放行，缺一不可** —— 它们是同一个问题的两面：
    // ① 省略 `content`（`stringValue` 给 `''` ⇒ 沿用旧值）；
    // ② **原样回传旧 `content`** —— 这是**契约要求的形状**：
    //    `memory_update` 的 `inputSchema.required` 含 `content`，内置 `/memory` 技能
    //    也明写「所有字段均为必填，未变更的字段保持原值」⇒ 模型一定会带回来。
    //    **只挡①的话，② 仍然被拒** —— 那条修复等于没修到主路。
    const overlongStored = '字'.repeat(MEMORY_CONTENT_MAX_CHARS + 1000);

    // ① 省略 content
    const omitted = countingRuntime(overlongStored);
    const renamed = await executeMemoryToolCall(omitted.runtime, {
      name: 'memory_update',
      payload: { id: 7, name: '改名' },
      raw: '<memory_update />',
    }, 'en');
    expect(renamed.ok, '只改名字不该被旧正文的超长拦住').toBe(true);
    expect(omitted.calls).toEqual([overlongStored]);

    // ② 原样回传旧 content（契约要求的形状）
    const echoed = countingRuntime(overlongStored);
    const echoedResult = await executeMemoryToolCall(echoed.runtime, {
      name: 'memory_update',
      payload: { id: 7, type: 'topic', name: '改名', content: overlongStored, tags: [] },
      raw: '<memory_update />',
    }, 'en');
    expect(echoedResult.ok, '原样回传旧正文不该被拒（schema 与技能都要求这么发）').toBe(true);
    expect(echoed.calls).toEqual([overlongStored]);

    // 反面自检：**真的改成了**超长正文时仍然要拒。
    const changed = countingRuntime(overlongStored);
    const rejected = await executeMemoryToolCall(changed.runtime, {
      name: 'memory_update',
      payload: { id: 7, content: 'x'.repeat(MEMORY_CONTENT_MAX_CHARS + 1) },
      raw: '<memory_update />',
    }, 'en');
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('memory_invalid_payload');
    expect(changed.calls).toHaveLength(0);

    // 边界：原样回传**恰好等于上限**的正文也要放行。
    const atLimit = 'x'.repeat(MEMORY_CONTENT_MAX_CHARS);
    const edge = countingRuntime(atLimit);
    const edgeResult = await executeMemoryToolCall(edge.runtime, {
      name: 'memory_update',
      payload: { id: 7, content: atLimit },
      raw: '<memory_update />',
    }, 'en');
    expect(edgeResult.ok).toBe(true);
    expect(edge.calls).toEqual([atLimit]);
  });
});

/**
 * `memory_update` 对**空白**字段的设防。
 *
 * ⚠️⚠️ **它守的是一条会漏成英文的路径**：`stringValue` 只判类型不判内容，
 * 一个 `'   '` 会原样穿透到 `store.updateMemory` → `decodePersistedMemoryRecord`
 * → `nonEmptyString` 才抛 `memory.name must be a non-empty string`。那条异常冒泡到
 * `executeRuntimeToolCall` 的 catch，被 `createBackgroundErrorResponse` 包成
 * `background_tool_execution_failed` **连同英文 message 回给模型**。
 *
 * ⚠️ **而 `memory_save` 挡得住**（它走 `requiredStringValue`，trim 过）——
 * 两者不对称正是这个缺陷的来源。所以本组同时钉住「save 拒绝、update 也拒绝」。
 */
describe('memory_update rejects blank fields instead of leaking a store error', () => {
  /** 记录**整条**被写入的记录（不只是 content），并模拟 store 侧的 `nonEmptyString` 校验。 */
  function recordingRuntime() {
    const written: Array<{ name: string; content: string }> = [];
    const runtime: MemoryToolRuntime = {
      async saveMemory() {
        return { id: 1 };
      },
      async getMemoryById() {
        return {
          id: 7,
          type: 'topic',
          name: '原标题',
          content: '原正文',
          description: '原标题',
          tags: ['a'],
          pinned: false,
          syncId: 's',
          createdAt: 1,
          updatedAt: 1,
          accessCount: 0,
          lastAccessedAt: 1,
        };
      },
      async updateMemory(mem) {
        // 与 `core/memory/codec.ts` 的 `nonEmptyString` 同形：store 层会在这里抛。
        const check = (value: string, path: string) => {
          if (value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
        };
        check(mem.syncId, 'memory.syncId');
        check(mem.name, 'memory.name');
        check(mem.content, 'memory.content');
        written.push({ name: mem.name, content: mem.content });
      },
      async deleteMemory() {},
    };
    return { runtime, written };
  }

  it('rejects a whitespace-only name before it reaches the store', async () => {
    const { runtime, written } = recordingRuntime();
    const result = await executeMemoryToolCall(runtime, {
      name: 'memory_update',
      payload: { id: 7, name: '   ', content: '原正文' },
      raw: '<memory_update />',
    }, 'zh-CN');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('memory_invalid_payload');
    // ⚠️ 判据是**本地化文案**，不是「抛了个错」—— 抛英文串正是要消掉的那个症状。
    expect(result.detail).toBe('name 必须是非空字符串');
    expect(written, '被拒的调用不该写进 store').toHaveLength(0);
  });

  it('rejects a whitespace-only content before it reaches the store', async () => {
    const { runtime, written } = recordingRuntime();
    const result = await executeMemoryToolCall(runtime, {
      name: 'memory_update',
      payload: { id: 7, name: '原标题', content: '   ' },
      raw: '<memory_update />',
    }, 'zh-CN');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('memory_invalid_payload');
    expect(result.detail).toBe('content 必须是非空字符串');
    expect(written).toHaveLength(0);
  });

  it('still allows omitting either field ("" must not be the rejection trigger)', async () => {
    // ⚠️⚠️ **这条是前两条的反面自检，缺了它判据会写成「trim 后为空就拒」** ——
    // 那种写法在「省略 name / 省略 content」时拿到 `''`，会把合法路径一起拦掉。
    const { runtime, written } = recordingRuntime();
    const result = await executeMemoryToolCall(runtime, {
      name: 'memory_update',
      payload: { id: 7 },
      raw: '<memory_update />',
    }, 'zh-CN');

    expect(result.ok).toBe(true);
    expect(written).toEqual([{ name: '原标题', content: '原正文' }]);
  });

  it('does not trim a name that has real content around its spaces', async () => {
    // 判据只管「纯空白」，不管「带空格的名字」—— 后者是合法输入，原样保留。
    const { runtime, written } = recordingRuntime();
    const result = await executeMemoryToolCall(runtime, {
      name: 'memory_update',
      payload: { id: 7, name: '  新标题  ' },
      raw: '<memory_update />',
    }, 'zh-CN');

    expect(result.ok).toBe(true);
    expect(written[0].name).toBe('  新标题  ');
  });

  it('turns a store-level "row is gone" into a user-facing not-found result', async () => {
    // ⚠️ **存储层拒绝与工具层失败是两件事** —— `deleteMemory` 在事务内查不到那条就抛
    // `memory_record_missing`，不接的话它会冒泡到后台通用 catch、被包成
    // `background_tool_execution_failed` 连同英文 message 回给模型。
    const runtime: MemoryToolRuntime = {
      async saveMemory() { return { id: 1 }; },
      async getMemoryById() { return null; },
      async updateMemory() {},
      async deleteMemory() { throw new Error(MEMORY_RECORD_MISSING_CODE); },
    };
    const result = await executeMemoryToolCall(runtime, {
      name: 'memory_delete',
      payload: { id: 4242 },
      raw: '<memory_delete />',
    }, 'en');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('memory_not_found');
    expect(result.error?.message).not.toContain('memory_record_missing');
  });

  it('still reports a successful delete when the store accepts it', async () => {
    const deleted: number[] = [];
    const runtime: MemoryToolRuntime = {
      async saveMemory() { return { id: 1 }; },
      async getMemoryById() { return null; },
      async updateMemory() {},
      async deleteMemory(id) { deleted.push(id); },
    };
    const result = await executeMemoryToolCall(runtime, {
      name: 'memory_delete',
      payload: { id: 7 },
      raw: '<memory_delete />',
    }, 'en');

    expect(result.ok).toBe(true);
    expect(deleted).toEqual([7]);
  });

  it.each([true, [7], 3.7, '0x10', {}, null])(
    'rejects a non-integer memory_delete id (%s) instead of coercing it',
    async (id) => {
      // schema 声明的是 `integer`，而裸 `Number()` 会把 `true` 转成 1、`[7]` 转成 7、
      // `3.7` 原样放行、`'0x10'` 转成 16 ⇒ 模型发个 `{"id": true}` 就会删掉第 1 条。
      let called = 0;
      const runtime: MemoryToolRuntime = {
        async saveMemory() { return { id: 1 }; },
        async getMemoryById() { return null; },
        async updateMemory() {},
        async deleteMemory() { called += 1; },
      };
      const result = await executeMemoryToolCall(runtime, {
        name: 'memory_delete',
        payload: { id },
        raw: '<memory_delete />',
      }, 'en');

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('memory_invalid_id');
      expect(called).toBe(0);
    },
  );

  it('still accepts a numeric string id, which is a legal integer spelling', async () => {
    // XML 里取值常带引号（`{"id":"7"}`），那是合法写法，不该因为引号被拒。
    const deleted: number[] = [];
    const runtime: MemoryToolRuntime = {
      async saveMemory() { return { id: 1 }; },
      async getMemoryById() { return null; },
      async updateMemory() {},
      async deleteMemory(id) { deleted.push(id); },
    };
    const result = await executeMemoryToolCall(runtime, {
      name: 'memory_delete',
      payload: { id: '7' },
      raw: '<memory_delete />',
    }, 'en');

    expect(result.ok).toBe(true);
    expect(deleted).toEqual([7]);
  });
});
