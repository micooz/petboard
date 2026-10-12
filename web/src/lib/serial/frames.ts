/**
 * v9 控制帧的**行语义**：字节 → 行、行 → 消息、消息 → 应答装配。
 *
 * 这一份镜像 `crates/serial/src/frame.rs`（通用成帧）＋ `crates/fm-core/src/wire/vocab.rs`
 * （`READY` / `DATA` / `ev` 这几个业务词），Rust 那边是权威。为什么不用
 * WASM 而是手写镜像：这一层只有**字符串规则**，没有格式编码，把整个协议 crate 编进
 * 浏览器不值当；风险由 `tests/lib/serial/wire-fixtures.test.ts` 兜住 —— 它把
 * `crates/fm-core/tests/fixtures/frames.jsonl`（由 Rust 的**真实实现**跑出来的期望表）
 * 逐条重放到这里，两边答案不一致就红。
 *
 * 三条值钱的规则，都来自真机：
 *
 * 1. **只有 `~` 开头的行是协议**。裸 `OK 9`（旧固件）、引导日志、正文行，一律当外来文本。
 * 2. **行中间看到 `~` 就切一行**。引导日志的最后一行不带换行，回执直接接在它屁股后面
 *    （`I (106) esp_image: … size~1 OK 9`），按哨兵切就不必从行尾抠回执。
 * 3. **半行不清缓冲**：一条命令可能跨两次串口读取到达，攒了一半的要能接着拼。
 */
import { MAX_LINE, SENTINEL } from './wire';
import { DefmtFrameScanner } from './defmt';

const SENTINEL_CODE = SENTINEL.charCodeAt(0);
const NEWLINE = 0x0a;
const CR = 0x0d;

/** 一个字节是不是"可以进正文"的可打印 ASCII（和 Rust 的 `is_ascii_graphic() || 空格` 一致） */
function isTextByte(byte: number): boolean {
  return (byte >= 0x21 && byte <= 0x7e) || byte === 0x20;
}

/** 板子 → 网页：一条控制帧的正文（`~<id> ` 之后的那段）解析出来的东西 */
export type Reply =
  | { t: 'ok' }
  | { t: 'okLines'; count: number }
  | { t: 'end' }
  | { t: 'error'; message: string }
  | { t: 'ready' }
  | { t: 'data'; len: number }
  | { t: 'event'; name: string; args: string }
  | { t: 'unknown'; body: string };

export interface Message {
  /** 请求编号；`0` = 不是应答（设备主动推的事件） */
  id: number;
  reply: Reply;
}

/** 正文 → [`Reply`]（对照 Rust 的 `parse_body`） */
function parseBody(body: string): Reply {
  if (body === 'OK') return { t: 'ok' };
  if (body === 'END') return { t: 'end' };
  if (body === 'READY') return { t: 'ready' };
  if (body.startsWith('OK ')) {
    const count = parseUint(body.slice(3));
    return count === null ? { t: 'unknown', body } : { t: 'okLines', count };
  }
  if (body.startsWith('ERR ')) return { t: 'error', message: body.slice(4) };
  if (body.startsWith('DATA ')) {
    const len = parseUint(body.slice(5));
    return len === null ? { t: 'unknown', body } : { t: 'data', len };
  }
  if (body.startsWith('ev ')) {
    const rest = body.slice(3);
    const at = rest.indexOf(' ');
    return at < 0
      ? { t: 'event', name: rest, args: '' }
      : { t: 'event', name: rest.slice(0, at), args: rest.slice(at + 1) };
  }
  return { t: 'unknown', body };
}

/**
 * 十进制整数，**允许前导 `+`** —— 和 Rust 的 `u32::from_str` 一模一样：
 * `+5` 收，`-5` / `abc` / 空串 / 越界不收。别"顺手"把它改成只收纯数字，
 * fixture 里那几条 `+` 的用例会红（镜像实现一旦比权威宽松/严格都是漂移）。
 */
function parseUint(raw: string): number | null {
  if (!/^(?:\d+|\+\d+)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= 0xffffffff ? value : null;
}

/** 消息 ID：Rust 那边先要求"全是 ASCII 数字"再解析，所以 `+1` 这种**不是**合法 ID */
function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  return parseUint(raw);
}

