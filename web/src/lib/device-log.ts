/**
 * 网页端的**设备通信日志**。
 *
 * 为什么要有它：串口被网页独占时 `espflash monitor` 打不开，而板子的日志是 defmt 二进制帧 ——
 * 光靠按行解析协议会把帧整个丢掉，设备卡死那一瞬的证据也没了。
 * 这里把通信**原样记下来**：协议命令行与回复逐行、固件日志帧存完整原始字节、
 * 文件载荷只留一条合并摘要（1KB 一块，内容不存，否则日志比素材还大）。
 *
 * 存储用**独立的 IndexedDB 库**（`pet-board-logs`），和媒体缓存互不影响：
 * - `entries`：一条一条日志（`autoIncrement` 主键 + `day` 索引）；
 * - `days`：每天一条清单（条数/字节数/最后看到的设备），用来即时统计和**整天删除**。
 *
 * 保留策略：**最近 30 天 / 上限 100MB**，超了从最旧的整天删；记录一直开，只能手动清空。
 */
const DB_NAME = 'pet-board-logs';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const DAYS = 'days';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 保留天数（含今天）：超过就从最旧的整天删 */
const LOG_RETENTION_DAYS = 30;
/** 保留总量上限：超过就从最旧的整天删 */
const LOG_MAX_BYTES = 100 * 1024 * 1024;
/** 缓冲最多攒多久 / 多少条就落盘 */
const FLUSH_MS = 200;
const FLUSH_ENTRIES = 200;
/** 界面和 .txt 里一帧最多显示多少字节的十六进制（完整字节写进导出的 `FW` 行，可还原成 .bin） */
const FRAME_PREVIEW_BYTES = 64;

export type LogDir = 'tx' | 'rx' | 'fw' | 'note';
export type LogKind = 'line' | 'frame' | 'bulk' | 'note' | 'error';

export interface LogEntry {
  /** IndexedDB 主键；还在内存缓冲里时没有 */
  id?: number;
  /** 本地日期 `YYYY-MM-DD`：分天查看和下载都以它为准 */
  day: string;
  /** 发生时间（epoch ms） */
  t: number;
  /** 设备 MAC；握手之前是 `unknown` */
  deviceId: string;
  dir: LogDir;
  kind: LogKind;
  /** 界面/.txt 里显示的内容：协议行原文、帧的十六进制预览、载荷摘要 */
  text: string;
  /** `kind = 'frame'` 的**完整 wire 字节**（含 `FF 00` 前缀和结尾 `00`） */
  raw?: Uint8Array;
  /** 估算占用（计入保留配额） */
  bytes: number;
  /** 连续重复的 ACK / 载荷摘要合并成一条，这里记次数 */
  count: number;
  /** 只在内存里：实时视图按它更新"正在合并的那一条" */
  seq?: number;
}

export interface DayManifest {
  day: string;
  /** 这一天最后看到的设备 */
  deviceId: string;
  bytes: number;
  count: number;
  firstT: number;
  lastT: number;
}

export type LogEvent = { type: 'entry'; entry: LogEntry } | { type: 'days' };

/** `Transport` 往上抛的通信事件；测试里塞一个内存实现就能验整条链路 */
export interface LogSink {
  line(dir: 'tx' | 'rx', text: string): void;
  frame(raw: Uint8Array): void;
  bulk(dir: 'tx' | 'rx', bytes: number, label: 'ack' | 'payload'): void;
  note(text: string): void;
  error(text: string): void;
}

