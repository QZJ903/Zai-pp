import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withSyncLocalStateLock } from '../core/persistence/local-state-lock';
import {
  stageDeleteProjectContextAndMemoriesAlreadyLocked,
  updateProjectContext,
  type ProjectContextState,
} from '../core/project';
import {
  PROJECT_CONTEXT_STORAGE_KEY,
  saveProjectContextStateForSyncApply,
} from '../core/project/store';
import {
  saveSavedItem,
  type SavedItemsState,
} from '../core/saved-items';
import {
  replaceSavedItemsStateForSyncApply,
  SAVED_ITEMS_STORAGE_KEY,
} from '../core/saved-items/store';

// 记忆库被替换成替身：本文件只核查「版本化仓储 + 领域 store 的读改写边界」，
// 真正的记忆表读写另有测试覆盖。不 mock 的话 store 会在 import 期拉真实 IndexedDB。
const memoryMocks = vi.hoisted(() => ({
  assertValid: vi.fn(async () => undefined),
  deleteForProject: vi.fn(async () => 0),
}));

vi.mock('../core/memory/store', () => ({
  assertMemoryRecordsValidAlreadyLocked: memoryMocks.assertValid,
  deleteMemoriesForProjectAlreadyLocked: memoryMocks.deleteForProject,
}));

