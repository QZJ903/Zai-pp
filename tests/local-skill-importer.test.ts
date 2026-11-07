import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_MCP_NATIVE_HOST, SHELL_MCP_SERVER_NAME } from '../core/shell';

vi.mock('../core/mcp/store', () => ({
  getAllMcpServers: vi.fn(),
  getMcpToolCache: vi.fn(),
  updateMcpServer: vi.fn(),
}));

vi.mock('../core/mcp/discovery', () => ({
  executeMcpToolCall: vi.fn(),
  getMcpToolDescriptors: vi.fn(),
  refreshMcpServerDiscovery: vi.fn(),
}));

import { executeMcpToolCall, getMcpToolDescriptors, refreshMcpServerDiscovery } from '../core/mcp/discovery';
import { getAllMcpServers, getMcpToolCache, updateMcpServer } from '../core/mcp/store';
import type { McpServerConfig, McpToolCacheEntry } from '../core/mcp/types';
import {
  importLocalSkillSource as importLocalSkillSourceWithRuntime,
  pickLocalSkillFolder as pickLocalSkillFolderWithRuntime,
  previewLocalSkillSource as previewLocalSkillSourceWithRuntime,
  relocateLocalSkillSource as relocateLocalSkillSourceWithRuntime,
  updateLocalSkillSource as updateLocalSkillSourceWithRuntime,
} from '../core/skill/local-importer';
import type { LocalSkillImportResponse, LocalSkillImportResult } from '../core/types';
import type { LocalStateMutationStage } from '../core/persistence/local-state-mutation';
import type { ToolCall, ToolResult } from '../core/types';

const SKILL_STORAGE_KEY = 'zai_pp_skills';

let storage: Record<string, unknown>;

const importerDeps = {
  executeToolCall: (call: ToolCall) => (
    executeMcpToolCall as unknown as (value: ToolCall) => Promise<ToolResult>
  )(call),
  async runLocalStateMutation<T>(stage: LocalStateMutationStage<T>): Promise<T> {
    return (await stage())();
  },
};

const previewLocalSkillSource = (rootPath: string) =>
  previewLocalSkillSourceWithRuntime(rootPath, importerDeps);
const pickLocalSkillFolder = (defaultPath?: string) =>
  pickLocalSkillFolderWithRuntime(defaultPath, importerDeps);
const importLocalSkillSource = (request: Parameters<typeof importLocalSkillSourceWithRuntime>[0]) =>
  importLocalSkillSourceWithRuntime(request, importerDeps);
const relocateLocalSkillSource = (sourceId: string, newRootPath: string) =>
  relocateLocalSkillSourceWithRuntime(sourceId, newRootPath, importerDeps);
