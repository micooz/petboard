//! **PetBoard 的控制帧词汇表**：哨兵外壳之外、本产品自己规定的几个词。
//!
//! `crates/serial` 只认 RPC 骨架（`OK` / `OK <n>` + 正文 + `END` / `ERR <原因>`），
//! 下面这些词全部落在 `serial::Reply::Unknown` 里，由这里解释 —— 换一路业务就该整套换掉。
//!
//! ```text
//! READY                 上传方向：文件建好了，可以开始发数据
//! DATA <字节数>         回传方向：紧接着是这么多裸字节
//! ev <名> <字段…>       设备主动推的事件（配在 id = 0 上 = 非应答帧）
//! ```
//!
//! 这里只拼**正文**（`~<id> ` 外壳由 `serial::encode_frame` / [`serial::Wire::frame`] 加）：
//! 成帧、换行、TX 节流、应答编号都归协议，措辞归业务。

use alloc::format;
use alloc::string::String;

/// `READY`：上传方向"文件建好了，可以开始发数据"
pub const READY: &str = "READY";

/// `DATA <字节数>`：回传方向"紧接着是这么多裸字节"
pub const DATA: &str = "DATA";

/// `ev <名> <字段…>`：设备主动推的事件正文前缀
pub const EVENT: &str = "ev";

/// `DATA <字节数>` 的正文
pub fn data(len: u32) -> String {
    format!("{DATA} {len}")
}

/// `ev <名> <字段…>` 的正文（参数为空时不带尾随空格）
pub fn event(name: &str, args: &str) -> String {
    if args.is_empty() {
        format!("{EVENT} {name}")
    } else {
        format!("{EVENT} {name} {args}")
    }
}

/// 一条完整的事件帧（`~0 ev <名> <字段…>`）：通知要**自己带 id = 0**，所以这里全包
pub fn event_frame(name: &str, args: &str) -> String {
    // 事件不是应答：协议把 id = 0 保留给这种帧
    serial::encode_frame(0, &event(name, args))
}

/// 控制帧正文的业务结论：`READY` / `DATA <n>` / `ev <名> <参数…>` / 别的
///
/// 只在**主机侧**用（设备不会把自己发的帧回读给自己）。`Other` 是"应答骨架之外又不
/// 认识"的正文：原样带着，由调用方决定怎么报错。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
    /// `READY`
    Ready,
    /// `DATA <字节数>`
    Data { len: u32 },
    /// `ev <名> <字段…>`
    Event { name: String, args: String },
    /// 别的正文
    Other(String),
}

/// 业务正文 → [`Body`]（`serial::Reply::Unknown` 那一支的解析）
///
/// 数字解析不了就退回 [`Body::Other`]（宁可不认，也不要猜一个数把传输带偏）。
pub fn parse_body(body: &str) -> Body {
    if body == READY {
        return Body::Ready;
    }
    if let Some(rest) = body.strip_prefix(&format!("{DATA} ")) {
        return match rest.parse::<u32>() {
            Ok(len) => Body::Data { len },
            Err(_) => Body::Other(String::from(body)),
        };
    }
    if let Some(rest) = body.strip_prefix(&format!("{EVENT} ")) {
        let (name, args) = match rest.split_once(' ') {
            Some((name, args)) => (name, args),
            None => (rest, ""),
        };
        return Body::Event {
            name: String::from(name),
            args: String::from(args),
        };
    }
    Body::Other(String::from(body))
}

/// 播放事件的**名字**（`ev frame 12 28` 里那个 `frame`）
pub mod events {
    /// `ev play`：开始播放（后面紧跟 `ev item` 说明播的是哪一项）
    pub const PLAY: &str = "play";
    /// `ev stop`：停止播放
    pub const STOP: &str = "stop";
    /// `ev item <序号> <共几项> <文件名>`：换到清单里的某一项
    pub const ITEM: &str = "item";
    /// `ev loop <第几轮>`：当前条目开始新的一轮
    pub const LOOP: &str = "loop";
    /// `ev frame <第几帧> <共几帧>`：帧进度（限速）
    pub const FRAME: &str = "frame";
    /// `ev error <原因>`：播放失败（面板复位、读卡失败等）
    pub const ERROR: &str = "error";

    /// 帧进度事件的最小间隔（微秒）：1 秒一条足够画进度条
    pub const FRAME_MIN_INTERVAL_US: u64 = 1_000_000;
}
