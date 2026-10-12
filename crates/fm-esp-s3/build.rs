fn main() {
    stamp();
    // 注意：这里**不**调 `linker_be_nice()`。它注入的 `--error-handling-script` 是 rust-lld
    // 的参数，而 Xtensa 目标用的是 esp 工具链里的 `xtensa-esp32s3-elf-gcc`（GNU ld），
    // 认不出这个参数会直接链接失败。C6 那份是 riscv + rust-lld，所以那边留着。
    //
    // 另一件事：GNU ld 默认会对"RWX 权限的 LOAD 段"发警告；这片内存布局
    // （IRAM 可执行 + 数据段）是 esp-hal 那一侧给定的，不是本项目能改的，所以把这条
    // 噪音关掉。注意这个参数要 binutils ≥ 2.39（esp 工具链 15.x 满足）。
    println!("cargo:rustc-link-arg=-Wl,--no-warn-rwx-segments");
    println!("cargo:rustc-link-arg=-Tdefmt.x");
    // make sure linkall.x is the last linker script (otherwise might cause problems with flip-link)
    println!("cargo:rustc-link-arg=-Tlinkall.x");
}

/// 把"编译日期"和"给用户看的网页地址"塞进固件。
///
/// - 日期：屏幕欢迎页要显示；不引 chrono，直接用 civil-from-days 算公历（UTC 日期）。
/// - 地址：默认本机开发用的 `http://localhost:3000`，CI 里用
///   `PET_BOARD_HINT_URL=https://<user>.github.io/<repo>/ cargo build` 覆盖。
fn stamp() {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    println!("cargo:rustc-env=BUILD_DATE={year:04}-{month:02}-{day:02}");

    let url = std::env::var("PET_BOARD_HINT_URL")
        .unwrap_or_else(|_| String::from("http://localhost:3000"));
    println!("cargo:rustc-env=HINT_URL={url}");

    // 声明了 rerun-if-* 之后 cargo 就只按这些条件重跑，所以源码目录也要显式列上，
    // 否则改了固件源码日期不会跟着更新。
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=PET_BOARD_HINT_URL");
}

/// 距 1970-01-01 的天数 → (年, 月, 日)。Howard Hinnant 的 `civil_from_days`。
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}
