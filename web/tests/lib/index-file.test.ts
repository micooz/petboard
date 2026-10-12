import { describe, expect, it } from 'vitest';

import {
  entryFileName,
  extOf,
  hasGeometry,
  needsMetadataRecovery,
  parseIndex,
  reconcile,
  recoverIndexMetadata,
  serializeIndex,
  type IndexEntry,
} from '@/lib/index-file';

function entry(id: string, skip = false): IndexEntry {
  return {
    id,
    ext: 'ANM',
    kind: 'anim',
    width: 312,
    height: 164,
    frames: 24,
    loops: 1,
    durationMs: 1000,
    bytes: 535000,
    sourceName: 'cat.gif',
    sourceType: 'gif',
    fit: 'contain',
    skip,
    createdAt: 1758888000000,
  };
}

describe('INDEX 读写', () => {
  it('往返保留数组顺序和 skip', () => {
    const bytes = serializeIndex({ version: 1, entries: [entry('AAAA1111'), entry('BBBB2222', true)] });
    const back = parseIndex(bytes);
    expect(back?.entries.map((item) => item.id)).toEqual(['AAAA1111', 'BBBB2222']);
    expect(back?.entries[1].skip).toBe(true);
  });

  it('往返保留静态精灵图的 sheet 元数据', () => {
    const bytes = serializeIndex({
      version: 1,
      entries: [{ ...entry('AAAA1111'), sheet: { mode: 'row', row: 2, rows: 7, delayMs: 100 } }],
    });
    expect(parseIndex(bytes)?.entries[0].sheet).toEqual({ mode: 'row', row: 2, rows: 7, delayMs: 100 });
  });

  it('把被重建出来的 0 帧空壳用本机快照元数据补回来', () => {
    const current = { version: 1, entries: [{ ...entry('AAAA1111'), width: 0, height: 0, frames: 0, durationMs: 0, sourceType: 'unknown' }] };
    const local = { version: 1, entries: [entry('AAAA1111')] };
    const recovered = recoverIndexMetadata(current, local);
    expect(recovered.entries[0].frames).toBe(24);
    expect(recovered.entries[0].sourceType).toBe('gif');
  });

  /**
   * `hasGeometry` 和 `needsMetadataRecovery` 的分工：来源格式未知**不该**挡住首帧图。
   *
   * 钉的是"素材卡片一直是黑块"：索引里的空壳从卡上文件头补回尺寸之后，来源仍然未知
   * （本机没有原图），按旧判据会永远画不出海报。
   */
  it('来源未知但尺寸齐全时：仍需恢复元数据，但已能画首帧图', () => {
    const shell = { ...entry('AAAA1111'), sourceType: 'unknown' };
    expect(needsMetadataRecovery(shell)).toBe(true);
    expect(hasGeometry(shell)).toBe(true);
    // 尺寸/帧数缺任何一个都不行
    expect(hasGeometry({ ...entry('AAAA1111'), frames: 0 })).toBe(false);
    expect(hasGeometry({ ...entry('AAAA1111'), width: 0 })).toBe(false);
    expect(hasGeometry({ ...entry('AAAA1111'), height: 0 })).toBe(false);
  });

  it('版本不对 / 不是 JSON 就当作没有索引', () => {
    expect(parseIndex(new TextEncoder().encode('{"version":9,"entries":[]}'))).toBeNull();
    expect(parseIndex(new TextEncoder().encode('{oops'))).toBeNull();
  });

  it('以卡上的文件为准做对账', () => {
    const index = { version: 1, entries: [entry('AAAA1111'), entry('BBBB2222')] };
    const { index: fixed, missing, orphans } = reconcile(index, [
      { name: 'AAAA1111.ANM', size: 535000 },
      { name: 'CCCC3333.BMP', size: 100 },
    ]);
    expect(fixed.entries.map(entryFileName)).toEqual(['AAAA1111.ANM']);
    expect(missing).toEqual(['BBBB2222.ANM']);
    expect(orphans).toEqual(['CCCC3333.BMP']);
  });

  it('extOf 认后缀', () => {
    expect(extOf('AB12CD34.ANM')).toBe('ANM');
    expect(extOf('ab12cd34.bmp')).toBe('BMP');
    expect(extOf('INDEX')).toBeNull();
  });
});
