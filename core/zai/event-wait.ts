/**
 * **事件驱动的等待原语** —— 零依赖，可被真输入喂满。
 *
 * ## 为什么需要（整套方案一的技术依据）
 *
 * Chrome 把后台标签的 `setTimeout` / `setInterval` 压到每秒一次（隐藏超过 5 分钟后
 * 强化节流到每分钟一次）。而本项目的续跑发送链原本全靠 80–150ms 的短轮询串起来：
 *
 * | 等待 | 预算 | 后台的采样点 |
 * |---|---|---|
 * | 发送按钮可用 | 4 秒 | 4 个 |
 * | 发送证据 | 5 秒 | 5 个 |
 *
 * 而实测「发送按钮可用」这个条件的存在窗口只有 **125–130ms** ⇒ 1000ms 采样落进去
 * 的概率约 13%，4 个样本全错过的概率接近一半 ⇒ 判 `unsent` ⇒ 续跑静默收尾。
 *
 * ## 判据：什么不受节流
 *
 * 官方文档只点名 `setTimeout` / `setInterval` / `scheduler.postTask` 被节流。
 * `MutationObserver` 回调**不走定时器队列** —— 真机实测（后台标签 8 分钟）：
 *
 * | 通道 | 后台 p50 | 后台 min |
 * |---|---|---|
 * | `MutationObserver` | 138.4ms | **5.8ms** |
 * | `setInterval(100)` 对照 | **998.2ms**（紧贴整千） | 530.9ms |
 * | 桥上 `postMessage` | **0.2ms** | 0.1ms |
 *
 * ⇒ 观察器与 message 事件都不受节流；只有定时器受。这就是本模块的全部依据。
 *
 * ⚠️⚠️ **超时兜底定时器仍然要留** —— 观察器只在「有变化」时唤醒，而「条件永远不成立」
 * 那种情况不会有任何变化，没有定时器就会永久挂起。它在后台被压到 1000ms 无所谓：
 * 它的语义只是「别无限等」，**超时的返回值与「条件成立」是两个不同的值**，精度不影响判定。
 */

/** 取一次条件；抛错一律按「未成立」处理。 */
export function safeProbe<T>(probe: () => T | null): T | null {
  try {
    const value = probe();
    // ⚠️ **`undefined` 一律按「未成立」处理** —— 判据是 `!== null`，若把 `undefined`
    // 当成立，那么「探针忘了写 return」这种错会变成**静默的立即成功**（最坏的失败方向）。
    return value === undefined ? null : value;
  } catch {
    // ⚠️ **必须吞** —— `getComputedStyle` 在脱连节点上会抛，而「暂时读不到」
    // 不等于「条件不成立」，更不能让它把整个等待打断。
    return null;
  }
}

export interface DomConditionOptions<T> {
  /** 每次 DOM 变动后调一次；返回非 `null` 即立即结束并带回该值。 */
  probe: () => T | null;
  /** 超时；到期返回 `fallback()`。 */
  timeoutMs: number;
  /** 超时的返回值。**必须与「条件成立」区分开**。 */
  fallback: () => T;
  /** 观察根。默认 `document.body`，没有则 `documentElement`。 */
  root?: Node | null;
  /** 监听哪些属性。默认含 `disabled`（发送按钮的可用态是属性投影）。 */
  attributeFilter?: readonly string[];
}

const DEFAULT_ATTRIBUTE_FILTER = ['disabled', 'class', 'style', 'aria-label'];

/**
 * **等一个 DOM 条件成立** —— 事件驱动，不轮询。
 *
 * ⚠️ **必须三档都开**：`childList`（节点增删）、`characterData`（文本变化）、
 * `attributes`（`disabled` / `class` / `style` 这类状态投影）。少一档就会漏掉
 * 「只有属性变了」的那一类 —— 发送按钮的可用态正是属性变更、节点不动。
 */
export function waitForDomCondition<T>(options: DomConditionOptions<T>): Promise<T> {
  const { probe, timeoutMs, fallback } = options;

  const immediate = safeProbe(probe);
  if (immediate !== null) return Promise.resolve(immediate);

  const root = options.root === undefined
    ? (typeof document === 'undefined' ? null : (document.body ?? document.documentElement))
    : options.root;
  // 没有可观察的根 ⇒ 只能靠超时（`safeProbe` 已经试过一次，这里是「确定拿不到」）。
  if (!root) return Promise.resolve(fallback());

  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(value);
    };

    const observer = new MutationObserver(() => {
      const value = safeProbe(probe);
      if (value !== null) finish(value);
    });

    const timer = setTimeout(() => finish(fallback()), timeoutMs);

    try {
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...(options.attributeFilter ?? DEFAULT_ATTRIBUTE_FILTER)],
      });
    } catch {
      // ⚠️⚠️ **观察器装不上必须降级到 `fallback()`，不能 reject** ——
      // `observe()` 抛错时整个 Promise 会 reject，而调用方（`waitForComposerReady`
      // 的 `.then`、`trySubmitViaFormRequestSubmit` 的 `finally`）**都没有 catch**
      // ⇒ 一次观察器失败会让整条发送链抛错。而本模块的约定是「失败方向一律静默降级」。
      finish(fallback());
    }
  });
}

/** 一个「叫醒所有等待者」的登记表 —— 由生产端在状态变化时 `notify()`。 */
export interface WaiterRegistry {
  /** 登记一个等待者，返回撤销函数。 */
  add: (waiter: () => void) => () => void;
  /** 叫醒全部（同步调用，见各生产点的说明）。 */
  notify: () => void;
  /** 当前登记数（诊断 / 测试用）。 */
  readonly size: number;
}

export function createWaiterRegistry(): WaiterRegistry {
  const waiters = new Set<() => void>();
  return {
    add: (waiter) => {
      waiters.add(waiter);
      return () => waiters.delete(waiter);
    },
    notify: () => {
      for (const waiter of [...waiters]) {
        try {
          waiter();
        } catch {
          // ⚠️ 单个等待者抛错不能影响其它等待者，更不能影响触发它的那条生产链。
        }
      }
    },
    get size() {
      return waiters.size;
    },
  };
}

/**
 * **等一件与某个计数器有关的事发生** —— 事件驱动，不轮询。
 *
 * `evaluate` 每被叫醒一次就跑一遍，返回 `true` 即结束。唤醒源有两个：
 * ① `registry.notify()`（生产端在计数器自增处调用）；
 * ② 超时兜底定时器。
 *
 * ⚠️ **超时返回 `false`**，调用方据此分档。
 * ⚠️ **`evaluate` 抛错按「未成立」处理**（走 `safeProbe`）。
 */
export function waitForNotified(
  evaluate: () => boolean,
  timeoutMs: number,
  registry: WaiterRegistry,
): Promise<boolean> {
  if (safeProbe(evaluate) === true) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(value);
    };
    const check = () => {
      if (settled) return;
      if (safeProbe(evaluate) === true) finish(true);
    };
    const unsubscribe = registry.add(check);
    const timer = setTimeout(() => {
      // 到期再判一次 —— 定时器被节流后可能晚于最后一次通知。
      finish(safeProbe(evaluate) === true);
    }, timeoutMs);
  });
}