/**
 * 播放次数：**不属于 `.ANM` 文件**，游戏规则是"谁播谁给"。
 *
 * 网页把它存在卡上的 `data/INDEX` 里，再由 `buildPlaylist` 写进 `data/PLAYLIST`；
 * 固件整表播放时按每行的第二个字段决定这个条目播几轮。
 *
 * 文件内容不随播放次数变化，所以改循环**不用重新编码、不用重新上传**。
 */

/** `0` = 一直播，直到收到 `media/stop` */
export const LOOPS_INFINITE = 0;
/** 新素材的默认轮数（和 `data/PLAYLIST` 里的含义一致） */
export const DEFAULT_LOOPS = 10;
/** 输入上限：`u16` 其实放得下 65535，留一半余量避免手滑输入天文数字 */
export const MAX_LOOPS = 32767;

/** 把任意输入规整成合法值：`<= 0`（含 0）= 一直播，其余落在 1..MAX_LOOPS */
export function normalizeLoops(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LOOPS;
  const rounded = Math.trunc(value);
  if (rounded <= LOOPS_INFINITE) return LOOPS_INFINITE;
  return Math.min(rounded, MAX_LOOPS);
}

/** 界面上显示播放次数："一直播" / "12 轮" */
export function formatLoops(loops: number): string {
  return loops === LOOPS_INFINITE ? '一直播' : `${loops} 轮`;
}
