//! 单帧的"读 + 解"：帧头 → 变化位图 → 颜色，最后按位图把颜色合成进画布。
//!
//! 失败直接往上抛 `&'static str`，那个字符串就是屏幕上 "Play Failed" 下面那一行；
//! 日志由调用方统一打。

use embassy_time::Instant;
use embedded_sdmmc::{BlockDevice, TimeSource};

use super::stats::LoopStats;
use crate::storage::OpenFile;

/// 画布的像素尺寸：bbox 越界检查和行跨度都要用
#[derive(Clone, Copy)]
pub(super) struct CanvasSize {
    pub(super) width: usize,
    pub(super) height: usize,
}

/// 一帧的头（已经过校验）
pub(super) struct FrameHead {
    /// 素材要求的帧间隔
    pub(super) delay_ms: u64,
    /// 这一帧变了画布上哪一块
    pub(super) bbox: anmfmt::Rect,
}

/// 读并校验 12 字节帧头：`flags/reserved` 必须全 0，bbox 必须落在画布里。
pub(super) fn read_head<D, T>(
    file: &OpenFile<'_, D, T>,
    canvas: CanvasSize,
    stats: &mut LoopStats,
) -> Result<FrameHead, &'static str>
where
    D: BlockDevice,
    D::Error: defmt::Format,
    T: TimeSource,
{
    let mut raw = [0u8; anmfmt::FRAME_HEADER_LEN];
    let read_started = Instant::now();
    if file.read_exact(&mut raw).is_err() {
        return Err("read frame header failed");
    }
    stats.add_read(
        anmfmt::FRAME_HEADER_LEN as u64,
        read_started.elapsed().as_micros(),
    );

    let head = FrameHead {
        delay_ms: u16::from_le_bytes([raw[0], raw[1]]) as u64,
        bbox: anmfmt::Rect {
            x: u16::from_le_bytes([raw[2], raw[3]]),
            y: u16::from_le_bytes([raw[4], raw[5]]),
            width: u16::from_le_bytes([raw[6], raw[7]]),
            height: u16::from_le_bytes([raw[8], raw[9]]),
        },
    };
    if raw[10] != 0 || raw[11] != 0 {
        return Err("bad frame flags");
    }
    let bbox = head.bbox;
    if bbox.x as u32 + bbox.width as u32 > canvas.width as u32
        || bbox.y as u32 + bbox.height as u32 > canvas.height as u32
    {
        return Err("bad frame bbox");
    }
    Ok(head)
}

/// 把这一帧的变化像素读出来、按位图合成进画布。
///
/// `bbox` 为空的帧没有位图也没有颜色，调用方不会走到这里。
#[allow(
    clippy::too_many_arguments,
    reason = "一帧的读+解本来就要这些：文件 / 脏区 / 画布 / 两个工作缓冲 / 计时"
)]
pub(super) fn compose<D, T>(
    file: &OpenFile<'_, D, T>,
    bbox: anmfmt::Rect,
    canvas: CanvasSize,
    pixels: &mut [u16],
    color: &mut [u8],
    bitmap: &mut [u8],
    read_bytes: usize,
    stats: &mut LoopStats,
) -> Result<(), &'static str>
where
    D: BlockDevice,
    D::Error: defmt::Format,
    T: TimeSource,
{
    // 位图：bbox 里 1 的位置要重画，颜色按行优先排在后面、只存那些像素
    let stride = (bbox.width as usize).div_ceil(8);
    let bitmap_len = bbox.bitmap_len();
    if bitmap_len > bitmap.len() {
        return Err("bitmap buffer too small");
    }
    let bitmap = &mut bitmap[..bitmap_len];
    let read_started = Instant::now();
    if file.read_exact(bitmap).is_err() {
        return Err("read bitmap failed");
    }
    stats.add_read(bitmap.len() as u64, read_started.elapsed().as_micros());

    let row_bytes = bbox.width as usize * 2;
    let rows_per_read = (read_bytes / row_bytes).max(1);
    let mut row0 = 0usize;
    while row0 < bbox.height as usize {
        let rows = (bbox.height as usize - row0).min(rows_per_read);
        // 这几行里有几个 1，就有几个颜色要读
        let ones: usize = (0..rows)
            .map(|r| {
                let at = (row0 + r) * stride;
                bitmap[at..at + stride]
                    .iter()
                    .map(|bits| bits.count_ones() as usize)
                    .sum::<usize>()
            })
            .sum();
        let bytes = ones * 2;
        if bytes > 0 {
            if bytes > color.len() {
                return Err("color buffer too small");
            }
            let read_started = Instant::now();
            if file.read_exact(&mut color[..bytes]).is_err() {
                return Err("read colors failed");
            }
            stats.add_read(bytes as u64, read_started.elapsed().as_micros());
        }
        stats.add_pixels(ones as u64);

        // 按位图把颜色写进画布。逐 bit 判断的话，一个 158x164 的 bbox 每帧要判断
        // 约 2.6 万次；这里用 `anmfmt::BitRuns` 一次取出一段连续的 1 —— 段内
        // 像素在画布上也是连续的，可以整块转换写入。
        let mut src = 0usize;
        let row_width = bbox.width as usize;
        for r in 0..rows {
            let at = (row0 + r) * stride;
            let dst = (bbox.y as usize + row0 + r) * canvas.width + bbox.x as usize;
            for byte_i in 0..stride {
                let byte = bitmap[at + byte_i];
                if byte == 0 {
                    continue;
                }
                let col0 = byte_i * 8;
                // 每行末尾那个字节可能有补齐位，它们不该消费颜色
                let valid = (row_width - col0).min(8);
                for (start, run) in anmfmt::BitRuns::new(byte, valid) {
                    let colors = &color[src..src + run * 2];
                    let dst_row = &mut pixels[dst + col0 + start..][..run];
                    for (dst_px, src_px) in dst_row.iter_mut().zip(colors.as_chunks::<2>().0) {
                        *dst_px = u16::from_le_bytes(*src_px);
                    }
                    src += run * 2;
                }
            }
        }
        row0 += rows;
    }
    Ok(())
}
