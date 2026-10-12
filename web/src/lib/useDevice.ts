'use client';

/**
 * 应用的全部状态与动作：连接、素材列表、上传、播放、断连。
 *
 * 串口那侧的并发由 `DeviceClient` 的单条队列保证，这里只管"什么时候该干什么"。
 * 几个关键约定：
 *
 * - **播放是后台的**：`media/play` 回完 `OK` 就返回，设备自己在播；
 *   状态由设备主动推的 `ev …` 驱动，只有收不到事件的旧固件才降级轮询 `device/info`（每 1.5 秒一次）。
 * - **播放期间不能读卡**（板子只认 stop/play/info），所以这时素材库用本地快照渲染。
 * - **任何改卡操作前先 `media/stop`**（幂等），避免撞上 `ERR busy`。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { MediaCache } from './cache';
import { convertFile, type ConvertOptions, type ConvertedMedia } from './convert';
import { DeviceLog, type LogSink } from './device-log';
import { classifyFailure, describeFailure } from './device-errors';
import { ANM_HEADER_LEN, ANM_MAX_BYTES, anmHeaderInfo } from './encode/anm';
import type { Fit } from './encode/image';
import { bytesLabel } from './format';
import { contentId } from './hash';
import {
  emptyIndex,
  entryFileName,
  extOf,
  hasGeometry,
  INDEX_NAME,
  needsMetadataRecovery,
  parseIndex,
  reconcile,
  recoverIndexMetadata,
  serializeIndex,
  type IndexEntry,
  type MediaIndex,
  type SheetSource,
} from './index-file';
import { DEFAULT_LOOPS, normalizeLoops } from './loops';
import { isLastGoodPort, markLastGoodPort } from './last-good-port';
import { buildPlaylist, PLAYLIST_NAME } from './playlist';
import { forgetPort, requestPortPreferringDevice } from './port-selection';
import { loadPosterImage, PosterDecodeError, posterBytesTrusted, readFilePrefix } from './poster';
import { previewByName, type Preview } from './preview';
import {
  DeviceClient,
  DeviceError,
  HandshakeError,
  type DeviceInfo,
  type PlaybackEvent,
} from './serial/client';
import { API_VERSION, EVENTS } from './serial/wire';
import { Transport } from './serial/transport';
import {
  clearUploadInFlight,
  isStaleUploadError,
  peekUploadInFlight,
  UPLOAD_RECOVERY_WAIT_MS,
  withUploadRecovery,
} from './upload-recovery';
/**
 * 悬停预览想读多少字节。
 *
 * 32 字节一块之后回传能到 ~60KB/s，所以这里够读完一个普通的几帧/十几帧动画（≤1 MiB）——
 * 整份读完，预览就是**完整**动画（不会出现"前几帧循环"）。再大的文件才退化成读前缀。
 */
const PREVIEW_PREFIX_BYTES = 1024 * 1024;
/**
 * 后台读（首帧图、预览前缀）每段"等第一个字节"的上限。
 *
 * 健康时一段只要几十毫秒，但换新卡/冷启动时第一段可能要几秒（固件在那边读卡），
 * 给 8 秒：偶发慢不该被误判成"读崩"，慢到这一步基本就是真出问题了。
 */
const BACKGROUND_READ_TIMEOUT_MS = 8_000;
/** 屏幕四周各留 4px（和固件的 `screen::PAD` 一致），所以画布 = 屏幕 - 8 */
const SCREEN_PADDING = 4;
/** 播放中轮询 `device/info` 的间隔（毫秒）；卡片进度条的过渡时长也用它 */
export const PLAYBACK_POLL_MS = 1500;

/**
 * 网页切到后台多久之后才松开串口。
 *
 * 切标签页本来就是常事，而每次"松开 + 切回来重连"都等于给板子来一次
 * "开端口 → 收发 → 关端口"。实测这条来回约 9 次就能让 C6 的 USB-Serial-JTAG
 * 数据通道卡死（其余只有拔插能恢复，见 `last-good-port.ts`）。所以短暂切走不动它，
 * 只有真的离开一阵子才把口让出来（给 espflash monitor 之类的程序用）。
 */
const BACKGROUND_RELEASE_MS = 90_000;

/**
 * "刚才还通、现在一条回执都没有"时给用户看的话。
 *
 * 这根线是实测出来的：C6 的 USB-Serial-JTAG 数据通道会卡死 —— 芯片照常跑、屏幕照常亮、
 * 设备也还挂在 USB 上，但两个方向全哑，**只有拔插 USB 能恢复**（见 `last-good-port.ts`）。
 * 这种情况下去重新挑端口是白费功夫；端口授权我们特意留着，所以插回来通常会自动重连。
 */
const MUTE_HINT =
  '设备完全没有回执。这条串口刚才还是好的，多半是板子的 USB 串口卡死了：拔掉 USB 线、等 2 秒再插回，插回来后会自动重连（没自动连上就再点一次「选择串口」）。';

export type Connection = 'unsupported' | 'disconnected' | 'connecting' | 'connected';

/** 列表来自本机快照、而且**读卡失败**（需要提示 + "重试读卡"）时才非 null */
type SnapshotReason = 'read-error' | null;

export interface MediaItem {
  name: string;
  size: number;
  /** 排序/缓存版本号：优先用索引里的上传时间 */
  createdAt: number;
  meta: IndexEntry | null;
  poster: ImageData | null;
  skip: boolean;
  /** 本机有没有原图：有才能改参数、才能在播放失败时自动重传 */
  hasSource: boolean;
}

interface PlaybackStatus {
  playing: boolean;
  item: string | null;
  index: number;
  total: number;
  loop: number;
  /** 当前条目播到第几帧 / 共几帧（卡片上的进度条用；固件没报时是 0/0） */
  frame: number;
  frames: number;
}

interface ProgressState {
  label: string;
  sent: number;
  total: number;
}

const IDLE_PLAYBACK: PlaybackStatus = { playing: false, item: null, index: 0, total: 0, loop: 0, frame: 0, frames: 0 };

/** "改参数后重新上传"那条进度的 label —— 设置对话框按它认领自己这次的进度 */
export const REUPLOAD_PROGRESS_LABEL = '重新上传';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 握手重试：
 * - 设备刚复位/刚插上时，第一次 `device/info` 可能静默超时；重试几次再判定连不上。
 * - 如果设备刚从一个被打断的 `media/add` 里恢复，会回 `timeout waiting for data`，
 *   等它的接收超时过去再试。
 * 真正“回了别的东西”的端口仍然立刻失败，不在那里白等。
 */
async function probeWithRecovery(client: DeviceClient): Promise<DeviceInfo> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.probe();
    } catch (error) {
      last = error;
      if (error instanceof HandshakeError && error.kind === 'silent') {
        await wait(500 * (attempt + 1));
        continue;
      }
      if (isStaleUploadError(error)) {
        await wait(UPLOAD_RECOVERY_WAIT_MS);
        continue;
      }
      // 上一页在 media/get 失败/刷新时可能留下一条旧的 `ERR transfer failed`；
      // 新页面的第一条 device/info 先读到它，会被误判成“设备不接受 device/info”。
      // 等旧字节被读走后再试一次。
      if (error instanceof DeviceError && error.message.includes('transfer failed')) {
        await wait(200);
        continue;
      }
      throw error;
    }
  }
  throw last;
}

/**
 * 从转换产物拼一条索引条目。
 *
 * `media` 里那几项（宽高 / 帧数 / 时长 / 字节数 / 来源类型）两处调用完全一样，
 * 只有循环、布局、来源文件名这些得由调用方给 —— 写两遍迟早会漏字段。
 */
