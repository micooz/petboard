#![no_std]
#![no_main]
#![deny(
    clippy::mem_forget,
    reason = "mem::forget is generally not safe to do with esp_hal types, especially those \
    holding buffers for the duration of a data transfer."
)]
#![deny(clippy::large_stack_frames)]

//! 这块板子的"组装说明书"：接线、初始化、然后把控制权交给 `fm_core::commands::run`。
//!
//! 和 C6 那块板的关系：逻辑（命令、播放引擎、协议、文件系统）全在 `fm-core` 里共用，
//! 这里只有这块板特有的三件事 —— 引脚表、ST77922 的 QSPI 接线、SDIO 卡的接线。
//!
//! 硬件（从出厂固件与厂商手册核对过）：
//!   ESP32-S3R8，16MB QSPI Flash + 8MB OPI PSRAM，芯片原生 USB-Serial-JTAG
//!   LCD：ST77922，320x480，**QSPI**（CS=IO10 CLK=IO12 D0=IO11 D1=IO13 D2=IO14 D3=IO9，BL=IO41）
//!   屏复位与芯片 EN 共用，所以没有单独的 LCD_RST
//!   TF 卡：**SDMMC（SDIO）**，CLK=IO5 CMD=IO4 D0=IO6 D1=IO7 D2=IO2 D3=IO3

use defmt::{info, warn};
use embassy_executor::Spawner;
use embassy_time::{Duration, Timer};
use embedded_sdmmc::{BlockDevice as _, VolumeManager};
use esp_backtrace as _;
use esp_hal::Blocking;
use esp_hal::clock::CpuClock;
use esp_hal::delay::Delay;
use esp_hal::gpio::{Level, Output, OutputConfig};
use esp_hal::spi::master::Config as SpiConfig;
use esp_hal::spi::master::Spi;
use esp_hal::time::Rate;
use esp_hal::timer::timg::{MwdtStage, MwdtStageAction, TimerGroup, Wdt};
use esp_hal::usb::usb_serial_jtag::UsbSerialJtag;
use esp_hal::{dma_rx_buffer, dma_tx_buffer};
use esp_println as _;
use fm_core::commands::PlayScratch;
use fm_core::link::Link;
use fm_core::screen::Screen;
use fm_core::storage::{self, FixedClock, ReadAhead};
use fm_core::{BoardConfig, Serial, SerialError, commands, reset};
use fm_esp_s3::panel::{HEIGHT as SCREEN_H, St77922, WIDTH as SCREEN_W};

use fm_esp_s3::qspi::{CHUNK_BYTES, QspiDevice};
use fm_esp_s3::sdio_block::{RUN_FREQ_HZ, SdioBlockDevice};
use static_cell::StaticCell;

extern crate alloc;

// =====================================================================
// 板级参数
// =====================================================================

/// 顺序预读一次读几个 512B 块（16 = 8KiB，和 C6 一致）
const READAHEAD_BLOCKS: usize = 16;

/// 播放时一次从卡上读多少字节
const PLAY_READ_BYTES: usize = 8192;

/// 合成画布后，一次最多刷多少行到 LCD
const PLAY_DRAW_ROWS: u16 = 32;

/// 一帧位图缓冲的大小：整幅画布 1 bit/像素
const PLAY_BITMAP_BYTES: usize = BoardConfig::play_bitmap_bytes(SCREEN_W, SCREEN_H);

/// 画布像素数（横屏 480x320）
const CANVAS_PIXELS: usize = SCREEN_W as usize * SCREEN_H as usize;

/// QSPI 的线速。ST77922 的写周期支持很高，但 S3 的 SPI2 在 80MHz 下对长排线容易出问题；
/// 40MHz 与厂商例程一致（`ST77922_PANEL_IO_QSPI_CONFIG` 就是 40MHz），先按这个来。
const QSPI_CLOCK_MHZ: u32 = 40;

