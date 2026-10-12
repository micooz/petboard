//! 上次复位的原因 → 一行短文本。
//!
//! 读 RTC_CNTL 里锁存的那个值需要芯片相关的代码（`esp_hal::system::reset_reason()`），
//! 所以**取值在板子那侧做**，这里只放"值 → 文案"的对照表：
//! 两个芯片的 `SocResetReason` 枚举名并不一样（S3 是 `CpuMwdt0`/`CpuSw`/`CpuRtcWdt`/`CpuMwdt1`，
//! 没有 `CoreSDIO` 与 `Cpu0JtagCpu`，另有 `SysClkGlitch`/`CorePwrGlitch`），
//! 板子把枚举映射成这里的 `kind`，文案就只有一份。
//!
//! 字符串必须保持**纯 ASCII 且不超过 32 字符**（320px ÷ 每字符 10px）；
//! FONT_10X20 只有 ASCII 字形。串口 monitor 在按下 RST 之后会掉线
//! （USB-Serial-JTAG 跟着芯片一起复位），所以这个字符串除了打日志，也会被画到 LCD 上 ——
//! 屏幕才是按 RST 后还能看到的那份。

/// 复位原因的分类。名字取自 esp-hal 的 `SocResetReason`，两块板取并集。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetKind {
    ChipPowerOn,
    CoreSw,
    CoreDeepSleep,
    CoreSdio,
    CoreMwdt0,
    CoreMwdt1,
    CoreRtcWdt,
    CpuMwdt0,
    CpuSw,
    CpuRtcWdt,
    SysBrownOut,
    SysRtcWdt,
    CpuMwdt1,
    SysSuperWdt,
    SysClkGlitch,
    CoreEfuseCrc,
    CoreUsbUart,
    CoreUsbJtag,
    CpuJtagCpu,
    CorePwrGlitch,
    /// 读不出来
    Unknown,
}

/// 分类 → 屏幕/日志上的那一行（名字 + code + 一句人话）。
pub fn text(kind: ResetKind) -> &'static str {
    match kind {
        ResetKind::ChipPowerOn => "ChipPowerOn 0x01 power-on/RST",
        ResetKind::CoreSw => "CoreSw 0x03 sw-reset",
        ResetKind::CoreDeepSleep => "CoreDeepSleep 0x05 wake",
        ResetKind::CoreSdio => "CoreSDIO 0x06 SDIO reset",
        ResetKind::CoreMwdt0 => "CoreMwdt0 0x07 MWDT0 WDT",
        ResetKind::CoreMwdt1 => "CoreMwdt1 0x08 MWDT1 WDT",
        ResetKind::CoreRtcWdt => "CoreRtcWdt 0x09 RTC WDT",
        ResetKind::CpuMwdt0 => "CpuMwdt0 0x0B MWDT0 WDT CPU",
        ResetKind::CpuSw => "CpuSw 0x0C sw-reset CPU",
        ResetKind::CpuRtcWdt => "CpuRtcWdt 0x0D RTC WDT CPU",
        ResetKind::SysBrownOut => "SysBrownOut 0x0F low VDD",
        ResetKind::SysRtcWdt => "SysRtcWdt 0x10 RTC WDT",
        ResetKind::CpuMwdt1 => "CpuMwdt1 0x11 MWDT1 WDT CPU",
        ResetKind::SysSuperWdt => "SysSuperWdt 0x12 SuperWDT",
        ResetKind::SysClkGlitch => "SysClkGlitch 0x13 clock glitch",
        ResetKind::CoreEfuseCrc => "CoreEfuseCrc 0x14 eFuse CRC",
        ResetKind::CoreUsbUart => "CoreUsbUart 0x15 USB-UART",
        ResetKind::CoreUsbJtag => "CoreUsbJtag 0x16 USB-JTAG",
        ResetKind::CpuJtagCpu => "CpuJtagCpu 0x18 JTAG CPU",
        ResetKind::CorePwrGlitch => "CorePwrGlitch 0x17 power glitch",
        ResetKind::Unknown => "unknown reset reason",
    }
}
