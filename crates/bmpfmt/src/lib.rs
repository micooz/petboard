//! 电脑和板子之间传位图用的那种 BMP（bitmap，位图）格式。
//!
//! 格式定死成最简单的一档：**24 位、无压缩、正高度（自下而上存）**。
//! 之所以抽成一个两边共用的小库，是因为"电脑写的"和"板子读的"必须遵守同一套规则：
//!
//! - 格式只在这里定义一次，不会两边写歪；
//! - 板子是 riscv32，跑不了测试，而这里是普通 `no_std` 库，`cargo test` 能跑。
//!
//! 文件结构（本库只关心这几个字段）：
//!
//! ```text
//! 偏移 0    "BM"                文件魔数
//! 偏移 10   像素数据的起始偏移（我们固定写 54）
//! 偏移 18   宽（像素，小端 i32）
//! 偏移 22   高（像素，正数 = 自下而上）
//! 偏移 28   每像素位数（要 24）
//! 偏移 30   压缩方式（要 0 = 不压缩）
//! ```

// 板子那边没有 std；跑测试时（cargo test）用 std，才能用测试框架
#![cfg_attr(not(test), no_std)]

extern crate alloc;

use alloc::vec::Vec;

/// BMP 的文件头（14 字节）+ 信息头（40 字节）
pub const HEADER_LEN: usize = 54;

/// 解析出来的图片参数
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Info {
    pub width: u16,
    pub height: u16,
    /// 像素数据在文件里的偏移（我们写出来的固定是 54）
    pub data_offset: u32,
    /// 一行的字节数：宽 × 3 字节，再按 4 字节对齐
    pub row_size: usize,
}

/// 一行的字节数（按 BMP 的规矩补齐到 4 的倍数）
pub const fn row_size(width: u16) -> usize {
    let raw = width as usize * 3;
    raw.div_ceil(4) * 4
}

/// 解析 54 字节的头；不支持的格式返回一句人话
pub fn parse_header(header: &[u8; HEADER_LEN]) -> Result<Info, &'static str> {
    let u32_at =
        |i: usize| u32::from_le_bytes([header[i], header[i + 1], header[i + 2], header[i + 3]]);
    let i32_at =
        |i: usize| i32::from_le_bytes([header[i], header[i + 1], header[i + 2], header[i + 3]]);

    if &header[0..2] != b"BM" {
        return Err("not a BMP");
    }
    if u16::from_le_bytes([header[28], header[29]]) != 24 {
        return Err("only 24-bit BMP");
    }
    if u32_at(30) != 0 {
        return Err("compressed BMP");
    }

    let width = i32_at(18);
    let height = i32_at(22);
    if !(1..=u16::MAX as i32).contains(&width) || !(1..=u16::MAX as i32).contains(&height) {
        return Err("bad BMP size");
    }

    Ok(Info {
        width: width as u16,
        height: height as u16,
        data_offset: u32_at(10),
        row_size: row_size(width as u16),
    })
}

/// 把一行按 BMP 存的 B、G、R 字节，转成 RGB565。
///
/// 输出的是打包好的 `u16`（红 5 位在高、绿 6 位居中、蓝 5 位在低），
/// 和 embedded-graphics 的 `Rgb565` 位布局一致 —— 显示那边直接按这个位拆就行。
pub fn row_to_rgb565(row: &[u8], width: usize, out: &mut Vec<u16>) {
    out.clear();
    out.reserve(width);
    for x in 0..width {
        let (b, g, r) = (row[x * 3], row[x * 3 + 1], row[x * 3 + 2]);
        out.push(((r as u16 & 0xF8) << 8) | ((g as u16 & 0xFC) << 3) | (b as u16 >> 3));
    }
}

