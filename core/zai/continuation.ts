/**
 * z.ai 续跑 prompt 构建。
 *
 * 与上游 buildContinuationPrompt 的关键区别：**不重灌工具目录**。
 * 续跑是 DOM 注入让页面自己发的（captcha 墙），工具目录只需要在首条消息注入一次，
 * 续跑 prompt 保持紧凑：original_task + tool_results + 一行工具名提醒。
 *
 * ⚠️ **措辞按 agent 模式写死** —— 站点只剩 agent 模式（chat 已从页面移除），
 * 服务端沙箱是原生通路（首条消息的 `prompt.sandboxHostSection` 明确要求中间处理
 * 用沙箱工具、只有涉及用户本机时才输出本地工具 XML）。
 *
 * ⚠️⚠️ **真正的判据是「排他措辞」** —— 凡是把 XML 工具标签说成全称唯一通道的句子
 * （「**只**输出可执行 XML 工具标签」「必须**直接**输出工具 XML」），都会把沙箱通道
 * 一起否掉。所以这里的措辞必须收窄成「**本地**工具如何表达」，不能排他。
 *
 * ⚠️ **本文件不重复交代两套工具的分工** —— 「中间处理走沙箱、涉及本机才用本地工具」
 * 那条规则在 `prompt.sandboxHostSection` 里、且每轮都注入。这里再讲一遍就是两处定义
 * 同一条规则，将来必然漂移。续跑与 nudge 只需要**不否定它**。
 */

import type {
  ToolDescriptor,
  ToolDescriptorSchema,
  ToolError,
  ToolExecutionRecord,
} from '../types';
// 续跑轮识别与占位符在**零依赖**的 `continuation-marker.ts` 里 —— 页面主世界
// （历史清洗 + 气泡隐藏）也要用同一份判据，而本文件带着一条约 1.5 KB 的待办话术
// 大正则，不该被拖进主世界。这里原样转出，**既有 import 路径全部不变**。
export {
  ZAI_CONTINUATION_PLACEHOLDER,
  isZaiContinuationPlaceholder,
  isZaiContinuationPrompt,
} from './continuation-marker';

export const ZAI_INLINE_AGENT_MAX_STEPS = 25;
export const ZAI_CONTINUATION_DELAY_MS = 2_500;
export const ZAI_INLINE_AGENT_MAX_NUDGES = 8;

/**
 * 最近多少条工具结果按**完整字段**渲染；更早的压缩成有界摘要。
 *
 * 续跑每一轮都会把整个 `toolExecutions` 重新发一遍，所以不加窗口时
 * 上下文随步数**线性增长**（25 步上限下实测约 90KB，其中大头是每次调用的
 * detail 与 output）。窗口化之后稳定在常数级（约 18KB）。
 */
export const ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW = 4;

const ORIGINAL_TASK_MAX_CHARS = 8_000;
const NUDGE_PREVIOUS_TEXT_MAX_CHARS = 4_000;
const TOOL_DETAIL_MAX_CHARS = 4_000;
const TOOL_OUTPUT_MAX_CHARS = 8_000;
/**
 * `browser_snapshot` 的 detail 上限（比默认宽 6 倍）。
 *
 * ⚠️⚠️ **只有这一个工具吃宽上限，不是所有快照** —— 动作后自动补的快照
 * （`includeSnapshotAfterActions`，默认开）走的是普通 4_000。若把所有快照都放宽，
 * 「点一下看一眼」的连续动作会让最近 4 条全变成 24_000 字符，prompt 直接涨到十万字符
 * （实测：3 步全 browser 时 20_800 → 76 867 字符，+270%）。
 *
 * ⚠️ **它必须 ≤ `maxSnapshotTextBytes` 能产出的量** —— 那个预算的上界是 24_000 **字节**，
 * 中文约 8_000 字符、英文约 24_000 字符 ⇒ 24_000 字符的上限刚好装得下，
 * 不会出现「预算给了、这里又截一刀」的错配。
 *
 * ⚠️ **prompt 总长没有独立上界**（`buildZaiContinuationPrompt` 拼完之后到注入之间
 * 没有任何长度检查）。这条宽上限是**唯一**约束 `browser_snapshot` 贡献量的地方，
 * 别把它抬到 24_000 以上而不先给 prompt 加总上界。
 */
const BROWSER_SNAPSHOT_DETAIL_MAX_CHARS = 24_000;
const COMPRESSED_SUMMARY_MAX_CHARS = 400;
const TOOL_ERROR_MESSAGE_MAX_CHARS = 400;

