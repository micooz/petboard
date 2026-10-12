//! 串口上的**收发状态机**：协议 crate 拥有的正是"报文怎么进出"这一层。
//!
//! 三条设计约束，都是真机踩出来的，别凭感觉改：
//!
//! 1. **同步 + 注入时钟**。这里不 `await`、不依赖任何异步运行时；超时问
//!    [`crate::Serial::now_us`]。于是 host 上能穷举所有超时分支，异步的调用方在
//!    "没字节可读"时让出执行器再回来。
//! 2. **大块缓冲归调用方**。[`Wire`] 只持有行缓冲（≤ [`MAX_LINE`]）和几个字节的状态；
//!    [`CHUNK_UP`] 字节的载荷缓冲由调用方从 `.bss`/PSRAM 拿 —— 别让状态机替性能敏感的
//!    路径要堆。
//! 3. **TX 节流是协议语义**。USB-Serial-JTAG 的 TX FIFO 只有 64 字节，而且**只有被
//!    flush 过才会把数据交给主机**，所以 [`Wire::write_raw`] 必须"满即 flush、重试同一个
//!    字节、收尾 flush 带预算"。少任何一条，某一天就会变成"设备说发了、主机说没收到"。

use alloc::string::String;

use crate::events::Events;
use crate::frame::{
    self, classify, is_control, parse_control_line, ByteClass, LineScanner, Message, Reply,
};
use crate::{Serial, CHUNK_ACK, CHUNK_ACK_COUNT_LEN, TAG_CTRL, TAG_DATA};

/// 主机 → 设备方向一块载荷的字节数：发送方必须按这个大小分块
pub const CHUNK_UP: usize = 1024;
/// 一行控制帧最多多少个字符
pub const MAX_LINE: usize = frame::LINE_LIMIT;

/// 主机 → 设备：等标签字节 / 一块载荷，超过这么久没有新字节就判超时
const RX_TIMEOUT_US: u64 = 2_000_000;
/// 设备 → 主机：等主机回块 ACK，超过这么久就判超时
const ACK_TIMEOUT_US: u64 = 5_000_000;
/// 写协议字节时，等 TX FIFO 腾出空位最多等这么久（微秒）。
///
/// 按配置波特率，一个 64 字节的 USB 包大约几毫秒；100ms 足够正常情况，又能在真卡住时及时收场。
const TX_WAIT_US: u64 = 100_000;
/// 没字节可读时，异步适配层多久回来轮一次（微秒）
pub const POLL_INTERVAL_US: u64 = 200;
/// 一块载荷最多补发几轮就放弃（丢字节本身靠补发治，这里只兜底）
pub const MAX_CHUNK_RESENDS: u32 = 4;

/// 等主机块 ACK 的结果。
///
/// 三种结局的处理方式完全不同：
/// - `Acked(n)` 且 `n == 发出去的长度`：这一块过了；
/// - `Acked(n)` 且 `n < 发出去的长度`：主机只收到前 `n` 个字节（设备的发送路径丢了尾巴），
///   调用方把缺的补发；
/// - `Aborted`：主机不等了，它发来的控制帧在 [`Wire::take_pending`] 里 —— 立刻停手，
///   别补零、别回 ERR；
/// - `Timeout`：主机一句话没说就没了 —— 要补齐声明的长度再回 ERR（主机可能还在按长度读）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckOutcome {
    /// 主机确认收到的字节数
    Acked(u16),
    /// 主机不等这次传输了，控制帧已收进 [`Wire::take_pending`]
    Aborted,
    /// 等超时了，主机一句话没说就没了
    Timeout,
}

/// 一条请求：消息 ID + **还没解释的正文**
///
/// 本 crate 管到"这一行是谁说的、说了什么"为止。正文是什么命令、要不要打断哪条传输，
/// 都是调用方那一层的业务知识（换一路业务不必动这里）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// 主机给这条请求编的号（`~<id> …`）；应答要原样带回去
    pub id: u32,
    /// 去掉 `~<id> ` 外壳之后的正文原文
    pub body: String,
}

