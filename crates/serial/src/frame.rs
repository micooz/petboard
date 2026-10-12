//! 控制帧（`~` 开头那一行）的编解码，以及两个方向各自的"从字节流里切帧"。
//!
//! 这一层**不认识任何业务词**：它只管"一行控制帧"的外壳（哨兵 + 消息 ID + 正文）
//! 和 RPC 的通用应答骨架（`OK` / `OK <n>` + n 行正文 + `END` / `ERR <原因>`）。
//! 产品自己的词（比如"可以开始发了"、"紧接着是裸数据"、"设备主动推的事件"）
//! 一律落在 [`Reply::Unknown`] 里，由调用方按 [`Message::id`] 和正文自己分类 ——
//! 换一路业务不用改这里。
//!
//! 哨兵 `~` 是这条链路上最值钱的一条约定：它让"我们的报文"和"引导加载器的日志 /
//! 别的杂音"用**首字节**就能分开。以前报文是裸 `OK` / `ERR`，于是主机不得不
//! 从行尾正则抠回执、还要防引导日志的最后一行把 `OK 9` 粘在屁股后面
//! （真机抓到的原文：`I (106) … : segment 3: … sizeOK 9`）。现在不认得 `~` 开头的行一律当外来文本。
//!
//! ## 两个方向的切帧不一样
//!
//! - **主机 → 设备**：只有 `~<id> <正文>` 一种形状（外加传输槽的标签字节），
//!   [`LineScanner`] 只按行交出文本，是不是帧由 [`is_control`] 判。
//! - **设备 → 主机**：`~<id> OK <n>` 之后跟 n 行**不带哨兵**的正文，最后一行才是
//!   `~<id> END`。正文不带哨兵是有意的：那些行本来就要给人看，套上哨兵只会更难读。
//!   [`ReplyReader`] 描述这一层。

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::SENTINEL;

/// 一行控制帧最多多少个字符；超了整行丢掉（正常情况下协议行都很短）
pub const LINE_LIMIT: usize = 128;

/// 正文（去掉 `~<id> ` 外壳）能解析出的东西：**只有 RPC 骨架那四种**
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    /// `OK`：请求成功，没有附加数据
    Ok,
    /// `OK <n>`：请求成功并且带 n 行正文（正文 + `END` 由后续行给出）
    OkLines { count: u32 },
    /// `END`：`OK <n>` 的正文结束
    End,
    /// `ERR <原因>`
    Error { message: String },
    /// 别的正文：原样带着，由调用方分类（产品的词表在调用方那一层）
    Unknown { body: String },
}

/// 解析出来的一条控制帧：消息 ID + 正文
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    /// 请求编号；协议规定 `0` **保留给"不是应答的帧"**（设备主动推送），
    /// 应答永远带它对应请求的号。
    pub id: u32,
    pub reply: Reply,
}

/// 拼一条控制帧：`~<id> <body>`（**不带换行** —— 换行是"成帧"的事，由写的一侧加）
fn line(id: u32, body: &str) -> String {
    format!("{}{id} {body}", SENTINEL as char)
}

/// 拼**任意**一条控制帧：`~<id> <正文>`（请求和应答都是这个形状）。
///
/// 唯一的编码入口：正文是什么词由调用方定，本 crate 不解释。
pub fn encode_frame(id: u32, body: &str) -> String {
    line(id, body)
}

/// 设备 → 主机：`OK`
pub fn encode_ok(id: u32) -> String {
    line(id, "OK")
}

/// 设备 → 主机：`OK <n>`（后面跟 n 行正文，最后 `END`）
pub fn encode_ok_lines(id: u32, count: usize) -> String {
    line(id, &format!("OK {count}"))
}

/// 设备 → 主机：`END`
pub fn encode_end(id: u32) -> String {
    line(id, "END")
}

/// 设备 → 主机：`ERR <原因>`
pub fn encode_err(id: u32, message: &str) -> String {
    line(id, &format!("ERR {message}"))
}

/// 解析一行控制帧（不含行尾换行）。不是 `~` 开头返回 `None`（那是外来文本或正文行）。
pub fn parse_control_line(line: &str) -> Option<Message> {
    let rest = line.strip_prefix(SENTINEL as char)?;
    let (raw_id, body) = rest.split_once(' ')?;
    if raw_id.is_empty() || !raw_id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // 空正文（`~1 `）不是帧：请求要有命令名，应答要有结论
    if body.is_empty() {
        return None;
    }
    let id = raw_id.parse::<u32>().ok()?;
    Some(Message {
        id,
        reply: parse_body(body),
    })
}

