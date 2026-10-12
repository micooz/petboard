//! SD 卡（TF 卡）：挂载 FAT、列目录、读写文件。
//!
//! 卡通过 SPI 访问，[`Fs`] 就是 embedded-sdmmc 的卷管理器（负责解析 FAT）。

use crate::wire::{PLAYLIST_FILE, parse_playlist};
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use core::cell::RefCell;
use core::ops::ControlFlow;
use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use embedded_sdmmc::{
    Block, BlockCount, BlockDevice, BlockIdx, Directory, Error, File, Mode, TimeSource, Timestamp,
    Volume, VolumeIdx, VolumeManager,
};

/// embedded-sdmmc 的默认上限：同时开 4 个目录、4 个文件、1 个卷。
/// 这两个常量只是为了让类型写得出来，值和 `VolumeManager::new` 的默认值一致。
pub const MAX_DIRS: usize = 4;
pub const MAX_FILES: usize = 4;
pub const MAX_VOLUMES: usize = 1;

/// 本项目的 FAT 卷管理器
pub type Fs<D, T> = VolumeManager<D, T, MAX_DIRS, MAX_FILES, MAX_VOLUMES>;

/// 资源目录：网页上传的 `.ANM` / `.BMP` 和索引 `INDEX` 都放在这里。
///
/// FAT 的短名是大写存储的，`open_dir` 会自己换算大小写，这里写小写只是为了可读。
pub const DATA_DIR: &str = "data";

/// 多块读降级时最多打几条日志（够看出"是不是一直在降级"就行，不刷屏）
///
/// 这个上限是**整个开机期间**的，不是每轮的：`RA_MULTI_FAIL` 会被 `readahead_reset` 清零
/// （每轮统计要归零），拿它当阈值就等于"每轮 3 条"，整表循环播放时照样刷屏。
/// 降级与否、降了几次本来就在每轮的 `play: loop …` 统计行和 `media/bench` 回复里，
/// 这几条只是给"日志里为什么看不见 CMD18"一个当场解释。
const READAHEAD_FALLBACK_LOGS: u32 = 3;

/// 顺序预读（[`ReadAhead`]）的运行计数。
///
/// 板子上只有一张 SD 卡，所以用全局静态量记最省事：`commands` 想打点统计时
/// 不必把 `ReadAhead` 实例一路传下来（`VolumeManager` 不暴露它）。
static RA_HITS: AtomicU32 = AtomicU32::new(0);
static RA_MISSES: AtomicU32 = AtomicU32::new(0);
static RA_MULTI_OK: AtomicU32 = AtomicU32::new(0);
static RA_MULTI_FAIL: AtomicU32 = AtomicU32::new(0);
static RA_BLOCKS: AtomicU32 = AtomicU32::new(0);

/// 降级告警已经打过几条（**不随 `readahead_reset` 清零**）：见 [`READAHEAD_FALLBACK_LOGS`]
static RA_FALLBACK_LOGGED: AtomicU32 = AtomicU32::new(0);

/// `media/get` 正在回传裸载荷时置上：这期间**一条日志都不能往串口写** ——
/// 日志帧会混进文件内容里，主机把帧字节当载荷、文件就错位了（`READAHEAD_FALLBACK_LOGS` 那条
/// 告警正好在文件读取路径里，最容易撞上）。
static PAYLOAD_QUIET: AtomicBool = AtomicBool::new(false);

/// 回传载荷期间把日志静音 / 解除（见 [`PAYLOAD_QUIET`]）
pub fn set_payload_quiet(on: bool) {
    PAYLOAD_QUIET.store(on, Ordering::Relaxed);
}

/// [`readahead_stats`] 的快照
#[derive(Debug, Clone, Copy, Default)]
pub struct ReadAheadStats {
    /// 命中预读缓存、没碰 SD 卡的块数
    pub hits: u32,
    /// 未命中（触发一次预读）的次数
    pub misses: u32,
    /// 预读（CMD18 多块读）成功次数
    pub multi_ok: u32,
    /// 预读失败、退回单块读（CMD17）的次数
    pub multi_fail: u32,
    /// 实际交给文件系统的块数
    pub blocks: u32,
}

