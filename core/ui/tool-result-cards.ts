/**
 * 把工具结果卡片挂到 z.ai 页面的助手消息里。
 *
 * 分工：`tool-result-renderer.ts` 只管「把一个结果对象画成卡片」，
 * 这里管「挂到哪儿、什么时候挂、别挂重复」。
 *
 * ⚠️ **助手消息的选择器是本模块唯一的站点假设**，见 `ASSISTANT_MESSAGE_SELECTOR`。
 * 挂载是**尽力而为**的：找不到锚点就不挂（结果本身已经在后台落库、也进了续跑链），
 * 绝不因为找不到 DOM 而报错或阻塞主流程。
 */

import type { ToolExecutionRecord } from '../types';
import {
  registerDefaultToolResultRenderers,
  renderToolResultWithRegistry,
  type ToolResultRendererActions,
} from './tool-result-renderer';

/**
 * 助手消息容器。与用户消息（`.user-message`）同属一套页面样式命名。
 *
 * ⚠️ **待真机验证** —— 这个选择器来自对页面 DOM 的既有记录，没有在改动后实测过。
 * 它错了的表现是**静默的**：卡片永远不出现，其余功能不受影响。改这块之前先
 * 用探针确认，别基于猜测改。
 */
const ASSISTANT_MESSAGE_SELECTOR = '.chat-assistant';

/** 卡片容器的注入标记（同一条消息只挂一个）。 */
const CARD_HOST_ATTR = 'data-dpp-result-cards';

/** 容器上记录「已挂过哪些结果」的属性 —— 去重的唯一真源（与容器同生命周期）。 */
const MOUNTED_KEYS_ATTR = 'data-dpp-mounted';

/** 单条消息最多挂几张卡片（结果多了会淹掉正文）。 */
const MAX_CARDS_PER_MESSAGE = 3;

export interface ToolResultCardDependencies extends ToolResultRendererActions {
  /** 读当前语言；拿不到时渲染器退回默认语言。 */
  getLocale: () => Parameters<typeof renderToolResultWithRegistry>[0]['locale'];
}

/**
 * 给「最后一轮执行过、且有可渲染结果」的工具挂卡片。
 *
 * ⚠️ **必须按结果去重，不能只按容器去重** —— 本函数**每轮回答结束都会被调一次**，
 * 而同一轮的 `executions` 会被反复传进来（续跑轮还会把历史执行也带上）。
 * 只判「容器在不在」会让同一张卡片每轮多挂一份，所以容器上记着已挂结果的指纹。
 *
 * ⚠️ **容器的两种消失要分清**（这是本模块最容易改错的一处）：
 * - **我们**画的卡片一张都没成 → 容器留着但隐藏（指纹跟着它活）；
 * - **页面**重建了消息的子节点 → 容器真的没了，指纹也没了 —— 那正是「该重画」的信号。
 */
export function mountToolResultCards(
  executions: readonly ToolExecutionRecord[],
  deps: ToolResultCardDependencies,
): void {
  if (typeof document === 'undefined') return;
  const renderable = executions.filter(hasRenderableOutput);
  if (renderable.length === 0) return;

  const message = findLastAssistantMessage();
  if (!message) return;

  registerDefaultToolResultRenderers(deps);

  let host = message.querySelector<HTMLElement>(`:scope > [${CARD_HOST_ATTR}]`);
  if (!host) {
    host = document.createElement('div');
    host.setAttribute(CARD_HOST_ATTR, '');
    message.appendChild(host);
  }

  const mounted = readMountedKeys(host);

  for (const execution of renderable) {
    const key = executionKey(execution);
    if (mounted.has(key)) continue;
    if (host.childElementCount >= MAX_CARDS_PER_MESSAGE) break;
    const slot = document.createElement('div');
    const rendered = renderToolResultWithRegistry({
      target: slot,
      result: execution.result,
      locale: deps.getLocale(),
    });
    // 渲染器返回 false 表示「这个结果它不认识」—— 丢弃空壳，不留占位。
    // 无论成败都记下指纹：失败的结果下轮也不会突然变得可渲染，反复重试没有意义。
    mounted.add(key);
    if (rendered) host.appendChild(slot);
  }

  host.setAttribute(MOUNTED_KEYS_ATTR, [...mounted].join('\n'));

  // ⚠️⚠️ **一张都没画出来时也保留容器，只是隐藏它** —— 两个理由缺一不可：
  // 1. **指纹挂在容器上**（见 `MOUNTED_KEYS_ATTR` 的说明）。把容器删掉，指纹就跟着没了，
  //    下次调用会建新容器、指纹集为空，同一批结果被重新尝试一遍。
  // 2. **反过来，容器被页面摘掉时必须能自愈** —— 页面（Svelte）会就地重建消息的子节点，
  //    我们的容器会消失而消息元素还在。那种情况下「容器不存在」是**唯一**能表达
  //    「卡片没了、得重画」的信号。若指纹存在别处（比如消息元素上），这条路径会
  //    判定「已挂过」而不再重画 —— 卡片永久消失。
  // 两者合起来只有一个自洽解：**指纹跟容器走，而容器由我们保留**。
  host.hidden = host.childElementCount === 0;
}

/** 容器上记录「已挂过哪些结果」的属性 —— 去重的唯一真源（与容器同生命周期）。 */
function readMountedKeys(host: HTMLElement): Set<string> {
  return new Set((host.getAttribute(MOUNTED_KEYS_ATTR) ?? '').split('\n').filter(Boolean));
}

/**
 * 结果的去重指纹。
 *
 * 优先用 `callId`（同一次工具调用的稳定标识）；没有就退到「工具名 + 结果内容的
 * 哈希」。两者都拿不到时返回空串 —— 那样会被当成「每次都不同」，宁可多挂一张
 * 也不静默吞掉一张卡片。
 */
function executionKey(execution: ToolExecutionRecord): string {
  if (execution.callId) return `id:${execution.callId}`;
  try {
    const serialized = JSON.stringify(execution.result?.output ?? null);
    return `${execution.name}:${serialized.length}:${serialized.slice(0, 160)}`;
  } catch {
    return '';
  }
}

function hasRenderableOutput(execution: ToolExecutionRecord): boolean {
  const output = execution.result?.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const kind = (output as { kind?: unknown }).kind;
  return kind === 'skill_draft' || kind === 'memory_import_preview';
}

/**
 * 取最后一条助手消息。
 *
 * 取不到返回 null —— 调用方据此跳过（见模块头注释的「尽力而为」）。
 * 用 `lastElementChild` 而不是 `querySelector`，是因为页面会在流式输出时
 * 不断重建节点，列表末尾才是当前这条。
 */
function findLastAssistantMessage(): HTMLElement | null {
  const messages = document.querySelectorAll<HTMLElement>(ASSISTANT_MESSAGE_SELECTOR);
  return messages.length > 0 ? messages[messages.length - 1] : null;
}
