# ESP32-S3 LCD 3.5"

## 1. 这块板是什么

从**板子自己的出厂固件**（读 flash 得到）与厂商手册核对而来：

| 项 | 值 |
|---|---|
| 芯片 | ESP32-S3R8，Xtensa 双核 LX7，最高 240MHz |
| Flash | 16MB QSPI |
| PSRAM | **8MB OPI**（Octal SPI，80MHz） |
| 屏幕 | 3.5" IPS，320x480，**ST77922**，**QSPI** 四线 |
| 触摸 | 集成在屏里，走 I2C（FT6336 一类，地址随固件；**本项目没用**） |
| 存储卡 | microSD，**SDIO 4-bit** |
| 音频 | ES8311 编解码 + 功放（**本项目没用**） |
| USB | 芯片原生 USB-Serial-JTAG（VID `0x303A`，和 C6 一样） |

固件里那张 ST77922 初始化表就是从**出厂固件**里抄的（`crates/fm-esp-s3/src/st77922_init.rs`）。
注意**不是** Waveshare 那块 ST7796 + FT6336 + TCA9554 的 3.5"（那是另一块板）。

## 2. 引脚

来源：厂商手册的引脚分配表。

| 功能 | GPIO | 备注 |
|---|---|---|
| LCD_CS | GPIO10 | 低有效 |
| LCD QSPI CLK | GPIO12 | |
| LCD QSPI D0 | GPIO11 | |
| LCD QSPI D1 | GPIO13 | |
| LCD QSPI D2 | GPIO14 | |
| LCD QSPI D3 | GPIO9 | |
| LCD_RST | **EN** | 与芯片复位共用，**没有独立复位脚** |
| LCD_BL | GPIO41 | 高电平点亮；可 PWM 调光（本项目只做开/关） |
| TF CLK | GPIO5 | SDIO |
| TF CMD | GPIO4 | SDIO |
| TF D0..D3 | GPIO6 / GPIO7 / GPIO2 / GPIO3 | SDIO 4-bit |
| 触摸 I2C SDA / SCL | GPIO38 / GPIO39 | 与音频编解码共用 |
| 触摸 RST / INT | GPIO48 / GPIO47 | |
| RGB 灯 | GPIO40 | 内置控制 IC，单线时序 |
| 电池 ADC | GPIO8 | |
| BOOT / RST 键 | GPIO0 / EN | |

- QSPI 没有 DC 线：命令靠 "opcode + 24 位地址" 区分（见 §4.3）。
- SD 卡槽有 10K 外部上拉，不必依赖芯片内部上拉。

## 3. ⚠️ 这块板的屏需要一个**真正的上电复位**

**烧完新固件先按板上的 RST 键（或拔插 USB），否则屏幕可能是黑的、而日志一切正常。**

`LCD_RST` 没有独立引脚，它是接在芯片的 `EN`/`CHIP_PU` 上的。而 USB 复位
（`espflash reset`、`esp_restart`、OTA）**只复位 CPU、不拉 CHIP_PU**，所以屏不会被硬件复位，
它会停在上一版固件留下的状态里 —— **`SWRESET`（软复位）救不回来**。

现象很有迷惑性：初始化全部无错、背光确认点亮、全帧几十毫秒发完，**而屏幕是黑的**，
日志里却没有任何异常 —— SPI 是只写的，"发送成功"永远成立，"收到命令但没在扫描"和
"一个命令都没收到"表现得一模一样。

判定与恢复：**按一下板上的 RST 键**（`RESET acts on CHIP_PU`），或者干脆拔插 USB 供电。
参考：<https://github.com/jlmeredith/ES3C35P> 的 `docs/HARDWARE.md`。

## 4. 屏幕：自己写 ST77922 的驱动（不用 mipidsi）

**这块屏的错误模式全在别人库的未声明约定里**（旋转、窗口换算、每条像素前的 `2Ch`、字节序），
看不见就只能试错，所以驱动是本项目自己写的：`crates/fm-esp-s3/src/panel.rs`（面板逻辑）+
`crates/fm-esp-s3/src/qspi.rs`（QSPI 帧）。下面**三条硬契约**都在真机上验证过；改任何一条都要重新上板确认。

### 4.1 硬契约一：窗口是**软件转置** —— x 发给 `0x2B`(RASET)、y 发给 `0x2A`(CASET)

面板显存是 **320 列 × 480 行**（竖屏原生），也就是说 `0x2A`(CASET) 走 320 那条短边、
`0x2B`(RASET) 走 480 那条长边。横屏要把 x/y 换过来，正常靠 MADCTL 的
**MV（行列交换）**；**但本板不认 MV**，所以交换只能在软件里做：

| 逻辑方向 | 寄存器 | 寄存器长度 | 合法范围 |
|---|---|---|---|
| 横屏 x（长边 480） | `0x2B` RASET（原生行） | 480 | 0..479 |
| 横屏 y（短边 320） | `0x2A` CASET（原生列） | 320 | 0..319 |

参数是**含端点**的坐标、各 4 字节大端。横屏 MADCTL 用 **`0x00`**。

