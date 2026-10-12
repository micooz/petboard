//! `.ANM`：给 ESP32 板子顺序播放的动画格式。
//!
//! **文件只描述"一段动画"**：画布尺寸 + 帧序列 + 每帧延时。**播放几轮不在文件里** ——
//! 循环次数由外部决定：卡上 `data/PLAYLIST` 每一项的第二个字段。
//! 这样同一份动画想换播放次数，不用重新编码、不用重新上传。
//!
//! 用**位图**描述"这一帧哪些像素变了"，颜色只存变了的那些像素：
//!
//! - 每帧带一个 dirty bbox（相对画布左上角）；
//! - 跟着 `((宽 + 7) / 8) * 高` 字节的位图，行优先，每行高位在前（bit7 = 该行最左像素）；
//! - 最后是位图里每个 1 对应一个 RGB565 小端，按行优先排列。
//!
//! 为什么不用矩形列表（v3）：矩形合并允许 80% 覆盖，框内没变的像素、以及被两个矩形重复
//! 覆盖的像素都要存一遍，实测多存 1.64 倍。
//! 位图是**无损**的，而且电脑侧不用再算矩形、板子侧不用再解析矩形。
//!
//! ```text
//! Header 18 字节：
//!   0..4    magic = "ANM\0"
//!   4       version = 1
//!   5       flags = 0
//!   6..8    canvas_width  u16 LE
//!   8..10   canvas_height u16 LE
//!   10..12  frame_count   u16 LE
//!   12..16  total_len     u32 LE    // 整个文件长度
//!   16..18  reserved      u16 LE
//!
//! 每帧头 12 字节：
//!   delay_ms          u16 LE
//!   x, y, width, height  u16 LE ×4   // dirty bbox；宽或高为 0 = 这一帧不用画
//!   flags             u8 = 0
//!   reserved          u8 = 0
//! 跟着位图：((width + 7) / 8) * height 字节
//! 跟着颜色：popcount(位图) 个 RGB565 小端，行优先
//!
//! 第 0 帧只画自己的非黑像素（不是"整个并集矩形"）：板子每轮开头会把画布清零，
//! 所以复位帧不需要负责擦掉上一轮的残影。
//! ```

#![cfg_attr(not(test), no_std)]

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec;

/// 文件开头的 4 个字节
pub const MAGIC: [u8; 4] = *b"ANM\0";
/// 当前格式版本。文件头里没有 `loops`，循环次数由外部（播放命令 / 播放清单）给。
pub const VERSION: u8 = 1;
/// 文件头长度
pub const HEADER_LEN: usize = 18;
/// 每帧小头长度
pub const FRAME_HEADER_LEN: usize = 12;
/// 单个文件的字节数上限，和网页侧同一条规矩
pub const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;

/// 解析出来的文件头
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub canvas_width: u16,
    pub canvas_height: u16,
    pub frame_count: u16,
    /// 整个 `.ANM` 文件的字节数
    pub total_len: u32,
}

/// 画布里的一个矩形，只用来表示每帧的 dirty bbox。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl Rect {
    /// 位图字节数：每行 `(width + 7) / 8` 字节
    pub fn bitmap_len(self) -> usize {
        (self.width as usize).div_ceil(8) * self.height as usize
    }

    /// 宽或高为 0：这一帧没有要画的像素
    pub fn is_empty(self) -> bool {
        self.width == 0 || self.height == 0
    }

    /// 两个矩形的**最小外接矩形**（不是集合意义的重叠区域）。
    ///
    /// 累计"这一轮画过哪儿"时用它：宁可多擦一点（多擦的地方本来就该是黑的），也不能漏掉。
    pub fn bounding(self, other: Self) -> Self {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = (self.x + self.width).max(other.x + other.width);
        let bottom = (self.y + self.height).max(other.y + other.height);
        Rect {
            x,
            y,
            width: right - x,
            height: bottom - y,
        }
    }

    /// 从 `self` 里"挖掉" `inner`，用最多 4 块表示（上 / 下 / 左 / 右，互不重叠）。
    ///
    /// 播放换轮时用它：上一轮画过的区域里，**这一帧 bbox 之外**的部分要擦黑，
    /// 而 bbox 之内会被这一帧整块重画 —— 擦了反而会在换轮时闪一下。
    /// 返回的 `None` 表示那一块是空的。
    pub fn without(self, inner: Self) -> [Option<Self>; 4] {
        let (outer_x1, outer_y1) = (self.x + self.width, self.y + self.height);
        let inner_x0 = inner.x.max(self.x);
        let inner_y0 = inner.y.max(self.y);
        let inner_x1 = (inner.x + inner.width).min(outer_x1);
        let inner_y1 = (inner.y + inner.height).min(outer_y1);
        if inner_x0 >= inner_x1 || inner_y0 >= inner_y1 {
            // 不相交（或 `inner` 是空矩形）：整块都留着擦
            return [(!self.is_empty()).then_some(self), None, None, None];
        }
        [
            rect_or_none(self.x, self.y, self.width, inner_y0 - self.y),
            rect_or_none(self.x, inner_y1, self.width, outer_y1 - inner_y1),
            rect_or_none(self.x, inner_y0, inner_x0 - self.x, inner_y1 - inner_y0),
            rect_or_none(inner_x1, inner_y0, outer_x1 - inner_x1, inner_y1 - inner_y0),
        ]
    }
}

/// 宽或高为 0 就当没有这一块
fn rect_or_none(x: u16, y: u16, width: u16, height: u16) -> Option<Rect> {
    (width > 0 && height > 0).then_some(Rect {
        x,
        y,
        width,
        height,
    })
}

/// 一帧：延时 + dirty bbox + 位图 + 颜色
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub delay_ms: u16,
    pub bbox: Rect,
    /// 位图，长度必须是 `bbox.bitmap_len()`
    pub bitmap: Vec<u8>,
    /// 位图里每个 1 一个 RGB565 小端，长度必须是 `set_bits(bitmap) * 2`
    pub colors: Vec<u8>,
}

/// 一帧的字节数（帧头 + 位图 + 颜色）
pub fn frame_bytes(frame: &Frame) -> usize {
    FRAME_HEADER_LEN + frame.bitmap.len() + frame.colors.len()
}

/// 位图里 1 的个数（= 颜色个数）
pub fn set_bits(bitmap: &[u8]) -> usize {
    bitmap.iter().map(|byte| byte.count_ones() as usize).sum()
}