const updateLocalSkillSource = (sourceId: string) =>
  updateLocalSkillSourceWithRuntime(sourceId, importerDeps);

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
      },
    },
  });
  const shellServer = createShellServer(['local_skill_preview', 'local_folder_pick']);
  vi.mocked(getAllMcpServers).mockResolvedValue([shellServer]);
  vi.mocked(updateMcpServer).mockImplementation(async (_id, patch) => ({
    ...shellServer,
    ...patch,
    allowlist: patch.allowlist ?? shellServer.allowlist,
  }));
  vi.mocked(refreshMcpServerDiscovery).mockResolvedValue({} as never);
  vi.mocked(getMcpToolCache).mockResolvedValue(createShellDiscovery([
    'local_skill_preview',
    'local_folder_pick',
  ]));
  vi.mocked(getMcpToolDescriptors).mockResolvedValue([]);
  vi.mocked(executeMcpToolCall).mockResolvedValue(createLocalSkillToolResult());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('local Skill importer', () => {
  it('picks local Skill folders through Shell MCP', async () => {
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createFolderPickToolResult());

    await expect(pickLocalSkillFolder('/Users/me/.codex/skills')).resolves.toBe('/Users/me/.codex/skills/demo');
    expect(executeMcpToolCall).toHaveBeenCalledWith(expect.objectContaining({
      name: 'local_folder_pick',
      descriptorId: 'mcp:shell-local:local_folder_pick',
      payload: {
        title: 'Choose a local Skill folder',
        defaultPath: '/Users/me/.codex/skills',
      },
    }));
  });

  it('leaves the Shell allowlist alone when picking folders', async () => {
    // ⚠️⚠️ **导入流程不再替用户打开工具** —— 它曾经调 `buildShellAllowlistUpgrade`
    // 把 `local_folder_pick` / `local_file_*` 补进名单，后果是用户关掉的工具
    // 每导入一次 Skill 又被打开一次。现在工具开关完全归用户；
    // 缺了就在执行时按需报错（文案见 `pickLocalSkillFolder` 的失败分支）。
    vi.mocked(getAllMcpServers).mockResolvedValueOnce([createShellServer(['shell_status', 'python_status'])]);
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createFolderPickToolResult());

    await expect(pickLocalSkillFolder()).resolves.toBe('/Users/me/.codex/skills/demo');
    expect(updateMcpServer, '导入流程不许写 allowlist').not.toHaveBeenCalled();
  });

  it('refreshes Shell discovery once when the folder picker cache is stale', async () => {
    vi.mocked(executeMcpToolCall)
      .mockResolvedValueOnce({
        ok: false,
        summary: 'MCP tool unavailable',
        detail: 'MCP tool is not available on server Shell Local.',
        name: 'local_folder_pick',
        error: {
          code: 'mcp_tool_not_found',
          message: 'MCP tool is not available on server Shell Local.',
          retryable: true,
        },
      })
      .mockResolvedValueOnce(createFolderPickToolResult());

    await expect(pickLocalSkillFolder()).resolves.toBe('/Users/me/.codex/skills/demo');
    expect(refreshMcpServerDiscovery).toHaveBeenCalledWith('shell-local');
    expect(executeMcpToolCall).toHaveBeenCalledTimes(2);
  });

  it('explains legacy Windows folder picker failures as stale Shell Native Host installs', async () => {
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce({
      ok: false,
      summary: 'MCP tool failed',
      detail: 'Command failed: powershell.exe -NoProfile -STA -Command Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {}; Choose a local Skill folder Choose : CommandNotFoundException',
      name: 'local_folder_pick',
      error: {
        code: 'mcp_tool_failed',
        message: 'Command failed: powershell.exe -NoProfile -STA -Command Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; Choose a local Skill folder Choose : CommandNotFoundException',
        retryable: false,
      },
    });

    const pick = pickLocalSkillFolder();
    await expect(pick).rejects.toThrow('copy the generated install command');
    await expect(pick).rejects.not.toThrow('<your-extension-id>');
  });

  it('tells the user where to re-enable a tool they turned off', async () => {
    // ⚠️⚠️ **这条是本轮改动的连带面**：改前启动链会把关掉的工具自动补回 allowlist
    // （那个升级已删除），所以用户永远撞不到 `mcp_tool_disabled`。
    // 现在它保持关闭 ⇒ 这里必须给一句「去哪儿打开」，而不是笼统的
    // `is disabled by server policy.`（既不说是哪个工具、也没说去哪儿开）。
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce({
      ok: false,
      summary: 'MCP tool disabled',
      detail: 'MCP tool local_folder_pick is disabled by server policy.',
      name: 'local_folder_pick',
      error: {
        code: 'mcp_tool_disabled',
        message: 'MCP tool local_folder_pick is disabled by server policy.',
        retryable: false,
      },
    });

    const pick = pickLocalSkillFolder();
    await expect(pick).rejects.toThrow('Open MCP > Shell Local, enable it in the tools list');
    // 反面自检：不能再说「重装 host」—— 重装解决不了「用户自己关掉了」。
    await expect(pick).rejects.not.toThrow('Reinstall');
  });

  it('treats a dismissed picker as "nothing happened" rather than a failure', async () => {
    // ⚠️ host 回的是**结构化错误码**，不是 message 文案 —— 判据必须落在码上，
    // 否则 host 改一次措辞，用户的取消就会重新变成一条红色报错。
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce({
      ok: false,
      summary: 'MCP tool failed',
      detail: 'Folder selection was cancelled.',
      name: 'local_folder_pick',
      error: {
        code: 'mcp_tool_result_error',
        message: 'Folder selection was cancelled.',
        retryable: false,
        details: { structuredCode: 'local_folder_pick_cancelled' },
      },
    });

    await expect(pickLocalSkillFolder()).resolves.toBeNull();
  });

  it('still fails loudly when the picker breaks without a cancellation code', async () => {
    // 反面自检：同样一句 message、但没有那个码 ⇒ 必须仍然抛错。
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce({
      ok: false,
      summary: 'MCP tool failed',
      detail: 'Folder selection was cancelled.',
      name: 'local_folder_pick',
      error: {
        code: 'mcp_tool_result_error',
        message: 'Folder selection was cancelled.',
        retryable: false,
      },
    });

    const pick = pickLocalSkillFolder();
    await expect(pick).rejects.toThrow('Folder selection was cancelled.');
  });

  it('previews and imports local Skills while preserving script execution boundaries', async () => {
    const preview = await previewLocalSkillSource('/Users/me/.codex/skills/demo');

    expect(preview.source.provider).toBe('local');
    expect(preview.skills[0]).toMatchObject({
      path: 'SKILL.md',
      importName: 'demo-local',
      description: 'Demo local Skill',
    });
    expect(preview.skills[0].scriptFiles).toEqual([{ path: 'scripts/run.py', bytes: 18 }]);

    const result = await importLocalSkillSource({
      rootPath: '/Users/me/.codex/skills/demo',
      selectedPaths: ['SKILL.md'],
    });
    expectImportSuccess(result);

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].remote).toMatchObject({
      provider: 'local',
      localRootPath: '/Users/me/.codex/skills/demo',
      localDirectory: '/Users/me/.codex/skills/demo',
      scriptFiles: [{ path: 'scripts/run.py', bytes: 18 }],
    });
    expect(result.imported[0].instructions).toContain('Local Execution Boundary');
    expect(result.imported[0].instructions).toContain('Run commands with the initial cwd set to the Skill directory path: /Users/me/.codex/skills/demo');
    expect(result.imported[0].instructions).toContain('scripts/run.py');
    expect(result.imported[0].instructions).toContain('Index form: true');
    expect(result.imported[0].instructions).toContain('Activation Notice');
    expect(result.imported[0].instructions).not.toContain('### references/guide.md');
    expect(storage[SKILL_STORAGE_KEY]).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'demo-local', source: 'remote' }),
    ]));
  });

  it('reports sizes in UTF-8 bytes, not UTF-16 code units', async () => {
    // A body made of 3-byte characters: `.length` and the byte count only differ here.
    const content = ['---', 'name: byte-unit-skill', 'description: 中文', '---', '', '# 中文标题', '', '正文内容。'].join('\n');
    const guideText = '指南内容。';
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce({
      ok: true,
      summary: 'MCP tool executed',
      output: {
        ok: true,
        data: {
          rootPath: '/Users/me/.codex/skills/byte-unit',
          displayName: 'byte-unit',
          directoryName: 'byte-unit',
          warnings: [],
          truncated: false,
          skills: [{
            path: 'SKILL.md',
            directory: '',
            directoryPath: '/Users/me/.codex/skills/byte-unit',
            content,
            includedFiles: [{
              path: 'references/guide.md',
              bytes: Buffer.byteLength(guideText, 'utf8'),
              content: guideText,
            }],
            omittedFiles: [],
            scriptFiles: [],
            warnings: [],
          }],
        },
      },
    });

    const preview = await previewLocalSkillSource('/Users/me/.codex/skills/byte-unit');
    const item = preview.skills[0];
    const expectedBodyBytes = Buffer.byteLength(content, 'utf8');
    const expectedGuideBytes = Buffer.byteLength(guideText, 'utf8');

    // 前提自检：这份夹具必须让「字符数」与「字节数」分开，否则断言证明不了任何事。
    expect(content.length).toBeLessThan(expectedBodyBytes);

    expect(item.bodyBytes).toBe(expectedBodyBytes);
    expect(item.bytes).toBe(expectedBodyBytes + expectedGuideBytes);
    expect(item.includedFiles[0].bytes).toBe(expectedGuideBytes);
  });

  it('renders nested local Skill resources relative to the Skill directory', async () => {
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createNestedLocalSkillToolResult());

    const result = await importLocalSkillSource({
      rootPath: '/Users/me/.codex/skills',
      selectedPaths: ['nested/SKILL.md'],
    });
    expectImportSuccess(result);

    const imported = result.imported[0];
    expect(imported.remote).toMatchObject({
      provider: 'local',
      localRootPath: '/Users/me/.codex/skills',
      localDirectory: '/Users/me/.codex/skills/nested',
      scriptFiles: [{ path: 'nested/scripts/run.py', bytes: 15 }],
    });
    expect(imported.instructions).toContain('Run commands with the initial cwd set to the Skill directory path: /Users/me/.codex/skills/nested');
    expect(imported.instructions).toContain('- scripts/run.py (15 bytes)');
    expect(imported.instructions).toContain('Index form: true');
    expect(imported.instructions).not.toContain('### references/child.md');
    expect(imported.instructions).not.toContain('- nested/scripts/run.py');
    expect(imported.instructions).not.toContain('### nested/references/child.md');
  });

  it('describes non-bundled local resources as available on demand', async () => {
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createLocalSkillWithOnDemandResourceToolResult());
    const discovery = createShellDiscovery(['local_file_read'], true, null, 'auto');
    vi.mocked(refreshMcpServerDiscovery).mockResolvedValueOnce(discovery);
    vi.mocked(getMcpToolDescriptors).mockResolvedValueOnce(discovery.descriptors);

    const result = await importLocalSkillSource({
      rootPath: '/Users/me/.codex/skills/demo',
      selectedPaths: ['SKILL.md'],
    });
    expectImportSuccess(result);

    const imported = result.imported[0];
    expect(imported.instructions).toContain('Supporting files available on demand: 1');
    expect(imported.instructions).toContain('## Supporting Files Available on Demand');
    expect(imported.instructions).toContain('Read them with the local file tool when the upstream instructions need them.');
    expect(imported.instructions).toContain('- references/extended-guide.md (2048 bytes)');
    expect(imported.instructions).not.toContain('## Omitted Supporting Files');
  });

  it('keeps preview available but blocks affected Skills on stale Shell Hosts', async () => {
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createLocalSkillWithOnDemandResourceToolResult());
    vi.mocked(refreshMcpServerDiscovery).mockResolvedValueOnce(createShellDiscovery(['local_skill_preview', 'shell_exec']));

    const preview = await previewLocalSkillSource('/Users/me/.codex/skills/demo');

    expect(preview.skills[0].importBlock).toEqual({
      code: 'shell_host_update_required',
    });
  });

  it('rejects on-demand imports when local_file_read is disabled by policy', async () => {
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createLocalSkillWithOnDemandResourceToolResult());
    vi.mocked(refreshMcpServerDiscovery).mockResolvedValueOnce(createShellDiscovery(['local_file_read'], false, null, 'auto'));

    await expect(importLocalSkillSource({
      rootPath: '/Users/me/.codex/skills/demo',
      selectedPaths: ['SKILL.md'],
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('not available to chat'),
      importBlock: {
        code: 'shell_reader_unavailable',
      },
    });
  });

  it('rejects manual readers that are not injected into the chat prompt', async () => {
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createLocalSkillWithOnDemandResourceToolResult());
    vi.mocked(refreshMcpServerDiscovery).mockResolvedValueOnce(createShellDiscovery(['local_file_read']));

    await expect(importLocalSkillSource({
      rootPath: '/Users/me/.codex/skills/demo',
      selectedPaths: ['SKILL.md'],
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('execution mode to Auto'),
      importBlock: {
        code: 'shell_reader_unavailable',
      },
    });
  });

  it('accepts an enabled auto shell_exec fallback on older Shell Hosts', async () => {
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createLocalSkillWithOnDemandResourceToolResult());
    const discovery = createShellDiscovery(['local_skill_preview', 'shell_exec'], true, null, 'auto');
    vi.mocked(refreshMcpServerDiscovery).mockResolvedValueOnce(discovery);
    vi.mocked(getMcpToolDescriptors).mockResolvedValueOnce(
      discovery.descriptors.filter((descriptor) => descriptor.name === 'shell_exec'),
    );

    await expect(previewLocalSkillSource('/Users/me/.codex/skills/demo')).resolves.toMatchObject({
      skills: [expect.objectContaining({
        omittedFiles: [expect.any(Object)],
        importBlock: undefined,
      })],
    });
  });

  it('surfaces Shell discovery failures while checking on-demand resource support', async () => {
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createLocalSkillWithOnDemandResourceToolResult());
    vi.mocked(refreshMcpServerDiscovery).mockResolvedValueOnce(createShellDiscovery([], true, 'native host disconnected'));

    await expect(importLocalSkillSource({
      rootPath: '/Users/me/.codex/skills/demo',
      selectedPaths: ['SKILL.md'],
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('native host disconnected'),
      importBlock: {
        code: 'shell_discovery_failed',
        detail: 'native host disconnected',
      },
    });
  });

  it('allows safe selections when a sibling Skill needs an unavailable reader', async () => {
    vi.mocked(executeMcpToolCall)
      .mockResolvedValueOnce(createMixedLocalSkillToolResult())
      .mockResolvedValueOnce(createSafeLocalSkillToolResult());
    vi.mocked(refreshMcpServerDiscovery).mockResolvedValueOnce(
      createShellDiscovery(['local_skill_preview', 'shell_exec']),
    );

    const preview = await previewLocalSkillSource('/Users/me/.codex/skills/demo');

    expect(preview.skills).toEqual([
      expect.objectContaining({
        path: 'SKILL.md',
        importName: 'demo-local',
        importBlock: {
          code: 'shell_host_update_required',
        },
      }),
      expect.objectContaining({
        path: 'safe/SKILL.md',
        importName: 'demo-local-2',
        importBlock: undefined,
      }),
    ]);

    const result = await importLocalSkillSource({
      rootPath: '/Users/me/.codex/skills/demo',
      selectedPaths: ['safe/SKILL.md'],
      selectedImportNames: {
        'safe/SKILL.md': preview.skills[1].importName,
      },
    });
    expectImportSuccess(result);

    expect(result.imported).toEqual([
      expect.objectContaining({ name: preview.skills[1].importName }),
    ]);
    expect(refreshMcpServerDiscovery).toHaveBeenCalledTimes(1);
    expect(executeMcpToolCall).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: {
        rootPath: '/Users/me/.codex/skills/demo',
        selectedPaths: ['safe/SKILL.md'],
      },
    }));
  });

  it('imports a BOM-prefixed SKILL.md without losing the frontmatter name', async () => {
    // Editors on Windows commonly save SKILL.md with a UTF-8 BOM. Previously
    // the BOM defeated the `^---` frontmatter fence, `name:` was dropped, and
    // the importer threw "Local Skill is missing a valid name."
    const content = [
      '---',
      'name: ref-material-writing',
      'description: BOM-safe import',
      '---',
      '',
      '# 参考材料写作',
      '',
      'body',
    ].join('\n');
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce({
      ok: true,
      summary: 'MCP tool executed',
      output: {
        ok: true,
        data: {
          rootPath: 'D:\\skills\\ref-material-writing',
          displayName: 'ref-material-writing',
          directoryName: 'ref-material-writing',
          warnings: [],
          truncated: false,
          skills: [
            {
              path: 'SKILL.md',
              directory: '',
              directoryPath: 'D:\\skills\\ref-material-writing',
              content: `\uFEFF${content}`,
              bodyBytes: content.length + 1,
              includedFiles: [],
              omittedFiles: [],
              scriptFiles: [],
              warnings: [],
            },
          ],
        },
      },
    });

    const result = await importLocalSkillSource({
      rootPath: 'D:\\skills\\ref-material-writing',
      selectedPaths: ['SKILL.md'],
    });
    expectImportSuccess(result);

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].name).toBe('ref-material-writing');
  });

  it('falls back to a hash slug when only a non-ASCII name is available', async () => {
    // No `name:` field, Chinese H1 title, Chinese directory — every source
    // slug is non-ASCII. The importer must not throw; it derives a stable
    // `skill-<hash>` slug so the user can rename it later.
    const content = ['---', 'description: 中文 only', '---', '', '# 参考材料写作', '', 'body'].join('\n');
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce({
      ok: true,
      summary: 'MCP tool executed',
      output: {
        ok: true,
        data: {
          rootPath: 'D:\\写作助手',
          displayName: '写作助手',
          directoryName: '写作助手',
          warnings: [],
          truncated: false,
          skills: [
            {
              path: 'SKILL.md',
              directory: '',
              directoryPath: 'D:\\写作助手',
              content,
              bodyBytes: content.length,
              includedFiles: [],
              omittedFiles: [],
              scriptFiles: [],
              warnings: [],
            },
          ],
        },
      },
    });

    const result = await importLocalSkillSource({
      rootPath: 'D:\\写作助手',
      selectedPaths: ['SKILL.md'],
    });
    expectImportSuccess(result);

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].name).toMatch(/^skill-[a-z0-9]{2,8}$/);
  });

  describe('relocateLocalSkillSource', () => {
    it('relocates a local Skill source to a renamed folder while preserving the source id', async () => {
      // 先正常导入，使 source 落盘（provider=local，id 由 rootPath 推导）。
      const imported = await importLocalSkillSource({
        rootPath: '/Users/me/.codex/skills/demo',
        selectedPaths: ['SKILL.md'],
      });
      expectImportSuccess(imported);
      const originalId = imported.source.id;
      expect(originalId).toBe('local:/Users/me/.codex/skills/demo');

      // 用户重新选择了改名后的文件夹。
      vi.mocked(executeMcpToolCall).mockResolvedValueOnce(
        createLocalSkillToolResultAt('/Users/me/.codex/skills/demo-renamed'),
      );

      const relocated = await relocateLocalSkillSource(originalId, '/Users/me/.codex/skills/demo-renamed');
      expect(relocated.ok).toBe(true);
      if (!relocated.ok) throw new Error(relocated.error);

      // 关键不变量：原地更新、保留原 source.id，激活引用 / 禁用状态 / 用户设置不断裂。
      expect(relocated.source.id).toBe(originalId);
      expect(relocated.source.rootPath).toBe('/Users/me/.codex/skills/demo-renamed');
      expect(relocated.source.displayName).toBe('demo-renamed');
      expect(relocated.source.skillPaths).toEqual(['SKILL.md']);
      expect(relocated.imported).toHaveLength(1);
      expect(relocated.imported[0].name).toBe('demo-local');
    });

    it('rejects an empty source id or empty new root path before touching storage', async () => {
      await expect(relocateLocalSkillSource('', '/Users/me/.codex/skills/demo'))
        .rejects.toThrow('Local Skill source id must be a non-empty string.');
      await expect(relocateLocalSkillSource('local:/x', ''))
        .rejects.toThrow('New root path must be a non-empty string.');
      await expect(relocateLocalSkillSource('local:/x', '   '))
        .rejects.toThrow('New root path must be a non-empty string.');
    });

    it('throws when the source id does not exist', async () => {
      await expect(
        relocateLocalSkillSource('local:does-not-exist', '/Users/me/.codex/skills/demo'),
      ).rejects.toThrow('Local Skill source was not found');
    });

    it('throws when the relocated folder no longer contains the selected Skill paths', async () => {
      const imported = await importLocalSkillSource({
        rootPath: '/Users/me/.codex/skills/demo',
        selectedPaths: ['SKILL.md'],
      });
      expectImportSuccess(imported);

      // 新文件夹里只有 nested/SKILL.md，没有原来选中的 SKILL.md。
      vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createNestedLocalSkillToolResult());

      await expect(
        relocateLocalSkillSource(imported.source.id, '/Users/me/.codex/skills/moved'),
      ).rejects.toThrow('Selected local Skill paths were not found: SKILL.md');
    });
  });

  describe('updateLocalSkillSource', () => {
    it('returns ok:false (not throw) when the original folder is gone, so the UI can offer relocation', async () => {
      const imported = await importLocalSkillSource({
        rootPath: '/Users/me/.codex/skills/demo',
        selectedPaths: ['SKILL.md'],
      });
      expectImportSuccess(imported);

      // 原文件夹被挪动：preview 返回空 skills → loadLocalSkillSource 抛 "No SKILL.md was found"。
      vi.mocked(executeMcpToolCall).mockResolvedValueOnce({
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
            skills: [],
          },
        },
      });

      // 关键：不抛异常，返回 ok:false，使 UI 进入 !response.ok 分支触发 relocate。
      await expect(updateLocalSkillSource(imported.source.id)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('No SKILL.md was found'),
      });
    });

    it('throws on a non-existent source id (unchanged contract)', async () => {
      await expect(updateLocalSkillSource('local:does-not-exist'))
        .rejects.toThrow('Local Skill source was not found');
    });
  });
});

