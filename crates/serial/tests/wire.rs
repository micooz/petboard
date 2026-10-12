//! 收发状态机：真实链路上踩过的坑全部钉在这里。
//!
//! 重点是两类**以前只有接上设备才能发现**的问题，如今在 host 上能穷举：
//! - TX FIFO 只有 64 字节、而且必须 flush 才交给主机（"宣告 512、实际只到 448"）；
//! - 主机中途不等了 / ACK 超时 / 载荷残字节 —— 三种结局的处理方式完全不同。
//!
//! 这里的命令与通知名字全是**中性词**（`store/*`、`job/cancel`、`note PROGRESS`）：
//! 本 crate 不认识任何业务词，测试也不该认识。产品自己的词在调用方那一层测。

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use serial::frame::{encode_frame, parse_control_line, Reply};
use serial::{
    AckOutcome, Request, Serial, SerialError, SerialResult, Step, Wire, CHUNK_ACK, TAG_CTRL,
    TAG_DATA,
};

/// 中性"通知措辞把手"：本 crate 只管什么时候能发，长什么样归调用方
fn note(name: &str, args: &str) -> String {
    if args.is_empty() {
        encode_frame(0, &format!("note {name}"))
    } else {
        encode_frame(0, &format!("note {name} {args}"))
    }
}

/// 中性"下面跟 n 个裸字节"：发词 + 拨载荷开关（调用方自己的编码函数该做这两件事）
fn announce_blob(wire: &mut Wire<Shared>, len: u32) {
    let id = wire.reply_id();
    wire.frame(id, &format!("BLOB {len}"));
    wire.set_payload(true);
}

/// 假串口的状态：用 `Rc<RefCell<..>>` 是因为 `Wire` 拿走串口的所有权，
/// 测试这边还得能塞字节、看发出去的东西。
#[derive(Clone)]
struct Shared {
    inner: Rc<RefCell<State>>,
}

struct State {
    /// 每问一次时间走 1 微秒：真机上时钟从不静止。
    /// 假时钟必须也走，否则 `write_raw` 的超时预算永远花不完（= 死循环）。
    rx: VecDeque<u8>,
    tx: Vec<u8>,
    /// 攒在 FIFO 里还没 flush 出去的字节
    pending: Vec<u8>,
    now: u64,
    /// 主机不来取：写不出去，flush 也失败（模拟 USB 包卡死）
    stuck: bool,
    /// `flush_tx_nb` 还要失败几次（模拟"主机这会儿没来取"）
    flush_failures: usize,
}

impl Shared {
    fn new() -> Self {
        Shared {
            inner: Rc::new(RefCell::new(State {
                rx: VecDeque::new(),
                tx: Vec::new(),
                pending: Vec::new(),
                now: 0,
                stuck: false,
                flush_failures: 0,
            })),
        }
    }

    /// 排入一批"此刻已经躺在 RX FIFO 里"的字节
    fn feed(&self, bytes: &[u8]) {
        self.inner.borrow_mut().rx.extend(bytes.iter());
    }

    fn line(&self, text: &str) {
        self.feed(text.as_bytes());
        self.feed(b"\n");
    }

    fn ack(&self, count: u16) {
        let raw = count.to_le_bytes();
        self.feed(&[CHUNK_ACK[0], CHUNK_ACK[1], raw[0], raw[1]]);
    }

    fn advance(&self, us: u64) {
        self.inner.borrow_mut().now += us;
    }

    /// 跳到"超时之后"：把时钟推到当前超时时刻再多加一点
    fn pass_deadline(&self, deadline: u64) {
        let now = self.inner.borrow().now;
        self.advance(deadline.saturating_sub(now) + 1);
    }

    /// 主机实际收到的字节（已 flush 出去的那些）
    fn tx(&self) -> Vec<u8> {
        self.inner.borrow().tx.clone()
    }

    /// 丢掉已经记录的发出去字节：只想看"接下来这一步有没有写字节"时用
    fn clear_tx(&self) {
        self.inner.borrow_mut().tx.clear();
        self.inner.borrow_mut().pending.clear();
    }

