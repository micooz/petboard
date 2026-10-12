//! 把协议 crate 的**同步状态机**接到 Embassy 上：等字节、等 ACK、睡到超时。
//!
//! 分层很明确：
//!
//! - `crates/serial`（`serial::Wire`）＝通用线路机制：`~<id>` 哨兵成帧、消息 ID
//!   配对、块 ACK、标签槽、TX FIFO 节流、通知队列。它不认识任何业务词。
//! - [`crate::wire`]＝PetBoard 的业务报文层：命令语法与 `READY` / `DATA n` / `ev …`
//!   这些词的编解码、事件限速策略。
//! - **这里**只是异步适配层：状态机说"还要等"，我们就 `await` 一下再来，并把协议层的
//!   `serial::Request` 换成业务层的 [`wire::Request`]（解析命令在这一步发生）。
//!
//! 为什么要 `await`：读不到字节时让出 executor，喂狗任务和播放循环才有机会跑
//! （真机踩过：帧循环饿死 idle 任务 → `CoreMwdt0` 5 秒复位，表现是"停不下来"）。
//!
//! 板子 → 主机（v9）：
//!
//! | 内容 | 含义 |
//! |------|------|
//! | `~<id> READY` | `media/add` 专用：文件建好了，可以开始发数据 |
//! | `~<id> DATA <字节数>` | `media/get` 专用：紧接着回传这么多裸字节 |
//! | `0x06 0x09` | `media/add`：板子每收完一块回 2 字节 ACK |
//! | `0x06 0x09 <实收 u16>` | `media/get`：主机每收完一块回「实收了多少字节」，板子据此补发缺的尾巴 |
//! | `~<id> OK` / `~<id> OK <n>` + n 行 + `~<id> END` | 命令成功 |
//! | `~<id> ERR <原因>` | 出错（播放中收到别的命令会回 `ERR busy`） |
//! | `~0 ev <名> <字段…>` | 设备主动推的播放事件 |
//!
//! 主机 → 板子：一行 `~<id> <命名空间>/<动作> [参数…]`；传输途中改成"标签槽"形状
//! （`0x00` + 载荷、`0x01` + 一行控制帧），见 `serial` 的模块文档。
//!
//! 播放是**后台**的：`media/play` 回完 `OK` 就继续在帧与帧之间用
//! [`Link::try_command`] 看一眼串口。播放期间只有 `media/stop`、`media/play`、
//! `device/info` 会被就地处理，其它一律 `ERR busy`。
//!
//! 注意：defmt 的日志和这些协议数据走**同一个串口**，所以凡是按行读的地方都把
//! 不认得的字节当噪音丢掉；而 `media/get` 回传的载荷是裸字节，回传循环里一条日志
//! 都不能打 —— 那件事由 [`Link::set_payload`] 驱动 `PayloadQuiet`（见 `commands::download`）。

use alloc::string::String;
use embassy_time::{Duration, Instant, Timer};

use crate::wire::{self, Command, Request};

// 命令层从 `crate::link` 拿 `AckOutcome`：权威在协议 crate，这里转发
pub use serial::AckOutcome;
use serial::{CHUNK_UP, POLL_INTERVAL_US, Step, Wire};

use crate::Serial;

/// 一行命令最多多少个字符（协议 crate 的常量，这里只是转发给命令层用）
pub const MAX_LINE: usize = serial::MAX_LINE;
/// 上传方向一块的字节数（同上）
pub const CHUNK: usize = CHUNK_UP;

/// 板子上的链接：协议状态机 + Embassy 的"睡一会儿再来"。
pub struct Link<S: Serial> {
    wire: Wire<S>,
}

/// 一次"收一槽"的结论（上传方向，见 [`Link::recv_slot`]）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Slot {
    /// 收到 `got` 个载荷字节（少于要的就是主机中途没发完）
    Data { got: usize },
    /// 传输途中收到控制帧（`media/abort`）：载荷到此为止
    Control(Request),
}

