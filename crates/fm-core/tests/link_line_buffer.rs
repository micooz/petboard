//! 板子上的异步适配层（`fm_core::link::Link`）：把协议 crate 的同步状态机接到 Embassy。
//!
//! 钉两类东西：
//! - **跨两次读取的半条命令必须接着拼**（真机踩过：播放循环只读到半条 `media`，停播后
//!   回到主循环，剩下的 `/list` 被拼成一条不认识的命令 → `unknown command: /list`）；
//! - **传输途中的控制帧要原样交给命令层**（`media/abort` 靠它才不用等超时）。
//!
//! 这些用例都把字节一次排齐，所以走不到"睡一会儿再来"那支；`embassy-time` 的驱动符号
//! 仍然要用桩补上（否则链接不过），见下面的 `_embassy_time_*`。

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::task::{Poll, Waker};

// ---------------------------------------------------------------- 时间驱动桩
//
// `Link::wait` 里的 `Timer::after` 需要 `embassy-time` 的驱动符号，而它在板子上由
// `esp-hal` 提供，host 测试里没有实现就链接不过。这里给一个**永不推进**的桩：
// 这些测试的字节全部提前排好，future 第一次 poll 就 Ready，永远不会真的等定时器。
// 万一哪天有用到，`schedule_wake` 会直接把测试打死，而不是静默地挂住。

#[unsafe(no_mangle)]
fn _embassy_time_now() -> u64 {
    0
}

#[unsafe(no_mangle)]
fn _embassy_time_schedule_wake(_at: u64, _waker: &Waker) {
    panic!("测试里不该真的等定时器：请先把串口字节排好，让 future 第一次 poll 就返回");
}

use fm_core::link::{Link, Slot};
use fm_core::wire::Command;
use fm_core::wire::Request;
use fm_core::{Serial, SerialError, SerialResult};

/// 内存假串口：字节按批"到达"，模拟 USB-Serial-JTAG 的节奏。
///
/// 用 `Rc<RefCell<..>>` 是因为 `Link` 拿走了串口的所有权，测试这边还得能往里塞字节。
#[derive(Clone)]
struct FakeSerial {
    inner: Rc<RefCell<FakeState>>,
}

struct FakeState {
    batches: VecDeque<Vec<u8>>,
    current: VecDeque<u8>,
    tx: Vec<u8>,
    /// 每问一次时间走 1 微秒：真机上时钟从不静止
    now: u64,
}

impl FakeSerial {
    fn new() -> Self {
        Self {
            inner: Rc::new(RefCell::new(FakeState {
                batches: VecDeque::new(),
                current: VecDeque::new(),
                tx: Vec::new(),
                now: 0,
            })),
        }
    }

    /// 排入一批"此刻已经躺在 FIFO 里"的字节
    fn push(&self, bytes: &[u8]) {
        self.inner.borrow_mut().batches.push_back(bytes.to_vec());
    }

    fn push_line(&self, text: &str) {
        self.push(text.as_bytes());
        self.push(b"\n");
    }

    /// 板子实际写出去的字节
    fn tx(&self) -> Vec<u8> {
        self.inner.borrow().tx.clone()
    }

    fn tx_text(&self) -> String {
        String::from_utf8(self.tx()).expect("协议字节应当是 UTF-8")
    }

    /// 丢掉已记录的写出字节：只看"接下来这一步有没有写字节"时用
    fn clear_tx(&self) {
        self.inner.borrow_mut().tx.clear();
    }
}

impl Serial for FakeSerial {
    fn read_byte(&mut self) -> SerialResult<u8> {
        let mut state = self.inner.borrow_mut();
        if state.current.is_empty() {
            match state.batches.pop_front() {
                Some(next) => state.current = next.into(),
                None => return Err(SerialError::WouldBlock),
            }
        }
        state.current.pop_front().ok_or(SerialError::WouldBlock)
    }

    fn write_byte_nb(&mut self, byte: u8) -> SerialResult<()> {
        self.inner.borrow_mut().tx.push(byte);
        Ok(())
    }

    fn flush_tx_nb(&mut self) -> SerialResult<()> {
        Ok(())
    }

    fn now_us(&mut self) -> u64 {
        let mut state = self.inner.borrow_mut();
        state.now += 1;
        state.now
    }
}

/// 没有执行器也跑完一个"第一次 poll 就好"的 future
fn poll_once<F: std::future::Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    match future
        .as_mut()
        .poll(&mut core::task::Context::from_waker(Waker::noop()))
    {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("future 挂起了：测试里不该需要等定时器"),
    }
}

