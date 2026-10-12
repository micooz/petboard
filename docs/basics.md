# 嵌入式通用知识

## 1. 术语表

### 1.1 芯片与存储

- **ROM**（Read-Only Memory，只读存储器）—— 出厂烧死在芯片里的代码，用户改不了；日志里的 `ESP-ROM:` 就是它在说话。
- **RAM**（Random Access Memory，随机存取存储器）—— 运行时的工作内存，断电即失；日志里 `load:` 的行就是把内容搬进 RAM。
- **Flash**（闪存）—— 断电不丢的存储器，程序存在这里；容量看具体型号（C6 是封装内 8MB，S3 是 16MB）。
- **SRAM**（Static Random Access Memory，静态随机存取存储器）—— RAM 的一种实现：6 个晶体管锁 1 个 bit，最快、不用刷新。芯片手册说 "SRAM" 就是指片上 RAM。
- **DRAM**（Dynamic Random Access Memory，动态随机存取存储器）—— RAM 的另一种实现：1 个晶体管 + 1 个电容，必须不停刷新；PC 的内存条用的就是它。
- **PSRAM**（Pseudo-static RAM，伪静态 RAM）—— 用 DRAM 技术做、对外提供类似 SRAM 接口的**外挂**内存。S3 板有 8MB，C6 板没有。
- **DRAM（当区域名用时）** —— **同一个缩写两个意思**：在链接脚本和日志里，`DRAM` = **Data RAM（数据内存）**，指同一块片上 SRAM 里放数据的那部分（如日志里的 `0x40800000`）；和上面那个"动态随机存取存储器"无关。同理链接脚本里的 `RAM` / `SRAM` 常泛指这片片上 SRAM。
- **IRAM**（Instruction RAM，指令内存）—— 指"这块 SRAM 用来放指令"，不是另一种硬件。
- **eFuse**（electronic Fuse，电子熔丝）—— 一次性可编程的存储位，烧断不能改；芯片版本、MAC 地址、加密密钥都在里面。
- **RTC**（Real-Time Clock，实时时钟）—— 芯片里常年供电的低功耗部分，管计时和慢速内存；"RTC 域"就是它。
- **HPSYS**（High-Performance System，高性能系统）—— 负责 CPU 和主要外设的那半个区域；相对的是 **LP**（Low-Power，低功耗域）。`USB_UART_HPSYS` = USB-UART 复位了高性能域。
- **Cache**（缓存）—— C6 上 32KB、只读、四路组相联（four-way set associative）；给"在 flash 里跑"的代码加速。
- **MMU**（Memory Management Unit，内存管理单元）—— 把 flash 按 64KB 一块映射进 CPU 地址空间的那部分硬件。
- **磨损均衡**（wear leveling）—— 让写操作轮流落到不同块上，避免总写坏同一块；NVS / 文件系统负责。
- **隧穿**（tunneling）—— flash 写/擦时电荷穿过氧化层的物理过程，也是 flash 有写入寿命的根本原因。
- **软错误**（soft error）—— 辐射打中存储器导致某个 bit 翻转；重写一次即可，和 flash 磨损不是一回事。
- **封装内 flash**（in-package flash）—— flash 芯片和主芯片封在同一个封装里（如 `ESP32-C6FH4` = 封装内 4MB）。
- **JEDEC ID** —— flash 芯片的身份/容量标识；espflash 就是读它来报 "Flash size: 8MB" 的。
- **map 段 / load 段** —— 程序镜像里的两种段：`map` = 留在 flash 里跑，`load` = 开机复制进 SRAM。

### 1.2 通信接口

