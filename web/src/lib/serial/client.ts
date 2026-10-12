/**
 * 板子协议（v9）的客户端：把 `media/add`、`media/get`… 包装成普通 async 方法。
 *
 * ## 三条主线
 *
 * 1. **消息 ID 配对**。每条请求带一个自增编号（`~<id> …`），板子的应答原样带回那个号；
 *    我们只认**对在飞请求**的那一份，对不上的丢掉并记一笔。v8 是按"下一行就是回复"来猜的：
 *    打开串口会把板子复位、第一条命令丢在复位窗口里，于是后面的应答全部串一位 —— 界面上
 *    就是"黑海报 / 素材 0 帧 / 命令凭空报错"，还得靠 `settle` + 探针 + 排空队列去补救。
 * 2. **事件驱动**。板子主动推 `~0 ev …`（play / stop / item / loop / frame / error），
 *    由这里统一分发给 [`DeviceClient.onEvent`]，网页不必再每秒轮 `device/info`。
 * 3. **传输可打断**。上传/下载途中只有 `media/abort <被中断请求的 id>` 会被接受，走标签槽
 *    （`TAG_CTRL` + 一行控制帧），于是"取消"是一槽之内生效，不用等整份文件传完。
 *
 * 串口仍是**一问一答**（板子同一时刻只处理一条命令），所以普通操作排在一条队列上、并发恒为 1。
 * 只有 abort 例外：它就是发给"正在传输那一条"的插队消息，允许与被中断那条同时在飞。
 */
import type { Bytes } from '../bytes';
import { encodeRequest, isControl, parseControlLine, ReplyReader } from './frames';
import { Transport, TransportError, TransportTimeout } from './transport';
import { CHUNK_UP, GET_CHUNK_FALLBACK } from './wire';

/** **上传**方向一块的字节数：来自生成物 `wire.ts`，权威在 `crates/serial` */
export const CHUNK = CHUNK_UP;

/**
 * **回传**方向一块的字节数**兜底值**。真正的值由固件在 `device/info` 的 `chunk` 行里报
 * （C6 = 32、S3 = 512 —— 两块板的发送路径和串口带宽不一样）。为什么 C6 是 32：实测
 * 1024（16 个满包）和 64（正好填满 FIFO）都会卡，18 字节（没填满 FIFO）从来没出错 ——
 * 差别就在这一笔有没有把 TX FIFO（64B）填满。
 */
const GET_CHUNK_FALLBACK_BYTES = GET_CHUNK_FALLBACK;

/** 一次 `media/get` 命令最多回传这么多字节：够大不至于碎，又小到能让用户操作插进来 */
const GET_SLICE_BYTES = 16 * 1024;

const REPLY_TIMEOUT = 10_000;
/** 挂起期间等一句 `READY` / `DATA n`：每一截最多读这么久（到点回循环重看结论与deadline） */
const REPLY_READ_SLICE_MS = 200;
/** 一块载荷"空档"多久就认为板子把尾巴丢了：回 ACK 让它补发（要明显大于 esp-println 的重试窗口） */
const CHUNK_IDLE_MS = 100;
/** 第一块之后每一块的等待：固件接到 ACK 就立刻发下一块，不该等这么久 */
const CHUNK_FIRST_BYTE_MS = 300;
/** 已经收到过部分字节的块，最多再空转几轮（等补发 / 催重发）就放弃 */
const CHUNK_ROUNDS = 4;
/** 连上来第一次握手用这个超时：选错端口不该干等十秒 */
const HANDSHAKE_TIMEOUT = 2_500;
/**
 * 握手时一轮等待的时长（毫秒）。
 *
 * 打开串口会让板子复位（USB-Serial-JTAG 上 DTR/RTS 一变就是 `rst:0x15`），第一条
 * `device/info` 有可能整个丢在复位窗口里没人收（真机实测：第一条无声无息，1.2 秒后
 * 重发的那条 0.02 秒就回了）。所以每轮只等这么久，等不到就重发。
 *
 * 这件事**和协议无关**（消息 ID 也治不了"命令根本没被收到"），所以保留。有了配对之后
 * 重发是安全的：那份迟到的回执只会结算它自己那条请求。
 */
const HANDSHAKE_SLICE_MS = 1_200;
const READY_TIMEOUT = 15_000;
const DATA_TIMEOUT = 30_000;
const CHUNK_TIMEOUT = 15_000;
/** 取消一次传输：等板子回 abort 那条 `OK` 的上限（拿不到也算成功，被中断那条会先失败） */
const ABORT_REPLY_TIMEOUT = 1_500;
/** 取消回传时先把"已经许诺但没读完"的载荷吃掉的时间预算（别让它们变成垃圾行） */
const ABORT_DRAIN_MS = 200;

export class DeviceError extends Error {}

/**
 * 握手谈不下来：这个串口**不像是在跑 Pet Board 固件**。
 *
 * 和普通 `DeviceError` 分开，是为了让上层能区别对待：遇到它就把这个端口
 * "忘记"掉（省得刷新页面又白试一次），而"端口打不开（被 monitor 占着）"
 * 那种失败则要保留授权 —— 端口多半是对的，只是暂时用不了。
 */
export class HandshakeError extends Error {
  constructor(
    message: string,
    /** `silent` = 设备暂时没回；`nonsense` = 回了但不像我们的协议 */
    readonly kind: 'silent' | 'nonsense' = 'silent',
  ) {
    super(message);
  }
}

