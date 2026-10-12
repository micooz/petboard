import { describe, expect, it } from 'vitest';

import { DEFAULT_LOOPS, MAX_LOOPS, formatLoops, normalizeLoops } from '@/lib/loops';

describe('循环次数（存在 INDEX 里，不在 .ANM 文件里）', () => {
  it('默认值和上限', () => {
    expect(DEFAULT_LOOPS).toBe(10);
    expect(MAX_LOOPS).toBe(32767);
  });

  it('normalizeLoops：0 及以下是"一直播"，超上限收到上限，非法值回落默认', () => {
    expect(normalizeLoops(0)).toBe(0);
    expect(normalizeLoops(-5)).toBe(0);
    expect(normalizeLoops(3)).toBe(3);
    expect(normalizeLoops(3.9)).toBe(3);
    expect(normalizeLoops(999_999)).toBe(MAX_LOOPS);
    expect(normalizeLoops(Number.NaN)).toBe(DEFAULT_LOOPS);
  });

  it('formatLoops：0 显示"一直播"', () => {
    expect(formatLoops(0)).toBe('一直播');
    expect(formatLoops(12)).toBe('12 轮');
  });
});
