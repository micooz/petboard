import { describe, expect, it } from 'vitest';

import {
  ANM_FRAME_HEADER_LEN,
  ANM_HEADER_LEN,
  ANM_VERSION,
  encodeAnm,
  anmHeaderInfo,
  decodeAnm,
  validateAnm,
  type AnmRasterFrame,
} from '@/lib/encode/anm';

function canvas(width: number, height: number, fill = 0): Uint16Array {
  return new Uint16Array(width * height).fill(fill);
}

function put(pixels: Uint16Array, width: number, x: number, y: number, value: number): void {
  pixels[y * width + x] = value;
}

describe('encodeAnm / decodeAnm', () => {
  it('往返一致：3 帧、小块变化', () => {
    const width = 8;
    const height = 4;
    const a = canvas(width, height);
    put(a, width, 1, 1, 0xf800);
    const b = canvas(width, height);
    put(b, width, 1, 1, 0xf800);
    put(b, width, 2, 1, 0x07e0);
    const c = canvas(width, height);
    put(c, width, 2, 1, 0x07e0);
    put(c, width, 3, 3, 0x001f);

    const frames: AnmRasterFrame[] = [
      { delayMs: 40, pixels: a },
      { delayMs: 50, pixels: b },
      { delayMs: 60, pixels: c },
    ];
    const bytes = encodeAnm({ width, height }, frames);

    expect(validateAnm(bytes)).toEqual([]);
    const back = decodeAnm(bytes);
    expect(back.complete).toBe(true);
    expect(back.width).toBe(width);
    expect(back.height).toBe(height);
    expect(back.frameCount).toBe(3);
    expect(back.frames.map((frame) => frame.delayMs)).toEqual([40, 50, 60]);
    // 解出来的每一帧都是"合成后的整幅画面"，应当和输入逐像素一致
    expect([...back.frames[0].pixels]).toEqual([...a]);
    expect([...back.frames[1].pixels]).toEqual([...b]);
    expect([...back.frames[2].pixels]).toEqual([...c]);
  });

  it('文件头里没有循环次数，总长紧跟在帧数后面', () => {
    const width = 4;
    const height = 2;
    const pixels = canvas(width, height);
    put(pixels, width, 0, 0, 0x1234);
    const bytes = encodeAnm({ width, height }, [{ delayMs: 30, pixels }]);

    // 跨语言契约：这个值必须和 `crates/anmfmt/src/lib.rs` 的 VERSION 一致
    expect(ANM_VERSION).toBe(1);
    expect(ANM_HEADER_LEN).toBe(18);
    expect([...bytes.subarray(0, 4)]).toEqual([0x41, 0x4e, 0x4d, 0x00]);
    expect(bytes[4]).toBe(ANM_VERSION);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(10, true)).toBe(1); // frame_count
    expect(view.getUint32(12, true)).toBe(bytes.length); // total_len
    expect(view.getUint16(16, true)).toBe(0); // reserved
    // 帧数据从 18 开始：第 0 帧的 delay 就是 30
    expect(view.getUint16(ANM_HEADER_LEN, true)).toBe(30);
  });

  it('第 0 帧只画自己的非黑像素', () => {
    const width = 4;
    const height = 2;
    const first = canvas(width, height);
    put(first, width, 0, 0, 0x1234);
    const bytes = encodeAnm({ width, height }, [{ delayMs: 30, pixels: first }]);
    const back = decodeAnm(bytes);
    expect(back.frames[0].pixels[0]).toBe(0x1234);
    expect(back.frames[0].pixels[1]).toBe(0);
  });

  it('两帧完全一样时，第二帧是"空帧"（bbox 宽高为 0）', () => {
    const width = 4;
    const height = 2;
    const pixels = canvas(width, height);
    put(pixels, width, 1, 0, 0x0001);
    const bytes = encodeAnm({ width, height }, [
      { delayMs: 30, pixels },
      { delayMs: 30, pixels },
    ]);
    const view = new DataView(bytes.buffer);
    // 第 1 帧头：文件头 + 第 0 帧（帧头 12 + 1 字节位图 + 2 字节颜色）
    const secondHeaderAt = ANM_HEADER_LEN + ANM_FRAME_HEADER_LEN + 1 + 2;
    expect(view.getUint16(secondHeaderAt + 6, true)).toBe(0);
    expect(view.getUint16(secondHeaderAt + 8, true)).toBe(0);
    expect(validateAnm(bytes)).toEqual([]);
  });

  it('全黑素材会被拒绝', () => {
    // 错误不翻译：Rust 抛什么，界面就显示什么
    expect(() =>
      encodeAnm({ width: 2, height: 2 }, [{ delayMs: 10, pixels: canvas(2, 2) }]),
    ).toThrow(/nothing to show/);
  });

  it('validateAnm 能挑出被改坏的 total_len 和 bbox', () => {
    const width = 4;
    const height = 2;
    const pixels = canvas(width, height);
    put(pixels, width, 0, 0, 0x2222);
    const bytes = encodeAnm({ width, height }, [{ delayMs: 10, pixels }]);

    // total_len 多说一个字节：文件本身解得完，只有字段对不上
    const lying = bytes.slice();
    const view = new DataView(lying.buffer);
    view.setUint32(12, view.getUint32(12, true) + 1, true);
    expect(validateAnm(lying).join()).toContain('total_len');

    const bad = bytes.slice();
    new DataView(bad.buffer).setUint16(ANM_HEADER_LEN + 6, 99, true); // bbox 宽改成 99
    expect(validateAnm(bad).join()).toContain('outside canvas');

    // 少一个字节：先撞上"帧没解完"，报的是第一个问题，不是全部问题
    expect(validateAnm(bytes.slice(0, bytes.length - 1))).not.toEqual([]);
  });

  it('只给文件头那一段时，解码器不报错、标成不完整', () => {
    const width = 4;
    const height = 2;
    const pixels = canvas(width, height);
    put(pixels, width, 0, 0, 0x0001);
    const bytes = encodeAnm({ width, height }, [{ delayMs: 10, pixels }]);
    const head = bytes.slice(0, 24);
    const back = decodeAnm(head);
    expect(back.complete).toBe(false);
    expect(back.frameCount).toBe(1);
    expect(back.frames).toHaveLength(0);
  });

  it('旧版 v4 文件直接被拒（提示文案由 Rust 给）', () => {
    const bytes = new Uint8Array(ANM_HEADER_LEN);
    bytes.set([0x41, 0x4e, 0x4d, 0x00]);
    bytes[4] = 4;
    expect(() => decodeAnm(bytes)).toThrow(/unsupported ANM version/);
  });

  /**
   * `anmHeaderInfo` 是给"索引里只剩空壳"的条目补元数据用的（见 `useDevice` 的列表收尾）：
   * 只喂 18 字节文件头也要能报出尺寸/帧数，且认不出时返回 null 而不是抛。
   */
  it('anmHeaderInfo 只要文件头就报出尺寸和帧数', () => {
    const frames = Array.from({ length: 3 }, (_, i) => {
      const pixels = canvas(8, 6);
      put(pixels, 8, 0, 0, 0x1234 + i);
      return { delayMs: 40, pixels };
    });
    const bytes = encodeAnm({ width: 8, height: 6 }, frames);
    expect(anmHeaderInfo(bytes.subarray(0, ANM_HEADER_LEN))).toEqual({
      width: 8,
      height: 6,
      frames: 3,
    });
  });

  it('anmHeaderInfo 遇到非 ANM / 太短的数据返回 null', () => {
    expect(anmHeaderInfo(new Uint8Array(ANM_HEADER_LEN))).toBeNull();
    expect(anmHeaderInfo(new Uint8Array(4))).toBeNull();
  });
});