export interface DeviceInfo {
  /** 芯片出厂 MAC，网页拿它当缓存命名空间 */
  id: string;
  /** 协议版本 */
  api: number;
  /** 板子标识（`c6-lcd-147` / `s3-lcd-35`）；旧固件没有这一行时是空串 */
  board: string;
  /** `media/get` 回传方向一块的字节数，由固件按板子报出来 */
  chunk: number;
  /**
   * 这一次开机以来 `media/get` 的失败计数（固件的 `io` 行）。
   *
   * 这是**整机健康度**里唯一能拿到的证据：`txStuck` 不为 0 就说明回传时发送通道真的卡过。
   * 早期固件没有这一行时全是 0。
   */
  io: IoStats;
  reset: string;
  sd: string;
  screen: { width: number; height: number };
  /** 板子此刻是不是正在播 */
  playing: boolean;
  /** 正在播哪个文件 */
  item: string | null;
  /** 在播放清单里的序号（1 基） */
  index: number;
  /** 清单长度 */
  total: number;
  /** 当前条目播到第几轮 */
  loop: number;
  /** 当前条目播到第几帧（1 基）；固件没报这一项时是 0 */
  frame: number;
  /** 当前条目一共几帧；0 = 还不知道 */
  frames: number;
}

export interface IoStats {
  /** 失败总数 */
  failed: number;
  /** 其中"写不出去（TX 卡住）"的次数 */
  txStuck: number;
  /** 其中"等主机块 ACK 超时"的次数 */
  ackTimeout: number;
  /** 其中"主机自己先走了"的次数 */
  hostLeft: number;
  /** 补发过的块数合计 */
  resends: number;
}

interface MediaEntry {
  name: string;
  size: number;
  createdAt: Date;
}

export interface Progress {
  (sent: number, total: number): void;
}

/**
 * 这行像不像**旧固件**的裸报文（`OK` / `OK n` / `ERR …` / `READY` / `DATA n`）。
 *
 * 只在"有一条请求正在等回复"时用它：那时候外来文本多半就是这种回复（哨兵规则把它们
 * 变成了外来文本），而引导日志的形状是 `I (50) boot: …`，不会撞上这几个关键字。
 */
function isLegacyReply(line: string): boolean {
  return /^OK(?: \d+)?$/.test(line) || line.startsWith('ERR ') || line === 'READY' || /^DATA \d+$/.test(line);
}

/** 一条装配完成的应答（`OK n` 已经把正文读全） */
export type Answer =
  | { t: 'ok' }
  | { t: 'okLines'; lines: string[] }
  | { t: 'error'; message: string }
  | { t: 'ready' }
  | { t: 'data'; len: number };

/** 设备主动推的播放事件（`~0 ev …` 解析后的样子） */
export type PlaybackEvent =
  | { name: 'play' }
  | { name: 'stop' }
  | { name: 'item'; index: number; total: number; file: string }
  | { name: 'loop'; round: number }
  | { name: 'frame'; frame: number; frames: number }
  | { name: 'error'; message: string }
  /** 认不出的事件名/字段：原样带着 —— 新固件加事件不该把网页打崩 */
  | { name: string; args: string };

export interface EventListener {
  (event: PlaybackEvent): void;
}

/** `device/info` 的正文（`id` / `api` / `chunk` / …）→ [`DeviceInfo`] */
function parseInfo(lines: string[]): DeviceInfo {
  const fields = new Map<string, string>();
  for (const line of lines) {
    const at = line.indexOf(' ');
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1));
  }
  const [width, height] = (fields.get('screen') ?? '0 0').split(' ').map(Number);
  const [frame, frames] = (fields.get('frame') ?? '0 0')
    .split(' ')
    .map((value) => Number.parseInt(value, 10) || 0);
  // `io fail 0 tx_stuck 0 ack_timeout 0 host_left 0 resends 0`：名值成对，认不出的项忽略
  const counters = new Map<string, number>();
  const ioText = fields.get('io') ?? '';
  const ioParts = ioText.split(' ');
  for (let at = 0; at + 1 < ioParts.length; at += 2) {
    counters.set(ioParts[at]!, Number.parseInt(ioParts[at + 1]!, 10) || 0);
  }
  return {
    id: fields.get('id') ?? 'unknown',
    api: Number.parseInt(fields.get('api') ?? '0', 10),
    board: fields.get('board') ?? '',
    chunk: Number.parseInt(fields.get('chunk') ?? '0', 10) || GET_CHUNK_FALLBACK_BYTES,
    io: {
      failed: counters.get('fail') ?? 0,
      txStuck: counters.get('tx_stuck') ?? 0,
      ackTimeout: counters.get('ack_timeout') ?? 0,
      hostLeft: counters.get('host_left') ?? 0,
      resends: counters.get('resends') ?? 0,
    },
    reset: fields.get('reset') ?? '',
    sd: fields.get('sd') ?? '',
    screen: { width, height },
    playing: fields.get('playing') === '1',
    item: fields.get('item') ?? null,
    index: Number.parseInt(fields.get('index') ?? '0', 10),
    total: Number.parseInt(fields.get('total') ?? '0', 10),
    loop: Number.parseInt(fields.get('loop') ?? '0', 10),
    frame,
    frames,
  };
}

