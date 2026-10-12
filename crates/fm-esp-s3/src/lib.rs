//! ESP32-S3 3.5" 板的驱动与接线层。
//!
//! 这里只有"这块板特有的东西"：ST77922 面板的 QSPI 直接驱动、SDIO 卡的块设备适配。
//! 命令、播放、协议、文件系统那一套逻辑都在 `fm-core` 里。

#![no_std]

pub mod panel;
pub mod qspi;
pub mod sdio_block;
pub mod st77922_init;
pub mod testcard;
