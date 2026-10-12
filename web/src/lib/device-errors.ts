/**
 * 板子的 `ERR <原因>` 分诊：同一个失败在界面上该给什么反馈、要不要自动重试。
 *
 * 这些字符串是固件的稳定契约（见 `crates/fm-core/src/commands.rs` 与 `link.rs`），
 * 改动它们要同步改这里和 `device-errors.test.ts`。
 */
import { DeviceError } from './serial/client';
import { TransportError, TransportTimeout } from './serial/transport';

export type FailureKind =
  /** 卡上没有这个文件（被删了 / 索引过期） */
  | 'missing'
  /** 文件在，但板子认不了（不是 ANM / 头坏了 / 比屏幕大） */
  | 'format'
  /** 板子正忙着（多半是在播动画），先 stop 再重试就行 */
  | 'busy'
  /** 播放清单为空或读不出来 */
  | 'no-playlist'
  /** 串口断了 */
  | 'disconnected'
  /** 板子没回应 */
  | 'timeout'
  /** 有回应但这句没料到 */
  | 'unexpected';

export interface FailureInfo {
  kind: FailureKind;
  /** 原始原因（给用户看的那句话） */
  message: string;
}

const MISSING = ['cannot open file', 'offset past end'];

const FORMAT = [
  'not an ANM file',
  'unsupported ANM version',
  'unsupported ANM flags',
  'bad ANM canvas size',
  'empty ANM animation',
  'bad ANM total length',
  'bad ANM file length',
  'cannot read ANM header',
  'animation larger than screen',
  'canvas too small',
];

const PLAYLIST = ['no playlist', 'cannot read playlist', 'no playable item'];

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function classifyFailure(error: unknown, options: { connected?: boolean } = {}): FailureInfo {
  const message = textOf(error);
  const lower = message.toLowerCase();

  if (error instanceof TransportTimeout) {
    return { kind: 'timeout', message: '设备没有回应，检查串口或重新连接' };
  }
  if (error instanceof TransportError) {
    // 串口读流结束/写失败：多半是线被拔了
    return { kind: 'disconnected', message };
  }
  if (options.connected === false) {
    return { kind: 'disconnected', message };
  }

  if (error instanceof DeviceError || lower.length > 0) {
    if (lower.includes('busy')) {
      return { kind: 'busy', message: '设备正在播放，先停止再试' };
    }
    if (MISSING.some((needle) => lower.includes(needle.toLowerCase()))) {
      return { kind: 'missing', message: '卡上没有这个文件了' };
    }
    if (FORMAT.some((needle) => lower.includes(needle.toLowerCase()))) {
      return { kind: 'format', message: '文件格式设备认不了' };
    }
    if (PLAYLIST.some((needle) => lower.includes(needle.toLowerCase()))) {
      return { kind: 'no-playlist', message: '播放列表是空的，先上传素材' };
    }
  }

  return { kind: 'unexpected', message };
}

/** 界面上给用户看的一句话 */
export function describeFailure(info: FailureInfo): string {
  switch (info.kind) {
    case 'missing':
      return '卡上找不到这个文件了';
    case 'format':
      return '设备认不了这个文件，请重新上传素材';
    case 'busy':
      return '设备正忙着播放，先停止再重试';
    case 'no-playlist':
      return '播放列表是空的，先上传素材';
    case 'disconnected':
      return '串口断开了，插好线后点重新连接';
    case 'timeout':
      return '设备没有回应，检查串口或重新连接';
    default:
      return info.message;
  }
}