    fn tx_text(&self) -> String {
        String::from_utf8(self.tx()).unwrap()
    }

    fn stick(&self) {
        self.inner.borrow_mut().stuck = true;
    }

    /// 主机又开始取字节了（重新连接）
    fn unstick(&self) {
        self.inner.borrow_mut().stuck = false;
    }

    /// 当前假时钟（微秒）：不推进，用 `peek` 语义
    fn now(&self) -> u64 {
        self.inner.borrow().now
    }

    fn fail_flushes(&self, times: usize) {
        self.inner.borrow_mut().flush_failures = times;
    }
}

impl Serial for Shared {
    fn read_byte(&mut self) -> SerialResult<u8> {
        self.inner
            .borrow_mut()
            .rx
            .pop_front()
            .ok_or(SerialError::WouldBlock)
    }

    /// USB-Serial-JTAG 的 TX FIFO：64 字节满就不收
    fn write_byte_nb(&mut self, byte: u8) -> SerialResult<()> {
        let mut state = self.inner.borrow_mut();
        if state.stuck || state.pending.len() >= 64 {
            return Err(SerialError::WouldBlock);
        }
        state.pending.push(byte);
        Ok(())
    }

    /// **只有 flush 才把这一截交给主机**（这条链路的根本怪癖）
    fn flush_tx_nb(&mut self) -> SerialResult<()> {
        let mut state = self.inner.borrow_mut();
        if state.stuck {
            return Err(SerialError::WouldBlock);
        }
        if state.flush_failures > 0 {
            state.flush_failures -= 1;
            return Err(SerialError::WouldBlock);
        }
        if state.pending.is_empty() {
            return Ok(());
        }
        // 解构借用：`state.tx`/`state.pending` 是同一个 RefMut 上的两个字段
        let State { tx, pending, .. } = &mut *state;
        tx.append(pending);
        Ok(())
    }

    fn now_us(&mut self) -> u64 {
        let mut state = self.inner.borrow_mut();
        state.now += 1;
        state.now
    }
}

/// 建一条已经握过手的连接：`feed` 里给的第一条就是请求，返回 (wire, 状态句柄)
fn connected(first: &str) -> (Wire<Shared>, Shared) {
    let shared = Shared::new();
    shared.line(first);
    let mut wire = Wire::new(shared.clone());
    let mut buf = [0u8; 1];
    let step = wire.poll(&mut buf);
    assert!(matches!(step, Step::Request(_)), "握手命令没读到：{step:?}");
    (wire, shared)
}

fn request_id(wire: &mut Wire<Shared>, shared: &Shared, line: &str) -> u32 {
    shared.line(line);
    let mut buf = [0u8; 1];
    let Step::Request(request) = wire.poll(&mut buf) else {
        panic!("读不到请求：{line}")
    };
    request.id
}

// ---------------------------------------------------------------- 请求

#[test]
fn reads_a_request_with_its_message_id() {
    let shared = Shared::new();
    shared.feed(encode_frame(42, "device/ping").as_bytes());
    shared.feed(b"\n");
    let mut wire = Wire::new(shared);
    let mut buf = [0u8; 1];
    assert_eq!(
        wire.poll(&mut buf),
        Step::Request(Request {
            id: 42,
            body: String::from("device/ping")
        })
    );
    assert_eq!(wire.reply_id(), 42, "应答要带同一个号");
}

/// 半条命令跨两次读取到达：必须接着拼，不能自清缓冲
/// （否则剩下的碎片会被拼成一条不认识的命令）
#[test]
fn keeps_a_partial_line_between_polls() {
    let shared = Shared::new();
    shared.feed(b"~9 store");
    let mut wire = Wire::new(shared.clone());
    let mut buf = [0u8; 1];
    assert!(matches!(wire.poll(&mut buf), Step::Nothing));
    shared.feed(b"/list\n");
    assert_eq!(
        wire.poll(&mut buf),
        Step::Request(Request {
            id: 9,
            body: String::from("store/list")
        })
    );
}