/** 落盘接口：浏览器用 IndexedDB，测试用内存实现 */
export interface LogStorage {
  append(entries: LogEntry[], days: DayManifest[]): Promise<void>;
  listDays(): Promise<DayManifest[]>;
  readDay(day: string): Promise<LogEntry[]>;
  deleteDays(days: string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface SessionInfo {
  id: string;
  api: number;
  screen: { width: number; height: number };
  reset: string;
  sd: string;
  href: string;
}

export interface DeviceLogOptions {
  now?: () => number;
  retentionDays?: number;
  maxBytes?: number;
  flushMs?: number;
  flushEntries?: number;
}

// ---------------------------------------------------------------- 纯函数（好测）

/** 本地时区的 `YYYY-MM-DD` */
export function localDay(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `HH:MM:SS.mmm`（本地时区） */
function formatClock(t: number): string {
  const d = new Date(t);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 帧的十六进制预览；超长只显示前 `limit` 字节（导出时 `FW` 行写完整字节） */
export function hexPreview(raw: Uint8Array, limit = FRAME_PREVIEW_BYTES): string {
  const head = raw.subarray(0, limit);
  const hex = Array.from(head, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
  return raw.length > limit ? `${hex} …(+${raw.length - limit} B)` : hex;
}

/**
 * 一行日志的文本形式。
 *
 * 固件帧（`FW`）默认只给 [`FRAME_PREVIEW_BYTES`] 字节的十六进制预览，免得界面上一行拉太长；
 * 导出文本日志时传 `frameBytes: Infinity` 写出**完整**帧，这样文本本身就能还原成 `.bin`
 * 交给 `defmt-print`（见 `exportTxt` 的头部说明）。
 */
export function formatEntryLine(entry: LogEntry, options: { frameBytes?: number } = {}): string {
  const tag = entry.dir === 'tx' ? 'TX' : entry.dir === 'rx' ? 'RX' : entry.dir === 'fw' ? 'FW' : '--';
  const body =
    entry.kind === 'frame'
      ? hexPreview(entry.raw ?? new Uint8Array(), options.frameBytes ?? FRAME_PREVIEW_BYTES)
      : entry.kind === 'error'
        ? `ERR ${entry.text}`
        : entry.text;
  const times = entry.count > 1 ? ` ×${entry.count}` : '';
  return `${formatClock(entry.t)}  ${tag}  ${body}${times}`;
}

/** 要删掉哪些整天：先超期、再按总量上限从最旧的开始 */
export function prunePlan(
  days: DayManifest[],
  opts: { now: number; retentionDays: number; maxBytes: number },
): string[] {
  const cutoff = localDay(opts.now - (opts.retentionDays - 1) * DAY_MS);
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const stale = sorted.filter((day) => day.day < cutoff).map((day) => day.day);
  let total = sorted.filter((day) => day.day >= cutoff).reduce((sum, day) => sum + day.bytes, 0);
  const overflow: string[] = [];
  for (const day of sorted) {
    if (day.day < cutoff) continue;
    if (total <= opts.maxBytes) break;
    overflow.push(day.day);
    total -= day.bytes;
  }
  return [...stale, ...overflow];
}

// ---------------------------------------------------------------- IndexedDB

function openLogDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('这个浏览器没有 IndexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENTRIES)) {
        const store = db.createObjectStore(ENTRIES, { keyPath: 'id', autoIncrement: true });
        store.createIndex('day', 'day');
      }
      if (!db.objectStoreNames.contains(DAYS)) {
        db.createObjectStore(DAYS, { keyPath: 'day' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打不开日志库'));
  });
}

class IdbLogStorage implements LogStorage {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<IdbLogStorage | null> {
    try {
      return new IdbLogStorage(await openLogDb());
    } catch {
      // 隐私模式之类没有 IndexedDB：日志功能整块关掉，界面显示"不可用"
      return null;
    }
  }

  append(entries: LogEntry[], days: DayManifest[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([ENTRIES, DAYS], 'readwrite');
      const entryStore = tx.objectStore(ENTRIES);
      const dayStore = tx.objectStore(DAYS);
      for (const entry of entries) {
        const { seq: _seq, ...record } = entry;
        entryStore.add(record);
      }
      for (const day of days) dayStore.put(day);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('写设备日志失败'));
      tx.onabort = () => reject(tx.error ?? new Error('写设备日志被中止'));
    });
  }

  listDays(): Promise<DayManifest[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(DAYS, 'readonly');
      const request = tx.objectStore(DAYS).getAll();
      request.onsuccess = () => resolve(request.result as DayManifest[]);
      request.onerror = () => reject(request.error ?? new Error('读设备日志清单失败'));
    });
  }

  readDay(day: string): Promise<LogEntry[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(ENTRIES, 'readonly');
      const request = tx.objectStore(ENTRIES).index('day').getAll(IDBKeyRange.only(day));
      request.onsuccess = () => resolve(request.result as LogEntry[]);
      request.onerror = () => reject(request.error ?? new Error('读设备日志失败'));
    });
  }

  deleteDays(days: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([ENTRIES, DAYS], 'readwrite');
      const index = tx.objectStore(ENTRIES).index('day');
      const dayStore = tx.objectStore(DAYS);
      for (const day of days) {
        const request = index.openCursor(IDBKeyRange.only(day));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
        dayStore.delete(day);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('删设备日志失败'));
      tx.onabort = () => reject(tx.error ?? new Error('删设备日志被中止'));
    });
  }

  clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([ENTRIES, DAYS], 'readwrite');
      tx.objectStore(ENTRIES).clear();
      tx.objectStore(DAYS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('清空设备日志失败'));
    });
  }
}

// ---------------------------------------------------------------- DeviceLog

