# ESP32-C6 LCD 1.47"

## 1. 这块板是什么

| 项 | 值 |
|---|---|
| 芯片 | ESP32-C6：RISC-V HP（High-Performance，高性能）核最高 160MHz，另有 20MHz 的 LP 核 |
| Flash | 8MB，**封装在芯片内**（板上没有独立 flash 元件） |
| 屏幕 | 1.47" ST7789，SPI 接口，横屏 320x172（`.ANM` 画布 312x164） |
| 存储卡 | microSD / TF，**SPI 模式**，与 LCD 共用 SPI2 |
| USB | 芯片原生 USB-Serial-JTAG（GPIO12/13），**没有 USB 转串口芯片** |

固件是 `#![no_std]` 的 embassy + esp-hal 工程：`crates/fm-esp-c6/` 只放这块板的接线与外设初始化，
其余（命令、播放、协议、文件系统）在 `crates/fm-core/`。

## 2. 引脚与按键

来源：Waveshare 官方原理图。

| 功能 | GPIO | 备注 |
|---|---|---|
| LCD_MOSI | GPIO6 | 与 TF 卡共用 |
| LCD_SCLK | GPIO7 | 与 TF 卡共用 |
| LCD_CS | GPIO14 | |
| LCD_DC | GPIO15 | 同时是 strapping 脚 |
| LCD_RST | GPIO21 | |
| LCD_BL | GPIO22 | 经 N-MOSFET（SI2302）驱动，高电平点亮 |
| TF_CS | GPIO4 | 插卡时必须显式拉高（代码已做） |
| TF_MISO | GPIO5 | 只给 TF 卡用（LCD 不需要） |
| RGB LED | GPIO8 | WS2812B，板上另有 10K 上拉 |
| BOOT 键 | GPIO9 | 见下 |
| USB D- / D+ | GPIO12 / GPIO13 | 芯片原生 USB，带 22Ω 串阻 |
| UART0 TXD / RXD | GPIO16 / GPIO17 | 备用串口，走这里需要拔掉 USB 供电 |

**strapping 脚**是复位那一刻被采样一次的引脚：GPIO4、GPIO5、GPIO8、GPIO9、GPIO15。
复位后它们恢复成普通 IO，所以运行中按 BOOT 不会切换启动模式。

| 键 | 接到 | 作用 |
|---|---|---|
| RST | `CHIP_PU`（经 10K 上拉） | 复位整颗芯片 |
| BOOT | GPIO9（经 10K 上拉） | 运行时什么都不发生（固件没读 GPIO9）；只在**复位瞬间**被拉低才有意义 |

**按住 BOOT 再点 RST**（GPIO9=0、GPIO8=1）→ 进 ROM 的下载模式，app 不运行，等 espflash 烧录 ——
烧录失败时的标准操作。**不按 BOOT 直接点 RST** → 正常启动。

## 3. 内存与分区

内存清单（来源：ESP32-C6 数据手册 v1.0 §3.1.3 + esp-hal 的链接脚本 `memory.x`）：

| 类型 | 容量 | 说明 |
|---|---|---|
| HP SRAM | **512 KB** | 程序变量 / 栈 / 堆（其中 32KB 被缓存占用） |
| LP SRAM | **16 KB** | 低功耗域内存，deep sleep 时唯一还供电的内存 |
| ROM | 320 KB | 出厂固化的引导程序与核心函数 |
| eFuse | 4 Kbit | 一次性可编程，其中 1792 bit 留给用户 |
| Cache | 32 KB | 只读、四路组相联，给"在 flash 里跑"的代码加速 |

链接脚本给 app 的静态 RAM ≈ **441.5KB**（512KB 里 32KB 被缓存占用），`RTC_FAST` 就是 LP SRAM。
固件在 `crates/fm-esp-c6/src/main.rs` 里开堆：先回收二级引导程序用过的 64KB，再要 64KB。

分区表（启动日志 `I (43) boot:` 那段）：

| 分区 | 用途 | 偏移 | 长度 |
|---|---|---|---|
| `nvs` | Wi-Fi 配置等键值存储 | 0x009000 | 24KB |
| `phy_init` | 射频校准参数 | 0x00f000 | 4KB |
| `factory` | 主程序 | 0x010000 | 0x7f0000（约 7.9MB） |