⚠️ **写反了**（x 发给 `0x2A`）的现象：x 的 320..479 超出 CASET 量程绕回 →
**一侧约 1/3 花屏 / 那一侧永远刷不到（旧图残留在上面）+ 文字转置**。点灯卡的照片就是这个问题。

厂商的 Arduino 驱动（<https://github.com/ydedox/st77922>）横屏用 `0xA0` + `0x2A ← sx`，那是**在认
MV 的板子上**成立的；本板逐趟换 MADCTL 看图的实测结论：

| 对比 | 差哪一位 | 现象 | 结论 |
|---|---|---|---|
| `0x00` vs `0x60` | MX | 画面完全一样 | **MX 无效** |
| `0xA0` vs `0xC0` | MX | 画面完全一样 | MX 无效（第二处印证） |
| `0x00` vs `0xA0` | MV + MY | 竖条**镜像到了对侧**，没有变成横条 | **MY（行序）有效、MV（行列交换）无效** |

所以：轴永远不换，**只能在软件里转置**；MY 是仅有的可用镜像位。
`MADCTL_LANDSCAPE = 0x00`（不镜像）—— 要镜像就改这一行，别顺手抄 `0xA0`。

### 4.2 硬契约二：**CASET** 边界必须对齐到 4 像素（横屏下就是 **y**）

面板是 **GIP（Gate In Panel，栅极集成在面板上）+ Dual-Gate（双栅极）驱动**，源极按 4 像素成组；
厂商驱动里那个 `sx % 4` 取整针对的就是 **CASET** 那条轴，而本板横屏下 CASET = 逻辑 **y**：

- 所以**要对齐的是 y**，x 不要求（按 x 对齐的话播放时每条横带都会歪几行）；
- 对齐**向外扩**，扩出来的行必须**跟着补像素**（`panel.rs` 补黑），否则数据上下错位；
- 逐行发送（文本、1 像素线）时补的是"上/下各最多 3 行"的整行黑；
- 播放的**行范围**由 `fm-core` 的 `BoardConfig::y_align = 4` 提前扩好（多出来的行照旧从画布读）
  —— 只让驱动补黑的话，每条横带上下都会留黑缝。C6 的 ST7789 没有这条约束（两个轴都填 1）。

### 4.3 硬契约三：像素帧的形状

| 用途 | opcode | 24 位地址 | 数据 |
|---|---|---|---|
| 写命令 / 写参数 | `0x02` | 命令字节放**高 8 位** | 参数 |
| 写像素 | `0x32` | **`0x3C00`**（RAMWRC） | **大端** RGB565 |

四条细节：

1. **命令帧整笔单线**（opcode + 24 位地址 + 参数都走 SIO0），**只有像素帧的数据相位走四线**。
   命令帧也按四线发的后果：面板一个命令都没认出来，屏幕停在出厂默认的浅灰。
2. **写像素用 `0x3C`（RAMWRC，续传）而不是 `0x2C`（RAMWR，开始）**：`2Ch` 会把写地址计数器重置回
   窗口起点、把整段写入打断。所以**数据之前不发 `0x2C`**（它只在初始化表里出现过一次）。
3. **一整段像素共用一次 CS**（`CS_LOW → 逐块发 → CS_HIGH`），别在每个 8KiB 分块里开关 CS。
4. 面板收**大端** RGB565（`0xF800` 发成 `00 F8`）；不交换的话相邻像素的颜色位互相错位交织，
   屏幕上一片彩色噪点。

无参数的命令**不要补数据字节**：esp-hal 收到空 buffer 时只发命令 + 地址，硬塞一个字节会被当成参数。

窗口里像素流的**快轴是 RASET**（横屏下即逻辑 x），整块行优先发送会被转置。因此 S3 驱动用 PSRAM
帧缓冲合成文本/图形，再按对齐窗口以列块顺序推屏；调用方保持普通"从上到下、行内从左到右"顺序即可。

### 4.4 上板怎么判：点灯卡

```bash
cd crates/fm-esp-s3 && cargo run --release --features lcd-test
```

它**通过驱动本身**（不是绕开驱动）画一张自证的图，每 8 秒换一趟 MADCTL，循环四趟：

| 画了什么 | 判什么 |
|---|---|
| 四个方位词 `TOP` / `BOTTOM` / `LEFT` / `RIGHT`，各贴自己那一边 | **方向**：能顺着读＝对；镜像＝字反着写；转置＝字竖起来 |
| 四个角标（红左上 / 绿右上 / 蓝左下 / 白右下） | 朝向：红跑错角就是转置或镜像 |
| 一条 1 像素白色对角线 | 对齐补边（逐行 1 像素区段上下各补最多 3 行黑） |
| 一条"左黑 + 左→右红色渐变"的横块（走 `fill_contiguous`） | 像素流的快轴（见 §4.3 末尾） |
| 一条写着当前 MADCTL 的彩条 | 这一趟是哪个值、面板认不认这些位 |

判读期望：`0x00` 那趟（黄条）是**正确且不镜像**的横屏；带 MY 的趟（`0xA0`/`0x84`）应当只是左右镜像；
四趟若两两相同，说明对应位无效（本板实测 MV/MX 就是这样）。

