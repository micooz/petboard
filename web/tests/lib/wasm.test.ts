/**
 * JS ↔ WASM 的搬运契约：交给上层的数组不能是 wasm 线性内存上的视图
 * （内存一涨就 detach，那块 `Vec` 一被释放就会被下一笔分配踩掉）。
 *
 * 比的是**缓冲区身份**不是内容 —— 视图没被踩的时候内容也是对的，只比内容等于没测。
 */
import { describe, expect, it } from 'vitest';

import { decodeAnm, encodeAnm, validateAnm } from '@/lib/encode/anm';
import { encodeBmp } from '@/lib/encode/bmp';
import { wasmMemory } from '@/lib/wasm';

function block(width: number, height: number, value: number): Uint16Array {
  return new Uint16Array(width * height).fill(value);
}

/** 编一份小的，再编一堆大的，逼内存增长、让先那块被回收 */
function pressure(): void {
  for (let round = 0; round < 20; round += 1) {
    encodeAnm({ width: 128, height: 64 }, [{ delayMs: 10, pixels: block(128, 64, 0xf800) }]);
    encodeBmp(128, 64, new Uint8Array(128 * 64 * 3).fill(round));
  }
}

describe('跨 wasm 边界的结果都是自己的一份拷贝', () => {
  it('编出来的字节不挂在 wasm 的线性内存上', () => {
    const memory = wasmMemory();
    expect(memory, 'WASM 没加载').not.toBeNull();

    const bytes = encodeAnm({ width: 4, height: 2 }, [{ delayMs: 10, pixels: block(4, 2, 0x1234) }]);
    expect(bytes.buffer).not.toBe(memory!.buffer);
  });

  it('解出来的像素和延时不挂在 wasm 的线性内存上', () => {
    const memory = wasmMemory();
    const bytes = encodeAnm({ width: 4, height: 2 }, [{ delayMs: 10, pixels: block(4, 2, 0xabcd) }]);
    const image = decodeAnm(bytes);

    expect(image.frames[0].pixels.buffer).not.toBe(memory!.buffer);
    expect(validateAnm(bytes)).toEqual([]);
  });

  it('内存涨过之后，先前交出去的字节和画面仍然完整', () => {
    const bytes = encodeAnm({ width: 4, height: 2 }, [{ delayMs: 10, pixels: block(4, 2, 0xabcd) }]);
    const snapshot = Uint8Array.from(bytes);
    const image = decodeAnm(bytes);
    const pixels = Uint16Array.from(image.frames[0].pixels);

    pressure();

    expect(bytes).toEqual(snapshot);
    expect(image.frames[0].pixels).toEqual(pixels);
    expect(validateAnm(bytes)).toEqual([]);
  });

  it('同一份输入重复解，两次结果互不共享内存', () => {
    const bytes = encodeAnm({ width: 2, height: 2 }, [{ delayMs: 10, pixels: block(2, 2, 0x0ff0) }]);
    const first = decodeAnm(bytes);
    const second = decodeAnm(bytes);

    first.frames[0].pixels.fill(0); // 上层手贱改自己的视图，也不该影响别次解码的结果
    expect(second.frames[0].pixels).toEqual(block(2, 2, 0x0ff0));
  });
});