impl ReadAheadStats {
    /// "命中率"：命中块数 / 总块数（总块数为 0 时返回 0）
    pub fn hit_percent(&self) -> u32 {
        self.hits
            .saturating_mul(100)
            .checked_div(self.blocks)
            .unwrap_or(0)
    }
}

/// 读一次计数器快照
pub fn readahead_stats() -> ReadAheadStats {
    ReadAheadStats {
        hits: RA_HITS.load(Ordering::Relaxed),
        misses: RA_MISSES.load(Ordering::Relaxed),
        multi_ok: RA_MULTI_OK.load(Ordering::Relaxed),
        multi_fail: RA_MULTI_FAIL.load(Ordering::Relaxed),
        blocks: RA_BLOCKS.load(Ordering::Relaxed),
    }
}

/// 清零计数器（每次播放/测速开始前调一次，这样每轮的数字是"这一轮"的）
pub fn readahead_reset() {
    for counter in [
        &RA_HITS,
        &RA_MISSES,
        &RA_MULTI_OK,
        &RA_MULTI_FAIL,
        &RA_BLOCKS,
    ] {
        counter.store(0, Ordering::Relaxed);
    }
}

/// 给 `embedded_sdmmc` 的块设备加顺序预读。
///
/// `embedded_sdmmc` 内置的 `BlockCache` 一次只读 1 个 512B 块；SD 驱动本身
/// 支持 CMD18 多块读，所以这里在下面垫一层：一旦请求某块，就一次读 `N` 块
/// 放进自己的缓存，后续顺序块直接命中。
pub struct ReadAhead<D, const N: usize>
where
    D: BlockDevice,
{
    inner: RefCell<ReadAheadInner<D, N>>,
}

struct ReadAheadInner<D, const N: usize> {
    device: D,
    cache: [Block; N],
    cache_start: Option<u32>,
    cache_len: usize,
}

impl<D, const N: usize> ReadAhead<D, N>
where
    D: BlockDevice,
{
    pub fn new(device: D) -> Self {
        ReadAhead {
            inner: RefCell::new(ReadAheadInner {
                device,
                cache: core::array::from_fn(|_| Block::new()),
                cache_start: None,
                cache_len: 0,
            }),
        }
    }
}