function expectImportSuccess(
  response: LocalSkillImportResponse,
): asserts response is LocalSkillImportResult {
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(response.error);
}

function createShellServer(toolNames: string[]): McpServerConfig {
  return {
    id: 'shell-local',
    displayName: SHELL_MCP_SERVER_NAME,
    enabled: true,
    transport: { kind: 'native_messaging' as const, nativeHost: SHELL_MCP_NATIVE_HOST },
    execution: { enabled: true, mode: 'auto' as const },
    allowlist: { mode: 'allow' as const, toolNames },
    timeouts: { connectMs: 1, requestMs: 1, discoveryMs: 1 },
    limits: { maxResultBytes: 128_000, maxToolCount: 8 },
    headers: [],
    secrets: [],
    version: 1 as const,
    status: 'ready' as const,
    lastConnectedAt: 1,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createFolderPickToolResult() {
  return {
    ok: true,
    summary: 'MCP tool executed',
    output: {
      ok: true,
      data: {
        path: '/Users/me/.codex/skills/demo',
      },
    },
  };
}

function createLocalSkillToolResult() {
  const content = [
    '---',
    'name: demo-local',
    'description: Demo local Skill',
    'version: 1.2.3',
    '---',
    '',
    '# Demo',
    '',
    'Use scripts/run.py when computation is needed.',
  ].join('\n');

  return {
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
        skills: [
          {
            path: 'SKILL.md',
            directory: '',
            directoryPath: '/Users/me/.codex/skills/demo',
            content,
            bodyBytes: content.length,
            includedFiles: [
              {
                path: 'references/guide.md',
                bytes: 11,
                content: 'Guide text.',
              },
            ],
            omittedFiles: [],
            scriptFiles: [{ path: 'scripts/run.py', bytes: 18 }],
            warnings: [],
          },
        ],
      },
    },
  };
}