- Flash 是 **8MB**（espflash 读 flash 芯片 ID 得到，不是默认值），且**封装在芯片内**；RAM 同样在芯片内。
- 当前程序约 805KB 留在 flash、约 94KB 进 SRAM（`map` / `load` 段怎么看见
  [`basics.md`](basics.md) §2.2）。
- **跑程序只读 flash**；写 flash 只有三种情况：电脑烧录、程序自己写 NVS/文件系统、OTA。
  当前固件不写 flash。
- flash 有擦写寿命，别在循环里反复写同一块；频繁写的数据交给 `nvs` 分区（有磨损均衡）。
  寿命的量级与换算见 [`basics.md`](basics.md) 的"Flash 的写入寿命"。
- **播放路径的大缓冲一律静态分配**（画布、颜色读缓冲、LCD 缓冲都放 `.bss`，不向堆要）：
  这块板的堆只有 ~128KB，还要留给协议和日志里的 `String`/`format!` —— 100KB 级的画布从堆上
  要会直接分配失败。
- **LP SRAM（16KB）本项目没用**：它能跨 deep sleep 保留，但容量很小、访问比普通 SRAM 慢；
  要用得在固件里显式声明（`#[ram(unstable(rtc_fast))]`）。

## 4. 复位原因

串口日志里 `Reset reason:` 这一行由 `crates/fm-core/src/reset.rs` 把 esp-hal 的 `SocResetReason`
映射成文案，两块板共用同一张文案表。

| code | 名字 | 谁触发的 | 要不要管 |
|---|---|---|---|
| 0x01 | ChipPowerOn | 上电，或把 `CHIP_PU` 拉低（板上的 RST 键） | 正常 |
| 0x03 | CoreSw | 程序自己调软件复位 | 正常 |
| 0x05 | CoreDeepSleep | 从 deep sleep 醒来 | 低功耗场景才有意义 |
| 0x06 | CoreSDIO | SDIO 主机触发 | 正常 |
| 0x07 / 0x08 | CoreMwdt0 / CoreMwdt1 | 主看门狗复位数字核 | **要管**：程序卡死过 |
| 0x09 | CoreRtcWdt | RTC 看门狗复位数字核 | **要管** |
| 0x0B / 0x11 | Cpu0Mwdt0 / Cpu0Mwdt1 | 看门狗复位 CPU0 | **要管** |
| 0x0C | Cpu0Sw | 软件复位 CPU0 | 正常 |
| 0x0D | Cpu0RtcWdt | RTC 看门狗复位 CPU0 | **要管** |
| 0x0F | SysBrownOut | 供电掉压 | **要管**：换线/换口/加电容 |
| 0x10 / 0x12 | SysRtcWdt / SysSuperWdt | 看门狗复位整系统 | **要管** |
| 0x14 | CoreEfuseCrc | eFuse CRC 校验错 | 芯片内部问题 |
| 0x15 | CoreUsbUart | 电脑通过 USB 串口下命令复位（espflash 烧完就走这条） | 正常，日常最常见 |
| 0x16 | CoreUsbJtag | 电脑通过 USB-JTAG 下命令复位 | 正常 |
| 0x18 | Cpu0JtagCpu | JTAG 复位 CPU0 | 正常 |

"复位深度"（CPU / Core / System / Chip Reset）的概念见 [`basics.md`](basics.md)。
实测对应关系：手按 RST 和刚上电都是 `0x01`（软件上分不开）；`cargo run` 烧完、monitor 里按
`Ctrl+R` 则是 `0x15`/`0x16`。S3 板的枚举名与本板不完全一样，见
[`esp32-s3-lcd-35.md`](esp32-s3-lcd-35.md)。

## 5. 日志与串口

### 5.1 日志格式

固件日志固定是 `[LEVEL] <消息> (pet_board <文件>:<行号>)`，括号里的"文件:行号"是**编译时**埋进
二进制的，改代码或升级依赖后行号会变；`I (23)` 里的数字是**开机后的毫秒数**，不是墙上时间。
完整启动日志的逐行注解见 [`basics.md`](basics.md) §4。