impl<D, const N: usize> BlockDevice for ReadAhead<D, N>
where
    D: BlockDevice,
{
    type Error = D::Error;

    fn read(&self, blocks: &mut [Block], start_block_idx: BlockIdx) -> Result<(), Self::Error> {
        if blocks.is_empty() {
            return Ok(());
        }

        let mut inner = self.inner.borrow_mut();
        let start = start_block_idx.0;
        RA_BLOCKS.fetch_add(blocks.len() as u32, Ordering::Relaxed);

        for (i, block) in blocks.iter_mut().enumerate() {
            let index = start.wrapping_add(i as u32);

            if let Some(cache_start) = inner.cache_start {
                let offset = index.wrapping_sub(cache_start) as usize;
                if offset < inner.cache_len {
                    RA_HITS.fetch_add(1, Ordering::Relaxed);
                    block
                        .contents
                        .copy_from_slice(&inner.cache[offset].contents);
                    continue;
                }
            }

            // 未命中：尝试一次多块读；失败就退回单块读（比如读到设备末尾）。
            let mut batch: [Block; N] = core::array::from_fn(|_| Block::new());
            match inner.device.read(&mut batch, BlockIdx(index)) {
                Ok(()) => {
                    RA_MISSES.fetch_add(1, Ordering::Relaxed);
                    RA_MULTI_OK.fetch_add(1, Ordering::Relaxed);
                    block.contents.copy_from_slice(&batch[0].contents);
                    for (dst, src) in inner.cache.iter_mut().zip(batch.iter()) {
                        dst.contents.copy_from_slice(&src.contents);
                    }
                    inner.cache_start = Some(index);
                    inner.cache_len = N;
                }
                Err(_) => {
                    RA_MISSES.fetch_add(1, Ordering::Relaxed);
                    let failures = RA_MULTI_FAIL.fetch_add(1, Ordering::Relaxed) + 1;
                    // 静音期间（正在发裸载荷）不打：这条日志走的是同一路 TX，混进文件就错位了。
                    // 预算**不因静音而消耗**，否则一次大文件的传输能把这几条全部吞掉。
                    if !PAYLOAD_QUIET.load(Ordering::Relaxed) {
                        let logged = RA_FALLBACK_LOGGED.load(Ordering::Relaxed);
                        if logged < READAHEAD_FALLBACK_LOGS {
                            RA_FALLBACK_LOGGED.fetch_add(1, Ordering::Relaxed);
                            // 这条日志是排查"读卡为什么慢"的关键：多块读（CMD18）没生效时，
                            // 每个块都要走一遍单块命令，读速会掉到 1/3 以下。
                            defmt::warn!(
                                "ReadAhead: 多块读 {} 块失败（本次开机第 {} 次，本轮第 {} 次），退回单块读，块 {}",
                                N,
                                logged + 1,
                                failures,
                                index
                            );
                        }
                    }
                    let mut single = [Block::new()];
                    inner.device.read(&mut single, BlockIdx(index)).map(|()| {
                        block.contents.copy_from_slice(&single[0].contents);
                    })?;
                    inner.cache_start = None;
                    inner.cache_len = 0;
                }
            }
        }
        Ok(())
    }

    fn write(&self, blocks: &[Block], start_block_idx: BlockIdx) -> Result<(), Self::Error> {
        let mut inner = self.inner.borrow_mut();
        inner.cache_start = None;
        inner.cache_len = 0;
        inner.device.write(blocks, start_block_idx)
    }

    fn num_blocks(&self) -> Result<BlockCount, Self::Error> {
        self.inner.borrow().device.num_blocks()
    }
}

/// embedded-sdmmc 需要知道"现在几点"（给新建/修改的文件打时间戳）。
/// 板子没有 RTC（Real-Time Clock，实时时钟），所以统一用固定的 2026-09-26 12:00:00；
/// 多个文件的时间会相同，列表用目录项顺序做 tie-break（见 [`list_root`]）。
pub struct FixedClock;

impl TimeSource for FixedClock {
    fn get_timestamp(&self) -> Timestamp {
        Timestamp {
            year_since_1970: 56,   // 1970 + 56 = 2026
            zero_indexed_month: 8, // 0 表示 1 月，所以 8 表示 9 月
            zero_indexed_day: 25,  // 0 表示 1 日，所以 25 表示 26 日
            hours: 12,
            minutes: 0,
            seconds: 0,
        }
    }
}

/// 打开着的"文件 + 根目录 + 卷"三件套。
///
/// **三个必须一起活着**，这也是它存在的唯一理由：embedded-sdmmc 的 `Volume`
/// 在析构时会自动 `close_volume`，而只要还有文件开着，`close_volume` 就会
/// 失败（`VolumeStillInUse`）并把卷留在表里 —— 之后再 `open_volume` 就会报
/// `VolumeAlreadyOpen`。所以不能只把 `File` 传出去。
///
/// 字段顺序 = 析构顺序（Rust 按声明顺序 drop）：文件 → 目录 → 卷。
pub struct OpenFile<'a, D, T>
where
    D: BlockDevice,
    T: TimeSource,
{
    file: File<'a, D, T, MAX_DIRS, MAX_FILES, MAX_VOLUMES>,
    /// 只为了按顺序析构（不参与读写）
    _dir: Directory<'a, D, T, MAX_DIRS, MAX_FILES, MAX_VOLUMES>,
    /// 只为了按顺序析构（不参与读写）
    _volume: Volume<'a, D, T, MAX_DIRS, MAX_FILES, MAX_VOLUMES>,
}

