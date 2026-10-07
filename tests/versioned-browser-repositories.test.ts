import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as t from '@babel/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withSyncLocalStateLock } from '../core/persistence/local-state-lock';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';
import {
  createProjectContext,
  stageDeleteProjectContextAndMemoriesAlreadyLocked,
  updateProjectContext,
  type ProjectContextState,
} from '../core/project';
import {
  PROJECT_CONTEXT_STORAGE_KEY,
  getProjectContextState,
  saveProjectContextStateForSyncApply,
} from '../core/project/store';
import {
  getSavedItemsState,
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

  it('keeps chrome.storage routing single-owned by the versioned repository', () => {
    // 路由（`chrome.storage.local` 的读写）只有 versioned-repository 一处实现；
    // 走它的 store 一旦自己直接读写，就绕开了「先解码再覆盖」那层保护。
    const repositoryPath = 'core/persistence/versioned-repository.ts';
    const repositorySource = readFileSync(repositoryPath, 'utf8');
    expect(repositorySource).toContain('chrome.storage.local.get');
    expect(repositorySource).toContain('chrome.storage.local.set');

    // 消费方清单**派生**自「谁真的 import 了 createVersionedRepository」，不手抄 ——
    // 手抄的清单在新增 store 时会静默漏掉那一个（正是这条要防的事）。
    const consumers = listTypeScriptFiles('core')
      .filter((path) => importsRepositoryFactory(readFileSync(path, 'utf8'), path))
      .map(toPosixPath);

    // 非空 + 含已知成员：否则「导入改名 / 文件挪走」会让上面那条循环空跑而恒绿。
    expect(consumers).toEqual(expect.arrayContaining([
      'core/project/store.ts',
      'core/saved-items/store.ts',
    ]));

    for (const path of consumers) {
      // 走 AST 找真实的成员访问，不查字符串 —— 后者写一句提到它的注释就会假红。
      expect(findChromeStorageAccesses(readFileSync(path, 'utf8'), path), path).toEqual([]);
    }
  });

  it('keeps sync apply delegating domain validation to the owning store', () => {
    const syncFiles = listTypeScriptFiles('core/sync').map(toPosixPath);
    const applyPath = 'core/sync/local-state-browser.ts';

    // 委托：sync 的 apply 步骤必须调 store 的 *ForSyncApply（它们内部才做
    // 「先解码现有原始值、再写入」—— 那条保护就是上面 `guards sync replacements…` 测的东西）。
    const calls = calledNames(readFileSync(applyPath, 'utf8'), applyPath);
    expect([...calls]).toEqual(expect.arrayContaining([
      'saveProjectContextStateForSyncApply',
      'replaceSavedItemsStateForSyncApply',
    ]));

    // 不重复实现：sync 层不得自己再解码一份领域状态（两份实现必然分叉）。
    for (const path of syncFiles) {
      const syncCalls = calledNames(readFileSync(path, 'utf8'), path);
      expect(syncCalls.has('decodeProjectContextState'), path).toBe(false);
      expect(syncCalls.has('decodeSavedItemsState'), path).toBe(false);
    }
  });

  it('treats a missing key as empty state without writing storage', async () => {
    await expect(getProjectContextState()).resolves.toEqual({
      schemaVersion: 2,
      projects: [],
      conversations: [],
      pendingProjectId: null,
    });
    await expect(getSavedItemsState()).resolves.toEqual({ schemaVersion: 1, items: [] });
    // 「缺键」是正常初态，读它不该产生副作用。
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('rejects a present null value instead of treating it as missing', async () => {
    // 显式 `null` 与「缺键」是两件事：前者是**已落盘的非法值**，必须显式失败并原样保留。
    // 判据在 `createChromeStorageSlot`：`hasOwnProperty` + `!== undefined` 两条都要有。
    storage[PROJECT_CONTEXT_STORAGE_KEY] = null;
    storage[SAVED_ITEMS_STORAGE_KEY] = null;

    await expect(getProjectContextState()).rejects.toThrow('projectContext must be an object');
    await expect(getSavedItemsState()).rejects.toThrow('savedItems must be an object');
    expect(storage[PROJECT_CONTEXT_STORAGE_KEY]).toBeNull();
    expect(storage[SAVED_ITEMS_STORAGE_KEY]).toBeNull();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('serializes concurrent Project and Saved Items mutations without lost updates', async () => {
    // 两个并发变更各自「读 → 改 → 写」；没有 FIFO 就会双双读到同一份旧状态、
    // 后写的那次把先写的整条记录覆盖掉（丢更新）。
    randomUUID
      .mockReturnValueOnce('project-a')
      .mockReturnValueOnce('project-b')
      .mockReturnValueOnce('saved-a')
      .mockReturnValueOnce('sync-a')
      .mockReturnValueOnce('saved-b')
      .mockReturnValueOnce('sync-b');

    await Promise.all([
      createProjectContext({ name: 'Project A' }),
      createProjectContext({ name: 'Project B' }),
    ]);
    expect(storage[PROJECT_CONTEXT_STORAGE_KEY]).toMatchObject({
      projects: [{ id: 'project-a' }, { id: 'project-b' }],
    });

    await Promise.all([
      saveSavedItem({ kind: 'snippet', title: 'A', content: 'A', tags: [] }),
      saveSavedItem({ kind: 'bookmark', title: 'B', content: 'B', tags: [] }),
    ]);
    const savedItems = storage[SAVED_ITEMS_STORAGE_KEY] as { items: Array<{ id: string }> };
    expect(savedItems.items.map((item) => item.id).sort()).toEqual(['saved-a', 'saved-b']);
  });

  it('fails mutations before clocks, identifiers, or writes can touch future/corrupt state', async () => {
    // 拒绝态（更高版本的未来态 / 结构损坏）必须在**任何副作用之前**失败：
    // 解码先于构造新记录 ⇒ 时钟不被读、ID 不被生成、存储一个字节都不写。
    // 反过来（先造记录再解码）的表现是「用户数据没变，但 ID 与时间戳已经被消耗掉」，
    // 且下一次重试会拿到一组新的 ID —— 这类痕迹不可见，只能靠这三条断言钉住。
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    for (const raw of Object.values(PROJECT_REJECTED_STATES)) {
      storage[PROJECT_CONTEXT_STORAGE_KEY] = raw;
      await expect(createProjectContext({ name: 'Blocked' })).rejects.toThrow();
      // 原样保留：失败不得就地重写（重写会把未来态降级成本版本能读的形状）。
      expect(storage[PROJECT_CONTEXT_STORAGE_KEY]).toBe(raw);
    }
    expect(randomUUID).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();

    for (const raw of Object.values(SAVED_ITEMS_REJECTED_STATES)) {
      storage[SAVED_ITEMS_STORAGE_KEY] = raw;
      await expect(saveSavedItem({
        kind: 'snippet',
        title: 'Blocked',
        content: 'Blocked',
        tags: [],
      })).rejects.toThrow();
      expect(storage[SAVED_ITEMS_STORAGE_KEY]).toBe(raw);
    }
    expect(randomUUID).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('touches clocks, identifiers, and storage on the legal path', async () => {
    // 上一条的对照面：证明那些 `not.toHaveBeenCalled()` 不是恒真 ——
    // 合法状态下同一批副作用**必须**发生，否则上一条在任何实现下都会绿。
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    // 两条 store 分开断言（中间清一次）—— 合在一起时，只要**任意一条**碰了时钟与 ID
    // 两条断言就都满足，另一条整段被删也照样绿（实测过：把 createProjectContext 的
    // `Date.now()` / `crypto.randomUUID()` 换成常量，合并写法仍然全绿）。
    await createProjectContext({ name: 'Allowed' });
    expect(now).toHaveBeenCalled();
    expect(randomUUID).toHaveBeenCalled();

    now.mockClear();
    randomUUID.mockClear();
    await saveSavedItem({ kind: 'snippet', title: 'Allowed', content: 'Allowed', tags: [] });
    expect(now).toHaveBeenCalled();
    expect(randomUUID).toHaveBeenCalled();
    expect(storageSet).toHaveBeenCalled();
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


// ---- 源码级检查用的辅助函数（走 AST，不查字符串）----

function listTypeScriptFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      out.push(...listTypeScriptFiles(path));
      continue;
    }
    if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function importsRepositoryFactory(source: string, path: string): boolean {
  const program = parseTypeScriptSource(path, source);
  let found = false;
  walkSourceAst(program, (node) => {
    if (!t.isImportDeclaration(node)) return;
    if (!String(node.source.value).endsWith('persistence/versioned-repository')) return;
    for (const specifier of node.specifiers) {
      if (t.isImportSpecifier(specifier)
        && t.isIdentifier(specifier.imported)
        && specifier.imported.name === 'createVersionedRepository') {
        found = true;
      }
    }
  });
  return found;
}

/** 源码里**真实出现**的 `chrome.storage.*` 成员访问（注释与字符串不参与）。 */
function findChromeStorageAccesses(source: string, path: string): string[] {
  const program = parseTypeScriptSource(path, source);
  const found: string[] = [];
  walkSourceAst(program, (node) => {
    if (!t.isMemberExpression(node) || node.computed) return;
    const text = memberPath(node);
    if (text && text.startsWith('chrome.storage.')) found.push(text);
  });
  return found;
}

function memberPath(node: t.Node): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
    const object = memberPath(node.object);
    return object ? `${object}.${node.property.name}` : null;
  }
  return null;
}

function calledNames(source: string, path: string): Set<string> {
  const program = parseTypeScriptSource(path, source);
  const names = new Set<string>();
  walkSourceAst(program, (node) => {
    if (t.isCallExpression(node) && t.isIdentifier(node.callee)) names.add(node.callee.name);
  });
  return names;
}
