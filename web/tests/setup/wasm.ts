/**
 * 测试在 node 里跑，没有页面那条取资源的链路，所以把 `pnpm wasm` 的产物直接递进去。
 */
import { readFileSync } from 'node:fs';

import { beforeAll } from 'vitest';

import { initWasm } from '@/lib/wasm';

const ARTIFACT = 'src/wasm/pkg/wasmfmt_bg.wasm';

beforeAll(() => {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(ARTIFACT));
  } catch {
    throw new Error(`找不到 ${ARTIFACT}：先跑 pnpm wasm（需要 rust 的 wasm32-unknown-unknown 目标）`);
  }
  return initWasm(bytes);
});