/// 一个位图字节里所有“连续 1”的段，产出 `(起点, 长度)`（相对这个字节的最左位）。
///
/// 板子按段批量写画布，比逐 bit 判断少很多循环。`valid` 是这个字节里**有效**的位数
/// （每行最后一个字节可能有补齐位，它们既不该被画、也不该消费颜色）。
///
/// ```
/// # use anmfmt::BitRuns;
/// // 0b1010_0000：第 0 列和第 2 列各一段
/// let mut runs = BitRuns::new(0b1010_0000, 8);
/// assert_eq!(runs.next(), Some((0, 1)));
/// assert_eq!(runs.next(), Some((2, 1)));
/// assert_eq!(runs.next(), None);
///
/// // 0b0000_0111 里有效位只有前 5 列 → 这段 1 落在补齐位里，不该被画
/// assert_eq!(BitRuns::new(0b0000_0111, 5).next(), None);
/// ```
pub struct BitRuns {
    /// 位图字节本身：最高位（bit7）对应这个字节的第 0 列
    bits: u8,
    /// 下一个还没看的列
    col: usize,
    /// 有效列数（1..=8）
    valid: usize,
}

impl BitRuns {
    /// `valid` = 这个字节里有效的位数（1..=8）
    pub fn new(byte: u8, valid: usize) -> Self {
        BitRuns {
            bits: byte,
            col: 0,
            valid: valid.min(8),
        }
    }
}

impl Iterator for BitRuns {
    type Item = (usize, usize);

    fn next(&mut self) -> Option<(usize, usize)> {
        if self.col >= self.valid {
            return None;
        }
        // 只看 [col, valid) 这一段：把 col 之前的列清掉
        let window = self.bits & (0xFFu8 >> self.col);
        let start = window.leading_zeros() as usize;
        if start >= self.valid {
            // 剩下的 1 都落在补齐位里
            self.col = self.valid;
            return None;
        }
        // `window << start` 的最高位一定是 1，所以取反后的前导 0 个数就是连续 1 的个数
        let ones = (!(window << start)).leading_zeros() as usize;
        let end = (start + ones).min(self.valid);
        self.col = end;
        Some((start, end - start))
    }
}

/// 解析 18 字节文件头。
pub fn parse_header(bytes: &[u8; HEADER_LEN]) -> Result<Header, &'static str> {
    if bytes[0..4] != MAGIC {
        return Err("not an ANM file");
    }
    if bytes[4] != VERSION {
        return Err("unsupported ANM version (need v1)");
    }
    if bytes[5] != 0 || bytes[16] != 0 || bytes[17] != 0 {
        return Err("unsupported ANM flags");
    }
    let header = Header {
        canvas_width: u16::from_le_bytes([bytes[6], bytes[7]]),
        canvas_height: u16::from_le_bytes([bytes[8], bytes[9]]),
        frame_count: u16::from_le_bytes([bytes[10], bytes[11]]),
        total_len: u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]),
    };
    if header.canvas_width == 0 || header.canvas_height == 0 {
        return Err("bad ANM canvas size");
    }
    if header.frame_count == 0 {
        return Err("empty ANM animation");
    }
    if header.total_len < HEADER_LEN as u32 {
        return Err("bad ANM total length");
    }
    Ok(header)
}

/// 组装一个 `.ANM` 文件。
///
/// 参数里**没有循环次数**：那是播放时的事（`data/PLAYLIST` 的每一项）。
pub fn encode(
    canvas_width: u16,
    canvas_height: u16,
    frames: &[Frame],
) -> Result<Vec<u8>, &'static str> {
    if canvas_width == 0 || canvas_height == 0 {
        return Err("bad ANM canvas size");
    }
    if frames.is_empty() {
        return Err("empty ANM animation");
    }
    let frame_count = u16::try_from(frames.len()).map_err(|_| "too many ANM frames")?;

    let mut total = HEADER_LEN;
    for frame in frames {
        check_frame(frame, canvas_width, canvas_height)?;
        total += frame_bytes(frame);
    }
    let total_len = u32::try_from(total).map_err(|_| "ANM file too large")?;

    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    out.push(0);
    out.extend_from_slice(&canvas_width.to_le_bytes());
    out.extend_from_slice(&canvas_height.to_le_bytes());
    out.extend_from_slice(&frame_count.to_le_bytes());
    out.extend_from_slice(&total_len.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());

    for frame in frames {
        out.extend_from_slice(&frame.delay_ms.to_le_bytes());
        out.extend_from_slice(&frame.bbox.x.to_le_bytes());
        out.extend_from_slice(&frame.bbox.y.to_le_bytes());
        out.extend_from_slice(&frame.bbox.width.to_le_bytes());
        out.extend_from_slice(&frame.bbox.height.to_le_bytes());
        out.push(0); // flags
        out.push(0); // reserved
        out.extend_from_slice(&frame.bitmap);
        out.extend_from_slice(&frame.colors);
    }
    Ok(out)
}

/// 整幅画布的一帧 RGB565 —— 和网页编码器喂给 `encodeAnm` 的形状一样。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterFrame {
    pub delay_ms: u16,
    /// 行优先，长度必须是 `canvas_width * canvas_height`
    pub pixels: Vec<u16>,
}

/// 位图里第 `col` 列（bbox 内的相对列号）落在哪一位：每行高位在前。
const fn bit_of(col: usize) -> u8 {
    0x80 >> (col & 7)
}

/// 位图一行的字节数：宽补齐到整字节，所以每行独立从最高位开始
fn bitmap_row_bytes(bbox: Rect) -> usize {
    (bbox.width as usize).div_ceil(8)
}

