#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const failures = [];

const requiredFiles = [
  'core/automation/types.ts',
  'core/automation/store.ts',
  'core/automation/scheduler.ts',
  'core/automation/runtime-request-codec.ts',
  'core/shell/index.ts',
  'core/shell/contracts.ts',
  'core/shell/policy.ts',
  'entrypoints/sidepanel/pages/AutomationPage.tsx',
  'entrypoints/background/automation-runtime-handlers.ts',
  'scripts/shell-mcp-host.mjs',
  'scripts/install-shell-host.mjs',
  'packages/shell-host/package.json',
  'packages/shell-host/lib/installer.mjs',
  'packages/shell-host/native/contracts.mjs',
  'packages/shell-host/native/os-adapter.mjs',
  'packages/shell-host/native/process-provider.mjs',
  'packages/shell-host/native/shell-mcp-host.mjs',
];

const removedPaths = [
  'entrypoints/sidepanel/pages/AgentPage.tsx',
  ['assets/screenshot-sidepanel', 'agent.svg'].join('-'),
];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) {
    failures.push(`missing required automation file: ${file}`);
  }
}

for (const removed of removedPaths) {
  if (fs.existsSync(path.join(root, removed))) {
    failures.push(`obsolete Agent-named path still exists: ${removed}`);
  }
}

assertContains('entrypoints/sidepanel/App.tsx', "labelKey: 'app.tabs.capabilities'");
assertContains('entrypoints/sidepanel/App.tsx', "import('./pages/CapabilitiesPage')");
// Automation lives as a section inside the Tools page (it is no longer its own
// capability sub-tab).
assertContains('entrypoints/sidepanel/pages/ToolsPage.tsx', "import { AutomationSection } from './AutomationPage'");
assertContains('entrypoints/sidepanel/pages/ToolsPage.tsx', '<AutomationSection />');
assertContains('entrypoints/sidepanel/pages/AutomationPage.tsx', 'export function AutomationSection');
assertContains('core/automation/scheduler.ts', 'runAutomation');
assertContains('wxt.config.ts', "'alarms'");
assertContains('entrypoints/background.ts', 'chrome.alarms.create');
assertContains('entrypoints/background.ts', 'chrome.alarms.onAlarm.addListener');
assertContains('entrypoints/background.ts', 'scanDueAutomations');
assertContains('entrypoints/background.ts', 'createBackgroundRuntimeHandlers');
assertContains('entrypoints/background/automation-runtime-handlers.ts', "'CREATE_AUTOMATION'");
assertContains('entrypoints/background/automation-runtime-handlers.ts', "'RUN_AUTOMATION_NOW'");
assertNotContains('entrypoints/background.ts', "case 'CREATE_AUTOMATION'");
assertNotContains('entrypoints/background.ts', "case 'RUN_AUTOMATION_NOW'");
assertContains('core/shell/index.ts', 'createShellMcpPresetInput');
assertContains('scripts/shell-mcp-host.mjs', '../packages/shell-host/native/shell-mcp-host.mjs');
assertContains('scripts/install-shell-host.mjs', '../packages/shell-host/lib/installer.mjs');
assertContains('packages/shell-host/package.json', 'glm-pp-shell-host');
assertContains('packages/shell-host/native/contracts.mjs', "name: 'shell_exec'");
assertContains('packages/shell-host/native/contracts.mjs', 'WINDOWS_POWERSHELL_UTF8_PREAMBLE');
assertContains('packages/shell-host/native/os-adapter.mjs', 'readWindowsUserMachinePathDirs');
assertContains('packages/shell-host/native/os-adapter.mjs', 'getExplicitPathOverride');
assertContains('packages/shell-host/native/process-provider.mjs', 'windowsVersion');
// release.yml was removed (this project does not publish to npm), so its
// publish assertions no longer apply.
// release.yml was removed (this project does not publish to npm), so its
// publish assertions no longer apply.
assertNotContains('README.md', ['Agent', '任务'].join(' '));
assertNotContains('README.md', ['screenshot-sidepanel', 'agent.svg'].join('-'));

if (failures.length > 0) {
  console.error('Automation contract smoke failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Automation contract smoke passed');

function assertContains(file, fragment) {
  if (!readText(file).includes(fragment)) {
    failures.push(`${file} does not contain required fragment: ${fragment}`);
  }
}

function assertNotContains(file, fragment) {
  if (readText(file).includes(fragment)) {
    failures.push(`${file} contains forbidden fragment: ${fragment}`);
  }
}

function readText(file) {
  const absolute = path.join(root, file);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
}
