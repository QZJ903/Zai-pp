#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const failures = [];
const packageJson = readJson('package.json');

const targets = [
  {
    browser: 'chrome',
    manifestPath: 'dist/chrome-mv3/manifest.json',
    permissions: ['storage', 'alarms', 'nativeMessaging', 'debugger', 'tabs', 'sidePanel'],
  },
  {
    browser: 'edge',
    manifestPath: 'dist/edge-mv3/manifest.json',
    permissions: ['storage', 'alarms', 'nativeMessaging', 'debugger', 'tabs', 'sidePanel'],
  },
];

const expectedHostPermissions = [
  // ⚠️ **两站都要声明**（与 `wxt.config.ts` 的 host_permissions 逐字对齐）——
  // 这是一份手抄清单，少一个下面 `assertSetEqual` 立刻红。
  '*://zchat.z.ai/*',
  '*://chat.z.ai/*',
  '*://cn.bing.com/*',
  '*://www.bing.com/*',
  'http://*/*',
  'https://*/*',
];
const expectedLocalizedManifest = {
  default_locale: 'en',
  name: '__MSG_extension_name__',
  description: '__MSG_extension_description__',
  actionTitle: '__MSG_extension_action_title__',
};
const expectedExtensionCsp = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";
for (const target of targets) {
  const manifest = readJson(target.manifestPath, `Run npm run build:all before npm run verify:manifest-policy.`);
  if (!manifest) continue;

  assertEqual(manifest.manifest_version, 3, `${target.browser}: manifest_version`);
  assertEqual(manifest.version, packageJson.version, `${target.browser}: manifest version must match package.json`);
  assertEqual(manifest.default_locale, expectedLocalizedManifest.default_locale, `${target.browser}: default_locale`);
  assertEqual(manifest.name, expectedLocalizedManifest.name, `${target.browser}: localized name`);
  assertEqual(manifest.description, expectedLocalizedManifest.description, `${target.browser}: localized description`);
  assertSetEqual(manifest.permissions, target.permissions, `${target.browser}: permissions`);
  assertSetEqual(manifest.host_permissions, expectedHostPermissions, `${target.browser}: host_permissions`);
  // optional_host_permissions 已全部升为必需权限，manifest 里不再有这个字段。
  assertEqual(
    manifest.optional_host_permissions,
    undefined,
    `${target.browser}: optional_host_permissions must be absent`,
  );

  if (target.permissions.includes('sidePanel')) {
    assertEqual(manifest.side_panel?.default_path, 'sidepanel.html', `${target.browser}: side_panel.default_path`);
    assertEqual(manifest.action?.default_title, expectedLocalizedManifest.actionTitle, `${target.browser}: action.default_title`);
    assert(!manifest.browser_specific_settings, `${target.browser}: browser_specific_settings must be omitted`);
  } else {
    assert(!manifest.side_panel, `${target.browser}: side_panel must be omitted`);
  }

  // No web-accessible resources are declared. Keep the guard so re-adding any
  // resource becomes an explicit, reviewed change.
  const webResources = manifest.web_accessible_resources ?? [];
  assertEqual(webResources.length, 0, `${target.browser}: no web-accessible resources are declared`);
  assertEqual(manifest.content_security_policy?.extension_pages, expectedExtensionCsp, `${target.browser}: extension CSP`);
  assertEqual(manifest.content_security_policy?.sandbox, undefined, `${target.browser}: sandbox CSP must be absent`);
}

const background = readText('entrypoints/background.ts');
const nativeTransport = readText('core/mcp/transports/native.ts');
const browserControlConnection = readText('core/browser-control/cdp.ts');
const browserControlService = readText('core/browser-control/service.ts');
const wxtConfig = readText('wxt.config.ts');

assertIncludes(background, 'chrome.alarms.create', 'alarms permission must create a Chrome alarm');
assertIncludes(background, 'chrome.alarms.onAlarm.addListener', 'alarms permission must listen for alarm wakeups');
assertIncludes(nativeTransport, 'chrome.runtime.connectNative', 'nativeMessaging permission must use connectNative');
assertIncludes(background, 'setPanelBehavior', 'sidePanel permission must use the side panel API');
assertIncludes(browserControlConnection, 'chromeApi.debugger', 'debugger permission must use the debugger API');
assertIncludes(browserControlService, 'chromeApi.tabs', 'tabs permission must use the tabs API');
assertIncludes(browserControlService, 'chromeApi.tabGroups', 'tabGroups API must be optional browser-control metadata');
assertIncludes(wxtConfig, "default_locale: 'en'", 'manifest config must declare default locale');
assertIncludes(wxtConfig, '__MSG_extension_name__', 'manifest config must use localized name');
assertIncludes(wxtConfig, '__MSG_extension_description__', 'manifest config must use localized description');
assertIncludes(wxtConfig, '__MSG_extension_action_title__', 'manifest config must use localized action title');

// Chrome Web Store permission-justification checks (privacy policy + submission
// runbook) are not included: this project does not publish to the store, so those
// documents are not part of the repository.

if (failures.length > 0) {
  console.error('Manifest policy check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Manifest policy check passed');

function readJson(relativePath, missingHint) {
  try {
    return JSON.parse(readText(relativePath));
  } catch (error) {
    failures.push(`${relativePath}: ${error.message}${missingHint ? ` ${missingHint}` : ''}`);
    return null;
  }
}

function readText(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) failures.push(`${message}: expected ${expected}, got ${actual}`);
}

function assertIncludes(text, fragment, message) {
  if (!text.includes(fragment)) failures.push(message);
}

function assertSetEqual(actual, expected, message) {
  if (!Array.isArray(actual)) {
    failures.push(`${message}: expected array`);
    return;
  }
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    failures.push(`${message}: expected ${expectedSorted.join(', ')}, got ${actualSorted.join(', ')}`);
  }
}
