#![no_std]
#![no_main]
#![deny(
    clippy::mem_forget,
    reason = "mem::forget is generally not safe to do with esp_hal types, especially those \
    holding buffers for the duration of a data transfer."
)]
#![deny(clippy::large_stack_frames)]

//! 这块板子的"组装说明书"：接线、初始化、然后把控制权交给 [`commands::run`]。
//!
//! 逻辑全在 `fm-core` 里；这里只有这块板的接线、引脚表，以及把
//! `esp-hal` 的几个外设适配成 `fm-core` 要求的 trait。

use core::cell::RefCell;
use defmt::{info, warn};
use embassy_executor::Spawner;
use embassy_time::{Duration, Timer};
use embedded_hal_bus::spi::RefCellDevice;
use embedded_sdmmc::{SdCard, VolumeManager};
use esp_backtrace as _;
use esp_hal::Blocking;
use esp_hal::clock::CpuClock;
use esp_hal::delay::Delay;
use esp_hal::gpio::{Level, Output, OutputConfig};
use esp_hal::spi::master::Config as SpiConfig;
use esp_hal::spi::master::Spi;
use esp_hal::spi::master::SpiDma;
use esp_hal::time::Rate;
use esp_hal::timer::timg::{MwdtStage, MwdtStageAction, TimerGroup, Wdt};
use esp_hal::usb::usb_serial_jtag::UsbSerialJtag;
use esp_println as _;
use fm_core::commands::PlayScratch;
use fm_core::link::Link;
use fm_core::screen::Screen;
use fm_core::storage::{self, FixedClock, ReadAhead};
use fm_core::{BoardConfig, Serial, SerialError, commands, reset};
use mipidsi::Builder;
use mipidsi::interface::SpiInterface;
use mipidsi::models::ST7789;
use mipidsi::options::{ColorInversion, ColorOrder, Orientation, Rotation};
use static_cell::StaticCell;

extern crate alloc;

/// SPI 配置。**每次换频率都要用它** —— `apply_config` 会把整个 `Config` 换掉，
/// 直接给 `SpiConfig::default()` 会把 `min_async_transfer_size` 清成 0：
/// 那样连 SD 的 10 字节上电时钟、mipidsi 的命令参数（它们常被编译器放进 flash）都会走 DMA，
/// 而 DMA 读不了 flash → esp-hal 退回"拷贝到内部缓冲"，没配缓冲就报 `BufferTooSmall`（真机踩过）。
fn spi_config(frequency: Rate) -> SpiConfig {
    SpiConfig::default()
        .with_frequency(frequency)
        .with_min_async_transfer_size(SMALL_TRANSFER_USES_CPU_BYTES)
}

/// 小于这个字节数的传输不走 DMA（走 CPU 的 FIFO 路径）。
///
/// SD 协议里那些 1~6 字节的命令/响应用 DMA 反而更慢；而 mipidsi 初始化命令的参数是
/// flash 里的常量，DMA 根本读不了。512B 的 SD 载荷和 8KiB 的 LCD 推块才交给 DMA。
const SMALL_TRANSFER_USES_CPU_BYTES: usize = 64;

/// 顺序预读一次读几个 512B 块（16 = 8KiB）
const READAHEAD_BLOCKS: usize = 16;

/// SD 卡用的 SPI 时钟（MHz）。SD 的 SPI 模式规范上限是 25MHz。
///
/// ⚠️ esp-hal 会选"不超过请求值"的那个分频，所以实际拿到的**不是 25MHz**：
/// 源时钟 80MHz 时，25 只能取到 80/4 = 20MHz（实测确认过）。
const SD_CLOCK_MHZ: u32 = 25;

/// 画屏这一段把共享 SPI 总线提到多少 MHz。
///
/// LCD 和 SD 卡共用 SPI2，SD 的 SPI 模式规范上限是 25MHz，但 ST7789 写周期只要
/// ≥16ns（≈62MHz），所以**按相位分频**：读卡时低速、画屏时高速。
/// 实测：请求 25MHz（实得 20MHz）时总线 2064KiB/s，40MHz 时 3578KiB/s ——
/// 画屏这段的线速直接快 1.7 倍。
///
/// 如果画面出现花屏/错位，把这里改回 20（或 `SD_CLOCK_MHZ` 的值）即可整段禁用。
const LCD_PHASE_MHZ: u32 = 40;

/// mipidsi 一次向 LCD 推送像素的缓冲区大小。
const LCD_BUFFER_BYTES: usize = 8192;

