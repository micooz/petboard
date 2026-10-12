//! 两块板共用的固件逻辑。
//!
//! 这里**不依赖任何芯片**（不 use esp-hal）：命令实现、播放引擎、串口协议、
//! 屏幕绘制、卡上的目录与文件读写全在这里。每块板子只提供"怎么接线"——
//! 引脚、外设实例，以及本模块定义的几个 trait 的实现。
//!
//! 按职责拆开：
//!
//! - [`screen`]：往屏幕上画文字 / 像素块
//! - [`storage`]：卡（挂载 FAT、列目录、读写文件）+ 顺序预读
//! - [`wire`]：本产品的**业务报文层**（命令语法、应答内容、事件、协议版本、生成器）
//! - [`link`]：把协议 crate 的**同步状态机**接到 Embassy 上（等字节 / 等 ACK / 睡到超时）
//! - `anmfmt`（在 `crates/anmfmt`）：`.ANM` 动画格式
//! - [`reset`]：上次复位原因 → 一行短文本（文案表，值由板子读出来）
//! - [`commands`]：`device/*` 与 `media/*` 命令的实现 + 主循环
//!
//! 两条分层线，别混：
//!
//! - `crates/serial`（外部 crate）＝**通用线路机制**：哨兵成帧、ID 配对、标签槽、
//!   块 ACK、TX 节流、通知队列。它不知道 `media/*` 是什么，换一路业务原样复用。
//! - [`wire`]＝**PetBoard 的语义**：词表、命令语法、`device/info` 的应答行、播放清单、
//!   事件名与限速策略、协议版本，以及网页侧常量/fixture 的生成器。

#![no_std]

extern crate alloc;

// 跑 `cargo test` 时才需要 std（测试框架）；板上仍然只用 core / alloc
#[cfg(test)]
extern crate std;

pub mod commands;
pub mod link;
pub mod reset;
pub mod screen;
pub mod storage;
pub mod wire;

/// 命令层常用的业务报文项，放在 `crate` 这一层用着顺（权威在 [`wire`]）。
pub use wire::{
    API_VERSION, Command, IoStats, LOOPS_INFINITE, PLAYLIST_FILE, PlaybackState, device_info_lines,
    parse_command, parse_playlist,
};

/// 串口的一个字节 / 错误类型 / trait 全部来自协议 crate（`crates/serial`）。
///
/// "报文怎么进出"是协议的语义，收在协议 crate 里；`fm-core` 只 re-export，两块板的
/// `main.rs` 照旧 `use fm_core::{Serial, SerialError, SerialResult}`（不用改 import 路径）。
pub use serial::{Serial, SerialError, SerialResult};

/// 换共享 SPI 总线的时钟。
///
/// C6 板上 LCD 和 TF 卡共用一条 SPI2，读卡和画屏要按相位分频（见 [`BoardConfig::lcd_phase_mhz`]），
/// 所以命令层需要一个能改频率的把手。
/// S3 板上 SDIO 与 QSPI 是两套独立外设，实现成空操作即可。
///
/// 命令层不关心底下是 `esp_hal::Spi` 还是别的，所以隔一层 trait；实现在板子那侧。
pub trait BusClock {
    /// 把总线时钟设成 `mhz`；成功返回 `true`
    fn set_mhz(&mut self, mhz: u32) -> bool;
}

/// 板级参数：几处"两块板不一样、但逻辑层要照着做"的值。
///
/// 集中放这里，是为了让 [`commands::run`] 的签名不必随板子增长。
pub struct BoardConfig<'a> {
    /// 板子标识（`device/info` 的 `board` 行，给网页显示用）
    pub id: &'a str,
    /// 欢迎屏第一行：产品名 + 版本 + 编译日期（板子 `build.rs` 注入的编译期常量）
    pub banner: &'a str,
    /// 欢迎屏第三行：网页地址（`PET_BOARD_HINT_URL`，板子 `build.rs` 注入）
    pub hint_url: &'a str,
    /// `media/get` 回传方向一块的字节数。
    ///
    /// 这个值原本是为 C6 上 `esp-println` 的 TX FIFO 缺陷定的（见 [`wire::GET_CHUNK_C6`]）；
    /// 板子的发送路径不同、串口带宽不同，所以由板子自己报，网页照它分块。
    pub get_chunk: usize,
    /// 刷屏窗口在 **x 方向**（屏幕横轴）必须对齐到几像素。
    ///
    /// 面板要求对齐的是它 **CASET** 那条寄存器，而两块板的映射不同：
    /// C6（ST7789，`x → CASET`）对 x 有要求、S3（ST77922，`y → CASET`）对 y 有要求。
    /// 所以两块板各填自己那条轴，另一条填 1。见 [`commands::align_span`]。
    pub x_align: u16,
    /// 刷屏窗口在 **y 方向**（屏幕纵轴）必须对齐到几像素（填法与 [`Self::x_align`] 配套）。
    pub y_align: u16,
    /// 驱动的多行像素接口要求调用方按面板窗口顺序倒序给数据时填 `true`。
    ///
    /// 当前 S3 的帧缓冲推屏接口收普通逻辑行序，C6 也是普通“从上到下”，
    /// 所以两块板都填 `false`；保留这个开关给将来需要窗口序的驱动。
    pub y_inverted: bool,
    /// 读卡时总线停在多少 MHz（只对 C6 那种"卡和屏共用总线"的板子有意义）
    pub sd_clock_mhz: u32,
    /// 画屏那一段把总线提到多少 MHz（同上；S3 独立总线，用不到）
    pub lcd_phase_mhz: u32,
    /// 顺序预读一次读几个 512B 块
    pub readahead_blocks: usize,
    /// 推屏缓冲的字节数（mipidsi 一次向 LCD 推多少）
    pub lcd_buffer_bytes: usize,
    /// 播放时一次从卡上读多少字节
    pub play_read_bytes: usize,
    /// 播放时一次最多刷多少行到 LCD
    pub play_draw_rows: u16,
}

impl BoardConfig<'_> {
    /// 一帧位图缓冲要多大：整幅画布 1 bit/像素。
    ///
    /// 板子拿它给 `StaticCell` 定尺寸；画布尺寸是板子自己的事，所以这里只给公式。
    pub const fn play_bitmap_bytes(canvas_width: u16, canvas_height: u16) -> usize {
        (canvas_width as usize).div_ceil(8) * canvas_height as usize
    }
}
