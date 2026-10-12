import { describe, expect, it } from 'vitest';

import {
  ANM_FRAME_HEADER_LEN,
  ANM_HEADER_LEN,
  anmFirstFrameSpan,
  anmFirstFrameTrusted,
  decodeAnm,
  encodeAnm,
  type AnmRasterFrame,
} from '@/lib/encode/anm';
import { rgb565ToRgba } from '@/lib/encode/image';
import {
  loadPosterImage,
  posterBytesTrusted,
  posterPrefixLength,
  type FilePrefix,
  type PosterImage,
} from '@/lib/poster';
import { DeviceClient } from '@/lib/serial/client';
import { FakeBoard } from '@/lib/serial/fake-board';
import { Transport } from '@/lib/serial/transport';

const CANVAS = { width: 312, height: 164 };
/** 老代码固定按这个长度读前缀 —— 正是它把大第 0 帧切坏 */
const OLD_HEAD_BYTES = 64 * 1024;

/**
 * 第 0 帧几乎铺满画布的动画：`.ANM` 第 0 帧要存整幅非黑像素，
 * 312x164 这么一张是 ~106 KiB，固定读 64 KiB 一定切在帧中间。
 */
function wideFirstFrame(name: string): { name: string; bytes: Uint8Array } {
  const pixels = new Uint16Array(CANVAS.width * CANVAS.height);
  for (let y = 0; y < CANVAS.height; y += 1) {
    for (let x = 0; x < CANVAS.width; x += 1) pixels[y * CANVAS.width + x] = 0x0821 + ((x + y) % 32);
  }
  const frames: AnmRasterFrame[] = [{ delayMs: 100, pixels }];
  // 再来两帧，让"第 0 帧很大"这件事不至于变成单帧文件的特例
  for (let step = 1; step <= 2; step += 1) {
    const next = Uint16Array.from(pixels);
    for (let y = 10; y < 20; y += 1) {
      for (let x = 10 + step * 8; x < 18 + step * 8; x += 1) next[y * CANVAS.width + x] = 0xffff;
    }
    frames.push({ delayMs: 100, pixels: next });
  }
  return { name, bytes: encodeAnm(CANVAS, frames) };
}

async function connectBoard(fileName: string, bytes: Uint8Array): Promise<DeviceClient> {
  const board = new FakeBoard();
  board.files.set(fileName, bytes);
  const transport = new Transport(board);
  await transport.open();
  return new DeviceClient(transport);
}

describe('posterPrefixLength（画首帧图要读多少字节）', () => {
  it('ANM：按文件头算第 0 帧的上界，够画就行', () => {
    const { name, bytes } = wideFirstFrame('AB12CD34.ANM');
    const span = anmFirstFrameSpan(bytes);
    expect(span).not.toBeNull();
    // 第 0 帧：18 文件头 + 12 帧头 + ceil(312/8)*164 位图 + 每个像素 2 字节颜色
    expect(span).toBe(18 + 12 + 39 * 164 + CANVAS.width * CANVAS.height * 2);
    expect(span!).toBeGreaterThan(OLD_HEAD_BYTES);
    // 上界之外还要一个帧头：那是"第 0 帧真的到此结束"唯一的边界证据
    expect(posterPrefixLength(name, bytes.length, bytes)).toBe(span! + ANM_FRAME_HEADER_LEN);
  });

  it('BMP：浏览器解码要整份，别只读一半', () => {
    const size = 54 + 936 * 164;
    expect(posterPrefixLength('AB12CD34.BMP', size, new Uint8Array(54))).toBe(size);
  });

  it('认不出来的文件头退回原来的小前缀', () => {
    expect(posterPrefixLength('AB12CD34.ANM', 999_999, new Uint8Array(18))).toBe(OLD_HEAD_BYTES);
  });

  it('文件本身比上界还小就整个读回来', () => {
    const { name, bytes } = wideFirstFrame('AB12CD34.ANM');
    expect(posterPrefixLength(name, 40, bytes)).toBe(40);
  });
});

