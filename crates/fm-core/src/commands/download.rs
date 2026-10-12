//! `media/get <文件名> [<偏移> <字节数>]`：把卡上的文件回传给网页。
//!
//! 模块名 `upload` / `download` 一律**以网页为原点**：`upload` = 网页写进卡（板子在收），
//! `download` = 网页从卡里读（板子在发）。线命令本身是方向中性的 `media/add` / `media/get`。
//!
//! 分块节奏和 `media/add`（见 [`super::upload`]）一样，只是方向反过来：**每块发完等主机一个 ACK**。
//! 这是必须的 —— `esp_println` 的写入器在 FIFO 长时间排不空时会丢掉剩下的字节
//! （防止没有主机时永久阻塞），所以不能一口气把整个文件灌出去。
//!
//! 回传的载荷是**裸字节**（前面有 `DATA <字节数>`），所以载荷循环里一条日志都不能打：
//! 日志帧会混进文件内容里。"现在处在裸载荷区间"这件事的权威是协议状态机
//! （[`Link::payload_open`]，由 `data()` 打开、`ok()`/`err()` 关闭），这里的静音开关只是它的镜像。
//!
//! 传输途中只接受 `media/abort <被中断请求的 id>`：收到就立刻停手（不补零、不拖满 ACK
//! 超时），按顺序回 `~<被中断号> ERR aborted` + `~<abort号> OK`。
//!
//! **点名错了的 abort（陈旧取消）在这个方向只能悄悄丢掉**：主机此刻正按 `DATA <字节数>`
//! 读裸字节，我们要是回一句 `~<id> ERR stale`，那行 ASCII 会被它当载荷读进 buffer，整次传输
//! 一起错位（上传方向没这个问题：板子在收，TX 是空的，所以那边可以回 `ERR stale`）。
//! 于是这里只记一笔、传输照常，主机那句 abort 自己会超时收手。

use crate::wire::Request;
use defmt::{debug, warn};
use embassy_time::Instant;
use embedded_sdmmc::{BlockDevice, TimeSource};

use super::io_stats::{GetFailure, record};
use crate::link::{AckOutcome, CHUNK, Link};
use crate::storage::{self, Fs};
use serial::MAX_CHUNK_RESENDS;

/// 回传一块的上限：不能大过发送缓冲
const MAX_GET_CHUNK: usize = CHUNK;

/// 回传途中允许出现几次"点名错了的 abort"，超过就判失败（同一次传输里反复错位没有意义）
const MAX_STALE_ABORTS: u32 = 4;

/// 板子宣告出去的回传块大小（[`crate::BoardConfig::get_chunk`]）夹进合法范围。
///
/// 这个数**必须**和 `device/info` 的 `chunk` 行是同一个值：主机按它收块、
/// 并按"这一块收到多少字节"回 ACK，两边一旦不一致，主机报上来的计数就会大过
/// 固件这一块的实际长度，[`send_chunk`] 直接判 `BadCount` 放弃整次传输。
/// （真机踩过：S3 报 512、这里却写死 32，于是 S3 上**每一次** `media/get` 都失败，
/// 表现是海报全黑、素材显示 0 帧、下载卡到超时。）
fn get_chunk_bytes(declared: usize) -> usize {
    declared.clamp(1, MAX_GET_CHUNK)
}