/// 播放事件的**措辞把手**：协议只管什么时候能发、写不出去要不要留队，一帧长什么样在这里。
///
/// 拼的是**整帧**而不是正文：`id = 0` 是"不是应答的帧"的约定（见 [`wire::vocab::event_frame`]），
/// 协议那边补一个换行就上线。
fn render_event(name: &str, args: &str) -> String {
    wire::vocab::event_frame(name, args)
}

impl<S: Serial> Link<S> {
    pub fn new(usb: S) -> Self {
        let mut wire = Wire::new(usb);
        // 帧进度是高频事件，限速 1 秒一条；别的（play/stop/item/loop/error）不限
        wire.set_notice_throttle(
            Some(wire::vocab::events::FRAME),
            wire::vocab::events::FRAME_MIN_INTERVAL_US,
        );
        Link { wire }
    }

    /// 状态机本体（要直接碰协议层接口时用；业务语义优先走本结构的其它方法）
    pub fn wire(&self) -> &Wire<S> {
        &self.wire
    }

    pub fn wire_mut(&mut self) -> &mut Wire<S> {
        &mut self.wire
    }

    /// 底层串口（板子那侧要直接碰外设时用）
    pub fn serial_mut(&mut self) -> &mut S {
        self.wire.serial_mut()
    }

    // ------------------------------------------------------------ 收命令

    /// 睡到状态机说的超时时刻；`None` = 没有超时（空闲等命令），按固定节奏轮询。
    ///
    /// 单独抽出来是因为三个入口（等命令 / 等载荷 / 等 ACK）都要走同一段"没字节就
    /// 让出 executor"的逻辑，写漏一次就是看门狗复位。
    /// **只能睡"一跳"，绝不能睡到 deadline**：[`Wire::poll`] 一进门就先判超时，
    /// 睡满整个预算会让**此刻已经躺在 RX FIFO 里的字节**被 `expire()` 判成超时。
    /// 真机实测（S3，2026-10-09）：上传 100% `ERR timeout waiting for data`、
    /// 下载第一块之后 100% `ack_timeout`，而 `resends 0` 说明固件根本没看见主机
    /// 几毫秒前就发出去的 ACK。空闲等命令时睡满也没事，因为那个阶段没有超时。
    async fn wait(&mut self) {
        match self.wire.deadline_us() {
            // 有明确超时：只睡一跳就去再看一眼（超时的判定始终由状态机负责）
            Some(_) => Timer::after(Duration::from_micros(POLL_INTERVAL_US)).await,
            // 空闲等命令：让出 executor，喂狗和播放循环才有机会跑
            None => Timer::after(Duration::from_millis(20)).await,
        }
    }

    /// 等一条命令。
    pub async fn next_command(&mut self) -> Command {
        self.next_request().await.command
    }

    /// 等一条命令，并带出它的消息 ID（应答要用；一般由 `Wire` 自己记着）
    pub async fn next_request(&mut self) -> Request {
        // 先收"上次传输里退回来的那条命令"：回传途中收到非 abort 的命令时，命令层会
        // `push_pending` 把它存着等这次传输收场再处理。漏了这一步，那条命令会永远躺在
        // 槽里 —— 网页只能干等到自己的超时（真机表现是"点了没反应"）。
        if let Some(request) = self.take_pending() {
            return request;
        }
        let mut buf = [0u8; 1];
        loop {
            match self.wire.poll(&mut buf) {
                Step::Request(request) => return Request::from_wire(request),
                Step::Nothing => self.wait().await,
                // 空闲阶段不会有别的结论；真出现了（残影）就继续清
                _ => continue,
            }
        }
    }

    /// **完全不等待**地看一眼串口：把已经到的字节读干，拼出整帧就返回它。
    ///
    /// 播放动画时每帧调用一次，用来在帧与帧之间收 `media/stop`、`media/play`、
    /// `device/info`。拼了一半的行留在缓冲里，下一次接着拼。
    pub fn try_command(&mut self) -> Option<Command> {
        self.try_request().map(|request| request.command)
    }

    /// 非阻塞版：连请求 ID 一起拿（`media/abort` 要按号回两条应答）
    pub fn try_request(&mut self) -> Option<Request> {
        let request = self.wire.try_request()?;
        Some(Request::from_wire(request))
    }

