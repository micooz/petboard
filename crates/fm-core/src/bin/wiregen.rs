//! 把协议常量与跨语言 fixture 写到网页侧（`pnpm wire` 的底层命令）。
//!
//! 用法：
//!
//! ```text
//! cargo run --features gen --bin wiregen -- ts       > ../../web/src/lib/serial/wire.ts
//! cargo run --features gen --bin wiregen -- fixtures > tests/fixtures/frames.jsonl
//! ```
//!
//! 单独建一个 bin 是因为它要 `std`（读参数、写文件），而库本体必须保持 `no_std`。

use std::io::{self, Write};
use std::process::exit;

fn main() {
    let what = std::env::args().nth(1).unwrap_or_default();
    let text = match what.as_str() {
        "ts" => fm_core::wire::codegen::ts_module(),
        "fixtures" => fm_core::wire::codegen::fixtures(),
        other => {
            eprintln!("用法：wiregen <ts|fixtures>（收到：{other:?}）");
            exit(2);
        }
    };
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    if let Err(e) = lock.write_all(text.as_bytes()) {
        eprintln!("写不出去：{e}");
        exit(1);
    }
}
