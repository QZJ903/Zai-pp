import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { basename, join, normalize, posix, resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const distDir = join(rootDir, 'dist');
const browserArgIndex = process.argv.indexOf('--browser');
const requestedBrowsers = browserArgIndex >= 0
  ? [process.argv[browserArgIndex + 1]]
  : ['chrome', 'edge'];

if (requestedBrowsers.some((browser) => !browser)) {
  throw new Error('Usage: sidepanel-chunk-budget.mjs [--browser chrome|edge]');
}

// Chrome baseline for the sidepanel initial shell, captured with WXT 0.20.26.
// The initial shell is the sidepanel entry script plus every static preloaded
// module. The budget below is the measured value plus a fixed encoder-variance
// allowance for gzip, so the guardrail stays meaningful without being brittle
// across zlib releases.
const BASELINE = Object.freeze({
  // ⚠️ **重新测量过一次**（2.15.12）：`prompt.sandboxHostSection` 两套语言合计
  // 增加约 8.8KB 原始字节，而这段资源经由 `core/i18n/index.ts` 进了侧边栏初始 shell
  // （侧边栏只用到它的类型与几个键，但资源是整个 section 一起打包的）。
  // 这是**有意增长**，不是意外膨胀 —— 再改这段提示词要连带重测这里。
  //
  // ⚠️ **2026-10-03 再测（2.15.19）**：`tool.web.*` 新增一个键
  // （`fetchByteLimitedDetail`，两套语言）后实测 raw 341907 / gzip 106255。
  // ⚠️ **这一档的 gzip 余量本来就很紧**（预算 = 基线 + 256）—— 本次实测已贴到
  // 只剩 23 字节，所以才把基线同步过来。**往 `tool` 段加键就会动这里**，
  // 因为整份 `tool` section 都进侧边栏初始 shell（同 `prompt.sandboxHostSection` 那条）。
  //
  // ⚠️⚠️ **2026-10-03 三测（2.15.21）**：自动化失败的**错误码 → 文案**映射
  // （`automationPage.error.*`，中英各 **24 键**）进 `sidepanel` 段，
  // 实测 raw 346096 / gzip 107600 —— **一次 +4189 raw / +1345 gzip**，
  // 是本文件历史上单次涨幅最大的一次（比 2.15.12 的提示词那次还大）。
  // **判据**：`core/i18n/resources/*/sidepanel.ts` 是**整份**进初始 shell 的，
  // 所以**往任何一段加键都会全文计入** —— 加文案前先想一下值不值。
  // ⚠️⚠️ **2026-10-07 四测（零引用 i18n 键清理）**：删掉 **45 个零引用键**
  // （`tool.artifact.*` 14 + `tool.sandbox.*` 12 + `sidepanel.toolsPage.*` 权限面板 10
  // + `sidepanel` 其余 7 + `common.retry` + `content.permission.webFetch`，中英各一份），
  // 实测 raw 338044 / gzip 105470 —— **raw −8052 / gzip −2130**。
  // ⚠️ **这是本文件历史上单次降幅最大的一次**，与 2.15.21 那次加 24 键的涨幅同源：
  // 两个 section 都是**整份**进初始 shell。
  // **教训**：基线长期偏大时门禁是「靠实测比基线小」蒙过去的（2.15.16→2.15.19 差了 378 字节），
  // 所以**降了也要回写**，不能只满足于「门禁还绿」。
  // ⚠️⚠️ **2026-10-11 五测（输入框斜杠命令补全）**：新增 `content.skillPopup.hint`
  // （中英各 1 键）后实测 raw 338219 / gzip 105546 —— **+175 raw / +76 gzip**。
  // ⚠️ 只加了 2 个键、涨幅却接近「加 1 键 ≈ +276 raw」的量级：**因为整份 `content`
  // section 都进初始 shell**（同上面那几条注释），键本身只占其中一小部分，
  // 剩下的是 content 段重排后压缩率的变化。
  // **涨了也要回写**（同下面那条教训），不能只满足于「门禁还绿」。
  // ⚠️⚠️ **2026-10-11 六测（工具调用面板）**：`content.toolBlock` 加极简
  // `title` + `summaries.{running,executed,failed,incomplete}`（中英各 5 键）后
  // 实测 raw 338580 / gzip 105644 —— **+361 raw / +98 gzip**。
  // **同源的又一条例证**：只加 5 对键、raw 涨 361，正是因为**整份 `content` section
  // 都进初始 shell**，键本身只占小头，剩下的是段内重排后压缩率的变化。
  // ⚠️⚠️ **2026-10-15 七测（双站适配）**：把 `background.missingGLM` 文案里的
  // `chat.z.ai` 换成 `Zai`（中英各 1 键，两站都成立）后实测
  // raw 338568 / gzip 105635 —— **−12 raw / −9 gzip**。
  // ⚠️ 涨跌幅度远小于「1 键 ≈ 276 raw」的量级，因为这次**没增删键**，
  // 只是两处值的字符数变了（域名字符串变短）。**降了也要回写**（同下面那条教训）。
  // ⚠️⚠️ **2026-10-20 八测（删除扩展自带的联网搜索）**：删掉 `sidepanel.toolsPage`
  // 的 web 开关与诊断搜索共 11 对键（中英各一份）后实测 raw 330535 / gzip 103253
  // —— **−8033 raw / −2382 gzip**。涨幅量级与「删 45 键 → −8052 raw」一致，
  // 说明这里是键数本身在起作用（`sidepanel` 段整份进初始 shell）。
  // ⚠️⚠️ **2026-10-20 九测（自动化并入工具页）**：删掉 `capabilitiesPage.tabs.automation`
  // （中英各 1 键）后实测 raw 330479 / gzip 103241 —— **−56 raw / −12 gzip**。
  // ⚠️⚠️ **2026-10-20 十测（删工具页 + 自动化回归能力页）**：删掉整个 `toolsPage` i18n 段
  // （中英各 24 键，含 web 那批与 python 那批）后实测 raw 327153 / gzip 102570
  // —— **−3326 raw / −671 gzip**。
  // ⚠️ **2026-10-20 十一测**：加 `sidepanel.mcpPage.shellSetup.listSeparator`
  // （中英各 1 键）后实测 raw 327195 / gzip 102595 —— **+42 raw / +25 gzip**。
  // ⚠️⚠️ **2026-10-21 十二测（MCP 页工具卡片改人话）**：新增
  // `sidepanel.mcpPage.detail.toolInfo`（12 个 Shell 工具各一组 label/summary
  // + 三条风险徽章文案，中英各 27 键），并删掉零引用的 `schemaNone` /
  // `schemaSummary` / `schemaRequired`（中英各 3 键）后，实测 raw **331733** /
  // gzip **103777** —— **+4538 raw / +1182 gzip**。
  // ⚠️ 涨幅来自键数本身（`sidepanel` 段整份进初始 shell，同上面几条），
  // 净增 48 对键 —— 与「1 键 ≈ 276 raw」的量级对得上。
  // ⚠️ **同日十三测（续跑「未确认发出」那条文案改措辞）**：把「请重试」改成
  // 「请先检查对话内容，再决定是否重试」（中英各 1 键的值变长）后实测
  // raw **331837** / gzip **103806** —— **+104 raw / +29 gzip**。
  // 只改值不增删键，涨幅远小于「1 键 ≈ 276 raw」，符合上面第七条注释的规律。
  // ⚠️ **同日十四测（MCP 页状态四档与空状态文案改中文）**：`status.{ready,error,disabled,unknown}`
  // 与 `detail.noTools`（中英各 5 键，只改值不增删键）后实测
  // raw **331993** / gzip **103994** —— **+156 raw / +188 gzip**。
  // ⚠️ **gzip 涨幅大于 raw** —— 与 2026-10-07 那条同源：中文 UTF-8 占 3 字节但压得更狠，
  // 反过来英文（`ready` → `Connected`）字符变多、raw 略涨而 gzip 涨得更多。
  // ⚠️ **同日十五测（首发导览文案）**：`whatsNew` 段副标题改功能定位、
  // 条目由 3 条改 6 条（删 `browserControlBoundary` / `sidepanelFeedback`，
  // 新增 `memory` / `skill` / `mcp` / `automation` / `project`，中英各净增 3 键）后
  // 实测 raw **332879** / gzip **103981** —— **+886 raw / −13 gzip**。
  // ⚠️ **gzip 反而降了** —— 中文条目压得更狠，同上面第七条注释的规律。
  // ⚠️ **同日十六测（系统提示词重构：两套工具改按通道区分）**：`sandboxHostSection`
  // 加判定表 + 口诀，删掉 `systemChat` 里重复的「关键：本地工具调用的确切格式」整段
  // 与全部包装格式负例清单后，实测 raw **331040** / gzip **103652**
  // —— **−1839 raw / −329 gzip**。
  // ⚠️ **2.15.56 实测**：`common.operationFailedWithCode` +1 键、`sidepanel.browserControlPage.messages.zaiTabBlocked`
  // +1 键（中英各一份），`BrowserControlPage` 新增对 `core/zai/contracts` 的静态 import
  // ⇒ 初始 shell 实测 raw **331527** / gzip **103943**（+487 raw / +291 gzip）。
  // 同批 `runtime-response.ts` 让产物从 43 文件涨到 **45**（两个同名 chunk 互相 import，
  // 共享模块被提成独立 chunk，属「entrypoint 数量决定切分」那类）。
  //
  // ⚠️ **同日十七测（`## 角色` 改占位符 + 新增联网 / 定时任务两节）**：
  // ① `systemChat` 的角色正文抽成 `prompt.defaultRole`（中英各 +1 键，值就是原正文）；
  // ② `sandboxHostSection` 原生工具清单加 `WebSearch` / `WebFetch` / `cron`，
  //    「三、联网搜索」整段重写（原生工具 vs skill 两条路），新增「四、定时任务」一节。
  // 实测 raw **340419** / gzip **107013** —— **+8892 raw / +3070 gzip**。
  // ⚠️ **这是单次涨幅最大的一档**，且两段都是**每轮注入**的提示词：
  // 加内容前先问「这句值不值每轮都付」。
  //
  // ⚠️ **删掉「项目」功能后实测 raw 334010 / gzip 105575** —— **−6409 raw / −1438 gzip**。
  // 来源：`content.projectPanel.*` 21 键 + `sidepanel.projectsPage.*` 28 键（中英各一份）
  // 与 `prompt.projectContext*` 3 键全部移除，侧边栏项目页 chunk 也不再进初始 shell。
  //
  // ⚠️⚠️ **2026-10-31 十八测（四批修复收口到 2.15.62）**：实测
  // raw **335812** / gzip **106170** —— **+1802 raw / +595 gzip**。
  // 来源是**净增 5 对键**（新增 11、删掉 6，中英各一份），且其中两条值本身较长：
  // `nameTaken`（技能名判重）、`keepaliveDescription`（保活开关的用户说明）。
  // 其余 9 条是失败分档：`recordMissing` / `memoryTruncated` / `invalidContentTooLong`
  // / `scheduleTooSparse` / `pageHandshakeTimeout` / `pageContentScriptMissing`
  // / `generalDescription` / `keepaliveSectionDescription` / `aboutTagline`。
  // ⚠️ **这 11 条没有一条是装饰性文案** —— 它们各自对应一条新加的失败分档或用户开关说明，
  // 删掉就会退回到「静默失败」或「界面没说清」。所以这是**有意增长**，回写基线。
  // ⚠️ 量级核对：净增 5 键 × 约 276 raw ≈ 1380，实测 1802，多出的 ~420 来自长句值。
  // ⚠️⚠️ **2026-11-03 八测（自动化链修复的三条失败文案）**：`sidepanel` 段新增
  // `automationNotFound` / `automationAlreadyRunning` / `automationInvalidStatus`
  // （中英各 3 键），实测 raw **336356** / gzip **106254** —— **+544 raw / +84 gzip**。
  // ⚠️ **这三条是 `5da43a4` 加的，而那一批当时没构建** ⇒ 门禁从那次起就是红的
  // （336356 > 335812+512），一直到本版才发现。**不是本版改动带来的**：
  // 本版构建与 `6b0df13` 干净构建的实测值逐字节相同（都是 336356）。
  // ⚠️ 三条文案各自对应一条新加的失败分档，删掉会退回「静默失败」⇒ **有意增长，回写基线**。
  //
  // ⚠️⚠️ **2026-11-07 重测**：实测 raw **342463** / gzip **107921**。
  // 这一版涨得比以往任何一次都多，来源分两批，**都不是意外膨胀**：
  // ① **侧边栏外壳与共享 UI 那批**（新增 `errorBoundary.*` 两条 + 若干设置页文案，
  //    以及 `RouteErrorBoundary` 组件本身进了初始 shell）—— 单独构建实测 341826 / 107733；
  // ② **MCP 与 Skill 配置页那批**（+637 raw / +188 gzip）：`skill.form` 三档校验提示、
  //    `skillPage.listSeparator`、`mcpPage.validation.timeoutOutOfRange`，
  //    以及 `capability-settings` 的四个边界常量随 `McpPage` 进包。
  // ⚠️ **①的那 341826 是上一批加的、当时没构建** ⇒ 门禁从那次起就红着（同 5da43a4 那次）。
  // 判据：每一条新键都对应一处「界面原先什么都没说」或「说了假话」，删了就退回去。
  //
  // ⚠️⚠️ **2026-11-08 重测**：实测 raw **343_645** / gzip **108_189**（chrome 与 edge 同值）。
  // 增量 +1182 raw / +268 gzip，来源两批，逐提交构建对照过：
  // ① **侧边栏其余五页那批**（`db6dc3a`）：单独构建实测 343_585 / 108_169 —— +1122 raw / +247 gzip。
  //    新增键为 `preset.form.requiredFields`、`memoryPage.importEntryInvalid`、
  //    `usage.tokensUnit` / `usage.tokenCount`、`browserControl.{loadFailed,saveFailed,enableFailed,detachFailed}`
  //    （`targetFailed` 改带 `{error}`），以及 `automation.field.prompt`。
  // ② **跨模块复核那批**（`fb1b810`）：+60 raw / +20 gzip，只有文案微调、无新增键。
  // ⚠️ **①是当时没构建的那一批** ⇒ 门禁从 `db6dc3a` 起就红着（同 `5da43a4` 那次）。
  // 判据同前：每条新键都对应一处「界面原先什么都没说」或「说了假话」，删了就退回去。
  initialShell: { raw: 343_645, gzip: 108_189 },
  // ⚠️⚠️ **本字段只作回显，不参与任何断言** —— 门禁比对的是 `BUDGET.routeChunks`
  // （下面那份**手工定的允差**，与这里的数值没有派生关系），而 `BUDGET.initialShell`
  // 才是从 `BASELINE.initialShell` 派生出来的。两组常量的关系是**反的**，
  // 别看着输出里 `baseline.routeChunks` 与 `current.routeChunks` 并排就以为它们在比。
  // 这里保留的是**早先实测过的参考值**（条目比 `BUDGET` 少、且早已不是当前值）；
  // 要不要改成与 initialShell 一致的「基线 + 小余量」，是另一个议题 ——
  // 那会把路由块的门禁从「20 倍余量」收紧到「涨几百字节就红」，属设计决策。
  routeChunks: {
    CapabilitiesPage: { raw: 1_568, gzip: 669 },
    SettingsPage: { raw: 2_118, gzip: 855 },
    LibraryPage: { raw: 1_270, gzip: 636 },
    MemoryPage: { raw: 4_485, gzip: 1_840 },
    SavedPage: { raw: 7_862, gzip: 2_765 },
  },
});

// gzip size may vary slightly between supported Node/zlib releases even when
// the built JavaScript bytes are identical. Keep the raw baseline exact and
// bound this encoder-only variance to a small fixed allowance.
const GZIP_ENCODER_VARIANCE_BYTES = 256;

// ⚠️ `initialShell` 的 raw 也是**实测精确值**，但它的主要成分是提示词资源
// （`core/i18n` 整份 section 都进初始 shell），改一句提示词就会动它。
// 留一点固定余量，免得每次微调文案都要重测这两个数字。
const INITIAL_SHELL_RAW_ALLOWANCE_BYTES = 512;

const BUDGET = Object.freeze({
  initialShell: {
    raw: BASELINE.initialShell.raw + INITIAL_SHELL_RAW_ALLOWANCE_BYTES,
    gzip: BASELINE.initialShell.gzip + GZIP_ENCODER_VARIANCE_BYTES,
  },
  routeChunks: {
    LibraryPage: { raw: 2_500, gzip: 1_200 },
    // ⚠️ **删掉「项目」功能后 `MemoryForm` 被内联进 MemoryPage** —— 它原来被
    // MemoryPage 与 ProjectsPage 两个 chunk 共享，Rollup 因此把它提成独立 chunk
    // （`MemoryPage 4545 + MemoryForm 5361`）；ProjectsPage 没了之后只剩一个消费者，
    // 合并成单文件 9642 / 3061。**总字节是降的**（9906 / 3628 → 9642 / 3061），
    // 与「entrypoint 数量决定切分」那条同源。预算按新的单文件实测抬到 10_500 / 3_500。
    MemoryPage: { raw: 10_500, gzip: 3_500 },
    SavedPage: { raw: 10_000, gzip: 4_000 },
    CapabilitiesPage: { raw: 5_000, gzip: 2_000 },
    SkillPage: { raw: 60_000, gzip: 13_000 },
    // ⚠️ **2.15.52：`mcp-tools-controller` 从独立 chunk 并进了 McpPage** —— 它原来
    // 被 McpPage 与已删除的 ToolsPage 共用，工具页没了之后只剩一个消费者，
    // Rollup 就把它内联了（与「entrypoint 数量决定切分」那条同源）。
    // ⇒ **总字节没有涨**：旧产物 `McpPage 39632 + controller 15343 = 54975`，
    // 现在 McpPage 单文件 54922。预算按新的单文件实测抬到 56_000 / 14_500。
    // ⚠️ **2026-10-21 抬到 60_000 / 15_000** —— 工具卡片改人话（工具说明 12 组
    // + 风险徽章三档）后实测 raw 57501 / gzip 14119，原预算 56000 差 1501 字节。
    // 这是**真实增长**（不是合并），来源是 `classifyAugmentRequest` 那套判定
    // 与 12 个工具的中文说明进了同一个 chunk。抬预算时留了 ~2500 / ~880 余量。
    // ⚠️ **2026-11-07 抬到 63_000 / 15_500** —— 实测 raw 60444 / gzip 14886，原预算 60000 差 444 字节。
    // 增量来源全是**这一轮的功能**，不是意外膨胀：`SET_MCP_TOOL_SELECTION` 的调用点、
    // 按服务取历史（`getServerHistory` + 独立的 `refreshHistory` + 切换选中只刷历史）、
    // 三个 ms 字段的上界校验与那句「必须在 {min}–{max} 之间」的文案。
    // ⚠️ gzip 只涨了 186、余量本来就紧（15000 只差 114），所以两档一起抬。
    McpPage: { raw: 63_000, gzip: 15_500 },
    BrowserControlPage: { raw: 10_000, gzip: 4_000 },
    // 自动化仍是能力页的一个 tab，独立懒加载 chunk。
    AutomationPage: { raw: 35_000, gzip: 10_000 },
    SettingsPage: { raw: 45_000, gzip: 14_000 },
    // The background-image section moved from AppearanceSubPage into General,
    // so General's budget absorbs the former Appearance allowance
    // (5_000 + 8_000 raw, 2_500 + 3_500 gzip) plus headroom.
    GeneralSubPage: { raw: 18_000, gzip: 7_500 },
    // Presets moved from the capability tabs into settings, so its former
    // standalone chunk budget moves with it.
    PresetSubPage: { raw: 14_000, gzip: 5_000 },
    PromptSubPage: { raw: 14_000, gzip: 5_000 },
    UsageSubPage: { raw: 12_000, gzip: 5_000 },
    DataSubPage: { raw: 14_000, gzip: 5_500 },
    AboutSubPage: { raw: 3_000, gzip: 1_500 },
  },
});

for (const browser of requestedBrowsers) {
  verifyBrowserBuild(browser);
}

function verifyBrowserBuild(browser) {
  const buildDir = join(distDir, `${browser}-mv3`);
  if (!existsSync(buildDir)) {
    throw new Error(`Missing ${browser} build at ${buildDir}. Run the browser build first.`);
  }

  const initialFiles = readInitialModuleFiles(buildDir);
  const initialGraph = collectStaticModuleGraph(buildDir, initialFiles);
  const initialMetric = measureFiles(buildDir, initialGraph);
  assertBudget(browser, 'initial shell', initialMetric, BUDGET.initialShell);

  const routeMetrics = {};
  for (const [chunkName, budget] of Object.entries(BUDGET.routeChunks)) {
    const chunkPath = findNamedChunk(buildDir, chunkName);
    const metric = measureFiles(buildDir, [chunkPath]);
    routeMetrics[chunkName] = metric;
    assertBudget(browser, `${chunkName} chunk`, metric, budget);
  }

  console.log(JSON.stringify({
    browser,
    baseline: BASELINE,
    gzipEncoderVarianceBytes: GZIP_ENCODER_VARIANCE_BYTES,
    current: {
      initialShell: initialMetric,
      routeChunks: routeMetrics,
    },
  }, null, 2));
}

function readInitialModuleFiles(buildDir) {
  const html = readFileSync(join(buildDir, 'sidepanel.html'), 'utf8');
  const files = new Set();
  for (const match of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+\.js)"/g)) {
    files.add(match[1].replace(/^\//, ''));
  }
  if (files.size === 0) throw new Error('sidepanel.html does not reference a JavaScript entry.');
  return [...files];
}

function collectStaticModuleGraph(buildDir, entryFiles) {
  const pending = [...entryFiles];
  const files = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || files.has(file)) continue;
    const absolutePath = join(buildDir, file);
    if (!existsSync(absolutePath)) {
      throw new Error(`Missing Side Panel module ${file}.`);
    }
    files.add(file);
    const source = readFileSync(absolutePath, 'utf8');
    for (const match of source.matchAll(/\bimport(?:[^"'()]*?from)?["']([^"']+)["']/g)) {
      if (!match[1].startsWith('.')) continue;
      const imported = posix.normalize(posix.join(posix.dirname(file), match[1]));
      pending.push(imported);
    }
  }
  return [...files];
}

function findNamedChunk(buildDir, name) {
  const chunksDir = join(buildDir, 'chunks');
  const matches = readdirSync(chunksDir)
    .filter((file) => file.startsWith(`${name}-`) && file.endsWith('.js'));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${name} chunk in ${chunksDir}, found ${matches.length}.`);
  }
  return normalize(join('chunks', matches[0])).replaceAll('\\', '/');
}

function measureFiles(buildDir, files) {
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const content = readFileSync(join(buildDir, file));
    raw += content.byteLength;
    gzip += gzipSync(content, { level: 9 }).byteLength;
  }
  return { raw, gzip, files: [...files].map((file) => basename(file)).sort() };
}

function assertBudget(browser, label, actual, budget) {
  if (actual.raw > budget.raw || actual.gzip > budget.gzip) {
    throw new Error(
      `${browser} ${label} exceeds budget: raw ${actual.raw}/${budget.raw}, `
      + `gzip ${actual.gzip}/${budget.gzip}.`,
    );
  }
}
