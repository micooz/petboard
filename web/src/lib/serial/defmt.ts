/**
 * defmt 日志帧的识别：从串口字节流里把板子的二进制日志帧认出来。
 *
 * 帧格式的依据（`defmt-1.1.1/src/encoding/rzcobs.rs` + `esp-println` 的 defmt logger）：
 *
 * ```text
 * esp-println 每帧先写   FF 00              ← 帧开始的标记
 * rzcobs 的帧体                          ← 里面不会出现 00（00 被转义掉了）
 * rzcobs 每帧最后写      00                ← 帧结束的分隔符
 * ```
 *
 * 这个状态机被两处共用，语义只有这一份：
 * - [`LineScanner`]：靠它把日志帧从协议文本里剔掉（`'consumed'` / `'reset-text'`）；
 * - 设备日志记录器：靠它把**一整帧原始字节**（含 `FF 00` 前缀和结尾 `00`）存下来，
 *   导出的 `.txt` 里 `FW` 行写的就是这些原始字节，能还原成 `.bin` 喂给 `defmt-print` 解。
 */
export type DefmtStep =
  /** 和日志帧无关：调用方按普通文本处理这个字节 */
  | 'text'
  /** 上一个字节是 `0xFF` 且不是帧开始（当噪音）：调用方先丢掉半行，再把这个字节当文本 */
  | 'reset-text'
  /** 属于帧标记 / 帧体 / 分隔符：调用方丢掉半行，这个字节也丢掉 */
  | 'consumed';

export class DefmtFrameScanner {
  private sawFF = false;
  private inFrame = false;
  private bodySeen = false;
  private frame: number[] = [];

  /** `onFrame` 收到的是完整的一帧（`FF 00 … 00`），顺序和到达顺序一致 */
  constructor(private readonly onFrame: (frame: Uint8Array) => void = () => {}) {}

  push(bytes: Uint8Array): void {
    for (const byte of bytes) this.feed(byte);
  }

  feed(byte: number): DefmtStep {
    if (this.inFrame) {
      this.frame.push(byte);
      if (byte === 0x00) {
        if (this.bodySeen) {
          this.inFrame = false;
          this.bodySeen = false;
          const frame = new Uint8Array(this.frame);
          this.frame = [];
          this.onFrame(frame);
        }
        // 否则是开头多出来的分隔符（空帧），继续吃
      } else {
        this.bodySeen = true;
      }
      return 'consumed';
    }

    if (this.sawFF) {
      this.sawFF = false;
      if (byte === 0x00) {
        this.inFrame = true;
        this.bodySeen = false;
        this.frame = [0xff, 0x00];
        return 'consumed';
      }
      // 0xFF 是噪音，当前这个字节还是正文
      return 'reset-text';
    }

    if (byte === 0xff) {
      this.sawFF = true;
      return 'consumed';
    }
    return 'text';
  }

  reset(): void {
    this.sawFF = false;
    this.inFrame = false;
    this.bodySeen = false;
    this.frame = [];
  }
}
