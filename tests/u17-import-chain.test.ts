import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 技能与记忆导入链的回归用例。
 *
 * 覆盖五组、每组对应一条实测缺陷：
 *  ① GitHub 更新不被「预览前 N 个」的上限截断成删除（>80 个 SKILL.md 时）；
 *  ② 资源收集不把同目录下嵌套的子技能 `SKILL.md` 当支持文件；
 *  ③ GitHub 解析器的三档兜底：BOM 前缀、无 frontmatter 时的 H1、根级无名字；
 *  ④ 嵌套本地技能的索引卡相对引用能改写成绝对路径（清单基与 skillDir 不同）；
 *  ⑤ 自动激活设置的并发保存按 `get,set,get,set` 串行；
 *  ⑥ 记忆导入超长条目拒绝而非静默截断（JSON / 纯文本 / 恰好 8000 三档）；
 *  ⑦ `updateLocalSkillSource` 只把「路径不可用」转成 `ok:false`，存储失败原样抛；
 *  ⑧ host 错误码两侧镜像 + host 真跑返回结构化码。
 *
 * ⚠️ **有几条在修复前的代码上也是绿的**（尤其 BOM 一条：`fetch().text()` 自己会吃
 * BOM），它们的价值是锁住「将来别退回去」，不是证明当时坏。
 */

let storage: Record<string, unknown>;

