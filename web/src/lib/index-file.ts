/**
 * `data/INDEX`：卡上的素材索引（JSON 文本，无后缀）。
 *
 * - **数组顺序就是播放顺序**（不额外存 order 字段）；
 * - `skip` 标记这条在以后的自动顺序播放里要跳过；
 * - 板子没有 RTC，FAT 里的时间戳全都一样，所以上传时间只能由网页写进来；
 * - `loops`（播放次数）也在这里 —— `.ANM` 里没有它，见 `lib/loops.ts`。
 */
export const INDEX_NAME = 'INDEX';
export const INDEX_VERSION = 1;

/** 静态 WebP 精灵图拆出来的素材来源；改布局重生成时靠它定位到同一段。 */
export interface SheetSource {
  /** `whole` = 整张按行优先一段；`row` = 每行一段 */
  mode: 'whole' | 'row';
  /** 0 开始的行号；`whole` 固定为 0 */
  row: number;
  /** 总共几段；`whole` 固定为 1 */
  rows: number;
  /** 静态精灵图的每帧时长（毫秒） */
  delayMs: number;
}

export interface IndexEntry {
  id: string;
  ext: 'ANM' | 'BMP';
  kind: 'anim' | 'still';
  width: number;
  height: number;
  frames: number;
  /** 播放次数：0 = 一直播；不在 `.ANM` 文件里，播放时经 `data/PLAYLIST` 交给固件 */
  loops: number;
  durationMs: number;
  bytes: number;
  /** 只有静态精灵图拆出来的条目才有；普通 GIF / 静图 / 真动画 WebP 没有 */
  sheet?: SheetSource;
  sourceName: string;
  sourceType: string;
  fit: string;
  skip: boolean;
  createdAt: number;
}

export interface MediaIndex {
  version: number;
  entries: IndexEntry[];
}

export function emptyIndex(): MediaIndex {
  return { version: INDEX_VERSION, entries: [] };
}

export function parseIndex(bytes: Uint8Array): MediaIndex | null {
  try {
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as Partial<MediaIndex>;
    if (!parsed || parsed.version !== INDEX_VERSION || !Array.isArray(parsed.entries)) return null;
    const entries = parsed.entries.filter(isEntry);
    return { version: INDEX_VERSION, entries };
  } catch {
    return null;
  }
}

function isEntry(value: unknown): value is IndexEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    (entry.ext === 'ANM' || entry.ext === 'BMP') &&
    typeof entry.bytes === 'number' &&
    typeof entry.createdAt === 'number'
  );
}

/** 索引里只剩“文件名 + 大小”的空壳时，用本机快照补回尺寸/帧数/来源等元数据。 */
export function needsMetadataRecovery(entry: IndexEntry): boolean {
  return (
    entry.sourceType === 'unknown' ||
    entry.frames === 0 ||
    entry.width === 0 ||
    entry.height === 0
  );
}

/**
 * 尺寸和帧数够不够用来画首帧图、进度条。
 *
 * 和 [`needsMetadataRecovery`] 的区别：这里**不管原始来源格式**。来源未知只影响
 * "能不能换参数重转"（那要看本机有没有存原图），不影响"这张卡上的文件能不能显示"。
 * 从卡上文件头补回尺寸之后就是这个状态。
 */
export function hasGeometry(entry: IndexEntry): boolean {
  return entry.frames > 0 && entry.width > 0 && entry.height > 0;
}

/**
 * 只补元数据，不改卡上文件的存在性判断：
 * - 当前条目有完整元数据时原样保留；
 * - 当前条目是空壳、且本机快照里有同名条目时，用快照条目替换；
 * - 大小和创建时间仍以卡上对账结果为准。
 */
export function recoverIndexMetadata(current: MediaIndex, local: MediaIndex | null): MediaIndex {
  if (!local) return current;
  const localByName = new Map(local.entries.map((entry) => [entryFileName(entry), entry]));
  return {
    version: current.version,
    entries: current.entries.map((entry) => {
      const localEntry = localByName.get(entryFileName(entry));
      if (!localEntry || !needsMetadataRecovery(entry)) return entry;
      return { ...localEntry, bytes: entry.bytes, createdAt: entry.createdAt };
    }),
  };
}

export function serializeIndex(index: MediaIndex): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version: INDEX_VERSION, entries: index.entries }));
}

/** 索引用文件名：`<ID>.<EXT>` */
export function entryFileName(entry: Pick<IndexEntry, 'id' | 'ext'>): string {
  return `${entry.id}.${entry.ext}`;
}

export interface ReconcileResult {
  index: MediaIndex;
  /** 索引里有、卡上已经没有了 */
  missing: string[];
  /** 卡上有、索引里没有（老文件或索引丢了） */
  orphans: string[];
}

/**
 * 把索引和卡上实际存在的文件对一遍。
 *
 * 索引是网页独占写的，理论上两者一致；但用户可能拿读卡器删过文件，所以这里
 * 以**卡上的文件**为准：索引用不上的条目丢掉，剩下的孤儿在界面上照常显示（没有元数据）。
 */
export function reconcile(index: MediaIndex, files: { name: string; size: number }[]): ReconcileResult {
  const present = new Map(files.map((file) => [file.name, file]));
  const entries: IndexEntry[] = [];
  const missing: string[] = [];
  for (const entry of index.entries) {
    const name = entryFileName(entry);
    if (present.has(name)) entries.push(entry);
    else missing.push(name);
  }
  const known = new Set(entries.map(entryFileName));
  const orphans = files
    .filter((file) => !known.has(file.name) && file.name !== INDEX_NAME)
    .map((file) => file.name);
  return { index: { version: INDEX_VERSION, entries }, missing, orphans };
}

export function extOf(name: string): 'ANM' | 'BMP' | null {
  const upper = name.toUpperCase();
  if (upper.endsWith('.ANM')) return 'ANM';
  if (upper.endsWith('.BMP')) return 'BMP';
  return null;
}
