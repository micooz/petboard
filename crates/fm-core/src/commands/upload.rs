//! `media/add <文件名> <字节数>`：收网页上传的文件，写进 `data/`。
//!
//! 数据是**标签槽**形状（v9）：每槽先一个标签字节，`0x00` = 后面跟 `min(1024, 剩余)`
//! 个裸载荷字节，`0x01` = 后面跟一行控制帧。为什么非要有标签：这个方向的载荷是裸
//! 文件字节，GIF/WebP 里出现 `0x00`、`~`(0x7E)、`0x06` 太正常，**首字节判不出类型**，
//! 只能由"现在在收第几槽"决定怎么解释（见 `serial::wire`）。
//!
//! 于是上传途中可以被打断：主机在**槽边界**发 `~<id2> media/abort <id1>`，
//! 板子删掉半截文件、回 `~<id1> ERR aborted` + `~<id2> OK`。打断延迟的上限就是
//! "一块 + 一次 ACK"，不必等整份文件传完。

use alloc::format;
use defmt::{debug, info, warn};
use embedded_graphics::pixelcolor::Rgb565;
use embedded_graphics::prelude::*;
use embedded_sdmmc::{BlockDevice, TimeSource};

use super::DeviceInfo;
use super::welcome::draw_welcome;
use crate::link::{CHUNK, Link, Slot};
use crate::screen::Screen;
use crate::storage::{self, Fs};
use crate::wire::Request;

