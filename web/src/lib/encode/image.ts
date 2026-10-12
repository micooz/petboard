import type { ClampedBytes } from '../bytes';

/**
 * 图片的像素级小工具：裁边、压到黑底、缩放、RGB565。
 *
 * 全部是纯计算的（不碰 canvas），所以网页和 Node 里跑出来的结果一模一样 ——
 * 这样网页编码器才能和 `crates/anmfmt` 的测试对齐。
 */

/** RGBA8 像素缓冲，行优先 */
export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export type Fit = 'contain' | 'cover' | 'fill';

export const DEFAULT_CANVAS = { width: 312, height: 164 } as const;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 所有帧里 alpha 非 0 像素的并集外接矩形；全透明返回 null */
export function alphaBounds(frames: RgbaImage[]): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  let any = false;
  for (const frame of frames) {
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        if (frame.data[(y * frame.width + x) * 4 + 3] === 0) continue;
        any = true;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!any) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function cropRgba(src: RgbaImage, rect: Rect): RgbaImage {
  const data = new Uint8Array(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const from = ((rect.y + y) * src.width + rect.x) * 4;
    data.set(src.data.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return { data, width: rect.width, height: rect.height };
}

/** RGBA → 黑底 RGB8：按 alpha 直接乘，不预乘也不做色彩管理 */
export function flattenOnBlack(img: RgbaImage): Uint8Array {
  const out = new Uint8Array(img.width * img.height * 3);
  for (let i = 0, o = 0; i < img.width * img.height; i += 1, o += 3) {
    const a = img.data[i * 4 + 3];
    const blend = (c: number) => Math.floor((c * a + 127) / 255);
    out[o] = blend(img.data[i * 4]);
    out[o + 1] = blend(img.data[i * 4 + 1]);
    out[o + 2] = blend(img.data[i * 4 + 2]);
  }
  return out;
}

function sampleRgb(
  src: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  out: Uint8Array,
  at: number,
): void {
  const x0 = Math.min(Math.max(Math.floor(x), 0), width - 1);
  const y0 = Math.min(Math.max(Math.floor(y), 0), height - 1);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = Math.min(Math.max(x - x0, 0), 1);
  const fy = Math.min(Math.max(y - y0, 0), 1);
  for (let c = 0; c < 3; c += 1) {
    const p00 = src[(y0 * width + x0) * 3 + c];
    const p10 = src[(y0 * width + x1) * 3 + c];
    const p01 = src[(y1 * width + x0) * 3 + c];
    const p11 = src[(y1 * width + x1) * 3 + c];
    const top = p00 + (p10 - p00) * fx;
    const bottom = p01 + (p11 - p01) * fx;
    out[at + c] = Math.round(top + (bottom - top) * fy);
  }
}

/**
 * RGB8 → RGB8 缩放：
 * `contain` 保持比例缩到框内、四周**黑底**居中；`cover` 保持比例铺满、多出来的裁掉；
 * `fill` 直接拉伸。
 */
export function scaleRgb(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
  fit: Fit,
): Uint8Array {
  const out = new Uint8Array(dstWidth * dstHeight * 3); // 默认全黑
  const scaleX = fit === 'fill' ? dstWidth / srcWidth : fit === 'cover' ? Math.max(dstWidth / srcWidth, dstHeight / srcHeight) : Math.min(dstWidth / srcWidth, dstHeight / srcHeight);
  const scaleY = fit === 'fill' ? dstHeight / srcHeight : scaleX;

  const scaledWidth = srcWidth * scaleX;
  const scaledHeight = srcHeight * scaleY;
  // 缩放后的图贴在目标画面里的位置（cover 时是负数 = 两边被裁掉）
  const offX = Math.floor((dstWidth - scaledWidth) / 2);
  const offY = Math.floor((dstHeight - scaledHeight) / 2);

  for (let dy = 0; dy < dstHeight; dy += 1) {
    const vy = dy - offY;
    if (vy < 0 || vy >= scaledHeight) continue; // 落在黑边里
    for (let dx = 0; dx < dstWidth; dx += 1) {
      const vx = dx - offX;
      if (vx < 0 || vx >= scaledWidth) continue;
      const sx = (vx + 0.5) / scaleX - 0.5;
      const sy = (vy + 0.5) / scaleY - 0.5;
      sampleRgb(src, srcWidth, srcHeight, sx, sy, out, (dy * dstWidth + dx) * 3);
    }
  }
  return out;
}

/** RGB8 → 整幅画布的 RGB565（`.ANM` 的像素格式） */
export function rgbToRgb565(rgb: Uint8Array): Uint16Array {
  const out = new Uint16Array(rgb.length / 3);
  for (let i = 0; i < out.length; i += 1) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    out[i] = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
  }
  return out;
}

export function rgb565ToRgba(pixels: Uint16Array, width: number, height: number): ClampedBytes {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 1) {
    const v = pixels[i];
    const r = ((v >> 11) & 0x1f) << 3;
    const g = ((v >> 5) & 0x3f) << 2;
    const b = (v & 0x1f) << 3;
    out[i * 4] = r | (r >> 5);
    out[i * 4 + 1] = g | (g >> 6);
    out[i * 4 + 2] = b | (b >> 5);
    out[i * 4 + 3] = 255;
  }
  return out;
}
