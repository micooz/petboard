//! ST77922 面板的直接驱动：**不经过 mipidsi**。
//!
//! ## 为什么要自己写
//!
//! 一开始用 `mipidsi` 驱动这块屏，结果长期花屏。差异全在库的未声明约定里：旋转、
//! 窗口换算、每条像素前的 `2Ch`、字节序……这些约定看不见，只能反复试错。这个模块
//! 把那些约定全拿回来自己写，底色是厂商自己的 Arduino 驱动
//! （<https://github.com/ydedox/st77922> 的 `Simple_test.ino`）——它是为**这块板**写的。
//!
//! ## 三条硬契约（真机验证过；改任何一条都要重新上板确认）
//!
//! ### 1. 窗口：`0x2B`(RASET) 收 **x**，`0x2A`(CASET) 收 **y** —— 也就是"软件转置"
//!
//! 参数是**含端点**的坐标，各 4 字节大端。
//!
//! 这块面板的显存是 **320 列 × 480 行**（竖屏原生）：`0x2A`(CASET) 走 320 那条短边、
//! `0x2B`(RASET) 走 480 那条长边。要靠 MADCTL 的 **MV（行列交换）**把横屏的 x/y 换过来
//! —— 但**我们这块板不认 MV**（见下），所以行列交换只能在**软件**里做：
//!
//! | 逻辑方向 | 落到哪个寄存器 | 寄存器长度 | 合法范围 |
//! |---|---|---|---|
//! | 横屏 x（长边 480） | `0x2B` RASET（原生行） | 480 | 0..479 |
//! | 横屏 y（短边 320） | `0x2A` CASET（原生列） | 320 | 0..319 |
//!
//! ⚠️ 写反了（x 发给 `0x2A`）时，x 的 320..479 超出 CASET 量程绕回，
//! 现象是**一侧约 1/3 花屏 / 那一侧永远刷不到（旧图残留）+ 文字转置**。
//! 点灯卡的实测照片就是这个样子（见 `docs/esp32-s3-lcd-35.md` §4.1）。
//!
//! #### 为什么不能照厂商驱动抄 `0xA0 + x→0x2A`
//!
//! 厂商的 Arduino 驱动（<https://github.com/ydedox/st77922>）里 `LCD_Set_Rotation` 横屏
//! 算出来是 `0xA0`，`LCD_Set_Windows(sx, sy, …)` 也是 `0x2A ← sx`。那是**在认 MV 的板子上**
//! 成立的。另一位独立核对（<https://github.com/jlmeredith/ES3C35P> 的 `docs/HARDWARE.md`）
//! 就写明这类结论"只在某一台上验证过，批次差异可能不成立"。
//! **点灯卡实测（本项目这块板）**：
//!
//! - `0x00` / `0x60` 两次（差 MX 位）画面完全一样 ⇒ **MX 无效**；
//! - `0xA0` / `0xC0` 两次（差 MX 位）也完全一样 ⇒ MX 无效（第二次）;
//! - `0x00` 与 `0xA0`（差 MV+MY）不同：条形图**只是镜像到了对侧**、没有变成横条
//!   ⇒ 起作用的是 **MY（行序）**、**MV（行列交换）无效**。
//!
//! 所以：**轴永远不换，只能在软件里转置**；MY 是唯一能用的镜像位，而且是**左右**镜像
//! （点灯卡照片：`0x00` 只上下颠倒，`0xA0` 是 180°，即 MY 只翻左右）。
//!
//! #### 还有一件事：这块屏的 y 是**反的**
//!
//! 点灯卡实测（照片）：用 `0x00` 时画面**左右方向正确**（文字顺序、红色渐变的走向都对），
//! 但**上下颠倒**。也就是说面板的 CASET 轴（`c`）与屏幕纵轴的关系是
//! **`V = 319 - c`**（`c` 小的一侧在屏幕下方），而 RASET 轴正常（`U = r`）。
//! 没有能翻 y 的 MADCTL 位（MY 只翻 x；MV/MX 无效）ⓘ，所以这一步也放在软件里：
//! [`St77922::window`] 会把 CASET 区间**反射**过去。
//!
//! 面板的像素快轴是 **RASET（逻辑 x）**：多行流按行优先发送会被转置。本驱动因此维护
//! 一块 PSRAM 帧缓冲，文本/图形先合成，再按对齐窗口以“列块 × 行”顺序推屏。
//! 调用方永远按普通屏幕顺序给像素，不要手动倒序。
//!
//! 目前 `MADCTL_LANDSCAPE = 0x00`（不镜像）。
//!
//! ### 2. 刷屏窗口的 **CASET** 边界必须对齐到 4 像素
//!
//! 面板是 GIP + 双栅极驱动，源极按 4 像素成组。厂商驱动里那两句
//! `if (sx % 4) sx -= sx % 4;` / `if (w % 4) w -= w % 4;` 就是在迁就它
//! —— 它对齐的是它的 `sx`，也就是 **CASET** 那条轴。本板横屏下 CASET = 逻辑 y，
//! 所以**要对齐的是 y**（旧版按"x 对齐"是想当然，播放时每条横带都会歪几行）。
//!
//! 对齐是**向外扩**，扩出来的行必须**跟着补像素**（本模块补黑），否则整段数据会上下错位。
//! 逐行发送（文本、1 像素线）时，补的就是"上面几行 / 下面几行"的整行黑。
//!
//! ### 3. 像素帧
//!
//! `0x32` + 地址 `0x3C00`（`RAMWRC`，续传），数据是**大端** RGB565；
//! **整段像素共用一次 CS**，且数据之前**不发** `0x2C`。细节与依据见 [`crate::qspi`]。

