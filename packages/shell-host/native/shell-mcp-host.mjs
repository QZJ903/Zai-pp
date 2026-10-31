#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFINITIONS } from './contracts.mjs';
import { createFileToolHandlers } from './file-provider.mjs';
import { createNativeMessageChannel, NATIVE_EOF } from './framing.mjs';
import { createHostLogger } from './logger.mjs';
import { initializeHostEnvironment } from './os-adapter.mjs';
import { readShellHostPackageMetadata } from './package-metadata.mjs';
import { createPickerToolHandlers } from './picker-provider.mjs';
import { createProcessToolHandlers } from './process-provider.mjs';
import { createNativeRouter } from './router.mjs';
import { createNativeEnvelopeDispatcher } from './runtime-dispatcher.mjs';
import { createSessionProvider } from './session-provider.mjs';
import { createSkillToolHandlers } from './skill-provider.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = readShellHostPackageMetadata();
const logger = createHostLogger();
const hostEnvironmentReady = Promise.resolve(initializeHostEnvironment(packageRoot, logger.logLine));

const sessionProvider = createSessionProvider({ logLine: logger.logLine });
const router = createNativeRouter({
  toolDefinitions: TOOL_DEFINITIONS,
  toolHandlerGroups: [
    createProcessToolHandlers(),
    createSkillToolHandlers(),
    createPickerToolHandlers(),
    createFileToolHandlers({ logLine: logger.logLine }),
    sessionProvider.handlers,
  ],
  logger,
  serverVersion: packageMetadata.version,
});
const channel = createNativeMessageChannel({ logLine: logger.logLine });
const dispatcher = createNativeEnvelopeDispatcher({
  router,
  channel,
  logger,
  hostEnvironmentReady,
});

let shuttingDown = false;

// Last-resort teardown. `main()` only covers the normal end-of-input path and
// promise rejections; an uncaught exception or an explicit process.exit skips it
// and every persistent session's shell would keep running with no owner.
// `process.on('exit')` fires on all of those, and shutdown() is idempotent.
function shutdownOnce(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    sessionProvider.shutdown();
  } catch (error) {
    logger.logLine(`Shutdown failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.on('exit', () => shutdownOnce('process_exit'));
process.on('uncaughtException', (error) => {
  logger.logLine(`Uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  shutdownOnce('uncaught_exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.logLine(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

async function main() {
  while (true) {
    const envelope = await channel.readMessage();
    if (envelope === NATIVE_EOF) break;
    dispatcher.scheduleEnvelope(envelope);
  }
  await dispatcher.settle();
  shutdownOnce('end_of_input');
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  logger.logLine(`Fatal: ${message}`);
  shutdownOnce('fatal');
  process.exit(1);
});
