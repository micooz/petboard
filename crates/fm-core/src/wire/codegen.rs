//! 生成**网页侧**要用的东西：常量文件 + 跨语言一致性 fixture。
//!
//! 为什么靠生成而不是手抄：同一条约定写在两个语言里，就一定会有某一天只改一处（本项目
//! 踩过"设备宣告 512、发送端写死 32"）。现在常量由这里**导出**，帧的切分由 [`fixtures`]
//! **跑自真实实现**：fixture 里的期望值不是人写的，是 Rust 自己答出来的，网页照同一张卷
//! 判卷。
//!
//! 分工照分层来：**通用线路机制**在 `crates/serial`（成帧、标签槽、ACK、扫描器），
//! **本产品的词与命令**在这里（[`super::command`] / [`super::vocab`]）。所以生成器必须在业务
//! 这一侧，`serial` 那边不认识 `READY` / `DATA` / `ev`。
//!
//! 只有 `gen` feature 才编译（固件不依赖它）。这里只拼字符串，写文件的是
//! `src/bin/wiregen.rs`，所以 `no_std` 不破。

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use serial::frame::{
    self, LineScanner, Message, Reply, ReplyReader, ReplyStep, is_control, parse_control_line,
};
use serial::wire as line;
use serial::{CHUNK_ACK, CHUNK_ACK_COUNT_LEN, SENTINEL, TAG_CTRL, TAG_DATA};

use super::Command;
use super::vocab::{self, events};
use super::{API_VERSION, GET_CHUNK_C6, LOOPS_INFINITE};

