/**
 * Skill 名的 slug 化 —— **唯一实现**。
 *
 * 归一规则：去首尾空白 → 小写 → 非 `[a-z0-9-]` 一律换成 `-` → 连续 `-` 合并 → 去掉首尾 `-`。
 *
 * ⚠️ **归一后为空（中文标题、纯符号等）的处置由调用方决定，本函数只返回空串** ——
 * 各调用点的策略本来就不同：侧边栏表单静默不提交、注册表拒绝写入、
 * 导入器改用 hash 派生的 slug。把这些策略塞进来只会让其中几处拿到不想要的行为。
 *
 * ⚠️ **为什么必须共用**：这个规则同时决定「写进存储的名字」与「界面上判重时用的名字」。
 * 两处各写一遍，会出现「表单说没重名、注册表说重名」——而两边都不报错。
 */
export function slugifySkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * slug 为空（中文标题、纯符号）时的**兜底名字**，两条导入链共用。
 *
 * ⚠️ **为什么要共用**：本地导入器原本自己写了一份 `shortHash`，GitHub 侧则直接抛
 * 「缺少有效名称」。同一个问题两种处置 —— 前者能导入、后者整份源导入失败。
 * 各写一份 hash 迟早分叉（同一份 SKILL.md 走两条链得出两个名字）。
 *
 * ⚠️ **兜底目标是「先能导入」**：用户可以在 Skills 页改名，而不是被一个名字卡住。
 */
export function hashedSkillSlug(name: string): string {
  return `skill-${shortHash(name || 'unnamed')}`;
}

/** 只在进程内稳定即可（同一名字 → 同一 slug），不需要跨版本一致。 */
function shortHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8).padStart(2, '0');
}

/**
 * 导入路径用的名字归一：能派 slug 就用，派不出（中文标题、纯符号）就用 hash 兜底。
 *
 * ⚠️ 与上面的 `slugifySkillName` **策略不同**，所以是两个函数：表单与注册表在
 * 「派不出 slug」时要**拒绝**（让用户改），而导入器要**先导进来**（用户事后再改）。
 * 两条导入链共用这一份，避免同一条 SKILL.md 走不同链得到两个名字。
 */
export function requireSkillSlug(name: string): string {
  return slugifySkillName(name) || hashedSkillSlug(name);
}