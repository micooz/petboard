//! 调用方提供的串口：本项目是芯片原生的 USB-Serial-JTAG。
//!
//! 收在这里是因为**发送节流**是协议语义的一部分：这类 USB 串口的 TX FIFO 只有 64 字节，
//! 而且**只有被 flush 过才会把数据交给主机**，所以"怎么写一个字节"不是外设细节、
//! 而是"报文能不能到达"的一部分。见 [`crate::wire::Wire::write_raw`]。

/// 串口读不出字节时的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SerialError {
    /// 暂时没数据（FIFO 空），等一会儿再来
    WouldBlock,
    /// 外设报错
    Other,
}

/// 串口读写的一个字节的结果。
///
/// 不用 `nb::Result` 是为了不让这一层绑上某个具体的 `nb` 版本：调用方那侧把
/// `nb::Result<_, Infallible>` 映射过来即可（`WouldBlock` 就是这里的一个变体）。
pub type SerialResult<T> = Result<T, SerialError>;

/// 非阻塞串口：方法名与常见嵌入式 HAL 的同名方法一一对应，实现里直接转发即可。
pub trait Serial {
    /// 非阻塞读一个字节
    fn read_byte(&mut self) -> SerialResult<u8>;
    /// 非阻塞写一个字节
    fn write_byte_nb(&mut self, byte: u8) -> SerialResult<()>;
    /// 把 TX FIFO 里剩下不足一包的那截推出去
    fn flush_tx_nb(&mut self) -> SerialResult<()>;
    /// 单调时钟（微秒）。
    ///
    /// 协议状态机的超时（等载荷、等 ACK）和 TX 等待预算都问它，**crate 因此不依赖
    /// 任何异步运行时**：调用方可以转发自己框架的 `Instant`，host 测试里给一个能自己
    /// 拨的假时钟，于是每一条超时分支都能穷举到（旧实现里测试要链接一个假的时钟符号，
    /// 超时分支基本测不了）。
    fn now_us(&mut self) -> u64;
}
