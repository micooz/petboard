//! 把 esp-hal 的 SDMMC 主机垫成 `embedded-sdmmc` 认的块设备。
//!
//! ## 为什么需要这一层
//!
//! C6 板上卡是走 SPI 的，`embedded-sdmmc` 自带 `SdCard` 就能用。这块 S3 板的 TF 卡
//! 接在 **SDMMC 主机（SDIO 4-bit）** 上，而 `embedded-sdmmc` 只实现了 SPI 模式，
//! 两者对不上。中间还差两件事：
//!
//! - **协议栈**：SD 卡的初始化状态机（CMD0/8/ACMD41/CMD2/3/9/7/16…）与块读写命令
//!   （CMD17/18/24/25 + CMD12/23）没有现成实现 —— 用 `sdio` 这个 crate（esp-hal 的
//!   `sdmmc::Slot` 在 Async 模式下就实现了它的 `MmcBus`）。
//! - **同步/异步的缝**：`sdio` 那套是 `async fn`，`embedded-sdmmc` 的 `BlockDevice` 是同步 trait。
//!   这里用 `embassy_futures::block_on` 在调用点把 future 跑完（板上只有一个任务会碰卡，
//!   所以不必担心把执行器堵住别人 —— 和 C6 那边 `media/bench` 直接同步读卡是同一类做法）。
//!
//! ## 数据怎么过去
//!
//! `embedded-sdmmc` 的块缓冲是 `[u8; 512]`（`embedded_sdmmc::Block`），不保证 4 字节对齐；
//! 而 SDMMC 的 IDMAC 要求缓冲按 4 字节对齐。所以这里**不把调用方的缓冲直接交给 DMA**：
//! 借用板子上的一块静态对齐暂存区，读完再拷进调用方的 `Block`。

use core::cell::RefCell;

use aligned::{A4, Aligned};
use block_device_driver::BlockDevice as _;
use embassy_futures::block_on;
use embedded_hal::delay::DelayNs;
use embedded_sdmmc::{Block, BlockCount, BlockDevice, BlockIdx};
use esp_hal::delay::Delay;
use esp_hal::sdmmc::{SdHostController, Slot, SlotConfig};

/// SD 卡的块大小（`embedded_sdmmc` 只支持 512）
const BLOCK: usize = 512;
/// 卡初始化时的时钟（规范要求 ≤400kHz）
pub const INIT_FREQ_HZ: u32 = 400_000;
/// 卡正常工作的时钟。SDIO 模式下 20MHz 是稳妥的起点；再高要开 tuning
pub const RUN_FREQ_HZ: u32 = 20_000_000;

/// 一次最多搬几块。
///
/// `embedded-sdmmc` 的 `ReadAhead` 一次要 16 块（8KiB），SD 卡的 CMD18 多块读正好用得上 ——
/// **逐块读会退化成每 512B 一条 CMD17，SDIO 的速度全白费**（真机实测：逐块读只有
/// 1156KiB/s，和多块读差着一个量级）。所以暂存区按 16 块准备。
pub const BURST_BLOCKS: usize = 16;

/// 对齐的块暂存区：`BURST_BLOCKS` 个 512B 块，4 字节对齐。
///
/// 为什么要这么一块：`embedded-sdmmc` 的 `Block` 只有 1 字节对齐，而 SDMMC 的 IDMAC
/// 要求缓冲 4 字节对齐。所以**不把调用方的缓冲直接交给 DMA**，而是先读进这块对齐内存，
/// 再拷给调用方。
///
/// 放在 `RefCell` 里是因为 `embedded_sdmmc::BlockDevice` 的 `read`/`write` 只拿 `&self`，
/// 而 `sdio` 那套要 `&mut`。
type Staging = RefCell<Aligned<A4, [u8; BLOCK * BURST_BLOCKS]>>;

