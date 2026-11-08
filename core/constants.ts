/**
 * 记忆注入的 token 预算 —— **整块上限，所有被选中的记忆共享**（不是每条）。
 *
 * ⚠️⚠️ **必须与 `MEMORY_CONTENT_MAX_CHARS` 一起算** —— 这两个数单独看都合理，
 * 配错了就会出现「存得下、看不见」：
 *
 * - 一条满上限的中文记忆占 `字符数 × 0.6 + 行壳` ≈ **1207 token**（`MEMORY_CONTENT_MAX_CHARS = 2000`）；
 * - 预算 3000 ⇒ 一条满长记忆装得下、还能再放一条，或换成九条 300 字的普通记忆。
 *
 * ⚠️ 旧组合是 8000 字 + 1500 预算 ⇒ 一条满长记忆要 4807 token，是预算的 **3.2 倍**
 * ⇒ 「排第一那条自己就超预算」成了**常态**而不是兜底，它会被截到 31%，且因
 * `selectMemories` 的 `break` 语义，后面的记忆一条都进不来。
 * ⇒ **改任一个数都要重算另一个**，判据见 `tests/memory-selector.test.ts` 的
 * 「一条满上限的记忆自己就装得下」那条。
 */
export const MEMORY_TOKEN_BUDGET = 3000;

/**
 * 单条记忆正文的字符上限。
 *
 * ⚠️ **与 `core/memory/importer.ts` 的导入截断同值** —— 导入、模型保存、表单手填
 * 四条写入路径必须用同一个上限，否则「导入能进来、保存被拒」这种不一致会出现。
 * ⚠️ **改它必须同时看 `MEMORY_TOKEN_BUDGET`**，理由见那个常量的说明。
 */
export const MEMORY_CONTENT_MAX_CHARS = 2000;

export const PRESET_REINJECTION_INTERVAL = 10;

/**
 * 一条用量记录的消息条数 —— **恒为 2（一问一答）是本项目的既定口径**，
 * 不是「读不到时的兜底」。
 *
 * ⚠️⚠️ **三处必须同值**，任何一处单独改都会让「总消息数」与「总轮数」不一致：
 * ① 发送侧 `entrypoints/zai.content.ts` 的 `RECORD_USAGE_TURN` 载荷；
 * ② 收侧 `core/usage/input-codec.ts` 的 `normalizePositiveInteger(value, …)`；
 * ③ 读回 `core/usage/codec.ts` 的 `value.messageCount === undefined ? … : …`。
 *
 * ⚠️ 曾试过「续跑轮记 1」，**自动化下没生效**、已回滚 —— 别按「更准确」的直觉改。
 * 守卫见 `tests/usage-message-count.test.ts`。
 */
export const USAGE_MESSAGE_COUNT = 2;

export const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '他', '她', '它', '们', '那', '里', '之', '中', '与', '而', '为',
  '以', '及', '等', '被', '把', '让', '给', '从', '向', '对', '但', '如果', '因为',
  '所以', '虽然', '可以', '能', '想', '知道', '时候', '没', '什么', '怎么', '这个',
  '那个', '还', '过', '吗', '呢', '吧', '啊', '嗯', '哦', '呀', '啦', '使用',
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his',
  'by', 'from', 'they', 'we', 'she', 'or', 'an', 'will', 'my', 'one', 'all',
  'would', 'there', 'their', 'what', 'so', 'up', 'out', 'if', 'about', 'who',
  'get', 'which', 'go', 'me', 'when', 'make', 'can', 'like', 'no', 'just',
  'him', 'know', 'take', 'into', 'your', 'some', 'could', 'them', 'than',
  'other', 'been', 'has', 'its', 'use', 'two', 'how', 'our', 'way',
]);

export const SKILL_TRIGGER_REGEX = /^\/(\S+)\s*([\s\S]*)$/;