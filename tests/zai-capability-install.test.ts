import { describe, expect, it, vi } from 'vitest';
import {
  disposeZaiCapabilities,
  installZaiCapabilities,
  installZaiSessionWatch,
  notifyZaiSessionChange,
  syncRuntimeStateBeforeUse,
  type ZaiCapabilityDeps,
} from '../core/zai/capability-install';
import { buildSkillPopupItems, wireSkillPopup } from '../core/ui/skill-popup-wiring';
import type { SkillPopupDependencies, SkillPopupItem } from '../core/ui/skill-popup';

/**
 * **启动链的编排** —— 用桩依赖**真调**，断言「谁被调了几次、按什么顺序、谁不被等」。
 *
 * ## 为什么是行为测试而不是 AST 断言
 *
 * 这段编排原先直接写在 `entrypoints/zai.content.ts` 的 `main()` 里，而那个文件
 * 不能被测试 import（模块顶层就执行 `defineContentScript`）。于是「这几处安装
 * 有没有真的接上」只能靠读源码做 AST 断言 —— 而那种断言**只能问名字、不能问身份**。
 * 实测被下面这些写法逐一绕过（每一种都 `tsc` 干净）：
 * 把调用挪进死函数 / 死类 / 死箭头；在 `main()` 里用 `const`、解构、`catch` 参数、
 * 形参重新绑定同名标识符；把真身改名再在文件末尾补同名壳靠**声明提升**接管；
 * 把 import 换成同名 stub；在同名可达函数体内塞**诱饵**同名函数。
 *
 * ⇒ 编排搬进 `core/zai/capability-install.ts` 之后，这里**真的调它**、
 * 传桩进去，判据是「桩有没有被调」—— 上面那一整族在结构上没有落点。
 * 这类断言**不会**再出现「我用来堵 A 的工具自己被 A 绕过」的循环。
 */

/** 造一套桩依赖，并记录每次调用。 */
function buildDeps(overrides: Partial<ZaiCapabilityDeps> = {}): {
  deps: ZaiCapabilityDeps;
  calls: string[];
  /** 每个安装函数被调的次数。 */
  count: (name: string) => number;
  unsubscribe: ReturnType<typeof vi.fn>;
  hiddenCounts: number[];
} {
  const calls: string[] = [];
  const record = (name: string) => {
    calls.push(name);
  };
  const unsubscribe = vi.fn();
  const hiddenCounts: number[] = [];

  const deps: ZaiCapabilityDeps = {
    installStopObserver: () => record('installStopObserver'),
    installSessionWatch: () => record('installSessionWatch'),
    installBackgroundCapability: async () => { record('installBackgroundCapability'); },
    installInjectedThemeWatch: () => record('installInjectedThemeWatch'),
    installContinuationBubbleHider: (options) => {
      record('installContinuationBubbleHider');
      // 桩里立刻回调一次，验「onHidden 被接到了生产那个回调上」。
      options.onHidden(3);
    },
    installToolPanel: async () => { record('installToolPanel'); },
    onSessionChange: (listener) => {
      record('onSessionChange');
      // ⚠️ **桩里立刻调一次 listener** —— 否则「订阅时有没有把
      // `handleSessionChange` 传进去」这件事根本没被观察到
      //（只记「订阅过一次」是不够的，订阅了但回调是空的同样会漏掉真缺陷）。
      listener();
      return unsubscribe;
    },
    handleSessionChange: () => record('handleSessionChange'),
    refreshAuth: async () => { record('refreshAuth'); return true; },
    // 站点记录：与另外两处「可选增强」一样是 `void` 调用（写不进去只是兜底退回默认站）。
    rememberViewedSite: async () => { record('rememberViewedSite'); return true; },
    syncRuntimeState: async () => { record('syncRuntimeState'); },
    onContinuationBubblesHidden: (count) => { hiddenCounts.push(count); },
    ...overrides,
  };

  return {
    deps,
    calls,
    count: (name) => calls.filter((entry) => entry === name).length,
    unsubscribe,
    hiddenCounts,
  };
}