beforeEach(() => {
  storage = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[] | null | undefined) => {
          if (typeof key === 'string') return { [key]: storage[key] };
          if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, storage[item]]));
          return { ...storage };
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          storage = { ...storage, ...values };
        }),
        remove: vi.fn(async (key: string) => { delete storage[key]; }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const commitSha = 'c0ffee';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
function textResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

/** 构造一个 SKILL.md 数量可控的 fake GitHub。`count` 个技能，路径 a00/SKILL.md … */
function installFakeGitHub(options: {
  count: number;
  skillFiles?: Record<string, string>;
  extraTree?: Array<{ path: string; size: number }>;
  /** Blobs the fake tree reports **without** a `size` field (GitHub does this for large blobs). */
  extraTreeWithoutSize?: Array<{ path: string }>;
}) {
  const paths = Array.from({ length: options.count }, (_, i) => `s${String(i).padStart(3, '0')}/SKILL.md`);
  const tree = [
    ...paths.map((path) => ({ path, mode: '100644', type: 'blob', sha: `sha-${path}`, size: 60, url: '' })),
    ...(options.extraTree ?? []).map((entry) => ({ path: entry.path, mode: '100644', type: 'blob', sha: `sha-${entry.path}`, size: entry.size, url: '' })),
    ...(options.extraTreeWithoutSize ?? []).map((entry) => ({ path: entry.path, mode: '100644', type: 'blob', sha: `sha-${entry.path}`, url: '' })),
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/repos/owner/repo')) {
      return jsonResponse({ full_name: 'owner/repo', html_url: 'https://github.com/owner/repo', default_branch: 'main', license: null, description: null });
    }
    if (/\/repos\/owner\/repo\/git\/trees\/[^?]+\?recursive=1$/.test(url)) {
      return jsonResponse({ sha: commitSha, truncated: false, tree });
    }
    if (url.includes('/repos/owner/repo/commits/')) {
      return jsonResponse({ sha: commitSha });
    }
    if (url.endsWith('.codex-plugin/plugin.json') || url.endsWith('.claude-plugin/plugin.json') || url.endsWith('/package.json')) {
      return new Response('', { status: 404 });
    }
    const rawPrefix = `https://raw.githubusercontent.com/owner/repo/${commitSha}/`;
    if (url.startsWith(rawPrefix)) {
      const path = decodeURIComponent(url.slice(rawPrefix.length));
      if (options.skillFiles && path in options.skillFiles) return textResponse(options.skillFiles[path]);
      if (paths.includes(path)) {
        const dir = path.split('/')[0];
        return textResponse(['---', `name: ${dir}`, `description: Skill ${dir}`, '---', '', `# ${dir}`, '', 'Body.'].join('\n'));
      }
      if (options.skillFiles && options.skillFiles[`__resource__${path}`] !== undefined) {
        return textResponse(options.skillFiles[`__resource__${path}`]);
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, paths };
}

describe('U17-1 GitHub 更新不被预览上限截断', () => {
  it('仓库 SKILL.md 超 80 个时，已导入的尾部技能仍随更新保留', async () => {
    storage.zai_pp_skill_sources = [{
      id: `github:owner/repo:main:.`,
      provider: 'github',
      url: 'https://github.com/owner/repo',
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      ref: 'main',
      rootPath: '',
      commitSha: 'oldsha',
      defaultBranch: 'main',
      repoUrl: 'https://github.com/owner/repo',
      skillPaths: ['s000/SKILL.md', 's099/SKILL.md'],
      importedSkillNames: ['s000', 's099'],
      importedAt: 1,
      updatedAt: 1,
    }];
    storage.zai_pp_skills = [
      { name: 's000', description: '', instructions: 'x', source: 'remote', memoryEnabled: false, enabled: true, remote: { provider: 'github', sourceId: `github:owner/repo:main:.`, path: 's000/SKILL.md', originalName: 's000', importedAt: 1, updatedAt: 1, includedFiles: [], omittedFiles: [], warnings: [] } },
      { name: 's099', description: '', instructions: 'x', source: 'remote', memoryEnabled: false, enabled: true, remote: { provider: 'github', sourceId: `github:owner/repo:main:.`, path: 's099/SKILL.md', originalName: 's099', importedAt: 1, updatedAt: 1, includedFiles: [], omittedFiles: [], warnings: [] } },
    ];
    // 上游现在有 100 个技能（s000…s099），s099 落在第 100 位 —— 超出预览上限
    installFakeGitHub({ count: 100 });

    const { updateGitHubSkillSource } = await import('../core/skill/github-importer');
    const deps = { runLocalStateMutation: async (stage: () => Promise<() => Promise<unknown>>) => (await stage())() };
    const result = await updateGitHubSkillSource(`github:owner/repo:main:.`, deps as never);

    expect(result.ok).toBe(true);
    expect(result.source.skillPaths).toEqual(['s000/SKILL.md', 's099/SKILL.md']);
    expect(result.imported.map((skill) => skill.name)).toEqual(['s000', 's099']);
  });
});

describe('U17-9 资源收集不吞嵌套 SKILL.md', () => {
  it('同目录下 sub/SKILL.md 不进父技能的 includedFiles', async () => {
    installFakeGitHub({
      count: 1,
      skillFiles: {
        's000/SKILL.md': ['---', 'name: parent', 'description: Parent', '---', '', '# Parent'].join('\n'),
        's000/sub/SKILL.md': ['---', 'name: child', 'description: Child', '---', '', '# Child'].join('\n'),
        '__resource__s000/references/guide.md': 'Guide.',
      },
      extraTree: [
        { path: 's000/sub/SKILL.md', size: 40 },
        { path: 's000/references/guide.md', size: 6 },
      ],
    });

    const { previewGitHubSkillSource } = await import('../core/skill/github-importer');
    const preview = await previewGitHubSkillSource('https://github.com/owner/repo');

    const parent = preview.skills.find((skill) => skill.path === 's000/SKILL.md');
    expect(parent?.includedFiles.map((file) => file.path)).toEqual(['s000/references/guide.md']);
  });
});

describe('U17-5 GitHub SKILL.md 解析兜底', () => {
  it('BOM 前缀不丢 frontmatter', async () => {
    installFakeGitHub({
      count: 1,
      skillFiles: { 's000/SKILL.md': '﻿---\nname: bom-skill\ndescription: BOM safe\n---\n\n# BOM' },
    });
    const { previewGitHubSkillSource } = await import('../core/skill/github-importer');
    const preview = await previewGitHubSkillSource('https://github.com/owner/repo');
    expect(preview.skills[0]).toMatchObject({ name: 'bom-skill', importName: 'bom-skill', description: 'BOM safe' });
  });

  it('无 frontmatter 时用 H1 作名字', async () => {
    installFakeGitHub({
      count: 1,
      skillFiles: { 's000/SKILL.md': '# Writing Helper\n\nDoes writing things.' },
    });
    const { previewGitHubSkillSource } = await import('../core/skill/github-importer');
    const preview = await previewGitHubSkillSource('https://github.com/owner/repo');
    expect(preview.skills[0]).toMatchObject({ importName: 'writing-helper' });
  });

  it('根级 SKILL.md 且无名字时不抛错，用 hash 兜底', async () => {
    installFakeGitHub({
      count: 0,
      skillFiles: { 'SKILL.md': '没有名字也没有 frontmatter 的正文。' },
      extraTree: [{ path: 'SKILL.md', size: 40 }],
    });
    const { previewGitHubSkillSource } = await import('../core/skill/github-importer');
    const preview = await previewGitHubSkillSource('https://github.com/owner/repo');
    expect(preview.skills).toHaveLength(1);
    expect(preview.skills[0].importName).toMatch(/^skill-/);
  });
});

describe('U17-8 自动激活设置并发保存', () => {
  it('并发保存的读-写时刻序列是串行的（get,set,get,set）', async () => {
    const ops: string[] = [];
    const local = (globalThis as unknown as { chrome: { storage: { local: {
      get: (k: string) => Promise<Record<string, unknown>>;
      set: (v: Record<string, unknown>) => Promise<void>;
    } } } }).chrome.storage.local;
    const originalGet = local.get;
    const originalSet = local.set;
    local.get = async (key: string) => { ops.push('get'); return originalGet(key); };
    local.set = async (value: Record<string, unknown>) => { ops.push('set'); return originalSet(value); };

    const { saveSkillAutoActivationSettings, getSkillAutoActivationSettings } = await import('../core/skill/auto-activation-settings');
    await Promise.all([
      saveSkillAutoActivationSettings({ everyMessage: true }),
      saveSkillAutoActivationSettings({ everyMessage: false }),
    ]);

    // 没有队列时是 get,get,set,set —— 两次读都拿到同一份旧快照，后写者抹掉前者。
    expect(ops).toEqual(['get', 'set', 'get', 'set']);
    // 最终值：第二次 patch 显式关掉 everyMessage（firstMessage 保持来自第一次写入后的值）。
    expect(await getSkillAutoActivationSettings()).toEqual({ firstMessage: true, everyMessage: false });
  });
});

describe('U17-2 嵌套本地技能的绝对化清单', () => {
  it('rootPath 相对清单 + localRootPath 作基 → 索引卡里的相对引用能命中', async () => {
    const { composeLocalSkillPrompt } = await import('../core/interceptor/request-augmentation');
    const skill = {
      name: 'nested-demo',
      instructions: [
        '# Local Skill: nested-demo',
        '- Index form: true',
        '',
        '见 [指南](references/child.md) 与 [脚本](scripts/run.py)',
      ].join('\n'),
      memoryEnabled: false,
      source: 'remote',
      description: '适用场景：测试',
      remote: {
        provider: 'local',
        sourceId: 'local:/skills',
        path: 'nested/SKILL.md',
        originalName: 'nested-demo',
        importedAt: 1,
        updatedAt: 1,
        localRootPath: '/skills',
        localDirectory: '/skills/nested',
        includedFiles: [{ path: 'nested/references/child.md', bytes: 10 }],
        omittedFiles: [],
        scriptFiles: [{ path: 'nested/scripts/run.py', bytes: 20 }],
        warnings: [],
      },
    };

    const prompt = composeLocalSkillPrompt(skill as never);

    expect(prompt).toContain('[指南](/skills/nested/references/child.md)');
    expect(prompt).toContain('[脚本](/skills/nested/scripts/run.py)');
  });
});


  it('判据是错误码不是文案：message 换了措辞仍归 local_path_unavailable', async () => {
    const { importLocalSkillSource, updateLocalSkillSource } = await import('../core/skill/local-importer');
    const claudeSkill = ['---', 'name: demo-local', 'description: Demo', '---', '', '# Demo'].join('\n');
    await installShellServer();
    const deps = {
      executeToolCall: async () => ({
        ok: true, summary: 'ok',
        output: { ok: true, data: {
          rootPath: '/Users/me/.codex/skills/demo', displayName: 'demo', directoryName: 'demo',
          warnings: [], truncated: false,
          skills: [{ path: 'SKILL.md', directory: '', directoryPath: '/Users/me/.codex/skills/demo',
            content: claudeSkill, bodyBytes: claudeSkill.length,
            includedFiles: [], omittedFiles: [], scriptFiles: [], warnings: [] }],
        } },
      }),
      async runLocalStateMutation<T>(stage: () => Promise<() => Promise<T>>): Promise<T> { return (await stage())(); },
    };
    const imported = await importLocalSkillSource(
      { rootPath: '/Users/me/.codex/skills/demo', selectedPaths: ['SKILL.md'] },
      deps as never,
    );
    if (!imported.ok) throw new Error(imported.error);

    const renamedMessageDeps = {
      executeToolCall: async () => ({
        ok: false,
        summary: 'failed',
        error: {
          code: 'mcp_tool_result_error',
          message: 'The folder you picked is gone.', // 完全不同的措辞
          retryable: false,
          details: { structuredCode: 'local_skill_root_unreadable' },
        },
      }),
      async runLocalStateMutation<T>(stage: () => Promise<() => Promise<T>>): Promise<T> { return (await stage())(); },
    };
    await expect(updateLocalSkillSource(imported.source.id, renamedMessageDeps as never)).resolves.toMatchObject({
      ok: false,
      importBlock: { code: 'local_path_unavailable' },
    });
  });

  it('没有结构化码时一律按普通失败重抛（不回落到文案匹配）', async () => {
    const { importLocalSkillSource, updateLocalSkillSource } = await import('../core/skill/local-importer');
    const claudeSkill = ['---', 'name: demo-local', 'description: Demo', '---', '', '# Demo'].join('\n');
    await installShellServer();
    const deps = {
      executeToolCall: async () => ({
        ok: true, summary: 'ok',
        output: { ok: true, data: {
          rootPath: '/Users/me/.codex/skills/demo', displayName: 'demo', directoryName: 'demo',
          warnings: [], truncated: false,
          skills: [{ path: 'SKILL.md', directory: '', directoryPath: '/Users/me/.codex/skills/demo',
            content: claudeSkill, bodyBytes: claudeSkill.length,
            includedFiles: [], omittedFiles: [], scriptFiles: [], warnings: [] }],
        } },
      }),
      async runLocalStateMutation<T>(stage: () => Promise<() => Promise<T>>): Promise<T> { return (await stage())(); },
    };
    const imported = await importLocalSkillSource(
      { rootPath: '/Users/me/.codex/skills/demo', selectedPaths: ['SKILL.md'] },
      deps as never,
    );
    if (!imported.ok) throw new Error(imported.error);

    const legacyDeps = {
      executeToolCall: async () => ({
        ok: false,
        summary: 'failed',
        error: {
          code: 'mcp_tool_result_error',
          // 老 host（未升级）：只有这段文本，没有 structuredContent.error.code
          message: 'Local Skill root is not a readable directory: /Users/me/.codex/skills/demo',
          retryable: false,
        },
      }),
      async runLocalStateMutation<T>(stage: () => Promise<() => Promise<T>>): Promise<T> { return (await stage())(); },
    };
    // ⚠️ **刻意不按文案回落** —— 老 host 上这会被当成普通失败（用户看到原始报错），
    // 而不是「引导重新选择文件夹」。这是 D2-B 的显式取舍：宁可少引导，也不按文案猜。
    await expect(updateLocalSkillSource(imported.source.id, legacyDeps as never))
      .rejects.toThrow('Local Skill root is not a readable directory');
  });

describe('U17-6（D1-A）记忆导入超长条目拒绝而非截断', () => {
  it('JSON 分支：超长条目计入 rejected + overLimit，不进 memories', async () => {
    const { previewMemoryImport } = await import('../core/memory/importer');
    const overlong = 'x'.repeat(8001);
    const preview = previewMemoryImport({
      content: JSON.stringify([
        { type: 'user', name: 'ok', content: 'short' },
        { type: 'user', name: 'long', content: overlong },
      ]),
    });
    expect(preview.memories.map((m) => m.name)).toEqual(['ok']);
    expect(preview.rejected).toBe(1);
    expect(preview.overLimit).toBe(1);
    // 落库的就是原文，没有被悄悄砍短
    expect(preview.memories[0].content).toBe('short');
  });

  it('纯文本分支：超长段落逐段拒绝，不打断其余段落', async () => {
    const { previewMemoryImport } = await import('../core/memory/importer');
    const preview = previewMemoryImport({
      content: ['第一段正常内容。', 'y'.repeat(8001), '第三段也正常。'].join('\n\n'),
    });
    expect(preview.memories).toHaveLength(2);
    expect(preview.rejected).toBe(1);
    expect(preview.overLimit).toBe(1);
  });

  it('边界：恰好 8000 字仍然收下', async () => {
    const { previewMemoryImport } = await import('../core/memory/importer');
    const preview = previewMemoryImport({ content: 'z'.repeat(8000) });
    expect(preview.memories).toHaveLength(1);
    expect(preview.rejected).toBe(0);
    expect(preview.overLimit).toBe(0);
  });
});




async function installShellServer() {
  const { createMcpServer } = await import('../core/mcp/store');
  const { createShellMcpPresetInput } = await import('../core/shell');
  await createMcpServer(createShellMcpPresetInput({ enabled: true }));
}

describe('U17-7（D2-A）update 失败分档', () => {
  it('存储写失败原样抛，不再伪装成「文件夹失效」', async () => {
    // 构造一个真实可用的 preview 响应，但让落库阶段（runLocalStateMutation）抛错。
    const { importLocalSkillSource, updateLocalSkillSource } = await import('../core/skill/local-importer');
    const claudeSkill = ['---', 'name: demo-local', 'description: Demo', '---', '', '# Demo'].join('\n');
    const toolResult = {
      ok: true,
      summary: 'MCP tool executed',
      output: {
        ok: true,
        data: {
          rootPath: '/Users/me/.codex/skills/demo',
          displayName: 'demo',
          directoryName: 'demo',
          warnings: [],
          truncated: false,
          skills: [{
            path: 'SKILL.md', directory: '', directoryPath: '/Users/me/.codex/skills/demo',
            content: claudeSkill, bodyBytes: claudeSkill.length,
            includedFiles: [], omittedFiles: [], scriptFiles: [], warnings: [],
          }],
        },
      },
    };
    await installShellServer();

    const deps = {
      executeToolCall: async () => toolResult,
      async runLocalStateMutation<T>(stage: () => Promise<() => Promise<T>>): Promise<T> {
        return (await stage())();
      },
    };
    const imported = await importLocalSkillSource(
      { rootPath: '/Users/me/.codex/skills/demo', selectedPaths: ['SKILL.md'] },
      deps as never,
    );
    if (!imported.ok) throw new Error(`import failed: ${imported.error}`);

    const failingDeps = {
      executeToolCall: async () => toolResult,
      async runLocalStateMutation(): Promise<never> {
        throw new Error('quota exceeded');
      },
    };
    await expect(updateLocalSkillSource(imported.source.id, failingDeps as never))
      .rejects.toThrow('quota exceeded');
  });

  it('文件夹真的不见了 → ok:false + local_path_unavailable', async () => {
    const { importLocalSkillSource, updateLocalSkillSource } = await import('../core/skill/local-importer');
    const claudeSkill = ['---', 'name: demo-local', 'description: Demo', '---', '', '# Demo'].join('\n');
    const goodResult = {
      ok: true, summary: 'ok',
      output: { ok: true, data: {
        rootPath: '/Users/me/.codex/skills/demo', displayName: 'demo', directoryName: 'demo',
        warnings: [], truncated: false,
        skills: [{ path: 'SKILL.md', directory: '', directoryPath: '/Users/me/.codex/skills/demo',
          content: claudeSkill, bodyBytes: claudeSkill.length,
          includedFiles: [], omittedFiles: [], scriptFiles: [], warnings: [] }],
      } },
    };
    await installShellServer();
    const deps = {
      executeToolCall: async () => goodResult,
      async runLocalStateMutation<T>(stage: () => Promise<() => Promise<T>>): Promise<T> { return (await stage())(); },
    };
    const imported = await importLocalSkillSource(
      { rootPath: '/Users/me/.codex/skills/demo', selectedPaths: ['SKILL.md'] },
      deps as never,
    );
    if (!imported.ok) throw new Error(`import failed: ${imported.error}`);

    // 原文件夹被删：host 报 "Local Skill root is not a readable directory:"
    // D2-B：判据是 host 的**结构化错误码**（`normalizeMcpToolResult` 把它透到
    // `error.details.structuredCode`），不是 message 文案。
    const goneDeps = {
      executeToolCall: async () => ({
        ok: false,
        summary: 'failed',
        error: {
          code: 'mcp_tool_result_error',
          message: 'Local Skill root is not a readable directory: /Users/me/.codex/skills/demo',
          retryable: false,
          details: { externalOutcome: 'confirmed', retrySafe: false, structuredCode: 'local_skill_root_unreadable' },
        },
      }),
      async runLocalStateMutation<T>(stage: () => Promise<() => Promise<T>>): Promise<T> { return (await stage())(); },
    };
    await expect(updateLocalSkillSource(imported.source.id, goneDeps as never)).resolves.toMatchObject({
      ok: false,
      importBlock: { code: 'local_path_unavailable' },
    });
  });
});

describe('D2-B · host 错误码两侧镜像', () => {
  it('host 常量与扩展侧常量逐码相同（且集合大小一致）', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const hostSource = readFileSync(
      resolve(import.meta.dirname, '../packages/shell-host/native/contracts.mjs'),
      'utf8',
    );
    const hostBlock = hostSource.slice(
      hostSource.indexOf('const LOCAL_SKILL_ERROR_CODES'),
      hostSource.indexOf('});', hostSource.indexOf('const LOCAL_SKILL_ERROR_CODES')) + 3,
    );
    const hostCodes = [...hostBlock.matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(hostCodes.length).toBeGreaterThan(0);

    const { LOCAL_SKILL_ERROR_CODES } = await import('../core/shell/contracts');
    const extensionCodes = Object.values(LOCAL_SKILL_ERROR_CODES);
    expect(new Set(hostCodes)).toEqual(new Set(extensionCodes));
  });
});

describe('D2-B · host 真的返回结构化错误码', () => {
  it('一个不存在的 root 返回 isError + structuredContent.error.code', async () => {
    const { spawn } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const hostPath = resolve(import.meta.dirname, '../packages/shell-host/native/shell-mcp-host.mjs');
    const child = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const response = await new Promise<Record<string, any>>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => { child.kill(); rejectPromise(new Error('host timeout')); }, 10_000);
      let buffer = Buffer.alloc(0);
      child.stdout.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        clearTimeout(timer);
        child.stdin.end();
        resolvePromise(JSON.parse(buffer.subarray(4, length + 4).toString('utf8')));
      });
      child.on('error', rejectPromise);
      const payload = JSON.stringify({
        protocol: 'zai-pp-mcp-native',
        version: 1,
        message: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'local_skill_preview', arguments: { rootPath: '/definitely/not/here/u17' } },
        },
      });
      const body = Buffer.from(payload, 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      child.stdin.write(Buffer.concat([header, body]));
    });

    const result = response.result;
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.error?.code).toBe('local_skill_root_unreadable');
    expect(result?.structuredContent?.ok).toBe(false);
  });
});

