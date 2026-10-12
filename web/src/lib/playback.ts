/**
 * 播放进度的换算（纯函数，方便单测）。
 *
 * 卡片上的进度条要的是**这条素材的整体进度**，不是当前这一轮的进度：
 * 设备只报"第几轮 + 本轮第几帧"，所以这里把两段合成一条：
 *
 * ```text
 * 整体 = ( (轮次 - 1) + 本轮帧进度 ) / 总轮数
 * ```
 *
 * 无限循环（`loops = 0`）没有整体终点，退回"本轮进度" —— 它至少能说明这一轮走到哪了。
 */

/**
 * 换算成 0..100 的百分比；设备还没报帧信息（`frames = 0`）时返回 `null`，
 * 调用方据此**不画**进度条（宁可不画，也不画假的）。
 */
export function itemProgressPercent(loops: number, loop: number, frame: number, frames: number): number | null {
  if (frames <= 0) return null;
  const withinLoop = Math.min(1, Math.max(0, frame / frames));
  // 无限循环（0）没有整体终点：轮次无意义，只看本轮走到哪
  if (loops === 0) return withinLoop * 100;
  const done = Math.max(0, loop - 1) + withinLoop;
  return Math.min(100, (done / Math.max(1, loops)) * 100);
}