    /// 在 `deadline` 之前等一条命令；超时就返回 `None`。
    ///
    /// 上传成功后的欢迎屏倒计时用它：中间来了 `media/list` / `device/info` 不打断，
    /// 来了 `media/play` 就能立刻处理。
    pub async fn next_command_until(&mut self, deadline: Instant) -> Option<Command> {
        if let Some(request) = self.take_pending() {
            return Some(request.command);
        }
        let mut buf = [0u8; 1];
        loop {
            match self.wire.poll(&mut buf) {
                Step::Request(request) => return Some(Request::from_wire(request).command),
                Step::Nothing => {
                    if Instant::now() >= deadline {
                        return None;
                    }
                    Timer::after(Duration::from_millis(20)).await;
                }
                _ => continue,
            }
        }
    }

    // ------------------------------------------------------------ 传输

    /// 从报文里读一槽数据（`media/add`）：返回实际读到的字节数，超时会少于 `buf.len()`。
    ///
    /// 如果主机在槽边界上发来控制帧（`media/abort`），原样交出去 —— 载荷到此为止。
    pub async fn recv_chunk(&mut self, buf: &mut [u8]) -> usize {
        match self.recv_slot(buf).await {
            Slot::Data { got } => got,
            // 老调用点不关心是谁打断的（它会走"短读"那条失败路径）
            Slot::Control(_) => 0,
        }
    }

    /// 收一槽载荷，并区分"短读"和"主机发来了控制帧"
    pub async fn recv_slot(&mut self, buf: &mut [u8]) -> Slot {
        self.wire.begin_recv_slot(buf.len());
        loop {
            match self.wire.poll(buf) {
                Step::ChunkDone { got } => return Slot::Data { got },
                Step::TimedOut { got } => return Slot::Data { got },
                Step::TransferFrame => {
                    return match self.take_pending() {
                        Some(request) => Slot::Control(request),
                        None => Slot::Data { got: 0 },
                    };
                }
                Step::Nothing => self.wait().await,
                Step::Request(_) | Step::Ack(_) => continue,
            }
        }
    }

    /// 等主机回一个块 ACK（`media/get` 回传时每块收一个）：`06 09` + 实收字节数（u16 小端）。
    ///
    /// **收下实收字节数是重点**：板子发一块 512 字节时，发送路径可能在主机没排空 FIFO 时
    /// 丢掉尾巴；主机把"我收到多少了"回过来，上层就能只补发缺的那几个字节。
    ///
    /// 主机读不到载荷时会超时放弃、接着发下一条命令，所以这里也会返回
    /// [`AckOutcome::Aborted`]，那条命令留在 [`Link::take_pending`] 里。
    pub async fn recv_ack(&mut self) -> AckOutcome {
        self.wire.begin_ack();
        let mut buf = [0u8; 1];
        loop {
            match self.wire.poll(&mut buf) {
                Step::Ack(outcome) => return outcome,
                Step::Nothing => self.wait().await,
                Step::Request(request) => {
                    // 等 ACK 时读到一条"正常请求"（不该发生：说明阶段没切对）—— 存下来当打断
                    self.push_pending(Request::from_wire(request));
                    return AckOutcome::Aborted;
                }
                Step::ChunkDone { .. } | Step::TimedOut { .. } | Step::TransferFrame => continue,
            }
        }
    }

    /// 把一条业务请求放回待发槽（"现在处理不了，等这次传输收场再说"）
    pub fn push_pending(&mut self, request: Request) {
        self.wire.push_pending(request.to_wire());
    }

    /// 取走传输途中收到的控制帧（一般是叫停这一趟传输）
    pub fn take_pending(&mut self) -> Option<Request> {
        let request = self.wire.take_pending()?;
        Some(Request::from_wire(request))
    }

    /// 主机最近 `window_us` 内发过请求吗（回传失败时用来区分"主机走了"和"串口卡了"）
    pub fn host_active(&mut self, window_us: u64) -> bool {
        self.wire.host_active(window_us)
    }

