/**
 * 测试用的假板子：**按 v9 真的跑一遍协议**。
 *
 * 它是"协议精确的假设备"：分块节奏、ACK 形状、标签槽、消息 ID、主动推的事件，全部和
 * 真固件一致，这样协议层在没有硬件的情况下也能被验到。为避免"另一份会漂移的真相"，
 * 这里的**行切分与帧编解码都复用 `frames.ts` / `wire.ts`**（网页正式链路用的同一份），
 * 而不是再手写一套字符串拼接。
 *
 * 故障注入开关（`muteInfo` / `noiseReply` / `bootLines` / `dropInfo` / `failNextUpload` /
 * `failNextDownloads`）一个都没删 —— 真机踩过的形状要靠它们在这里重放。
 */
import {
  SentinelScanner,
  encodeData,
  encodeEnd,
  encodeErr,
  encodeEvent,
  encodeOk,
  encodeOkLines,
  encodeReady,
  isControl,
  parseControlLine,
} from './frames';
import type { SerialPortLike } from './transport';
import { API_VERSION, CHUNK_ACK, CHUNK_UP, EVENTS, TAG_CTRL, TAG_DATA } from './wire';

/**
 * 回传方向一块的字节数**默认值**（C6 的实测值：小于 FIFO 深度 64B，每一笔都不会把 FIFO 填满）。
 *
 * 真正分块用的是 [`FakeBoard.chunk`] —— 也就是 `device/info` 对外宣告的那一个；两者对不上
 * （比如宣告 512 却按 32 分块）在测试里也会把下载做坏。
 */
const DEFAULT_GET_CHUNK = 32;

/** 板子 → 主机：一条应答 */
type BoardReply =
  /** 单行结论（`OK` / `ERR` / `READY` / `DATA n`） */
  | { t: 'line'; text: string }
  /** 带正文：`OK n` + n 行 + `END` */
  | { t: 'lines'; head: string; body: string[]; end: string };

type Mode = 'idle' | 'upload' | 'download' | 'closed';

export class FakeBoard implements SerialPortLike {
  readonly files = new Map<string, Uint8Array>();
  /** 收到的**请求正文**（去掉 `~<id> ` 外壳），测试按它断言"网页发了什么命令" */
  readonly log: string[] = [];
  /** 收到的每一条请求的编号（测试用它断言"重连后 ID 重置"） */
  readonly requestIds: number[] = [];
  readonly deviceId = 'aa:bb:cc:dd:ee:ff';
  apiVersion = API_VERSION;
  /** 板子标识（`device/info` 的 `board` 行） */
  board = 'c6-lcd-147';
  /** 回传方向一块的字节数（`device/info` 的 `chunk` 行） */
  chunk = DEFAULT_GET_CHUNK;
  /** `media/get` 的失败计数（`device/info` 的 `io` 行）；真机上这是"本次开机"的累计 */
  io = { failed: 0, txStuck: 0, ackTimeout: 0, hostLeft: 0, resends: 0 };
  /** 模拟**旧固件**：`device/info` 里没有 `io` 那一行 */
  withoutIoLine = false;
  /** 屏幕尺寸（画布 = 屏幕四周各留 4px） */
  screenWidth = 320;
  screenHeight = 172;
  /** 打开之后对 `device/info` 一声不吭（模拟"插了个别的 USB 串口设备"） */
  muteInfo = false;
  /** 收到 `device/info` 时改成回这行原文（模拟"说话了，但不是我们的协议"） */
  noiseReply: string | null = null;
  /**
   * 打开端口时先吐出的**引导加载器日志**（模拟"打开串口把板子复位了"）。
   *
   * 真机上最后一行不带换行，固件的回执会直接接在它屁股后面，照这个形状发，别自己加换行。
   */
  bootLines: string[] = [];
  /** 开头几条 `device/info` 直接吞掉不回答（命令字节丢在复位窗口里） */
  dropInfo = 0;
  /** 假板子当前是不是在播 */
  playing = false;
  playingItem: string | null = null;
  /** 播放进度：当前第几帧 / 共几帧 */
  frame = 0;
  frames = 0;
  /** 在播放清单里的序号 / 清单长度（`ev item` 的两个数字） */
  itemIndex = 0;
  itemTotal = 0;
  /** `media/add` 之前先回一行 ERR（测错误路径） */
  failNextUpload: string | null = null;
  /**
   * 接下来几次 `media/get` **每一轮最多发多少字节**（`null` / 队列空 = 不限，`0` = 一个字节都不发）。
   * 用来模拟"发送路径丢尾巴"和"整块丢掉"两条路径。
   */
  failNextDownloads: (number | null)[] = [];
  /** 因为主机报告"少收了"而补发过几次（测试观察用） */
  resends = 0;
  /** `media/play` 被调了几次 */
  played = 0;
  /** `media/stop` 被调了几次 */
  stopped = 0;
  /** `media/abort` 被调了几次（测试断言"取消真的发出去了"） */
  aborted = 0;
  /** 被中断那条请求的编号（`media/abort <id>` 的参数） */
  abortedId: number | null = null;
  /** 点名点错了的 abort（陈旧取消）被丢了几次 */
  staleAborts = 0;
  readonly benchRuns: string[] = [];

  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;

