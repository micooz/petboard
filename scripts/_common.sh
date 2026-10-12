# 两块板子的烧录脚本共用的部分：解析选项、定位仓库、编译、调 espflash。
#
# 由 flash-c6.sh / flash-s3.sh 用 `source` 引入，所以这里不写 shebang，也不重复
# `set -euo pipefail`（沿用调用方的）。共用选项在这里解析，板子特有的选项由调用方
# 先吃掉、再把剩下的参数传进来。
#
# source 之前调用方必须设好这几个变量：
#   BOARD_LABEL  给人看的板子名（日志前缀）
#   BOARD_DIR    crate 目录（绝对路径）
#   CHIP         espflash 的 `--chip` 值
#   BIN          Cargo.toml 里 `[[bin]]` 的名字
#   TRIPLE       rustc target 名（决定 target/ 下的落点）
#   EXPORT_ESP   Xtensa 环境脚本，需要 source 才填（C6 留空）
#   FEATURES     cargo feature 串，可空（S3 的 --lcd-test 用它传）
#   EXTRA_USAGE  板子特有的选项说明，可空

PROFILE=release
PROFILE_DIR=release
PORT=${ESPFLASH_PORT:-}
BAUD=${ESPFLASH_BAUD:-}
MONITOR=1
DEFMT_LEVEL=${DEFMT_LOG:-}
HINT_URL=${PET_BOARD_HINT_URL:-}
SKIP_BUILD=0
DRY_RUN=0
ELF=

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

# 只在终端上色，输出重定向到文件时保持干净。
if [ -t 2 ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_YELLOW=$'\033[33m'
  C_GREEN=$'\033[32m'
  C_CYAN=$'\033[36m'
else
  C_RESET=''
  C_BOLD=''
  C_DIM=''
  C_RED=''
  C_YELLOW=''
  C_GREEN=''
  C_CYAN=''
fi

# 全部走 stderr（espflash 的输出也在 stderr，混在一起看顺序才对）。
note() {
  printf '%s==>%s %s%s%s\n' "$C_GREEN$C_BOLD" "$C_RESET" "$C_BOLD" "$*" "$C_RESET" >&2
}

info() {
  printf '    %s\n' "$C_DIM$*$C_RESET" >&2
}

warn() {
  printf '%s!%s %s\n' "$C_YELLOW$C_BOLD" "$C_RESET" "$*" >&2
}

die() {
  printf '%s错误:%s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$*" >&2
  exit 1
}

# 打印出来再执行；--dry-run 时只打印。
run() {
  printf '%s$ %s%s\n' "$C_CYAN" "$*" "$C_RESET" >&2
  if [ "$DRY_RUN" = 1 ]; then
    return 0
  fi
  "$@"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "找不到 $1 —— $2"
  fi
}

usage_flash() {
  cat >&2 <<EOF
用法: $(basename "$0") [选项]

编译 $BOARD_LABEL 的固件并烧进板子。默认 release，烧完直接开监视器。

选项:
  --debug                编 dev 档（编译快、跑得慢；默认 release）
  --release              显式用 release（默认就是它，写出来求个清楚）
  --no-monitor           只烧不开监视器（烧完要把串口交给网页时用）
  --no-build             跳过编译，烧 target/ 里已有的产物
  -p, --port <端口>       指定串口（同时插不止一块板子时必需）
  -B, --baud <波特率>     烧录波特率
  --defmt <级别>          覆盖 DEFMT_LOG（error|warn|info|debug|trace）
  --hint-url <地址>       覆盖 PET_BOARD_HINT_URL（欢迎屏上显示的网页地址）
  -n, --dry-run          只打印将要执行的命令，不真的跑
  -h, --help             看这个帮助
${EXTRA_USAGE}
环境变量 ESPFLASH_PORT / ESPFLASH_BAUD / DEFMT_LOG / PET_BOARD_HINT_URL 同样生效。

烧录走板子自带的 USB-Serial-JTAG，没有 Wi-Fi/OTA 这条路。
EOF
}

parse_flash_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --debug)
        PROFILE=dev
        PROFILE_DIR=debug
        shift
        ;;
      --release)
        PROFILE=release
        PROFILE_DIR=release
        shift
        ;;
      --no-monitor)
        MONITOR=0
        shift
        ;;
      --no-build)
        SKIP_BUILD=1
        shift
        ;;
      -p|--port)
        if [ $# -lt 2 ]; then
          die "$1 后面要跟一个端口"
        fi
        PORT=$2
        shift 2
        ;;
      -B|--baud)
        if [ $# -lt 2 ]; then
          die "$1 后面要跟一个数字"
        fi
        BAUD=$2
        shift 2
        ;;
      --defmt)
        if [ $# -lt 2 ]; then
          die "$1 后面要跟 error|warn|info|debug|trace"
        fi
        DEFMT_LEVEL=$2
        shift 2
        ;;
      --hint-url)
        if [ $# -lt 2 ]; then
          die "$1 后面要跟一个 URL"
        fi
        HINT_URL=$2
        shift 2
        ;;
      -n|--dry-run)
        DRY_RUN=1
        shift
        ;;
      -h|--help)
        usage_flash
        exit 0
        ;;
      *)
        die "不认识的选项: $1（$(basename "$0") --help 看可用选项）"
        ;;
    esac
  done

  ELF=$BOARD_DIR/target/$TRIPLE/$PROFILE_DIR/$BIN
}

