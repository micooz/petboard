import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { convertFile, DEFAULT_CONVERT_OPTIONS, UnsupportedFileError } from '@/lib/convert';
import { ANM_VERSION, decodeAnm, validateAnm } from '@/lib/encode/anm';

// 冻结的素材副本：原 `assets/` 里那只 240×240 的跳舞猫，测试不再读上层目录。
const gifPath = resolve(process.cwd(), 'tests', 'fixture.gif');

function gifFile(name = 'fixture.gif'): File {
  const bytes = readFileSync(gifPath);
  return new File([new Uint8Array(bytes)], name, { type: 'image/gif' });
}

describe('convertFile（GIF → ANM，纯计算，Node 里能跑）', () => {
  it('把 fixture.gif 转成合法的 .ANM', async () => {
    const [media] = await convertFile(gifFile(), DEFAULT_CONVERT_OPTIONS);
    expect(media.kind).toBe('anim');
    expect(media.ext).toBe('ANM');
    expect(media.width).toBe(312);
    expect(media.height).toBe(164);
    expect(media.frames).toBeGreaterThan(1);
    expect(validateAnm(media.payload)).toEqual([]);

    const decoded = decodeAnm(media.payload);
    expect(decoded.complete).toBe(true);
    expect(decoded.frameCount).toBe(media.frames);
  });

  it('同一个输入转两次结果一样（可复现，才能当 fixture）', async () => {
    const [first] = await convertFile(gifFile(), DEFAULT_CONVERT_OPTIONS);
    const [second] = await convertFile(gifFile(), DEFAULT_CONVERT_OPTIONS);
    expect([...first.payload]).toEqual([...second.payload]);
  });

  it('产出的 .ANM 里没有循环次数（头 18 字节，total_len 紧跟帧数）', async () => {
    const [media] = await convertFile(gifFile(), DEFAULT_CONVERT_OPTIONS);
    expect(media.payload[4]).toBe(ANM_VERSION);
    const header = new DataView(media.payload.buffer, media.payload.byteOffset, media.payload.byteLength);
    expect(header.getUint32(12, true)).toBe(media.payload.length);
    expect('loops' in media).toBe(false);
  });

  // cover 会把画面铺满：bbox 明显变宽、位图变大，是设备侧最容易踩到内存边界的形态，
  // 所以单独钉一条"产出的字节合法"的用例。
  it('cover 布局也产出合法 .ANM（帧更大、bbox 更宽）', async () => {
    const [contain] = await convertFile(gifFile(), DEFAULT_CONVERT_OPTIONS);
    const [cover] = await convertFile(gifFile(), { ...DEFAULT_CONVERT_OPTIONS, fit: 'cover' });
    expect(validateAnm(cover.payload)).toEqual([]);
    expect(cover.frames).toBe(contain.frames);
    expect(cover.payload.length).toBeGreaterThan(contain.payload.length);
  });

  it('认不出的格式报 UnsupportedFileError', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'x.bin');
    await expect(convertFile(file, DEFAULT_CONVERT_OPTIONS)).rejects.toBeInstanceOf(UnsupportedFileError);
  });
});