describe('顺带修复回归', () => {
  it('小写 skill.md 也认作 Skill 定义（不再报「找不到 SKILL.md」）', async () => {
    installFakeGitHub({
      count: 0,
      skillFiles: {
        'docs/skill.md': ['---', 'name: lower-case-skill', 'description: Lower case', '---', '', '# Lower'].join('\n'),
      },
      extraTree: [{ path: 'docs/skill.md', size: 60 }],
    });

    const { previewGitHubSkillSource } = await import('../core/skill/github-importer');
    const preview = await previewGitHubSkillSource('https://github.com/owner/repo');

    expect(preview.skills).toHaveLength(1);
    expect(preview.skills[0]).toMatchObject({
      path: 'docs/skill.md',
      importName: 'lower-case-skill',
    });
  });

  it('嵌套的小写 skill.md 也不会被当成父技能的支持文件', async () => {
    installFakeGitHub({
      count: 1,
      skillFiles: {
        's000/SKILL.md': ['---', 'name: parent', 'description: Parent', '---', '', '# Parent'].join('\n'),
        's000/child/skill.md': ['---', 'name: child', 'description: Child', '---', '', '# Child'].join('\n'),
        '__resource__s000/references/guide.md': 'Guide.',
      },
      extraTree: [
        { path: 's000/child/skill.md', size: 40 },
        { path: 's000/references/guide.md', size: 6 },
      ],
    });

    const { previewGitHubSkillSource } = await import('../core/skill/github-importer');
    const preview = await previewGitHubSkillSource('https://github.com/owner/repo');

    // 两个条目都会作为独立 Skill 被发现，父技能的清单里不含子技能正文
    const parent = preview.skills.find((skill) => skill.path === 's000/SKILL.md');
    expect(parent?.includedFiles.map((file) => file.path)).toEqual(['s000/references/guide.md']);
  });
});

