'use client';

import { Usb } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { ThemeToggle } from './theme-toggle';
import type { Connection } from '@/lib/useDevice';

interface Props {
  connection: Connection;
  error: string | null;
  onPickPort: () => void;
}

const BROWSER_HINT =
  '支持 Chrome 89+ / Edge / Firefox 151+ 桌面浏览器；Chrome 148+ 安卓手机浏览器；不支持 Safari 桌面和 iOS 浏览器。';

export function ConnectionGate({ connection, error, onPickPort }: Props) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Pet Board v1.0</h1>
        <ThemeToggle />
      </div>

      {connection === 'unsupported' ? (
        <Alert>
          <AlertTitle>这个浏览器用不了</AlertTitle>
          <AlertDescription>{BROWSER_HINT}</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>连接设备</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
              <li>用 USB-C 线将设备连接至电脑。</li>
              <li>点击下面的按钮选择一个串行端口（通常包含 usb 三个字）。</li>
            </ol>
            <div>
              <Button onClick={onPickPort} disabled={connection === 'connecting'}>
                <Usb className="size-4" />
                {connection === 'connecting' ? '连接中…' : '选择串口'}
              </Button>
            </div>
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>连不上</AlertTitle>
                <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
              </Alert>
            ) : null}
            <p className="text-muted-foreground text-xs">{BROWSER_HINT}</p>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