/// 由"哪些像素要写"算出 dirty bbox 和位图；一处都没要写时返回 `None`（写成空帧）。
fn dirty_rect(mask: &[u8], canvas_width: usize, canvas_height: usize) -> Option<(Rect, Vec<u8>)> {
    let mut found = false;
    let (mut min_x, mut min_y) = (canvas_width, canvas_height);
    let (mut max_x, mut max_y) = (0usize, 0usize);
    for y in 0..canvas_height {
        for x in 0..canvas_width {
            if mask[y * canvas_width + x] == 0 {
                continue;
            }
            found = true;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }
    if !found {
        return None;
    }
    let bbox = Rect {
        x: min_x as u16,
        y: min_y as u16,
        width: (max_x - min_x + 1) as u16,
        height: (max_y - min_y + 1) as u16,
    };
    let stride = bitmap_row_bytes(bbox);
    let mut bitmap = vec![0u8; bbox.bitmap_len()];
    for row in 0..bbox.height as usize {
        for col in 0..bbox.width as usize {
            let index = (bbox.y as usize + row) * canvas_width + bbox.x as usize + col;
            if mask[index] != 0 {
                bitmap[row * stride + (col >> 3)] |= bit_of(col);
            }
        }
    }
    Some((bbox, bitmap))
}

/// 一帧头 + 位图 + 颜色：`mask` 说要写哪些像素，`pixels` 提供它们的颜色。
fn frame_from_mask(
    delay_ms: u16,
    mask: &[u8],
    pixels: &[u16],
    canvas_width: u16,
    canvas_height: u16,
) -> Frame {
    let width = canvas_width as usize;
    let empty = Rect {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
    };
    let Some((bbox, bitmap)) = dirty_rect(mask, width, canvas_height as usize) else {
        return Frame {
            delay_ms,
            bbox: empty,
            bitmap: Vec::new(),
            colors: Vec::new(),
        };
    };
    let stride = bitmap_row_bytes(bbox);
    let mut colors = Vec::with_capacity(set_bits(&bitmap) * 2);
    for row in 0..bbox.height as usize {
        for col in 0..bbox.width as usize {
            if bitmap[row * stride + (col >> 3)] & bit_of(col) == 0 {
                continue;
            }
            let index = (bbox.y as usize + row) * width + bbox.x as usize + col;
            colors.extend_from_slice(&pixels[index].to_le_bytes());
        }
    }
    Frame {
        delay_ms,
        bbox,
        bitmap,
        colors,
    }
}

/// 从整幅画布的帧序列做出一份 `.ANM`：每帧存"和上一帧不同的像素"，
/// 第 0 帧的上一帧按纯黑画布算（板子每轮开头会清零）。
pub fn encode_rasters(
    canvas_width: u16,
    canvas_height: u16,
    frames: &[RasterFrame],
) -> Result<Vec<u8>, &'static str> {
    if canvas_width == 0 || canvas_height == 0 {
        return Err("bad ANM canvas size");
    }
    if frames.is_empty() {
        return Err("empty ANM animation");
    }
    let pixels_len = canvas_width as usize * canvas_height as usize;
    if frames.iter().any(|frame| frame.pixels.len() != pixels_len) {
        return Err("ANM raster doesn't match the canvas size");
    }
    if frames
        .iter()
        .all(|frame| frame.pixels.iter().all(|value| *value == 0))
    {
        return Err("ANM animation has nothing to show");
    }

    let mut encoded: Vec<Frame> = Vec::with_capacity(frames.len());
    let mut total = HEADER_LEN;
    let mut mask = vec![0u8; pixels_len];
    let black = vec![0u16; pixels_len];
    for (index, frame) in frames.iter().enumerate() {
        // 每帧都和"上一帧"比；第 0 帧的上一帧是纯黑画布（板子每轮开头会清零）
        let previous = if index == 0 {
            &black[..]
        } else {
            &frames[index - 1].pixels
        };
        for (at, dirty) in mask.iter_mut().enumerate() {
            *dirty = u8::from(previous[at] != frame.pixels[at]);
        }
        let frame = frame_from_mask(
            frame.delay_ms,
            &mask,
            &frame.pixels,
            canvas_width,
            canvas_height,
        );
        total += frame_bytes(&frame);
        if total > MAX_FILE_BYTES {
            return Err("ANM file too large");
        }
        encoded.push(frame);
    }
    encode(canvas_width, canvas_height, &encoded)
}

/// 解出来的一帧：延时 + **合成之后**的整幅画布。
///
/// 每帧只存"相对上一帧变了的地方"，所以要看第 k 帧就得把前 k 帧叠起来。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedFrame {
    pub delay_ms: u16,
    /// 行优先，长度 `canvas_width * canvas_height`
    pub pixels: Vec<u16>,
}

/// `decode_prefix` 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedAnm {
    pub canvas_width: u16,
    pub canvas_height: u16,
    /// 文件头里声明的帧数；数据不全时比 `frames` 多
    pub frame_count: u16,
    pub frames: Vec<DecodedFrame>,
    /// `false` = 数据不够解完所有帧，`frames` 里是**完整**解出来的那几帧
    pub complete: bool,
}

/// 把 `.ANM` 合成成整幅画布的帧序列。
///
/// 两处刻意的取舍：
///
/// - **数据不全不算错**。网页对卡上的文件做范围读时只拿得到前一段（串口偶发丢字节也一样），
///   这时把已经完整解出来的帧交回去、`complete` 置 `false`，预览能播几帧是几帧。
/// - **bbox 越界算错**。这种文件是坏了，画出来是残影；越界那一帧没有任何办法"猜"出该画什么。
///
/// `max_frames` 用来只解前几帧（列表页的首帧图就是这么来的）。
pub fn decode_prefix(bytes: &[u8], max_frames: Option<usize>) -> Result<DecodedAnm, &'static str> {
    let limit = max_frames.unwrap_or(usize::MAX);
    if bytes.len() < HEADER_LEN {
        return Err("ANM file is shorter than its header");
    }
    let mut header_bytes = [0u8; HEADER_LEN];
    header_bytes.copy_from_slice(&bytes[..HEADER_LEN]);
    let header = parse_header(&header_bytes)?;

    let canvas_width = header.canvas_width as usize;
    let canvas_height = header.canvas_height as usize;
    let mut canvas = vec![0u16; canvas_width * canvas_height];
    let mut frames: Vec<DecodedFrame> = Vec::new();
    let mut at = HEADER_LEN;
    let mut complete = true;

    for _ in 0..header.frame_count as usize {
        if frames.len() >= limit {
            break;
        }
        let Some(head) = bytes.get(at..at + FRAME_HEADER_LEN) else {
            complete = false;
            break;
        };
        if head[10] != 0 || head[11] != 0 {
            return Err("ANM frame has nonzero flags/reserved");
        }
        let bbox = Rect {
            x: u16::from_le_bytes([head[2], head[3]]),
            y: u16::from_le_bytes([head[4], head[5]]),
            width: u16::from_le_bytes([head[6], head[7]]),
            height: u16::from_le_bytes([head[8], head[9]]),
        };
        if !bbox.is_empty()
            && (bbox.x as usize + bbox.width as usize > canvas_width
                || bbox.y as usize + bbox.height as usize > canvas_height)
        {
            return Err("ANM frame bbox outside canvas");
        }
        let head_end = at + FRAME_HEADER_LEN;
        let bitmap_len = bbox.bitmap_len();
        let Some(bitmap) = bytes.get(head_end..head_end + bitmap_len) else {
            complete = false;
            break;
        };
        let colors_start = head_end + bitmap_len;
        let colors_len = set_bits(bitmap) * 2;
        let Some(colors) = bytes.get(colors_start..colors_start + colors_len) else {
            complete = false;
            break;
        };
        at = colors_start + colors_len;

        let stride = bitmap_row_bytes(bbox);
        let mut color_at = 0;
        for row in 0..bbox.height as usize {
            for col in 0..bbox.width as usize {
                if bitmap[row * stride + (col >> 3)] & bit_of(col) == 0 {
                    continue;
                }
                let value = u16::from_le_bytes([colors[color_at], colors[color_at + 1]]);
                color_at += 2;
                canvas[(bbox.y as usize + row) * canvas_width + bbox.x as usize + col] = value;
            }
        }
        frames.push(DecodedFrame {
            delay_ms: u16::from_le_bytes([head[0], head[1]]),
            pixels: canvas.clone(),
        });
    }

    let read_every_frame = frames.len() == header.frame_count as usize;
    if read_every_frame && at != bytes.len() {
        return Err("ANM file has bytes left after the declared frames");
    }
    Ok(DecodedAnm {
        canvas_width: header.canvas_width,
        canvas_height: header.canvas_height,
        frame_count: header.frame_count,
        frames,
        complete,
    })
}

