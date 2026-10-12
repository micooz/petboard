/**
 * v9 协议的端到端测试：对着 `FakeBoard`（协议精确的假设备）跑完整链路。
 *
 * "字节怎么切成行 / 一行装配成什么应答"这类**规则**由 `wire-fixtures.test.ts` 拿 Rust
 * 跑出来的期望表钉住，这里不再重复；这里管的是**行为**：分块节奏、ACK、配对、取消、
 * 事件推送、失败之后不毒化下一条命令。
 */
import { describe, expect, it } from 'vitest';

import { ByteQueue } from '@/lib/bytes';

import { DeviceClient, HandshakeError } from '@/lib/serial/client';
import { FakeBoard } from '@/lib/serial/fake-board';
import { ReplyReader, SentinelScanner, isControl } from '@/lib/serial/frames';
import { API_VERSION, CHUNK_UP, EVENTS, TAG_DATA } from '@/lib/serial/wire';
import { Transport, TransportTimeout } from '@/lib/serial/transport';

/** 让假板子写出来的字节被读走、把行分发出去（pump 是异步的） */
async function settle(times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 某条命令（按正文前缀认）的请求编号：`log` 与 `requestIds` 是一一对应push进去的 */
function idOf(board: FakeBoard, prefix: string): number {
  const at = board.log.findIndex((line) => line.startsWith(prefix));
  expect(at, `板子没收到 ${prefix}`).toBeGreaterThanOrEqual(0);
  return board.requestIds[at];
}

/** 把字符串按字节喂进扫描器，收回所有成形行 */
function scan(text: string): string[] {
  const scanner = new SentinelScanner();
  const out: string[] = [];
  for (const byte of new TextEncoder().encode(text)) {
    const line = scanner.feed(byte);
    if (line !== null) out.push(line);
  }
  return out;
}

async function connect(board: FakeBoard): Promise<DeviceClient> {
  const transport = new Transport(board);
  await transport.open();
  return new DeviceClient(transport);
}

describe('行扫描与应答装配（规则本身另有 fixture 卷，这里只留最容易读错的三条）', () => {
  it('正文行不带哨兵，但 ReplyReader 知道还要读几行', () => {
    const reader = new ReplyReader();
    expect(reader.feedLine('~7 OK 2').t).toBe('body');
    expect(reader.feedLine('id aa:bb').t).toBe('body');
    const last = reader.feedLine('api 1');
    expect(last.t).toBe('body');
    expect(reader.feedLine('~7 END').t).toBe('complete');
  });

  it('粘行按哨兵切：boot 日志最后一行不带换行，回执直接接在它屁股后面', () => {
    const lines = scan('I (106) esp_image: segment 3: paddr=0001bb6c size~1 OK 9');
    expect(lines).toHaveLength(1);
    // 切出来的第一行是外来文本；回执要等换行才成第二行 —— 关键是 `~` 不再被埋在正文里
    expect(isControl(lines[0])).toBe(false);
    expect(lines[0]).toContain('esp_image');
  });

  it('一条命令跨两次读取到达：半行留在缓冲里，不会变成一条不认识的命令', () => {
    const scanner = new SentinelScanner();
    for (const byte of new TextEncoder().encode('~3 med')) expect(scanner.feed(byte)).toBeNull();
    expect(scanner.pending()).toBe('~3 med');
    const rest = new TextEncoder().encode('ia/list\n');
    let line: string | null = null;
    for (const byte of rest) line = scanner.feed(byte) ?? line;
    expect(line).toBe('~3 media/list');
  });
});

describe('DeviceClient（对着假板子跑完整协议）', () => {
  it('device/info 解析成字段', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    const info = await client.info();
    expect(info.id).toBe('aa:bb:cc:dd:ee:ff');
    expect(info.api).toBe(API_VERSION);
    expect(info.board).toBe('c6-lcd-147');
    expect(info.chunk).toBe(32);
    expect(info.screen).toEqual({ width: 320, height: 172 });
    expect(info.frame).toBe(0);
    expect(info.frames).toBe(0);
    // `io` 计数：诊断面板直接展示它，解析错了就会把"卡过"说成"没卡过"
    expect(info.io).toEqual({ failed: 0, txStuck: 0, ackTimeout: 0, hostLeft: 0, resends: 0 });
    // 请求带编号：v9 靠它配对，不再是"下一行就是回复"
    expect(board.requestIds).toEqual([1]);
  });

  it('device/info 的 io 计数逐项解析（回传时卡过的证据）', async () => {
    const board = new FakeBoard();
    board.io = { failed: 4, txStuck: 2, ackTimeout: 1, hostLeft: 1, resends: 7 };
    const client = await connect(board);
    const info = await client.info();
    expect(info.io).toEqual({ failed: 4, txStuck: 2, ackTimeout: 1, hostLeft: 1, resends: 7 });
  });

  it('旧固件不报 io 行时全是 0（不是 undefined）', async () => {
    const board = new FakeBoard();
    board.withoutIoLine = true;
    const client = await connect(board);
    const info = await client.info();
    expect(info.io).toEqual({ failed: 0, txStuck: 0, ackTimeout: 0, hostLeft: 0, resends: 0 });
  });

  it('device/info 的 board / chunk 跟着板子走（S3 那块）', async () => {
    const board = new FakeBoard();
    board.board = 's3-lcd-35';
    board.chunk = 512;
    board.screenWidth = 480;
    board.screenHeight = 320;
    const client = await connect(board);
    const info = await client.info();
    expect(info.board).toBe('s3-lcd-35');
    expect(info.chunk).toBe(512);
    expect(info.screen).toEqual({ width: 480, height: 320 });
  });

  it('旧固件没报 board / chunk 时也能用（回退到默认值）', async () => {
    const board = new FakeBoard();
    board.board = '';
    board.chunk = 0;
    const client = await connect(board);
    const info = await client.info();
    expect(info.board).toBe('');
    expect(info.chunk).toBe(32);
  });

  /**
   * 钉的是真机 bug：S3 的 `BoardConfig::get_chunk` 报 512，固件的回传循环却写死 32。
   * 于是主机按 512 收块、板子按 32 发块，第二块的 ACK 计数（64）大过板子这一块的实际
   * 长度（32），固件判 `BadCount` 放弃整次传输 —— 表现是海报全黑、素材显示 0 帧、
   * 下载一直卡到超时。这里用假板子把同一条不变量钉住：**宣告多少就按多少分块**。
   */
  it('板子宣告的回传块大小就是实际分块大小（S3 = 512）', async () => {
    const board = new FakeBoard();
    board.chunk = 512;
    // 1200 字节 = 512 + 512 + 176，跨三块，能暴露"块边界对不上"
    const payload = new Uint8Array(1200).map((_, i) => i & 0xff);
    board.files.set('S3BIG.ANM', payload);
    const client = await connect(board);
    await client.info();

    const got = await client.get('S3BIG.ANM');
    expect(got).toEqual(payload);
    expect(board.resends).toBe(0);
  });

  it('播放中 device/info 带上帧进度（卡片进度条用）', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    await client.play();
    board.frame = 7;
    board.frames = 28;
    const info = await client.info();
    expect(info.frame).toBe(7);
    expect(info.frames).toBe(28);
  });

  it('media/add 按 1024 字节分块并逐块等 ACK', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    const payload = new Uint8Array(2500).map((_, i) => i & 0xff);
    await client.add('AB12CD34.BMP', payload);
    expect(board.files.get('AB12CD34.BMP')).toEqual(payload);
  });

  it('上传的载荷第一字节哪怕是 0x00 / 0x01 也照原样进文件（靠标签槽，不看内容）', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    // 前两字节正好是 TAG_DATA / TAG_CTRL 的取值：按内容解释就会被咬断
    const payload = new Uint8Array([TAG_DATA, 1, 2, 3]);
    await client.add('TAG00001.BMP', payload);
    expect([...board.files.get('TAG00001.BMP')!]).toEqual([0, 1, 2, 3]);
  });

  it('media/add 的 ERR 会带着原因抛出来', async () => {
    const board = new FakeBoard();
    board.failNextUpload = 'SD write failed';
    const client = await connect(board);
    await expect(client.add('X.BMP', new Uint8Array(10))).rejects.toThrow(/SD write failed/);
    // 被拒绝之后没有残留：下一条命令照样能用
    expect(await client.list()).toHaveLength(0);
  });

  it('media/get 能整份取回，也能只取一段', async () => {
    const board = new FakeBoard();
    board.files.set('AB12CD34.ANM', new Uint8Array(3000).map((_, i) => i & 0xff));
    const client = await connect(board);

    const whole = await client.get('AB12CD34.ANM');
    expect(whole.length).toBe(3000);
    expect(whole[2999]).toBe(2999 & 0xff);

    const part = await client.get('AB12CD34.ANM', { offset: 100, length: 200 });
    expect(part.length).toBe(200);
    expect(part[0]).toBe(100 & 0xff);
  });

  it('大段读拆成几条命令，用户的命令能插在中间（不 read 整份再响应）', async () => {
    const board = new FakeBoard();
    board.chunk = 512;
    const payload = new Uint8Array(40 * 1024).map((_, i) => i & 0xff);
    board.files.set('BIG.ANM', payload);
    const client = await connect(board);
    // 先握手：没握过手时 `get` 会自己去问一次块大小（那第一条 info 就不是"用户插进来的"了）
    await client.info();
    const start = board.log.length;

    // 读还没完就点了下别的（真实场景里就是"删除/播放"，这里用 device/info 代替）
    const read = client.get('BIG.ANM', { length: payload.length });
    const info = client.info();
    const [bytes] = await Promise.all([read, info]);
    expect(bytes).toEqual(payload);

    const order = board.log.slice(start).filter(
      (line) => line.startsWith('media/get') || line === 'device/info',
    );
    const gets = order.filter((line) => line.startsWith('media/get'));
    expect(gets.length).toBeGreaterThanOrEqual(3);
    // 用户那条 device/info 夹在第一段和最后一段之间 —— 最多等一段（16 KiB），不用等整份读完
    const at = order.indexOf('device/info');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(order.length - 1);
  });

  it('一块都收不到时判失败：靠 media/abort 让固件停手，残留下毒不了下一条命令', async () => {
    const board = new FakeBoard();
    board.files.set('AB12CD34.ANM', new Uint8Array(4096).fill(0x41));
    // 一个字节都发不出来（比"丢尾巴"更狠）：补发几轮也没用，只能判失败
    board.failNextDownloads = [0];
    const client = await connect(board);

    await expect(
      client.get('AB12CD34.ANM', { offset: 0, length: 1024, timeoutMs: 60 }),
    ).rejects.toBeInstanceOf(TransportTimeout);

    // v9 不再发 `device/info` 当探针：直接 `media/abort <被中断请求的 id>`
    expect(board.aborted).toBe(1);
    expect(board.abortedId).toBe(idOf(board, 'media/get'));
    // 下一条真命令拿到的是它自己的回执，不是上一次的残留
    const entries = await client.list();
    expect(entries.map((entry) => entry.name)).toEqual(['AB12CD34.ANM']);
  });

  it('发送路径丢尾巴：主机 ACK 带实收字节数，板子只补发缺的那几个字节', async () => {
    const board = new FakeBoard();
    // 96 字节 = 3 块，足够验证"补发能补齐"，又不至于让测试等太久
    const payload = new Uint8Array(96).map((_, index) => index & 0xff);
    board.files.set('AB12CD34.ANM', payload);
    // 每一轮最多发出 8 字节（回传一块只有 32 字节）：不补发的话永远收不满
    board.failNextDownloads = [8];
    const client = await connect(board);

    const bytes = await client.get('AB12CD34.ANM', { length: payload.length, timeoutMs: 500 });
    expect(bytes).toEqual(payload);
    expect(board.resends).toBeGreaterThan(0);
  });

  it('一块载荷一个字节都没到：只再试一次就判失败（不再一块块磨）', async () => {
    const board = new FakeBoard();
    board.files.set('AB12CD34.ANM', new Uint8Array(16 * 1024));
    board.failNextDownloads = [0];
    const client = await connect(board);

    const started = Date.now();
    await expect(
      client.get('AB12CD34.ANM', { length: 16 * 1024, timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(TransportTimeout);
    // 老实现：16 块 × 每块等 5 轮 ≈ 4s。现在第一块试两次（2×50ms）就收手，
    // 收尾是 drain + abort（不再发探针）。
    expect(Date.now() - started).toBeLessThan(600);
  });

  it('上传中途取消：一槽之内生效、半截文件消失、abort 对上被中断那条的号', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    await client.info(); // 握手 + 拿到 chunk

    const payload = new Uint8Array(64 * 1024).fill(0x7e); // 64 块
    let cancelled = false;
    let cancelledAt = 0;
    const add = client.add('CANCEL.BMP', payload, (sent) => {
      // 第一块过了就取消：打断延迟的上限 = 一块 + 一次 ACK
      if (sent === CHUNK_UP && !cancelled) {
        cancelled = true;
        cancelledAt = Date.now();
        void client.cancelTransfer();
      }
    });

    await expect(add).rejects.toThrow(/已取消/);
    expect(Date.now() - cancelledAt).toBeLessThan(200);
    // 半截文件必须已经不在卡上，否则 `media/list` 会多出一个孤儿素材
    expect(board.files.has('CANCEL.BMP')).toBe(false);
    expect(board.aborted).toBe(1);
    expect(board.abortedId).toBe(idOf(board, 'media/add'));
    // 取消之后串口是干净的：下一条命令照常用自己的回执
    expect(await client.list()).toHaveLength(0);
  });

  it('下载中途取消：立刻带着手里的字节收手，不拖满 ACK 超时', async () => {
    const board = new FakeBoard();
    board.chunk = 512;
    board.files.set('CANCEL.ANM', new Uint8Array(64 * 1024).fill(0x33));
    const client = await connect(board);
    await client.info();

    let cancelled = false;
    let cancelledAt = 0;
    const read = client.get('CANCEL.ANM', {
      length: 8 * 1024,
      timeoutMs: 5_000,
      onProgress: () => {
        if (!cancelled) {
          cancelled = true;
          cancelledAt = Date.now();
          void client.cancelTransfer();
        }
      },
    });

    await expect(read).rejects.toThrow(/已取消/);
    expect(Date.now() - cancelledAt).toBeLessThan(200);
    expect(board.aborted).toBe(1);
    expect(board.abortedId).toBe(idOf(board, 'media/get'));
    expect(await client.list()).toHaveLength(1);
  });

  /**
   * 真固件在上传途中收到"不是 abort 的命令"时**就地失败**（那一槽的字节数已经对不上，
   * 继续收会把坏数据写进文件），而且**先给那条命令一个结论**（否则主机干等超时）。
   * 假板子照做，是为了把这条行为钉在测试里 —— 以前这类差异只有上真机才暴露。
   */
  it('上传途中插一条非 abort 的命令：两条都有结论，半截文件不留下来', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    await client.info();

    const payload = new Uint8Array(8 * 1024).fill(0x41);
    let injected = false;
    // 在第一块 ACK 之后（正好停在槽边界）灌一条 `media/list` —— 真机就是这个形状
    const add = client.add('STRAY.BMP', payload, () => {
      if (injected) return;
      injected = true;
      board.feedTransferFrame('media/list');
    });

    // 上传那条按"传输失败"收场，插进来的那条拿到自己的 ERR busy —— 谁都不会干等超时
    await expect(add).rejects.toThrow(/unexpected command/);
    expect(board.files.has('STRAY.BMP')).toBe(false);
    expect(board.log).toContain('media/list');
  });

  it('下载途中插一条非 abort 的命令：板子停手，不往裸字节里塞回执，命令随后照常处理', async () => {
    const board = new FakeBoard();
    board.chunk = 512;
    board.files.set('STRAY.ANM', new Uint8Array(8 * 1024).fill(0x5a));
    const client = await connect(board);
    await client.info();

    let injected = false;
    const read = client.get('STRAY.ANM', {
      length: 8 * 1024,
      timeoutMs: 400,
      onProgress: () => {
        if (injected) return;
        injected = true;
        board.feedTransferFrame('media/list');
      },
    });

    // 板子停手 → 这次读取凑不满字节，按超时收场（不会等到 15 秒，也不会当成整份读全）
    await expect(read).rejects.toBeInstanceOf(TransportTimeout);
    // 那条命令的**回执是有的**（不会凭空消失）：假板子和固件一样，先把手上的传输收场
    // 再处理它，所以它只在板子日志里出现一次
    expect(board.log.filter((line) => line === 'media/list')).toHaveLength(1);
    const entries = await client.list();
    expect(entries.map((entry) => entry.name)).toEqual(['STRAY.ANM']);
  });

  /**
   * 陈旧的取消（`media/abort` 点名的编号不是此刻在飞的那条传输）绝不能打断好好的传输。
   *
   * 上传方向：板子在收、TX 是空的，所以可以回一句 `~<abort号> ERR stale` 给个结论；
   * 回传方向：板子正在发裸字节，回话会被主机当载荷读进去（整次传输一起错位），
   * 所以只能悄悄丢掉。两条都是固件的真实行为，钉在测试里防止以后"顺手统一"掉。
   */
  it('上传途中收到点名错了的 abort：回 ERR stale 且传输照常完成', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    await client.info();

    const payload = new Uint8Array(4 * 1024).fill(0x42);
    let injected = false;
    const add = client.add('STALE.BMP', payload, () => {
      if (injected) return;
      injected = true;
      // 传输途中来一条"取消别人的"abort：编号 999 不是这次上传
      board.feedTransferFrame('media/abort 999');
    });
    await expect(add).resolves.toBeUndefined();
    expect(board.staleAborts).toBe(1);
    expect(board.aborted, '陈旧的 abort 不算真打断').toBe(0);
    expect(board.files.get('STALE.BMP')).toEqual(payload);
  });

  it('回传途中收到点名错了的 abort：悄悄丢掉，裸载荷里不混一个字节', async () => {
    const board = new FakeBoard();
    board.chunk = 512;
    const payload = new Uint8Array(4 * 1024).fill(0x7e); // 满屏哨兵：更能看出"回话"会被误读
    board.files.set('STALE.ANM', payload);
    const client = await connect(board);
    await client.info();

    let injected = false;
    const read = client.get('STALE.ANM', {
      length: payload.length,
      timeoutMs: 4_000,
      onProgress: () => {
        if (injected) return;
        injected = true;
        // 第一个块收完（正处在传输中）灌一条点名错了的取消
        board.feedTransferFrame('media/abort 999');
      },
    });
    const bytes = await read;
    expect(bytes).toEqual(payload);
    expect(board.staleAborts).toBe(1);
    expect(board.aborted, '陈旧的 abort 不算真打断').toBe(0);
  });

  it('没有传输在飞时 cancelTransfer 返回 false（不瞎发 abort）', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    await client.info();
    expect(await client.cancelTransfer()).toBe(false);
    expect(board.aborted).toBe(0);
  });

  it('getPartial：某一段读崩就带着手里的数据收手，不往下读', async () => {
    const board = new FakeBoard();
    const payload = new Uint8Array(64 * 1024).fill(0x22); // 4 段
    board.files.set('AB12CD34.ANM', payload);
    const client = await connect(board);
    const realGet = client.get.bind(client);
    let calls = 0;
    client.get = async (name, options) => {
      calls += 1;
      if (calls === 2) throw new TransportTimeout('模拟第二段读崩');
      return realGet(name, options);
    };

    const part = await client.getPartial('AB12CD34.ANM', {
      length: payload.length,
      timeoutMs: 500,
      retries: 0,
    });
    expect(part.complete).toBe(false);
    expect(part.bytes).toHaveLength(16 * 1024);
    expect(calls).toBe(2); // 第二段失败就收手，没去读第三、四段
  });

  it('getPartial：某一段没读上，就把已经读到的部分交出来（悬停预览靠它）', async () => {
    const board = new FakeBoard();
    const payload = new Uint8Array(32 * 1024).fill(0x5a);
    board.files.set('AB12CD34.ANM', payload);
    const client = await connect(board);
    const realGet = client.get.bind(client);
    let calls = 0;
    client.get = async (name, options) => {
      calls += 1;
      if (calls === 2) throw new TransportTimeout('模拟第二段读崩');
      return realGet(name, options);
    };

    const part = await client.getPartial('AB12CD34.ANM', {
      length: payload.length,
      timeoutMs: 500,
      retries: 0,
    });
    expect(part.complete).toBe(false);
    expect(part.bytes.length).toBeGreaterThan(0);
    expect(part.bytes.length).toBeLessThan(payload.length);
    expect([...part.bytes].every((byte) => byte === 0x5a)).toBe(true);
  });

  it('getPartial：失败的段会重试一次，好了就交完整结果', async () => {
    const board = new FakeBoard();
    const payload = new Uint8Array(2048).fill(0x33);
    board.files.set('AB12CD34.ANM', payload);
    const client = await connect(board);
    const realGet = client.get.bind(client);
    let calls = 0;
    client.get = async (name, options) => {
      calls += 1;
      if (calls === 1) throw new TransportTimeout('第一段先崩一次');
      return realGet(name, options);
    };

    const part = await client.getPartial('AB12CD34.ANM', { length: 2048, timeoutMs: 500 });
    expect(part.complete).toBe(true);
    expect(part.bytes).toEqual(payload);
  });

  it('media/list / media/delete / media/bench', async () => {
    const board = new FakeBoard();
    board.files.set('AB12CD34.ANM', new Uint8Array(100));
    const client = await connect(board);

    const entries = await client.list();
    expect(entries.map((entry) => entry.name)).toEqual(['AB12CD34.ANM']);

    const bench = await client.bench('AB12CD34.ANM', 1);
    expect(bench[0]).toContain('BENCH');

    await client.remove('AB12CD34.ANM');
    expect(board.files.has('AB12CD34.ANM')).toBe(false);
  });

  it('整表播放：play / stop 与 busy 都按协议走', async () => {
    const board = new FakeBoard();
    board.files.set('AB12CD34.ANM', new Uint8Array(100));
    const client = await connect(board);

    await client.play('AB12CD34.ANM');
    expect(board.played).toBe(1);
    expect((await client.info()).playing).toBe(true);
    expect((await client.info()).item).toBe('AB12CD34.ANM');

    // 播放期间改卡命令会被拒（网页据此先 stop 再重试）
    await expect(client.remove('AB12CD34.ANM')).rejects.toThrow(/busy/);

    await client.stop();
    expect(board.stopped).toBe(1);
    expect((await client.info()).playing).toBe(false);
  });

  it('多条命令排队执行，不会互相插队', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    const results = await Promise.all([client.info(), client.list(), client.info()]);
    expect(results).toHaveLength(3);
    // 假板子的日志就是收到命令的顺序：必须是串行的
    expect(board.log.filter((line) => line === 'device/info')).toHaveLength(2);
    expect(board.requestIds).toEqual([1, 2, 3]);
  });

  it('对不上号的应答会被丢掉，不会把别人的请求配坏', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    // 板子先胡说一句"~99 OK"（99 从来不是我们的编号）
    board.emit('play'); // 事件是 ~0 ev …，走事件那条支，不影响配对
    await settle();
    const entries = await client.list();
    expect(Array.isArray(entries)).toBe(true);
  });

  it('读超时会抛出 TransportTimeout', async () => {
    const bare = new Transport(new FakeBoard());
    await bare.open();
    await expect(bare.readLine(50)).rejects.toBeInstanceOf(TransportTimeout);
  });
});

