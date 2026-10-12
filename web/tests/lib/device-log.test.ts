import { describe, expect, it } from 'vitest';

import {
  DeviceLog,
  formatEntryLine,
  hexPreview,
  localDay,
  prunePlan,
  type DayManifest,
  type LogEntry,
  type LogStorage,
} from '@/lib/device-log';

/** 测试用的内存存储：语义和 IndexedDB 那份一致（append 顺便更新每天清单） */
class MemoryStorage implements LogStorage {
  entries: LogEntry[] = [];
  days = new Map<string, DayManifest>();

  async append(entries: LogEntry[], days: DayManifest[]): Promise<void> {
    for (const entry of entries) {
      const { seq: _seq, ...record } = entry;
      this.entries.push({ ...record, id: this.entries.length + 1 });
    }
    for (const day of days) this.days.set(day.day, day);
  }

  async listDays(): Promise<DayManifest[]> {
    return [...this.days.values()];
  }

  async readDay(day: string): Promise<LogEntry[]> {
    return this.entries.filter((entry) => entry.day === day);
  }

  async deleteDays(days: string[]): Promise<void> {
    const doomed = new Set(days);
    this.entries = this.entries.filter((entry) => !doomed.has(entry.day));
    for (const day of days) this.days.delete(day);
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.days.clear();
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** 固定时钟：测试自己决定"现在"是几点 */
function clock(start: number) {
  let t = start;
  return {
    now: () => t,
    set: (value: number) => {
      t = value;
    },
  };
}

describe('DeviceLog', () => {
  it('协议行、ACK、载荷块都会落盘，连续重复的合并成 ×N', async () => {
    const storage = new MemoryStorage();
    const at = clock(Date.parse('2026-09-28T10:00:00+08:00'));
    const log = await DeviceLog.openWith(storage, { now: at.now });

    log.line('tx', 'media/add A1B2C3D4.ANM 2048');
    log.line('rx', 'READY');
    log.bulk('tx', 1024, 'payload');
    log.bulk('tx', 1024, 'payload');
    log.bulk('rx', 2, 'ack');
    log.bulk('rx', 2, 'ack');
    log.bulk('rx', 2, 'ack');
    await log.flush();

    const day = localDay(at.now());
    const entries = await log.readDay(day);
    expect(entries.map((entry) => entry.text)).toEqual([
      'media/add A1B2C3D4.ANM 2048',
      'READY',
      '1024 B 数据块',
      'ACK',
    ]);
    expect(entries[2].count).toBe(2);
    expect(entries[3].count).toBe(3);
    expect(entries[1].dir).toBe('rx');
    expect(log.stats().count).toBe(4);
  });

  it('固件帧存完整原始字节、从不合并；导出的文本给出**完整**十六进制', async () => {
    const storage = new MemoryStorage();
    const log = await DeviceLog.openWith(storage, { now: () => 1_800_000_000_000 });
    const first = new Uint8Array([0xff, 0x00, 0x41, 0x00]);
    // 比界面预览（64B）更长的一帧：导出时必须一位不少，否则没法还原成 .bin
    const second = new Uint8Array(100).map((_, index) => index & 0xff);
    second[0] = 0xff;
    second[1] = 0x00;
    second[99] = 0x00;
    log.frame(first);
    log.frame(second);
    await log.flush();

    const day = localDay(1_800_000_000_000);
    const entries = await log.readDay(day);
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('ff 00 41 00');
    expect([...entries[1].raw!]).toEqual([...second]);

    const text = await log.exportTxt(day);
    const frameLines = text
      .split('\n')
      .filter((line) => !line.startsWith('#') && line.includes('  FW  '));
    expect(frameLines).toHaveLength(2);
    // 第二行是完整 100 字节（界面预览只给 64B，导出不能截断）
    const hex = frameLines[1].split('  FW  ')[1].trim().split(' ');
    expect(hex).toHaveLength(100);
    expect(hex[0]).toBe('ff');
    expect(hex[99]).toBe('00');
  });

  it('导出的文本日志既有协议行也有说明，缺哪一步一眼能看出来', async () => {
    const storage = new MemoryStorage();
    const log = await DeviceLog.openWith(storage, { now: () => 1_800_000_000_000 });
    log.line('tx', 'media/get 335C5A0B.ANM 18 16384');
    log.line('rx', 'DATA 16384');
    log.error('等载荷超时（收到 18/16384 字节）');
    await log.flush();

    const text = await log.exportTxt(localDay(1_800_000_000_000));
    expect(text).toContain('# Pet Board 通信日志');
    expect(text).toContain('media/get 335C5A0B.ANM 18 16384');
    expect(text).toContain('DATA 16384');
    expect(text).toContain('等载荷超时（收到 18/16384 字节）');
  });

  it('载荷块连续合并：行数少，而且按"行大小"记账、不按流量记账', async () => {
    const storage = new MemoryStorage();
    const log = await DeviceLog.openWith(storage, { now: () => 1_800_000_000_000 });
    // 32 字节一块：一次 534KB 的预览就是这样上万条
    for (let i = 0; i < 1000; i += 1) log.bulk('rx', 32, 'payload');
    await log.flush();

    const entries = await log.readDay(localDay(1_800_000_000_000));
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(1000);
    // 32B×1000 = 32KB 流量，但只存了一行 —— 记账要按行算（几十字节），不然"日志占用"会虚高几十倍
    expect(log.stats().bytes).toBeLessThan(200);
  });

  it('跨零点按本地日期分桶', async () => {
    const storage = new MemoryStorage();
    const at = clock(Date.parse('2026-09-28T23:59:59+08:00'));
    const log = await DeviceLog.openWith(storage, { now: at.now });
    log.note('睡前一条');
    await log.flush();

    at.set(Date.parse('2026-09-29T00:00:01+08:00'));
    log.note('醒来一条');
    await log.flush();

    expect(log.listDays().map((day) => day.day)).toEqual(['2026-09-29', '2026-09-28']);
    expect((await log.readDay('2026-09-28')).map((entry) => entry.text)).toEqual(['睡前一条']);
    expect((await log.readDay('2026-09-29')).map((entry) => entry.text)).toEqual(['醒来一条']);
  });

  it('session 头记了设备信息，错误行是 ERR 前缀', async () => {
    const storage = new MemoryStorage();
    const log = await DeviceLog.openWith(storage, { now: () => 1_800_000_000_000 });
    log.startSession({
      id: 'aa:bb:cc:dd:ee:ff',
      api: 3,
      screen: { width: 320, height: 172 },
      reset: 'power-on',
      sd: 'microSD 30GB',
      href: 'http://localhost:3000/',
    });
    log.line('tx', 'device/info');
    log.error('等设备回 ACK 超时（15000 ms）');
    await log.flush();

    const day = localDay(1_800_000_000_000);
    const entries = await log.readDay(day);
    expect(entries[0].text).toContain('session: aa:bb:cc:dd:ee:ff · api 3');
    expect(entries.map((entry) => entry.text)).toContain('device/info');
    const failure = entries.find((entry) => entry.kind === 'error')!;
    expect(formatEntryLine(failure)).toContain('ERR 等设备回 ACK 超时（15000 ms）');
  });

  it('清空之后统计归零、能重新开始记', async () => {
    const storage = new MemoryStorage();
    const log = await DeviceLog.openWith(storage, { now: () => 1_800_000_000_000 });
    log.note('一');
    await log.flush();
    expect(log.stats().days).toBe(1);

    await log.clear();
    expect(log.stats()).toEqual({ days: 0, bytes: 0, count: 0 });
    expect(await log.readDay(localDay(1_800_000_000_000))).toEqual([]);

    log.note('二');
    await log.flush();
    expect(log.stats().count).toBe(1);
  });

  it('flush 时按 30 天 / 100MB 从最旧的整天删', async () => {
    const storage = new MemoryStorage();
    const base = Date.parse('2026-03-01T12:00:00+08:00');
    const at = { value: base };
    const log = await DeviceLog.openWith(storage, { now: () => at.value, retentionDays: 30 });

    // 先写满 35 天，每天一条
    for (let day = 0; day < 35; day += 1) {
      at.value = base + day * DAY;
      log.note(`第 ${day} 天`);
      await log.flush();
    }
    const days = log.listDays().map((day) => day.day);
    expect(days).toHaveLength(30);
    expect(days).not.toContain(localDay(base)); // 最旧的 5 天已经被删
    expect(days).toContain(localDay(at.value));
  });

  it('prunePlan：超容量时也从最旧的整天删', () => {
    const day = (value: string, bytes: number): DayManifest => ({
      day: value,
      deviceId: 'aa:bb:cc:dd:ee:ff',
      bytes,
      count: 1,
      firstT: 0,
      lastT: 0,
    });
    const days = [day('2026-09-26', 60), day('2026-09-27', 60), day('2026-09-28', 60)];
    // 180 B > 100 B：删到 09-27 后剩 60 B 才收手
    const doomed = prunePlan(days, {
      now: Date.parse('2026-09-28T10:00:00+08:00'),
      retentionDays: 30,
      maxBytes: 100,
    });
    expect(doomed).toEqual(['2026-09-26', '2026-09-27']);
  });

  it('行格式：毫秒时间戳、方向、合并次数', () => {
    const entry: LogEntry = {
      id: 1,
      day: '2026-09-28',
      t: Date.parse('2026-09-28T09:08:07.006+08:00'),
      deviceId: 'aa:bb:cc:dd:ee:ff',
      dir: 'rx',
      kind: 'bulk',
      text: 'ACK',
      bytes: 8,
      count: 57,
    };
    expect(formatEntryLine(entry)).toBe('09:08:07.006  RX  ACK ×57');
  });

  it('hex 预览超长会截断，完整字节仍在 raw 里', () => {
    const raw = new Uint8Array(80).fill(0xab);
    const text = hexPreview(raw, 64);
    expect(text.startsWith('ab ab ab')).toBe(true);
    expect(text.endsWith('…(+16 B)')).toBe(true);
  });

});