/// 本板的参数（`fm-core` 的逻辑照这些值干活）
const BOARD: BoardConfig<'static> = BoardConfig {
    id: "s3-lcd-35",
    banner: concat!(
        "Pet Board v",
        env!("CARGO_PKG_VERSION"),
        " (",
        env!("BUILD_DATE"),
        ")"
    ),
    hint_url: env!("HINT_URL"),
    // S3 的发送路径是我们自己逐字节写的（不经过 esp-println 的有损写入器），
    // 而且屏幕大 2.8 倍、一帧首图最坏 ~305KiB —— 32B 一块要近一万次往返，
    // 会贴着网页 30s 的 DATA_TIMEOUT。这里放大到 512B。
    //
    // **512 要配得上，`Link::write_bytes_raw` 必须在 FIFO 满时主动 flush**：
    // USB-Serial-JTAG 的 TX FIFO 只有 64 字节，而且只有被 flush 过才会把数据交给主机。
    // 真机实测（同一块板、同一张卡）：不 flush 时按 512 回传，主机只收到 448 字节就
    // 再也不动；补上 flush 后连续读满 262144 字节 × 8 轮，约 290 KiB/s。
    get_chunk: 512,
    // ST77922 要求刷屏窗口的 **CASET** 边界对齐到 4 像素。横屏下 CASET 收的是逻辑 **y**
    // （软件转置，见 `panel.rs` 模块头），所以对齐落在 y 上，x 不要求。
    x_align: 1,
    y_align: 4,
    // CASET 由驱动反射到屏幕 y；多行数据保持普通“从上到下”顺序。
    // 面板快轴是 CASET，fill_contiguous 的行优先流会自然完成软件转置。
    y_inverted: false,
    // SDIO 与 QSPI 是两套独立外设，没有共享总线的相位问题
    sd_clock_mhz: RUN_FREQ_HZ / 1_000_000,
    lcd_phase_mhz: QSPI_CLOCK_MHZ,
    readahead_blocks: READAHEAD_BLOCKS,
    lcd_buffer_bytes: CHUNK_BYTES,
    play_read_bytes: PLAY_READ_BYTES,
    play_draw_rows: PLAY_DRAW_ROWS,
};

// This creates a default app-descriptor required by the esp-idf bootloader.
esp_bootloader_esp_idf::esp_app_desc!();

#[embassy_executor::task]
async fn feed_watchdog(mut watchdog: Wdt<esp_hal::peripherals::TIMG0<'static>>) {
    loop {
        Timer::after(Duration::from_secs(1)).await;
        watchdog.feed();
    }
}

/// SPI2 的配置。
///
/// 这里不带 DMA，所以不需要 C6 那条 `min_async_transfer_size`（那是为了"小传输别走 DMA"）。
fn spi_config(frequency: Rate) -> SpiConfig {
    SpiConfig::default().with_frequency(frequency)
}

