export const HOST_NAME: string;
export const SUPPORTED_BROWSER_NAMES: readonly string[];

export function assertSupportedBrowser(browser: string): void;
export function resolveNativeHostLocations(args: {
  os: string;
  browser: string;
  home: string;
  localAppData?: string;
}): {
  appDataRoot: string;
  hostInstallDir: string;
  manifestDir: string;
  manifestPath: string;
  registryKey: string | null;
};
export function getCurrentNativeHostLocations(browser?: string): ReturnType<typeof resolveNativeHostLocations>;
export function getHostInstallDir(): string;
export function getManifestPath(browser: string): string;
export function getRegistryKey(browser: string): string | null;
export function createNativeHostManifest(
  args: { browser: string; extensionId?: string | null },
  wrapperPath: string,
): {
  name: string;
  description: string;
  path: string;
  type: string;
  allowed_extensions?: string[];
  allowed_origins?: string[];
};

export function parseArgs(argv: string[]): {
  command: 'install' | 'status' | 'uninstall';
  extensionId: string | null;
  browser: string;
  logFile: string | null;
};

export function copyHostRuntime(nativeSourceDir: string, installDir: string): string;
export function createWrapper(hostPath: string, logFile: string | null): string;
export function detectLogFile(wrapperPath: string): string | null;
export function escapeShellValue(value: string): string;
export function getMissingHostRuntimeFiles(installDir: string): string[];

export function main(argv?: string[]): Promise<void>;