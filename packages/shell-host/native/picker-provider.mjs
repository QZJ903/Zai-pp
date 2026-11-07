import { execFile } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { promisify } from 'node:util';
import { DEFAULT_TIMEOUT_MS, LOCAL_SKILL_ERROR_CODES, WINDOWS_POWERSHELL_UTF8_PREAMBLE } from './contracts.mjs';
import { resolveLocalPath, safeStat } from './file-provider.mjs';

const execFileAsync = promisify(execFile);

export function createPickerToolHandlers() {
  return [{ name: 'local_folder_pick', handle: createLocalFolderPickResult }];
}

async function createLocalFolderPickResult(args) {
  const title = typeof args?.title === 'string' && args.title.trim()
    ? args.title.trim()
    : 'Choose a local Skill folder';
  const defaultPath = typeof args?.defaultPath === 'string' && args.defaultPath.trim()
    ? resolveFolderPickerDefault(args.defaultPath)
    : '';

  try {
    const selectedPath = await pickLocalFolder({ title, defaultPath });
    const normalizedPath = resolveLocalPath(selectedPath);
    const selectedStat = safeStat(normalizedPath);
    if (!selectedStat || !selectedStat.isDirectory()) {
      throw new Error(`Selected path is not a readable directory: ${normalizedPath}`);
    }
    return {
      content: [{ type: 'text', text: `Selected local folder: ${normalizedPath}` }],
      structuredContent: { ok: true, data: { path: normalizedPath } },
    };
  } catch (error) {
    const message = normalizeFolderPickerError(error);
    // ⚠️ **用户取消不是失败** —— 回一个机器可读的码，让扩展那边直接当作「什么都没发生」。
    // 不给码的话，扩展只能按 message 文案判（那是 UI 字符串，改一次措辞就静默失效）。
    const code = message === FOLDER_PICK_CANCELLED_MESSAGE
      ? LOCAL_SKILL_ERROR_CODES.FOLDER_PICK_CANCELLED
      : LOCAL_SKILL_ERROR_CODES.FOLDER_PICK_FAILED;
    return {
      isError: true,
      content: [{ type: 'text', text: message }],
      structuredContent: { ok: false, error: { code, message } },
    };
  }
}

async function pickLocalFolder({ title, defaultPath }) {
  const hostPlatform = platform();
  if (hostPlatform === 'darwin') return pickLocalFolderOnMac(title, defaultPath);
  if (hostPlatform === 'win32') return pickLocalFolderOnWindows(title, defaultPath);
  return pickLocalFolderOnLinux(title, defaultPath);
}

async function pickLocalFolderOnMac(title, defaultPath) {
  const script = [
    'on run argv',
    '  set promptText to item 1 of argv',
    '  set defaultPath to item 2 of argv',
    '  if defaultPath is not "" then',
    '    set chosenFolder to choose folder with prompt promptText default location (POSIX file defaultPath)',
    '  else',
    '    set chosenFolder to choose folder with prompt promptText',
    '  end if',
    '  return POSIX path of chosenFolder',
    'end run',
  ].join('\n');
  const { stdout } = await execFileAsync('osascript', ['-e', script, title, defaultPath || ''], {
    encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS, windowsHide: true,
  });
  return stdout.trim();
}

async function pickLocalFolderOnWindows(title, defaultPath) {
  const script = [
    WINDOWS_POWERSHELL_UTF8_PREAMBLE,
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = [Environment]::GetEnvironmentVariable("ZPP_FOLDER_PICK_TITLE", "Process")',
    '$dialog.ShowNewFolderButton = $false',
    '$defaultPath = [Environment]::GetEnvironmentVariable("ZPP_FOLDER_PICK_DEFAULT_PATH", "Process")',
    'if ($defaultPath) { $dialog.SelectedPath = $defaultPath }',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($dialog.SelectedPath)',
    '} else {',
    '  [Environment]::Exit(2)',
    '}',
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encodePowerShellCommand(script)], {
    encoding: 'utf8',
    env: { ...process.env, ZPP_FOLDER_PICK_TITLE: title, ZPP_FOLDER_PICK_DEFAULT_PATH: defaultPath || '' },
    timeout: DEFAULT_TIMEOUT_MS,
    windowsHide: false,
  });
  return stdout.trim();
}

function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function pickLocalFolderOnLinux(title, defaultPath) {
  const linuxPickers = [
    {
      command: 'zenity',
      args: ['--file-selection', '--directory', '--title', title, ...(defaultPath ? ['--filename', ensureTrailingPathSeparator(defaultPath)] : [])],
    },
    { command: 'kdialog', args: ['--getexistingdirectory', defaultPath || homedir(), '--title', title] },
  ];
  const missing = [];
  for (const picker of linuxPickers) {
    try {
      const { stdout } = await execFileAsync(picker.command, picker.args, {
        encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS, windowsHide: true,
      });
      return stdout.trim();
    } catch (error) {
      if (error?.code === 'ENOENT') {
        missing.push(picker.command);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`No graphical folder picker is available. Install one of: ${missing.join(', ')}.`);
}

function resolveFolderPickerDefault(input) {
  const resolved = resolveLocalPath(input);
  return safeStat(resolved)?.isDirectory() ? resolved : homedir();
}

function ensureTrailingPathSeparator(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * The one sentence the picker produces when the user dismisses the dialog.
 *
 * ⚠️ **Kept as a single constant so the "is this a cancellation?" test compares against
 * the same string it emits** — that is also why the machine-readable code above exists;
 * the extension must not have to match on this text.
 */
const FOLDER_PICK_CANCELLED_MESSAGE = 'Folder selection was cancelled.';

/**
 * Wording that only ever appears when the user actually dismissed the dialog.
 *
 * ⚠️⚠️ **Deliberately narrow** — `The operation couldn't be completed.` used to be in
 * here, and it is macOS's *generic* AppleScript failure text: a denied Automation
 * permission or a system-blocked `osascript` matches it too. Treating that as a cancel
 * turns a real fault into "nothing happened" (the extension drops the pick silently
 * instead of showing an error). Only keep phrasings that cannot mean anything else.
 */
const CANCELLED_MESSAGE_PATTERN = /User canceled|User cancelled/i;

export function normalizeFolderPickerError(error) {
  const message = error instanceof Error ? error.message : String(error);
  // `execFile` reports the exit code on the error object, not inside the message
  // (`message` is only `Command failed: <cmd>`). Without this check a user pressing
  // Cancel sees the whole command line — including the base64 payload — instead of
  // "cancelled".
  if (error && typeof error === 'object' && error.code === 2) {
    return FOLDER_PICK_CANCELLED_MESSAGE;
  }
  return CANCELLED_MESSAGE_PATTERN.test(message)
    ? FOLDER_PICK_CANCELLED_MESSAGE
    : message;
}
