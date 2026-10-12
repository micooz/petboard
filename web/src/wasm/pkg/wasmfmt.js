/* @ts-self-types="./wasmfmt.d.ts" */

/**
 * `anm_decode` 的结果；字段都是取一次算一次的 getter，别在循环里反复拿。
 */
export class AnmDecoded {
    static __wrap(ptr) {
        const obj = Object.create(AnmDecoded.prototype);
        obj.__wbg_ptr = ptr;
        AnmDecodedFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AnmDecodedFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_anmdecoded_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get canvas_height() {
        const ret = wasm.anmdecoded_canvas_height(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get canvas_width() {
        const ret = wasm.anmdecoded_canvas_width(this.__wbg_ptr);
        return ret;
    }
    /**
     * `false` = 数据只够解出前面几帧
     * @returns {boolean}
     */
    get complete() {
        const ret = wasm.anmdecoded_complete(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * 每帧一个延时
     * @returns {Uint16Array}
     */
    get delays() {
        const ret = wasm.anmdecoded_delays(this.__wbg_ptr);
        var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        return v1;
    }
    /**
     * 文件里声明的帧数；数据不全时比 `delays.length` 多
     * @returns {number}
     */
    get frame_count() {
        const ret = wasm.anmdecoded_frame_count(this.__wbg_ptr);
        return ret;
    }
    /**
     * 每帧**合成之后**的整幅画布，按帧顺序平铺
     * @returns {Uint16Array}
     */
    get pixels() {
        const ret = wasm.anmdecoded_pixels(this.__wbg_ptr);
        var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        return v1;
    }
}
if (Symbol.dispose) AnmDecoded.prototype[Symbol.dispose] = AnmDecoded.prototype.free;

/**
 * 解一份 `.ANM`：数据不全不是错误，交回已解出的完整帧并把 `complete` 置 false。
 * `max_frames` 只解前几帧（列表页首帧图）；不传就解完。
 * @param {Uint8Array} bytes
 * @param {number | null} [max_frames]
 * @returns {AnmDecoded}
 */
export function anm_decode(bytes, max_frames) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.anm_decode(ptr0, len0, isLikeNone(max_frames) ? Number.MAX_SAFE_INTEGER : (max_frames) >>> 0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return AnmDecoded.__wrap(ret[0]);
}

/**
 * 整幅画布的帧序列 → `.ANM` 字节。
 *
 * * `delays` —— 每帧一个延时，帧数就是它的长度；
 * * `pixels` —— `delays.len()` 段 `canvas_width * canvas_height` 的 RGB565，按帧顺序平铺。
 * @param {number} canvas_width
 * @param {number} canvas_height
 * @param {Uint16Array} delays
 * @param {Uint16Array} pixels
 * @returns {Uint8Array}
 */
export function anm_encode_rasters(canvas_width, canvas_height, delays, pixels) {
    const ptr0 = passArray16ToWasm0(delays, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray16ToWasm0(pixels, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.anm_encode_rasters(canvas_width, canvas_height, ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * 只读文件头，算第 0 帧最多占多少字节；不是 ANM / 版本不对 / 尺寸不合法时返回 `null`。
 * @param {Uint8Array} header
 * @returns {number | undefined}
 */
export function anm_first_frame_span(header) {
    const ptr0 = passArray8ToWasm0(header, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.anm_first_frame_span(ptr0, len0);
    return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
}

/**
 * 这一段字节里的第 0 帧能不能信（**逐字节对齐**吗）：`false` = 中途丢了/多了字节，
 * 这时 `anm_decode` 仍会画出一帧，但那一帧是错位的（界面上就是"花掉的首帧图"）。
 * 规矩和判据见 `anmfmt::first_frame_trusted`。
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function anm_first_frame_trusted(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.anm_first_frame_trusted(ptr0, len0);
    return ret !== 0;
}

/**
 * 整份文件的自检：没问题返回 `null`，否则返回**第一个**问题的原文。
 * 只拿到前缀时该用 `anm_decode`（数据不全在那儿不算错）。
 * @param {Uint8Array} bytes
 * @returns {string | undefined}
 */
export function anm_validate(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.anm_validate(ptr0, len0);
    let v2;
    if (ret[0] !== 0) {
        v2 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v2;
}

/**
 * RGB8 像素（行优先、从上到下）→ 24 位无压缩 `.BMP`。
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgb
 * @returns {Uint8Array}
 */
export function bmp_encode(width, height, rgb) {
    const ptr0 = passArray8ToWasm0(rgb, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.bmp_encode(width, height, ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * BMP 一行的字节数（宽 × 3 再按 4 字节对齐）
 * @param {number} width
 * @returns {number}
 */
export function bmp_row_size(width) {
    const ret = wasm.bmp_row_size(width);
    return ret >>> 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./wasmfmt_bg.js": import0,
    };
}

const AnmDecodedFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_anmdecoded_free(ptr, 1));

function getArrayU16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray16ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 2, 2) >>> 0;
    getUint16ArrayMemory0().set(arg, ptr / 2);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint16ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('wasmfmt_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