- **UART**（Universal Asynchronous Receiver/Transmitter，通用异步收发器）—— 最经典的"串口"硬件，两根线收发字节。
- **USB**（Universal Serial Bus，通用串行总线）—— 你插的那根线/那个口。
- **USB-Serial-JTAG**（USB Serial/JTAG controller，USB 串口/调试二合一外设）—— ESP32-C6/S3 内置的外设，芯片自带 USB 功能，不用外挂 CH340/CP2102 这类 USB 转串口芯片。日志和传文件共用这一个口。
- **CDC-ACM**（Communications Device Class - Abstract Control Model，通信设备类-抽象控制模型）—— USB 规范里"模拟一个串口"的标准；电脑上看到的 `/dev/cu.usbmodemXXXX` 就是按这个标准虚拟出来的串口。
- **JTAG**（Joint Test Action Group，联合测试行动组：制定标准的组织名）—— 调试接口标准，能直接读写芯片内部；ESP32 把它和 USB 合成一个外设，既能当串口又能当调试器。
- **SPI**（Serial Peripheral Interface，串行外设接口）—— 高速短距离通信总线，四根线：SCLK 时钟、MOSI 主机出/从机入、MISO 主机入/从机出、CS 片选。C6 板上屏幕和 TF 卡共用这条总线。
- **QSPI**（Quad SPI，四线 SPI）—— 数据相位用 4 根线并行；S3 板的屏幕走它。
- **GPIO**（General-Purpose Input/Output，通用输入输出）—— 用途由程序决定的引脚。
- **PHY**（Physical layer，物理层）—— 通信里最底层"电信号那一层"的电路；分区 `phy_init` 存的就是射频校准参数。
- **RF**（Radio Frequency，射频）—— 无线通信的模拟电路，Wi-Fi / 蓝牙都靠它。
- **ACK**（acknowledgement，确认/应答）—— 收方回给发方的一个短信号，表示"这一块收到了"。
- **stop-and-wait**（停等）—— 一种流控方式：发一块、等对方回 ACK、再发下一块。慢一点，但不会淹没对方的缓冲区。

### 1.3 Flash 分区名（脑补成"硬盘分区"）

- **NVS**（Non-Volatile Storage，非易失性存储）—— 乐鑫提供的键值对存储区，放配置项、Wi-Fi 密码这类小数据，掉电不丢；有磨损均衡。目前本项目没用它。
- **phy_init** = **phy** + **init**（initialization，初始化）—— 射频校准参数分区。
- **factory**（出厂/主程序分区）—— **我们的程序就烧在这里**。
- **App**（application，应用程序）—— 编译出来的这个程序；`part.` = **partition**（分区）的缩写。

### 1.4 软件与工具

- **IDF**（Espressif IoT Development Framework，乐鑫物联网开发框架）—— 乐鑫官方 C/C++ 框架；日志里的二级引导程序就是用它编的。
- **bootloader**（引导程序）—— 开机时"读分区表 → 找程序 → 搬进内存 → 跳过去"的小程序，分一级（ROM 里）和二级（flash 里）。
- **HAL**（Hardware Abstraction Layer，硬件抽象层）—— 包住寄存器细节、提供一套现成函数的库；本项目的 `esp-hal` 就是。
- **defmt**（deferred formatting，延迟格式化）—— Rust 嵌入式日志框架：内容压缩存进 flash，由电脑上的 espflash 还原成文字，所以每条日志能标出"文件:行号"。
- **RZCobs** —— defmt 的一种压缩编码（Run-Zero + Consistent Overhead Byte Stuffing），`espflash --log-format defmt` 在电脑侧按它解压。
- **init** —— initialize / initialization（初始化）的缩写，不是专有名词。
- **DIO**（Dual I/O，双线输入输出）—— SPI flash 的一种读取模式，用 2 根数据线；四线的叫 **QIO**（Quad I/O）。日志里 `mode:DIO` 即此。
- **SPIWP**（SPI Write Protect，SPI 写保护）—— flash 写保护寄存器状态，日志里的 `SPIWP:0xee`。
- **OTA**（Over-The-Air，空中升级）—— 不接电脑、通过网络把新固件写进 flash 的升级方式。
- **stub**（桩程序）—— 烧录时临时塞进芯片内存的小助手程序，用来加快烧写；日志里的 `Using flash stub` 就是它。
- **cargo workspace**（cargo 工作区）—— 一个 `Cargo.toml` 里用 `[workspace]` 把多个子项目捆在一起，共享 `Cargo.lock` 和 `target/`。
- **build-std**（build standard library，从源码编译标准库）—— `[unstable] build-std = ["core","alloc"]`，让 cargo 用 `rust-src` 现场编译 core/alloc，而不是用预编译版本。

### 1.5 看着像缩写、其实是引脚名