use embedded_graphics::pixelcolor::Rgb565;
use embedded_graphics::prelude::*;
use embedded_graphics::primitives::Rectangle;
use embedded_hal::delay::DelayNs;
use embedded_hal::digital::OutputPin;

use crate::qspi::{FrameError, QspiDevice};
use crate::st77922_init::INIT;

/// 横屏逻辑尺寸
pub const WIDTH: u16 = 480;
pub const HEIGHT: u16 = 320;

/// 横屏的 MADCTL：`0x00`（不镜像）。
///
/// ⚠️ 这块板**不认 MV**（行列交换），所以厂商那份"横屏 = `0xA0`"在这里不成立：
/// `0xA0` 只等于"开 MY（行序镜像）"。用点灯卡确认过（见模块头）：MV 无效、MX 无效、
/// MY 有效。轴靠软件转置，MY 留作纠正镜像的备选，所以这里是 `0x00`。
/// 另外 `0x08`(BGR) 不置位 ⇒ 面板按 RGB 收（实测颜色正确）。
pub const MADCTL_LANDSCAPE: u8 = 0x00;

/// 窗口 **CASET** 边界要对齐到几像素（面板硬要求，见模块头第 2 条）。
/// 横屏下 CASET = 逻辑 y，所以对齐的是 y。
const Y_ALIGN: u16 = 4;

pub struct St77922<'d, CS> {
    dev: QspiDevice<'d, CS>,
    buffer: &'d mut [u8],
    /// 本地 RGB565 帧缓冲：文本/图形先合成，再按对齐窗口推屏。
    /// 大小等于整屏像素数，由调用方放 PSRAM。
    framebuffer: &'d mut [u16],
}

impl<'d, CS: OutputPin> St77922<'d, CS> {
    pub fn new(dev: QspiDevice<'d, CS>, buffer: &'d mut [u8], framebuffer: &'d mut [u16]) -> Self {
        debug_assert!(framebuffer.len() >= WIDTH as usize * HEIGHT as usize);
        Self {
            dev,
            buffer,
            framebuffer,
        }
    }

