import { describe, expect, it } from 'vitest';
import {
  buildLocalSkillSystemContext,
  composeLocalSkillPrompt,
  isLocalIndexSkill,
  resolveSkills,
  selectImplicitLocalSkill,
  wrapUserInput,
  type AugmentationSkill,
} from '../core/interceptor/request-augmentation';
import { isLocalIndexInstructions, LOCAL_INDEX_MARKER } from '../core/skill/local-importer';

/**
 * 本地索引 Skill 的**激活分支**：索引形态检测、隐式打分命中、显式 `/名字`、
 * 以及「只有本地索引 Skill 才注入执行边界」这条隔离保证。
 *
 * 从上游 `request-augmentation-local.test.ts` 移植。⚠️ **被测入口换了**：
 * 上游测的是 `augmentRequestBody`（一次调用返回 `agentTaskPrompt` / `body` /
 * `activeLocalSkillDir`），而本项目**没有这个函数** —— 那条链现在是
 * `entrypoints/zai.content.ts` 的 `augmentPrompt`（模块内私有，测不了），
 * 它调用的这几个 helper 才是**可测的公开面**。
 *
 * 所以本文件测的是**同一批契约的公开面**：
 *  ① `isLocalIndexSkill` 必须**同时**要求 `remote.provider === 'local'` 与索引标记
 *    —— 只看标记会让一个恰好含该串的 builtin/github skill 被误当本地索引技能；
 *  ② 隐式打分**只在本地索引技能里选**（旧快照 / builtin / github 一律不参与）
 *    —— 这是「不波及原有行为」的全部依据；
 *  ③ 显式 `/名字` 命中本地索引技能才追加 `## Local Execution Boundary`，
 *    其余来源**原样透传**；
 *  ④ 边界段**不重复追加**（技能正文里已经写了就不再加）。
 *
 * ⚠️ 上游有、本项目**没有**的一条：`activeLocalSkillDir`。那个字段在上游由
 * `augmentRequestBody` 返回；本项目改由 `zai.content.ts` 就地算出来（见
 * `paragraph` 里的 `let activeLocalSkillDir`），不进公开面 ⇒ 这里不测。
 */

const MARKER = LOCAL_INDEX_MARKER; // 'Index form: true'

function indexInstructions(name: string, dir: string): string {
  return [
    `# Local Skill: ${name}`,
    '',
    '## Zai++ Import Metadata',
    '',
    `- ${MARKER}`,
    `- Skill directory path: ${dir}`,
    '',
    '## Activation Notice',
    '',
    `- Read the Skill definition file with the local file tool: ${dir}/SKILL.md`,
  ].join('\n');
}

const LEGACY_INSTRUCTIONS = [
  '# Local Skill: legacy',
  '',
  'This is the old frozen snapshot body (no index marker).',
].join('\n');

/**
 * ⚠️ fixture 全部走 `as unknown as AugmentationSkill` 收口 —— 与上游同一手法。
 * 这里只关心 `isLocalIndexSkill` 真正读的三个字段（`remote.provider` /
 * `instructions` / `remote.localDirectory`），而 `RemoteSkillMetadata` 要求
 * `sourceId` / `path` / `includedFiles` 等一堆与激活判定无关的字段。
 * 逐个补齐只会让 fixture 变成噪音，还会在类型演进时无谓地碎掉。
 */
function localIndexSkill(overrides: Partial<AugmentationSkill> = {}): AugmentationSkill {
  return {
    name: 'demo',
    instructions: indexInstructions('demo', '/skills/demo'),
    memoryEnabled: false,
    source: 'remote',
    description: '适用场景：生成周报、日报、总结',
    remote: { provider: 'local', localDirectory: '/skills/demo', localRootPath: '/skills/demo' },
    ...overrides,
  } as unknown as AugmentationSkill;
}