- **DC**（Data/Command）—— 告诉屏幕"这趟发的是数据还是命令"（SPI 屏有，QSPI 屏没有）。
- **CS**（Chip Select，片选）—— "我现在要跟你这块芯片说话"。
- **RST**（Reset，复位）。
- **BL**（Back Light，背光）。
- **SCLK**（Serial Clock，串行时钟）。
- **MOSI** / **MISO** —— Master Out Slave In / Master In Slave Out（主机发 / 主机收）；新命名 COPI / CIPO 是同样的两根线。
- **WDT**（Watchdog Timer，看门狗定时器）—— 倒计时器，程序要定期"喂狗"，忘了喂就复位芯片；**MWDT** = Main WDT（主看门狗）。

### 1.6 CPU 与寄存器

- **RISC-V** —— 一种开放指令集架构（读作 "risk five"）；ESP32-C6 的 CPU 就是它。
- **RV32IMAC** —— RISC-V 的规格写法：32 位，外加 I（基础整数）/ M（乘除）/ A（原子）/ C（压缩指令）四个扩展。
- **HP CPU**（High-Performance CPU，高性能 CPU）—— 主核（C6 上是 32 位 RISC-V，最高 160MHz）。
- **LP CPU**（Low-Power CPU，低功耗 CPU）—— 副核，deep sleep 时仍可运行。
- **通用寄存器**（General-Purpose Register，GPR）—— CPU 内部那 32 个小格子（每个 32 位），**没有地址、不算内存**。
- **CSR**（Control and Status Register，控制与状态寄存器）—— CPU 内部管配置和状态的寄存器（例如中断使能）。
- **触发器**（flip-flop）—— 用几个逻辑门锁住 1 个 bit 的电路；CPU 寄存器就是它搭出来的。
- **spill**（寄存器溢出）—— 寄存器不够用时，编译器把变量写回 SRAM。
- **上下文切换**（context switch）—— 切换任务 / 处理中断时，把寄存器内容压进 SRAM 的栈里再切走；这就是"上下文要占 RAM"的原因。
- **PC**（Program Counter，程序计数器）—— CPU 下一条要执行的指令地址，不是"个人电脑"。日志里 `Saved PC:0x40800822` 就是复位那一刻 CPU 停在哪儿。

### 1.7 显示与存储卡

- **LCD**（Liquid Crystal Display，液晶显示）—— 液晶显示屏。
- **TFT**（Thin Film Transistor，薄膜晶体管）—— LCD 的一种驱动方式：每个像素配一个晶体管。
- **ST7789 / ST77922** —— 常见的 SPI / QSPI 小屏驱动控制芯片型号（厂家起的名字，不是缩写）。
- **RGB565** —— 16 位颜色编码：红 5 位 + 绿 6 位 + 蓝 5 位，共 65,536 色。一个 320×172 的整屏就是 320×172×2 = 110,080 字节。
- **SD**（Secure Digital，安全数字）—— 存储卡的标准名，也是最早那种大卡（32×24×2.1mm）的叫法。
- **TF / microSD** —— 小卡。TF 是 SanDisk 最早的商品名（TransFlash），后来被 SD 协会采纳为 **microSD**；日常说的"TF 卡"就是 microSD。
- **SDIO**（Secure Digital Input Output，安全数字输入输出）—— SD 卡的 4 线接口模式（比 SPI 模式快）；绝大多数卡也支持更简单的 **SPI 模式**（引脚少、速度低，C6 板常用）。
- **FAT / FAT16 / FAT32**（File Allocation Table，文件分配表）—— 一种老牌文件系统格式；数码相机和单片机读卡基本都用它，**不支持 exFAT**。
- **创建时间 / 修改时间（ctime / mtime）** —— FAT 目录项里各存一份。注意没有 RTC 的板子写文件时用的是固定时钟，同一批文件的创建时间会完全相同，排序时需要再加一层 tie-break（例如按目录项顺序）。
- **卷标**（volume label）—— FAT 根目录里的一条特殊目录项，用来给整张卡起名字（例如 `SDCARD`）。它**不是文件**（属性里的 `VOLUME` 位为 1），遍历目录时要过滤掉。
- **BMP**（bitmap，位图）—— 最简单的一种图片文件格式：一个固定长度的文件头，后面直接跟像素字节，**不需要解码器**就能读。24 位无压缩 BMP 里每个像素是 B、G、R 三个字节，且**从下往上**逐行存放。
- **GIF**（Graphics Interchange Format，图形交换格式）—— 一种带调色板、支持透明和动画的图片格式；动画由多帧组成，每帧带自己的延迟和 disposal（上一帧怎么处理）规则。
- **帧 / 延迟 / 循环** —— GIF 动画里的“帧”是一张图，“延迟”是这帧显示多久（单位 1/100 秒），“循环”是整段动画播几遍；`loop=0` 通常表示无限循环。
- **contain / cover / fill（图片放进目标框的三种方式）** —— `contain` = 完整缩进框内、保留比例（框里多余的地方是背景色）；`cover` = 铺满整框、超出部分裁掉；`fill` = 直接拉伸（会变形）。

