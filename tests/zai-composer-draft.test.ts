import { describe, expect, it } from 'vitest';
import { captureComposerDraft } from '../core/zai/composer-draft';

/**
 * **草稿保护的行为判据** —— 三个档位各走一遍真调用。
 *
 * ## 为什么需要这一组（而不是只靠 AST 守卫）
 *
 * 草稿保护原先内联在 `entrypoints/zai.content.ts`（加载即执行 `defineContentScript`、
 * 不可 import），所以只能靠「按结构数调用点」的 AST 断言盯着。那种断言有两个洞
 * （2026-11-01 外部评审 P1-2 指出）：
 *
 * ① **锁形状不锁语义** —— 把 `restore()` 的守卫条件改错（例如去掉「当前值是空的才算
 *    我们那份」），AST 断言照绿；
 * ② **要求「恰好一次调用」** —— 把 `clear(); restore();` 抽成一个助手就假红。
 *
 * 抽到 `core/zai/composer-draft.ts` 之后，语义可以用真输入喂满。两层的分工：
 * **AST 守卫防漏接（每个 unsent 出口都调了没）、本文件防语义错（调了但判据写反了）**。
 *
 * ## 三档判据（本组的全部内容）
 *
 * | 当前输入框里的值 | 期望 | 为什么 |
 * |---|---|---|
 * | 空 | **写回草稿** | 页面已经清过，框是空的 |
 * | 等于我们注入的 prompt | **写回草稿** | 页面把我们的 prompt 留在框里（或反向同步回来了）|
 * | 用户新打的字 | **放弃** | 不把他的新输入冲掉 |
 */

function makeTextarea(value: string): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.value = value;
  return el;
}

/** 装一套依赖：一个「当前输入框」的可变槽位 + 一个记录写回的桩。 */
function makeDeps(initial: HTMLTextAreaElement | null) {
  let live = initial;
  const writes: Array<{ element: HTMLTextAreaElement; text: string }> = [];
  return {
    deps: {
      resolveInput: () => live,
      writeValue: (element: HTMLTextAreaElement, text: string) => {
        writes.push({ element, text });
        element.value = text;
      },
    },
    writes,
    /** 模拟「页面把这一小块 DOM 重建掉」/「重建完又挂回来」。 */
    setLive: (next: HTMLTextAreaElement | null) => {
      live = next;
    },
  };
}

const INJECTED = '这是我们注入的续跑模板正文';
const DRAFT = '用户之前打的草稿';

describe('composer draft: 恢复的三档判据', () => {
  it('当前值为空 ⇒ 写回草稿', () => {
    const live = makeTextarea('');
    const { deps, writes } = makeDeps(live);
    const guard = captureComposerDraft(makeTextarea(DRAFT), INJECTED, deps);

    guard.restore();

    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toBe(DRAFT);
    expect(live.value).toBe(DRAFT);
  });

  it('当前值仍是我们注入的那份 ⇒ 写回草稿', () => {
    // ⚠️ 这一档是「页面还没清、或反向同步又把我们的 prompt 写回来了」。
    // 那份 prompt 本来就不该给用户看，换回草稿是对的。
    const live = makeTextarea(INJECTED);
    const { deps, writes } = makeDeps(live);
    const guard = captureComposerDraft(makeTextarea(DRAFT), INJECTED, deps);

    guard.restore();

    expect(writes).toHaveLength(1);
    expect(live.value).toBe(DRAFT);
  });

  it('用户已经重新打了字 ⇒ 放弃，不覆盖他', () => {
    // ⚠️⚠️ **这是本组最重要的一条** —— 从交还输入框到恢复之间隔着最长 5 秒的证据等待，
    // 用户完全可能已经开始打新内容。写回会把它冲掉，而且用户看不到任何提示。
    const live = makeTextarea('用户刚打的新内容');
    const { deps, writes } = makeDeps(live);
    const guard = captureComposerDraft(makeTextarea(DRAFT), INJECTED, deps);

    guard.restore();

    expect(writes, '不该写回').toHaveLength(0);
    expect(live.value, '用户的新输入必须原样保留').toBe('用户刚打的新内容');
  });

  it('放完之后用户又清空了，再调一次也不还（放弃是终局）', () => {
    // ⚠️ 与下一条（拿不到框）方向相反：这一档**已经**判过「用户在用了」，所以置位。
    // 不置位的话，兜底那次会把旧草稿塞回一个他刚发完消息的空输入框里。
    const live = makeTextarea('用户刚打的新内容');
    const { deps, writes } = makeDeps(live);
    const guard = captureComposerDraft(makeTextarea(DRAFT), INJECTED, deps);

    guard.restore();
    live.value = '';
    guard.restore();

    expect(writes, '第二次不该写回').toHaveLength(0);
  });
});

describe('composer draft: 拿不到输入框时留一次机会', () => {
  it('第一次拿不到框 ⇒ 不写、也不置位；框回来后兜底那次仍会还', () => {
    // ⚠️⚠️ **这正是外部评审 P2-4 指出的那一档** —— 页面在注入之后可能把这一小块 DOM
    // 重建掉。旧写法把 `restored = true` 放在 `if (!live) return` 之前 ⇒ 那次白丢之后，
    // `finally` 里的兜底也不会再试。
    const { deps, writes, setLive } = makeDeps(null);
    const guard = captureComposerDraft(makeTextarea(DRAFT), INJECTED, deps);

    guard.restore();          // 页面正在重建期间 —— 拿不到框
    expect(writes).toHaveLength(0);

    const rebuilt = makeTextarea('');
    setLive(rebuilt);
    guard.restore();          // 兜底那次：框回来了，应当还

    expect(writes, '兜底那次必须还').toHaveLength(1);
    expect(rebuilt.value).toBe(DRAFT);
  });

  it('空草稿 ⇒ 从头到尾 no-op', () => {
    // 用户本来就没打东西 ⇒ 没有草稿可还，也不该往框里写一个空白串。
    const live = makeTextarea('');
    const { deps, writes } = makeDeps(live);

    captureComposerDraft(makeTextarea(''), INJECTED, deps).restore();
    captureComposerDraft(makeTextarea('   '), INJECTED, deps).restore();

    expect(writes).toHaveLength(0);
  });

  it('写回成功后不再重复写（幂等）', () => {
    const live = makeTextarea('');
    const { deps, writes } = makeDeps(live);
    const guard = captureComposerDraft(makeTextarea(DRAFT), INJECTED, deps);

    guard.restore();
    guard.restore();
    guard.restore();

    expect(writes, '只写一次').toHaveLength(1);
  });
});