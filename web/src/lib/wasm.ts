/**
 * 格式实现的 WASM 加载：产物由 `pnpm wasm` 生成在 `src/wasm/pkg/`。
 *
 * 只在启动时 `await initWasm()` 一次，之后导出的函数都是同步的 —— 调用点二十多处，
 * 全改成 async 不现实。没初始化就调用给的是人话，不是 wasm trap。
 */
import initFormat, * as format from '../wasm/pkg/wasmfmt';
import type { InitOutput } from '../wasm/pkg/wasmfmt';

let output: InitOutput | null = null;
let loading: Promise<void> | null = null;

/**
 * `source`：不传就走胶水自己的默认路径（`src/wasm/pkg/` 里那个 `.wasm`，由打包器 emit 成
 * 带部署前缀的静态资源）；传字节则直接用 —— 测试在 node 里跑，从磁盘读，不走 fetch。
 */
export function initWasm(source?: Uint8Array): Promise<void> {
  loading ??= (async () => {
    output = source ? await initFormat({ module_or_path: source }) : await initFormat();
  })();
  return loading;
}

/** 给同步门面用的闸：没加载完就调用是编程错误，说清楚比 wasm trap 好查 */
function requireOutput(): void {
  if (!output) {
    throw new Error('格式 WASM 还没加载完（先 await initWasm()）');
  }
}

/**
 * wasm 的线性内存，只给测试用。
 *
 * 胶水里 owned 返回会再 `.slice()` 一份（`getArrayU16FromWasm0(...).slice()`），
 * 所以门面里不要再自己拷一遍。`tests/lib/wasm.test.ts` 盯着这个性质别在升级时变掉。
 */
export function wasmMemory(): WebAssembly.Memory | null {
  return output?.memory ?? null;
}

export const wasmFormat = {
  get anmEncodeRasters() {
    requireOutput();
    return format.anm_encode_rasters;
  },
  get anmDecode() {
    requireOutput();
    return format.anm_decode;
  },
  get anmFirstFrameSpan() {
    requireOutput();
    return format.anm_first_frame_span;
  },
  get anmFirstFrameTrusted() {
    requireOutput();
    return format.anm_first_frame_trusted;
  },
  get anmValidate() {
    requireOutput();
    return format.anm_validate;
  },
  get bmpEncode() {
    requireOutput();
    return format.bmp_encode;
  },
  get bmpRowSize() {
    requireOutput();
    return format.bmp_row_size;
  },
};