/// 块设备本体：`sdio` 的块设备（异步）+ 对齐暂存区。
///
/// 两者都在 `RefCell` 里：`embedded_sdmmc` 的 trait 方法只有 `&self`。
/// 板上只有一个任务碰卡，不会真的撞上借用冲突。
pub struct SdioBlockDevice<'d> {
    inner: RefCell<
        sdio::BlockDevice<sdio::sd::Card, Slot<'d, 0, esp_hal::Async>, BlockingDelay, BLOCK>,
    >,
    staging: Staging,
}

/// `sdio` 的 `BusAdapter` 要 **异步** 的 `DelayNs`，而 esp-hal 的 `Delay` 只有同步那个。
///
/// 卡初始化里有几处"发完命令等 1~10ms"的延时，这里用忙等实现：次数很少、总时长几十毫秒，
/// 而且卡的操作本来就在 `block_on` 里同步跑着，等一等不影响别的任务。
struct BlockingDelay(Delay);

impl embedded_hal_async::delay::DelayNs for BlockingDelay {
    async fn delay_ns(&mut self, ns: u32) {
        // 只有毫秒量级值得忙等；更短的延时在 SD 命令间隔里用不到
        let us = ns.div_ceil(1_000);
        if us > 0 {
            self.0.delay_us(us);
        }
    }
}

/// 这一层可能出的错（`embedded_sdmmc::BlockDevice::Error` 只要求 `Debug`；
/// `fm-core` 另外要求 `defmt::Format`，因为出错时要打日志）
#[derive(Debug, defmt::Format)]
pub enum SdioError {
    /// 主机/slot 配置失败
    Host(esp_hal::sdmmc::ConfigError),
    /// 卡协议栈报的错
    Mmc(sdio::MmcError),
}

impl core::error::Error for SdioError {}

impl core::fmt::Display for SdioError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            SdioError::Host(e) => write!(f, "SDIO host: {e:?}"),
            SdioError::Mmc(e) => write!(f, "SDIO card: {e:?}"),
        }
    }
}

impl<'d> SdioBlockDevice<'d> {
    /// 挂上卡：初始化 SDMMC 主机、配好 4-bit 总线，再跑一遍卡的初始化状态机。
    ///
    /// 失败时把 `sdio` 的错误原样带出来（`Debug` 里能看出是超时、CRC 还是不支持的电压）。
    pub fn new(
        host: &'d SdHostController<'d>,
        clk: impl esp_hal::gpio::interconnect::PeripheralOutput<'d> + 'd,
        cmd: impl esp_hal::gpio::interconnect::PeripheralInput<'d>
        + esp_hal::gpio::interconnect::PeripheralOutput<'d>
        + 'd,
        d0: impl esp_hal::gpio::interconnect::PeripheralInput<'d>
        + esp_hal::gpio::interconnect::PeripheralOutput<'d>
        + 'd,
        d1: impl esp_hal::gpio::interconnect::PeripheralInput<'d>
        + esp_hal::gpio::interconnect::PeripheralOutput<'d>
        + 'd,
        d2: impl esp_hal::gpio::interconnect::PeripheralInput<'d>
        + esp_hal::gpio::interconnect::PeripheralOutput<'d>
        + 'd,
        d3: impl esp_hal::gpio::interconnect::PeripheralInput<'d>
        + esp_hal::gpio::interconnect::PeripheralOutput<'d>
        + 'd,
    ) -> Result<Self, SdioError> {
        // 1) 取一个 slot 并接上引脚。`SdHostController::slot` 只做配置，不碰卡。
        let slot = host
            .slot::<0>(SlotConfig::default())
            .map_err(SdioError::Host)?
            .with_clk(clk)
            .with_cmd(cmd)
            .with_data0(d0)
            .with_data1(d1)
            .with_data2(d2)
            .with_data3(d3)
            // 4-bit 总线：数据线接了几条由这里声明，协议栈据此选 BusWidth::W4
            .into_async();

        // 2) 跑卡的初始化状态机（CMD8 → ACMD41 → CMD2/3 → CMD9/7/16 …）
        let inner = block_on(sdio::BlockDevice::<sdio::sd::Card, _, _, BLOCK>::new(
            slot,
            BlockingDelay(Delay::new()),
            RUN_FREQ_HZ,
        ))
        .map_err(SdioError::Mmc)?;

        Ok(Self {
            inner: RefCell::new(inner),
            staging: RefCell::new(Aligned([0u8; BLOCK * BURST_BLOCKS])),
        })
    }
}

