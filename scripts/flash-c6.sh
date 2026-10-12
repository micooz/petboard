#!/usr/bin/env bash
# 烧录 ESP32-C6 板（Waveshare ESP32-C6-LCD-1.47）。
#
#   ./scripts/flash-c6.sh                  # 编译 release + 烧录 + 开监视器
#   ./scripts/flash-c6.sh --no-monitor     # 只烧，把串口留给网页
#   ./scripts/flash-c6.sh --debug          # 编 dev 档，转得快一点
#   ./scripts/flash-c6.sh --help           # 全部选项
#
# C6 是 RISC-V，target 由 rustup 自带，不需要 espup / export-esp.sh。
set -euo pipefail

BOARD_LABEL='ESP32-C6'
BOARD_DIR=$(cd "$(dirname "$0")/../crates/fm-esp-c6" && pwd)
CHIP=esp32c6
BIN=pet-board-c6
TRIPLE=riscv32imac-unknown-none-elf
EXPORT_ESP=
FEATURES=
EXTRA_USAGE='
C6 补充:
  这块板是 RISC-V，target 随 rustup 自带，不需要 espup / export-esp.sh。
  想看完整启动日志：在监视器里按 Ctrl+R（复位芯片且不掉串口）。
'

# shellcheck source=_common.sh
. "$(dirname "$0")/_common.sh"

parse_flash_args "$@"
flash_main