/// 引导加载器的纯文本日志绝不当命令（也不靠从行尾抠回执）
#[test]
fn ignores_boot_logs_and_reply_shapes() {
    let shared = Shared::new();
    shared.feed(b"I (50) boot: ## Label NG\n");
    // 应答的形状设备自己也会发，读到就丢
    shared.feed(b"~1 OK 3\n");
    shared.feed(b"~0 note PROGRESS 5 28\n");
    shared.feed(encode_frame(7, "job/stop").as_bytes());
    shared.feed(b"\n");
    let mut wire = Wire::new(shared);
    let mut buf = [0u8; 1];
    let mut requests = Vec::new();
    for _ in 0..8 {
        if let Step::Request(request) = wire.poll(&mut buf) {
            requests.push(request);
        }
    }
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].id, 7);
    assert!(wire.noise() > 0, "外来行要留下计数，排查时是证据");
}

/// 正文的语法本 crate 一概不管：畸形命令照样交出去，由调用方判用法错
#[test]
fn odd_bodies_still_arrive() {
    let (mut wire, shared) = connected("~1 wat/ever");
    assert_eq!(wire.reply_id(), 1);
    assert_eq!(request_id(&mut wire, &shared, "~2 store/put nope"), 2);
}

#[test]
fn request_body_is_delivered_verbatim() {
    let shared = Shared::new();
    shared.line("~8 job/cancel 3");
    let mut wire = Wire::new(shared);
    let mut buf = [0u8; 1];
    let Step::Request(request) = wire.poll(&mut buf) else {
        panic!("没读到请求")
    };
    assert_eq!(request.id, 8);
    assert_eq!(request.body, "job/cancel 3");
}

// ---------------------------------------------------------------- 应答

#[test]
fn ok_is_one_line() {
    let (mut wire, shared) = connected("~5 job/stop");
    wire.ok();
    assert_eq!(shared.tx_text(), "~5 OK\n");
}

#[test]
fn arbitrary_body_is_one_line() {
    // 调用方自己的词照发不误，本 crate 不解释
    let (mut wire, shared) = connected("~5 job/stop");
    let id = wire.reply_id();
    wire.frame(id, "GO");
    assert_eq!(shared.tx_text(), "~5 GO\n");
}

#[test]
fn reply_lines_frame_the_body_then_end() {
    let (mut wire, shared) = connected("~6 device/ping");
    wire.reply_lines(&[String::from("name alpha"), String::from("state 3")]);
    // 正文行不带哨兵：它们只在"某条请求的应答"里出现
    assert_eq!(shared.tx_text(), "~6 OK 2\nname alpha\nstate 3\n~6 END\n");
}

#[test]
fn zero_line_reply_has_no_end() {
    let (mut wire, shared) = connected("~2 store/list");
    wire.reply_lines(&[]);
    assert_eq!(shared.tx_text(), "~2 OK 0\n");
}

#[test]
fn payload_interval_opens_with_the_word_and_closes_on_ok_or_err() {
    let (mut wire, shared) = connected("~3 store/get A.BLOB 0 1024");
    assert!(!wire.payload_open());
    announce_blob(&mut wire, 1024);
    assert!(wire.payload_open(), "声明之后进入裸载荷区间");
    assert!(shared.tx_text().starts_with("~3 BLOB 1024\n"));
    wire.err("transfer failed");
    assert!(!wire.payload_open(), "ERR 之后必须退出载荷区间");
    assert!(shared.tx_text().ends_with("~3 ERR transfer failed\n"));
}

#[test]
fn ok_after_payload_clears_the_interval() {
    let (mut wire, shared) = connected("~3 store/get A.BLOB 0 4");
    announce_blob(&mut wire, 4);
    wire.bytes(b"1234");
    wire.ok();
    assert!(!wire.payload_open());
    assert_eq!(shared.tx_text(), "~3 BLOB 4\n1234~3 OK\n");
}

