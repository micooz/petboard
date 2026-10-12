//! `device/info`：把板子状态报给网页。

use crate::wire::{PlaybackState, device_info_lines};
use embedded_graphics::pixelcolor::Rgb565;
use embedded_graphics::prelude::*;

use super::DeviceInfo;
use super::io_stats::io_stats;
use crate::link::Link;
use crate::screen::Screen;

/// `id` 是芯片出厂 MAC —— 网页拿它当缓存命名空间，换板子不会串数据。
/// 播放期间这条命令也会被就地回答（见 [`super::playback::play_loaded`] 的帧间轮询），所以这里
/// **不能碰目录**：SD 摘要只报容量和有没有 FAT 卷，不数条目。
pub(super) fn info_cmd<S, U>(
    link: &mut Link<U>,
    screen: &Screen<S>,
    info: &DeviceInfo<'_>,
    state: &PlaybackState,
) where
    U: crate::Serial,
    S: DrawTarget<Color = Rgb565>,
    S::Error: core::fmt::Debug,
{
    let size = screen.size();
    // 开机时探测到的摘要直接缓存下来：`device/info` 不现场 open_volume，
    // 这样卡目录/FAT 出问题时，网页的握手也不会被 SD 拖死。
    // 应答行的格式权威在 `crate::wire::device`（`tests/wire_contract.rs` 逐个字段钉着）
    let lines = device_info_lines(
        info.device_id,
        info.board.id,
        info.board.get_chunk,
        info.reset_reason,
        info.sd_summary,
        (size.width as u16, size.height as u16),
        state,
        io_stats(),
    );
    link.reply_lines(&lines);
}