    /// 应答要带的消息 ID
    pub fn reply_id(&self) -> u32 {
        self.wire.reply_id()
    }

    /// 把应答目标切到另一个编号（`media/abort` 要同时回被中断那条 + abort 自己）
    pub fn set_reply_id(&mut self, id: u32) {
        self.wire.set_reply_id(id);
    }

    /// 丢掉攒了一半的行（重连/复位后回到确定的起点）
    pub fn reset_line(&mut self) {
        self.wire.reset_line();
    }

    /// 现在是不是处在"裸载荷区间"（这期间不能打日志）
    pub fn payload_open(&self) -> bool {
        self.wire.payload_open()
    }

    /// 开/关"裸载荷区间"：`commands::download` 用它驱动 `PayloadQuiet`，
    /// 于是"日志静音"和"协议正在发裸字节"由同一个事实决定。
    pub fn set_payload(&mut self, open: bool) {
        self.wire.set_payload(open);
    }

    // ------------------------------------------------------------ 发应答

    /// 发**任意**一条控制帧（正文由业务层拼）：成帧、换行、TX 节流、编号都归协议
    pub fn frame(&mut self, id: u32, body: &str) {
        self.wire.frame(id, body);
    }

    /// `media/add` 专用：文件建好了，可以开始发数据
    pub fn ready(&mut self) {
        let id = self.reply_id();
        self.wire.frame(id, wire::vocab::READY);
    }

    /// `media/get` 专用：紧接着要回传 `len` 个字节（同时打开裸载荷区间）
    pub fn data(&mut self, len: u32) {
        let id = self.reply_id();
        self.wire.frame(id, &wire::vocab::data(len));
        self.wire.set_payload(true);
    }

    /// 发一段裸字节（`media/get` 的文件内容）：返回实际写出去的字节数
    pub fn bytes(&mut self, data: &[u8]) -> usize {
        self.wire.bytes(data)
    }

    /// 命令成功，没有附加数据
    pub fn ok(&mut self) {
        self.wire.ok();
    }

    /// 命令成功，附带几行数据：`~<id> OK n` + n 行 + `~<id> END`
    pub fn reply_lines(&mut self, lines: &[String]) {
        self.wire.reply_lines(lines);
    }

    /// 命令失败
    pub fn err(&mut self, msg: &str) {
        self.wire.err(msg);
    }

    /// 回一个块 ACK
    pub fn ack(&mut self) {
        self.wire.ack();
    }

    /// 排入一个待推的播放事件（`~0 ev <名> <字段…>`）：**只入队，不碰串口**。
    ///
    /// 播放的帧边界用它而不是直接写：限速/同类合并由协议 crate 负责（帧进度 1 秒一条），
    /// 写不出去（网页关了）也不会把帧循环拖慢。真正发出去由 [`Link::flush_events`] 完成。
    pub fn queue_event(&mut self, name: &'static str, args: &str) {
        self.wire.queue_notice(name, args);
    }

    /// 把待发的通知送出去，返回送出条数（每帧边界调一次）
    pub fn flush_events(&mut self) -> usize {
        self.wire.flush_notices(render_event)
    }

    /// 立刻发一条播放事件（不经队列；只给"关键时刻不许排队"的场合用）
    pub fn event(&mut self, name: &str, args: &str) {
        self.wire.frame(0, &wire::vocab::event(name, args));
    }

    /// 丢掉待发事件（停播时：旧的帧进度再发出去只会把界面跳回上一帧）
    pub fn clear_events(&mut self) {
        self.wire.clear_notices();
    }

    /// 现在还在推事件吗（网页的兜底轮询降级用；排查也用）
    pub fn pushing_events(&self) -> bool {
        self.wire.pushing_notices()
    }

    /// 队列里压着几条 / 丢了几条（排查"主机没收到事件"的证据）
    pub fn event_stats(&self) -> (usize, u32) {
        self.wire.notice_stats()
    }

    /// 写一段协议字节，返回实际写出去的字节数（板级诊断用；正常路径走上面的方法）
    pub fn write_raw(&mut self, data: &[u8]) -> usize {
        self.wire.write_raw(data)
    }
}
