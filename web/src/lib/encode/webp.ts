/**
 * WebP 的两种形态：
 *
 * - **真动画 WebP**：RIFF 容器里有 `ANIM` / `ANMF` 帧序列，用浏览器的
 *   `ImageDecoder`（WebCodecs）逐帧解码；每帧时长来自 `ANMF`。
 * - **静态精灵图**：只是一张单帧大图，网格是制图时的人为约定。这里只看
 *   **全透明行 / 列形成的缝**，不去读任何 sidecar JSON。
 *
 * 检测失败不猜：如果图里有多个内容格，但透明缝不足以可靠切分，抛
 * `SheetDetectionError`；如果整张图只有一个内容块，返回 null，让调用方
 * 继续按静图处理。
 */
import type { RgbaImage } from './image';

interface DecodedAnimation {
  frames: { delayMs: number; image: RgbaImage }[];
}

interface SheetFrameGroup {
  /** 0 开始的行号；传给 `SheetSource.row` */
  row: number;
  /** 这一行的帧，所有帧尺寸相同，保留了网格里的相对位置 */
  frames: RgbaImage[];
}

export interface SheetLayout {
  rows: number;
  /** 内容最宽一行的帧数 */
  columns: number;
  groups: SheetFrameGroup[];
  /** 除最后一行外帧数一致、且最后一行的尾部可以少几帧：整张按行优先就是一段动画 */
  rowMajor: boolean;
  /** `rowMajor = true` 时的整张帧序列；否则为 null */
  wholeFrames: RgbaImage[] | null;
}

export class SheetDetectionError extends Error {}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length > 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP';
}

/** 只认 RIFF 块；返回 animated / static，不是 WebP 时返回 null */
export function webpKind(bytes: Uint8Array): 'animated' | 'static' | null {
  if (!isWebp(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  while (at + 8 <= bytes.length) {
    const fourcc = ascii(bytes, at, 4);
    const size = view.getUint32(at + 4, true);
    if (fourcc === 'ANIM') return 'animated';
    // RIFF 块按偶数字节对齐；size 本身已经包含在 RIFF 里，不需要再加 8
    const next = at + 8 + size + (size % 2);
    if (next <= at || next > bytes.length) break;
    at = next;
  }
  return 'static';
}

/**
 * `VideoFrame.duration` 的单位是微秒；WebP 的 ANMF 里是毫秒。
 * 0 / null 按 100ms 处理，和 GIF 路径的“0 当 100ms”保持一致。
 */
export function normalizeWebpDelay(durationUs: number | null): number {
  const ms = Math.round((durationUs ?? 0) / 1000);
  if (ms <= 0) return 100;
  return Math.min(Math.max(ms, 10), 65535);
}

export async function decodeAnimatedWebp(bytes: Uint8Array): Promise<DecodedAnimation> {
  if (typeof ImageDecoder === 'undefined') {
    throw new Error('这个浏览器不支持解码动态 WebP，请用最新版 Chrome、Edge 或 Firefox。');
  }
  if (!(await ImageDecoder.isTypeSupported('image/webp'))) {
    throw new Error('这个浏览器不支持 WebP 解码，请用最新版 Chrome、Edge 或 Firefox。');
  }

  const decoder = new ImageDecoder({ data: bytes, type: 'image/webp', preferAnimation: true });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    if (!track || !track.animated || track.frameCount <= 1) {
      throw new Error('这个 WebP 里没有可播放的动态帧。');
    }

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('拿不到 2D 画布');

    const frames: { delayMs: number; image: RgbaImage }[] = [];
    let width = 0;
    let height = 0;
    for (let i = 0; i < track.frameCount; i += 1) {
      const { image } = await decoder.decode({ frameIndex: i });
      try {
        if (width === 0 || height === 0) {
          width = image.displayWidth;
          height = image.displayHeight;
          canvas.width = width;
          canvas.height = height;
        }
        if (image.displayWidth !== width || image.displayHeight !== height) {
          throw new Error('动态 WebP 的帧尺寸不一致，无法转换成 ANM。');
        }
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height);
        frames.push({
          delayMs: normalizeWebpDelay(image.duration),
          image: { data: new Uint8Array(pixels.data.buffer.slice(0)), width, height },
        });
      } finally {
        image.close();
      }
    }
    return { frames };
  } finally {
    decoder.close();
  }
}