/// 把 RGB8 像素打包成 24 位无压缩 BMP（自下而上存）。
///
/// `rgb` 是 `width * height * 3` 个字节，按"从上到下、从左到右"的 RGB 顺序给。
pub fn encode(width: u16, height: u16, rgb: &[u8]) -> Vec<u8> {
    let row = row_size(width);
    let data_size = row * height as usize;
    let file_size = HEADER_LEN + data_size;
    assert_eq!(
        rgb.len(),
        width as usize * height as usize * 3,
        "RGB 字节数和宽高对不上"
    );

    let mut out = Vec::with_capacity(file_size);
    // ---- BITMAPFILEHEADER（14 字节）----
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(file_size as u32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // 保留
    out.extend_from_slice(&0u16.to_le_bytes()); // 保留
    out.extend_from_slice(&(HEADER_LEN as u32).to_le_bytes()); // 像素数据偏移

    // ---- BITMAPINFOHEADER（40 字节）----
    out.extend_from_slice(&40u32.to_le_bytes()); // 本结构大小
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&(height as i32).to_le_bytes()); // 正数 = 自下而上
    out.extend_from_slice(&1u16.to_le_bytes()); // 平面数
    out.extend_from_slice(&24u16.to_le_bytes()); // 每像素位数
    out.extend_from_slice(&0u32.to_le_bytes()); // 无压缩
    out.extend_from_slice(&(data_size as u32).to_le_bytes());
    out.extend_from_slice(&2835u32.to_le_bytes()); // 横向 72 DPI
    out.extend_from_slice(&2835u32.to_le_bytes()); // 纵向 72 DPI
    out.extend_from_slice(&0u32.to_le_bytes()); // 调色板颜色数
    out.extend_from_slice(&0u32.to_le_bytes()); // 重要颜色数

    // ---- 像素数据：从下往上，每个像素按 B、G、R 排 ----
    let padding = row - width as usize * 3;
    for y in (0..height as usize).rev() {
        for x in 0..width as usize {
            let i = (y * width as usize + x) * 3;
            out.push(rgb[i + 2]); // B
            out.push(rgb[i + 1]); // G
            out.push(rgb[i]); // R
        }
        out.extend(core::iter::repeat_n(0u8, padding));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn u16_at(b: &[u8], i: usize) -> u16 {
        u16::from_le_bytes([b[i], b[i + 1]])
    }
    fn u32_at(b: &[u8], i: usize) -> u32 {
        u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
    }
    fn i32_at(b: &[u8], i: usize) -> i32 {
        i32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
    }

    /// 2x2 的样板图，从上到下、从左到右：红 绿 / 蓝 白
    fn sample() -> Vec<u8> {
        vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]
    }

    /// 这个测试把"文件长什么样"钉死：头部的每个字段、每行怎么对齐。
    /// 三份参考实现（本库的注释、Waveshare 例程用的调色板、Pillow 读回来的结果）
    /// 对过之后就是这个样子，改了格式这里会红。
    #[test]
    fn encode_layout() {
        let bmp = encode(2, 2, &sample());
        assert_eq!(&bmp[0..2], b"BM");
        assert_eq!(u32_at(&bmp, 2), bmp.len() as u32, "文件大小字段");
        assert_eq!(u32_at(&bmp, 10), 54, "像素数据从第 54 字节开始");
        assert_eq!(u32_at(&bmp, 14), 40, "信息头长度");
        assert_eq!(i32_at(&bmp, 18), 2, "宽");
        assert_eq!(i32_at(&bmp, 22), 2, "高（正数 = 自下而上）");
        assert_eq!(u16_at(&bmp, 26), 1, "平面数");
        assert_eq!(u16_at(&bmp, 28), 24, "每像素位数");
        assert_eq!(u32_at(&bmp, 30), 0, "无压缩");
        assert_eq!(bmp.len(), 54 + 2 * 8, "2 像素宽 → 每行 6 字节 → 补齐到 8");
    }

    #[test]
    fn encode_is_bottom_up_and_bgr() {
        let bmp = encode(2, 2, &sample());
        let pixels = &bmp[54..];
        // 文件里的第 0 行 = 图片最下面一行（蓝 白），每像素 B G R
        assert_eq!(&pixels[0..6], &[255, 0, 0, 255, 255, 255]);
        // 文件里的第 1 行 = 图片最上面一行（红 绿）
        assert_eq!(&pixels[8..14], &[0, 0, 255, 0, 255, 0]);
    }

    #[test]
    fn odd_width_is_padded_with_zeros() {
        let bmp = encode(1, 1, &[10, 20, 30]);
        assert_eq!(bmp.len(), 54 + 4);
        assert_eq!(&bmp[54..], &[30, 20, 10, 0], "只填 B G R，剩下补 0");
        assert_eq!(row_size(1), 4);
        assert_eq!(row_size(2), 8);
    }

    /// 端到端：电脑 encode → 板子 parse + 逐行转 RGB565 → 屏幕上的像素
    #[test]
    fn encode_then_parse_then_unpack_gives_back_the_original_pixels() {
        let bmp = encode(2, 2, &sample());

        let mut header = [0u8; HEADER_LEN];
        header.copy_from_slice(&bmp[..HEADER_LEN]);
        let info = parse_header(&header).expect("自己写的 BMP 应该能读回来");
        assert_eq!((info.width, info.height, info.row_size), (2, 2, 8));

        // 完全照板子的读法：文件里第 i 行画到 y = 高-1-i
        let mut screen = vec![0u16; 4];
        for i in 0..info.height as usize {
            let start = info.data_offset as usize + i * info.row_size;
            let mut line = Vec::new();
            row_to_rgb565(
                &bmp[start..start + info.row_size],
                info.width as usize,
                &mut line,
            );
            let y = info.height as usize - 1 - i;
            screen[y * info.width as usize..][..info.width as usize].copy_from_slice(&line);
        }

        assert_eq!(
            screen,
            vec![0xF800, 0x07E0, 0x001F, 0xFFFF],
            "红 绿 / 蓝 白 的 RGB565"
        );
    }

    /// 端到端往返：编 → 解头 → 逐行转 RGB565 → 拿回原像素。
    ///
    /// 像素取**恰好能被 RGB565 表示**的值（红蓝是 8 的倍数、绿是 4 的倍数），
    /// 否则转换本身有损，比不出是不是搬运错了。
    #[test]
    fn round_trip_survives_odd_widths_and_a_real_canvas() {
        for (width, height) in [(1u16, 1u16), (3, 2), (7, 5), (312, 164)] {
            let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
            for y in 0..height as usize {
                for x in 0..width as usize {
                    let at = (y * width as usize + x) as u32;
                    rgb.push(((at * 11) % 32 * 8) as u8);
                    rgb.push(((at * 7) % 64 * 4) as u8);
                    rgb.push(((at * 13) % 32 * 8) as u8);
                }
            }
            let (triples, _rest) = rgb.as_chunks::<3>();
            let want: Vec<u16> = triples
                .iter()
                .map(|p| {
                    ((p[0] as u16 & 0xf8) << 8) | ((p[1] as u16 & 0xfc) << 3) | (p[2] as u16 >> 3)
                })
                .collect();

            let bmp = encode(width, height, &rgb);

            let mut header = [0u8; HEADER_LEN];
            header.copy_from_slice(&bmp[..HEADER_LEN]);
            let info = parse_header(&header).expect("自己写的 BMP 应该读得回来");
            assert_eq!((info.width, info.height), (width, height));

            let mut screen = vec![0u16; width as usize * height as usize];
            let mut line = Vec::new();
            for row in 0..info.height as usize {
                let start = info.data_offset as usize + row * info.row_size;
                row_to_rgb565(
                    &bmp[start..start + info.row_size],
                    info.width as usize,
                    &mut line,
                );
                let y = info.height as usize - 1 - row; // 文件自下而上存
                screen[y * info.width as usize..][..info.width as usize].copy_from_slice(&line);
            }
            assert_eq!(
                screen, want,
                "{width}x{height}：解回来的像素和喂进去的不一样"
            );
        }
    }

    #[test]
    fn parse_header_rejects_what_we_do_not_support() {
        let good = encode(2, 2, &sample());
        let mut header = [0u8; HEADER_LEN];
        header.copy_from_slice(&good[..HEADER_LEN]);
        assert!(parse_header(&header).is_ok());

        let mut not_bmp = header;
        not_bmp[0] = b'X';
        assert_eq!(parse_header(&not_bmp), Err("not a BMP"));

        let mut sixteen_bit = header;
        sixteen_bit[28..30].copy_from_slice(&16u16.to_le_bytes());
        assert_eq!(parse_header(&sixteen_bit), Err("only 24-bit BMP"));

        let mut compressed = header;
        compressed[30] = 1;
        assert_eq!(parse_header(&compressed), Err("compressed BMP"));

        let mut top_down = header;
        top_down[22..26].copy_from_slice(&(-2i32).to_le_bytes());
        assert_eq!(parse_header(&top_down), Err("bad BMP size"));
    }
}
