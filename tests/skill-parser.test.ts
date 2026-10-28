import { describe, expect, it } from 'vitest';
import { parseSkillCommand } from '../core/skill/parser';

/**
 * 显式 `/技能名` 命令的解析 —— **唯一生产消费者**是内容脚本的
 * `resolveActiveLocalSkill`（`entrypoints/zai.content.ts`），它决定这一轮激活哪个技能、
 * 以及 `activeLocalSkillDir` 取哪个目录（后者随建授权上报给后台，用于 cwd 归一）。
 *
 * ⚠️⚠️ **这组测试守的是语义，不是接线** —— `resolveActiveLocalSkill` 是模块内私有，
 * 现有守卫（`tests/zai-content-local-skill-dir-contract.test.ts`）全是 AST 断言，
 * 只钉「调用存在 + 早于建授权」，**一条都没喂过这个函数真实输入**
 * —— **位置类断言替不了行为断言**。
 *
 * ⚠️ **失败方向是静默的**：`parseSkillCommand` 返回 null ⇒ 落到隐式激活分支
 * （`selectImplicitLocalSkill`）⇒ 隐式也没命中时，用户看到的是「技能没激活」，
 * 没有任何报错。
 *
 * ⚠️ **本组只钉「现在是什么行为」，不替产品做决定**。特别是「大小写敏感」那条：
 * 它记录的是现状，不是「应该这样」。
 */
describe('parseSkillCommand', () => {
  it('parses a bare command with no arguments', () => {
    expect(parseSkillCommand('/skill1')).toEqual({
      skillName: 'skill1',
      args: '',
      rawInput: '/skill1',
    });
  });

  it('splits arguments from the skill name', () => {
    expect(parseSkillCommand('/skill1 arg')).toEqual({
      skillName: 'skill1',
      args: 'arg',
      rawInput: '/skill1 arg',
    });
    // 多个空格只作分隔，不进 args（`\s*` 吃掉、剩余部分再 `trim`）。
    expect(parseSkillCommand('/skill1   two words')?.args).toBe('two words');
  });

  it('keeps everything after the first whitespace as raw arguments', () => {
    // ⚠️ args 里**可以再有斜杠** —— 删掉链式分支之后，这里不再被二次解析成技能名。
    // 钉住这一点是为了防止「顺手把 args 再 parse 一遍」的改动回来。
    expect(parseSkillCommand('/skill1 /skill2 arg')).toEqual({
      skillName: 'skill1',
      args: '/skill2 arg',
      rawInput: '/skill1 /skill2 arg',
    });
  });

  it('returns null for a bare slash', () => {
    expect(parseSkillCommand('/')).toBeNull();
  });

  it('returns null when the slash is not at the very start', () => {
    // ⚠️ **斜杠命令必须顶格** —— 前导空白一律不认。
    // 这条是刻意口径（`SKILL_TRIGGER_REGEX` 以 `^\/` 锚定），改动正则时容易顺手放宽。
    expect(parseSkillCommand('  /skill1')).toBeNull();
    expect(parseSkillCommand('\n/skill1')).toBeNull();
    expect(parseSkillCommand('use /skill1')).toBeNull();
  });

  it('swallows a second leading slash into the skill name', () => {
    // ⚠️ `\S+` 会把第二个斜杠吃进名字 ⇒ 得到 `skillName: "/skill2"`，**不是 null**。
    // 这个值匹配不到任何技能（技能名归一化后恒为 `[a-z0-9-]+`），所以最终行为等价于
    // 「不激活」；但**返回的是对象**，调用方会走进 `if (invocation)` 分支、
    // 在 `skills.find()` 里找不到、`resolveSkills` 返回 null。
    // ⇒ 路径绕一圈、结果对。钉住它，防止将来把 `\S+` 改成 `[^/\s]+` 时以为改坏了。
    expect(parseSkillCommand('//skill2')).toEqual({
      skillName: '/skill2',
      args: '',
      rawInput: '//skill2',
    });
  });

  it('trims trailing whitespace from arguments', () => {
    expect(parseSkillCommand('/skill1  ')?.args).toBe('');
    expect(parseSkillCommand('/skill1 arg   ')?.args).toBe('arg');
  });

  it('accepts non-ASCII skill names and arguments', () => {
    // 解析层不校验字符集（校验发生在技能名归一化那一层，结果恒为 `[a-z0-9-]+`）。
    // 所以 `/技能 参数` 在**解析**这一层是合法的 —— 它匹配不到技能是下游的事。
    expect(parseSkillCommand('/技能 参数')).toEqual({
      skillName: '技能',
      args: '参数',
      rawInput: '/技能 参数',
    });
  });

  it('is case-sensitive', () => {
    // ⚠️ **记录现状，不是「应该这样」**：技能名在存储里恒为小写
    // （`normalizeSkillName` 会 `toLowerCase`），而调用方用 `===` 比对
    // ⇒ 手打 `/Demo` 匹配不到 `demo`。
    // 斜杠补全插入的是 `/${item.name}`（已小写），所以**用补全不会撞上**，手打才会。
    // 要不要改成大小写不敏感是产品决定，这里只钉住当前行为。
    const parsed = parseSkillCommand('/Demo');
    expect(parsed?.skillName).toBe('Demo');
    expect(parsed?.skillName).not.toBe('demo');
  });
});