/// 生成 `web/src/lib/serial/wire.ts` 的全文（顶部写明"生成物、禁止手改"）
pub fn ts_module() -> String {
    let ack = CHUNK_ACK
        .iter()
        .map(|byte| format!("{byte}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sentinel = SENTINEL as char;
    format!(
        "/*\n \
         * 自动生成，**禁止手改**。\n \
         *\n \
         * 来源：`crates/fm-core/src/wire/`（本产品的报文层）＋ `crates/serial`（通用线路层）。\n \
         * 重新生成：`pnpm wire`，产物随仓库跟踪。改了 Rust 忘了重生成时，\n \
         * `crates/fm-core/tests/wire_contract.rs` 会逐个常量比对这一份并让 CI 变红。\n \
         *\n \
         * 这一份只统一**常量**；帧的切分语义另有一份 fixture\n \
         * （`crates/fm-core/tests/fixtures/frames.jsonl`），由 Rust 的真实实现跑出来，\n \
         * 网页照同一张表测自己那份（`web/tests/lib/serial/wire-fixtures.test.ts`）。\n \
         */\n\n\
         /// 协议版本：和固件对不上就提示\"检测到旧固件，请重新烧录\"。\n\
         export const API_VERSION = {API_VERSION};\n\n\
         /// 控制帧的哨兵：协议里每一行控制帧都以它开头，不以此开头的行一律当外来文本。\n\
         export const SENTINEL = '{sentinel}';\n\n\
         /// **上传**方向（网页 → 板子）一块的字节数：必须和固件一致。\n\
         export const CHUNK_UP = {chunk_up};\n\n\
         /// 回传块大小的**兜底值**（旧固件没报 `chunk` 行时用）。\n\
         /// 真正的值由固件在 `device/info` 的 `chunk` 行里报（C6 = 32、S3 = 512）。\n\
         export const GET_CHUNK_FALLBACK = {get_chunk_c6};\n\n\
         /// 传输槽的标签：后面跟 `min(CHUNK_UP, 剩余)` 个裸载荷字节。\n\
         export const TAG_DATA = {tag_data};\n\n\
         /// 传输槽的标签：后面跟一行 ASCII 控制帧（以 `\\n` 结尾）。\n\
         export const TAG_CTRL = {tag_ctrl};\n\n\
         /// 块 ACK 的前缀；`media/get` 方向后面再跟**实收字节数**（u16 小端）。\n\
         export const CHUNK_ACK = new Uint8Array([{ack}]);\n\n\
         /// `CHUNK_ACK` 之后跟的实收字节数长度（u16 小端）。\n\
         export const CHUNK_ACK_COUNT_LEN = {ack_count_len};\n\n\
         /// 一行控制帧最多多少个字符（超了整行丢掉）。\n\
         export const MAX_LINE = {max_line};\n\n\
         /// 播放次数里的 `0`：一直播到被 `media/stop` 打断。\n\
         export const LOOPS_INFINITE = {loops_infinite};\n\n\
         /// 设备主动推的事件名（`~0 ev <名> <字段…>`）。\n\
         export const EVENTS = {{\n  \
           play: '{play}',\n  \
           stop: '{stop}',\n  \
           item: '{item}',\n  \
           loop: '{loop}',\n  \
           frame: '{frame}',\n  \
           error: '{error}',\n\
         }} as const;\n\n\
         /// 事件名的联合类型。\n\
         export type EventName = (typeof EVENTS)[keyof typeof EVENTS];\n",
        chunk_up = line::CHUNK_UP,
        get_chunk_c6 = GET_CHUNK_C6,
        tag_data = TAG_DATA,
        tag_ctrl = TAG_CTRL,
        ack_count_len = CHUNK_ACK_COUNT_LEN,
        max_line = line::MAX_LINE,
        loops_infinite = LOOPS_INFINITE,
        play = events::PLAY,
        stop = events::STOP,
        item = events::ITEM,
        loop = events::LOOP,
        frame = events::FRAME,
        error = events::ERROR,
    )
}

/// 字节数组 → JSON
fn json_bytes(bytes: &[u8]) -> String {
    format!(
        "[{}]",
        bytes
            .iter()
            .map(|byte| format!("{byte}"))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// 字符串 → JSON（fixture 里的行文本走这一层）
fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// [`Reply`] → JSON：骨架那四种照协议，其余正文**再过一遍业务词表**
///
/// 协议 crate 只认 `OK` / `OK n` / `END` / `ERR`；`READY` / `DATA n` / `ev …` 落在
/// [`Reply::Unknown`] 里，由 [`vocab::parse_body`] 解释成业务结论。fixture 钉的是**网页
/// 要判的完整答案**，所以这里必须把两层合起来答。
fn json_reply(reply: &Reply) -> String {
    match reply {
        Reply::Ok => String::from(r#"{"t":"ok"}"#),
        Reply::OkLines { count } => format!(r#"{{"t":"okLines","count":{count}}}"#),
        Reply::End => String::from(r#"{"t":"end"}"#),
        Reply::Error { message } => {
            format!(r#"{{"t":"error","message":{}}}"#, json_string(message))
        }
        Reply::Unknown { body } => match vocab::parse_body(body) {
            vocab::Body::Ready => String::from(r#"{"t":"ready"}"#),
            vocab::Body::Data { len } => format!(r#"{{"t":"data","len":{len}}}"#),
            vocab::Body::Event { name, args } => format!(
                r#"{{"t":"event","name":{},"args":{}}}"#,
                json_string(&name),
                json_string(&args)
            ),
            vocab::Body::Other(_) => {
                format!(r#"{{"t":"unknown","body":{}}}"#, json_string(body))
            }
        },
    }
}

/// [`Command`] → JSON（fixture 钉"一行正文解析成什么命令"）
fn json_command(command: &Command) -> String {
    match command {
        Command::DeviceInfo => String::from(r#"{"t":"info"}"#),
        Command::MediaList => String::from(r#"{"t":"list"}"#),
        Command::MediaAdd { name, len } => {
            format!(r#"{{"t":"add","name":{},"len":{len}}}"#, json_string(name))
        }
        Command::MediaGet { name, offset, len } => format!(
            r#"{{"t":"get","name":{},"offset":{offset},"len":{}}}"#,
            json_string(name),
            match len {
                Some(len) => len.to_string(),
                None => String::from("null"),
            }
        ),
        Command::MediaDelete { name } => {
            format!(r#"{{"t":"delete","name":{}}}"#, json_string(name))
        }
        Command::MediaPlay { start } => format!(
            r#"{{"t":"play","start":{}}}"#,
            match start {
                Some(name) => json_string(name),
                None => String::from("null"),
            }
        ),
        Command::MediaStop => String::from(r#"{"t":"stop"}"#),
        Command::MediaAbort { id } => format!(r#"{{"t":"abort","id":{id}}}"#),
        Command::MediaBench { name, mib } => format!(
            r#"{{"t":"bench","name":{},"mib":{}}}"#,
            json_string(name),
            match mib {
                Some(mib) => mib.to_string(),
                None => String::from("null"),
            }
        ),
        Command::Unknown(text) => {
            format!(r#"{{"t":"unknown","text":{}}}"#, json_string(text))
        }
        Command::BadUsage(reason) => {
            format!(r#"{{"t":"badUsage","reason":{}}}"#, json_string(reason))
        }
    }
}

fn json_message(message: &Message) -> String {
    format!(
        r#"{{"id":{},"reply":{}}}"#,
        message.id,
        json_reply(&message.reply)
    )
}

/// 一个"字节流 → 行序列"场景：喂 [`LineScanner`]，把切出来的每一行与是否控制帧记下来。
///
/// 这是跨语言卷的核心题型：引导日志、defmt 碎片、`\r\n`、超长行、跨两次读取的半条命令
/// —— 网页的 `transport.ts` 必须切出**完全一样**的行序列。
fn scan_case(name: &str, bytes: &[u8]) -> String {
    let mut scan = LineScanner::new();
    let mut lines: Vec<String> = Vec::new();
    let mut control: Vec<&str> = Vec::new();
    for &byte in bytes {
        if let Some(line) = scan.feed(byte) {
            control.push(if is_control(&line) { "true" } else { "false" });
            lines.push(json_string(&line));
        }
    }
    format!(
        r#"{{"kind":"scan","name":{},"bytes":{},"lines":[{}],"control":[{}],"dropped":{}}}"#,
        json_string(name),
        json_bytes(bytes),
        lines.join(","),
        control.join(","),
        scan.dropped()
    )
}

/// 一个"编码形状"场景：网页要能按同样的形状发请求、板子要能按它拼应答
fn encode_case(label: &str, text: &str) -> String {
    format!(
        r#"{{"kind":"encode","label":{},"wire":{}}}"#,
        json_string(label),
        json_string(text)
    )
}

/// "一行 → (id, 正文)"场景（不是控制帧的期望 `null`）
fn parse_case(line: &str) -> String {
    let expect = match parse_control_line(line) {
        Some(message) => json_message(&message),
        None => String::from("null"),
    };
    format!(
        r#"{{"kind":"parse","line":{},"expect":{}}}"#,
        json_string(line),
        expect
    )
}

/// "命令正文 → 命令"场景
fn command_case(text: &str) -> String {
    format!(
        r#"{{"kind":"command","text":{},"command":{}}}"#,
        json_string(text),
        json_command(&super::parse_command(text))
    )
}

/// "一行一行装配应答"场景：把 [`ReplyReader`] 每步结论记下来
fn reply_case(name: &str, lines: &[&str]) -> String {
    let mut reader = ReplyReader::new();
    let mut steps: Vec<String> = Vec::new();
    for line in lines {
        let step = match reader.feed_line(line) {
            ReplyStep::Ignored(text) => {
                format!(r#"{{"t":"ignored","line":{}}}"#, json_string(&text))
            }
            ReplyStep::Done(message) => {
                format!(r#"{{"t":"done","message":{}}}"#, json_message(&message))
            }
            ReplyStep::Body { message, remaining } => format!(
                r#"{{"t":"body","message":{},"remaining":{remaining}}}"#,
                json_message(&message)
            ),
            ReplyStep::Complete { message, lines } => format!(
                r#"{{"t":"complete","message":{},"lines":[{}]}}"#,
                json_message(&message),
                lines
                    .iter()
                    .map(|line| json_string(line))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            ReplyStep::Broken(text) => {
                format!(r#"{{"t":"broken","line":{}}}"#, json_string(&text))
            }
        };
        steps.push(step);
    }
    format!(
        r#"{{"kind":"reply","name":{},"lines":[{}],"steps":[{}]}}"#,
        json_string(name),
        lines
            .iter()
            .map(|line| json_string(line))
            .collect::<Vec<_>>()
            .join(","),
        steps.join(",")
    )
}

/// 生成跨语言 fixture（JSONL，每行一个场景）
pub fn fixtures() -> String {
    // 一次给出容量：这些场景是固定表，不该边 push 边扩容
    let mut out: Vec<String> = Vec::with_capacity(64);

    // ---- 字节 → 行
    out.push(scan_case("干净的一条请求", b"~1 device/info\n"));
    out.push(scan_case(
        "引导日志夹在中间（真机开口的样子）",
        b"I (50) boot: ## Label  NG\nI (106) esp_image: segment 3: paddr=0 size\n~1 OK 9\n",
    ));
    out.push(scan_case(
        "boot 日志最后一行不带换行，和回执粘成一行",
        b"I (106) esp_image: segment 3: paddr=0001bb6c vaddr=00000000 size~1 OK 9\n",
    ));
    out.push(scan_case("CRLF", b"~2 media/list\r\n~2 OK 0\r\n"));
    out.push(scan_case(
        "defmt 碎片（不可打印字节）打断半条命令",
        b"~3 med\x00ia/list\n~4 device/info\n",
    ));
    out.push(scan_case(
        "一条命令跨两次读取到达：半行必须留着",
        b"~5 media/stop\n~6 media",
    ));
    out.push(scan_case(
        "正文行不带哨兵（device/info 的那些行）",
        b"~7 OK 3\nid aa:bb:cc:dd:ee:ff\napi 1\n~7 END\n",
    ));
    out.push(scan_case("空行与连续换行", b"\n\n~8 OK\n"));
    {
        let mut bytes: Vec<u8> = b"~9 ".to_vec();
        bytes.resize(line::MAX_LINE + 43, b'x');
        bytes.push(b'\n');
        bytes.extend_from_slice(b"~10 OK\n");
        out.push(scan_case("超长行整行丢掉，后面的一条照收", &bytes));
    }
    out.push(scan_case(
        "载荷残字节污染行缓冲",
        &[
            b'~', b'1', b' ', b'O', b'K', 0x06, 0x09, b'\n', b'~', b'2', b' ', b'O', b'K', b'\n',
        ],
    ));

    // ---- 编码形状（请求走协议，`READY` / `DATA` / `ev` 走业务词表）
    out.push(encode_case(
        "request",
        &frame::encode_frame(1, "device/info"),
    ));
    out.push(encode_case("ok", &frame::encode_ok(12)));
    out.push(encode_case("okLines", &frame::encode_ok_lines(12, 3)));
    out.push(encode_case("end", &frame::encode_end(12)));
    out.push(encode_case("err", &frame::encode_err(12, "busy")));
    out.push(encode_case("ready", &frame::encode_frame(4, vocab::READY)));
    out.push(encode_case(
        "data",
        &frame::encode_frame(4, &vocab::data(16384)),
    ));
    out.push(encode_case(
        "event-frame",
        &vocab::event_frame(events::FRAME, "12 28"),
    ));
    out.push(encode_case(
        "event-play",
        &vocab::event_frame(events::PLAY, ""),
    ));

    // ---- 一行 → (id, 正文)
    for line in [
        "~1 device/info",
        "~1 OK",
        "~1 OK 9",
        "~1 OK 0",
        "~1 END",
        "~1 ERR cannot open file",
        "~1 READY",
        "~1 DATA 16384",
        "~0 ev frame 12 28",
        "~0 ev error sd write failed",
        "~0 ev play",
        // 以下都**不是**协议
        "OK 9",
        "I (106) esp_image: sizeOK 9",
        "~OK",
        "~x1 OK",
        "~1",
        "~1 ",
        "~1 OK abc",
        "~1 DATA -5",
        "~4294967296 OK",
        // 前导 `+`：Rust 的整数解析接受（标准库行为），镜像实现也要同答案
        "~1 OK +5",
        "~1 DATA +16",
        "~+1 OK",
    ] {
        out.push(parse_case(line));
    }

    // ---- 命令正文 → 命令（网页就是发这些字符串）
    for text in [
        "device/info",
        "media/list",
        "media/add A1B2C3D4.ANM 535000",
        "media/get A1B2C3D4.ANM",
        "media/get A1B2C3D4.ANM 0 65536",
        "media/get A1B2C3D4.ANM 4096 18",
        "media/delete A1B2C3D4.ANM",
        "media/play",
        "media/play BBBB2222.ANM",
        "media/stop",
        "media/abort 7",
        "media/bench BIGFILE.BIN 2",
        "media/bench BIGFILE.BIN",
        "device/info extra",
        "media/add",
        "media/add A 0",
        "media/add A -1",
        "media/get",
        "media/get A x 10",
        "media/abort",
        "media/abort 0",
        "media/abort abc",
        "media/add A +5",
        "media/get A +1 +2",
        "media/abort +7",
        "media/bench A +0",
        "wat/ever",
    ] {
        out.push(command_case(text));
    }

    // ---- 应答装配
    out.push(reply_case("单行 OK", &["~1 OK"]));
    out.push(reply_case(
        "带正文：OK 2 + 两行 + END",
        &["~4 OK 2", "id aa:bb", "api 1", "~4 END"],
    ));
    out.push(reply_case("零行不需要 END", &["~9 OK 0"]));
    out.push(reply_case(
        "等正文时来了别的控制帧：整条作废",
        &["~5 OK 1", "~6 OK"],
    ));
    out.push(reply_case(
        "END 的号对不上：作废",
        &["~5 OK 1", "sd ok", "~6 END"],
    ));
    out.push(reply_case(
        "正文多一行：迟到的那行忽略",
        &["~3 OK 1", "sd ok", "~3 END", "late"],
    ));
    out.push(reply_case(
        "没在等正文时的普通行：忽略",
        &["I (24) boot: noise"],
    ));
    out.push(reply_case("事件直接交付", &["~0 ev frame 12 28"]));
    out.push(reply_case("ERR 一条就完", &["~2 ERR busy"]));

    let mut text = String::from(
        "# 自动生成，禁止手改：`cargo run --features gen --bin wiregen -- fixtures`。\n",
    );
    for case in out {
        text.push_str(&case);
        text.push('\n');
    }
    text
}
