import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as t from '@babel/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withSyncLocalStateLock } from '../core/persistence/local-state-lock';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';
import {
  PRESETS_STORAGE_KEY,
  getAllPresets,
} from '../core/preset/store';
import { presetCollectionCodec } from '../core/preset/codec';
import { createChromeStorageSlot, createVersionedRepository } from '../core/persistence/versioned-repository';
import {
  getSavedItemsState,
  saveSavedItem,
  type SavedItemsState,
} from '../core/saved-items';
import {
  savedItemsCodec,
} from '../core/saved-items/codec';
import {
  SAVED_ITEMS_STORAGE_KEY,
} from '../core/saved-items/store';

// 记忆库被替换成替身：本文件只核查「版本化仓储 + 领域 store 的读改写边界」，
// 真正的记忆表读写另有测试覆盖。不 mock 的话 store 会在 import 期拉真实 IndexedDB。
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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('versioned browser repositories', () => {
  it('guards sync replacements against overwriting local future state', async () => {
    const presetRepo = createVersionedRepository({
      label: 'presets',
      createDefault: () => [],
      codec: presetCollectionCodec,
      storage: createChromeStorageSlot(PRESETS_STORAGE_KEY),
    });
    const savedItemsRepo = createVersionedRepository({
      label: 'savedItems',
      createDefault: () => ({ schemaVersion: 1 as const, items: [] }),
      codec: savedItemsCodec,
      storage: createChromeStorageSlot(SAVED_ITEMS_STORAGE_KEY),
    });

    storage[PRESETS_STORAGE_KEY] = PRESETS_REJECTED_STATES.future;
    // 替换是「先解码、解码过了才允许覆盖」：本地若是更高版本的未来态，
    // 直接覆盖等于把用户在新版本里造的数据回滚掉，所以必须在写之前抛错。
    await expect(withSyncLocalStateLock(() => presetRepo.replaceAlreadyLocked(
      structuredClone(PRESETS_V1_STATE) as never,
    ))).rejects.toThrow('presets.schemaVersion is not supported');
    expect(storage[PRESETS_STORAGE_KEY]).toBe(PRESETS_REJECTED_STATES.future);

    storage[SAVED_ITEMS_STORAGE_KEY] = SAVED_ITEMS_REJECTED_STATES.future;
    await expect(withSyncLocalStateLock(() => savedItemsRepo.replaceAlreadyLocked(
      structuredClone(SAVED_ITEMS_V1_STATE) as unknown as SavedItemsState,
    ))).rejects.toThrow('savedItems.schemaVersion is not supported');
    expect(storage[SAVED_ITEMS_STORAGE_KEY]).toBe(SAVED_ITEMS_REJECTED_STATES.future);
    // 拒绝时连一次写都不能发生：错误必须是「写之前抛出」，而不是「写完再回滚」。
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('persists Saved Items envelope additive fields without truncation', async () => {
    const savedItemsRepo = createVersionedRepository({
      label: 'savedItems',
      createDefault: () => ({ schemaVersion: 1 as const, items: [] }),
      codec: savedItemsCodec,
      storage: createChromeStorageSlot(SAVED_ITEMS_STORAGE_KEY),
    });
    storage[SAVED_ITEMS_STORAGE_KEY] = SAVED_ITEMS_V1_STATE;
    const remoteState = {
      ...SAVED_ITEMS_V1_STATE,
      additiveSyncField: { preserve: true },
    };

    await withSyncLocalStateLock(() => savedItemsRepo.replaceAlreadyLocked(
      structuredClone(remoteState) as unknown as SavedItemsState,
    ));

    // 信封上本版本不认识的附加字段必须整段落盘：多写的字段被截掉，
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
      'core/preset/store.ts',
      'core/saved-items/store.ts',
    ]));

    for (const path of consumers) {
      // 走 AST 找真实的成员访问，不查字符串 —— 后者写一句提到它的注释就会假红。
      expect(findChromeStorageAccesses(readFileSync(path, 'utf8'), path), path).toEqual([]);
    }
  });

  it('keeps the sync layer from re-implementing domain decoding', () => {
    const syncFiles = listTypeScriptFiles('core/sync').map(toPosixPath);

    // 恢复链按**原始字节**回滚（`OpaqueStoragePreimage`）—— sync 层不得自己再
    // 解码一份领域状态：那边只要有第二份解码实现，就会与 store 的 codec 分叉，
    // 而分叉时没有任何报错。
    expect(syncFiles.length).toBeGreaterThan(0);
    for (const path of syncFiles) {
      const syncCalls = calledNames(readFileSync(path, 'utf8'), path);
      expect(syncCalls.has('decodePresetCollection'), path).toBe(false);
      expect(syncCalls.has('decodeSavedItemsState'), path).toBe(false);
    }
  });

  it('treats a missing key as empty state without writing storage', async () => {
    await expect(getAllPresets()).resolves.toEqual([]);
    await expect(getSavedItemsState()).resolves.toEqual({ schemaVersion: 1, items: [] });
    // 「缺键」是正常初态，读它不该产生副作用。
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('rejects a present null value instead of treating it as missing', async () => {
    // 显式 `null` 与「缺键」是两件事：前者是**已落盘的非法值**，必须显式失败并原样保留。
    // 判据在 `createChromeStorageSlot`：`hasOwnProperty` + `!== undefined` 两条都要有。
    storage[PRESETS_STORAGE_KEY] = null;
    storage[SAVED_ITEMS_STORAGE_KEY] = null;

    await expect(getAllPresets()).rejects.toThrow('presets must use the released array schema');
    await expect(getSavedItemsState()).rejects.toThrow('savedItems must be an object');
    expect(storage[PRESETS_STORAGE_KEY]).toBeNull();
    expect(storage[SAVED_ITEMS_STORAGE_KEY]).toBeNull();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('serializes concurrent Saved Items mutations without lost updates', async () => {
    // 两个并发变更各自「读 → 改 → 写」；没有 FIFO 就会双双读到同一份旧状态、
    // 后写的那次把先写的整条记录覆盖掉（丢更新）。
    randomUUID
      .mockReturnValueOnce('saved-a')
      .mockReturnValueOnce('saved-b');

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

    await saveSavedItem({ kind: 'snippet', title: 'Allowed', content: 'Allowed', tags: [] });
    expect(now).toHaveBeenCalled();
    expect(randomUUID).toHaveBeenCalled();
    expect(storageSet).toHaveBeenCalled();
  });
});

// ---- 契约夹具 ----

const PRESET = {
  id: 'preset-contract-1',
  name: 'Reusable contract prompt',
  content: 'Preserve this preset.',
  createdAt: 500,
  updatedAt: 510,
} as const;

const PRESETS_V1_STATE = [PRESET];

const PRESETS_REJECTED_STATES = {
  future: { schemaVersion: 2, items: [PRESET], futureField: 'preserve-me' },
  corrupt: null,
} as const;

const SAVED_ITEM = {
  id: 'saved-contract-1',
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
