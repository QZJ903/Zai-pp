/**
 * 「这份结果是不是已经落库了」—— 决定卡片上还给不给动作按钮。
 *
 * ⚠️ **判据是「库里有没有」，不是「这一页点过没有」**：按「点过」判的话，
 * 刷新一次按钮又回来了（而东西其实早就在库里），用户会再点一次 ——
 * Skill 那次会覆盖同名自定义 Skill，记忆那次只是白跑一趟。
 *
 * ⚠️ **纯函数、无 IO**：调用方把「库的当前快照」传进来。这样它既能被直接测，
 * 又不依赖内容脚本那层模块状态。
 */

import type { Skill } from '../types';
import { memoryDedupeKey } from '../memory/dedupe';

/**
 * 这份 Skill 草稿是否已在技能库里。
 *
 * 判据是**名字 + 指令正文**都相同：
 * - 只看名字 ⇒ 「同名但改过正文的草稿」被判成已保存，用户再也存不进去；
 * - 只看正文 ⇒ 改名后的草稿被判成已保存。
 *
 * ⚠️ **只比 `custom` 来源** —— 内置 / 远程 Skill 不是「这份草稿存下来的」，
 * 同名不算数（草稿存进去会新建一条自定义 Skill）。
 */
export function isSkillDraftSaved(draft: Skill, skills: readonly Skill[]): boolean {
  const instructions = draft.instructions.trim();
  return skills.some((skill) => (
    skill.source === 'custom'
    && skill.name === draft.name
    && skill.instructions.trim() === instructions
  ));
}

/**
 * 这批记忆草稿是否**全部**已在记忆库里。
 *
 * ⚠️ **判「全部」而不是「任意一条」**：部分导入过时仍要给出按钮 ——
 * 再点一次只会跳过重复项、把剩下的补进去。
 * ⚠️ **一条可比对的内容都没有时判「未导入」**（宁可多给一个按钮）。
 */
export function areMemoriesImported(
  drafts: readonly unknown[],
  memories: readonly { content: string }[],
): boolean {
  const keys = drafts
    .map(readMemoryContent)
    .filter((content): content is string => content !== null)
    .map((content) => memoryDedupeKey(content))
    .filter(Boolean);
  if (keys.length === 0) return false;
  const existing = new Set(memories.map((memory) => memoryDedupeKey(memory.content)));
  return keys.every((key) => existing.has(key));
}

function readMemoryContent(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const content = (value as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
}