### 5.2 日志是二进制帧，解它需要同版本的 ELF

defmt 的日志是二进制帧（`FF 00` 标记 + rzcobs 编码的帧体 + `00` 结束），格式串、级别、文件:行号
都是编译时写进二进制的，所以解码要用**当前那版固件的 ELF**：

```bash
espflash monitor --chip esp32c6 --log-format defmt \
  --elf crates/fm-esp-c6/target/riscv32imac-unknown-none-elf/{debug,release}/pet-board-c6
```

⚠️ 拿新 ELF 解旧日志会解出**看起来完全合理、实际完全不对**的内容 ——
**日志和固件版本要成对留档**。debug 与 release 都很新时无法判断板上跑的是哪一版，
要显式指定。

### 5.3 看不到日志时怎么办

- **按板子上的 RST** → USB 端口随芯片复位消失 → espflash 的 monitor **直接退出**
  （它只容忍读超时，其它 I/O 错误一律结束，且不重连）。想在串口里看完整启动日志，
  就在 monitor 里按 **Ctrl+R**（端口不掉，复位原因报 `0x15`/`0x16`）。
- **日志走哪条通道**：本项目用 `esp-println` 的 auto 通道，每写一条都判断 USB 主机是否在发 SOF ——
  在发就走 USB-Serial-JTAG，否则走 UART0（GPIO16/17）。所以插着 USB 时 UART0 上**没有**输出；
  想用 UART0 必须拔掉 USB、改从排针供电，再接 USB-TTL。

### 5.4 常用操作

| 操作 | 命令 / 动作 | 说明 |
|---|---|---|
| 编译 + 烧录 + 监视 | `cd crates/fm-esp-c6 && cargo run` | 烧完 espflash 会发一次 USB 复位，所以复位原因通常是 `0x15` |
| 复位芯片 | monitor 里按 `Ctrl+R` | 不掉串口 |
| 退出监视器 | `Ctrl+C` | |
| 进下载模式（烧不进去时） | 按住 **BOOT** → 点一下 **RST** → 松开 BOOT | 之后再 `cargo run` |
| 正常重启 | 直接点 **RST** | |

仓库根目录的 `scripts/flash-c6.sh` 把上面这套包好了。

## 6. 串口链路约束

换固件或改协议前先看这一节 —— 下面每条都是上板实测钉死的结论。

- **端口独占，只有一个读者**：串口同一时刻只能被一个程序打开。就算驱动允许两个程序同时打开，
  每个字节也只会被其中一个读走，两边拿到的都是残缺数据流。所以网页、`espflash monitor`
  同一时刻只能有一个在跟板子说话。
- **发送路径有损，而且丢过一次之后会"粘滞"**：`esp-println` 写 TX FIFO 时若排不空，
  就丢掉这一笔的**尾巴**，并且此后只要开头 FIFO 还是满的就**一个字节都不写**。日志与协议回复共用
  这条路，所以偶发的"命令没回音 / 读卡读不动"往往是发送路径哑了，不是板子死了。
  协议字节的写法（defmt 日志仍走 `esp_println::Printer`）：**逐字节写 + FIFO 满了主动 flush 一次再
  重试同一个字节 + 每字节 100ms 预算**（`TX_WAIT_US`），等不到就把实际写出去的字节数如实返回、
  由调用方判 `tx stuck`。TX FIFO 只有 64 字节，而且**只有被 flush 过才会把数据交给主机**；
  无超时的 `write()` / `flush_tx()` 不能用 —— 主机不来取数据时会把固件锁死，连日志都发不出来。
- **传文件的块大小**：上传方向（网页写、板子读）一块 1024 字节（`CHUNK_UP`）+ 2 字节 ACK；
  回传方向（板子写、网页读）的块大小**由板子声明**（`device/info` 的 `chunk` 行 =
  `BoardConfig::get_chunk`），本板是 **32 字节**（FIFO 深度的一半：慢一点，但一条不丢），S3 是 512；
  主机按声明值收块，并对每块回带实收字节数的 ACK 催补发。实测 16 KiB 分片约 265ms（≈62KB/s）。