/// 播放时一次从卡上读多少字节；读多行再画，减少 SD/`File::read` 调用次数。
const PLAY_READ_BYTES: usize = 8192;

/// 合成画布后，一次最多刷多少行到 LCD，减少小矩形造成的“断层”感。
const PLAY_DRAW_ROWS: u16 = 32;

/// 一帧位图缓冲的大小：整幅画布 1 bit/像素（画布尺寸和下面 `CANVAS` 一致）。
const PLAY_BITMAP_BYTES: usize = BoardConfig::play_bitmap_bytes(320, 172);

/// 板载 LCD：Waveshare ESP32-C6-LCD-1.47（ST7789，172x320）
///
/// 这是面板"贴装方向"（竖屏）的尺寸，`display_size()` 必须按这个坐标填；
/// mipidsi 会按 `orientation` 自动交换宽高（横屏时逻辑尺寸是 320x172）。
const LCD_WIDTH: u16 = 172;
const LCD_HEIGHT: u16 = 320;

/// 本板的参数（`fm-core` 的逻辑照这些值干活）
const BOARD: BoardConfig<'static> = BoardConfig {
    id: "c6-lcd-147",
    banner: concat!(
        "Pet Board v",
        env!("CARGO_PKG_VERSION"),
        " (",
        env!("BUILD_DATE"),
        ")"
    ),
    hint_url: env!("HINT_URL"),
    // C6 上 `esp-println` 的 TX FIFO 缺陷要求回传块远小于 64B，取一半
    get_chunk: 32,
    // ST7789 对刷屏窗口没有对齐要求（两个轴都填 1）
    x_align: 1,
    y_align: 1,
    // ST7789 的 y 方向正常，不需要反射
    y_inverted: false,
    sd_clock_mhz: SD_CLOCK_MHZ,
    lcd_phase_mhz: LCD_PHASE_MHZ,
    readahead_blocks: READAHEAD_BLOCKS,
    lcd_buffer_bytes: LCD_BUFFER_BYTES,
    play_read_bytes: PLAY_READ_BYTES,
    play_draw_rows: PLAY_DRAW_ROWS,
};

// This creates a default app-descriptor required by the esp-idf bootloader.
// For more information see: <https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/system/app_image_format.html#application-description>
esp_bootloader_esp_idf::esp_app_desc!();

