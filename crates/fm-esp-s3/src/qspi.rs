//! QSPI 底层：把"命令 / 像素"按 ST77922 的帧格式发到 SPI2 上。
//!
//! ## 这块屏的 QSPI 帧长什么样
//!
//! 它**不是**普通四线 SPI。每一笔传输是"8 位 opcode + 24 位地址"的固定头部，后面跟数据：
//!
//! | 用途 | opcode | 24 位地址 | 数据 |
//! |---|---|---|---|
//! | 写命令 / 写参数 | `0x02` | 命令字节放高 8 位 | 参数；命令无参数时**没有数据阶段** |
//! | 写像素 | `0x32` | **`0x3C00`**（`RAMWRC` 放高 8 位） | RGB565 |
//!
//! ⚠️ 写像素的地址是 **`0x3C`（RAMWRC，写显存"续传"）**，不是 `0x2C`（RAMWR，写显存"开始"）。
//! 厂商例程（<https://github.com/ydedox/st77922> 的 `Simple_test.ino`）把两者分得很清楚：
//! 写命令用 `addr = cmd << 8`（`0x2C` 也在其中，但那是**命令**相位，整张初始化表里只发一次），
//! 写像素一律 `addr = 0x3C << 8` —— `LCD_Write_Data` 和 `LCD_Clear` 都是这么发的。
//!
//! ## 哪几相位走几条线（最容易搞错的一处）
//!
//! ESP-IDF 的 `esp_lcd_panel_io_spi.c` 写得很直白（`quad_mode` 分支的注释就是
//! "use 4 lines only for transmitting data"）：
//!
//! - **命令帧**（`tx_param`）：整笔**单线** —— opcode、24 位地址、参数都走 SIO0；
//! - **像素帧**（`tx_color`）：opcode 与 24 位地址**单线**，只有后面的像素数据走四线。
//!
//! 一开始这里把命令帧也按四线发，结果面板一个命令都没认出来 —— 屏幕亮着但停在出厂默认
//! 状态（一片发灰的浅色），真机上踩过。
//!
//! ## 字节序：面板要大端
//!
//! 这块面板按 **大端** 收 RGB565：`0xF800`（红）要发成 `00 F8`。厂商例程里那句
//! `color_swap = (color >> 8) | (color << 8)` 就是在做这个交换。不交换的话，
//! 相邻像素的颜色位会互相错位交织，屏幕上一片彩色噪点（真机踩过）。
//! 本 crate 里这条约定由 `panel.rs` 的 `put()` 负责（逐字节写大端）。
//!
//! ## 两处"必须这样"的地方
//!
//! - **命令无参数时不能带空的数据阶段**。`Spi::half_duplex_write` 收到空 buffer 时
//!   只发命令+地址就收工（见 esp-hal `spi/master/low_level/mod.rs` 的 `half_duplex_write`），
//!   这正是要的行为 —— 硬塞一个字节反而会被面板当成参数。
//! - **一整段像素必须共用一次 CS 低电平**。普通 SPI 可以把一串像素拆成好几笔，反正每笔
//!   就是数据；但 QSPI 每笔都自带 `0x32 + 地址` 的头，而推屏缓冲只有 8KiB、一帧几十 KiB
//!   必然要拆好几笔。一开始把 CS 的开关放进了每个 8KiB 分块里，一次全屏清屏就翻了 38 次
//!   CS，屏幕出现错乱；现在按厂商例程的形状：`CS_LOW → 逐块发 → CS_HIGH`。

use embedded_hal::digital::OutputPin;
use esp_hal::Blocking;
use esp_hal::delay::Delay;
use esp_hal::spi::master::SpiDma;
use esp_hal::spi::master::{Address, Command, DataMode};

/// 写命令 / 写参数的 opcode
const OPCODE_WRITE_CMD: u16 = 0x02;
/// 写像素（`RAMWRC`）的 opcode
const OPCODE_WRITE_COLOR: u16 = 0x32;

/// 写像素用的 24 位地址：`RAMWRC`（0x3C）放高 8 位。
///
/// 注意是 **0x3C**（"继续写"），不是 0x2C（"开始写"）。见模块头。
const ADDR_RAMWRC: u32 = 0x3C00;

/// 命令相位（opcode / 24 位地址 / 参数）走单线
const CMD_MODE: DataMode = DataMode::Single;
/// 只有像素数据走四线
const PIXEL_MODE: DataMode = DataMode::Quad;

