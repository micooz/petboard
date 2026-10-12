//! 播放引擎：打开并校验 `.ANM`，再把每一帧合成到画布、刷到 LCD。
//!
//! 整表循环的调度在 [`super::playlist`]，这里只播"一个已经打开的动画"。
//! 单帧的"读 + 解"在 [`frame`]，每轮的计时在 [`stats`]。
//!
//! 每帧之间用 [`Link::try_command`](crate::link::Link::try_command) 看一眼串口（完全不等待，几微秒）：
//! `media/stop` → 返回 [`PlayOutcome::Stopped`]；`media/play [x]` → 返回
//! [`PlayOutcome::StartPlaylist`]；`device/info` → 就地回状态后继续播；
//! 其它命令一律 `ERR busy`。
//!
//! **播完不回 `DONE`**：网页靠 `device/info` 的 `playing` 字段判断（见 [`crate::link`]）。

mod frame;
mod stats;

use crate::wire::{Command, LOOPS_INFINITE, PlaybackState};
use alloc::string::String;
use anmfmt;
use defmt::{debug, warn};
use embassy_time::{Duration, Instant, Timer};
use embedded_graphics::pixelcolor::Rgb565;
use embedded_graphics::prelude::*;
use embedded_sdmmc::{BlockDevice, TimeSource};

use super::events::{ev_error, ev_frame, ev_loop, ev_stop};
use super::{DeviceInfo, info::info_cmd};
use crate::BusClock;
use crate::link::Link;
use crate::screen::Screen;
use crate::storage::{self, Fs};
use frame::CanvasSize;
use stats::{LoopStats, sampled};

/// 只在"离目标还差得多"时才睡：差得少就直接放行（目标是"不慢于素材节奏"）。
/// 这个执行器的定时器唤醒有固定延迟，为几十微秒去睡反而更慢（真机实测过）。
const SLEEP_MIN_US: u64 = 5_000;

/// 主动让出一次执行器。
///
/// 为什么播放循环每帧都要让：读卡、合成、刷屏全是**同步**代码，只有"这一帧比素材节奏
/// 快"时才会走到 `Timer::after`。素材节奏快、而帧体又跑不完（实测 104ms/帧 vs 40ms 目标）
/// 时，整个循环可以连续几秒一个 `await` 都没有 —— 喂狗是**另一个任务**（`feed_watchdog`），
/// 不被轮询就没有机会喂，实测 5 秒后就是 `CoreMwdt0` 复位：动画开播几秒后整块板子重启，
/// 网页那边的 `media/stop` 也就永远等不到回执（看起来像"停了但停不下来"）。
/// 实现要点：第一次 poll 要**先排唤醒再返回 Pending**，第二次才 Ready。直接返回 Ready
/// 等于什么都没让（任务还在同一轮 poll 里往下跑），喂狗任务照样饿着。
async fn yield_now() {
    let mut yielded = false;
    core::future::poll_fn(move |cx| {
        if yielded {
            return core::task::Poll::Ready(());
        }
        yielded = true;
        cx.waker().wake_by_ref();
        core::task::Poll::Pending
    })
    .await;
}

/// 播放动画用的工作缓冲（**调用方提供**）。
///
/// 为什么不从堆上要：C6 的堆只有 ~128KB，还要留给协议和日志里的 `String`/`format!`。
/// 把这十几 KB 挂在堆上，播放期间别的分配（网页轮询 `device/info` 时的 `String`/`format!`）
/// 就只能在碎片里挤；实测的挂法就是停播时欢迎屏那句 `format!` 分配失败 —— panic 位置落在
/// `library/alloc/src/alloc.rs`。
///
/// 两块板的拿法不同：C6 从 `.bss` 的 `StaticCell` 里切（内部 SRAM 装得下），
/// S3 从 PSRAM 上分配（288KB 的画布内部 SRAM 放不下）。所以这里只收切片，
/// 内存从哪来由板子决定。
pub struct PlayScratch<'a> {
    /// 一帧颜色字节的读取缓冲，长度 ≥ [`BoardConfig::play_read_bytes`]
    pub color: &'a mut [u8],
    /// 一帧的位图缓冲，长度 ≥ [`BoardConfig::play_bitmap_bytes`]
    pub bitmap: &'a mut [u8],
}