fn parse_body(body: &str) -> Reply {
    match body {
        "OK" => return Reply::Ok,
        "END" => return Reply::End,
        _ => {}
    }
    if let Some(count) = body.strip_prefix("OK ") {
        return match count.parse::<u32>() {
            Ok(count) => Reply::OkLines { count },
            Err(_) => Reply::Unknown {
                body: String::from(body),
            },
        };
    }
    if let Some(message) = body.strip_prefix("ERR ") {
        return Reply::Error {
            message: String::from(message),
        };
    }
    Reply::Unknown {
        body: String::from(body),
    }
}

/// 一个字节在**主机 → 设备**方向上的角色（只看首字节）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByteClass {
    /// 控制帧的开始
    Control,
    /// 块 ACK 的开始
    Ack,
    /// 别的字节：只有在"收载荷"状态下才有意义
    Other,
}

/// 首字节分类
///
/// 为什么首字节就够：控制帧以 `~` 开头、块 ACK 以 `0x06` 开头，而**载荷只在标签字节
/// 之后按固定长度收** —— 所以"现在在收载荷"由状态机决定，绝不由字节内容决定。
/// 载荷里出现 `~` 或 `0x06` 完全不影响判断（真实文件里这两种字节必然会撞上）。
pub fn classify(byte: u8) -> ByteClass {
    if byte == SENTINEL {
        ByteClass::Control
    } else if byte == crate::CHUNK_ACK[0] {
        ByteClass::Ack
    } else {
        ByteClass::Other
    }
}

/// 一行行扫描器：凑出**任何一行**可打印文本就交回（不含换行）。
///
/// 它是"字节 → 行"这一层的**唯一实现**，两个方向共用，分类交给调用方：
/// [`is_control`] 认得出控制帧，剩下的就是引导日志或正文行。
///
/// 规则：
/// - 不可打印字节 → 丢掉当前半行（那是同一根线上日志帧的碎片）；
/// - 超长行 → 整行丢掉，继续扫下一行；
/// - **不清行缓冲去凑下一行**：跨两次读取到达的半条命令要能接着拼
///   （踩过：忙的时候只读到半条命令，自清缓冲之后剩下的碎片被拼成一条不认识的
///   命令，主机收到一条莫名的 `ERR`）。
#[derive(Default)]
pub struct LineScanner {
    line: Vec<u8>,
    /// 当前这一行已经超长：整行丢掉，一直读到换行才恢复
    overflow: bool,
    /// 丢掉过多少行/半行（外来文本 + 超长 + 被日志碎片打断的半行）
    dropped: u32,
}

impl LineScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂一个字节；凑出一整行就交回
    pub fn feed(&mut self, byte: u8) -> Option<String> {
        match byte {
            b'\n' => {
                if core::mem::take(&mut self.overflow) {
                    // 超长行：整行作废，换行正好是它的终点
                    self.line.clear();
                    return None;
                }
                if self.line.is_empty() {
                    return None;
                }
                let raw = String::from_utf8_lossy(&self.line).to_string();
                self.line.clear();
                if !raw.starts_with(SENTINEL as char) {
                    self.dropped += 1;
                }
                Some(raw)
            }
            // **在行中间看到哨兵**：手边攒的这段不是控制帧（否则不会在正文里再冒出一个
            // `~`），把它当"一行外来文本"先交出去，再从这一个字节起重新攒一行。
            //
            // 钉的是真实链路的形状：外来日志的**最后一行不带换行**，控制帧直接接在
            // 它屁股后面 —— `…size~1 OK 9`。按哨兵切，规则是确定的，不必从行尾抠回执。
            b'~' if !self.line.is_empty() && self.line[0] != SENTINEL => {
                let raw = String::from_utf8_lossy(&self.line).to_string();
                self.line.clear();
                self.dropped += 1;
                self.line.push(byte);
                Some(raw)
            }
            b'\r' => None,
            b if b.is_ascii_graphic() || b == b' ' => {
                if self.line.len() >= LINE_LIMIT {
                    // 一行超长：整行丢掉，读到换行为止（继续攒会把下一行也拼坏）
                    self.line.clear();
                    self.overflow = true;
                    self.dropped += 1;
                    return None;
                }
                self.line.push(byte);
                None
            }
            _ => {
                // 不可打印字节：多半是日志帧的碎片，丢掉当前半行
                if !self.line.is_empty() {
                    self.line.clear();
                    self.dropped += 1;
                }
                None
            }
        }
    }

    /// 这行是不是控制帧（以哨兵开头）
    pub fn is_control(line: &str) -> bool {
        line.starts_with(SENTINEL as char)
    }

    /// 丢掉过多少非控制行 / 半行
    pub fn dropped(&self) -> u32 {
        self.dropped
    }

    /// 攒了一半的行（测试用：确认"跨两次读取的半条命令"确实留在缓冲里）
    pub fn pending(&self) -> &[u8] {
        &self.line
    }

    pub fn reset(&mut self) {
        self.line.clear();
        self.overflow = false;
    }
}

