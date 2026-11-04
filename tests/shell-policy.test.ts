import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildShellToolLimitUpgrade,
  createShellMcpPresetInput,
  isShellMcpServer,
} from '../core/shell/policy';
import { SHELL_MCP_NATIVE_HOST, SHELL_TOOL_NAMES } from '../core/shell/contracts';
import type { McpServerConfig } from '../core/mcp/types';

/** 一条完整的 MCP 服务记录，用来喂 `isShellMcpServer`（它的入参已收窄成 `Pick<…,'transport'>`）。 */
function shellServerForTest(): McpServerConfig {
  return {
    version: 1,
    id: 'server-under-test',
    displayName: 'Shell Local',
    enabled: true,
    transport: { kind: 'native_messaging', nativeHost: SHELL_MCP_NATIVE_HOST },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 5_000, requestMs: 120_000, discoveryMs: 10_000 },
    limits: { maxResultBytes: 128_000, maxToolCount: 12 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'ready',
    lastConnectedAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('createShellMcpPresetInput', () => {
  it('defaults Shell MCP to auto execution while the server itself stays disabled', () => {
    const preset = createShellMcpPresetInput();

    // 服务本身仍默认停用（要用户先装 host 再启用）。
    expect(preset.enabled).toBe(false);
    // ⚠️⚠️ **预设不写 allowlist** —— 缺省由 `createMcpServer` 补成 `mode: 'all'`，
    // 与其它 MCP 服务同一口径：工具级开关完全归用户。
    expect(preset.allowlist).toBeUndefined();
    // ⚠️ **「自动执行」默认开启。** 关着的时候 `isMcpToolEnabled` 恒假 ⇒ 工具列表
    // 整列显示 0/N，而面板上没有任何一处解释「是这一项在挡」。Shell 是本项目的一等能力，
    // 默认值就该是「能用」。
    expect(preset.execution).toEqual({ enabled: true, mode: 'auto' });
  });

  it('leaves every tool switch to the user instead of seeding an allowlist', () => {
    // ⚠️⚠️ **这条守的是一个真实缺陷**：预设曾经硬编码 `mode: 'allow'` + 三个只读工具，
    // 配一个「启动时把缺的本地文件工具补回名单」的升级函数 ⇒ **用户关掉的工具
    // 每次浏览器启动都被重新打开**（`mode: 'allow'` 下关工具 = 从名单删掉，
    // 而升级判据正是「缺了就补」）。
    // ⇒ 预设不许再带名单；工具开关只由用户在 MCP 页写。
    const preset = createShellMcpPresetInput();
    expect(preset.allowlist, '预设不许替用户预选任何工具').toBeUndefined();
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

  it('identifies the built-in Shell Local server by native host only', () => {
    expect(isShellMcpServer(shellServerForTest())).toBe(true);
    const otherHost: McpServerConfig = {
      ...shellServerForTest(),
      transport: { kind: 'native_messaging', nativeHost: 'com.example.other' },
    };
    expect(isShellMcpServer(otherHost)).toBe(false);
  });

  it('does not trust a user-typed display name', () => {
    // ⚠️⚠️ 守的是一个真缺陷：判据里曾经还有 `displayName === 'Shell Local'` 这一半。
    // 显示名是 MCP 页可编辑的普通字段（没有保留名检查），而这条判据决定工具调用走哪条
    // 传输路径、本地 Skill 导入跟哪个服务说话、启动预设维护动哪条记录。
    // 一个第三方服务只要把自己**命名**成 `Shell Local`，它的 `local_file_read` 就会被
    // 路由进 Shell 的窗口续读路径 —— 形状对不上，每次调用都以「无法从工具结果解析窗口内容」
    // fail-closed，而用户没有任何线索知道原因。
    //
    // ⚠️ 参数类型已经收窄成 `Pick<McpServerConfig, 'transport'>`，所以这里只能先落到
    // 一个**完整记录**变量上再传 —— 那正好模拟生产：调用方手里是整条 `McpServerConfig`。
    const impersonator: McpServerConfig = {
      ...shellServerForTest(),
      displayName: 'Shell Local',
      transport: { kind: 'streamable_http', url: 'https://third-party.example/mcp' },
    };
    expect(isShellMcpServer(impersonator)).toBe(false);

    const sameNameOtherHost: McpServerConfig = {
      ...shellServerForTest(),
      displayName: 'Shell Local',
      transport: { kind: 'native_messaging', nativeHost: 'other.host' },
    };
    expect(isShellMcpServer(sameNameOtherHost)).toBe(false);
  });
});

describe('user tool switches are never rewritten by the startup path', () => {
  /**
   * ⚠️⚠️ **缺陷形态**：`ensureShellMcpCompatibility` 曾在每次浏览器启动时调
   * `buildShellAllowlistUpgrade`，把「名单里缺的本地文件工具」补回去。
   * 而 `mode: 'allow'` 下关工具 = 从名单删掉 ⇒ **用户关掉的工具每次启动都被重新打开**，
   * 且没有任何提示。用户报的就是这一条（四个本地文件 / 文件夹工具）。
   *
   * ⇒ 判据：启动链只许升 `limits`，**不许写 `allowlist`**。
   * ⚠️ 这条是源码级断言（启动链不可 import），但判据收窄到**那一个函数体内**，
   * 不是「文件里出现过这个名字」。
   * ⚠️⚠️ **必须先剥注释再断言** —— 函数体里的说明文字本身就写着 `allowlist`，
   * 不剥的话这条判据被自己的注释喂饱、永远绿（实测踩过）。
   */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it('ensureShellMcpCompatibility never writes an allowlist', () => {
    const background = readFileSync('entrypoints/background.ts', 'utf8');
    const start = background.indexOf('async function ensureShellMcpCompatibility');
    expect(start, '应当能找到 ensureShellMcpCompatibility').toBeGreaterThan(-1);
    // 函数体到下一个顶层 `}` 前的那段（缩进 0 的 `}` 结束）。
    const end = background.indexOf('\n}', start);
    expect(end, '应当能找到函数体结束').toBeGreaterThan(start);
    const body = stripComments(background.slice(start, end));

    // ⚠️⚠️ **判据要不区分大小写** —— 只认小写的 `allowlist` 时，
    // `const upgradedAllowlist = …` 这种写法能整个溜过去（实测：变异后仍绿）。
    expect(body, '启动链不许写 allowlist —— 那是用户的选择').not.toMatch(/allowlist/i);
    expect(body, '启动链应当仍然升级 maxToolCount').toContain('buildShellToolLimitUpgrade');
  });
});