/// 一段播放结束之后该干什么
pub(super) enum PlayOutcome {
    /// 按次数播完了
    Finished,
    /// 收到 `media/stop`：**回执由调用方发**，而且要等屏幕忙完（见 `play_loaded` 里那段注释）
    Stopped,
    /// 收到 `media/play [x]`：改成从 x（`None` = 第一项）开始的整表播放
    StartPlaylist(Option<String>),
}

/// 已经打开并校验好的 `.ANM`
pub(super) struct LoadedAnim<'a, D, T>
where
    D: BlockDevice,
    T: TimeSource,
{
    file: storage::OpenFile<'a, D, T>,
    header: anmfmt::Header,
}

/// 把画布上的这一帧送上 LCD，顺带记住两件跨帧的事：总线停在哪个时钟、屏幕上现在画着哪些地方。
struct Painter<'a, 'b, 'c, S>
where
    S: DrawTarget<Color = Rgb565>,
{
    screen: &'a mut Screen<S>,
    bus: &'b mut dyn BusClock,
    /// 合成好的画布（已经按动画尺寸截好）
    pixels: &'c mut [u16],
    /// 动画的像素尺寸
    size: CanvasSize,
    /// 画布在屏上的左上角（画布比屏幕小时居中留出的边）
    base: (u16, u16),
    /// 刷屏窗口在 x 方向上必须对齐到几像素（见 [`super::align_span`]）。
    ///
    /// 对齐的是面板的 **CASET** 那条轴：C6（`x → CASET`）对 x 有要求、S3 对 y 有要求，
    /// 所以 S3 这里是 1、看 [`Self::row_align`]。对齐在**屏幕坐标**里做，再换算回画布坐标，
    /// 这样画布居中偏了几个像素都不影响结果。
    align: u16,
    /// 刷屏窗口在 y 方向上必须对齐到几像素（S3 的 ST77922 要求 4，C6 是 1）。
    ///
    /// 横带的**行范围**要一并向外扩：只让驱动去补黑的话，每条带上下都会留出几行黑缝。
    row_align: u16,
    /// 读卡 / 画屏各自的总线相位时钟（只对"卡和屏共用总线"的板子有意义）
    sd_clock_mhz: u32,
    lcd_phase_mhz: u32,
    /// 一次最多刷多少行到 LCD
    draw_rows: u16,
    /// 多行像素是否要按面板窗口顺序倒序喂（见 [`BoardConfig::y_inverted`]）
    y_inverted: bool,
    /// 当前总线是不是停在"LCD 相位"的高频上（读卡前必须降回去）
    lcd_phase: bool,
    /// 这一轮画过的并集
    painted: Option<anmfmt::Rect>,
    /// 上一轮画过的并集矩形：这一轮**第一帧准备画之前**再擦（见 [`Self::present`]）。
    ///
    /// 只清画布（RAM）是不够的：每轮第 0 帧**只画自己的非黑像素**（格式就是这么定的），
    /// 上一轮后几帧画在别的位置、而第 0 帧在那儿是黑的（透明）时，LCD 上就留下上一轮的影子。
    ///
    /// 但也不能一进这一轮就擦：擦完还要读卡 + 解码第 0 帧（30~60ms，`cover` 布局更大），
    /// 那段时间屏幕上就是一块黑 —— 换轮时的"黑闪"就是这么来的。等这一帧解进画布、真要画了再擦。
    leftover: Option<anmfmt::Rect>,
}