export function buildZaiContinuationPrompt(
  originalTask: string,
  executions: readonly ToolExecutionRecord[],
  toolNames: readonly string[],
): string {
  const hasFailures = executions.some((execution) => !execution.result.ok);

  return [
    '以下是工具续跑任务刚刚执行的工具结果。请像真正的 Agent 一样，基于原始任务和这些工具结果继续推进。',
    '如果结果已经足够，请输出最终结论；只有确实需要更多信息、验证或文件修改时才继续调用工具。',
    renderContinueInstruction(),
    renderToolReminder(toolNames),
    '',
    '<original_task>',
    clamp(originalTask, ORIGINAL_TASK_MAX_CHARS),
    '</original_task>',
    // 失败恢复只在真有失败时加 —— 无条件加会让模型在一切正常时也去翻 error 字段。
    ...(hasFailures ? [renderFailureRecovery()] : []),
    '',
    '<tool_results>',
    JSON.stringify(renderWindowedToolResults(executions), null, 2),
    '</tool_results>',
  ].filter(Boolean).join('\n');
}

/**
 * 「怎么继续」那一条。
 *
 * ⚠️ **措辞必须收窄到「本地工具」** —— agent 模式还有服务端沙箱这条原生通路，
 * 排他措辞（「只输出可执行 XML 工具标签」）会把沙箱一并否掉。所以只说
 * 「**本地**工具调用必须输出 XML」，对沙箱保持沉默 —— 既不声称它存在、也不声称它不存在。
 */
function renderContinueInstruction(): string {
  const deliverables = '文件、HTML 页面与图表等交付物请直接用 Markdown 围栏代码块输出（如 ```html、```mermaid）。';
  return `不要要求用户点击继续，也不要输出伪工具调用 JSON；本地工具调用必须输出可执行 XML 工具标签。${deliverables}`;
}

/**
 * 工具名提醒。
 *
 * ⚠️ **只列名字，不重复交代两套通道的分工** —— 那条规则由每轮注入的
 * `prompt.sandboxHostSection` 负责。这里再讲一遍既是重复、又只能用排他措辞表达
 * （「只输出这些」），反而与沙箱冲突。
 */
function renderToolReminder(toolNames: readonly string[]): string {
  if (toolNames.length === 0) return '';
  return `本轮可输出的本地工具标签：${toolNames.join(', ')}`;
}

/**
 * 构建**误用纠错** nudge：上一轮把本地工具写进了 agent 原生 `tool_call`。
 *
 * 与 `buildZaiNudgePrompt` 治的不是同一件事，所以文案不共用：
 * - 那个治「**一个工具都没吐**」，要它「给出下一步调用」；
 * - 这个治「**吐了，但吐错通道**」—— 模型已经想清楚要调什么，只是格式错了，
 *   所以**不该让它重新思考**，只要它换个壳重发。
 *
 * ⚠️ **不带 `arguments`**（用户拍板）：流中断时 `delta_arguments` 是半截 JSON，
 * 喂回去是垃圾；即使完整，重发一遍那段长参数也比让它自己重写慢。
 * ⚠️ **示例由该工具真实的 `inputSchema` 生成** —— 通用占位符它未必填得对。
 * ⚠️ **不是说「服务端不认识这个工具」之外的话**：真机上服务端确实回了
 * `tool_response { status: 'error', content: 'tool call failed: <名>' }`。
 * ⚠️⚠️ **`<tool_results_so_far>` 必须无条件带上（空也要带 `[]`）** ——
 * 它是 `isZaiContinuationPrompt` 的结构判据之一（要 `<original_task>` **且**
 * `<tool_results>` 或 `<tool_results_so_far>`）。首轮误用时 `executions` 是空的，
 * 少这一段会让下一轮被判成**原生轮** ⇒ 新建一个 taskId 为 null 的循环覆盖掉它，
 * 后台任务再也收不到终态。
 * ⚠️ **`<previous_assistant_text>` 不带** —— 误用轮的 `assistantText` 恒为空
 * （`tool_call` / `tool_response` 两个相位都被挖掉），带上只是噪音。
 */
