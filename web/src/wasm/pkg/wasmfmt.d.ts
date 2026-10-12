/* tslint:disable */
/* eslint-disable */

/**
 * `anm_decode` 的结果；字段都是取一次算一次的 getter，别在循环里反复拿。
 */
export class AnmDecoded {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly canvas_height: number;
    readonly canvas_width: number;
    /**
     * `false` = 数据只够解出前面几帧
     */
    readonly complete: boolean;
    /**
     * 每帧一个延时
     */
    readonly delays: Uint16Array;
    /**
     * 文件里声明的帧数；数据不全时比 `delays.length` 多
     */
    readonly frame_count: number;
    /**
     * 每帧**合成之后**的整幅画布，按帧顺序平铺
     */
    readonly pixels: Uint16Array;
}

/**
 * 解一份 `.ANM`：数据不全不是错误，交回已解出的完整帧并把 `complete` 置 false。
 * `max_frames` 只解前几帧（列表页首帧图）；不传就解完。
 */
export function anm_decode(bytes: Uint8Array, max_frames?: number | null): AnmDecoded;

/**
 * 整幅画布的帧序列 → `.ANM` 字节。
 *
 * * `delays` —— 每帧一个延时，帧数就是它的长度；
 * * `pixels` —— `delays.len()` 段 `canvas_width * canvas_height` 的 RGB565，按帧顺序平铺。
 */
export function anm_encode_rasters(canvas_width: number, canvas_height: number, delays: Uint16Array, pixels: Uint16Array): Uint8Array;

/**
 * 只读文件头，算第 0 帧最多占多少字节；不是 ANM / 版本不对 / 尺寸不合法时返回 `null`。
 */
export function anm_first_frame_span(header: Uint8Array): number | undefined;

/**
 * 这一段字节里的第 0 帧能不能信（**逐字节对齐**吗）：`false` = 中途丢了/多了字节，
 * 这时 `anm_decode` 仍会画出一帧，但那一帧是错位的（界面上就是"花掉的首帧图"）。
 * 规矩和判据见 `anmfmt::first_frame_trusted`。
 */
export function anm_first_frame_trusted(bytes: Uint8Array): boolean;

/**
 * 整份文件的自检：没问题返回 `null`，否则返回**第一个**问题的原文。
 * 只拿到前缀时该用 `anm_decode`（数据不全在那儿不算错）。
 */
export function anm_validate(bytes: Uint8Array): string | undefined;

/**
 * RGB8 像素（行优先、从上到下）→ 24 位无压缩 `.BMP`。
 */
export function bmp_encode(width: number, height: number, rgb: Uint8Array): Uint8Array;

/**
 * BMP 一行的字节数（宽 × 3 再按 4 字节对齐）
 */
export function bmp_row_size(width: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_anmdecoded_free: (a: number, b: number) => void;
    readonly anm_decode: (a: number, b: number, c: number) => [number, number, number];
    readonly anm_encode_rasters: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly anm_first_frame_span: (a: number, b: number) => number;
    readonly anm_first_frame_trusted: (a: number, b: number) => number;
    readonly anm_validate: (a: number, b: number) => [number, number];
    readonly anmdecoded_canvas_height: (a: number) => number;
    readonly anmdecoded_canvas_width: (a: number) => number;
    readonly anmdecoded_complete: (a: number) => number;
    readonly anmdecoded_delays: (a: number) => [number, number];
    readonly anmdecoded_frame_count: (a: number) => number;
    readonly anmdecoded_pixels: (a: number) => [number, number];
    readonly bmp_encode: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly bmp_row_size: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