let storage: Record<string, unknown>;
let storageSet: ReturnType<typeof vi.fn>;
let randomUUID: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storage = {};
  // 写入必须深拷贝：断言里比的是「落盘那一刻的值」，
  // 共享引用会让后续 mutate 悄悄改掉已断言的快照。
  storageSet = vi.fn(async (patch: Record<string, unknown>) => {
    storage = { ...storage, ...structuredClone(patch) };
  });
  randomUUID = vi.fn(() => 'generated-id');
  vi.stubGlobal('crypto', { randomUUID });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (
          Object.prototype.hasOwnProperty.call(storage, key)
            ? { [key]: structuredClone(storage[key]) }
            : {}
        )),
        set: storageSet,
      },
    },
  });
  memoryMocks.deleteForProject.mockClear();
  memoryMocks.deleteForProject.mockResolvedValue(0);
  memoryMocks.assertValid.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('versioned browser repositories', () => {
  it('persists a lossless Project v1 migration only on the first successful mutation', async () => {
    storage[PROJECT_CONTEXT_STORAGE_KEY] = PROJECT_V1_STATE;
    vi.spyOn(Date, 'now').mockReturnValue(900);

    await updateProjectContext('project-v1', { description: 'Updated description' });

    // v1 → v2 的迁移**不做独立落盘**，只在第一次真正的业务写入时一并写出：
    // 否则「只是读了一次」也会改写磁盘，读操作就有了副作用。
    expect(storageSet).toHaveBeenCalledOnce();
    expect(storage[PROJECT_CONTEXT_STORAGE_KEY]).toEqual({
      ...PROJECT_V1_MIGRATED_STATE,
      projects: [{
        ...PROJECT_V1_MIGRATED_STATE.projects[0],
        description: 'Updated description',
        updatedAt: 900,
      }],
    });
  });

  it('removes intentionally deleted Project v1 legacy fields without leaving orphan files', async () => {
    storage[PROJECT_CONTEXT_STORAGE_KEY] = PROJECT_V1_STATE;

    await expect(withSyncLocalStateLock(async () => {
      const operation = await stageDeleteProjectContextAndMemoriesAlreadyLocked('project-v1');
      return operation();
    })).resolves.toBe(0);

    // 删项目时 v1 遗留的 files / activeProjectId / activeFileIds 必须跟着收干净，
    // 否则会留下指向已删项目的孤儿文件，下次读回时校验直接炸。
    expect(storage[PROJECT_CONTEXT_STORAGE_KEY]).toEqual({
      ...PROJECT_V1_MIGRATED_STATE,
      projects: [],
      files: [],
      activeProjectId: null,
      activeFileIds: [],
    });
    expect(memoryMocks.deleteForProject).toHaveBeenCalledWith('project-v1');
  });

  it('keeps released empty optional Project v1 source fields through first mutation', async () => {
    storage[PROJECT_CONTEXT_STORAGE_KEY] = PROJECT_V1_EMPTY_OPTIONAL_SOURCE_STATE;
    vi.spyOn(Date, 'now').mockReturnValue(901);

    await updateProjectContext('project-empty-source', { description: 'Updated' });

    const persisted = storage[PROJECT_CONTEXT_STORAGE_KEY] as ProjectContextState & {
      projects: Array<ProjectContextState['projects'][number] & {
        source: Record<string, unknown>;
      }>;
    };
    // 空字符串是**已发布过的合法值**，不是「没写」。解码器只在字段 undefined 时才省略，
    // 所以这三个空串必须在迁移+重编码后原样留下 —— 判成「空即缺」会把释放过的数据抹掉。
    expect(persisted.projects[0].source).toMatchObject({
      url: '',
      owner: '',
      repo: '',
      ref: '',
    });
  });

  it('preserves legal saved-item values exactly when a later item is added', async () => {
    const exactItem = {
      ...SAVED_ITEMS_V1_STATE.items[0],
      title: '  Existing title  ',
      content: '  Existing content  ',
      tags: [' duplicate ', ' duplicate '],
      additiveField: { preserve: true },
    };
    storage[SAVED_ITEMS_STORAGE_KEY] = {
      items: [exactItem],
      additiveStateField: { preserve: true },
    };
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    randomUUID
      .mockReturnValueOnce('new-item-id')
      .mockReturnValueOnce('new-sync-id');

    await saveSavedItem({
      kind: 'snippet',
      title: 'New item',
      content: 'New content',
      tags: [],
    });

    const persisted = storage[SAVED_ITEMS_STORAGE_KEY] as SavedItemsState;
    // 新增一条不能顺手「清洗」老记录：空白与重复标签属于已落盘的合法值，
    // 归一化只应作用在**新写入**的输入上，老数据必须逐字节保留。
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.items).toContainEqual(exactItem);
    // 未知的顶层附加字段也要透传 —— 老版本读到的状态里可能有新版本写的字段，
    // 本版本不认识它，但也不能把它丢了。
    expect(persisted).toMatchObject({ additiveStateField: { preserve: true } });
  });

  it('guards sync replacements against overwriting local future state', async () => {
    storage[PROJECT_CONTEXT_STORAGE_KEY] = PROJECT_REJECTED_STATES.future;
    // 同步替换是「先解码、解码过了才允许覆盖」：本地若是更高版本的未来态，
    // 直接覆盖等于把用户在新版本里造的数据回滚掉，所以必须在写之前抛错。
    await expect(withSyncLocalStateLock(() => saveProjectContextStateForSyncApply(
      structuredClone(PROJECT_V2_STATE) as unknown as ProjectContextState,
    ))).rejects.toThrow('projectContext.schemaVersion is not supported');
    expect(storage[PROJECT_CONTEXT_STORAGE_KEY]).toBe(PROJECT_REJECTED_STATES.future);

    storage[SAVED_ITEMS_STORAGE_KEY] = SAVED_ITEMS_REJECTED_STATES.future;
    await expect(withSyncLocalStateLock(() => replaceSavedItemsStateForSyncApply(
      structuredClone(SAVED_ITEMS_V1_STATE) as unknown as SavedItemsState,
    ))).rejects.toThrow('savedItems.schemaVersion is not supported');
    expect(storage[SAVED_ITEMS_STORAGE_KEY]).toBe(SAVED_ITEMS_REJECTED_STATES.future);
    // 拒绝时连一次写都不能发生：错误必须是「写之前抛出」，而不是「写完再回滚」。
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('persists Saved Items sync envelope additive fields without truncation', async () => {
    storage[SAVED_ITEMS_STORAGE_KEY] = SAVED_ITEMS_V1_STATE;
    const remoteState = {
      ...SAVED_ITEMS_V1_STATE,
      additiveSyncField: { preserve: true },
    };

    await withSyncLocalStateLock(() => replaceSavedItemsStateForSyncApply(
      structuredClone(remoteState) as unknown as SavedItemsState,
    ));

    // 同步信封上本版本不认识的附加字段必须整段落盘：远端多写的字段被截掉，
    // 下次回传时对方就拿到了「数据被吞」的假象。
    expect(storage[SAVED_ITEMS_STORAGE_KEY]).toEqual(remoteState);
  });
});

// ---- 契约夹具：与上游 ds++ 的同名夹具逐字段对齐（仅换命名空间前缀）----

const PROJECT_V1_STATE = {
  schemaVersion: 1,
  projects: [{
    id: 'project-v1',
    name: 'Historical project',
    description: 'Released project v1 data',
    instructions: 'Preserve the original project instructions.',
    source: {
      kind: 'github',
      label: 'example/project',
      url: 'https://github.com/example/project',
      owner: 'example',
      repo: 'project',
      ref: 'main',
      importedAt: 300,
    },
    createdAt: 300,
    updatedAt: 310,
  }],
  files: [{
    id: 'file-v1',
    projectId: 'project-v1',
    path: 'README.md',
    content: '# Historical project',
    sizeBytes: 20,
    sourceKind: 'github',
    createdAt: 305,
  }],
  activeProjectId: 'project-v1',
  activeFileIds: ['file-v1'],
} as const;

const PROJECT_V2_STATE = {
  schemaVersion: 2,
  projects: [{
    id: 'project-v2',
    name: 'Conversation project',
    description: 'Released project v2 data',
    instructions: 'Keep this conversation bound to the project.',
    createdAt: 400,
    updatedAt: 410,
  }],
  conversations: [{
    conversationId: 'conversation-v2',
    projectId: 'project-v2',
    title: 'Compatibility discussion',
    url: 'https://chat.z.ai/chat/s/conversation-v2',
    addedAt: 420,
    lastSeenAt: 430,
  }],
  pendingProjectId: 'project-v2',
} as const;

const PROJECT_V1_MIGRATED_STATE = {
  ...PROJECT_V1_STATE,
  schemaVersion: 2,
  conversations: [],
  pendingProjectId: null,
} as const;

const PROJECT_V1_EMPTY_OPTIONAL_SOURCE_STATE = {
  schemaVersion: 1,
  projects: [{
    id: 'project-empty-source',
    name: 'Manual project',
    description: '',
    instructions: '',
    source: {
      kind: 'manual',
      label: 'Manual project',
      url: '',
      owner: '',
      repo: '',
      ref: '',
      importedAt: 320,
    },
    createdAt: 320,
    updatedAt: 320,
  }],
  files: [],
  activeProjectId: 'project-empty-source',
  activeFileIds: [],
} as const;

const PROJECT_REJECTED_STATES = {
  future: {
    schemaVersion: 3,
    projects: PROJECT_V2_STATE.projects,
    conversations: PROJECT_V2_STATE.conversations,
    pendingProjectId: PROJECT_V2_STATE.pendingProjectId,
    futureField: 'preserve-me',
  },
  corrupt: {
    schemaVersion: 2,
    projects: 'not-an-array',
    conversations: [],
    pendingProjectId: null,
  },
} as const;

const SAVED_ITEM = {
  id: 'saved-contract-1',
  syncId: 'sync-saved-contract-1',
  kind: 'snippet',
  title: 'Reusable contract prompt',
  content: 'Preserve this saved item.',
  sourceUrl: 'https://example.test/contracts',
  tags: ['contract', 'prompt'],
  createdAt: 500,
  updatedAt: 510,
} as const;

const SAVED_ITEMS_V1_STATE = {
  schemaVersion: 1,
  items: [SAVED_ITEM],
} as const;

const SAVED_ITEMS_REJECTED_STATES = {
  future: { schemaVersion: 2, items: [SAVED_ITEM], futureField: 'preserve-me' },
  corrupt: { schemaVersion: 1, items: null },
} as const;