/// [`Wire::poll`] 一次推进之后的结论
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// 这次没读出完整的东西：继续喂字节，或等到 [`Wire::deadline_us`]
    Nothing,
    /// 收到一条完整请求（空闲阶段）
    Request(Request),
    /// 载荷块收满了
    ChunkDone { got: usize },
    /// 等载荷/等 ACK 超时，只到这里为止（载荷阶段带已收到的字节数）
    TimedOut { got: usize },
    /// 传输途中收到控制帧：请求在 [`Wire::take_pending`] 里
    TransferFrame,
    /// 主机的块 ACK 到了
    Ack(AckOutcome),
}

/// 正在收的这一行属于哪种场合（决定收完之后的结论与回哪个阶段）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineMode {
    /// 空闲时读请求：结论是 [`Step::Request`]，读完回到空闲
    Request,
    /// 传输途中（标签是 `TAG_CTRL`）：结论是 [`Step::TransferFrame`]，读完继续等下一槽
    Transfer,
    /// 等块 ACK 时来了控制帧 = 主机不等这次传输：结论是 `Ack(Aborted)`，读完回到空闲
    DuringAck,
}

/// 读状态机处在哪个阶段
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// 空闲：读一整行请求（`~<id> …`），可以永远等下去
    Idle,
    /// 等一个标签字节（`TAG_DATA` / `TAG_CTRL`）
    Tag,
    /// 正在收 `expected` 个裸载荷字节
    Chunk { expected: usize, got: usize },
    /// 正在收一行控制帧（`mode` 决定收完怎么交出去、回到哪个阶段）
    Line { mode: LineMode },
    /// 等主机回块 ACK（`06 09 <u16 小端>`）
    Ack,
}

/// 块 ACK 的总长度：前缀 2 字节 + 实收字节数（u16 小端）
const ACK_LEN: usize = CHUNK_ACK.len() + CHUNK_ACK_COUNT_LEN;

/// 串口连接：负责收发，不管命令具体做什么。
///
/// 底下是哪个外设由调用方决定（见 [`crate::Serial`]）—— 同一颗芯片的
/// USB-Serial-JTAG 在各块板上行为一致，所以这里不必知道芯片。
pub struct Wire<S: Serial> {
    usb: S,
    scan: LineScanner,
    phase: Phase,
    /// 设备主动推的通知待发队列（限速、"同类只留最新"见 [`Events`]）
    events: Events,
    /// 主机在**取**我们写的字节吗。
    ///
    /// 为什么需要它：主机走了以后 USB-Serial-JTAG 的 TX FIFO 会一直满着，而
    /// [`Wire::write_raw`] 每个字节都要烧完 `TX_WAIT_US` 预算才收手 —— 一行二十几个字节
    /// 就是两秒，设备自己的热循环会被自己推的通知拖死。所以通知走"写不出去就立刻收手"
    /// 这条路（[`Wire::write_optional`]）：一旦发现主机没在取就停推，直到下一条**请求**到达
    /// （请求到得了 = 主机又在看）。普通应答不受这个开关影响：那是主机主动问的，必须答。
    host_reading: bool,
    /// 应答要带的消息 ID（收到请求时设进去）
    inflight: Option<u32>,
    /// 传输途中收到的控制帧：等调用方处理（一般是叫停这一趟传输）
    pending: Option<Request>,
    /// 最后一次收到字节的时刻（超时判断用）
    last_rx_us: u64,
    /// 最后一次收到**请求**的时刻（判断主机在不在线）
    last_request_us: u64,
    /// 当前是不是处在"裸载荷区间"（这期间不能打日志）
    payload: bool,
    /// 丢掉的外来字节/行数（排查"命令凭空消失"时的证据）
    noise: u32,
    /// 块 ACK 的收字节进度
    ack_got: usize,
    ack_buf: [u8; ACK_LEN],
    /// 标签为 `TAG_DATA` 时这一槽要收几个字节
    chunk_len: usize,
}

impl<S: Serial> Wire<S> {
    pub fn new(mut usb: S) -> Self {
        let now = usb.now_us();
        Wire {
            usb,
            scan: LineScanner::new(),
            phase: Phase::Idle,
            events: Events::new(),
            // 还没收到过请求：先别推（没人听），第一条请求到了再打开
            host_reading: false,
            inflight: None,
            pending: None,
            last_rx_us: now,
            last_request_us: now,
            payload: false,
            noise: 0,
            ack_got: 0,
            ack_buf: [0u8; ACK_LEN],
            chunk_len: CHUNK_UP,
        }
    }

    /// 交还底层串口（调用方那侧要直接碰外设时用）
    pub fn serial_mut(&mut self) -> &mut S {
        &mut self.usb
    }