- **回传时"空档即停"并补发**：主机收一块时"100ms 内没有新字节"就算这块发完了，然后回
  `06 09 <实收 u16>`；固件只补发缺的那几个字节（最多来回 4 轮）。主机一个字节都没收到时**不回 ACK**，
  否则固件会从头重发一整块。
- **载荷期间一条日志都不能打**：`media/get` 的载荷是裸字节，日志帧混进去会被主机当成文件内容。
  固件一进载荷循环就静音日志，退出自动解除。
- **`media/get` 的失败要分三类**：`SD read failed`（用 0 补齐再回 `ERR`，否则主机会把 ERR 文本当载荷）、
  `ack timeout`（主机 5 秒没回）、`host moved on`（主机放弃并接着发下一条命令 → **立刻停手**，
  不补零也不回 ERR，并把那条命令按命令行收下）。草率处理会让"点了没反应 / 播放卡在启动中"。
- **一条 media/get 最多回传 16 KiB**，下一段要等上一段回来才排队，所以用户中途点的删除/播放能插在中间；
  主机读崩后清管道（`resync`）并发 `media/abort <id>` 点名中断，让固件立刻停手、把队列让出来。
- **看门狗兜底**：TIMG0 硬件看门狗 5s 不喂就复位系统，`feed_watchdog` 任务每秒喂一次。
  正常 await 时没问题；SD/SPI 事务把执行器同步卡住超过 5s 就会复位，网页最多重连一次。
  同步长循环（例如测速的 `media/bench`）要主动让出执行权。
- **残字节错位是"四层都不报错"的故障**：一次读取没收满就收手，剩下的载荷字节留在主机队列里，
  下一条读取把它们当成本次载荷的开头 → 整段错位，而帧、ACK、长度、`complete` 都不报错。
  这种错位会让首帧图花掉。三层修法缺一不可：
  每条命令排到队首时清管道、画之前用 `anmfmt::first_frame_trusted` 验帧边界、
  不可信的前缀不进缓存。
- **上传途中刷新页面**：固件正把后续字节当文件内容，要等 2s 收不到才回命令行。新页面用
  `sessionStorage` 标记识别"上次是在上传中刷新的"，先等 2.2s 再握手。⚠️ 真机验收待做。
- **设备日志由网页记**：网页连着板子时 `espflash monitor` 抢不到口。设置页的「下载日志」导出一份
  `.txt`：协议行 + 固件帧的原始字节按时间排在一起（文件头写着怎么把 `FW` 行还原成 `.bin` 喂
  `defmt-print`）。记账按**存下来的行**算、主机自己的块 ACK 不记，否则一次悬停预览能写出几百 KB 假账。

## 7. 存储卡

> **卷句柄不能嵌套开**：`embedded_sdmmc` 的 `Volume` 同一时刻只能有一个 —— 播放动画时
> 文件还开着（`OpenFile` 同时握着 file/dir/volume），这时再 `open_volume` 会报
> `VolumeAlreadyOpen`。所以 `device/info` 的 `sd` 行**直接用开机时探测到的摘要**，
> 不现场 `open_volume`；这样即使后来卡目录/FAT 读坏了，网页的握手也不会被 SD 拖死。

- **卡槽按 SPI 模式接线**（不是 4 线 SDIO）：CS=GPIO4、MISO=GPIO5，MOSI/SCLK 与 LCD 共用。
- **只认 FAT12/16/32**：`embedded_sdmmc` 不支持 exFAT，而 64GB 以上的卡出厂基本是 exFAT，
  插上会挂载失败。要换卡就用 32GB 及以下，或先格式化成 FAT32。
- **FAT 8.3 短名**：主名最多 8 字符、扩展名最多 3 字符，所以卡上是 `CAT.ANM`。
- **卷标要过滤掉**（根目录里那条 `VOLUME` 属性的条目是卡名，不是文件）。
- **没有 RTC，创建时间不是真时间**：写文件用固定时钟，同一批文件的时间戳完全相同 ——
  列表在时间相同时按目录项顺序倒序（后追加的排前面）。术语见 [`basics.md`](basics.md) §1.7。
- **卡容量**由 CSD 寄存器得到（日志里的 `microSD …` 摘要就是它）；"剩余容量"看不到。
