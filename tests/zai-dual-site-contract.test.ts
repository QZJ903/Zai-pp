import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ZAI_DEFAULT_SITE_ID,
  ZAI_HOME_URL,
  ZAI_SITES,
  ZAI_TAB_URL_PATTERN,
  ZAI_TAB_URL_PATTERNS,
  ZAI_WEB_ORIGIN,
  ZAI_WEB_ORIGINS,
  isZaiSiteOrigin,
  resolveZaiSiteOrigin,
} from '../core/zai/contracts';

/**
 * 双站适配的**边界守卫**。
 *
 * 这个项目支持两个站点（国区站 `zchat.z.ai` 与国际站 `chat.z.ai`，跑同一份前端产物）。
 * 下面每一组断言守的都是「那一处漏了会静默失效」—— 不是风格偏好，是**失败不可见**：
 * 少声明一个站不会报错，只会让那一站的某条链整块不工作，而且看起来跟「功能就是这样」没区别。
 */

/** 相对仓库根解析文件路径。 */
const file = (path: string) => resolve(process.cwd(), path);
const read = (path: string) => readFileSync(file(path), 'utf8');

describe('site table: the two sites stay in sync with everything derived from it', () => {
  it('keeps the convenience constants derived from the default site, not hand-written', () => {
    // ⚠️ 这三个常量是**默认站**的投影。它们与服务端行为无关，只是「没有页面上下文时
    // 该去哪一站」的兜底 ⇒ 必须与站点表同源，不能各写一遍字面量。
    const defaultSite = ZAI_SITES[ZAI_DEFAULT_SITE_ID];
    expect(ZAI_WEB_ORIGIN).toBe(defaultSite.origin);
    expect(ZAI_HOME_URL).toBe(defaultSite.homeUrl);
    expect(ZAI_TAB_URL_PATTERN).toBe(defaultSite.tabUrlPattern);
  });

  it('lists every site origin and tab pattern exactly once', () => {
    const tableOrigins = Object.values(ZAI_SITES).map((site) => site.origin);
    const tablePatterns = Object.values(ZAI_SITES).map((site) => site.tabUrlPattern);
    expect([...ZAI_WEB_ORIGINS].sort()).toEqual([...tableOrigins].sort());
    expect([...ZAI_TAB_URL_PATTERNS].sort()).toEqual([...tablePatterns].sort());
    // 重复项的后果是「广播发两次 / 标签页查两遍」，虽然无害但说明表写坏了。
    expect(new Set(ZAI_WEB_ORIGINS).size).toBe(ZAI_WEB_ORIGINS.length);
    expect(new Set(ZAI_TAB_URL_PATTERNS).size).toBe(ZAI_TAB_URL_PATTERNS.length);
  });

  it('derives each tab pattern from its own site origin', () => {
    // 手抄 pattern 时最容易出的错是「两个站共用同一个 pattern」（复制粘贴没改），
    // 表现是**其中一站永远查不到标签页**。这条从 origin 反推把两者钉在一起。
    for (const site of Object.values(ZAI_SITES)) {
      expect(site.tabUrlPattern).toBe(`*://${new URL(site.origin).host}/*`);
      expect(new URL(site.homeUrl).origin).toBe(site.origin);
    }
  });

  it('never matches by suffix', () => {
    // ⚠️⚠️ **这是安全判据，不是风格偏好** —— 站点自己就有 `zcode.z.ai` 之类的同域子站。
    // 放宽到后缀匹配等于把信任范围从一个站放大到一个域。
    for (const stranger of [
      'https://zcode.z.ai',
      'https://z.ai',
      'https://sub.chat.z.ai',
      'https://chat.z.ai.evil.test',
      'https://zchat.z.ai.evil.test',
      'https://space-z.ai',
      'https://evil.test/?next=https://chat.z.ai',
    ]) {
      expect(isZaiSiteOrigin(stranger), `${stranger} 不该被认成站点`).toBe(false);
      expect(resolveZaiSiteOrigin(stranger)).toBeNull();
    }
  });
});