impl<S> Painter<'_, '_, '_, S>
where
    S: DrawTarget<Color = Rgb565>,
    S::Error: core::fmt::Debug,
{
    /// 一轮的开始：清画布，这样第 0 帧只需要画自己的非黑像素，不必"整块重写并集矩形"
    fn begin_loop(&mut self) {
        self.pixels.fill(0);
        self.painted = None;
    }

    /// 一轮的收尾：把这一轮画过的并集交给下一轮，它准备画第一帧时会把这块擦掉
    fn end_loop(&mut self) {
        self.leftover = self.painted.take();
    }

    /// 画布坐标下的一段 x 区间 → 对齐到面板要求、且裁进画布的那一段。
    ///
    /// 先换算到屏幕坐标（`base.0 + x`）再对齐，最后换算回画布坐标 —— 这样即使画布
    /// 在屏上居中偏了非整倍数个像素，扩出来的边界也一定落在面板要求的格子上。
    fn aligned_span(&self, x: u16, width: u16) -> (u16, u16) {
        if self.align <= 1 || width == 0 {
            return (x, width);
        }
        let limit = self.base.0 + self.size.width as u16;
        let (aligned_x, aligned_w) = super::align_span(self.base.0 + x, width, limit, self.align);
        // `aligned_x >= base.0`：画布的 x 偏移本身是对齐的（板子在选画布尺寸时保证），
        // 所以向左扩最多扩到画布左边那一列，不会扩到画布外面。
        (aligned_x - self.base.0, aligned_w)
    }

    /// 画布坐标下的一段 y 区间（行范围）→ 对齐到面板要求、且裁进画布的那一段。
    ///
    /// 与 [`Self::aligned_span`] 同一个思路，只是作用在行上：对齐的是面板 CASET 那条轴
    /// 落在屏幕纵轴上的板子（S3）。多扩出来的行照旧从画布读，不补黑。
    fn aligned_row_span(&self, y0: u16, y1: u16) -> (u16, u16) {
        if self.row_align <= 1 || y1 <= y0 {
            return (y0, y1);
        }
        let base = self.base.1;
        let limit = base + self.size.height as u16;
        let (start, len) = super::align_span(base + y0, y1 - y0, limit, self.row_align);
        (start - base, start - base + len)
    }

    fn present(&mut self, bbox: anmfmt::Rect, stats: &mut LoopStats) {
        let (x, y) = (bbox.x, bbox.y);
        let right = bbox.x + bbox.width;
        let bottom = bbox.y + bbox.height;
        // 画屏这一段把共享总线提到 LCD 相位时钟：这时 SD 卡的 CS 是高，
        // 不理会 SCK，所以超频只作用在屏上。
        if !self.lcd_phase && self.bus.set_mhz(self.lcd_phase_mhz) {
            self.lcd_phase = true;
        }
        // 上一轮画过、而这一帧画不到的地方现在擦黑：这一帧的 bbox 之内马上会被整块重画，
        // 所以别去动它（擦了会在换轮时闪一下）；只擦外面那几块（`Rect::without`）。
        // 放在提频之后，擦的这几下也走 LCD 相位时钟。
        if let Some(prev) = self.leftover.take() {
            for area in prev.without(bbox).into_iter().flatten() {
                // 擦的这几块也要对齐（同一次 RAMWR 的限制），范围只会多不会少 ——
                // 多出来的那几列马上会被这一帧的 bbox 重画覆盖掉。
                let (ax, aw) = self.aligned_span(area.x, area.width);
                self.screen
                    .clear_area(self.base.0 + ax, self.base.1 + area.y, aw, area.height);
            }
        }
        // 面板要求窗口对齐时，把要刷的这一段向外扩到合法边界：多出来的列从画布里
        // 一起读过去就行（画布是整幅画面的真相，该黑的地方合成阶段已经写成 0）。
        let (x, width) = self.aligned_span(bbox.x, right - x);
        // 行范围同样要扩到对齐（面板要求的是 CASET 那条轴；S3 上它是屏幕纵轴）。
        // 扩出来的行也照旧从画布读：**不要**指望驱动去补黑，那会在每条带上下留黑缝。
        let (top, bottom) = self.aligned_row_span(y, bottom);
        let canvas_width = self.size.width;
        let mut band_y = top;
        while band_y < bottom {
            let rows = (bottom - band_y).min(self.draw_rows);
            // 直接把画布里的这一带喂给 LCD：不往堆上再拷一份
            //（横带在画布里是"每行一段"，用迭代器拼出来即可）
            // 驱动要求按窗口顺序喂数据时，这里倒序；普通驱动保持从上到下。
            let band = (0..rows as usize).flat_map(|i| {
                let r = match self.y_inverted {
                    true => rows as usize - 1 - i,
                    false => i,
                };
                let start = (band_y as usize + r) * canvas_width + x as usize;
                self.pixels[start..start + width as usize].iter().copied()
            });

            let draw_started = Instant::now();
            self.screen
                .draw_image_block(self.base.0 + x, self.base.1 + band_y, width, rows, band);
            stats.add_draw(
                width as u64 * rows as u64 * 2,
                draw_started.elapsed().as_micros(),
            );
            band_y += rows;
        }
        self.painted = Some(self.painted.map_or(bbox, |acc| acc.bounding(bbox)));
        // 画完立刻降回 SD 的时钟，下一帧的读卡不会超频
        if self.lcd_phase {
            let _ = self.bus.set_mhz(self.sd_clock_mhz);
            self.lcd_phase = false;
        }
    }
}

