import { describe, expect, it } from 'vitest';

import { DEFAULT_CONVERT_OPTIONS, framesToAnm } from '@/lib/convert';
import { validateAnm } from '@/lib/encode/anm';
import type { RgbaImage } from '@/lib/encode/image';
import { detectSpriteSheet, normalizeWebpDelay, webpKind } from '@/lib/encode/webp';

function blank(width: number, height: number): RgbaImage {
  return { data: new Uint8Array(width * height * 4), width, height };
}

function fillRect(image: RgbaImage, x: number, y: number, width: number, height: number): void {
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const at = ((y + row) * image.width + x + col) * 4;
      image.data[at] = 255;
      image.data[at + 1] = 0;
      image.data[at + 2] = 0;
      image.data[at + 3] = 255;
    }
  }
}

/** 每格 32×32，格内左上角放一个 8×8 红块，格与格之间是全透明缝 */
function makeSheet(frameCounts: number[]): RgbaImage {
  const cell = 32;
  const columns = Math.max(...frameCounts);
  const image = blank(columns * cell, frameCounts.length * cell);
  for (let row = 0; row < frameCounts.length; row += 1) {
    for (let col = 0; col < frameCounts[row]; col += 1) {
      fillRect(image, col * cell + 8, row * cell + 8, 8, 8);
    }
  }
  return image;
}

/** 每个格子里放“身体 + 分离的 zZZ”：两者之间也有透明缝，但它们是同一帧。 */
function makeDetachedSheet(frameCounts: number[]): RgbaImage {
  const cell = 32;
  const columns = Math.max(...frameCounts);
  const image = blank(columns * cell, frameCounts.length * cell);
  for (let row = 0; row < frameCounts.length; row += 1) {
    for (let col = 0; col < frameCounts[row]; col += 1) {
      fillRect(image, col * cell + 10, row * cell + 20, 12, 6);
      fillRect(image, col * cell + 12, row * cell + 4, 8, 3);
    }
  }
  return image;
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function le32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

function riff(chunks: { fourcc: string; data: number[] }[]): Uint8Array {
  const body: number[] = [];
  for (const chunk of chunks) {
    body.push(...ascii(chunk.fourcc), ...le32(chunk.data.length), ...chunk.data);
    if (chunk.data.length % 2 === 1) body.push(0);
  }
  return Uint8Array.from([...ascii('RIFF'), ...le32(4 + body.length), ...ascii('WEBP'), ...body]);
}

describe('webpKind', () => {
  it('认得出普通静态 WebP 和带 ANIM/ANMF 的真动画 WebP', () => {
    const still = riff([{ fourcc: 'VP8L', data: [1, 2, 3] }]);
    const animated = riff([
      { fourcc: 'VP8X', data: new Array(10).fill(0) },
      { fourcc: 'ANIM', data: new Array(6).fill(0) },
      { fourcc: 'ANMF', data: new Array(16).fill(0) },
    ]);
    expect(webpKind(still)).toBe('static');
    expect(webpKind(animated)).toBe('animated');
    expect(webpKind(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('detectSpriteSheet', () => {
  it('各行帧数相同且格子一致时返回整张一段', () => {
    const image = makeSheet([2, 2]);
    const layout = detectSpriteSheet(image);
    expect(layout).not.toBeNull();
    expect(layout!.rows).toBe(2);
    expect(layout!.columns).toBe(2);
    expect(layout!.rowMajor).toBe(true);
    expect(layout!.wholeFrames).toHaveLength(4);
    expect(layout!.groups.map((group) => group.frames.length)).toEqual([2, 2]);
    expect(layout!.wholeFrames![0].width).toBe(32);
    expect(layout!.wholeFrames![0].height).toBe(32);
    expect(layout!.wholeFrames![0].data[((8 * 32) + 8) * 4]).toBe(255);
  });

  it('只有最后一行少几帧：仍按整张一段处理', () => {
    const image = makeSheet([2, 1]);
    const layout = detectSpriteSheet(image);
    expect(layout).not.toBeNull();
    expect(layout!.rowMajor).toBe(true);
    expect(layout!.wholeFrames).toHaveLength(3);
  });

  it('同一格里的分离内容（身体 + zZZ）不会被拆成独立帧', () => {
    const layout = detectSpriteSheet(makeDetachedSheet([2, 1]))!;
    expect(layout.rows).toBe(2);
    expect(layout.columns).toBe(2);
    expect(layout.groups.map((group) => group.frames.length)).toEqual([2, 1]);
    expect(layout.rowMajor).toBe(true);
    expect(layout.wholeFrames).toHaveLength(3);
  });

  it('非最后一行就出现帧数变化：按行拆段', () => {
    const image = makeSheet([1, 2]);
    const layout = detectSpriteSheet(image);
    expect(layout).not.toBeNull();
    expect(layout!.rowMajor).toBe(false);
    expect(layout!.wholeFrames).toBeNull();
    expect(layout!.groups.map((group) => group.frames.length)).toEqual([1, 2]);
  });

  it('单行多格也是一段动画', () => {
    const image = makeSheet([3]);
    const layout = detectSpriteSheet(image);
    expect(layout).not.toBeNull();
    expect(layout!.rowMajor).toBe(true);
    expect(layout!.wholeFrames).toHaveLength(3);
  });

  it('看不出多个内容块时不猜，交给普通静图流程', () => {
    const solid = blank(16, 16);
    fillRect(solid, 0, 0, 16, 16);
    expect(detectSpriteSheet(solid)).toBeNull();
  });

  it('切片打包出来的 ANM 合法', () => {
    const layout = detectSpriteSheet(makeSheet([2, 2]))!;
    const media = framesToAnm(
      layout.groups[0].frames.map((image) => ({ delayMs: 100, image })),
      DEFAULT_CONVERT_OPTIONS,
    );
    expect(validateAnm(media.payload)).toEqual([]);
    expect(media.frames).toBe(2);
    expect(media.durationMs).toBe(200);
  });
});

describe('normalizeWebpDelay', () => {
  it('微秒转毫秒，0 / null 按 100ms，极端值收敛到 ANM 的 u16 范围', () => {
    expect(normalizeWebpDelay(100_000)).toBe(100);
    expect(normalizeWebpDelay(0)).toBe(100);
    expect(normalizeWebpDelay(null)).toBe(100);
    expect(normalizeWebpDelay(5_000)).toBe(10);
    expect(normalizeWebpDelay(100_000_000)).toBe(65535);
  });
});
