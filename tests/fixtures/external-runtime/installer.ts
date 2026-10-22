export const SHELL_HOST_CONTRACT = {
  nativeHost: 'com.zai_pp.shell',
  packageName: 'zai-pp-shell-host',
  nodeEngine: '>=18.17',
  browsers: ['chrome', 'chromium', 'edge'],
  commands: ['install', 'status', 'uninstall'],
  initializedServer: { name: 'zai-pp-shell' },
  instructions: 'General-purpose shell execution host. Use shell_exec for local commands and python_exec only for short computation or validation snippets.',
} as const;

export const INSTALLER_LOCATION_FIXTURES = [
  {
    name: 'macOS Chrome',
    input: { os: 'darwin', browser: 'chrome', home: '/Users/contract', localAppData: undefined },
    output: {
      appDataRoot: '/Users/contract/Library/Application Support/Zai++',
      hostInstallDir: '/Users/contract/Library/Application Support/Zai++/NativeHost',
      manifestDir: '/Users/contract/Library/Application Support/Google/Chrome/NativeMessagingHosts',
      manifestPath: '/Users/contract/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.zai_pp.shell.json',
      registryKey: null,
    },
  },
  {
    name: 'Linux Edge',
    input: { os: 'linux', browser: 'edge', home: '/home/contract', localAppData: undefined },
    output: {
      appDataRoot: '/home/contract/.local/share/zai-pp',
      hostInstallDir: '/home/contract/.local/share/zai-pp/native-host',
      manifestDir: '/home/contract/.config/microsoft-edge/NativeMessagingHosts',
      manifestPath: '/home/contract/.config/microsoft-edge/NativeMessagingHosts/com.zai_pp.shell.json',
      registryKey: null,
    },
  },
  {
    name: 'Linux Chromium',
    input: { os: 'linux', browser: 'chromium', home: '/home/contract', localAppData: undefined },
    output: {
      appDataRoot: '/home/contract/.local/share/zai-pp',
      hostInstallDir: '/home/contract/.local/share/zai-pp/native-host',
      manifestDir: '/home/contract/.config/chromium/NativeMessagingHosts',
      manifestPath: '/home/contract/.config/chromium/NativeMessagingHosts/com.zai_pp.shell.json',
      registryKey: null,
    },
  },
  {
    name: 'Windows Chrome',
    input: {
      os: 'win32',
      browser: 'chrome',
      home: 'C:\\Users\\contract',
      localAppData: 'C:\\Users\\contract\\AppData\\Local',
    },
    output: {
      appDataRoot: 'C:\\Users\\contract\\AppData\\Local\\Zai++',
      hostInstallDir: 'C:\\Users\\contract\\AppData\\Local\\Zai++\\NativeHost',
      manifestDir: 'C:\\Users\\contract\\AppData\\Local\\Zai++\\NativeMessagingHosts',
      manifestPath: 'C:\\Users\\contract\\AppData\\Local\\Zai++\\NativeMessagingHosts\\com.zai_pp.shell.chrome.json',
      registryKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.zai_pp.shell',
    },
  },
] as const;

export const INSTALLER_CURRENT_GAPS = [
  {
    name: 'missing checksum metadata permits installation to continue',
    status: 'deferred',
    owner: 'deferred:installer-integrity-policy',
    target: 'fail-closed-checksum-policy',
  },
  {
    name: 'Windows registry failure is warning-only and status does not verify the registered value',
    status: 'deferred',
    owner: 'deferred:installer-registry-health',
    target: 'observable-registry-health',
  },
] as const;