export function buildZaiMisuseNudgePrompt(
  originalTask: string,
  misusedToolName: string,
  descriptor: ToolDescriptor | undefined,
  executions: readonly ToolExecutionRecord[],
): string {
  const example = descriptor
    ? JSON.stringify(createSchemaExamplePayload(descriptor.inputSchema), null, 2)
    : '{"参数名": "参数值"}';
  return [
    `上一轮你把本地工具 ${misusedToolName} 写进了 agent 原生的 tool_call 通道。`
      + '服务端不认识这个工具，那一轮没有执行任何东西。',
    '',
    '本地工具只能通过 XML 标签调用，不能走 tool_call / tool_use / function_call 等任何原生通道。'
      + '请把要传的参数包成下面这个形状，直接输出在最终回复正文里：',
    '',
    `<${misusedToolName}>`,
    example,
    `</${misusedToolName}>`,
    '',
    '要求：',
    '- 标签名与工具名完全一致，开标签不带任何属性',
    '- 标签体只放一个 JSON 对象，前后不加文字、不加代码围栏',
    '- 不要再用 tool_call 重发',
    '- 不要解释、不要道歉，直接重发这一条',
    '',
    '<original_task>',
    clamp(originalTask, ORIGINAL_TASK_MAX_CHARS),
    '</original_task>',
    '',
    '<tool_results_so_far>',
    // 与续跑轮共用同一个渲染 —— 两处各写一份会让窗口化只在一半链路上生效。
    JSON.stringify(renderWindowedToolResults(executions), null, 2),
    '</tool_results_so_far>',
  ].join('\n');
}

/**
 * 由工具的真实 `inputSchema` 生成一份示例载荷（只列必填字段）。
 *
 * ⚠️ **与 `core/prompt/augmentation.ts` 的 `createExamplePayload` 是同一条规则的两个落点** ——
 * 那边渲染系统提示词里的工具清单、这边渲染纠错轮的示例。两处若给出不同的形状，
 * 模型会按其中一份填、而另一份才是它认定的「正确格式」。
 */
function createSchemaExamplePayload(schema: ToolDescriptorSchema): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const required = schema.required ?? Object.keys(properties);
  const payload: Record<string, unknown> = {};
  for (const key of required) {
    payload[key] = exampleValueForSchema(properties[key]);
  }
  return payload;
}

function exampleValueForSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return 'value';
  const value = schema as Record<string, unknown>;
  const type = value.type;
  if (Array.isArray(type)) return exampleValueForSchema({ ...value, type: type[0] });
  if (Array.isArray(value.enum) && value.enum.length > 0) return value.enum[0];
  switch (type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'value';
  }
}

function renderFailureRecovery(): string {
  return '至少一个工具执行失败。不要因为可恢复错误就停止；先阅读 summary/detail/error，并修正参数或改用合适的下一步继续完成任务。';
}

/**
 * 渲染工具结果：最近 {@link ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW} 条保完整字段，
 * 更早的压缩成有界摘要（丢掉 `detail` / `output` 这两个大头，`summary` 收到 400 字）。
 *
 * ⚠️ **压缩条目带 `windowed: true`** —— 让模型知道「这条是被裁过的」，而不是
 * 以为工具本来就没返回细节。
 *
 * ## ⚠️⚠️ 快照只保最新一份的正文（与窗口无关的**第二条**压缩规则）
 *
 * `browser_snapshot` 与「动作后自动补的快照」里的 uid 是 `e{序号}` ——
 * **只是「第 N 个节点」的编号，不是稳定 id**。而 `BrowserControlService` 的
 * `uidToBackendNodeId` **每次拍新快照都会 `clear()`** ⇒ 只有**最新那一份**的 uid 能用。
 *
 * 旧快照留在 prompt 里的后果不是「浪费体积」，是**误导**：实测两份快照的 `e1`
 * 分别指向「提交订单」与「下一步」，模型照旧快照的 `e1` 去点，会**静默点到另一个元素**。
 *
 * ⇒ 从最新往回数，**第一份**带快照的结果保完整正文，更早的快照一律压缩
 * （`summary` + `windowed: true`，正文丢掉）。压掉的不是「可能有用的信息」，
 * 是「已经失效、照着做会出错的旧坐标」。
 *
 * ⚠️ **这条规则与 `includeSnapshotAfterActions` 默认开启叠加后才有意义** ——
 * 默认每一次点击都会补一份快照，所以「最近 4 条」里常常有 2–4 份互相冲突的 uid。
 */
