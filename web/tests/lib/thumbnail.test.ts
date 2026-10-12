/**
 * 上传区小图预览的回归测试。
 *
 * 这里没有 DOM，所以手搓一个最小 canvas：只记下"往哪张画布写了什么"。
 * 要守住的是**缩放那一步**：`putImageData` 既不缩放也不吃 canvas 变换，
 * 把整帧（240×240）直接写进缩小后的画布（160×160）只会留下左上角一块，
 * 预览看上去就是"没居中、右下被切掉"。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GifWriter } from 'omggif';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeThumbnail } from '@/lib/thumbnail';

interface DrawCall {
  source: unknown;
  width: number;
  height: number;
}

class FakeContext {
  readonly draws: DrawCall[] = [];
  readonly puts: { canvas: FakeCanvas; width: number; height: number }[] = [];

  constructor(private readonly canvas: FakeCanvas) {}

  drawImage(source: unknown, _x: number, _y: number, width: number, height: number): void {
    this.draws.push({ source, width, height });
  }

  putImageData(data: { width: number; height: number }): void {
    this.puts.push({ canvas: this.canvas, width: data.width, height: data.height });
  }
}

class FakeCanvas {
  width = 300;
  height = 150;
  readonly context = new FakeContext(this);

  getContext(): FakeContext {
    return this.context;
  }

  toDataURL(): string {
    return 'data:image/png;base64,stub';
  }
}

/** 造样本 GIF 用的调色板：索引 0 透明、1 红、2 绿、3 蓝 */
const PALETTE = [0x000000, 0xff0000, 0x00ff00, 0x0000ff];

const canvases: FakeCanvas[] = [];

beforeEach(() => {
  canvases.length = 0;
  (globalThis as Record<string, unknown>).createImageBitmap = async () => ({
    width: 100,
    height: 50,
    close: () => undefined,
  });
  (globalThis as Record<string, unknown>).document = {
    createElement: () => {
      const canvas = new FakeCanvas();
      canvases.push(canvas);
      return canvas;
    },
  };
  (globalThis as Record<string, unknown>).ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).ImageData;
  delete (globalThis as Record<string, unknown>).createImageBitmap;
});

function catGif(): File {
  const bytes = readFileSync(resolve(process.cwd(), 'tests', 'fixture.gif'));
  return new File([bytes], 'cat.gif', { type: 'image/gif' });
}

describe('makeThumbnail', () => {
  it('GIF 预览按 contain 缩到上限尺寸，不裁掉右下角', async () => {
    const url = await makeThumbnail(catGif());
    expect(url).toBe('data:image/png;base64,stub');

    // 原帧 240×240 → 上限 160
    const full = canvases.find((canvas) => canvas.width === 240 && canvas.height === 240);
    const thumb = canvases.find((canvas) => canvas.width === 160 && canvas.height === 160);
    expect(full, '整帧要先落到一张等大画布上').toBeDefined();
    expect(thumb, '缩略图画布是 160×160').toBeDefined();

    // 整帧只允许写进那张 240×240 的画布
    const puts = canvases.flatMap((canvas) => canvas.context.puts);
    expect(puts).toHaveLength(1);
    expect(puts[0].canvas).toBe(full);

    // 缩小后的画布只能通过 drawImage 拿到缩放后的整帧，不能直接 putImageData
    expect(thumb!.context.puts).toHaveLength(0);
    expect(thumb!.context.draws).toEqual([{ source: full, width: 160, height: 160 }]);
  });

  it('WebP/PNG 这类静图走 createImageBitmap，不再误当 GIF 解码', async () => {
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const url = await makeThumbnail(new File([bytes], 'x.webp', { type: 'image/webp' }));
    expect(url).toBe('data:image/png;base64,stub');

    const thumb = canvases.find((canvas) => canvas.width === 100 && canvas.height === 50);
    expect(thumb).toBeDefined();
    expect(thumb!.context.draws).toHaveLength(1);
    expect(thumb!.context.draws[0].width).toBe(100);
    expect(thumb!.context.draws[0].height).toBe(50);
  });

  it('宽的图按比例缩小，不会被硬裁成正方形', async () => {
    // 320×100 的纯蓝 GIF：上限 160 时应该是 160×50，长宽比保住
    const buffer = new Uint8Array(4096);
    const writer = new GifWriter(buffer, 320, 100, { palette: PALETTE, loop: 0 });
    writer.addFrame(0, 0, 320, 100, new Uint8Array(320 * 100).fill(1), { delay: 10, disposal: 1 });
    const file = new File([buffer.slice(0, writer.end())], 'wide.gif', { type: 'image/gif' });

    await makeThumbnail(file);
    const full = canvases.find((canvas) => canvas.width === 320 && canvas.height === 100);
    const thumb = canvases.find((canvas) => canvas.width === 160 && canvas.height === 50);
    expect(full).toBeDefined();
    expect(thumb).toBeDefined();
    expect(thumb!.context.draws).toEqual([{ source: full, width: 160, height: 50 }]);
  });
});
