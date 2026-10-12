//! **PetBoard 的业务报文层**：命令语法、应答内容、事件与协议版本。
//!
//! 分层原则：通用的"报文怎么进出"（哨兵成帧、ID 配对、标签槽、块 ACK、TX 节流）
//! 在 `crates/serial`，那个 crate 不许知道 `media/*` 这些词；本模块装的才是
//! **本产品**的语义 —— 换一块板子做别的业务，`serial` 原样复用，这里整套换掉。
//!
//! - [`command`]：`~<id> <命名空间>/<动作> [参数…]` 的正文语法
//! - [`device`]：`device/info` 应答行的格式（网页解析的依据）+ 播放状态
//! - [`playlist`]：`data/PLAYLIST` 的文本解析
//! - [`vocab`]：本产品的控制帧词汇表（`READY` / `DATA n` / `ev <名>` 之外没有别的业务词）
//! - `codegen`（`gen` feature）：生成网页侧常量 `web/src/lib/serial/wire.ts` 与跨语言 fixture

use alloc::string::String;

pub mod command;
pub mod device;
pub mod playlist;
pub mod vocab;

#[cfg(feature = "gen")]
pub mod codegen;

pub use command::{Command, parse as parse_command};
pub use device::{IoStats, PlaybackState, device_info_lines};
pub use playlist::parse_playlist;
pub use vocab::{Body, event, parse_body};

/// 协议版本：网页看到对不上就提示"检测到旧固件，请重新烧录"。
///
/// 网页侧的值由本 crate **生成**（`web/src/lib/serial/wire.ts`，见 `codegen`），
/// 不是手抄的镜像。
///
/// 报文形状：控制帧带 `~` 哨兵与消息 ID；上传每块前面带标签字节；
/// 支持 `media/abort`（传输途中可打断）与 `~0 ev …`（设备主动推播放事件，主机不用轮询）。
pub const API_VERSION: u32 = 1;

/// 播放清单的文件名（卡上 `data/` 里；8.3 短名，网页写、固件读）。
pub const PLAYLIST_FILE: &str = "PLAYLIST";

/// 播放次数里的 `0`：一直播到被 `media/stop` 打断。
///
/// **循环次数不属于 `.ANM` 文件**：文件只描述"一段动画"，播几轮由外部给 ——
/// 唯一来源是播放清单 `data/PLAYLIST` 每行的第二个字段。
pub const LOOPS_INFINITE: u16 = 0;

/// C6 板回传方向实测的块大小（[`crate::BoardConfig::get_chunk`] 的取值依据）。
///
/// 为什么是 32：1024（16 个满 FIFO 的包）连发十几包后卡住；64（正好填满 FIFO）**还是一样卡**；
/// 18 字节（没填满 FIFO）的读从来没出过错 —— 差别就在"这一笔有没有把 64 字节的 TX FIFO
/// 填满"。取 FIFO 深度的一半：每块都留余量，慢一点，但一条也不会丢。**这是 C6 的实测值**
/// （S3 的发送路径不同，实测能跑到 512）。
pub const GET_CHUNK_C6: usize = 32;

/// 一条业务请求：消息 ID + 解析好的命令（外加原文，用于退回协议层）。
///
/// 协议 crate 交回来的是"谁说的 + 正文"（`serial::Request`），**在这里**才变成命令。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// 主机给这条请求编的号（`~<id> …`）；应答要原样带回去
    pub id: u32,
    pub command: Command,
    /// 正文原文（私有）：只用于 [`Request::to_wire`] 原样退回，不重复解析
    body: String,
}

impl Request {
    /// 协议层的一条报文 → 业务请求（认不出的正文当未知命令，仍要给它一个回执）
    pub fn from_wire(request: serial::Request) -> Self {
        let body = request.body;
        Request {
            id: request.id,
            command: command::parse(&body),
            body,
        }
    }

    /// 退回协议层的一条报文（"这条命令现在处理不了，先放回待发槽"时用）：
    /// 交回的是**原文**，所以绝不出现"解析再拼回去变了个样"的漂移。
    pub fn to_wire(self) -> serial::Request {
        serial::Request {
            id: self.id,
            body: self.body,
        }
    }
}