    /// 把帧缓冲里的一块矩形推到面板。
    ///
    /// **x 范围也要跟着收窄**：面板的像素快轴是 RASET（逻辑 x），一次窗口只能覆盖
    /// `[x0, x1]` 这一段，所以调用方给的脏区横范围直接决定发多少字节。之前这里固定
    /// 从 0 发到 `WIDTH`（整幅 480 宽），于是"只改了中间一小块"的动画帧也要把整屏推一遍 ——
    /// 实测每帧发 300KB、而真正变化的像素只有 58KB，刷屏一项就吃掉 80ms/帧（帧预算 40ms）。
    ///
    /// 数据序是“先 x、块内 y”：帧缓冲是行优先（先 y 后 x），所以按列抽进发送缓冲。
    /// 列块大小取"发送缓冲装得下的列数"，行多时块自动变小。
    fn flush_region(&mut self, x0: u16, x1: u16, y0: u16, y1: u16) -> Result<(), FrameError> {
        let (ya, yb, _, _) = Self::align_y(y0, y1);
        let rows = (yb - ya + 1) as usize;
        let columns = (self.buffer.len() / 2 / rows).max(1);
        let mut x = x0.min(WIDTH - 1) as usize;
        let last = x1.min(WIDTH - 1) as usize;
        while x <= last {
            let count = columns.min(last - x + 1);
            // 拆成两个字段各自借用：写发送缓冲、读帧缓冲
            let Self {
                buffer,
                framebuffer,
                ..
            } = self;
            // 循环嵌套顺序是**性能关键**：帧缓冲在 PSRAM 上、行优先，而发送序要求
            // "同一列的行连续"。按"列在外、行在内"读就是每读一个像素跳一整个行距
            // （960 字节），PSRAM 每一像素都是一笔独立事务；反过来"行在外、列在内"，
            // PSRAM 就是整段顺序读，代价换成向内部 SRAM 的发送缓冲做**跨步写**
            // （SRAM 没有那个延迟，几乎免费）。
            //
            // 窗口已按 CASET 反射，发送数据的第 0 条对应屏幕最高 y，所以行从 yb 倒着读，
            // 于是 enumerate 出来的序号正好就是该行的发送行号。
            let stride = rows * 2;
            let width = WIDTH as usize;
            let first = (yb as usize - rows + 1) * width;
            let last = (yb as usize + 1) * width;
            for (send_row, screen_row) in framebuffer[first..last].rchunks_exact(width).enumerate()
            {
                for (col, &pixel) in screen_row[x..x + count].iter().enumerate() {
                    let at = col * stride + send_row * 2;
                    buffer[at] = (pixel >> 8) as u8;
                    buffer[at + 1] = pixel as u8;
                }
            }
            self.window(x as u16, ya, (x + count - 1) as u16, yb)?;
            self.dev.vendor_pixels(&self.buffer[..count * stride])?;
            x += count;
        }
        Ok(())
    }

    /// 初始化：厂商表 + 表外的收尾命令（顺序照厂商 `Simple_test.ino`）。
    pub fn init(&mut self, invert: bool) -> Result<(), FrameError> {
        let mut delay = esp_hal::delay::Delay::new();

        // 软复位：这块板的屏复位线接在 CHIP_PU 上，USB 复位时拉不到它，
        // 先尽力把面板拉回已知状态；拉不到时请按板上的 RST 键。
        self.dev.vendor_cmd(0x01, &[])?;
        delay.delay_ms(150);

        for &(cmd, args, delay_ms) in INIT {
            self.dev.vendor_cmd(cmd, args)?;
            if delay_ms > 0 {
                delay.delay_ms(delay_ms as u32);
            }
            // 表尾的 SLPOUT 之后必须等 ≥120ms 才能收下一条命令
            if cmd == 0x11 && delay_ms == 0 {
                delay.delay_ms(120);
            }
        }

        // 表外的收尾（厂商顺序：INVON → DISPON → RAMWR → COLMOD → MADCTL → TEON）
        if invert {
            self.dev.vendor_cmd(0x21, &[])?;
        }
        self.dev.vendor_cmd(0x29, &[])?;
        self.dev.vendor_cmd(0x2C, &[])?;
        // COLMOD：厂商用的是 0x01（最小测试验证过它渲染的 RGB565 正确）
        self.dev.vendor_cmd(0x3A, &[0x01])?;
        self.dev.vendor_cmd(0x36, &[MADCTL_LANDSCAPE])?;
        self.dev.vendor_cmd(0x35, &[0x01])?;
        delay.delay_ms(200);
        Ok(())
    }

