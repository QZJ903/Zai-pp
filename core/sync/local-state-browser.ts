import {
  captureRawMemoryRecordsForSyncRecovery,
  restoreRawMemoryRecordsForSyncRecovery,
} from '../memory/store';
import {
  ACTIVE_PRESET_STORAGE_KEY,
  PRESETS_STORAGE_KEY,
} from '../preset/store';
import {
  SAVED_ITEMS_STORAGE_KEY,
} from '../saved-items/store';
import {
  SKILLS_STORAGE_KEY,
  SKILL_SOURCES_STORAGE_KEY,
} from '../skill/registry';
import type {
  OpaqueStoragePreimage,
  SyncApplyStep,
  SyncLocalStatePort,
  SyncUndoPreimageV1,
} from './local-apply';

export const SYNC_RECOVERY_STORAGE_KEYS = {
  skills: SKILLS_STORAGE_KEY,
  skillSources: SKILL_SOURCES_STORAGE_KEY,
  presets: PRESETS_STORAGE_KEY,
  activePreset: ACTIVE_PRESET_STORAGE_KEY,
  savedItems: SAVED_ITEMS_STORAGE_KEY,
} as const;

type SyncRecoveryStorageSlot = keyof typeof SYNC_RECOVERY_STORAGE_KEYS;

export const browserSyncLocalStatePort: SyncLocalStatePort = {
  captureUndoPreimage,
  restoreStep,
};

async function captureUndoPreimage(): Promise<SyncUndoPreimageV1> {
  const storageKeys = Object.values(SYNC_RECOVERY_STORAGE_KEYS);
  const [memoryRecords, rawStorage] = await Promise.all([
    captureRawMemoryRecordsForSyncRecovery(),
    chrome.storage.local.get(storageKeys) as Promise<Record<string, unknown>>,
  ]);

  return {
    memoryRecords,
    storage: {
      skills: captureStorageValue(rawStorage, SKILLS_STORAGE_KEY),
      skillSources: captureStorageValue(rawStorage, SKILL_SOURCES_STORAGE_KEY),
      presets: captureStorageValue(rawStorage, PRESETS_STORAGE_KEY),
      activePreset: captureStorageValue(rawStorage, ACTIVE_PRESET_STORAGE_KEY),
      savedItems: captureStorageValue(rawStorage, SAVED_ITEMS_STORAGE_KEY),
    },
  };
}

async function restoreStep(step: SyncApplyStep, before: SyncUndoPreimageV1): Promise<void> {
  if (step === 'memories') {
    await restoreRawMemoryRecordsForSyncRecovery(before.memoryRecords);
    return;
  }
  await restoreStorageSlot(step, before);
}

async function restoreStorageSlot(step: Exclude<SyncApplyStep, 'memories'>, before: SyncUndoPreimageV1) {
  const slot = step satisfies SyncRecoveryStorageSlot;
  const key = SYNC_RECOVERY_STORAGE_KEYS[slot];
  const preimage = before.storage[slot];
  if (preimage.present) {
    await chrome.storage.local.set({ [key]: preimage.value });
  } else {
    await chrome.storage.local.remove(key);
  }
}

function captureStorageValue(
  rawStorage: Record<string, unknown>,
  key: string,
): OpaqueStoragePreimage {
  return Object.prototype.hasOwnProperty.call(rawStorage, key)
    ? { present: true, value: rawStorage[key] }
    : { present: false };
}