function indexEntryOf(
  media: ConvertedMedia,
  fields: {
    id: string;
    loops: number;
    sheet?: SheetSource;
    sourceName: string;
    fit: Fit;
    skip: boolean;
    createdAt: number;
  },
): IndexEntry {
  return {
    ...fields,
    ext: media.ext,
    kind: media.kind,
    width: media.width,
    height: media.height,
    frames: media.frames,
    durationMs: media.durationMs,
    bytes: media.payload.length,
    sourceType: media.sourceType,
  };
}

/** 同一张精灵图拆出的行段：内容相同时用行号当盐，避免被内容寻址合并。 */
function sheetSalt(sheet?: SheetSource): string {
  return sheet?.mode === 'row' ? `row:${sheet.row}` : '';
}

export function useDevice() {
  const [connection, setConnection] = useState<Connection>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [playback, setPlayback] = useState<PlaybackStatus>(IDLE_PLAYBACK);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [cacheStats, setCacheStats] = useState<{ count: number; bytes: number } | null>(null);
  /** 设备通信日志（IndexedDB）；打不开时是 null，界面显示"不可用" */
  const [logs, setLogs] = useState<DeviceLog | null>(null);
  const [logStats, setLogStats] = useState({ days: 0, bytes: 0, count: 0 });
  const [snapshotReason, setSnapshotReason] = useState<SnapshotReason>(null);
  /** 正在从设备（或本地快照）拉文件列表 —— 列表为空时用它显示骨架屏 */
  const [listLoading, setListLoading] = useState(false);

  const transportRef = useRef<Transport | null>(null);
  const portRef = useRef<SerialPort | null>(null);
  const clientRef = useRef<DeviceClient | null>(null);
  const cacheRef = useRef<MediaCache | null>(null);
  /** IndexedDB 打开是个异步过程；连接流程可能比它更快，别想当然 */
  const cacheReadyRef = useRef<Promise<void> | null>(null);
  const indexRef = useRef<MediaIndex>(emptyIndex());
  const postersRef = useRef<Map<string, ImageData>>(new Map());
  /** 读不出来的文件：本次会话里只尝试一次，之后跳到下一张，别让坏文件拖死列表。 */
  const posterFailuresRef = useRef<Set<string>>(new Set());
  /**
   * 这一轮补首帧图时串口**没把数据读全**（多半是设备没响应，而不是这个文件坏了）。
   *
   * 判据是"读回来的字节不完整"：一张张磨下去，板子不吭声时列表会黑着等好几分钟，
   * 而且这些读还排在唯一的命令队列上，用户点什么都要干等。所以一发现就收手并说清楚。
   */
  const posterReadStalledRef = useRef(false);
  const sourcesRef = useRef<Set<string>>(new Set());
  const itemsRef = useRef<MediaItem[]>([]);
  const logRef = useRef<DeviceLog | null>(null);
  /**
   * 给 `Transport` 用的代理 sink：日志实例是异步打开的（IndexedDB），
   * 但串口可能先连上 —— 代理每次都取当前的实例，不会丢掉开头那几条。
   */
  const logSinkRef = useRef<LogSink>({
    line: (dir, text) => logRef.current?.line(dir, text),
    frame: (raw) => logRef.current?.frame(raw),
    bulk: (dir, bytes, label) => logRef.current?.bulk(dir, bytes, label),
    note: (text) => logRef.current?.note(text),
    error: (text) => logRef.current?.error(text),
  });
  const infoRef = useRef<DeviceInfo | null>(null);
  const playbackRef = useRef<PlaybackStatus>(IDLE_PLAYBACK);
  /**
   * 播放事件的处理函数放在 ref 里：订阅发生在"连接"那一刻，而处理逻辑要用的
   * `refresh` 等回调是后面才建好的 —— 用 ref 转一手，避免依赖顺序打结。
   */
  const eventHandlerRef = useRef<(event: PlaybackEvent) => void>(() => {});
  /** 这条链路上有没有收到过设备事件（决定要不要降级回轮询） */
  const eventsSeenRef = useRef(false);
  /** 取消订阅（断开时调） */
  const eventOffRef = useRef<(() => void) | null>(null);
  const userClosedRef = useRef(false);
  const connectionRef = useRef<Connection>('disconnected');
  const reconnectRef = useRef<(() => Promise<boolean>) | null>(null);
  /** 是不是"因为切到后台才松开的串口"——决定回前台要不要自动重连 */
  const pausedRef = useRef(false);
  itemsRef.current = items;
  connectionRef.current = connection;

  /**
   * `infoRef` / `playbackRef` 不能只靠 render 里那行赋值：连接流程是
   * `setInfo()` 之后紧接着就 `await refresh()` / `await loadSnapshot()`，
   * 而 setState 要等下一次 render 才生效 —— 中间读 ref 就会拿到旧值
   * （`deviceId()` 因此会返回上一个设备甚至 `unknown`，快照直接查不到）。
   */
  const applyInfo = useCallback((next: DeviceInfo | null) => {
    infoRef.current = next;
    setInfo(next);
  }, []);

  const applyPlayback = useCallback((next: PlaybackStatus) => {
    playbackRef.current = next;
    setPlayback(next);
  }, []);

  /** 画布尺寸由屏幕尺寸推断：四周各留 4px（对应 320x172 → 312x164） */
  const canvasSize = info
    ? {
        width: Math.max(1, info.screen.width - SCREEN_PADDING * 2),
        height: Math.max(1, info.screen.height - SCREEN_PADDING * 2),
      }
    : { width: 312, height: 164 };

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!navigator.serial) {
      setConnection('unsupported');
      return;
    }
    cacheReadyRef.current = MediaCache.open().then((cache) => {
      cacheRef.current = cache;
      void cache?.stats().then(setCacheStats);
    });
    void DeviceLog.open().then((log) => {
      logRef.current = log;
      setLogs(log);
    });
    const onPageHide = () => {
      // 刷新/关页时尽量把端口主动释放掉；固件那边最多等自己的 RX_TIMEOUT 后回到命令行。
      userClosedRef.current = true;
      void transportRef.current?.close();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      userClosedRef.current = true;
      void transportRef.current?.close();
    };
  }, []);

  // 日志库里的"每天清单"变了（新的一天、清理过）就把设置页那行统计刷一下
  useEffect(() => {
    if (!logs) return;
    const update = () => setLogStats(logs.stats());
    update();
    return logs.subscribe((event) => {
      if (event.type === 'days') update();
    });
  }, [logs]);

  /**
   * 等 IndexedDB 就绪。**别省这一步**：连接发生在挂载后的几十毫秒内，而
   * `MediaCache.open()` 还没回来时 `cacheRef.current` 是 null，那一轮 refresh 的
   * `putSnapshot` 会被 `?.` 悄悄跳过 —— 结果就是"播放中刷新页面看不到列表"，
   * 因为唯一的兜底快照压根没写进去。
   */
  const cacheReady = useCallback(async (): Promise<void> => {
    await cacheReadyRef.current;
  }, []);

  const client = useCallback((): DeviceClient => {
    const value = clientRef.current;
    if (!value) throw new Error('还没连上设备');
    return value;
  }, []);

  const deviceId = useCallback((): string => infoRef.current?.id ?? 'unknown', []);

  // ------------------------------------------------------------------ 连接

  const connect = useCallback(
    async (port: SerialPort): Promise<void> => {
      setConnection('connecting');
      setError(null);
      setNotice(null);
      // 只有走到"握手成功、拿到设备信息"才算真的连上 —— 连接失败时要把浏览器
      // 对这个端口的授权抹掉，别让一个连不上的口留在"记忆"里。
      let established = false;
      // 上次是在上传途中刷新的：这次连接的失败不能按"选错端口"处理。
      const recoveringUpload = peekUploadInFlight();
      try {
        userClosedRef.current = false;
        await transportRef.current?.close();

        // 上次页面是在上传途中被刷掉的：固件还可能在把剩下的字节当文件收。
        // 先等它到接收超时，再打开/握手；这样旧页面的端口也有时间释放。
        if (recoveringUpload) {
          logRef.current?.note('检测到上次刷新发生在上传中，等待设备恢复后再握手');
          await wait(UPLOAD_RECOVERY_WAIT_MS);
        }

        const transport = new Transport(port, 115200, logSinkRef.current);
        try {
          await transport.open();
        } catch (error) {
          // 打不开端口最常见的理由是"被别的程序占着"（espflash monitor 之类）。
          // 因为失败后我们会把这个端口的授权忘掉，所以提示里要说清"再选一次"。
          throw new Error(
            `打不开这个串口：${describeError(error)}。常见原因是别的网页/程序正占着它，关掉之后再试试。`,
          );
        }
        // 设备被拔掉/串口没了：只把状态切成"未连接"，由连接页的横幅说明情况；
        // 不弹底层原因（`The device has been lost.` 这类英文）的提示。
        transport.onClose = () => {
          if (userClosedRef.current) return;
          eventOffRef.current?.();
          eventOffRef.current = null;
          clientRef.current = null;
          setConnection('disconnected');
          applyPlayback(IDLE_PLAYBACK);
        };
        transportRef.current = transport;
        portRef.current = port;
        const deviceClient = new DeviceClient(transport);
        clientRef.current = deviceClient;
        // 设备主动推的播放事件：进度与状态由它驱动，不再每 1.5 秒问一次
        eventsSeenRef.current = false;
        eventOffRef.current?.();
        eventOffRef.current = deviceClient.onEvent((event) => eventHandlerRef.current(event));

        const nextInfo = await probeWithRecovery(deviceClient);
        // 握手成功：上传恢复标记可以清掉了。
        clearUploadInFlight();

        // 具体版本号不写进提示：用户能做的只有"重烧固件"，写数字只会增加噪音
        if (nextInfo.api !== API_VERSION) {
          throw new Error('检测到旧固件，请重新烧录（控制面板与固件的协议版本不一致）。');
        }
        applyInfo(nextInfo);
        setConnection('connected');
        established = true;
        // 记住"这条口刚才还通"：它以后突然一句话都不回时，才能说清是"卡死"而不是"选错端口"
        markLastGoodPort(port);
        logRef.current?.startSession({
          id: nextInfo.id,
          api: nextInfo.api,
          screen: nextInfo.screen,
          reset: nextInfo.reset,
          sd: nextInfo.sd,
          href: typeof location === 'undefined' ? '' : location.href,
        });
        postersRef.current.clear();
        posterFailuresRef.current.clear();
        sourcesRef.current = new Set();

        // 后面这两条路都要碰 IndexedDB（读快照 / 写快照），先等它开好
        await cacheReady();

        if (nextInfo.playing) {
          // 设备正在播：这时读不了卡，用本地快照渲染，并开始轮询状态
          applyPlayback({
            playing: true,
            item: nextInfo.item,
            index: nextInfo.index,
            total: nextInfo.total,
            loop: nextInfo.loop,
            frame: nextInfo.frame,
            frames: nextInfo.frames,
          });
          await loadSnapshot(null);
        } else {
          applyPlayback(IDLE_PLAYBACK);
          // 先把本机快照放到界面上（如果有），再去读卡。坏卡/间歇性掉线时，
          // 页面不会先空白或一直挂着骨架屏。
          await loadSnapshot(null);
          await refresh();
        }
      } catch (failure) {
        eventOffRef.current?.();
        eventOffRef.current = null;
        clientRef.current = null;
        // 这次关闭是"因为失败而收摊"，不是用户拔线：别让 onClose 再挂一条"串口断开了"的提示
        userClosedRef.current = true;
        await transportRef.current?.close();
        transportRef.current = null;

        // 没连上的端口一律忘掉：选错过、被 monitor 占着、固件版本不对 —— 这些都还没
        // "连接成功"过，留在浏览器的授权列表里只会让刷新时白试一次。
        // 连上之后才出的问题（比如读卡失败）不算，那种端口是对的，保留。
        const port = portRef.current;
        portRef.current = null;
        // 握手静默超时、上传收尾超时、或者本次连接本来就是刷新恢复：设备多半是对的，
        // 只是还没准备好；别把端口忘掉，否则刷新/复位后要重新选一次串口。
        const transientHandshake = failure instanceof HandshakeError && failure.kind === 'silent';
        if (!established && port && !recoveringUpload && !transientHandshake && !isStaleUploadError(failure)) {
          await forgetPort(port);
        }

        // 这条口刚才还跟板子通过话、现在一条回执都没有：那不是"选错端口"，是板子的串口通道
        // 卡死了（见 `MUTE_HINT`）。这种情况按"选错端口"提示会把用户引到死路上。
        setError(transientHandshake && isLastGoodPort(port) ? MUTE_HINT : describeError(failure));
        setConnection('disconnected');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const pickPort = useCallback(async (): Promise<void> => {
    const serial = navigator.serial;
    if (!serial) return;
    try {
      // 过滤没命中时会自动再列一次全部串口；`fellBack` 只用于调试，
      // 界面上不再多挂一行提示 —— 用户要的就是那个选择框本身。
      const { port } = await requestPortPreferringDevice(serial);
      // 取消 = 什么都不说（可能只是还没插好）
      if (!port) return;
      await connect(port);
    } catch (failure) {
      setError(describeError(failure));
      setConnection('disconnected');
    }
  }, [connect]);

  /** 之前授权过的端口会留在 `getPorts()` 里，直接重连 */
  const reconnect = useCallback(async (): Promise<boolean> => {
    const serial = navigator.serial;
    if (!serial) return false;
    // 已经在连了就别再插一脚：`connect()` 会先关掉手上的传输再重开，两路并发等于
    // 白白多走一次"关端口 → 开端口" —— 正是把板子串口弄哑的那套动作。
    if (connectionRef.current === 'connecting') return false;
    try {
      const ports = await serial.getPorts();
      // 没有已授权的端口是**正常状态**（第一次打开、或者刚点过"断开设备"），
      // 初始化页本来就写着"点下面的按钮选择串口"，这里不用再提醒一遍。
      if (ports.length === 0) return false;
      await connect(ports[0]);
      return true;
    } catch {
      return false;
    }
  }, [connect]);

  reconnectRef.current = reconnect;

  /** 收摊：关串口 + 清界面状态，但**不动端口授权**（回前台自动重连要靠它） */
  const closeTransport = useCallback(async (): Promise<void> => {
    userClosedRef.current = true;
    eventOffRef.current?.();
    eventOffRef.current = null;
    clientRef.current?.detach();
    clientRef.current = null;
    await transportRef.current?.close();
    transportRef.current = null;

    applyInfo(null);
    setItems([]);
    applyPlayback(IDLE_PLAYBACK);
    setConnection('disconnected');
  }, []);

  const disconnect = useCallback(async (): Promise<void> => {
    logRef.current?.note('用户点了"断开设备"');
    await closeTransport();

    // 顺手"忘记"这个端口：撤掉浏览器的授权记忆，刷新页面就不会自动又连上。
    // 想再用就得重新点"选择串口"授权一次 —— 这正是"断开设备"该有的语义。
    const port = portRef.current;
    portRef.current = null;
    await forgetPort(port);
  }, [closeTransport]);

  /**
   * 网页切到后台（另一个标签页 / 最小化）**过一阵子**才松开串口。
   *
   * 设备那边是**自主播放**，松开网页不影响它；这边主动放手，别的程序（espflash
   * monitor 之类）想用这个口不用等用户手动点"断开设备"。但**不能一切走就松手**：
   * 每次"松开 + 切回来重连"都是一次"开端口 → 收发 → 关端口"，实测约 9 次就能让 C6
   * 的 USB-Serial-JTAG 数据通道卡死（见 `BACKGROUND_RELEASE_MS` 与 `last-good-port.ts`），
   * 而切标签页是这件事最主要的来源。所以留一段宽限，短暂切走不动它。
   *
   * 这里**不能**走 `disconnect()`：那个会把端口授权忘掉，`getPorts()` 就再也看不到
   * 它，回前台只能让用户重新挑一次串口。这里走 `closeTransport()` 把授权留着，
   * 回前台 `reconnect()` 就能自动恢复。
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let releaseTimer: number | null = null;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (connectionRef.current !== 'connected') return;
        if (releaseTimer !== null) return;
        releaseTimer = window.setTimeout(() => {
          releaseTimer = null;
          // 宽限期内切回来过、或者中途断了：都不用再松手了
          if (document.visibilityState !== 'hidden' || connectionRef.current !== 'connected') return;
          pausedRef.current = true;
          void (async () => {
            await closeTransport();
            setNotice('网页切到后台有一阵子了，先把串口让出来；切回来会自动重连。');
          })();
        }, BACKGROUND_RELEASE_MS);
        return;
      }
      if (releaseTimer !== null) {
        window.clearTimeout(releaseTimer);
        releaseTimer = null;
      }
      // 回前台：只接回"因为切后台才松开的那一次"
      if (!pausedRef.current) return;
      pausedRef.current = false;
      void reconnectRef.current?.();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (releaseTimer !== null) window.clearTimeout(releaseTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [closeTransport]);

  // 浏览器层面的插拔事件：拔掉 → 切状态；插回来 → 自动重连
  useEffect(() => {
    const serial = navigator.serial;
    if (!serial) return;
    // 同理：插拔事件只负责切状态 + 插回来时自动重连，不额外挂提示
    const onDisconnect = () => {
      if (userClosedRef.current) return;
      applyPlayback(IDLE_PLAYBACK);
      setConnection('disconnected');
    };
    const onConnect = () => {
      if (connectionRef.current === 'disconnected') void reconnectRef.current?.();
    };
    serial.addEventListener('disconnect', onDisconnect);
    serial.addEventListener('connect', onConnect);
    return () => {
      serial.removeEventListener('disconnect', onDisconnect);
      serial.removeEventListener('connect', onConnect);
    };
  }, []);

  // ------------------------------------------------------------------ 索引与快照

  const loadIndex = useCallback(async (): Promise<MediaIndex> => {
    // INDEX 刚写完时 SD 卡可能会短暂读不回来（日志里表现为 0/1219）：
    // 最多重试一次，且把超时收短；重试太久会把后面的播放命令堵在串口队列里。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const bytes = await client().get(INDEX_NAME, { timeoutMs: 1_200 });
        const parsed = parseIndex(bytes);
        if (parsed) return parsed;
      } catch {
        /* 下一次重试 */
      }
      await wait(100);
    }
    return emptyIndex();
  }, [client]);

  /** 写索引 + 播放清单（固件只认清单，不读 JSON） */
  const saveIndex = useCallback(
    async (index: MediaIndex): Promise<void> => {
      indexRef.current = index;
      // INDEX / PLAYLIST 也是 media/add：刷新页面时同样要能恢复，不能只用
      // 素材上传那条路径去标记“上传进行中”。
      await withUploadRecovery(() => client().add(INDEX_NAME, serializeIndex(index)));
      await withUploadRecovery(() => client().add(PLAYLIST_NAME, buildPlaylist(index)));
    },
    [client],
  );

  /**
   * 卡片上的首帧图。
   *
   * 取图顺序（见 `lib/poster.ts`）：本机存过的首帧图 → 产物缓存里的整份 → 从板子上读
   * 够画第 0 帧的那一段。
   *
   * `allowDeviceRead=false` 时只用本机已经有的：播放中、或者卡读不出来的时候去读串口
   * 只会白等超时（还要把唯一的命令队列堵住）。
   */
  const loadPoster = useCallback(
    async (item: MediaItem, options: { allowDeviceRead?: boolean } = {}): Promise<ImageData | null> => {
      const allowDeviceRead = options.allowDeviceRead ?? true;
      // 连尺寸/帧数都没有的空壳多半就是坏文件；不在列表收尾阶段读它。
      // 这里只看几何（`hasGeometry`），不看"来源格式知不知道"：来源只影响能不能换
      // 参数重转，不影响这张卡上的文件能不能画出首帧图。
      if (
        !item.meta ||
        !hasGeometry(item.meta) ||
        posterFailuresRef.current.has(item.name)
      ) {
        return null;
      }
      const currentDevice = deviceId();
      const meta = { size: item.size, createdAt: item.createdAt };
      try {
        const poster = await loadPosterImage(
          {
            stored: async () =>
              (await cacheRef.current?.getPoster(currentDevice, item.name, meta.size, meta.createdAt)) ??
              null,
            cached: async () =>
              (await cacheRef.current?.get(currentDevice, item.name, meta.size, meta.createdAt)) ?? null,
            dropCached: async () => {
              // 本机那份产物是**错位**读回来的（长度碰巧对上，内容是花的）：丢掉，
              // 下面会重新读卡；下次悬停预览也不会再拿它当"整份都在手"。
              await cacheRef.current?.dropMedia(currentDevice, item.name);
            },
            read: async (offset, length) => {
              // 这次不让读卡（设备在播 / 列表本来就是快照）：直接说"拿不到"，
              // 别去串口上白等几秒超时。
              if (!allowDeviceRead) throw new Error('这次只从本机取首帧图');
              const part = await client().getPartial(item.name, {
                offset,
                length,
                timeoutMs: BACKGROUND_READ_TIMEOUT_MS,
              });
              // 没读全：这一段废了（丢字节、或者板子根本没回）。上层据此提前收手（见 `refresh`）
              if (!part.complete) posterReadStalledRef.current = true;
              return part;
            },
            store: async (image) => {
              await cacheRef.current?.putPoster(currentDevice, item.name, meta, image);
            },
          },
          item.name,
          meta.size,
        );
        return poster ? new ImageData(poster.rgba, poster.width, poster.height) : null;
      } catch (failure) {
        // 读不出来（超时 / 设备在播 / 卡坏了）只是"这次没拿到"：下次刷新还会再试。
        // 只有字节已经读到、却解不出第一帧的才算坏文件 —— 记下来是为了别每次刷新都去读它。
        if (failure instanceof PosterDecodeError) posterFailuresRef.current.add(item.name);
        return null;
      }
    },
    [client, deviceId],
  );

  /** 拿到一张首帧图就存进内存 + 贴回列表里（快照和读卡两条路都走它） */
  const putPoster = useCallback(
    async (item: MediaItem, options: { allowDeviceRead?: boolean } = {}): Promise<void> => {
      if (item.poster) return;
      const poster = await loadPoster(item, options);
      if (!poster) return;
      postersRef.current.set(item.name, poster);
      setItems((current) =>
        current.map((entry) => (entry.name === item.name ? { ...entry, poster } : entry)),
      );
    },
    [loadPoster],
  );

  const restore = useCallback(async (reason: SnapshotReason): Promise<void> => {
    await cacheReady();
    const snapshot = await cacheRef.current?.getSnapshot(deviceId());
    if (!snapshot) {
      setItems([]);
      setSnapshotReason(reason);
      return;
    }
    indexRef.current = snapshot.index;
    const byName = new Map(snapshot.index.entries.map((entry) => [entryFileName(entry), entry]));
    const restored: MediaItem[] = snapshot.files.map((file) => {
      const meta = byName.get(file.fileName) ?? null;
      return {
        name: file.fileName,
        size: file.size,
        createdAt: meta?.createdAt ?? file.createdAt,
        meta,
        poster: postersRef.current.get(file.fileName) ?? null,
        skip: meta?.skip ?? false,
        hasSource: sourcesRef.current.has(file.fileName),
      };
    });
    orderItems(restored, snapshot.index);
    setItems(restored);
    setSnapshotReason(reason);
    void markSources(restored);

    // 快照里只有文件名：首帧图从**本机**补（存过的首帧图 / 产物缓存）。
    // 这里**不读板子**：走到这条路的两种情况（设备在播、卡读不出来）读了也是白等超时，
    // 还会把命令队列堵住；补不上的那几张安静留空，等 refresh 的时候再补。
    for (const item of restored) {
      await putPoster(item, { allowDeviceRead: false });
    }
  }, [cacheReady, deviceId, putPoster]);

  /** 快照读取包一层"加载中"，列表为空时界面显示骨架屏 */
  const loadSnapshot = useCallback(async (reason: SnapshotReason = 'read-error'): Promise<void> => {
    setListLoading(true);
    try {
      await restore(reason);
    } finally {
      setListLoading(false);
    }
  }, [restore]);

  /** 把"本机有没有原图"标出来（改参数、自动重传都靠它） */
  const markSources = useCallback(
    async (list: MediaItem[]): Promise<void> => {
      const cache = cacheRef.current;
      if (!cache) return;
      const next = new Set<string>();
      for (const item of list) {
        if ((await cache.getSource(deviceId(), item.name)) !== null) next.add(item.name);
      }
      sourcesRef.current = next;
      setItems((current) => current.map((item) => ({ ...item, hasSource: next.has(item.name) })));
    },
    [deviceId],
  );

  const refresh = useCallback(async (force = false): Promise<void> => {
    const deviceClient = client();
    // 正在播的时候读不了卡，也没必要读：用快照。刚发完 stop 时状态还没 render，
    // 所以要读 `playbackRef`（`force` 给"明知道已经停了"的调用方用）
    if (!force && playbackRef.current.playing) {
      await loadSnapshot(null);
      return;
    }
    setListLoading(true);
    try {
      const files = await deviceClient.list();
      const mediaFiles = files.filter((file) => /\.(ANM|BMP)$/i.test(file.name));

      // INDEX 可能是被中断写坏的，或者只剩网页重建的“孤儿条目”（frames/宽高全 0）。
      // 卡上的文件还在时，用本机快照里的元数据把宽度、帧数、来源等补回来，别把
      // 有元数据的索引覆盖成空壳。
      // 内存/snapshot 已经有带元数据的索引时，不再为了 refresh 去发一次
      // `media/get INDEX`：这个读操作失败过，而且会占住唯一的串口命令队列，
      // 导致用户点“播放”后要等十几秒才排到。
      const localIndex = indexRef.current;
      const hasLocalMetadata = localIndex.entries.some((entry) => !needsMetadataRecovery(entry));
      const diskIndex = hasLocalMetadata ? localIndex : await loadIndex();
      const diskHasMetadata = diskIndex.entries.some((entry) => !needsMetadataRecovery(entry));
      const index = diskHasMetadata || localIndex.entries.length === 0 ? diskIndex : localIndex;
      const snapshot = await cacheRef.current?.getSnapshot(deviceId());
      const localByName = new Map(
        (snapshot?.index.entries ?? []).map((entry) => [entryFileName(entry), entry]),
      );
      const enriched = recoverIndexMetadata(index, snapshot?.index ?? null);

      const { index: pruned, missing, orphans } = reconcile(
        enriched,
        mediaFiles.map((file) => ({ name: file.name, size: file.size })),
      );

      // 注意：这里不主动读卡上文件恢复元数据。坏文件读取会把列表一直卡在骨架屏；
      // 先用快照能补多少补多少，补不回来的先以 0 帧空壳显示，让用户能删除坏文件。
      let nextIndex: MediaIndex = pruned;

      if (missing.length > 0 || orphans.length > 0) {
        // 卡上的文件和索引对不上（比如用读卡器动过）：以卡上的为准重建；
        // 能对上的条目优先用快照/文件本身恢复出来的元数据，别直接生成 0 帧空壳。
        const known = new Map(pruned.entries.map((entry) => [entryFileName(entry), entry]));
        const entries: IndexEntry[] = [];
        for (const file of mediaFiles) {
          const entry = known.get(file.name);
          if (entry) {
            entries.push(entry);
            continue;
          }
          const local = localByName.get(file.name);
          if (local) {
            entries.push({ ...local, bytes: file.size, createdAt: file.createdAt.getTime() });
            continue;
          }
          const ext = file.name.toUpperCase().endsWith('.ANM') ? 'ANM' : 'BMP';
          entries.push({
            id: file.name.split('.')[0].toUpperCase(),
            ext,
            kind: ext === 'ANM' ? 'anim' : 'still',
            width: 0,
            height: 0,
            frames: 0,
            loops: DEFAULT_LOOPS,
            durationMs: 0,
            bytes: file.size,
            sourceName: file.name,
            sourceType: 'unknown',
            fit: 'contain',
            skip: false,
            createdAt: file.createdAt.getTime(),
          } satisfies IndexEntry);
        }
        nextIndex = { version: pruned.version, entries };
      }

      /**
       * 还缺尺寸/帧数的条目：直接问卡上的文件本身。
       *
       * 为什么需要这一步：索引是网页写的，一旦某次上传/写回被中断，条目就可能只剩
       * "文件名 + 大小"的空壳（`frames = 0`）。空壳会让卡片显示"0 帧"、画不出首帧图
       * （黑块），进度条也没有分母 —— 而**卡上的 `.ANM` 文件头里这些数字都是好的**。
       * 只读 18 字节的文件头，走 `crates/anmfmt` 那一份解析（不在 TS 里重解格式）。
       *
       * 只在列表收尾时按顺序读（串口只有一条队列），失败就留着空壳：下次刷新还会再试。
       */
      const repaired: IndexEntry[] = [];
      for (const entry of nextIndex.entries) {
        if (entry.ext !== 'ANM' || hasGeometry(entry)) {
          repaired.push(entry);
          continue;
        }
        try {
          const header = await deviceClient.get(entryFileName(entry), {
            offset: 0,
            length: ANM_HEADER_LEN,
            timeoutMs: BACKGROUND_READ_TIMEOUT_MS,
          });
          const info = anmHeaderInfo(header);
          // 认不出文件头（不是 ANM / 读到了垃圾）：原样留着空壳
          repaired.push(info ? { ...entry, ...info } : entry);
        } catch {
          // 读不到（设备在播 / 卡坏了）：保持空壳，别把整个列表卡住
          repaired.push(entry);
        }
      }
      nextIndex = { version: nextIndex.version, entries: repaired };

      const previousIndex = JSON.stringify(indexRef.current);
      indexRef.current = nextIndex;
      const indexChanged = previousIndex !== JSON.stringify(nextIndex);

      const byName = new Map(nextIndex.entries.map((entry) => [entryFileName(entry), entry]));
      const next: MediaItem[] = mediaFiles.map((file) => {
        const meta = byName.get(file.name) ?? null;
        return {
          name: file.name,
          size: file.size,
          createdAt: meta?.createdAt ?? file.createdAt.getTime(),
          meta,
          poster: postersRef.current.get(file.name) ?? null,
          skip: meta?.skip ?? false,
          hasSource: sourcesRef.current.has(file.name),
        };
      });
      orderItems(next, nextIndex);
      setItems(next);
      setSnapshotReason(null);
      // 列表已经到手就立刻撤骨架屏；后面的索引写回、快照和首帧图都算收尾。
      setListLoading(false);

      // 索引和清单都以网页为准，但**只有内容变化、或磁盘索引已经坏了**才写回。
      // 每次 refresh 都重写 INDEX 会放大“刚写完的大 INDEX 读不回来”的问题。
      if (indexChanged || !diskHasMetadata) {
        try {
          await saveIndex(nextIndex);
        } catch {
          // 写回失败（多半是刚好断连）不用打扰用户：下次 refresh 会重写一遍
        }
      }
      await cacheRef.current?.prune(deviceId(), mediaFiles.map((file) => file.name));
      await cacheRef.current?.putSnapshot({
        deviceId: deviceId(),
        index: nextIndex,
        files: mediaFiles.map((file) => ({ fileName: file.name, size: file.size, createdAt: file.createdAt.getTime() })),
        at: Date.now(),
      });
      void cacheRef.current?.stats().then(setCacheStats);

      // 首帧图一张一张补（串口只有一条队列，不能并发）：本机没有的那几张才去读板子，
      // 而且只读"够画第 0 帧"的那一段（分段读，用户的操作能插在中间）
      posterReadStalledRef.current = false;
      for (const item of next) {
        await putPoster(item);
        // 板子不回话时别把剩下的卡片一张张磨完：列表会一直黑着，用户的点击也堵在队列后面。
        // 收手并说清楚原因（下一轮 refresh 还会再试）。
        if (posterReadStalledRef.current) {
          setNotice('读卡超时：设备没把首帧图读全（多半是没响应），剩下的卡片先空着。重新插拔或点"重新连接"再试。');
          break;
        }
      }
      void markSources(next);
    } catch (failure) {
      const message = describeError(failure);
      // 卡目录读失败（例如坏块/坏目录项）时，别把素材库变成空白：先退回本机快照，
      // 让用户至少能看到旧列表并尝试删除坏文件。
      try {
        await loadSnapshot('read-error');
        setNotice(`读卡失败：${message}。当前显示的是本机快照。`);
      } catch {
        setError(message);
      }
    } finally {
      setListLoading(false);
    }
  }, [applyInfo, client, deviceId, loadIndex, loadSnapshot, markSources, putPoster, saveIndex]);

  /**
   * **降级兜底**：连着、正在播，但这条链路上一条设备事件都没收到 → 才回退到轮询。
   *
   * v9 的固件会主动推 `~0 ev …`，正常情况下这个定时器根本不该跑；留着是因为
   * 旧固件不会推事件，而"停在播但没人告诉你"这种状态最难查。判据是**事件计数**，
   * 不是时间：只要收到过任何一条事件（哪怕是 `ev play`），就永久不再轮询。
   */
  useEffect(() => {
    if (connection !== 'connected' || !playback.playing) return;
    if (eventsSeenRef.current) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const next = await client().info();
          applyInfo(next);
          applyPlayback({
            playing: next.playing,
            item: next.item,
            index: next.index,
            total: next.total,
            loop: next.loop,
            frame: next.frame,
            frames: next.frames,
          });
          if (!next.playing) await refresh();
        } catch (failure) {
          const info = classifyFailure(failure, { connected: connectionRef.current === 'connected' });
          // 串口断了/设备没回应这类，连接页的横幅已经说了，别再叠一行原文
          if (info.kind === 'disconnected') return;
          setNotice(describeFailure(info));
        }
      })();
    }, PLAYBACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [client, connection, playback.playing, refresh]);

  // ------------------------------------------------------------------ 上传

  const convertForUpload = useCallback(
    (file: File, options: ConvertOptions): Promise<ConvertedMedia[]> => convertFile(file, options),
    [],
  );

  /** 传一个已经转好的素材：写卡 → 追加索引 → 写清单 → 存产物与原图 → 更新界面 */
  const uploadConverted = useCallback(
    async (file: File, media: ConvertedMedia, onProgress?: (sent: number, total: number) => void): Promise<void> => {
      if (media.payload.length > ANM_MAX_BYTES) {
        throw new Error(`转换后 ${(media.payload.length / 1024 / 1024).toFixed(1)} MiB，超过 32 MiB 上限`);
      }
      const id = await contentId(media.payload, sheetSalt(media.sheet));
      const name = `${id}.${media.ext}`;
      const deviceClient = client();
      try {
        await deviceClient.stop(); // 幂等：万一设备正在播，先停下来免得吃 ERR busy
      } catch {
        /* 设备没在播时也回 OK；这里失败不影响后面 */
      }
      setProgress({ label: `上传 ${file.name}`, sent: 0, total: media.payload.length });
      logRef.current?.note(`上传开始：${file.name} → ${name}（${bytesLabel(media.payload.length)}）`);
      try {
        await withUploadRecovery(() => deviceClient.add(name, media.payload, onProgress));
        logRef.current?.note(`上传完成：${name}`);
      } catch (failure) {
        logRef.current?.error(`上传失败：${file.name}：${describeError(failure)}`);
        // 主动取消：板子收到 `media/abort` 已经回到命令行状态（半截文件也删了），
        // 不必像"刷新页面/链路烂掉"那样留下恢复标记让下一次先等 2.2 秒
        if (describeError(failure).includes('已取消')) clearUploadInFlight();
        throw failure;
      } finally {
        setProgress(null);
      }

      const entry = indexEntryOf(media, {
        id,
        loops: DEFAULT_LOOPS,
        sheet: media.sheet,
        sourceName: file.name,
        fit: 'contain',
        skip: false,
        createdAt: Date.now(),
      });
      const entries = indexRef.current.entries.filter((item) => entryFileName(item) !== name);
      entries.push(entry);
      await saveIndex({ version: indexRef.current.version, entries });

      const currentDevice = deviceId();
      await cacheRef.current?.put(currentDevice, name, { size: media.payload.length, createdAt: entry.createdAt }, media.payload);
      await cacheRef.current?.putSource(currentDevice, name, {
        sourceName: file.name,
        type: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      sourcesRef.current.add(name);

      posterFailuresRef.current.delete(name);
      const preview = await previewByName(name, media.payload, 1).catch(() => null);
      const frame = preview?.frames[0];
      const poster = frame ? new ImageData(frame.rgba, preview!.width, preview!.height) : null;
      if (poster) {
        postersRef.current.set(name, poster);
        // 顺手存进首帧图缓存：以后就算「清空缓存」把产物清了，卡片也不用重新读板子
        await cacheRef.current?.putPoster(
          currentDevice,
          name,
          { size: media.payload.length, createdAt: entry.createdAt },
          { width: poster.width, height: poster.height, rgba: poster.data },
        );
      }

      const item: MediaItem = {
        name,
        size: media.payload.length,
        createdAt: entry.createdAt,
        meta: entry,
        poster,
        skip: false,
        hasSource: true,
      };
      const merged = itemsRef.current.filter((existing) => existing.name !== name);
      merged.push(item);
      orderItems(merged, indexRef.current);
      setItems(merged);
    },
    [client, deviceId, saveIndex],
  );

  // ------------------------------------------------------------------ 素材操作

  const removeItem = useCallback(
    async (name: string): Promise<void> => {
      const deviceClient = client();
      await deviceClient.stop().catch(() => undefined);
      await deviceClient.remove(name);
      const entries = indexRef.current.entries.filter((entry) => entryFileName(entry) !== name);
      await saveIndex({ version: indexRef.current.version, entries });
      postersRef.current.delete(name);
      posterFailuresRef.current.delete(name);
      const currentDevice = deviceId();
      await cacheRef.current?.remove(currentDevice, name);
      await cacheRef.current?.removeSource(currentDevice, name);
      sourcesRef.current.delete(name);
      setItems((current) => current.filter((item) => item.name !== name));
    },
    [client, deviceId, saveIndex],
  );

  const setSkip = useCallback(
    async (name: string, skip: boolean): Promise<void> => {
      const entries = indexRef.current.entries.map((entry) =>
        entryFileName(entry) === name ? { ...entry, skip } : entry,
      );
      await saveIndex({ version: indexRef.current.version, entries });
      // `skip` 和 `meta.skip` 都要跟着变：卡面徽标看前者，界面判断"清单是否为空"看后者
      setItems((current) =>
        current.map((item) =>
          item.name === name
            ? { ...item, skip, meta: item.meta ? { ...item.meta, skip } : item.meta }
            : item,
        ),
      );
    },
    [saveIndex],
  );

  /** 拖拽排序：把 `name` 挪到 `beforeName` 前面（`beforeName` 为空表示挪到末尾） */
  const reorder = useCallback(
    async (name: string, beforeName: string | null): Promise<void> => {
      const entries = [...indexRef.current.entries];
      const from = entries.findIndex((entry) => entryFileName(entry) === name);
      if (from < 0) return;
      const [moved] = entries.splice(from, 1);
      const to = beforeName === null ? entries.length : entries.findIndex((entry) => entryFileName(entry) === beforeName);
      entries.splice(to < 0 ? entries.length : to, 0, moved);
      await saveIndex({ version: indexRef.current.version, entries });
      setItems((current) => {
        const copy = [...current];
        const at = copy.findIndex((item) => item.name === name);
        if (at < 0) return current;
        const [item] = copy.splice(at, 1);
        const before = beforeName === null ? copy.length : copy.findIndex((entry) => entry.name === beforeName);
        copy.splice(before < 0 ? copy.length : before, 0, item);
        return copy;
      });
    },
    [saveIndex],
  );

  /**
   * 改某张的布局/循环，按改动分两条路：
   *
   * - **只改循环**：循环次数不在 `.ANM` 里，所以只重写索引 + `PLAYLIST`，卡上的动画文件
   *   一个字节都不动（连本机原图都不需要）；
   * - **改布局**：必须重新转换，于是用**本机缓存的原图**重新生成 → 传成新 id →
   *   在索引里原位置替换 → 删掉旧文件。本机没有原图就报错（界面会提示重新选文件）。
   */
  const updateItemParams = useCallback(
    async (name: string, params: { fit: Fit; loops: number }): Promise<void> => {
      // 索引条目才是权威数据；不在索引里的文件不给改（界面上也不会有入口）
      const current = indexRef.current.entries.find((entry) => entryFileName(entry) === name);
      if (!current) return;
      const loops = normalizeLoops(params.loops);

      if (params.fit === current.fit) {
        // 重写 INDEX + PLAYLIST 也是"改卡"：先停一下，免得撞上播放中的 ERR busy
        await client().stop().catch(() => undefined);
        const entries = indexRef.current.entries.map((entry) =>
          entryFileName(entry) === name ? { ...entry, loops } : entry,
        );
        await saveIndex({ version: indexRef.current.version, entries });
        logRef.current?.note(`改循环：${name} → ${loops === 0 ? '一直播' : `${loops} 轮`}`);
        setItems((items) =>
          items.map((entry) =>
            entry.name === name ? { ...entry, meta: { ...current, loops } } : entry,
          ),
        );
        return;
      }

      const currentDevice = deviceId();
      const source = await cacheRef.current?.getSource(currentDevice, name);
      if (!source) throw new Error('本机没有原图，改布局需要重新选择文件');

      const converted = await convertFile(new File([new Uint8Array(source.bytes)], source.sourceName, { type: source.type }), {
        width: canvasSize.width,
        height: canvasSize.height,
        fit: params.fit,
        trim: true,
        fromSheet: current.sheet,
      });
      if (converted.length !== 1) {
        throw new Error('源文件包含多段动画，无法只重新生成当前段；请重新上传原图。');
      }
      const media = converted[0];
      const id = await contentId(media.payload, sheetSalt(media.sheet ?? current.sheet));
      const nextName = `${id}.${media.ext}`;
      const deviceClient = client();
      await deviceClient.stop().catch(() => undefined);

      const createdAt = Date.now();
      const entry = indexEntryOf(media, {
        id,
        loops,
        sheet: media.sheet ?? current.sheet,
        sourceName: source.sourceName,
        fit: params.fit,
        skip: current.skip,
        createdAt,
      });
      // 重新上传的过程会持续几秒：把分块进度报给界面（改设置对话框的按钮上显示）
      const label = REUPLOAD_PROGRESS_LABEL;
      setProgress({ label, sent: 0, total: media.payload.length });
      try {
        await withUploadRecovery(() =>
          deviceClient.add(nextName, media.payload, (sent, total) => setProgress({ label, sent, total })),
        );
      } finally {
        setProgress(null);
      }
      // 原位置替换，保住播放顺序
      const entries = indexRef.current.entries.map((existing) =>
        entryFileName(existing) === name ? entry : existing,
      );
      if (!entries.some((existing) => entryFileName(existing) === nextName)) entries.push(entry);
      await saveIndex({ version: indexRef.current.version, entries });

      if (nextName !== name) {
        await deviceClient.remove(name);
        await cacheRef.current?.remove(currentDevice, name);
        await cacheRef.current?.moveSource(currentDevice, name, nextName);
        postersRef.current.delete(name);
        posterFailuresRef.current.delete(name);
      }
      posterFailuresRef.current.delete(nextName);
      await cacheRef.current?.put(currentDevice, nextName, { size: media.payload.length, createdAt }, media.payload);
      sourcesRef.current.add(nextName);

      logRef.current?.note(`改布局：${name} → ${nextName}（${params.fit}，${loops === 0 ? '一直播' : `${loops} 轮`}）`);
      // 文件名变了（内容哈希），别自己拼列表：以**卡上的内容**为准重建一次 —— 索引、PLAYLIST、
      // 快照、首帧图全都跟着对上，列表里也不会留下"旧名字的空壳"（那要靠手动刷新才消失）。
      await refresh(true);
    },
    [canvasSize.height, canvasSize.width, client, deviceId, refresh, saveIndex],
  );

  // ------------------------------------------------------------------ 播放

  /**
   * 设备主动推的播放事件 → 界面状态。
   *
   * v9 之前播放状态只能问（`device/info` 每 1.5 秒一次），于是"什么时候停的"最多滞后
   * 一个轮询周期，而轮询还要跟用户的命令抢同一条串口队列。现在方向反过来：**有事设备说**。
   * 收到 `frame` / `item` 就更新进度，`stop` 就把界面切回不在播并刷一次卡。
   */
  const handlePlaybackEvent = useCallback(
    (event: PlaybackEvent): void => {
      eventsSeenRef.current = true;
      const current = playbackRef.current;
      switch (event.name) {
        case EVENTS.play:
          applyPlayback({ ...current, playing: true });
          return;
        case EVENTS.stop:
          applyPlayback(IDLE_PLAYBACK);
          // 停了就能读卡：把素材库从"本机快照"换回卡上的真实列表
          void refresh(true).catch(() => undefined);
          return;
        case EVENTS.item: {
          // 字段解析失败时是"原样带着"的那一支（新固件/坏数据），这里判掉再取字段
          if (!('file' in event)) return;
          applyPlayback({
            playing: true,
            item: event.file,
            index: event.index,
            total: event.total,
            loop: current.loop,
            frame: current.frame,
            frames: current.frames,
          });
          return;
        }
        case EVENTS.loop:
          if (!('round' in event)) return;
          applyPlayback({ ...current, playing: true, loop: event.round, frame: 0 });
          return;
        case EVENTS.frame: {
          if (!('frame' in event)) return;
          applyPlayback({
            ...current,
            playing: true,
            frame: event.frame,
            frames: event.frames,
          });
          return;
        }
        case EVENTS.error:
          if (!('message' in event)) return;
          setNotice(`播放失败：${event.message}`);
          applyPlayback(IDLE_PLAYBACK);
          return;
        default:
          // 认不出的事件（新固件加的种类）：忽略就好，别把界面打崩
          return;
      }
    },
    [applyPlayback, refresh],
  );
  eventHandlerRef.current = handlePlaybackEvent;

  const playPlaylist = useCallback(
    async (start?: string): Promise<void> => {
      logRef.current?.note(start ? `开始整表播放（从 ${start} 起）` : '开始整表播放');
      try {
        await client().play(start);
        // `OK` 只代表"已开始"：先乐观切成"正在播放"，这样即使紧接着的 info 超时，
        // 界面也会显示"停止播放"而不是误判成读卡失败/设备不在播。
        applyPlayback({
          playing: true,
          item: start ?? null,
          index: 0,
          total: 0,
          loop: 0,
          frame: 0,
          frames: 0,
        });
      } catch (failure) {
        logRef.current?.error(`整表播放失败：${describeError(failure)}`);
        throw new Error(describeFailure(classifyFailure(failure, { connected: connection === 'connected' })));
      }
    },
    [applyPlayback, client, connection],
  );

  const stopPlayback = useCallback(async (): Promise<void> => {
    logRef.current?.note('停止播放');
    await client().stop();
    applyPlayback(IDLE_PLAYBACK);
    // 停了就能读卡了：立刻把素材库从"本机快照"换回卡上的真实列表
    await refresh(true);
  }, [applyPlayback, client, refresh]);

  /** 播放期间界面上要禁掉的功能：这里统一告诉你"现在能不能改卡上的东西" */
  const canEdit = connection === 'connected' && !playback.playing;

  /**
   * 取消**正在进行**的上传 / 下载（v9 的 `media/abort`）。
   *
   * 只做一件事：把"取消"登记到正在传输那条请求上，并叫醒正卡在等字节处的读取。
   * 板子的 abort 那一槽由传输循环自己在槽边界发，所以打断延迟的上限是**一块 + 一次 ACK**
   * （上传一块 1024 字节），不用等整份文件传完。半截文件由板子删。
   *
   * 返回有没有登记上（没有传输在飞就是 false）。
   */
  const cancelTransfer = useCallback(async (): Promise<boolean> => {
    const client = clientRef.current;
    if (client === null) return false;
    logRef.current?.note('取消当前传输');
    return client.cancelTransfer();
  }, []);

  // ------------------------------------------------------------------ 预览/缓存

  /**
   * 悬停预览。
   *
   * - 产物缓存里有整份 → 直接解，最理想（平时都是这条）；
   * - 没有就只从板子读**开头一段**，`decodeAnm` 会把已经完整解出来的那几帧交给我们，
   *   够卡片动起来。**不读整份**：500 KiB 在 115200 波特率下要 40 多秒，而串口只有一条
   *   命令队列 —— 这期间用户点的删除/播放只能干等（"点了没反应"就是这么来的）。
   */
  const loadPreview = useCallback(
    async (name: string): Promise<Preview> => {
      const item = itemsRef.current.find((entry) => entry.name === name);
      if (!item) throw new Error(`${name} 不在列表里`);
      // 没有元数据 / 0 帧的空壳通常就是坏文件；直接拒绝读，别让悬停预览再卡一次。
      if (!item.meta || !hasGeometry(item.meta)) {
        throw new Error('这个文件读不出来（可能是坏文件），请直接在卡片上删除它。');
      }
      const currentDevice = deviceId();
      const cached = await cacheRef.current?.get(currentDevice, name, item.size, item.createdAt);
      if (cached) return previewByName(name, cached);

      // 播放中读不了卡（`media/get` 会回 ERR busy）：别浪费三秒超时
      if (playbackRef.current.playing) throw new Error('设备正在播放，暂时读不了卡');
      // 静图的预览就是卡片上那张首帧图，不用为了它把整份 BMP 拉一遍
      if (extOf(name) !== 'ANM') throw new Error('静图不用预览');

      // 第 0 帧可能很大（cover 布局实测 ~74 KiB），少读了会一个完整帧都解不出来：
      // `readFilePrefix` 会先读文件头算出至少该读多少，再补读剩下的。
      //
      // 用 `getPartial`：串口偶发丢字节时，把**已经读到的部分**交给 `decodeAnm`，
      // 它能播几帧就播几帧 —— 而不是整次悬停白等一场、什么都不显示。
      const prefix = await readFilePrefix(
        (offset, length) =>
          client().getPartial(name, { offset, length, timeoutMs: BACKGROUND_READ_TIMEOUT_MS }),
        name,
        item.size,
        PREVIEW_PREFIX_BYTES,
      );
      if (!prefix) throw new Error('这个文件没有内容可预览');
      // 整份都读回来了就顺手塞进产物缓存：下次悬停、首帧图都不用再读卡。
      // **但错位的那份不能进缓存**（长度碰巧对上、内容是花的），否则这张卡以后一直花。
      if (prefix.bytes.length >= item.size && posterBytesTrusted(name, prefix.bytes)) {
        await cacheRef.current?.put(
          currentDevice,
          name,
          { size: item.size, createdAt: item.createdAt },
          prefix.bytes,
        );
        void cacheRef.current?.stats().then(setCacheStats);
      }
      return previewByName(name, prefix.bytes);
    },
    [client, deviceId],
  );

  const clearLogs = useCallback(async (): Promise<void> => {
    await logRef.current?.clear();
    setLogStats(logRef.current?.stats() ?? { days: 0, bytes: 0, count: 0 });
  }, []);

  /**
   * 「清空缓存」清的是体积大的转换产物；首帧图故意留着（见 `lib/cache.ts`），
   * 不然清完列表整片变黑块。顺手把"这个文件读不出来"的记忆清掉：清空之后
   * 每张都会重新走一遍取图流程，设备这会儿能读的话就该读到。
   */
  const clearCache = useCallback(async (): Promise<void> => {
    await cacheRef.current?.clear();
    posterFailuresRef.current.clear();
    setCacheStats((await cacheRef.current?.stats()) ?? { count: 0, bytes: 0 });
  }, []);

  return {
    connection,
    error,
    notice,
    info,
    items,
    playback,
    progress,
    cacheStats,
    snapshotReason,
    listLoading,
    canEdit,
    canvasSize,
    sources: sourcesRef.current,
    pickPort,
    reconnect,
    disconnect,
    refresh,
    convertForUpload,
    uploadConverted,
    removeItem,
    setSkip,
    reorder,
    updateItemParams,
    logs,
    logStats,
    clearLogs,
    playPlaylist,
    stopPlayback,
    cancelTransfer,
    loadPreview,
    clearCache,
    clearError: () => setError(null),
    clearNotice: () => setNotice(null),
  };
}

/** 按索引里的顺序排（索引里没有的排后面） */
function orderItems(items: MediaItem[], index: MediaIndex): void {
  const order = new Map(index.entries.map((entry, at) => [entryFileName(entry), at]));
  items.sort(
    (a, b) => (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER),
  );
}
