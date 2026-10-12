'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { Fit } from '@/lib/encode/image';
import { DEFAULT_LOOPS, LOOPS_INFINITE, MAX_LOOPS, normalizeLoops } from '@/lib/loops';
import { REUPLOAD_PROGRESS_LABEL, type useDevice } from '@/lib/useDevice';

interface Props {
  device: ReturnType<typeof useDevice>;
  name: string | null;
  onClose: () => void;
}

export function ItemSettings({ device, name, onClose }: Props) {
  const item = name ? device.items.find((entry) => entry.name === name) : undefined;
  const [fit, setFit] = useState<Fit>('contain');
  const [loops, setLoops] = useState(DEFAULT_LOOPS);
  const [infinite, setInfinite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setFit((item.meta?.fit as Fit) ?? 'contain');
    const loops = item.meta?.loops ?? DEFAULT_LOOPS;
    setInfinite(loops === 0);
    setLoops(loops === 0 ? DEFAULT_LOOPS : loops);
    setError(null);
  }, [item]);

  // 改布局要重新转换 + 重新上传；只改循环是"纯改索引"，不碰卡上的文件
  const savedFit = (item?.meta?.fit as Fit) ?? 'contain';
  const fitChanged = item !== undefined && fit !== savedFit;
  /** 只有"改布局又缺原图"才做不了；只改循环不需要原图 */
  const blocked = fitChanged && !item?.hasSource;
  /** 播放期间禁止改设置（按钮入口也会禁掉，这里兜底挡住"对话框开着时开始播"） */
  const playing = device.playback.playing;

  // 这次重新上传的进度（分块发完一块刷一次）；没轮到上传阶段时是 null
  const progress = fitChanged && device.progress?.label === REUPLOAD_PROGRESS_LABEL ? device.progress : null;
  const percent = progress && progress.total > 0 ? Math.floor((progress.sent / progress.total) * 100) : null;

  const apply = async () => {
    if (!name || playing) return;
    setBusy(true);
    setError(null);
    try {
      await device.updateItemParams(name, {
        fit,
        loops: infinite ? LOOPS_INFINITE : normalizeLoops(loops),
      });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={name !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>布局与循环</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label>布局</Label>
            <Select value={fit} onValueChange={(value) => setFit(value as Fit)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="contain">contain（完整显示，四周留黑）</SelectItem>
                <SelectItem value="cover">cover（铺满，超出裁掉）</SelectItem>
                <SelectItem value="fill">fill（拉伸变形）</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>循环次数</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={MAX_LOOPS}
                value={loops}
                disabled={infinite}
                onChange={(event) => setLoops(Math.max(1, Number(event.target.value) || 1))}
                className="w-24"
              />
              <div className="flex items-center gap-2">
                <Switch checked={infinite} onCheckedChange={setInfinite} id="loops-infinite" />
                <Label htmlFor="loops-infinite" className="font-normal">
                  无限循环（需手动停止）
                </Label>
              </div>
            </div>
          </div>

          {playing ? (
            <Alert>
              <AlertDescription>设备正在播放，先停止播放再改设置。</AlertDescription>
            </Alert>
          ) : null}
          {blocked ? (
            <Alert>
              <AlertDescription>
                改布局要用本机保存的原图重新生成，而本机没有这个素材的原图。请把原始文件重新拖进上传区
                （会生成一张新的）—— 只改循环次数不需要原图。
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          {/* 进度画在按钮里当背景条带：文案固定成"应用"，宽度也就不会忽宽忽窄；
              还没有具体百分比时（改循环那种秒回的操作）用一条脉动的满宽条表示在处理 */}
          <Button
            className="relative overflow-hidden"
            onClick={() => void apply()}
            disabled={busy || blocked || playing}
          >
            {busy ? (
              <span
                aria-hidden
                className={`bg-primary-foreground/40 pointer-events-none absolute inset-y-0 left-0 ${
                  percent === null ? 'w-full animate-pulse' : 'transition-[width] duration-150'
                }`}
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            ) : null}
            {/* 转圈和文案都要 `relative`：背景条带是 absolute，会盖在普通内容上面 */}
            {busy ? <Loader2 aria-hidden className="relative size-3.5 animate-spin" /> : null}
            <span className="relative">应用</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