/// 这行是不是控制帧
pub fn is_control(line: &str) -> bool {
    line.starts_with(SENTINEL as char)
}

/// **主机侧**的应答装配器：一整行 → 应答状态机推进一步。
///
/// 它**只吃整行**（字节 → 行是 [`LineScanner`] 的事），所以和调用方"整行进、结论出"
/// 的读法一一对应。跨语言的期望表也由生成器按"行序列 → 结论序列"跑出来，另一门
/// 语言拿同一张表测自己那份实现。
///
/// 骨架里 `~id OK` / `~id ERR …` 一条就结束；`~id OK <n>`（n>0）之后跟 n 行
/// **不带哨兵**的正文，再一行 `~id END`。
///
/// 其余正文（`~0 …` 这种非应答帧、以及调用方自己的词）都算"不需要正文的一条"，
/// 直接 [`ReplyStep::Done`] 交付，内容由调用方解释。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplyStep {
    /// 这一行不该出现在这里（没在等它）：调用方丢掉并记一笔
    Ignored(String),
    /// 收到一条不需要正文的帧（`OK` / `ERR …` / 任意非应答正文）
    Done(Message),
    /// `OK <n>`：接下来还要读 n 行正文
    Body { message: Message, remaining: u32 },
    /// 正文收齐并见到 `~id END`：一条完整应答
    Complete {
        message: Message,
        lines: Vec<String>,
    },
    /// 应答读崩（`END` 的号对不上 / 解析不出控制帧）：原样带出那一行
    Broken(String),
}

#[derive(Debug, Default)]
pub struct ReplyReader {
    /// 正在等正文的那条应答的头
    head: Option<Message>,
    remaining: u32,
    lines: Vec<String>,
}

impl ReplyReader {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂**一行**（不含换行）。控制行走状态机，普通行按"正文行"记账。
    pub fn feed_line(&mut self, line: &str) -> ReplyStep {
        if is_control(line) {
            let Some(message) = parse_control_line(line) else {
                self.abort();
                return ReplyStep::Broken(String::from(line));
            };
            return self.control(message, line);
        }
        // 正文行：只有在等正文时才有意义
        let Some(head) = self.head.clone() else {
            return ReplyStep::Ignored(String::from(line));
        };
        // 正文已经数满了：多出来的这一行不再记账（等 END 来收尾，或由 END 之后的
        // `Ignored` 分支处理），否则 `remaining` 会被减法下溢拦掉。
        if self.remaining == 0 {
            return ReplyStep::Ignored(String::from(line));
        }
        self.lines.push(String::from(line));
        self.remaining -= 1;
        ReplyStep::Body {
            message: head,
            remaining: self.remaining,
        }
    }

    fn control(&mut self, message: Message, raw: &str) -> ReplyStep {
        // 正在等正文：这一行只可能是 `~id END`
        if let Some(head) = self.head.clone() {
            if message.id == head.id && message.reply == Reply::End {
                let lines = core::mem::take(&mut self.lines);
                self.head = None;
                self.remaining = 0;
                return ReplyStep::Complete {
                    message: head,
                    lines,
                };
            }
            self.abort();
            return ReplyStep::Broken(String::from(raw));
        }
        // 先把计数取出来，避免"借用 message.reply 的同时把 message 搬走"
        let count = match message.reply {
            Reply::OkLines { count } => count,
            _ => 0,
        };
        if count > 0 {
            self.head = Some(message.clone());
            self.remaining = count;
            self.lines.clear();
            return ReplyStep::Body {
                message,
                remaining: count,
            };
        }
        ReplyStep::Done(message)
    }

