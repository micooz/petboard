//! 播放事件的**产生端**：把状态变化排进协议 crate 的待发队列。
//!
//! 为什么单独一层：`~0 ev …` 的字段要拼字符串（`1 5 A1B2C3D4.ANM`），而拼字符串的地方
//! 正是播放的帧边界 —— 那条路径**一个字节都不许从堆上要**（见 `AGENTS.md`）。
//! [`serial::ArgsBuf`] 是栈上的固定缓冲，装不下就截断，于是这里既不用 `format!`
//! 也不用 `alloc`。
//!
//! 这里只**入队**，不写串口：写入由 [`Link::flush_events`] 在帧边界做，限速与"同类只留
//! 最新"是协议 crate 的队列机制（`serial::Events`），**名字与限速策略**在
//! [`crate::wire::vocab::events`]。发送的细节（主机不取就停推）见协议 crate 的文档。

use core::fmt::Write as _;

use serial::ArgsBuf;

use crate::wire::vocab::events::{ERROR, FRAME, ITEM, LOOP, PLAY, STOP};

use crate::Serial;
use crate::link::Link;

/// 把 `args` 拼进栈上缓冲后排入事件队列
fn push<U: Serial>(link: &mut Link<U>, name: &'static str, args: &ArgsBuf) {
    link.queue_event(name, args.as_str());
}

/// `ev play`：开始播放（后面紧跟 [`ev_item`] 说明播的是哪一项）
pub(super) fn ev_play<U: Serial>(link: &mut Link<U>) {
    link.queue_event(PLAY, "");
}

/// `ev stop`：停止播放（关键时刻，别丢：限速只作用在 `ev frame` 上）
pub(super) fn ev_stop<U: Serial>(link: &mut Link<U>) {
    link.queue_event(STOP, "");
}

/// `ev item <序号> <共几项> <文件名>`：换到清单里的某一项
pub(super) fn ev_item<U: Serial>(link: &mut Link<U>, index: usize, total: usize, name: &str) {
    let mut args = ArgsBuf::new();
    let _ = write!(args, "{index} {total} {name}");
    push(link, ITEM, &args);
}

/// `ev loop <第几轮>`：当前条目开始新的一轮
pub(super) fn ev_loop<U: Serial>(link: &mut Link<U>, round: u32) {
    let mut args = ArgsBuf::new();
    let _ = write!(args, "{round}");
    push(link, LOOP, &args);
}

/// `ev frame <第几帧> <共几帧>`：帧进度（协议侧限速为每 ≥1 秒一条）
pub(super) fn ev_frame<U: Serial>(link: &mut Link<U>, frame: usize, frames: usize) {
    let mut args = ArgsBuf::new();
    let _ = write!(args, "{frame} {frames}");
    push(link, FRAME, &args);
}

/// `ev error <原因>`：播放失败（读卡失败、动画比屏幕大……）
pub(super) fn ev_error<U: Serial>(link: &mut Link<U>, message: &str) {
    let mut args = ArgsBuf::new();
    let _ = write!(args, "{message}");
    push(link, ERROR, &args);
}
