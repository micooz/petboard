//! 命令的实现，以及"上电后一直等命令"的主循环。
//!
//! 协议本身在 [`crate::link`]，这里只负责"收到某条命令该干什么"，一条命令一个文件：
//!
//! | 命令 | 干什么 | 实现在 |
//! |------|--------|--------|
//! | `device/info` | 设备标识 / 协议版本 / 复位原因 / SD 卡 / 屏幕尺寸 / **播放状态** | `info` |
//! | `media/list` | 列 `data/` 目录给网页看 | `listing` |
//! | `media/add` | 收文件写进 `data/`（**不显示**） | `upload` |
//! | `media/get` | 把 `data/` 里的文件回传给网页（支持偏移 + 长度） | `download` |
//! | `media/delete` | 删掉 `data/` 里的文件 | `listing` |
//! | `media/play` | 按 `data/PLAYLIST` 整表循环播放 | `playlist` + `playback` |
//! | `media/stop` | 停止播放 | [`run`]（就地回执） |
//! | `media/bench` | 只顺序读卡、不画屏，量 SD 卡的裸读带宽 | `bench` |
//!
//! **播放是后台的**：`media/play` 回完 `OK` 就一边播一边在帧与帧之间
//! 用 [`Link::try_command`](crate::link::Link::try_command) 看一眼串口 —— 只有 `media/stop`、`media/play`、
//! `device/info` 会被就地处理，其它命令回 `ERR busy`。所以关掉网页不影响设备继续播。

mod bench;
mod download;
mod events;
mod info;
mod io_stats;
mod listing;
mod playback;
mod playlist;
mod upload;
mod welcome;

pub use crate::BusClock;
pub use playback::PlayScratch;
pub use welcome::draw_welcome;

use crate::wire::{Command, PlaybackState};
use defmt::warn;
use embassy_time::{Duration, Instant};
use embedded_graphics::pixelcolor::Rgb565;
use embedded_graphics::prelude::*;
use embedded_sdmmc::{BlockDevice, TimeSource};

use crate::link::Link;
use crate::screen::Screen;
use crate::storage::Fs;
use crate::{BoardConfig, Serial};

/// "跟播放无关、但播放期间也可能要用"的那几样板子状态。
///
/// 板级参数也一并带在这里：`device/info` 在播放循环里也会被就地回答
/// （见 [`playback::play_loaded`]），把 [`BoardConfig`] 塞进来就不必再多传一个参数。
pub struct DeviceInfo<'a> {
    pub reset_reason: &'a str,
    pub device_id: &'a str,
    pub size_mb: Option<u64>,
    /// 开机探测到的 SD 摘要；`device/info` 不再现场碰卡，坏卡也能先连上网页。
    pub sd_summary: &'a str,
    /// 卡到底挂上了没有。没挂上时 `media/list` 回**空列表**而不是报错 ——
    /// 空卡/没插卡都是正常状态，网页不该弹一条"读卡失败"的警报。
    pub sd_ok: bool,
    pub board: &'a BoardConfig<'a>,
}

/// 把 `[x, x + width)` 向外扩到 `align` 的整数倍边界，并裁进 `[0, limit)`。
///
/// 有些面板（ST77922）要求刷屏窗口的 x 边界对齐到 4 像素 —— 窗口可以比要画的那一段宽，
/// 但不能落在任意边界上。多出来的列**不是补黑**：画布本身就是整幅画面的真相，
/// 从画布多读那几列一起送过去即可（合成阶段已经把该黑的地方写成 0 了）。
///
/// `limit` 必须是 `align` 的整数倍，否则右边界裁完就不对齐了；板子在选屏幕/画布尺寸时
/// 就保证了这一点（见 [`BoardConfig::x_align`]）。`align <= 1` 时原样返回，
/// 也就是 C6 那条路径的行为**一个字节都不变**。
pub fn align_span(x: u16, width: u16, limit: u16, align: u16) -> (u16, u16) {
    if align <= 1 || width == 0 {
        return (x, width);
    }
    let start = x - (x % align);
    let end = (x + width).div_ceil(align) * align;
    let end = end.min(limit);
    (start, end.saturating_sub(start))
}

/// 上传成功后，屏幕停留在 “Upload OK” 多久，再自动回欢迎屏。
///
/// 同时也是**左上角那行状态文字（HUD）的显示时长** —— HUD 是叠在欢迎屏上的，
/// 它只在重画欢迎屏时被擦掉，所以这个值就等于"状态文字多久后消失"。
const UPLOAD_OK_SECS: u64 = 2;

