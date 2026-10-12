/**
 * 上传队列：**上传串行、转换并行**。
 *
 * 串口是严格一问一答的单链路（每块都要等 ACK），所以"并发上传"物理上做不到；
 * 能并发的是**转换**（解码 GIF/WebP、缩放、打包）。这里就做一条流水线：
 *
 * - 预转换池：同时准备 2~4 个文件（按实测"转换耗时 vs 上传耗时"自动增减）；
 * - 上传游标：永远只传一个，轮到谁就等谁准备完；
 * - 一个输入文件可以产出多个素材（静态 WebP 精灵图按行拆分），按顺序逐个上传；
 * - 单个失败不影响别人：标红、跳过，之后可以单图重试或一键重试全部失败项。
 *
 * 依赖是注入的（`convert` / `upload`），所以这套调度能脱离串口和浏览器单测。
 */
import type { ConvertedMedia } from './convert';

export type UploadStatus = 'pending' | 'preparing' | 'ready' | 'uploading' | 'done' | 'failed';

export interface UploadItem {
  id: string;
  file: File;
  status: UploadStatus;
  /** 0..1，只有 uploading 时才有意义；多输出时是整体进度 */
  progress: number;
  error?: string;
  /** 转换结果；一个文件可能拆成多段 */
  payloads?: ConvertedMedia[];
  /** 下一个要上传的 payload 下标；部分成功后重试从这里继续 */
  nextOutput: number;
  /** 已经成功上传的 payload 数 */
  uploadedOutputs: number;
}

export interface UploadQueueOptions {
  /** 把一个文件转换成 1..N 个素材；静态 WebP 精灵图可能返回多段 */
  convert: (file: File) => Promise<ConvertedMedia[]>;
  /** 传一个素材；`onProgress(sent, total)` 用来画进度环 */
  upload: (item: UploadItem, payload: ConvertedMedia, onProgress: (sent: number, total: number) => void) => Promise<void>;
  /**
   * 取消**当前正在传的那一槽**（v9 的 `media/abort`）：由上层打到设备上。
   * 注入进来是为了这套调度仍能脱离串口单测。
   */
  cancelTransfer?: () => Promise<boolean>;
  onChange: (items: UploadItem[]) => void;
  /** 预转换并发上限 */
  maxPrepare?: number;
  minPrepare?: number;
}

const MIN_PREPARE = 2;
const MAX_PREPARE = 4;

export class UploadQueue {
  readonly items: UploadItem[] = [];
  private prepareCursor = 0;
  private uploadCursor = 0;
  private pool = MIN_PREPARE;
  private prepareMs = 0;
  private uploadMs = 0;
  private running = false;
  /** 仅用来生成稳定的 id；用自增序号，删掉中间某项后新加的也不会撞 id */
  private seq = 0;
  /**
   * 按过"取消"：当前这一项交给设备层的 abort 去失败（半截文件由板子删），
   * 队列**不再往下传**，剩下的项留在原地等下次点"上传文件"。
   */
  private cancelRequested = false;

  constructor(private readonly options: UploadQueueOptions) {}

  add(files: File[]): void {
    for (const file of files) {
      this.items.push({
        id: `${file.name}:${file.size}:${this.seq++}`,
        file,
        status: 'pending',
        progress: 0,
        nextOutput: 0,
        uploadedOutputs: 0,
      });
    }
    this.emit();
  }

  /** 移除一项；只有还没开始上传（pending）时才会被调用 */
  remove(id: string): void {
    const at = this.items.findIndex((item) => item.id === id);
    if (at < 0) return;
    this.items.splice(at, 1);
    if (at < this.prepareCursor) this.prepareCursor -= 1;
    if (at < this.uploadCursor) this.uploadCursor -= 1;
    this.emit();
  }

  /**
   * 取消上传：先叫停设备上正在传的那一槽（打断延迟上限 = 一块 + 一次 ACK），
   * 再让队列停在当前项。剩下没传的项保持原状态，用户想继续再点一次"上传文件"。
   */
  async requestCancel(): Promise<void> {
    this.cancelRequested = true;
    await this.options.cancelTransfer?.().catch(() => false);
    this.emit();
  }

  get cancelling(): boolean {
    return this.cancelRequested;
  }

  clear(): void {
    this.cancelRequested = false;
    this.items.length = 0;
    this.prepareCursor = 0;
    this.uploadCursor = 0;
    this.pool = MIN_PREPARE;
    this.emit();
  }

  get hasWork(): boolean {
    return this.items.some((item) => item.status !== 'done');
  }

  /** 单个失败项重试：转换结果还在就从上次失败的段继续，不然从头来 */
  retry(id: string): void {
    const at = this.items.findIndex((item) => item.id === id);
    if (at < 0) return;
    this.cancelRequested = false;
    const item = this.items[at];
    const hasPayloads = item.payloads !== undefined && item.payloads.length > 0;
    item.status = hasPayloads ? 'ready' : 'pending';
    item.error = undefined;
    item.progress = hasPayloads && item.payloads ? item.uploadedOutputs / item.payloads.length : 0;
    if (!hasPayloads) {
      item.nextOutput = 0;
      item.uploadedOutputs = 0;
    }
    this.uploadCursor = Math.min(this.uploadCursor, at);
    this.prepareCursor = Math.min(this.prepareCursor, at);
    this.emit();
  }

