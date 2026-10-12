//! 设备**主动推给主机**的通知队列：机制在这一层，内容在调用方那层。
//!
//! 为什么要它：状态"只能问"的话，主机要么高频轮询、要么在关键时刻滞后一个轮询周期，
//! 而轮询本身还要和用户的手动操作抢同一条串口队列。通知把方向反过来：**有事设备说，
//! 没事主机不用问**。
//!
//! ## 一条字节都不许多占
//!
//! 通知往往产生在**性能敏感的循环边界**上，而那些路径通常不许从堆分配（嵌入式上堆
//! 本来就小，分配失败还可能把后面的分配一起打死）。
//! 所以 [`Events`] 用固定长度数组 + 内联参数缓冲，**不 `alloc`**：参数超过 `ARG_MAX`
//! 就整条丢掉并计数，而不是扩容。
//!
//! ## 合并与限速（策略由调用方设定）
//!
//! - **同名只保留最新一条**（旧的立刻过期，发出去只会挤占带宽）—— 这条对所有种类都成立；
//! - **限速**只对调用方指定的那**一个**名字生效：[`Events::set_throttle`]，
//!   没设就谁都不限。某个具体业务可能想限"进度类"通知（例如每秒最多一条），
//!   那是业务节奏，由调用方在初始化时设进来，不在这里。
//!
//! 队列满就丢新的，**绝不阻塞发送** —— 通知是"省掉轮询"的便利，不该变成主循环的负担。

use core::fmt;
use core::str;

/// 待发队列的长度上限
const QUEUE_MAX: usize = 4;
/// 一条通知参数的字节上限（`65535 65535 1234ABCD.ANM` 这种形状也放得下）
const ARG_MAX: usize = 48;

/// 事件参数的**栈上**拼装缓冲（同样 `ARG_MAX` 字节上限）。
///
/// 通知的参数是 `2 5 CC724A98.DATA` 这种拼出来的字符串，而产生通知的那条路径常常
/// **不许碰堆**。这里用固定数组 + [`fmt::Write`]，放不下就把已写的截断 —— 少一个
/// 字段不会比"热循环卡住"更糟。
pub struct ArgsBuf {
    buf: [u8; ARG_MAX],
    len: usize,
}

impl ArgsBuf {
    pub fn new() -> Self {
        ArgsBuf {
            buf: [0u8; ARG_MAX],
            len: 0,
        }
    }

    /// 已经拼出来的那一段（超长部分被丢掉）
    pub fn as_str(&self) -> &str {
        str::from_utf8(&self.buf[..self.len]).unwrap_or("")
    }
}

impl Default for ArgsBuf {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Write for ArgsBuf {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        let raw = s.as_bytes();
        // 放不下的部分直接不写（而不是报错中断整条格式化）：宁可参数短一截
        let take = raw.len().min(self.buf.len() - self.len);
        self.buf[self.len..self.len + take].copy_from_slice(&raw[..take]);
        self.len += take;
        Ok(())
    }
}

/// 一条待发通知：名字 + 内联参数。
///
/// **不用 `String`**（见模块文档的零分配约定）：参数固定在 `ARG_MAX` 字节里，
/// 于是队列可以是 `static`、可以进 `.bss`，热路径一个字节都不必从堆上要。
/// [`Events::pop`] 把它**按值交出去**，所以调用方拿到的是自己的那一份，随便留多久。
#[derive(Clone)]
pub struct Event {
    name: &'static str,
    args: [u8; ARG_MAX],
    len: u8,
}

impl Event {
    fn new(name: &'static str, args: &str) -> Option<Self> {
        let raw = args.as_bytes();
        if raw.len() > ARG_MAX {
            return None;
        }
        let mut buf = [0u8; ARG_MAX];
        buf[..raw.len()].copy_from_slice(raw);
        Some(Event {
            name,
            args: buf,
            len: raw.len() as u8,
        })
    }

    /// 通知名（常量由调用方定义，本 crate 不解释）
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// 参数原文（`frame 12 28` 里的 `12 28`）
    pub fn args(&self) -> &str {
        // 参数只可能是 ASCII（文件名、数字），不是 UTF-8 就当空
        str::from_utf8(&self.args[..self.len as usize]).unwrap_or("")
    }
}

/// 设备侧的通知待发队列（见模块文档的合并、限速与零分配约定）
pub struct Events {
    /// 已占用的槽：`None` = 空位
    slots: [Option<Event>; QUEUE_MAX],
    /// 限速作用在**哪个名字**上；`None` = 谁都不限（策略由调用方 [`Events::set_throttle`] 给）
    throttled: Option<&'static str>,
    /// 上一条**被限速的那种**通知发出去的时刻（微秒）；`None` = 还没发过
    last_throttled_us: Option<u64>,
    /// 限速的最小间隔（微秒）；只在 [`Self::throttled`] 有值时用
    throttle_us: u64,
    /// 因为队列满或参数过长而丢掉的通知数（排查"主机没收到通知"时的证据）
    dropped: u32,
}