    /// 丢掉一条读到一半的应答（超时/断线时用）
    fn abort(&mut self) {
        self.head = None;
        self.remaining = 0;
        self.lines.clear();
    }

    /// 还差几行正文
    pub fn remaining(&self) -> u32 {
        self.remaining
    }

    /// 是不是在等正文
    pub fn awaiting_body(&self) -> bool {
        self.head.is_some()
    }

    /// 正在等的应答编号（用来丢弃"别条请求的迟到回执"）
    pub fn awaiting_id(&self) -> Option<u32> {
        self.head.as_ref().map(|message| message.id)
    }

    pub fn reset(&mut self) {
        self.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_frames_round_trip() {
        assert_eq!(
            parse_control_line(&encode_frame(3, "queue/pull")),
            Some(Message {
                id: 3,
                reply: Reply::Unknown {
                    body: String::from("queue/pull")
                }
            })
        );
        assert_eq!(
            parse_control_line(&encode_ok(7)),
            Some(Message {
                id: 7,
                reply: Reply::Ok
            })
        );
        assert_eq!(
            parse_control_line(&encode_ok_lines(7, 9)),
            Some(Message {
                id: 7,
                reply: Reply::OkLines { count: 9 }
            })
        );
        assert_eq!(
            parse_control_line(&encode_end(7)),
            Some(Message {
                id: 7,
                reply: Reply::End
            })
        );
        assert_eq!(
            parse_control_line(&encode_err(7, "busy")),
            Some(Message {
                id: 7,
                reply: Reply::Error {
                    message: String::from("busy")
                }
            })
        );
        // 骨架之外的词：只把正文原样带着，含义归调用方
        assert_eq!(
            parse_control_line(&encode_frame(1, "GO")),
            Some(Message {
                id: 1,
                reply: Reply::Unknown {
                    body: String::from("GO")
                }
            })
        );
        assert_eq!(
            parse_control_line(&encode_frame(0, "note tick 3")),
            Some(Message {
                id: 0,
                reply: Reply::Unknown {
                    body: String::from("note tick 3")
                }
            })
        );
    }

    #[test]
    fn only_sentinel_lines_are_frames() {
        // 裸回执（v8 的形状）、粘行、缺 id、id 不是数字 —— 全部不当协议
        assert_eq!(parse_control_line("OK 9"), None);
        assert_eq!(
            parse_control_line("I (106) esp_image: segment 3: sizeOK 9"),
            None
        );
        assert_eq!(parse_control_line("~ OK"), None);
        assert_eq!(parse_control_line("~x1 OK"), None);
        assert_eq!(parse_control_line("~1"), None);
        assert_eq!(parse_control_line("~1 "), None);
    }

    #[test]
    fn bad_numbers_are_unknown_not_panics() {
        assert_eq!(
            parse_control_line("~1 OK abc"),
            Some(Message {
                id: 1,
                reply: Reply::Unknown {
                    body: String::from("OK abc")
                }
            })
        );
        assert_eq!(
            parse_control_line("~1 BLOB -5"),
            Some(Message {
                id: 1,
                reply: Reply::Unknown {
                    body: String::from("BLOB -5")
                }
            })
        );
        assert_eq!(
            parse_control_line("~1 wat"),
            Some(Message {
                id: 1,
                reply: Reply::Unknown {
                    body: String::from("wat")
                }
            })
        );
    }

    #[test]
    fn first_byte_classifies_without_looking_at_payload() {
        assert_eq!(classify(b'~'), ByteClass::Control);
        assert_eq!(classify(0x06), ByteClass::Ack);
        assert_eq!(classify(b'G'), ByteClass::Other);
        assert_eq!(classify(0xff), ByteClass::Other);
    }

    #[test]
    fn scanner_separates_ours_from_boot_logs() {
        let mut scan = LineScanner::new();
        let stream = b"I (50) boot: ## Label\r\nI (106) esp_image: segment 3\r\n~1 OK 9\n";
        let mut controls = Vec::new();
        let mut foreign = Vec::new();
        for &byte in stream {
            if let Some(line) = scan.feed(byte) {
                if is_control(&line) {
                    controls.push(line);
                } else {
                    foreign.push(line);
                }
            }
        }
        assert_eq!(controls, alloc::vec![String::from("~1 OK 9")]);
        assert_eq!(foreign.len(), 2);
        assert_eq!(scan.dropped(), 2);
    }

    #[test]
    fn scanner_survives_log_bytes_splitting_a_line() {
        // 半条命令 + 日志碎片（不可打印）+ 完整的另一条：前者丢掉，不会拼成垃圾命令
        let mut scan = LineScanner::new();
        for &byte in b"~1 que\x00ue/pull\n" {
            scan.feed(byte);
        }
        assert!(scan.pending().is_empty());
        let mut out = Vec::new();
        for &byte in b"~2 queue/pull\n" {
            if let Some(line) = scan.feed(byte) {
                out.push(line);
            }
        }
        assert_eq!(out, alloc::vec![String::from("~2 queue/pull")]);
    }

    #[test]
    fn scanner_overlong_line_is_dropped_whole() {
        let mut scan = LineScanner::new();
        for _ in 0..(LINE_LIMIT + 10) {
            scan.feed(b'a');
        }
        assert_eq!(scan.feed(b'\n'), None);
        assert!(scan.pending().is_empty());
        assert!(scan.dropped() > 0);
        // 换行之后恢复正常：下一条短命令照收
        let mut out = Vec::new();
        for &byte in b"~7 list/all\n" {
            if let Some(line) = scan.feed(byte) {
                out.push(line);
            }
        }
        assert_eq!(out, alloc::vec![String::from("~7 list/all")]);
    }

    #[test]
    fn reply_reader_assembles_body() {
        let mut reader = ReplyReader::new();
        assert_eq!(
            reader.feed_line("~4 OK 2"),
            ReplyStep::Body {
                message: Message {
                    id: 4,
                    reply: Reply::OkLines { count: 2 }
                },
                remaining: 2
            }
        );
        assert!(reader.awaiting_body());
        assert_eq!(reader.awaiting_id(), Some(4));
        reader.feed_line("name alpha");
        assert_eq!(reader.remaining(), 1);
        reader.feed_line("state 3");
        assert_eq!(
            reader.feed_line("~4 END"),
            ReplyStep::Complete {
                message: Message {
                    id: 4,
                    reply: Reply::OkLines { count: 2 }
                },
                lines: alloc::vec![String::from("name alpha"), String::from("state 3")]
            }
        );
        assert!(!reader.awaiting_body());
    }

    /// 等正文时来了一行别的控制帧：整条应答作废（不能让正文把别条的 END 吃回去）
    #[test]
    fn reply_reader_breaks_on_foreign_control_line() {
        let mut reader = ReplyReader::new();
        reader.feed_line("~5 OK 1");
        assert!(matches!(reader.feed_line("~6 OK"), ReplyStep::Broken(_)));
        assert!(!reader.awaiting_body());
    }

    /// 没在等正文时来的普通行：忽略，不进状态
    #[test]
    fn reply_reader_ignores_stray_body_lines() {
        let mut reader = ReplyReader::new();
        assert!(matches!(
            reader.feed_line("I (24) boot: noise"),
            ReplyStep::Ignored(_)
        ));
        assert!(!reader.awaiting_body());
    }

    #[test]
    fn reply_reader_passes_non_reply_frames_through() {
        // id = 0 的"不是应答的帧"：只交付，不解释正文
        let mut reader = ReplyReader::new();
        assert_eq!(
            reader.feed_line("~0 note tick 3"),
            ReplyStep::Done(Message {
                id: 0,
                reply: Reply::Unknown {
                    body: String::from("note tick 3")
                }
            })
        );
    }

    #[test]
    fn reply_reader_zero_lines_needs_no_end() {
        let mut reader = ReplyReader::new();
        assert_eq!(
            reader.feed_line("~9 OK 0"),
            ReplyStep::Done(Message {
                id: 9,
                reply: Reply::OkLines { count: 0 }
            })
        );
    }

    /// 迟到的正文行（多一行）：忽略而不是污染下一条应答
    #[test]
    fn reply_reader_extra_body_line_is_ignored() {
        let mut reader = ReplyReader::new();
        reader.feed_line("~3 OK 1");
        reader.feed_line("alpha ok");
        reader.feed_line("~3 END");
        assert!(matches!(reader.feed_line("late"), ReplyStep::Ignored(_)));
    }
}
