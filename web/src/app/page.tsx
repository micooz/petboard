'use client';

import { useEffect, useRef } from 'react';

import { ConnectionGate } from '@/components/ConnectionGate';
import { LibraryView } from '@/components/LibraryView';
import { useDevice } from '@/lib/useDevice';
import { initWasm } from '@/lib/wasm';

export default function Page() {
  const device = useDevice();
  const tried = useRef(false);
  const reconnectRef = useRef(device.reconnect);
  reconnectRef.current = device.reconnect;

  // 之前授权过的串口会被浏览器记着，进页面直接连
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    if (typeof navigator === 'undefined' || !navigator.serial) return;
    void reconnectRef.current();
  }, []);

  // 格式实现是 WASM（和板子跑的同一份代码）：一挂载就去取。
  // 取不到不在界面上喊 —— 之后每次转换/预览都会明确报"格式 WASM 还没加载完"；
  // 但这里得留一条日志，否则启动失败在浏览器里完全查不到线索。
  useEffect(() => {
    initWasm().catch((err: unknown) => {
      console.error('格式 WASM 加载失败', err);
    });
  }, []);

  if (device.connection === 'connected') return <LibraryView device={device} />;

  return (
    <ConnectionGate
      connection={device.connection}
      error={device.error}
      onPickPort={() => void device.pickPort()}
    />
  );
}
