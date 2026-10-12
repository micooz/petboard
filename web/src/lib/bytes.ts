/**
 * 明确带 `ArrayBuffer` 的字节类型别名。
 *
 * TypeScript 5.7 之后 `Uint8Array` 是泛型的（`Uint8Array<ArrayBufferLike>`），而 DOM 接口
 * （`ImageData`、`crypto.subtle`）只接受 `ArrayBuffer` 那一版。我们的缓冲全都是自己 new 的，
 * 所以在类型上写死成这个别名，省掉一堆 cast。
 */
export type Bytes = Uint8Array<ArrayBuffer>;
export type ClampedBytes = Uint8ClampedArray<ArrayBuffer>;

/** 一个只进不出的字节队列：串口读到的字节先攒在这里，按需取走。 */
export class ByteQueue {
  private data = new Uint8Array(0);
  private start = 0;
  private end = 0;

  get length(): number {
    return this.end - this.start;
  }

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const count = this.length; // 注意：要在动 start 之前算出来
    const need = count + bytes.length;
    // 尾巴不够就先搬到前面；再不够就翻倍扩容
    if (this.end + bytes.length > this.data.length) {
      if (need <= this.data.length) {
        this.data.copyWithin(0, this.start, this.end);
      } else {
        let cap = Math.max(1024, this.data.length * 2);
        while (cap < need) cap *= 2;
        const grown = new Uint8Array(cap);
        grown.set(this.data.subarray(this.start, this.end), 0);
        this.data = grown;
      }
      this.start = 0;
      this.end = count;
    }
    this.data.set(bytes, this.end);
    this.end += bytes.length;
  }

  /** 取走一个字节；队列空了返回 undefined（0x00 是合法字节，不能拿它当空） */
  shift(): number | undefined {
    if (this.length === 0) return undefined;
    const byte = this.data[this.start];
    this.start += 1;
    return byte;
  }

  /** 取走最多 n 个字节（返回的是拷贝，调用方可以随便留着） */
  take(n: number): Uint8Array {
    const count = Math.min(n, this.length);
    const out = this.data.slice(this.start, this.start + count);
    this.start += count;
    return out;
  }

  clear(): void {
    this.start = 0;
    this.end = 0;
  }
}
