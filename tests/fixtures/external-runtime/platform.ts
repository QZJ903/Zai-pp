export const PLATFORM_CAPABILITY_KEYS = [
  'storage',
  'runtimeMessaging',
  'downloads',
  'assetUrl',
  'sidePanel',
  'nativeMessaging',
  'alarms',
  'tabs',
  'tabGroups',
  'debugger',
  'browserControl',
  'accessibilityTree',
] as const;

export const PLATFORM_PROFILE_FIXTURES = {
  chromium: {
    supported: PLATFORM_CAPABILITY_KEYS.filter((capability) => capability !== 'downloads'),
    unsupported: ['downloads'],
  },
} as const;

export const PLATFORM_CURRENT_GAPS = [] as const;