impl Default for Events {
    fn default() -> Self {
        Self::new()
    }
}

impl Events {
    pub const fn new() -> Self {
        Events {
            slots: [None, None, None, None],
            throttled: None,
            last_throttled_us: None,
            throttle_us: 0,
            dropped: 0,
        }
    }

    /// 给**某一个名字**设限速：距上一条不足 `interval_us` 就直接丢掉新的。
    ///
    /// 只支持"一种限速"是刻意的：多数业务只需要限住进度那一类，多一种限速就要多一个
    /// 时间戳字段，而这块内存要进 `.bss`。`None` 关掉限速。
    pub fn set_throttle(&mut self, name: Option<&'static str>, interval_us: u64) {
        self.throttled = name;
        self.throttle_us = interval_us;
        self.last_throttled_us = None;
    }

    /// 排入一条通知；**同名只保留最新一条**。
    ///
    /// `now_us` 只用来判限速（ [`Events::set_throttle`] 设过才生效）：那种通知距上一条
    /// 不够久就直接丢掉 —— 丢一条进度不丢人，主循环还在跑。
    pub fn push(&mut self, name: &'static str, args: &str, now_us: u64) {
        if self.throttled == Some(name) {
            if let Some(last) = self.last_throttled_us {
                if now_us.saturating_sub(last) < self.throttle_us {
                    return;
                }
            }
            self.last_throttled_us = Some(now_us);
        }
        let Some(event) = Event::new(name, args) else {
            // 参数放不下：丢掉并计数，绝不为了它去动堆
            self.dropped += 1;
            return;
        };
        // 同类只留最新：**位置不变**，只换内容（保持"play 先于 item"这类相对顺序）
        if let Some(existing) = self
            .slots
            .iter_mut()
            .find(|item| item.as_ref().is_some_and(|held| held.name == name))
        {
            *existing = Some(event);
            return;
        }
        if let Some(empty) = self.slots.iter_mut().find(|item| item.is_none()) {
            *empty = Some(event);
            return;
        }
        // 队列满：丢新的，不阻塞
        self.dropped += 1;
    }

    /// 取下一条待发通知（按入队顺序；队列空返回 `None`）。交出去的是**owned** 的一份。
    pub fn pop(&mut self) -> Option<Event> {
        self.slots[self.next_index()?].take()
    }

    /// 下一条待发通知是**谁**（不出队）：发送失败时它必须留着重试。
    pub fn peek(&self) -> Option<&Event> {
        self.slots[self.next_index()?].as_ref()
    }

    /// 把队首出队（配合 [`Events::peek`]：确认写出去了才丢）
    pub fn discard_front(&mut self) {
        if let Some(index) = self.next_index() {
            self.slots[index] = None;
        }
    }

    /// 第一个非空槽的下标（槽位顺序就是入队顺序）
    fn next_index(&self) -> Option<usize> {
        self.slots.iter().position(|slot| slot.is_some())
    }

    /// 有没有等着发的通知
    pub fn is_empty(&self) -> bool {
        self.slots.iter().all(|slot| slot.is_none())
    }

    /// 队列里还压着几个
    pub fn len(&self) -> usize {
        self.slots.iter().filter(|slot| slot.is_some()).count()
    }

    /// 因为队列满 / 参数过长丢掉了几个
    pub fn dropped(&self) -> u32 {
        self.dropped
    }

