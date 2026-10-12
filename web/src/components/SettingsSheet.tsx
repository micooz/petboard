'use client';

import { DeviceLogDialog } from '@/components/DeviceLogDialog';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { bytesLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { useDevice } from '@/lib/useDevice';

interface Props {
  device: ReturnType<typeof useDevice>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 一行"标签 — 值"。左侧多给一点缩进，和上面的小节标题拉开层次。
 * 值一律用等宽字体，MAC / 容量 / 字节数这些看起来才整齐。
 */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 pl-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-xs text-right">{value}</span>
    </div>
  );
}

/**
 * 一行"标签 — 值 + 右侧按钮"：「本地存储」里缓存和日志两项用同一种排版，
 * 按钮都贴在这一行的右端，和上面的值对齐。
 */
function RowAction({ label, value, action }: { label: string; value: React.ReactNode; action: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 pl-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs">{value}</span>
        {action}
      </div>
    </div>
  );
}

/**
 * "标签在上、值在下"的一段 —— 给 `reset` 原因、`io` 计数这类**长且要看全**的值用。
 *
 * `Row` 是左标签右值的一行排版，长值会挤成两行还看不清；诊断信息宁可占一行高度。
 */
function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 pl-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-xs break-all">{value}</span>
    </div>
  );
}

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col px-4 pt-2', className)}>
      <h3 className="text-muted-foreground pb-1 text-xs font-medium">{title}</h3>
      {children}
    </section>
  );
}

export function SettingsSheet({ device, open, onOpenChange }: Props) {
  const info = device.info;
  const [logsOpen, setLogsOpen] = useState(false);
  const logStats = device.logs
    ? `${device.logStats.days} 天 / ${bytesLabel(device.logStats.bytes)}`
    : '不可用';
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* gap-0：小节之间的间距自己控制，免得标题下面空一大块 */}
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="pb-2">
          <SheetTitle>设置</SheetTitle>
        </SheetHeader>

        <Section title="设备信息">
          <Row label="设备标识" value={info?.id ?? '—'} />
          <Separator />
          <Row label="通信协议" value={info ? `v${info.api}` : '—'} />
          <Separator />
          <Row label="存储卡" value={info?.sd ?? '—'} />
        </Section>

        {/*
          诊断：这两项是"板子这次开机健不健康"的唯一证据。
          `reset` 是本次启动的原因（`USB-UART`/`USB-JTAG` = 电脑那边发起的复位，
          `power-on` = 刚插过电）；`io` 是 `media/get` 的失败计数，`TX 卡死` 不为 0
          说明回传时发送通道真的卡过 —— 那也是"拔插一次 USB 线"就能好的那种毛病。
        */}
        <Section title="诊断" className="mt-2 border-t pt-3">
          <Metric label="本次启动原因" value={info?.reset || '—'} />
          <Separator />
          <Metric
            label="回传失败（本次开机累计）"
            value={
              info
                ? `${info.io.failed} 次 · TX 卡死 ${info.io.txStuck} · 无回执 ${info.io.ackTimeout} · 主机离开 ${info.io.hostLeft} · 补发 ${info.io.resends} 块`
                : '—'
            }
          />
          {info && info.io.txStuck > 0 ? (
            <p className="text-muted-foreground pb-2 pl-2 text-xs">
              回传时发送通道卡过 {info.io.txStuck} 次。界面要是跟着卡住不回话，拔插一次 USB 线即可恢复。
            </p>
          ) : null}
        </Section>

        <Section title="本地存储" className="mt-2 border-t pt-3">
          <RowAction
            label="已缓存文件"
            value={
              device.cacheStats
                ? `${device.cacheStats.count} 个 / ${bytesLabel(device.cacheStats.bytes)}`
                : '不可用'
            }
            action={
              <Button
                size="sm"
                variant="outline"
                disabled={!device.cacheStats || device.cacheStats.count === 0}
                onClick={() => void device.clearCache()}
              >
                清空
              </Button>
            }
          />
          <Separator />
          <RowAction
            label="设备日志"
            value={logStats}
            action={
              <Button size="sm" variant="outline" disabled={!device.logs} onClick={() => setLogsOpen(true)}>
                查看
              </Button>
            }
          />
          <Separator />
        </Section>

        <div className="mt-4 flex flex-wrap gap-2 px-4 pb-4">
          <Button
            variant="destructive"
            onClick={() => {
              void device.disconnect();
              onOpenChange(false);
            }}
          >
            断开设备
          </Button>
        </div>
      </SheetContent>
      <DeviceLogDialog logs={device.logs} open={logsOpen} onOpenChange={setLogsOpen} />
    </Sheet>
  );
}