/**
 * manifest 侧的两份**手抄清单**。
 *
 * ⚠️ 这两处引不到 TS 常量（`matches` 是 manifest 阶段的字面量、`wxt.config.ts` 在
 * 构建期执行），所以只能靠源码扫描守着「它们与站点表一致」。扫描理由：漏改一处的
 * 后果是那一站的**内容脚本完全不注入**（页面看着正常，但所有功能都没有反应）。
 */
describe('manifest declarations cover every site', () => {
  const entrypoints = ['entrypoints/zai.content.ts', 'entrypoints/zai-main-world.content.ts'];

  it.each(entrypoints)('%s declares a content script match for every site', (path) => {
    const source = read(path);
    const match = /matches:\s*\[([^\]]*)\]/.exec(source);
    expect(match, `${path} 应当有 matches 声明`).not.toBeNull();
    const declared = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...declared].sort()).toEqual([...ZAI_TAB_URL_PATTERNS].sort());
  });

  it('wxt.config.ts declares every site in host_permissions', () => {
    const source = read('wxt.config.ts');
    const block = /host_permissions:\s*\[([\s\S]*?)\]/.exec(source);
    expect(block, 'wxt.config.ts 应当有 host_permissions').not.toBeNull();
    const declared = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    for (const pattern of ZAI_TAB_URL_PATTERNS) {
      expect(declared, `host_permissions 缺少 ${pattern}`).toContain(pattern);
    }
  });

  it('the manifest policy check expects exactly the same host permissions', () => {
    // ⚠️ 这份是 `assertSetEqual` 的**集合相等**判据 ⇒ 少一个 / 多一个都红。
    // 它与 `wxt.config.ts` 是两份独立字面量，只能两处同改。
    const source = read('scripts/manifest-policy-check.mjs');
    const block = /expectedHostPermissions\s*=\s*\[([\s\S]*?)\]/.exec(source);
    expect(block, 'manifest-policy-check.mjs 应当有 expectedHostPermissions').not.toBeNull();
    const declared = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    for (const pattern of ZAI_TAB_URL_PATTERNS) {
      expect(declared, `expectedHostPermissions 缺少 ${pattern}`).toContain(pattern);
    }
  });
});

/**
 * 「没有页面上下文」的那几条链路必须**显式**选站。
 *
 * ⚠️ 判据是「不许吃 `ZAI_WEB_ORIGIN` 的默认值」而不是「必须写某个站」——
 * 默认值是**默认站**（国区站），在国际站上用它拼出来的链接会把用户带到另一个站
 * （那个站既没有这条会话、token 也不通用）。这几处都必须把站点作为参数/依赖传进来。
 */
