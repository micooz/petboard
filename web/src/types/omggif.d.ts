declare module 'omggif' {
  export interface GifFrameInfo {
    x: number;
    y: number;
    width: number;
    height: number;
    has_local_palette: boolean;
    palette_offset: number;
    palette_size: number;
    data_offset: number;
    data_length: number;
    transparent_index: number | null;
    interlaced: boolean;
    /** 单位是 1/100 秒 */
    delay: number;
    disposal: number;
  }

  export interface GifWriterOptions {
    /** 全局调色板：长度是 2 的幂（2..256），每项 3 个 0..255 的分量 */
    palette?: number[] | Uint8Array;
    /** 循环次数；不传 = 不带 NETSCAPE 循环块 */
    loop?: number;
  }

  export interface GifFrameOptions {
    /** 局部调色板；不传就用全局的 */
    palette?: number[] | Uint8Array;
    /** 单位 1/100 秒 */
    delay?: number;
    /** 0/1/2/3，见 GIF89a 规范 */
    disposal?: number;
    /** 透明色索引 */
    transparent?: number | null;
  }

  /** 只在测试里用来造样本 GIF */
  export class GifWriter {
    constructor(buffer: Uint8Array, width: number, height: number, options?: GifWriterOptions);
    addFrame(
      x: number,
      y: number,
      width: number,
      height: number,
      indexedPixels: Uint8Array | number[],
      options?: GifFrameOptions,
    ): void;
    /** 收尾并返回写进去的字节数 */
    end(): number;
  }

  export class GifReader {
    constructor(buffer: Uint8Array);
    /** 注意：omggif 把这两项做成**属性**，不是方法 */
    readonly width: number;
    readonly height: number;
    numFrames(): number;
    loopCount(): number;
    frameInfo(frame: number): GifFrameInfo;
    /**
     * 把这一帧的像素 blit 到 `pixels`（整幅画布 RGBA）。
     *
     * ⚠️ 它**不处理 disposal**：透明像素会跳过、非透明像素直接覆盖，
     * 上一帧残留不会自动清掉。合成得自己来（见 `encode/gif.ts`）。
     */
    decodeAndBlitFrameRGBA(frame: number, pixels: Uint8ClampedArray<ArrayBuffer>): void;
  }
}
