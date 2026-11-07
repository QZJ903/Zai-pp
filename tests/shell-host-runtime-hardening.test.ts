import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { copyHostRuntime } from '../packages/shell-host/lib/installer.mjs';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { resolveNativeHostLocations } from '../packages/shell-host/lib/installer-locations.mjs';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { createNativeMessageChannel } from '../packages/shell-host/native/framing.mjs';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { createSessionProvider } from '../packages/shell-host/native/session-provider.mjs';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { createSkillToolHandlers } from '../packages/shell-host/native/skill-provider.mjs';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { createFileToolHandlers } from '../packages/shell-host/native/file-provider.mjs';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { normalizeFolderPickerError } from '../packages/shell-host/native/picker-provider.mjs';

const tempRoots: string[] = [];
const hostPath = resolve('packages/shell-host/native/shell-mcp-host.mjs');
const installerPath = resolve('packages/shell-host/lib/installer.mjs');

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

describe('Shell Host survives failures that would otherwise orphan sessions', () => {
  it('reports a failed shell spawn instead of crashing the host', async () => {
    const provider = createSessionProvider({ logLine: () => {} });
    const begin = provider.handlers.find((handler: { name: string }) => handler.name === 'shell_session_begin').handle;

    const result = await begin({ shell: join(tempDir('zai-pp-missing-shell-'), 'definitely-not-a-shell'), cwd: tmpdir() });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to start persistent shell');
    provider.shutdown();
  });

  it('keeps the host alive and returns an error when the session cwd does not exist', async () => {
    const missingCwd = join(tempDir('zai-pp-missing-cwd-'), 'nope');
    const child = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const frames: Array<{ id: string; result?: any }> = [];
    let exited = false;
    let buffer = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        frames.push(JSON.parse(buffer.subarray(4, length + 4).toString('utf8')));
        buffer = buffer.subarray(length + 4);
      }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('exit', () => { exited = true; });

    try {
      child.stdin.write(createNativeFrame(nativeEnvelope('begin', 'tools/call', {
        name: 'shell_session_begin',
        arguments: { cwd: missingCwd },
      })));
      await waitFor(() => frames.length > 0, 4_000);

      const response = frames[0] as any;
      expect(response.id).toBe('begin');
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toContain('Failed to start persistent shell');
      expect(exited, 'the host must not exit on a failed spawn').toBe(false);
    } finally {
      child.kill();
    }
  });

  it('treats a closed output channel as end-of-input instead of an uncaught EPIPE', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const onOutputClosed = vi.fn();
    createNativeMessageChannel({ input, output, logLine: () => {}, onOutputClosed });

    output.destroy(new Error('EPIPE'));

    await vi.waitFor(() => expect(onOutputClosed).toHaveBeenCalledTimes(1));
  });

  it('refuses to emit a frame larger than the native messaging cap', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logs: string[] = [];
    const channel = createNativeMessageChannel({
      input,
      output,
      logLine: (message: unknown) => logs.push(String(message)),
    });

    await expect(channel.writeMessage({ body: 'x'.repeat(2 * 1024 * 1024) }))
      .rejects.toThrow(/too large/);
    expect(logs.join('\n')).toContain('REJECTED');
  });

  it('keeps the inbound and outbound caps as separate constants', async () => {
    // ⚠️⚠️ Chrome's two native-messaging directions have different documented caps
    // (extension→host 64 MiB, host→extension 1 MiB). Both are self-imposed 1 MiB here
    // today, but they must stay **separate constants** so relaxing one direction later
    // cannot silently widen the other. This test pins that they are distinct bindings,
    // not one shared value.
    // @ts-expect-error 宿主 contracts.mjs 为纯 JS 实现，无类型声明文件
    const contracts = await import('../packages/shell-host/native/contracts.mjs') as {
      MAX_NATIVE_REQUEST_BYTES: number;
      MAX_NATIVE_RESPONSE_BYTES: number;
    };
    expect(contracts.MAX_NATIVE_REQUEST_BYTES).toBe(1 * 1024 * 1024);
    expect(contracts.MAX_NATIVE_RESPONSE_BYTES).toBe(1 * 1024 * 1024);
    expect(Object.keys(contracts)).not.toContain('MAX_NATIVE_MESSAGE_BYTES');
  });
});