function renderWindowedToolResults(executions: readonly ToolExecutionRecord[]) {
  const windowStart = Math.max(0, executions.length - ZAI_INLINE_AGENT_FULL_TOOL_RESULT_WINDOW);
  // ⚠️ **从最新往回找第一份带快照的** —— 只有它保正文，更早的压缩。
  let newestSnapshotIndex = -1;
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    if (carriesAccessibilitySnapshot(executions[index]!)) {
      newestSnapshotIndex = index;
      break;
    }
  }

  return executions.map((execution, index) => {
    const insideWindow = index >= windowStart;
    const staleSnapshot = carriesAccessibilitySnapshot(execution) && index !== newestSnapshotIndex;
    return insideWindow && !staleSnapshot
      ? renderToolResult(execution)
      : renderCompressedToolResult(execution);
  });
}

/**
 * 这条结果里有没有一份**可寻址的页面快照**（即带 `e{序号}` uid 的那份正文）。
 *
 * 两种形态都要认：
 * - `browser_snapshot`：正文在 `detail`，`output` 是顶层元数据（`url` / `nodeCount` / …）；
 * - **动作后自动补的快照**（`withOptionalSnapshot`）：正文接在 `detail` 末尾，
 *   `output.snapshot` 是同一份元数据。
 *
 * ⚠️ **判 `output` 的形状，不判工具名** —— 判名会漏掉「`browser_click` 也带快照」
 * 这一整类（`includeSnapshotAfterActions` 默认就是开的）。
 */
function carriesAccessibilitySnapshot(execution: ToolExecutionRecord): boolean {
  const output = execution.result.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const record = output as Record<string, unknown>;
  const snapshot = record.snapshot;
  const candidate = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : record;
  return typeof candidate.nodeCount === 'number' && typeof candidate.truncated === 'boolean';
}

function renderToolResult(execution: ToolExecutionRecord) {
  return {
    tool: execution.name,
    provider: execution.provider?.displayName,
    ok: execution.result.ok,
    // ⚠️ **`summary` 也要有上界** —— 本地工具的 summary 都是我们自己生成的固定串
    //（`Captured N accessibility nodes` 之类），但 MCP 那条路径的 summary 来自服务端。
    // 与压缩档同口径（400），否则「压缩了一条很长的 summary」这件事本身就不成立。
    summary: clamp(execution.result.summary, COMPRESSED_SUMMARY_MAX_CHARS),
    // ⚠️ **`browser_snapshot` 单独一档** —— 它是模型主动要的整页快照，4_000 字符只够
    // 看一屏的十分之一；而动作后自动补的快照（默认开）仍走 4_000，否则连续点击会把
    // 最近 4 条全撑成 24_000 字符。判据见 `BROWSER_SNAPSHOT_DETAIL_MAX_CHARS` 的说明。
    detail: clamp(
      execution.result.detail,
      execution.name === 'browser_snapshot'
        ? BROWSER_SNAPSHOT_DETAIL_MAX_CHARS
        : TOOL_DETAIL_MAX_CHARS,
    ),
    // ⚠️ **失败原因必须给全** —— 只给 `ok: false` 时模型看不到错误码与可重试性，
    // 只能瞎猜参数，往往直接放弃。`details` 刻意丢掉（可能很大，且不是判据）。
    error: boundToolError(execution.result.error),
    output: clamp(
      execution.result.output === undefined
        ? undefined
        : JSON.stringify(execution.result.output),
      TOOL_OUTPUT_MAX_CHARS,
    ),
    truncated: execution.result.truncated === true,
  };
}

function renderCompressedToolResult(execution: ToolExecutionRecord) {
  return {
    tool: execution.name,
    provider: execution.provider?.displayName,
    ok: execution.result.ok,
    summary: clamp(execution.result.summary, COMPRESSED_SUMMARY_MAX_CHARS),
    error: boundToolError(execution.result.error),
    windowed: true,
    truncated: execution.result.truncated === true,
  };
}

function boundToolError(error: ToolError | undefined): ToolError | undefined {
  if (!error) return undefined;
  return {
    code: error.code,
    message: clamp(error.message, TOOL_ERROR_MESSAGE_MAX_CHARS) ?? '',
    retryable: error.retryable,
  };
}