pub(super) async fn get_cmd<D, T, U>(
    link: &mut Link<U>,
    fs: &Fs<D, T>,
    name: &str,
    offset: u32,
    len: Option<u32>,
    get_chunk: usize,
) where
    U: crate::Serial,
    D: BlockDevice,
    D::Error: defmt::Format,
    T: TimeSource,
{
    let chunk = get_chunk_bytes(get_chunk);
    // 分阶段计时：这条链路上"读卡慢"和"发送慢"完全不是一个修法，日志里必须分得出来
    let opened_at = Instant::now();
    let file = match storage::open(fs, name) {
        Ok(file) => file,
        Err(e) => {
            warn!("media/get: open {} failed: {:?}", name, e);
            link.err("cannot open file");
            return;
        }
    };
    let open_us = opened_at.elapsed().as_micros() as u32;

    let total = file.length();
    if offset >= total {
        let _ = file.close();
        link.err("offset past end");
        return;
    }
    let sought_at = Instant::now();
    if offset > 0 && file.seek_from_start(offset).is_err() {
        let _ = file.close();
        link.err("seek failed");
        return;
    }
    let seek_us = sought_at.elapsed().as_micros() as u32;

    let available = total - offset;
    let want = len.unwrap_or(available).min(available);
    link.data(want);
    // 被中断时要用这个号回 `ERR aborted`（abort 的参数会带它，收尾时按它回两条）
    let interrupted = link.reply_id();
    // 从这里到函数结束都在回传**裸字节**：这期间固件不能打任何日志，否则日志帧会被主机
    // 当成载荷（`PayloadQuiet` 会拦住 `storage` 里那条预读降级告警；其余日志本来就不在这个循环里）。
    let _quiet = PayloadQuiet::new(link.payload_open());

    let mut buf = [0u8; CHUNK];
    let mut sent = 0u32;
    // 三种失败分开记：只打一句 `media/get failed` 分不出"卡读不动"还是"串口没配上"。
    let mut failed: Option<GetFailure> = None;
    let mut host_present = true;
    // 主机明确叫停（`media/abort`）：不算失败，但要欠它两条应答
    let mut aborted: Option<Request> = None;
    // 补发次数：丢字节是这条链路的常态，补了几次是判断串口好不好的关键指标
    let mut resends = 0u32;
    // 读卡 / 发送各花了多少时间（微秒）：括号里那串数字是分阶段的实测
    let mut read_us = 0u32;
    let mut send_us = 0u32;
    // 点名错了的 abort 次数（见文件头的说明：这里不能回话，只能丢掉并记一笔）
    let mut stale_aborts = 0u32;
    while sent < want {
        let n = ((want - sent) as usize).min(chunk);
        // 注意：这里**不能**打日志（哪怕只是想记下读失败的原因）—— 载荷是裸字节，
        // 日志帧混进去两边都会错位。原因通过结尾那句 `media/get failed: … , <原因>` 带出来。
        let reading = Instant::now();
        let read_ok = file.read_exact(&mut buf[..n]).is_ok();
        read_us += reading.elapsed().as_micros() as u32;
        if !read_ok {
            failed = Some(GetFailure::SdRead);
            break;
        }
        let sending = Instant::now();
        let outcome = send_chunk(
            link,
            &buf[..n],
            &mut resends,
            interrupted,
            &mut stale_aborts,
        )
        .await;
        send_us += sending.elapsed().as_micros() as u32;
        match outcome {
            ChunkOutcome::Sent => {}
            ChunkOutcome::Aborted(request) => {
                // 主机在等 ACK 的窗口里点名中断了**这一次**读取：立刻停手，
                // 别补零、也别拖满超时（回执在函数结尾，那时载荷区间已经关了）
                aborted = Some(request);
                host_present = false;
                break;
            }
            ChunkOutcome::Failed(reason) => {
                failed = Some(reason);
                host_present = false;
                break;
            }
        }
        sent += n as u32;
    }

    let _ = file.close();
    if let Some(request) = &aborted {
        // 声明过的 `DATA <want>` 已经把主机钉在"按长度读裸字节"上；它发 abort 就是明确
        // 表示不等了，所以这里**不补零**。应答顺序和被中断的上传一致：先给被中断那条
        // 一个结论，再确认 abort 本身，反过来的话网页会先看到 OK 再看到 aborted。
        record(resends, None);
        link.set_reply_id(interrupted);
        link.err("aborted");
        link.set_reply_id(request.id);
        link.ok();
        // 日志只能打在**回执之后**：`err()`/`ok()` 已经关掉裸载荷区间，此时主机不在按长度
        // 读字节。反过来（先日志后回执）就是真机踩过的坑 —— `DATA 512` 的尾巴后面直接跟一
        // 帧 defmt，主机把帧字节当载荷，整次传输错位（AGENTS.md 的不变量）。
        _quiet.off();
        debug!(
            "media/get aborted: {} ({}/{} bytes, {} resend(s))",
            name, sent, want, resends
        );
        return;
    }
    record(resends, failed);
    if let Some(reason) = failed {
        let read_bytes = sent;
        if host_present {
            // `DATA <want>` 已经发出去了，主机正按这个长度读裸载荷。若这里直接回 ERR，
            // 主机收不到剩余字节，会一直等到超时；用 0 补齐整个声明的长度，最后再回 ERR，
            // 主机读完载荷后会在 `expectOk` 看到 ERR，把这次读取判失败并丢弃填充数据。
            let zeros = [0u8; CHUNK];
            while sent < want {
                let n = ((want - sent) as usize).min(chunk);
                let outcome = send_chunk(
                    link,
                    &zeros[..n],
                    &mut resends,
                    interrupted,
                    &mut stale_aborts,
                )
                .await;
                if let ChunkOutcome::Aborted(request) = outcome {
                    // 补齐途中主机点名叫停：这次读取已经判失败，把 abort 放回待发队列，
                    // 由主循环回它一句 OK —— 命令绝不能凭空消失（网页会干等超时）
                    link.push_pending(request);
                    host_present = false;
                    break;
                }
                if !matches!(outcome, ChunkOutcome::Sent) {
                    // 补齐途中主机也走了/发不出去：停手
                    host_present = false;
                    break;
                }
                sent += n as u32;
            }
        }
        // 主机中途消失/刷新时不要再往 TX FIFO 里塞 ERR：否则新页面重连后
        // 第一条 `device/info` 会先读到这条旧错误，误判成“设备不接受 device/info”。
        if host_present {
            link.err("transfer failed");
        } else {
            // 协议状态机里的"裸载荷区间"必须关掉，否则静音会一直挂着
            _quiet.off();
            link.set_payload(false);
        }
        // 日志排在回执/关区间**之后**：下面这条日志写的是同一路 TX，主机刚按
        // `DATA <want>` 收满裸字节，多出来的一帧 defmt 会被它当成载荷读进 buffer ——
        // 整次传输错位（真机抓包实测：512 字节之后紧跟一帧含 "ack timeout" 的日志帧）。
        // 主机自己走了（刷新页面/关标签）是日常，不是设备故障：那种情况降为 debug，
        // 真正要看见的是读卡失败、TX 卡住、ACK 超时这几类。
        if matches!(reason, GetFailure::HostLeft) {
            debug!(
                "media/get host left: {} ({}/{} bytes, {} resend(s), {} stale abort(s), open {}us seek {}us read {}us send {}us)",
                name, read_bytes, want, resends, stale_aborts, open_us, seek_us, read_us, send_us
            );
        } else {
            warn!(
                "media/get failed: {} ({}/{} bytes, {}, {} resend(s), {} stale abort(s), open {}us seek {}us read {}us send {}us)",
                name,
                read_bytes,
                want,
                reason.as_str(),
                resends,
                stale_aborts,
                open_us,
                seek_us,
                read_us,
                send_us
            );
        }
    } else {
        link.ok();
        // 同上：`ok()` 关掉裸载荷区间之后才允许有日志字节上线
        debug!(
            "media/get done: {} {}..{} ({} bytes, {} resend(s), {} stale abort(s), open {}us seek {}us read {}us send {}us)",
            name,
            offset,
            offset + want,
            want,
            resends,
            stale_aborts,
            open_us,
            seek_us,
            read_us,
            send_us
        );
    }
}