describe('设备主动推的事件（取代 1.5 秒轮询）', () => {
  it('ev item / ev frame 交给订阅者，全程一次 device/info 都不发', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    const seen: string[] = [];
    client.onEvent((event) => seen.push(`${event.name}`));

    board.playing = true;
    board.emit(EVENTS.play);
    board.showItem(2, 5, 'AB12CD34.ANM');
    board.advanceFrame(3, 12);
    await settle();

    expect(seen).toEqual(['play', 'item', 'frame']);
    expect(board.log.filter((line) => line === 'device/info')).toHaveLength(0);
    expect(client.receivedEvents).toBe(true);
  });

  it('事件字段解析：item 带序号与文件名，frame 带两个数字', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    const got: unknown[] = [];
    client.onEvent((event) => got.push(event));
    board.showItem(3, 7, 'AB12CD34.ANM');
    board.advanceFrame(5, 28);
    await settle();
    expect(got[0]).toEqual({ name: 'item', index: 3, total: 7, file: 'AB12CD34.ANM' });
    expect(got[1]).toEqual({ name: 'frame', frame: 5, frames: 28 });
  });

  it('ev stop 之后不再需要 info；取消订阅就不再接收', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    const seen: string[] = [];
    const off = client.onEvent((event) => seen.push(event.name));
    board.emit(EVENTS.stop);
    await settle();
    expect(seen).toEqual(['stop']);
    off();
    board.emit(EVENTS.play);
    await settle();
    expect(seen).toEqual(['stop']);
  });

  it('认不出的事件原样带着，不会把界面打崩', async () => {
    const board = new FakeBoard();
    const client = await connect(board);
    const got: unknown[] = [];
    client.onEvent((event) => got.push(event));
    board.emit('future', 'x y');
    await settle();
    expect(got).toEqual([{ name: 'future', args: 'x y' }]);
  });
});