function createLocalSkillToolResultAt(rootPath: string) {
  const result = createLocalSkillToolResult();
  const skill = result.output.data.skills[0];
  return {
    ...result,
    output: {
      ...result.output,
      data: {
        ...result.output.data,
        rootPath,
        displayName: 'demo-renamed',
        directoryName: 'demo-renamed',
        skills: [{
          ...skill,
          directory: '',
          directoryPath: rootPath,
          content: skill.content,
        }],
      },
    },
  };
}

function createNestedLocalSkillToolResult() {
  const content = [
    '---',
    'name: nested-local',
    'description: Nested local Skill',
    '---',
    '',
    '# Nested',
    '',
    'Use references/child.md and scripts/run.py.',
  ].join('\n');

  return {
    ok: true,
    summary: 'MCP tool executed',
    output: {
      ok: true,
      data: {
        rootPath: '/Users/me/.codex/skills',
        displayName: 'skills',
        directoryName: 'skills',
        warnings: [],
        truncated: false,
        skills: [
          {
            path: 'nested/SKILL.md',
            directory: 'nested',
            directoryPath: '/Users/me/.codex/skills/nested',
            content,
            bodyBytes: content.length,
            includedFiles: [
              {
                path: 'nested/references/child.md',
                bytes: 11,
                content: 'Child guide.',
              },
            ],
            omittedFiles: [],
            scriptFiles: [{ path: 'nested/scripts/run.py', bytes: 15 }],
            warnings: [],
          },
        ],
      },
    },
  };
}

