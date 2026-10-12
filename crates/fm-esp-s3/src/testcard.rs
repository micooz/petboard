//! LCD 点灯卡：**通过驱动本身**（不是绕开它）画一张"一照片就能判读"的测试图。
//!
//! 这块屏每一轮的问题都是**几何**问题，而靠推理去解读照片已经读歪过两次
//! （一次是把厂商的"认 MV"当成通用结论，一次是把残留旧图当成新画的）。
//! 所以这张卡只画**一眼能认**的东西，并且每 8 秒换一趟 MADCTL：
//!
//! | 画了什么 | 判什么 |
//! |---|---|
//! | 四个方位词：`LEFT`(左下角起) / `RIGHT` / `TOP` / `BOTTOM`，各贴在自己那一边 | **方向**：字能不能顺着读？镜像会反着写，转置会竖起来 |
//! | 四个角标（红左上 / 绿右上 / 蓝左下 / 白右下） | **朝向**：红跑错角就是转置或镜像 |
//! | 一条 1 像素白色对角线 | **对齐补边**：逐行的 1 像素区段上下各补最多 3 行黑，两侧会留细黑边 |
//! | 一条渐变块：红分量沿 x 递增（左端留一段黑当起点），**上半块红、下半块蓝** | **像素流的快轴**（渐变该横着走）+ **多行数据的行序**（红蓝给反了会上下互换） |
//! | 一条写着当前 MADCTL 的彩条 | 面板认不认 MADCTL 的各个位、这一趟是哪一个（每趟 20 秒） |
//!
//! 判读期望（本项目这块板实测）：`0x00` 那趟（黄条）是**正确且不镜像**的横屏；
//! `0xA0`/`0x84`（带 MY）只是**左右镜像**（MY 就是左右镜像位）；`0x04` 是顺手探一下
//! MH 位（实测 MV/MX 都无效，MH 待判）。

use defmt::info;
use embassy_time::{Duration, Timer};
use embedded_graphics::mono_font::MonoTextStyle;
use embedded_graphics::mono_font::ascii::FONT_10X20;
use embedded_graphics::pixelcolor::Rgb565;
use embedded_graphics::pixelcolor::raw::RawU16;
use embedded_graphics::prelude::*;
use embedded_graphics::primitives::{Line, PrimitiveStyle, Rectangle};
use embedded_graphics::text::{Baseline, Text};
use embedded_hal::digital::OutputPin;

use crate::panel::{HEIGHT, St77922, WIDTH};

/// 每趟停留多久（够拍照、够人肉看清 —— 手机拍照切来切去比想象的慢）
const HOLD_SECS: u64 = 20;

/// 逐趟试的 `(MADCTL, 说明文字, 彩条颜色)`。
///
/// `0x00` 是预期正确的那趟；`0xA0` 多 MY（行序镜像）、`0x04` 多 MH、`0x84` 两个都有
/// —— MH/MY 是这块板上仅有的可能镜像位（MV/MX 实测无效，见 `panel.rs` 模块头）。
const PASSES: [(u8, &str, u16); 4] = [
    (0x00, "MADCTL 0x00", 0xFFE0), // 黄
    (0xA0, "MADCTL 0xA0", 0xF81F), // 品红
    (0x04, "MADCTL 0x04", 0x07FF), // 青
    (0x84, "MADCTL 0x84", 0x7BEF), // 灰
];

/// 角标边长 / 离屏边距
const MARKER: u32 = 40;
const INSET: u32 = 8;

/// 画一遍卡、停一会儿、换下一趟 MADCTL；内部是死循环，实际不会返回。
///
/// 返回类型故意写成 `()`：这样调用点之后仍然是"可达"的，主流程不用为了它加
/// `unreachable_code` 的白名单。
pub async fn run<CS: OutputPin>(panel: &mut St77922<'_, CS>) {
    let mut pass = 0usize;
    loop {
        let index = pass % PASSES.len();
        let (madctl, text, color) = PASSES[index];
        draw(panel, madctl, text, color);
        info!(
            "lcd test card: MADCTL 0x{:02X} (pass {}/4), hold {}s",
            madctl,
            index + 1,
            HOLD_SECS
        );
        Timer::after(Duration::from_secs(HOLD_SECS)).await;
        pass += 1;
    }
}