#[test]
fn non_reply_frames_use_the_reserved_zero_id() {
    let (mut wire, shared) = connected("~1 job/start");
    wire.frame(0, "note PROGRESS 12 28");
    assert!(shared.tx_text().contains("~0 note PROGRESS 12 28\n"));
    // id = 0 的正文在本 crate 眼里只是"别的正文"
    let message = parse_control_line("~0 note PROGRESS 12 28").unwrap();
    assert_eq!(message.id, 0);
    assert_eq!(
        message.reply,
        Reply::Unknown {
            body: String::from("note PROGRESS 12 28")
        }
    );
}

// ---------------------------------------------------------------- TX 节流

/// **踩过**：只在整段写完之后 flush 的话，写到第 64 字节 FIFO 就满、
/// 之后每个字节白等满超时 —— 按 512 一块发时主机一个载荷字节都收不到。
#[test]
fn flushes_the_fifo_while_writing_a_large_chunk() {
    let (mut wire, shared) = connected("~1 store/get A.BLOB 0 4096");
    let payload = [0xa5u8; 512];
    assert_eq!(wire.bytes(&payload), 512, "边写边 flush 才写得完 512 字节");
    assert_eq!(shared.tx().len(), 512, "必须真的交给主机，不是只写进 FIFO");
}

/// 载荷和应答交错时也不能串位（512 一块就是这个形状）
#[test]
fn many_chunks_all_reach_the_host() {
    let (mut wire, shared) = connected("~1 store/get A.BLOB 0 16384");
    let payload = [0x5au8; 512];
    for _ in 0..32 {
        assert_eq!(wire.bytes(&payload), 512);
    }
    assert_eq!(shared.tx().len(), 32 * 512);
}

/// **踩过**：`flush_tx_nb` 返回 WouldBlock 时被忽略，最后那半包要等下一次写入
/// 才被顺带冲出去（512 只到 448，主机那边就是"卡住不动"）。
#[test]
fn retries_the_final_flush_instead_of_giving_up() {
    let (mut wire, shared) = connected("~1 job/stop");
    shared.fail_flushes(5);
    wire.ok();
    assert_eq!(shared.tx_text(), "~1 OK\n");
}

#[test]
fn reports_short_write_instead_of_hanging() {
    // FIFO 彻底写不出去（主机不在了）：必须"宁可报错，不要卡死"
    let (mut wire, shared) = connected("~1 job/stop");
    shared.stick();
    // 时钟不推进的话 write_raw 会立刻收手；这里让它慢慢走，模拟超时预算被耗尽
    let sent = wire.bytes(&[0u8; 40]);
    assert!(sent < 40, "写不出去时如实报告：{sent}");
}

// ---------------------------------------------------------------- 传输槽

/// 主机 → 设备的一槽：标签 + 载荷；载荷里出现 `~` / `0x06` 不许被误认成控制帧
#[test]
fn tagged_slots_keep_payload_bytes_as_data() {
    let (mut wire, shared) = connected("~1 store/put A.BLOB 3");
    let mut chunk = [0u8; 3];
    wire.begin_recv_slot(chunk.len());
    shared.feed(&[TAG_DATA, b'~', 0x06, 0x00]);
    let Step::ChunkDone { got } = wire.poll(&mut chunk) else {
        panic!("载荷没收满")
    };
    assert_eq!(got, 3);
    assert_eq!(chunk, [b'~', 0x06, 0x00]);
}

