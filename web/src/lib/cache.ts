/**
 * 浏览器本地存储（IndexedDB）里的四样东西：
 *
 * - `media`：从板子读回来的**转换产物**（`.ANM` / `.BMP`），列表页 hover 播放用；LRU 淘汰。
 * - `posters`：卡片上的**首帧图**。故意和 `media` 分开存：「清空缓存」清的是体积大的转换产物，
 *   首帧图（一张 312x164 的 RGBA，200 KiB 上下）留着，清完列表不会全变成黑块。
 * - `sources`：上传时那份**原图**（GIF/PNG…）。改布局/循环时要重新转换，靠它。
 * - `snapshot`：最近一次成功读到的 `INDEX` + 文件列表。断连、或设备正在播放（这时读不了卡）
 *   时用它渲染素材库，并标注"本机快照"。
 *
 * 失效判定用不上 FAT 的 mtime（板子没有 RTC，写出来的时间全一样），
 * 所以用**索引里的 createdAt + 文件大小**当版本号。
 *
 * 首帧图另有一个**内容可信度**标记（`POSTER_TRUSTED`）：只有"来源可证没错位"的那几张才带它
 * —— 自己编码出来的产物、或者读卡后过了帧边界校验的前缀（见 `lib/poster.ts`）。
 * 老版本没有这个校验，存下来的首帧图可能是**花掉的**（串口丢一个字节 → 整段错位，
 * 照样能解出一帧），所以不带标记的记录一律作废、重新读一次卡。
 *
 * 术语：**文件名** = 卡上那份 `<ID>.<EXT>`（`entryFileName(IndexEntry)`），存盘一律叫
 * `fileName`；**原图名** = 用户当初选的那个文件的名字，存盘叫 `sourceName`。
 * `IndexEntry.id` 只是文件名里不含后缀的那一段。
 */
import type { ClampedBytes } from './bytes';
import type { MediaIndex } from './index-file';
import type { PosterImage } from './poster';

/** 库名就是存储命名空间：改它或改记录字段名，等于放弃本机已有的全部缓存与快照 */
const DB_NAME = 'pet-board';
const DB_VERSION = 1;
const MEDIA = 'media';
const POSTERS = 'posters';
const SOURCES = 'sources';
const SNAPSHOT = 'snapshot';

/** 转换产物缓存的总容量上限，超了按最久没用过的先扔 */
const CACHE_LIMIT_BYTES = 256 * 1024 * 1024;

/** 首帧图缓存的上限：这些图很小，留得住才不会一清缓存就满屏黑块 */
const POSTER_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * 首帧图的"内容可信"标记：只有画之前验过帧边界（或干脆是自己编码出来的）才写这个值。
 *
 * 为什么要有它：串口丢/重一个字节会让 `.ANM` 前缀整体错位，而 `decodeAnm` 照样能解出
 * 一帧 —— 于是老版本把**花掉的**首帧图存进了 `posters`。光加校验救不了已经存坏的那批
 * （`stored()` 一命中就再也不看板子），所以用"没有标记 = 不可信"把它们一次性作废。
 */
const POSTER_TRUSTED = 1;

interface CacheRecord {
  key: string;
  deviceId: string;
  fileName: string;
  size: number;
  createdAt: number;
  lastUsed: number;
  data: Uint8Array;
}

interface PosterRecord {
  key: string;
  deviceId: string;
  fileName: string;
  size: number;
  createdAt: number;
  lastUsed: number;
  width: number;
  height: number;
  /** 首帧图的 RGBA（`ImageData` 要求 `Uint8ClampedArray`） */
  data: ClampedBytes;
  /** 见 [`POSTER_TRUSTED`]：缺这个字段（或值不对）的记录一律当"可能是花掉的"作废 */
  trusted?: number;
}

interface SourceRecord {
  key: string;
  deviceId: string;
  /** 卡上的文件名 `<ID>.<EXT>`，也就是 `entryFileName(IndexEntry)`；不是 `IndexEntry.id` */
  fileName: string;
  /** 原图文件名（上传时用户看到的那个名字，只在界面上/日志里用） */
  sourceName: string;
  type: string;
  bytes: Uint8Array;
  addedAt: number;
}

interface SnapshotRecord {
  deviceId: string;
  index: MediaIndex;
  files: { fileName: string; size: number; createdAt: number }[];
  at: number;
}

function mediaKey(deviceId: string, fileName: string): string {
  return `${deviceId}:${fileName}`;
}

function sourceKey(deviceId: string, fileName: string): string {
  return `${deviceId}:${fileName}`;
}

/** 按指定版本打开（upgrade 逻辑只认当前 schema） */
function openAt(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('这个浏览器没有 IndexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDIA)) {
        const store = db.createObjectStore(MEDIA, { keyPath: 'key' });
        store.createIndex('lastUsed', 'lastUsed');
      }
      if (!db.objectStoreNames.contains(POSTERS)) {
        const store = db.createObjectStore(POSTERS, { keyPath: 'key' });
        store.createIndex('lastUsed', 'lastUsed');
      }
      if (!db.objectStoreNames.contains(SOURCES)) {
        db.createObjectStore(SOURCES, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(SNAPSHOT)) {
        db.createObjectStore(SNAPSHOT, { keyPath: 'deviceId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打不开 IndexedDB'));
  });
}

