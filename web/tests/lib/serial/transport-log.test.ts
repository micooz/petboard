import { describe, expect, it } from 'vitest';

import type { LogSink } from '@/lib/device-log';
import { DeviceClient } from '@/lib/serial/client';
import { FakeBoard } from '@/lib/serial/fake-board';
import { Transport, type SerialPortLike } from '@/lib/serial/transport';

/** 记录所有通信事件的内存 sink：断言"该记的记了、不该记的没记" */
class MemorySink implements LogSink {
  readonly entries: string[] = [];

  line(dir: 'tx' | 'rx', text: string): void {
    this.entries.push(`${dir}:line:${text}`);
  }
  frame(raw: Uint8Array): void {
    this.entries.push(`fw:frame:${[...raw].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`);
  }
  bulk(dir: 'tx' | 'rx', bytes: number, label: 'ack' | 'payload'): void {
    this.entries.push(`${dir}:bulk:${label}:${bytes}`);
  }
  note(text: string): void {
    this.entries.push(`note:${text}`);
  }
  error(text: string): void {
    this.entries.push(`error:${text}`);
  }
}

/** 只用来手动推字节的假串口（测日志帧提取和载荷模式） */
class ScriptedPort implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private controller!: ReadableStreamDefaultController<Uint8Array>;

  async open(): Promise<void> {
    this.readable = new ReadableStream({ start: (controller) => (this.controller = controller) });
    this.writable = new WritableStream();
  }

  async close(): Promise<void> {
    this.controller.close();
  }

  push(bytes: Uint8Array): void {
    this.controller.enqueue(bytes);
  }
}

/** 载荷里塞满 `FF 00`：它绝对不是日志帧，别被认出来 */
function payloadWithFrameMarkers(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let at = 0; at + 1 < size; at += 2) {
    out[at] = 0xff;
    out[at + 1] = 0x00;
  }
  return out;
}

describe('Transport 的通信日志', () => {
  it('命令、回复、ACK、载荷摘要都记；载荷里的 FF 00 不会被当成固件帧', async () => {
    const board = new FakeBoard();
    const sink = new MemorySink();
    const transport = new Transport(board, 115200, sink);
    await transport.open();
    const client = new DeviceClient(transport);

    await client.info();
    await client.list();
    await client.add('AB12CD34.BMP', payloadWithFrameMarkers(2500));
    board.files.set('AB12CD34.ANM', payloadWithFrameMarkers(2048));
    await client.get('AB12CD34.ANM');
    await client.play('AB12CD34.ANM');
    await client.stop();

    // v9：每条报文都带编号（`~<id> …`），日志里也是这个形状 —— 排查时一眼能看出
    // "哪条请求配了哪条应答"，这正是配对机制的全部价值。
    expect(sink.entries).toContain('tx:line:~1 device/info');
    expect(sink.entries).toContain('tx:line:~2 media/list');
    expect(sink.entries).toContain('tx:line:~3 media/add AB12CD34.BMP 2500');
    expect(sink.entries).toContain('tx:line:~4 media/get AB12CD34.ANM');
    expect(sink.entries).toContain('tx:line:~5 media/play AB12CD34.ANM');
    expect(sink.entries).toContain('tx:line:~6 media/stop');
    expect(sink.entries).toContain('rx:line:~3 READY');
    expect(sink.entries).toContain('rx:line:~1 OK 9');
    // 每行只记一次：传输期间由 client 自己读行（`awaitAnswer`）也只记一次
    expect(sink.entries.filter((entry) => entry === 'rx:line:~3 READY')).toHaveLength(1);
    // 板子回的是上传方向的 2 字节 ACK，要记
    expect(sink.entries).toContain('rx:bulk:ack:2');
    // 主机自己发的块 ACK 不单独记：回传时它和载荷块交替出现，会把日志冲爆
    //（"收了多少块"在载荷计数里已经有了）
    expect(sink.entries.some((entry) => entry.startsWith('tx:bulk:ack:'))).toBe(false);
    // 上传一块 1024；回传一块 32（小于 TX FIFO 深度：填满 FIFO 的那一笔在这块板子上会卡住）
    expect(sink.entries).toContain('tx:bulk:payload:1024');
    expect(sink.entries).toContain('rx:bulk:payload:32');
    // 关键：上下载的都是 FF 00 填充的"像帧"的载荷，一条固件帧都不该记出来
    expect(sink.entries.filter((entry) => entry.startsWith('fw:frame:'))).toEqual([]);
  });

  it('串口里的 defmt 帧记原始字节，协议文本照常成行', async () => {
    const port = new ScriptedPort();
    const sink = new MemorySink();
    const transport = new Transport(port, 115200, sink);
    await transport.open();

    port.push(new Uint8Array([0xff, 0x00, 0x41, 0x42, 0x00]));
    port.push(new TextEncoder().encode('~1 OK\n'));
    expect(await transport.readLine(1000)).toBe('~1 OK');
    // 帧是 pump 里扫出来的，等一个微任务
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sink.entries).toContain('fw:frame:ff00414200');
    // `readLine` 是"读原始行"的原语，自己不记日志（传输期间的行由调用方 `awaitAnswer`
    // 记一次，避免双记）。挂上背景分发器之后，行模式的报文才会记 `rx`。
    expect(sink.entries.filter((entry) => entry.startsWith('rx:line:'))).toEqual([]);
    port.push(new TextEncoder().encode('~2 OK\n'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.setLineHandler(() => undefined);
    expect(sink.entries).toContain('rx:line:~2 OK');
  });

  it('readUpTo 期间是载荷模式：载荷原样收下，只记一条摘要', async () => {
    const port = new ScriptedPort();
    const sink = new MemorySink();
    const transport = new Transport(port, 115200, sink);
    await transport.open();

    port.push(new Uint8Array([0xff, 0x00, 0x41, 0x42]));
    const bytes = await transport.readUpTo(4, { firstByteMs: 1_000, idleMs: 50, deadlineMs: 1_000 });
    expect([...bytes]).toEqual([0xff, 0x00, 0x41, 0x42]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sink.entries).toContain('rx:bulk:payload:4');
    expect(sink.entries.filter((entry) => entry.startsWith('fw:frame:'))).toEqual([]);
  });
});
