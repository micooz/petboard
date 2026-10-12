import { describe, expect, it } from 'vitest';

import { contentId } from '@/lib/hash';

describe('contentId', () => {
  it('不带盐时仍按纯内容寻址，带盐时能把相同内容拆开', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const plain = await contentId(payload);
    expect(await contentId(payload)).toBe(plain);
    expect(await contentId(payload, 'row:0')).not.toBe(await contentId(payload, 'row:1'));
    expect(await contentId(payload, 'row:0')).not.toBe(plain);
  });
});
