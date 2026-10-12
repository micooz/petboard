/**
 * "这个端口刚才还跟 Pet Board 通过话" —— 只在当前标签页（`sessionStorage`）里记。
 *
 * 用来区分两种"握手一条回执都没等到"：
 *
 * - 从没成功过的端口：多半是选错了（或者板子还没起来）—— 照旧提示"确认选对端口"；
 * - **刚才还通、现在一句话都不回**：多半是 C6 的 USB-Serial-JTAG **数据通道卡死了**。
 *   实测（2026-10-11，上板）：反复"打开端口 → 收发一次 → 关端口"约 9 次就中一次，
 *   中的那一刻回执被截断，之后两个方向全哑；而芯片还在跑（屏幕正常）、设备也还挂在
 *   USB 上（枚举没变、`reset` 原因不变），**只有拔插 USB 能恢复**。上游对应
 *   espressif/esp-idf#19192（ESP32-C6）。
 *
 * 这种情况下让用户去重新挑端口是误导，直接告诉他拔插。标记放 `sessionStorage` 是有意的：
 * 刷新（用户报的正是"上传完成后刷新页面"）会丢掉内存状态，但不丢 `sessionStorage`，
 * 所以新页面仍然知道"这条口刚才还好着"。
 */

export const LAST_GOOD_PORT_KEY = 'pet-board-last-good-port';

/** 只用到 `getInfo()`；写成结构类型是为了让单测能直接传普通对象 */
export interface PortLike {
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserSessionStore(): KeyValueStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // 隐私模式/禁用 Storage：静默降级 —— 拿不准是"选错端口"还是"卡死"时，按中性文案说。
    return null;
  }
}

/**
 * 端口的身份串（`0x303a:0x1001`）。
 *
 * 拿不到 USB 厂商/产品号（有些串口报不出来）时返回空串：那就等于"认不出这个口"，
 * 不标记也不匹配，宁可回落到中性文案。
 */
export function portIdentity(port: PortLike | null): string {
  const info = port?.getInfo?.();
  if (!info || info.usbVendorId === undefined || info.usbProductId === undefined) return '';
  return `${info.usbVendorId.toString(16)}:${info.usbProductId.toString(16)}`;
}

/** 握手成功后记一笔"这条口刚才是好的" */
export function markLastGoodPort(port: PortLike | null, store: KeyValueStore | null = browserSessionStore()): void {
  const identity = portIdentity(port);
  if (identity === '') return;
  try {
    store?.setItem(LAST_GOOD_PORT_KEY, identity);
  } catch {
    /* 存储不可用时忽略：退化成中性文案 */
  }
}

/** 这条口在本次标签页里成功握过手吗 */
export function isLastGoodPort(port: PortLike | null, store: KeyValueStore | null = browserSessionStore()): boolean {
  const identity = portIdentity(port);
  if (identity === '') return false;
  try {
    return store?.getItem(LAST_GOOD_PORT_KEY) === identity;
  } catch {
    return false;
  }
}
