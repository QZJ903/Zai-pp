import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountToolResultCards } from '../core/ui/tool-result-cards';
import type { ToolCardResult, ToolExecutionRecord } from '../core/types';

/**
 * 卡片挂载是**尽力而为**的：锚点找不到就不挂，绝不抛错、也不留空壳。
 * 这个模块里唯一的站点假设是助手消息选择器（见模块头注释），所以这里
 * 用一段自建的 DOM 把它钉住，真机选择器若变了会在这里暴露。
 */
const ASSISTANT_SELECTOR = '.chat-assistant';

function execution(result: ToolCardResult): ToolExecutionRecord {
  return { name: 'skill_draft_create', result };
}

function skillDraftResult(name = 'audit'): ToolCardResult {
  return {
    ok: true,
    summary: 'Skill draft ready',
    output: {
      kind: 'skill_draft',
      draft: {
        name,
        description: 'Review contrast-sensitive output.',
        instructions: 'Check dark theme text.',
        memoryEnabled: true,
      },
    },
  };
}

function deps() {
  return {
    getLocale: () => 'en' as const,
    saveSkill: vi.fn(async () => ({ ok: true })),
    importMemories: vi.fn(async () => ({ ok: true, count: 0 })),
  };
}

function mountAssistantMessage(): HTMLElement {
  const message = document.createElement('div');
  message.className = 'chat-assistant';
  document.body.appendChild(message);
  return message;
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('tool result card mounting', () => {
  it('mounts a card into the last assistant message', () => {
    const message = mountAssistantMessage();

    mountToolResultCards([execution(skillDraftResult())], deps());

    expect(message.querySelector('.zpp-skill-draft-result')).not.toBeNull();
  });

  it('does nothing when there is no assistant message anchor', () => {
    expect(() => mountToolResultCards([execution(skillDraftResult())], deps())).not.toThrow();
    expect(document.body.childElementCount).toBe(0);
  });

  it('does nothing when no execution carries a renderable result', () => {
    const message = mountAssistantMessage();

    mountToolResultCards(
      [execution({ ok: true, summary: 'ok', output: { kind: 'something_else' } })],
      deps(),
    );

    expect(message.childElementCount).toBe(0);
    expect(message.querySelector('[data-zpp-result-cards]')).toBeNull();
  });

  it('mounts only once for the same message on repeated calls', () => {
    const message = mountAssistantMessage();
    const executions = [execution(skillDraftResult())];

    mountToolResultCards(executions, deps());
    mountToolResultCards(executions, deps());

    expect(message.querySelectorAll('.zpp-skill-draft-result')).toHaveLength(1);
    expect(message.querySelectorAll('[data-zpp-result-cards]')).toHaveLength(1);
  });

  it('adds a genuinely new result on a later call without duplicating the old one', () => {
    const message = mountAssistantMessage();

    mountToolResultCards([execution(skillDraftResult('first'))], deps());
    mountToolResultCards(
      [execution(skillDraftResult('first')), execution(skillDraftResult('second'))],
      deps(),
    );

    expect(message.querySelectorAll('.zpp-skill-draft-result')).toHaveLength(2);
  });

  it('caps the number of cards mounted into one message', () => {
    const message = mountAssistantMessage();
    const executions = Array.from({ length: 5 }, (_item, index) => (
      execution(skillDraftResult(`skill-${index}`))
    ));

    mountToolResultCards(executions, deps());

    expect(message.querySelectorAll('.zpp-skill-draft-result')).toHaveLength(3);
  });

  it('targets the last assistant message, not the first', () => {
    const first = mountAssistantMessage();
    const second = mountAssistantMessage();

    mountToolResultCards([execution(skillDraftResult())], deps());

    expect(first.querySelector('.zpp-skill-draft-result')).toBeNull();
    expect(second.querySelector('.zpp-skill-draft-result')).not.toBeNull();
  });

  it('keeps an empty host hidden instead of removing it, so the fingerprints survive', () => {
    const message = mountAssistantMessage();
    const unrenderable = execution({ ok: true, summary: 'x', output: { kind: 'skill_draft' } });

    mountToolResultCards([unrenderable], deps());

    // 容器留着（隐藏）—— 指纹挂在它上面；删掉就等于把「这批结果已经处理过」忘了。
    const host = message.querySelector<HTMLElement>('[data-zpp-result-cards]');
    expect(host).not.toBeNull();
    expect(host!.hidden).toBe(true);
    expect(host!.childElementCount).toBe(0);
  });

  it('does not retry a result that could not be rendered', () => {
    // 指纹确实生效：第二次调用不该再为同一个结果建节点。
    const message = mountAssistantMessage();
    const unrenderable = execution({ ok: true, summary: 'x', output: { kind: 'skill_draft' } });

    mountToolResultCards([unrenderable], deps());
    const hostAfterFirst = message.querySelector<HTMLElement>('[data-zpp-result-cards]')!;
    mountToolResultCards([unrenderable], deps());

    expect(message.querySelector('[data-zpp-result-cards]')).toBe(hostAfterFirst);
    expect(hostAfterFirst.getAttribute('data-zpp-mounted')).toContain('skill_draft_create');
  });

  it('redraws a card when the page itself dropped our host', () => {
    // ⚠️ 这是**指纹不能存在消息元素上**的理由：页面（Svelte）会就地重建消息的子节点，
    // 我们的容器会消失而消息元素还在。「容器不存在」是唯一能表达「卡片没了、得重画」
    // 的信号 —— 指纹若挂在消息元素上，这条路径会判定「已挂过」而永不重画。
    const message = mountAssistantMessage();
    const result = skillDraftResult();

    mountToolResultCards([execution(result)], deps());
    expect(message.querySelectorAll('.zpp-skill-draft-result')).toHaveLength(1);

    // 模拟页面重建子节点：把我们的容器摘掉，消息元素本身还在。
    message.querySelector('[data-zpp-result-cards]')!.remove();
    mountToolResultCards([execution(result)], deps());

    expect(message.querySelectorAll('.zpp-skill-draft-result')).toHaveLength(1);
  });

  it('still mounts a later, genuinely new result after an unrenderable one was remembered', () => {
    const message = mountAssistantMessage();

    mountToolResultCards(
      [execution({ ok: true, summary: 'x', output: { kind: 'skill_draft' } })],
      deps(),
    );
    mountToolResultCards([execution(skillDraftResult('later'))], deps());

    expect(message.querySelectorAll('.zpp-skill-draft-result')).toHaveLength(1);
  });

  it('keeps a mounted card out of a hidden host when a new result arrives later', () => {
    // 空容器是隐藏的；后续来了一个**能**渲染的结果，它要重新可见。
    const message = mountAssistantMessage();

    mountToolResultCards(
      [execution({ ok: true, summary: 'x', output: { kind: 'skill_draft' } })],
      deps(),
    );
    const host = message.querySelector<HTMLElement>('[data-zpp-result-cards]')!;
    expect(host.hidden).toBe(true);

    mountToolResultCards([execution(skillDraftResult('later'))], deps());

    expect(message.querySelector('[data-zpp-result-cards]')).toBe(host);
    expect(host.hidden).toBe(false);
  });

  it('keeps the assistant selector assumption in one place', () => {
    // 选择器变了这里会红 —— 这是有意的：它是本模块唯一的站点假设。
    const message = document.createElement('div');
    message.className = ASSISTANT_SELECTOR.slice(1);
    document.body.appendChild(message);

    mountToolResultCards([execution(skillDraftResult())], deps());

    expect(message.querySelector('.zpp-skill-draft-result')).not.toBeNull();
  });
});
