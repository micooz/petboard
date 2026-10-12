/**
 * 设备的"发送窗口"守卫：`Transport.writeRequest`。
 *
 * 真机结论（S3，2026-10-09）：板子刚发完一大串字节（`media/play` 的 `OK` + `ev …` +
 * 启动日志）之后，固件还要做几件不轮询串口的阻塞活，这期间主机的请求会**整包消失**。
 * 按"距上一个收到的字节 ≥25ms"再发，丢失率从 100% 降到 0。
 */
import { describe, expect, it } from 'vitest';

import { FakeBoard } from '@/lib/serial/fake-board';
import { Transport, type SerialPortLike } from '@/lib/serial/transport';

/** 手动控制"设备什么时候吐字节"的假串口 */
class ScriptedPort implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  /** 每一笔写入的字节数和时刻：断言"距上一个收到的字节至少隔了空档"要用它 */
  readonly writes: { bytes: number; at: number }[] = [];
  /** 上一次设备吐字节的时刻 */
  pushedAt = 0;
  private controller!: ReadableStreamDefaultController<Uint8Array>;

  async open(): Promise<void> {
    this.readable = new ReadableStream({ start: (controller) => (this.controller = controller) });
    this.writable = new WritableStream({
      write: (chunk: Uint8Array) => {
        this.writes.push({ bytes: chunk.length, at: Date.now() });
      },
    });
  }

  async close(): Promise<void> {
    this.controller.close();
  }

  push(text: string): void {
    this.pushedAt = Date.now();
    this.controller.enqueue(new TextEncoder().encode(text));
  }

  /** 主机此刻写出去了多少字节 */
  get writtenBytes(): number {
    return this.writes.reduce((sum, write) => sum + write.bytes, 0);
  }
}

async function withPort(): Promise<{ transport: Transport; port: ScriptedPort }> {
  const port = new ScriptedPort();
  const transport = new Transport(port);
  await transport.open();
  return { transport, port };
}

describe('请求行的发送窗口（writeRequest）', () => {
  it('设备静默时不等：一行都没收到 → 立刻发出去', async () => {
    const { transport, port } = await withPort();
    const started = Date.now();
    await transport.writeRequest('~1 device/info\n');
    expect(Date.now() - started).toBeLessThan(15);
    expect(port.writtenBytes).toBe(new TextEncoder().encode('~1 device/info\n').length);
  });

  it('刚收到字节的几毫秒内不写：至少等满空档', async () => {
    const { transport, port } = await withPort();
    port.push('~1 OK\n');
    // 等 pump 把字节挪进队列（lastRxAt 是在 pump 里记的）
    await new Promise((resolve) => setTimeout(resolve, 5));
    await transport.writeRequest('~2 media/list\n');
    // 真正的不变量：请求字节落在**最后一个收到的字节之后 ≥25ms**
    expect(port.writes.at(-1)!.at - port.pushedAt).toBeGreaterThanOrEqual(25);
    expect(port.writtenBytes).toBe(new TextEncoder().encode('~2 media/list\n').length);
  });

  it('设备一直推事件也不会把命令按死：等满上限照样发', async () => {
    const { transport, port } = await withPort();
    port.push('~0 ev frame 1 28\n');
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 期间不断重置空档（每 10ms 推一条），逼近上限
    const ping = setInterval(() => port.push('~0 ev frame 2 28\n'), 10);
    const started = Date.now();
    await transport.writeRequest('~3 device/info\n');
    clearInterval(ping);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(20);
    expect(waited).toBeLessThan(300);
    expect(port.writtenBytes).toBeGreaterThan(0);
  });

  it('块 ACK 与上传载荷槽不受窗口影响（那两个方向是板子在等主机）', async () => {
    const board = new FakeBoard();
    const transport = new Transport(board);
    await transport.open();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    await Promise.all([transport.writeAck(32), transport.writeDataSlot(new Uint8Array(4))]);
    expect(Date.now() - started).toBeLessThan(15);
  });
});