function clamp(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return value;
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

/**
 * shouldNudge：判断模型是否「还有待办」。
 *
 * 判定模型回复末尾是否还有「接下来我要做 X」这类未完成的动作承诺：
 *  - 有 `<task_complete>` 信号 → 明确结束，不 nudge。
 *  - 文本为空 → 需要 nudge。
 *  - 末尾有「待办话术」且后面没有跟渲染产物 → 需要 nudge。
 *
 * ## 为什么按「主语」分三级
 *
 * 一条正则把「接下来」这类**无主语引导词**与「我将…」一视同仁时，会把建议当成待办：
 * 任务完成时模型常写「报告已生成。**接下来你可以**打开它查看。」——
 * 主语是**用户**、是建议、不是待办，却照样命中 ⇒ 弹 nudge。
 *
 * ⇒ 拆成三级，**方向是「宁可多 nudge，不可漏 nudge」**（漏判 = 任务提前收尾，
 * 代价远高于多跑一轮）：
 *
 * | 级别 | 形态 | 处理 |
 * |---|---|---|
 * | 强（有主语） | `我 + 情态词 + 动词` | **无条件 nudge** |
 * | 强（无主语） | `马上 / 再试一次 / 还需要 + 动词` | **无条件 nudge**，排除被动与已发生 |
 * | 弱 | `接下来 / 下一步 / 然后 + 动词` | 命中处附近有「给用户的建议」语气才放过 |
 *
 * ⚠️ **强信号不给任何附加条件** —— 它们是漏判风险最高的形态，加条件就是把
 * 「提前收尾」的风险换回来。
 */
const ZAI_ACTION_VERBS = '调用|创建|编辑|检查|验证|生成|保存|尝试|搜索|获取|打开|执行|查看|访问|读取|抓取|下载|上传|修改|更新|删除|写入|分析|比对|比较|监控|查询|发送|提交|安装|启动|停止|清理|转换|解析|提取|汇总|整理|核对|核实|扫描|截屏|渲染|处理|运行|部署|构建|测试|编译|打包';

/** 英文动词表 —— 与中文表**分开**：两者的分词形态完全不同，合并只会更难读。 */
const ZAI_ACTION_VERBS_EN = 'call|create|edit|inspect|validate|generate|save|try|search|fetch|open|run|browse|read|check|look|use|verify|test|download|write|update|review|analyze|extract|query|send|post|investigate|monitor|compare|install|start|stop|convert|parse|list|collect|request|retry|scroll|click|type|navigate';

/**
 * 「已经发生」的动词后缀 —— 动词后紧跟这些字就不是待办，是汇报。
 *
 * ⚠️ 只看**紧跟**（中间不能插字）：「我读取了文件」是汇报，「我将读取文件」是待办。
 *
 * ⚠️⚠️ **`到` / `后` 刻意不在名单里** —— 它们是**目的补语**与**顺序连接词**，
 * 大量出现在尚未发生的句子里：「我将把报告保存**到**桌面」「我会下载**到**本地」
 * 「我将修改**后**通知你」。把它们当过去时标记会让这些真待办全部漏判（方向与本模块
 * 「宁可多 nudge」的原则相反）。
 *
 * ⚠️ **`完` / `好` / `成` / `毕` 只在句末才算完成态** —— 它们既可能是「我创建好了」（汇报），
 * 也可能是「我将整理**好**数据」（待办，后面还有宾语）。判据是紧跟其后的字符：
 * 只有紧跟标点或文本结束时才算过去时。
 *
 * ⚠️ **`后` 单独出现不算过去时，但「…后…了」是** —— 「我将修改**后**通知你」是待办
 * （「后」是顺序连接词），而「我继续分析**后**得出了结论」是汇报（后面紧跟「了」）。
 * ⇒ 判据是「`后` 之后 20 字内出现 `了`」——把「顺序 + 完成」这一对形态一起认掉。
 */
const ZAI_PAST_MARKER = '(?!了|过|(?:完|好|成|毕)(?=[，。；！？、\\s]|$)|后(?=[^。！？]{0,20}了))';

/** 情态 / 意图词：出现在「我」之后，表明这是一个**尚未发生**的打算。 */
const ZAI_INTENT_MODALS = '将|会|想|要|先|让|再|直接|现在|这就|马上|立刻|立即|继续|尝试|开始|需要|还需要|仍需|还要|打算|计划|准备|随后|稍后|先去|先来|接下来';

/**
 * 三条待办正则里的「中间隔多少字」窗口 —— **必须能跨行**。
 *
 * ⚠️⚠️ **`.{0,N}` 不匹配换行**，而模型把待办承诺写成多行是最常见的形态之一
 * （分点 / 编号列表 / 冒号后换行）：
 *
 * ```
 * 任务完成。
 *
 * 接下来我会：
 * - 读取配置文件
 * - 生成报告
 * ```
 *
 * 用 `.{0,48}` 时上面这段**整条漏判** ⇒ `shouldNudgeZai` 返回 false ⇒ 循环按
 * 「任务已完成」收尾，而模型其实承诺了还要继续。方向与本模块声明的
 * 「宁可多 nudge，不可漏 nudge（漏判 = 任务提前收尾）」正好相反。
 *
 * ⚠️ **`[\s\S]` 是唯一正确的写法** —— 它匹配任意字符（含换行），且不需要 `s` flag
 * （`s` flag 会让同一份正则在老环境里失效，而这里是模板串拼出来的）。
 * ⚠️ **窗口宽度不变**（48 / 64 / 24）：换行只多占 1 个字符，不需要为它放大窗口。
 * ⚠️ **尾部闸门 `ZAI_PENDING_ACTION_AFTER_MAX_CHARS` 不受影响** —— 它判的是
 * 「命中之后还剩多少字」，与窗口能否跨行无关；多行列表实测未被它挡掉。
 * ⚠️ **上游 `prompt.ts` 的 `PENDING_ACTION_RE` 逐字用的是 `.{0,48}`** ⇒ 这个缺陷上游也有。
 * 判据不是「上游也这么写」，而是「判据方向与声明的方向一致」。
 */
const ZAI_PENDING_GAP_48 = '[\\s\\S]{0,48}';
const ZAI_PENDING_GAP_64 = '[\\s\\S]{0,64}';
const ZAI_PENDING_GAP_24 = '[\\s\\S]{0,24}';

/** 强信号（有主语）：`我 + 情态词 + … + 动词`。主语必然是模型 ⇒ 无条件 nudge。 */
const ZAI_PENDING_STRONG_RE = new RegExp(
  // 中文第一人称承诺。
  `我(?:${ZAI_INTENT_MODALS})${ZAI_PENDING_GAP_48}(?:${ZAI_ACTION_VERBS})${ZAI_PAST_MARKER}`
  // 「让我 / 先让我」：主语同样只能是模型。
  + `|(?:让我|先让我)${ZAI_PENDING_GAP_48}(?:${ZAI_ACTION_VERBS})${ZAI_PAST_MARKER}`
  // 「为 / 帮你做 X」：动作是模型做的，第二人称只是受益者。
  + `|(?:(?:现在|这就|马上|随后|稍后|立即|立刻|先|直接))?(?:为|帮)(?:你|您)(?:创建|生成|制作|输出|编写|绘制|渲染)(?!了|好|完|成|过|的)`
  // 英文第一人称承诺（与中文同义，不合并成一条正则 —— 动词表完全不同）。
  + `|(?:i(?:'ll| will|'m| am|'d| would| want to| should| have to| (?:still\\s+)?need to|'m going to| am going to|'m about to| am about to|'ve got to| have got to)|let me|let's|next,? (?:i|we)|we(?:'ll| will| need to| can)|(?:my|the) next step is to)${ZAI_PENDING_GAP_64}(?:${ZAI_ACTION_VERBS_EN})`,
  'gi',
);

/**
 * 强信号（无主语但语气明确）：`马上 / 再试一次 / 还需要 + 动词`。
 *
 * ⚠️⚠️ **`接下来` / `下一步` / `然后` / `现在` / `随后` / `稍后` 刻意不在这一支里** ——
 * 它们同样大量出现在**给用户的建议**中（「接下来**你**可以打开它查看」「现在**你**可以下载」）。
 * 它们归 `ZAI_PENDING_WEAK_RE` 管，由那里按上下文（±12 字内有没有「你/您/可以/建议」）判断。
 * ⇒ **本支只留「语气明确指向模型自己」的引导词**：马上 / 立刻 / 立即 / 这就 / 再试 / 还需要 / 仍需 / 还要 / 继续。
 * ⚠️ 早前把这些词放在本支（strong）里，靠的是「同 index 时 `WEAK` 后插入、稳定排序排在最后」
 * 这个**巧合**才判对；一旦重排 `collect` 或换排序实现就会静默翻转。
 */
const ZAI_PENDING_IMPERSONAL_RE = new RegExp(
  `(?:马上|立刻|立即|这就|再试(?:一次)?|还需要|仍需|还要|继续)${ZAI_PENDING_GAP_24}(?:${ZAI_ACTION_VERBS})${ZAI_PAST_MARKER}`,
  'gi',
);

/** 弱信号：`接下来 / 下一步 / 然后 / 现在 / 随后 / 稍后 + 动词`，可能只是在给用户建议。 */
const ZAI_PENDING_WEAK_RE = new RegExp(
  `(?:接下来|下一步|然后|现在|随后|稍后)${ZAI_PENDING_GAP_48}(?:${ZAI_ACTION_VERBS})${ZAI_PAST_MARKER}`,
  'gi',
);

/**
 * 「这是在给用户建议」的判据 —— **看引导词后面紧跟什么**，不是看窗口里有没有「你」。
 *
 * ⚠️⚠️ **为什么不能用「窗口里有 你/您/可以 就算建议」**：那些字大量出现在**宾语/定语**位置
 * ——「接下来读取**你给的**链接」「接下来把结果推送到**你可以访问的**地址」「然后检查**你提供的**那几个文件」。
 * 这些都是**模型自己要做的事**，按窗口判会被整体放过（真机方向是「该 nudge 却判不 nudge」）。
 *
 * ⇒ 判据改成：**引导词（接下来/下一步/然后/现在/随后/稍后）之后紧跟「你 / 您 / 请」** 才算建议 ——
 * 那才是「主语是用户」的直接形态（「接下来**你**可以打开」「接下来**请**查看」）。
 * 引导词后面紧跟动词或「把/再/将」时，主语是模型自己 ⇒ 待办。
 */
const ZAI_ADVICE_LEAD_RE = /(?:接下来|下一步|然后|现在|随后|稍后)[，,、\s]*[你您请]/;

/** 弱信号判断的上下文窗口：命中片段前后各取这么多字。 */
const ZAI_ADVICE_WINDOW_CHARS = 12;

// ⚠️ **捕获组两侧不能加 `\s*`** —— `<task_complete>\s*([\s\S]*?)\s*<\/task_complete>`
// 会在「开标签后跟连续空白、且无配对闭合标签」时灾难性回溯（`\s*` 与 `[\s\S]*?\s*`
// 量词重叠；实测 4,000 空白 6.4s / 8,000 空白 >20s）。输入是 `complete.assistantText`
// 全文，来自桥消息、没有长度上限。去掉这两个 `\s*` 后是近线性（100 万空白 0.1ms）。
// 对 `.test()` 的布尔结果**完全等价**（穷举 8.7 万条 + 随机 30 万条零差异），
// 因为这里只用 `.test()`、不取捕获组，且无 `g` flag。守卫见
// `tests/zai-nudge-task-complete-redos.test.ts`。
const ZAI_TASK_COMPLETE_RE = /<task_complete>([\s\S]*?)<\/task_complete>/;
const ZAI_NUDGE_DECISION_TAIL_MAX_CHARS = 600;
const ZAI_PENDING_ACTION_AFTER_MAX_CHARS = 80;

export function shouldNudgeZai(
  originalTask: string,
  executions: readonly ToolExecutionRecord[],
  visibleText: string,
): boolean {
  void originalTask;
  void executions;
  if (ZAI_TASK_COMPLETE_RE.test(visibleText)) return false;
  if (!visibleText) return true;
  return hasPendingActionAtTail(getNudgeDecisionText(visibleText));
}

function getNudgeDecisionText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ZAI_NUDGE_DECISION_TAIL_MAX_CHARS
    ? trimmed.slice(-ZAI_NUDGE_DECISION_TAIL_MAX_CHARS)
    : trimmed;
}