/// 打开并校验一个 `.ANM`。
///
/// **必须在回 `OK` 之前做完**：这样网页只会看到"要么收 `ERR`、要么开始播"两种结果，
/// 不会出现"先 `OK` 再报错"。
pub(super) fn load_anim<'a, D, T, S>(
    fs: &'a Fs<D, T>,
    screen: &Screen<S>,
    canvas_len: usize,
    name: &str,
) -> Result<LoadedAnim<'a, D, T>, &'static str>
where
    D: BlockDevice,
    D::Error: defmt::Format,
    T: TimeSource,
    S: DrawTarget<Color = Rgb565>,
    S::Error: core::fmt::Debug,
{
    let file = storage::open(fs, name).map_err(|e| {
        // 具体原因（卡读不动 / 文件不存在）只在 debug 级给：`media/play` 那句
        // `跳过 …` 的 warn 已经带上了网页能看到的结论，同一件事不必打两行。
        debug!("play: open {} failed: {:?}", name, e);
        "cannot open file"
    })?;

    let mut header_bytes = [0u8; anmfmt::HEADER_LEN];
    if file.read_exact(&mut header_bytes).is_err() {
        let _ = file.close();
        return Err("cannot read ANM header");
    }
    let header = match anmfmt::parse_header(&header_bytes) {
        Ok(header) => header,
        Err(msg) => {
            let _ = file.close();
            debug!("play: bad header in {}: {}", name, msg);
            return Err(msg);
        }
    };

    let screen_size = screen.size();
    if header.canvas_width as u32 > screen_size.width
        || header.canvas_height as u32 > screen_size.height
    {
        let _ = file.close();
        return Err("animation larger than screen");
    }
    if header.total_len as u64 != file.length() as u64 {
        let _ = file.close();
        return Err("bad ANM file length");
    }
    if canvas_len < header.canvas_width as usize * header.canvas_height as usize {
        let _ = file.close();
        return Err("canvas too small");
    }

    Ok(LoadedAnim { file, header })
}

