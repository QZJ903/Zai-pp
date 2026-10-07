// 本地 Skill cwd「初始 cwd 提示」单测：
//   1) enforceLocalSkillCwd 纯函数：仅对 shell_exec / shell_session_begin 在「初始 cwd」层面归一化 cwd=skillDir。
//   2) parseExternalizedToolPayload 落点：当传入 skillDir 时，命令型工具的「初始 cwd」被归一化。
//   3) 声明自洽：本层仅设定初始 cwd，不持久绑定会话（持久会话 cwd 复用由 shell 会话注册表既有语义负责）。
//   4) shell_session_exec 不在归一化集合（其 cwd 由会话注册表保持，contracts.ts:80-84），不注入 cwd。
//
// ⚠️ 判据是**工具名**（`call.name` / `descriptor.name`），不是 invocation name ——
// 后者对 Shell Local 的每个工具都是 `mcp_<server uuid>_<tool>`。真实形状下的端到端守卫
// 见 `runtime-cwd-hydration.test.ts`；本文件只测纯函数的语义。

import { describe, expect, it } from 'vitest';
import { enforceLocalSkillCwd, isCwdEnforcedTool } from '../core/tool/local-skill-cwd';
import { parseExternalizedToolPayload } from '../core/tool/externalized-payload';
import { createMcpInvocationName } from '../core/mcp/descriptor-identity';

// 真实 Shell Local 工具的 invocation name 由生产同一个函数派生（不手抄）。
const SHELL_EXEC_INVOCATION_NAME = createMcpInvocationName(
  '41095031-b1ee-41b9-92bf-89fc9314b0ab',
  'shell_exec',
);

describe('enforceLocalSkillCwd', () => {
  it('shell_exec 未给 cwd → 强制为 skillDir', () => {
    const out = enforceLocalSkillCwd({ command: 'ls' }, 'shell_exec', '/skills/demo');
    expect(out.cwd).toBe('/skills/demo');
  });

  it('shell_exec 已给错误 cwd（≠ skillDir）→ 被 grant 的 skillDir 覆盖', () => {
    const payload = { command: 'ls', cwd: '/somewhere/else' };
    const out = enforceLocalSkillCwd(payload, 'shell_exec', '/skills/demo');
    expect(out).not.toBe(payload);
    expect(out.cwd).toBe('/skills/demo');
  });

  it('shell_exec cwd 已等于 skillDir → 原样返回（不复制）', () => {
    const payload = { command: 'ls', cwd: '/skills/demo' };
    const out = enforceLocalSkillCwd(payload, 'shell_exec', '/skills/demo');
    expect(out).toBe(payload);
  });

  it('skillDir 为空 → 不改 payload', () => {
    const payload = { command: 'ls' };
    expect(enforceLocalSkillCwd(payload, 'shell_exec', '')).toBe(payload);
    expect(enforceLocalSkillCwd(payload, 'shell_exec', undefined)).toBe(payload);
  });

  it('local_file_read（无 cwd 语义）→ 不强制', () => {
    const payload = { rootPath: '/skills/demo', selectedPaths: ['SKILL.md'] };
    const out = enforceLocalSkillCwd(payload, 'local_file_read', '/skills/demo');
    expect(out.cwd).toBeUndefined();
    expect(out.rootPath).toBe('/skills/demo');
  });

  it('isCwdEnforcedTool 仅覆盖初始命令型工具（shell_session_exec 不归一化）', () => {
    expect(isCwdEnforcedTool('shell_exec')).toBe(true);
    expect(isCwdEnforcedTool('shell_session_begin')).toBe(true);
    // shell_session_exec 复用会话既有 cwd（contracts.ts:80-84 明确不接收 cwd 字段），
    // 不再归入归一化集合，避免违反对外契约。
    expect(isCwdEnforcedTool('shell_session_exec')).toBe(false);
    expect(isCwdEnforcedTool('local_file_read')).toBe(false);
    expect(isCwdEnforcedTool('local_skill_preview')).toBe(false);
  });

  it('invocation name（MCP 长名）不是判据 —— 不会被误当成命令型工具', () => {
    // 反面对照：真实 shell 工具的 invocationName 形如 `mcp_<uuid>_shell_exec`，
    // 它**不在**集合里。这正是「判据必须取工具名」的原因（见文件头与
    // runtime-cwd-hydration.test.ts 的真实形状端到端用例）。
    expect(isCwdEnforcedTool(SHELL_EXEC_INVOCATION_NAME)).toBe(false);
  });
});