    /// 当前时钟（微秒）：状态机内部和命令层共用同一个时间源
    pub fn now_us(&mut self) -> u64 {
        self.usb.now_us()
    }

    // ------------------------------------------------------------ 收

    /// 把 RX 里**已经到的**字节读干，推进状态机。
    ///
    /// `buf` 只在收载荷时用，长度就是这一槽要收的字节数（[`Self::begin_recv_slot`]
    /// 会按 `buf.len()` 记账）。完全不等待：读不到字节就返回 [`Step::Nothing`]，
    /// 什么时候再来由 [`Self::deadline_us`] 告诉调用方。
    pub fn poll(&mut self, buf: &mut [u8]) -> Step {
        let now = self.usb.now_us();
        // 超时先看：避免"字节早就不来了，状态机却还守着上一轮的计数"
        if self.timed_out(now) {
            return self.expire();
        }
        loop {
            match self.usb.read_byte() {
                Ok(byte) => {
                    self.last_rx_us = self.usb.now_us();
                    if let Some(step) = self.feed(byte, buf) {
                        return step;
                    }
                }
                Err(_) => return Step::Nothing,
            }
        }
    }

    /// 当前阶段的超时时刻（微秒）；`None` = 这个阶段可以永远等下去。
    ///
    /// 调用方的异步适配层拿它决定"睡到什么时候再来"。
    pub fn deadline_us(&self) -> Option<u64> {
        let budget = self.timeout_budget()?;
        Some(self.last_rx_us.saturating_add(budget))
    }

    /// 哪些阶段会超时、超时预算多久
    fn timeout_budget(&self) -> Option<u64> {
        match self.phase {
            // 等标签也算：主机发完最后一块就可能直接走人
            Phase::Tag | Phase::Chunk { .. } => Some(RX_TIMEOUT_US),
            Phase::Ack => Some(ACK_TIMEOUT_US),
            Phase::Line { mode } => match mode {
                LineMode::Transfer => Some(RX_TIMEOUT_US),
                // 已经在等 ACK 的场合，沿用 ACK 的窗口（语义上是同一件事）
                LineMode::DuringAck => Some(ACK_TIMEOUT_US),
                // 空闲读请求：没主机时固件不能自己转起来，永远可以等
                LineMode::Request => None,
            },
            Phase::Idle => None,
        }
    }

    fn timed_out(&self, now_us: u64) -> bool {
        match self.timeout_budget() {
            Some(budget) => now_us.saturating_sub(self.last_rx_us) >= budget,
            None => false,
        }
    }

    /// 超时收场：回到空闲，把"已经收到几个字节"如实交出去
    fn expire(&mut self) -> Step {
        let got = match self.phase {
            Phase::Chunk { got, .. } => got,
            _ => 0,
        };
        let ack = matches!(self.phase, Phase::Ack);
        self.phase = Phase::Idle;
        self.ack_got = 0;
        self.scan.reset();
        if ack {
            Step::Ack(AckOutcome::Timeout)
        } else {
            Step::TimedOut { got }
        }
    }

    /// 喂一个字节，返回"这一步有没有读出完整的东西"
    fn feed(&mut self, byte: u8, buf: &mut [u8]) -> Option<Step> {
        match self.phase {
            Phase::Idle => self.line_byte(byte, LineMode::Request),
            Phase::Tag => match byte {
                TAG_DATA => {
                    let expected = self.chunk_len.min(buf.len());
                    self.phase = Phase::Chunk { expected, got: 0 };
                    if expected == 0 {
                        // 这一槽没有要收的字节（长度刚好整除的情况由调用方避免）
                        self.phase = Phase::Idle;
                        return Some(Step::ChunkDone { got: 0 });
                    }
                    None
                }
                TAG_CTRL => {
                    self.scan.reset();
                    self.phase = Phase::Line {
                        mode: LineMode::Transfer,
                    };
                    None
                }
                _ => {
                    // 不是标签：多半是上一轮残字节。丢掉，继续等标签。
                    self.noise += 1;
                    None
                }
            },
            Phase::Chunk { expected, got } => {
                if got < expected && got < buf.len() {
                    buf[got] = byte;
                    let next = got + 1;
                    if next == expected {
                        self.phase = Phase::Idle;
                        return Some(Step::ChunkDone { got: next });
                    }
                    self.phase = Phase::Chunk {
                        expected,
                        got: next,
                    };
                }
                None
            }
            Phase::Line { mode } => self.line_byte(byte, mode),
            Phase::Ack => self.ack_byte(byte),
        }
    }