describe('Shell Host session output budget', () => {
  const canRunShell = process.platform !== 'win32';

  // Writing to a shell that already died surfaces as an asynchronous EPIPE. Without a
  // listener that is an uncaught exception, and the host exits with every open session.
  it.runIf(canRunShell)('survives a shell that dies between commands', async () => {
    const provider = createSessionProvider({ logLine: () => {} });
    const handlers = Object.fromEntries(
      provider.handlers.map((handler: { name: string; handle: unknown }) => [handler.name, handler.handle]),
    ) as Record<string, (args: Record<string, unknown>) => Promise<any>>;

    try {
      const session = await handlers.shell_session_begin({ cwd: tmpdir() });
      const { session_id: sessionId, pid } = session.structuredContent.data;

      // Kill the shell directly, so the session entry is still live when the next
      // command writes to its stdin.
      process.kill(pid, 'SIGKILL');

      const result = await handlers.shell_session_exec({ session_id: sessionId, command: 'echo hi', timeout_ms: 3_000 })
        .catch((error: Error) => ({ isError: true, content: [{ text: error.message }] }));

      // Either a clean error or a failed exec — what must NOT happen is an uncaught
      // exception escaping into this test process.
      expect(result).toBeDefined();
    } finally {
      provider.shutdown();
    }
  });

  it.runIf(canRunShell)('keeps multi-byte output intact across pipe chunk boundaries', async () => {
    const provider = createSessionProvider({ logLine: () => {} });
    const handlers = Object.fromEntries(
      provider.handlers.map((handler: { name: string; handle: unknown }) => [handler.name, handler.handle]),
    ) as Record<string, (args: Record<string, unknown>) => Promise<any>>;
    const session = await handlers.shell_session_begin({ cwd: tmpdir() });
    const sessionId = session.structuredContent.data.session_id;

    try {
      // 21846 CJK characters = 65538 bytes, so the 64 KiB pipe boundary lands in the
      // middle of the 21845th character.
      const result = await handlers.shell_session_exec({
        session_id: sessionId,
        command: `python3 - <<'PY'\nimport sys\nsys.stdout.write('\\u4e2d'*21846); sys.stdout.flush()\nprint()\nPY`,
        timeout_ms: 30_000,
      });

      const stdout: string = result.structuredContent.data.stdout;
      expect(stdout).not.toContain('\uFFFD');
      expect(Array.from(stdout).length).toBe(21846);
    } finally {
      provider.shutdown();
    }
  });

  it.runIf(canRunShell)('caps multi-byte output by bytes rather than characters', async () => {
    const provider = createSessionProvider({ logLine: () => {} });
    const handlers = Object.fromEntries(
      provider.handlers.map((handler: { name: string; handle: unknown }) => [handler.name, handler.handle]),
    ) as Record<string, (args: Record<string, unknown>) => Promise<any>>;
    const session = await handlers.shell_session_begin({ cwd: tmpdir() });
    const sessionId = session.structuredContent.data.session_id;

    try {
      const result = await handlers.shell_session_exec({
        session_id: sessionId,
        command: `python3 - <<'PY'\nimport sys, time\nfor _ in range(120):\n    sys.stdout.write('\\u4e2d'*1000); sys.stdout.flush()\n    time.sleep(0.001)\nprint()\nPY`,
        timeout_ms: 40_000,
      });

      const data = result.structuredContent.data;
      expect(data.truncated).toBe(true);
      expect(Buffer.byteLength(data.stdout, 'utf8')).toBeLessThanOrEqual(128_000);
    } finally {
      provider.shutdown();
    }
  });
});

describe('Shell Host local file reads', () => {
  it('reports a start offset past the end instead of an empty success', async () => {
    const root = tempDir('zai-pp-file-oob-');
    const file = join(root, 'a.txt');
    writeFileSync(file, 'abcdefghij');
    const handlers = Object.fromEntries(
      createFileToolHandlers({ logLine: () => {} }).map((handler: { name: string; handle: unknown }) => [handler.name, handler.handle]),
    ) as Record<string, (args: Record<string, unknown>) => any>;

    const inside = handlers.local_file_read({ path: file, start: 10, max_chars: 100 });
    expect(inside.structuredContent.data.content).toBe('');
    expect(inside.isError).toBeUndefined();

    const past = handlers.local_file_read({ path: file, start: 11, max_chars: 100 });
    expect(past.isError).toBe(true);
    expect(past.content[0].text).toContain('is past the end');
  });
});

