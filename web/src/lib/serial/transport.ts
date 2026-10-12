/**
 * Web Serial 的收发封装。
 *
 * 只做三件事：打开端口、把读到的字节丢进队列、提供"按行读 / 按裸字节读 / 等 ACK /
 * 按标签写一槽"。**协议语义**（消息 ID 配对、应答装配、事件）在 `client.ts`，
 * "字节怎么切成行"在 `frames.ts`（和 Rust 的 `LineScanner` 逐条对齐，由
 * `crates/fm-core/tests/fixtures/frames.jsonl` 钉住）。
 *
 * ## v9 的关键结构：常驻分发 + 传输挂起
 *
 * 设备会**主动推事件**（`~0 ev …`），它可以在任何时刻冒出来。所以读到的行由一个
 * 常驻分发器（[`Transport.setLineHandler`]）统一交给 `client.ts` 判配 —— 不能像 v8 那样
 * "谁在等就读一行"，否则事件会把一问一答的读法咬断。
 *
 * 而传输期间（`media/add` 的载荷块、`media/get` 的回传载荷）串口上是**裸字节**，
 * 一个字节都不能被按行消费掉。于是有 `raw` 开关：传输代码包在
 * [`Transport.withRaw`] 里，这期间分发器完全不碰队列，结束后再把期间攒下的行一次交出。
 *
 * `SerialPortLike` 是故意抽出来的：测试里塞一个假的端口就能跑完整条协议链路，
 * 不需要真的插板子。
 */
import { ByteQueue, type Bytes } from '../bytes';
import type { LogSink } from '../device-log';
import { WireReader, isControl } from './frames';
import { CHUNK_ACK, SENTINEL, TAG_CTRL, TAG_DATA } from './wire';

export interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

export class TransportError extends Error {}
export class TransportTimeout extends TransportError {}

/**
 * 串口超过这么久没吐一个字节才记一条 note（毫秒）。
 *
 * 阈值不能太低：播放期间设备主动推的 `ev frame` 本来就被限速成**每秒一条**，
 * 按 250ms 记就等于"每秒一条停顿"，一次播放能把日志刷满，而这些都是正常节奏。
 * 这条 note 的意义是"板子说发了、主机一个字节都没收到"那种真故障（历史实测卡死是
 * 5 秒量级），所以留出好几秒的余量，只抓真正异常的静默。
 */
const STALL_NOTE_MS = 3_000;

/**
 * 收到设备字节之后，隔这么久才允许发**下一条请求**（毫秒）。
 *
 * 为什么要等：S3 的 `media/play` 回完 `OK` 之后，固件还要连着做几件**不轮询串口**的
 * 阻塞活（推 `ev play`/`ev item`、`load_anim` 读卡、整屏 `clear()` 推
 * PSRAM 帧缓冲约 75ms）。这期间 USB-Serial-JTAG 的 RX 只有一个 64 字节 FIFO，主机紧跟
 * `OK` 发出去的那一行会**整包消失**（不是丢几个字节）。真机实测（2026-10-09）：
 * `OK` 之后 1ms 发 `device/info` 丢 4/6，0ms 丢 5/5，≥15ms 丢 0/5；把一次写的两行
 * 放在窗口里 → 要么两条都不到、要么两条都到，从没丢过半条 —— 说明丢的是整包。
 * 按“距上一个收到的字节 ≥25ms”再发：16/16 全部有应答，0 丢失。
 *
 * 只作用于**请求行**（[`Transport.writeRequest`]）：块 ACK 和上传载荷槽走
 * [`Transport.write`]，不等待 —— 那两个方向是板子在等主机，等待反而会拖慢传输
 * （回传实测约 290 KiB/s，每个 ACK 多等 25ms 会直接掉到 20 KiB/s 以下）。
 */
const REQUEST_QUIET_MS = 25;

/**
 * 上面那个空档最多等多久（毫秒）：设备一直在推事件时会不断重置空档，不能无限期地
 * 把用户的命令按在原地 —— 等满上限就照发（最多比老行为慢这一点，绝不更差）。
 */
const REQUEST_QUIET_MAX_MS = 150;

