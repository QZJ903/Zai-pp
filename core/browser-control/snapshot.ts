import type {
  BrowserSnapshotNode,
  BrowserSnapshotResult,
} from './types';
import { utf8ByteLength } from '../tool/result-bytes';

/**
 * 超预算时追加在 `text` 末尾的标记。
 *
 * ⚠️ **它自己的字节数也要算进预算** —— 见下面那段说明。单独提成常量是为了
 * 「加标记」与「量标记」用的是同一个真源，别在两处各写一份字面量。
 *
 * ⚠️ **量长度走共享的 `utf8ByteLength`** —— 那个函数是「UTF-8 字节」这件事的
 * 唯一实现，`core/tool` / `core/skill` / `core/mcp` 也用它。这里**不自己写一份**：
 * 早先本文件有个私有的 `utf8Length`，与共享版语义相同但写法不同（`.length` vs
 * `.byteLength`），两份各自被各自的用例守着 —— 而那种「看起来一样、改一处不影响另一处」
 * 的形态正是重复实现最容易漂的地方。
 * ⚠️ **它按「新增的那一行」调用、不按整段 `text`** —— 每个节点上编码整段已是 O(n²)。
 */
const SNAPSHOT_TRUNCATION_MARKER = '\n...[snapshot truncated]';
const SNAPSHOT_TRUNCATION_MARKER_BYTES = utf8ByteLength(SNAPSHOT_TRUNCATION_MARKER);

interface AxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  description?: { value?: unknown };
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: Array<{
    name?: string;
    value?: { value?: unknown };
  }>;
}

interface SnapshotInput {
  axNodes: AxNode[];
  url: string;
  title: string;
  maxNodes: number;
  maxTextBytes: number;
}

export interface FormattedSnapshot {
  result: BrowserSnapshotResult;
  uidToBackendNodeId: Map<string, number>;
}

export function formatAccessibilitySnapshot(input: SnapshotInput): FormattedSnapshot {
  const uidToBackendNodeId = new Map<string, number>();
  const normalized = input.axNodes.filter((node) => !node.ignored);
  const byId = new Map<string, AxNode>();
  const referenced = new Set<string>();
  for (const node of normalized) {
    if (node.nodeId) byId.set(node.nodeId, node);
    for (const childId of node.childIds ?? []) referenced.add(childId);
  }

  const roots = normalized.filter((node) => node.nodeId && !referenced.has(node.nodeId));
  const queue: Array<{ node: AxNode; level: number }> = roots.length > 0
    ? roots.map((node) => ({ node, level: 0 }))
    : normalized.map((node) => ({ node, level: 0 }));

  const nodes: BrowserSnapshotNode[] = [];
  const seen = new Set<string>();
  let text = `URL: ${input.url || '(unknown)'}\nTitle: ${input.title || '(untitled)'}\n`;
  // ⚠️ **累计字节必须跟着 `text` 一起长** —— 逐行累加（每行只编码一次），
  // 不在循环里重新编码全文。
  let textBytes = utf8ByteLength(text);
  let truncated = false;

  while (queue.length > 0) {
    const { node, level } = queue.shift()!;
    if (node.nodeId && seen.has(node.nodeId)) continue;
    if (node.nodeId) seen.add(node.nodeId);

    const normalizedNode = toSnapshotNode(node, nodes.length + 1, level);
    if (!shouldIncludeNode(normalizedNode)) {
      enqueueChildren(queue, node, byId, level);
      continue;
    }

    if (nodes.length >= input.maxNodes) {
      truncated = true;
      break;
    }

    // ⚠️⚠️ **文本预算必须判在 `nodes.push` 之前** —— 判在之后的话，撞线那个节点
    // 已经进了 `nodes` 与 `uidToBackendNodeId`，但它的行没进 `text`：
    // 模型按 `text` 看不见它，而 `browser_click { uid }` 照样能解析成功
    // （`DOM.resolveNode` 认的是映射）⇒ **看不见却能点**，`nodeCount` 也比实际可见的多 1。
    // 两个预算的截断点必须同源（`maxNodes` 那条本来就在 push 之前）。
    const nextLine = formatSnapshotLine(normalizedNode);
    const nextLineBytes = utf8ByteLength(nextLine);
    if (textBytes + nextLineBytes > input.maxTextBytes) {
      truncated = true;
      break;
    }
    nodes.push(normalizedNode);
    if (normalizedNode.backendDOMNodeId !== undefined) {
      uidToBackendNodeId.set(normalizedNode.uid, normalizedNode.backendDOMNodeId);
    }
    text += nextLine;
    textBytes += nextLineBytes;

    enqueueChildren(queue, node, byId, level);
  }

  /**
   * ⚠️⚠️ **截断标记本身也要算进预算** —— 判据在循环里用的是 `maxTextBytes`，
   * 而标记是在判完之后追加的（`SNAPSHOT_TRUNCATION_MARKER` 是 25 字节）。
   * 不扣它的话最终 `text` 会超出预算 25 字节。
   *
   * 后果不是功能错，是**两处截断信号叠加**：英文页 24_000 字节 ≈ 24_000 字符，
   * 再进 `core/zai/continuation.ts` 的 `BROWSER_SNAPSHOT_DETAIL_MAX_CHARS`（同为 24_000
   * **字符**）时会多出第二个 `...[truncated]` —— 读的人会以为被截了两轮。
   *
   * ⚠️ **放不下就干脆不加** —— 加一个把预算撑破的标记，比没有标记更糟：
   * 下游按「没超预算」处理，而它其实超了。
   */
  if (truncated && textBytes + SNAPSHOT_TRUNCATION_MARKER_BYTES <= input.maxTextBytes) {
    text += SNAPSHOT_TRUNCATION_MARKER;
  }

  return {
    result: {
      url: input.url,
      title: input.title,
      text,
      nodes,
      truncated,
    },
    uidToBackendNodeId,
  };
}

