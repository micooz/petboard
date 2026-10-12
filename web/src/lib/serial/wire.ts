/*
 * 自动生成，**禁止手改**。
 *
 * 来源：`crates/fm-core/src/wire/`（本产品的报文层）＋ `crates/serial`（通用线路层）。
 * 重新生成：`pnpm wire`，产物随仓库跟踪。改了 Rust 忘了重生成时，
 * `crates/fm-core/tests/wire_contract.rs` 会逐个常量比对这一份并让 CI 变红。
 *
 * 这一份只统一**常量**；帧的切分语义另有一份 fixture
 * （`crates/fm-core/tests/fixtures/frames.jsonl`），由 Rust 的真实实现跑出来，
 * 网页照同一张表测自己那份（`web/tests/lib/serial/wire-fixtures.test.ts`）。
 */

/// 协议版本：和固件对不上就提示"检测到旧固件，请重新烧录"。
export const API_VERSION = 1;

/// 控制帧的哨兵：协议里每一行控制帧都以它开头，不以此开头的行一律当外来文本。
export const SENTINEL = '~';

/// **上传**方向（网页 → 板子）一块的字节数：必须和固件一致。
export const CHUNK_UP = 1024;

/// 回传块大小的**兜底值**（旧固件没报 `chunk` 行时用）。
/// 真正的值由固件在 `device/info` 的 `chunk` 行里报（C6 = 32、S3 = 512）。
export const GET_CHUNK_FALLBACK = 32;

/// 传输槽的标签：后面跟 `min(CHUNK_UP, 剩余)` 个裸载荷字节。
export const TAG_DATA = 0;

/// 传输槽的标签：后面跟一行 ASCII 控制帧（以 `\n` 结尾）。
export const TAG_CTRL = 1;

/// 块 ACK 的前缀；`media/get` 方向后面再跟**实收字节数**（u16 小端）。
export const CHUNK_ACK = new Uint8Array([6, 9]);

/// `CHUNK_ACK` 之后跟的实收字节数长度（u16 小端）。
export const CHUNK_ACK_COUNT_LEN = 2;

/// 一行控制帧最多多少个字符（超了整行丢掉）。
export const MAX_LINE = 128;

/// 播放次数里的 `0`：一直播到被 `media/stop` 打断。
export const LOOPS_INFINITE = 0;

/// 设备主动推的事件名（`~0 ev <名> <字段…>`）。
export const EVENTS = {
  play: 'play',
  stop: 'stop',
  item: 'item',
  loop: 'loop',
  frame: 'frame',
  error: 'error',
} as const;

/// 事件名的联合类型。
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