/**
 * 块 ACK 的前两个字节（`06 09`）。
 *
 * 权威定义在 `crates/serial`，这一份来自**生成物** `wire.ts`，不是手抄镜像。
 * 它同时是"首字节分类"的依据：`06` 开头是 ACK、`~` 开头是控制帧，其余字节只在
 * "正在按长度收载荷"时才有意义（见 `serial::classify`）。
 */
export const ACK = CHUNK_ACK;

const SENTINEL_CODE = SENTINEL.charCodeAt(0);

/**
 * `media/get` 回传时主机的块 ACK：`06 09` + **实收字节数**（u16 小端）。
 *
 * 板子的发送路径会静默丢掉一笔的尾巴（见 [`Transport.readUpTo`]），带上实收字节数它就能
 * 只补发缺的那几个。上传方向（`media/add`）仍是 2 字节 ACK —— 那条路是主机写、板子读，
 * 不走这个有损发送器。
 */
export function ackWithCount(count: number): Uint8Array {
  return new Uint8Array([...ACK, count & 0xff, (count >> 8) & 0xff]);
}

export class Transport {
  /**
   * 日志帧从**行扫描器**里取：它扫到的帧才算帧。
   *
   * 不在 `pump()` 里另开一份扫描器，是因为载荷字节（`media/get` 的数据块）和
   * `DATA <n>` 那一行可能挤在同一个串口分块里 —— 那份数据里什么都可能有（含 `FF 00`），
   * 按字节流去认必然会把载荷当日志帧。走同一份扫描器就天然避开了：载荷是 `readUpTo`
   * 直接从队列里拿走的，根本不会流到扫描器里。
   *
   * 它同时负责"字节 → 行"（与 Rust 的 `LineScanner` 同一条规则），扫出来的行交给分发器。
   */
  private readonly wires = new WireReader((frame) => this.log?.frame(frame));
  /** 原始字节队列：扫描器和 `readUpTo` 共用这一个游标，谁先取到归谁 */
  readonly queue = new ByteQueue();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private waiter: (() => void) | null = null;
  private closed = false;
  private failure: Error | null = null;
  /** 上一次从设备收到字节的时刻（毫秒，`Date.now()`）；0 = 还没收到过 */
  private lastRxAt = 0;
  /** 端口断掉（读流结束/读写失败/被关掉）时回调一次；界面拿它挂"已断开"提示 */
  onClose: ((reason: string) => void) | null = null;

  /** 串口通信日志（可选）：网页挂 `DeviceLog`，测试塞内存实现 */
  log: LogSink | null;

  /**
   * 现在是不是"裸字节模式"（传输期间）。`true` 时背景分发器一律不碰队列。
   * 为什么需要它，见文件头的"常驻分发 + 传输挂起"。
   */
  private raw = false;

  /** 背景行分发器（`client.ts` 注入）：只在行模式下被调用 */
  private onLine: ((line: string) => void) | null = null;

  constructor(
    private readonly port: SerialPortLike,
    private readonly baudRate = 115200,
    log: LogSink | null = null,
  ) {
    this.log = log;
  }