/// 播一个已经打开的动画，**播完或被打断才返回**。
///
/// 循环次数由调用方给（`PLAYLIST` 的每一项）—— `.ANM` 文件里没有，
/// `loops = 0` 表示一直播到被 `media/stop` 打断。
///
/// 帧数据是“dirty bbox + 1bit/像素的变化位图 + 变化像素的颜色”。固件按位图把颜色
/// 合成到静态 RAM 画布（[`frame::compose`]），再按 32 行一带刷新 LCD（一帧拆成几百个小块刷会有“断层”感）；
/// 画屏那一段还会把共享 SPI 总线切到 LCD 相位时钟。
/// **帧节流那几行是实测调出来的，别动**。
#[allow(
    clippy::too_many_arguments,
    reason = "这是一条命令的实现，参数就是它要用到的几样板级资源：串口 / 屏幕 / 画布 / SPI 总线"
)]
pub(super) async fn play_loaded<D, T, S, U>(
    link: &mut Link<U>,
    screen: &mut Screen<S>,
    info: &DeviceInfo<'_>,
    state: &mut PlaybackState,
    canvas: &mut [u16],
    scratch: &mut PlayScratch<'_>,
    bus: &mut dyn BusClock,
    loaded: LoadedAnim<'_, D, T>,
    name: &str,
    loops: u16,
) -> PlayOutcome
where
    D: BlockDevice,
    D::Error: defmt::Format,
    T: TimeSource,
    S: DrawTarget<Color = Rgb565>,
    S::Error: core::fmt::Debug,
    U: crate::Serial,
{
    let LoadedAnim { file, header } = loaded;

    let screen_size = screen.size();
    let base = (
        ((screen_size.width - header.canvas_width as u32) / 2) as u16,
        ((screen_size.height - header.canvas_height as u32) / 2) as u16,
    );
    let size = CanvasSize {
        width: header.canvas_width as usize,
        height: header.canvas_height as usize,
    };
    // 用外部传入的静态画布：读取变化矩形后先合成，再按大块刷 LCD。
    // 容量已经在 load_anim 里校验过。
    let canvas = &mut canvas[..size.width * size.height];

    debug!(
        "play: {} / ANM v1 / SD {}MHz(req) / LCD 相位 {}MHz / readahead {} blocks / LCD {}B / chunk <= {}B",
        info.board.id,
        info.board.sd_clock_mhz,
        info.board.lcd_phase_mhz,
        info.board.readahead_blocks,
        info.board.lcd_buffer_bytes,
        info.board.play_read_bytes
    );
    debug!(
        "play: {} frames, {} loop(s), canvas {}x{}",
        header.frame_count, loops, header.canvas_width, header.canvas_height
    );
    screen.clear();

    if file.seek_from_start(anmfmt::HEADER_LEN as u32).is_err() {
        let _ = file.close();
        screen.show_status(&["Play Failed", "seek failed"]);
        ev_error(link, "seek failed");
        return PlayOutcome::Finished;
    }

    // 帧间轮询串口得到的"下一步"（None = 继续播）
    let mut next: Option<PlayOutcome> = None;
    // 工作缓冲是调用方给的**静态**内存：播放全程一个字节都不从堆上要
    let color = &mut scratch.color[..];
    let bitmap = &mut scratch.bitmap[..];
    let mut loops_done = 0u32;
    let mut failed: Option<&'static str> = None;
    let mut painter = Painter {
        screen,
        bus,
        pixels: canvas,
        size,
        base,
        align: info.board.x_align,
        row_align: info.board.y_align,
        sd_clock_mhz: info.board.sd_clock_mhz,
        lcd_phase_mhz: info.board.lcd_phase_mhz,
        draw_rows: info.board.play_draw_rows,
        y_inverted: info.board.y_inverted,
        lcd_phase: false,
        painted: None,
        leftover: None,
    };

    loop {
        if loops != LOOPS_INFINITE && loops_done >= loops as u32 {
            break;
        }
        state.set_loop(loops_done + 1);
        // 新一轮开始（第 1 轮也发）：网页点"播放"后靠它确认真跑起来了
        ev_loop(link, loops_done + 1);

        let loop_started = Instant::now();
        painter.begin_loop();
        let mut stats = LoopStats::default();
        // 每轮从零开始统计预读：这样日志里的命中/降级就是"这一轮"的
        storage::readahead_reset();

        for frame_index in 0..header.frame_count {
            // 每帧把进度写进播放状态：网页拿 `device/info` 的 frame 画卡片上的进度条
            state.set_frame(frame_index as usize + 1, header.frame_count as usize);
            // 同一件事现在也**主动推**（协议侧限速成每秒一条），进度条不再等轮询
            ev_frame(link, frame_index as usize + 1, header.frame_count as usize);
            let frame_started = Instant::now();

            let head = match frame::read_head(&file, size, &mut stats) {
                Ok(head) => head,
                Err(msg) => {
                    failed = Some(msg);
                    break;
                }
            };
            let bbox = head.bbox;
            if !bbox.is_empty() {
                if let Err(msg) = frame::compose(
                    &file,
                    bbox,
                    size,
                    painter.pixels,
                    color,
                    bitmap,
                    info.board.play_read_bytes,
                    &mut stats,
                ) {
                    failed = Some(msg);
                    break;
                }
                painter.present(bbox, &mut stats);
            }

            let frame_us = frame_started.elapsed().as_micros();
            let target_us = head.delay_ms.max(10) * 1_000;
            stats.add_frame(frame_us, target_us);
            if frame_us + SLEEP_MIN_US < target_us {
                Timer::after(Duration::from_micros(target_us - frame_us)).await;
            }

            // 这一帧没睡着（帧体比素材节奏还慢）时，上面那个 `if` 不会让出执行器，
            // 于是喂狗任务可能连续几秒轮不到 —— 必须在这里主动让一次。
            yield_now().await;

            // 帧边界看一眼串口：播放期间只认 stop / play / info。
            // 完全非阻塞，几微秒，不会影响上面的节流判断。
            if let Some(command) = link.try_command() {
                match command {
                    Command::MediaStop => {
                        // 停播这件事由 `playlist_cmd` 那句 `media/play: 停了` 收尾，这里不重复播报
                        debug!("play: stop after {} loops", loops_done);
                        // 停播事件**先排队**：它和 `OK` 的先后不该由帧循环决定，交给
                        // [`playlist_cmd`](super::playlist) 在画完欢迎屏、回完 `OK` 之后
                        // 统一 flush（回 `OK` 之前先冒别的字节，会撞上"屏还在同步画、
                        // 命令头几个字节丢在 RX FIFO 门外"那个老坑）。
                        ev_stop(link);
                        // 这条 stop 是在播放循环里被接住的，得自己回执 —— 否则网页
                        // 那边的 stop() 会一直等到超时。
                        //
                        // **回执交给调用方在重画欢迎屏之后发**（见 [`PlayOutcome::Stopped`]）：
                        // 网页一看到 `OK` 就立刻接着发下一条命令，而停播后那块欢迎屏是
                        // 同步画的（S3 上整屏推 PSRAM 帧缓冲，实测约 75ms），这段时间
                        // 固件不轮询串口，USB-Serial-JTAG 的 RX 又只有 64 字节 FIFO ——
                        // 命令的头几个字节直接丢在门外。真机日志实测：固件拼出来的行是
                        // `e/info`（`device/info` 少了 `devic`），回了一句
                        // `ERR unknown command`，网页于是显示"读卡失败"。
                        next = Some(PlayOutcome::Stopped);
                        break;
                    }
                    Command::MediaPlay { start } => {
                        next = Some(PlayOutcome::StartPlaylist(start));
                        break;
                    }
                    Command::DeviceInfo => info_cmd(link, painter.screen, info, state),
                    _ => link.err("busy"),
                }
            }
            // 把这一帧攒下的事件推出去（限速后大约一秒一条）。主机不取字节就立刻收手，
            // 不占帧预算 —— 播放不能因为"网页关了"而变慢。
            link.flush_events();
        }

        if failed.is_some() || next.is_some() {
            break;
        }
        loops_done += 1;
        // 每轮的三行计时是性能实测用的，不是运行状态：按 [`sampled`] 限速
        // （前几轮全样 + 之后周期性采样），整表循环播放时才不会一秒钟刷出十几行日志。
        if sampled(loops_done) {
            stats.log(loops_done, loop_started.elapsed().as_micros().max(1));
        }

        if loops != LOOPS_INFINITE && loops_done >= loops as u32 {
            break;
        }
        if file.seek_from_start(anmfmt::HEADER_LEN as u32).is_err() {
            failed = Some("rewind failed");
            break;
        }
        painter.end_loop();
    }

    let _ = file.close();
    if let Some(msg) = failed {
        warn!("play failed: {} ({})", msg, name);
        painter.screen.show_status(&["Play Failed", msg]);
        ev_error(link, msg);
        return PlayOutcome::Finished;
    }
    if let Some(outcome) = next {
        return outcome;
    }
    // 整表循环播时每一项每轮都会播完一次，这行按"轮"刷，不是低频事件：降到 debug
    debug!("play done: {}", name);
    PlayOutcome::Finished
}
