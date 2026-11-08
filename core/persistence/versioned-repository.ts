import { withSyncLocalStateLock } from './local-state-lock';

export type RawStorageSlot =
  | { readonly present: false }
  | { readonly present: true; readonly value: unknown };

export interface StorageSlotPort {
  read(): Promise<RawStorageSlot>;
  write(value: unknown): Promise<void>;
  remove(): Promise<void>;
}

export interface VersionedValueCodec<T> {
  decode(value: unknown, path: string): T;
  encode(value: T): unknown;
}

export interface VersionedRepository<T> {
  read(): Promise<T>;
  readAlreadyLocked(): Promise<T>;
  replaceAlreadyLocked(value: T): Promise<void>;
  writeAfterReadAlreadyLocked(value: T): Promise<void>;
}

export interface VersionedRepositoryOptions<T> {
  label: string;
  createDefault(): T;
  codec: VersionedValueCodec<T>;
  storage: StorageSlotPort;
}

export function createChromeStorageSlot(key: string): StorageSlotPort {
  return {
    async read() {
      const values = await chrome.storage.local.get(key) as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(values, key) || values[key] === undefined) {
        return { present: false };
      }
      return { present: true, value: values[key] };
    },
    async write(value) {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove() {
      await chrome.storage.local.remove(key);
    },
  };
}

export function createVersionedRepository<T>(
  options: VersionedRepositoryOptions<T>,
): VersionedRepository<T> {
  const readAlreadyLocked = async (): Promise<T> => {
    const raw = await options.storage.read();
    return raw.present
      ? options.codec.decode(raw.value, options.label)
      : options.createDefault();
  };

  /**
   * 覆盖写：**先解码当前值，解码过了才允许写**。
   *
   * ⚠️⚠️ **这条不变式必须由本函数自己兑现，不能靠调用方纪律。**
   * 早先 `writeAfterReadAlreadyLocked` 的函数体只有一句 `storage.write`，
   * 「损坏 / 更高版本的状态不许被普通写覆盖」全靠 8 个调用点各自先读一遍 ——
   * 而那 8 处**没有任何守卫**：将来新增一个忘了读的写入口，就会把用户在新版本里
   * 造的数据、或一条读不出来的损坏记录，用一份基于空态算出的值整份覆盖掉，
   * 且**零报错**（下一次读只是「数据不见了」）。
   *
   * ⚠️ 代价是每次写多一次 `chrome.storage.local.get`（本地 IPC、亚毫秒级），
   * 而写操作是用户动作触发的低频路径（存预设、删技能），不构成负担。
   */
  const replaceAlreadyLocked = async (value: T): Promise<void> => {
    await readAlreadyLocked();
    await options.storage.write(options.codec.encode(value));
  };

  return {
    read() {
      return withSyncLocalStateLock(readAlreadyLocked);
    },
    readAlreadyLocked,
    replaceAlreadyLocked,
    /**
     * 与 `replaceAlreadyLocked` **同一实现** —— 名字里的「after read」现在是
     * 本函数自己读，不是「调用方应该已经读过」。
     *
     * ⚠️ 保留两个名字是因为调用点已经按语义选好了：`replaceAlreadyLocked` 用于
     * 「整份替换」（当前零生产调用、只有测试当观察面），`writeAfterReadAlreadyLocked`
     * 用于「在已读出的状态上改一处再写回」。两者现在行为一致，但保留名字能让
     * 调用点表达意图。⚠️ **不要再拆出第二份实现** —— 拆开就是这条不变式分叉的开始。
     */
    writeAfterReadAlreadyLocked: replaceAlreadyLocked,
  };
}