interface Band {
  /** 包含在内容里的起始下标 */
  start: number;
  /** 包含在内容里的结束下标 */
  end: number;
}

function bands(values: boolean[]): Band[] {
  const out: Band[] = [];
  let start = -1;
  for (let i = 0; i <= values.length; i += 1) {
    const on = i < values.length && values[i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push({ start, end: i - 1 });
      start = -1;
    }
  }
  return out;
}

function alphaAt(image: RgbaImage, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3];
}

function contentRows(image: RgbaImage): Band[] {
  const values: boolean[] = [];
  for (let y = 0; y < image.height; y += 1) {
    let found = false;
    for (let x = 0; x < image.width; x += 1) {
      if (alphaAt(image, x, y) !== 0) {
        found = true;
        break;
      }
    }
    values.push(found);
  }
  return bands(values);
}

function contentColumns(image: RgbaImage, y0: number, y1: number): Band[] {
  const values: boolean[] = [];
  for (let x = 0; x < image.width; x += 1) {
    let found = false;
    for (let y = y0; y <= y1; y += 1) {
      if (alphaAt(image, x, y) !== 0) {
        found = true;
        break;
      }
    }
    values.push(found);
  }
  return bands(values);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** 从大图里裁一块；越界处填透明。这样非整除网格也能得到等大的帧。 */
function cropCell(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sy = y + row;
    if (sy < 0 || sy >= image.height) continue;
    for (let col = 0; col < width; col += 1) {
      const sx = x + col;
      if (sx < 0 || sx >= image.width) continue;
      const from = (sy * image.width + sx) * 4;
      const to = (row * width + col) * 4;
      data[to] = image.data[from];
      data[to + 1] = image.data[from + 1];
      data[to + 2] = image.data[from + 2];
      data[to + 3] = image.data[from + 3];
    }
  }
  return { data, width, height };
}

function groupsFromGrid(
  image: RgbaImage,
  rows: Band[],
  columns: Band[][],
  exact: boolean,
): SheetFrameGroup[] | null {
  const frameCounts = columns.map((bands) => bands.length);
  const maxColumns = Math.max(...frameCounts);
  const out: SheetFrameGroup[] = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const rowBand = rows[rowIndex];
    const bandsInRow = columns[rowIndex];
    if (bandsInRow.length === 0) continue;

    let cellWidth: number;
    let x0: number;
    if (exact) {
      if (image.width % maxColumns !== 0) return null;
      cellWidth = image.width / maxColumns;
      x0 = 0;
    } else if (bandsInRow.length === 1) {
      cellWidth = Math.max(1, bandsInRow[0].end - bandsInRow[0].start + 1);
      x0 = Math.max(0, Math.round((bandsInRow[0].start + bandsInRow[0].end + 1 - cellWidth) / 2));
    } else {
      const starts = bandsInRow.map((band) => band.start);
      cellWidth = median(starts.slice(1).map((start, i) => start - starts[i]));
      const firstCenter = (bandsInRow[0].start + bandsInRow[0].end + 1) / 2;
      x0 = Math.round(firstCenter - cellWidth / 2);
      x0 = Math.max(0, Math.min(x0, image.width - cellWidth * bandsInRow.length));
    }
    if (cellWidth <= 0) return null;

    const cellHeight = exact ? image.height / rows.length : rowBand.end - rowBand.start + 1;
    if (!Number.isInteger(cellHeight) || cellHeight <= 0) return null;

    const frames: RgbaImage[] = [];
    for (let frameIndex = 0; frameIndex < bandsInRow.length; frameIndex += 1) {
      const band = bandsInRow[frameIndex];
      const cellX = exact ? frameIndex * cellWidth : x0 + frameIndex * cellWidth;
      const cellY = exact ? rowIndex * cellHeight : rowBand.start;
      if (band.start < cellX || band.end >= cellX + cellWidth) return null;
      if (exact && (rowBand.start < cellY || rowBand.end >= cellY + cellHeight)) return null;
      frames.push(cropCell(image, Math.round(cellX), Math.round(cellY), Math.round(cellWidth), Math.round(cellHeight)));
    }
    out.push({ row: rowIndex, frames });
  }

  return out;
}