describe('Shell Host local Skill preview budget', () => {
  function writeSkill(root: string, name: string, bodyBytes: number, filler = 'X'): void {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    const header = `---\nname: ${name}\ndescription: ${name}\n---\n\n## 正文\n\n`;
    const repeats = Math.max(0, Math.floor((bodyBytes - Buffer.byteLength(header, 'utf8')) / Buffer.byteLength(filler, 'utf8')));
    writeFileSync(join(directory, 'SKILL.md'), header + filler.repeat(repeats));
  }

  function callPreview(args: Record<string, unknown>): any {
    const handler = createSkillToolHandlers()[0].handle;
    return handler(args);
  }

  it('filters by selectedPaths before applying the preview count limit', () => {
    const root = tempDir('zai-pp-skill-limit-');
    for (let index = 0; index < 90; index += 1) {
      writeSkill(root, `s${String(index).padStart(3, '0')}`, 200);
    }

    const result = callPreview({ rootPath: root, selectedPaths: ['s089/SKILL.md'] });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.data.skills.map((skill: { path: string }) => skill.path)).toEqual(['s089/SKILL.md']);
  });

  it('keeps readable Skills when one Skill is unreadable', () => {
    const root = tempDir('zai-pp-skill-mixed-');
    writeSkill(root, 'good1', 200);
    writeSkill(root, 'good2', 200);
    mkdirSync(join(root, 'huge'), { recursive: true });
    writeFileSync(join(root, 'huge', 'SKILL.md'), 'x'.repeat(130_000));

    const result = callPreview({ rootPath: root });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.data.skills).toHaveLength(2);
    expect(result.structuredContent.data.warnings.join('\n')).toContain('huge/SKILL.md was skipped');
    expect(result.structuredContent.data.truncated).toBe(true);
  });

  it('drops Skills from the tail so the preview stays inside the frame budget', () => {
    const root = tempDir('zai-pp-skill-frame-');
    for (let index = 0; index < 8; index += 1) {
      writeSkill(root, `s${index}`, 118_000);
    }

    const result = callPreview({ rootPath: root });
    const data = result.structuredContent.data;
    const frameBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'x', result }), 'utf8');

    expect(frameBytes).toBeLessThan(1024 * 1024);
    expect(data.skills.length).toBeGreaterThan(1);
    expect(data.skills.length).toBeLessThan(8);
    expect(data.truncated).toBe(true);
    expect(data.warnings.join('\n')).toContain('was omitted because the preview response would exceed the size limit');
  });

  it('reports an actionable error when an explicit selection is too large to preview', () => {
    const root = tempDir('zai-pp-skill-explicit-large-');
    const paths: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      writeSkill(root, `s${index}`, 118_000);
      paths.push(`s${index}/SKILL.md`);
    }

    const result = callPreview({ rootPath: root, selectedPaths: paths });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Import them in smaller batches');
  });

  // The import path turns a missing entry into "Selected local Skill paths were not
  // found", which points at the path. For an explicit selection the real cause has to
  // win — otherwise an oversized SKILL.md reads as "you picked a wrong folder".
  it('names the real reason when an explicitly selected Skill cannot be read', () => {
    const root = tempDir('zai-pp-skill-explicit-unreadable-');
    writeSkill(root, 'ok', 200);
    mkdirSync(join(root, 'huge'), { recursive: true });
    writeFileSync(join(root, 'huge', 'SKILL.md'), 'x'.repeat(130_000));

    const result = callPreview({ rootPath: root, selectedPaths: ['ok/SKILL.md', 'huge/SKILL.md'] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Selected local Skill could not be read (huge/SKILL.md)');
    expect(result.content[0].text).toContain('size limit');
    expect(result.content[0].text).not.toContain('were not found');
  });

  // A single Skill's body can be truncated to empty and the frame can still be over
  // budget, because `scriptFiles` / `omittedFiles` are uncapped path lists. Reporting
  // success there hands the caller a response that is silently cut off downstream.
  it('fails loudly when a single Skill cannot be reduced under the frame budget', () => {
    const root = tempDir('zai-pp-skill-unreducible-');
    const skillDir = join(root, 's0');
    const scriptsDir = join(skillDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: s0\ndescription: d\n---\nbody\n');
    for (let index = 0; index < 13_000; index += 1) {
      writeFileSync(
        join(scriptsDir, `script_with_a_considerably_longer_file_name_${String(index).padStart(6, '0')}.py`),
        'pass\n',
      );
    }

    const result = callPreview({ rootPath: root });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot be reduced under the');
    expect(result.content[0].text).toContain('fewer files');
  });

  it('never escapes the frame budget for escape-heavy content', () => {
    const root = tempDir('zai-pp-skill-escape-');
    for (let index = 0; index < 8; index += 1) {
      writeSkill(root, `s${index}`, 118_000, '"');
    }

    const result = callPreview({ rootPath: root });
    const frameBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'x', result }), 'utf8');

    expect(frameBytes).toBeLessThan(1024 * 1024);
  });

  it('truncates a single oversized Skill and marks it on the Skill itself', () => {
    const root = tempDir('zai-pp-skill-single-');
    writeSkill(root, 'only', 118_000, '\u0001');
    const references = join(root, 'only', 'references');
    mkdirSync(references, { recursive: true });
    for (let index = 0; index < 2; index += 1) {
      writeFileSync(join(references, `r${index}.md`), '\u0001'.repeat(39_000));
    }

    const result = callPreview({ rootPath: root });
    const data = result.structuredContent.data;
    const frameBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'x', result }), 'utf8');

    expect(frameBytes).toBeLessThan(1024 * 1024);
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0].warnings.join('\n')).toContain('was truncated because the preview response would exceed the size limit');
  });
});