impl<D, T> OpenFile<'_, D, T>
where
    D: BlockDevice,
    T: TimeSource,
{
    /// 读一段，返回实际读到的字节数（0 = 到文件结尾了）
    pub fn read(&self, buf: &mut [u8]) -> Result<usize, Error<D::Error>> {
        self.file.read(buf)
    }

    /// 写一段
    pub fn write(&self, buf: &[u8]) -> Result<(), Error<D::Error>> {
        self.file.write(buf)
    }

    /// 读满整个 `buf`（`read` 允许只返回一部分，所以要循环）
    pub fn read_exact(&self, buf: &mut [u8]) -> Result<(), Error<D::Error>> {
        let mut filled = 0;
        while filled < buf.len() {
            match self.file.read(&mut buf[filled..])? {
                0 => return Err(Error::EndOfFile),
                n => filled += n,
            }
        }
        Ok(())
    }

    /// 文件大小（字节），来自 FAT 目录项
    pub fn length(&self) -> u32 {
        self.file.length()
    }

    /// 回到文件开头
    pub fn rewind(&self) -> Result<(), Error<D::Error>> {
        self.file.seek_from_start(0)
    }

    /// 跳到文件里的绝对偏移
    pub fn seek_from_start(&self, offset: u32) -> Result<(), Error<D::Error>> {
        self.file.seek_from_start(offset)
    }

    /// 关文件：把新的文件大小写回 FAT 目录项，然后释放目录和卷。
    /// 一定要显式关（`Drop` 也会关，但错误会被丢掉）。
    pub fn close(self) -> Result<(), Error<D::Error>> {
        let OpenFile {
            file,
            _dir,
            _volume,
        } = self;
        let result = file.close();
        drop(_dir);
        drop(_volume);
        result
    }
}

/// 打开 `data/` 下的 `name`（只读）。
pub fn open<'a, D, T>(fs: &'a Fs<D, T>, name: &str) -> Result<OpenFile<'a, D, T>, Error<D::Error>>
where
    D: BlockDevice,
    T: TimeSource,
{
    open_with_mode(fs, name, Mode::ReadOnly)
}

/// 在 `data/` 下新建（或清空）`name`；目录不存在时先建出来。
pub fn create<'a, D, T>(fs: &'a Fs<D, T>, name: &str) -> Result<OpenFile<'a, D, T>, Error<D::Error>>
where
    D: BlockDevice,
    T: TimeSource,
{
    open_with_mode(fs, name, Mode::ReadWriteCreateOrTruncate)
}

/// 删掉 `data/` 下的 `name`。
pub fn delete<D, T>(fs: &Fs<D, T>, name: &str) -> Result<(), Error<D::Error>>
where
    D: BlockDevice,
    T: TimeSource,
{
    let volume = fs.open_volume(VolumeIdx(0))?;
    let root = volume.open_root_dir()?;
    let dir = root.open_dir(DATA_DIR)?;
    let result = dir.delete_entry_in_dir(name);
    drop(dir);
    drop(root);
    drop(volume);
    result
}

fn open_with_mode<'a, D, T>(
    fs: &'a Fs<D, T>,
    name: &str,
    mode: Mode,
) -> Result<OpenFile<'a, D, T>, Error<D::Error>>
where
    D: BlockDevice,
    T: TimeSource,
{
    let volume = fs.open_volume(VolumeIdx(0))?;
    let root = volume.open_root_dir()?;
    // 只读打开时目录不存在就直接报错；要写的时候顺手把 `data/` 建出来。
    let dir = match root.open_dir(DATA_DIR) {
        Ok(dir) => dir,
        Err(_) if mode != Mode::ReadOnly => {
            root.make_dir_in_dir(DATA_DIR)?;
            root.open_dir(DATA_DIR)?
        }
        Err(e) => return Err(e),
    };
    let file = dir.open_file_in_dir(name, mode)?;
    Ok(OpenFile {
        file,
        _dir: dir,
        _volume: volume,
    })
}

