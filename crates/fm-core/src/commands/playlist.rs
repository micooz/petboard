//! `media/play [<文件名>]`：按 `data/PLAYLIST` **整表循环**播放。
//!
//! 这里只管"下一项播谁、坏了跳过谁"，真正的逐帧播放和帧间轮询都在 [`super::playback`]。

use crate::wire::PlaybackState;
use alloc::string::String;
use defmt::{info, warn};
use embedded_graphics::pixelcolor::Rgb565;
use embedded_graphics::prelude::*;
use embedded_sdmmc::{BlockDevice, TimeSource};

use super::events::{ev_error, ev_item, ev_play, ev_stop};
use super::playback::{PlayOutcome, PlayScratch, load_anim, play_loaded};
use super::welcome::draw_welcome;
use super::{BusClock, DeviceInfo};
use crate::link::Link;
use crate::screen::Screen;
use crate::storage::{self, Fs};

/// 清单每行 `<文件名> <循环次数>`（`0` = 一直播），被跳过的条目网页不会写进来。
/// 每转完一圈重读一次清单，所以网页改完下一轮生效。
///
/// `OK` 只代表已开始；停止用 `media/stop`，查询在播什么用 `device/info`。
/// 关掉网页不影响它继续播 —— 这正是"宠物一直动"的那条路径。
#[allow(
    clippy::too_many_arguments,
    reason = "这是一条命令的实现，参数就是它要用到的几样板级资源：串口 / 文件系统 / 屏幕 / 画布 / SPI 总线"
)]
pub(super) async fn playlist_cmd<D, T, S, U>(
    link: &mut Link<U>,
    fs: &Fs<D, T>,
    screen: &mut Screen<S>,
    info: &DeviceInfo<'_>,
    state: &mut PlaybackState,
    canvas: &mut [u16],
    scratch: &mut PlayScratch<'_>,
    bus: &mut dyn BusClock,
    start: Option<String>,
) where
    U: crate::Serial,
    D: BlockDevice,
    D::Error: defmt::Format,
    T: TimeSource,
    S: DrawTarget<Color = Rgb565>,
    S::Error: core::fmt::Debug,
{
    let mut list = match storage::read_playlist(fs) {
        Ok(list) => list,
        Err(e) => {
            warn!("media/play: 读 PLAYLIST 失败：{:?}", e);
            link.err("cannot read playlist");
            ev_error(link, "cannot read playlist");
            link.flush_events();
            return;
        }
    };
    if list.is_empty() {
        link.err("no playlist");
        ev_error(link, "no playlist");
        link.flush_events();
        return;
    }

    // 从指定那项开始；找不到就从第一项开始
    let mut at = start
        .as_deref()
        .and_then(|name| list.iter().position(|(item, _)| item == name))
        .unwrap_or(0);

    state.set_total(list.len());
    state.set_item(&list[at].0, at + 1);
    link.ok();
    // 网页收到 `OK` 之后就该看到"播的是哪一项"：这两条排在 `OK` 之后发，
    // 于是播放状态完全是事件驱动的（不用再靠 1.5 秒一次的 `device/info` 猜）。
    ev_play(link);
    ev_item(link, at + 1, list.len(), list[at].0.as_str());
    link.flush_events();
    info!("media/play: {} 项，从 #{} 开始", list.len(), at + 1);

    // 连续失败多少项了：全都不行就别在这儿空转
    let mut failures = 0usize;
    // 跳出循环时的那次播放结果：只有 `Stopped` 欠网页一个 `OK`
    let mut outcome = PlayOutcome::Finished;
    'playlist: loop {
        let (name, loops) = list[at].clone();
        state.set_item(&name, at + 1);
        ev_item(link, at + 1, list.len(), name.as_str());

        match load_anim(fs, screen, canvas.len(), &name) {
            Ok(loaded) => {
                failures = 0;
                match play_loaded(
                    link, screen, info, state, canvas, scratch, bus, loaded, &name, loops,
                )
                .await
                {
                    PlayOutcome::Finished => {
                        at += 1;
                        if at >= list.len() {
                            // 一圈播完：重读清单（网页可能刚改过）再从头来
                            if let Ok(fresh) = storage::read_playlist(fs)
                                && !fresh.is_empty()
                            {
                                list = fresh;
                                state.set_total(list.len());
                            }
                            at = 0;
                        }
                    }
                    PlayOutcome::Stopped => {
                        outcome = PlayOutcome::Stopped;
                        break 'playlist;
                    }
                    PlayOutcome::StartPlaylist(next) => {
                        // 和 stop 同理：这条 media/play 是在播放循环里被接住的，回执要自己发
                        link.ok();
                        at = next
                            .as_deref()
                            .and_then(|name| list.iter().position(|(item, _)| item == name))
                            .unwrap_or((at + 1) % list.len());
                    }
                }
            }
            Err(msg) => {
                // 清单里有一条坏的（被删了、格式不对）就跳过它，别把整个播放卡死
                warn!("media/play: 跳过 {}：{}", name.as_str(), msg);
                ev_error(link, msg);
                failures += 1;
                if failures >= list.len() {
                    link.err("no playable item");
                    link.flush_events();
                    break 'playlist;
                }
                at = (at + 1) % list.len();
            }
        }
    }

    state.stop();
    let stopped = matches!(outcome, PlayOutcome::Stopped);
    draw_welcome(screen, info.board);
    // 停播的回执必须排在欢迎屏**之后**：网页一收到 `OK` 就发下一条命令，
    // 而这块屏是同步画的（S3 上整屏推 PSRAM 帧缓冲，实测约 75ms），
    // 那段时间固件不轮询串口，命令的头几个字节会丢在 USB RX 的 64 字节 FIFO 门外。
    // 真机实测过：固件拼出 `e/info`（`device/info` 少了 `devic`）→ `ERR unknown command`。
    if stopped {
        // **先把这一轮攒下的旧进度丢掉**：`ev loop` / `ev item` / `ev frame` 是播放途中
        // 排进队列的，主机没来取字节时会一直压着。真机实测（S3，2026-10-09）：`media/stop`
        // 的 `OK` 之后紧接着送出 `ev loop 6` + `ev item 1 1 …` —— 网页刚把界面切回"已停止"，
        // 又被这两条迟到的进度点亮成"正在播放"，表现就是"点了停止停不下来"。
        // 而且队列只有 4 格，旧进度会把真正该发的 `ev stop` 挤掉（那条被丢弃）。
        link.clear_events();
        link.ok();
        // 队列现在是空的：`ev stop` 是唯一待发的事件，排在 `OK` **之后**（网页先确认命令
        // 成功、再收到"停了"）。发不出去就留到下一条请求时再试。
        ev_stop(link);
        link.flush_events();
    } else {
        // 不是被 stop 叫停的（清单全坏 → 已经回过 `ERR`）：把这一轮的事件发完再丢掉，
        // 迟到的进度不该在播放结束之后还去点亮界面
        link.flush_events();
        link.clear_events();
    }
    // 一次停播只有这一行（每轮内部的 `play: stop after …` 已降为 debug），留着当会话的收尾标记
    info!("media/play: 停了");
}