describe('Shell Host folder picker cancellation', () => {
  // `execFile` puts the exit code on the error object and leaves `message` as
  // `Command failed: <cmd>`. Matching the message text alone never fires for a user
  // cancel (PowerShell exits 2), and the raw command line reaches the model.
  it('recognizes a cancelled picker by the exit code on the error object', () => {
    const error = Object.assign(new Error('Command failed: powershell.exe -NoProfile -STA -EncodedCommand AAAA'), { code: 2 });

    expect(normalizeFolderPickerError(error)).toBe('Folder selection was cancelled.');
  });

  it('keeps the message-based fallbacks for the other platforms', () => {
    expect(normalizeFolderPickerError(new Error('execution error: User canceled. (-128)'))).toBe('Folder selection was cancelled.');
    expect(normalizeFolderPickerError(new Error('User cancelled the operation'))).toBe('Folder selection was cancelled.');
  });

  /**
   * ⚠️⚠️ `The operation couldn't be completed.` 是 macOS/AppleScript 的**通用失败文案** ——
   * Automation 权限被拒、`osascript` 被系统拦下都会命中它。把它当取消，一次真实故障
   * 就会从「红色报错」降级成「什么都没发生」（扩展侧按取消码静默收尾）。
   */
  it('does not mistake a generic AppleScript failure for a cancellation', () => {
    expect(normalizeFolderPickerError(new Error('The operation couldn’t be completed. (OSStatus -1743)')))
      .toBe('The operation couldn’t be completed. (OSStatus -1743)');
    expect(normalizeFolderPickerError(new Error('The operation couldn\'t be completed. Operation not permitted')))
      .toBe('The operation couldn\'t be completed. Operation not permitted');
  });

  it('passes a real failure through unchanged', () => {
    const error = Object.assign(new Error('Command failed: powershell.exe'), { code: 1 });

    expect(normalizeFolderPickerError(error)).toBe('Command failed: powershell.exe');
  });
});