/// 回传载荷期间的"日志静音"开关：进作用域静音，离开（含提前 return）自动解除
struct PayloadQuiet;

impl PayloadQuiet {
    /// `payload_open` 是协议状态机给的事实：它说"正在发裸字节"，这里才静音。
    /// 两边由同一个事实决定，不再各记一遍（传 `false` 说明调用点顺序错了）。
    fn new(payload_open: bool) -> Self {
        debug_assert!(payload_open, "link.data() 之后协议状态必须处在裸载荷区间");
        storage::set_payload_quiet(true);
        PayloadQuiet
    }

    /// 提前解除静音（函数还在作用域内、但载荷已经发完时用它；`Drop` 再调一次无害）
    fn off(&self) {
        storage::set_payload_quiet(false);
    }
}

impl Drop for PayloadQuiet {
    fn drop(&mut self) {
        // 上面已经 off() 过也不报错：`set_payload_quiet` 是幂等的布尔开关
        storage::set_payload_quiet(false);
    }
}

/// 发一块载荷的结果（见 [`send_chunk`]）
enum ChunkOutcome {
    /// 主机确认收全了
    Sent,
    /// 主机点名中断了这次读取（那条 `media/abort` 请求带在这里，收尾要回它两条应答）
    Aborted(Request),
    /// 失败原因
    Failed(GetFailure),
}

