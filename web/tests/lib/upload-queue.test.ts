import { describe, expect, it } from 'vitest';

import type { ConvertedMedia } from '@/lib/convert';
import { UploadQueue, type UploadItem } from '@/lib/upload-queue';

function file(name: string): File {
  return new File([new Uint8Array(4)], name, { type: 'image/gif' });
}

function media(name: string): ConvertedMedia {
  return {
    kind: 'anim',
    ext: 'ANM',
    payload: new Uint8Array(16).fill(name.charCodeAt(name.length - 1)),
    width: 312,
    height: 164,
    frames: 2,
    durationMs: 80,
    sourceType: 'gif',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  queue: UploadQueue;
  uploaded: string[];
  uploadedPayloads: string[];
  maxPrepare: () => number;
  maxUpload: () => number;
  items: () => UploadItem[];
}

/**
 * `outputsPerFile` 用来模拟静态 WebP 精灵图拆成多段；
 * `failOutput` 用来让某个文件的第 N 个输出失败（-1 表示不失败）。
 */
function harness(failOn?: string, outputsPerFile = 1, failOutput = -1, onCancel?: () => Promise<boolean>): Harness {
  const uploaded: string[] = [];
  const uploadedPayloads: string[] = [];
  let preparing = 0;
  let uploading = 0;
  let alreadyFailed = false;
  let maxPrepare = 0;
  let maxUpload = 0;
  let latest: UploadItem[] = [];
  const outputCursors = new Map<string, number>();

  const queue = new UploadQueue({
    convert: async (f) => {
      preparing += 1;
      maxPrepare = Math.max(maxPrepare, preparing);
      await sleep(5);
      preparing -= 1;
      return Array.from({ length: outputsPerFile }, (_, index) => media(`${f.name}:${index}`));
    },
    upload: async (item, payload) => {
      const outputIndex = outputCursors.get(item.file.name) ?? 0;
      outputCursors.set(item.file.name, outputIndex + 1);

      uploading += 1;
      maxUpload = Math.max(maxUpload, uploading);
      uploaded.push(item.file.name);
      uploadedPayloads.push(new TextDecoder().decode(payload.payload.slice(0, 1)));
      try {
        await sleep(3);
      } finally {
        uploading -= 1;
      }

      // 只失败一次：这样"重试"才有意义（模拟偶发失败）
      if (failOn === item.file.name && (failOutput < 0 || failOutput === outputIndex) && !alreadyFailed) {
        alreadyFailed = true;
        throw new Error('SD write failed');
      }
    },
    cancelTransfer: onCancel,
    onChange: (items) => {
      latest = items;
    },
  });

  return {
    queue,
    uploaded,
    uploadedPayloads,
    maxPrepare: () => maxPrepare,
    maxUpload: () => maxUpload,
    items: () => latest,
  };
}

describe('UploadQueue', () => {
  it('上传严格串行且按顺序，转换可以并行', async () => {
    const h = harness();
    h.queue.add(['a.gif', 'b.gif', 'c.gif', 'd.gif', 'e.gif'].map(file));
    const count = await h.queue.run();

    expect(count).toBe(5);
    expect(h.uploaded).toEqual(['a.gif', 'b.gif', 'c.gif', 'd.gif', 'e.gif']);
    expect(h.maxUpload()).toBe(1); // 串口一次只能一问一答
    expect(h.maxPrepare()).toBeGreaterThan(1); // 但转换确实并行预取
    expect(h.maxPrepare()).toBeLessThanOrEqual(4);
    expect(h.items().every((item) => item.status === 'done')).toBe(true);
  });

  it('一个文件可以拆成多段，按顺序逐个上传', async () => {
    const h = harness(undefined, 2);
    h.queue.add([file('sheet.webp')]);
    const count = await h.queue.run();

    expect(count).toBe(2);
    expect(h.uploaded).toEqual(['sheet.webp', 'sheet.webp']);
    expect(h.uploadedPayloads).toEqual(['0', '1']);
    expect(h.items()[0].status).toBe('done');
    expect(h.items()[0].uploadedOutputs).toBe(2);
  });

  it('多段上传中途失败，重试从失败段继续，不会重传成功的段', async () => {
    const h = harness('sheet.webp', 2, 1);
    h.queue.add([file('sheet.webp')]);
    await h.queue.run();

    const item = h.items()[0];
    expect(item.status).toBe('failed');
    expect(item.uploadedOutputs).toBe(1);
    expect(h.uploaded).toEqual(['sheet.webp', 'sheet.webp']);
    expect(h.uploadedPayloads).toEqual(['0', '1']);

    h.queue.retry(item.id);
    await h.queue.run();

    expect(h.uploaded).toEqual(['sheet.webp', 'sheet.webp', 'sheet.webp']);
    expect(h.uploadedPayloads).toEqual(['0', '1', '1']); // 只补传失败的 1，没有重传 0
    expect(h.items()[0].status).toBe('done');
    expect(h.items()[0].uploadedOutputs).toBe(2);
  });

  it('单个失败不影响别人，失败项可以单独重试', async () => {
    const h = harness('c.gif');
    h.queue.add(['a.gif', 'b.gif', 'c.gif'].map(file));
    await h.queue.run();

    expect(h.uploaded).toEqual(['a.gif', 'b.gif', 'c.gif']);
    const failed = h.items().filter((item) => item.status === 'failed');
    expect(failed.map((item) => item.file.name)).toEqual(['c.gif']);

    // 重试时因为 payload 还在，只会重传不会重转
    const target = h.items().find((item) => item.file.name === 'c.gif')!;
    h.queue.retry(target.id);
    await h.queue.run();
    expect(h.items().every((item) => item.status === 'done')).toBe(true);
  });

  it('上传前可以移除某一项，顺序不乱，也不会留下重复 id', async () => {
    const h = harness();
    h.queue.add(['a.gif', 'b.gif', 'c.gif'].map(file));
    const b = h.items().find((item) => item.file.name === 'b.gif')!;
    h.queue.remove(b.id);
    expect(h.items().map((item) => item.file.name)).toEqual(['a.gif', 'c.gif']);

    h.queue.add([file('d.gif')]);
    const ids = h.items().map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);

    await h.queue.run();
    expect(h.uploaded).toEqual(['a.gif', 'c.gif', 'd.gif']);
    expect(h.items().every((item) => item.status === 'done')).toBe(true);
  });

  it('取消上传：叫停设备那一步、当前项失败、剩下的项不再往下传', async () => {
    let cancelled = 0;
    const h = harness(undefined, 1, -1, async () => {
      cancelled += 1;
      return true;
    });
    h.queue.add(['a.gif', 'b.gif', 'c.gif'].map(file));
    const run = h.queue.run();
    // 第一项正在传的时候按取消
    await sleep(2);
    await h.queue.requestCancel();
    const count = await run;

    expect(cancelled).toBe(1); // 只叫停一次（板子据此删半截文件）
    expect(count).toBeLessThan(3); // 后面没传完
    const statuses = h.items().map((item) => item.status);
    expect(statuses).toContain('failed'); // 被取消那一项标失败
    expect(statuses).toContain('pending'); // 没轮到的留在原地，等下次再点上传
  });

  it('取消之后再点重试，标记会清掉，不会一传就断', async () => {
    const h = harness(undefined, 1, -1, async () => true);
    h.queue.add([file('a.gif')]);
    const run = h.queue.run();
    await sleep(2);
    await h.queue.requestCancel();
    await run;
    const target = h.items()[0];
    expect(target.status).toBe('failed');

    h.queue.retry(target.id);
    await h.queue.run();
    expect(h.items()[0].status).toBe('done');
  });

  it('重试全部失败项', async () => {
    const h = harness('a.gif');
    h.queue.add(['a.gif', 'b.gif'].map(file));
    await h.queue.run();
    expect(h.items().filter((item) => item.status === 'failed')).toHaveLength(1);

    h.queue.retryFailed();
    await h.queue.run();
    expect(h.items().every((item) => item.status === 'done')).toBe(true);
  });
});