    /// 换 MADCTL。点灯卡用它逐趟试方向（面板认不认某个位，只能这样看）。
    pub fn set_madctl(&mut self, value: u8) -> Result<(), FrameError> {
        self.dev.vendor_cmd(0x36, &[value])
    }

    /// 逻辑 y 区间 → 对齐后的 CASET 边界，以及上下各要补几行。
    ///
    /// 只向外扩，不裁掉请求的区间（`ya <= y0`、`yb >= y1`），两端都夹在屏内。
    fn align_y(y0: u16, y1: u16) -> (u16, u16, usize, usize) {
        let y0 = y0.min(HEIGHT - 1);
        let y1 = y1.min(HEIGHT - 1).max(y0);
        let ya = y0 - (y0 % Y_ALIGN);
        let yb = ((y1 + 1).div_ceil(Y_ALIGN) * Y_ALIGN - 1).min(HEIGHT - 1);
        (ya, yb, (y0 - ya) as usize, (yb - y1) as usize)
    }

    /// 设窗口。**y 必须已经对齐**（见 [`Self::align_y`]），x 不用。
    ///
    /// ⚠️ 两处约定都在这一个函数里：
    ///
    /// 1. `0x2B`(RASET) 收 x、`0x2A`(CASET) 收 y —— 软件转置（模块头第 1 条）；
    /// 2. CASET 区间要**反射**：面板的 `V = 319 - c`（模块头"y 是反的"）。
    fn window(&mut self, x0: u16, ya: u16, x1: u16, yb: u16) -> Result<(), FrameError> {
        let x0 = x0.min(WIDTH - 1);
        let x1 = x1.min(WIDTH - 1).max(x0);
        let ya = ya.min(HEIGHT - 1);
        let yb = yb.min(HEIGHT - 1).max(ya);
        let (ca, cb) = (HEIGHT - 1 - yb, HEIGHT - 1 - ya);
        let args_x = [(x0 >> 8) as u8, x0 as u8, (x1 >> 8) as u8, x1 as u8];
        let args_y = [(ca >> 8) as u8, ca as u8, (cb >> 8) as u8, cb as u8];
        self.dev.vendor_cmd(0x2B, &args_x)?;
        self.dev.vendor_cmd(0x2A, &args_y)
    }

    /// 往缓冲的第 `index` 个像素位置写一个大端 RGB565 值。
    fn put(&mut self, index: usize, value: u16) {
        self.buffer[index * 2] = (value >> 8) as u8;
        self.buffer[index * 2 + 1] = value as u8;
    }

    /// 把缓冲开头的 `n` 个像素写入本地帧缓冲的一条逻辑行。
    fn store_line(&mut self, x: u16, y: u16, n: usize) {
        let start = y as usize * WIDTH as usize + x as usize;
        for (dst, chunk) in self.framebuffer[start..start + n]
            .chunks_exact_mut(1)
            .zip(self.buffer.chunks_exact(2))
        {
            dst[0] = ((chunk[0] as u16) << 8) | chunk[1] as u16;
        }
    }
}

impl<CS: OutputPin> OriginDimensions for St77922<'_, CS> {
    fn size(&self) -> Size {
        Size::new(WIDTH as u32, HEIGHT as u32)
    }
}