/** 这行是不是控制帧 */
export function isControl(line: string): boolean {
  return line.startsWith(SENTINEL);
}

/** 一行控制帧 → [`Message`]；不是帧返回 `null`（对照 Rust 的 `parse_control_line`） */
export function parseControlLine(line: string): Message | null {
  if (!line.startsWith(SENTINEL)) return null;
  const rest = line.slice(1);
  const at = rest.indexOf(' ');
  if (at < 0) return null; // `~1`（没有正文）不是帧
  const rawId = rest.slice(0, at);
  const body = rest.slice(at + 1);
  if (rawId.length === 0 || body.length === 0) return null;
  const id = parseId(rawId);
  if (id === null) return null;
  return { id, reply: parseBody(body) };
}

/** 命令正文 → 结论（fixture 的 `command` 题型；网页发的那些命令必须和 Rust 解析成同一个） */
export type ParsedCommand =
  | { t: 'info' }
  | { t: 'list' }
  | { t: 'add'; name: string; len: number }
  | { t: 'get'; name: string; offset: number; len: number | null }
  | { t: 'delete'; name: string }
  | { t: 'play'; start: string | null }
  | { t: 'stop' }
  | { t: 'abort'; id: number }
  | { t: 'bench'; name: string; mib: number | null }
  | { t: 'unknown'; text: string }
  | { t: 'badUsage'; reason: string };

/** `<命名空间>/<动作> [参数…]` → [`ParsedCommand`]（对照 Rust 的 `command::parse`） */
export function parseCommand(text: string): ParsedCommand {
  const at = text.indexOf(' ');
  const cmd = at < 0 ? text : text.slice(0, at);
  // Rust 用 `split(' ').filter(非空)`：连续空格会被跳过，这里同一套
  const args = (at < 0 ? '' : text.slice(at + 1)).split(' ').filter((item) => item !== '');
  let cursor = 0;
  const next = () => (cursor < args.length ? args[cursor++] : undefined);
  const extra = () => cursor < args.length;

  switch (cmd) {
    case 'device/info':
      return extra() ? { t: 'badUsage', reason: 'usage: device/info' } : { t: 'info' };
    case 'media/list':
      return extra() ? { t: 'badUsage', reason: 'usage: media/list' } : { t: 'list' };
    case 'media/add': {
      const name = next();
      const rawLen = next();
      if (name === undefined || rawLen === undefined)
        return { t: 'badUsage', reason: 'usage: media/add <name> <len>' };
      if (extra()) return { t: 'badUsage', reason: 'usage: media/add <name> <len>' };
      const len = parseUint(rawLen);
      return len === null || len === 0
        ? { t: 'badUsage', reason: 'bad length' }
        : { t: 'add', name, len };
    }
    case 'media/get': {
      const name = next();
      if (name === undefined)
        return { t: 'badUsage', reason: 'usage: media/get <name> [<offset> <len>]' };
      let offset = 0;
      const rawOffset = next();
      if (rawOffset !== undefined) {
        const parsed = parseUint(rawOffset);
        if (parsed === null) return { t: 'badUsage', reason: 'bad offset' };
        offset = parsed;
      }
      let len: number | null = null;
      const rawLen = next();
      if (rawLen !== undefined) {
        const parsed = parseUint(rawLen);
        if (parsed === null || parsed === 0) return { t: 'badUsage', reason: 'bad length' };
        len = parsed;
      }
      if (extra()) return { t: 'badUsage', reason: 'usage: media/get <name> [<offset> <len>]' };
      return { t: 'get', name, offset, len };
    }
    case 'media/delete': {
      const name = next();
      if (name === undefined) return { t: 'badUsage', reason: 'usage: media/delete <name>' };
      if (extra()) return { t: 'badUsage', reason: 'usage: media/delete <name>' };
      return { t: 'delete', name };
    }
    case 'media/play': {
      const start = next();
      if (extra()) return { t: 'badUsage', reason: 'usage: media/play [<name>]' };
      return { t: 'play', start: start ?? null };
    }
    case 'media/stop':
      return extra() ? { t: 'badUsage', reason: 'usage: media/stop' } : { t: 'stop' };
    case 'media/abort': {
      const rawId = next();
      if (rawId === undefined) return { t: 'badUsage', reason: 'usage: media/abort <id>' };
      const id = parseUint(rawId);
      if (id === null || id === 0) return { t: 'badUsage', reason: 'bad id' };
      if (extra()) return { t: 'badUsage', reason: 'usage: media/abort <id>' };
      return { t: 'abort', id };
    }
    case 'media/bench': {
      const name = next();
      if (name === undefined)
        return { t: 'badUsage', reason: 'usage: media/bench <name> [<MiB>]' };
      let mib: number | null = null;
      const rawMib = next();
      if (rawMib !== undefined) {
        const parsed = parseUint(rawMib);
        if (parsed === null || parsed === 0) return { t: 'badUsage', reason: 'bad MiB' };
        mib = parsed;
      }
      if (extra()) return { t: 'badUsage', reason: 'usage: media/bench <name> [<MiB>]' };
      return { t: 'bench', name, mib };
    }
    default:
      return { t: 'unknown', text: cmd };
  }
}

