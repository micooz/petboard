import { describe, expect, it } from 'vitest';

import { BMP_HEADER_LEN, bmpRowSize, encodeBmp } from '@/lib/encode/bmp';

describe('encodeBmp', () => {
  it('头部字段和 crates/bmpfmt 对齐', () => {
    const rgb = new Uint8Array(4 * 3 * 3);
    const bmp = encodeBmp(4, 3, rgb);
    const view = new DataView(bmp.buffer);
    expect(String.fromCharCode(bmp[0], bmp[1])).toBe('BM');
    expect(view.getUint32(10, true)).toBe(BMP_HEADER_LEN);
    expect(view.getInt32(18, true)).toBe(4);
    expect(view.getInt32(22, true)).toBe(3);
    expect(view.getUint16(28, true)).toBe(24);
    expect(view.getUint32(34, true)).toBe(4 * 3 * 3);
    expect(bmp.length).toBe(BMP_HEADER_LEN + 4 * 3 * 3);
  });

  it('每行按 4 字节对齐（宽 3 → 行宽 12）', () => {
    expect(bmpRowSize(3)).toBe(12);
    const rgb = new Uint8Array(3 * 2 * 3);
    const bmp = encodeBmp(3, 2, rgb);
    expect(bmp.length).toBe(BMP_HEADER_LEN + 12 * 2);
  });

  it('像素自下而上、每个像素 BGR', () => {
    // 4x2（宽度取 4 就没有补齐字节，好读）：上排红、绿，下排蓝、白
    const rgb = new Uint8Array([
      255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0,
    ]);
    const bmp = encodeBmp(4, 2, rgb);
    const pixels = bmp.subarray(BMP_HEADER_LEN);
    // 第一行（文件里的第一行）= 图片最下面一行 = 蓝、白
    expect([...pixels.subarray(0, 3)]).toEqual([255, 0, 0]); // 蓝在 BMP 里是 B=255,G=0,R=0
    expect([...pixels.subarray(3, 6)]).toEqual([255, 255, 255]);
    // 第二行（偏移 12 起）才是图片最上面一行：红、绿
    expect([...pixels.subarray(12, 15)]).toEqual([0, 0, 255]);
    expect([...pixels.subarray(15, 18)]).toEqual([0, 255, 0]);
  });
});