    /// 清空（一轮工作结束、旧进度没有意义时；限速窗口也一起重来）。
    ///
    /// 限速窗口必须跟着重来：否则刚停又开，第一条进度会因为"离上一条不够久"被吃掉，
    /// 主机要等一整个窗口才知道新的那轮播到哪儿了。
    pub fn clear(&mut self) {
        for slot in self.slots.iter_mut() {
            *slot = None;
        }
        self.last_throttled_us = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::String;

    // 通知的名字由调用方定：测试里用一组中性名字，免得这里出现任何业务词
    const START: &str = "start";
    const ITEM: &str = "item";
    const ROUND: &str = "round";
    const PROGRESS: &str = "progress";
    const FAULT: &str = "fault";
    const DONE: &str = "done";
    /// 限速窗口：一帧一条足够画进度条
    const WINDOW_US: u64 = 1_000_000;

    /// 建一个"只限 progress 这种"的队列
    fn throttled() -> Events {
        let mut events = Events::new();
        events.set_throttle(Some(PROGRESS), WINDOW_US);
        events
    }

    #[test]
    fn same_name_keeps_only_the_newest() {
        let mut events = Events::new();
        events.push(PROGRESS, "1 28", 0);
        events.push(PROGRESS, "2 28", 1_100_000);
        events.push(PROGRESS, "3 28", 2_200_000);
        assert_eq!(events.len(), 1, "同名只留最新一条");
        let first = events.pop().expect("该有一个");
        assert_eq!(first.name(), PROGRESS);
        assert_eq!(first.args(), "3 28");
        assert!(events.pop().is_none());
    }

    /// 设了限速的那一种：一个窗口一条，中间那几条直接丢
    #[test]
    fn the_throttled_name_is_rate_limited() {
        let mut events = throttled();
        events.push(PROGRESS, "1 28", 1_000_000);
        events.push(PROGRESS, "2 28", 1_400_000);
        events.push(PROGRESS, "3 28", 1_800_000);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events.pop().map(|item| String::from(item.args())),
            Some(String::from("1 28"))
        );
        // 离上一条超过一个窗口的那一条可以进来
        events.push(PROGRESS, "4 28", 2_100_000);
        assert_eq!(
            events.pop().map(|item| String::from(item.args())),
            Some(String::from("4 28"))
        );
    }

    /// 没设限速时谁都不限（策略完全由调用方开关）
    #[test]
    fn nothing_is_limited_without_a_throttle() {
        let mut events = Events::new();
        events.push(PROGRESS, "1 28", 0);
        events.push(PROGRESS, "2 28", 10);
        assert_eq!(events.len(), 1, "同名合并，但不该被时间吃掉");
    }

    /// 别的名字不受限速影响（收尾、报错这种关键时刻不能丢）
    #[test]
    fn other_names_are_not_rate_limited() {
        let mut events = throttled();
        events.push(START, "", 0);
        events.push(ITEM, "2 5 CC724A98.DATA", 10);
        events.push(ROUND, "3", 20);
        events.push(DONE, "", 30);
        assert_eq!(events.len(), 4);
        let order = [START, ITEM, ROUND, DONE];
        for name in order {
            let item = events.pop().expect("队列不该提前空");
            assert_eq!(item.name(), name, "要按入队顺序发");
        }
        assert!(events.pop().is_none());
    }

    /// 队列满：丢掉新的，绝不阻塞发送。
    ///
    /// 用**不同名字**填满它：同名只保留最新一条，永远堆不到上限。
    #[test]
    fn full_queue_drops_instead_of_blocking() {
        let mut events = throttled();
        let names = [START, ITEM, ROUND, PROGRESS, FAULT, DONE];
        for (index, name) in names.iter().enumerate() {
            // 每个都隔开一个窗口以上，免得被限速吃掉（限速是另一种丢弃）
            events.push(name, "x", (index as u64 + 1) * 2_000_000);
        }
        assert_eq!(events.len(), QUEUE_MAX);
        assert!(events.dropped() > 0);
    }

    /// 参数放不下：丢掉并计数（不许为了长参数动堆）
    #[test]
    fn oversized_args_are_dropped() {
        let mut events = Events::new();
        let long = String::from("y").repeat(ARG_MAX + 1);
        events.push(FAULT, &long, 0);
        assert!(events.is_empty());
        assert_eq!(events.dropped(), 1);
        // 正好放得下的要收进来
        let exact = String::from("y").repeat(ARG_MAX);
        events.push(FAULT, &exact, 1);
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn clear_forgets_stale_progress() {
        let mut events = throttled();
        events.push(PROGRESS, "9 28", 0);
        events.clear();
        assert!(events.is_empty());
        // 清空之后限速窗口也要重来，否则新一轮的第一条进度会被限速吃掉
        events.push(PROGRESS, "1 28", 0);
        assert_eq!(
            events.pop().map(|item| String::from(item.args())),
            Some(String::from("1 28"))
        );
    }

    #[test]
    fn same_name_keeps_its_position() {
        let mut events = throttled();
        events.push(START, "", 0);
        events.push(PROGRESS, "1 28", 0);
        events.push(ITEM, "1 1 A.DATA", 0);
        // 刷新中间那个 progress：顺序应该还是 start → progress → item
        events.push(PROGRESS, "2 28", 2_000_000);
        let order = [START, PROGRESS, ITEM];
        for name in order {
            assert_eq!(events.pop().map(|item| item.name()), Some(name));
        }
    }

    /// 编译期就该是个不碰堆的东西（`const fn` 构造 = 可以放进 `.bss`/`static`）
    #[test]
    fn queue_is_constructible_without_allocating() {
        static QUEUE: Events = Events::new();
        // 只取引用，不移动：证明它可以是 `static`
        assert!(QUEUE.is_empty());
    }
}
