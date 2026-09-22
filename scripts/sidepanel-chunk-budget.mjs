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
  initialShell: { raw: 332_966, gzip: 102_185 },
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

const BUDGET = Object.freeze({
  initialShell: {
    raw: BASELINE.initialShell.raw,
    gzip: BASELINE.initialShell.gzip + GZIP_ENCODER_VARIANCE_BYTES,
  },
  routeChunks: {
    LibraryPage: { raw: 2_500, gzip: 1_200 },
    MemoryPage: { raw: 6_000, gzip: 2_500 },
    SavedPage: { raw: 10_000, gzip: 4_000 },
    CapabilitiesPage: { raw: 5_000, gzip: 2_000 },
    SkillPage: { raw: 60_000, gzip: 13_000 },
    McpPage: { raw: 50_000, gzip: 12_000 },
    ToolsPage: { raw: 18_000, gzip: 6_000 },
    BrowserControlPage: { raw: 10_000, gzip: 4_000 },
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
