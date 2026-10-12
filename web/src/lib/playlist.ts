/**
 * `data/PLAYLIST`：给固件看的播放清单。
 *
 * 格式极简，一行一项：`<文件名> <循环次数>`（0 = 一直播）。`#` 开头是注释。
 * 被"跳过"的条目**根本不写进来** —— 固件不需要知道 skip 这个概念。
 */
import { entryFileName, type IndexEntry, type MediaIndex } from './index-file';
import { normalizeLoops } from './loops';

export const PLAYLIST_NAME = 'PLAYLIST';

/**
 * 这条素材会不会进 `data/PLAYLIST`：**静图**和**被跳过**的都不进。
 *
 * 界面判断"播放按钮该不该禁用"用的也是这个函数，别在别处重写一遍条件。
 */
export function isPlayable(entry: Pick<IndexEntry, 'kind' | 'skip'>): boolean {
  return !entry.skip && entry.kind === 'anim';
}

export function buildPlaylist(index: MediaIndex): Uint8Array {
  const lines = ['# Pet Board 播放清单：一行一项，格式 <文件名> <循环次数>，0 = 一直播'];
  for (const entry of index.entries) {
    if (!isPlayable(entry)) continue;
    // 索引可能是手改过的：越界的次数在这里收一下，免得固件整行跳过
    lines.push(`${entryFileName(entry)} ${normalizeLoops(entry.loops)}`);
  }
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}