// ---------------------------------------------------------------- 行缓冲

#[test]
fn partial_line_survives_between_try_request_and_next_request() {
    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());

    usb.push(b"~7 media"); // 播放循环里只到这几个字节
    assert_eq!(link.try_request(), None, "半条命令不该被当成命令");

    usb.push(b"/list\n"); // 停播之后剩下的才到
    let request = poll_once(link.next_request());
    assert_eq!(request.command, Command::MediaList);
    assert_eq!(request.id, 7, "留在缓冲里的 `~7 ` 也要一起拼回来");
}

#[test]
fn try_request_continues_a_partial_line() {
    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());

    usb.push(b"~1 device/");
    assert_eq!(link.try_request(), None);
    usb.push(b"info\n");
    let request = link.try_request().expect("半条行要接着拼");
    assert_eq!(request.command, Command::DeviceInfo);
    assert_eq!(request.id, 1);
}

#[test]
fn binary_noise_resets_the_partial_line() {
    // defmt 日志帧和协议共用同一个串口：不可打印字节要清掉半条行，
    // 否则粘出来的"命令"是垃圾。
    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());

    usb.push_line("~2 ~3 med\x00ia/list");
    // `~2 ~3 med` 被日志碎片打断 → 丢掉；剩下的 `ia/list` 不带哨兵 → 也丢掉。
    // 关键在**不许拼出一条假命令**：宁可不认，也不能执行一条没人发的命令。
    assert_eq!(link.try_request(), None);
    // 丢掉的东西要留下计数（排查"命令凭空消失"时是证据）
    usb.push_line("~3 media/stop");
    assert_eq!(
        link.try_request()
            .map(|request| (request.id, request.command)),
        Some((3, Command::MediaStop)),
        "丢掉半行之后，下一条正常命令照收"
    );
}

/// 引导加载器的日志最后一行不带换行，回执直接粘在它后面。
/// v9 靠哨兵切分，不再需要从行尾抠 `OK`。
#[test]
fn boot_log_glued_to_a_request_is_split_at_the_sentinel() {
    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());

    usb.push(b"I (106) esp_image: segment 3: paddr=0001bb6c vaddr=00000000 size");
    usb.push_line("~4 device/info");
    // 扫描器在行**中间**看到哨兵就把粘在一起的两段切开：前半截是外来文本（丢掉），
    // 后半截是那条请求。旧协议在这里只能"从行尾正则抠回执"。
    let request = link.try_request().expect("粘在日志后面的请求必须读出来");
    assert_eq!(request.id, 4);
    assert_eq!(request.command, Command::DeviceInfo);
}

// ---------------------------------------------------------------- 应答带 id

#[test]
fn replies_carry_the_id_of_the_request_being_handled() {
    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());

    usb.push_line("~11 media/list");
    let request = poll_once(link.next_request());
    assert_eq!(request.id, 11);
    link.ok();
    assert_eq!(usb.tx_text(), "~11 OK\n");
}

#[test]
fn payload_interval_is_visible_to_the_command_layer() {
    // `PayloadQuiet` 靠这个开关驱动：静音窗口必须和"正在发裸字节"完全重合
    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());
    usb.push_line("~5 media/get A.ANM 0 4");
    poll_once(link.next_request());

    assert!(!link.payload_open());
    link.data(4);
    assert!(link.payload_open(), "DATA 之后进入裸载荷区间");
    link.bytes(b"1234");
    link.ok();
    assert!(!link.payload_open(), "OK 之后必须退出");
    assert_eq!(usb.tx_text(), "~5 DATA 4\n1234~5 OK\n");
}

// ---------------------------------------------------------------- 传输途中的帧

/// 上传途中收到 `media/abort`：适配层要把它交出去，而不是当噪音吞掉
#[test]
fn abort_during_upload_reaches_the_command_layer() {
    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());
    usb.push_line("~1 media/add A.ANM 2048");
    poll_once(link.next_request());

    let mut chunk = [0u8; 4];
    // 一槽：标签 + 4 个载荷字节
    usb.push(&[0x00]); // TAG_DATA
    usb.push(&[1, 2, 3, 4]);
    assert_eq!(poll_once(link.recv_chunk(&mut chunk)), 4);

    // 下一槽：标签 + 一行控制帧（abort）
    usb.push(&[0x01]); // TAG_CTRL
    usb.push_line("~2 media/abort 1");
    let slot = poll_once(link.recv_slot(&mut chunk));
    let Slot::Control(request) = slot else {
        panic!("传输途中的控制帧必须交出来：{slot:?}");
    };
    assert_eq!(request.command, Command::MediaAbort { id: 1 });
    assert_eq!(request.id, 2);
}