  private controller!: ReadableStreamDefaultController<Uint8Array>;
  /** 行切分复用正式链路那份扫描器（哨兵规则只有一处实现） */
  private readonly scanner = new SentinelScanner();
  private mode: Mode = 'idle';
  private upload: {
    id: number;
    name: string;
    len: number;
    got: Uint8Array;
    received: number;
    /** 这一槽在等什么：`tag` 等标签字节、`data` 等载荷、`ctrl` 等一行控制帧 */
    slot: 'tag' | 'data' | 'ctrl';
    /** `slot === 'data'` 时这一槽还要几个字节 */
    need: number;
  } | null = null;
  private download: {
    id: number;
    data: Uint8Array;
    /** 已经被主机确认收全的字节数（块对齐） */
    sent: number;
    /** 当前这一块主机报告收到了多少 */
    chunkGot: number;
    /** 这一轮最多发多少字节（模拟发送路径丢尾巴） */
    cap: number | null;
    /** 本次传输的分块大小：取开始传输那一刻宣告的 `chunk` */
    size: number;
    /** 在等 ACK 时攒到的字节（前缀 + 实收计数） */
    ack: number[];
    /** 这一槽在等什么：`ack` 等 4 字节块 ACK、`ctrl` 等一行控制帧（abort） */
    slot: 'ack' | 'ctrl';
  } | null = null;
  private opened = false;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.onWrite(chunk);
      },
    });
    this.mode = 'idle';
  }

  async open(): Promise<void> {
    if (this.opened) throw new Error('已打开');
    this.opened = true;
    // 引导日志：逐行发，最后一行不带换行（真机就是这个形状，会把回执粘在它屁股后面）
    for (const [index, text] of this.bootLines.entries()) {
      this.send(index === this.bootLines.length - 1 ? text : `${text}\n`);
    }
  }

  async close(): Promise<void> {
    this.opened = false;
    this.mode = 'closed';
    try {
      this.controller.close();
    } catch {
      /* 忽略 */
    }
  }

  private send(text: string | Uint8Array): void {
    const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
    this.controller.enqueue(new Uint8Array(bytes));
  }

  /** 写一条控制帧（补换行 —— 成帧是写这一侧的事） */
  private writeFrame(text: string): void {
    this.send(`${text}\n`);
  }

  /**
   * 回一条应答。`id` 只用来提醒调用方"这是回给谁的"—— 编号已经在 `answer` 里编好的
   * 帧文本上了（`encodeOk(id)` 等），所以这里不参与拼接。
   */
  private reply(_id: number, answer: BoardReply): void {
    if (answer.t === 'line') {
      this.writeFrame(answer.text);
      return;
    }
    this.writeFrame(answer.head);
    for (const line of answer.body) this.send(`${line}\n`);
    if (answer.body.length > 0) this.writeFrame(answer.end);
  }

  // ---------------------------------------------------------------- 事件（设备主动推）

  /** 主动推一个事件（`~0 ev <名> <字段…>`） */
  emit(name: string, args = ''): void {
    this.writeFrame(encodeEvent(name, args));
  }

  /**
   * 播一帧：把进度推上去并 `ev frame`。
   *
   * 真固件是"每帧边界"发（协议侧限速成每秒一条），测试里由调用方按需驱动 ——
   * 网页"进度条由事件驱动、不靠轮询"就是靠这个方法验的。
   */
  advanceFrame(frame: number, frames: number): void {
    this.frame = frame;
    this.frames = frames;
    this.emit(EVENTS.frame, `${frame} ${frames}`);
  }

  /** 换到清单里的某一项：`ev item <序号> <共几项> <文件名>` */
  showItem(index: number, total: number, file: string): void {
    this.itemIndex = index;
    this.itemTotal = total;
    this.playingItem = file;
    this.emit(EVENTS.item, `${index} ${total} ${file}`);
  }

  /** 播放失败：`ev error <原因>` */
  failPlayback(message: string): void {
    this.playing = false;
    this.playingItem = null;
    this.emit(EVENTS.error, message);
  }

  /**
   * 测试把手：按"主机在传输途中发一槽控制帧"的形状把字节灌进来。
   *
   * 用来重放真固件的行为（收到非 abort 的命令就地失败），不必去 mock 字节流。
   */
  feedTransferFrame(command: string): void {
    const bytes = new TextEncoder().encode(`~${this.nextHostId} ${command}\n`);
    this.nextHostId += 1;
    const out = new Uint8Array(bytes.length + 1);
    out[0] = TAG_CTRL;
    out.set(bytes, 1);
    this.onWrite(out);
  }

  /** 灌帧用的编号（和真主机一样自增，别撞上传输那条的号） */
  private nextHostId = 500;

  // ---------------------------------------------------------------- 收字节

  /** 测试把手：直接把主机写来的字节灌进来 */
  feedBytes(chunk: Uint8Array): void {
    this.onWrite(chunk);
  }

  private onWrite(chunk: Uint8Array): void {
    for (const byte of chunk) this.feedByte(byte);
  }

  /**
   * 一个字节 → 要么进标签槽（传输期间），要么进行扫描器（空闲时的一行请求）。
   *
   * 这正是 v9 的"两个方向形状不同"：主机 → 板子这个方向载荷是裸字节，所以传输期间
   * 每个字节都由**当前槽**决定怎么解释，绝不由字节内容决定。
   */
  private feedByte(byte: number): void {
    if (this.mode === 'upload') {
      this.feedUpload(byte);
      return;
    }
    if (this.mode === 'download') {
      this.feedDownload(byte);
      return;
    }
    const line = this.scanner.feed(byte);
    if (line === null) return;
    if (!isControl(line)) return; // 主机侧的外来文本（不会有，但规则保持和真固件一样）
    this.handleRequest(line);
  }

  // ---------------------------------------------------------------- 上传（板子在收）

  private feedUpload(byte: number): void {
    const upload = this.upload!;
    if (upload.slot === 'tag') {
      if (byte === TAG_DATA) {
        upload.need = Math.min(CHUNK_UP, upload.len - upload.received);
        upload.slot = 'data';
        if (upload.need === 0) this.finishUpload();
        return;
      }
      if (byte === TAG_CTRL) {
        this.scanner.reset();
        upload.slot = 'ctrl';
        return;
      }
      return; // 不是标签：残字节，丢掉继续等（和真固件一样）
    }
    if (upload.slot === 'ctrl') {
      const line = this.scanner.feed(byte);
      if (line === null) return;
      upload.slot = 'tag';
      const message = parseControlLine(line);
      if (message === null) return;
      this.handleTransferFrame(message.id, message);
      return;
    }
    // 收载荷字节
    upload.got[upload.received] = byte;
    upload.received += 1;
    upload.need -= 1;
    if (upload.need > 0) return;
    this.send(CHUNK_ACK); // 上传方向的 ACK 不带计数（板子是收的一方，它收到多少自己清楚）
    if (upload.received >= upload.len) this.finishUpload();
    else upload.slot = 'tag';
  }

  /** 传完了：登记文件、回 `~<id> OK` */
  private finishUpload(): void {
    const upload = this.upload!;
    this.files.set(upload.name, upload.got.subarray(0, upload.received));
    this.upload = null;
    this.mode = 'idle';
    this.reply(upload.id, { t: 'line', text: encodeOk(upload.id) });
  }

  /**
   * 传输途中收到的控制帧：只认 `media/abort`。
   *
   * 收尾顺序（真固件也一样，网页靠它认账）：先删半截文件，再 `~<被中断号> ERR aborted`，
   * 最后 `~<abort号> OK`。反过来的话网页会先看到 OK 再看到 aborted，界面一闪很难看。
   */
  private handleTransferFrame(id: number, message: NonNullable<ReturnType<typeof parseControlLine>>): void {
    if (message.reply.t !== 'unknown') return;
    const command = message.reply.body;
    if (!command.startsWith('media/abort')) {
      // 不是 abort：**和真固件一样就地失败**（一槽的字节数已经对不上，继续收会写出坏文件）。
      // 先给那条插进来的命令一个结论，再按"传输失败"收场：删半截文件 + `ERR <原因>`，
      // 主机在槽边界看到 ERR 就停手（网页的 `waitAck` 按首字节 `~` 把它交给分发器）。
      // 回传方向（板子正在发裸字节）不能在这里插一句 ERR：那会变成载荷的一部分，
      // 而且新页面重连后第一条命令会读到这条旧错误。真固件的做法：停手（**不**给被中断
      // 那条发结论，主机既然能发命令说明它已经放弃了这次读取），把这条命令放回待发队列，
      // 传输收场后由主循环照常处理 —— 这里照做：先停，再按空闲状态处理它。
      if (this.download !== null && this.upload === null) {
        this.download = null;
        this.mode = 'idle';
        this.handleRequest(`~${id} ${command}`);
        return;
      }
      // 上传方向：这条命令要记账（不会再走 handleRequest），并当场给它一个结论
      this.log.push(command);
      this.requestIds.push(id);
      this.reply(id, { t: 'line', text: encodeErr(id, 'busy') });
      if (this.upload !== null) {
        // 上传：删半截文件 + 给被中断那条一个失败（固件的 `unexpected command during upload`）
        this.files.delete(this.upload.name);
        this.reply(this.upload.id, {
          t: 'line',
          text: encodeErr(this.upload.id, 'unexpected command during upload'),
        });
        this.upload = null;
      }
      this.mode = 'idle';
      return;
    }
    this.log.push(command);
    this.requestIds.push(id);
    const target = Number.parseInt(command.slice('media/abort'.length).trim(), 10);
    const interrupted = this.upload?.id ?? this.download?.id ?? null;
    // 编号必须点名**这一次**传输，否则是陈旧的取消（主机状态错位 / 上一轮迟到的取消）。
    // 两个方向的处理不一样，原因和真固件完全一致：
    // - 上传：板子在收、TX 是空的 → 可以回 `~<abort号> ERR stale`，传输**继续**；
    // - 回传：板子正在发裸字节 → 回话会被主机当载荷读进去，只能悄悄丢掉，传输**继续**。
    if (Number.isFinite(target) && target !== interrupted) {
      this.staleAborts += 1;
      if (this.upload !== null) {
        this.reply(id, { t: 'line', text: encodeErr(id, 'stale') });
      }
      return;
    }
    this.aborted += 1;
    this.abortedId = Number.isFinite(target) ? target : null;
    if (this.upload !== null) {
      // 半截文件丢掉：否则它会被 `media/list` 当成孤儿素材
      this.files.delete(this.upload.name);
      this.upload = null;
      this.mode = 'idle';
    } else if (this.download !== null) {
      // 不再补零、不再拖 ACK 超时
      this.download = null;
      this.mode = 'idle';
    }
    if (interrupted !== null) {
      this.reply(interrupted, { t: 'line', text: encodeErr(interrupted, 'aborted') });
    }
    this.reply(id, { t: 'line', text: encodeOk(id) });
  }

  // ---------------------------------------------------------------- 回传（板子在发）

  private feedDownload(byte: number): void {
    const download = this.download!;
    if (download.slot === 'ctrl') {
      // 正在收 `TAG_CTRL` 后面的那一行（abort）
      const line = this.scanner.feed(byte);
      if (line === null) return;
      download.slot = 'ack';
      const message = parseControlLine(line);
      if (message === null) return;
      this.handleTransferFrame(message.id, message);
      return;
    }
    if (byte === TAG_CTRL) {
      // 主机按标签槽发来的 abort（上传/下载两个方向同一个形状）
      this.scanner.reset();
      download.slot = 'ctrl';
      return;
    }
    if (byte === CHUNK_ACK[0]) {
      download.ack = [byte];
      return;
    }
    if (download.ack.length === 1 && byte === CHUNK_ACK[1]) {
      download.ack.push(byte);
      return;
    }
    if (download.ack.length >= 2 && download.ack.length < CHUNK_ACK.length + 2) {
      download.ack.push(byte);
      if (download.ack.length < CHUNK_ACK.length + 2) return;
      const got = download.ack[2] | (download.ack[3] << 8);
      download.ack = [];
      this.onDownloadAck(got);
      return;
    }
    // 裸字节又不像 ACK：多半是上一块的残字节，丢掉
    download.ack = [];
  }

  private onDownloadAck(got: number): void {
    const download = this.download!;
    const chunkLen = Math.min(download.size, download.data.length - download.sent);
    if (got > download.chunkGot) download.chunkGot = got;
    if (download.chunkGot < chunkLen) {
      // 主机只收到一部分：只补发缺的尾巴（真固件也是这个行为）
      this.resends += 1;
      this.sendChunk();
      return;
    }
    download.sent += chunkLen;
    download.chunkGot = 0;
    if (download.sent >= download.data.length) {
      this.download = null;
      this.mode = 'idle';
      this.reply(download.id, { t: 'line', text: encodeOk(download.id) });
      return;
    }
    this.sendChunk();
  }

  /** 按当前进度继续发这一块：`cap` 只截断这一笔，模拟发送路径丢尾巴 */
  private sendChunk(): void {
    const download = this.download!;
    const chunkLen = Math.min(download.size, download.data.length - download.sent);
    const missing = chunkLen - download.chunkGot;
    const take = download.cap === null ? missing : Math.min(download.cap, missing);
    if (take <= 0) return;
    const from = download.sent + download.chunkGot;
    this.send(download.data.subarray(from, from + take));
  }

  // ---------------------------------------------------------------- 命令

  private handleRequest(line: string): void {
    const message = parseControlLine(line);
    if (message === null) return;
    const id = message.id;
    // 请求的形状是 `~<id> <正文>`：正文在 `unknown` 那一支（应答/事件是反方向的形状）
    if (message.reply.t !== 'unknown') return;
    const body = message.reply.body;
    this.log.push(body);
    this.requestIds.push(id);

    // 播放期间只就地处理 stop / play / info，其余 busy
    if (this.playing && body !== 'media/stop' && !body.startsWith('media/play') && body !== 'device/info') {
      this.reply(id, { t: 'line', text: encodeErr(id, 'busy') });
      return;
    }

    const [command, ...args] = body.split(' ');
    if (command === 'device/info') {
      if (this.dropInfo > 0) {
        this.dropInfo -= 1;
        return; // 这条丢在复位里，没人回答
      }
      if (this.muteInfo) return; // 一声不吭
      if (this.noiseReply !== null) {
        this.send(`${this.noiseReply}\n`); // 不是控制帧：主机该把它当外来文本
        return;
      }
      // 字段顺序照着真固件（`crates/fm-core/src/wire/device.rs`）来：旧固件少 `io` 那一行
      const lines = [
        `id ${this.deviceId}`,
        `api ${this.apiVersion}`,
        `board ${this.board}`,
        `chunk ${this.chunk}`,
        'reset CoreUsbUart 0x15',
        'sd microSD 63700MB (FAT)',
      ];
      if (!this.withoutIoLine) {
        lines.push(
          `io fail ${this.io.failed} tx_stuck ${this.io.txStuck} ack_timeout ${this.io.ackTimeout} host_left ${this.io.hostLeft} resends ${this.io.resends}`,
        );
      }
      lines.push(`screen ${this.screenWidth} ${this.screenHeight}`, `playing ${this.playing ? 1 : 0}`);
      if (this.playing) {
        lines.push(
          `item ${this.playingItem ?? ''}`,
          `index ${this.itemIndex}`,
          `total ${this.itemTotal}`,
          'loop 1',
          `frame ${this.frame} ${this.frames}`,
        );
      }
      this.reply(id, {
        t: 'lines',
        head: encodeOkLines(id, lines.length),
        body: lines,
        end: encodeEnd(id),
      });
      return;
    }

    if (command === 'media/abort') {
      // 空闲时收到 abort（网页的 `ask` 超时后会发一条叫停）：没有传输可中断，
      // 按固件主循环的做法直接回 OK，让主机那侧立刻结束等待。
      const target = Number.parseInt(args[0] ?? '', 10);
      this.aborted += 1;
      this.abortedId = Number.isFinite(target) ? target : null;
      this.reply(id, { t: 'line', text: encodeOk(id) });
      return;
    }

    if (command === 'media/stop') {
      this.playing = false;
      this.playingItem = null;
      this.stopped += 1;
      this.reply(id, { t: 'line', text: encodeOk(id) });
      // 事件排在 `OK` **之后**（和真固件那条已验证的不变量一致）
      this.emit(EVENTS.stop);
      return;
    }

    if (command === 'media/play') {
      this.playing = true;
      this.playingItem = args[0] ?? 'PLAYLIST';
      this.played += 1;
      this.reply(id, { t: 'line', text: encodeOk(id) });
      this.emit(EVENTS.play);
      return;
    }

    if (command === 'media/list') {
      const lines = [...this.files.entries()].map(
        ([name, data]) => `${name} ${data.length} 2026 09 26 12 00 00`,
      );
      this.reply(id, {
        t: 'lines',
        head: encodeOkLines(id, lines.length),
        body: lines,
        end: encodeEnd(id),
      });
      return;
    }

    if (command === 'media/add') {
      if (this.failNextUpload) {
        const messageText = this.failNextUpload;
        this.failNextUpload = null;
        this.reply(id, { t: 'line', text: encodeErr(id, messageText) });
        return;
      }
      const name = args[0] ?? 'FILE';
      const len = Number.parseInt(args[1] ?? '0', 10);
      // `INDEX`/`PLAYLIST` 会被反复覆盖：先删再建（真固件同一条）
      this.files.delete(name);
      this.upload = { id, name, len, got: new Uint8Array(len), received: 0, slot: 'tag', need: 0 };
      this.mode = 'upload';
      this.reply(id, { t: 'line', text: encodeReady(id) });
      return;
    }

    if (command === 'media/get') {
      const data = this.files.get(args[0] ?? '');
      if (!data) {
        this.reply(id, { t: 'line', text: encodeErr(id, 'cannot open file') });
        return;
      }
      const offset = args.length >= 3 ? Number.parseInt(args[1], 10) : 0;
      const length = args.length >= 3 ? Number.parseInt(args[2], 10) : data.length - offset;
      const slice = data.subarray(offset, offset + length);
      // `DATA <长度>` 声明的永远是**完整**长度；队列里的数字只截断每一笔实际发出去的字节，
      // 模拟"TX FIFO 排不空、发送路径把尾巴丢了"。
      const cap = this.failNextDownloads.length > 0 ? this.failNextDownloads.shift()! : null;
      this.download = {
        id,
        data: slice,
        sent: 0,
        chunkGot: 0,
        cap,
        size: this.chunk,
        ack: [],
        slot: 'ack',
      };
      this.mode = 'download';
      this.reply(id, { t: 'line', text: encodeData(id, slice.length) });
      this.sendChunk();
      return;
    }

    if (command === 'media/delete') {
      if (!this.files.delete(args[0] ?? '')) {
        this.reply(id, { t: 'line', text: encodeErr(id, 'cannot delete file') });
        return;
      }
      this.reply(id, { t: 'line', text: encodeOk(id) });
      return;
    }

    if (command === 'media/bench') {
      this.benchRuns.push(args[0] ?? '');
      const lines = [
        `BENCH ${args[0]}: 4096 bytes in 10 ms = 400 KiB/s (1 pass)`,
        'BENCH readahead: hit 1 miss 0 (100%), multi ok 1 fail 0, blocks 8',
      ];
      this.reply(id, {
        t: 'lines',
        head: encodeOkLines(id, lines.length),
        body: lines,
        end: encodeEnd(id),
      });
      return;
    }

    this.reply(id, { t: 'line', text: encodeErr(id, 'unknown command') });
  }
}