function rowContentCounts(image: RgbaImage): number[] {
  const counts = new Array<number>(image.height).fill(0);
  for (let y = 0; y < image.height; y += 1) {
    let count = 0;
    for (let x = 0; x < image.width; x += 1) {
      if (alphaAt(image, x, y) !== 0) count += 1;
    }
    counts[y] = count;
  }
  return counts;
}

function columnContentCounts(image: RgbaImage): number[] {
  const counts = new Array<number>(image.width).fill(0);
  for (let x = 0; x < image.width; x += 1) {
    let count = 0;
    for (let y = 0; y < image.height; y += 1) {
      if (alphaAt(image, x, y) !== 0) count += 1;
    }
    counts[x] = count;
  }
  return counts;
}

function bandsFromCounts(counts: number[]): Band[] {
  return bands(counts.map((count) => count > 0));
}

/** 有内容的行/列在 `lag` 位移后和原来的相似度；规则网格会有明显峰值。 */
function autocorrelation(values: number[], lag: number): number {
  let mean = 0;
  for (const value of values) mean += value;
  mean /= values.length;

  let denominator = 0;
  for (const value of values) {
    const delta = value - mean;
    denominator += delta * delta;
  }
  if (denominator === 0) return 0;

  let numerator = 0;
  for (let i = 0; i + lag < values.length; i += 1) {
    numerator += (values[i] - mean) * (values[i + lag] - mean);
  }
  return numerator / denominator;
}

interface GridPeriod {
  /** 一格的宽/高（像素） */
  period: number;
  /** 一行/一列有多少格 */
  cells: number;
  /** 自相关分数，越高越像规则网格 */
  score: number;
}

/**
 * 从内容投影里找“规则重复的格子尺寸”。
 *
 * 关键不是“找到一条透明缝就切”，而是要求**候选边界不切过任何内容块**：
 * 例如睡觉动画里 zZZ 和身体是同一格里的两个分离内容，zZZ 与身体之间也有透明缝；
 * 只按透明缝切会把 zZZ 单独切成一帧。这里用自相关找重复周期，再用
 * “内容块不跨边界”筛掉 zZZ 这种假周期。
 */
function gridPeriod(counts: number[], size: number): GridPeriod | null {
  const content = bandsFromCounts(counts);
  const candidates: GridPeriod[] = [];

  // 一屏最多 64 格；格太小时容易把 zZZ 这种小图标当成独立帧。
  for (let cells = 1; cells <= 64; cells += 1) {
    if (size % cells !== 0) continue;
    const period = size / cells;
    if (period < 8) continue;

    // 有任何一个内容块跨过候选边界，这个周期就不是完整格子。
    const crossesBoundary = content.some(
      (band) => Math.floor(band.end / period) !== Math.floor(band.start / period),
    );
    if (crossesBoundary) continue;

    const score = autocorrelation(counts, period);
    if (score < 0.35) continue;
    candidates.push({ period, cells, score });
  }

  if (candidates.length === 0) return null;

  // 在分数接近的候选里优先选更小的周期：208 比 416 更像真实格子；
  // 同时要求分数不能比最佳候选低太多，避免把两行合成一格。
  const best = Math.max(...candidates.map((candidate) => candidate.score));
  const qualified = candidates.filter((candidate) => candidate.score >= best * 0.75);
  qualified.sort((a, b) => a.period - b.period);
  return qualified[0];
}

function hasVisiblePixels(frame: RgbaImage): boolean {
  for (let i = 3; i < frame.data.length; i += 4) {
    if (frame.data[i] !== 0) return true;
  }
  return false;
}