/// 回传途中主机不等了：`recv_ack` 要返回 Aborted，命令留在 pending 里
#[test]
fn ack_wait_reports_when_the_host_leaves() {
    use serial::AckOutcome;

    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());
    usb.push_line("~3 media/get A.ANM 0 512");
    poll_once(link.next_request());

    usb.push_line("~4 media/abort 3");
    assert_eq!(
        poll_once(link.recv_ack()),
        AckOutcome::Aborted,
        "主机发来控制帧 = 它不等这次传输了"
    );
    let pending = link.take_pending().expect("abort 要取得到");
    assert_eq!(pending.command, Command::MediaAbort { id: 3 });
    assert_eq!(pending.id, 4);
}

/// 回传途中收到**不是 abort** 的命令：命令层把它退回 pending 槽，主循环下一次取命令时
/// 必须拿到它 —— 否则那条命令凭空消失，网页干等到自己的超时（真机表现是"点了没反应"）。
#[test]
fn a_command_pushed_back_is_handed_to_the_main_loop() {
    use serial::AckOutcome;

    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());
    usb.push_line("~5 media/get A.ANM 0 512");
    poll_once(link.next_request());

    usb.push_line("~6 media/list");
    assert_eq!(poll_once(link.recv_ack()), AckOutcome::Aborted);
    let stray = link.take_pending().expect("退回来的命令要取得到");
    assert_eq!(stray.command, Command::MediaList);
    // 命令层的做法：`push_pending` 放回，等这次传输收场后由主循环照常处理
    link.push_pending(stray);
    assert_eq!(poll_once(link.next_request()).command, Command::MediaList);
}

/// 主机老老实实在收：ACK 的实收字节数要带回来（固件据此只补发缺的尾巴）
#[test]
fn ack_carries_the_received_byte_count() {
    use serial::AckOutcome;

    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());
    usb.push_line("~3 media/get A.ANM 0 512");
    poll_once(link.next_request());

    usb.push(&[0x06, 0x09, 0x2c, 0x01]); // 实收 300
    assert_eq!(poll_once(link.recv_ack()), AckOutcome::Acked(300));
}

// ---------------------------------------------------------------- 播放期间的非阻塞

#[test]
fn playback_can_poll_the_port_without_waiting() {
    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());
    assert!(link.try_command().is_none(), "没字节时立刻返回，不许等");

    usb.push_line("~9 media/stop");
    assert_eq!(link.try_command(), Some(Command::MediaStop));
    assert_eq!(link.reply_id(), 9, "就地回执要用这条 stop 的号");
    link.ok();
    assert_eq!(usb.tx_text(), "~9 OK\n");
}

#[test]
fn reset_line_forgets_a_half_read_line() {
    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());
    usb.push(b"~8 med");
    assert_eq!(link.try_command(), None);
    link.reset_line();
    usb.push_line("~9 media/stop");
    assert_eq!(link.try_request().map(|r| r.id), Some(9));
}

// ---------------------------------------------------------------- 业务词的编码

/// `READY` / `DATA n` / `ev …` 这些**词**由业务层拼（`crate::wire::vocab`），
/// 协议 crate 只负责成帧。分层搬动时最容易漏的就是这条：线上字节必须一字不变。
#[test]
fn business_words_are_encoded_on_the_wire_unchanged() {
    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());

    // 上传：文件建好了 → `~<id> READY`
    usb.push_line("~3 media/add A.ANM 2048");
    poll_once(link.next_request());
    link.ready();
    assert_eq!(usb.tx_text(), "~3 READY\n");

    // 播放事件：`~0 ev <名> <字段…>`（id = 0 = 非应答帧）
    usb.push_line("~4 media/play");
    poll_once(link.next_request());
    usb.clear_tx();
    link.event(fm_core::wire::vocab::events::FRAME, "12 28");
    assert_eq!(usb.tx_text(), "~0 ev frame 12 28\n");
}

