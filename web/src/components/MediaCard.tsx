'use client';

import { Eye, EyeOff, ListVideo, Settings2, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ClampedBytes } from '@/lib/bytes';
import { bytesLabel } from '@/lib/format';
import { formatLoops } from '@/lib/loops';
import type { Preview } from '@/lib/preview';
import { PLAYBACK_POLL_MS, type MediaItem } from '@/lib/useDevice';

/** hover 之后等这么久才真的去读卡（毫秒）：鼠标扫过一排卡片时不该把整屏都排队回传 */
const HOVER_DELAY_MS = 250;

/** 预览遮罩上的文案：`busy` 是卡片唯一一条状态，清它的时候得认准是自己这条 */
const PREVIEW_BUSY = '准备预览…';

interface Props {
  item: MediaItem;
  index: number;
  playing: boolean;
  /** 正在播这张时的**整体**进度（0..100，跨所有轮次）；null = 没有进度可显示 */
  progress: number | null;
  canEdit: boolean;
  dragging: boolean;
  onPlayFrom: (name: string) => Promise<void>;
  /** 正在播这张时按钮变成"停止播放"，和头部的全局停止是同一个动作 */
  onStop: () => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onToggleSkip: (name: string, skip: boolean) => Promise<void>;
  onSettings: (name: string) => void;
  onLoadPreview: (name: string) => Promise<Preview>;
  onDragStart: (name: string) => void;
  onDragEnd: () => void;
  onDropOn: (name: string) => void;
}

