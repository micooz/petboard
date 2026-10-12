import { describe, expect, it } from 'vitest';

import { itemProgressPercent } from '@/lib/playback';

describe('卡片上的播放进度（整体进度）', () => {
  it('多轮：按"轮次 + 本轮帧进度"占总轮数的比例', () => {
    // 第 1 轮刚过一半 → 整体 5%
    expect(itemProgressPercent(10, 1, 14, 28)).toBeCloseTo(5);
    // 第 5 轮结束 → 整体 50%
    expect(itemProgressPercent(10, 5, 28, 28)).toBeCloseTo(50);
    // 最后一轮播完 → 100%
    expect(itemProgressPercent(10, 10, 28, 28)).toBeCloseTo(100);
  });

  it('单轮：就是这一轮的进度', () => {
    expect(itemProgressPercent(1, 1, 7, 28)).toBeCloseTo(25);
    expect(itemProgressPercent(1, 1, 28, 28)).toBeCloseTo(100);
  });

  it('无限循环（0）没有整体终点：退回"本轮进度"', () => {
    expect(itemProgressPercent(0, 3, 14, 28)).toBeCloseTo(50);
  });

  it('算出来永远落在 0..100（设备报的轮次可能比网页记的多）', () => {
    expect(itemProgressPercent(3, 99, 28, 28)).toBe(100);
    expect(itemProgressPercent(3, 0, 0, 28)).toBeGreaterThanOrEqual(0);
  });

  it('设备没报帧信息就不画：返回 null', () => {
    expect(itemProgressPercent(3, 1, 0, 0)).toBeNull();
  });
});