function mergeManifest(base: DayManifest | null, entry: LogEntry): DayManifest {
  if (!base) {
    return {
      day: entry.day,
      deviceId: entry.deviceId,
      bytes: entry.bytes,
      count: 1,
      firstT: entry.t,
      lastT: entry.t,
    };
  }
  return {
    ...base,
    deviceId: entry.deviceId,
    bytes: base.bytes + entry.bytes,
    count: base.count + 1,
    firstT: Math.min(base.firstT, entry.t),
    lastT: Math.max(base.lastT, entry.t),
  };
}

export class DeviceLog implements LogSink {
  private buffer: LogEntry[] = [];
  private readonly manifests = new Map<string, DayManifest>();
  private deviceId = 'unknown';
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private readonly subscribers = new Set<(event: LogEvent) => void>();
  private readonly now: () => number;
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  private readonly flushMs: number;
  private readonly flushEntries: number;

  private constructor(
    private readonly storage: LogStorage | null,
    options: DeviceLogOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.retentionDays = options.retentionDays ?? LOG_RETENTION_DAYS;
    this.maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
    this.flushMs = options.flushMs ?? FLUSH_MS;
    this.flushEntries = options.flushEntries ?? FLUSH_ENTRIES;
  }

  /** 打开浏览器的日志库；IndexedDB 不可用时返回一个"关闭记录"的实例（界面显示不可用） */
  static async open(options: DeviceLogOptions = {}): Promise<DeviceLog> {
    const log = new DeviceLog(await IdbLogStorage.open(), options);
    await log.init();
    return log;
  }

  /** 测试用：直接塞一个存储实现 */
  static async openWith(storage: LogStorage | null, options: DeviceLogOptions = {}): Promise<DeviceLog> {
    const log = new DeviceLog(storage, options);
    await log.init();
    return log;
  }

  private async init(): Promise<void> {
    if (this.storage) {
      try {
        for (const day of await this.storage.listDays()) this.manifests.set(day.day, day);
      } catch {
        /* 读不到就当空的 */
      }
    }
    if (typeof document !== 'undefined') {
      const flush = () => {
        if (document.visibilityState === 'hidden') void this.flush();
      };
      document.addEventListener('visibilitychange', flush);
      document.addEventListener('pagehide', () => void this.flush());
    }
  }

  get enabled(): boolean {
    return this.storage !== null;
  }

  // ---- LogSink ----

  line(dir: 'tx' | 'rx', text: string): void {
    this.push({ dir, kind: 'line', text, bytes: text.length + 2 });
  }

  frame(raw: Uint8Array): void {
    // 帧永远不合并：原始字节要按顺序留着，导出的 `FW` 行才能还原成 .bin 喂给 defmt-print
    this.push({ dir: 'fw', kind: 'frame', text: hexPreview(raw), raw: raw.slice(), bytes: raw.length + 8 }, false);
  }

  bulk(dir: 'tx' | 'rx', bytes: number, label: 'ack' | 'payload'): void {
    const text = label === 'ack' ? 'ACK' : `${bytes} B 数据块`;
    // 这里记的是**存下来的这一行有多大**（几十字节），不是"流过了多少载荷"：
    // 32 字节一块的时候一次预览就有一万多块，按流量记账会把"日志占用"报成几十倍，
    // 而合并之后其实只有几行（见 `push` 里的合并分支）。
    this.push({ dir, kind: 'bulk', text, bytes: text.length + 24 });
  }

  note(text: string): void {
    this.push({ dir: 'note', kind: 'note', text, bytes: text.length + 2 });
  }

  error(text: string): void {
    this.push({ dir: 'note', kind: 'error', text, bytes: text.length + 2 });
  }

  // ---- 会话 ----

  attachDevice(deviceId: string): void {
    this.deviceId = deviceId;
  }

  startSession(info: SessionInfo): void {
    this.attachDevice(info.id);
    this.note(
      `session: ${info.id} · api ${info.api} · 屏幕 ${info.screen.width}x${info.screen.height} · ` +
        `复位 ${info.reset} · 卡 ${info.sd} · ${info.href}`,
    );
  }

  // ---- 读取 / 导出 / 清理 ----

  /** 按天倒序（今天的在最前面） */
  listDays(): DayManifest[] {
    return [...this.manifests.values()].sort((a, b) => b.day.localeCompare(a.day));
  }

  stats(): { days: number; bytes: number; count: number } {
    let bytes = 0;
    let count = 0;
    for (const day of this.manifests.values()) {
      bytes += day.bytes;
      count += day.count;
    }
    return { days: this.manifests.size, bytes, count };
  }