## 2. 内存与执行模型

### 2.1 Flash / SRAM / DRAM / PSRAM

**RAM 是总称**（Random Access Memory，随机存取存储器），**SRAM 是 RAM 的一种实现方式**；芯片手册里写 "SRAM"，说的就是这颗芯片的片上 RAM。

|                   | Flash（闪存）            | SRAM（静态随机存取存储器）                | DRAM（动态随机存取存储器）                            |
|-------------------|------------------------|-----------------------------------------|-----------------------------------------------------|
| 全称              | flash memory           | Static Random Access Memory             | Dynamic Random Access Memory                        |
| 断电后            | 数据保留               | 丢失                                    | 丢失                                                |
| 每个 bit 用什么存 | 浮栅晶体管存电荷       | 6 个晶体管锁存                          | 1 个晶体管 + 1 个电容                               |
| 需要刷新吗        | 不用                   | 不用                                    | 要不停刷新（所以叫"动态"）                            |
| 写入代价          | 要先擦除整块、慢、有寿命 | 直接写、最快                             | 快，但要刷新                                         |
| 用途              | 存程序和数据（仓库）     | CPU 的变量、栈、堆、要高速跑的代码（工作台） | PC 内存条；MCU 上外挂的 PSRAM 用它                   |

### 2.2 为什么有"在 flash 里跑"和"复制进 SRAM"两种

**在 flash 里跑不是裸读 flash 芯片**，中间隔着两层：

- **MMU**：把 flash 按 **64KB 一块**映射进 CPU 地址空间（指令和数据各最多 16MB）。
- **Cache**：C6 上是 32KB、只读、四路组相联；命中就快，未命中要等 flash。

```text
I (72)  esp_image: segment 0: paddr=00010020 vaddr=42000020 size=24184h (147844) map   // 0x42… 映射区：代码留在 flash，靠缓存取指
I (107) esp_image: segment 1: paddr=000341ac vaddr=40800000 size=0be6ch ( 48748) load  // 0x40… SRAM 区：开机时复制进 RAM
```

- `paddr` 和 `vaddr` 的低位都是 `0x20` —— MMU 要求 flash 地址与内存地址**在 64KB 页内的偏移一致**。
- **为什么还要复制进 SRAM**：① 可写数据（变量、栈、堆）必须在 RAM；② 速度和确定性（缓存未命中要等）；
  ③ **擦写 flash 时不能从 flash 取指**，那段时间还要跑的代码必须在 RAM 里。
- **为什么不能全放 flash**：程序不只有只读指令，还有必须可写的数据；而且 flash 取指带宽/延迟远不如 SRAM。
  所以策略是"默认放 flash 省 RAM，必要的搬到 RAM"。
- 实例：C6 固件 920,208 字节 ≈ **805KB 在 flash**（两个 `map` 段）+ **94KB 进 SRAM**（四个 `load` 段）。

### 2.3 CPU 寄存器不在 SRAM 里

- **CPU 寄存器是 CPU 内部极小的存储**，由触发器组成，**没有内存地址**，也**不占那 512KB SRAM**。
- RISC-V 有 **32 个通用寄存器**（RV32IMAC：每个 32 位，合计 128 字节），外加 PC 等控制/状态寄存器。
  每个 CPU 核有自己的一套寄存器。
- 类比：**寄存器** = 手上的几个格子；**SRAM** = 旁边的工作台；**flash** = 仓库。
- 但寄存器的内容会被**暂存进 SRAM**：中断 / 任务切换时，CPU 把寄存器压到 SRAM 里的栈上
  （这就是"上下文"要占 RAM 的原因）。编译器也会把常用变量留在寄存器里，放不下的"溢出"（spill）到 SRAM。