interface ZaiPendingHit {
  index: number;
  length: number;
  /** 强信号 = 主语明确是模型，不看上下文直接判待办。 */
  strong: boolean;
}

function collectPendingHits(text: string): ZaiPendingHit[] {
  const hits: ZaiPendingHit[] = [];
  const collect = (pattern: RegExp, strong: boolean, skip?: (matched: string) => boolean) => {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      if (skip?.(match[0])) continue;
      hits.push({ index: match.index, length: match[0].length, strong });
    }
  };
  collect(ZAI_PENDING_STRONG_RE, true);
  // 无主语强信号：排除被动 / 已发生（「随后数据被写入文件」「现在已经拿到了结果」）。
  collect(ZAI_PENDING_IMPERSONAL_RE, true, (matched) => /被|已经/.test(matched));
  // 弱信号：被动式同样不是模型的待办（「随后数据被写入文件」）。
  collect(ZAI_PENDING_WEAK_RE, false, (matched) => /被/.test(matched));
  return hits.sort((a, b) => a.index - b.index);
}

/** 命中之后还有大段内容（或渲染产物）⇒ 不像「空承诺」，不 nudge（原有语义）。 */
function passesTailGate(text: string, hit: ZaiPendingHit): boolean {
  const afterPendingAction = text.slice(hit.index + hit.length).trim();
  if (afterPendingAction.length > ZAI_PENDING_ACTION_AFTER_MAX_CHARS) return false;
  if (afterPendingAction.includes('```')) return false;
  return true;
}

