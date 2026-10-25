import { describe, expect, it } from 'vitest';
import {
  buildZaiMisuseNudgePrompt,
  isZaiContinuationPrompt,
} from '../core/zai/continuation';
import type { ToolDescriptor, ToolExecutionRecord } from '../core/types';

/**
 * 误用纠错轮的 prompt 与判据。
 *
 * ⚠️ 这一组守两件事：
 * ① **纠错文本本身**（带真实 schema 示例、不排他、不要求道歉）；
 * ② **它必须被 `isZaiContinuationPrompt` 认作续跑轮** —— 不认的话下一轮会被当成
 *    原生轮、新建一个 taskId 为 null 的循环覆盖掉它，后台任务永远收不到终态。
 */

const SKILL_DRAFT: ToolDescriptor = {
  id: 'local:skill-creator:skill_draft_create',
  provider: {
    kind: 'local',
    id: 'skill-creator',
    displayName: 'Skill Creator',
    transport: 'in_process',
  },
  name: 'skill_draft_create',
  invocationName: 'skill_draft_create',
  title: 'Draft a Skill',
  description: 'Create a custom Skill draft.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      instructions: { type: 'string' },
      memoryEnabled: { type: 'boolean' },
    },
    required: ['name', 'description', 'instructions'],
  },
  execution: { mode: 'auto', enabled: true, risk: 'low' },
};

const EXECUTION: ToolExecutionRecord = {
  name: 'shell_exec',
  result: { ok: true, summary: 'done' },
};

describe('misuse correction prompt', () => {
  it('names the tool and states that nothing executed', () => {
    const prompt = buildZaiMisuseNudgePrompt('草拟打招呼 skill', 'skill_draft_create', SKILL_DRAFT, []);
    expect(prompt).toContain('skill_draft_create');
    expect(prompt).toContain('没有执行任何东西');
    // ⚠️ 服务端确实会回这个错误（真机样本），说它是为了让模型明白「不是格式偏好问题」。
    expect(prompt).toContain('服务端不认识这个工具');
  });

  it('renders the example from the tool real input schema', () => {
    const prompt = buildZaiMisuseNudgePrompt('任务', 'skill_draft_create', SKILL_DRAFT, []);
    const start = prompt.indexOf('<skill_draft_create>\n');
    const end = prompt.indexOf('\n</skill_draft_create>');
    expect(start).toBeGreaterThanOrEqual(0);
    const payload = JSON.parse(prompt.slice(start + '<skill_draft_create>\n'.length, end)) as Record<string, unknown>;
    // 只列必填字段，值与 schema 的类型一致。
    expect(Object.keys(payload).sort()).toEqual(['description', 'instructions', 'name']);
    expect(payload.name).toBe('value');
  });

  it('falls back to a generic placeholder when the descriptor is unknown', () => {
    const prompt = buildZaiMisuseNudgePrompt('任务', 'unknown_tool', undefined, []);
    expect(prompt).toContain('<unknown_tool>');
    expect(prompt).toContain('{"参数名": "参数值"}');
  });

  it('does not ask the model to apologise or re-plan', () => {
    const prompt = buildZaiMisuseNudgePrompt('任务', 'shell_exec', undefined, []);
    expect(prompt).toContain('不要解释、不要道歉');
  });

  it('is recognised as a continuation turn even when there are no tool results', () => {
    // ⚠️⚠️ **首轮误用时 `executions` 是空的** —— 若这时省掉 `<tool_results_so_far>`，
    // `isZaiContinuationPrompt` 会判 false ⇒ 下一轮走原生轮分支 ⇒ 新建一个 taskId 为 null
    // 的循环覆盖它，后台任务永远收不到终态。
    const prompt = buildZaiMisuseNudgePrompt('任务', 'skill_draft_create', SKILL_DRAFT, []);
    expect(isZaiContinuationPrompt(prompt)).toBe(true);
    expect(prompt).toContain('<tool_results_so_far>');
  });

  it('carries prior tool results when there are any', () => {
    const prompt = buildZaiMisuseNudgePrompt('任务', 'shell_exec', undefined, [EXECUTION]);
    expect(isZaiContinuationPrompt(prompt)).toBe(true);
    expect(prompt).toContain('"tool": "shell_exec"');
  });

  it('never leaks the previous assistant text section', () => {
    // 误用轮的 assistantText 恒为空（两个非答案相位都被挖掉），带上只是噪音。
    const prompt = buildZaiMisuseNudgePrompt('任务', 'shell_exec', undefined, []);
    expect(prompt).not.toContain('<previous_assistant_text>');
  });
});