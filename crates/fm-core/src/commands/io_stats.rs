//! `media/get` 的失败分类与累计计数。
//!
//! 日志走 esp-println，丢过一次字节之后会粘滞地整笔跳过，所以失败原因经常根本没写进日志 ——
//! 这几个数改从 `device/info` 带出去（我们自己写的回复一定送得到）。
//!
//! 写方是 [`super::download`]（每完成一次 `media/get` 调 [`record`]），读方是 [`super::info`]。

use core::sync::atomic::{AtomicU32, Ordering};

// `media/get` 的累计计数
static IO_GET_FAILED: AtomicU32 = AtomicU32::new(0);
static IO_TX_STUCK: AtomicU32 = AtomicU32::new(0);
static IO_ACK_TIMEOUT: AtomicU32 = AtomicU32::new(0);
static IO_HOST_LEFT: AtomicU32 = AtomicU32::new(0);
static IO_RESENDS: AtomicU32 = AtomicU32::new(0);

/// `media/get` 失败的原因（也是 `device/info` 里那几个计数的分类）
#[derive(Debug, Clone, Copy)]
pub(super) enum GetFailure {
    /// 卡 / 文件读不出来
    SdRead,
    /// 一块载荷写不出去（TX 卡住）
    TxStuck,
    /// 等主机 ACK 超时
    AckTimeout,
    /// 主机自己先走了（我们主动停手）
    HostLeft,
    /// 补发几轮还是没补齐
    Resend,
    /// 主机报的实收计数对不上（协议串了）
    BadCount,
}

impl GetFailure {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            GetFailure::SdRead => "SD read failed",
            GetFailure::TxStuck => "tx stuck",
            GetFailure::AckTimeout => "ack timeout",
            GetFailure::HostLeft => "host moved on",
            GetFailure::Resend => "resend failed",
            GetFailure::BadCount => "bad ack count",
        }
    }
}

pub(super) fn io_stats() -> crate::wire::IoStats {
    crate::wire::IoStats {
        get_failed: IO_GET_FAILED.load(Ordering::Relaxed),
        tx_stuck: IO_TX_STUCK.load(Ordering::Relaxed),
        ack_timeout: IO_ACK_TIMEOUT.load(Ordering::Relaxed),
        host_left: IO_HOST_LEFT.load(Ordering::Relaxed),
        resends: IO_RESENDS.load(Ordering::Relaxed),
    }
}

/// 记一次 `media/get` 的账：补发次数先累加，失败再按原因分类累加。
pub(super) fn record(resends: u32, failed: Option<GetFailure>) {
    IO_RESENDS.fetch_add(resends, Ordering::Relaxed);
    let Some(reason) = failed else {
        return;
    };
    IO_GET_FAILED.fetch_add(1, Ordering::Relaxed);
    match reason {
        GetFailure::TxStuck => IO_TX_STUCK.fetch_add(1, Ordering::Relaxed),
        GetFailure::AckTimeout => IO_ACK_TIMEOUT.fetch_add(1, Ordering::Relaxed),
        GetFailure::HostLeft => IO_HOST_LEFT.fetch_add(1, Ordering::Relaxed),
        _ => 0,
    };
}