### 4.5 初始化表：**别抄 `esp_lcd_st77922` 的默认表**

`esp_lcd_st77922` 自带的默认初始化表是上游给**另一块 532x300 面板**准备的（别抄）：本板固件始终
传自己的表。

本板真正在跑的是固件里那张 **63 项**的厂商表（`CASET`/`RASET` = `00 00 01 3F` / `00 00 01 DF`，
即 319/479 = 320x480），就在 `crates/fm-esp-s3/src/st77922_init.rs`。

`0xF0/0xF1/0xF2` 是分页命令，**顺序不能改、不能合并**；表尾的 `SLPOUT`（`0x11`）之后要等
**≥120ms** 才能下一条命令。**COLMOD(0x3A)、MADCTL(0x36) 必须在 SLPOUT 之后**发 ——
顺序错了屏幕会停在一片浅灰。

## 5. 存储卡：SDIO

`embedded-sdmmc` **只实现了 SPI 模式**，接不了 SDIO 主机，所以这块板自己垫了一层薄适配
（`crates/fm-esp-s3/src/sdio_block.rs`）：把 esp-hal 的 SDMMC 槽位接到 `sdio` 的状态机上，再转成
`embedded_sdmmc::BlockDevice` —— 往上和 C6 完全一样（ReadAhead / 文件系统 / 命令）。两个坑：

- **同步/异步的缝**：`sdio` 那套是 `async fn`，`embedded_sdmmc::BlockDevice` 是同步 trait。
  适配层用 `embassy_futures::block_on` 在调用点把 future 跑完（板上只有一个任务碰卡）。
- **对齐**：`embedded-sdmmc` 的块缓冲只有 1 字节对齐，SDMMC 的 IDMAC 要求 4 字节。
  所以不把调用方缓冲直接交给 DMA，而是先读进一块 4 字节对齐的暂存区再拷过去。

### 5.1 卡不认的时候怎么查

固件在卡初始化失败时会**照常启动命令循环**，`device/info` 的 `sd` 行会报
`microSD no card / init failed`，网页能连上来看清是卡的问题。

要分辨"卡的问题"还是"驱动的问题"，可以在 `main.rs` 里临时调 `slot.send_init_sequence()` 与
`slot.command_blocking(8, 0x1AA, …)` 换几个时钟试：初始化 OK 但 CMD8 一直 `ResponseTimeout`、
换时钟重试也一样，多半是卡没插好/接触不良/卡坏（同一条代码路径在 C6 上能挂上卡，可作对照）。

## 6. 内存

| 区域 | 容量 | 用途 |
|---|---|---|
| SRAM | 512KB | 静态变量 / 栈 / 堆 |
| PSRAM | **8MB OPI** | 播放画布等大块内存 |

- 内部堆：`heap_allocator!(#[ram(reclaimed)] 64KB)` + `heap_allocator!(64KB)`（和 C6 一样）。
- **画布必须放 PSRAM**：480x320x2 = 300KiB，内部 SRAM 装不下。用 `static` 数组会进 `.bss`，
  链接直接报 `cannot move location counter backwards`。现在的做法是
  `Box::leak(vec![0u16; N].into_boxed_slice())`，落在 PSRAM 上。
- **不要把 `Atomic*` 放进 PSRAM**：S3 的原子指令访问 PSRAM 不正确（`esp-alloc` 有明确警告）。
- PSRAM 用 `esp_alloc::psram_allocator!(peripherals.PSRAM, esp_hal::psram)` 注册进全局分配器；
  开机日志会打印识别结果（`PSRAM initialized successfully in Octal SPI mode` / `PSRAM size: 8 MB`）。

## 7. 复位原因

枚举名和 C6 **不完全一样**（`crates/fm-esp-s3/src/main.rs` 的 `reset_kind()` 做映射，文案表在
`crates/fm-core/src/reset.rs`）：S3 是 `CpuMwdt0`/`CpuSw`/`CpuRtcWdt`/`CpuMwdt1`（C6 那边叫 `Cpu0*`），
**没有** `CoreSDIO` 与 `Cpu0JtagCpu`，另有 `SysClkGlitch`（0x13）与 `CorePwrGlitch`（0x17）。
"复位深度"的概念见 [`basics.md`](basics.md)。

## 8. 工具链

Xtensa 目标**不在 rustup 里**，要用 esp-rs 的 fork：

```bash
cargo install espup --locked
espup install
. ~/export-esp.sh        # 每个新终端都要 source 一次
cd crates/fm-esp-s3 && cargo run --release
```

`rust-toolchain.toml` 里写的是 `channel = "esp"`。仓库根目录的 `scripts/flash-s3.sh` 把上面这套包好了。

Xtensa 这边用 GNU ld（`xtensa-esp32s3-elf-gcc`），能用的链接参数和 C6 的 riscv + rust-lld 不一样；
差异写在 `crates/fm-esp-s3/build.rs` 的注释里。

屏幕有问题时先跑点灯卡（见 §4.4）：`cargo run --release --features lcd-test`。