/** 本机那份库的 schema 比当前版本还新（上一次 `indexedDB.open` 只肯升不肯降） */
function isVersionError(error: unknown): boolean {
  return (error as { name?: string } | null | undefined)?.name === 'VersionError';
}

/** 删掉整个库（只在版本对不上时用）；别的标签页占着删不掉就如实失败，别无限期挂着 */
function dropDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('删不掉旧的本地缓存'));
    request.onblocked = () => reject(new Error('别的标签页正占着本地缓存'));
  });
}

/**
 * 打开本地库；本机那份是**更新的 schema** 时先删掉再按当前版本重建。
 *
 * 为什么非要有这一步：`indexedDB.open(名, 版本)` **只肯升不肯降** —— 本机是版本 3、代码要版本 1
 * 时会直接回 `VersionError`。**而且这个错是永久的**：库里存的东西全都读不出来，界面上的表现是
 * "已缓存文件：不可用"，首帧图、悬停预览、原图也全废（每次都重新走串口，卡起来就像坏了）。
 * 这份库从头到尾都是本机缓存（转换产物 / 首帧图 / 快照；原图只是省一次"重新选文件"），
 * 所以直接删掉重建。
 *
 * 打开 / 删库两个动作从外面传进来只为了能在测试里换掉（node 里没有 IndexedDB）。
 */
export async function openCacheDb(
  open: (version: number) => Promise<IDBDatabase>,
  drop: () => Promise<void>,
): Promise<IDBDatabase> {
  try {
    return await open(DB_VERSION);
  } catch (error) {
    if (!isVersionError(error)) throw error;
    await drop();
    return open(DB_VERSION);
  }
}

export class MediaCache {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<MediaCache | null> {
    try {
      return new MediaCache(await openCacheDb(openAt, dropDb));
    } catch (error) {
      // 隐私模式之类没有 IndexedDB 的情况：缓存不可用，但功能照旧。
      // 这条 warn 是**唯一**能看见原因的地方（界面上只有一句"不可用"），
      // 版本对不上以外的失败（配额、别的标签页占着）都要靠它排查。
      console.warn('[pet-board] 本地缓存不可用，这一次运行不缓存任何东西：', error);
      return null;
    }
  }

