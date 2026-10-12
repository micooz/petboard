import { describe, expect, it } from 'vitest';

import { DefmtFrameScanner } from '@/lib/serial/defmt';
import { WireReader } from '@/lib/serial/frames';

/** 一帧 wire 字节：`FF 00` + 帧体 + `00`（帧体里不会出现 00） */
function frame(body: number[]): number[] {
  return [0xff, 0x00, ...body, 0x00];
}

function collect(): { frames: number[][]; scanner: DefmtFrameScanner } {
  const frames: number[][] = [];
  const scanner = new DefmtFrameScanner((value) => frames.push([...value]));
  return { frames, scanner };
}

describe('DefmtFrameScanner', () => {
  it('把整帧交出来（含 FF 00 前缀和结尾 00）', () => {
    const { frames, scanner } = collect();
    scanner.push(new Uint8Array(frame([0x41, 0x42])));
    expect(frames).toEqual([frame([0x41, 0x42])]);
  });

  it('帧跨分块也能认出来', () => {
    const { frames, scanner } = collect();
    scanner.push(new Uint8Array([0xff]));
    scanner.push(new Uint8Array([0x00, 0x41]));
    scanner.push(new Uint8Array([0x42, 0x00]));
    expect(frames).toEqual([frame([0x41, 0x42])]);
  });

  it('连续两帧各算一帧', () => {
    const { frames, scanner } = collect();
    scanner.push(new Uint8Array([...frame([0x01]), ...frame([0x02, 0x03])]));
    expect(frames).toEqual([frame([0x01]), frame([0x02, 0x03])]);
  });

  it('帧体里出现 0xFF 不影响', () => {
    const { frames, scanner } = collect();
    scanner.push(new Uint8Array(frame([0xff, 0xff, 0x41])));
    expect(frames).toEqual([frame([0xff, 0xff, 0x41])]);
  });

  it('开头多出来的分隔符不算帧结束', () => {
    const { frames, scanner } = collect();
    scanner.push(new Uint8Array([0xff, 0x00, 0x00, 0x41, 0x00]));
    expect(frames).toEqual([[0xff, 0x00, 0x00, 0x41, 0x00]]);
  });

  it('reset 之后当新流处理', () => {
    const { frames, scanner } = collect();
    scanner.push(new Uint8Array([0xff, 0x00, 0x41]));
    scanner.reset();
    scanner.push(new Uint8Array(frame([0x42])));
    expect(frames).toEqual([frame([0x42])]);
  });

  /**
   * v9：行切分与帧过滤合并在 `WireReader`（一处实现，网页链路和测试共用）。
   * 这条验的是"帧被吃掉、文本照常成行"这个语义没被拆开。
   */
  it('WireReader 吃掉日志帧、把控制帧切成行', () => {
    const reader = new WireReader();
    const out: string[] = [];
    const stream = new Uint8Array([
      ...new TextEncoder().encode('~1 OK\n'),
      ...frame([0x01, 0x02]),
      ...new TextEncoder().encode('~2 READY\n'),
    ]);
    for (const byte of stream) {
      const line = reader.feed(byte);
      if (line !== null) out.push(line);
    }
    // 只有**控制帧**会被认出来（`~` 开头）；帧字节不该变成任何一行
    expect(out).toEqual(['~1 OK', '~2 READY']);
  });

  it('WireReader 里帧之前的半行会被丢掉（和 transport 的行为一致）', () => {
    const reader = new WireReader();
    const out: string[] = [];
    for (const byte of new Uint8Array([...new TextEncoder().encode('RE'), ...frame([0x01]), ...new TextEncoder().encode('~2 ADY\n')])) {
      const line = reader.feed(byte);
      if (line !== null) out.push(line);
    }
    expect(out).toEqual(['~2 ADY']);
  });
});
