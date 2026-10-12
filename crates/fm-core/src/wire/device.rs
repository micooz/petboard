//! **PetBoard 的业务应答**：播放状态、`device/info` 的应答行、I/O 计数。
//!
//! 应答行的格式是网页解析的依据（按行里第一个空格切字段），所以这一层的改动必须
//! 和 `web/src/lib/serial/client.ts` 一起看；权威就是这里。

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use super::API_VERSION;

/// 播放状态：`device/info` 报它，播放流程更新它。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PlaybackState {
    item: Option<String>,
    /// 当前条目在播放清单里的序号（1 基）
    index: usize,
    /// 清单一共几项
    total: usize,
    /// 当前条目播到第几轮（1 基）
    loop_no: u32,
    /// 当前条目播到第几帧（1 基）；0 = 这一轮还没开始画
    frame: usize,
    /// 当前条目一共几帧；0 = 还不知道
    frames: usize,
}

impl PlaybackState {
    /// 从头开始播一个文件（`total = 1`）
    pub fn start(&mut self, item: &str, index: usize, total: usize) {
        self.item = Some(String::from(item));
        self.index = index;
        self.total = total;
        self.loop_no = 1;
        self.frame = 0;
        self.frames = 0;
    }

    /// 换到清单里的下一项
    pub fn set_item(&mut self, item: &str, index: usize) {
        self.item = Some(String::from(item));
        self.index = index;
        self.loop_no = 1;
        self.frame = 0;
        self.frames = 0;
    }

    /// 清单长度变了（整表重读之后）
    pub fn set_total(&mut self, total: usize) {
        self.total = total;
    }

    /// 当前条目播到第几轮
    pub fn set_loop(&mut self, round: u32) {
        self.loop_no = round;
    }

    /// 当前条目播到第几帧（网页拿它画播放进度条）
    pub fn set_frame(&mut self, frame: usize, frames: usize) {
        self.frame = frame;
        self.frames = frames;
    }

    /// 停止：回到"什么都没在播"
    pub fn stop(&mut self) {
        self.item = None;
        self.index = 0;
        self.total = 0;
        self.loop_no = 0;
        self.frame = 0;
        self.frames = 0;
    }

    pub fn is_playing(&self) -> bool {
        self.item.is_some()
    }

    pub fn item(&self) -> Option<&str> {
        self.item.as_deref()
    }

    pub fn index(&self) -> usize {
        self.index
    }

    pub fn total(&self) -> usize {
        self.total
    }

    pub fn loop_no(&self) -> u32 {
        self.loop_no
    }

    /// 当前条目播到第几帧（1 基）
    pub fn frame(&self) -> usize {
        self.frame
    }

    /// 当前条目一共几帧
    pub fn frames(&self) -> usize {
        self.frames
    }
}

/// `media/get` 读路径的累计计数（开机以来一直累加）。
#[derive(Debug, Clone, Copy, Default)]
pub struct IoStats {
    /// 失败的 `media/get` 次数
    pub get_failed: u32,
    /// 其中：一块载荷写不出去（TX 卡住）
    pub tx_stuck: u32,
    /// 其中：等主机 ACK 超时
    pub ack_timeout: u32,
    /// 其中：主机自己先走了（我们主动停手）
    pub host_left: u32,
    /// 因主机少收而补发过几块
    pub resends: u32,
}

/// `device/info` 的应答行（**不含** `OK n` / `END` 那层框架，那是串口层的事）。
///
/// 网页按行里第一个空格切字段，所以格式不能随手改：
/// `id` / `api` / `board` / `chunk` / `reset` / `sd` / `screen` / `playing`，播放中再跟五项
/// （`item` / `index` / `total` / `loop` / `frame <第几帧> <共几帧>`）。
///
/// `board` 是板子标识（给网页显示"现在接的是哪块板"），`chunk` 是 `media/get` 回传方向
/// 一块的字节数（板子自己报，网页照它分块）。
#[allow(
    clippy::too_many_arguments,
    reason = "每一行都是独立来源（板子标识 / 协议版本 / 屏幕 / 卡 / 播放状态 / I-O 计数），              只在固件与测试两处调用；为了压参数个数去包一层结构体，反而把这些来源藏了起来"
)]
pub fn device_info_lines(
    id: &str,
    board: &str,
    chunk: usize,
    reset_reason: &str,
    sd: &str,
    screen: (u16, u16),
    playback: &PlaybackState,
    io: IoStats,
) -> Vec<String> {
    let (width, height) = screen;
    let mut lines = alloc::vec![
        format!("id {id}"),
        format!("api {API_VERSION}"),
        format!("board {board}"),
        format!("chunk {chunk}"),
        format!("reset {reset_reason}"),
        format!("sd {sd}"),
        format!("screen {width} {height}"),
        format!("playing {}", u8::from(playback.is_playing())),
        // 一行把 I/O 计数全带出来：`media/get` 失败时日志可能被 esp-println 跳过，
        // 这行是走我们自己写的回复，一定送得到（网页只认它认识的 key，多这行没影响）
        format!(
            "io fail {} tx_stuck {} ack_timeout {} host_left {} resends {}",
            io.get_failed, io.tx_stuck, io.ack_timeout, io.host_left, io.resends
        ),
    ];
    if let Some(item) = playback.item() {
        lines.push(format!("item {item}"));
        lines.push(format!("index {}", playback.index()));
        lines.push(format!("total {}", playback.total()));
        lines.push(format!("loop {}", playback.loop_no()));
        lines.push(format!("frame {} {}", playback.frame(), playback.frames()));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playback_state_resets_loop_counter_on_item_change() {
        let mut state = PlaybackState::default();
        assert!(!state.is_playing());

        state.start("A1B2C3D4.ANM", 1, 3);
        state.set_loop(7);
        state.set_frame(12, 28);
        assert!(state.is_playing());
        assert_eq!(state.item(), Some("A1B2C3D4.ANM"));
        assert_eq!(state.loop_no(), 7);
        assert_eq!(state.frame(), 12);
        assert_eq!(state.frames(), 28);

        state.set_item("BBBB2222.ANM", 2);
        assert_eq!(state.loop_no(), 1, "换条目要从第 1 轮重新数");
        assert_eq!(state.frame(), 0, "换条目要把帧进度清掉");
        assert_eq!(state.frames(), 0);
        assert_eq!(state.index(), 2);

        state.set_total(5);
        assert_eq!(state.total(), 5);

        state.stop();
        assert!(!state.is_playing());
        assert_eq!(state.item(), None);
        assert_eq!(state.index(), 0);
        assert_eq!(state.total(), 0);
        assert_eq!(state.loop_no(), 0);
        assert_eq!(state.frame(), 0);
        assert_eq!(state.frames(), 0);
    }
}
