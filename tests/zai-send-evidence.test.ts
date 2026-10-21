import { describe, expect, it } from 'vitest';
import {
  classifyAugmentRequest,
  classifySendEvidence,
} from '../core/zai/send-evidence';
import { buildZaiContinuationPrompt, buildZaiNudgePrompt } from '../core/zai/continuation';

/**
 * 续跑链「这一发到底发出去了没有」的两条规则。
 *
 * ⚠️ **这两个函数是从 `zai.content.ts` 里抽出来的，理由就是「可测」** ——
 * 那个文件加载即执行 `defineContentScript`、不可 import，判定逻辑留在里面
 * 只能靠「按名字找源码」的断言盯着，而那种断言挡不住「把逻辑包进嵌套函数」
 * （位置对、执行时机不对）。
 *
 * ⚠️ **这里测的是规则本身**；「记账必须在串行队列之外同步调用」是接线，
 * 由 `zai-content-continuation-submit-contract.test.ts` 守着。两件事分开测。
 */

const SHELL_PROVIDER = {
  kind: 'mcp',
  id: 'shell',
  displayName: 'Shell MCP',
  transport: 'native_messaging',
} as const;

function execution() {
  return {
    name: 'shell_exec',
    provider: SHELL_PROVIDER,
    result: { ok: true, summary: '列出 3 个文件', detail: 'a.txt\nb.txt\nc.txt' },
  } as never;
}

/** 一份真实的续跑请求体（走复刻模板、由 `buildZaiContinuationPrompt` 现渲染）。 */
function continuationBody(): string {
  const prompt = buildZaiContinuationPrompt('看看桌面有什么', [execution()], ['shell_exec']);
  return JSON.stringify({ messages: [{ role: 'user', content: prompt }], model: 'glm-5.3' });
}

function nudgeBody(): string {
  const prompt = buildZaiNudgePrompt('看看桌面有什么', '上轮正文', [execution()], 1, ['shell_exec']);
  return JSON.stringify({ messages: [{ role: 'user', content: prompt }], model: 'glm-5.3' });
}

function plainBody(text = '帮我看看桌面有什么'): string {
  return JSON.stringify({ messages: [{ role: 'user', content: text }], model: 'glm-5.3' });
}

describe('classifyAugmentRequest: 一条桥消息怎么记账', () => {
  it('认得出续跑与 nudge 两种模板：两个计数器各 +1', () => {
    // ⚠️ 不手抄模板文案 —— 拿真渲染出来的文本喂进去，改模板时这条会跟着走。
    for (const body of [continuationBody(), nudgeBody()]) {
      expect(classifyAugmentRequest(body, 'completion')).toEqual({
        requestDelta: 1,
        continuationDelta: 1,
      });
    }
  });

  it('普通用户消息：只有请求计数 +1，续跑计数不动', () => {
    expect(classifyAugmentRequest(plainBody(), 'completion')).toEqual({
      requestDelta: 1,
      continuationDelta: 0,
    });
  });

  it('⚠️ body 不是字符串时也记一条请求 —— 语义是「桥消息到了」，与内容无关', () => {
    // ⚠️ 这一档是「桥通了、但这一发不是我们注入的模板」的极端形态。
    // 若这里返回 0，那一轮会被判成 ambiguous ⇒ 看门狗终止一个**其实正常发出去了**的请求。
    for (const body of [undefined, null, 42, {}]) {
      expect(classifyAugmentRequest(body, 'completion')).toEqual({
        requestDelta: 1,
        continuationDelta: 0,
      });
    }
  });

  it('空串与非模板文本：请求 +1、续跑 0', () => {
    for (const body of ['', 'not json at all', '{}']) {
      expect(classifyAugmentRequest(body, 'completion')).toEqual({
        requestDelta: 1,
        continuationDelta: 0,
      });
    }
  });

  it('⚠️ 模板文本但解析不出来时仍认作续跑（原文粗判那一级）', () => {
    // `isZaiContinuationRequestBody` 的第二级判据：`parseZaiBody` 失败 ⇒ 退回原文粗判。
    // 那一轮**仍然是正常发出的**，判据跟着认不出来会让调用方把同一段 prompt 再发一遍。
    const broken = `${continuationBody()}<<<`;
    expect(classifyAugmentRequest(broken, 'completion')).toEqual({
      requestDelta: 1,
      continuationDelta: 1,
    });
  });

  it('route 不影响记账（chatNew 与 completion 一致）', () => {
    const body = continuationBody();
    expect(classifyAugmentRequest(body, 'chatNew'))
      .toEqual(classifyAugmentRequest(body, 'completion'));
    expect(classifyAugmentRequest(plainBody(), 'chatNew'))
      .toEqual(classifyAugmentRequest(plainBody(), 'completion'));
  });
});

describe('classifySendEvidence: 两个计数器 → 三档', () => {
  it('两个都涨 ⇒ sent（正常续跑轮）', () => {
    expect(classifySendEvidence(1, 1)).toBe('sent');
  });

  it('⚠️ 只有请求计数涨 ⇒ 仍判 sent（桥通了但 body 不是模板，请求确实出去了）', () => {
    // 这一档是整个三态判据存在的理由：它把「桥挂了」与「桥通了但没认成模板」分开。
    // 少了它，后者会被看门狗终止 —— 而那一轮的回答其实正常回来了。
    expect(classifySendEvidence(1, 0)).toBe('sent');
  });

  it('⚠️ 只有续跑计数涨 ⇒ 也判 sent（比桥消息更强的证据）', () => {
    // 倒退不回去的组合，但判据必须向宽：认出了续跑模板就是发出去了。
    expect(classifySendEvidence(0, 1)).toBe('sent');
  });

  it('两个都没涨 ⇒ ambiguous（桥挂了或请求没发）', () => {
    expect(classifySendEvidence(0, 0)).toBe('ambiguous');
  });

  it('负增量（读到了更小的值）⇒ 按「没证据」处理，不判 sent', () => {
    expect(classifySendEvidence(-1, 0)).toBe('ambiguous');
    expect(classifySendEvidence(0, -1)).toBe('ambiguous');
    expect(classifySendEvidence(-1, -1)).toBe('ambiguous');
  });

  it('⚠️ 永不返回 unsent —— 那一档来自提交动作本身失败，不来自等待结果', () => {
    const results = new Set<string>();
    for (const requestDelta of [-2, -1, 0, 1, 2]) {
      for (const continuationDelta of [-2, -1, 0, 1, 2]) {
        results.add(classifySendEvidence(requestDelta, continuationDelta));
      }
    }
    expect(results.has('unsent'), '等待结果不产出 unsent').toBe(false);
    expect([...results].sort()).toEqual(['ambiguous', 'sent']);
  });
});