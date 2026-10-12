import { describe, expect, it } from 'vitest';

import {
  isLastGoodPort,
  LAST_GOOD_PORT_KEY,
  markLastGoodPort,
  portIdentity,
  type KeyValueStore,
} from '@/lib/last-good-port';

function memoryStore(): KeyValueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

/** 假端口：Web Serial 的 `SerialPort` 只需要 `getInfo()` */
function port(usbVendorId?: number, usbProductId?: number) {
  return { getInfo: () => ({ usbVendorId, usbProductId }) };
}

describe('"这条串口刚才还通"的标记', () => {
  it('握过手的端口认得出来，别的端口认不出来', () => {
    const store = memoryStore();
    const board = port(0x303a, 0x1001);
    markLastGoodPort(board, store);
    expect(store.values.get(LAST_GOOD_PORT_KEY)).toBe('303a:1001');
    expect(isLastGoodPort(board, store)).toBe(true);
    // 换一条口（或者插了别的设备）就不算"刚才是好的"
    expect(isLastGoodPort(port(0x303a, 0x1002), store)).toBe(false);
    expect(isLastGoodPort(port(0x1a86, 0x7523), store)).toBe(false);
  });

  it('报不出 USB 厂商/产品号的串口：不标记、也不匹配（回落到中性文案）', () => {
    const store = memoryStore();
    const unknown = port(undefined, undefined);
    expect(portIdentity(unknown)).toBe('');
    markLastGoodPort(unknown, store);
    expect(store.values.size).toBe(0);
    expect(isLastGoodPort(unknown, store)).toBe(false);
  });

  it('没有 sessionStorage（隐私模式）时静默降级，不抛异常', () => {
    const board = port(0x303a, 0x1001);
    expect(() => markLastGoodPort(board, null)).not.toThrow();
    expect(isLastGoodPort(board, null)).toBe(false);
  });
});
