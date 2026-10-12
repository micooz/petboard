/**
 * 24 位 BMP 的打包：实现在 `crates/bmpfmt`（板子同一份），这里只搬运。
 * 用之前要先 `await initWasm()`。
 */
import { wasmFormat } from '../wasm';

/** 权威定义在 `crates/bmpfmt/src/lib.rs` 的 `HEADER_LEN` */
export const BMP_HEADER_LEN = 54;

/** 一行的字节数：宽 × 3 再补齐到 4 的倍数 */
export function bmpRowSize(width: number): number {
  return wasmFormat.bmpRowSize(width);
}

/** `rgb`：行优先、从上到下的 RGB8，长度必须是 `width * height * 3`。 */
export function encodeBmp(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const expected = width * height * 3;
  if (rgb.length !== expected) {
    throw new Error(`RGB 字节数（${rgb.length}）和宽高（${width}x${height}）对不上`);
  }
  return wasmFormat.bmpEncode(width, height, rgb);
}