export function MediaCard({
  item,
  index,
  playing,
  progress,
  canEdit,
  dragging,
  onPlayFrom,
  onStop,
  onDelete,
  onToggleSkip,
  onSettings,
  onLoadPreview,
  onDragStart,
  onDragEnd,
  onDropOn,
}: Props) {
  /**
   * 预览区的宽高比：用条目自己的画布尺寸。
   *
   * 画布随屏幕变（C6 是 312x164、S3 是 472x312），所以**不能写死**某一块板的比例；
   * 索引里有尺寸就用它，没有就用首帧图，最后才退回 16:9。
   */
  const previewWidth = item.meta?.width ?? item.poster?.width ?? 16;
  const previewHeight = item.meta?.height ?? item.poster?.height ?? 9;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverTimer = useRef(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [animating, setAnimating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState(false);
  /** 鼠标/手指此刻还在卡片上吗（决定"播放结束"时要不要把 hover 预览一起停掉） */
  const hoveredRef = useRef(false);
  /** 这次动画是不是"因为正在播"自动开的 */
  const autoPreviewRef = useRef(false);
  /** 上一次画出去的进度：用来判断这次是"继续涨"还是"回退" */
  const lastProgress = useRef<number | null>(null);
  const previous = lastProgress.current;
  lastProgress.current = progress;
  /** 前进（或第一次）才补间；回退直接跳，免得无限循环时每轮倒着扫一遍 */
  const transitionMs =
    progress === null || previous === null || progress >= previous ? PLAYBACK_POLL_MS : 0;
  /** 自动预览只拉一次（`onLoadPreview` 每次 render 都是新函数，别拿它当依赖反复重拉） */
  const autoLoadedRef = useRef(false);
  const previewLoaderRef = useRef(onLoadPreview);
  previewLoaderRef.current = onLoadPreview;

  const drawFrame = useCallback((rgba: ClampedBytes, width: number, height: number) => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.putImageData(new ImageData(rgba, width, height), 0, 0);
  }, []);

  const drawPoster = useCallback(() => {
    if (!item.poster) return;
    drawFrame(item.poster.data, item.poster.width, item.poster.height);
  }, [drawFrame, item.poster]);

  useEffect(() => {
    drawPoster();
  }, [drawPoster]);

  // hover 播放：按每帧 delay 循环（GIF 一般是不停循环的）。
  //
  // 但**只读了开头一段**的预览（`complete === false`，见 `loadPreview`）不能循环 ——
  // 那会变成"前几帧反复播"，看起来像文件坏了。这种播完就停在最后一帧。
  useEffect(() => {
    if (!animating || !preview || preview.frames.length === 0) return;
    let cancelled = false;
    let timer = 0;
    let at = 0;
    const step = () => {
      if (cancelled) return;
      if (!preview.complete && at >= preview.frames.length) return; // 半份数据：播一遍就停
      const frame = preview.frames[at % preview.frames.length];
      at += 1;
      drawFrame(frame.rgba, preview.width, preview.height);
      timer = window.setTimeout(step, Math.min(Math.max(frame.delayMs, 10), 1000));
    };
    step();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [animating, preview, drawFrame]);

  // 正在播的那张：不用 hover 也把预览跑起来（拿不到整份文件时就算了，留首帧）
  useEffect(() => {
    if (!playing) {
      autoLoadedRef.current = false;
      if (!autoPreviewRef.current) return;
      autoPreviewRef.current = false;
      setAnimating(hoveredRef.current);
      if (!hoveredRef.current) drawPoster();
      return;
    }
    if (preview) {
      autoPreviewRef.current = true;
      setAnimating(true);
      return;
    }
    if (autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    void (async () => {
      try {
        const loaded = await previewLoaderRef.current(item.name);
        if (loaded.frames.length === 0) return;
        setPreview(loaded);
        autoPreviewRef.current = true;
        setAnimating(true);
      } catch {
        /* 设备正在播的时候读不了卡：拿不到就继续显示首帧，不打扰用户 */
      }
    })();
  }, [drawPoster, item.name, playing, preview]);

  const handleEnter = useCallback(() => {
    hoveredRef.current = true;
    if (preview) {
      setAnimating(true);
      return;
    }
    hoverTimer.current = window.setTimeout(() => {
      void (async () => {
        setBusy(PREVIEW_BUSY);
        try {
          const loaded = await onLoadPreview(item.name);
          if (loaded.frames.length > 0) {
            setPreview(loaded);
            // 等这份数据的时候鼠标可能已经移开了：移开了就别再让它动起来
            // （预览留着，下次 hover 直接播）
            if (hoveredRef.current) setAnimating(true);
          }
        } catch {
          /* 预览失败不影响卡片上的其它功能 */
        } finally {
          setBusy((current) => (current === PREVIEW_BUSY ? null : current));
        }
      })();
    }, HOVER_DELAY_MS);
  }, [item.name, onLoadPreview, preview]);

  const handleLeave = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    hoveredRef.current = false;
    // 遮罩归 hover 管：读卡慢的时候不能让它一直挂在卡片上（读还在飞，但界面已经离开了）。
    // 只清自己那一条：`busy` 也被"删除中…"这类动作共用着。
    setBusy((current) => (current === PREVIEW_BUSY ? null : current));
    // 正在播的卡片继续跑预览（hover 进来/出去的行为本身没变）
    if (playing) return;
    setAnimating(false);
    drawPoster();
  }, [drawPoster, playing]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }, []);

  // 卡片上只报"这条素材怎么样"：帧数 / 轮数 / 大小。
  // 源文件名和"第几段"不展示 —— 从同一张 WebP 精灵图拆出来的多张卡片，
  // 画面本身就能区分，名字和段号只会把这一行撑长。
  const detail = [
    item.meta?.kind === 'anim' ? `${item.meta.frames} 帧` : '静图',
    item.meta?.loops !== undefined ? formatLoops(item.meta.loops) : null,
    bytesLabel(item.size),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card
      draggable={canEdit}
      onDragStart={(event) => {
        if (!canEdit) return;
        event.dataTransfer.effectAllowed = 'move';
        onDragStart(item.name);
      }}
      onDragEnd={() => {
        setDropTarget(false);
        onDragEnd();
      }}
      onDragOver={(event) => {
        if (!canEdit) return;
        event.preventDefault();
        setDropTarget(true);
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        if (!canEdit) return;
        event.preventDefault();
        setDropTarget(false);
        onDropOn(item.name);
      }}
      className={[
        'gap-0 overflow-hidden py-0 transition-opacity',
        canEdit ? 'cursor-grab active:cursor-grabbing' : '',
        dragging ? 'opacity-40' : '',
        dropTarget ? 'ring-ring ring-2' : '',
        playing ? 'ring-2 ring-emerald-500' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* 预览只在**图片区域**上触发：hover 到下面的按钮/信息行不动它。
          宽高比按条目自己的尺寸来（画布尺寸随屏幕变：C6 是 312x164，S3 是 472x312），
          而不是写死某一块板的屏幕比例 —— 换板子不用改前端。 */}
      <div
        className="relative flex items-center justify-center bg-black"
        style={{ aspectRatio: `${previewWidth} / ${previewHeight}` }}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <canvas ref={canvasRef} className="max-h-full max-w-full [image-rendering:pixelated]" />
        <Badge variant="secondary" className="absolute top-1.5 left-1.5 font-mono text-[10px]">
          #{index + 1}
        </Badge>
        {/* 右上角：跳过/恢复（只有图标，说明放 tooltip 里，免得在图上压一大片） */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={item.skip ? '恢复' : '跳过'}
              disabled={!canEdit}
              className="absolute top-1.5 right-1.5 bg-black/55 text-white hover:bg-black/70 hover:text-white"
              onClick={() => void onToggleSkip(item.name, !item.skip)}
            >
              {item.skip ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{item.skip ? '恢复' : '跳过'}</TooltipContent>
        </Tooltip>
        {/* 状态徽标挪到右下角（在进度条上方），给跳过按钮让出右上角 */}
        {playing ? (
          <Badge className="absolute right-1.5 bottom-2 bg-emerald-600 text-[10px] text-white">正在播放</Badge>
        ) : item.skip ? (
          <Badge variant="secondary" className="text-muted-foreground absolute right-1.5 bottom-2 text-[10px]">
            已跳过
          </Badge>
        ) : null}
        {playing && progress !== null ? (
          // 贴在图片底边：absolute 定位，不占布局高度，卡片整体高度不变。
          // 过渡时长 = 轮询间隔：设备 1.5 秒才报一次帧号，靠这条线性过渡把两次上报之间
          // 的差距补成"一直在涨"；进度回退时（无限循环换轮、从头再播）不补，直接跳回去。
          <div aria-hidden className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div
              className="h-full bg-emerald-500 transition-[width] ease-linear"
              style={{ width: `${progress}%`, transitionDuration: `${transitionMs}ms` }}
            />
          </div>
        ) : null}
        {busy ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-xs text-white">
            {busy}
          </div>
        ) : null}
      </div>

      {/* 这一行不换行：设置（齿轮）和删除必须跟"从此播放"在同一行上 */}
      <div className="flex items-center gap-1 border-t p-2 pb-0">
        {/* 正在播这张：同一个位置变成"停止播放"，播放中也允许点（其它卡片仍然禁用） */}
        <Button
          size="sm"
          variant={playing ? 'secondary' : 'ghost'}
          className="whitespace-nowrap"
          disabled={!canEdit && !playing}
          onClick={() =>
            void run(playing ? '停止中…' : '启动中…', () => (playing ? onStop() : onPlayFrom(item.name)))
          }
        >
          {playing ? <Square className="size-3.5" /> : <ListVideo className="size-3.5" />}
          {playing ? '停止播放' : '从此播放'}
        </Button>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label="设置布局与循环"
            disabled={!canEdit}
            onClick={() => onSettings(item.name)}
          >
            <Settings2 className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="text-destructive hover:text-destructive hover:bg-destructive/10 size-8"
            aria-label="删除"
            disabled={!canEdit}
            onClick={() => {
              if (window.confirm('确定要删掉这张吗？')) void run('删除中…', () => onDelete(item.name));
            }}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="text-muted-foreground px-2 pl-5 pb-2 text-[11px]">{detail}</div>
    </Card>
  );
}