# Xtensa 不在 rustup 里：先确认 espup 的环境脚本在，否则 cargo 会在链接阶段才报
# 一个很难看的错。
check_toolchain() {
  if [ -n "$EXPORT_ESP" ]; then
    if [ ! -f "$EXPORT_ESP" ]; then
      die "找不到 Xtensa 环境脚本 $EXPORT_ESP
  ESP32-S3 用的是 esp-rs 的 fork 工具链，先跑一次：
    cargo install espup && espup install
  它会生成 ~/export-esp.sh（本脚本每次自动 source，不用手动加到 ~/.zshrc）。"
    fi
  fi
}

# 编译板子 crate。必须 cd 进 crate 目录：那里的 .cargo/config.toml 才定 target /
# build-std / rustflags，ESP 的 .cargo 配置不会往仓库根方向找。
build_firmware() {
  local args=(build)
  if [ "$PROFILE" = release ]; then
    args+=(--release)
  fi
  if [ -n "$FEATURES" ]; then
    args+=(--features "$FEATURES")
  fi

  note "编译 ${BOARD_LABEL}（${BOARD_DIR#$REPO_ROOT/} · cargo ${args[*]}）"
  if [ -n "$DEFMT_LEVEL" ]; then
    info "DEFMT_LOG=${DEFMT_LEVEL}（改级别会重编，defmt 的字符串是编译时写进 flash 的）"
  fi
  if [ -n "$HINT_URL" ]; then
    info "PET_BOARD_HINT_URL=$HINT_URL"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    if [ -n "$EXPORT_ESP" ]; then
      printf '%s$ . %s%s\n' "$C_CYAN" "$EXPORT_ESP" "$C_RESET" >&2
    fi
    printf '%s$ (cd %s && cargo %s)%s\n' "$C_CYAN" "${BOARD_DIR#$REPO_ROOT/}" \
      "${args[*]}" "$C_RESET" >&2
    return 0
  fi

  (
    cd "$BOARD_DIR" || exit 1
    if [ -n "$EXPORT_ESP" ]; then
      # shellcheck disable=SC1090
      . "$EXPORT_ESP"
    fi
    if [ -n "$DEFMT_LEVEL" ]; then
      export DEFMT_LOG="$DEFMT_LEVEL"
    fi
    if [ -n "$HINT_URL" ]; then
      export PET_BOARD_HINT_URL="$HINT_URL"
    fi
    cargo "${args[@]}"
  ) || die "编译失败。先修编译器报的错，再重试烧录。"
}

# 产物不在就先说清楚，别让 espflash 只报一句"文件找不到"。
check_elf() {
  local flag=--release
  if [ "$PROFILE" = dev ]; then
    flag=
  fi
  if [ ! -f "$ELF" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      # dry-run 只为看命令，产物缺不缺不该挡住，但要说清楚。
      warn "（dry-run）产物 ${ELF#$REPO_ROOT/} 还不存在，真跑时会失败"
      return 0
    fi
    die "找不到产物 ${ELF#$REPO_ROOT/}
  它还没编出来。去掉 --no-build 让它先编译，或者手动跑：
    cd ${BOARD_DIR#$REPO_ROOT/} && cargo build ${flag:+$flag}"
  fi
}

# 与两块板 .cargo/config.toml 里的 runner 等价：
#   espflash flash --monitor --chip <chip> --log-format defmt <elf>
flash_firmware() {
  # `--log-format` 只对监视器有意义；单独带上它 espflash 会警告"选项被忽略"，所以不开
  # 监视器时不传。
  local args=(-S flash --chip "$CHIP")
  if [ -n "$PORT" ]; then
    args+=(--port "$PORT")
  fi
  if [ -n "$BAUD" ]; then
    args+=(--baud "$BAUD")
  fi
  if [ "$MONITOR" = 1 ]; then
    args+=(--monitor --log-format defmt)
  fi
  args+=("$ELF")

  if [ "$MONITOR" = 1 ]; then
    note "烧录 ${BOARD_LABEL}，随后打开监视器"
    info "监视器独占串口：网页要连板子之前先 Ctrl+C 释放。Ctrl+R 复位芯片。"
  else
    note "烧录 ${BOARD_LABEL}（不开监视器）"
    info "想看日志（defmt 要有这份 ELF 才能还原文字）："
    printf '    espflash -S monitor --chip %s --log-format defmt --elf %s\n' \
      "$CHIP" "${ELF#$REPO_ROOT/}" >&2
  fi

  run espflash "${args[@]}" || flash_failed
}

# 烧不进去时把最常见的原因摊开，省得回去翻 docs/esp32-c6-lcd-147.md §5.4。
flash_failed() {
  warn "烧录失败。按这个顺序排查："
  info "1. 换一根线（很多 USB 线只能充电，没有数据线）。"
  info "2. 串口被占用：网页的 Web Serial 和 espflash monitor 同一时刻只能开一个。"
  info "3. 手动进下载模式：按住 BOOT → 点一下 RST → 松开 BOOT，然后重试。"
  info "4. 同时插了不止一块板子：用 --port 指定。现在能看到的串口："
  if [ "$DRY_RUN" != 1 ]; then
    espflash -S list-ports 2>&1 | sed 's/^/    /' >&2
  fi
  exit 1
}

# 烧录的完整流程；调用方解析完参数后调它。
flash_main() {
  check_tools
  if [ "$SKIP_BUILD" = 1 ]; then
    check_elf
  else
    check_toolchain
    build_firmware
  fi
  flash_firmware
}

check_tools() {
  require_cmd cargo '装 Rust: https://rustup.rs'
  # 只有真的要烧才要 espflash；--no-build + --dry-run 的组合不该被它挡住。
  if [ "$DRY_RUN" != 1 ]; then
    require_cmd espflash '装它: cargo install espflash'
  fi
}
