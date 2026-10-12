#!/usr/bin/env bash
# 烧录 ESP32-S3 板（3.5 寸 IPS：ST77922 QSPI + SDIO TF 卡 + 8MB PSRAM）。
#
#   ./scripts/flash-s3.sh                  # 编译 release + 烧录 + 开监视器
#   ./scripts/flash-s3.sh --no-monitor     # 只烧，把串口留给网页
#   ./scripts/flash-s3.sh --lcd-test       # 烧点灯卡（方向/对齐/MADCTL 自证测试图）
#   ./scripts/flash-s3.sh --help           # 全部选项
#
# S3 是 Xtensa，rustup 官方没有这个 target：脚本每次自动 source ~/export-esp.sh
# （espup 生成的），所以不需要你先手动 `. ~/export-esp.sh`。没装过会提示怎么装。
set -euo pipefail

BOARD_LABEL='ESP32-S3'
BOARD_DIR=$(cd "$(dirname "$0")/../crates/fm-esp-s3" && pwd)
CHIP=esp32s3
BIN=pet-board-s3
TRIPLE=xtensa-esp32s3-none-elf
EXPORT_ESP=${EXPORT_ESP_SH:-$HOME/export-esp.sh}
FEATURES=
EXTRA_USAGE='
S3 专用:
  --lcd-test               打开 lcd-test feature，烧点灯卡（见 crates/fm-esp-s3/src/testcard.rs）
  环境 EXPORT_ESP_SH        指定 export-esp.sh 的位置（默认 ~/export-esp.sh）

⚠️ 这块板的 LCD_RST 与芯片 EN 共用：USB 复位只复位 CPU，屏可能还是黑的。
   烧完黑屏就按一下板上的 RST（或拔插一次 USB），日志干净不代表屏醒了。
'

# 先吃掉板子特有的 --lcd-test，剩下的交给公共解析。用 while + shift 而不是 `for arg in "$@"`
# 收集，是为了在 bash 3.2（macOS 默认）+ `set -u` 下也不碰"空数组展开"那个坑。
rest=()
while [ $# -gt 0 ]; do
  if [ "$1" = '--lcd-test' ]; then
    FEATURES=lcd-test
    shift
  else
    rest+=("$1")
    shift
  fi
done

# shellcheck source=_common.sh
. "$(dirname "$0")/_common.sh"

if [ "${#rest[@]}" -gt 0 ]; then
  parse_flash_args "${rest[@]}"
else
  parse_flash_args
fi
flash_main