/// 把暂存区切成 `count` 个 512B 的对齐块，喂给 `sdio` 的多块读/写。
fn chunk_blocks<'a>(
    staging: &'a mut Aligned<A4, [u8; BLOCK * BURST_BLOCKS]>,
    count: usize,
) -> &'a mut [Aligned<A4, [u8; BLOCK]>] {
    // `Aligned` 实现了 `DerefMut<Target = [u8; N]>`，所以能直接拿到内部数组
    let bytes: &'a mut [u8; BLOCK * BURST_BLOCKS] = staging;
    // `Aligned<A4, [u8; N]>` 与 `[Aligned<A4, [u8; 512]>; N]` 的内存布局相同
    // （`Aligned` 只是给内部值加了更大的对齐要求，512 本身就是 4 的倍数），
    // 所以这里可以按块重新切分。这是 `aligned` 这个 crate 的惯用法。
    let (prefix, rest, suffix) = unsafe { bytes.align_to_mut::<Aligned<A4, [u8; BLOCK]>>() };
    debug_assert!(
        prefix.is_empty() && suffix.is_empty(),
        "512B 块应当天然 4 字节对齐"
    );
    &mut rest[..count]
}

/// `embedded-sdmmc` 的 `BlockDevice`：读、写、报告容量。
///
/// `read`/`write` 收的是 `&self`，所以内部全用 `RefCell`；板上只有一个任务碰卡，
/// 不会真的撞上借用冲突。
impl BlockDevice for SdioBlockDevice<'_> {
    type Error = SdioError;

    fn read(&self, blocks: &mut [Block], start_block_idx: BlockIdx) -> Result<(), Self::Error> {
        if blocks.is_empty() {
            return Ok(());
        }
        let mut staging = self.staging.borrow_mut();
        let mut inner = self.inner.borrow_mut();
        // 按暂存区容量分批：一批一次 CMD18（多块读），再把整批拷给调用方
        let mut done = 0usize;
        while done < blocks.len() {
            let batch = (blocks.len() - done).min(BURST_BLOCKS);
            let chunks = chunk_blocks(&mut staging, batch);
            block_on(inner.read(start_block_idx.0 + done as u32, chunks))
                .map_err(SdioError::Mmc)?;
            for (i, block) in blocks[done..done + batch].iter_mut().enumerate() {
                block
                    .contents
                    .copy_from_slice(&staging[i * BLOCK..(i + 1) * BLOCK]);
            }
            done += batch;
        }
        Ok(())
    }

    fn write(&self, blocks: &[Block], start_block_idx: BlockIdx) -> Result<(), Self::Error> {
        if blocks.is_empty() {
            return Ok(());
        }
        let mut staging = self.staging.borrow_mut();
        let mut inner = self.inner.borrow_mut();
        // 和读一样分批：一批一次 CMD25（多块写）
        let mut done = 0usize;
        while done < blocks.len() {
            let batch = (blocks.len() - done).min(BURST_BLOCKS);
            for (i, block) in blocks[done..done + batch].iter().enumerate() {
                staging[i * BLOCK..(i + 1) * BLOCK].copy_from_slice(&block.contents);
            }
            let chunks = chunk_blocks(&mut staging, batch);
            block_on(inner.write(start_block_idx.0 + done as u32, chunks))
                .map_err(SdioError::Mmc)?;
            done += batch;
        }
        Ok(())
    }

    fn num_blocks(&self) -> Result<BlockCount, Self::Error> {
        // `sdio` 把容量记在 CSD 里；换算成 512B 块数
        let inner = self.inner.borrow();
        let bytes = inner.card().csd.card_size();
        Ok(BlockCount((bytes / BLOCK as u64) as u32))
    }
}