/// 队列里的事件在帧边界一次冲出，并带上限速（`ev frame` 一秒最多一条）
#[test]
fn queued_events_flush_at_frame_boundaries_and_are_throttled() {
    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());
    usb.push_line("~7 media/play");
    poll_once(link.next_request());
    usb.clear_tx();

    link.queue_event(fm_core::wire::vocab::events::PLAY, "");
    link.queue_event(fm_core::wire::vocab::events::FRAME, "1 28");
    // 同一时刻的第二条进度：落在限速窗口里，不该发出去
    link.queue_event(fm_core::wire::vocab::events::FRAME, "2 28");
    assert_eq!(link.flush_events(), 2, "play + 一条进度");
    assert_eq!(usb.tx_text(), "~0 ev play\n~0 ev frame 1 28\n");
    assert!(link.pushing_events());

    // 停播清掉待发进度：迟到的进度会把界面跳回上一帧
    link.clear_events();
    usb.clear_tx();
    assert_eq!(link.flush_events(), 0);
    assert_eq!(usb.tx_text(), "");
}

/// `push_pending` / `take_pending` 走的是业务 `Request`：退回来再取出去，命令与编号都不许变
#[test]
fn a_pushed_back_request_comes_back_unchanged() {
    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());
    usb.push_line("~9 media/get A.ANM 0 4");
    poll_once(link.next_request());

    // 业务 Request 只能从协议报文造出来（正文原文私有，只用于原样退回）
    let stray = Request::from_wire(serial::Request {
        id: 12,
        body: String::from("media/list"),
    });
    link.push_pending(stray.clone());
    let back = link.take_pending().expect("退回来的命令要取得到");
    assert_eq!(back, stray, "原文退回：不能变成重新解析出来的样子");
    assert_eq!(link.reply_id(), 12);
}

/// **停播收尾的顺序**（真机踩过，S3 2026-10-09）：`media/stop` 的 `OK` 之后不能再送出
/// 这一轮攒下的旧进度。播放途中主机没来取字节时，`ev loop` / `ev item` / `ev frame` 会一直
/// 压在待发队列里；照"先 flush 再 clear"的老顺序，网页刚把界面切回"已停止"就被迟到的进度
/// 点亮成"正在播放"（用户看到的就是"点了停止停不下来"）。
///
/// 更要命的是队列只有 4 格：旧进度占满之后，真正该发的 `ev stop` 会被**直接丢弃**
/// —— 主机永远等不到"停了"这条事件。
#[test]
fn stopping_clears_stale_progress_before_sending_the_stop_event() {
    use fm_core::wire::vocab::events::{FRAME, ITEM, LOOP, PLAY, STOP};

    let usb = FakeSerial::new();
    let mut link = Link::new(usb.clone());
    usb.push_line("~3 media/play");
    poll_once(link.next_request());
    usb.clear_tx();

    // 播放途中攒下四条没人取的事件（队列正好满）
    link.queue_event(PLAY, "");
    link.queue_event(ITEM, "1 1 A.ANM");
    link.queue_event(LOOP, "6");
    link.queue_event(FRAME, "27 28");

    // 新顺序：先丢掉旧进度 → 回 `OK` → 再排 `ev stop` → flush
    link.clear_events();
    link.ok();
    link.queue_event(STOP, "");
    assert_eq!(link.flush_events(), 1, "只该送出 ev stop 这一条");
    assert_eq!(
        usb.tx_text(),
        "~3 OK\n~0 ev stop\n",
        "回执之后只许有 ev stop，不许有迟到的进度"
    );

    // 反证（老顺序为什么会"停不下来"）：队列只有 4 格，旧进度占满时
    // `queue_event(STOP)` 在**入队那一刻**就被丢弃（满队丢新的），于是界面只收到
    // 迟到的进度、永远等不到 `ev stop`。
    usb.clear_tx();
    link.queue_event(PLAY, "");
    link.queue_event(ITEM, "1 1 A.ANM");
    link.queue_event(LOOP, "6");
    link.queue_event(FRAME, "1 28");
    let (_, dropped_before) = link.event_stats();
    link.queue_event(STOP, "");
    let (_, dropped_after) = link.event_stats();
    assert_eq!(
        dropped_after - dropped_before,
        1,
        "满队时 ev stop 在入队那一刻就被丢弃"
    );
    assert_eq!(link.flush_events(), 4, "发出去的全是没用的旧进度");
    assert!(
        !usb.tx_text().contains("ev stop"),
        "界面上根本没有'停了'这条事件"
    );
}
