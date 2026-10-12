/**
 * `.ANM` 的打包与解析：实现在 Rust（`crates/anmfmt`，板子用的同一份），
 * 这里只做 JS 形状 ↔ 平铺数组的搬运，错误也不翻译、原样抛出。
 * 格式规范见 `docs/anm-format.md`；用之前要先 `await initWasm()`（见 `app/page.tsx`）。
 */
import { wasmFormat } from '../wasm';

// 下面四个常量的权威定义在 `crates/anmfmt/src/lib.rs`
export const ANM_VERSION = 1;
export const ANM_HEADER_LEN = 18;
export const ANM_FRAME_HEADER_LEN = 12;
/** 单个文件的上限 */
export const ANM_MAX_BYTES = 32 * 1024 * 1024;

export interface AnmRasterFrame {
  delayMs: number;
  /** 整幅画布的 RGB565，行优先 */
  pixels: Uint16Array;
}

export interface AnmOptions {
  width: number;
  height: number;
}

export interface AnmImage {
  width: number;
  height: number;
  frameCount: number;
  /**
   * **合成之后**的整幅画面（不是文件里的变化像素）。
   *
   * 每帧只存"相对上一帧变了的地方"，所以要看第 k 帧就得把前 k 帧叠上去；
   * 板子的播放循环也是这么做的（而且每轮开头会清画布）。
   */
  frames: { delayMs: number; pixels: Uint16Array }[];
  /** 数据不够解完所有帧时为 false（网页只取了文件头那一段时就是这样） */
  complete: boolean;
}

/** 把帧序列摊平成两个平铺数组（跨 wasm 边界就一次拷贝） */
function flatten(options: AnmOptions, frames: AnmRasterFrame[]): { delays: Uint16Array; pixels: Uint16Array } {
  const perFrame = options.width * options.height;
  const delays = new Uint16Array(frames.length);
  const pixels = new Uint16Array(frames.length * perFrame);
  frames.forEach((frame, index) => {
    // 这一条必须在这儿查：平铺数组是按 n×画布建的，短一帧会被静默补 0
    if (frame.pixels.length !== perFrame) {
      throw new Error(
        `第 ${index} 帧有 ${frame.pixels.length} 个像素，画布是 ${options.width}x${options.height}`,
      );
    }
    delays[index] = frame.delayMs;
    pixels.set(frame.pixels, index * perFrame);
  });
  return { delays, pixels };
}

export function encodeAnm(options: AnmOptions, frames: AnmRasterFrame[]): Uint8Array {
  const { delays, pixels } = flatten(options, frames);
  return wasmFormat.anmEncodeRasters(options.width, options.height, delays, pixels);
}

/**
 * 解一份 `.ANM`。`maxFrames` 用来只解前几帧（列表页的首帧图就是这么来的）。
 *
 * 数据不够时不报错，而是把已经解出来的帧返回、`complete` 置 false ——
 * 网页对文件做范围读时只拿得到前半段。
 */
export function decodeAnm(bytes: Uint8Array, options: { maxFrames?: number } = {}): AnmImage {
  const decoded = wasmFormat.anmDecode(bytes, options.maxFrames ?? null);
  const perFrame = decoded.canvas_width * decoded.canvas_height;
  const delays = decoded.delays;
  const all = decoded.pixels;
  const frames = new Array<{ delayMs: number; pixels: Uint16Array }>(delays.length);
  for (let index = 0; index < delays.length; index += 1) {
    frames[index] = {
      delayMs: delays[index],
      pixels: all.subarray(index * perFrame, (index + 1) * perFrame),
    };
  }
  return {
    width: decoded.canvas_width,
    height: decoded.canvas_height,
    frameCount: decoded.frame_count,
    frames,
    complete: decoded.complete,
  };
}

/** 第 0 帧最多占多少字节（算法见 `anmfmt::first_frame_span`）；不是 ANM 时返回 null。
 *
 * 网页按范围读预览靠它定前缀长度：少读了会把第 0 帧切在中间，一帧都解不出来。
 */
export function anmFirstFrameSpan(header: Uint8Array): number | null {
  return wasmFormat.anmFirstFrameSpan(header) ?? null;
}

/**
 * 这一段字节里的**第 0 帧能不能信**：`false` = 中途丢了/多了字节，整段从某一点起整体错位。
 *
 * 为什么非要它：`decodeAnm` 只看"数据够不够解出一帧"，**看不出解错了**。位图里少一个字节，
 * popcount 跟着变、颜色个数跟着变，于是整幅画面按错的行宽和错的调色板重画出来 ——
 * 一帧"花掉"的首帧图，而且 `complete` 还是 `true`，一个错都不报（实测丢 1 字节 →
 * 26,080 个像素不对）。设备播的是卡上那份完整文件，所以只有网页会花。
 *
 * 判据（帧边界，不是像素内容）见 `anmfmt::first_frame_trusted`：第 0 帧自己的帧头要合法、
 * 前缀要真覆盖到它声明的末尾，而且**第 1 帧的帧头也要落在它该在的位置**。
 */
export function anmFirstFrameTrusted(bytes: Uint8Array): boolean {
  return wasmFormat.anmFirstFrameTrusted(bytes);
}

/** 结构自检：返回所有问题（空数组 = 合法）。规则和 `anmfmt::validate` 一条不差。 */
export function validateAnm(bytes: Uint8Array): string[] {
  const problem = wasmFormat.anmValidate(bytes);
  return problem ? [problem] : [];
}

/** `.ANM` 文件头里的尺寸与帧数 */
export interface AnmHeaderInfo {
  width: number;
  height: number;
  frames: number;
}

/**
 * 只从文件头取尺寸/帧数，一帧像素都不合成。
 *
 * 给"索引里只剩空壳"的条目补元数据用（见 `useDevice` 里的 recoverFromCard）：
 * 解析仍然走 `crates/anmfmt` 那一份实现，这里不自己数字节。
 * `maxFrames: 0` 让解码器读完头就停；不是 ANM / 版本不对时返回 null。
 */
export function anmHeaderInfo(bytes: Uint8Array): AnmHeaderInfo | null {
  try {
    const decoded = decodeAnm(bytes, { maxFrames: 0 });
    return { width: decoded.width, height: decoded.height, frames: decoded.frameCount };
  } catch {
    return null;
  }
}