/// 只负责"收下来存好"：屏幕上的播放由 `media/play`（播放清单）负责，
/// 所以"存"和"播"是两件事。目录不存在时顺手建出来。
pub(super) async fn add_cmd<D, T, S, U>(
    link: &mut Link<U>,
    fs: &Fs<D, T>,
    screen: &mut Screen<S>,
    info: &DeviceInfo<'_>,
    name: &str,
    len: u32,
) -> bool
where
    U: crate::Serial,
    D: BlockDevice,
    D::Error: defmt::Format,
    T: TimeSource,
    S: DrawTarget<Color = Rgb565>,
    S::Error: core::fmt::Debug,
{
    // ---- 1) 先在卡上建文件；建好了才回 READY 让主机开始发 ----
    // `INDEX`/`PLAYLIST` 会被反复覆盖写。先删再建，确保拿到的是全新的 FAT 簇链，
    // 避免 truncate 后旧链残留导致「刚写完 >1KiB 的文件，紧接着读就 0 字节」。
    // 文件不存在（新上传）时 delete 会返回 NotFound，忽略即可。
    let _ = storage::delete(fs, name);
    let file = match storage::create(fs, name) {
        Ok(file) => file,
        Err(e) => {
            warn!("media/add: create {} failed: {:?}", name, e);
            link.err("cannot create file");
            return false;
        }
    };

    // 被中断那条请求的编号：abort 的参数会带它，收尾时按它回 `ERR aborted`
    let interrupted = link.reply_id();

    // 欢迎屏照常画，进度**只占左上角一行**（不清整屏，也不打断居中显示的欢迎屏）
    draw_welcome(screen, info.board);
    screen.show_hud("Uploading 0%");
    link.ready();

    // ---- 2) 收一槽 → 写卡 → 回 ACK，直到收满 ----
    let mut remaining = len as usize;
    let mut buf = [0u8; CHUNK];
    let mut failed: Option<&'static str> = None;
    // 主机主动叫停（不是超时/写卡失败）：单独记，收尾的回执形状不一样
    let mut aborted: Option<Request> = None;

    while remaining > 0 {
        let want = remaining.min(CHUNK);
        match link.recv_slot(&mut buf[..want]).await {
            Slot::Data { got } if got == want => {}
            Slot::Data { got } => {
                // 短读：主机中途没了（刷新页面/拔线）
                // 网页刷新/拔线是常态，而且结尾那句 `media/add failed` 会带上原因，这里不重复
                debug!("media/add: short read ({} of {} bytes)", got, want);
                failed = Some("timeout waiting for data");
                break;
            }
            Slot::Control(request) => {
                // 槽边界上收到的控制帧：只认"点名中断**这一次**上传"的 abort。
                if let Some(target) = request.command.abort_target() {
                    if target != interrupted {
                        // 编号对不上 = 陈旧的取消（主机状态已经错位，或那是上一轮迟到的
                        // 取消）。绝不能拿它打断好好的一次传输，但要给它一个结论。
                        info!(
                            "media/add: stale abort {} (in flight is {})",
                            target, interrupted
                        );
                        link.set_reply_id(request.id);
                        link.err("stale");
                        link.set_reply_id(interrupted);
                        continue;
                    }
                    aborted = Some(request);
                    break;
                }
                // 不是 abort（旧客户端/不守规矩的客户端）：这一槽的字节数已经对不上，
                // 继续收会把坏数据写进文件，所以只能就地失败。**但必须先给它一个结论**
                // —— 不然主机那边等不到回执，要干等到自己的超时（十秒）。
                // `Command` 不实现 defmt::Format（业务词表保持零依赖）：这里只记编号。
                warn!(
                    "media/add: control frame {} during upload is not abort",
                    request.id
                );
                link.set_reply_id(request.id);
                link.err("busy");
                // 恢复成"被中断这条"的号：收尾那句 `ERR <原因>` 要配给上传请求本身
                link.set_reply_id(interrupted);
                failed = Some("unexpected command during upload");
                break;
            }
        }
        if let Err(e) = file.write(&buf[..want]) {
            warn!("media/add: write failed: {:?}", e);
            failed = Some("SD write failed");
            break;
        }
        link.ack();
        remaining -= want;

        // 进度：原地刷新左上角那一行
        let percent = (len as usize - remaining) * 100 / len as usize;
        screen.show_hud(&format!("Uploading {percent}%"));
    }

    // 必须显式关文件：关闭时才把新的文件大小写回 FAT 目录项
    let closed = file.close();
    if failed.is_none()
        && aborted.is_none()
        && let Err(e) = closed
    {
        warn!("media/add: close failed: {:?}", e);
        failed = Some("close failed");
    }

    // 上传没传完（主机叫停 / 主机没了）：把卡上那个半截文件一起删掉，
    // 否则它会被后续 `media/list` 当成孤儿素材，网页还得再清一次。
    if (failed.is_some() || aborted.is_some())
        && let Err(e) = storage::delete(fs, name)
    {
        warn!("media/add: delete partial {} failed: {:?}", name, e);
    }

    if let Some(request) = aborted {
        // 主机点了"取消"：先给被中断那条一个明确的失败，再确认 abort 本身。
        // 顺序反过来的话，网页会先看到 OK 再看到 aborted，界面上一闪很难看。
        // 用户点"取消"是正常操作，不是故障：降一级，别和真失败混在一起
        debug!("media/add: aborted by host: {} (req {})", name, interrupted);
        link.set_reply_id(interrupted);
        link.err("aborted");
        link.set_reply_id(request.id);
        link.ok();
        draw_welcome(screen, info.board);
        return false;
    }

    match failed {
        Some(msg) => {
            warn!("media/add failed: {} ({})", msg, name);
            link.err(msg);
            // 不要一直停在 "Upload failed" 这行：那会让设备看起来像卡死。
            // 网页会把具体错误显示出来；设备这边回到正常欢迎屏待命。
            draw_welcome(screen, info.board);
            false
        }
        None => {
            info!("media/add done: {} bytes -> {}", len, name);
            // 传完把左上角那行换成结果；欢迎屏倒计时由 run 主循环管理（到时重画欢迎屏，这行就被擦掉）
            screen.show_hud(&format!("Upload OK {len}B"));
            link.ok();
            true
        }
    }
}