/// 第 0 帧的**字节数上界**（画布上全是非黑像素时），只读文件头就能算出来。
/// 不是 ANM、版本不对、尺寸不合法时返回 `None`，让调用方退回兜底长度。
pub fn first_frame_span(header: &[u8]) -> Option<u32> {
    let bytes: &[u8; HEADER_LEN] = header.get(..HEADER_LEN)?.try_into().ok()?;
    let parsed = parse_header(bytes).ok()?;
    let bitmap = (parsed.canvas_width as usize).div_ceil(8) * parsed.canvas_height as usize;
    let colors = parsed.canvas_width as usize * parsed.canvas_height as usize * 2;
    u32::try_from(HEADER_LEN + FRAME_HEADER_LEN + bitmap + colors).ok()
}

/// `bytes[at..]` 起的那一帧占多少字节（帧头 + 位图 + 颜色）；**边界对不上就是 `None`**。
///
/// 三种 `None`：数据不够（帧头、位图或颜色没读全）、`flags`/`reserved` 非 0、
/// bbox 越出画布。后两种正是"字节流错位"的形状：错位一个字节，那 12 个字节
/// 就不再是帧头，而是载荷的中间一段。
fn frame_at(header: &Header, bytes: &[u8], at: usize) -> Option<usize> {
    let head = bytes.get(at..at + FRAME_HEADER_LEN)?;
    if head[10] != 0 || head[11] != 0 {
        return None;
    }
    let bbox = Rect {
        x: u16::from_le_bytes([head[2], head[3]]),
        y: u16::from_le_bytes([head[4], head[5]]),
        width: u16::from_le_bytes([head[6], head[7]]),
        height: u16::from_le_bytes([head[8], head[9]]),
    };
    if !bbox.is_empty()
        && (bbox.x as usize + bbox.width as usize > header.canvas_width as usize
            || bbox.y as usize + bbox.height as usize > header.canvas_height as usize)
    {
        return None;
    }
    let bitmap_start = at + FRAME_HEADER_LEN;
    let bitmap_len = bbox.bitmap_len();
    let bitmap = bytes.get(bitmap_start..bitmap_start + bitmap_len)?;
    let colors_len = set_bits(bitmap) * 2;
    let colors_start = bitmap_start + bitmap_len;
    bytes.get(colors_start..colors_start + colors_len)?;
    Some(FRAME_HEADER_LEN + bitmap_len + colors_len)
}

/// 一帧帧头的**边界自检**：`flags`/`reserved` 全 0，且 bbox 不越出画布。
///
/// 只看帧头那 12 个字节，不要求位图和颜色也在手里 —— 前缀读多长是调用方的事。
fn head_in_place(header: &Header, head: &[u8]) -> bool {
    if head.len() < FRAME_HEADER_LEN || head[10] != 0 || head[11] != 0 {
        return false;
    }
    let bbox = Rect {
        x: u16::from_le_bytes([head[2], head[3]]),
        y: u16::from_le_bytes([head[4], head[5]]),
        width: u16::from_le_bytes([head[6], head[7]]),
        height: u16::from_le_bytes([head[8], head[9]]),
    };
    bbox.is_empty()
        || (bbox.x as usize + bbox.width as usize <= header.canvas_width as usize
            && bbox.y as usize + bbox.height as usize <= header.canvas_height as usize)
}

/// 前缀里的**第 0 帧能不能信**：`true` = 这些字节和第 0 帧真实内容逐字节对齐。
///
/// 为什么需要它：`decode_prefix` 只看"数据够不够解出这一帧"，**看不出这一帧解错了**。
/// 位图里少（或多）一个字节，popcount 跟着变，颜色个数就跟着错位 —— 于是
/// 整幅画面被按错的行宽/错的调色板重画出来，界面上就是"花掉的首帧图"，
/// 而 `complete` 依然是 `true`、一个错都不报。真机见过：丢一个字节 → 26,080 个像素不对。
///
/// 判据是**帧边界**，不是像素内容（内容没有校验和可对）：
///
/// 1. 第 0 帧自己的帧头合法，且前缀真的覆盖到它声明的末尾；
/// 2. 文件里还有后面的帧 → 前缀必须再看到一个**合法的**第 1 帧帧头。字节一错位，
///    那 12 个字节就是载荷的中段，`flags`/`reserved` 或 bbox 边界几乎必然对不上；
/// 3. 文件只有第 0 帧 → 前缀必须覆盖到 `total_len`，并且整份解得开、没有多余字节。
///
/// 这是很强的完整性检查，但**不是证明**：错位刚好落进一串 0 字节、且第 1 帧帧头
/// 又碰巧合法时看不出来。所以网页拿它当"敢不敢画"的闸，不当"文件一定好"的结论。
pub fn first_frame_trusted(bytes: &[u8]) -> bool {
    let Some(header) = bytes
        .get(..HEADER_LEN)
        .and_then(|head| parse_header(head.try_into().ok()?).ok())
    else {
        return false;
    };
    let Some(span) = frame_at(&header, bytes, HEADER_LEN) else {
        return false;
    };
    let end = HEADER_LEN + span;
    if header.frame_count > 1 {
        // 第 1 帧的帧头必须落在它该在的位置（位图/颜色没读全不算错位，前缀本来就不读那么多）
        let next = bytes.get(end..end + FRAME_HEADER_LEN);
        return next.is_some_and(|head| head_in_place(&header, head));
    }
    // 单帧文件：唯一的边界证据就是"整份都在手里，而且解得干净"
    let Some(whole) = bytes.get(..header.total_len as usize) else {
        return false;
    };
    match decode_prefix(whole, None) {
        Ok(decoded) => decoded.complete && decoded.frames.len() == 1,
        Err(_) => false,
    }
}

/// 整份文件是否**完整且合法**：`decode_prefix` 的所有规矩，再加上"长度等于 `total_len`"。
/// 只拿到前缀时该用 `decode_prefix` —— 数据不全在那里不算错。
pub fn validate(bytes: &[u8]) -> Result<(), &'static str> {
    let decoded = decode_prefix(bytes, None)?;
    if !decoded.complete {
        // 声明的帧都解完了、也没剩字节 —— 到这里只可能是"声明的帧数没读全"
        return Err("ANM file ends before the declared frames");
    }
    let mut header_bytes = [0u8; HEADER_LEN];
    header_bytes.copy_from_slice(&bytes[..HEADER_LEN]);
    let header = parse_header(&header_bytes)?;
    if header.total_len as usize != bytes.len() {
        return Err("ANM total_len doesn't match the file length");
    }
    Ok(())
}

