// Core pure function for the local-skill cwd initialization hint.
//
// When a local skill is active, its command-type tool calls (shell_exec /
// shell_session_begin) receive an initial working-directory suggestion of the
// skill's skillDir on the Native Host side, instead of falling back to homedir().
// This is the "initial cwd" layer of the Local Execution Boundary: an Agent call
// issued via <shell_exec> that omits or misstates cwd gets its initial cwd
// normalized to skillDir (persistent session calls via shell_session_exec reuse the session's
// existing cwd established by shell_session_begin and kept in the session registry, see
// core/shell/contracts.ts:80-84, so this function does NOT re-normalize them).
//
// Declarative consistency (initial cwd hint): this function provides *cwd normalization*
// for the initial command-type tool calls (shell_exec / shell_session_begin). When such a call
// omits or misstates cwd, it is normalized to the grant-derived skillDir, so the local Skill's
// "initial cwd is skillDir" hint holds for the first command of each invocation.
// shell_session_exec reuses the session's existing cwd and is intentionally out of scope here
// (contracts.ts:80-84). A call whose cwd is already skillDir is idempotent.
//
// Applies only to command-type tools that accept cwd. Tools that take rootPath /
// paths as input (local_file_read / local_file_write / local_file_stat /
// local_skill_preview) are out of scope (no cwd semantics, forcing is meaningless).
//
// ⚠️ The gate below keys on the **tool name** (`descriptor.name`, carried on the
// call as `call.name`), never on the invocation name (`call.invocationName`).
// The shell tools are published by the Shell Local MCP server, so their
// invocation name is `mcp_<sanitized server id>_<tool name>` — derived from a
// per-install server UUID (core/mcp/descriptor-identity.ts). A gate that matched
// on the invocation name therefore never fired for any real shell call: cwd
// silently fell back to homedir() and a caller-supplied cwd was never
// overwritten, while the prompt still promised the Skill directory. The tool
// name is the transport-independent identity (`shell_exec` stays `shell_exec`
// whether the tool arrives over MCP or from an in-process provider).

import type { ToolPayload } from './types';

const CWD_ENFORCED_TOOLS = new Set(['shell_exec', 'shell_session_begin']);

export function isCwdEnforcedTool(toolName: string): boolean {
  return CWD_ENFORCED_TOOLS.has(toolName);
}

/**
 * Normalize the initial cwd for command-type tool calls when a local skill is
 * active:
 * - cwd missing (undefined): set to the grant-derived skillDir (initial cwd hint).
 * - cwd === skillDir (Agent supplied the correct directory): returned as-is (idempotent).
 * - cwd present but !== skillDir (wrong / misstated): OVERWRITTEN with the
 *   grant-derived skillDir, so a wrong cwd can never execute a shell command
 *   outside the Skill directory. This honors the "error cwd normalized to Skill
 *   directory" promise, so a caller-supplied cwd can never silently
 *   override the grant's skillDir.
 *
 * `toolName` is the stable tool identity (call.name), not the invocation name —
 * see the file header for why that distinction is load-bearing.
 *
 * Note: cwd normalization applies only to the initial command-type calls (shell_exec / shell_session_begin) (initial cwd hint, not persistently bound to the session).
 * A call whose cwd is already skillDir is idempotent; shell_session_exec reuses the session's existing cwd and is intentionally out of scope here (contracts.ts:80-84).
 */
export function enforceLocalSkillCwd(
  payload: ToolPayload,
  toolName: string,
  skillDir: string | undefined,
): ToolPayload {
  if (!skillDir || !skillDir.trim()) return payload;
  if (!isCwdEnforcedTool(toolName)) return payload;
  if (payload.cwd === skillDir) return payload;
  return { ...payload, cwd: skillDir };
}
