/**
 * 给上传区的小图预览用：把用户选的文件解成一张小图（data URL）。
 *
 * GIF 走我们自己的合成器（取第一帧），PNG/JPEG/WebP 等静图走浏览器解码 ——
 * 和真正转换用的是同一套解码路径，所以预览和最终成品一致。
 */
import { decodeGif } from './encode/gif';

const THUMB_MAX = 160;

export async function makeThumbnail(file: File, max = THUMB_MAX): Promise<string | null> {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let width = 0;
    let height = 0;
    let source: CanvasImageSource | null = null;
    let bitmap: ImageBitmap | null = null;
    let frameData: ImageData | null = null;

    const isGif =
      bytes.length > 6 &&
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46; // "GIF"

    if (isGif) {
      const decoded = decodeGif(bytes);
      const first = decoded.frames[0];
      if (!first) return null;
      width = decoded.width;
      height = decoded.height;
      frameData = new ImageData(new Uint8ClampedArray(first.image.data), width, height);
    } else {
      bitmap = await createImageBitmap(file);
      width = bitmap.width;
      height = bitmap.height;
      source = bitmap;
    }

    const scale = Math.min(1, max / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    if (frameData) {
      // 注意：`putImageData` 既不缩放、也不吃 canvas 的变换。整帧是 width×height，
      // 直接 putImageData 到缩小后的画布上只会保留左上角那一块（看起来就是"没居中、
      // 右下被切掉"）。所以先按原尺寸落到一张等大画布上，再用 drawImage 缩下来。
      const full = document.createElement('canvas');
      full.width = width;
      full.height = height;
      const fullContext = full.getContext('2d');
      if (!fullContext) return null;
      fullContext.putImageData(frameData, 0, 0);
      context.drawImage(full, 0, 0, canvas.width, canvas.height);
    } else if (source) {
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
    }
    bitmap?.close();
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