/// 开机后停在这里等命令，永远不会返回。
#[allow(
    clippy::too_many_arguments,
    reason = "主循环要拿的是几样板级资源：串口 / 文件系统 / 屏幕 / 复位原因 / 设备标识 / 画布 / SPI 总线"
)]
pub async fn run<D, T, S, U>(
    link: &mut Link<U>,
    board: &BoardConfig<'_>,
    fs: &Fs<D, T>,
    screen: &mut Screen<S>,
    reset_reason: &str,
    device_id: &str,
    size_mb: Option<u64>,
    sd_summary: &str,
    sd_ok: bool,
    canvas: &mut [u16],
    scratch: &mut PlayScratch<'_>,
    bus: &mut dyn BusClock,
) -> !
where
    D: BlockDevice,
    D::Error: defmt::Format,
    T: TimeSource,
    S: DrawTarget<Color = Rgb565>,
    S::Error: core::fmt::Debug,
    U: Serial,
{
    let info = DeviceInfo {
        reset_reason,
        device_id,
        size_mb,
        sd_summary,
        sd_ok,
        board,
    };
    // 播放状态：单任务里就是个普通变量，播放函数会更新它
    let mut playback = PlaybackState::default();
    // 上传结果那行会停留 UPLOAD_OK_SECS；期间没有命令才回欢迎屏。
    let mut welcome_at: Option<Instant> = None;

    loop {
        let command = match welcome_at {
            Some(deadline) => match link.next_command_until(deadline).await {
                Some(command) => command,
                None => {
                    draw_welcome(screen, board);
                    welcome_at = None;
                    continue;
                }
            },
            None => link.next_command().await,
        };

        match command {
            Command::DeviceInfo => info::info_cmd(link, screen, &info, &playback),
            Command::MediaList => listing::list_cmd(link, fs, &info),
            Command::MediaAdd { name, len } => {
                welcome::cancel_welcome(&mut welcome_at, screen, board);
                if upload::add_cmd(link, fs, screen, &info, &name, len).await {
                    welcome_at = Some(Instant::now() + Duration::from_secs(UPLOAD_OK_SECS));
                }
            }
            Command::MediaGet { name, offset, len } => {
                welcome::cancel_welcome(&mut welcome_at, screen, board);
                // 块大小用板子自己宣告的那个值：网页就是照 `device/info` 的 `chunk` 行分块的
                download::get_cmd(link, fs, &name, offset, len, board.get_chunk).await;
            }
            Command::MediaDelete { name } => {
                welcome::cancel_welcome(&mut welcome_at, screen, board);
                listing::delete_cmd(link, fs, &name);
            }
            Command::MediaPlay { start } => {
                welcome::cancel_welcome(&mut welcome_at, screen, board);
                playlist::playlist_cmd(
                    link,
                    fs,
                    screen,
                    &info,
                    &mut playback,
                    canvas,
                    scratch,
                    bus,
                    start,
                )
                .await;
            }
            Command::MediaAbort { .. } => {
                // `media/abort` 只在传输途中有意义（由 `recv_slot` 就地接住）。
                // 走到主循环说明此刻没有正在进行的传输：回 OK 即可，让主机那侧的
                // "取消"立刻结束，而不是等到超时才看到结果。
                welcome::cancel_welcome(&mut welcome_at, screen, board);
                link.ok();
            }
            Command::MediaStop => {
                // 走到这里说明当前没在播（在播的话会由播放循环自己就地处理）
                welcome::cancel_welcome(&mut welcome_at, screen, board);
                playback.stop();
                // 丢掉上一轮没送出去的进度：队列只有 4 格，旧进度会把 `ev stop` 挤掉，
                // 而且迟到的 `ev loop` / `ev item` 会把网页重新点亮成"正在播放"
                link.clear_events();
                link.ok();
                // 事件排在 `OK` 之后发（和播放循环那条不变量一致）：网页先确认命令成功
                events::ev_stop(link);
                link.flush_events();
            }
            Command::MediaBench { name, mib } => {
                welcome::cancel_welcome(&mut welcome_at, screen, board);
                bench::bench_cmd(link, fs, screen, &info, &name, mib).await;
            }
            Command::Unknown(name) => {
                warn!("unknown command: {}", name.as_str());
                link.err("unknown command");
            }
            Command::BadUsage(msg) => link.err(msg),
        }
    }
}