### 2.4 Flash 的写入寿命

- **为什么会磨损**：flash 用浮栅晶体管存电荷，写/擦要让电荷**穿过极薄的氧化层**；每擦写一次就轻微损伤一次。
  而且**擦除是按块**做的（典型 4KB 一个扇区），改 1 个字节也要擦掉一整块。
- **典型值**（SPI NOR flash 这一类）：**每块约 100,000 次擦写**、**数据保存约 20 年**；具体以芯片手册为准。
- **换算成时间**：寿命按"写同一块"的频率算。正常开发每天烧 10 次 → 约 27 年，用不完；
  但**在循环里反复写同一块**（每秒一次），一天多就能把那块写废。
- **对策**：频繁写的数据交给 NVS / 文件系统（有磨损均衡，写操作轮流摊到不同块），或先在 SRAM 里攒着批量写。
- **SRAM / DRAM 没有写入次数寿命**：SRAM 靠 6 个晶体管正反馈锁状态，写就是翻转晶体管；
  DRAM 靠电容存电荷 + 不停刷新，而刷新是"重新充电"不是磨损。它们的问题是别的 ——
  SRAM 断电即失、怕辐射（**软错误**）；DRAM 要不停刷新、对温度敏感。

## 3. 复位

**复位的"深度"**（esp-hal 源码里的术语定义，从轻到重）：

- **CPU Reset** —— 只复位 CPU 核（C6 日志里的 `Cpu0…` 系列）。
- **Core Reset** —— 复位整个数字系统，但 RTC 子系统保留（含 `0x15` / `0x16`）。
- **System Reset** —— 数字系统 + RTC（`Sys…` 系列）。
- **Chip Reset** —— 整颗芯片，连模拟部分（`ChipPowerOn`）。

