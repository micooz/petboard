/**
 * 上传前的转换：把用户拖进来的图片 / GIF / WebP 变成板子认识的 `.BMP` / `.ANM`。
 *
 * 板子上没有图片解码器，所以解码、裁边、缩放全在这里做完；
 * 产出的字节必须能被共用格式实现解析（`crates/anmfmt`、`crates/bmpfmt`）。
 *
 * 这里**不管循环次数**：`.ANM` 只描述"一段动画"，播几轮由 `lib/loops.ts` 那条外部链路决定。
 *
 * WebP 分两类：
 * - 真动画 WebP（RIFF 里有 `ANIM` / `ANMF`）：逐帧解码，时长来自容器；
 * - 静态精灵图：按全透明缝识别网格。各行帧数相同且格子一致时整张按行优先一段，
 *   否则每行一段；静图没有时长信息，固定 100ms。
 */
import { encodeAnm, type AnmRasterFrame } from './encode/anm';
import { encodeBmp } from './encode/bmp';
import { decodeGif } from './encode/gif';
import {
  alphaBounds,
  cropRgba,
  DEFAULT_CANVAS,
  flattenOnBlack,
  rgbToRgb565,
  scaleRgb,
  type Fit,
  type RgbaImage,
} from './encode/image';
import {
  decodeAnimatedWebp,
  detectSpriteSheet,
  SheetDetectionError,
  webpKind,
  type SheetLayout,
} from './encode/webp';
import type { SheetSource } from './index-file';

export interface ConvertOptions {
  width: number;
  height: number;
  fit: Fit;
  /** 裁掉所有帧共用的透明边 */
  trim: boolean;
  /**
   * 只用于“改布局重新生成”：指定原图里已经识别过的某一横段 / 整张。
   * 不传时按当前图片重新自动识别。
   */
  fromSheet?: SheetSource;
}

export const DEFAULT_CONVERT_OPTIONS: ConvertOptions = {
  width: DEFAULT_CANVAS.width,
  height: DEFAULT_CANVAS.height,
  fit: 'contain',
  trim: true,
};

/** 静态 WebP 精灵图没有时长信息，按 10fps 处理 */
const SHEET_FRAME_DELAY_MS = 100;

export interface ConvertedMedia {
  kind: 'anim' | 'still';
  ext: 'ANM' | 'BMP';
  payload: Uint8Array;
  width: number;
  height: number;
  frames: number;
  durationMs: number;
  sourceType: string;
  /** 只有静态精灵图拆出来的动画才有 */
  sheet?: SheetSource;
}

export class UnsupportedFileError extends Error {}

const MAGIC = {
  gif87: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
  gif89: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  png: [0x89, 0x50, 0x4e, 0x47],
  jpeg: [0xff, 0xd8, 0xff],
  bmp: [0x42, 0x4d],
};

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((value, index) => bytes[index] === value);
}

function sourceTypeOf(bytes: Uint8Array, file: File): string {
  if (startsWith(bytes, MAGIC.gif87) || startsWith(bytes, MAGIC.gif89)) return 'gif';
  if (startsWith(bytes, MAGIC.png)) return 'png';
  if (startsWith(bytes, MAGIC.jpeg)) return 'jpeg';
  if (startsWith(bytes, MAGIC.bmp)) return 'bmp';
  if (webpKind(bytes) !== null) return 'webp';
  throw new UnsupportedFileError(`${file.name}：认不出这是什么图片格式`);
}

/** 浏览器解码静图（PNG/JPEG/WebP/BMP 都交给它） */
async function decodeStill(file: File): Promise<RgbaImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new UnsupportedFileError(`${file.name}：这个图片浏览器解不开`);
  }
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
  return { data: new Uint8Array(image.data.buffer.slice(0)), width, height };
}

/**
 * 所有动画（GIF / 动态 WebP / 精灵图切片）最后都走这里：
 * 裁透明边 → 压黑底 → 缩放到画布 → RGB565。
 */
function framesToRasters(
  frames: { delayMs: number; image: RgbaImage }[],
  options: ConvertOptions,
): AnmRasterFrame[] {
  if (frames.length === 0) throw new UnsupportedFileError('这个动画里没有帧');

  const first = frames[0].image;
  if (frames.some((frame) => frame.image.width !== first.width || frame.image.height !== first.height)) {
    throw new UnsupportedFileError('动画各帧尺寸不一致，无法转换成 ANM');
  }

  // 1) 裁掉所有帧共用的透明边
  const bounds = options.trim ? alphaBounds(frames.map((frame) => frame.image)) : null;
  if (options.trim && !bounds) throw new UnsupportedFileError('这个动画全是透明像素，没有可见内容');
  const rect = bounds ?? { x: 0, y: 0, width: first.width, height: first.height };

  // 2) 每帧：裁边 → 压黑底 → 缩放到画布 → RGB565
  return frames.map((frame) => {
    const cropped = cropRgba(frame.image, rect);
    const rgb = flattenOnBlack(cropped);
    const scaled = scaleRgb(rgb, cropped.width, cropped.height, options.width, options.height, options.fit);
    return { delayMs: frame.delayMs, pixels: rgbToRgb565(scaled) };
  });
}

