'use client';

import { Check, Plus, RotateCcw, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { bytesLabel } from '@/lib/format';
import { makeThumbnail } from '@/lib/thumbnail';
import { DEFAULT_CONVERT_OPTIONS } from '@/lib/convert';
import type { useDevice } from '@/lib/useDevice';
import { UploadQueue, type UploadItem, type UploadStatus } from '@/lib/upload-queue';

interface Props {
  device: ReturnType<typeof useDevice>;
  onFinished: (count: number) => void;
  /**
   * 上传队列在跑（转换中 / 排队中 / 传输中）时通知上层。
   * 上层拿它禁掉别的操作 —— 串口是一问一答的，上传途中点播放/删除只会互相打架。
   */
  onBusyChange?: (busy: boolean) => void;
}

const RING = { size: 44, stroke: 3 };

function ProgressRing({ value, status }: { value: number; status: UploadStatus }) {
  const radius = (RING.size - RING.stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(Math.max(value, 0), 1);
  const color =
    status === 'failed'
      ? 'stroke-destructive'
      : status === 'done'
        ? 'stroke-emerald-500'
        : 'stroke-primary';

  return (
    <svg width={RING.size} height={RING.size} viewBox={`0 0 ${RING.size} ${RING.size}`} className="-rotate-90">
      <circle cx={RING.size / 2} cy={RING.size / 2} r={radius} className="stroke-muted" strokeWidth={RING.stroke} fill="none" />
      <circle
        cx={RING.size / 2}
        cy={RING.size / 2}
        r={radius}
        className={color}
        strokeWidth={RING.stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${circumference * clamped} ${circumference}`}
      />
    </svg>
  );
}

function Tile({
  item,
  thumb,
  removable,
  onRetry,
  onRemove,
}: {
  item: UploadItem;
  thumb: string | undefined;
  /** 还没开始上传时，hover 中间露出"移除"按钮 */
  removable: boolean;
  onRetry: () => void;
  onRemove: () => void;
}) {
  // 只有真正在传的那一项才画进度环；待上传 / 转换中不画
  const uploadingThis = item.status === 'uploading';
  const preparing = item.status === 'preparing' || item.status === 'ready';
  const done = item.status === 'done';
  const failed = item.status === 'failed';
  const dimmed = uploadingThis || preparing || done || failed;

  const label = failed ? '失败' : done ? '完成' : preparing ? '转换中' : '待上传';
  const outputs = item.payloads?.length ?? 0;
  const currentOutput = outputs > 1 ? Math.min(item.uploadedOutputs + 1, outputs) : 0;

  return (
    <div className="group bg-muted relative aspect-square overflow-hidden rounded-lg border">
      {thumb ? <img src={thumb} alt="" className="size-full object-contain object-center" /> : null}

      {dimmed ? (
        <div className="bg-background/70 absolute inset-0 flex flex-col items-center justify-center gap-1">
          {done ? <Check className="size-6 text-emerald-500" /> : null}
          {failed ? <span className="text-destructive text-[11px]">{label}</span> : null}
          {uploadingThis ? (
            <>
              <ProgressRing value={item.progress} status="uploading" />
              <span className="text-[11px]">{Math.round(item.progress * 100)}%</span>
              {outputs > 1 ? (
                <span className="text-[10px]">
                  第 {currentOutput}/{outputs} 段
                </span>
              ) : null}
            </>
          ) : null}
          {preparing ? <span className="text-muted-foreground text-[11px]">{label}</span> : null}
        </div>
      ) : null}

      {failed ? (
        <Button
          size="sm"
          variant="destructive"
          className="absolute inset-x-1 bottom-1 h-6 text-[11px]"
          onClick={onRetry}
        >
          <RotateCcw className="size-3" />
          重试
        </Button>
      ) : null}

      {removable && item.status === 'pending' ? (
        <button
          type="button"
          aria-label={`移除 ${item.file.name}`}
          className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={onRemove}
        >
          <X className="size-6 text-white" />
        </button>
      ) : null}

      <span className="absolute top-1 left-1 max-w-[90%] truncate rounded bg-black/60 px-1 text-[10px] text-white">
        {item.file.name}
      </span>
    </div>
  );
}

export function UploadPanel({ device, onFinished, onBusyChange }: Props) {
  const deviceRef = useRef(device);
  deviceRef.current = device;
  const inputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<UploadQueue | null>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [draggingOver, setDraggingOver] = useState(false);

  const ensureQueue = useCallback((): UploadQueue => {
    if (!queueRef.current) {
      queueRef.current = new UploadQueue({
        // 每个文件轮到它时才转换；参数用默认值（布局/循环之后可以单张再改）
        convert: (file) =>
          deviceRef.current.convertForUpload(file, {
            ...DEFAULT_CONVERT_OPTIONS,
            ...deviceRef.current.canvasSize,
          }),
        upload: (item, media, onProgress) => deviceRef.current.uploadConverted(item.file, media, onProgress),
        // 取消：让设备停在当前这一槽（v9 `media/abort`），半截文件由板子删
        cancelTransfer: () => deviceRef.current.cancelTransfer(),
        onChange: setItems,
      });
    }
    return queueRef.current;
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      const queue = ensureQueue();
      const before = new Set(queue.items.map((item) => item.id));
      queue.add(list);
      for (const item of queue.items) {
        if (before.has(item.id)) continue;
        void makeThumbnail(item.file).then((url) => {
          if (!url) return;
          setThumbs((current) => ({ ...current, [item.id]: url }));
        });
      }
    },
    [ensureQueue],
  );

  const reset = useCallback(() => {
    queueRef.current?.clear();
    queueRef.current = null;
    setThumbs({});
  }, []);

  const start = useCallback(async () => {
    const queue = ensureQueue();
    const count = await queue.run();
    onFinished(count);
  }, [ensureQueue, onFinished]);

  const uploading = items.some((item) => item.status === 'preparing' || item.status === 'uploading');
  /** 整条队列还在干活：转换 / 等上传 / 正在传，都算"忙" */
  const busy = items.some(
    (item) => item.status === 'preparing' || item.status === 'ready' || item.status === 'uploading',
  );
  const failed = items.filter((item) => item.status === 'failed').length;

  // 把"忙"报给上层（回调每次 render 都是新函数，用 ref 存着，别让它当 effect 依赖）
  const busyListener = useRef(onBusyChange);
  busyListener.current = onBusyChange;
  useEffect(() => {
    busyListener.current?.(busy);
  }, [busy]);
  useEffect(() => () => busyListener.current?.(false), []);

  // 全部成功 → 稍等一下让对勾看得见，然后恢复初始 UI
  useEffect(() => {
    if (items.length === 0 || uploading || failed > 0) return;
    if (!items.every((item) => item.status === 'done')) return;
    const timer = window.setTimeout(reset, 1200);
    return () => window.clearTimeout(timer);
  }, [failed, items, reset, uploading]);

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/gif,image/png,image/jpeg,image/webp,image/bmp"
      multiple
      hidden
      onChange={(event) => {
        if (event.target.files) addFiles(event.target.files);
        event.target.value = '';
      }}
    />
  );

  if (items.length === 0) {
    return (
      <div
        className={[
          'flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center transition-colors',
          draggingOver ? 'border-primary bg-accent/40' : 'border-border',
          device.canEdit ? '' : 'opacity-50',
        ].join(' ')}
        onDragOver={(event) => {
          event.preventDefault();
          setDraggingOver(true);
        }}
        onDragLeave={() => setDraggingOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDraggingOver(false);
          if (event.dataTransfer.files) addFiles(event.dataTransfer.files);
        }}
      >
        {fileInput}
        <Button disabled={!device.canEdit} onClick={() => inputRef.current?.click()}>
          <Upload className="size-4" />
          选择文件
        </Button>
        <p className="text-muted-foreground text-xs">或者将文件拖放至此处（支持多文件）</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border p-3">
      {fileInput}
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {items.map((item) => (
          <Tile
            key={item.id}
            item={item}
            thumb={thumbs[item.id]}
            removable={!uploading}
            onRemove={() => {
              queueRef.current?.remove(item.id);
              setThumbs((current) => {
                const next = { ...current };
                delete next[item.id];
                return next;
              });
            }}
            onRetry={() => {
              queueRef.current?.retry(item.id);
              void queueRef.current?.run();
            }}
          />
        ))}
        <button
          type="button"
          className="text-muted-foreground hover:border-primary hover:text-foreground flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed transition-colors"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          <Plus className="size-5" />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => void start()} disabled={uploading || items.length === 0}>
          <Upload className="size-4" />
          {uploading ? '上传中…' : '上传文件'}
        </Button>
        {failed > 0 ? (
          <Button
            variant="outline"
            onClick={() => {
              queueRef.current?.retryFailed();
              void queueRef.current?.run();
            }}
            disabled={uploading}
          >
            <RotateCcw className="size-4" />
            重试失败项
          </Button>
        ) : null}
        {uploading ? (
          <Button variant="outline" onClick={() => void queueRef.current?.requestCancel()}>
            <X className="size-4" />
            取消上传
          </Button>
        ) : null}
        <Button variant="ghost" onClick={reset} disabled={uploading}>
          <X className="size-4" />
          清空
        </Button>
        <span className="text-muted-foreground text-xs">
          {items.filter((item) => item.status === 'done').length}/{items.length} 完成 · 共{' '}
          {bytesLabel(items.reduce((sum, item) => sum + item.file.size, 0))}
        </span>
      </div>
    </div>
  );
}
