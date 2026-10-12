import { describe, expect, it } from 'vitest';

import type { IndexEntry } from '@/lib/index-file';
import { buildPlaylist } from '@/lib/playlist';

function entry(id: string, ext: 'ANM' | 'BMP', loops: number, skip = false): IndexEntry {
  return {
    id,
    ext,
    kind: ext === 'ANM' ? 'anim' : 'still',
    width: 312,
    height: 164,
    frames: 10,
    loops,
    durationMs: 400,
    bytes: 1000,
    sourceName: 'x.gif',
    sourceType: 'gif',
    fit: 'contain',
    skip,
    createdAt: 1,
  };
}

describe('buildPlaylist', () => {
  it('一行一项，跳过的不写、静图不写，数组顺序就是播放顺序', () => {
    const index = {
      version: 1,
      entries: [entry('AAAA1111', 'ANM', 20), entry('BBBB2222', 'ANM', 0, true), entry('CCCC3333', 'BMP', 1)],
    };
    const text = new TextDecoder().decode(buildPlaylist(index));
    const lines = text.trim().split('\n');
    expect(lines[0].startsWith('#')).toBe(true);
    expect(lines.slice(1)).toEqual(['AAAA1111.ANM 20']);
    expect(text).not.toContain('BBBB2222');
    expect(text).not.toContain('CCCC3333');
  });

  it('无限循环写成 0', () => {
    const text = new TextDecoder().decode(buildPlaylist({ version: 1, entries: [entry('AAAA1111', 'ANM', 0)] }));
    expect(text).toContain('AAAA1111.ANM 0');
  });

  it('索引被手改过（越界次数）时收进合法范围，免得固件把整行跳过', () => {
    const text = new TextDecoder().decode(
      buildPlaylist({ version: 1, entries: [entry('AAAA1111', 'ANM', 999_999)] }),
    );
    expect(text).toContain('AAAA1111.ANM 32767');
  });
});