  async open(): Promise<void> {
    await this.port.open({ baudRate: this.baudRate });
    if (!this.port.readable || !this.port.writable) {
      throw new TransportError('端口打开了，但拿不到读/写通道');
    }
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.closed = false;
    this.failure = null;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const waiting = Date.now();
        const { value, done } = await this.reader!.read();
        // 浏览器/驱动偶尔几秒不吐字节：记一笔。排查"板子说发了、主机说没收到"时这是关键证据。
        const gap = Date.now() - waiting;
        if (gap > STALL_NOTE_MS) this.log?.note(`串口读停顿 ${gap}ms（这段时间没收到任何字节）`);
        if (done) break;
        if (value && value.length > 0) {
          this.lastRxAt = Date.now();
          this.queue.push(value);
          this.wake();
          // 行模式下顺手把已经成形的行交出去：设备主动推的事件就是这样到达的
          this.dispatch();
        }
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new TransportError(String(error));
      this.log?.error(`串口读取失败：${this.failure.message}`);
    } finally {
      this.closed = true;
      this.wake();
      const reason = this.failure ? this.failure.message : '串口已关闭';
      if (!this.failure) this.log?.note('串口读流结束（设备被拔出，或端口被关掉）');
      const notify = this.onClose;
      this.onClose = null; // 只通知一次
      notify?.(reason);
    }
  }

  /**
   * 叫醒正在等字节的读取（[`readUpTo`] / [`waitAck`]）。
   *
   * 取消传输用的：登记好取消之后 nudge 一下，正卡在 `waitForData` 里的读取立刻回来重看
   * `stopped()` —— 于是"取消"不必等一个空档（100ms）或一个超时。
   */
  nudge(): void {
    this.wake();
  }

  /** 把队列里已经成形的行**全部**交出去（外来文本照旧丢掉，只是不记成协议行） */
  private dispatch(): void {
    if (this.raw || this.onLine === null) return;
    for (;;) {
      const line = this.scanLine();
      if (line === null) return;
      // 只有控制帧进协议日志：引导日志那一堆外来文本进日志会把界面冲爆
      if (isControl(line)) this.log?.line('rx', line);
      this.onLine(line);
    }
  }

  /** 装/换背景行分发器；装上之后顺手把已排着的行清一遍 */
  setLineHandler(handler: (line: string) => void): void {
    this.onLine = handler;
    this.dispatch();
  }

  /** 取掉分发器并丢掉半行（断开/重连时回到确定的起点） */
  clearLineHandler(): void {
    this.onLine = null;
    this.wires.reset();
  }

  /**
   * 进入/退出"裸字节模式"（整条传输期间开着：从**发请求**到**载荷收发完**）。
   *
   * 挂起期间背景分发器**不碰队列**：裸载荷里会出现 `0x0a`（造出假行）和 `~`（触发哨兵切行），
   * 两种都会吃掉真字节。于是传输期间的行只由**调用方自己**按需要读：
   * 开头那句 `READY` / `DATA n` 用 [`readLine`] —— 它 shift 到凑出一行为止就停手，后面的
   * 裸字节原样留在队列里给 [`readUpTo`]；块边界上板子说的 `ERR` / `ev` 由 [`waitAck`]
   * 按首字节切出来读。
   *
   * 退出时**立刻**把期间攒下的行一次交出去，所以传输结束后那句 `~id OK`（还有 abort 的
   * 回执）不会躺在队列里没人扫。取消/失败的收尾顺序：`drain`（还挂着，按裸字节吃掉在路上的
   * 载荷）→ `setRaw(false)` → 发 abort 那一槽 → 等它的回执（这时候串口上只剩文本行）。
   */
  setRaw(on: boolean): void {
    if (this.raw === on) return;
    this.raw = on;
    // 两个方向都要丢掉攒了一半的行（和 Rust 那边"传输开始/结束都从确定的起点读起"一样）：
    // - 退出时：取消留下的残载荷会被扫成"半行"，不清就会和紧接着的 `~id OK` 粘在一起；
    // - 进入时：那半行只可能是上一条命令的垃圾（它的回执要么已被消费、要么已超时作废），
    //   不清的话本次的 `~12 DATA 1024` 会被粘成 `~9~12 DATA 1024`，解析不出来 → 白等一个超时。
    this.wires.reset();
    if (!on) this.dispatch();
  }

  /** 现在是不是挂着（传输期间的裸载荷窗口） */
  get suspended(): boolean {
    return this.raw;
  }

  /** 扫出一行（可打印文本，含外来文本）；规则全在 `frames.ts`，与 Rust 逐条对齐 */
  private scanLine(): string | null {
    for (;;) {
      const byte = this.queue.shift();
      if (byte === undefined) return null;
      const line = this.wires.feed(byte);
      if (line !== null) return line;
    }
  }

  /** 串口还活着吗（没关、也没出错） */
  get alive(): boolean {
    return !this.closed && this.failure === null;
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  /** 等到"可能有新数据了"或者超时；超时返回 false */
  private waitForData(timeoutMs: number): Promise<boolean> {
    if (this.queue.length > 0) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(false);
      }, Math.max(1, timeoutMs));
      this.waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
  }

  private assertHealthy(): void {
    if (this.failure) throw new TransportError(`串口读取失败：${this.failure.message}`);
    if (this.closed) throw new TransportError('串口已经关闭（设备被拔掉了？）');
  }

  /**
   * 读一行文本（自动跳过 defmt 日志帧；外来文本照样返回，由调用方判断）。
   *
   * 只给测试和诊断用 —— 协议链路的行由背景分发器统一交出（[`setLineHandler`]），
   * 两边共用同一个扫描器游标，绝不会有一行被读两次。
   */
  async readLine(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.assertHealthy();
      const line = this.scanLine();
      if (line !== null) return line;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.log?.error(`等一行协议文本超时（${timeoutMs} ms）`);
        throw new TransportTimeout('等设备回一行文本超时');
      }
      await this.waitForData(remaining);
    }
  }

  /**
   * 读掉 n 个裸字节不看内容（只用来清管道，超时返回已丢掉的字节数）。
   *
   * 什么情况需要它：回传半途而废时，`DATA <n>` 已经许诺了那么多字节，它们多半已经在
   * USB 管道里了 —— 先吃掉，免得这些残字节变成下一条命令前面的垃圾。
   */
  async drain(count: number, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let dropped = 0;
    while (dropped < count) {
      if (!this.alive) return dropped;
      const take = Math.min(count - dropped, this.queue.length);
      if (take > 0) {
        this.queue.take(take);
        dropped += take;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return dropped;
      await this.waitForData(remaining);
    }
    return dropped;
  }

  /**
   * 上一次传输是不是半途而废（`DATA <n>` 许诺过、但没读满就收手）。
   *
   * 只影响 [`resync`] 那句日志的措辞（"预期内的残骸"还是"不知道哪儿来的"）—— 清空本身是
   * 无条件的，理由见那里。
   */
  private staleRx = false;

  /** 登记"这次传输没读满就收手了"（下一次 [`resync`] 会据此把日志说准） */
  markStaleRx(): void {
    this.staleRx = true;
  }

  /**
   * 开一次传输之前把管道清空：丢掉队列里剩下的字节 + 丢掉攒了一半的行。**每次传输开头都做**。
   *
   * 为什么必须无条件：错位会**自己续命**。一次被顶掉开头的读取照样"读满"就照样算成功，于是真载荷
   * 的最后几个字节反过来冻在队列里，成为**下一条**读取的开头残骸 —— 不清就一路错下去（真机表现：
   * 某几张切片从此一直花，别的几张一直好）。登记过"半途而废"只说明第一批残字节从哪儿来。
   *
   * 为什么在这里清是安全的：调用点在 `DeviceClient.enqueue`（**每条**命令排到队首时）和
   * `media/get` 的开头。行模式下 `pump` 会把扫完的整行立刻交给分发器，所以队列里留下的
   * 只可能是：残骸、或者一条**刚被超时作废**的请求的回执。真在等的回执不会躺在这里 ——
   * 顶多丢掉一条板子主动推的 `~0 ev …`（它正好横跨两次读取之间）。
   *
   * 代价就是后者：丢一条事件。播放状态本来会在下一条事件 / 下一次 `device/info` 时对齐，
   * 比"悄悄读出坏文件"轻得多。
   *
   * 仍然不是万能药：晚到得**比这次清空更晚**的残字节照样能混进载荷开头。所以真正兜底的是
   * "画之前验一遍帧边界"（见 `lib/poster.ts`），这里只是把最常见的来源堵掉。
   *
   * 半行也必须丢：残载荷里的 `~` 会被扫描器当成"控制帧的开头"，把紧接着的真回执
   * `~12 OK` 粘成一行垃圾（`~9~12 OK`），那条请求就此永远等不到结论。
   */
  resync(): void {
    const dropped = this.queue.length;
    const expected = this.staleRx;
    this.staleRx = false;
    // 队列空但攒了半行也要动手：那半行是残载荷里的 `~` 造出来的"控制帧开头"
    if (dropped === 0 && this.wires.pending() === '') return;
    this.queue.clear();
    this.wires.reset();
    this.log?.note(
      expected
        ? `清掉串口管道里 ${dropped} 个残留字节（上次传输半途而废）`
        : `传输前丢掉串口管道里 ${dropped} 个多余字节（多半是上一次晚到的尾巴）`,
    );
  }

  /**
   * 读**最多** `count` 个**裸**字节（`media/get` 的载荷，不做日志帧过滤）：拿到多少算多少。
   *
   * 三个时间参数各有分工：`firstByteMs` 是"一个字节都还没来"时能等多久（固件可能正在读卡）；
   * `idleMs` 是收到过字节之后，"空档"多久就认为这一块发完了；`deadlineMs` 是硬上限。
   *
   * 为什么要"空档就停"而不是读满：板子的发送路径会丢尾巴（`docs/esp32-c6-lcd-147.md` §6），
   * 死等满 512 只会等到超时。先把手里的字节回给板子（ACK 带实收字节数），它会补发缺的那些。
   */
  async readUpTo(
    count: number,
    options: {
      firstByteMs: number;
      idleMs: number;
      deadlineMs: number;
      /** 取消已登记：带着手里的字节立刻返回，让传输循环走到它的检查点（见 `client.deliverAbort`） */
      stopped?: () => boolean;
    },
  ): Promise<Bytes> {
    const { firstByteMs, idleMs, deadlineMs, stopped } = options;
    const out = new Uint8Array(count);
    let filled = 0;
    const started = Date.now();
    let lastProgress = started;
    while (filled < count) {
      this.assertHealthy();
      if (stopped?.()) break;
      const chunk = this.queue.take(count - filled);
      if (chunk.length > 0) {
        out.set(chunk, filled);
        filled += chunk.length;
        lastProgress = Date.now();
        continue;
      }
      const now = Date.now();
      const allowance = filled === 0 ? firstByteMs : idleMs;
      const left = Math.min(allowance - (now - lastProgress), deadlineMs - (now - started));
      if (left <= 0) break;
      await this.waitForData(left);
    }
    if (filled > 0) this.log?.bulk('rx', filled, 'payload');
    return out.subarray(0, filled);
  }

  /**
   * 等板子回一个块 ACK（上传方向：`06 09` 两个裸字节）。
   *
   * 槽边界上板子只有两种东西发：一个 ACK，或者一整行控制帧（`~<id> ERR …`、`~0 ev …`）。
   * 按**首字节**分流，规则确定、不会咬断前缀：
   * - `0x06` → 再收一个字节，是 `0x09` 就成了；对不上整段重来（多半是残字节）；
   * - `~` → 读完整一行交给分发器，由 `client.ts` 判配（`ERR` 会配给在飞的那条请求，
   *   所以上层很快就能看到失败原因，而不是干等到 ACK 超时）。
   */
  async waitAck(timeoutMs: number, stopped?: () => boolean): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.assertHealthy();
      // 分发器已经收到这条请求的 `ERR`（板子在槽边界上把失败原因说了）：别再等 ACK
      if (stopped?.()) throw new TransportError('设备已拒绝这次传输');
      const byte = await this.nextByte(deadline);
      if (byte === SENTINEL_CODE) {
        await this.collectControlLine(byte, deadline);
        continue;
      }
      if (byte !== ACK[0]) continue;
      const second = await this.nextByte(deadline);
      if (second === ACK[1]) {
        this.log?.bulk('rx', ACK.length, 'ack');
        return;
      }
    }
  }

  /** 取一个字节；到 `deadline` 还没来就抛 [`TransportTimeout`] */
  private async nextByte(deadline: number): Promise<number> {
    for (;;) {
      this.assertHealthy();
      const byte = this.queue.shift();
      if (byte !== undefined) return byte;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransportTimeout('等设备回字节超时');
      await this.waitForData(remaining);
    }
  }

  /**
   * 从哨兵字节起攒一行，攒出来就交给分发器；超时就把这半行丢掉回等 ACK。
   *
   * 复用 [`SentinelScanner`]：不另写一套行规则，否则跨语言 fixture 的一致性守不住。
   */
  private async collectControlLine(firstByte: number, deadline: number): Promise<void> {
    this.wires.reset();
    let byte: number | undefined = firstByte;
    for (;;) {
      if (byte !== undefined) {
        const line = this.wires.feed(byte);
        if (line !== null) {
          if (isControl(line)) {
            this.log?.line('rx', line);
            this.onLine?.(line);
          }
          return;
        }
      }
      if (Date.now() >= deadline) {
        this.wires.reset();
        return;
      }
      if (this.queue.length === 0) await this.waitForData(Math.max(1, deadline - Date.now()));
      byte = this.queue.shift();
    }
  }

  /** 板子回传载荷时，主机每收完一块回一个 ACK（带这一块实收的字节数） */
  async writeAck(count: number): Promise<void> {
    await this.write(ackWithCount(count));
  }

  /**
   * 发**上传方向的一槽**：`TAG_DATA` + 这一段裸载荷字节。
   *
   * 为什么要有标签：这个方向的载荷是裸文件字节，GIF/WebP 里出现 `0x00`、`~`(0x7E)、
   * `0x06` 太正常，**首字节判不出类型**，只能由"现在在收第几槽"决定怎么解释。
   */
  async writeDataSlot(payload: Uint8Array): Promise<void> {
    const out = new Uint8Array(payload.length + 1);
    out[0] = TAG_DATA;
    out.set(payload, 1);
    await this.write(out);
  }

  /**
   * 传输途中发一行控制帧：`TAG_CTRL` + `~<id> …` + 换行。
   *
   * 只有 `media/abort` 会在传输途中被板子接受（其余命令一律 `ERR busy`），于是"取消"
   * 不再排在长长的队列后面，而是一槽之内生效（上限 = 一块 + 一次 ACK）。
   */
  async writeControlSlot(frame: string): Promise<void> {
    const body = new TextEncoder().encode(`${frame}\n`);
    const out = new Uint8Array(body.length + 1);
    out[0] = TAG_CTRL;
    out.set(body, 1);
    await this.write(out);
  }

  async write(data: Uint8Array | string): Promise<void> {
    if (!this.writer) throw new TransportError('串口还没打开');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    try {
      await this.writer.write(bytes);
    } catch {
      // 写不进去基本只有一种情况：端口已经不在我们手上了（拔线 / 已被释放）。
      // 别把浏览器那句 "WritableStreamDefaultWriter ... released" 原样抛给用户。
      throw new TransportError('串口写失败，设备可能已经被拔掉');
    }
    this.logWrite(data, bytes);
  }

  /**
   * 发一条**请求行**：先避开设备的发送窗口（见 [`REQUEST_QUIET_MS`]），再写字节。
   *
   * 串口协议是一问一答，发请求的时刻正好是“上一个结论刚到”的时刻 —— 也就是设备最可能
   * 还在忙的那几毫秒。这里等的是“距上一个收到的字节”的空档：设备静默时一行都不等多
   * （平时绝大多数命令走的就是这条），刚发完一大串则等满空档。
   */
  async writeRequest(line: string): Promise<void> {
    const deadline = Date.now() + REQUEST_QUIET_MAX_MS;
    for (;;) {
      const since = this.lastRxAt === 0 ? REQUEST_QUIET_MS : Date.now() - this.lastRxAt;
      if (since >= REQUEST_QUIET_MS) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(REQUEST_QUIET_MS - since, remaining)));
      if (!this.alive) throw new TransportError('串口已经关闭（设备被拔掉了？）');
    }
    await this.write(line);
  }

  /** 发出去的字节也进日志：命令行记原文，ACK/载荷块记合并摘要 */
  private logWrite(source: Uint8Array | string, bytes: Uint8Array): void {
    if (!this.log) return;
    if (typeof source === 'string') {
      this.log.line('tx', source.replace(/\r?\n$/, ''));
      return;
    }
    // 主机自己发的块 ACK（2 字节上传 ACK / 4 字节回传 ACK + 实收字节数）不单独记：
    // 回传时它和载荷块交替出现，会把日志冲爆（一次预览就上百 KB），而"收了多少块"在载荷计数里已经有了。
    if (bytes.length <= ACK.length + 2 && ACK.every((byte, at) => byte === bytes[at])) return;
    // 上传的一槽：标签字节不算进"这槽发了多少载荷"，日志报的是载荷本身
    if (bytes[0] === TAG_DATA) {
      this.log.bulk('tx', bytes.length - 1, 'payload');
      return;
    }
    if (bytes[0] === TAG_CTRL) return; // abort 那一帧由 `send()` 记原文，这里不重复
    this.log.bulk('tx', bytes.length, 'payload');
  }

  async close(): Promise<void> {
    this.log?.note('串口关闭（主机主动）');
    this.closed = true;
    this.wake();
    try {
      this.reader?.releaseLock();
    } catch {
      /* 忽略 */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* 忽略 */
    }
    try {
      await this.port.close();
    } catch {
      /* 已经关了就算了 */
    }
  }
}