export function framesToAnm(
  frames: { delayMs: number; image: RgbaImage }[],
  options: ConvertOptions,
): { payload: Uint8Array; frames: number; durationMs: number } {
  const rasters = framesToRasters(frames, options);
  const payload = encodeAnm({ width: options.width, height: options.height }, rasters);
  return {
    payload,
    frames: rasters.length,
    durationMs: rasters.reduce((sum, frame) => sum + frame.delayMs, 0),
  };
}

function buildMedia(
  frames: { delayMs: number; image: RgbaImage }[],
  options: ConvertOptions,
  sourceType: string,
  sheet?: SheetSource,
): ConvertedMedia {
  const result = framesToAnm(frames, options);
  const media: ConvertedMedia = {
    kind: 'anim',
    ext: 'ANM',
    payload: result.payload,
    width: options.width,
    height: options.height,
    frames: result.frames,
    durationMs: result.durationMs,
    sourceType,
  };
  if (sheet) media.sheet = sheet;
  return media;
}

function staticMedia(image: RgbaImage, options: ConvertOptions, sourceType: string): ConvertedMedia {
  const rgb = flattenOnBlack(image);
  const scaled = scaleRgb(rgb, image.width, image.height, options.width, options.height, options.fit);
  const payload = encodeBmp(options.width, options.height, scaled);
  return {
    kind: 'still',
    ext: 'BMP',
    payload,
    width: options.width,
    height: options.height,
    frames: 1,
    durationMs: 0,
    sourceType,
  };
}

function withDelay(frames: RgbaImage[], delayMs: number): { delayMs: number; image: RgbaImage }[] {
  return frames.map((image) => ({ delayMs, image }));
}

function convertSheet(layout: SheetLayout, options: ConvertOptions): ConvertedMedia[] {
  const delayMs = options.fromSheet?.delayMs ?? SHEET_FRAME_DELAY_MS;

  // 改布局重生成：只产出指定的一段，别把整张图的所有行都重传一遍。
  if (options.fromSheet) {
    const requested = options.fromSheet;
    const frames =
      requested.mode === 'whole'
        ? layout.wholeFrames
        : layout.groups.find((group) => group.row === requested.row)?.frames;
    if (!frames) {
      throw new UnsupportedFileError(
        '源文件结构和上次识别的不一致，无法只重新生成这一段；请重新上传原图。',
      );
    }
    return [
      buildMedia(withDelay(frames, delayMs), options, 'webp', {
        ...requested,
        delayMs,
      }),
    ];
  }

  // 除最后一行外帧数一致、格子尺寸一致：整张图就是一段按行优先铺开的动画。
  if (layout.rowMajor && layout.wholeFrames) {
    return [
      buildMedia(withDelay(layout.wholeFrames, delayMs), options, 'webp', {
        mode: 'whole',
        row: 0,
        rows: 1,
        delayMs,
      }),
    ];
  }

  // 否则每行是一段。
  return layout.groups.map((group) =>
    buildMedia(withDelay(group.frames, delayMs), options, 'webp', {
      mode: 'row',
      row: group.row,
      rows: layout.groups.length,
      delayMs,
    }),
  );
}

export async function convertFile(file: File, options: ConvertOptions): Promise<ConvertedMedia[]> {
  if (file.type.startsWith('video/')) {
    throw new UnsupportedFileError('视频暂不支持，请先转成 GIF');
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sourceType = sourceTypeOf(bytes, file);

  if (sourceType === 'webp') {
    const kind = webpKind(bytes);
    if (kind === 'animated') {
      const animation = await decodeAnimatedWebp(bytes).catch((error: unknown) => {
        throw new UnsupportedFileError(error instanceof Error ? error.message : String(error));
      });
      return [buildMedia(animation.frames, options, 'webp')];
    }

    const image = await decodeStill(file);
    let layout: SheetLayout | null;
    try {
      layout = detectSpriteSheet(image);
    } catch (error) {
      if (error instanceof SheetDetectionError) throw new UnsupportedFileError(error.message);
      throw error;
    }
    if (layout) return convertSheet(layout, options);
    return [staticMedia(image, options, 'webp')];
  }

  if (sourceType === 'gif') {
    const gif = decodeGif(bytes);
    if (gif.frames.length === 0) throw new UnsupportedFileError('这个 GIF 里没有帧');
    return [buildMedia(gif.frames, options, 'gif')];
  }

  // 静图：整幅压黑底 → 缩放 → 24 位 BMP，不裁边
  const image = await decodeStill(file);
  return [staticMedia(image, options, sourceType)];
}
