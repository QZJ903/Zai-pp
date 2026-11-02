// @vitest-environment-options {"url": "https://chat.z.ai/c/abc"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installZaiFetchHook, readFeVersion } from '../core/zai/fetch-hook';

/**
 * **`hookXHR` 的卸载必须真的还原原型。**
 *
 * ⚠️⚠️ 这条守的是一个**恒不生效**的清理：`origOpen` / `origSend` 是**装之前**取的，
 * 而装完之后 `prototype.open` 已经是 wrapper ⇒ `prototype.open === origOpen` **恒为假**
 * ⇒ cleanup 里的两个赋值一次都不执行。后果：
 * ① 反复安装会一层层叠 wrapper（每次 `installZaiFetchHook()` 都套一层）；
 * ② 所有「装 → 卸」的测试其实**没有卸载**，后面的用例跑在带 hook 的原型上。
 *
 * ⚠️ 判据只能是「卸完之后是不是**原始那个函数**」，不能是「卸完还能不能用」——
 * wrapper 转发给原始函数，功能永远是好的。
 *
 * ⚠️ 生产里 `main()` 丢弃了 `installZaiFetchHook()` 的返回值，所以这条**当前零影响**；
 * 但它是测试里 9 处 `uninstall()` 的唯一保证，且只要 `main()` 跑两次就会叠层。
 */
describe('installZaiFetchHook: the XHR hook must be uninstalled for real', () => {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalFetch = window.fetch;

  afterEach(() => {
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
    // ⚠️⚠️ **marker 也要清** —— 只还原引用不删标记的话，一旦某条用例在 `uninstall()`
    // **之前**抛错，标记会留在原型上 ⇒ 同文件后续用例的 `install` 变成 no-op
    // ⇒ `expect(...).not.toBe(originalOpen)` 连锁假红（实测复现）。
    delete (XMLHttpRequest.prototype as unknown as Record<symbol, unknown>)[
      Symbol.for('zai-pp.xhr-hook-installed')
    ];
  });

  it('restores XMLHttpRequest.prototype.open and send to the original functions', () => {
    const uninstall = installZaiFetchHook();
    // 前提：装完之后确实换了（否则下面的断言在验空气）。
    expect(XMLHttpRequest.prototype.open).not.toBe(originalOpen);
    expect(XMLHttpRequest.prototype.send).not.toBe(originalSend);

    uninstall();

    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(XMLHttpRequest.prototype.send).toBe(originalSend);
  });

  it('does not stack wrappers across repeated install/uninstall cycles', () => {
    for (let round = 0; round < 3; round += 1) {
      const uninstall = installZaiFetchHook();
      uninstall();
    }
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(XMLHttpRequest.prototype.send).toBe(originalSend);
  });

  it('keeps a second install a no-op while the marker is present', () => {
    // 不卸载再装：marker 挡住，不该再套一层。
    const first = installZaiFetchHook();
    const afterFirst = XMLHttpRequest.prototype.open;
    const second = installZaiFetchHook();
    expect(XMLHttpRequest.prototype.open).toBe(afterFirst);
    second();
    first();
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
  });
});

/**
 * **`readFeVersion` 取的是「最大版本」，而最大必须按数字段比。**
 *
 * ⚠️⚠️ 用 `sort().reverse()[0]` 是**字典序**：`prod-fe-1.0.99` 会排在 `prod-fe-1.0.194`
 * **后面**被当成「更新」。单版本场景下两种实现**完全同值** ⇒ 只有多版本并存才分叉，
 * 所以必须**同时**造出两个版本。
 *
 * ⚠️ 判据的手写期望：`1.0.194 > 1.0.99`、`1.0.10 > 1.0.9`。这两组都是「字符串序与
 * 数字序相反」的最小样本。
 */
describe('readFeVersion: the newest prod-fe version wins', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stubResources = (names: readonly string[]): void => {
    // ⚠️ 只换 `getEntriesByType`，其余 Performance 成员（`now` 等）保持原样 ——
    // 整体替换对象会让同一进程里的其它消费者炸。
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
      names.map((name) => ({ name }) as PerformanceEntry),
    );
  };

  it('picks the numerically greatest version, not the lexicographically greatest', () => {
    stubResources([
      'https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.0.99/assets/index-a.js',
      'https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.0.194/assets/index-b.js',
    ]);
    expect(readFeVersion()).toBe('prod-fe-1.0.194');
  });

  it('compares every numeric segment, not just the first', () => {
    stubResources(['https://cdn/x/prod-fe-1.0.9/a.js', 'https://cdn/x/prod-fe-1.0.10/b.js']);
    expect(readFeVersion()).toBe('prod-fe-1.0.10');
  });

  it('returns the only version when there is just one', () => {
    stubResources(['https://cdn/x/prod-fe-1.0.194/a.js']);
    expect(readFeVersion()).toBe('prod-fe-1.0.194');
  });

  it('returns an empty string when no resource carries a version', () => {
    stubResources(['https://cdn/x/assets/index-a.js']);
    expect(readFeVersion()).toBe('');
  });

  it('does not carry a stale lastIndex across calls (no /g flag on the regex)', () => {
    // ⚠️⚠️ **这个形状是刻意的，别「简化」成两条相同的 URL** ——
    // 两条版本号相同时，带 `/g` 的 `exec` 第二次从 `lastIndex` 起找不到会重置为 0，
    // 两次调用仍返回同一个值 ⇒ 断言**恒过**，测不出 `/g`（实测过）。
    // 要暴露 `/g`：**第一条的版本号位置靠右、第二条靠左**（index 0 < 上一条的 `lastIndex`），
    // 这样第二条会被整条跳过 ⇒ 只命中 1.0.99 ⇒ 与期望的 1.0.194 不等。
    stubResources([
      `https://cdn/x/assets/${'a'.repeat(40)}/prod-fe-1.0.99/index.js`,
      'prod-fe-1.0.194/assets/b.js',
    ]);
    expect(readFeVersion()).toBe('prod-fe-1.0.194');
    // 第二次调用：`lastIndex` 若被跨调用保留，这里还会再错一次。
    expect(readFeVersion()).toBe('prod-fe-1.0.194');
  });
});