describe('Shell Host installer safety', () => {
  it('removes its own stale runtime files on reinstall but keeps unrelated files', () => {
    const installDir = tempDir('zai-pp-reinstall-');
    writeFileSync(join(installDir, 'legacy-old-module.mjs'), 'export const x = 1;');
    writeFileSync(join(installDir, 'shell-mcp-host.bat'), 'stale wrapper');
    writeFileSync(join(installDir, 'user-note.txt'), 'keep me');

    copyHostRuntime(resolve('packages/shell-host/native'), installDir);

    expect(existsSync(join(installDir, 'legacy-old-module.mjs'))).toBe(false);
    expect(existsSync(join(installDir, 'user-note.txt'))).toBe(true);
    expect(existsSync(join(installDir, 'shell-mcp-host.mjs'))).toBe(true);
  });

  // A failed reinstall must not take the working install down with it: the host
  // refuses to start without `package.json`, so clearing before copying would leave
  // the machine worse off than before the command.
  it('leaves the previous install intact when the runtime copy cannot start', () => {
    const installDir = tempDir('zai-pp-reinstall-failed-');
    writeFileSync(join(installDir, 'shell-mcp-host.mjs'), '// previous host');
    writeFileSync(join(installDir, 'package.json'), '{"name":"zai-pp-shell-host","version":"0.0.0"}');

    // A source directory whose parent has no package.json — the copy must refuse.
    const brokenSource = join(tempDir('zai-pp-broken-source-'), 'native');
    mkdirSync(brokenSource, { recursive: true });
    writeFileSync(join(brokenSource, 'shell-mcp-host.mjs'), '// new host');

    expect(() => copyHostRuntime(brokenSource, installDir)).toThrow(/package metadata is missing/);

    expect(existsSync(join(installDir, 'package.json')), 'package.json must survive').toBe(true);
    expect(readFileSync(join(installDir, 'shell-mcp-host.mjs'), 'utf8')).toBe('// previous host');
  });

  it('keeps the shared runtime while another browser still points at it', async () => {
    const home = tempDir('zai-pp-uninstall-shared-');
    const installDir = join(home, '.local', 'share', 'zai-pp', 'native-host');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'shell-mcp-host.mjs'), '// host');

    const manifests = ['chrome', 'chromium', 'edge'].map((browser) => {
      const { manifestPath } = resolveNativeHostLocations({
        os: 'linux',
        browser,
        home,
        localAppData: undefined,
      });
      mkdirSync(join(manifestPath, '..'), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify({ path: join(installDir, 'shell-mcp-host') }));
      return manifestPath;
    });

    const output = await runInstaller(home, ['uninstall', '--browser', 'edge']);

    expect(output).toContain('Kept the shared host runtime');
    expect(existsSync(installDir), 'the shared runtime must survive').toBe(true);
    expect(existsSync(manifests[0]), 'chrome manifest must stay').toBe(true);
    expect(existsSync(manifests[2]), 'edge manifest must be gone').toBe(false);
  });

  it('removes the runtime once no other browser references it', async () => {
    const home = tempDir('zai-pp-uninstall-last-');
    const installDir = join(home, '.local', 'share', 'zai-pp', 'native-host');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'shell-mcp-host.mjs'), '// host');
    const { manifestPath } = resolveNativeHostLocations({
      os: 'linux',
      browser: 'chrome',
      home,
      localAppData: undefined,
    });
    mkdirSync(join(manifestPath, '..'), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ path: join(installDir, 'shell-mcp-host') }));

    await runInstaller(home, ['uninstall', '--browser', 'chrome']);

    expect(existsSync(installDir)).toBe(false);
  });

  // "Cannot read the other browser's manifest" is not "it is not using the runtime".
  // Deleting on that assumption leaves that browser registered but pointing at nothing.
  it('keeps the shared runtime when another browser manifest cannot be read', async () => {
    const home = tempDir('zai-pp-uninstall-unreadable-');
    const installDir = join(home, '.local', 'share', 'zai-pp', 'native-host');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'shell-mcp-host.mjs'), '// host');

    // chrome's manifest exists and points at the runtime, but its contents are damaged.
    const { manifestPath: chromeManifest } = resolveNativeHostLocations({
      os: 'linux',
      browser: 'chrome',
      home,
      localAppData: undefined,
    });
    mkdirSync(join(chromeManifest, '..'), { recursive: true });
    writeFileSync(chromeManifest, `{"path": "${join(installDir, 'shell-mcp-host')}"`);

    const output = await runInstaller(home, ['uninstall', '--browser', 'chromium']);

    expect(output).toContain('could not read');
    expect(existsSync(installDir), 'the shared runtime must survive an unreadable manifest').toBe(true);
  });

  it('names a corrupt manifest instead of leaking a JSON.parse error', async () => {
    const home = tempDir('zai-pp-manifest-corrupt-');
    const { manifestPath } = resolveNativeHostLocations({
      os: 'linux',
      browser: 'chrome',
      home,
      localAppData: undefined,
    });
    mkdirSync(join(manifestPath, '..'), { recursive: true });
    writeFileSync(manifestPath, '{broken');

    const output = await runInstaller(home, ['status', '--browser', 'chrome']);

    expect(output).toContain('Invalid Shell Host manifest');
  });

  it.skipIf(process.platform === 'win32')('keeps Windows browser manifests isolated while sharing one runtime', () => {
    const base = { os: 'win32', home: 'C:\\Users\\contract', localAppData: 'C:\\Users\\contract\\AppData\\Local' };
    const locations = ['chrome', 'chromium', 'edge'].map((browser) => resolveNativeHostLocations({ ...base, browser }));

    expect(new Set(locations.map((entry: { manifestPath: string }) => entry.manifestPath)).size).toBe(3);
    expect(new Set(locations.map((entry: { hostInstallDir: string }) => entry.hostInstallDir)).size).toBe(1);
  });
});

function nativeEnvelope(id: string, method: string, params?: unknown) {
  return {
    protocol: 'zai-pp-mcp-native',
    version: 1,
    server: { id: 'hardening' },
    message: { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) },
  };
}

function createNativeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error('Timed out waiting for condition');
}

function runInstaller(home: string, args: string[]): Promise<string> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [installerPath, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', () => resolveRun(output));
    child.on('exit', () => resolveRun(output));
  });
}