/// 画一张卡：黑底 + 方位词 + 角标 + 对角线 + 渐变块 + 彩条
fn draw<CS: OutputPin>(panel: &mut St77922<'_, CS>, madctl: u8, text: &str, color: u16) {
    panel.set_madctl(madctl).expect("LCD: 写 MADCTL 失败");
    // 黑底是"整屏填充"：不管窗口怎么绕，它都能把面板刷一遍，不会留上一趟的残影
    panel.clear(Rgb565::BLACK).expect("LCD: 清屏失败");

    // 1. 方位词：字能不能顺着读、在哪一边，一眼就能判方向
    let style = MonoTextStyle::new(&FONT_10X20, Rgb565::WHITE);
    for (text, x, y) in [
        ("TOP", 215, 8),
        ("BOTTOM", 200, HEIGHT as i32 - 24),
        ("LEFT", 8, HEIGHT as i32 / 2 - 10),
        ("RIGHT", WIDTH as i32 - 58, HEIGHT as i32 / 2 - 10),
    ] {
        Text::with_baseline(text, Point::new(x, y), style, Baseline::Top)
            .draw(panel)
            .expect("LCD: 画方位词失败");
    }

    // 2. 四个角标（屏幕坐标：红左上 / 绿右上 / 蓝左下 / 白右下）
    for (x, y, color) in [
        (INSET, INSET, Rgb565::RED),
        (WIDTH as u32 - MARKER - INSET, INSET, Rgb565::GREEN),
        (INSET, HEIGHT as u32 - MARKER - INSET, Rgb565::BLUE),
        (
            WIDTH as u32 - MARKER - INSET,
            HEIGHT as u32 - MARKER - INSET,
            Rgb565::WHITE,
        ),
    ] {
        panel
            .fill_solid(
                &Rectangle::new(Point::new(x as i32, y as i32), Size::new(MARKER, MARKER)),
                color,
            )
            .expect("LCD: 画角标失败");
    }

    // 3. 1 像素对角线：转置/镜像一眼可见，同时压着"逐行 1 像素 + 对齐补边"那条路径
    Line::new(
        Point::new(0, 0),
        Point::new(WIDTH as i32 - 1, HEIGHT as i32 - 1),
    )
    .into_styled(PrimitiveStyle::with_stroke(Rgb565::WHITE, 1))
    .draw(panel)
    .expect("LCD: 画对角线失败");

    // 4. 渐变块：红分量沿 x 递增（左端一段黑当"起点标记"），上半红、下半蓝
    //    —— 像素流按另一个轴走这条渐变就会竖起来；多行行序给反了红蓝会上下互换。
    gradient_block(panel, 40, 220, 400, 40);

    // 5. 彩条：颜色标趟次、文字写出当前 MADCTL（字被转置时颜色还能读）
    panel
        .fill_solid(
            &Rectangle::new(Point::new(0, 170), Size::new(WIDTH as u32, 24)),
            Rgb565::from(RawU16::new(color)),
        )
        .expect("LCD: 画彩条失败");
    let x = (WIDTH as i32 - text.len() as i32 * 10) / 2;
    Text::with_baseline(
        text,
        Point::new(x.max(0), 172),
        MonoTextStyle::new(&FONT_10X20, Rgb565::BLACK),
        Baseline::Top,
    )
    .draw(panel)
    .expect("LCD: 画说明文字失败");
}

/// 画"左黑 + 左→右渐变"的横块（走 `fill_contiguous` 那条路径）。
///
/// 上半块用红、下半块用蓝，一眼就能看出行序有没有给反。
/// 行按普通屏幕顺序给：驱动负责 CASET 反射和窗口转置。
fn gradient_block<CS: OutputPin>(panel: &mut St77922<'_, CS>, x: i32, y: i32, w: u32, h: u32) {
    let area = Rectangle::new(Point::new(x, y), Size::new(w, h));
    let notch = w / 8;
    let pixels = (0..h).flat_map(move |row| {
        (0..w).map(move |col| {
            let level = if col < notch {
                0
            } else {
                ((col - notch) * 31 / (w - notch)).min(31) as u16
            };
            let raw = match row < h / 2 {
                true => level << 11, // 上半块：红分量渐增
                false => level,      // 下半块：蓝分量渐增（同样的渐变，换个通道好认）
            };
            Rgb565::from(RawU16::new(raw))
        })
    });
    panel
        .fill_contiguous(&area, pixels)
        .expect("LCD: 画渐变块失败");
}