describe('site-less call sites thread the site explicitly', () => {
  it('the model catalog takes the site origin from its dependencies', () => {
    const source = read('core/zai/models.ts');
    expect(source, '抓取器应当要求注入 resolveOrigin').toContain('resolveOrigin');
    expect(
      source.includes('dependencies.fetchImpl(`${ZAI_WEB_ORIGIN}'),
      '抓取器不该再直接拼接 ZAI_WEB_ORIGIN',
    ).toBe(false);
  });

  it('the model catalog origin follows the active site, not the default one', () => {
    const source = read('entrypoints/background.ts');
    expect(source, '后台的抓取器应当跟随最近活跃站').toContain('resolveOrigin: () => readActiveZaiSiteOrigin()');
  });

  it('the background trust policy accepts both sites', () => {
    const source = read('entrypoints/background.ts');
    // ⚠️ 判据写成**整行形态**而不是「函数体里含某个词」—— 后者的正则要跨过返回类型
    // 那段花括号，很容易把类型体当成函数体（第一版就是这么假红的）。
    // 少了 additionalWebOrigins，另一站的内容脚本发来的消息会被整块拒绝
    // （表现：项目面板、工具执行、自动化回传全部静默失效）。
    expect(
      source,
      '信任策略必须带上另一站',
    ).toContain('additionalWebOrigins: ZAI_WEB_ORIGINS');
  });

  it('tab broadcasts reach both sites', () => {
    const source = read('entrypoints/background.ts');
    // 只发默认站会让另一站的页面收不到状态更新（改了记忆 / 技能 / 背景要刷新才生效）。
    expect(source, '广播必须带上 additionalTabUrlPatterns').toContain('additionalTabUrlPatterns');
  });

  it('the automation session record carries its own site', () => {
    // ⚠️ 站点是**这条记录自己的属性**（「它上次跑在哪一站」），不能从「用户此刻在看哪一站」
    // 推 —— 那会让一条跑在 A 站的记录，在用户切到 B 站之后被拼成 B 站的链接。
    const types = read('core/automation/types.ts');
    expect(types).toContain('siteOrigin');
    const codec = read('core/automation/storage-codec.ts');
    // 兼容缺省：旧记录没有这个字段 ⇒ 必须 `defaultedNullableString`（写成必填会让
    // 所有旧记录判 corrupt、**整份自动化存储打不开**）。
    const occurrences = codec.match(/defaultedNullableString\(value\.siteOrigin/g) ?? [];
    expect(occurrences.length, '会话 / run 请求 / run 结果三处都要兼容缺省').toBeGreaterThanOrEqual(3);
  });

  it('the coordinator resolves the site before picking a tab, and reports it back', () => {
    const source = read('core/zai/dom-task-coordinator.ts');
    // 输出侧：结果要带站点（下游全靠它拼链接）。
    // ⚠️ 判据按**行**找、不按「整块类型」找 —— `DomTaskOutcome` 里的对象字面量类型
    // 会先碰到 `};`，正则很容易提前截断（第一版就是这么假红的）。
    const okArm = source.slice(source.indexOf('export type DomTaskOutcome'));
    expect(okArm, '应当有 DomTaskOutcome').not.toBe('');
    expect(
      /siteOrigin: DomTaskSiteOrigin;/.test(okArm),
      '成功分支要带站点',
    ).toBe(true);
    expect(
      /siteOrigin\?: DomTaskSiteOrigin \| null;/.test(okArm),
      '失败分支也要带站点（可为 null = 还没挑中标签页）',
    ).toBe(true);
    // 输入侧：协调器要知道这条任务上次跑在哪一站。
    expect(source).toContain('siteOrigin?: string | null;');
    // 两个站都要查（只查默认站会让另一站的空闲标签页永远找不到）。
    expect(source).toContain('ZAI_TAB_URL_PATTERNS');
  });
});

/**
 * 剩下的裸 hostname 字面量。
 *
 * ⚠️ 这一组是**反向**的：它断言生产代码里**不再有**绕过站点表的 hostname 判据。
 * 历史上 `background.ts` 有两处 `hostname === 'chat.z.ai'`，它们会让国区站的会话页
 * 永远不被认出来，而**没有任何报错**。
 */
describe('no host-literal judgements outside the site table', () => {
  const productionFiles = [
    'entrypoints/background.ts',
    'core/zai/request-codec.ts',
    'core/zai/fetch-hook.ts',
    'core/zai/chat-session.ts',
    'core/zai/dom-task-coordinator.ts',
    'core/zai/models.ts',
  ];

  it.each(productionFiles)('%s does not compare against a bare z.ai hostname', (path) => {
    const source = read(path);
    const withoutComments = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(
      /hostname\s*===\s*['"]/.test(withoutComments),
      `${path} 不该用 hostname 字面量判站（应当用 isZaiSiteOrigin）`,
    ).toBe(false);
  });

  it('keeps the site table as the only place that spells out the origins', () => {
    // 只允许 `contracts.ts` 出现裸 origin 字面量（i18n 文案不算生产判据）。
    const contracts = read('core/zai/contracts.ts');
    for (const origin of ZAI_WEB_ORIGINS) {
      expect(contracts, `站点表应当写着 ${origin}`).toContain(origin);
    }
  });
});