#[allow(
    clippy::large_stack_frames,
    reason = "it's not unusual to allocate larger buffers etc. in main"
)]
#[esp_rtos::main]
async fn main(spawner: Spawner) -> ! {
    let config = esp_hal::Config::default().with_cpu_clock(CpuClock::max());
    let peripherals = esp_hal::init(config);

    // USB 串口外设（USB-Serial-JTAG）：日志和"电脑传文件给板子"用的是同一个口。
    // 和 C6 一样放在最前面，避免 espflash 的 monitor 连上之后又看到一次复位掉线。
    let mut link = Link::new(UsbSerial(UsbSerialJtag::new(peripherals.USB_DEVICE)));

    // 堆：内部 SRAM 里先开一块（协议和日志的 String/format! 用），
    // 大块的画布另外放 PSRAM（见下）。
    esp_alloc::heap_allocator!(#[esp_hal::ram(reclaimed)] size: 65536);
    esp_alloc::heap_allocator!(size: 64 * 1024);
    // 8MB OPI PSRAM：288KiB 的画布内部 SRAM 装不下，必须走这里
    esp_alloc::psram_allocator!(peripherals.PSRAM, esp_hal::psram);

    let timg0 = TimerGroup::new(peripherals.TIMG0);
    let mut watchdog = timg0.wdt;
    // 5 秒没喂狗说明有任务把执行器卡住了（最常见是卡读事务/SPI 等待）。
    watchdog.set_timeout(MwdtStage::Stage0, esp_hal::time::Duration::from_secs(5));
    watchdog.set_stage_action(MwdtStage::Stage0, MwdtStageAction::ResetSystem);
    watchdog.enable();
    esp_rtos::start(timg0.timer0, peripherals.FROM_CPU_INTR0);

    spawner.spawn(feed_watchdog(watchdog).expect("spawn watchdog"));

    let reset_reason = reset::text(reset_kind());
    info!("Reset reason: {}", reset_reason);

    // =====================================================================
    // LCD：ST77922，320x480，QSPI
    //
    // 引脚（厂商手册 + 出厂固件核对）：
    //   LCD_CS = GPIO10   QSPI_CLK = GPIO12   QSPI_D0..D3 = GPIO11/13/14/9
    //   LCD_BL = GPIO41（高电平点亮）
    //   屏复位与芯片 EN 共用，没有单独的 RST 引脚
    //
    // QSPI 没有 DC 线（命令走 opcode + 24 位地址，见 `fm_esp_s3::qspi`），
    // 所以这条路上没有 Data/Command 引脚。
    // =====================================================================

    // 用**带 DMA** 的 `SpiDma`：像素整段交给 DMA 搬。
    //
    // 缓冲必须放内部 SRAM（DMA 访问不了 PSRAM）：`dma_buffers!` 用的正是
    // `InternalMemory`，尺寸要和推屏暂存一致，否则一次 `half_duplex_write` 就溢出。
    // 收缓冲这条路上用不到（面板只收不发），给一个块的最小尺寸就行。
    let qspi_rx = dma_rx_buffer!(4).expect("QSPI: RX DMA 缓冲不合法");
    let qspi_tx = dma_tx_buffer!(CHUNK_BYTES).expect("QSPI: TX DMA 缓冲不合法");

    // `SpiDma::half_duplex_write` 会先检查 DMA 缓冲，没配缓冲直接报 `BufferTooSmall` ——
    // 连"只有命令+地址"的短帧都发不出去（真踩过），所以这里必须用 `with_buffers` 把收发缓冲配上。
    //
    // 为什么值得换：不带 DMA 时 esp-hal 按 **64 字节 FIFO** 分块，每块都要「填 → `update`
    // → 忙等 `usr` 清零」，填和发完全不重叠。真机实测一帧推 180306 字节要 17.8ms，
    // 而 40MHz 四线的线上时间只有 9.0ms —— 多出来的 8.8ms 全是这个循环的 CPU 开销。
    let spi = Spi::new(peripherals.SPI2, spi_config(Rate::from_mhz(QSPI_CLOCK_MHZ)))
        .expect("QSPI: 配置失败")
        .with_sck(peripherals.GPIO12)
        .with_sio0(peripherals.GPIO11)
        .with_sio1(peripherals.GPIO13)
        .with_sio2(peripherals.GPIO14)
        .with_sio3(peripherals.GPIO9)
        .with_dma(peripherals.DMA_CH0)
        .with_buffers(qspi_rx, qspi_tx);

    let lcd_cs = Output::new(peripherals.GPIO10, Level::High, OutputConfig::default());
    // 背光：高电平点亮。这里只做开/关，不做 PWM 调光。
    let mut lcd_bl = Output::new(peripherals.GPIO41, Level::Low, OutputConfig::default());

    // QSPI 的 CS 由驱动自己控制（每段像素共用一次 CS，见 `qspi.rs`）。
    let lcd_device = QspiDevice {
        spi,
        cs: lcd_cs,
        delay: Delay::new(),
    };

    // 攒像素用的静态缓冲（8KiB 的栈上数组会撞上 large_stack_frames）
    static LCD_BUFFER: StaticCell<[u8; CHUNK_BYTES]> = StaticCell::new();
    let lcd_buffer = LCD_BUFFER.init([0u8; CHUNK_BYTES]);

    // 动画播放用的画布：480x320x2 = 300KiB。
    //
    // **不能**用 `static`：静态数组进的是内部 SRAM 的 `.bss`，300KiB 装不下 ——
    // 链接会直接报 `cannot move location counter backwards`（真踩过）。
    // 这里从堆上要，而内部堆只有 128KiB，所以这么大的分配必然落到上面注册的 PSRAM 里。
    //
    // 注意**不能**把 Atomic 放进 PSRAM（S3 的原子指令访问 PSRAM 不正确），
    // 所以这里只用普通 u16 数组。
    let canvas: &'static mut [u16] =
        alloc::boxed::Box::leak(alloc::vec![0u16; CANVAS_PIXELS].into_boxed_slice());

    // LCD 驱动的本地帧缓冲：文本/图形先合成，再按面板要求的对齐窗口推屏。
    // 300KiB 和播放画布一样必须放 PSRAM。
    let lcd_framebuffer: &'static mut [u16] =
        alloc::boxed::Box::leak(alloc::vec![0u16; CANVAS_PIXELS].into_boxed_slice());

    // 播放的两块工作缓冲也放静态存储
    static PLAY_COLOR: StaticCell<[u8; PLAY_READ_BYTES]> = StaticCell::new();
    static PLAY_BITMAP: StaticCell<[u8; PLAY_BITMAP_BYTES]> = StaticCell::new();
    let mut play_scratch = PlayScratch {
        color: PLAY_COLOR.init([0u8; PLAY_READ_BYTES]),
        bitmap: PLAY_BITMAP.init([0u8; PLAY_BITMAP_BYTES]),
    };

    // 直接用我们自己的 ST77922 驱动（见 `panel.rs`：窗口、4 像素对齐、字节序那三条契约）
    let mut panel = St77922::new(lcd_device, lcd_buffer, lcd_framebuffer);
    panel.init(true).unwrap_or_else(|e| {
        warn!("LCD: ST77922 初始化失败：{:?}", defmt::Debug2Format(&e));
        panic!("LCD init failed");
    });
    lcd_bl.set_high();

    // ---- 点灯卡：`cargo run --release --features lcd-test` ----
    // 通过驱动本身画一张自证的测试图（角标方向 / 对齐补边 / 整屏覆盖 / MADCTL），
    // 每 8 秒换一趟 MADCTL，不返回。判读方法见 `testcard.rs` 的模块注释。
    #[cfg(feature = "lcd-test")]
    fm_esp_s3::testcard::run(&mut panel).await;

    let mut screen = Screen::new(panel);
    commands::draw_welcome(&mut screen, &BOARD);
    lcd_bl.set_high();
    // 这里只报屏；SD 摘要在下面的 SD 探测分支里单独一行，别重复。
    info!(
        "LCD ready: ST77922 {}x{} (landscape)",
        screen.size().width,
        screen.size().height
    );

    // =====================================================================
    // TF 卡：SDMMC（SDIO 4-bit）
    //
    // 引脚：CLK=GPIO5、CMD=GPIO4、D0..D3=GPIO6/7/2/3
    //
    // 卡没插好或初始化失败时，**照样把命令循环跑起来**：网页要能连上来看清原因
    // （`device/info` 的 `sd` 行会说 "no SD card"），而不是连端口都握不上手。
    // =====================================================================
    let sd_host = esp_hal::sdmmc::SdHostController::new(peripherals.SDHOST, Default::default())
        .expect("SDMMC: 主机初始化失败");

    match SdioBlockDevice::new(
        &sd_host,
        peripherals.GPIO5,
        peripherals.GPIO4,
        peripherals.GPIO6,
        peripherals.GPIO7,
        peripherals.GPIO2,
        peripherals.GPIO3,
    ) {
        Ok(card) => {
            let size_mb = card
                .num_blocks()
                .ok()
                .map(|n| n.0 as u64 * 512 / (1024 * 1024));
            let fs = VolumeManager::new(ReadAhead::<_, READAHEAD_BLOCKS>::new(card), FixedClock);
            let probed = storage::probe(&fs, size_mb);
            info!("SD: {}", probed.summary.as_str());
            commands::run(
                &mut link,
                &BOARD,
                &fs,
                &mut screen,
                reset_reason,
                &device_id(),
                probed.size_mb,
                &probed.summary,
                probed.mounted,
                canvas,
                &mut play_scratch,
                &mut NoBusClock,
            )
            .await
        }
        Err(e) => {
            warn!("SD: SDIO 初始化失败：{:?}", e);
            let empty = VolumeManager::new(FailingDevice, FixedClock);
            let probed = storage::probe(&empty, None);
            commands::run(
                &mut link,
                &BOARD,
                &empty,
                &mut screen,
                reset_reason,
                &device_id(),
                probed.size_mb,
                &probed.summary,
                probed.mounted,
                canvas,
                &mut play_scratch,
                &mut NoBusClock,
            )
            .await
        }
    }
}

/// 卡没挂上时垫在文件系统下面的块设备：任何访问都报错。
///
/// 这样 `device/info`、`media/list` 这些命令还能正常回答（列表是空的），
/// 网页连上之后能看清"是卡的问题"而不是"板子没反应"。
struct FailingDevice;

#[derive(Debug, defmt::Format)]
struct NoCard;

impl core::error::Error for NoCard {}

impl core::fmt::Display for NoCard {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("no SD card")
    }
}

