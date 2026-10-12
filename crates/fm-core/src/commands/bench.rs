//! `media/bench <文件名> [MiB]`：只按顺序读卡、不画屏，量 SD 卡的“裸读”带宽。

use alloc::format;
use defmt::{debug, warn};
use embassy_time::{Duration, Instant, Timer};
use embedded_graphics::pixelcolor::Rgb565;
use embedded_graphics::prelude::*;
use embedded_sdmmc::{BlockDevice, TimeSource};

use super::DeviceInfo;
use crate::link::Link;
use crate::screen::Screen;
use crate::storage::{self, Fs};

/// `READ` 最多把文件回卷读几遍，免得对着小文件空转
const BENCH_MAX_PASSES: u32 = 4096;
/// `READ` 最多跑几秒
const BENCH_MAX_SECS: u64 = 20;

/// 不给 MiB 就把文件读一遍；给了就一直读（读完回卷），直到读满这么多 MiB
/// 或 [`BENCH_MAX_SECS`] 秒。这是把“读卡”从动画逻辑里单独拎出来：
/// 如果这里也很慢，那瓶颈就不在播放循环里的位图合成。
pub(super) async fn bench_cmd<D, T, S, U>(
    link: &mut Link<U>,
    fs: &Fs<D, T>,
    screen: &mut Screen<S>,
    info: &DeviceInfo<'_>,
    name: &str,
    mib: Option<u32>,
) where
    U: crate::Serial,
    D: BlockDevice,
    D::Error: defmt::Format,
    T: TimeSource,
    S: DrawTarget<Color = Rgb565>,
    S::Error: core::fmt::Debug,
{
    let file = match storage::open(fs, name) {
        Ok(file) => file,
        Err(e) => {
            warn!("media/bench: open {} failed: {:?}", name, e);
            link.err("cannot open file");
            return;
        }
    };
    if file.length() == 0 {
        let _ = file.close();
        link.err("empty file");
        return;
    }

    screen.show_status(&["Read Bench", name]);
    storage::readahead_reset();

    let target = mib.map(|mib| mib as u64 * 1024 * 1024);
    let started = Instant::now();
    let mut buf = alloc::vec![0u8; info.board.play_read_bytes];
    let mut total = 0u64;
    let mut passes = 1u32;
    let mut failed: Option<&'static str> = None;

    let mut since_yield = 0u32;
    loop {
        match file.read(&mut buf) {
            Ok(0) => {
                if target.is_none_or(|target| total >= target) {
                    break;
                }
                if passes >= BENCH_MAX_PASSES || started.elapsed().as_secs() >= BENCH_MAX_SECS {
                    break;
                }
                passes += 1;
                if file.rewind().is_err() {
                    failed = Some("rewind failed");
                    break;
                }
            }
            Ok(n) => total += n as u64,
            Err(_) => {
                failed = Some("read failed");
                break;
            }
        }
        // 让喂狗任务有机会运行；如果 SD 读卡死了，这个 await 走不到，看门狗会复位。
        since_yield += 1;
        if since_yield >= 8 {
            since_yield = 0;
            Timer::after(Duration::from_millis(1)).await;
        }
    }

    let elapsed = started.elapsed();
    let kib_s = total * 1_000_000 / elapsed.as_micros().max(1) / 1024;
    let ra = storage::readahead_stats();
    let _ = file.close();

    if let Some(msg) = failed {
        warn!("media/bench failed: {} ({})", msg, name);
        link.err(msg);
        screen.show_status(&["Read Failed", msg]);
        return;
    }

    // 测速结果已经通过 `BENCH …` 回复行送给网页了，日志只是给人看的一份，降为 debug
    debug!(
        "media/bench: {} {}B in {}ms = {}KiB/s ({} passes, hit {}% multi ok {} fail {})",
        name,
        total,
        elapsed.as_millis(),
        kib_s,
        passes,
        ra.hit_percent(),
        ra.multi_ok,
        ra.multi_fail
    );
    let speed = format!("{kib_s} KiB/s");
    let hit = format!(
        "hit {}% multi {}/{}",
        ra.hit_percent(),
        ra.multi_ok,
        ra.multi_ok + ra.multi_fail
    );
    screen.show_status(&["Read Bench", name, &speed, &hit]);
    link.reply_lines(&[
        format!(
            "BENCH {name}: {total} bytes in {} ms = {kib_s} KiB/s ({passes} pass)",
            elapsed.as_millis()
        ),
        format!(
            "BENCH readahead: hit {} miss {} ({}%), multi ok {} fail {}, blocks {}",
            ra.hits,
            ra.misses,
            ra.hit_percent(),
            ra.multi_ok,
            ra.multi_fail,
            ra.blocks
        ),
    ]);
}
