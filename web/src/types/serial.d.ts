/**
 * Web Serial 的类型声明。
 *
 * 它不在 TypeScript 自带的 DOM 类型里（各浏览器实现进度不一样），所以这里只声明
 * 我们真正用到的那一小块。
 */
interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
  /**
   * 撤销这个端口的授权（"忘记"它）。
   *
   * Chrome 103+ 支持；调用之后 `navigator.serial.getPorts()` 不再返回它，
   * 也就是清掉了"浏览器记住你选过哪个串口"这份记忆。
   */
  forget?(): Promise<void>;
}

interface SerialPortRequestOptions {
  filters?: { usbVendorId?: number; usbProductId?: number }[];
}

interface Serial extends EventTarget {
  getPorts(): Promise<SerialPort[]>;
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
}

interface Navigator {
  readonly serial?: Serial;
}