  retryFailed(): void {
    this.cancelRequested = false;
    for (const item of this.items) {
      if (item.status !== 'failed') continue;
      const hasPayloads = item.payloads !== undefined && item.payloads.length > 0;
      item.status = hasPayloads ? 'ready' : 'pending';
      item.error = undefined;
      if (hasPayloads && item.payloads) {
        item.progress = item.uploadedOutputs / item.payloads.length;
      } else {
        item.nextOutput = 0;
        item.uploadedOutputs = 0;
        item.progress = 0;
      }
    }
    this.uploadCursor = 0;
    this.prepareCursor = Math.min(this.prepareCursor, this.uploadCursor);
    this.emit();
  }

  /** @returns 成功上传的素材数（多段文件按段计数） */
  async run(): Promise<number> {
    if (this.running) return this.uploadedCount();
    this.running = true;
    this.cancelRequested = false;
    try {
      const preparing = new Map<number, Promise<void>>();

      while (this.uploadCursor < this.items.length) {
        const current = this.items[this.uploadCursor];
        if (current.status === 'done' || current.status === 'failed') {
          this.uploadCursor += 1;
          continue;
        }
        if (current.status === 'ready') {
          await this.uploadOne(this.uploadCursor);
          this.uploadCursor += 1;
          // 用户按了取消：当前项已经失败（半截文件由板子删掉），后面的项留在原地
          if (this.cancelRequested) break;
          continue;
        }

        this.fillPool(preparing);
        if (preparing.size > 0) {
          await Promise.race(preparing.values());
          continue;
        }
        // 既没在准备、又不是 ready：理论上不会发生，兜一下防止死循环
        this.items[this.uploadCursor].status = 'failed';
        this.items[this.uploadCursor].error = '内部错误：这项既没准备也没结果';
        this.emit();
      }

      // 剩余还在准备的（比如全部失败后重试）等它们跑完
      while (preparing.size > 0) await Promise.race(preparing.values());
    } finally {
      this.running = false;
    }
    return this.uploadedCount();
  }

  private uploadedCount(): number {
    return this.items.reduce((sum, item) => sum + item.uploadedOutputs, 0);
  }

  private fillPool(preparing: Map<number, Promise<void>>): void {
    const min = this.options.minPrepare ?? MIN_PREPARE;
    const max = this.options.maxPrepare ?? MAX_PREPARE;
    this.pool = Math.min(Math.max(this.pool, min), max);

    while (this.prepareCursor < this.items.length && preparing.size < this.pool) {
      const at = this.prepareCursor;
      const item = this.items[at];
      this.prepareCursor += 1;
      if (item.status !== 'pending') continue;
      const task = this.prepare(at).finally(() => {
        preparing.delete(at);
      });
      preparing.set(at, task);
    }
  }

  private async prepare(at: number): Promise<void> {
    const item = this.items[at];
    item.status = 'preparing';
    this.emit();
    const started = Date.now();
    try {
      const payloads = await this.options.convert(item.file);
      if (payloads.length === 0) throw new Error('转换结果是空的');
      item.payloads = payloads;
      item.nextOutput = 0;
      item.uploadedOutputs = 0;
      item.status = 'ready';
      this.prepareMs = Date.now() - started;
      this.tune();
    } catch (error) {
      item.status = 'failed';
      item.error = error instanceof Error ? error.message : String(error);
    }
    this.emit();
  }

  private async uploadOne(at: number): Promise<void> {
    const item = this.items[at];
    const payloads = item.payloads;
    if (!payloads || payloads.length === 0) return;

    const totalBytes = payloads.reduce((sum, payload) => sum + payload.payload.length, 0);
    let uploadedBytes = payloads
      .slice(0, item.nextOutput)
      .reduce((sum, payload) => sum + payload.payload.length, 0);

    item.status = 'uploading';
    item.progress = totalBytes === 0 ? 1 : uploadedBytes / totalBytes;
    this.emit();

    const started = Date.now();
    try {
      for (let index = item.nextOutput; index < payloads.length; index += 1) {
        if (this.cancelRequested) throw new Error('已取消上传');
        const payload = payloads[index];
        await this.options.upload(item, payload, (sent, total) => {
          const done = total === 0 ? payload.payload.length : (sent / total) * payload.payload.length;
          item.progress = totalBytes === 0 ? 1 : Math.min(1, Math.max(0, (uploadedBytes + done) / totalBytes));
          this.emit();
        });
        item.nextOutput = index + 1;
        item.uploadedOutputs = index + 1;
        uploadedBytes += payload.payload.length;
        item.progress = totalBytes === 0 ? 1 : uploadedBytes / totalBytes;
        this.emit();
      }
      item.status = 'done';
      item.progress = 1;
      this.uploadMs = Date.now() - started;
      this.tune();
    } catch (error) {
      item.status = 'failed';
      item.error = error instanceof Error ? error.message : String(error);
    }
    this.emit();
  }

  /**
   * 按"哪一段更慢"调整预转换并发：
   * 转换明显比上传慢就多开几个（最多 4），转换快得多就收回到 2，省得白占 CPU。
   */
  private tune(): void {
    const min = this.options.minPrepare ?? MIN_PREPARE;
    const max = this.options.maxPrepare ?? MAX_PREPARE;
    if (this.prepareMs > this.uploadMs * 1.2 && this.pool < max) this.pool += 1;
    else if (this.prepareMs * 2 < this.uploadMs && this.pool > min) this.pool -= 1;
  }

  private emit(): void {
    this.options.onChange([...this.items]);
  }
}