    /// 收一行控制帧（`~<id> …`）。**攒半行的过程中也待在这个阶段**，所以每个字节都会
    /// 走到这里 —— 旧实现只看了首字节，剩下的 `2 abort 1` 被当噪音丢掉，
    /// 传输途中的插队帧永远读不出来。
    fn line_byte(&mut self, byte: u8, mode: LineMode) -> Option<Step> {
        let line = self.scan.feed(byte)?;
        // 收完一行才换阶段：Transfer 回"等下一槽"，别的回空闲
        self.phase = match mode {
            LineMode::Transfer => Phase::Tag,
            LineMode::Request | LineMode::DuringAck => Phase::Idle,
        };
        if !is_control(&line) {
            // 外来文本（引导日志等）：不当命令，也不影响状态机
            self.noise += 1;
            return None;
        }
        let Some(request) = self.parse_request(&line) else {
            self.noise += 1;
            return None;
        };
        self.last_request_us = self.usb.now_us();
        match mode {
            // 传输途中 / 等 ACK 时来的控制帧：先存着，交给调用方处理
            LineMode::Transfer => {
                self.pending = Some(request);
                Some(Step::TransferFrame)
            }
            LineMode::DuringAck => {
                self.pending = Some(request);
                Some(Step::Ack(AckOutcome::Aborted))
            }
            LineMode::Request => {
                self.inflight = Some(request.id);
                // 请求到得了 = 这条链路双向活着：恢复推事件
                self.host_reading = true;
                Some(Step::Request(request))
            }
        }
    }

    /// 收块 ACK 的字节：`06 09 <实收 u16 小端>`
    ///
    /// 前缀还没对上时，可打印的 `~` **按请求行收**（主机不等这次传输了，直接发
    /// 一行控制帧）—— 当噪音丢掉的话它就凭空消失了，这正是旧实现踩过的坑。
    fn ack_byte(&mut self, byte: u8) -> Option<Step> {
        match classify(byte) {
            ByteClass::Control => {
                // 等 ACK 时来了一行控制帧 = 主机不等这次传输了。
                // **切到收行阶段**再喂首字节：后面每个字节都得继续进扫描器。
                self.ack_got = 0;
                self.scan.reset();
                self.phase = Phase::Line {
                    mode: LineMode::DuringAck,
                };
                self.line_byte(byte, LineMode::DuringAck)
            }
            ByteClass::Ack => {
                // `06` 开头：重新起头计数（半截 ACK 之后再来一个 `06` 说明前一次作废）
                self.ack_buf[0] = byte;
                self.ack_got = 1;
                None
            }
            ByteClass::Other => match self.ack_got {
                0 => {
                    self.noise += 1;
                    None
                }
                // 前缀第二个字节必须对上 `09`；对不上整段重来（可能是载荷残字节）
                1 if byte != CHUNK_ACK[1] => {
                    self.ack_got = 0;
                    self.noise += 1;
                    None
                }
                index => {
                    self.ack_buf[index] = byte;
                    self.ack_got = index + 1;
                    if self.ack_got < ACK_LEN {
                        return None;
                    }
                    self.ack_got = 0;
                    self.phase = Phase::Idle;
                    let count = u16::from_le_bytes([self.ack_buf[2], self.ack_buf[3]]);
                    Some(Step::Ack(AckOutcome::Acked(count)))
                }
            },
        }
    }

    /// 一行控制帧 → 请求（`id = 0` 与应答骨架都不当请求）
    fn parse_request(&self, line: &str) -> Option<Request> {
        let Message { id, reply } = parse_control_line(line)?;
        // `id = 0` 是"不是应答的帧"（设备主动推的那一类），主机不该这样发请求；
        // 应答的形状设备自己也会发，读到就当噪音（链路上设备读不到自己的回声，
        // 但状态机不该依赖这点）
        let body = match reply {
            Reply::Unknown { body } if id != 0 => body,
            _ => return None,
        };
        Some(Request { id, body })
    }

