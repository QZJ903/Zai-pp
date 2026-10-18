import { describe, expect, it } from 'vitest';
import {
  ZAI_CONTINUATION_PLACEHOLDER,
  containsZaiContinuationPlaceholder,
  isZaiContinuationPlaceholder,
  isZaiContinuationPrompt,
} from '../core/zai/continuation-marker';
import {
  ZAI_INLINE_AGENT_MAX_STEPS,
  buildZaiContinuationPrompt,
  buildZaiNudgePrompt,
} from '../core/zai/continuation';
import {
  hideContinuationBubbles,
  installContinuationBubbleHider,
} from '../core/zai/continuation-bubble';

/**
 * **续跑 / nudge 模板的可见性**（当场那份：页面气泡）。
 *
 * ⚠️⚠️ **判据必须与生产端同源** —— 这些用例**不手抄模板文案**，而是拿
 * `buildZaiContinuationPrompt` / `buildZaiNudgePrompt` **真渲染出来**的文本去测。
 * 手抄的 fixture 会在改模板时静默分叉：模板改了、判据没跟上，于是气泡照旧可见
 * （失败方向静默）。这与 `tests/prompt-visibility.test.ts` 里那条「用真渲染出来的
 * 提醒过一遍 sanitizer」是同一个做法。
 */

const SHELL_PROVIDER = {
  kind: 'mcp',
  id: 'shell',
  displayName: 'Shell MCP',
  transport: 'native_messaging',
} as const;

function execution(overrides: Record<string, unknown> = {}) {
  return {
    name: 'shell_exec',
    provider: SHELL_PROVIDER,
    result: { ok: true, summary: '列出 3 个文件', detail: 'a.txt\nb.txt\nc.txt' },
    ...overrides,
  } as never;
}

describe('zai continuation marker', () => {
  it('recognises the real continuation prompt', () => {
    const prompt = buildZaiContinuationPrompt('看看桌面有什么', [execution()], ['shell_exec']);
    expect(isZaiContinuationPrompt(prompt)).toBe(true);
  });

  it('recognises the real nudge prompt', () => {
    // ⚠️ 只认 `<tool_results>` 会漏掉 nudge 轮 —— 它用的是 `<tool_results_so_far>`。
    const prompt = buildZaiNudgePrompt('看看桌面有什么', '上轮正文', [execution()], 1, ['shell_exec']);
    expect(isZaiContinuationPrompt(prompt)).toBe(true);
  });

  it('recognises both agent-mode variants too', () => {
    // 沙箱措辞按模式分叉，但结构标签不变 —— 两种模式都要认。
    const continuation = buildZaiContinuationPrompt(
      '任务', [execution()], ['shell_exec'], { isAgent: true },
    );
    const nudge = buildZaiNudgePrompt(
      '任务', '正文', [execution()], 1, ['shell_exec'], { isAgent: true },
    );
    expect(isZaiContinuationPrompt(continuation)).toBe(true);
    expect(isZaiContinuationPrompt(nudge)).toBe(true);
  });

  it.each([
    ['an ordinary user message', '帮我读一下这个文件'],
    ['only the original_task tag', '<original_task>only one</original_task>'],
    ['only the tool_results tag', '<tool_results>[]</tool_results>'],
    ['an empty string', ''],
    ['a mention in prose', 'explain the tag <tool_results> in isolation'],
  ])('rejects %s', (_name, text) => {
    expect(isZaiContinuationPrompt(text)).toBe(false);
  });

  it('treats the placeholder as a non-prompt (idempotence)', () => {
    expect(isZaiContinuationPrompt(ZAI_CONTINUATION_PLACEHOLDER)).toBe(false);
    expect(isZaiContinuationPlaceholder(ZAI_CONTINUATION_PLACEHOLDER)).toBe(true);
    expect(isZaiContinuationPlaceholder('普通消息')).toBe(false);
  });

  it('keeps the placeholder non-empty (the message chain depends on it)', () => {
    // ⚠️ **空内容会让服务端那条 parent/child 链断掉** —— 表现是刷新后那条消息整个消失。
    expect(ZAI_CONTINUATION_PLACEHOLDER.length).toBeGreaterThan(0);
    expect(ZAI_CONTINUATION_PLACEHOLDER.trim()).toBe(ZAI_CONTINUATION_PLACEHOLDER);
    // 不可见：三个都是 Unicode 格式字符（Cf），不占视觉宽度。
    expect([...ZAI_CONTINUATION_PLACEHOLDER].every((ch) => /\p{Cf}/u.test(ch))).toBe(true);
  });
});

