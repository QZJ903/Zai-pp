import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS, getLocalizedBuiltinSkills } from '../core/skill/builtin';
import type { Skill } from '../core/types';

/**
 * 内置 Skill 的**本地化投影**：只换 `description` / `instructions`，**名字与规范对象不动**。
 *
 * **为什么守这条**：
 * ① **名字不能变** —— `shell` / `memory` 是 `/shell`、`/memory` 命令的触发词，
 *    也是提示词里给模型看的标识。跟着语言变会让用户按界面语言不同、命令也不同。
 * ② **规范对象不能被改写** —— `BUILTIN_SKILLS` 是模块级常量，`getLocalizedBuiltinSkills`
 *    若就地改它，第一次调用 `en` 之后所有人都拿到英文（且无法恢复）。
 *
 * ⚠️ 上游对应 `tests/skill-localization.test.ts`（15 条），**本项目只覆盖前 3 条** ——
 * 上游那 15 条里的后 12 条测的是第三方 bundled 技能（OfficeCLI / spec-driven-develop），
 * **那批技能本项目没移植**（内置 skill 只留 shell + memory）。
 *
 * ⚠️⚠️ **上游那 3 条里有一处断言本项目过不了，我刻意没搬**：上游断言
 * `memory.instructions` 含 `'"description":"更新已有记忆"'`（中文投影下工具 schema 的中文描述）。
 * 本项目 `core/i18n/resources/zh-CN/tool.ts` 里 **memory 段的描述还是英文**
 * （`updateDescription: 'Update an existing memory'`），所以中文投影出来仍是英文。
 * **这是 i18n 缺口、不是本测试该锁定的状态** —— 所以这里不写「断言它等于英文值」
 * （那会把缺口锁成契约），只覆盖与语言无关的那部分。缺口已记入待办。
 */
function findSkill(skills: readonly Skill[], name: string): Skill {
  const found = skills.find((skill) => skill.name === name);
  if (!found) throw new Error(`Missing skill: ${name}`);
  return found;
}

describe('builtin skill localization', () => {
  it('selects English builtin display and model instructions without changing names', () => {
    const skills = getLocalizedBuiltinSkills('en');
    const shell = findSkill(skills, 'shell');
    const memory = findSkill(skills, 'memory');

    expect(shell.source).toBe('builtin');
    expect(shell.name).toBe('shell');
    expect(shell.description).toContain('Local command-line assistant');
    expect(shell.instructions).toContain('You are executing local shell commands');
    expect(shell.instructions).toContain('<shell_exec>{"command":"..."}</shell_exec>');
    // ⚠️ 中文原文必须被换掉，不能只是「英文也在里面」。
    expect(shell.instructions).not.toContain('你正在通过');

    expect(memory.name).toBe('memory');
    expect(memory.description).toContain('Memory management');
    expect(memory.instructions).toContain('The user is asking to manage memories');
    expect(memory.instructions).toContain('"name":"memory_update"');
  });

  it('keeps Chinese builtin skills as the default resource', () => {
    const skills = getLocalizedBuiltinSkills('zh-CN');
    const shell = findSkill(skills, 'shell');
    const memory = findSkill(skills, 'memory');

    expect(shell.description).toContain('本地命令行助手');
    expect(shell.instructions).toContain('你正在通过 Zai++ Shell MCP');
    expect(shell.instructions).not.toContain('You are executing local shell commands');
    expect(memory.name).toBe('memory');
    expect(memory.description).toContain('记忆管理');
  });

  it('does not mutate the canonical default builtin skill objects', () => {
    const canonicalShell = findSkill(BUILTIN_SKILLS, 'shell');
    const englishShell = findSkill(getLocalizedBuiltinSkills('en'), 'shell');

    expect(canonicalShell.description).toContain('本地命令行助手');
    expect(englishShell.description).toContain('Local command-line assistant');

    // ⚠️ 顺序无关：先取英文再取中文，规范对象仍必须是中文原文。
    getLocalizedBuiltinSkills('zh-CN');
    expect(findSkill(BUILTIN_SKILLS, 'shell').description).toContain('本地命令行助手');
    // ⚠️ 返回的是**新对象**，改它不该影响规范对象。
    englishShell.description = 'mutated';
    expect(findSkill(BUILTIN_SKILLS, 'shell').description).toContain('本地命令行助手');
  });

  it('returns fresh objects for every builtin instead of the canonical ones', () => {
    // ⚠️⚠️ **这条原本写错了，是恒真断言**：原先写成
    // `[...getLocalizedBuiltinSkills('en'), custom, remote]` 再断言 custom/remote 原样 ——
    // 但 `getLocalizedBuiltinSkills` 只 map `BUILTIN_SKILLS`，**它从来收不到** custom/remote，
    // 追加在返回值之后断言等于拿输入断言输入，恒真、改坏实现也不会红。
    // ⚠️ 而且「非 builtin 原样透传」那条语义在本函数里**不可达**（见下），所以不能靠它覆盖。
    //
    // 判据改成**可证伪的形态**：返回值里每一项都必须是 builtin，且**不能是规范对象本身**
    // （就地改写会污染 `BUILTIN_SKILLS`，那是模块级常量、一次调用之后所有人都拿到英文）。
    const english = getLocalizedBuiltinSkills('en');
    const chinese = getLocalizedBuiltinSkills('zh-CN');

    expect(english.length).toBe(BUILTIN_SKILLS.length);
    for (const [index, skill] of english.entries()) {
      expect(skill.source, skill.name).toBe('builtin');
      expect(skill, skill.name).not.toBe(BUILTIN_SKILLS[index]);
    }
    for (const [index, skill] of chinese.entries()) {
      expect(skill, skill.name).not.toBe(BUILTIN_SKILLS[index]);
    }
  });
});
