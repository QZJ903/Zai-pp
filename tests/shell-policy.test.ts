import { describe, expect, it } from 'vitest';
import {
  buildShellAllowlistUpgrade,
  buildShellToolLimitUpgrade,
  createShellMcpPresetInput,
  DEFAULT_SHELL_MCP_ALLOWLIST_TOOL_NAMES,
  isShellMcpServer,
} from '../core/shell/policy';
import { SHELL_TOOL_NAMES } from '../core/shell/contracts';

describe('createShellMcpPresetInput', () => {
  it('defaults Shell MCP to auto execution while disabled by default', () => {
    const preset = createShellMcpPresetInput();

    expect(preset.enabled).toBe(false);
    expect(preset.allowlist).toEqual({ mode: 'allow', toolNames: [...DEFAULT_SHELL_MCP_ALLOWLIST_TOOL_NAMES] });
    expect(preset.execution).toEqual({ enabled: false, mode: 'auto' });
  });

  it('keeps shell_exec and the persistent session tools out of the default allowlist', () => {
    // These are the opt-in, risk-bearing tools. They must NOT appear in the
    // safe-by-default allowlist — the default preset exposes only read/status
    // tools so a fresh install cannot execute commands until the user opts in.
    const preset = createShellMcpPresetInput();
    const allowlisted = new Set(preset.allowlist?.toolNames ?? []);
    const gatedTools = ['shell_exec', 'python_exec', 'local_file_write', 'local_file_read', 'local_file_stat', 'shell_session_begin', 'shell_session_exec', 'shell_session_end'];
    for (const tool of gatedTools) {
      expect(allowlisted.has(tool as string)).toBe(false);
    }
  });

  it('registers the persistent session tools in the shell tool catalog', () => {
    // Sanity: contracts and the native host must agree on tool names. This guards
    // against silent drift when the allowlist or tool list changes.
    expect(SHELL_TOOL_NAMES).toContain('shell_session_begin');
    expect(SHELL_TOOL_NAMES).toContain('shell_session_exec');
    expect(SHELL_TOOL_NAMES).toContain('shell_session_end');
  });

  it('discovers every shell tool the host exposes, not just the first few', () => {
    // ⚠️⚠️ **这条守的是「静默截断」** —— 发现阶段的 `listMcpTools` 按服务端返回顺序
    // `slice(0, maxToolCount)`，而这一步在 allowlist 过滤**之前**。上限小于工具总数时，
    // 排在后面的工具会被无声丢弃：模型看不到、MCP 页也列不出来（用户想手动勾都勾不到）。
    //
    // 曾经是 8，于是 local_file_write 与三个 shell_session_* 一直不可达，
    // 而提示词却在教模型用它们。**症状是「模型说没有这个工具」，没有任何报错。**
    const preset = createShellMcpPresetInput();
    expect(preset.limits?.maxToolCount).toBeGreaterThanOrEqual(SHELL_TOOL_NAMES.length);
  });

  it('upgrades persisted Shell tool limits that would truncate the tool list', () => {
    // ⚠️ 光改 preset 默认值**只对新装生效** —— 存量记录的 limits 由
    // `normalizeServerForMutation` 从存储原样读出，`ensureShellMcpCompatibility`
    // 此前只升 allowlist。所以升级函数必须能把已落库的小值抬上来。
    expect(buildShellToolLimitUpgrade({ maxResultBytes: 128_000, maxToolCount: 8 }))
      .toEqual({ maxResultBytes: 128_000, maxToolCount: SHELL_TOOL_NAMES.length });

    // 已经够大时不动（幂等，避免每次启动都写一次存储）。
    expect(buildShellToolLimitUpgrade({
      maxResultBytes: 128_000,
      maxToolCount: SHELL_TOOL_NAMES.length,
    })).toBeNull();
    expect(buildShellToolLimitUpgrade({ maxResultBytes: 64_000, maxToolCount: 128 })).toBeNull();
  });

  it('upgrades legacy read-only Shell allowlists with local file tools too', () => {
    expect(buildShellAllowlistUpgrade({
      mode: 'allow',
      toolNames: ['shell_status', 'python_status'],
    })).toEqual({
      mode: 'allow',
      toolNames: [
        'shell_status',
        'python_status',
        'local_folder_pick',
        'local_file_stat',
        'local_file_read',
        'local_file_write',
      ],
    });
  });

  it('preserves existing exec tools while upgrading Shell allowlists', () => {
    expect(buildShellAllowlistUpgrade({
      mode: 'allow',
      toolNames: ['shell_status', 'python_status', 'shell_exec'],
    })).toEqual({
      mode: 'allow',
      toolNames: [
        'shell_status',
        'python_status',
        'shell_exec',
        'local_folder_pick',
        'local_file_stat',
        'local_file_read',
        'local_file_write',
      ],
    });
  });

  it('detects the built-in Shell Local server by name or native host', () => {
    expect(isShellMcpServer({
      displayName: 'Shell Local',
      transport: { kind: 'native_messaging', nativeHost: 'other.host' },
    })).toBe(true);
    expect(isShellMcpServer({
      displayName: 'Anything',
      transport: { kind: 'native_messaging', nativeHost: 'com.glm_pp.shell' },
    })).toBe(true);
    expect(isShellMcpServer({
      displayName: 'Anything',
      transport: { kind: 'native_messaging', nativeHost: 'com.example.other' },
    })).toBe(false);
  });
});
