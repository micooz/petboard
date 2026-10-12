/**
 * 挑串口：过滤、退路，以及"忘记端口"。
 *
 * 抽出来单独放，一是逻辑不短，二是能脱离 React 单测（见 `port-selection.test.ts`）。
 */

/**
 * Espressif 原厂 USB 的厂商 ID。本板的 USB-Serial-JTAG 是芯片原生的，走的就是它；
 * 挑端口时先按这个过滤，用户基本不可能选到别的串口上去。
 */
export const ESPRESSIF_VENDOR_ID = 0x303a;

/**
 * `navigator.serial.requestPort()` 被用户取消时抛的就是这个 —— 别把它当"连不上"。
 * Chrome 给的是 `NotFoundError: No port selected`，各家实现略有差别，所以名字和文案都看一遍。
 */
export function isPortSelectionCancelled(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'NotFoundError' || error.name === 'AbortError';
  }
  const message = error instanceof Error ? error.message : String(error);
  return /no port selected|no compatible port|user cancel|user did not select|cancel/i.test(message);
}

/** 忘掉一个端口：撤销浏览器里的"你选过它"这份记忆 */
export async function forgetPort(port: SerialPort | null): Promise<void> {
  if (!port?.forget) return;
  try {
    await port.forget();
  } catch {
    /* 浏览器没有 forget、或者已经忘了：忽略，断开本身已经完成了 */
  }
}

/** 浏览器里是不是已经授权过一个"非 Espressif"的串口（比如换了 CH340 的板子） */
async function hasAuthorizedNonEspressifPort(serial: Serial): Promise<boolean> {
  try {
    const ports = await serial.getPorts();
    return ports.some((port) => {
      const info = port.getInfo();
      return info.usbVendorId !== undefined && info.usbVendorId !== ESPRESSIF_VENDOR_ID;
    });
  } catch {
    return false;
  }
}

/** 弹一次选择框；用户取消（或过滤后没有可选项）返回 null */
async function requestPortOnce(
  serial: Serial,
  filters?: { usbVendorId?: number; usbProductId?: number }[],
): Promise<SerialPort | null> {
  try {
    return await serial.requestPort(filters ? { filters } : undefined);
  } catch (error) {
    if (isPortSelectionCancelled(error)) return null;
    throw error;
  }
}

/**
 * 挑端口：**优先只列 Espressif 原厂 USB 设备**，选错的可能性就很小了。
 *
 * 过滤有个坑：Chrome 在"过滤后没匹配到设备"和"用户点了取消"两种情况下抛的是**同一个**
 * `NotFoundError`（`serial.cc` 里只有一句 `No port selected by the user.`），分不出来。所以：
 *
 * 1. 如果浏览器里已经授权过**非 Espressif** 的串口，说明用户的板子不走原厂 USB，
 *    直接不过滤（换过板子也不会被过滤器挡住）；
 * 2. 否则先带过滤试一次；没成再不带过滤试一次（**只退一次**，不会来回弹）。
 *    代价是"用户主动取消"时会多弹一次选择框，换来的是换了板子也不用额外操作。
 *
 * `fellBack` 表示这次没有用过滤（上层可以据此给用户一句提示）。
 */
export async function requestPortPreferringDevice(
  serial: Serial,
): Promise<{ port: SerialPort | null; fellBack: boolean }> {
  if (await hasAuthorizedNonEspressifPort(serial)) {
    return { port: await requestPortOnce(serial), fellBack: true };
  }
  const filtered = await requestPortOnce(serial, [{ usbVendorId: ESPRESSIF_VENDOR_ID }]);
  if (filtered) return { port: filtered, fellBack: false };
  return { port: await requestPortOnce(serial), fellBack: true };
}