/** 按固定格子切；同一个格子里的所有内容（例如身体 + zZZ）会留在同一帧里。 */
function groupsFromCells(
  image: RgbaImage,
  columns: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
): SheetFrameGroup[] {
  const out: SheetFrameGroup[] = [];
  for (let row = 0; row < rows; row += 1) {
    const frames: RgbaImage[] = [];
    let lastContent = -1;
    for (let column = 0; column < columns; column += 1) {
      const frame = cropCell(image, column * cellWidth, row * cellHeight, cellWidth, cellHeight);
      frames.push(frame);
      if (hasVisiblePixels(frame)) lastContent = column;
    }
    if (lastContent >= 0) out.push({ row, frames: frames.slice(0, lastContent + 1) });
  }
  return out;
}

function isRowMajor(frameCounts: number[]): boolean {
  if (frameCounts.length === 0) return false;
  const first = frameCounts[0];
  // 单段动画按行优先铺开时，只有最后一行可能因为序列结束而少几帧；
  // 多段素材则会在“非最后一行”就出现帧数变化。
  return frameCounts.slice(0, -1).every((count) => count === first) && frameCounts[frameCounts.length - 1] <= first;
}

/**
 * 识别静态 WebP 精灵图。
 *
 * - 找不到内容块，或整张图只有一个内容块：返回 null（普通静图）。
 * - 内容格之间没有透明缝、或缝不足以推出等大格子：抛 `SheetDetectionError`。
 * - 除最后一行外帧数一致、且格子尺寸一致：`rowMajor = true`，`wholeFrames` 按行优先拼接。
 * - 否则：`rowMajor = false`，调用方应按 `groups` 每行生成一段动画。
 */
export function detectSpriteSheet(image: RgbaImage): SheetLayout | null {
  const rows = contentRows(image);
  if (rows.length === 0) return null;

  const columns = rows.map((row) => contentColumns(image, row.start, row.end));
  const total = columns.reduce((sum, list) => sum + list.length, 0);
  if (total <= 1) return null;

  // 首选“规则周期”网格：能正确处理一张格子里有多个分离内容（例如身体 + zZZ）的情况。
  const rowProfile = rowContentCounts(image);
  const columnProfile = columnContentCounts(image);
  const rowPeriod = gridPeriod(rowProfile, image.height);
  const columnPeriod = gridPeriod(columnProfile, image.width);
  if (rowPeriod && columnPeriod) {
    const groups = groupsFromCells(
      image,
      columnPeriod.cells,
      rowPeriod.cells,
      columnPeriod.period,
      rowPeriod.period,
    );
    if (groups.length > 0) {
      const frameCounts = groups.map((group) => group.frames.length);
      const sample = groups[0].frames[0];
      const rowMajor =
        isRowMajor(frameCounts) &&
        groups.every((group) =>
          group.frames.every(
            (frame) => frame.width === sample.width && frame.height === sample.height,
          ),
        );
      const wholeFrames = rowMajor ? groups.flatMap((group) => group.frames) : null;
      return {
        rows: rowPeriod.cells,
        columns: columnPeriod.cells,
        groups,
        rowMajor,
        wholeFrames,
      };
    }
  }

  // 兜底：单行/单列、或周期不够明显时，只按透明缝推格子。
  let groups = groupsFromGrid(image, rows, columns, true);
  if (!groups) groups = groupsFromGrid(image, rows, columns, false);
  if (!groups || groups.length === 0) {
    throw new SheetDetectionError(
      '这张 WebP 看起来像多格精灵图，但透明缝不足以可靠切片。请先导出成单行/单段网格，或转成 GIF。',
    );
  }

  const frameCounts = groups.map((group) => group.frames.length);
  const sample = groups[0].frames[0];
  const rowMajor =
    isRowMajor(frameCounts) &&
    groups.every((group) =>
      group.frames.every(
        (frame) => frame.width === sample.width && frame.height === sample.height,
      ),
    );
  const wholeFrames = rowMajor ? groups.flatMap((group) => group.frames) : null;

  return {
    rows: rows.length,
    columns: Math.max(...frameCounts),
    groups,
    rowMajor,
    wholeFrames,
  };
}