#[embassy_executor::task]
async fn feed_watchdog(mut watchdog: Wdt<esp_hal::peripherals::TIMG0<'static>>) {
    loop {
        Timer::after(Duration::from_secs(1)).await;
        watchdog.feed();
    }
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
    //
    // 这里刻意放在最前面：esp-hal 首次启用这个外设时会顺手复位它一次
    // （esp-hal 的 PeripheralClockControl::enable 返回 true 时就 reset），
    // 复位会让电脑那边看到一次"拔插"。放在开机最前面，能在 espflash 的 monitor
    // 真正连上之前做完，避免看着日志突然掉线。
    let mut link = Link::new(UsbSerial(UsbSerialJtag::new(peripherals.USB_DEVICE)));

    // The following pins are used to bootstrap the chip. They are available
    // for use, but check the datasheet of the module for more information on them.
    // - GPIO4
    // - GPIO5
    // - GPIO8
    // - GPIO9
    // - GPIO15
    // These GPIO pins are in use by some feature of the module and should not be used.
    let _gpio24 = peripherals.GPIO24;
    let _gpio25 = peripherals.GPIO25;
    let _gpio26 = peripherals.GPIO26;
    let _gpio27 = peripherals.GPIO27;
    let _gpio28 = peripherals.GPIO28;
    let _gpio29 = peripherals.GPIO29;
    let _gpio30 = peripherals.GPIO30;

    esp_alloc::heap_allocator!(#[esp_hal::ram(reclaimed)] size: 65536);
    // COEX needs more RAM - so we've added some more
    esp_alloc::heap_allocator!(size: 64 * 1024);

    let timg0 = TimerGroup::new(peripherals.TIMG0);
    let mut watchdog = timg0.wdt;
    // 5 秒没有喂狗说明有任务把执行器卡住了（最常见是 SD 读事务/SPI 等待）。
    // 独立喂狗任务在正常 await 时能跑，synchronous 阻塞超过 5s 时它跑不了，
    // 硬件看门狗会把芯片复位，让网页重新连上而不是永久失去响应。
    watchdog.set_timeout(MwdtStage::Stage0, esp_hal::time::Duration::from_secs(5));
    watchdog.set_stage_action(MwdtStage::Stage0, MwdtStageAction::ResetSystem);
    watchdog.enable();
    esp_rtos::start(timg0.timer0, peripherals.FROM_CPU_INTR0);

    spawner.spawn(feed_watchdog(watchdog).expect("spawn watchdog"));

    let reset_reason = reset::text(reset_kind());
    info!("Reset reason: {}", reset_reason);

    // =====================================================================
    // 板载 LCD：Waveshare ESP32-C6-LCD-1.47（ST7789 控制器，172x320）
    //
    // 引脚取自 Waveshare 官方原理图与官方例程（非猜测）：
    //   LCD_MOSI = GPIO6   LCD_SCLK = GPIO7   LCD_CS  = GPIO14
    //   LCD_DC   = GPIO15  LCD_RST  = GPIO21  LCD_BL  = GPIO22
    // GPIO6/GPIO7 与 TF 卡座共用同一条 SPI 总线；
    // GPIO4/5/8/9/15 是 strapping 脚，其中 GPIO15 在这里当 LCD DC 用。
    // =====================================================================
    let mut lcd_delay = Delay::new();

    // SPI2 总线：LCD 和 TF 卡共用
    //   MOSI=GPIO6、SCLK=GPIO7 两个设备共用
    //   MISO=GPIO5 只有 TF 卡用来读数据（LCD 不需要）
    // 一条总线两个设备：把总线放进 RefCell，再各包一个"带自己 CS"的 SpiDevice。
    //
    // 用 DMA 版（`SpiDma`，它本身就是个 `SpiBus`）：CPU 版每 64B 一个 FIFO 块、
    // 每块有几微秒固定开销（实测读路径 11.6µs/块），而真正的数据只有几百字节；
    // DMA 一次把整块搬完。`min_async_transfer_size` 让 64B 以下的小传输仍走 CPU ——
    // SD 协议里那些 1~6 字节的命令/响应用 DMA 反而更慢，而且 init 命令的常量还在 flash 里。
    let spi = Spi::new(peripherals.SPI2, spi_config(Rate::from_mhz(40)))
        .expect("SPI: 配置失败")
        .with_sck(peripherals.GPIO7)
        .with_mosi(peripherals.GPIO6)
        .with_miso(peripherals.GPIO5)
        .with_dma(peripherals.DMA_CH0);

    let spi_bus = RefCell::new(spi);

    let lcd_cs = Output::new(peripherals.GPIO14, Level::High, OutputConfig::default());
    let lcd_dc = Output::new(peripherals.GPIO15, Level::Low, OutputConfig::default());
    let lcd_rst = Output::new(peripherals.GPIO21, Level::High, OutputConfig::default());
    // 背光走 N-MOSFET（SI2302），高电平点亮
    let mut lcd_bl = Output::new(peripherals.GPIO22, Level::Low, OutputConfig::default());

    // TF 卡的 CS = GPIO4（SpiDevice 会保证不通信时它是高电平）
    let tf_cs = Output::new(peripherals.GPIO4, Level::High, OutputConfig::default());

    let lcd_device =
        RefCellDevice::new(&spi_bus, lcd_cs, Delay::new()).expect("LCD: CS 引脚初始化失败");
    let tf_device =
        RefCellDevice::new(&spi_bus, tf_cs, Delay::new()).expect("TF: CS 引脚初始化失败");

    // mipidsi 需要一块缓冲区来批量推送像素，放静态存储避免占堆栈。
    // 越大，一次 SPI write 的数据越多，LCD 命令/切换开销越小；8KiB 占 RAM 很少。
    static LCD_BUFFER: StaticCell<[u8; LCD_BUFFER_BYTES]> = StaticCell::new();
    let lcd_buffer = LCD_BUFFER.init([0u8; LCD_BUFFER_BYTES]);

    // 动画播放用的静态 RGB565 画布。放 .bss，不走只有 ~128KB 的堆，
    // 这样 v3 变化矩形可以先在 RAM 合成、再按大块刷新，避免一帧几百个小块“断层”。
    static CANVAS: StaticCell<[u16; 320 * 172]> = StaticCell::new();
    let canvas = CANVAS.init([0u16; 320 * 172]);

    // 播放时的两块工作缓冲（颜色读缓冲 + 一帧位图）也放静态存储：
    // 堆要留给协议和日志那点 String/format!，播放全程从堆上拿 15KB 会把它们挤死
    // （实测停播时欢迎屏的 format! 分配失败 panic，见 commands::PlayScratch）。
    static PLAY_COLOR: StaticCell<[u8; PLAY_READ_BYTES]> = StaticCell::new();
    static PLAY_BITMAP: StaticCell<[u8; PLAY_BITMAP_BYTES]> = StaticCell::new();
    let mut play_scratch = PlayScratch {
        color: PLAY_COLOR.init([0u8; PLAY_READ_BYTES]),
        bitmap: PLAY_BITMAP.init([0u8; PLAY_BITMAP_BYTES]),
    };

    let lcd_interface = SpiInterface::new(lcd_device, lcd_dc, lcd_buffer);

    // ST7789 显存是 240 列 x 320 行，172 宽的面板居中，左右各留 34 列，所以偏移 (34, 0)。
    //
    // 下面三个参数在 Waveshare 自家的两份例程里不一致，这里取的是证据更强的一组
    // （Arduino 例程 Dec-2024 版 + 第三方 Rust demo，两者一致；ESP-IDF 例程是旧的另一组）：
    //   Orientation::new().rotate(Rotation::Deg90) -> 横屏，MADCTL = MY|MV (0xA0)
    //   ColorOrder::Rgb                -> MADCTL 不置 BGR
    //   ColorInversion::Inverted       -> 发 INVON（两份例程都这么发）
    // 若现象不符，按下面这张表只改一行：
    //   画面偏成另一个横屏方向（上下颠倒）-> Rotation::Deg90 换成 Rotation::Deg270
    //   文字左右镜像      -> 改成 Orientation::new().flip_horizontal()，并把 ColorOrder 改成 Bgr
    //   黑底白字反了      -> 改成 ColorInversion::Normal
    //   画面整体偏 34 像素 -> display_offset(0, 0)
    //   以后加了彩色还偏色 -> ColorOrder 换成 Bgr
    let display = Builder::new(ST7789, lcd_interface)
        .display_size(LCD_WIDTH, LCD_HEIGHT)
        .display_offset(34, 0)
        // 横屏：把逻辑画面绕屏旋转 90°。display_size 仍填竖屏的 172x320，
        // mipidsi 会自己交换宽高，并把偏移 (34, 0) 换算到旋转后的轴上
        // （竖屏偏的是 x，横屏偏的是 y，数值都是 34，所以 offset 不用改）。
        .orientation(Orientation::new().rotate(Rotation::Deg90))
        .color_order(ColorOrder::Rgb)
        .invert_colors(ColorInversion::Inverted)
        .reset_pin(lcd_rst)
        .init(&mut lcd_delay)
        .expect("LCD: ST7789 初始化失败");

    // 屏幕这块的细节（字体、居中、逐行写）都在 screen 模块里
    let mut screen = Screen::new(display);
    // 开机第一屏直接就是欢迎屏（产品名 + 版本 + 编译日期 + 网页地址）。
    // 早点画出来，卡初始化慢的时候屏幕也不会一直黑着；它只用编译期常量，不依赖 SD。
    // 和"播完/上传成功后回欢迎屏"共用同一段绘制逻辑。
    commands::draw_welcome(&mut screen, &BOARD);

    // =====================================================================
    // TF 卡（SD）：初始化 → 挂载 FAT → 探一下根目录
    // =====================================================================
    // 1) 卡片初始化按规范要在 ≤400kHz 下做，同时给卡发上电后的初始时钟
    //    （此时 LCD 和 TF 两个设备的 CS 都是高电平，所以这些时钟谁都不会理）
    {
        let mut bus = spi_bus.borrow_mut();
        if let Err(e) = bus.apply_config(&spi_config(Rate::from_khz(400))) {
            warn!("SD: SPI 降到 400kHz 失败（{:?}）", e);
        }
        if let Err(e) = bus.write(&[0xFF; 10]) {
            warn!("SD: 发送初始时钟失败（{:?}）—— 继续，挂载那步会报出来", e);
        }
    }

    // 2) 初始化卡片（num_bytes 会触发初始化），再挂载第一个 FAT 分区
    let sdcard = SdCard::new(tf_device, Delay::new());
    let size_mb = sdcard.num_bytes().map(|bytes| bytes / (1024 * 1024)).ok();
    let fs = VolumeManager::new(ReadAhead::<_, READAHEAD_BLOCKS>::new(sdcard), FixedClock);

    // 3) 探测：卡多大、能不能挂上 FAT
    let card = storage::probe(&fs, size_mb);
    info!("SD: {}", card.summary.as_str());

    // 4) 提速：SD 的 SPI 模式规范上限 25MHz，LCD 用这个速度也足够快。
    // 若某张卡在 25MHz 下不稳定，改回 20MHz（只是读卡更慢一些）。
    spi_bus
        .borrow_mut()
        .apply_config(&spi_config(Rate::from_mhz(SD_CLOCK_MHZ)))
        .expect("SPI: 提速到 25MHz 失败");

    // 欢迎屏在 LCD 初始化之后就已经画好了（内容只跟编译期常量有关），这里只开背光。
    lcd_bl.set_high();
    // SD 摘要在上面单独一行已经报过，这里只说屏，别把同一件事打两遍。
    info!(
        "LCD ready: ST7789 {}x{} (landscape)",
        screen.size().width,
        screen.size().height
    );

    // 芯片出厂 MAC：网页拿它当缓存命名空间，换板子不会串数据。
    let device_id = alloc::format!("{}", esp_hal::efuse::base_mac_address());

    // =====================================================================
    // 交出去：主循环在 commands 模块里，等着网页发 device/info、media/…
    // =====================================================================
    commands::run(
        &mut link,
        &BOARD,
        &fs,
        &mut screen,
        reset_reason,
        &device_id,
        size_mb,
        &card.summary,
        card.mounted,
        &mut canvas[..],
        &mut play_scratch,
        &mut SpiBusClock { bus: &spi_bus },
    )
    .await
}

/// 把 SPI2 总线借给命令层 —— 播放时画屏那一段要把时钟升到 LCD 相位（`LCD_PHASE_MHZ`）。
///
/// 拿的是 `&RefCell<Spi>`（和 LCD / TF 两个 `RefCellDevice` 同源），不直接握住总线；
/// 只在切换相位时 `borrow_mut()` 一下。
struct SpiBusClock<'a, 'd> {
    bus: &'a RefCell<SpiDma<'d, Blocking>>,
}

impl commands::BusClock for SpiBusClock<'_, '_> {
    fn set_mhz(&mut self, mhz: u32) -> bool {
        // 注意用 spi_config：直接把 Config 换成 default 会把"小传输走 CPU"的阈值清掉，
        // 之后 mipidsi 的 flash 常量命令就会撞上 DMA 读不了的问题。
        self.bus
            .borrow_mut()
            .apply_config(&spi_config(Rate::from_mhz(mhz)))
            .is_ok()
    }
}

/// 把 esp-hal 的 USB-Serial-JTAG 适配成 `fm-core` 要的 [`Serial`]。
///
/// `nb::Result` 里那个 `Infallible` 直接映射成 [`SerialError::Other`]：这块外设的读写
/// 只有"有没有数据"两种结果，不会真的报错。
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

/// 本芯片的复位原因 → `fm-core` 的分类（枚举名和 C6 的 `SocResetReason` 一一对应）。
fn reset_kind() -> reset::ResetKind {
    use esp_hal::rtc_cntl::SocResetReason as R;
    match esp_hal::system::reset_reason() {
        Some(R::ChipPowerOn) => reset::ResetKind::ChipPowerOn,
        Some(R::CoreSw) => reset::ResetKind::CoreSw,
        Some(R::CoreDeepSleep) => reset::ResetKind::CoreDeepSleep,
        Some(R::CoreSDIO) => reset::ResetKind::CoreSdio,
        Some(R::CoreMwdt0) => reset::ResetKind::CoreMwdt0,
        Some(R::CoreMwdt1) => reset::ResetKind::CoreMwdt1,
        Some(R::CoreRtcWdt) => reset::ResetKind::CoreRtcWdt,
        Some(R::Cpu0Mwdt0) => reset::ResetKind::CpuMwdt0,
        Some(R::Cpu0Sw) => reset::ResetKind::CpuSw,
        Some(R::Cpu0RtcWdt) => reset::ResetKind::CpuRtcWdt,
        Some(R::SysBrownOut) => reset::ResetKind::SysBrownOut,
        Some(R::SysRtcWdt) => reset::ResetKind::SysRtcWdt,
        Some(R::Cpu0Mwdt1) => reset::ResetKind::CpuMwdt1,
        Some(R::SysSuperWdt) => reset::ResetKind::SysSuperWdt,
        Some(R::CoreEfuseCrc) => reset::ResetKind::CoreEfuseCrc,
        Some(R::CoreUsbUart) => reset::ResetKind::CoreUsbUart,
        Some(R::CoreUsbJtag) => reset::ResetKind::CoreUsbJtag,
        Some(R::Cpu0JtagCpu) => reset::ResetKind::CpuJtagCpu,
        None => reset::ResetKind::Unknown,
    }
}