describe('installZaiCapabilities: every install runs exactly once', () => {
  it.each([
    'installStopObserver',
    'installSessionWatch',
    'installBackgroundCapability',
    'installInjectedThemeWatch',
    'installContinuationBubbleHider',
    'installToolPanel',
    'onSessionChange',
    'refreshAuth',
    'rememberViewedSite',
  ])('calls %s', (name) => {
    const harness = buildDeps();
    installZaiCapabilities(harness.deps);
    expect(harness.count(name), `${name} 必须恰好被调一次`).toBe(1);
  });

  it('installs the stop observer first', () => {
    // ⚠️ 顺序是语义，不是随手排的：它要覆盖「页面刚起来就有 Stop」的窗口。
    const harness = buildDeps();
    installZaiCapabilities(harness.deps);
    expect(harness.calls[0]).toBe('installStopObserver');
  });

  it('installs the session watcher before subscribing to it', () => {
    // ⚠️ 反了会漏掉「启动到装完」之间那次导航。
    const harness = buildDeps();
    installZaiCapabilities(harness.deps);
    expect(harness.calls.indexOf('installSessionWatch'))
      .toBeLessThan(harness.calls.indexOf('onSessionChange'));
  });

  it('routes the session-change subscription into the panel handler', () => {
    // ⚠️⚠️ 切会话时旧记录的三条定位腿在新会话全 miss，兜底腿会把它挂到**新会话的消息**上
    // （真机实测：旧会话的 web_fetch / web_search / shell_status 出现在新会话里）。
    // 桩里立刻触发了 listener ⇒ 这条断言证明「订阅把 handleSessionChange 传进去了」。
    const harness = buildDeps();
    installZaiCapabilities(harness.deps);
    expect(harness.count('handleSessionChange'), '订阅回调必须调到面板的会话切换处理').toBe(1);
  });

  it('returns a cleanup function that unsubscribes the session watcher', () => {
    const harness = buildDeps();
    const cleanup = installZaiCapabilities(harness.deps);
    cleanup();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('refreshes the remembered site when the page becomes visible again', () => {
    // ⚠️ 那条记录只是读侧的兜底。它要答的是「上一次用户真正看着哪一站」，
    // 所以「切回这一站」这一刻必须补写一次。
    const harness = buildDeps();
    const cleanup = installZaiCapabilities(harness.deps);
    const before = harness.count('rememberViewedSite');

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      expect(harness.count('rememberViewedSite')).toBe(before + 1);

      // 卸载之后不再写（为将来的热卸载保留：清理函数必须把监听一起卸掉）。
      cleanup();
      document.dispatchEvent(new Event('visibilitychange'));
      expect(harness.count('rememberViewedSite')).toBe(before + 1);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('does not refresh the remembered site while the page is hidden', () => {
    const harness = buildDeps();
    const cleanup = installZaiCapabilities(harness.deps);
    const before = harness.count('rememberViewedSite');

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      expect(harness.count('rememberViewedSite')).toBe(before);
    } finally {
      cleanup();
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('does not remember the site on load while the page is hidden', () => {
    // ⚠️⚠️ **这一条守的是加载时那一处也判可见性** —— 后台标签页刷新一次也会跑到启动链，
    // 不门控就会把记录钉在后台那一站（用户在国际站看着、后台那个国区站标签页刷新了）。
    // 只看「⑧b 有没有门控」是不够的：两处各写一遍，漏一处就静默写歪。
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    try {
      const harness = buildDeps();
      installZaiCapabilities(harness.deps);
      expect(
        harness.count('rememberViewedSite'),
        '隐藏页面加载时不该写「上一次看着的站」',
      ).toBe(0);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('forwards the hidden-bubble count to the caller-supplied reporter', () => {
    const harness = buildDeps();
    installZaiCapabilities(harness.deps);
    expect(harness.hiddenCounts, '桩在安装时就回调了 onHidden(3)').toEqual([3]);
  });

  it('does not await the optional enhancements', () => {
    // ⚠️⚠️ **「不等」是契约的一部分** —— 背景配置 / 面板 / token 推送 / 站点记录
    // 都是可选增强，让它们挂住启动链会让 `syncRuntimeState` 迟迟不跑。
    // 判据：这几处必须在**同步的那一轮**里就被调到（如果被 await 了，
    // 它们会排在 microtask 之后，而下面这行同步断言就看不到它们了）。
    const harness = buildDeps();
    installZaiCapabilities(harness.deps);
    for (const name of [
      'installBackgroundCapability',
      'installToolPanel',
      'refreshAuth',
      'rememberViewedSite',
    ]) {
      expect(harness.count(name), `${name} 必须在同步阶段就被发起（不能被 await 挂住）`).toBe(1);
    }
  });

  it('does not touch runtime state sync on its own', () => {
    // ⚠️ 状态同步**要 await**，所以它被单独拆成 `syncRuntimeStateBeforeUse` ——
    // 混在 install 里会让「哪些要等」这件事消失。
    const harness = buildDeps();
    installZaiCapabilities(harness.deps);
    expect(harness.count('syncRuntimeState')).toBe(0);
  });
});

describe('syncRuntimeStateBeforeUse: the step that must be awaited', () => {
  it('delegates to the injected sync', async () => {
    const sync = vi.fn(async () => undefined);
    await syncRuntimeStateBeforeUse({ syncRuntimeState: sync });
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('returns a promise the caller can await', () => {
    const harness = buildDeps();
    const result = syncRuntimeStateBeforeUse(harness.deps);
    expect(result).toBeInstanceOf(Promise);
    return result;
  });
});

describe('disposeZaiCapabilities: both injected UIs are torn down', () => {
  it('disposes the skill popup and the tool panel', () => {
    // ⚠️⚠️ 不卸的后果是「扩展重载后输入框打不了字」：补全那个**捕获阶段** keydown
    // 监听还挂在 `document` 上会一直掐断 Enter；面板的 MutationObserver
    // 还在观察一个再也无人消费的 DOM。两者都不报错。
    const disposeSkillPopup = vi.fn();
    const disposeToolPanel = vi.fn();
    disposeZaiCapabilities({ disposeSkillPopup, disposeToolPanel });
    expect(disposeSkillPopup).toHaveBeenCalledTimes(1);
    expect(disposeToolPanel).toHaveBeenCalledTimes(1);
  });
});

/**
 * **地址变化观察**：三个监听源 + 一个轮询，必须全部挂上、且走**同一个处理器**。
 *
 * ⚠️ 这条链原本也只能靠 AST 断言守，而那种断言先后被「把通知挪进一个没人引用的
 * 兄弟箭头」「再声明一个同名箭头顶替前者」绕过（两种都 `tsc` 干净、全量全绿）。
 * 行为化之后，判据变成「**触发那个监听器，两个消费者有没有被调**」——
 * 那些写法在这里根本没有落点。
 */
describe('installZaiSessionWatch: every source feeds the same handler', () => {
  function buildWatch() {
    const reportLiveSession = vi.fn();
    const notifySessionChange = vi.fn();
    const addLocationChangeListener = vi.fn();
    const registered = new Map<string, () => void>();
    const intervals: { handler: () => void; ms: number }[] = [];
    const fakeWindow = {
      addEventListener: (type: string, handler: () => void) => { registered.set(type, handler); },
    } as unknown as Window;
    return {
      reportLiveSession,
      notifySessionChange,
      addLocationChangeListener,
      registered,
      intervals,
      deps: {
        reportLiveSession,
        notifySessionChange,
        addLocationChangeListener,
        intervalMs: 1_000,
        window: fakeWindow,
        setInterval: ((handler: () => void, ms: number) => {
          intervals.push({ handler, ms });
          return 0;
        }) as unknown as typeof setInterval,
      },
    };
  }

  it('registers all three listener sources and the polling interval', () => {
    const harness = buildWatch();
    installZaiSessionWatch(harness.deps);
    expect(harness.addLocationChangeListener, 'wxt:locationchange 必须挂上').toHaveBeenCalledTimes(1);
    expect([...harness.registered.keys()].sort(), 'popstate 与 hashchange 都必须挂上')
      .toEqual(['hashchange', 'popstate']);
    expect(harness.intervals, '1s 轮询必须挂上').toHaveLength(1);
    expect(harness.intervals[0]!.ms).toBe(1_000);
  });

  it.each(['wxt:locationchange', 'popstate', 'hashchange', 'interval'])(
    'notifies both consumers when %s fires',
    (source) => {
      // ⚠️⚠️ **这是本组最重要的一条** —— 只断言「挂上了监听器」挡不住
      // 「处理器里漏了一个消费者」（例如只有 popstate 那条调了 notifySessionChange）。
      // 判据是**触发它**，看两个消费者有没有都被调到。
      const harness = buildWatch();
      installZaiSessionWatch(harness.deps);

      if (source === 'interval') harness.intervals[0]!.handler();
      else if (source === 'wxt:locationchange') harness.addLocationChangeListener.mock.calls[0]![0]();
      else harness.registered.get(source)!();

      expect(harness.reportLiveSession, `${source} 触发时应当补报任务归属`).toHaveBeenCalledTimes(1);
      expect(harness.notifySessionChange, `${source} 触发时应当通知页面侧订阅者`).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the other sources alive when the wxt listener is unavailable', () => {
    // ⚠️ `wxt:locationchange` 拿不到时会抛 —— 只该记一行日志，不该让整条链不装
    //（popstate / hashchange / 轮询仍是有效兜底）。
    const harness = buildWatch();
    harness.addLocationChangeListener.mockImplementation(() => {
      throw new Error('locationchange unavailable');
    });
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      installZaiSessionWatch(harness.deps);
      expect([...harness.registered.keys()].sort()).toEqual(['hashchange', 'popstate']);
      expect(harness.intervals).toHaveLength(1);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('notifyZaiSessionChange: dedupe and isolation', () => {
  function buildNotify(sessionId: string | null, last: string | null) {
    const listeners = new Set<() => void>();
    let lastNotified = last;
    return {
      listeners,
      deps: {
        getCurrentSessionId: () => sessionId,
        listeners,
        readLastNotified: () => lastNotified,
        writeLastNotified: (value: string | null) => { lastNotified = value; },
      },
      last: () => lastNotified,
    };
  }

  it('does not disturb the subscribers when the session id did not change', () => {
    // ⚠️ 1s 轮询会每秒调到这里 —— 不去重的话项目面板会被每秒重绘一次。
    const harness = buildNotify('same', 'same');
    const listener = vi.fn();
    harness.listeners.add(listener);
    notifyZaiSessionChange(harness.deps);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies every subscriber when the session id changed', () => {
    const harness = buildNotify('new', 'old');
    const first = vi.fn();
    const second = vi.fn();
    harness.listeners.add(first);
    harness.listeners.add(second);
    notifyZaiSessionChange(harness.deps);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(harness.last()).toBe('new');
  });

  it('keeps notifying the rest when one subscriber throws', () => {
    // ⚠️ 一个消费者的 bug 不该让另一个收不到通知 —— 这个 Set 里同时有面板与项目面板。
    const harness = buildNotify('new', 'old');
    const broken = vi.fn(() => { throw new Error('boom'); });
    const healthy = vi.fn();
    harness.listeners.add(broken);
    harness.listeners.add(healthy);
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      notifyZaiSessionChange(harness.deps);
      expect(healthy).toHaveBeenCalledTimes(1);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('slash completion wiring: the real primitives are what gets injected', () => {
  const skills = [
    { name: 'alpha', description: '第一条' },
    { name: 'beta', enabled: false },
    { name: 'gamma' },
  ];

  /** 造桩：记下 `init` 收到的实参，供「引用相等」断言用。 */
  function buildWiring() {
    const resolveInput = vi.fn(() => null);
    const resolveAnchor = vi.fn(() => null);
    const setInputValue = vi.fn();
    let received: { items: SkillPopupItem[]; deps: SkillPopupDependencies; hint: string } | null = null;
    const init = (items: SkillPopupItem[], copy: { hint: string }, deps: SkillPopupDependencies) => {
      received = { items, deps, hint: copy.hint };
    };
    return {
      resolveInput,
      resolveAnchor,
      setInputValue,
      init,
      received: () => received,
    };
  }

  it('passes the primitives through by reference', () => {
    // ⚠️⚠️ **判据是引用相等，不是名字匹配** —— 把 `setInputValue: setTextareaValue`
    // 换成一个同名但空实现的本地函数时，任何「按名字找」的断言都会绿，
    // 而引用相等立刻红。这是这一层存在的全部理由。
    const harness = buildWiring();
    wireSkillPopup(skills, {
      hint: '提示',
      init: harness.init,
      resolveInput: harness.resolveInput,
      resolveAnchor: harness.resolveAnchor,
      setInputValue: harness.setInputValue,
    });
    const received = harness.received();
    expect(received).not.toBeNull();
    expect(received!.deps.setInputValue).toBe(harness.setInputValue);
    expect(received!.deps.resolveInput).toBe(harness.resolveInput);
  });

  it('routes the anchor resolution through the injected resolver', () => {
    const harness = buildWiring();
    wireSkillPopup(skills, {
      hint: '提示',
      init: harness.init,
      resolveInput: harness.resolveInput,
      resolveAnchor: harness.resolveAnchor,
      setInputValue: harness.setInputValue,
    });
    const received = harness.received()!;
    const fakeInput = {} as HTMLTextAreaElement;
    received.deps.resolveAnchor(fakeInput);
    expect(harness.resolveAnchor, 'resolveAnchor 必须调到注入的那个解析器').toHaveBeenCalledWith(fakeInput);
  });

  it('forwards the hint copy', () => {
    const harness = buildWiring();
    wireSkillPopup(skills, {
      hint: '↑↓ 导航',
      init: harness.init,
      resolveInput: harness.resolveInput,
      resolveAnchor: harness.resolveAnchor,
      setInputValue: harness.setInputValue,
    });
    expect(harness.received()!.hint).toBe('↑↓ 导航');
  });

  it('offers only enabled skills, keeping the ones without a description', () => {
    // ⚠️ 与 `resolveActiveLocalSkill` 同口径：禁用技能补全出来也用不了。
    // ⚠️ 描述缺失留空串、不丢这一条 —— 名字本身才是可用的那部分。
    expect(buildSkillPopupItems(skills)).toEqual([
      { name: 'alpha', description: '第一条' },
      { name: 'gamma', description: '' },
    ]);
  });
});