/// 根目录里的一条目录项。
///
/// `ctime` 是 FAT 里的**创建时间**（创建文件时由 [`TimeSource`] 写入）。
/// `order` 是这次遍历目录时目录项出现的顺序（0 开始），用来在创建时间相同
/// （例如都用固定时钟写出来的文件）时决出先后：后追加的目录项排前面。
pub struct Entry {
    pub name: String,
    pub size: u32,
    pub ctime: Timestamp,
    pub is_dir: bool,
    pub order: usize,
}

impl Entry {
    /// 屏幕列目录和 `LIST` 共用的创建时间：`(年, 月, 日, 时, 分, 秒)`，
    /// 年份是实际年份（不是 `year_since_1970`），月份和日期从 1 开始。
    pub fn created_at(&self) -> (u32, u32, u32, u32, u32, u32) {
        (
            1970 + self.ctime.year_since_1970 as u32,
            self.ctime.zero_indexed_month as u32 + 1,
            self.ctime.zero_indexed_day as u32 + 1,
            self.ctime.hours as u32,
            self.ctime.minutes as u32,
            self.ctime.seconds as u32,
        )
    }
}

/// 一次列目录的结果
pub struct Listing {
    /// 目录里的条目（最多留 `keep` 条在内存里）
    pub entries: Vec<Entry>,
    /// 目录里实际有多少条（可能比 `entries.len()` 多）
    pub total: usize,
}

/// 列目录。`dir` 为 `None` 时列根目录，否则列这个子目录（不存在时返回 `Err`）。
/// `keep` 只影响内存里留几条，**不影响计数**。
///
/// 返回的 `entries` 已经按**创建时间倒序**排好；创建时间相同就按目录项顺序倒序，
/// 让后写进 FAT 目录的新文件排在前面。
pub fn list_dir<D, T>(
    fs: &Fs<D, T>,
    dir: Option<&str>,
    keep: usize,
) -> Result<Listing, Error<D::Error>>
where
    D: BlockDevice,
    T: TimeSource,
{
    let volume = fs.open_volume(VolumeIdx(0))?;
    let root = volume.open_root_dir()?;
    match dir {
        None => collect(&root, keep),
        Some(name) => {
            let sub = root.open_dir(name)?;
            collect(&sub, keep)
        }
    }
}

/// [`list_dir`] 的实际遍历：把目录里的条目收集成 [`Listing`]。
fn collect<D, T>(
    dir: &Directory<'_, D, T, MAX_DIRS, MAX_FILES, MAX_VOLUMES>,
    keep: usize,
) -> Result<Listing, Error<D::Error>>
where
    D: BlockDevice,
    T: TimeSource,
{
    let mut entries: Vec<Entry> = Vec::new();
    let mut total = 0usize;
    let _ = dir.iterate_dir(|entry| {
        // FAT 目录里还有一条“卷标”（volume label）目录项，例如 SDCARD。
        // 它不是文件，也不该出现在列表和计数里。
        if entry.attributes.is_volume() {
            return ControlFlow::Continue(());
        }

        let order = total;
        total += 1;

        // 只维护“前 keep 名”的有序表：内存占用和卡上有多少文件无关。
        if keep == 0 {
            return ControlFlow::Continue(());
        }
        let item = Entry {
            name: format!("{}", entry.name),
            size: entry.size,
            ctime: entry.ctime,
            is_dir: entry.attributes.is_directory(),
            order,
        };
        // 插入到第一个比它旧的位置；时间相同的时候 order 大的（后出现的）排前面。
        let pos = entries
            .iter()
            .position(|existing| (existing.ctime, existing.order) < (item.ctime, item.order))
            .unwrap_or(entries.len());
        entries.insert(pos, item);
        if entries.len() > keep {
            entries.pop();
        }
        ControlFlow::Continue(())
    });
    Ok(Listing { entries, total })
}

