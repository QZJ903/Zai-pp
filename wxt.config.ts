import { defineConfig, type ConfigEnv, type UserManifest } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import pyodidePackagePolicy from './scripts/pyodide-package-policy.json';

const rootDir = dirname(fileURLToPath(import.meta.url));
const safeWxtBrowser = resolve(rootDir, 'core/browser/safe-wxt-browser.ts');
const CHROMIUM_BROWSERS = new Set(['chrome', 'edge']);
const extensionVersion = readPackageVersion();
const MANIFEST_NAME = '__MSG_extension_name__';
const MANIFEST_DESCRIPTION = '__MSG_extension_description__';
const MANIFEST_ACTION_TITLE = '__MSG_extension_action_title__';
const SANDBOX_CSP = [
  'sandbox allow-scripts',
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  'worker-src blob:',
  "child-src 'self' blob: data:",
  "frame-src 'self' blob: data:",
  "connect-src 'self' blob:",
  // img-src / style-src are pinned so sandboxed HTML cannot use remote
  // images or CSS url() as network beacons (M13); media-src / font-src are
  // pinned for the same reason (video/audio/@font-face are the remaining
  // fetch-directive beacon vectors without a default-src). Local and inline
  // content (data:/blob: URLs, inline styles) remains supported.
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "media-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "object-src 'none'",
].join('; ');
const PYODIDE_ASSET_FILES = pyodidePackagePolicy.assets.map(({ file }) => file);

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(resolve(rootDir, 'package.json'), 'utf8'),
  ) as { version?: unknown };

  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('package.json version is required for extension manifest');
  }

  return packageJson.version;
}

export function createManifest(env: ConfigEnv): UserManifest {
  const isChromiumTarget = CHROMIUM_BROWSERS.has(env.browser);
  const basePermissions = ['storage', 'alarms', 'nativeMessaging'];
  const chromiumPermissions = [...basePermissions, 'offscreen', 'debugger', 'tabs'];

  return {
    default_locale: 'en',
    name: MANIFEST_NAME,
    description: MANIFEST_DESCRIPTION,
    version: extensionVersion,
    permissions: isChromiumTarget
      ? [...chromiumPermissions, 'sidePanel']
      : basePermissions,
    host_permissions: [
      // Bing: web_search 依赖。
      '*://cn.bing.com/*',
      '*://www.bing.com/*',
      // GLM++ (z.ai) host.
      '*://chat.z.ai/*',
      // web_fetch 抓任意站点、MCP 自配端点、GitHub skill 导入都要跨源访问。
      // 声明成必需权限（而非 optional_host_permissions）以省掉运行时授权步骤 ——
      // 此前实测在开发者模式下扩展本就已获得「所有网站」访问权，声明成必需
      // 只是把这件事实写明，安装时用户即可看到权限范围。
      'http://*/*',
      'https://*/*',
    ],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
      sandbox: SANDBOX_CSP,
    },
    sandbox: {
      pages: ['sandbox-runner.html'],
    },
    // web_accessible_resources is intentionally omitted:
    // only that feature needed sidepanel.html exposed to every page for iframe
    // embedding. The side panel now opens solely through the chrome.sidePanel API,
    // so no page-accessible resources are required.
    ...(isChromiumTarget ? {
      action: {
        default_title: MANIFEST_ACTION_TITLE,
      },
      side_panel: {
        default_path: 'sidepanel.html',
      },
    } : {}),
  };
}

function asciiJavaScriptOutputPlugin(): Plugin {
  return {
    name: 'glm-pp-ascii-js-output',
    enforce: 'post',
    generateBundle(_, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') {
          item.code = escapeNonAsciiJavaScript(item.code);
          continue;
        }

        if (!item.fileName.endsWith('.js')) continue;
        const source = typeof item.source === 'string'
          ? item.source
          : Buffer.from(item.source).toString('utf8');
        item.source = escapeNonAsciiJavaScript(source);
      }
    },
  };
}

function copyPyodideAssets(
  outputDir: string,
  publicAssets: Array<{ type: 'asset'; fileName: string }>,
): void {
  const sourceDir = resolve(rootDir, 'node_modules/pyodide');
  const targetDir = resolve(outputDir, 'pyodide');
  mkdirSync(targetDir, { recursive: true });

  for (const file of PYODIDE_ASSET_FILES) {
    const fileName = `pyodide/${file}`;
    copyFileSync(resolve(sourceDir, file), resolve(outputDir, fileName));
    publicAssets.push({ type: 'asset', fileName });
  }
}

function escapeNonAsciiJavaScript(source: string): string {
  let escaped = '';
  for (const char of source) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x7f) {
      escaped += char;
      continue;
    }
    escaped += codePoint <= 0xffff
      ? `\\u${codePoint.toString(16).padStart(4, '0')}`
      : toSurrogatePairEscape(codePoint);
  }
  return escaped;
}

function toSurrogatePairEscape(codePoint: number): string {
  const value = codePoint - 0x10000;
  const high = 0xd800 + (value >> 10);
  const low = 0xdc00 + (value & 0x3ff);
  return `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
}

export default defineConfig({
  outDir: 'dist',
  targetBrowsers: ['chrome', 'edge'],
  modules: ['@wxt-dev/module-react'],
  manifest: createManifest,
  hooks: {
    'build:done'(wxt, output) {
      copyPyodideAssets(wxt.config.outDir, output.publicAssets);
    },
  },
  vite: () => ({
    plugins: [tailwindcss(), asciiJavaScriptOutputPlugin()],
    build: {
      modulePreload: {
        // Extension pages load every chunk from the local extension file
        // store; modulepreload links carry no latency benefit and Chromium
        // logs "cross-world extension resource mismatch" / "preloaded but
        // not used" noise for them. The module graph still loads normally
        // through the entry script's static imports.
        resolveDependencies: () => [],
      },
    },
    resolve: {
      alias: {
        '@wxt-dev/browser': safeWxtBrowser,
        'wxt/browser': safeWxtBrowser,
      },
    },
  }),
});
