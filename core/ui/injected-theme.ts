/**
 * 注入到 z.ai 页面的 UI 主题变量（`--dpp-ui-*`）。
 *
 * 与侧边栏共用同一套冷调墨色（`--ds-*`，见 `entrypoints/sidepanel/style.css`），
 * 让注入的卡片和面板看起来是同一个产品，而不是外挂的中性灰块。层级靠描边与
 * 内高光表达，不靠发光。
 *
 * ⚠️ **深浅两套色板都要有** —— 侧边栏永远浅色，但 z.ai 页面本身有深色模式
 * （标记是 `html` 上的 `light` / `dark` 类），卡片挂在页面里必须跟着走。
 * 主题切换由 `syncInjectedTheme()` 写 `body.dpp-theme-dark` / `dpp-theme-light`。
 */

const STYLE_ID = 'dpp-injected-theme-css';

/** 侧边栏浅色与深色变量块之间需要保持同步的调色对应关系（改一处要改两处）。 */
const LIGHT_VARS = `
  --dpp-ui-surface:      oklch(0.998 0.002 264);
  --dpp-ui-surface-muted: oklch(0.965 0.005 264);
  --dpp-ui-surface-hover: oklch(0.95 0.006 264);
  --dpp-ui-text:         oklch(0.24 0.018 264);
  --dpp-ui-text-muted:   oklch(0.52 0.020 264);
  --dpp-ui-text-subtle:  oklch(0.70 0.015 264);
  --dpp-ui-border:       oklch(0.90 0.008 264);
  --dpp-ui-border-muted: oklch(0.94 0.006 264);
  --dpp-ui-accent:       oklch(0.62 0.19 264);
  --dpp-ui-accent-strong: oklch(0.56 0.20 266);
  --dpp-ui-accent-soft:  oklch(0.96 0.025 264);
  --dpp-ui-accent-panel: oklch(0.62 0.19 264 / 0.06);
  --dpp-ui-code-bg:      oklch(0.30 0.02 264 / 0.06);
  --dpp-ui-danger-panel: oklch(0.64 0.22 25 / 0.08);
  --dpp-ui-success:      oklch(0.70 0.15 162);
  --dpp-ui-warning:      oklch(0.75 0.15 75);
  --dpp-ui-error:        oklch(0.64 0.22 25);
  --dpp-ui-shadow:       0 0 0 1px var(--dpp-ui-border), inset 0 1px 0 oklch(1 0 0 / 0.05);
`;

const DARK_VARS = `
  --dpp-ui-surface:      oklch(0.22 0.014 264);
  --dpp-ui-surface-muted: oklch(0.25 0.014 264);
  --dpp-ui-surface-hover: oklch(0.29 0.015 264);
  --dpp-ui-text:         oklch(0.93 0.012 264);
  --dpp-ui-text-muted:   oklch(0.76 0.015 264);
  --dpp-ui-text-subtle:  oklch(0.60 0.015 264);
  --dpp-ui-border:       oklch(0.32 0.014 264);
  --dpp-ui-border-muted: oklch(0.28 0.014 264);
  --dpp-ui-accent:       oklch(0.75 0.14 264);
  --dpp-ui-accent-strong: oklch(0.82 0.12 264);
  --dpp-ui-accent-soft:  oklch(0.30 0.06 264 / 0.55);
  --dpp-ui-accent-panel: oklch(0.75 0.14 264 / 0.12);
  --dpp-ui-code-bg:      oklch(1 0 0 / 0.08);
  --dpp-ui-danger-panel: oklch(0.30 0.06 25 / 0.22);
  --dpp-ui-success:      oklch(0.78 0.14 162);
  --dpp-ui-warning:      oklch(0.80 0.14 75);
  --dpp-ui-error:        oklch(0.72 0.18 25);
  --dpp-ui-shadow:       0 0 0 1px var(--dpp-ui-border), inset 0 1px 0 oklch(1 0 0 / 0.04);
`;

export function injectInjectedThemeStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
body {
${LIGHT_VARS}}

body.dpp-theme-dark {
${DARK_VARS}}

@media (prefers-color-scheme: dark) {
  body:not(.dpp-theme-light) {
${DARK_VARS.replace(/^ {2}/gm, '    ')}}
}
`;
  document.head.appendChild(style);
}

/**
 * 把 z.ai 页面的当前主题投影成 `body` 上的 `dpp-theme-*` 类。
 *
 * 页面用 `html` 的 `light` / `dark` 类表达主题（Tailwind class 策略），
 * 注入的 UI 在 `body` 上，所以要搬一层。
 *
 * ⚠️⚠️ **两个类都不在时必须把我们的类也摘掉**，不能「保持现状」——
 * 此时应当由 `prefers-color-scheme` 那条媒体查询决定，而它只在**没有** `dpp-theme-*`
 * 类时才生效（`body.dpp-theme-dark` 与媒体查询里的 `body:not(.dpp-theme-light)`
 * 特异度相同、后者在样式表后面，所以旧类留着会盖住兜底）。
 * 「页面深色 → 跟随系统且系统浅色」正好走这条路：页面移除 `dark` 而不加 `light`。
 */
export function syncInjectedTheme(): void {
  const root = document.documentElement;
  if (!root) return;
  const body = document.body;
  if (!body) return;
  if (root.classList.contains('dark')) {
    body.classList.add('dpp-theme-dark');
    body.classList.remove('dpp-theme-light');
    return;
  }
  if (root.classList.contains('light')) {
    body.classList.add('dpp-theme-light');
    body.classList.remove('dpp-theme-dark');
    return;
  }
  // 页面没表态 → 交回给媒体查询（先摘掉我们的类，否则它盖住兜底）。
  body.classList.remove('dpp-theme-dark', 'dpp-theme-light');
}