// ------------------------------------------------------------------ 编码

function line(id: number, body: string): string {
  return `${SENTINEL}${id} ${body}`;
}

/** 网页 → 板子：一条请求 */
export function encodeRequest(id: number, command: string): string {
  return line(id, command);
}

export function encodeOk(id: number): string {
  return line(id, 'OK');
}

export function encodeOkLines(id: number, count: number): string {
  return line(id, `OK ${count}`);
}

export function encodeEnd(id: number): string {
  return line(id, 'END');
}

export function encodeErr(id: number, message: string): string {
  return line(id, `ERR ${message}`);
}

export function encodeReady(id: number): string {
  return line(id, 'READY');
}

export function encodeData(id: number, len: number): string {
  return line(id, `DATA ${len}`);
}

export function encodeEvent(name: string, args: string): string {
  return args === '' ? line(0, `ev ${name}`) : line(0, `ev ${name} ${args}`);
}

// ------------------------------------------------------------------ 扫描与装配

/**
 * 字节 → 行（对照 Rust 的 `LineScanner::feed`，规则一条不多一条不少）。
 *
 * `feed` 返回**任何一行**可打印文本（含外来文本），分类交给 [`isControl`]。
 */
export class SentinelScanner {
  private buffer = '';
  /** 当前这行已经超长：整行丢掉，读到换行才恢复 */
  private overflow = false;
  private droppedLines = 0;

  feed(byte: number): string | null {
    if (byte === NEWLINE) {
      if (this.overflow) {
        this.overflow = false;
        this.buffer = '';
        return null;
      }
      if (this.buffer.length === 0) return null;
      const out = this.buffer;
      this.buffer = '';
      if (!isControl(out)) this.droppedLines += 1;
      return out;
    }
    // 行中间看到哨兵：手边这段不是控制帧，先当一行交出去，从这个字节重新攒
    if (byte === SENTINEL_CODE && this.buffer.length > 0 && !isControl(this.buffer)) {
      const out = this.buffer;
      this.buffer = SENTINEL;
      this.droppedLines += 1;
      return out;
    }
    if (byte === CR) return null;
    if (isTextByte(byte)) {
      if (this.buffer.length >= MAX_LINE) {
        // 超长：整行丢掉（继续攒会把下一行也拼坏）
        this.buffer = '';
        this.overflow = true;
        this.droppedLines += 1;
        return null;
      }
      this.buffer += String.fromCharCode(byte);
      return null;
    }
    // 不可打印字节：日志帧碎片，丢掉攒了一半的行
    if (this.buffer.length > 0) {
      this.buffer = '';
      this.droppedLines += 1;
    }
    return null;
  }

  /** 丢掉过多少非控制行 / 半行 */
  dropped(): number {
    return this.droppedLines;
  }

  /** 攒了一半的行（测试用） */
  pending(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = '';
    this.overflow = false;
  }
}

