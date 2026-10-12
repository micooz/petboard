//! 网页用的 WASM 门面：格式的规矩一律在 `anmfmt` / `bmpfmt`（板子用的那两份），
//! 这里只做跨边界的数据搬运、把长度对不上的输入挡在格式库外面、以及 `wasm-bindgen` 的类型外壳。
//!
//! 错误**原样抛出**，不在这儿加文案。数组一律平铺：跨一次边界一次拷贝，比逐帧建 JS 对象省。

use wasm_bindgen::prelude::*;

// 格式常量留在 TS 那边：`#[wasm_bindgen]` 不支持导出常量，而它们要在 init 之前就能读到。
// 线路协议常量的做法不同——`serial/wire.ts` 由 `fm-core` 的 wiregen **生成**，不是手抄镜像。

/// 整幅画布的帧序列 → `.ANM` 字节。
///
/// * `delays` —— 每帧一个延时，帧数就是它的长度；
/// * `pixels` —— `delays.len()` 段 `canvas_width * canvas_height` 的 RGB565，按帧顺序平铺。
#[wasm_bindgen]
pub fn anm_encode_rasters(
    canvas_width: u16,
    canvas_height: u16,
    delays: &[u16],
    pixels: &[u16],
) -> Result<Vec<u8>, String> {
    let frame_len = canvas_width as usize * canvas_height as usize;
    let expected = delays
        .len()
        .checked_mul(frame_len)
        .ok_or("ANM pixel count overflows")?;
    if expected != pixels.len() {
        return Err(format!(
            "ANM pixels don't match: {} frames × {frame_len} pixels = {expected}, got {}",
            delays.len(),
            pixels.len()
        ));
    }

    let frames = delays
        .iter()
        .enumerate()
        .map(|(index, delay_ms)| anmfmt::RasterFrame {
            delay_ms: *delay_ms,
            pixels: pixels[index * frame_len..(index + 1) * frame_len].to_vec(),
        })
        .collect::<Vec<_>>();
    anmfmt::encode_rasters(canvas_width, canvas_height, &frames).map_err(Into::into)
}

/// `anm_decode` 的结果；字段都是取一次算一次的 getter，别在循环里反复拿。
#[derive(Debug, PartialEq)]
#[wasm_bindgen]
pub struct AnmDecoded(anmfmt::DecodedAnm);

#[wasm_bindgen]
impl AnmDecoded {
    #[wasm_bindgen(getter)]
    pub fn canvas_width(&self) -> u16 {
        self.0.canvas_width
    }

    #[wasm_bindgen(getter)]
    pub fn canvas_height(&self) -> u16 {
        self.0.canvas_height
    }

    /// 文件里声明的帧数；数据不全时比 `delays.length` 多
    #[wasm_bindgen(getter)]
    pub fn frame_count(&self) -> u16 {
        self.0.frame_count
    }

    /// `false` = 数据只够解出前面几帧
    #[wasm_bindgen(getter)]
    pub fn complete(&self) -> bool {
        self.0.complete
    }

    /// 每帧一个延时
    #[wasm_bindgen(getter)]
    pub fn delays(&self) -> Vec<u16> {
        self.0.frames.iter().map(|frame| frame.delay_ms).collect()
    }

    /// 每帧**合成之后**的整幅画布，按帧顺序平铺
    #[wasm_bindgen(getter)]
    pub fn pixels(&self) -> Vec<u16> {
        self.0
            .frames
            .iter()
            .flat_map(|frame| frame.pixels.iter().copied())
            .collect()
    }
}

/// 解一份 `.ANM`：数据不全不是错误，交回已解出的完整帧并把 `complete` 置 false。
/// `max_frames` 只解前几帧（列表页首帧图）；不传就解完。
#[wasm_bindgen]
pub fn anm_decode(bytes: &[u8], max_frames: Option<u32>) -> Result<AnmDecoded, String> {
    anmfmt::decode_prefix(bytes, max_frames.map(|count| count as usize))
        .map(AnmDecoded)
        .map_err(Into::into)
}

/// 只读文件头，算第 0 帧最多占多少字节；不是 ANM / 版本不对 / 尺寸不合法时返回 `null`。
#[wasm_bindgen]
pub fn anm_first_frame_span(header: &[u8]) -> Option<u32> {
    anmfmt::first_frame_span(header)
}

/// 这一段字节里的第 0 帧能不能信（**逐字节对齐**吗）：`false` = 中途丢了/多了字节，
/// 这时 `anm_decode` 仍会画出一帧，但那一帧是错位的（界面上就是"花掉的首帧图"）。
/// 规矩和判据见 `anmfmt::first_frame_trusted`。
#[wasm_bindgen]
pub fn anm_first_frame_trusted(bytes: &[u8]) -> bool {
    anmfmt::first_frame_trusted(bytes)
}

/// 整份文件的自检：没问题返回 `null`，否则返回**第一个**问题的原文。
/// 只拿到前缀时该用 `anm_decode`（数据不全在那儿不算错）。
#[wasm_bindgen]
pub fn anm_validate(bytes: &[u8]) -> Option<String> {
    anmfmt::validate(bytes).err().map(Into::into)
}

/// RGB8 像素（行优先、从上到下）→ 24 位无压缩 `.BMP`。
#[wasm_bindgen]
pub fn bmp_encode(width: u16, height: u16, rgb: &[u8]) -> Result<Vec<u8>, String> {
    let expected = width as usize * height as usize * 3;
    if expected != rgb.len() {
        return Err(format!(
            "BMP RGB byte count {} doesn't match {width}x{height} (want {expected})",
            rgb.len()
        ));
    }
    Ok(bmpfmt::encode(width, height, rgb))
}

/// BMP 一行的字节数（宽 × 3 再按 4 字节对齐）
#[wasm_bindgen]
pub fn bmp_row_size(width: u16) -> usize {
    bmpfmt::row_size(width)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_arrays_are_sliced_back_into_frames() {
        let encoded = anm_encode_rasters(2, 1, &[40, 60], &[0x0011, 0x0022, 0x0033, 0x0044])
            .expect("两帧 2x1");
        let decoded = anm_decode(&encoded, None).expect("自己编的该解得开");

        assert_eq!(decoded.canvas_width(), 2);
        assert_eq!(decoded.delays(), vec![40, 60]);
        assert_eq!(decoded.pixels(), vec![0x0011, 0x0022, 0x0033, 0x0044]);
    }

    #[test]
    fn pixel_count_has_to_match_the_frame_budget() {
        assert_eq!(
            anm_encode_rasters(2, 2, &[40], &[0u16; 3]),
            Err("ANM pixels don't match: 1 frames × 4 pixels = 4, got 3".to_string())
        );
        assert_eq!(
            bmp_encode(2, 2, &[0u8; 5]),
            Err("BMP RGB byte count 5 doesn't match 2x2 (want 12)".to_string())
        );
    }

    #[test]
    fn format_errors_come_through_unchanged() {
        // 全黑：由 anmfmt 说了算，门面不加戏
        assert_eq!(
            anm_encode_rasters(2, 1, &[40], &[0u16; 2]),
            Err("ANM animation has nothing to show".to_string())
        );
        assert_eq!(
            anm_decode(&[0u8; 4], None),
            Err("ANM file is shorter than its header".to_string())
        );
    }
}
