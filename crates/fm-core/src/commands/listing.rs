//! 卡上条目的"看"和"删"：`media/list` 与 `media/delete`。
//!
//! 这两条都只动目录项、不碰文件内容，所以和收文件 / 回传文件那两条完全分开。

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use defmt::{info, warn};
use embedded_sdmmc::{BlockDevice, TimeSource};

use super::DeviceInfo;
use crate::link::Link;
use crate::storage::{self, Fs};

/// `media/list` 一次最多列几项（够用，而且不占内存）
const LIST_MAX: usize = 64;

/// 每行是 `<名字> <大小> <年> <月> <日> <时> <分> <秒>`，
/// 例如 `A1B2C3D4.ANM 535000 2026 09 26 12 00 00`。
///
/// 文件名只有 8.3 短名（FAT 限制），友好名字存在索引文件里、由网页自己读。
pub(super) fn list_cmd<D, T, U>(link: &mut Link<U>, fs: &Fs<D, T>, info: &DeviceInfo<'_>)
where
    U: crate::Serial,
    D: BlockDevice,
    D::Error: defmt::Format,
    T: TimeSource,
{
    match storage::list_dir(fs, Some(storage::DATA_DIR), LIST_MAX) {
        Ok(listing) => {
            let lines: Vec<String> = listing
                .entries
                .iter()
                .filter(|entry| !entry.is_dir)
                .map(|entry| {
                    let (year, month, day, hour, minute, second) = entry.created_at();
                    format!(
                        "{} {} {year} {month:02} {day:02} {hour:02} {minute:02} {second:02}",
                        entry.name, entry.size
                    )
                })
                .collect();
            link.reply_lines(&lines);
        }
        Err(e) => {
            // 卡没挂上、或者空卡上 `data/` 还不存在 —— 都是正常状态，当成空列表回，
            // 别让网页一进来就弹一条"读卡失败"。卡的状况由 `device/info` 的 `sd` 行说明。
            match storage::data_dir_exists(fs) {
                Ok(false) => link.reply_lines(&[]),
                _ if !info.sd_ok => link.reply_lines(&[]),
                _ => {
                    warn!("media/list failed: {:?}", e);
                    link.err("cannot list data dir");
                }
            }
        }
    }
}

/// 删掉 `data/` 下的文件。
pub(super) fn delete_cmd<D, T, U>(link: &mut Link<U>, fs: &Fs<D, T>, name: &str)
where
    U: crate::Serial,
    D: BlockDevice,
    D::Error: defmt::Format,
    T: TimeSource,
{
    match storage::delete(fs, name) {
        Ok(()) => {
            info!("media/delete done: {}", name);
            link.ok();
        }
        Err(e) => {
            warn!("media/delete failed: {} ({:?})", name, e);
            link.err("cannot delete file");
        }
    }
}