/// 一次 `half_duplex_write` 最多发多少字节（也是推屏暂存缓冲的大小）。
///
/// 像素走 **DMA**（见 [`QspiDevice::vendor_pixels`]）：CPU 半双工写按 64 字节 FIFO
/// 分块，每块都要「填 → `update` → 忙等 `usr` 清零」，填和发完全不能重叠。真机实测
/// 一帧推 180306 字节要 17.8ms，而 40MHz 四线只要 9.0ms —— 那 8.8ms 全是这个循环的
/// CPU 开销（C6 的读路径也踩过同一个坑，见 `crates/fm-esp-c6/src/main.rs`）。
pub const CHUNK_BYTES: usize = 8192;

/// QSPI 面板的"设备"：总线 + 片选 + 帧间延时。
///
/// QSPI 没有 DC 线，所以这里比普通 SPI 面板少一个引脚 —— 命令/参数的区分完全靠 opcode。
pub struct QspiDevice<'d, CS> {
    /// 带 DMA 的 SPI2：像素整段交给 DMA 搬，CPU 只在块边界出现
    pub spi: SpiDma<'d, Blocking>,
    pub cs: CS,
    pub delay: Delay,
}

impl<CS: OutputPin> QspiDevice<'_, CS> {
    /// 照厂商 `LCD_Write_Reg` 发一条命令（+ 可选参数）。
    ///
    /// opcode `0x02`、地址高 8 位放命令、参数跟在数据相位 —— 与厂商例程逐字对应。
    pub fn vendor_cmd(&mut self, cmd: u8, args: &[u8]) -> Result<(), FrameError> {
        self.frame(OPCODE_WRITE_CMD, (cmd as u32) << 8, CMD_MODE, args)
    }

    /// 照厂商 `LCD_Write_Data` 写一段像素（整段共用一次 CS）。
    pub fn vendor_pixels(&mut self, data: &[u8]) -> Result<(), FrameError> {
        if data.is_empty() {
            return Ok(());
        }
        self.cs.set_low().map_err(|_| FrameError::Pin)?;
        let result = (|| {
            for chunk in data.chunks(CHUNK_BYTES) {
                self.pixel_data(chunk)?;
            }
            Ok(())
        })();
        let ended = self.cs.set_high().map_err(|_| FrameError::Pin);
        result.and(ended)
    }

    /// 发一笔**完整的**帧：拉低 CS → 发帧 → 拉高 CS。
    fn frame(
        &mut self,
        opcode: u16,
        address: u32,
        data_mode: DataMode,
        data: &[u8],
    ) -> Result<(), FrameError> {
        self.cs.set_low().map_err(|_| FrameError::Pin)?;
        let result = write_frame(&mut self.spi, opcode, address, data_mode, data);
        self.cs.set_high().map_err(|_| FrameError::Pin)?;
        result
    }

    /// 发一段像素数据：`0x32 + 0x3C00` 头 + 数据（一笔里完成）
    fn pixel_data(&mut self, data: &[u8]) -> Result<(), FrameError> {
        self.spi
            .half_duplex_write(
                PIXEL_MODE,
                Command::_8Bit(OPCODE_WRITE_COLOR, CMD_MODE),
                Address::_24Bit(ADDR_RAMWRC, CMD_MODE),
                0,
                data,
            )
            .map_err(FrameError::Spi)
    }
}

/// 这一层可能出的错
#[derive(Debug)]
pub enum FrameError {
    Spi(esp_hal::spi::Error),
    /// 片选引脚拉不动（基本不会发生）
    Pin,
}

fn write_frame(
    spi: &mut SpiDma<'_, Blocking>,
    opcode: u16,
    address: u32,
    data_mode: DataMode,
    data: &[u8],
) -> Result<(), FrameError> {
    // 命令与地址永远是单线（见模块头）；只有数据相位的线数由 `data_mode` 决定
    let cmd = Command::_8Bit(opcode, CMD_MODE);
    let addr = Address::_24Bit(address, CMD_MODE);
    if data.is_empty() {
        // 只有命令+地址的短帧（切页、开显示这类）
        return spi
            .half_duplex_write(data_mode, cmd, addr, 0, &[])
            .map_err(FrameError::Spi);
    }
    // 命令的参数通常只有几个字节，一次发完
    spi.half_duplex_write(data_mode, cmd, addr, 0, data)
        .map_err(FrameError::Spi)
}
