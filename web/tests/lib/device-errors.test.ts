import { describe, expect, it } from 'vitest';

import { classifyFailure } from '@/lib/device-errors';
import { DeviceError } from '@/lib/serial/client';
import { TransportError, TransportTimeout } from '@/lib/serial/transport';

describe('classifyFailure', () => {
  const cases: [string, string][] = [
    ['cannot open file', 'missing'],
    ['offset past end', 'missing'],
    ['not an ANM file', 'format'],
    ['unsupported ANM version (need v4)', 'format'],
    ['bad ANM file length', 'format'],
    ['animation larger than screen', 'format'],
    ['no playlist', 'no-playlist'],
    ['no playable item', 'no-playlist'],
    ['busy', 'busy'],
  ];

  for (const [message, kind] of cases) {
    it(`"${message}" → ${kind}`, () => {
      expect(classifyFailure(new DeviceError(message)).kind).toBe(kind);
    });
  }

  it('超时/串口错误分别归到 timeout / disconnected', () => {
    expect(classifyFailure(new TransportTimeout('等 ACK 超时')).kind).toBe('timeout');
    expect(classifyFailure(new TransportError('端口没了')).kind).toBe('disconnected');
    expect(classifyFailure(new DeviceError('cannot open file'), { connected: false }).kind).toBe('disconnected');
  });

  it('认不出来的一律 unexpected', () => {
    expect(classifyFailure(new DeviceError('???')).kind).toBe('unexpected');
  });
});
