/**
 * 隐藏页面上的**续跑 / nudge 模板气泡**（跑在内容脚本 / 隔离世界）。
 *
 * 背景：续跑与 nudge 的 prompt 是我们经 DOM 注入、让页面自己发出去的。页面把它当成
 * 一条**用户消息**渲染出来，内容是一大段工具结果 JSON —— 用户会看到它。
 * 刷新后的那一份由 `core/zai/history-cleanup.ts` 换成占位符处理；**本模块管当场这份**。
 *
 * ⚠️ **只隐藏、不改文本** —— 改 `textContent` 会打乱页面对这条消息的内部状态
 * （它是 Svelte 渲染的，重渲染会把我们的改动冲掉）。隐藏是幂等的、且不参与它的状态。
 *
 * ⚠️ **站点假设集中在这一个常量上**（`CONTINUATION_BUBBLE_SELECTOR`）。
 * 与 `core/ui/tool-result-cards.ts` 的 `ASSISTANT_MESSAGE_SELECTOR` 同一处理方式：
 * 选择器错了的表现是**静默的**（气泡照旧可见，其余功能不受影响），
 * 所以它是「可观测但无害」的失效，而不是会连累主流程的那种。
 */

import { isZaiContinuationPrompt } from './continuation-marker';

/**
 * 用户消息容器。
 *
 * ⚠️ **已由探针验证**（`F:\Conversation\GLM\zai-续跑气泡探针.js`）：真机上 4 条用户消息里
 * 2 条是续跑模板，命中准确。⚠️ **别换成更宽的写法**：`[class*="user-message"]` 计数是 **8**
 * （页面上还有个 `edit-user-message-button` 也含这个子串）⇒ 子串匹配会多抓一倍元素。
 * ⚠️ 它错了的表现是**静默的**（气泡照旧可见，其余功能不受影响）。
 */
const CONTINUATION_BUBBLE_SELECTOR = '.user-message';

/** 隐藏标记 —— 幂等判据（同一条消息只处理一次）。 */
const HIDDEN_ATTR = 'data-dpp-hidden-continuation';

/**
 * 单次扫描最多看**最后**多少条候选（页面长了之后别整页扫）。
 *
 * ⚠️ **取值要克制**：每次扫描都要对候选跑 `textContent`（O(消息长度)），
 * 而扫描是**每帧合流**触发的。已隐藏的条目会被 `HIDDEN_ATTR` 提前跳过、不读文本，
 * 所以稳态很便宜；真正贵的是「新消息出现」那几帧。
 *
 * ⚠️ **64 是留余量，不是按需算出来的**：一次跑满的自动化任务最多产生
 * **26 条用户消息**（1 条原始 + 25 条续跑 prompt），而续跑 prompt 是**逐条插入**的 ——
 * 每条出现时都在末尾、当时就会被隐藏。所以 24 其实也够。
 * 取 64 是为了覆盖一个**未验证的**失效形态：页面若重渲染了旧消息、且数据源是内存里的
 * 原始文本，那些气泡既会丢 `HIDDEN_ATTR`、又可能落在窗口外。
 * ⚠️ 实测代价是噪声级（24 → 64 时每次扫描 0.12 ms → 0.14 ms）。
 */
const MAX_CANDIDATES = 64;

export interface ContinuationBubbleDependencies {
  /** 注入 `document`（测试用）。 */
  root: ParentNode & { querySelectorAll: ParentNode['querySelectorAll'] };
  /** 单次扫描的候选上限；缺省用 `MAX_CANDIDATES`。 */
  maxCandidates?: number;
}