function createLocalSkillWithOnDemandResourceToolResult() {
  const result = createLocalSkillToolResult();
  return {
    ...result,
    output: {
      ...result.output,
      data: {
        ...result.output.data,
        skills: [{
          ...result.output.data.skills[0],
          omittedFiles: [{
            path: 'references/extended-guide.md',
            bytes: 2048,
          }],
        }],
      },
    },
  };
}

function createMixedLocalSkillToolResult() {
  const result = createLocalSkillWithOnDemandResourceToolResult();
  const safeContent = [
    '---',
    'name: demo-local',
    'description: Safe local Skill',
    '---',
    '',
    '# Safe',
  ].join('\n');
  return {
    ...result,
    output: {
      ...result.output,
      data: {
        ...result.output.data,
        skills: [
          ...result.output.data.skills,
          {
            path: 'safe/SKILL.md',
            directory: 'safe',
            directoryPath: '/Users/me/.codex/skills/demo/safe',
            content: safeContent,
            bodyBytes: safeContent.length,
            includedFiles: [],
            omittedFiles: [],
            scriptFiles: [],
            warnings: [],
          },
        ],
      },
    },
  };
}

function createSafeLocalSkillToolResult() {
  const result = createMixedLocalSkillToolResult();
  return {
    ...result,
    output: {
      ...result.output,
      data: {
        ...result.output.data,
        skills: result.output.data.skills.filter((skill) => skill.path === 'safe/SKILL.md'),
      },
    },
  };
}

function createShellDiscovery(
  toolNames: string[],
  enabled = true,
  error: string | null = null,
  mode: 'auto' | 'disabled' = 'auto',
): McpToolCacheEntry {
  const now = Date.now();
  return {
    serverId: 'shell-local',
    descriptors: toolNames.map((name) => ({
      id: `mcp:shell-local:${name}`,
      provider: {
        kind: 'mcp' as const,
        id: 'shell-local',
        displayName: SHELL_MCP_SERVER_NAME,
        transport: 'native_messaging' as const,
      },
      name,
      invocationName: name,
      title: name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      execution: {
        enabled,
        mode,
        risk: 'low' as const,
      },
    })),
    refreshedAt: now,
    expiresAt: now + 60_000,
    health: {
      serverId: 'shell-local',
      status: error ? 'error' : 'ready',
      checkedAt: now,
      latencyMs: 1,
      toolCount: toolNames.length,
      error,
    },
  };
}
