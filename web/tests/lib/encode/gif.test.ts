import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GifReader, GifWriter } from 'omggif';
import { describe, expect, it } from 'vitest';

import { decodeGif } from '@/lib/encode/gif';

/**
 * 样本 GIF 的调色板：**一项一个打包的 24 位 RGB**，长度必须是 2 的幂。
 * 索引 0 当透明色用，1 红、2 绿、3 蓝。
 */
const PALETTE = [0x000000, 0xff0000, 0x00ff00, 0x0000ff];

interface FrameSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 每个像素一个调色板索引 */
  index: number;
  disposal: number;
}

function buildGif(width: number, height: number, frames: FrameSpec[]): Uint8Array {
  const buffer = new Uint8Array(4096);
  const writer = new GifWriter(buffer, width, height, { palette: PALETTE, loop: 0 });
  for (const frame of frames) {
    const pixels = new Uint8Array(frame.width * frame.height).fill(frame.index);
    writer.addFrame(frame.x, frame.y, frame.width, frame.height, pixels, {
      delay: 10,
      disposal: frame.disposal,
      transparent: 0,
    });
  }
  return buffer.slice(0, writer.end());
}

function pixelAt(data: Uint8Array, width: number, x: number, y: number): number[] {
  const at = (y * width + x) * 4;
  return [data[at], data[at + 1], data[at + 2], data[at + 3]];
}

describe('decodeGif：按规范做 disposal 合成（拖影就是这里丢了）', () => {
  it('disposal=2：上一帧那一块会被还原成透明，不会留下来', () => {
    const gif = buildGif(4, 4, [
      { x: 0, y: 0, width: 2, height: 2, index: 1, disposal: 2 }, // 左上角红块，画完擦掉
      { x: 2, y: 2, width: 2, height: 2, index: 3, disposal: 1 }, // 右下角蓝块
    ]);
    const decoded = decodeGif(gif);
    expect(decoded.frames).toHaveLength(2);

    const first = decoded.frames[0].image.data;
    expect(pixelAt(first, 4, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(first, 4, 2, 2)).toEqual([0, 0, 0, 0]);

    const second = decoded.frames[1].image.data;
    // 关键：第一帧的红块必须已经没了（不处理的实现这里会是红的）
    expect(pixelAt(second, 4, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(second, 4, 1, 1)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(second, 4, 2, 2)).toEqual([0, 0, 255, 255]);
  });

  it('disposal=3：画下一帧之前把画布恢复成"上一帧画之前"的样子', () => {
    const gif = buildGif(4, 4, [
      { x: 0, y: 0, width: 2, height: 2, index: 1, disposal: 1 }, // 红
      { x: 2, y: 2, width: 2, height: 2, index: 3, disposal: 3 }, // 蓝，之后要撤销
      { x: 0, y: 2, width: 2, height: 2, index: 2, disposal: 1 }, // 绿
    ]);
    const decoded = decodeGif(gif);

    const second = decoded.frames[1].image.data;
    expect(pixelAt(second, 4, 0, 0)).toEqual([255, 0, 0, 255]); // 红还在
    expect(pixelAt(second, 4, 2, 2)).toEqual([0, 0, 255, 255]); // 这时有蓝

    const third = decoded.frames[2].image.data;
    expect(pixelAt(third, 4, 0, 0)).toEqual([255, 0, 0, 255]); // 红还在
    expect(pixelAt(third, 4, 0, 2)).toEqual([0, 255, 0, 255]); // 绿画上了
    expect(pixelAt(third, 4, 2, 2)).toEqual([0, 0, 0, 0]); // 蓝被撤销了
  });

  it('真实素材：帧与帧之间不再累积残留（修复前最后一帧约多 10% 像素）', () => {
    const gifPath = resolve(process.cwd(), 'tests', 'fixture.gif');
    const bytes = new Uint8Array(readFileSync(gifPath));
    const decoded = decodeGif(bytes);
    const width = decoded.width;
    const height = decoded.height;
    const opaque = decoded.frames.map((frame) => {
      let count = 0;
      const data = frame.image.data;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) count += 1;
      return count;
    });
    const first = opaque[0];
    const last = opaque[opaque.length - 1];
    // 不处理 disposal 时这个比值会一路涨到 1.3 以上
    expect(last).toBeLessThan(first * 1.15);
    expect(width * height).toBeGreaterThan(0);
    expect(new GifReader(bytes).numFrames()).toBe(decoded.frames.length);
  });
});