impl embedded_sdmmc::BlockDevice for FailingDevice {
    type Error = NoCard;

    fn read(
        &self,
        _blocks: &mut [embedded_sdmmc::Block],
        _start: embedded_sdmmc::BlockIdx,
    ) -> Result<(), Self::Error> {
        Err(NoCard)
    }

    fn write(
        &self,
        _blocks: &[embedded_sdmmc::Block],
        _start: embedded_sdmmc::BlockIdx,
    ) -> Result<(), Self::Error> {
        Err(NoCard)
    }

    fn num_blocks(&self) -> Result<embedded_sdmmc::BlockCount, Self::Error> {
        Err(NoCard)
    }
}

/// 芯片出厂 MAC：网页拿它当缓存命名空间，换板子不会串数据。
fn device_id() -> alloc::string::String {
    alloc::format!("{}", esp_hal::efuse::base_mac_address())
}

/// 把 esp-hal 的 USB-Serial-JTAG 适配成 `fm-core` 要的 [`Serial`]。
struct UsbSerial(UsbSerialJtag<'static, Blocking>);

impl Serial for UsbSerial {
    fn read_byte(&mut self) -> fm_core::SerialResult<u8> {
        match self.0.read_byte() {
            Ok(byte) => Ok(byte),
            Err(nb::Error::WouldBlock) => Err(SerialError::WouldBlock),
            Err(nb::Error::Other(_)) => Err(SerialError::Other),
        }
    }

    fn write_byte_nb(&mut self, byte: u8) -> fm_core::SerialResult<()> {
        match self.0.write_byte_nb(byte) {
            Ok(()) => Ok(()),
            Err(nb::Error::WouldBlock) => Err(SerialError::WouldBlock),
            Err(nb::Error::Other(_)) => Err(SerialError::Other),
        }
    }

    fn flush_tx_nb(&mut self) -> fm_core::SerialResult<()> {
        match self.0.flush_tx_nb() {
            Ok(()) => Ok(()),
            Err(nb::Error::WouldBlock) => Err(SerialError::WouldBlock),
            Err(nb::Error::Other(_)) => Err(SerialError::Other),
        }
    }

    /// 协议状态机的超时问这里要时钟（微秒）。
    ///
    /// 协议 crate 因此**不依赖 embassy-time**：host 测试里给一个可以自己拨的假时钟，
    /// 板子上就转发 Embassy 的单调计时器。
    fn now_us(&mut self) -> u64 {
        embassy_time::Instant::now().as_micros()
    }
}

/// SDIO 与 QSPI 不共享总线，没有相位切换这回事 —— 空实现。
struct NoBusClock;

impl fm_core::BusClock for NoBusClock {
    fn set_mhz(&mut self, _mhz: u32) -> bool {
        false
    }
}

/// 本芯片的复位原因 → `fm-core` 的分类。
///
/// S3 的枚举名和 C6 不完全一样（`CpuMwdt0` 而不是 `Cpu0Mwdt0`，没有 `CoreSDIO`
/// 和 `Cpu0JtagCpu`，另有 `SysClkGlitch` / `CorePwrGlitch`）。
fn reset_kind() -> reset::ResetKind {
    use esp_hal::rtc_cntl::SocResetReason as R;
    match esp_hal::system::reset_reason() {
        Some(R::ChipPowerOn) => reset::ResetKind::ChipPowerOn,
        Some(R::CoreSw) => reset::ResetKind::CoreSw,
        Some(R::CoreDeepSleep) => reset::ResetKind::CoreDeepSleep,
        Some(R::CoreMwdt0) => reset::ResetKind::CoreMwdt0,
        Some(R::CoreMwdt1) => reset::ResetKind::CoreMwdt1,
        Some(R::CoreRtcWdt) => reset::ResetKind::CoreRtcWdt,
        Some(R::CpuMwdt0) => reset::ResetKind::CpuMwdt0,
        Some(R::CpuSw) => reset::ResetKind::CpuSw,
        Some(R::CpuRtcWdt) => reset::ResetKind::CpuRtcWdt,
        Some(R::SysBrownOut) => reset::ResetKind::SysBrownOut,
        Some(R::SysRtcWdt) => reset::ResetKind::SysRtcWdt,
        Some(R::CpuMwdt1) => reset::ResetKind::CpuMwdt1,
        Some(R::SysSuperWdt) => reset::ResetKind::SysSuperWdt,
        Some(R::SysClkGlitch) => reset::ResetKind::SysClkGlitch,
        Some(R::CoreEfuseCrc) => reset::ResetKind::CoreEfuseCrc,
        Some(R::CoreUsbUart) => reset::ResetKind::CoreUsbUart,
        Some(R::CoreUsbJtag) => reset::ResetKind::CoreUsbJtag,
        Some(R::CorePwrGlitch) => reset::ResetKind::CorePwrGlitch,
        None => reset::ResetKind::Unknown,
    }
}
