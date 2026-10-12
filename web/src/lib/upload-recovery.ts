/**
 * “上传途中刷新页面”的恢复标记。
 *
 * 固件收到 `media/add` 后会把后面所有字节都当文件内容。网页如果在半路刷新，
 * 串口一断，固件最多要等自己的接收超时（当前 2 秒）才会回到命令行状态。
 * 新页面如果立刻发 `device/info` 去握手，那串命令会被固件当成“文件还剩的字节”，
 * 于是握手失败、端口被误判成“不是本设备”而被忘掉。
 *
 * 这里用一个 `sessionStorage` 标记把“上次页面是在上传中被刷掉的”带给新页面：
 * 新页面先等固件超时，再开始握手。标记只在浏览器标签页里存活，刷新不会丢。
 */
export const UPLOAD_IN_FLIGHT_KEY = 'pet-board-upload-in-flight';
/** 比固件 `link::RX_TIMEOUT`（2s）多留一点余量 */
export const UPLOAD_RECOVERY_WAIT_MS = 2_200;

export interface UploadRecoveryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserSessionStore(): UploadRecoveryStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // 隐私模式/禁用 Storage 时静默降级：恢复标记不可用，但上传本身照常
    return null;
  }
}

export function markUploadInFlight(store: UploadRecoveryStore | null = browserSessionStore()): void {
  try {
    store?.setItem(UPLOAD_IN_FLIGHT_KEY, '1');
  } catch {
    /* 存储不可用时忽略 */
  }
}

export function clearUploadInFlight(store: UploadRecoveryStore | null = browserSessionStore()): void {
  try {
    store?.removeItem(UPLOAD_IN_FLIGHT_KEY);
  } catch {
    /* 存储不可用时忽略 */
  }
}

/** 只看标记，不清掉；返回 true 表示“上次是在上传中被刷掉的” */
export function peekUploadInFlight(store: UploadRecoveryStore | null = browserSessionStore()): boolean {
  try {
    return store?.getItem(UPLOAD_IN_FLIGHT_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 包住一次 `media/add`：标记“上传进行中”，结束后清掉；上次失败/刷新留下的
 * 标记会让下一次上传先等固件从接收超时里恢复。
 */
export async function withUploadRecovery<T>(
  operation: () => Promise<T>,
  store: UploadRecoveryStore | null = browserSessionStore(),
  waitMs = UPLOAD_RECOVERY_WAIT_MS,
): Promise<T> {
  if (peekUploadInFlight(store)) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    clearUploadInFlight(store);
  }
  markUploadInFlight(store);
  try {
    const result = await operation();
    clearUploadInFlight(store);
    return result;
  } catch (error) {
    // 失败时故意留着标记：刷新页面或马上重试都要先等设备恢复。
    throw error;
  }
}

/**
 * 固件在接收超时后会回 `ERR timeout waiting for data`。
 * `DeviceClient.probe` 会把它包装成“设备不接受 device/info（timeout waiting for data）…”，
 * 这里只认这个明确信号，不把别的错误也当上传恢复。
 */
export function isStaleUploadError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('timeout waiting for data');
}