function legacyLocalSkill(): AugmentationSkill {
  return {
    name: 'legacy',
    instructions: LEGACY_INSTRUCTIONS,
    memoryEnabled: false,
    source: 'remote',
    description: '适用场景：生成周报',
    remote: { provider: 'local', localDirectory: '/skills/legacy', localRootPath: '/skills/legacy' },
  } as unknown as AugmentationSkill;
}

function builtinSkill(): AugmentationSkill {
  return {
    name: 'writer',
    instructions: 'You are a writing assistant.',
    memoryEnabled: false,
    source: 'builtin',
    description: '适用场景：生成周报',
  } as unknown as AugmentationSkill;
}

function githubSkill(): AugmentationSkill {
  // ⚠️ 本项目 `SkillSource` 是 `'builtin' | 'custom' | 'remote'`（上游多 `third-party` /
  // `official`）—— github 来源在两边都是 `source: 'remote'` + `remote.provider: 'github'`。
  return {
    name: 'gh',
    instructions: 'GitHub skill body.',
    memoryEnabled: false,
    source: 'remote',
    description: 'GitHub 集成',
    remote: { provider: 'github' },
  } as unknown as AugmentationSkill;
}

describe('isLocalIndexInstructions / isLocalIndexSkill（索引形态检测）', () => {
  it('含索引标记 → true；旧快照 / undefined / 空 → false', () => {
    expect(isLocalIndexInstructions(indexInstructions('demo', '/skills/demo'))).toBe(true);
    expect(isLocalIndexInstructions(LEGACY_INSTRUCTIONS)).toBe(false);
    expect(isLocalIndexInstructions(undefined)).toBe(false);
    expect(isLocalIndexInstructions('')).toBe(false);
  });

  it('必须同时是 local provider 且含标记 —— 只看标记会把别家技能误判成本地索引', () => {
    expect(isLocalIndexSkill(localIndexSkill())).toBe(true);
    // 有标记但 provider 不是 local
    expect(isLocalIndexSkill({
      ...builtinSkill(),
      instructions: indexInstructions('writer', '/skills/writer'),
    })).toBe(false);
    // 是 local 但没有标记（旧快照）
    expect(isLocalIndexSkill(legacyLocalSkill())).toBe(false);
    // 连 remote 都没有
    expect(isLocalIndexSkill(builtinSkill())).toBe(false);
  });
});

describe('selectImplicitLocalSkill（隐式打分激活）', () => {
  it('用户输入命中描述中的场景词 → 选中该本地索引技能', () => {
    // ⚠️ 判据是**子串**：打分器对中文走 2-gram + 子串匹配，
    // 所以查询要用描述里真实出现的词（「周报」），不是自然语句。
    // 已实测：'周报' → 命中；'帮我生成本周周报' → 不命中。
    expect(selectImplicitLocalSkill([localIndexSkill()], '周报')?.name).toBe('demo');
  });

  it('旧快照（无索引标记）不参与隐式打分', () => {
    expect(selectImplicitLocalSkill([legacyLocalSkill()], '周报')).toBeNull();
  });

  it('builtin / github 来源不参与隐式打分', () => {
    expect(selectImplicitLocalSkill([builtinSkill()], '周报')).toBeNull();
    expect(selectImplicitLocalSkill([githubSkill()], '周报')).toBeNull();
  });

  it('混在一堆非本地技能里时，只从本地索引技能中选', () => {
    const picked = selectImplicitLocalSkill(
      [builtinSkill(), githubSkill(), legacyLocalSkill(), localIndexSkill()],
      '周报',
    );
    expect(picked?.name).toBe('demo');
  });

  it('没有本地索引技能时直接返回 null（不落到别的来源上）', () => {
    expect(selectImplicitLocalSkill(
      [builtinSkill(), githubSkill(), legacyLocalSkill()],
      '周报',
    )).toBeNull();
  });
});