#[test]
fn tagged_control_line_during_transfer_becomes_a_pending_request() {
    let (mut wire, shared) = connected("~1 store/put A.BLOB 2048");
    let mut chunk = [0u8; 10];
    // 第一块照收：载荷是盲收的，中途来的字节只能算进这一槽（这就是"打断上限 =
    // 一块 + 一次 ACK"的由来，不是 bug）
    wire.begin_recv_slot(10);
    shared.feed(&[TAG_DATA]);
    shared.feed(&[7u8; 10]);
    assert_eq!(wire.poll(&mut chunk), Step::ChunkDone { got: 10 });

    // 槽边界上主机发取消（TAG_CTRL + 一行控制帧）
    wire.begin_recv_slot(10);
    shared.feed(&[TAG_CTRL]);
    shared.line("~2 job/cancel 1");
    // 一次 poll 就把这一行的字节读干了：必须直接交出"传输途中收到控制帧"
    assert_eq!(
        wire.poll(&mut chunk),
        Step::TransferFrame,
        "传输途中的控制帧必须交出去"
    );
    let abort = wire.take_pending().expect("取消帧要能取出来");
    assert_eq!(abort.id, 2);
    assert_eq!(abort.body, "job/cancel 1");
    // 被中断那条的号可以被调用方切回去，补一条 `~1 ERR cancelled`
    wire.set_reply_id(1);
    assert_eq!(wire.reply_id(), 1);
}

#[test]
fn slot_len_is_clamped_to_the_buffer() {
    let (mut wire, shared) = connected("~1 store/put A.BLOB 100");
    let mut chunk = [0u8; 4];
    // 调用方给的块比缓冲大：只收 `buf.len()` 个，剩下的留给下一槽
    wire.begin_recv_slot(9999);
    shared.feed(&[TAG_DATA, 1, 2, 3, 4]);
    let Step::ChunkDone { got } = wire.poll(&mut chunk) else {
        panic!("没收满")
    };
    assert_eq!(got, 4);
    assert_eq!(chunk, [1, 2, 3, 4]);
}

// ---------------------------------------------------------------- 块 ACK

#[test]
fn reads_ack_with_received_byte_count() {
    let (mut wire, shared) = connected("~1 store/get A.BLOB 0 512");
    wire.begin_ack();
    shared.ack(300);
    let mut got = [0u8; 1];
    let Step::Ack(outcome) = wire.poll(&mut got) else {
        panic!("没读到 ACK")
    };
    assert_eq!(outcome, AckOutcome::Acked(300));
}

/// 等 ACK 时主机发来一行控制帧 = 它不等这次传输了：`Aborted` + 帧留给调用方
#[test]
fn host_may_leave_the_transfer_mid_ack() {
    let (mut wire, shared) = connected("~1 store/get A.BLOB 0 512");
    wire.begin_ack();
    shared.line("~2 job/cancel 1");
    let mut got = [0u8; 1];
    let Step::Ack(outcome) = wire.poll(&mut got) else {
        panic!("没判出 Aborted")
    };
    assert_eq!(outcome, AckOutcome::Aborted);
    assert_eq!(
        wire.take_pending().map(|r| r.body),
        Some(String::from("job/cancel 1"))
    );
}

/// 半截 ACK 之后又来啦一个 `06`：重新起头，不要把旧前缀当新 ACK 的一部分
#[test]
fn half_ack_then_restart() {
    let (mut wire, shared) = connected("~1 store/get A.BLOB 0 512");
    wire.begin_ack();
    shared.feed(&[CHUNK_ACK[0]]);
    let mut got = [0u8; 1];
    assert!(matches!(wire.poll(&mut got), Step::Nothing));
    shared.ack(16);
    let Step::Ack(outcome) = wire.poll(&mut got) else {
        panic!("没读到 ACK")
    };
    assert_eq!(outcome, AckOutcome::Acked(16));
}

/// 前缀第二个字节不对：整段重来（可能是载荷残字节），不能拼出假计数
#[test]
fn bad_ack_prefix_is_rejected() {
    let (mut wire, shared) = connected("~1 store/get A.BLOB 0 512");
    wire.begin_ack();
    shared.feed(&[CHUNK_ACK[0], b'X', 0x10, 0x00]);
    let mut got = [0u8; 1];
    for _ in 0..4 {
        assert!(
            matches!(wire.poll(&mut got), Step::Nothing),
            "错前缀不能当 ACK"
        );
    }
    shared.ack(8);
    let Step::Ack(outcome) = wire.poll(&mut got) else {
        panic!("没读到 ACK")
    };
    assert_eq!(outcome, AckOutcome::Acked(8));
}

