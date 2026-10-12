//! **PetBoard 的业务命令**：`<命名空间>/<动作> [参数…]` 正文 → [`Command`]。
//!
//! 这里刻意**不属于** `crates/serial`：`device/*` / `media/*` 这些名字、参数含义、
//! "abort 要点名中断谁"都是本产品的语义，换一块板子/另一路业务就该整套换掉。
//! 通用的那一层（哨兵成帧、ID 配对、标签槽、ACK、TX 节流）在 `crates/serial`。
//!
//! 帧的外壳（`~<id> ` 前缀）由 `serial::frame` 剥掉，这里只管剩下的正文；
//! 正文的**线格式**（`OK` / `END` / `READY` / `DATA` / `ev` 那几个词）见 [`super::vocab`]。

use alloc::string::String;

/// 网页发来的一条命令
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// `device/info`
    DeviceInfo,
    /// `media/list`
    MediaList,
    /// `media/add <文件名> <字节数>`
    MediaAdd { name: String, len: u32 },
    /// `media/get <文件名> [<偏移> <字节数>]`
    MediaGet {
        name: String,
        offset: u32,
        /// `None` = 从 `offset` 一直读到文件结尾
        len: Option<u32>,
    },
    /// `media/delete <文件名>`
    MediaDelete { name: String },
    /// `media/play [<文件名>]`：按 `data/PLAYLIST` 整表循环播放
    MediaPlay {
        /// `None` = 从第一项开始
        start: Option<String>,
    },
    /// `media/stop`：停止正在播放的动画
    MediaStop,
    /// `media/abort <被中断请求的 id>`：传输途中叫停（上传/回传期间唯一被接受的命令）
    MediaAbort { id: u32 },
    /// `media/bench <文件名> [MiB]`
    MediaBench {
        name: String,
        /// `None` = 把文件读一遍；`Some(n)` = 一直读（读完回卷）到读满 n MiB
        mib: Option<u32>,
    },
    /// 命令认不出来
    Unknown(String),
    /// 命令认识但参数不对
    BadUsage(&'static str),
}

impl Command {
    /// `media/abort <id>` 里要点名中断的那条请求的编号；别的命令是 `None`。
    ///
    /// 单独抽出来是因为**两块板 + 假板子**都要做同一件事：判断这个编号是不是
    /// "此刻真正在飞的那条传输"。对不上就是**陈旧**的 abort（主机那侧状态已经错位，
    /// 或者那是上一轮迟到的取消），要回 `ERR stale`，而不是把好好的一次传输打断。
    pub fn abort_target(&self) -> Option<u32> {
        match self {
            Command::MediaAbort { id } => Some(*id),
            _ => None,
        }
    }

    /// 是不是要点名中断某条请求（不管编号对不对得上）
    pub fn is_abort(&self) -> bool {
        self.abort_target().is_some()
    }
}

/// 解析参数里的数字；解析不了返回 `None`。
///
/// 单独抽出来是因为 `parse` 里到处都在做这件事，而且边界（负数、前导 `+`、
/// 超大数值）值得单独钉一下。
pub(crate) fn parse_num<T: core::str::FromStr>(raw: &str) -> Option<T> {
    raw.parse::<T>().ok()
}