describe('composeLocalSkillPrompt（激活时的索引指令 + 执行边界）', () => {
  it('本地索引技能 → 原索引正文 + `## Local Execution Boundary` + skillDir', () => {
    const prompt = composeLocalSkillPrompt(localIndexSkill());

    expect(prompt).toContain(MARKER);
    expect(prompt).toContain('## Local Execution Boundary');
    expect(prompt).toContain('/skills/demo');
  });

  it('正文里已经有边界段 → 不重复追加', () => {
    const withBoundary = localIndexSkill({
      instructions: `${indexInstructions('demo', '/skills/demo')}\n\n## Local Execution Boundary\n\n- 已经写过了`,
    });
    const prompt = composeLocalSkillPrompt(withBoundary);

    // 只应出现一次（原正文那一次）
    expect(prompt.split('## Local Execution Boundary')).toHaveLength(2);
  });

  it('没有 localDirectory 时不追加边界（无 skillDir 可指）', () => {
    const noDir = {
      name: 'nodb',
      instructions: indexInstructions('nodb', '/skills/nodb'),
      memoryEnabled: false,
      source: 'remote',
      description: '无目录',
      remote: { provider: 'local' },
    } as unknown as AugmentationSkill;
    const prompt = composeLocalSkillPrompt(noDir);

    expect(prompt).toBe(noDir.instructions);
    expect(prompt).not.toContain('## Local Execution Boundary');
  });
});

describe('resolveSkills（显式 /名字 命中）', () => {
  it('命中的是本地索引技能 → 注入执行边界', () => {
    const resolved = resolveSkills([localIndexSkill()], 'demo', '写本周周报', 'en');

    expect(resolved).not.toBeNull();
    expect(resolved!.combinedPrompt).toContain('## Local Execution Boundary');
    expect(resolved!.combinedPrompt).toContain(MARKER);
    expect(resolved!.skillName).toBe('demo');
  });

  it('命中的是 github 技能 → 指令原样透传，**不注入**执行边界', () => {
    const resolved = resolveSkills([githubSkill()], 'gh', 'do something', 'en');

    expect(resolved).not.toBeNull();
    expect(resolved!.combinedPrompt).toContain('GitHub skill body.');
    expect(resolved!.combinedPrompt).not.toContain('## Local Execution Boundary');
  });

  it('命中的是 builtin 技能 → 同样原样透传', () => {
    const resolved = resolveSkills([builtinSkill()], 'writer', '', 'en');

    expect(resolved!.combinedPrompt).toBe('You are a writing assistant.');
  });

  it('名字不存在 → null', () => {
    expect(resolveSkills([localIndexSkill()], 'nope', '', 'en')).toBeNull();
  });

  it('带参数时按 wrapper 包一层（保留用户输入）', () => {
    const resolved = resolveSkills([githubSkill()], 'gh', '用户补充', 'en');

    expect(resolved!.combinedPrompt).toContain('GitHub skill body.');
    expect(resolved!.combinedPrompt).toContain('用户补充');
    expect(resolved!.combinedPrompt).toBe(
      wrapUserInput('GitHub skill body.', '用户补充', 'en'),
    );
  });
});

describe('buildLocalSkillSystemContext（激活指令 + 索引正文）', () => {
  it('注入 SKILL.md 读取指令，并把索引正文接在后面', () => {
    const resolved = { combinedPrompt: 'BODY', memoryEnabled: false, skillName: 'demo' };
    const context = buildLocalSkillSystemContext(resolved, '/skills/demo', 'en');

    // 指令里要出现可点的绝对路径 —— 模型据此决定去哪读定义文件
    expect(context).toContain('/skills/demo/SKILL.md');
    expect(context).toContain('BODY');
  });

  it('拿不到 skillDir 时退回相对路径（不编造假绝对路径）', () => {
    const resolved = { combinedPrompt: 'BODY', memoryEnabled: false, skillName: 'demo' };
    const context = buildLocalSkillSystemContext(resolved, undefined, 'en');

    expect(context).toContain('SKILL.md');
    expect(context).not.toContain('/skills/');
  });
});