describe('zai continuation bubble hider', () => {
  /** 造一个假的候选集合（只实现用到的两个方法）。 */
  function fakeRoot(nodes: Array<{ text: string; attrs?: Record<string, string> }>) {
    const elements = nodes.map((node) => {
      const attrs = new Map(Object.entries(node.attrs ?? {}));
      return {
        textContent: node.text,
        style: { props: new Map<string, string>(), setProperty(k: string, v: string, p?: string) { this.props.set(k, `${v}|${p ?? ''}`); } },
        getAttribute: (name: string) => attrs.get(name) ?? null,
        setAttribute: (name: string, value: string) => { attrs.set(name, value); },
        attrs,
      };
    });
    return {
      elements,
      root: {
        querySelectorAll: () => elements,
      } as unknown as ParentNode,
    };
  }

  it('hides the bubble carrying a real continuation prompt', () => {
    const prompt = buildZaiContinuationPrompt('任务', [execution()], ['shell_exec']);
    const { root, elements } = fakeRoot([{ text: '普通用户消息' }, { text: prompt }]);
    expect(hideContinuationBubbles({ root })).toBe(1);
    expect(elements[1]!.attrs.get('data-dpp-hidden-continuation')).toBe('true');
    expect(elements[1]!.style.props.get('display')).toBe('none|important');
    // 普通消息不受影响。
    expect(elements[0]!.attrs.get('data-dpp-hidden-continuation')).toBeUndefined();
  });

  it('hides the nudge bubble too', () => {
    const prompt = buildZaiNudgePrompt('任务', '正文', [execution()], 1, ['shell_exec']);
    const { root, elements } = fakeRoot([{ text: prompt }]);
    expect(hideContinuationBubbles({ root })).toBe(1);
    expect(elements[0]!.attrs.get('data-dpp-hidden-continuation')).toBe('true');
  });

  it('hides a very long template bubble (no length guard)', () => {
    // ⚠️⚠️ **这条把「不许按长度跳过候选」钉死。**
    // 曾经有一条 `text.length > 20_000 → continue` 的守卫，理由是「省掉 textContent 的开销」——
    // 那条守卫**在结构上就不可能达到目的**（要判长度必须先读 textContent），
    // 而且**失败方向是反的**：续跑模板的正文就是工具结果 JSON，
    // 4 条完整结果的 `detail` ≤4,000 + `output` ≤8,000 叠满时**理论上界约 66 KB**
    // ⇒ **载荷越大越该被隐藏、越可能落进守卫之外**。
    //
    // ⚠️ **必须凑满窗口（4 条）才够长**：单条完整结果的 detail+output 上限是 12 KB
    // ⇒ 一条只有约 12.5 KB，**够不到旧阈值**（第一版就是这么假绿的）。
    const bigResult = {
      ok: true,
      summary: '大结果',
      detail: 'D'.repeat(4_000),
      output: 'O'.repeat(8_000),
    };
    const huge = buildZaiContinuationPrompt(
      '任务',
      [
        execution({ result: bigResult }),
        execution({ result: bigResult }),
        execution({ result: bigResult }),
        execution({ result: bigResult }),
      ],
      ['shell_exec'],
    );
    // 前提：这条真的超过了旧守卫的阈值（否则这条用例证明不了任何事）。
    expect(huge.length).toBeGreaterThan(20_000);
    const { root, elements } = fakeRoot([{ text: huge }]);
    expect(hideContinuationBubbles({ root })).toBe(1);
    expect(elements[0]!.attrs.get('data-dpp-hidden-continuation')).toBe('true');
  });

  it('hides the placeholder bubble left behind by a history refetch', () => {
    // ⚠️⚠️ **这是另一个时刻的同一件事**：页面从 `messages/batch` 重渲染会话时
    // （切走再切回来就会发生，不必刷新），那条消息的正文已经被历史清洗换成了占位符。
    // 只认模板标签的判据在这时会漏判 —— 页面上留下一只空白气泡，
    // 实测它与正常消息一样占 80px 高，且没有任何东西会报错。
    //
    // ⚠️ 文本形状按**真机读数**写：占位符 3 字符 + 页面自己的 14 个空白字符。
    const refetched = `${ZAI_CONTINUATION_PLACEHOLDER}${' '.repeat(14)}`;
    const { root, elements } = fakeRoot([{ text: '普通用户消息' }, { text: refetched }]);
    expect(hideContinuationBubbles({ root })).toBe(1);
    expect(elements[1]!.attrs.get('data-dpp-hidden-continuation')).toBe('true');
    expect(elements[0]!.attrs.get('data-dpp-hidden-continuation')).toBeUndefined();
  });

  it('still hides the placeholder bubble when the page chrome is not plain whitespace', () => {
    // ⚠️⚠️ **这条钉的是「不许用严格判据」** —— 真机上那 14 个 chrome 字符**恰好全是空白**，
    // 所以 `isZaiContinuationPlaceholder`（`trim()` 后整段相等）眼下也能命中。
    // 但只要页面把 chrome 换成任何可见文字，严格判据就**静默漏判**。
    // ⇒ 判据必须收窄到「含这三个字符」，不能收窄到「整段等于它」。
    const withVisibleChrome = `编辑${ZAI_CONTINUATION_PLACEHOLDER}复制`;
    // 前提：严格判据认不出它（认得出的话这条用例证明不了任何事）。
    expect(isZaiContinuationPlaceholder(withVisibleChrome)).toBe(false);
    expect(containsZaiContinuationPlaceholder(withVisibleChrome)).toBe(true);

    const { root, elements } = fakeRoot([{ text: withVisibleChrome }]);
    expect(hideContinuationBubbles({ root })).toBe(1);
    expect(elements[0]!.attrs.get('data-dpp-hidden-continuation')).toBe('true');
  });

  it('does not hide an ordinary short message', () => {
    // 反面：判据放宽到「含占位符」之后，普通消息一条都不许被误藏。
    const { root, elements } = fakeRoot([
      { text: '好的，我知道了' },
      { text: '   ' },
      { text: '在沙箱写一个简单html文件，再放到桌面上' },
    ]);
    expect(hideContinuationBubbles({ root })).toBe(0);
    expect(elements.every((el) => el.attrs.get('data-dpp-hidden-continuation') === undefined)).toBe(true);
  });

  it('is idempotent (a second scan hides nothing)', () => {
    const prompt = buildZaiContinuationPrompt('任务', [execution()], ['shell_exec']);
    const { root } = fakeRoot([{ text: prompt }]);
    expect(hideContinuationBubbles({ root })).toBe(1);
    expect(hideContinuationBubbles({ root })).toBe(0);
  });

  it('skips already-hidden entries without reading their text again', () => {
    // ⚠️ 性能相关：每次扫描都要对候选跑 `textContent`（O(消息长度)），
    // 而扫描是每帧合流触发的。已隐藏的条目必须在读文本**之前**跳过。
    const prompt = buildZaiContinuationPrompt('任务', [execution()], ['shell_exec']);
    const { root, elements } = fakeRoot([{ text: prompt, attrs: { 'data-dpp-hidden-continuation': 'true' } }]);
    // 把 textContent 换成 getter：被读就抛 —— 用来证明它真的没被读。
    let read = false;
    Object.defineProperty(elements[0]!, 'textContent', {
      get() { read = true; return prompt; },
    });
    expect(hideContinuationBubbles({ root })).toBe(0);
    expect(read).toBe(false);
  });

  it('only looks at the last N candidates', () => {
    const prompt = buildZaiContinuationPrompt('任务', [execution()], ['shell_exec']);
    const nodes = Array.from({ length: 80 }, (_, i) => ({ text: i === 0 ? prompt : '普通消息' }));
    const { root } = fakeRoot(nodes);
    // 模板在第 0 条（最旧），而扫描只看最后 64 条 ⇒ 不该命中。
    expect(hideContinuationBubbles({ root, maxCandidates: 64 })).toBe(0);
    // 放宽到全部 ⇒ 命中。
    expect(hideContinuationBubbles({ root, maxCandidates: 80 })).toBe(1);
  });

  it('covers a full run plus headroom within the default window', () => {
    // ⚠️ 默认窗口的**取值依据**：一次跑满的自动化任务最多产生 `ZAI_INLINE_AGENT_MAX_STEPS + 1`
    // 条用户消息（1 条原始 + 每步一条续跑 prompt），而默认窗口是 64 ⇒ 即使全部落在
    // 窗口内也够。这条把「默认值 ≥ 步数 + 1」钉住，免得将来有人把它调小到步数之下。
    //
    // ⚠️⚠️ **条数必须从 `ZAI_INLINE_AGENT_MAX_STEPS` 派生，不能写死** ——
    // 实测：把步数从 25 调到 **64**（此时 `stepCount = 65 > 默认窗口 64`，窗口真的不够了）
    // 派生版**立刻红**，而写死 26 的版本**永远不会红** —— 用例标题自称守的正是这件事。
    // ⚠️ 调到 **40 时两版都是绿的**，而那是**正确**的（`41 ≤ 64`，窗口确实够）——
    // 别把这个「不红」当成判据失灵。
    const stepCount = ZAI_INLINE_AGENT_MAX_STEPS + 1;
    const prompt = buildZaiContinuationPrompt('任务', [execution()], ['shell_exec']);
    const nodes = Array.from({ length: stepCount }, () => ({ text: prompt }));
    const { root } = fakeRoot(nodes);
    expect(hideContinuationBubbles({ root })).toBe(stepCount);
  });

  it('returns 0 instead of throwing when the selector is invalid', () => {
    const root = { querySelectorAll: () => { throw new Error('bad selector'); } } as unknown as ParentNode;
    expect(hideContinuationBubbles({ root })).toBe(0);
  });

  it('returns 0 when the document has no matching nodes', () => {
    const { root } = fakeRoot([]);
    expect(hideContinuationBubbles({ root })).toBe(0);
  });

  it('installs an observer that scans once immediately', () => {
    // ⚠️ 这条用**真 DOM**（jsdom）—— `MutationObserver.observe` 要求参数是真 `Node`，
    // 假对象会抛（而那是被 catch 掉的，测试会「绿着什么都没验」）。
    const prompt = buildZaiContinuationPrompt('任务', [execution()], ['shell_exec']);
    const container = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.className = 'user-message';
    bubble.textContent = prompt;
    container.appendChild(bubble);
    document.body.appendChild(container);

    const frames: Array<() => void> = [];
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: () => void) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;
    const hiddenCounts: number[] = [];
    let uninstall: (() => void) | null = null;
    try {
      uninstall = installContinuationBubbleHider({ onHidden: (count) => hiddenCounts.push(count) });
      // 立刻那一次是排进 rAF 的，不是同步执行。
      expect(bubble.getAttribute('data-dpp-hidden-continuation')).toBeNull();
      for (const frame of frames.splice(0)) frame();
      expect(bubble.getAttribute('data-dpp-hidden-continuation')).toBe('true');
      expect(bubble.style.getPropertyValue('display')).toBe('none');
      expect(hiddenCounts).toEqual([1]);
    } finally {
      uninstall?.();
      globalThis.requestAnimationFrame = originalRaf;
      container.remove();
    }
  });

  it('re-scans when the DOM changes (the bubble appears after the submit)', () => {
    // ⚠️ 续跑气泡是在**页面渲染完成后**才出现的 —— 提交那一刻还没有它，
    // 所以必须靠观察器补扫（只扫一次会漏掉绝大多数情形）。
    const prompt = buildZaiContinuationPrompt('任务', [execution()], ['shell_exec']);
    const frames: Array<() => void> = [];
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: () => void) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;

    let container: HTMLDivElement | null = null;
    let uninstall: (() => void) | null = null;
    try {
      uninstall = installContinuationBubbleHider({});
      for (const frame of frames.splice(0)) frame();
      // 首扫时页面还没有气泡。
      expect(frames).toHaveLength(0);

      container = document.createElement('div');
      const bubble = document.createElement('div');
      bubble.className = 'user-message';
      bubble.textContent = prompt;
      container.appendChild(bubble);
      document.body.appendChild(container);
      // ⚠️ MutationObserver 的回调是**微任务**，要等一拍。
      return Promise.resolve().then(() => {
        for (const frame of frames.splice(0)) frame();
        expect(bubble.getAttribute('data-dpp-hidden-continuation')).toBe('true');
      }).finally(() => {
        uninstall?.();
        globalThis.requestAnimationFrame = originalRaf;
        container?.remove();
      });
    } catch (error) {
      uninstall?.();
      globalThis.requestAnimationFrame = originalRaf;
      container?.remove();
      throw error;
    }
  });
});
