import { describe, expect, it } from 'vitest';
import { createSkillCreatorToolDescriptors } from '../core/skill/creator-tool';
import { createMemoryImportToolDescriptors } from '../core/memory/import-tool';
import { tool as zhTool } from '../core/i18n/resources/zh-CN/tool';
import { tool as enTool } from '../core/i18n/resources/en/tool';

/**
 * 喂给模型的 **schema 文案在 zh 下也用英文**。
 *
 * 这不是「漏翻译」：`### Tool <name>` 那一段是给模型读的工具说明，
 * 与用户界面无关，而英文 schema 对模型更稳。既有先例是 web / memory / browser
 * 三组工具的描述符（见 `core/i18n/resources/zh-CN/tool.ts` 的 `web` 块 ——
 * `searchTitle` / `searchDescription` 等在 zh 资源里也是英文）。
 *
 * ⚠️ **为什么要有这条测试**：i18n 的两个校验都不管这件事 ——
 * `verify:i18n` 的 locale-check 只比键的存在性、coverage-audit 只管有没有裸中文，
 * 两者都不看 zh 的值是什么语言。所以把 schema 文案改回中文**不会让任何检查变红**，
 * 只能靠这里钉住。
 *
 * ⚠️ **断言用「描述符」而不是「资源键」** —— 前者是模型真正拿到的东西，
 * 后者只是它的来源。这样将来描述符改成从别处取文案，这条测试仍然成立。
 */

/** CJK 统一表意文字（含扩展 A）：用户可见的中文文案一定落在这个区间。 */
const CJK = /[㐀-䶿一-鿿]/;

/** schema 键：`title` / `description` 与所有 `*Title` / `*Description`。 */
const SCHEMA_KEY = /^(title|description|.*(Title|Description))$/;

function schemaText(descriptor: {
  title: string;
  description: string;
  inputSchema: unknown;
}): string {
  return [descriptor.title, descriptor.description, JSON.stringify(descriptor.inputSchema)].join('\n');
}

describe('tool schema copy stays English under zh-CN', () => {
  it('keeps the Skill draft tool schema free of Chinese', () => {
    const [descriptor] = createSkillCreatorToolDescriptors('zh-CN');
    expect(descriptor).toBeDefined();
    expect(schemaText(descriptor!)).not.toMatch(CJK);
    // 与 en 同值 —— 这条排除了「碰巧没有中文、但两套语言各写一份」的漂移形态。
    expect(descriptor).toEqual(createSkillCreatorToolDescriptors('en')[0]);
  });

  it('keeps the memory import tool schema free of Chinese', () => {
    const [descriptor] = createMemoryImportToolDescriptors('zh-CN');
    expect(descriptor).toBeDefined();
    expect(schemaText(descriptor!)).not.toMatch(CJK);
    expect(descriptor).toEqual(createMemoryImportToolDescriptors('en')[0]);
  });

  it('still localizes the user-facing copy of those same tools', () => {
    // 反向守一条：**只把 schema 那部分统一成英文**，不能顺手把用户可见文案也英文化。
    // 判据是「同一个块里，schema 键两语言同值、UI 键两语言不同值且 zh 是中文」。
    for (const block of ['skillCreator', 'memoryImport'] as const) {
      const zhBlock = zhTool[block] as unknown as Record<string, unknown>;
      const enBlock = enTool[block] as unknown as Record<string, unknown>;

      const schemaKeys = Object.keys(zhBlock).filter((key) => SCHEMA_KEY.test(key));
      expect(schemaKeys.length).toBeGreaterThan(0);
      for (const key of schemaKeys) {
        expect(zhBlock[key], `${block}.${key} 应与 en 同值`).toBe(enBlock[key]);
      }

      // ⚠️ **递归下去** —— 卡片按钮与状态行都在 `result` 子对象里
      // （`result.saveSkill` / `result.imported`…），只扫顶层会漏掉它们。
      // 判据只用 CJK：它已经蕴含「与 en 不同值」（en 侧是英文），再加一条
      // `!== en` 是冗余的，反而会在将来某个键天然同值（纯格式串）时误红。
      for (const [key, value] of flattenStrings(zhBlock, block)) {
        expect(value, `${key} 应是中文`).toMatch(CJK);
      }
    }
  });
});

/** 把嵌套对象摊平成 `路径 → 字符串值`，并剔除 schema 键（那些本来就该是英文）。 */
function flattenStrings(
  value: Record<string, unknown>,
  prefix: string,
): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, entry] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if (SCHEMA_KEY.test(key)) continue;
    if (typeof entry === 'string') {
      out.push([path, entry]);
      continue;
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      out.push(...flattenStrings(entry as Record<string, unknown>, path));
    }
  }
  return out;
}
