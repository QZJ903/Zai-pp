import { describe, expect, it } from 'vitest';
import {
  areMemoriesImported,
  isSkillDraftSaved,
} from '../core/ui/tool-result-saved-state';
import type { Skill } from '../core/types';

/**
 * 「这份结果是不是已经落库了」—— 卡片上还给不给动作按钮的判据。
 *
 * ⚠️ 这一组守的是**判据本身**（纯函数），不是渲染。渲染侧「按钮该不该出现」
 * 由 `tool-result-renderer.test.ts` 守。
 */

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'greeting',
    description: 'Say hi',
    instructions: 'Always greet the user warmly.',
    source: 'custom',
    memoryEnabled: true,
    ...overrides,
  };
}

describe('isSkillDraftSaved', () => {
  it('matches a saved custom Skill by name and instructions', () => {
    expect(isSkillDraftSaved(skill(), [skill()])).toBe(true);
  });

  it('ignores whitespace differences in the instructions', () => {
    expect(isSkillDraftSaved(skill(), [skill({ instructions: '  Always greet the user warmly.  ' })]))
      .toBe(true);
  });

  it('does not match when the same name has different instructions', () => {
    // ⚠️ 只看名字的话，用户改过正文的草稿会被判成「已保存」、再也存不进去。
    expect(isSkillDraftSaved(skill(), [skill({ instructions: 'Different body entirely.' })]))
      .toBe(false);
  });

  it('does not match when the same body has a different name', () => {
    // ⚠️ 只看正文的话，改名后的草稿会被判成「已保存」。
    expect(isSkillDraftSaved(skill(), [skill({ name: 'other' })])).toBe(false);
  });

  it('does not count builtin or remote Skills as the saved draft', () => {
    // 草稿存进去会新建一条 custom 记录；同名的内置 / 远程 Skill 不算数。
    expect(isSkillDraftSaved(skill(), [skill({ source: 'builtin' })])).toBe(false);
    expect(isSkillDraftSaved(skill(), [skill({ source: 'remote' })])).toBe(false);
  });

  it('returns false for an empty library', () => {
    expect(isSkillDraftSaved(skill(), [])).toBe(false);
  });
});

describe('areMemoriesImported', () => {
  const drafts = [{ content: 'Alpha memory' }, { content: 'Beta  memory' }];

  it('is true only when every draft already exists', () => {
    expect(areMemoriesImported(drafts, [
      { content: 'alpha memory' },
      { content: 'beta memory' },
    ])).toBe(true);
  });

  it('is false when only some drafts exist', () => {
    // ⚠️ **判「全部」而不是「任意一条」** —— 部分导入过时仍要能补进去。
    expect(areMemoriesImported(drafts, [{ content: 'alpha memory' }])).toBe(false);
  });

  it('normalizes whitespace and case before comparing', () => {
    // 归一化必须与后台判重同源（`memoryDedupeKey`）。
    expect(areMemoriesImported([{ content: 'Alpha   MEMORY' }], [{ content: 'alpha memory' }]))
      .toBe(true);
  });

  it('is false when the drafts have no comparable content', () => {
    expect(areMemoriesImported([], [{ content: 'alpha memory' }])).toBe(false);
    expect(areMemoriesImported([{ name: 'no content' }], [{ content: 'alpha memory' }]))
      .toBe(false);
  });
});