/// 一帧的字段校验（`encode` 用；板子读的时候也会做同样的边界检查）
pub fn check_frame(
    frame: &Frame,
    canvas_width: u16,
    canvas_height: u16,
) -> Result<(), &'static str> {
    let bbox = frame.bbox;
    if !bbox.is_empty()
        && (bbox.x as u32 + bbox.width as u32 > canvas_width as u32
            || bbox.y as u32 + bbox.height as u32 > canvas_height as u32)
    {
        return Err("ANM frame bbox outside canvas");
    }
    if frame.bitmap.len() != bbox.bitmap_len() {
        return Err("ANM frame has wrong bitmap length");
    }
    if frame.colors.len() != set_bits(&frame.bitmap) * 2 {
        return Err("ANM frame has wrong color length");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn rect(x: u16, y: u16, width: u16, height: u16) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn frame(bbox: Rect, bitmap: Vec<u8>) -> Frame {
        let colors = vec![0u8; set_bits(&bitmap) * 2];
        Frame {
            delay_ms: 40,
            bbox,
            bitmap,
            colors,
        }
    }

    #[test]
    fn header_roundtrip_and_frame_layout() {
        let frames = [
            frame(
                Rect {
                    x: 1,
                    y: 2,
                    width: 2,
                    height: 1,
                },
                vec![0b1100_0000],
            ),
            frame(
                Rect {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                },
                Vec::new(),
            ),
        ];
        let file = encode(4, 4, &frames).unwrap();

        assert_eq!(&file[0..4], b"ANM\0");
        assert_eq!(file[4], VERSION);
        assert_eq!(file[5], 0);
        let mut header_bytes = [0u8; HEADER_LEN];
        header_bytes.copy_from_slice(&file[..HEADER_LEN]);
        let header = parse_header(&header_bytes).unwrap();
        assert_eq!(
            header,
            Header {
                canvas_width: 4,
                canvas_height: 4,
                frame_count: 2,
                total_len: file.len() as u32,
            }
        );

        // 第 0 帧头：delay=40、bbox=(1,2,2,1)、flags/reserved=0，然后 1 字节位图 + 4 字节颜色
        let f = &file[HEADER_LEN..];
        assert_eq!(u16::from_le_bytes([f[0], f[1]]), 40);
        assert_eq!(
            (
                u16::from_le_bytes([f[2], f[3]]),
                u16::from_le_bytes([f[4], f[5]]),
                u16::from_le_bytes([f[6], f[7]]),
                u16::from_le_bytes([f[8], f[9]]),
            ),
            (1, 2, 2, 1)
        );
        assert_eq!((f[10], f[11]), (0, 0));
        assert_eq!(f[12], 0b1100_0000);
        assert_eq!(frame_bytes(&frames[0]), FRAME_HEADER_LEN + 1 + 4);
        assert_eq!(frame_bytes(&frames[1]), FRAME_HEADER_LEN);
    }

    #[test]
    fn bitmap_len_rounds_up_per_row() {
        let rect = Rect {
            x: 0,
            y: 0,
            width: 9,
            height: 3,
        };
        assert_eq!(rect.bitmap_len(), 2 * 3);
        assert!(Rect {
            width: 0,
            height: 5,
            ..rect
        }
        .is_empty());
    }

    #[test]
    fn bounding_takes_the_outer_bounds() {
        let a = rect(10, 10, 20, 20);
        let b = rect(100, 5, 10, 50);
        assert_eq!(a.bounding(b), rect(10, 5, 100, 50));
        assert_eq!(a.bounding(a), a);
    }

    #[test]
    fn without_splits_into_four_non_overlapping_pieces() {
        let outer = rect(0, 0, 100, 100);
        let holes = outer.without(rect(20, 30, 40, 50));
        // 四块拼起来 = 原面积 - 挖掉的面积
        let area: u32 = holes
            .iter()
            .flatten()
            .map(|piece| piece.width as u32 * piece.height as u32)
            .sum();
        assert_eq!(area, 100 * 100 - 40 * 50);
        // 每块都在原矩形里，而且都不和挖掉的那块重叠
        for piece in holes.iter().flatten() {
            assert!(piece.x >= outer.x && piece.y >= outer.y);
            assert!(piece.x + piece.width <= outer.x + outer.width);
            assert!(piece.y + piece.height <= outer.y + outer.height);
            let overlaps = piece.x < 60 && piece.x + piece.width > 20;
            let overlaps = overlaps && piece.y < 80 && piece.y + piece.height > 30;
            assert!(!overlaps, "剩下的块不该和挖掉的那块重叠：{piece:?}");
        }
    }

    #[test]
    fn without_handles_disjoint_and_covering_rects() {
        let outer = rect(0, 0, 10, 10);
        // 不相交：整块留着擦
        assert_eq!(
            outer.without(rect(50, 50, 5, 5)),
            [Some(outer), None, None, None]
        );
        // 完全挖掉 / 被更大的矩形盖住：什么都不用擦
        assert_eq!(outer.without(outer), [None, None, None, None]);
        assert_eq!(
            outer.without(rect(0, 0, 999, 999)),
            [None, None, None, None]
        );
        // 空矩形不产生任何块
        assert_eq!(
            outer.without(rect(5, 5, 0, 0)),
            [Some(outer), None, None, None]
        );
    }

    #[test]
    fn bit_runs_finds_consecutive_ones() {
        let runs = |byte: u8, valid: usize| BitRuns::new(byte, valid).collect::<Vec<_>>();
        assert_eq!(runs(0b0000_0000, 8), vec![]);
        assert_eq!(runs(0b1111_1111, 8), vec![(0, 8)]);
        assert_eq!(runs(0b1000_0000, 8), vec![(0, 1)]);
        assert_eq!(runs(0b0000_0001, 8), vec![(7, 1)]);
        assert_eq!(runs(0b1010_1010, 8), vec![(0, 1), (2, 1), (4, 1), (6, 1)]);
        assert_eq!(runs(0b0111_1000, 8), vec![(1, 4)]);
        // 补齐位（valid 之外）既不产出段、也不让后面的段跑出来
        assert_eq!(runs(0b1111_1111, 5), vec![(0, 5)]);
        assert_eq!(runs(0b0000_1000, 3), vec![]);
        assert_eq!(runs(0b0001_1000, 4), vec![(3, 1)]);
        assert_eq!(runs(0b1000_0001, 8), vec![(0, 1), (7, 1)]);
    }

    #[test]
    fn rejects_mismatched_bitmap_or_colors() {
        let mut f = frame(
            Rect {
                x: 0,
                y: 0,
                width: 8,
                height: 1,
            },
            vec![0b1000_0001],
        );
        f.colors.truncate(2);
        assert!(encode(8, 1, &[f]).is_err());

        let mut f = frame(
            Rect {
                x: 0,
                y: 0,
                width: 8,
                height: 1,
            },
            vec![0xFF],
        );
        f.bitmap.push(0);
        assert!(encode(8, 1, &[f]).is_err());
    }

    #[test]
    fn rejects_bbox_outside_canvas() {
        let f = frame(
            Rect {
                x: 7,
                y: 0,
                width: 2,
                height: 1,
            },
            vec![0b1100_0000],
        );
        assert_eq!(encode(8, 1, &[f]), Err("ANM frame bbox outside canvas"));
    }

    #[test]
    fn rejects_bad_header() {
        let f = frame(
            Rect {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            Vec::new(),
        );
        let file = encode(4, 4, &[f]).unwrap();

        let mut bytes = [0u8; HEADER_LEN];
        bytes.copy_from_slice(&file[..HEADER_LEN]);
        bytes[4] = 3; // 旧版本
        assert!(parse_header(&bytes).is_err());
        bytes[4] = VERSION;
        bytes[0] = b'X';
        assert!(parse_header(&bytes).is_err());
        bytes[0] = b'A'; // 恢复 magic，好让下面那条断言只测 total_len
        bytes[12..16].copy_from_slice(&(HEADER_LEN as u32 - 1).to_le_bytes());
        assert!(parse_header(&bytes).is_err());
    }

    fn raster(delay_ms: u16, pixels: &[u16]) -> RasterFrame {
        RasterFrame {
            delay_ms,
            pixels: pixels.to_vec(),
        }
    }

    /// 把整份文件钉死：文件头、两帧的帧头 / 位图 / 颜色，一个字节都不许动。
    #[test]
    fn encode_rasters_bytes_are_frozen() {
        let file = encode_rasters(
            3,
            1,
            &[
                raster(40, &[0x0000, 0x1234, 0x5678]),
                raster(60, &[0x9ABC, 0x1234, 0x0000]),
            ],
        )
        .unwrap();

        assert_eq!(
            file,
            vec![
                b'A',
                b'N',
                b'M',
                0, // magic
                1,
                0, // version / flags
                3,
                0, // canvas_width
                1,
                0, // canvas_height
                2,
                0, // frame_count
                52,
                0,
                0,
                0, // total_len
                0,
                0, // reserved
                // 第 0 帧只留非黑像素：bbox (1,0,2,1)，位图 0b1100_0000，颜色小端
                40,
                0,
                1,
                0,
                0,
                0,
                2,
                0,
                1,
                0,
                0,
                0,
                0b1100_0000,
                0x34,
                0x12,
                0x78,
                0x56,
                // 第 1 帧改了最左（黑 → 有值）和最右（有值 → 黑）：bbox (0,0,3,1)。
                // 变回黑的像素照样要存一份颜色，否则板子那一格还留着旧值。
                60,
                0,
                0,
                0,
                0,
                0,
                3,
                0,
                1,
                0,
                0,
                0,
                0b1010_0000,
                0xBC,
                0x9A,
                0x00,
                0x00,
            ]
        );
    }

    /// 两帧一模一样：后一帧没有像素要写，落成"宽高为 0"的空帧（只占 12 字节帧头）
    #[test]
    fn encode_rasters_marks_unchanged_frames_empty() {
        let pixels = [0x0011, 0x0022, 0x0033, 0x0044];
        let file = encode_rasters(2, 2, &[raster(40, &pixels), raster(40, &pixels)]).unwrap();

        // 第 0 帧：bbox 铺满 2x2 → 位图 2 字节 + 4 个像素的颜色 = 12 + 2 + 8
        assert_eq!(file.len(), HEADER_LEN + 22 + FRAME_HEADER_LEN);
        let second = &file[file.len() - FRAME_HEADER_LEN..];
        assert_eq!(u16::from_le_bytes([second[0], second[1]]), 40, "延时照样存");
        assert_eq!(
            &second[2..10],
            &[0, 0, 0, 0, 0, 0, 0, 0],
            "bbox 的 x/y/宽/高全为 0"
        );
        assert_eq!(&second[10..], &[0, 0]);
    }

    /// 位图每行**各自**从最高位开始，行尾补 0：宽 9 → 每行 2 字节
    #[test]
    fn encode_rasters_pads_each_bitmap_row_separately() {
        let pixels = [1u16; 9];
        let file = encode_rasters(9, 1, &[raster(40, &pixels)]).unwrap();
        let bitmap = &file[HEADER_LEN + FRAME_HEADER_LEN..];
        assert_eq!(
            bitmap[0..2],
            [0b1111_1111, 0b1000_0000],
            "前 8 列占满第 0 字节，第 9 列是第 1 字节的最高位"
        );
        assert_eq!(set_bits(&bitmap[..2]), 9);
        // 9 个像素各 2 字节颜色，后面不该再有东西
        assert_eq!(file.len(), HEADER_LEN + FRAME_HEADER_LEN + 2 + 18);
    }

    /// 自造一批有代表性的画面：差分、dirty bbox、位图行补齐、位边界都在里面。
    ///
    /// 最后一份是 312x164 x 28 帧 —— 和板子的实际画布同尺寸，用来跑大批量路径。
    fn cases() -> Vec<(&'static str, u16, u16, Vec<RasterFrame>)> {
        let paint = |width: usize,
                     height: usize,
                     delay_ms: u16,
                     f: &dyn Fn(usize, usize) -> u16|
         -> RasterFrame {
            let mut pixels = Vec::with_capacity(width * height);
            for y in 0..height {
                for x in 0..width {
                    pixels.push(f(x, y));
                }
            }
            RasterFrame { delay_ms, pixels }
        };
        let blue: u16 = 0x001f;
        let red: u16 = 0xf800;

        vec![
            (
                "walking-block-16x8",
                16,
                8,
                (0..3u16)
                    .map(|index| {
                        paint(16, 8, 40 + index * 10, &|x, y| {
                            if x < 4 && y < 4 {
                                return blue;
                            }
                            if (2 + index as usize * 2..6 + index as usize * 2).contains(&x)
                                && (2..6).contains(&y)
                            {
                                return red;
                            }
                            0
                        })
                    })
                    .collect(),
            ),
            (
                // bbox 里有黑像素：第 0 帧只留非黑的，位图上就该挖出洞
                "first-frame-with-holes-8x2",
                8,
                2,
                vec![
                    paint(8, 2, 50, &|x, _y| {
                        if x == 0 || x == 3 {
                            0
                        } else {
                            red + x as u16
                        }
                    }),
                    paint(8, 2, 60, &|x, y| {
                        if x == 0 || x == 3 {
                            0
                        } else if y == 0 {
                            red + x as u16
                        } else {
                            0x07e0 + x as u16
                        }
                    }),
                ],
            ),
            (
                // 中间那帧和上一帧一模一样：该落成"宽高为 0"的空帧
                "unchanged-middle-frame-4x4",
                4,
                4,
                vec![
                    paint(4, 4, 40, &|x, y| blue + y as u16 * 4 + x as u16),
                    paint(4, 4, 41, &|x, y| blue + y as u16 * 4 + x as u16),
                    paint(4, 4, 42, &|x, y| {
                        if x == 0 && y == 0 {
                            red
                        } else {
                            blue + y as u16 * 4 + x as u16
                        }
                    }),
                ],
            ),
            (
                // 宽 9 不是 8 的倍数：每行各自补到 2 字节
                "odd-canvas-width-9x3",
                9,
                3,
                vec![paint(9, 3, 100, &|x, y| 0x1000 + y as u16 * 9 + x as u16)],
            ),
            (
                // 变化的像素正好压在字节的左右边界上（第 0、7、8、19 列）
                "bit-boundaries-20x1",
                20,
                1,
                vec![
                    paint(20, 1, 30, &|_x, _y| 0),
                    paint(20, 1, 31, &|x, _y| {
                        if x == 0 || x == 7 || x == 8 || x == 19 {
                            0x1000 + x as u16
                        } else {
                            0
                        }
                    }),
                ],
            ),
            (
                "single-pixel-1x1",
                1,
                1,
                vec![paint(1, 1, 20, &|_x, _y| red), paint(1, 1, 21, &|_x, _y| 0)],
            ),
            (
                // 满幅渐变打底 + 一个移动的小色块：每帧只该有一小块要重写
                "big-canvas-312x164",
                312,
                164,
                (0..28u16)
                    .map(|index| {
                        paint(312, 164, 40 + index % 7, &|x, y| {
                            let block = (index as usize * 8..index as usize * 8 + 24).contains(&x)
                                && (60..90).contains(&y);
                            if block {
                                0xf800 | index
                            } else {
                                x as u16 * 7 + y as u16 * 13 + 1
                            }
                        })
                    })
                    .collect(),
            ),
        ]
    }

    /// 无损往返：编出来再解回去必须一帧不差。板子每轮重播、网页预览都靠这条。
    #[test]
    fn rasters_survive_a_round_trip() {
        for (name, canvas_width, canvas_height, frames) in cases() {
            let pixels = frames[0].pixels.len();
            assert_eq!(
                pixels,
                canvas_width as usize * canvas_height as usize,
                "{name}: 用例自己写错了"
            );

            let file = encode_rasters(canvas_width, canvas_height, &frames)
                .unwrap_or_else(|err| panic!("{name}: 编不出来 {err}"));
            validate(&file)
                .unwrap_or_else(|err| panic!("{name}: 自己编的文件 validate 都没过：{err}"));

            let decoded = decode_prefix(&file, None)
                .unwrap_or_else(|err| panic!("{name}: 解不开自己编的文件：{err}"));
            assert!(decoded.complete, "{name}: 完整的文件该报 complete=true");
            assert_eq!(decoded.frames.len(), frames.len(), "{name}: 帧数");
            for (index, frame) in decoded.frames.iter().enumerate() {
                assert_eq!(
                    frame.delay_ms, frames[index].delay_ms,
                    "{name} 第 {index} 帧延时"
                );
                assert_eq!(
                    frame.pixels, frames[index].pixels,
                    "{name} 第 {index} 帧画面：解回来和喂进去的不是同一张图"
                );
            }
        }
    }

    /// 只解前几帧时（列表页首帧图），结果必须是全量解的前缀
    #[test]
    fn decoding_a_prefix_of_frames_matches_the_full_decode() {
        let frames = cases()
            .into_iter()
            .find(|(name, _, _, _)| *name == "walking-block-16x8")
            .map(|(_, _, _, frames)| frames)
            .expect("用例得在");
        let file = encode_rasters(16, 8, &frames).unwrap();

        let partial = decode_prefix(&file, Some(2)).unwrap();
        let whole = decode_prefix(&file, None).unwrap();
        assert_eq!(partial.frames.len(), 2);
        assert!(partial.complete, "按额度停下不算不完整");
        assert_eq!(partial.frame_count, 3, "文件里到底几帧得照实说");
        assert_eq!(partial.frames, whole.frames[..2]);
    }

    #[test]
    fn encode_rasters_rejects_inputs_the_web_side_rejects() {
        assert_eq!(
            encode_rasters(0, 4, &[raster(40, &[0u16; 4])]),
            Err("bad ANM canvas size")
        );
        assert_eq!(
            encode_rasters(2, 2, &[]),
            Err("empty ANM animation"),
            "没有帧就拼不出文件头里的 frame_count"
        );
        assert_eq!(
            encode_rasters(2, 2, &[raster(40, &[0u16; 4])]),
            Err("ANM animation has nothing to show"),
            "全黑素材没有可显示的内容"
        );
        assert_eq!(
            encode_rasters(2, 2, &[raster(40, &[0u16; 3])]),
            Err("ANM raster doesn't match the canvas size"),
            "像素数和画布对不上就别编，别让越界读悄悄发生"
        );
    }

    /// 编出来再解回去必须一帧不差：位图差分是**无损**的
    #[test]
    fn decode_prefix_gives_back_the_rasters_it_was_encoded_from() {
        let rasters = vec![
            raster(40, &[0x0000, 0x1234, 0x5678, 0x0001]),
            raster(60, &[0x0000, 0x1234, 0x5678, 0x0001]),
            raster(80, &[0x9ABC, 0x1234, 0x0000, 0x0001]),
        ];
        let file = encode_rasters(2, 2, &rasters).unwrap();
        let decoded = decode_prefix(&file, None).unwrap();

        assert!(decoded.complete);
        assert_eq!(decoded.frame_count, 3);
        assert_eq!(decoded.frames.len(), 3);
        for (index, frame) in decoded.frames.iter().enumerate() {
            assert_eq!(
                frame.delay_ms, rasters[index].delay_ms,
                "第 {index} 帧的延时"
            );
            assert_eq!(frame.pixels, rasters[index].pixels, "第 {index} 帧的画面");
        }
    }

    /// 只要前几帧（列表页首帧图）：解到额度就停，这不算"不完整"
    #[test]
    fn decode_prefix_stops_at_max_frames() {
        let file = encode_rasters(
            2,
            1,
            &[raster(40, &[0x0011, 0x0022]), raster(50, &[0x0033, 0x0022])],
        )
        .unwrap();
        let decoded = decode_prefix(&file, Some(1)).unwrap();

        assert_eq!(decoded.frames.len(), 1);
        assert_eq!(decoded.frames[0].pixels, vec![0x0011, 0x0022]);
        assert!(decoded.complete, "按额度停下的，不是数据不全");
        assert_eq!(decoded.frame_count, 2, "文件里到底有几帧还得照实说");
    }

    /// 铺满画布的第 0 帧（= `first_frame_span` 的上界那一档）+ 后面几帧
    fn wide_first_frame(count: usize) -> Vec<u8> {
        let width = 12usize;
        let height = 4usize;
        let pixels: Vec<u16> = (0..width * height).map(|i| (i as u16) | 0x21).collect();
        let rasters = (0..count)
            .map(|index| RasterFrame {
                delay_ms: 40,
                pixels: pixels
                    .iter()
                    .enumerate()
                    .map(|(at, value)| if at % (count + 1) == index { 0 } else { *value })
                    .collect(),
            })
            .collect::<Vec<_>>();
        encode_rasters(width as u16, height as u16, &rasters).unwrap()
    }

    /// 把 `bytes[at]` 去掉（模拟串口丢一个字节 → 后面整体前移一位）
    fn drop_byte(bytes: &[u8], at: usize) -> Vec<u8> {
        let mut out = bytes.to_vec();
        out.remove(at);
        out
    }

    /// 首帧图的可信度检查：干净的前缀要放行，**错位**一个字节的前缀必须拦下
    ///
    /// 这就是"网页上有的切片花掉、板子上却正常"的根因：`decode_prefix` 对错位的
    /// 字节流照样能解出一帧（`complete` 还是 `true`），画出来是花的。
    #[test]
    fn first_frame_trusted_catches_a_shifted_prefix() {
        let file = wide_first_frame(4);
        let span = first_frame_span(&file).unwrap() as usize;
        // 上界那一档一定盖住第 0 帧 + 下一个帧头
        let prefix = &file[..span.min(file.len())];
        assert!(first_frame_trusted(prefix), "干净前缀该放行");

        // 位图中段丢一个字节：popcount 变了，颜色个数跟着错位
        let shifted = drop_byte(prefix, HEADER_LEN + FRAME_HEADER_LEN + 8);
        assert!(
            !first_frame_trusted(&shifted),
            "错位的字节流必须拦下（否则画出来是花的）"
        );
        // 但 `decode_prefix` 对此一句话都没说 —— 这正是需要这个检查的原因
        let decoded = decode_prefix(&shifted, Some(1)).unwrap();
        assert_eq!(decoded.frames.len(), 1, "错位的流照样'解得出一帧'");
        assert!(decoded.complete);

        // 颜色区丢一个字节
        // 颜色区起点 = 帧头之后跳过位图（每行 2 字节 × 4 行）
        let colors_at = HEADER_LEN + FRAME_HEADER_LEN + 2 * 4 + 4;
        assert!(!first_frame_trusted(&drop_byte(prefix, colors_at)));
    }

    /// 前缀没盖住第 1 帧的帧头时不能放行：那时候没有任何边界证据
    #[test]
    fn first_frame_trusted_needs_the_next_frame_header() {
        let file = wide_first_frame(4);
        let view = &file[HEADER_LEN + 6..HEADER_LEN + 8];
        let bbox_width = u16::from_le_bytes([view[0], view[1]]) as usize;
        let bbox_height = u16::from_le_bytes([file[HEADER_LEN + 8], file[HEADER_LEN + 9]]) as usize;
        let bits: usize = file[HEADER_LEN + FRAME_HEADER_LEN
            ..HEADER_LEN + FRAME_HEADER_LEN + bbox_width.div_ceil(8) * bbox_height]
            .iter()
            .map(|byte| byte.count_ones() as usize)
            .sum();
        let exact_end =
            HEADER_LEN + FRAME_HEADER_LEN + bbox_width.div_ceil(8) * bbox_height + bits * 2;

        // 刚好只到第 0 帧末尾：第 0 帧本身没错，但没证据说明它没错位
        assert!(!first_frame_trusted(&file[..exact_end]));
        // 再多一个帧头就有证据了
        assert!(first_frame_trusted(&file[..exact_end + FRAME_HEADER_LEN]));
    }

    /// 单帧文件：只能靠"整份都在手里且解得干净"来放行
    #[test]
    fn first_frame_trusted_accepts_a_complete_single_frame_file() {
        let file = wide_first_frame(1);
        assert!(first_frame_trusted(&file));
        // 整份文件错位一个字节：`total_len` 就对不上了，拦下
        assert!(!first_frame_trusted(&drop_byte(&file, HEADER_LEN + 4)));
        // 只拿到一部分（没到 total_len）：没证据，拦下
        assert!(!first_frame_trusted(&file[..file.len() - 1]));
    }

    /// 每个截断长度都不许 panic：范围读拿到多长的段都有可能
    #[test]
    fn first_frame_trusted_survives_every_prefix() {
        let file = wide_first_frame(3);
        for cut in 0..=file.len() {
            let _ = first_frame_trusted(&file[..cut]);
        }
    }

    /// 每个截断长度都不许 panic：范围读拿到多长的段都有可能
    #[test]
    fn decode_prefix_survives_every_truncation() {
        let file = encode_rasters(
            4,
            2,
            &[raster(40, &[0x1111u16; 8]), raster(50, &[0x2222u16; 8])],
        )
        .unwrap();

        for cut in 0..=file.len() {
            match decode_prefix(&file[..cut], None) {
                Ok(decoded) => {
                    assert!(
                        decoded.frames.len() <= decoded.frame_count as usize,
                        "截到 {cut} 字节却解出了太多帧"
                    );
                    if decoded.complete {
                        assert_eq!(
                            decoded.frames.len(),
                            decoded.frame_count as usize,
                            "complete=true 却没解完：截到 {cut}"
                        );
                    }
                }
                Err(err) => assert!(cut < HEADER_LEN, "截到 {cut} 字节不该报错：{err}"),
            }
        }
    }

    #[test]
    fn validate_checks_the_whole_file_including_total_len() {
        let file = encode_rasters(2, 2, &[raster(40, &[0x0011, 0x0022, 0x0033, 0x0044])]).unwrap();
        assert_eq!(validate(&file), Ok(()));

        let mut short = file.clone();
        short.pop();
        assert_eq!(
            validate(&short),
            Err("ANM file ends before the declared frames"),
            "少一个字节就先撞上帧数不够"
        );

        let mut lying = file.clone();
        let declared = u32::from_le_bytes([lying[12], lying[13], lying[14], lying[15]]);
        lying[12..16].copy_from_slice(&(declared + 1).to_le_bytes());
        assert_eq!(
            validate(&lying),
            Err("ANM total_len doesn't match the file length"),
            "解得完但声明对不上，也是坏文件：这条解码管不着"
        );

        let mut flags = file.clone();
        flags[HEADER_LEN + 10] = 1;
        assert_eq!(
            validate(&flags),
            Err("ANM frame has nonzero flags/reserved")
        );

        assert_eq!(
            validate(&[0u8; 8]),
            Err("ANM file is shorter than its header")
        );
    }

    #[test]
    fn decode_prefix_rejects_files_the_web_side_should_not_pretty_print() {
        // bbox 出画布：这种文件画出来是残影，不能当"能播"
        let file = encode_rasters(4, 1, &[raster(40, &[0x0001, 0, 0, 0x0002])]).unwrap();
        let mut broken_bbox = file.clone();
        broken_bbox[HEADER_LEN + 6] = 5; // 第 0 帧的 bbox 宽：0..8 里 width 的低位
        assert_eq!(
            decode_prefix(&broken_bbox, None),
            Err("ANM frame bbox outside canvas")
        );

        // 声明的帧都解完了还剩字节：坏文件
        let mut trailing = file.clone();
        trailing.push(0);
        assert_eq!(
            decode_prefix(&trailing, None),
            Err("ANM file has bytes left after the declared frames")
        );

        assert_eq!(
            decode_prefix(&[0u8; 8], None),
            Err("ANM file is shorter than its header")
        );
        let mut not_anm = file;
        not_anm[0] = b'X';
        assert_eq!(decode_prefix(&not_anm, None), Err("not an ANM file"));
    }
}