/**
 * "日志帧过滤 + 行切分"的组合器：串口字节流的**唯一**入口读法。
 *
 * [`SentinelScanner`] 只懂"可打印字节 / 换行 / 哨兵"，它不知道 defmt 的二进制帧长什么样；
 * 而 [`DefmtFrameScanner`] 只懂帧。两者必须按固定顺序配合（先问帧、再喂行），否则
 * 日志帧的字节会被当成正文碎片、把好好的一条命令咬断。这个顺序在真机上跑过大量往返，
 * 所以只有这一处实现，网页正式链路和测试都走它。
 */
export class WireReader {
  private readonly scanner: SentinelScanner;
  private readonly frames: DefmtFrameScanner;

  constructor(onFrame: (frame: Uint8Array) => void = () => {}) {
    this.scanner = new SentinelScanner();
    this.frames = new DefmtFrameScanner(onFrame);
  }

  /** 喂一个字节；凑出一整行（可能是外来文本）就交回 */
  feed(byte: number): string | null {
    const step = this.frames.feed(byte);
    if (step !== 'text') this.scanner.reset();
    if (step === 'consumed') return null;
    return this.scanner.feed(byte);
  }

  push(bytes: Uint8Array): void {
    for (const byte of bytes) this.feed(byte);
  }

  dropped(): number {
    return this.scanner.dropped();
  }

  pending(): string {
    return this.scanner.pending();
  }

  reset(): void {
    this.scanner.reset();
    this.frames.reset();
  }
}

/** 一次 [`ReplyReader.feedLine`] 的结论（对照 Rust 的 `ReplyStep`） */
export type ReplyStep =
  /** 这一行不该出现在这里：丢掉并记一笔 */
  | { t: 'ignored'; line: string }
  /** 不需要正文的应答（`OK` / `ERR` / `READY` / `DATA` / `ev`） */
  | { t: 'done'; message: Message }
  /** `OK <n>`：还要读 n 行正文 */
  | { t: 'body'; message: Message; remaining: number }
  /** 正文收齐且见到 `~id END` */
  | { t: 'complete'; message: Message; lines: string[] }
  /** 应答读崩（`END` 的号对不上 / 解析不出控制帧） */
  | { t: 'broken'; line: string };

/**
 * 主机侧的应答装配器（对照 Rust 的 `ReplyReader`）：整行进、结论出。
 *
 * `~id OK <n>` 之后那 n 行正文**不带哨兵**（`device/info` 的那些行本来就要给人看），
 * 所以"现在在等第几行"必须由状态机决定，绝不由字节内容决定。
 */
export class ReplyReader {
  private head: Message | null = null;
  private remaining = 0;
  private collected: string[] = [];

  feedLine(text: string): ReplyStep {
    if (isControl(text)) {
      const message = parseControlLine(text);
      if (message === null) {
        this.abort();
        return { t: 'broken', line: text };
      }
      return this.control(message, text);
    }
    // 正文行：只有在等正文时才有意义
    const head = this.head;
    if (head === null || this.remaining === 0) return { t: 'ignored', line: text };
    this.collected.push(text);
    this.remaining -= 1;
    return { t: 'body', message: head, remaining: this.remaining };
  }

  private control(message: Message, raw: string): ReplyStep {
    const head = this.head;
    if (head !== null) {
      // 正在等正文：这一行只可能是 `~id END`
      if (message.id === head.id && message.reply.t === 'end') {
        const lines = this.collected;
        this.abort();
        return { t: 'complete', message: head, lines };
      }
      this.abort();
      return { t: 'broken', line: raw };
    }
    const count = message.reply.t === 'okLines' ? message.reply.count : 0;
    if (count > 0) {
      this.head = message;
      this.remaining = count;
      this.collected = [];
      return { t: 'body', message, remaining: count };
    }
    return { t: 'done', message };
  }

  /** 丢掉读到一半的应答（超时/断线用） */
  private abort(): void {
    this.head = null;
    this.remaining = 0;
    this.collected = [];
  }

  remainingLines(): number {
    return this.remaining;
  }

  awaitingBody(): boolean {
    return this.head !== null;
  }

  reset(): void {
    this.abort();
  }
}