// ---------------------------------------------------------------- 超时

#[test]
fn ack_timeout_reports_timeout_and_recovers() {
    let (mut wire, shared) = connected("~1 store/get A.BLOB 0 512");
    wire.begin_ack();
    let deadline = wire.deadline_us().expect("等 ACK 有超时");
    shared.pass_deadline(deadline);
    let mut got = [0u8; 1];
    assert_eq!(wire.poll(&mut got), Step::Ack(AckOutcome::Timeout));
    // 超时之后回到空闲：下一条请求照常收
    shared.line("~2 job/stop");
    let Step::Request(request) = wire.poll(&mut got) else {
        panic!("超时后没能恢复")
    };
    assert_eq!(request.id, 2);
}

/// 载荷只到一半就没了：如实报告收到多少，调用方据此判失败
#[test]
fn short_chunk_times_out_with_the_bytes_that_arrived() {
    let (mut wire, shared) = connected("~1 store/put A.BLOB 1024");
    let mut chunk = [0u8; 1024];
    wire.begin_recv_slot(chunk.len());
    shared.feed(&[TAG_DATA]);
    shared.feed(&[1u8; 300]);
    // 300 字节到了但没收满：状态机守着缓冲，不返回结论
    assert!(matches!(wire.poll(&mut chunk), Step::Nothing));
    assert_eq!(&chunk[..300], &[1u8; 300], "收到的字节要留在缓冲里");
    // 主机再没发东西：超时收场，并把"已经收到 300"如实交出去
    let deadline = wire.deadline_us().expect("等载荷有超时");
    shared.pass_deadline(deadline);
    assert_eq!(wire.poll(&mut chunk), Step::TimedOut { got: 300 });
    // 超时之后回到空闲，下一条请求照常收
    shared.line("~2 job/stop");
    let Step::Request(request) = wire.poll(&mut chunk) else {
        panic!("超时后没能恢复")
    };
    assert_eq!(request.body, "job/stop");
}

/// 标签之后一个字节都没来：也是短读（`got = 0`），不能卡在这一槽
#[test]
fn missing_payload_after_tag_times_out() {
    let (mut wire, shared) = connected("~1 store/put A.BLOB 1024");
    let mut chunk = [0u8; 1024];
    wire.begin_recv_slot(chunk.len());
    shared.feed(&[TAG_DATA]);
    assert!(matches!(wire.poll(&mut chunk), Step::Nothing));
    let deadline = wire.deadline_us().expect("等标签也算超时");
    shared.pass_deadline(deadline);
    assert_eq!(wire.poll(&mut chunk), Step::TimedOut { got: 0 });
}

/// 空闲阶段没有超时：没主机时固件不能自己转起来（也绝不能饿死看门狗）
#[test]
fn idle_has_no_deadline() {
    let wire = Wire::new(Shared::new());
    assert!(wire.deadline_us().is_none());
}

// ---------------------------------------------------------------- 忙时的非阻塞读

#[test]
fn try_request_while_busy_is_non_blocking() {
    let shared = Shared::new();
    let mut wire = Wire::new(shared.clone());
    assert!(wire.try_request().is_none(), "没字节时立刻返回，不许等");
    shared.line("~3 job/stop");
    let request = wire.try_request().expect("忙的时候也要能收到停止");
    assert_eq!(request.id, 3);
    assert_eq!(request.body, "job/stop");
}

#[test]
fn try_request_hands_over_a_pending_frame() {
    let (mut wire, shared) = connected("~1 store/put A.BLOB 2048");
    wire.begin_recv_slot(1024);
    shared.feed(&[TAG_CTRL]);
    shared.line("~2 job/cancel 1");
    let mut buf = [0u8; 1];
    let mut saw = false;
    for _ in 0..32 {
        if matches!(wire.poll(&mut buf), Step::TransferFrame) {
            saw = true;
            break;
        }
    }
    assert!(saw, "取消帧没被读出来");
    let request = wire.try_request().expect("pending 要优先交出去");
    assert_eq!(request.body, "job/cancel 1");
}

