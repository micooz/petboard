#!/usr/bin/env bash
# 启动网页开发服务器（Next.js dev）。
#
#   ./scripts/web.sh                 # 装依赖 → 保证有 WASM → http://localhost:3000
#   ./scripts/web.sh --port 5173     # 换端口
#   ./scripts/web.sh --wire          # 顺手重生成协议常量（改过 Rust 协议时）
#   ./scripts/web.sh --no-wasm       # 跳过 WASM（只改 UI、不碰编解码时最快）
#   ./scripts/web.sh --help          # 全部选项
#
# 为什么要管 WASM：web/src/wasm/pkg/ 虽然已随仓库跟踪，但本地缺了它 dev 页会在加载
# 编解码器时报 `Cannot find module '../wasm/pkg/wasmfmt'`，所以缺了就补上。
set -euo pipefail

# WASM：auto = 产物缺失才编；force = 一定重编；skip = 完全不碰。
WASM=auto
RUN_WIRE=0
WEB_DIR=$(cd "$(dirname "$0")/../web" && pwd)

if [ -t 2 ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_YELLOW=$'\033[33m'
  C_GREEN=$'\033[32m'
else
  C_RESET=''
  C_BOLD=''
  C_DIM=''
  C_RED=''
  C_YELLOW=''
  C_GREEN=''
fi

note() {
  printf '%s==>%s %s%s%s\n' "$C_GREEN$C_BOLD" "$C_RESET" "$C_BOLD" "$*" "$C_RESET" >&2
}

info() {
  printf '    %s\n' "$C_DIM$*$C_RESET" >&2
}

die() {
  printf '%s错误:%s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
用法: scripts/web.sh [选项]

选项:
  -p, --port <端口>   监听端口（默认 3000，和固件欢迎屏的地址一致）
  -H, --host <地址>   绑定地址（默认 localhost；Web Serial 需要 https 或 localhost）
  --wasm             强制重编 WASM（默认只在产物缺失时编）
  --no-wasm          完全不碰 WASM
  --wire             先跑 pnpm wire，重生成 wire.ts / frames.jsonl（改过 Rust 协议后用）
  --no-install       不自动 pnpm install
  -h, --help         看这个帮助
EOF
}

AUTO_INSTALL=1
HOST=localhost
PORT=3000
while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)
      if [ $# -lt 2 ]; then
        die "$1 后面要跟一个端口"
      fi
      PORT=$2
      shift 2
      ;;
    -H|--host)
      if [ $# -lt 2 ]; then
        die "$1 后面要跟一个地址"
      fi
      HOST=$2
      shift 2
      ;;
    --wasm)
      WASM=force
      shift
      ;;
    --no-wasm)
      WASM=skip
      shift
      ;;
    --wire)
      RUN_WIRE=1
      shift
      ;;
    --no-install)
      AUTO_INSTALL=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "不认识的选项: $1（scripts/web.sh --help 看可用选项）"
      ;;
  esac
done

command -v pnpm >/dev/null 2>&1 || die '找不到 pnpm —— 装它: corepack enable 或 npm i -g pnpm'

cd "$WEB_DIR"

if [ ! -d node_modules ] && [ "$AUTO_INSTALL" = 1 ]; then
  note '安装网页依赖（pnpm install）'
  pnpm install
elif [ ! -d node_modules ]; then
  die 'web/node_modules 不存在，但又给了 --no-install。先跑 pnpm install。'
fi

if [ "$RUN_WIRE" = 1 ]; then
  note '重新生成协议常量（pnpm wire）'
  info '改过 crates/serial 或 crates/fm-core/src/wire/ 之后需要它；产出两个被版本控制的文件'
  pnpm wire
fi

# WASM：dev 页一加载编解码器就要它。产物已随仓库跟踪，但本地缺了必须补。
if [ ! -f src/wasm/pkg/wasmfmt.js ] && [ "$WASM" = auto ]; then
  WASM=force
  info 'src/wasm/pkg/ 还不存在，必须先生成（这是生成物，已随仓库跟踪，本地缺了才编）'
fi

# auto + 产物已在 = 什么都不做；其余情况才检查依赖并真编。
if [ "$WASM" = skip ]; then
  if [ ! -f src/wasm/pkg/wasmfmt.js ]; then
    printf '%s!%s 跳过了 WASM，但 src/wasm/pkg/ 不在：页面会报 Cannot find module\n' \
      "$C_YELLOW$C_BOLD" "$C_RESET" >&2
  fi
elif [ "$WASM" = auto ] && [ -f src/wasm/pkg/wasmfmt.js ]; then
  info 'WASM 产物已在，跳过重编（改过 crates/* 之后要加 --wasm）'
else
  note '编译 WASM 编解码器（pnpm wasm）'
  if ! command -v cargo >/dev/null 2>&1; then
    die '找不到 cargo —— pnpm wasm 要用它编 wasm32 产物: https://rustup.rs'
  fi
  if ! rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown; then
    die '缺 wasm32-unknown-unknown target。补一下:
    rustup target add wasm32-unknown-unknown'
  fi
  if ! command -v wasm-bindgen >/dev/null 2>&1; then
    die '缺 wasm-bindgen-cli。版本要跟 crates/wasmfmt/Cargo.toml 里的 wasm-bindgen 对上（当前 0.2.129）:
    cargo install wasm-bindgen-cli --version 0.2.129 --locked'
  fi
  pnpm wasm
fi

note "启动 dev 服务器 → http://$HOST:$PORT"
if [ "$PORT" != 3000 ]; then
  info '端口不是 3000：板子欢迎屏印的是 http://localhost:3000，要一致的话'
  info '烧录时给 --hint-url http://localhost:<端口>（见 scripts/flash-c6.sh --help）'
fi
info 'Web Serial 只在 Chromium + 安全上下文里可用（https 或 localhost），Ctrl+C 停'

exec pnpm dev --hostname "$HOST" --port "$PORT"
