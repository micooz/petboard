/**
 * 卡片上的首帧图和悬停预览要读的那一段字节。
 *
 * 首帧图优先用本机已经存好的，其次用本机缓存里的整份产物，最后才从板子上读
 * **够画第 0 帧的那一段**。
 *
 * 这里最要紧的第一条：**不能固定读一小段**。
 *
 * - `.ANM` 的第 0 帧是"整幅画面的非黑像素"，最坏情况（画布全是非黑像素）要
 *   `18 + 12 + ceil(宽/8)*高 + 2*宽*高` 字节 —— 312x164 的画布差不多 106 KiB。
 *   按固定长度切下去，只要切在帧中间，`decodeAnm` 就**一个完整帧都解不出来**，
 *   卡片上只剩一块黑（`cover` 布局的第 0 帧实测 74 KiB，一定会被切坏）。
 * - `.BMP` 交给浏览器解码，半张图直接解不开，只能整份读回来。
 *
 * 所以顺序是：先读文件头（`.ANM` 18 字节 / `.BMP` 54 字节）算出真正需要多少，再补读剩下的。
 *
 * 第二条同样要紧，而且更阴：**解得出来不等于解对了**。串口丢一个（或重一个）字节，
 * 整段从那儿开始错位，`decodeAnm` 照样"解出一帧"——只是那一帧按错的行宽和错的调色板
 * 重画，卡片上就是**花掉**的首帧图，而 `complete` 仍是 `true`、一个错都不报。板子播的是
 * 卡上那份完整文件，所以只有网页会花。画之前必须验一遍帧边界（`posterBytesTrusted`）。
 */
import type { ClampedBytes } from './bytes';
import {
  ANM_FRAME_HEADER_LEN,
  ANM_HEADER_LEN,
  anmFirstFrameSpan,
  anmFirstFrameTrusted,
} from './encode/anm';
import { BMP_HEADER_LEN } from './encode/bmp';
import { extOf } from './index-file';
import { previewByName } from './preview';

/** 读到的文件前缀：`complete=false` 表示有段没读上，`bytes` 只是"能读到的那部分" */
export interface FilePrefix {
  bytes: Uint8Array;
  complete: boolean;
}

/** 读文件的一段（`DeviceClient.getPartial` 的薄包装），抽出来是为了能在测试里塞假的 */
export type PrefixRead = (offset: number, length: number) => Promise<FilePrefix>;

/** 字节读到了、但解不出第一帧：这种才算"这个文件坏了"，其它失败都当暂时性的 */
export class PosterDecodeError extends Error {}

export interface PosterImage {
  width: number;
  height: number;
  rgba: ClampedBytes;
}

/** `loadPosterImage` 需要的外部能力：都能在测试里换成假的 */
export interface PosterSource {
  /** 本机存过的首帧图（独立于"转换产物缓存"，清空缓存不会清掉它） */
  stored(): Promise<PosterImage | null>;
  /** 本机缓存里的整份转换产物；没有就是 null */
  cached(): Promise<Uint8Array | null>;
  /** 从板子上读一段文件（允许只读到一部分，见 `FilePrefix`） */
  read(offset: number, length: number): Promise<FilePrefix>;
  /** 丢掉本机那份**不可信**的转换产物（错位读回来的），好让下次重新读卡 */
  dropCached(): Promise<void>;
  /** 把刚画好的首帧图存起来，下次不用再读板子 */
  store(poster: PosterImage): Promise<void>;
}

/** 文件头认不出来时的兜底前缀：至少能画出小文件 */
const PREFIX_FALLBACK_BYTES = 64 * 1024;

/** 首帧图最多读几遍：第一遍错位（残字节顶在开头）时再读一遍，见 `loadPosterImage` */
const POSTER_READ_ATTEMPTS = 2;

/**
 * 画首帧图至少要读多少字节（按 `size` 封顶）；`.BMP` 需要整份。
 *
 * `.ANM` 在"第 0 帧的上界"之外再多要**一个帧头**（12 字节）：那是完整性检查唯一的
 * 边界证据 —— 只有第 1 帧的帧头正好落在第 0 帧末尾，才说明前面这些字节没错位。
 * 上界有可能刚好等于第 0 帧的真实长度（画布全是非黑像素），少这 12 字节就没法验。
 */
export function posterPrefixLength(name: string, size: number, header: Uint8Array): number {
  if (extOf(name) !== 'ANM') return size;
  const span = anmFirstFrameSpan(header);
  if (span === null) return Math.min(size, PREFIX_FALLBACK_BYTES);
  return Math.min(size, span + ANM_FRAME_HEADER_LEN);
}

