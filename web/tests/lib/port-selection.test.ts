import { describe, expect, it, vi } from 'vitest';

import { ESPRESSIF_VENDOR_ID, isPortSelectionCancelled, requestPortPreferringDevice } from '@/lib/port-selection';

/** 造一个只实现 requestPort / getPorts 的假 Serial */
function fakeSerial(options: {
  authorized?: { usbVendorId?: number }[];
  requestPort?: (init?: SerialPortRequestOptions) => Promise<SerialPort>;
}): { serial: Serial; calls: { filters?: SerialPortRequestOptions['filters'] }[] } {
  const calls: { filters?: SerialPortRequestOptions['filters'] }[] = [];
  const serial = {
    getPorts: async () =>
      (options.authorized ?? []).map(
        (info) =>
          ({
            getInfo: () => ({ usbVendorId: info.usbVendorId }),
          }) as unknown as SerialPort,
      ),
    requestPort: async (init?: SerialPortRequestOptions) => {
      calls.push({ filters: init?.filters });
      if (options.requestPort) return options.requestPort(init);
      return {} as SerialPort;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Serial;
  return { serial, calls };
}

const notFound = () => {
  const error = new Error('No port selected by the user.');
  error.name = 'NotFoundError';
  return error;
};

describe('requestPortPreferringDevice', () => {
  it('默认带 Espressif 过滤', async () => {
    const { serial, calls } = fakeSerial({});
    const { port, fellBack } = await requestPortPreferringDevice(serial);
    expect(port).not.toBeNull();
    expect(fellBack).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].filters).toEqual([{ usbVendorId: ESPRESSIF_VENDOR_ID }]);
  });

  it('过滤没匹配到（或用户取消）时不带过滤再试一次，并且只退一次', async () => {
    let attempt = 0;
    const { serial, calls } = fakeSerial({
      requestPort: async () => {
        attempt += 1;
        if (attempt === 1) throw notFound();
        return {} as SerialPort;
      },
    });
    const { port, fellBack } = await requestPortPreferringDevice(serial);
    expect(port).not.toBeNull();
    expect(fellBack).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].filters).toEqual([{ usbVendorId: ESPRESSIF_VENDOR_ID }]);
    expect(calls[1].filters).toBeUndefined();
  });

  it('两次都取消 → 返回 null（上层不报错、不提示）', async () => {
    const { serial } = fakeSerial({
      requestPort: async () => {
        throw notFound();
      },
    });
    const { port } = await requestPortPreferringDevice(serial);
    expect(port).toBeNull();
  });

  it('已经授权过非 Espressif 的串口（换过板子），直接不过滤', async () => {
    const { serial, calls } = fakeSerial({ authorized: [{ usbVendorId: 0x1a86 }] });
    const { fellBack } = await requestPortPreferringDevice(serial);
    expect(fellBack).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].filters).toBeUndefined();
  });

  it('其它错误照原样抛出去', async () => {
    const { serial } = fakeSerial({
      requestPort: async () => {
        throw new Error('boom');
      },
    });
    const spy = vi.fn();
    try {
      await requestPortPreferringDevice(serial);
    } catch (error) {
      spy(error);
    }
    expect(spy).toHaveBeenCalled();
  });
});

describe('isPortSelectionCancelled', () => {
  it('认 DOMException 的 NotFoundError / AbortError，也认文案', () => {
    const dom = new DOMException('No port selected by the user.', 'NotFoundError');
    expect(isPortSelectionCancelled(dom)).toBe(true);
    expect(isPortSelectionCancelled(new Error('user cancelled the prompt'))).toBe(true);
    expect(isPortSelectionCancelled(new Error('Failed to open serial port'))).toBe(false);
  });
});