/// 把一块载荷发出去，并确认主机**收全了**。
///
/// 主机的 ACK 会带"这一块实际收到多少字节"：少了就把缺的那几个字节原样补发。
/// 发送路径（`esp_println::Printer::write_bytes`）在 FIFO 排不空时会丢掉这一笔的尾巴
/// （见 `docs/esp32-c6-lcd-147.md` §6），1024 字节一块几乎必然要经历它 —— 但这只值一次几十字节的补发，
/// 不必整块重传、更不必等超时。
///
/// **这个函数里一条日志都不能打**：载荷是裸字节，日志帧会混进文件内容里。
///
/// 等 ACK 时收到控制帧分三种，处理完全不同：
/// - 点名中断**这一次**读取的 abort → [`ChunkOutcome::Aborted`]，调用方立刻停手；
/// - 点名错了的（陈旧）abort → **不能回话**（一回话就是往裸载荷里插 ASCII 文本），只记一笔
///   然后重新等 ACK；连续陈旧到 [`MAX_CHUNK_RESENDS`] 次说明主机状态已经错位，按失败收场；
/// - 根本不是 abort 的命令 → 放回待发队列，由主循环在这次传输收场后处理（命令不能凭空消失）。
async fn send_chunk<U: crate::Serial>(
    link: &mut Link<U>,
    data: &[u8],
    resends: &mut u32,
    interrupted: u32,
    stale_aborts: &mut u32,
) -> ChunkOutcome {
    let mut at = 0usize;
    let mut rounds = 0u32;
    // 陈旧 abort 之后**只重新等 ACK、不重发**：那一刻主机没报过实收数，重发会把它已经
    // 收到的字节再发一遍，主机把多出来的字节当新载荷写进 buffer —— 整份文件就错位了。
    let mut send = true;
    loop {
        if send {
            let rest = &data[at..];
            // 写不出去（TX 卡住）就别再等 ACK 了：如实报失败，让网页那边恢复
            if link.bytes(rest) < rest.len() {
                return ChunkOutcome::Failed(GetFailure::TxStuck);
            }
        }
        send = true;
        match link.recv_ack().await {
            AckOutcome::Acked(got) => {
                let got = got as usize;
                if got == data.len() {
                    return ChunkOutcome::Sent;
                }
                if got < at || got > data.len() {
                    // 计数对不上说明协议串了（比如网页和固件版本不匹配），别硬着头皮补发
                    return ChunkOutcome::Failed(GetFailure::BadCount);
                }
                at = got;
                rounds += 1;
                *resends += 1;
                if rounds > MAX_CHUNK_RESENDS {
                    return ChunkOutcome::Failed(GetFailure::Resend);
                }
            }
            AckOutcome::Aborted => {
                match link.take_pending() {
                    // 点名的是这一次读取：交出去，由调用方停手
                    Some(request)
                        if request.command.is_abort()
                            && request.command.abort_target() == Some(interrupted) =>
                    {
                        return ChunkOutcome::Aborted(request);
                    }
                    // 陈旧的 abort：这里回不了话（载荷区间还开着），只能丢掉并继续等 ACK
                    Some(request) if request.command.is_abort() => {
                        send = false;
                        *stale_aborts += 1;
                        // `take_pending` 顺手把应答目标改成了 abort 自己的号；这次传输
                        // 还要继续，末尾那句 `OK` / `ERR` 必须配给被中断的那条，所以切回去。
                        link.set_reply_id(interrupted);
                        if *stale_aborts > MAX_STALE_ABORTS {
                            // 连着几次点名都错：主机那侧状态已经错位，别再陪它绕下去
                            return ChunkOutcome::Failed(GetFailure::HostLeft);
                        }
                        continue;
                    }
                    // 不是 abort：放回待发队列，等这次传输收场后由主循环处理
                    Some(request) => {
                        link.push_pending(request);
                        return ChunkOutcome::Failed(GetFailure::HostLeft);
                    }
                    None => return ChunkOutcome::Failed(GetFailure::HostLeft),
                }
            }
            AckOutcome::Timeout => return ChunkOutcome::Failed(GetFailure::AckTimeout),
        }
    }
}