两块板各自的 code → 名字对照表见 [`esp32-c6-lcd-147.md`](esp32-c6-lcd-147.md#4-复位原因) 与
[`esp32-s3-lcd-35.md`](esp32-s3-lcd-35.md#7-复位原因)（枚举名不完全一样）。

## 4. 启动日志逐行注解

以下是 C6 板插着 USB、`cargo run` 烧录时的一段完整启动日志，`//` 后面是逐行解释，按来源分三段。

```text
// ================= 来源：电脑（espflash 打印） =================
[2026-09-26T08:09:27Z INFO ] Serial port: '/dev/cu.usbmodemXXXX'  // 板子在 macOS 上的串口设备名（走芯片自带 USB）
[2026-09-26T08:09:27Z INFO ] Connecting...                        // 正在和芯片里出厂的引导程序握手
[2026-09-26T08:09:27Z INFO ] Using flash stub                     // 先往芯片内存塞个小助手（stub），用来加快烧录
Chip type:         esp32c6 (revision v0.2)                        // 芯片型号 + 硅片版本
Crystal frequency: 40 MHz                                         // 板上晶振频率，芯片的时钟来源
Flash size:        8MB                                            // Flash（闪存）容量
Features:          WiFi 6, BT 5                                   // 支持 Wi-Fi 6 和 BT（Bluetooth，蓝牙）5
MAC address:       aa:bb:cc:dd:ee:ff                              // MAC（Media Access Control，媒体访问控制）地址，出厂唯一
App/part. size:    920,208/8,323,072 bytes, 11.06%                // App（application，应用程序）用了 11.06% 的分区（partition）空间
[2026-09-26T08:09:28Z INFO ] Flashing has completed!              // 烧录完成
Commands:                                                         // 下面是监视器的快捷键提示
    CTRL+R    Reset chip                                          // Ctrl+R：复位芯片（串口不会被踢掉）
    CTRL+C    Exit                                                // Ctrl+C：退出监视器

// ================= 来源：芯片（出厂 ROM 引导程序） =================
ESP-ROM:esp32c6-20220919                                          // 芯片内固化的 ROM（Read-Only Memory，只读存储器）引导程序，用户改不了
Build:Sep 19 2022                                                 // 上面这段 ROM 的编译日期
rst:0x15 (USB_UART_HPSYS),boot:0x6e (SPI_FAST_FLASH_BOOT)         // rst=reset 复位原因：0x15=USB 串口复位（即 CoreUsbUart）；boot=启动模式：从 flash 高速启动
Saved PC:0x40800822                                               // PC（Program Counter，程序计数器）= 复位那一刻 CPU 停的地址
SPIWP:0xee                                                        // SPIWP（SPI Write Protect，SPI 写保护）寄存器状态
mode:DIO, clock div:2                                             // Flash 读取模式 DIO（Dual I/O，双线）+ 时钟分频 2
load:0x40875730,len:0x1628                                        // 把这几个分段从 flash 搬进 RAM（下面共 3 行同理）
load:0x4086b910,len:0xd9c
load:0x4086e610,len:0x31e0
entry 0x4086b91a                                                  // 跳到引导程序入口，开始执行

// ================= 来源：芯片（flash 里的二级引导程序） =================
I (23) boot: ESP-IDF v6.1-beta1-497-g14f663f003e 2nd stage bootloader // 二级引导程序启动；IDF=Espressif IoT Development Framework（乐鑫物联网开发框架）；(23)=开机后 23 毫秒
I (24) boot: chip revision: v0.2                                  // 芯片版本，和电脑侧报的一致
I (24) boot: efuse block revision: v0.3                           // eFuse（electronic Fuse，电子熔丝）块版本
I (24) boot.esp32c6: SPI Speed      : 80MHz                       // 读 flash 的速度
I (28) boot.esp32c6: SPI Mode       : DIO                         // flash 读取模式
I (32) boot.esp32c6: SPI Flash Size : 8MB                         // flash 容量（两处都报 8MB，所以按 8MB 算）
I (35) boot: Enabling RNG early entropy source...                 // 打开 RNG（Random Number Generator，随机数发生器）的早期熵源，加密/无线要用
I (40) boot: Partition Table:                                     // 下面是分区表（把 flash 想成硬盘的分区）
I (43) boot: ## Label            Usage          Type ST Offset   Length // 表头：名字 / 用途 / 类型 / 子类型 / 偏移 / 长度
I (49) boot:  0 nvs              WiFi data        01 02 00009000 00006000 // NVS（Non-Volatile Storage，非易失性存储）分区：配置、Wi-Fi 信息
I (55) boot:  1 phy_init         RF data          01 01 0000f000 00001000 // PHY（physical layer，物理层）射频校准参数
I (62) boot:  2 factory          factory app      00 00 00010000 007f0000 // 主程序分区：我们的程序就烧在这里
I (69) boot: End of partition table                               // 分区表结束
I (72) esp_image: segment 0: paddr=00010020 vaddr=42000020 size=24184h (147844) map // 加载程序分段：paddr=flash 地址，vaddr=内存地址，size=长度（…h 是十六进制）
I (107) esp_image: segment 1: paddr=000341ac vaddr=40800000 size=0be6ch ( 48748) load // map=直接从 flash 执行/读取；load=复制进 RAM
I (119) esp_image: segment 2: paddr=00040020 vaddr=42030020 size=a51d4h (676308) map // 同上（map）
I (248) esp_image: segment 3: paddr=000e51fc vaddr=4080be6c size=08fa0h ( 36768) load // 同上（load）
I (257) esp_image: segment 4: paddr=000ee1a4 vaddr=40814e10 size=025cch (  9676) load // 同上（load）
I (260) esp_image: segment 5: paddr=000f0778 vaddr=408173e0 size=002f0h (   752) load // 同上（load）
I (266) boot: Loaded app from partition at offset 0x10000         // 加载完成，准备把 CPU 交给我们的程序
I (267) boot: Disabling RNG early entropy source...               // 关掉早期熵源，之后由程序自己管理

// ================= 来源：我们的固件（defmt 打印） =================
[INFO ] Embassy initialized!                                     // Embassy（Rust 的异步任务调度器）已启动
[INFO ] Reset reason: CoreUsbUart 0x15 USB-UART                  // 复位原因，和上面 rst:0x15 是同一件事
[INFO ] LCD ready: ST7789 {宽}x{高} (landscape), SD: {卡的状态}   // 屏幕初始化完成（横屏）；后面跟 SD 卡摘要
[INFO ] System Ready: 等网页发命令（device/info、media/list…）     // 进入主循环，等网页发命令
```

`{}` 处是运行时填进去的值（屏幕尺寸、SD 卡容量和文件数）。