/**
 * 扫一遍页面，把带续跑模板文本的气泡藏掉。返回本次隐藏了几条。
 *
 * ⚠️ **判据是「这个气泡的文本里含续跑模板的结构标签」** —— 与历史侧**同一份判据**
 * （`isZaiContinuationPrompt`，来自零依赖的 `continuation-marker.ts`）。
 * 各写一遍会在改模板时静默分叉：一边认得出、另一边认不出。
 *
 * ⚠️⚠️ **刻意不按文本长度跳过任何候选** —— 曾经有一条 `length > 20_000` 的守卫，
 * 理由是「省掉 `textContent` 的开销」。**那条守卫在结构上就不可能达到目的**
 * （要判长度必须先读 `textContent`），而且**失败方向是反的**：续跑模板的正文就是工具结果
 * JSON，实测 6–12 KB、**理论上界约 66 KB**（4 条完整结果的 `detail` ≤4,000 + `output` ≤8,000
 * 叠满）⇒ **载荷越大越该被隐藏、越可能落进守卫之外**。
 * 实测删掉后每次扫描只多 0.006–0.042 ms（一帧的千分之三以内）。
 *
 * ⚠️ **`display: none` 用内联样式 + `!important`** —— 页面的气泡样式表里有
 * `display: flex` 这类规则，普通内联样式会被它盖掉（优先级相同时后加载的胜）。
 */
export function hideContinuationBubbles(
  dependencies: ContinuationBubbleDependencies,
): number {
  const { root } = dependencies;
  const maxCandidates = dependencies.maxCandidates ?? MAX_CANDIDATES;
  let candidates: Element[];
  try {
    candidates = Array.from(root.querySelectorAll(CONTINUATION_BUBBLE_SELECTOR));
  } catch {
    return 0;
  }
  const start = Math.max(0, candidates.length - maxCandidates);
  let hidden = 0;
  for (let index = start; index < candidates.length; index += 1) {
    const element = candidates[index] as HTMLElement;
    if (!element || element.getAttribute(HIDDEN_ATTR) === 'true') continue;
    const text = element.textContent ?? '';
    if (!text) continue;
    if (!isZaiContinuationPrompt(text)) continue;
    element.setAttribute(HIDDEN_ATTR, 'true');
    element.style.setProperty('display', 'none', 'important');
    hidden += 1;
  }
  return hidden;
}

/**
 * 装一个**按帧合流**的观察器：DOM 一变就重扫（续跑气泡是在页面渲染完成后才出现的，
 * 提交那一刻还没有它）。
 *
 * ⚠️ **必须按帧合流** —— 流式回答时 DOM 每秒会变更上百次，逐次触发会明显掉帧。
 * 与 `installBackgroundCapability` 的 MutationObserver 同一处理方式。
 *
 * ⚠️ **只观察 `childList` + `subtree`，不观察 `characterData`** —— 我们要找的是
 * 「气泡出现了」，那一定伴随节点插入；观察文本变化会让流式输出期间每帧都触发。
 */
export function installContinuationBubbleHider(options?: {
  root?: Document;
  onHidden?: (count: number) => void;
}): () => void {
  const doc = options?.root ?? document;
  let scheduled = false;
  const scan = () => {
    scheduled = false;
    try {
      const hidden = hideContinuationBubbles({ root: doc });
      if (hidden > 0) options?.onHidden?.(hidden);
    } catch (error) {
      console.warn('[Zai++] continuation bubble hide failed', error);
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    // ⚠️ **`requestAnimationFrame` 要有兜底** —— 后台标签页里它可能被节流到不触发，
    // 某些环境（无 rAF 的宿主）甚至不存在。退化成同步扫描只是「这一拍多扫一次」，
    // 而漏扫的表现是**气泡一直显示**。
    try {
      requestAnimationFrame(scan);
    } catch {
      scan();
    }
  };

  // 立刻扫一次（切回一个已经有气泡的会话时）。
  schedule();

  let observer: MutationObserver | null = null;
  const observeTarget = doc.body ?? doc.documentElement;
  if (observeTarget) {
    try {
      observer = new MutationObserver(schedule);
      observer.observe(observeTarget, { childList: true, subtree: true });
    } catch (error) {
      console.warn('[Zai++] continuation bubble observer unavailable', error);
    }
  }

  return () => {
    try {
      observer?.disconnect();
    } catch {
      /* 卸载失败不影响其它清理 */
    }
  };
}
