# AGENTS.md

这块板是 **ESP32-S3 3.5" IPS（ST77922 QSPI + SDIO TF 卡 + 8MB PSRAM）**，
用 `esp-generate` 生成骨架后改的。

## Project-specific notes

- **这个 crate 只放 S3 这块板的接线与专用驱动**（QSPI 屏、SDIO 卡、引脚、trait 适配）。
  命令、播放引擎、串口协议、文件系统那套逻辑都在 `../fm-core`，改动优先放那边。
- Target chip: `esp32s3`（Xtensa）。**Xtensa 目标不在 rustup 里**：先 `espup install`，
  再 `. ~/export-esp.sh`，`rust-toolchain.toml` 里写的是 `channel = "esp"`。
- 这是 `#![no_std]` / `#![no_main]` 工程，用 `core` / `alloc`；`alloc` 已在 `src/main.rs` 里初始化。
- 屏幕是 **ST77922（不是 ST7796）**：初始化表与 QSPI 帧都得自己写，
  `mipidsi` 那条路已经**弃用**（它的未声明约定带我们绕过好几轮弯路）。
  现在的驱动是 `src/panel.rs`（面板逻辑）+ `src/qspi.rs`（QSPI 帧）+ `src/st77922_init.rs`（厂商表）。
  上手前先读 `../../docs/esp32-s3-lcd-35.md` §4 的**三条硬契约**（窗口 x→`0x2B`/y→`0x2A` 的软件转置、
  CASET 对齐 4 像素、像素帧形状）。⚠️ **别照抄厂商的"横屏 = MADCTL 0xA0 + x→0x2A"**：
  本板实测**不认 MV**（轴不换），照抄会出现"一侧 1/3 花屏 + 文字转置"。当前 MADCTL 是 `0x00`。
- 面板要求对齐的是它 **CASET** 那条轴，本板横屏下 CASET = 逻辑 **y**，所以：
  驱动按 y 向外扩并补行（`panel.rs`）、播放的行范围由 `BoardConfig::y_align = 4` 提前扩好
  （C6 是 x→CASET，所以它用 `x_align`，两个轴都填 1）。
- S3 驱动用 PSRAM 帧缓冲合成文本/图形，再按对齐窗口推屏：面板多行快轴是 RASET，
  行优先整块会被转置；调用方保持普通“从上到下”行序，`y_inverted` 填 `false`。
- 屏幕方向/颜色不对时用点灯卡看：`cargo run --release --features lcd-test`（自证测试图，见 `src/testcard.rs`）。
- 大块内存（播放画布 300KiB）必须走 PSRAM，不能放 `static`；**不要把 `Atomic*` 放进 PSRAM**。
- `build.rs` **不注入 `--error-handling-script`**（那是 rust-lld 的参数，Xtensa 用的是 GNU ld），
  但会加 `-Wl,--no-warn-rwx-segments` 关掉 GNU ld 对 RWX 段的噪音警告（布局是 esp-hal 那侧定的）。
- 日志走 defmt，级别用 `DEFMT_LOG`（默认 `info`，在 `.cargo/config.toml` 里）。
- `cargo run` 用 `espflash` 烧录（`runner` 已在 `.cargo/config.toml` 配好 `--chip esp32s3`）。

## Useful references

- esp-generate: https://github.com/esp-rs/esp-generate
- esp-hal docs: https://docs.espressif.com/projects/rust/esp-hal/1.2.2/index.html
- 厂商自己的 Arduino 例程（这块板的权威参考，窗口映射 + 初始化表都出自它）:
  https://github.com/ydedox/st77922
- 这块板的独立核对文档（引脚、复位、MADCTL 实测）: https://github.com/jlmeredith/ES3C35P
- ESP LCD ST77922（QSPI 帧格式的另一处依据；注意它的默认初始化表是给 **532x300** 面板的诱饵）:
  https://components.espressif.com/components/espressif/esp_lcd_st77922
- 本板引脚与内存细节：`../../docs/esp32-s3-lcd-35.md`