/// `<命名空间>/<动作> [参数...]` → [`Command`]
///
/// 文件名里不允许有空格（FAT 短名也不该有），所以参数一律按空格切；
/// 命令名**大小写敏感**（网页一律发小写，写错就当未知命令）。
pub fn parse(line: &str) -> Command {
    let (cmd, args) = match line.split_once(' ') {
        Some((cmd, args)) => (cmd, args),
        None => (line, ""),
    };
    let mut it = args.split(' ').filter(|arg| !arg.is_empty());

    match cmd {
        "device/info" => {
            if it.next().is_some() {
                Command::BadUsage("usage: device/info")
            } else {
                Command::DeviceInfo
            }
        }
        "media/list" => {
            if it.next().is_some() {
                Command::BadUsage("usage: media/list")
            } else {
                Command::MediaList
            }
        }
        "media/add" => {
            let (Some(name), Some(raw_len)) = (it.next().map(String::from), it.next()) else {
                return Command::BadUsage("usage: media/add <name> <len>");
            };
            if it.next().is_some() {
                return Command::BadUsage("usage: media/add <name> <len>");
            }
            match parse_num::<u32>(raw_len) {
                Some(len) if len > 0 => Command::MediaAdd { name, len },
                _ => Command::BadUsage("bad length"),
            }
        }
        "media/get" => {
            let Some(name) = it.next().map(String::from) else {
                return Command::BadUsage("usage: media/get <name> [<offset> <len>]");
            };
            let offset = match it.next() {
                None => 0,
                Some(raw) => match parse_num::<u32>(raw) {
                    Some(offset) => offset,
                    None => return Command::BadUsage("bad offset"),
                },
            };
            let len = match it.next() {
                None => None,
                Some(raw) => match parse_num::<u32>(raw) {
                    Some(len) if len > 0 => Some(len),
                    _ => return Command::BadUsage("bad length"),
                },
            };
            if it.next().is_some() {
                return Command::BadUsage("usage: media/get <name> [<offset> <len>]");
            }
            Command::MediaGet { name, offset, len }
        }
        "media/delete" => {
            let Some(name) = it.next().map(String::from) else {
                return Command::BadUsage("usage: media/delete <name>");
            };
            if it.next().is_some() {
                return Command::BadUsage("usage: media/delete <name>");
            }
            Command::MediaDelete { name }
        }
        "media/play" => {
            let start = it.next().map(String::from);
            if it.next().is_some() {
                return Command::BadUsage("usage: media/play [<name>]");
            }
            Command::MediaPlay { start }
        }
        "media/stop" => {
            if it.next().is_some() {
                return Command::BadUsage("usage: media/stop");
            }
            Command::MediaStop
        }
        "media/bench" => {
            let Some(name) = it.next().map(String::from) else {
                return Command::BadUsage("usage: media/bench <name> [<MiB>]");
            };
            let mib = match it.next() {
                None => None,
                Some(raw) => match parse_num::<u32>(raw) {
                    Some(mib) if mib > 0 => Some(mib),
                    _ => return Command::BadUsage("bad MiB"),
                },
            };
            if it.next().is_some() {
                return Command::BadUsage("usage: media/bench <name> [<MiB>]");
            }
            Command::MediaBench { name, mib }
        }
        "media/abort" => {
            let Some(raw_id) = it.next() else {
                return Command::BadUsage("usage: media/abort <id>");
            };
            match parse_num::<u32>(raw_id) {
                Some(id) if id > 0 => {
                    if it.next().is_some() {
                        return Command::BadUsage("usage: media/abort <id>");
                    }
                    Command::MediaAbort { id }
                }
                _ => Command::BadUsage("bad id"),
            }
        }
        other => Command::Unknown(String::from(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abort_target_only_reads_media_abort() {
        // 只有 abort 带"要点名中断谁"；别的命令必须是 None，否则传输会被无关命令打断
        assert_eq!(
            parse("media/abort 7").abort_target(),
            Some(7),
            "abort 的参数就是被中断请求的编号"
        );
        assert_eq!(parse("media/abort 0").abort_target(), None, "0 是非法编号");
        assert!(
            !parse("media/abort 0").is_abort(),
            "非法 abort 不当成 abort"
        );
        for other in [
            "media/stop",
            "media/get A.ANM 0 4",
            "device/info",
            "media/add A 10",
            "wat/ever",
        ] {
            assert_eq!(
                parse(other).abort_target(),
                None,
                "{other} 不该被当成 abort"
            );
            assert!(!parse(other).is_abort(), "{other} 不是 abort");
        }
    }

    #[test]
    fn parse_num_accepts_only_what_we_mean() {
        assert_eq!(parse_num::<u32>("0"), Some(0));
        assert_eq!(parse_num::<u32>("4294967295"), Some(u32::MAX));
        assert_eq!(parse_num::<u16>("65535"), Some(u16::MAX));
        // 越界、负号、空串、带空格都不接受
        assert_eq!(parse_num::<u16>("65536"), None);
        assert_eq!(parse_num::<u32>("-1"), None);
        assert_eq!(parse_num::<u32>(""), None);
        assert_eq!(parse_num::<u32>("1 2"), None);
        // Rust 的整数解析接受前导 `+`（标准库行为）；网页不会这么发，接受了也无害
        assert_eq!(parse_num::<u32>("+1"), Some(1));
    }
}