function isAdviceAt(text: string, hit: ZaiPendingHit): boolean {
  const windowStart = Math.max(0, hit.index - ZAI_ADVICE_WINDOW_CHARS);
  const windowEnd = Math.min(text.length, hit.index + hit.length + ZAI_ADVICE_WINDOW_CHARS);
  return ZAI_ADVICE_LEAD_RE.test(text.slice(windowStart, windowEnd));
}

/**
 * 末尾是否还有「待办话术」。
 *
 * ⚠️⚠️ **强信号优先，不是「只看最后一条命中」** —— 早前取 `hits[hits.length - 1]` 直接判定，
 * 于是「我将生成报告。**接下来你可以**下载它。」这种「强在前、弱建议在后」的句子会被
 * 最后那条弱信号（带建议标记）整体否掉 ⇒ **前面的强信号被丢弃**，与「强信号无条件 nudge」矛盾。
 * ⇒ 先在强信号里找一条通过尾部闸门的，有就 `true`；只有全部强信号都不通过时，
 * 才退回「最后一条弱信号 + 建议窗口」。
 *
 * ⚠️ 方向是**宁可多 nudge**：强信号只要通过尾部闸门就判待办，不看上下文。
 */
function hasPendingActionAtTail(text: string): boolean {
  const hits = collectPendingHits(text);
  if (hits.length === 0) return false;

  // ① 强信号优先：任意一条通过尾部闸门 ⇒ 判待办。
  //    取**最后一条**通过的（与旧实现「以最后一次承诺为准」的口径一致）。
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const hit = hits[i]!;
    if (hit.strong && passesTailGate(text, hit)) return true;
  }

  // ② 没有可用的强信号 ⇒ 退回最后一条命中，按建议窗口判断。
  const last = hits[hits.length - 1]!;
  if (!passesTailGate(text, last)) return false;
  // 弱信号：命中处附近若在给用户建议（「接下来**你**可以打开它查看」），不算待办。
  return !isAdviceAt(text, last);
}

