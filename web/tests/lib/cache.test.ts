import { describe, expect, it } from 'vitest';

import { openCacheDb } from '@/lib/cache';

/** 本机库的版本比代码里那份还新时，`indexedDB.open` 回的错 */
function versionError(): Error {
  const error = new Error('requested version (1) is less than existing version (3)');
  error.name = 'VersionError';
  return error;
}

const fakeDb = { name: 'fake' } as unknown as IDBDatabase;

describe('openCacheDb（本机库的 schema 对不上自愈）', () => {
  it('本机是更新的版本：删掉重建，缓存不该永久不可用', async () => {
    const asked: number[] = [];
    let dropped = 0;
    const db = await openCacheDb(
      async (version) => {
        asked.push(version);
        if (asked.length === 1) throw versionError();
        return fakeDb;
      },
      async () => {
        dropped += 1;
      },
    );

    expect(db).toBe(fakeDb);
    // 删一次，然后按同一个版本重开
    expect(dropped).toBe(1);
    expect(asked).toEqual([1, 1]);
  });

  it('别的原因打不开（没有 IndexedDB、配额满）：不删库，照原样往上抛', async () => {
    let dropped = 0;
    const failure = new Error('这个浏览器没有 IndexedDB');
    await expect(
      openCacheDb(
        async () => {
          throw failure;
        },
        async () => {
          dropped += 1;
        },
      ),
    ).rejects.toBe(failure);
    expect(dropped).toBe(0);
  });

  it('正常打开：一次都不动本机那份库', async () => {
    let dropped = 0;
    const db = await openCacheDb(
      async () => fakeDb,
      async () => {
        dropped += 1;
      },
    );
    expect(db).toBe(fakeDb);
    expect(dropped).toBe(0);
  });
});