/** `ev <名> <字段…>` → [`PlaybackEvent`]（数字解析不了就交原文，别抛） */
function parseEvent(name: string, args: string): PlaybackEvent {
  const parts = args.split(' ');
  switch (name) {
    case 'play':
      return { name: 'play' };
    case 'stop':
      return { name: 'stop' };
    case 'item': {
      const index = Number.parseInt(parts[0] ?? '0', 10);
      const total = Number.parseInt(parts[1] ?? '0', 10);
      const file = parts.slice(2).join(' ');
      if (!Number.isFinite(index) || !Number.isFinite(total) || file === '')
        return { name, args };
      return { name: 'item', index, total, file };
    }
    case 'loop': {
      const round = Number.parseInt(parts[0] ?? '0', 10);
      return Number.isFinite(round) ? { name: 'loop', round } : { name, args };
    }
    case 'frame': {
      const frame = Number.parseInt(parts[0] ?? '0', 10);
      const frames = Number.parseInt(parts[1] ?? '0', 10);
      if (!Number.isFinite(frame) || !Number.isFinite(frames)) return { name, args };
      return { name: 'frame', frame, frames };
    }
    case 'error':
      return args === '' ? { name, args } : { name: 'error', message: args };
    default:
      return { name, args };
  }
}

/** 应答 → 给人看的一句话（错误文案用） */
function describeAnswer(answer: Answer): string {
  switch (answer.t) {
    case 'ok':
      return 'OK';
    case 'okLines':
      return `OK ${answer.lines.length}`;
    case 'error':
      return `ERR ${answer.message}`;
    case 'ready':
      return 'READY';
    case 'data':
      return `DATA ${answer.len}`;
  }
}

/**
 * 一条在飞请求：ID + 应答装配器 + 等下一步的挂起点。
 *
 * 行的装配用 `frames.ts` 的 `ReplyReader`（与 Rust 同一套规则，`~id OK n` 之后的 n 行
 * **不带哨兵**，所以"现在在读第几行"必须由状态机决定）。终态（`OK` / `OK n`+正文 / `ERR`）
 * 之后这条请求就结束了；`READY` / `DATA` 是"还没完"的中间结论，请求继续活着。
 */
class Request {
  readonly id: number;
  readonly command: string;
  private readonly reader = new ReplyReader();
  /** 装配好、还没被 [`next`] 取走的结论 */
  private readonly ready: Answer[] = [];
  private waiting: {
    resolve: (answer: Answer) => void;
    reject: (error: Error) => void;
  } | null = null;
  /** 板子已经回了终态 */
  finished = false;
  /**
   * 用户按了"取消"（[`DeviceClient.cancelTransfer`]）。
   *
   * 为什么不能只靠 `refused`：`refused` 是"板子回了 ERR"，而取消是我们单方面决定的，
   * 板子那边什么都还没说。传输循环每走完一步都重看这个标记，于是打断延迟的上限是
   * **一块 + 一次 ACK**（计划里定的那条）。
   */
  cancelled = false;
  /** 终态是不是 `ERR`（传输循环靠它提前收手，不必等 ACK 超时） */
  refused = false;
  /** 被拒绝的原因（`ERR` 后面那段原文） */
  error: string | null = null;
  /**
   * 板子回的是**不带哨兵**的老报文（v8 及更早：裸 `OK` / `ERR …`）。
   *
   * v9 只认 `~` 开头的行，这种回复会被当外来文本 —— 但它在"我们正等这条请求的回复"时
   * 冒出来，说明对面**对得上话、只是协议太旧**。这时候要报"重新烧录"，不能报
   * "这不是 Pet Board 设备"（那会撤掉端口授权，用户重插也没用）。
   */
  legacy: string | null = null;

  constructor(id: number, command: string) {
    this.id = id;
    this.command = command;
  }

  /** 收到属于本请求的一行：装配，装配出结论就喂给等待者 */
  push(line: string): void {
    const step = this.reader.feedLine(line);
    switch (step.t) {
      case 'body':
      case 'ignored':
        return;
      case 'broken':
        this.deliver({ t: 'error', message: `应答读崩：${step.line}` });
        return;
      case 'done': {
        const reply = step.message.reply;
        if (reply.t === 'ready') this.deliver({ t: 'ready' });
        else if (reply.t === 'data') this.deliver({ t: 'data', len: reply.len });
        else if (reply.t === 'error') this.deliver({ t: 'error', message: reply.message });
        else if (reply.t === 'ok') this.deliver({ t: 'ok' });
        else this.deliver({ t: 'error', message: `没料到的应答：${reply.t}` });
        return;
      }
      case 'complete':
        this.deliver({ t: 'okLines', lines: step.lines });
    }
  }

  private deliver(answer: Answer): void {
    const terminal = answer.t === 'ok' || answer.t === 'okLines' || answer.t === 'error';
    if (terminal) {
      this.finished = true;
      if (answer.t === 'error') {
        this.refused = true;
        this.error = answer.message;
      }
    }
    const target = this.waiting;
    if (target === null) {
      this.ready.push(answer);
      return;
    }
    this.waiting = null;
    target.resolve(answer);
  }

  /** 非阻塞地取一个已经装配好的结论（传输挂起时，行由传输代码自己读进来） */
  poll(): Answer | null {
    return this.ready.shift() ?? null;
  }

  /** 下一个结论；没有就等，超时抛 [`TransportTimeout`] */
  next(timeoutMs: number): Promise<Answer> {
    const pending = this.ready.shift();
    if (pending !== undefined) return Promise.resolve(pending);
    if (this.finished) {
      return Promise.reject(new DeviceError(this.error ?? '这条请求已经结束'));
    }
    return new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new TransportTimeout(`等设备回话超时（${timeoutMs} ms）`));
      }, Math.max(1, timeoutMs));
      this.waiting = {
        resolve: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  /**
   * 现在是不是在等 `~id OK <n>` 之后的正文行（那些行**不带哨兵**，见 `frames.ts`）。
   *
   * 分发器据此决定"一行普通文本归谁"——归谁由状态机决定，绝不由字节内容决定。
   */
  awaitingBody(): boolean {
    return !this.finished && this.reader.awaitingBody();
  }

  /** 我们不等了（超时/断线）：把等待者掐掉 */
  abandon(reason: string): void {
    this.finished = true;
    const target = this.waiting;
    this.waiting = null;
    target?.reject(new DeviceError(reason));
  }
}