    /// **完全不等待**地看一眼串口：把已经到的字节读干，拼出整帧就返回它。
    ///
    /// 设备忙的时候每轮边界调用一次，用来见缝插针地收命令。
    /// 拼了一半的行留在扫描器里，下一次接着拼（踩过：只到半条命令时自清缓冲，
    /// 剩下的碎片会被拼成一条不认识的命令）。
    pub fn try_request(&mut self) -> Option<Request> {
        if let Some(pending) = self.pending.take() {
            self.inflight = Some(pending.id);
            self.last_request_us = self.usb.now_us();
            return Some(pending);
        }
        let mut scratch = [0u8; 1];
        loop {
            match self.poll(&mut scratch) {
                Step::Request(request) => return Some(request),
                Step::Nothing => return None,
                // 空闲阶段只可能出这两种；真出了别的（残影）就继续清
                _ => continue,
            }
        }
    }

    /// 现在这条请求的编号（应答都要带它）；没收到过请求时是 `0`
    pub fn reply_id(&self) -> u32 {
        self.inflight.unwrap_or(0)
    }

    /// 把应答目标切到另一个编号（一次传输被叫停要同时回两个号）
    pub fn set_reply_id(&mut self, id: u32) {
        self.inflight = Some(id);
    }

    /// 把一条已经解析好的请求放回 pending 槽。
    ///
    /// 只给适配层兜底用：状态机在"等 ACK"阶段不该产出 [`Step::Request`]
    /// （那里的控制帧走 `Ack(Aborted)`），万一上游改了顺序，这条路径也保证
    /// **命令不会被吞掉** —— 旧实现就是在这儿把命令当噪音丢的。
    pub fn push_pending(&mut self, request: Request) {
        self.pending = Some(request);
    }

    /// 传输途中收到的控制帧（一般是叫停这一趟传输），取走它
    pub fn take_pending(&mut self) -> Option<Request> {
        let pending = self.pending.take();
        if let Some(request) = &pending {
            self.last_request_us = self.usb.now_us();
            // 应答目标留给 abort 自己；被中断那条的号由命令层显式切回去
            self.inflight = Some(request.id);
        }
        pending
    }

    /// 主机看着还在线吗：最近 `window_us` 内收到过请求
    pub fn host_active(&mut self, window_us: u64) -> bool {
        self.usb.now_us().saturating_sub(self.last_request_us) <= window_us
    }

    /// 清掉攒了一半的行与传输阶段（重连/复位后回到确定的起点）
    pub fn reset_line(&mut self) {
        self.scan.reset();
        self.phase = Phase::Idle;
        self.pending = None;
        self.ack_got = 0;
        self.payload = false;
    }

    /// 现在是不是处在"裸载荷区间"（这期间不能打日志）
    pub fn payload_open(&self) -> bool {
        self.payload
    }

    /// 开/关"裸载荷区间"：调用方用它把"日志静音"这类副作用和协议状态绑在
    /// **同一个事实**上，而不是两处各记一遍。
    pub fn set_payload(&mut self, open: bool) {
        self.payload = open;
    }

    /// 丢掉的外来字节/行数
    pub fn noise(&self) -> u32 {
        self.noise
    }

    // ------------------------------------------------------------ 传输阶段入口

    /// 准备收一槽数据：先等标签字节，标签是 `TAG_DATA` 时收 `chunk_len` 个裸字节
    pub fn begin_recv_slot(&mut self, chunk_len: usize) {
        self.chunk_len = chunk_len.min(CHUNK_UP);
        self.scan.reset();
        self.ack_got = 0;
        self.last_rx_us = self.usb.now_us();
        self.phase = Phase::Tag;
    }

    /// 准备等主机回块 ACK（每发一块之后）
    pub fn begin_ack(&mut self) {
        self.ack_got = 0;
        self.scan.reset();
        self.last_rx_us = self.usb.now_us();
        self.phase = Phase::Ack;
    }

    // ------------------------------------------------------------ 发

    /// 写一条控制帧：补上换行（编码函数只管正文，换行是"成帧"的事）
    fn control(&mut self, frame: &str) {
        self.write_raw(frame.as_bytes());
        self.write_raw(b"\n");
    }

    /// 写一行文本（`OK` / `ERR` 这些短回复，以及应答的正文行）
    fn text(&mut self, s: &str) {
        self.write_raw(s.as_bytes());
        self.write_raw(b"\n");
    }