describe('重连（新建 DeviceClient）：编号从 1 重来', () => {
  it('每个 client 自己一套编号，串口上的应答按号归位', async () => {
    const first = new FakeBoard();
    const clientA = await connect(first);
    await clientA.info();
    await clientA.list();
    expect(first.requestIds).toEqual([1, 2]);

    const second = new FakeBoard();
    const clientB = await connect(second);
    await clientB.info();
    expect(second.requestIds).toEqual([1]);
  });
});

describe('ByteQueue', () => {
  it('取走一部分之后再推入，会把剩下的搬到前面', () => {
    const queue = new ByteQueue();
    queue.push(new Uint8Array(1000).fill(1));
    queue.take(900); // 留下 100 字节，start 前进到 900
    queue.push(new Uint8Array(5000).fill(2)); // 触发搬迁 + 扩容
    expect(queue.length).toBe(5100);
    const rest = queue.take(5100);
    expect(rest[0]).toBe(1);
    expect(rest[99]).toBe(1);
    expect(rest[100]).toBe(2);
    expect(rest[5099]).toBe(2);
  });
});

describe('DeviceClient.probe（连错端口的诊断）', () => {
  it('正常的板子能握手成功', async () => {
    const client = await connect(new FakeBoard());
    const info = await client.probe(200);
    expect(info.api).toBe(API_VERSION);
    expect(info.sd).toContain('microSD');
  });

  it('一声不吭的串口：短超时后报 HandshakeError，而不是干等十秒', async () => {
    const board = new FakeBoard();
    board.muteInfo = true;
    const client = await connect(board);
    const started = Date.now();
    await expect(client.probe(120)).rejects.toBeInstanceOf(HandshakeError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('说话但没按协议的串口：也报 HandshakeError', async () => {
    const board = new FakeBoard();
    board.noiseReply = 'hello from some other device';
    const client = await connect(board);
    await expect(client.probe(200)).rejects.toBeInstanceOf(HandshakeError);
  });

  it('回了 ERR 的串口按"协议对得上、固件太旧"处理，不当成别的设备', async () => {
    const board = new FakeBoard();
    board.noiseReply = 'ERR unknown command';
    const client = await connect(board);
    // 不是 HandshakeError（上层不会因此撤掉端口授权），而是一句能照做的提示
    await expect(client.probe(200)).rejects.toThrow(/检测到旧固件，请重新烧录/);
  });

  // 真机背景：打开串口会让板子复位（USB_UART_CHIP_RESET），第一条 device/info
  // 撞上引导加载器的纯文本日志 —— v9 靠哨兵把这些行整批当外来文本丢掉。
  const BOOT_LINES = [
    'ESP-ROM:esp32s3-20210327',
    'Build:Mar 27 2021',
    'rst:0x15 (USB_UART_CHIP_RESET),boot:0x8 (SPI_FAST_FLASH_BOOT)',
    'I (50) boot: ## Label            Usage          Type ST Offset   Length',
    'I (106) esp_image: segment 3: paddr=0001bb6c vaddr=00000000 size',
  ];

  it('握手丢掉引导日志：首行是 boot 文本也能连上', async () => {
    const board = new FakeBoard();
    board.bootLines = BOOT_LINES;
    const client = await connect(board);
    const info = await client.probe(2_000);
    expect(info.api).toBe(API_VERSION);
    expect(info.board).toBe('c6-lcd-147');
  });

  it('第一条 device/info 丢在复位里（无回应）时重发，而不是报"连不上"', async () => {
    const board = new FakeBoard();
    board.bootLines = BOOT_LINES;
    board.dropInfo = 1; // 第一条命令整个丢在复位窗口里
    const client = await connect(board);
    const info = await client.probe(2_500);
    expect(info.api).toBe(API_VERSION);
  });

  it('重发之后多出来的那份回执不会毒化下一条命令', async () => {
    const board = new FakeBoard();
    board.bootLines = BOOT_LINES;
    board.dropInfo = 1;
    const client = await connect(board);
    await client.probe(2_500);
    // probe 重发过一次：迟到的那一份按编号配不上（对不上号就丢掉），
    // media/list 拿到的是它自己的回执
    const files = await client.list();
    expect(Array.isArray(files)).toBe(true);
  });

  it('真的是别的设备（一直只说人话）仍然报 HandshakeError，不会重试到超时', async () => {
    const board = new FakeBoard();
    board.noiseReply = 'hello from some other device';
    const client = await connect(board);
    const started = Date.now();
    await expect(client.probe(300)).rejects.toBeInstanceOf(HandshakeError);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
