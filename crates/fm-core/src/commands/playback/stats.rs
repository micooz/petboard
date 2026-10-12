//! 一轮播放的计时与计数，攒够一轮打三行日志，但**按轮限速**。
//!
//! 每轮从零开始统计：这样日志里的命中/降级就是"这一轮"的。
//!
//! 为什么要限速：整表循环播放时一轮只有几秒，每轮三行会把串口日志刷满 ——
//! 而这些数字是**性能实测**用的，不是运行状态。
//! 策略：前 [`STATS_FIRST_LOOPS`] 轮全样（刚开播最有诊断价值，冷缓存
//! 和预读降级都在这几轮露出来），之后每 [`STATS_EVERY_LOOPS`] 轮采样一次。
//! 调优时想逐轮都看：把 [`STATS_EVERY_LOOPS`] 改成 `1` 重编即可（这三行本来就是 `info!`，
//! 默认级别就打得出来）；只想测读卡裸速就走 `media/bench`，结果直接回复给网页、不依赖日志。

use defmt::info;

use crate::storage;

/// 采样：前几轮每轮都打（开播头几轮最能看出冷缓存/降级）
const STATS_FIRST_LOOPS: u32 = 3;
/// 之后每多少轮打一次（按 40ms/帧 × 30 帧估，约等于几十秒一条）
const STATS_EVERY_LOOPS: u32 = 30;

/// 第 `loop_no` 轮（1 基）的统计要不要打日志
pub(super) fn sampled(loop_no: u32) -> bool {
    loop_no <= STATS_FIRST_LOOPS || loop_no.is_multiple_of(STATS_EVERY_LOOPS)
}

/// 帧间要攒的八个量：平均、吞吐、以及"跟不跟得住素材节奏"。
#[derive(Default)]
pub(super) struct LoopStats {
    /// 这一轮真正播掉的帧数
    frames: u64,
    read_us: u64,
    draw_us: u64,
    read_bytes: u64,
    draw_bytes: u64,
    /// 一帧拆成几带去刷 LCD
    bands: u64,
    /// 合成进画布的像素数（等于读到的颜色个数）
    frame_pixels: u64,
    /// 帧体超过素材节奏的帧数："跟不跟得住"就看它
    slow: u64,
}

impl LoopStats {
    /// 一次读卡：`bytes` 个字节花了 `us` 微秒
    pub(super) fn add_read(&mut self, bytes: u64, us: u64) {
        self.read_bytes += bytes;
        self.read_us += us;
    }

    /// 一次刷 LCD 的一带
    pub(super) fn add_draw(&mut self, bytes: u64, us: u64) {
        self.draw_bytes += bytes;
        self.draw_us += us;
        self.bands += 1;
    }

    pub(super) fn add_pixels(&mut self, pixels: u64) {
        self.frame_pixels += pixels;
    }

    /// 一帧收尾：`frame_us` 是整帧（读卡 + 合成 + 刷屏）耗时，`target_us` 是素材要求的节奏
    pub(super) fn add_frame(&mut self, frame_us: u64, target_us: u64) {
        self.frames += 1;
        if frame_us > target_us {
            self.slow += 1;
        }
    }

    /// 第 `loop_no` 轮（1 基）播完后打的那三行；`elapsed_us` 是这一轮的总耗时
    pub(super) fn log(&self, loop_no: u32, elapsed_us: u64) {
        let frames = self.frames;
        let fps = frames * 1_000_000 / elapsed_us;
        let avg_frame = elapsed_us.checked_div(frames).unwrap_or(0);
        let avg_read = self.read_us.checked_div(frames).unwrap_or(0);
        let avg_draw = self.draw_us.checked_div(frames).unwrap_or(0);
        let avg_read_bytes = self.read_bytes.checked_div(frames).unwrap_or(0);
        let avg_draw_bytes = self.draw_bytes.checked_div(frames).unwrap_or(0);
        let avg_bands = self.bands.checked_div(frames).unwrap_or(0);
        let avg_px = self.frame_pixels.checked_div(frames).unwrap_or(0);
        let read_kib_s = self.read_bytes * 1_000_000 / self.read_us.max(1) / 1024;
        let draw_kib_s = self.draw_bytes * 1_000_000 / self.draw_us.max(1) / 1024;
        // 每轮就这三行：帧率与耗时、读写字节与实际吞吐、预读命中。
        info!(
            "play: loop {}: {} fps, {}us/frame, read {}us/frame, draw {}us/frame, slow {}/{}",
            loop_no, fps, avg_frame, avg_read, avg_draw, self.slow, frames
        );
        info!(
            "play: loop {}: read {}B/frame ({}KiB/s), draw {}B/frame ({}KiB/s), px {}/frame, bands {}/frame",
            loop_no, avg_read_bytes, read_kib_s, avg_draw_bytes, draw_kib_s, avg_px, avg_bands
        );
        let ra = storage::readahead_stats();
        info!(
            "play: loop {}: readahead hit {} miss {} ({}%), multi ok {} fail {}, blocks {}",
            loop_no,
            ra.hits,
            ra.misses,
            ra.hit_percent(),
            ra.multi_ok,
            ra.multi_fail,
            ra.blocks
        );
    }
}

#[cfg(test)]
mod tests {
    use super::sampled;

    /// 限速的形状：头几轮全样，之后只在周期点上打，中间一轮都不能多
    #[test]
    fn loop_stats_sampling_gate() {
        assert!(
            (1..=super::STATS_FIRST_LOOPS).all(sampled),
            "开播头几轮必须每轮都打"
        );
        assert!(!sampled(super::STATS_FIRST_LOOPS + 1));
        assert!(sampled(super::STATS_EVERY_LOOPS));
        assert!(sampled(super::STATS_EVERY_LOOPS * 2));
        assert!(!sampled(super::STATS_EVERY_LOOPS + 1));
    }
}
