import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { convertFile, DEFAULT_CONVERT_OPTIONS } from '@/lib/convert';
import { validateAnm } from '@/lib/encode/anm';
import type { RgbaImage } from '@/lib/encode/image';

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

function makeSheet(frameCounts: number[]): RgbaImage {
  const cell = 32;
  const image = blank(Math.max(...frameCounts) * cell, frameCounts.length * cell);
  for (let row = 0; row < frameCounts.length; row += 1) {
    for (let col = 0; col < frameCounts[row]; col += 1) {
      fillRect(image, col * cell + 8, row * cell + 8, 8, 8);
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

function staticWebpBytes(): Uint8Array {
  const data = [1, 2, 3];
  const body = [...ascii('VP8L'), ...le32(data.length), ...data];
  return Uint8Array.from([...ascii('RIFF'), ...le32(4 + body.length), ...ascii('WEBP'), ...body]);
}

class FakeContext {
  constructor(private readonly image: RgbaImage) {}

  drawImage(): void {}

  getImageData(): { data: ArrayBufferView; width: number; height: number } {
    return { data: this.image.data, width: this.image.width, height: this.image.height };
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  private readonly context: FakeContext;

  constructor(image: RgbaImage) {
    this.context = new FakeContext(image);
  }

  getContext(): FakeContext {
    return this.context;
  }
}

let sheet: RgbaImage;

beforeEach(() => {
  (globalThis as Record<string, unknown>).createImageBitmap = async () => ({
    width: sheet.width,
    height: sheet.height,
    close: () => undefined,
  });
  (globalThis as Record<string, unknown>).document = {
    createElement: () => new FakeCanvas(sheet),
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).createImageBitmap;
  delete (globalThis as Record<string, unknown>).document;
});

describe('convertFile（静态 WebP 精灵图）', () => {
  it('非最后一行就出现帧数变化：按行拆成多个 ANM，并能只重生成其中一段', async () => {
    sheet = makeSheet([1, 2]);
    const file = new File([new Uint8Array(staticWebpBytes())], 'sheet.webp', { type: 'image/webp' });

    const media = await convertFile(file, DEFAULT_CONVERT_OPTIONS);
    expect(media).toHaveLength(2);
    expect(media.map((item) => item.sheet)).toEqual([
      { mode: 'row', row: 0, rows: 2, delayMs: 100 },
      { mode: 'row', row: 1, rows: 2, delayMs: 100 },
    ]);
    expect(media.map((item) => item.frames)).toEqual([1, 2]);
    media.forEach((item) => expect(validateAnm(item.payload)).toEqual([]));

    const again = await convertFile(file, { ...DEFAULT_CONVERT_OPTIONS, fromSheet: media[0].sheet });
    expect(again).toHaveLength(1);
    expect(again[0].sheet?.row).toBe(0);
    expect(again[0].frames).toBe(1);
    expect(validateAnm(again[0].payload)).toEqual([]);
  });

  it('只有最后一行少几帧时仍整张一段，zZZ 和身体在同一帧里', async () => {
    sheet = makeSheet([2, 1]);
    const file = new File([new Uint8Array(staticWebpBytes())], 'sheet.webp', { type: 'image/webp' });

    const media = await convertFile(file, DEFAULT_CONVERT_OPTIONS);
    expect(media).toHaveLength(1);
    expect(media[0].sheet).toEqual({ mode: 'whole', row: 0, rows: 1, delayMs: 100 });
    expect(media[0].frames).toBe(3);
    expect(validateAnm(media[0].payload)).toEqual([]);
  });

  it('各行帧数相同且格子一致时整张是一段', async () => {
    sheet = makeSheet([2, 2]);
    const file = new File([new Uint8Array(staticWebpBytes())], 'sheet.webp', { type: 'image/webp' });

    const media = await convertFile(file, DEFAULT_CONVERT_OPTIONS);
    expect(media).toHaveLength(1);
    expect(media[0].sheet).toEqual({ mode: 'whole', row: 0, rows: 1, delayMs: 100 });
    expect(media[0].frames).toBe(4);
    expect(validateAnm(media[0].payload)).toEqual([]);
  });

  it('没有网格迹象的普通静态 WebP 仍走 BMP', async () => {
    sheet = blank(16, 16);
    fillRect(sheet, 0, 0, 16, 16);
    const file = new File([new Uint8Array(staticWebpBytes())], 'solid.webp', { type: 'image/webp' });

    const media = await convertFile(file, DEFAULT_CONVERT_OPTIONS);
    expect(media).toHaveLength(1);
    expect(media[0].ext).toBe('BMP');
    expect(media[0].kind).toBe('still');
  });
});