    /// 发**任意**一条控制帧（正文由调用方拼，本 crate 不解释它是什么意思）。
    ///
    /// 调用方自己的词（"可以开始发了"、"下面是 n 个裸字节"、"一条主动通知"）都从这里
    /// 出去：成帧、换行、TX 节流、应答编号由协议管，措辞归调用方。
    pub fn frame(&mut self, id: u32, body: &str) {
        self.control(&frame::encode_frame(id, body));
    }

    /// 发一段裸字节（设备 → 主机方向的载荷，不加标签）：返回实际写出去的字节数
    pub fn bytes(&mut self, data: &[u8]) -> usize {
        self.write_raw(data)
    }

    /// 命令成功，没有附加数据
    pub fn ok(&mut self) {
        let id = self.reply_id();
        self.control(&frame::encode_ok(id));
        self.payload = false;
    }

    /// 命令成功，附带几行数据：`~id OK n` + n 行 + `~id END`
    ///
    /// 正文那 n 行**不带哨兵**：它们只在"某条请求的应答"里出现，读的人已经知道自己在
    /// 读第几行；套上哨兵只会让正文更难读（也更难给人看）。
    pub fn reply_lines(&mut self, lines: &[String]) {
        let id = self.reply_id();
        self.control(&frame::encode_ok_lines(id, lines.len()));
        for line in lines {
            self.text(line);
        }
        if !lines.is_empty() {
            self.control(&frame::encode_end(id));
        }
    }

    /// 命令失败
    pub fn err(&mut self, msg: &str) {
        let id = self.reply_id();
        self.control(&frame::encode_err(id, msg));
        self.payload = false;
    }

    /// 回一个块 ACK（2 字节，不带计数：这个方向设备是收的一方，它收到多少自己清楚）
    pub fn ack(&mut self) {
        self.write_raw(&CHUNK_ACK);
    }

    /// 排入一条待发通知（名字与参数都是调用方的词）：只入队，不碰串口。
    ///
    /// 通知常常产生在性能敏感的循环边界上，那条路径不许被串口拖住，所以产生与发送分开：
    /// 发送由 [`Wire::flush_notices`] 负责。合并与限速见 [`Events`]。
    pub fn queue_notice(&mut self, name: &'static str, args: &str) {
        let now = self.usb.now_us();
        self.events.push(name, args, now);
    }

    /// 设定"哪一种通知要限速、间隔多久"（策略归调用方，这里只管窗口）。
    pub fn set_notice_throttle(&mut self, name: Option<&'static str>, interval_us: u64) {
        self.events.set_throttle(name, interval_us);
    }

    /// 把待发通知尽量送出去，返回送出去几条。
    ///
    /// `render` 是调用方的**措辞把手**（名字 + 参数 → 一帧正文）：协议知道什么时候能发、
    /// 发不出去要不要留着重试，但不知道一条通知长什么样。
    ///
    /// 两条硬性约束：
    /// - **处在裸载荷区间时一条都不发**（[`Wire::payload_open`]）：那时串口被裸字节占着，
    ///   混进任何字节都会让两边一起错位；
    /// - **一发现主机不取字节就停手**：剩下的留在队列里，等下一条请求到达时再试。
    ///   主机走了以后设备不能因为"自己在推通知"而变慢。
    pub fn flush_notices(&mut self, render: fn(&str, &str) -> String) -> usize {
        if !self.host_reading || self.payload_open() {
            return 0;
        }
        let mut sent = 0usize;
        // **写成功才出队**：收尾类的通知是关键时刻，不能因为"这会儿 FIFO 满了"就永远丢掉。
        // 写不下去就停在这里，等下一条请求（= 主机又在看）再试。
        while let Some(event) = self.events.peek() {
            let mut text = render(event.name(), event.args());
            text.push('\n');
            if !self.write_optional(&text) {
                self.host_reading = false;
                return sent;
            }
            self.events.discard_front();
            sent += 1;
        }
        sent
    }

    /// 丢掉待发通知（一轮工作结束、旧的进度再发出去只会把界面跳回上一步）
    pub fn clear_notices(&mut self) {
        self.events.clear();
    }

    /// 现在还在给主机推通知吗（用来判断"兜底轮询可以降级吗"、以及排查用）
    pub fn pushing_notices(&self) -> bool {
        self.host_reading
    }

    /// 队列里压着几条 / 因队列满或参数过长丢了几条（排查"主机没收到通知"的证据）
    pub fn notice_stats(&self) -> (usize, u32) {
        (self.events.len(), self.events.dropped())
    }