describe('parseExternalizedToolPayload cwd 强制落点', () => {
  it('shell_exec 解析时携带 skillDir → cwd 被强制', () => {
    const { payload, parseError } = parseExternalizedToolPayload(
      '{"command":"ls"}',
      'shell_exec',
      'shell_exec',
      '/skills/demo',
    );
    expect(parseError).toBeUndefined();
    expect(payload?.cwd).toBe('/skills/demo');
  });

  it('不传 skillDir → cwd 不被强制（保持 Agent 原意或缺失）', () => {
    const { payload } = parseExternalizedToolPayload('{"command":"ls"}', 'shell_exec', 'shell_exec');
    expect(payload?.cwd).toBeUndefined();
  });

  it('local_file_read 不强制 cwd', () => {
    const { payload } = parseExternalizedToolPayload(
      '{"rootPath":"/skills/demo"}',
      'local_file_read',
      'local_file_read',
      '/skills/demo',
    );
    expect(payload?.cwd).toBeUndefined();
  });

  it('shell_exec 解析时携带错误 cwd（≠ skillDir）→ 被覆盖为 skillDir（parser→runtime 路径）', () => {
    const { payload, parseError } = parseExternalizedToolPayload(
      '{"command":"ls","cwd":"/somewhere/else"}',
      'shell_exec',
      'shell_exec',
      '/skills/demo',
    );
    expect(parseError).toBeUndefined();
    expect(payload?.cwd).toBe('/skills/demo');
  });

  it('MCP 长 invocation name + 短工具名 → 仍按工具名强制 cwd', () => {
    const { payload, parseError } = parseExternalizedToolPayload(
      '{"command":"pwd","cwd":"/somewhere/else"}',
      SHELL_EXEC_INVOCATION_NAME,
      'shell_exec',
      '/skills/demo',
    );
    expect(parseError).toBeUndefined();
    expect(payload?.cwd).toBe('/skills/demo');
  });
});

describe('声明自洽：仅初始 cwd 提示，不持久绑定会话', () => {
  it('enforceLocalSkillCwd 对「错误 cwd（≠ skillDir）」归一化为 grant 的 skillDir', () => {
    const original = { command: 'ls', cwd: '/somewhere/else' };
    const out = enforceLocalSkillCwd(original, 'shell_exec', '/skills/demo');
    expect(out).not.toBe(original);
    expect(out.cwd).toBe('/skills/demo');
    expect(original.cwd).toBe('/somewhere/else');
  });

  it('enforceLocalSkillCwd 对「缺失 cwd」注入 skillDir，且不修改原对象', () => {
    const original: { command: string; cwd?: string } = { command: 'ls' };
    const out = enforceLocalSkillCwd(original, 'shell_exec', '/skills/demo');
    expect(out.cwd).toBe('/skills/demo');
    expect(original.cwd).toBeUndefined();
  });

  it('shell_session_exec（会话续发命令）不归一化 cwd（contracts.ts:80-84）', () => {
    const payload = { command: 'ls', sessionId: 's1', cwd: '/somewhere/else' };
    // shell_session_exec 不在 CWD_ENFORCED_TOOLS，其 cwd 由会话注册表保持，
    // 调用方传入的 cwd 原样保留（不强制为 skillDir），避免违反对外契约。
    expect(isCwdEnforcedTool('shell_session_exec')).toBe(false);
    const out = enforceLocalSkillCwd(payload, 'shell_session_exec', '/skills/demo');
    expect(out).toBe(payload);
    expect(out.cwd).toBe('/somewhere/else');
  });
});

describe('模块 E：对立面回归（C1-C3，shell_session_exec 不注入 cwd）', () => {
  it('C1：isCwdEnforcedTool 不含 shell_session_exec', () => {
    expect(isCwdEnforcedTool('shell_session_exec')).toBe(false);
  });

  it('C2：初始命令型调用 shell_exec / shell_session_begin 仍归一化 cwd', () => {
    expect(isCwdEnforcedTool('shell_exec')).toBe(true);
    expect(isCwdEnforcedTool('shell_session_begin')).toBe(true);
  });

  it('C3：shell_session_exec 的 cwd 原样保留（不强制为 skillDir，contracts.ts:80-84）', () => {
    const payload = { command: 'ls', sessionId: 's1', cwd: '/somewhere/else' };
    const out = enforceLocalSkillCwd(payload, 'shell_session_exec', '/skills/demo');
    expect(out).toBe(payload);
    expect(out.cwd).toBe('/somewhere/else');
  });

  it('C3 补：错误 cwd 仍被 shell_exec 归一化（防回归）', () => {
    const payload = { command: 'ls', cwd: '/somewhere/else' };
    const out = enforceLocalSkillCwd(payload, 'shell_exec', '/skills/demo');
    expect(out.cwd).toBe('/skills/demo');
  });
});