describe('loadPosterImage', () => {
  it('固定读 64 KiB 会一个完整帧都解不出来（这就是清空缓存后满屏黑块的起因）', () => {
    const { bytes } = wideFirstFrame('AB12CD34.ANM');
    const decoded = decodeAnm(bytes.subarray(0, OLD_HEAD_BYTES), { maxFrames: 1 });
    expect(decoded.frames).toHaveLength(0);
  });

  it('本机没有缓存时：读板子上的那段前缀就能画出第 0 帧', async () => {
    const { name, bytes } = wideFirstFrame('AB12CD34.ANM');
    const client = await connectBoard(name, bytes);
    const reads: string[] = [];
    const stored: PosterImage[] = [];

    const poster = await loadPosterImage(
      {
        stored: async () => null,
        cached: async () => null,
        dropCached: async () => undefined,
        read: async (offset, length) => {
          reads.push(`${offset}+${length}`);
          return client.getPartial(name, { offset, length, timeoutMs: 3_000 });
        },
        store: async (image) => {
          stored.push(image);
        },
      },
      name,
      bytes.length,
    );

    // 两次读：18 字节文件头 + 剩下的部分（不是"猜一个 64 KiB"）
    expect(reads).toEqual([
      `0+18`,
      `18+${anmFirstFrameSpan(bytes)! + ANM_FRAME_HEADER_LEN - 18}`,
    ]);
    expect(poster).not.toBeNull();
    expect(poster!.width).toBe(CANVAS.width);
    const first = decodeAnm(bytes, { maxFrames: 1 }).frames[0];
    expect(poster!.rgba).toEqual(rgb565ToRgba(first.pixels, CANVAS.width, CANVAS.height));
    // 顺手存起来，下次不用再读板子
    expect(stored).toHaveLength(1);
    expect(stored[0].width).toBe(CANVAS.width);
  });

  it('前缀没读全（串口丢字节）时：这次不画，也不当成坏文件', async () => {
    const { name, bytes } = wideFirstFrame('AB12CD34.ANM');
    const stored: PosterImage[] = [];
    const poster = await loadPosterImage(
      {
        stored: async () => null,
        cached: async () => null,
        dropCached: async () => undefined,
        // 头读到了，正文只读到一半
        read: async (offset, length) => ({
          bytes: offset === 0 ? bytes.subarray(0, length) : bytes.subarray(offset, offset + length / 2),
          complete: offset === 0,
        }),
        store: async (image) => {
          stored.push(image);
        },
      },
      name,
      bytes.length,
    );
    expect(poster).toBeNull();
    expect(stored).toEqual([]);
  });

  it('文件头就没读全：不再补读正文（板子没响应时那是白白多等一个超时）', async () => {
    const { name, bytes } = wideFirstFrame('AB12CD34.ANM');
    const reads: string[] = [];
    const stored: PosterImage[] = [];

    const poster = await loadPosterImage(
      {
        stored: async () => null,
        cached: async () => null,
        dropCached: async () => undefined,
        // 连文件头都只读到一半（`getPartial` 重试用尽时的形状）
        read: async (offset, length) => {
          reads.push(`${offset}+${length}`);
          return { bytes: bytes.subarray(offset, offset + length / 2), complete: false };
        },
        store: async (image) => {
          stored.push(image);
        },
      },
      name,
      bytes.length,
    );

    expect(reads).toEqual([`0+${ANM_HEADER_LEN}`]);
    expect(poster).toBeNull();
    expect(stored).toEqual([]);
  });

  it('本机已经有整份产物时：一次串口都不用碰', async () => {
    const { name, bytes } = wideFirstFrame('AB12CD34.ANM');
    const board = new FakeBoard();
    await new Transport(board).open();

    const poster = await loadPosterImage(
      {
        stored: async () => null,
        cached: async () => bytes,
        dropCached: async () => {
          throw new Error('干净产物不该被丢掉');
        },
        read: async () => {
          throw new Error('不该读板子');
        },
        store: async () => undefined,
      },
      name,
      bytes.length,
    );

    expect(poster).not.toBeNull();
    expect(board.log).toEqual([]);
  });
});

/** 把 `bytes[at]` 去掉：模拟串口丢一个字节 → 后面整体前移一位 */
function dropByte(bytes: Uint8Array, at: number): Uint8Array {
  const out = new Uint8Array(bytes.length - 1);
  out.set(bytes.subarray(0, at));
  out.set(bytes.subarray(at + 1), at);
  return out;
}