#[test]
fn host_activity_is_visible() {
    let (mut wire, shared) = connected("~1 job/start");
    assert!(wire.host_active(1_000_000));
    shared.advance(10_000_000);
    assert!(!wire.host_active(1_000_000), "好久没请求就该判主机走了");
}

#[test]
fn reset_line_clears_a_half_read_line() {
    let (mut wire, shared) = connected("~1 store/list");
    shared.feed(b"~2 sto");
    let mut buf = [0u8; 1];
    assert!(matches!(wire.poll(&mut buf), Step::Nothing));
    wire.reset_line();
    shared.line("~3 job/stop");
    let Step::Request(request) = wire.poll(&mut buf) else {
        panic!("reset 后读不到新命令")
    };
    assert_eq!(request.id, 3);
}

// ---------------------------------------------------------------- 主动推的通知

/// 通知由调用方的把手拼词，而且和应答共用同一条"必须 flush 才交给主机"的写路径
#[test]
fn queued_notices_are_flushed_through_the_render_hook() {
    let (mut wire, shared) = connected("~1 job/start");
    wire.queue_notice("PROGRESS", "3 28");
    wire.queue_notice("START", "");
    assert_eq!(wire.flush_notices(note), 2, "两条都该发出去");
    assert_eq!(shared.tx_text(), "~0 note PROGRESS 3 28\n~0 note START\n");
}

/// 同类只留最新：循环很快时主机只该看到最后那一步
#[test]
fn same_kind_notices_merge_before_flush() {
    let (mut wire, shared) = connected("~1 job/start");
    wire.queue_notice("PROGRESS", "1 28");
    shared.advance(2_000_000);
    wire.queue_notice("PROGRESS", "2 28");
    assert_eq!(wire.flush_notices(note), 1);
    assert_eq!(
        shared.tx_text(),
        "~0 note PROGRESS 2 28\n",
        "旧的那步不该再发"
    );
}

/// 限速只作用在调用方点名的那个名字上，没点名谁都不限
#[test]
fn only_the_named_notice_is_rate_limited() {
    let (mut wire, shared) = connected("~1 job/start");
    shared.clear_tx();
    wire.set_notice_throttle(Some("PROGRESS"), 1_000_000);
    wire.queue_notice("PROGRESS", "1 28");
    wire.queue_notice("PROGRESS", "2 28");
    assert_eq!(wire.flush_notices(note), 1, "窗口内的第二条被吃掉");
    assert_eq!(shared.tx_text(), "~0 note PROGRESS 1 28\n");
    // 别的名字不受限速影响
    wire.queue_notice("DONE", "");
    assert_eq!(wire.flush_notices(note), 1);
    assert!(shared.tx_text().ends_with("~0 note DONE\n"));
}

/// **主机不取字节时必须立刻停推**：这是"推通知不能拖慢热循环"的铁律。
///
/// 真实形状：主机走了以后 TX FIFO 一直满着，[`Wire::write_raw`] 会为每个字节烧完
/// 100ms 预算 —— 一行二十几个字节就是两秒。所以通知走"一次 flush 失败就收手"，
/// 并且之后不再试，直到下一条**请求**到达（请求到得了才说明主机回来了）。
#[test]
fn notices_stop_being_pushed_when_the_host_is_not_reading() {
    let (mut wire, shared) = connected("~1 job/start");
    shared.stick();
    let before = shared.now();
    wire.queue_notice("PROGRESS", "1 28");
    assert_eq!(wire.flush_notices(note), 0, "写不出去就该报 0 条");
    // 没烧超时预算：假时钟每问一次走 1us，真机这里是"每一字节最多 100ms"
    let burned = shared.now().saturating_sub(before);
    assert!(burned < 1_000, "停推不该烧超时预算：多走了 {burned}us");
    assert!(!wire.pushing_notices(), "该记住主机没在取");
    // 队列里那条也不再试（省带宽），直到下一条请求
    wire.queue_notice("PROGRESS", "2 28");
    assert_eq!(wire.flush_notices(note), 0);
}