impl<CS: OutputPin> DrawTarget for St77922<'_, CS> {
    type Color = Rgb565;
    type Error = FrameError;

    /// 逐像素兜底路径（`embedded-graphics` 的文本/图形会走到这里）。
    ///
    /// 同一行上连续的像素会被攒成一段再发，免得每个点都设一次窗口。
    fn draw_iter<I>(&mut self, pixels: I) -> Result<(), Self::Error>
    where
        I: IntoIterator<Item = Pixel<Self::Color>>,
    {
        let cap = self.buffer.len() / 2;
        let mut first_row = u16::MAX;
        let mut last_row = 0u16;
        // 脏区的横范围：只推真正被画到的那几列（见 [`Self::flush_region`]）
        let mut min_x = u16::MAX;
        let mut max_x = 0u16;
        let mut have = false;
        let mut start_x = 0u16;
        let mut row = 0u16;
        let mut n = 0usize;

        for Pixel(point, color) in pixels {
            if point.x < 0 || point.y < 0 || point.x >= WIDTH as i32 || point.y >= HEIGHT as i32 {
                continue;
            }
            let (px, py) = (point.x as u16, point.y as u16);
            min_x = min_x.min(px);
            max_x = max_x.max(px);
            let contiguous = have && py == row && px == start_x + n as u16;
            if !contiguous {
                if have {
                    self.store_line(start_x, row, n);
                    first_row = first_row.min(row);
                    last_row = last_row.max(row);
                }
                start_x = px;
                row = py;
                n = 0;
                have = true;
            }
            self.put(n, color.into_storage());
            n += 1;
            if n == cap {
                self.store_line(start_x, row, n);
                first_row = first_row.min(row);
                last_row = last_row.max(row);
                have = false;
            }
        }
        if have {
            self.store_line(start_x, row, n);
            first_row = first_row.min(row);
            last_row = last_row.max(row);
        }
        if first_row == u16::MAX {
            return Ok(());
        }
        self.flush_region(min_x, max_x, first_row, last_row)
    }

    /// 填充先写本地帧缓冲；后续 `draw_iter`/`fill_contiguous` 统一按行推屏。
    fn fill_solid(&mut self, area: &Rectangle, color: Self::Color) -> Result<(), Self::Error> {
        let area = self.clip(area);
        let Some(br) = area.bottom_right() else {
            return Ok(());
        };
        let (x0, x1) = (area.top_left.x as u16, br.x as u16);
        let y0 = area.top_left.y.max(0) as u16;
        let y1 = br.y.max(0) as u16;
        let v = color.into_storage();
        for y in y0..=y1 {
            let start = y as usize * WIDTH as usize + x0 as usize;
            self.framebuffer[start..start + (x1 - x0 + 1) as usize].fill(v);
        }
        self.flush_region(x0, x1, y0, y1)
    }

    /// 覆盖默认实现：先合成到本地帧缓冲，再统一推屏。
    ///
    /// 调用方按普通屏幕顺序给像素（行从上到下、行内从左到右）。
    fn fill_contiguous<I>(&mut self, area: &Rectangle, colors: I) -> Result<(), Self::Error>
    where
        I: IntoIterator<Item = Self::Color>,
    {
        let area = self.clip(area);
        let Some(br) = area.bottom_right() else {
            return Ok(());
        };
        let (x0, y0) = (area.top_left.x as u16, area.top_left.y as u16);
        let (x1, y1) = (br.x as u16, br.y as u16);
        let per_row = (x1 - x0 + 1) as usize;
        let rows = (y1 - y0 + 1) as usize;
        let mut colors = colors.into_iter();
        for row in 0..rows {
            // 直接写进帧缓冲：这里收的是**原生** u16，不必绕道发送缓冲做一次
            // "交换→再交换回来"（播放时每帧几十万像素，这一趟是白跑的）。
            let start = (y0 as usize + row) * WIDTH as usize + x0 as usize;
            for out in &mut self.framebuffer[start..start + per_row] {
                *out = colors.next().map_or(0, |color| color.into_storage());
            }
        }
        self.flush_region(x0, x1, y0, y1)
    }
}

impl<CS: OutputPin> St77922<'_, CS> {
    /// 把矩形裁进屏幕范围
    fn clip(&self, area: &Rectangle) -> Rectangle {
        area.intersection(&Rectangle::new(
            Point::zero(),
            Size::new(WIDTH as u32, HEIGHT as u32),
        ))
    }
}
