//! 屏幕：往下画文字、往上画图片的一行。
//!
//! 这里只要求一个 embedded-graphics 的 `DrawTarget<Color = Rgb565>`，
//! **不关心底下是 SPI 还是别的** —— 所以"这块板子的 LCD 接在哪几个脚"
//! 留在板子那侧的 `main.rs`，这个模块只负责"画什么、画在哪"。
//!
//! 文字四周固定留 [`PAD`] 像素空白：有些屏是圆角的，贴边的内容会被切掉。

use embedded_graphics::mono_font::MonoTextStyle;
use embedded_graphics::mono_font::ascii::FONT_10X20;
use embedded_graphics::pixelcolor::Rgb565;
use embedded_graphics::pixelcolor::raw::RawU16;
use embedded_graphics::prelude::*;
use embedded_graphics::primitives::Rectangle;
use embedded_graphics::text::{Baseline, Text};

/// FONT_10X20 的字形：每个字符 10px 宽、20px 高（只含 ASCII）
const CHAR_W: i32 = FONT_10X20.character_size.width as i32;
const CHAR_H: i32 = FONT_10X20.character_size.height as i32;
/// 四周留白（圆角屏贴边会被切）
pub const PAD: i32 = 4;

/// 太长就截断。FONT_10X20 只有 ASCII 字形，所以不加省略号。
pub fn truncate(text: &str, max_chars: usize) -> &str {
    match text.char_indices().nth(max_chars) {
        Some((end, _)) => &text[..end],
        None => text,
    }
}

/// 一层薄薄的屏幕包装：把"写第几行 / 居中写"这些位置计算收在一起，
/// 顺便记住"下一行写到哪了"。
pub struct Screen<D> {
    display: D,
    next_y: i32,
}