function toSnapshotNode(node: AxNode, index: number, level: number): BrowserSnapshotNode {
  const properties = new Map(
    (node.properties ?? [])
      .filter((item) => item.name)
      .map((item) => [item.name!, item.value?.value]),
  );

  return {
    uid: `e${index}`,
    role: readAxValue(node.role?.value) || 'node',
    name: readAxValue(node.name?.value),
    value: readOptionalAxValue(node.value?.value),
    description: readOptionalAxValue(node.description?.value),
    disabled: properties.get('disabled') === true,
    focused: properties.get('focused') === true,
    selected: properties.get('selected') === true,
    checked: normalizeChecked(properties.get('checked')),
    level,
    backendDOMNodeId: node.backendDOMNodeId,
  };
}

function enqueueChildren(
  queue: Array<{ node: AxNode; level: number }>,
  node: AxNode,
  byId: Map<string, AxNode>,
  level: number,
): void {
  const children = (node.childIds ?? [])
    .map((id) => byId.get(id))
    .filter((child): child is AxNode => Boolean(child));
  for (const child of children) queue.push({ node: child, level: level + 1 });
}

function shouldIncludeNode(node: BrowserSnapshotNode): boolean {
  if (node.role === 'generic' && !node.name && !node.value && !node.backendDOMNodeId) return false;
  if (node.role === 'none' && !node.name && !node.value) return false;
  return Boolean(node.role || node.name || node.value || node.description);
}

function formatSnapshotLine(node: BrowserSnapshotNode): string {
  const parts = [`${'  '.repeat(Math.min(node.level, 8))}[${node.uid}]`, node.role];
  if (node.name) parts.push(JSON.stringify(node.name));
  if (node.value) parts.push(`value=${JSON.stringify(node.value)}`);
  if (node.checked !== undefined) parts.push(`checked=${node.checked}`);
  if (node.selected) parts.push('selected');
  if (node.focused) parts.push('focused');
  if (node.disabled) parts.push('disabled');
  return `\n${parts.join(' ')}`;
}

function readAxValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function readOptionalAxValue(value: unknown): string | undefined {
  const text = readAxValue(value);
  return text || undefined;
}

function normalizeChecked(value: unknown): boolean | 'mixed' | undefined {
  if (value === true || value === false || value === 'mixed') return value;
  return undefined;
}