export class DeviceClient {
  /**
   * 最近一次 `device/info` 的结果：只用来取"回传块大小"这种跨命令的参数
   * （`media/get` 必须按固件宣告的那个数分块）。没握过手时是 null。
   */
  private lastInfo: DeviceInfo | null = null;

  /** 下一条请求的编号：从 1 起递增。**新建一个 client 就是重连**，计数从 1 重来。 */
  private nextId = 1;

  /** 在飞请求：正常只有一条，`media/abort` 允许与被中断那条同时在飞 */
  private readonly inflight = new Map<number, Request>();

  /** 事件监听者（`useDevice` 用它驱动播放状态） */
  private readonly listeners = new Set<EventListener>();

  /** 现在正在传输的那条请求（`cancelTransfer()` 按它发 abort） */
  private transfer: Request | null = null;

  /** 收到过几次设备事件（播放状态降级回轮询的判据） */
  private eventCount = 0;

  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly transport: Transport) {
    // 背景分发器：读到的行由这里判配，而不是"谁在等就读一行"
    transport.setLineHandler((line) => this.dispatch(line));
  }

  /** 断开时取掉分发器并掐掉所有在飞请求 */
  detach(): void {
    this.transport.clearLineHandler();
    this.transport.setRaw(false);
    for (const request of this.inflight.values()) request.abandon('串口已关闭');
    this.inflight.clear();
    this.transfer = null;
  }

  /** 订阅设备主动推的事件；返回取消订阅 */
  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 连着、但一个事件都没收到（旧固件/板子没在播）→ 上层该降级回轮询 */
  get receivedEvents(): boolean {
    return this.eventCount > 0;
  }

  // ---------------------------------------------------------------- 分发

  /**
   * 一行文本 → 要么配给在飞请求，要么是事件，要么丢掉。
   *
   * 不以 `~` 开头的行（引导日志、defmt 碎片）一律当外来文本丢掉 —— 这条哨兵规则是整个
   * v9 的地基（见 `frames.ts`）。
   */
  private dispatch(line: string): void {
    if (!isControl(line)) {
      this.dispatchBodyLine(line);
      return;
    }
    const message = parseControlLine(line);
    if (message === null) return;
    if (message.id === 0) {
      if (message.reply.t === 'event') {
        this.eventCount += 1;
        const event = parseEvent(message.reply.name, message.reply.args);
        for (const listener of this.listeners) listener(event);
      }
      return;
    }
    const target = this.inflight.get(message.id);
    if (target === undefined) {
      // 对不上号：多半是"握手重发"多换来的那一份，或上一轮传输迟到的收尾。
      // 记一笔，丢掉 —— v8 那套 settle / 排空 / 探针全部不需要了。
      this.transport.log?.note(`丢掉对不上号的应答（req ${message.id}）：${line}`);
      return;
    }
    target.push(line);
    if (target.finished) this.inflight.delete(target.id);
  }

  /**
   * 正文行（`~id OK <n>` 之后那 n 行，不带哨兵）交给**正在等正文**的那条请求。
   *
   * 为什么要单独一条路：`device/info` 的 `id …` / `api …` 行本来就要给人看，故意不带哨兵
   * （和 Rust 的 `ReplyReader` 一致）。所以"这一行归谁"由状态机决定（谁在等正文），
   * 绝不由字节内容决定 —— 同时最多只有一条请求在等正文（一问一答）。
   */
  private dispatchBodyLine(line: string): void {
    // 一问一答：同时最多只有一条请求处在"等正文"的状态，扫到就交给它
    for (const request of this.inflight.values()) {
      if (!request.awaitingBody()) continue;
      request.push(line);
      return;
    }
    // 认一下"不带哨兵的老报文"（`ERR unknown command` 这类）：只有在有人等回复时才算数
    for (const request of this.inflight.values()) {
      if (request.finished || request.legacy !== null || !isLegacyReply(line)) continue;
      request.legacy = line;
      return;
    }
    // 没人在等正文：多半是上一次传输迟到的收尾，或引导日志漏网的碎片。丢掉并记一笔。
    this.transport.log?.note(`丢掉没人在等的一行：${line}`);
  }

  // ---------------------------------------------------------------- 请求

  /** 把操作排进唯一的串口队列 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(
      () => {
        // 轮到这条命令了：上一条要么已经拿到自己的结论、要么已经作废，此刻队列里剩下的
        // 字节只可能是残骸（上一次传输晚到的尾巴）。先清管道再发请求 —— 不清的话它会被当成
        // 本次载荷的开头读走：**整段错位一个字节，而每一段都读满了自己要求的长度，谁都发现不了**。
        // `.ANM` 的位图 popcount 跟着变，网页就画出一张**花掉的**首帧图（板子播的是卡上那份
        // 完整文件，所以只有网页会花）。半行也一样要丢，否则本次的回执会被粘成一行垃圾。
        this.transport.resync();
        return task();
      },
      task,
    );
    // 队列本身不能因为某条命令失败就断掉
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 发一条请求（不等应答），返回它的在飞记录 */
  private begin(command: string): Request {
    const id = this.nextId;
    this.nextId += 1;
    const request = new Request(id, command);
    this.inflight.set(id, request);
    // 这一行不再自己记 `tx`：`write(字符串)` 会把原文记一次（`Transport.logWrite`）
    const frame = encodeRequest(id, command);
    // 用 `writeRequest` 而不是 `write`：设备的发送窗口里请求会整包消失（见那里的说明）
    this.transport.writeRequest(`${frame}\n`).catch((error: unknown) => {
      this.inflight.delete(id);
      request.abandon(error instanceof Error ? error.message : String(error));
    });
    return request;
  }

  /** 只**占号**并登记在飞，不写字节（传输途中的 abort 要把整帧包进标签槽） */
  private prepare(command: string): Request {
    const id = this.nextId;
    this.nextId += 1;
    const request = new Request(id, command);
    this.inflight.set(id, request);
    return request;
  }

  /** 一问一答：发命令、等一条完整应答 */
  private async ask(command: string, timeoutMs = REPLY_TIMEOUT): Promise<Answer> {
    const request = this.begin(command);
    try {
      return await request.next(timeoutMs);
    } catch (error) {
      // 超时：明确告诉板子我们不等了（否则它会守着这条命令直到自己的超时）
      this.inflight.delete(request.id);
      if (error instanceof TransportTimeout) {
        // 此刻没有正在进行的传输（串口队列是一问一答），所以 abort 走普通一行
        await this.sendAbort(request.id, false).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * **挂起期间**（传输进行中）等这条请求的下一个结论：自己按行读，不等背景分发器。
   *
   * 为什么不能等背景分发器：`raw` 开着的时候它不碰队列（不然载荷里的 `0x0a` 会造出假行、
   * `~` 会触发哨兵切行，两种都会吃掉真字节）。而传输开头的 `READY` / `DATA n` 后面紧跟裸
   * 载荷，必须"读到行尾换行为止就停手"—— [`Transport.readLine`] 正是这个语义，剩下的字节
   * 原样留在队列里给 [`Transport.readUpTo`]。
   *
   * 读到的行按和 [`dispatch`] 同一套规则处理（控制帧配号、`~0` 走事件、老报文记 `legacy`），
   * 所以传输途中板子说的话不会丢。
   */
  private async awaitAnswer(request: Request, timeoutMs: number): Promise<Answer> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ready = request.poll();
      if (ready !== null) return ready;
      if (request.legacy !== null) {
        throw new DeviceError(
          `设备不接受这次命令（旧报文「${request.legacy}」）—— 检测到旧固件，请重新烧录`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransportTimeout(`等设备回话超时（${timeoutMs} ms）`);
      let line: string;
      try {
        line = await this.transport.readLine(Math.min(remaining, REPLY_READ_SLICE_MS));
      } catch (error) {
        // 这一截没读到行：回循环重看"结论是否已经到手 / 有没有过期"
        if (error instanceof TransportTimeout) continue;
        throw error;
      }
      this.transport.log?.line('rx', line);
      if (isControl(line)) this.dispatch(line);
      else if (request.legacy === null && isLegacyReply(line)) request.legacy = line;
      // 既不是控制帧也不是老报文：板子的日志碎片/杂音，丢掉
    }
  }

  /** 这条命令只该回 `OK`（带不带正文都行） */
  private async expectOk(answer: Answer): Promise<void> {
    if (answer.t !== 'ok' && answer.t !== 'okLines') {
      throw new DeviceError(`没料到的应答：${describeAnswer(answer)}`);
    }
  }

  private bodyOf(answer: Answer): string[] {
    return answer.t === 'okLines' ? answer.lines : [];
  }

  // ---------------------------------------------------------------- 命令

  async info(options: { timeoutMs?: number } = {}): Promise<DeviceInfo> {
    const timeoutMs = options.timeoutMs ?? REPLY_TIMEOUT;
    return this.enqueue(async () => {
      const answer = await this.ask('device/info', timeoutMs);
      // 记下来给后续命令用（`media/get` 的分块要和固件一致）
      this.lastInfo = parseInfo(this.bodyOf(answer));
      return this.lastInfo;
    });
  }

  /**
   * 回传块大小；**还没握过手就先问一次**。
   *
   * 不能直接用兜底值：兜底是 C6 的 32，而 S3 板子按自己宣告的 512 发块 —— 主机每收 32
   * 就回一次"实收 32"，板子就永远在补发同一块的尾巴，下载直接卡死（要等超时才收手）。
   * 上一轮真机的"每一次 media/get 都失败"是这个数不一致，方向反过来同样坏，所以这里
   * 不再信任调用方"应该先握过手了"，缺信息就自己去取。
   */
  private async getChunkSync(): Promise<number> {
    if (this.lastInfo === null) await this.info();
    return this.getChunk();
  }

  /** 已经知道块大小（握过手）——`get` 在排队**之前**用它确认一次 */
  private get chunkKnown(): boolean {
    return this.lastInfo !== null;
  }

  /**
   * 当前设备报的回传块大小（由 `device/info` 的 `chunk` 行给出：C6 = 32、S3 = 512）。
   *
   * **必须和固件分块一致**：主机按这个数收、固件按这个数发，对不上就会一直等不到整块。
   * 上一轮真机的"每一次 `media/get` 都失败"就是这个数不一致（板子报 512、固件写死 32）。
   */
  private getChunk(): number {
    return this.lastInfo?.chunk ?? GET_CHUNK_FALLBACK_BYTES;
  }

  /**
   * 连上来的第一次握手：`device/info` + **短超时** + 说人话的错误。
   *
   * 选错端口时用户应该在两三秒内看到"这不像 Pet Board 设备"，而不是干等十秒再看到一句超时。
   * 为什么要重发：打开串口本身就复位板子，第一条命令可能整个丢在复位窗口里（真机实测）。
   */
  async probe(timeoutMs = HANDSHAKE_TIMEOUT): Promise<DeviceInfo> {
    const deadline = Date.now() + timeoutMs;
    try {
      return await this.enqueue(async () => {
        let last: unknown = new TransportTimeout('未收到设备回执');
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw last;
          const request = this.begin('device/info');
          try {
            const answer = await request.next(Math.min(remaining, HANDSHAKE_SLICE_MS));
            const info = parseInfo(this.bodyOf(answer));
            this.lastInfo = info;
            return info;
          } catch (error) {
            this.inflight.delete(request.id);
            // 旧固件：它回了话，只是报文不带 `~`（见 `isLegacyReply`）。别重发、也别报
            // "不是本设备"（那会撤掉端口授权），直接一句"检测到旧固件，请重新烧录"。
            if (request.legacy !== null) {
              throw new DeviceError(
                `设备不接受 device/info（旧报文「${request.legacy}」）—— 检测到旧固件，请重新烧录`,
              );
            }
            // 只有"这一截连一行都没等到"才重发：设备可能还在 boot，或命令丢在复位里。
            // `ERR …`、正文读崩这些说明协议对得上，交给下面的分类处理。
            if (!(error instanceof TransportTimeout)) throw error;
            last = error;
          }
        }
      });
    } catch (error) {
      const silent = error instanceof TransportTimeout;
      const nonsense = error instanceof DeviceError && error.message.startsWith('没料到的应答');
      if (silent) {
        // 一条回执都没等到：两种原因对用户来说要做的事完全不同，所以文案里都写出来。
        // 上层（`useDevice`）如果知道这条口刚才还通，会替换成"拔插 USB 线"那句。
        throw new HandshakeError(
          '没等到任何回执：可能是选错了端口，也可能板子的 USB 串口卡死了（后者拔插一次 USB 线就能恢复）。',
          'silent',
        );
      }
      if (nonsense) {
        throw new HandshakeError('这个端口回的报文不是 Pet Board 协议，多半是选错端口了。', 'nonsense');
      }
      // 它按行协议回了 `ERR …` —— 说明对得上话，只是不认 `device/info`，多半是固件太旧。
      // 这种别当"别的设备"踢掉，给一句能照做的提示。
      if (error instanceof DeviceError) {
        throw new DeviceError(
          `设备不接受 device/info（${error.message}）—— 检测到旧固件，请重新烧录`,
        );
      }
      throw error;
    }
  }

  async list(): Promise<MediaEntry[]> {
    return this.enqueue(async () => {
      const answer = await this.ask('media/list');
      return this.bodyOf(answer).map((line) => {
        const [name, size, year, month, day, hour, minute, second] = line.split(' ');
        return {
          name,
          size: Number.parseInt(size, 10),
          createdAt: new Date(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hour),
            Number(minute),
            Number(second),
          ),
        };
      });
    });
  }

  /**
   * 上传一个文件到 `data/<name>`（每槽 `TAG_DATA` + 载荷，逐块等 ACK）。
   *
   * 传输期间背景分发器是挂起的（那些字节是裸的，不能按行消费）：`READY` 由 `awaitAnswer`
   * 自己按行读，板子在槽边界想说的话（`ERR`）由 `waitAck` 按首字节 `~` 切出来交给分发器 ——
   * 于是失败原因不会被 ACK 循环吞掉，这条循环也能立刻收手。
   */
  async add(name: string, payload: Uint8Array, onProgress?: Progress): Promise<void> {
    return this.enqueue(async () => {
      // 挂起要**早于**发请求：`READY` 那一行的换行后面紧跟的就是裸载荷，晚一步就会被
      // 背景分发器当文本咬掉几个字节（表现是"偶尔少几个字节 / 校验不上"）
      this.transport.setRaw(true);
      const request = this.begin(`media/add ${name} ${payload.length}`);
      this.transfer = request;
      try {
        const first = await this.awaitAnswer(request, READY_TIMEOUT);
        if (first.t !== 'ready') {
          throw new DeviceError(`没料到的应答：${describeAnswer(first)}`);
        }

        for (let sent = 0; sent < payload.length; sent += CHUNK) {
          // 取消的检查点（一槽一次）：串口正好停在槽边界，写/读都只有这一个主人
          if (request.cancelled) throw new DeviceError('已取消上传');
          const end = Math.min(sent + CHUNK, payload.length);
          await this.transport.writeDataSlot(payload.subarray(sent, end));
          if (request.refused) throw new DeviceError(request.error ?? '设备拒绝接收');
          await this.transport.waitAck(CHUNK_TIMEOUT, () => request.refused || request.cancelled);
          if (request.cancelled) throw new DeviceError('已取消上传');
          onProgress?.(end, payload.length);
        }

        // 载荷发完了：最后一块的两个 ACK 字节是非可打印的，扫描器会直接丢掉，
        // 于是这里恢复行模式就能扫出那句 `~id OK`
        this.transport.setRaw(false);
        await this.expectOk(await request.next(CHUNK_TIMEOUT));
      } catch (error) {
        if (request.cancelled) throw new DeviceError('已取消上传');
        if (request.refused) throw new DeviceError(request.error ?? '设备拒绝接收');
        throw error;
      } finally {
        // 顺序要紧：先恢复行模式（abort 的回执是文本），再发 abort 那一槽，再等它自己那条
        this.transport.setRaw(false);
        if (!request.finished) {
          this.inflight.delete(request.id);
          // 上传半途而废：板子可能正回着一个块 ACK（`06 09`），那两个字节的残留会让
          // **下一次回传**的第一块少收两个字节 → 整段错位。登记一笔，让下一条命令开头清掉。
          this.transport.markStaleRx();
          await this.sendAbort(request.id, true).catch(() => undefined);
        }
        this.transfer = null;
      }
    });
  }

  /**
   * 从 `data/<name>` 读一段（缺省整份）。
   *
   * 每块都按"先收、再回带实收字节数的 ACK"来：板子发送时会丢尾巴（见 `Transport.readUpTo`），
   * 主机的计数就是让它把缺的那几个字节补上 —— 一次补发几十字节，而不是整块重传或等超时。
   *
   * 带 `length` 且比较长时**分几条命令**读（每条最多 `GET_SLICE_BYTES`）：串口只有一条队列，
   * 一口气读完 100 KiB 要好十几秒，这期间用户点的删除/预览只能干等（"点了没反应"）。切成小段
   * 之后，用户中途排进来的命令能插在中间，最多等一段。
   */
  async get(
    name: string,
    options: { offset?: number; length?: number; onProgress?: Progress; timeoutMs?: number } = {},
  ): Promise<Bytes> {
    const { offset = 0, length, onProgress, timeoutMs = DATA_TIMEOUT } = options;
    // 进队列之前先确认回传块大小：到了队列里就没法再发 `device/info`（会和自己排的那条撞死）。
    // 少了这一步，没握手就下载会按兜底值 32 收块、板子按 512 发块，两边永远对不上。
    if (!this.chunkKnown) await this.getChunkSync();
    if (length !== undefined && length > GET_SLICE_BYTES) {
      const out = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const want = Math.min(GET_SLICE_BYTES, length - filled);
        const chunk = await this.get(name, { offset: offset + filled, length: want, timeoutMs });
        out.set(chunk, filled);
        filled += want;
        onProgress?.(filled, length);
      }
      return out;
    }

    return this.enqueue(async () => {
      const args = length === undefined ? '' : ` ${offset} ${length}`;
      // 挂起早于发请求（理由同 `add`）；`DATA n` 由 `awaitAnswer` 自己按行读
      this.transport.setRaw(true);
      const request = this.begin(`media/get ${name}${args}`);
      this.transfer = request;
      let total = 0;
      let filled = 0;
      try {
        const header = await this.awaitAnswer(request, timeoutMs);
        if (header.t !== 'data') throw new DeviceError(`没料到的应答：${describeAnswer(header)}`);
        total = header.len;
          if (!Number.isFinite(total) || total <= 0) throw new DeviceError(`长度不对：${total}`);
        const buffer = new Uint8Array(total);

        while (filled < total) {
            // 一块的大小必须和固件报的一致（见 `DeviceInfo.chunk`），最后一块是余数
            const want = Math.min(this.getChunk(), total - filled);
            let got = 0;
            let silent = 0;
            let acked = false;
            while (got < want) {
              if (request.cancelled) throw new DeviceError('已取消下载');
              if (request.refused) throw new DeviceError(request.error ?? '设备中止了这次读取');
              const firstRound = got === 0 && silent === 0;
              const chunk = await this.transport.readUpTo(want - got, {
                // 第一块的第一轮可能要等固件读卡；之后每一轮只等一个"空档"，
                // 丢掉的尾巴靠 ACK 催固件补发（`CHUNK_IDLE_MS` 就够）
                firstByteMs: firstRound && filled === 0 ? timeoutMs : CHUNK_FIRST_BYTE_MS,
                idleMs: CHUNK_IDLE_MS,
                deadlineMs: timeoutMs,
                // 取消登记后 nudge 会叫醒这里：带着手里的字节立刻回去走检查点
                stopped: () => request.cancelled,
              });
              if (chunk.length > 0) {
                buffer.set(chunk, filled + got);
                got += chunk.length;
                silent = 0;
                acked = true;
                // 回带"这一块我收到多少了"：少了固件只补发缺的那几个字节
                await this.transport.writeAck(got);
                continue;
              }
              silent += 1;
              // 一个字节都没到的块：**只再试一次就收手**。固件要么还在读卡、要么这块整块丢了，
              // 一块块磨下去会让上层等好几分钟（"一直停在准备预览…"就是这么来的）。
              if (silent > (acked ? CHUNK_ROUNDS : 1)) {
                throw new TransportTimeout(
                  `等载荷超时（收到 ${filled + got}/${total} 字节，第 ${silent} 轮）`,
                );
              }
              // 已经回过 ACK 了 → 再回一次同样的计数，催固件重发缺的尾巴。
              // 一个字节都没收到时**不能**回 0：那时固件可能还在读卡，回 0 会让它从头重发一整块。
              if (acked) await this.transport.writeAck(got);
            }
            filled += want;
            onProgress?.(filled, total);
          }

          // 末尾那句 `OK` 用这次读的超时（不是默认 10 秒）：读崩时主机已经先放弃了，
          // 盯着一个永远不会来的回执干等 10 秒没有意义。
        // 载荷收齐：恢复行模式，扫出末尾那句 `~id OK`
        this.transport.setRaw(false);
        await this.expectOk(await request.next(timeoutMs));
        return buffer;
      } catch (error) {
        if (request.cancelled) throw new DeviceError('已取消下载');
        if (request.refused) throw new DeviceError(request.error ?? '设备中止了这次读取');
        throw error;
      } finally {
        if (!request.finished) {
          this.inflight.delete(request.id);
          // 我们不等了：把"已经许诺但没读到"的字节先吃掉（它们已经在路上，还在挂起时
          // 按裸字节取走，不会被行扫描器咬碎），再发 abort 让板子停手（不补零、不拖满超时）。
          if (total > 0 && filled < total) {
            // 取消时残字节多半已经在 USB 管道里：只等很短一下，别拖慢"取消"的响应
            const budget = request.cancelled ? Math.min(ABORT_DRAIN_MS, 60) : ABORT_DRAIN_MS;
            const dropped = await this.transport.drain(total - filled, budget).catch(() => 0);
            // `drain` 只等一小会儿：**没等完的残字节就是错位的来源**。登记一笔，
            // 让下一条命令开头（`enqueue` 里）把管道彻底清掉。
            if (dropped < total - filled) this.transport.markStaleRx();
          }
          await this.sendAbort(request.id, true).catch(() => undefined);
        }
        // abort 那一槽写完了才恢复行模式：它的回执是文本，得让分发器扫得出来
        this.transport.setRaw(false);
        this.transfer = null;
      }
    });
  }

  /**
   * 和 [`get`] 一样读一段，但**允许中途读崩**：把已经读到的字节交出来，`complete` 说明读全没。
   *
   * 串口的偶发丢字节不该让整次读取作废：悬停预览只要开头那几帧，`decodeAnm` 又只会解
   * **完整**的帧 —— 把能读到的部分交出去，预览就能播几帧是几帧。
   * 每段失败后重试 `retries` 次（默认 1 次），还不行就带着部分结果返回。
   */
  async getPartial(
    name: string,
    options: { offset?: number; length: number; timeoutMs?: number; retries?: number },
  ): Promise<{ bytes: Bytes; complete: boolean }> {
    const { offset = 0, length, timeoutMs = DATA_TIMEOUT, retries = 1 } = options;
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const want = Math.min(GET_SLICE_BYTES, length - filled);
      let attempt = 0;
      for (;;) {
        try {
          const chunk = await this.get(name, { offset: offset + filled, length: want, timeoutMs });
          out.set(chunk, filled);
          filled += want;
          break;
        } catch (failure) {
          if (attempt >= retries) return { bytes: out.subarray(0, filled), complete: false };
          attempt += 1;
        }
      }
    }
    return { bytes: out, complete: true };
  }

  /**
   * 发一条 `media/abort <id>` 并等它自己的回执。
   *
   * **只有传输循环能调用它**（在它的检查点上）。原因：传输期间读字节的一方是
   * `waitAck` / `readUpTo`，别处再开一个读取就和它抢同一个队列，谁先拿到字节谁把它咬碎。
   * 所以取消的写法是：`cancelTransfer()` 只**登记**取消并 nudge 唤醒正在等的读取，传输循环
   * 走到槽边界时调用这里 —— 那时候循环已经退出，写字节、读行都只有一个主人。
   *
   * 走标签槽时顺序固定：写这一槽（仍挂着）→ 恢复行模式 → 等这条 abort 自己的回执。
   *
   * `viaSlot` = 传输途中（裸字节模式，整帧包在 `TAG_CTRL` 槽里）；`false` = 空闲时
   * （我们只是超时放弃了某条命令），它就是普通的一行请求，走背景分发器。
   */
  private async sendAbort(id: number, viaSlot: boolean): Promise<boolean> {
    const command = `media/abort ${id}`;
    const request = viaSlot ? this.prepare(command) : this.begin(command);
    const frame = encodeRequest(request.id, command);
    if (viaSlot) {
      // 还在挂起时写这一槽（此时串口停在槽边界，裸载荷不会被行扫描器咬碎），写完
      // **立刻**恢复行模式：abort 的回执是文本，挂着的时候没人读它，只会等一个超时。
      await this.transport.writeControlSlot(frame);
      this.transport.log?.line('tx', frame);
      this.transport.setRaw(false);
    }
    try {
      const answer = await request.next(ABORT_REPLY_TIMEOUT);
      return answer.t === 'ok' || answer.t === 'okLines';
    } catch {
      // 没等到 abort 自己的回执也没关系：被中断那条会先以 `ERR aborted` 失败，
      // 界面已经能出结果。这条请求就此作废。
      this.inflight.delete(request.id);
      return false;
    }
  }

  /**
   * 取消**正在进行**的上传 / 回传。
   *
   * 这里只登记取消并叫醒正在等字节的读取（[`Transport.nudge`]），**不碰串口字节**：
   * abort 那一槽由传输循环在自己的检查点上发（见 [`sendAbort`] 里为什么必须这样）。
   * 所以返回的是"取消有没有登记上"，不是"板子有没有确认"。
   */
  async cancelTransfer(): Promise<boolean> {
    const request = this.transfer;
    if (request === null || request.finished) return false;
    request.cancelled = true;
    this.transport.nudge();
    return true;
  }

  async remove(name: string): Promise<void> {
    return this.enqueue(async () => {
      await this.expectOk(await this.ask(`media/delete ${name}`));
    });
  }

  /** `media/play [<名字>]`：按卡上的播放清单整表循环播（`OK` 只代表已开始） */
  async play(start?: string): Promise<void> {
    return this.enqueue(async () => {
      const suffix = start === undefined ? '' : ` ${start}`;
      await this.expectOk(await this.ask(`media/play${suffix}`));
    });
  }

  /** `media/stop`：停止播放；没在播也回 OK（幂等） */
  async stop(): Promise<void> {
    return this.enqueue(async () => {
      await this.expectOk(await this.ask('media/stop'));
    });
  }

  async bench(name: string, mib?: number): Promise<string[]> {
    return this.enqueue(async () => {
      const suffix = mib === undefined ? '' : ` ${mib}`;
      return this.bodyOf(await this.ask(`media/bench ${name}${suffix}`));
    });
  }
}

/** 传输错误也归一到"设备错误"这一层，方便上层分诊 */
export { TransportError };
