'use client';

import { Play, Settings, Square, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { itemProgressPercent } from '@/lib/playback';
import { isPlayable } from '@/lib/playlist';
import type { useDevice } from '@/lib/useDevice';

import { ItemSettings } from './ItemSettings';
import { LibrarySkeleton } from './LibrarySkeleton';
import { MediaCard } from './MediaCard';
import { SettingsSheet } from './SettingsSheet';
import { ThemeToggle } from './theme-toggle';
import { UploadPanel } from './UploadPanel';

interface Props {
  device: ReturnType<typeof useDevice>;
}

export function LibraryView({ device }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsItem, setSettingsItem] = useState<string | null>(null);
  const [dragName, setDragName] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const connected = device.connection === 'connected';
  const playing = device.playback.playing;
  /** 上传队列在跑：这期间别的操作一律禁掉（播放 / 删除 / 改设置 / 拖拽排序） */
  const [uploadBusy, setUploadBusy] = useState(false);
  const canEdit = device.canEdit && !uploadBusy;
  // 卡上有文件 ≠ 播放清单非空：静图和被跳过的都不写进 data/PLAYLIST
  const canPlay = device.items.some((item) => item.meta !== null && isPlayable(item.meta));
  // 只报"在播 + 是清单里的第几项"，第几轮不展示（卡片上的进度条已经说明走到哪了）；
  // 单文件播放时固件报的 total 是 1，那种情况不写"第 1/1 项"
  const progressLabel = [
    '正在播放',
    device.playback.total > 1 ? `第 ${device.playback.index}/${device.playback.total} 项` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // 播放期间不允许改设置：对话框开着时设备开始播（别的页面点了、或轮询才发现）就直接关掉
  useEffect(() => {
    if (playing) setSettingsItem(null);
  }, [playing]);

  const guard = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <main className="mx-auto max-w-5xl px-4 pb-16 pt-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Pet Board v1.0</h1>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="设置" onClick={() => setSettingsOpen(true)}>
                <Settings className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>设置</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {!connected ? (
        <Alert variant="destructive" className="mb-3">
          <TriangleAlert />
          <AlertTitle>串口没有连接</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{device.notice ?? '设备可能被拔掉了，或者被别的程序占着串口。'}</span>
            <Button size="sm" variant="outline" onClick={() => void device.reconnect()}>
              重新连接
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {device.notice && connected ? (
        <Alert className="mb-3">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{device.notice}</span>
            <Button size="sm" variant="ghost" onClick={() => device.clearNotice()}>
              知道了
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {actionError ? (
        <Alert variant="destructive" className="mb-3">
          <AlertTitle>操作没成功</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{actionError}</span>
            <Button size="sm" variant="ghost" onClick={() => setActionError(null)}>
              关闭
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {uploadNotice ? (
        <Alert className="mb-3">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{uploadNotice}</span>
            <Button size="sm" variant="ghost" onClick={() => setUploadNotice(null)}>
              关闭
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mb-6">
        <UploadPanel
          device={device}
          onBusyChange={setUploadBusy}
          onFinished={(count) => {
            setUploadNotice(`上传完成：${count} 个素材`);
            void device.refresh();
          }}
        />
      </div>

      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-base font-semibold">播放列表</h2>
        <div className="ml-auto flex items-center gap-2">
          {/* 进度就贴在按钮左边；文件名在列表里已经能看到 */}
          {playing ? <span className="text-muted-foreground font-mono text-xs">{progressLabel}</span> : null}
          {/* 同一个按钮两个状态："播放"整张清单 / "停止" */}
          {playing ? (
            <Button size="sm" variant="outline" onClick={() => void guard(() => device.stopPlayback())}>
              <Square className="size-3.5" />
              停止
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!connected || !canPlay || uploadBusy}
              onClick={() => void guard(() => device.playPlaylist())}
            >
              <Play className="size-3.5" />
              播放
            </Button>
          )}
        </div>
      </div>

      {/* 读卡失败时列表是上次读到的快照：说清楚，并把下一步动作放出来 */}
      {connected && device.snapshotReason === 'read-error' ? (
        <Alert className="mb-3">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>设备暂时读不了卡，当前显示本机快照。</span>
            <Button size="sm" variant="outline" onClick={() => void guard(() => device.refresh(true))}>
              重试读卡
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {device.items.length === 0 ? (
        device.listLoading ? (
          <LibrarySkeleton
            aspect={`${device.canvasSize.width} / ${device.canvasSize.height}`}
          />
        ) : (
          <p className="text-muted-foreground py-12 text-center text-sm">还没有文件，请先上传。</p>
        )
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {device.items.map((item, index) => (
            <MediaCard
              key={item.name}
              item={item}
              index={index}
              playing={playing && device.playback.item === item.name}
              progress={
                device.playback.item === item.name
                  ? itemProgressPercent(
                      item.meta?.loops ?? 1,
                      device.playback.loop,
                      device.playback.frame,
                      device.playback.frames,
                    )
                  : null
              }
              canEdit={canEdit}
              dragging={dragName === item.name}
              onDragStart={setDragName}
              onDragEnd={() => setDragName(null)}
              onDropOn={(target) => {
                if (dragName && dragName !== target) void guard(() => device.reorder(dragName, target));
                setDragName(null);
              }}
              onPlayFrom={(name) => guard(() => device.playPlaylist(name))}
              onStop={() => guard(() => device.stopPlayback())}
              onDelete={(name) => guard(() => device.removeItem(name))}
              onToggleSkip={(name, skip) => guard(() => device.setSkip(name, skip))}
              onSettings={setSettingsItem}
              onLoadPreview={(name) => device.loadPreview(name)}
            />
          ))}
        </div>
      )}

      <SettingsSheet device={device} open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ItemSettings device={device} name={settingsItem} onClose={() => setSettingsItem(null)} />
    </main>
  );
}
