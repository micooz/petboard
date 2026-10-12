import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // 和 tsconfig 里的 `@/*` 对齐（Vitest 不会自己读 tsconfig 的 paths）
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // 格式实现是 WASM，测试开始前先把字节喂进去
    setupFiles: ['tests/setup/wasm.ts'],
    // 约定：测试都在与 src/ 平级的 tests/ 下，目录结构镜像 src/
    // （src/lib/x.ts → tests/lib/x.test.ts）。import 一律走 @/ 别名，所以位置和源码无关。
    include: ['tests/**/*.test.ts'],
  },
});
