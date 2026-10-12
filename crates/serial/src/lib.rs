//! 串口上的**通用线路协议**：哨兵成帧、消息 ID 与配对、传输标签槽、块 ACK、
//! TX FIFO 节流，以及一台设备**主动推通知**的队列。
//!
//! 这个 crate **不认识任何业务词**。它管到"谁说的（id）、说了什么（正文）"为止：
//! 正文是哪条命令、某种正文该不该打断传输，全是调用方的事。业务报文层放在调用方那一侧
//! （本项目是 `crates/fm-core/src/wire/`），所以换一块板子、换一路业务，这个 crate 原样复用。
//!
//! # 为什么值得单独一个 crate
//!
//! 以前"报文长什么样"散在三处 —— 协议解析、适配层的收发、另一门语言里的手抄镜像。
//! 只要有一处忘了跟着改，链路就会在某天突然错位（本项目踩过：设备宣告 512、发送端写死
//! 32，于是每一次传输都失败）。现在**收发语义**只有这一份；跨语言的规则由生成器跑
//! 自本 crate 的**真实实现**，另一门语言照同一张卷判卷（生成器和业务词表在调用方，
//! 不在这个 crate 里）。
//!
//! # 报文形状
//!
//! 控制帧**独占一行**，一律以 `~` 开头 —— 于是"协议字节"和"引导加载器的日志 / 别的
//! 杂音"用首字节就能分开，主机不必从行尾抠回执：
//!
//! ```text
//! ~<id> <正文>                  请求；id 从 1 起递增，重连即重置
//! ~<id> OK                      成功，没有附加数据
//! ~<id> OK <n> + n 行 + END      成功并且带 n 行正文
//! ~<id> ERR <原因>              失败
//! ~0  …                         `id = 0` **保留**给"不是应答的帧"（主动通知由调用方拼）
//! ```
//!
//! `id` 是请求编号：主机只认**对在飞请求**的那一份应答，对不上的丢掉并记一笔。
//! 上面四种应答（`OK` / `OK <n>` / `END` / `ERR`）是 RPC 骨架，本 crate 认得；
//! 其余正文一律 [`frame::Reply::Unknown`]，交回调用方解释。
//!
//! # 传输槽（唯一的二进制部分）
//!
//! 主机 → 设备方向的载荷是**裸字节**，没法用首字节判类型（文件里出现 `0x00`/`0x01` 太
//! 正常），所以每一块前面加一个标签字节：
//!
//! ```text
//! 0x00 + min(CHUNK_UP, 剩余) 个裸载荷字节
//! 0x01 + 一行 ASCII 控制帧（以 \n 结尾）
//! ```
//!
//! 于是"传输途中插一句话"停在槽边界生效，打断延迟的上限 = 一块 + 一次 ACK。
//! 设备 → 主机方向的载荷**不加标签**：那个方向主机只会回 ACK（`0x06` 开头）或控制帧
//! （`~` 开头），首字节天然无歧义。ACK 的形状：`06 09`（收方向，不带计数）、
//! `06 09 <实收 u16 小端>`（发方向，带上实收才谈得上只补发缺的尾巴）。
//!
//! "紧接着会有一串裸字节"这件事由 [`Wire::set_payload`] 开关：开关由调用方在发自己那些
//! "下面是什么"的词时拨。区间开着时 [`Wire::flush_notices`] 一条都不发 —— 混进任何字节
//! 都会让两边一起错位。
//!
//! # 时序：纯同步 + 注入时钟
//!
//! [`wire::Wire`] 不 `await`、不依赖任何异步运行时：调用方喂字节并给一个单调微秒时钟
//! （[`serial::Serial::now_us`]），超时由状态机自己判。于是**所有超时分支在 host 上可
//! 穷举**，不用再为测试链接一个假的时钟符号。"等一会儿再来"由调用方的异步适配层实现。

#![no_std]

extern crate alloc;

#[cfg(test)]
extern crate std;

pub mod events;
pub mod frame;
pub mod serial;
pub mod wire;

pub use events::{ArgsBuf, Event, Events};
pub use frame::{
    classify, encode_end, encode_err, encode_frame, encode_ok, encode_ok_lines, is_control,
    parse_control_line, ByteClass, LineScanner, Message, Reply, ReplyStep,
};
pub use serial::{Serial, SerialError, SerialResult};
pub use wire::{
    AckOutcome, Request, Step, Wire, CHUNK_UP, MAX_CHUNK_RESENDS, MAX_LINE, POLL_INTERVAL_US,
};

/// 控制帧的哨兵：协议里**每一行控制帧**都以它开头，不以此开头的行一律当外来文本。
pub const SENTINEL: u8 = b'~';

/// 主机对**每一块**发方向载荷的确认：`06 09 <实收字节数 u16 小端>`。
///
/// 为什么不是单纯两个字节：设备的发送路径在主机没及时排空 TX FIFO 时会**静默丢掉这一笔
/// 剩下的尾巴**。带上实收字节数，设备就能把缺的那几个字节原样补发 —— 不用整块重传，
/// 也不用死等超时。
///
/// 收方向（主机写、设备读）不经过那个有损发送器，所以仍然是 2 字节 ACK。
pub const CHUNK_ACK: [u8; 2] = [0x06, 0x09];

/// `CHUNK_ACK` 后面跟的实收字节数长度（u16 小端）
pub const CHUNK_ACK_COUNT_LEN: usize = 2;

/// 传输槽的标签：后面跟 `min(CHUNK_UP, 剩余)` 个裸载荷字节
pub const TAG_DATA: u8 = 0x00;

/// 传输槽的标签：后面跟一行 ASCII 控制帧（以 `\n` 结尾）
pub const TAG_CTRL: u8 = 0x01;