/**
 * 构建 nudge prompt：上一轮没输出可执行工具 XML，提醒模型「任务没完成就继续给调用」。
 *
 * ⚠️ **不声称「观察到服务端沙箱工具调用」** —— 我们从来不观察它（`shouldNudgeZai`
 * 里 `executions` 是 `void` 的，`assistantText` 也只含答案相位）。旧文案写
 * 「也没有观察到服务端沙箱工具的调用」是**与事实相反**的断言，模型刚调过沙箱工具时
 * 会读到一句假话。现在只陈述能确认的那一半：**没有输出本地工具 XML**。
 *
 * ⚠️ **不给「任务已完成」指定信号** —— 旧文案要求输出 `<task_complete>`，
 * 但提示词从没教过模型这个约定（i18n 资源里零命中），而且与「忽略这条提示」冲突。
 * 现在只让模型**忽略**：完成与否由它自己判断，不引入第二套完成语义。
 */
export function buildZaiNudgePrompt(
  originalTask: string,
  previousText: string,
  executions: readonly ToolExecutionRecord[],
  nudgeCount: number,
  toolNames: readonly string[] = [],
): string {
  return [
    '上一轮回复没有输出可执行的本地工具 XML。如果任务尚未完成，请给出下一步可执行调用；如果任务已经完成，忽略这条提示。',
    '请根据原始任务和工具结果二选一：',
    '1. 如果任务仍未完成，本轮必须给出下一步的可执行调用：本地工具输出可执行 XML 工具标签，服务端沙箱工具直接调用（无需 XML）。',
    '2. 如果任务已经完成，直接给出最终结论；文件、HTML 页面与图表等交付物用 Markdown 围栏代码块输出（如 ```html、```mermaid）。',
    `这是第 ${nudgeCount} 次无工具调用纠偏。`,
    renderToolReminder(toolNames),
    '',
    '<original_task>',
    clamp(originalTask, ORIGINAL_TASK_MAX_CHARS),
    '</original_task>',
    '',
    '<previous_assistant_text>',
    clamp(previousText, NUDGE_PREVIOUS_TEXT_MAX_CHARS),
    '</previous_assistant_text>',
    '',
    '<tool_results_so_far>',
    // 与续跑轮共用同一个渲染 —— 两处各写一份会让窗口化只在一半链路上生效。
    JSON.stringify(renderWindowedToolResults(executions), null, 2),
    '</tool_results_so_far>',
  ].filter(Boolean).join('\n');
}