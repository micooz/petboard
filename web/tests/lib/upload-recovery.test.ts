import { describe, expect, it } from 'vitest';

import {
  clearUploadInFlight,
  isStaleUploadError,
  markUploadInFlight,
  peekUploadInFlight,
  UPLOAD_IN_FLIGHT_KEY,
  withUploadRecovery,
  type UploadRecoveryStore,
} from '@/lib/upload-recovery';

function memoryStore(): UploadRecoveryStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe('upload recovery', () => {
  it('可以反复查看标记，clear 后才消失', () => {
    const store = memoryStore();
    markUploadInFlight(store);
    expect(store.values.get(UPLOAD_IN_FLIGHT_KEY)).toBe('1');
    expect(peekUploadInFlight(store)).toBe(true);
    clearUploadInFlight(store);
    expect(peekUploadInFlight(store)).toBe(false);
  });

  it('clear 只清标记，不影响别的键', () => {
    const store = memoryStore();
    store.setItem('other', 'x');
    markUploadInFlight(store);
    clearUploadInFlight(store);
    expect(store.values.get(UPLOAD_IN_FLIGHT_KEY)).toBeUndefined();
    expect(store.values.get('other')).toBe('x');
  });

  it('只把固件的接收超时当上传恢复信号', () => {
    expect(isStaleUploadError(new Error('设备不接受 device/info（timeout waiting for data）'))).toBe(true);
    expect(isStaleUploadError(new Error('timeout waiting for ACK'))).toBe(false);
    expect(isStaleUploadError(new Error('别的问题'))).toBe(false);
  });

  it('withUploadRecovery 在操作期间打标记，成功后清掉，失败后留下', async () => {
    const store = memoryStore();
    await withUploadRecovery(
      async () => {
        expect(peekUploadInFlight(store)).toBe(true);
      },
      store,
      0,
    );
    expect(peekUploadInFlight(store)).toBe(false);

    await expect(
      withUploadRecovery(async () => {
        throw new Error('boom');
      }, store, 0),
    ).rejects.toThrow('boom');
    expect(peekUploadInFlight(store)).toBe(true);
  });
});