  async readDay(day: string): Promise<LogEntry[]> {
    if (!this.storage) return [];
    const entries = await this.storage.readDay(day);
    return entries.sort((a, b) => a.t - b.t || (a.id ?? 0) - (b.id ?? 0));
  }

  /**
   * 按天导成纯文本：**协议行**（`tx` / `rx` 一行一条）+ 说明 + 固件帧的**完整**十六进制。
   *
   * 一份文本就够用了：网页这侧的每个命令/回复逐行记着（"命令发出去了没有、板子回的是什么、
   * 哪一步超时"），固件那一侧的 defmt 帧也按时间顺序完整列在 `FW` 行里 —— 需要解码时按
   * 头部那条 `sed | xxd -r -p` 还原成 `.bin` 再喂 `defmt-print` 即可。
   */
  async exportTxt(day: string): Promise<string> {
    const entries = await this.readDay(day);
    const head = [
      `# Pet Board 通信日志 ${day}`,
      `# 导出时间 ${new Date().toISOString()}　条数 ${entries.length}`,
      '# 方向：TX = 网页→板子　RX = 板子→网页　FW = 固件 defmt 日志帧（完整十六进制，按时间顺序）',
      '# 把 FW 行还原成 .bin 再解码（先滤掉这些 # 开头的说明行）：',
      '#   grep -v \'^#\' pet-board-log-<day>.txt | sed -n \'s/^.*  FW  //p\' | tr -d \' \' | xxd -r -p > pet-board-frames-<day>.bin',
      '#   defmt-print -e <这一版固件的 ELF> < pet-board-frames-<day>.bin',
      '',
    ];
    return `${head.join('\n')}\n${entries
      .map((entry) => formatEntryLine(entry, { frameBytes: Number.POSITIVE_INFINITY }))
      .join('\n')}\n`;
  }

  async clear(): Promise<void> {
    this.buffer = [];
    this.manifests.clear();
    if (this.storage) await this.storage.clear();
    this.emit({ type: 'days' });
  }

  subscribe(cb: (event: LogEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  // ---- 写入 ----

  /** 缓冲落盘 + 保留清理；并发调用串成一条链，不会互相插队 */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // 写失败（配额满、库被关掉）只丢这一批，别让整条链子从此变成 rejected ——
    // 那样后面的 flush 会全部短路，日志会"悄悄不记了"
    this.flushing = this.flushing
      .catch(() => undefined)
      .then(() => this.writeBatch())
      .catch(() => undefined);
    return this.flushing;
  }

  private async writeBatch(): Promise<void> {
    const batch = this.buffer;
    if (!this.storage || batch.length === 0) return;
    this.buffer = [];
    const touched = new Map<string, DayManifest>();
    for (const entry of batch) {
      touched.set(entry.day, mergeManifest(touched.get(entry.day) ?? this.manifests.get(entry.day) ?? null, entry));
    }
    await this.storage.append(batch, [...touched.values()]);
    for (const [day, manifest] of touched) this.manifests.set(day, manifest);
    const doomed = prunePlan([...this.manifests.values()], {
      now: this.now(),
      retentionDays: this.retentionDays,
      maxBytes: this.maxBytes,
    });
    if (doomed.length > 0) {
      await this.storage.deleteDays(doomed);
      for (const day of doomed) this.manifests.delete(day);
    }
    this.emit({ type: 'days' });
  }

  private push(
    input: { dir: LogDir; kind: LogKind; text: string; raw?: Uint8Array; bytes: number },
    merge = true,
  ): void {
    if (!this.enabled) return;
    const t = this.now();
    const day = localDay(t);
    const last = this.buffer[this.buffer.length - 1];
    // 连续重复的 ACK / 载荷摘要合并成一条，日志才不会被 1KB 块刷屏
    if (
      merge &&
      last &&
      last.day === day &&
      last.deviceId === this.deviceId &&
      last.dir === input.dir &&
      last.kind === input.kind &&
      last.text === input.text
    ) {
      // 只把计数加到同一行上：**不**按流量累加 `bytes`（理由见 `bulk`）
      last.count += 1;
      this.emit({ type: 'entry', entry: { ...last } });
      return;
    }
    const entry: LogEntry = {
      day,
      t,
      deviceId: this.deviceId,
      dir: input.dir,
      kind: input.kind,
      text: input.text,
      raw: input.raw,
      bytes: input.bytes,
      count: 1,
      seq: ++this.seq,
    };
    this.buffer.push(entry);
    this.emit({ type: 'entry', entry: { ...entry } });
    if (this.buffer.length >= this.flushEntries) {
      void this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushMs);
    }
  }

  private emit(event: LogEvent): void {
    for (const cb of this.subscribers) cb(event);
  }
}
