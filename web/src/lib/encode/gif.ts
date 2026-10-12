/**
 * GIF 解码：用 `omggif` 解出每帧的索引流，**自己按 GIF 规范做 disposal 合成**。
 *
 * 为什么不能直接用 `omggif` 的 `decodeAndBlitFrameRGBA` 一路叠下去：它**不处理
 * disposal**，只往同一块画布上叠加。真实素材里大量使用 disposal=2（每帧画完把
 * 自己那块矩形还原成背景），不处理的话旧帧内容会一直累积 —— 表现就是"拖影"。
 * 实测 `tests/fixture.gif`（25/28 帧是 disposal=2）压黑底之后，
 * 最后一帧有约 10% 的像素是残留的旧帧。
 *
 * 所以这里的做法是：每帧先用清零的临时缓冲拿到"这一帧自己的像素"，再按规范合成：
 *
 * - disposal 0/1：不动画布；
 * - disposal 2：把**上一帧**的矩形清成透明；
 * - disposal 3：把画布恢复成"上一帧画之前"的快照。
 */
import { GifReader } from 'omggif';

import type { RgbaImage } from './image';

export interface GifFrame {
  delayMs: number;
  image: RgbaImage;
}

export interface DecodedGif {
  width: number;
  height: number;
  frames: GifFrame[];
  /** 容器里的循环次数（0 = 无限）；GIF 没写就返回 null */
  loopCount: number | null;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  disposal: number;
}

/** GIF 的延迟单位是 1/100 秒；0 或过小按 100ms 处理 */
export function normalizeDelay(delayCentiseconds: number): number {
  const ms = Math.round(delayCentiseconds * 10);
  if (ms === 0) return 100;
  return Math.min(Math.max(ms, 10), 65535);
}

/** 把矩形里的像素清成透明（disposal = 2 的语义） */
function clearRect(canvas: Uint8ClampedArray, width: number, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    const start = (y * width + rect.x) * 4;
    canvas.fill(0, start, start + rect.width * 4);
  }
}

/** 把 `src`（这一帧自己的像素，透明处 alpha=0）里非透明的像素盖到画布上 */
function blitOpaque(canvas: Uint8ClampedArray, src: Uint8ClampedArray, width: number, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const at = (y * width + x) * 4;
      if (src[at + 3] === 0) continue;
      canvas[at] = src[at];
      canvas[at + 1] = src[at + 1];
      canvas[at + 2] = src[at + 2];
      canvas[at + 3] = src[at + 3];
    }
  }
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  const reader = new GifReader(bytes);
  const width = reader.width;
  const height = reader.height;
  const count = reader.numFrames();
  if (count === 0) throw new Error('这个 GIF 里没有帧');

  /** 合成后的画布 */
  const canvas = new Uint8ClampedArray(width * height * 4);
  /** 只拿"这一帧自己的像素"用的临时缓冲，每帧清零 */
  const frame = new Uint8ClampedArray(width * height * 4);

  let previous: Rect | null = null;
  let saved: Uint8ClampedArray | null = null;
  const frames: GifFrame[] = [];

  for (let i = 0; i < count; i += 1) {
    const info = reader.frameInfo(i);
    const rect: Rect = {
      x: info.x,
      y: info.y,
      width: info.width,
      height: info.height,
      disposal: info.disposal,
    };

    // 1) 先把上一帧的 disposal 做掉，再画这一帧
    if (previous) {
      if (previous.disposal === 2) clearRect(canvas, width, previous);
      else if (previous.disposal === 3 && saved) canvas.set(saved);
    }
    // 2) 这一帧自己要求 disposal = 3 的话，先留一份"画之前"的快照
    if (rect.disposal === 3) saved = new Uint8ClampedArray(canvas);

    // 3) 取这一帧自己的像素：清零之后让 omggif blit 一次（透明处它不会写）
    frame.fill(0);
    reader.decodeAndBlitFrameRGBA(i, frame);
    blitOpaque(canvas, frame, width, rect);

    previous = rect;
    frames.push({
      delayMs: normalizeDelay(info.delay),
      // 拷一份快照；统一成 Uint8Array（值域本来就是 0..255，不需要 clamped）
      image: { data: new Uint8Array(canvas), width, height },
    });
  }

  const loopCount = reader.loopCount();
  return {
    width,
    height,
    frames,
    loopCount: loopCount === 0 ? 0 : loopCount > 0 ? loopCount : null,
  };
}