/**
 * 这一段字节能不能画出**可信**的第 0 帧。
 *
 * `.BMP` 交给浏览器解码，半份直接解不开（会抛），所以不需要再验；`.ANM` 必须验，
 * 否则错位的字节会被"成功地解成一帧"，画出来是花的（理由见文件头）。
 */
export function posterBytesTrusted(name: string, bytes: Uint8Array): boolean {
  if (extOf(name) !== 'ANM') return true;
  return anmFirstFrameTrusted(bytes);
}

/**
 * 读文件开头**够用**的那一段：先读文件头（`.ANM` 18 字节 / `.BMP` 54 字节）算出要多少，再补读。
 *
 * - `.ANM`：至少覆盖第 0 帧（`posterPrefixLength` 的上界），`wantedBytes` 再往上多要几帧；
 * - `.BMP`：浏览器解码要整份，`posterPrefixLength` 直接给 `size`。
 *
 * 分两次读不是为了省流量，是为了**只读该读的**：读少了会把第 0 帧切在中间，
 * `decodeAnm` 连一个完整帧都解不出来。
 */
export async function readFilePrefix(
  read: PrefixRead,
  name: string,
  size: number,
  wantedBytes = 0,
): Promise<FilePrefix | null> {
  if (size <= 0) return null;
  const headerLen = Math.min(size, extOf(name) === 'ANM' ? ANM_HEADER_LEN : BMP_HEADER_LEN);
  const header = await read(0, headerLen);
  // 文件头都没读全就到此为止：没有头就算不出"第 0 帧要多少字节"（`posterPrefixLength`
  // 只会退回一个兜底长度），这时候补读的那一段**读回来也没用**，白白多等一个超时。
  if (!header.complete) return header;
  const need = Math.min(
    size,
    Math.max(headerLen, posterPrefixLength(name, size, header.bytes), wantedBytes),
  );
  if (need <= headerLen) return header;
  const rest = await read(headerLen, need - headerLen);
  const bytes = new Uint8Array(header.bytes.length + rest.bytes.length);
  bytes.set(header.bytes, 0);
  bytes.set(rest.bytes, header.bytes.length);
  return { bytes, complete: header.complete && rest.complete };
}

/** 画一张首帧图；连本机缓存都没有时才读板子 */
export async function loadPosterImage(
  source: PosterSource,
  name: string,
  size: number,
): Promise<PosterImage | null> {
  const stored = await source.stored();
  if (stored) return stored;

  const cached = await source.cached();
  if (cached) {
    // 缓存里那份也可能是**错位**的（当年整份读回来时串口丢了字节，长度碰巧对上）：
    // 不能直接画，也不能就此判文件坏了 —— 丢掉缓存，回到"从板子上重新读"这条路。
    if (posterBytesTrusted(name, cached)) return decodePoster(source, name, cached);
    await source.dropCached();
  }

  // 错位是这条链路的常态（上一次传输的残字节会顶到下一次开头），而它**只读得出花的图、
  // 不报错**，所以这里重读一次：`DeviceClient` 在两次传输之间会把管道清干净，第二次一般就正了。
  for (let attempt = 0; attempt < POSTER_READ_ATTEMPTS; attempt += 1) {
    // 前缀没读全就先不画（半份字节解不出完整帧），但**不算坏文件** —— 下次刷新还会再试
    const prefix = await readFilePrefix((offset, length) => source.read(offset, length), name, size);
    if (!prefix?.complete) return null;
    // 读全了但帧边界对不上 = 这段字节错位了（串口丢/重了字节）。同样**不算坏文件**：
    // 卡上那份是好的，重读一次，还不行就这次不画。
    if (posterBytesTrusted(name, prefix.bytes)) return decodePoster(source, name, prefix.bytes);
  }
  return null;
}

/** 解第 0 帧并存起来；解不出来就是"这个文件坏了"（调用方据此记进黑名单） */
async function decodePoster(source: PosterSource, name: string, bytes: Uint8Array): Promise<PosterImage> {
  let preview;
  try {
    preview = await previewByName(name, bytes, 1);
  } catch (error) {
    throw new PosterDecodeError(error instanceof Error ? error.message : String(error));
  }
  const frame = preview.frames[0];
  if (!frame) throw new PosterDecodeError('解不出第一帧');

  const poster: PosterImage = { width: preview.width, height: preview.height, rgba: frame.rgba };
  await source.store(poster);
  return poster;
}
