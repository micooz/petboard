`pkg/` 是构建产物，**已随仓库跟踪**，所以 `pnpm install` 之后 `pnpm test` / `pnpm typecheck` /
`pnpm build` 直接就能跑，网页这一侧不需要 rust 工具链。

只有改了 `crates/anmfmt`、`crates/bmpfmt` 或 `crates/wasmfmt` 才需要重跑：

```bash
cd web && pnpm wasm
```

并把重生成出来的 `pkg/` 一起提交 —— CI 不会替你重建它（需要 rustup 的
`wasm32-unknown-unknown` 目标，以及和 `crates/wasmfmt/Cargo.toml` 里 `wasm-bindgen`
同版本的 `wasm-bindgen-cli`）。

实现在 `../../../crates/wasmfmt`，加载与搬运的门面是 `src/lib/wasm.ts`。