/// 下一条请求到达 = 主机又在看：恢复推送
#[test]
fn a_new_request_resumes_notice_push() {
    let (mut wire, shared) = connected("~1 job/start");
    shared.stick();
    wire.queue_notice("STOP", "");
    assert_eq!(wire.flush_notices(note), 0);
    shared.unstick();
    request_id(&mut wire, &shared, "~2 device/ping");
    assert!(wire.pushing_notices());
    assert_eq!(wire.flush_notices(note), 1);
    assert_eq!(shared.tx_text(), "~0 note STOP\n");
}

/// **裸载荷区间里一条通知都不许发**：那时串口被裸字节占着，
/// 混进任何字节都会让两边一起错位（和"载荷循环里不许打日志"是同一条铁律）。
#[test]
fn no_notices_inside_the_payload_interval() {
    let (mut wire, shared) = connected("~1 store/get A.BLOB");
    announce_blob(&mut wire, 4096);
    assert!(wire.payload_open());
    wire.queue_notice("PROGRESS", "1 28");
    assert_eq!(wire.flush_notices(note), 0, "载荷区间内不发通知");
    wire.ok();
    assert_eq!(wire.flush_notices(note), 1, "载荷区间关掉之后照发");
    let text = shared.tx_text();
    assert!(text.contains("~1 OK\n"), "应答在前：{text}");
    assert!(
        text.ends_with("~0 note PROGRESS 1 28\n"),
        "通知在后：{text}"
    );
}

/// 一轮工作结束清掉待发进度：迟到的进度会把界面跳回上一步
#[test]
fn clearing_notices_forgets_stale_progress() {
    let (mut wire, shared) = connected("~1 job/start");
    wire.queue_notice("PROGRESS", "9 28");
    wire.clear_notices();
    assert_eq!(wire.flush_notices(note), 0);
    assert_eq!(shared.tx_text(), "");
}

/// 没握过手（还没收到任何请求）时一个字都不推
#[test]
fn nothing_is_pushed_before_the_first_request() {
    let shared = Shared::new();
    let mut wire = Wire::new(shared.clone());
    wire.queue_notice("PROGRESS", "1 28");
    assert_eq!(wire.flush_notices(note), 0);
    assert!(shared.tx().is_empty());
}

/// 等 ACK 时收到控制帧：状态机**一个字都不回**（调用方才可以决定回什么）。
///
/// 为什么单独钉这条：如果调用方在"载荷区间还开着"时就回一句 `ERR stale`，
/// 那行 ASCII 会被主机当载荷读进缓冲，整次传输一起错位。所以"不该答的取消只能
/// 丢掉"这条规则的**地基**是：状态机在 ACK 阶段绝不自己发东西。
#[test]
fn a_control_frame_during_ack_emits_nothing() {
    let (mut wire, shared) = connected("~1 store/get A.BLOB 0 512");
    shared.clear_tx();
    wire.begin_ack();
    // 点名错了的取消（在飞的是 1）
    shared.line("~2 job/cancel 9");
    let mut got = [0u8; 1];
    let Step::Ack(outcome) = wire.poll(&mut got) else {
        panic!("没判出 Aborted")
    };
    assert_eq!(outcome, AckOutcome::Aborted);
    assert!(
        shared.tx().is_empty(),
        "等 ACK 阶段收到控制帧时，状态机不许写任何字节：{:?}",
        shared.tx()
    );
    // 应答目标被 `take_pending` 切到取消帧自己 —— 调用方要继续传输必须显式切回去
    let abort = wire.take_pending().expect("取消帧要能取出来");
    assert_eq!(abort.body, "job/cancel 9");
    assert_eq!(wire.reply_id(), abort.id);
    wire.set_reply_id(1);
    assert_eq!(wire.reply_id(), 1, "切回被中断那条，传输才能继续");
}
