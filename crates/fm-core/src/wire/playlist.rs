//! **PetBoard 的业务格式**：`data/PLAYLIST` 的文本解析，每行 `<文件名> <循环次数>`。
//!
//! 清单的存放与读取在 `crate::storage`，这里只管文本；循环次数 `0` = 一直播
//! （见 [`crate::wire::LOOPS_INFINITE`]）。

use alloc::string::String;
use alloc::vec::Vec;

use super::command::parse_num;

/// 解析 `data/PLAYLIST` 的文本：每行 `<文件名> <循环次数>`（`0` = 一直播）。
///
/// - `#` 开头的注释、空行跳过；
/// - 解析不了的行也跳过 —— 固件宁少播一个，也不要因为一行坏掉整个清单。
pub fn parse_playlist(text: &str) -> Vec<(String, u16)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, loops)) = line.split_once(' ') else {
            continue;
        };
        let Some(loops) = parse_num::<u16>(loops.trim()) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        out.push((String::from(name), loops));
    }
    out
}