impl<D> Screen<D>
where
    D: DrawTarget<Color = Rgb565>,
    // 底层出错时 `.expect()` 要打印错误，所以需要 Debug
    D::Error: core::fmt::Debug,
{
    pub fn new(display: D) -> Self {
        Screen {
            display,
            next_y: PAD,
        }
    }

    /// 屏幕的逻辑尺寸（本板横屏是 320x172）
    pub fn size(&self) -> Size {
        self.display.bounding_box().size
    }

    /// 留白之后一行最多能放几个字符（本板 320 宽 → 31 个）
    pub fn max_line_chars(&self) -> usize {
        ((self.size().width as i32 - 2 * PAD) / CHAR_W).max(0) as usize
    }

    /// 整屏刷黑，并把“下一行写哪里”重置回左上角留白处。
    pub fn clear(&mut self) {
        self.display.clear(Rgb565::BLACK).expect("LCD: 清屏失败");
        self.next_y = PAD;
    }

    /// 临时诊断用：整屏刷一个颜色。
    pub fn debug_fill(&mut self, color: Rgb565) {
        self.display.clear(color).expect("LCD: 清屏失败");
    }

    /// 临时诊断用：画一个实心矩形。
    pub fn debug_rect(&mut self, x: i32, y: i32, w: u32, h: u32, color: Rgb565) {
        let area = Rectangle::new(Point::new(x, y), Size::new(w, h));
        self.display
            .fill_solid(&area, color)
            .expect("LCD: 画块失败");
    }

    /// 在指定位置写一行白字
    pub fn draw_at(&mut self, text: &str, x: i32, y: i32) {
        let style = MonoTextStyle::new(&FONT_10X20, Rgb565::WHITE);
        Text::with_baseline(text, Point::new(x, y), style, Baseline::Top)
            .draw(&mut self.display)
            .expect("LCD: 文字绘制失败");
    }

    /// 某个 y 上水平居中写一行（居中范围是留白以内的那一段）
    pub fn show_center(&mut self, text: &str, y: i32) {
        let text = truncate(text, self.max_line_chars());
        let width = text.chars().count() as i32 * CHAR_W;
        let x = PAD + ((self.size().width as i32 - 2 * PAD - width) / 2).max(0);
        self.draw_at(text, x, y);
    }

    /// 左上角那一行：用来在欢迎屏上**叠**一行上传进度/结果，不清整屏。
    ///
    /// 只擦这一行的范围，所以底下居中显示的欢迎屏还在。
    pub fn show_hud(&mut self, text: &str) {
        let text = truncate(text, self.max_line_chars());
        self.clear_row(PAD);
        self.draw_at(text, PAD, PAD);
    }

    /// 清屏 + 居中显示一组状态行（**整块**在留白区里垂直居中，每行水平居中）
    pub fn show_status(&mut self, lines: &[&str]) {
        self.clear();
        for index in 0..lines.len() {
            let y = self.status_y(index, lines.len());
            self.show_center(lines[index], y);
        }
    }

    /// 把一个矩形区域刷黑。
    ///
    /// 播放每轮只重画"变了的部分"，而每轮第 0 帧又只画自己的非黑像素 —— 上一轮在别处
    /// 画过的像素不擦掉就会像影子一样叠在下一轮上。擦的范围是上一轮真正画过的并集矩形，
    /// 比整屏 `clear()` 快得多，也不会整屏闪一下。
    pub fn clear_area(&mut self, x: u16, y: u16, width: u16, height: u16) {
        if width == 0 || height == 0 {
            return;
        }
        let area = Rectangle::new(
            Point::new(x as i32, y as i32),
            Size::new(width as u32, height as u32),
        );
        self.display
            .fill_solid(&area, Rgb565::BLACK)
            .expect("LCD: 擦区域失败");
    }

    /// 画一个矩形块：按行优先消费 `width * height` 个像素。
    ///
    /// 比逐行调用 `fill_contiguous` 少很多“设窗口”命令，播放动画时更快。
    /// 收的是**迭代器**而不是切片：动画的一个横带在画布里是"每行一段"，
    /// 用迭代器直接喂给 LCD 就行，不必先拷进一块堆缓冲（堆只有 ~128KB）。
    ///
    /// 这里**不**做窗口对齐：有些面板（ST77922）要求刷屏窗口的 x 边界对齐到 4 像素，
    /// 而"对齐"必须连画布里取的列一起改，光在这一层改做不到 —— 那件事在播放引擎里
    /// 用 [`crate::commands::align_span`] 算好，再把对齐后的整段喂进来。
    pub fn draw_image_block<I>(&mut self, x: u16, y: u16, width: u16, height: u16, pixels: I)
    where
        I: IntoIterator<Item = u16>,
    {
        let area = Rectangle::new(
            Point::new(x as i32, y as i32),
            Size::new(width as u32, height as u32),
        );
        self.display
            .fill_contiguous(&area, pixels.into_iter().map(unpack_rgb565))
            .expect("LCD: 像素绘制失败");
    }

    /// 一组状态行垂直居中时，第 `index` 行的 y
    fn status_y(&self, index: usize, total: usize) -> i32 {
        let usable_h = self.size().height as i32 - 2 * PAD;
        let block_h = total as i32 * CHAR_H;
        PAD + ((usable_h - block_h) / 2).max(0) + index as i32 * CHAR_H
    }

    /// 把某一行的位置擦成黑的（更新状态文字前用）
    fn clear_row(&mut self, y: i32) {
        let area = Rectangle::new(
            Point::new(PAD, y),
            Size::new(
                (self.size().width as i32 - 2 * PAD).max(0) as u32,
                CHAR_H as u32,
            ),
        );
        self.display
            .fill_solid(&area, Rgb565::BLACK)
            .expect("LCD: 擦行失败");
    }
}

/// 打包好的 RGB565（u16）→ embedded-graphics 的颜色类型。
///
/// 位布局是同一个（红 5 位在高、绿 6 位居中、蓝 5 位在低），只是要拆成三个通道；
/// `Rgb565::new` 自己会按 5/6/5 的位宽截断，所以这里不用手工掩码。
fn unpack_rgb565(packed: u16) -> Rgb565 {
    // 直接按原始 16 位构造，避免拆成 5/6/5 再重新拼一遍。
    RawU16::new(packed).into()
}
