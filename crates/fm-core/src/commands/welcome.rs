//! 欢迎屏，以及叠在它左上角的那行状态文字（HUD）。
//!
//! 上传进度、播放结束、停止之后都回到这里，所以 [`draw_welcome`] 是命令层最常用的一个动作。
//!
//! 屏上那三行文字来自**编译期**的常量，由板子装进 [`BoardConfig`]：版本号取自 `fm-core` 的
//! `package.version`，日期是编译日期、地址是 `PET_BOARD_HINT_URL`（都是板子 `build.rs` 注入的）。
//! 两个板子各编各的，所以这两个值也各是各的。

use embassy_time::Instant;
use embedded_graphics::pixelcolor::Rgb565;
use embedded_graphics::prelude::*;

use crate::BoardConfig;
use crate::screen::Screen;

/// 开机欢迎屏：标题 / 空行 / 地址，整块垂直居中 + 每行水平居中
/// （[`Screen::show_status`] 就是干这个的）。
///
/// 上传进度/结果用 [`Screen::show_hud`] 单独叠在左上角一行，不占整屏。
pub fn draw_welcome<S>(screen: &mut Screen<S>, board: &BoardConfig<'_>)
where
    S: DrawTarget<Color = Rgb565>,
    S::Error: core::fmt::Debug,
{
    screen.show_status(&[board.banner, "", board.hint_url]);
}

/// 上传结果那行（HUD）的倒计时被打断时，把欢迎屏画回来。
///
/// 少了这一步，`Upload OK <n>B` 那行字会一直留在屏上：上传刚完网页就接着写
/// `INDEX` / `PLAYLIST`、读首帧图，2 秒倒计时几乎必然被打断；不在这儿重画，
/// 屏幕就一直停在 "Upload OK"。
pub(super) fn cancel_welcome<S>(
    welcome_at: &mut Option<Instant>,
    screen: &mut Screen<S>,
    board: &BoardConfig<'_>,
) where
    S: DrawTarget<Color = Rgb565>,
    S::Error: core::fmt::Debug,
{
    if welcome_at.take().is_some() {
        draw_welcome(screen, board);
    }
}