/// `data/` 目录在不在。第一次用的空卡上当然不在 —— 那不算错误。
pub fn data_dir_exists<D, T>(fs: &Fs<D, T>) -> Result<bool, Error<D::Error>>
where
    D: BlockDevice,
    T: TimeSource,
{
    let volume = fs.open_volume(VolumeIdx(0))?;
    let root = volume.open_root_dir()?;
    Ok(root.open_dir(DATA_DIR).is_ok())
}

/// `device/info` 里的 SD 卡摘要：只报容量和有没有 FAT 卷。
///
/// **故意不数条目** —— 数条目要遍历目录，而这条命令在播放期间也会被回答
/// （每帧之间偷偷看一眼串口），不该去抢 SD 总线。
pub fn summary(size_mb: Option<u64>) -> String {
    match size_mb {
        Some(mb) => format!("microSD {mb}MB (FAT)"),
        None => String::from("microSD no card / init failed"),
    }
}

/// 卡在，但 FAT 卷挂不上时的摘要。
pub fn no_fat_summary(size_mb: u64) -> String {
    format!("microSD {size_mb}MB no FAT volume")
}

/// 现在这张卡的摘要。
pub fn current_summary<D, T>(fs: &Fs<D, T>, size_mb: Option<u64>) -> String
where
    D: BlockDevice,
    T: TimeSource,
{
    let Some(mb) = size_mb else {
        return summary(None);
    };
    // 只打开卷，不遍历目录
    match fs.open_volume(VolumeIdx(0)) {
        Ok(_) => summary(Some(mb)),
        Err(_) => no_fat_summary(mb),
    }
}

/// 开机探测的结果
pub struct CardInfo {
    /// 卡容量（MB）；`None` = 卡没插好或者初始化失败
    pub size_mb: Option<u64>,
    /// 一句话摘要，`device/info` 用它
    pub summary: String,
    /// 卡挂上了、FAT 也能打开。命令层用它决定"读卡失败"该不该报给网页：
    /// 卡本身没挂上时，`media/list` 回空列表更合适（见 `commands::listing`）。
    pub mounted: bool,
}

/// 探测：卡多大、能不能挂上 FAT。
pub fn probe<D, T>(fs: &Fs<D, T>, size_mb: Option<u64>) -> CardInfo
where
    D: BlockDevice,
    T: TimeSource,
{
    let summary = current_summary(fs, size_mb);
    let mounted = size_mb.is_some() && fs.open_volume(VolumeIdx(0)).is_ok();
    CardInfo {
        size_mb,
        summary,
        mounted,
    }
}

/// 读 `data/PLAYLIST`：每行 `<文件名> <循环次数>`（0 = 无限）。
///
/// 空行和 `#` 开头的注释跳过；解析不了的行也跳过（固件宁少播一个也不要因为一行坏掉整个清单）。
/// 整份读进内存 —— 就算几百条也只有几 KB。
pub fn read_playlist<D, T>(fs: &Fs<D, T>) -> Result<Vec<(String, u16)>, Error<D::Error>>
where
    D: BlockDevice,
    T: TimeSource,
{
    const PLAYLIST_MAX: u32 = 64 * 1024;

    let file = open(fs, PLAYLIST_FILE)?;
    let len = file.length().min(PLAYLIST_MAX);
    let mut raw = Vec::with_capacity(len as usize);
    let mut buf = [0u8; 256];
    while raw.len() < len as usize {
        let want = (len as usize - raw.len()).min(buf.len());
        let got = file.read(&mut buf[..want])?;
        if got == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..got]);
    }
    let _ = file.close();

    // 逐行解析在 `crate::wire::playlist`（`tests/wire_contract.rs` 钉着：注释、空行、坏行都要跳过）
    let text = String::from_utf8_lossy(&raw);
    Ok(parse_playlist(&text))
}