    /// 写一段**可丢弃**的文本（只用于事件）：FIFO 一满就立刻收手，不烧 `TX_WAIT_US` 预算。
    ///
    /// 返回 `true` = 整段都写进了 FIFO 并按了一次 flush。写不全时留在 FIFO 里的那半截
    /// 是没有换行的残行：主机侧扫描器把它当噪音（重连时端口会复位，双方状态一起重来）。
    fn write_optional(&mut self, text: &str) -> bool {
        for &byte in text.as_bytes() {
            if self.usb.write_byte_nb(byte).is_ok() {
                continue;
            }
            // FIFO 满：先试一次 flush 腾位置；还是不行就说明主机这会儿没来取，立刻收手
            if self.usb.flush_tx_nb().is_err() || self.usb.write_byte_nb(byte).is_err() {
                return false;
            }
        }
        // 和 [`Wire::write_raw`] 同一条铁律：**不 flush 就永远不会交给主机**
        // （这里同样只按一次，不烧预算：事件丢了不丢人）。
        let _ = self.usb.flush_tx_nb();
        true
    }

    /// 写一段**协议字节**（回复 / ACK / 载荷都走它），返回**实际写出去**的字节数。
    ///
    /// 为什么不复用某个现成的 `io::Write`：有的实现在 FIFO 满时会丢字节，而且丢过一次
    /// 之后会**粘滞地"以后整笔都不写"** —— 实测就是这样把 16 KiB 传输的首块整个丢掉的。
    ///
    /// 为什么也不用无超时的 `UsbSerialJtag::write()` / `flush_tx()`：真卡住时会把固件锁死
    /// （实测有过一次 USB 包卡在 FIFO 里，之后固件再没回来过）。
    ///
    /// 所以这里自己逐字节写：FIFO 没空位就**主动 flush 一次**再重试，**每个字节最多等
    /// `TX_WAIT_US`**；等不到就把已经写出去的字节数如实返回，由调用方判失败 ——
    /// 宁可报错，不要卡死。
    ///
    /// **为什么必须在这儿 flush**：USB-Serial-JTAG 的 TX FIFO 只有 64 字节，而且
    /// **只有被 flush 过才会把数据交给主机**（底层外设驱动自己的 `write()` 就是每 64 字节
    /// `wr_done` 一次）。只在整段写完之后 flush 的话，写到第 64 个字节 FIFO 就满了、
    /// `serial_in_ep_data_free` 清零，之后每个字节都白等满 `TX_WAIT_US` 而一个字节也
    /// 发不出去 —— 实测：按 512 字节一块发时，声明长度那一行之后主机一个载荷字节
    /// 都收不到。短回复本来就不到 64 字节，所以这个坑只在分块变大时才暴露。
    pub fn write_raw(&mut self, data: &[u8]) -> usize {
        let mut sent = 0usize;
        for &byte in data {
            let deadline = self.usb.now_us().saturating_add(TX_WAIT_US);
            loop {
                if self.usb.write_byte_nb(byte).is_ok() {
                    sent += 1;
                    break;
                }
                // FIFO 满：把已经攒下的这一截推给主机，腾出空位后重试同一个字节。
                // `flush_tx_nb` 不阻塞（没准备好就返回 WouldBlock），所以真卡住时
                // 仍然会走到下面的超时收手。
                let _ = self.usb.flush_tx_nb();
                if self.usb.now_us() >= deadline {
                    return sent;
                }
            }
        }
        // 把 FIFO 里剩下这一截（不足一包）发出去。
        //
        // **要重试到真的被送走**：`flush_tx_nb` 只是"按一下发送键"，主机没来取的时候它
        // 返回 WouldBlock。忽略这个结果的话，最后那半包会一直躺在 FIFO 里，直到**下一次
        // 别的写入**才被顺带冲出去（真机实测：512 字节一块只到 448 字节，剩下 64 字节
        // 等固件补发时才发现被送走了 —— 主机那边就是"卡住不动"）。这里给它和单字节同样的
        // 预算 `TX_WAIT_US`，等不到也照常返回：宁可少发，不要卡死。
        let flush_deadline = self.usb.now_us().saturating_add(TX_WAIT_US);
        while self.usb.flush_tx_nb().is_err() && self.usb.now_us() < flush_deadline {}
        sent
    }
}
