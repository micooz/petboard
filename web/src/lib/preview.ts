/**
 * 把卡上的素材解成能画到 canvas 上的 RGBA 帧。
 *
 * 只拿到文件开头一段时也能用：`decodeAnm` 允许数据不全，把**已经完整解出来**的帧给它就行
 * （卡片上的首帧图、悬停预览都靠这个：串口慢，能不读整份就不读）。
 */
import type { ClampedBytes } from './bytes';
import { decodeAnm } from './encode/anm';
import { rgb565ToRgba } from './encode/image';
import { extOf } from './index-file';

export interface PreviewFrame {
  delayMs: number;
  rgba: ClampedBytes;
}

export interface Preview {
  width: number;
  height: number;
  frames: PreviewFrame[];
  /** 只读了文件开头一段时为 false（此时播完手里的帧就该停住，而不是循环"前几帧"） */
  complete: boolean;
}

/** `.ANM`：直接用自带解析器 */
export function previewAnm(bytes: Uint8Array, maxFrames?: number): Preview {
  const image = decodeAnm(bytes, maxFrames === undefined ? {} : { maxFrames });
  return {
    width: image.width,
    height: image.height,
    complete: image.complete,
    frames: image.frames.map((frame) => ({
      delayMs: frame.delayMs,
      rgba: rgb565ToRgba(frame.pixels, image.width, image.height),
    })),
  };
}

/** `.BMP` 以及别的浏览器认得的图片：交给 `createImageBitmap` */
export async function previewBitmap(bytes: Uint8Array): Promise<Preview> {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/bmp' });
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('拿不到 2D 画布');
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, width, height);
  bitmap.close();
  return {
    width,
    height,
    complete: true,
    frames: [{ delayMs: 0, rgba: image.data as ClampedBytes }],
  };
}

export async function previewByName(name: string, bytes: Uint8Array, maxFrames?: number): Promise<Preview> {
  if (extOf(name) === 'ANM') return previewAnm(bytes, maxFrames);
  return previewBitmap(bytes);
}