describe('posterBytesTrusted（解得出来不等于解对了）', () => {
  it('干净前缀放行；第 0 帧位图里丢一个字节必须拦下', () => {
    const { name, bytes } = wideFirstFrame('AB12CD34.ANM');
    const prefix = bytes.subarray(0, posterPrefixLength(name, bytes.length, bytes));
    expect(posterBytesTrusted(name, prefix)).toBe(true);

    // 第 0 帧位图中段丢一个字节：popcount 变了 → 颜色个数错位 → 整幅画面重画成花的
    const shifted = dropByte(prefix, ANM_HEADER_LEN + ANM_FRAME_HEADER_LEN + 500);
    expect(posterBytesTrusted(name, shifted)).toBe(false);
    // 而 `decodeAnm` 对此一句话都没说 —— 这正是需要这道闸的原因
    const decoded = decodeAnm(shifted, { maxFrames: 1 });
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.complete).toBe(true);
    const clean = decodeAnm(prefix, { maxFrames: 1 });
    let different = 0;
    for (let i = 0; i < decoded.frames[0].pixels.length; i += 1) {
      if (decoded.frames[0].pixels[i] !== clean.frames[0].pixels[i]) different += 1;
    }
    expect(different).toBeGreaterThan(0);
  });

  it('BMP 不需要这道闸（浏览器解码，半份直接解不开）', () => {
    expect(posterBytesTrusted('AB12CD34.BMP', new Uint8Array(7))).toBe(true);
  });

  it('anmFirstFrameTrusted 对非 ANM 字节流不报错', () => {
    expect(anmFirstFrameTrusted(new Uint8Array(3))).toBe(false);
  });
});

describe('loadPosterImage：错位的前缀不能画', () => {
  /** 每次都返回同一份（可能错位的）字节的假板子 */
  function fakeRead(bytes: Uint8Array, name: string) {
    return async (offset: number, length: number): Promise<FilePrefix> => {
      const slice = bytes.subarray(offset, offset + length);
      const out = new Uint8Array(slice);
      return { bytes: out, complete: true };
    };
  }

  it('读回来是错位的：不画、不存、也不判坏文件，下次刷新还会再试', async () => {
    const { name, bytes } = wideFirstFrame('AB12CD34.ANM');
    const prefixLen = posterPrefixLength(name, bytes.length, bytes);
    const shifted = dropByte(bytes.subarray(0, prefixLen), ANM_HEADER_LEN + ANM_FRAME_HEADER_LEN + 500);
    const stored: PosterImage[] = [];
    let dropped = 0;

    const poster = await loadPosterImage(
      {
        stored: async () => null,
        cached: async () => null,
        dropCached: async () => {
          dropped += 1;
        },
        read: fakeRead(shifted, name),
        store: async (image) => {
          stored.push(image);
        },
      },
      name,
      shifted.length,
    );

    expect(poster).toBeNull();
    expect(stored).toEqual([]);
    // 本机产物没被牵连（错位的是这次读卡，不是缓存）
    expect(dropped).toBe(0);
  });

  it('本机缓存里那份产物是错位的：丢掉它，重新读卡拿到的干净前缀照常画', async () => {
    const { name, bytes } = wideFirstFrame('AB12CD34.ANM');
    const prefixLen = posterPrefixLength(name, bytes.length, bytes);
    const dirty = dropByte(bytes.subarray(0, prefixLen), ANM_HEADER_LEN + ANM_FRAME_HEADER_LEN + 500);
    const stored: PosterImage[] = [];
    let dropped = 0;

    const poster = await loadPosterImage(
      {
        stored: async () => null,
        cached: async () => dirty,
        dropCached: async () => {
          dropped += 1;
        },
        read: fakeRead(bytes, name),
        store: async (image) => {
          stored.push(image);
        },
      },
      name,
      bytes.length,
    );

    expect(dropped).toBe(1);
    expect(poster).not.toBeNull();
    const first = decodeAnm(bytes, { maxFrames: 1 }).frames[0];
    expect(poster!.rgba).toEqual(rgb565ToRgba(first.pixels, CANVAS.width, CANVAS.height));
    expect(stored).toHaveLength(1);
  });
});