  private tx<T>(
    store: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(store, mode);
      const request = run(transaction.objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB 操作失败'));
    });
  }

  // ---------------------------------------------------------------- 转换产物

  /** 命中的记录要是版本对不上（大小/时间变了），直接丢掉当没缓存 */
  async get(
    deviceId: string,
    fileName: string,
    size: number,
    createdAt: number,
  ): Promise<Uint8Array | null> {
    const key = mediaKey(deviceId, fileName);
    const record = await this.tx<CacheRecord | undefined>(MEDIA, 'readonly', (store) => store.get(key));
    if (!record) return null;
    if (record.fileName !== fileName || record.size !== size || record.createdAt !== createdAt) {
      await this.remove(deviceId, fileName);
      return null;
    }
    record.lastUsed = Date.now();
    await this.tx(MEDIA, 'readwrite', (store) => store.put(record));
    return record.data;
  }

  async put(
    deviceId: string,
    fileName: string,
    meta: { size: number; createdAt: number },
    data: Uint8Array,
  ): Promise<void> {
    const record: CacheRecord = {
      key: mediaKey(deviceId, fileName),
      deviceId,
      fileName,
      size: meta.size,
      createdAt: meta.createdAt,
      lastUsed: Date.now(),
      data,
    };
    await this.tx(MEDIA, 'readwrite', (store) => store.put(record));
    await this.evict();
  }

  /** 只丢**转换产物**、留着首帧图：本机那份产物内容不可信（读回来时错位），要重新读卡 */
  async dropMedia(deviceId: string, fileName: string): Promise<void> {
    await this.tx(MEDIA, 'readwrite', (store) => store.delete(mediaKey(deviceId, fileName)));
  }

  /** 文件没了（删掉/换了新内容）：产物和首帧图一起丢 */
  async remove(deviceId: string, fileName: string): Promise<void> {
    await this.tx(MEDIA, 'readwrite', (store) => store.delete(mediaKey(deviceId, fileName)));
    await this.tx(POSTERS, 'readwrite', (store) => store.delete(mediaKey(deviceId, fileName)));
  }

  /** 把某台设备上已经不存在的文件从缓存里清掉 */
  async prune(deviceId: string, alive: string[]): Promise<void> {
    const keep = new Set(alive);
    for (const store of [MEDIA, POSTERS]) {
      const records = await this.tx<CacheRecord[]>(store, 'readonly', (s) => s.getAll());
      for (const record of records) {
        if (record.deviceId !== deviceId || keep.has(record.fileName)) continue;
        await this.remove(record.deviceId, record.fileName);
      }
    }
  }

  async stats(): Promise<{ count: number; bytes: number }> {
    const records = await this.tx<CacheRecord[]>(MEDIA, 'readonly', (store) => store.getAll());
    return { count: records.length, bytes: records.reduce((sum, record) => sum + record.data.byteLength, 0) };
  }

  /** 超过上限就按 lastUsed 从小到大扔 */
  async evict(limitBytes = CACHE_LIMIT_BYTES): Promise<void> {
    const records = await this.tx<CacheRecord[]>(MEDIA, 'readonly', (store) => store.getAll());
    let total = records.reduce((sum, record) => sum + record.data.byteLength, 0);
    if (total <= limitBytes) return;
    records.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const record of records) {
      if (total <= limitBytes) break;
      await this.remove(record.deviceId, record.fileName);
      total -= record.data.byteLength;
    }
  }

  /**
   * 「清空缓存」只清**转换产物**：首帧图（`posters`）故意留着，清完列表不该整片变黑
   * （为什么这么分，见文件头）。
   */
  async clear(): Promise<void> {
    await this.tx(MEDIA, 'readwrite', (store) => store.clear());
  }

  // ---------------------------------------------------------------- 首帧图

  async getPoster(
    deviceId: string,
    fileName: string,
    size: number,
    createdAt: number,
  ): Promise<PosterImage | null> {
    const key = mediaKey(deviceId, fileName);
    const record = await this.tx<PosterRecord | undefined>(POSTERS, 'readonly', (store) => store.get(key));
    if (!record) return null;
    // 同名但换了内容（重新生成过）、或者**没验过内容**（老版本存的，可能是花掉的）：作废重读
    if (
      record.fileName !== fileName ||
      record.size !== size ||
      record.createdAt !== createdAt ||
      record.trusted !== POSTER_TRUSTED
    ) {
      await this.tx(POSTERS, 'readwrite', (store) => store.delete(key));
      return null;
    }
    record.lastUsed = Date.now();
    await this.tx(POSTERS, 'readwrite', (store) => store.put(record));
    return { width: record.width, height: record.height, rgba: record.data };
  }

  async putPoster(
    deviceId: string,
    fileName: string,
    meta: { size: number; createdAt: number },
    poster: PosterImage,
  ): Promise<void> {
    const record: PosterRecord = {
      key: mediaKey(deviceId, fileName),
      deviceId,
      fileName,
      size: meta.size,
      createdAt: meta.createdAt,
      lastUsed: Date.now(),
      width: poster.width,
      height: poster.height,
      data: new Uint8ClampedArray(poster.rgba),
      // 调用方要么是自己编码的产物、要么是过了帧边界校验的前缀（见 `lib/poster.ts`）
      trusted: POSTER_TRUSTED,
    };
    await this.tx(POSTERS, 'readwrite', (store) => store.put(record));
    await this.evictPosters();
  }

  /** 首帧图太多太久没用了就先扔最老的 */
  async evictPosters(limitBytes = POSTER_LIMIT_BYTES): Promise<void> {
    const records = await this.tx<PosterRecord[]>(POSTERS, 'readonly', (store) => store.getAll());
    let total = records.reduce((sum, record) => sum + record.data.byteLength, 0);
    if (total <= limitBytes) return;
    records.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const record of records) {
      if (total <= limitBytes) break;
      await this.tx(POSTERS, 'readwrite', (store) => store.delete(record.key));
      total -= record.data.byteLength;
    }
  }

  // ---------------------------------------------------------------- 原图

  async putSource(
    deviceId: string,
    fileName: string,
    source: { sourceName: string; type: string; bytes: Uint8Array },
  ): Promise<void> {
    const record: SourceRecord = {
      key: sourceKey(deviceId, fileName),
      deviceId,
      fileName,
      sourceName: source.sourceName,
      type: source.type,
      bytes: source.bytes,
      addedAt: Date.now(),
    };
    await this.tx(SOURCES, 'readwrite', (store) => store.put(record));
  }

  async getSource(deviceId: string, fileName: string): Promise<SourceRecord | null> {
    const record = await this.tx<SourceRecord | undefined>(SOURCES, 'readonly', (store) =>
      store.get(sourceKey(deviceId, fileName)),
    );
    return record ?? null;
  }

  /** 改布局重新生成之后文件名变了：把原图挂到新文件名下，顺手删掉旧的 */
  async moveSource(deviceId: string, from: string, to: string): Promise<boolean> {
    const record = await this.getSource(deviceId, from);
    if (!record) return false;
    await this.putSource(deviceId, to, record);
    await this.removeSource(deviceId, from);
    return true;
  }

  async removeSource(deviceId: string, fileName: string): Promise<void> {
    await this.tx(SOURCES, 'readwrite', (store) => store.delete(sourceKey(deviceId, fileName)));
  }

  // ---------------------------------------------------------------- 快照

  async putSnapshot(snapshot: SnapshotRecord): Promise<void> {
    await this.tx(SNAPSHOT, 'readwrite', (store) => store.put(snapshot));
  }

  async getSnapshot(deviceId: string): Promise<SnapshotRecord | null> {
    const record = await this.tx<SnapshotRecord | undefined>(SNAPSHOT, 'readonly', (store) =>
      store.get(deviceId),
    );
    return record ?? null;
  }
}