describe('N1 · tree 条目缺 size 时不按 0 放行', () => {
  it('缺 size 的资源不出现在 includedFiles，且给出告警', async () => {
    installFakeGitHub({
      count: 1,
      skillFiles: {
        's000/SKILL.md': ['---', 'name: parent', 'description: Parent', '---', '', '# Parent'].join('\n'),
      },
      // 手工注入一条**没有 size 字段**的 blob，模拟 GitHub 对大文件省略 size 的形状
      extraTreeWithoutSize: [{ path: 's000/references/huge.md' }],
    });

    const { previewGitHubSkillSource } = await import('../core/skill/github-importer');
    const preview = await previewGitHubSkillSource('https://github.com/owner/repo');

    const parent = preview.skills.find((skill) => skill.path === 's000/SKILL.md');
    expect(parent?.includedFiles.map((file) => file.path)).toEqual([]);
    expect(parent?.omittedFiles.map((file) => file.path)).toEqual(['s000/references/huge.md']);
    expect(parent?.warnings.join(' ')).toContain('未返回文件大小');
  });
});

describe('A · 结构化错误码穿过 native 往返到达 ToolResult', () => {
  it('host 的 structuredContent.error.code 变成 error.details.structuredCode', async () => {
    const { createMcpNativeMessagingTransport, callMcpTool } = await import('../core/mcp');

    const listeners: Array<(value: unknown) => void> = [];
    const posted: any[] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        connectNative: vi.fn(() => ({
          postMessage: vi.fn((value: unknown) => {
            posted.push(value);
            // 收到请求后，立刻按 host 的真实回包形状回一帧：
            // JSON-RPC 顶层带 id，result 里是 { isError, content, structuredContent }。
            const envelope = value as { message?: { id?: unknown } };
            const reply = {
              jsonrpc: '2.0',
              id: envelope.message?.id,
              result: {
                isError: true,
                content: [{ type: 'text', text: 'Local Skill root is not a readable directory: /gone' }],
                structuredContent: {
                  ok: false,
                  error: {
                    code: 'local_skill_root_unreadable',
                    message: 'Local Skill root is not a readable directory: /gone',
                  },
                },
              },
            };
            queueMicrotask(() => {
              for (const listener of listeners) listener(reply);
            });
          }),
          onMessage: { addListener: vi.fn((listener: (value: unknown) => void) => listeners.push(listener)) },
          onDisconnect: { addListener: vi.fn() },
        })),
        lastError: undefined,
      },
    });

    try {
      const server = {
        version: 1,
        id: 'shell-local',
        displayName: 'Shell Local',
        enabled: true,
        transport: { kind: 'native_messaging', nativeHost: 'com.zai_pp.shell' },
        headers: [],
        secrets: [],
        timeouts: { connectMs: 5000, requestMs: 120000, discoveryMs: 10000 },
        limits: { maxResultBytes: 128000, maxToolCount: 12 },
        allowlist: { mode: 'all', toolNames: [] },
        execution: { mode: 'auto', enabled: true },
        status: 'ready',
        lastConnectedAt: null,
        lastError: null,
        createdAt: 0,
        updatedAt: 0,
      } as never;

      const transport = createMcpNativeMessagingTransport(server);
      const result = await callMcpTool(server, transport, {
        call: {
          name: 'local_skill_preview',
          invocationName: 'local_skill_preview',
          payload: { rootPath: '/gone' },
          raw: '',
        } as never,
      });

      expect(result.ok).toBe(false);
      // 关键断言：host 的机器可读码穿过了 transport 与 normalizeMcpToolResult。
      expect((result.error?.details as Record<string, unknown>)?.structuredCode)
        .toBe('local_skill_root_unreadable');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('truncated 的两个口径恒等（记录为什么没有区分用例）', () => {
  // ⚠️ 这一节**不是**在测「两个判据不同」，而是在测它们的结果一致。
  //
  // 旧判据 `skillPaths.length > MAX_SKILLS_PER_SOURCE` 与新判据
  // `limitedPaths.length < skillPaths.length` 在 pinned 语义下恒等：
  //   · limitedPaths 最多 MAX 条；skillPaths 超过 MAX 时至少丢掉一条 ⇒ 两边都 true
  //   · skillPaths 不超过 MAX 时 pinned 也装得下 ⇒ 两边都 false
  // ⇒ **不存在能区分两者的输入**，所以这组用例只能锁「结果一致」，锁不了「判据换了」。
  // 换判据的理由是可读性（直写「本次预览是否被截断」），不是行为修正。

  it('上游 100 个、无 pinned ⇒ truncated 为 true 且只给 80 条', async () => {
    installFakeGitHub({ count: 100 });
    const { previewGitHubSkillSource } = await import('../core/skill/github-importer');
    const preview = await previewGitHubSkillSource('https://github.com/owner/repo');
    expect(preview.truncated).toBe(true);
    expect(preview.skills).toHaveLength(80);
  });

  it('上游恰好 80 个 ⇒ truncated 为 false 且全给', async () => {
    installFakeGitHub({ count: 80 });
    const { previewGitHubSkillSource } = await import('../core/skill/github-importer');
    const preview = await previewGitHubSkillSource('https://github.com/owner/repo');
    expect(preview.truncated).toBe(false);
    expect(preview.skills).toHaveLength(80);
  });

  it('上游 100 个、pinned 占满 80 ⇒ truncated 仍为 true', async () => {
    const all = Array.from({ length: 100 }, (_, i) => `s${String(i).padStart(3, '0')}/SKILL.md`);
    const pinned = all.slice(0, 80);
    installFakeGitHub({ count: 100 });
    storage.zai_pp_skill_sources = [{
      id: 'github:owner/repo:main:.',
      provider: 'github', url: 'https://github.com/owner/repo',
      owner: 'owner', repo: 'repo', repository: 'owner/repo',
      ref: 'main', rootPath: '', commitSha: 'old', defaultBranch: 'main',
      repoUrl: 'https://github.com/owner/repo',
      skillPaths: pinned, importedSkillNames: pinned.map((p) => p.split('/')[0]),
      importedAt: 1, updatedAt: 1,
    }];
    storage.zai_pp_skills = pinned.map((path) => ({
      name: path.split('/')[0], description: '', instructions: 'x',
      source: 'remote', memoryEnabled: false, enabled: true,
      remote: { provider: 'github', sourceId: 'github:owner/repo:main:.', path,
        originalName: path.split('/')[0], importedAt: 1, updatedAt: 1,
        includedFiles: [], omittedFiles: [], warnings: [] },
    }));

    const { updateGitHubSkillSource } = await import('../core/skill/github-importer');
    const deps = { runLocalStateMutation: async (stage: () => Promise<() => Promise<unknown>>) => (await stage())() };
    // 更新路径不返回 preview（它返回 imported/replaced）；这里只验它不会抛
    // —— `truncated` 本身只出现在 preview 上，由前两条覆盖。
    await expect(updateGitHubSkillSource('github:owner/repo:main:.', deps as never)).resolves.toMatchObject({ ok: true });
  });
});

describe('截断告警的措辞与 pinned 一致', () => {
  it('有 pinned 时不说「前 N 个」—— 保留的不是上游排序的前几个', async () => {
    const all = Array.from({ length: 100 }, (_, i) => `s${String(i).padStart(3, '0')}/SKILL.md`);
    const pinned = [...all.slice(0, 78), ...all.slice(90, 92)]; // 两条故意取尾部
    installFakeGitHub({ count: 100 });
    storage.zai_pp_skill_sources = [{
      id: 'github:owner/repo:main:.',
      provider: 'github', url: 'https://github.com/owner/repo',
      owner: 'owner', repo: 'repo', repository: 'owner/repo',
      ref: 'main', rootPath: '', commitSha: 'old', defaultBranch: 'main',
      repoUrl: 'https://github.com/owner/repo',
      skillPaths: pinned, importedSkillNames: pinned.map((x) => x.split('/')[0]),
      importedAt: 1, updatedAt: 1,
    }];
    storage.zai_pp_skills = pinned.map((path) => ({
      name: path.split('/')[0], description: '', instructions: 'x',
      source: 'remote', memoryEnabled: false, enabled: true,
      remote: { provider: 'github', sourceId: 'github:owner/repo:main:.', path,
        originalName: path.split('/')[0], importedAt: 1, updatedAt: 1,
        includedFiles: [], omittedFiles: [], warnings: [] },
    }));

    // `check` 会把 `loadGitHubSkillSource` 的 warnings 透出来，正好能验措辞。
    const { checkGitHubSkillSourceUpdates } = await import('../core/skill/github-importer');
    const update = await checkGitHubSkillSourceUpdates('github:owner/repo:main:.');

    const text = update.warnings.join(' ');
    expect(text).toContain('预览上限 80 个');
    expect(text).toContain('已导入的 80 个优先保留');
    // 关键：不再声称「前 N 个」—— 保留集里有排在尾部的路径
    expect(text).not.toContain('仅预览前');
  });

  it('无 pinned 时保留原来的「仅预览前 N 个」措辞', async () => {
    installFakeGitHub({ count: 100 });
    const { previewGitHubSkillSource } = await import('../core/skill/github-importer');
    const preview = await previewGitHubSkillSource('https://github.com/owner/repo');
    expect(preview.warnings.join(' ')).toContain('仅预览前 80 个');
    expect(preview.warnings.join(' ')).not.toContain('优先保留');
  });
});
