/**
 * 半途而废之后的管道清理：`Transport.markStaleRx` / `resync`。
 *
 * 这条链路是"网页上有的切片首帧图花掉、板子上却正常"的根因：一次 `media/get` 没读满就收手时，
 * `DATA <n>` 许诺过、还在 USB 管道里的残字节会留在队列里，被**下一条**回传当成载荷开头读走。
 * 每一段都读满了自己要求的长度，所以帧、ACK、长度、`complete` 谁都不报错，只有画出来的第 0 帧
 * 是花的 —— 位图少一个字节，popcount 和颜色个数就全错位了。
 */
import { describe, expect, it } from 'vitest';

import { Transport, type SerialPortLike } from '@/lib/serial/transport';

/** 手动控制"设备什么时候吐什么字节"的假串口（残载荷是裸字节，不能用文本模拟） */
class RawPort implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private controller!: ReadableStreamDefaultController<Uint8Array>;

  async open(): Promise<void> {
    this.readable = new ReadableStream({ start: (controller) => (this.controller = controller) });
    this.writable = new WritableStream<Uint8Array>({ write: () => undefined });
  }

  async close(): Promise<void> {
    this.controller.close();
  }

  push(bytes: Uint8Array): void {
    this.controller.enqueue(bytes);
  }
}

/** 等 pump 把刚推进流的字节挪进队列 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

async function withPort(): Promise<{ transport: Transport; port: RawPort }> {
  const port = new RawPort();
  const transport = new Transport(port);
  await transport.open();
  return { transport, port };
}

/** 设备主动吐的残字节（上一次传输许诺过、但没读满的载荷尾巴） */
function raw(fill: number, byte: number): Uint8Array {
  return new Uint8Array(fill).fill(byte);
}

/** 按 `media/get` 收载荷的方式读一段 */
function readPayload(transport: Transport, count: number): Promise<Uint8Array> {
  return transport.readUpTo(count, { firstByteMs: 200, idleMs: 200, deadlineMs: 2_000 });
}

describe('半途而废之后的管道清理（markStaleRx / resync）', () => {
  it('清掉残字节：下一次回传拿到的是它自己的字节', async () => {
    const { transport, port } = await withPort();
    transport.setRaw(true);
    port.push(raw(300, 0x41));
    await settle();

    transport.markStaleRx();
    transport.resync();

    const payload = new Uint8Array(512).map((_, index) => index & 0xff);
    port.push(payload);
    expect(await readPayload(transport, 512)).toEqual(payload);
  });

  /**
   * 反面对照：不清管道就**确实**会错位。
   *
   * 留着它是为了钉住这个 bug 的形状 —— 少一个字节不会有任何一层报错，只有内容不对。
   */
  it('不 resync 就会被残字节顶掉开头：整段错位而且没人报错', async () => {
    const { transport, port } = await withPort();
    transport.setRaw(true);
    port.push(raw(300, 0x41));
    await settle();

    transport.markStaleRx(); // 登记了，但这一条故意不调用 resync

    const payload = new Uint8Array(512).map((_, index) => index & 0xff);
    port.push(payload);
    const bytes = await readPayload(transport, 512);
    // 长度照样"读满"（上层因此报 `complete: true`），但开头 300 个字节是上一次的残骸
    expect(bytes).toHaveLength(512);
    expect(bytes.subarray(0, 300)).toEqual(raw(300, 0x41));
    expect(bytes).not.toEqual(payload);
  });

  /** 错位会**自己续命**：一次"成功"的错位读取同样留下尾巴，所以清空不能只认登记过的那一次 */
  it('没登记过也照清：上一次晚到的尾巴挡不住下一条传输', async () => {
    const { transport, port } = await withPort();
    transport.setRaw(true);
    port.push(raw(8, 0x43));
    await settle();

    transport.resync(); // 故意没有 markStaleRx
    port.push(raw(8, 0x44));
    await settle();

    expect(await readPayload(transport, 8)).toEqual(raw(8, 0x44));
  });

  /**
   * 上一次传输的残载荷里要是碰巧有 `~` 开头的可打印字节，行扫描器会把它攒成"半条控制帧"
   * （`~9`）。紧接着的真回执 `~12 OK` 会被接在它后面，扫出 `~9 OK` —— 编号对不上，
   * 那条请求就此永远等不到结论。所以 `resync` 除了清队列，还要丢掉攒了一半的行。
   */
  it('攒了一半的行一起丢掉：残骸不能把紧接着的回执粘走', async () => {
    const { transport, port } = await withPort();
    const lines: string[] = [];
    transport.setLineHandler((line) => lines.push(line));
    await settle();

    port.push(new TextEncoder().encode('~9'));
    await settle();
    transport.resync();

    port.push(new TextEncoder().encode('~12 OK\n'));
    await settle();
    expect(lines).toEqual(['~12 OK']);
  });

  /** 反面对照：不清半行的话，回执会被残骸粘走 → 编号对不上，上层等不到结论 */
  it('不 resync 时残骸真的会粘住行：扫出来的是一行垃圾', async () => {
    const { transport, port } = await withPort();
    const lines: string[] = [];
    transport.setLineHandler((line) => lines.push(line));
    await settle();

    port.push(new TextEncoder().encode('~9'));
    await settle();
    port.push(new TextEncoder().encode('~12 OK\n'));
    await settle();
    // `~9` 已经是"控制帧的开头"，扫描器不会在中间的 `~` 处切行 —— 整行报废
    expect(lines).toEqual(['~9~12 OK']);
  });

  /**
   * 进入裸字节模式时也要丢掉半行：`resync` 在"队列已空"时直接返回，
   * 而"半行 + 空队列"正是残载荷留下的形状。
   */
  it('setRaw(true) 丢掉半行：本次的 DATA 回执不会被上一条的残骸粘走', async () => {
    const { transport, port } = await withPort();
    // 装上分发器，字节才会被真正扫进扫描器（半行留在扫描器里，队列是空的）
    transport.setLineHandler(() => undefined);
    await settle();

    port.push(new TextEncoder().encode('~9'));
    await settle();
    transport.setRaw(true);
    port.push(new TextEncoder().encode('~12 DATA 4\n'));
    expect(await transport.readLine(500)).toBe('~12 DATA 4');
  });
});
