//! **PetBoard 业务报文层**的行为测试（只碰公开 API）。
//!
//! 这些是**网页和固件之间的契约**：命令名、参数、`device/info` 的每一行 ——
//! 网页的 `DeviceClient` 就是按这些字符串解析的，改了必须两边一起改。
//! 通用线路机制（成帧、ID 配对、标签槽、ACK、节流）在 `crates/serial` 自己的测试里。

use std::fs;
use std::path::PathBuf;

use fm_core::wire::{
    API_VERSION, Command, GET_CHUNK_C6, IoStats, LOOPS_INFINITE, PlaybackState, device_info_lines,
    parse_command, parse_playlist,
};
use serial::wire;
use serial::{CHUNK_ACK, CHUNK_ACK_COUNT_LEN, SENTINEL, TAG_CTRL, TAG_DATA};

fn name(value: &str) -> String {
    String::from(value)
}

#[test]
fn parses_every_command_the_web_sends() {
    assert_eq!(parse_command("device/info"), Command::DeviceInfo);
    assert_eq!(parse_command("media/list"), Command::MediaList);

    assert_eq!(
        parse_command("media/add A1B2C3D4.ANM 535000"),
        Command::MediaAdd {
            name: name("A1B2C3D4.ANM"),
            len: 535_000
        }
    );

    // 整份 / 只取一段
    assert_eq!(
        parse_command("media/get A1B2C3D4.ANM"),
        Command::MediaGet {
            name: name("A1B2C3D4.ANM"),
            offset: 0,
            len: None
        }
    );
    assert_eq!(
        parse_command("media/get A1B2C3D4.ANM 0 65536"),
        Command::MediaGet {
            name: name("A1B2C3D4.ANM"),
            offset: 0,
            len: Some(65_536)
        }
    );

    assert_eq!(
        parse_command("media/delete A1B2C3D4.ANM"),
        Command::MediaDelete {
            name: name("A1B2C3D4.ANM")
        }
    );

    assert_eq!(
        parse_command("media/play"),
        Command::MediaPlay { start: None }
    );
    assert_eq!(
        parse_command("media/play BBBB2222.ANM"),
        Command::MediaPlay {
            start: Some(name("BBBB2222.ANM"))
        }
    );

    assert_eq!(parse_command("media/stop"), Command::MediaStop);

    assert_eq!(
        parse_command("media/bench A1B2C3D4.ANM"),
        Command::MediaBench {
            name: name("A1B2C3D4.ANM"),
            mib: None
        }
    );
    assert_eq!(
        parse_command("media/bench A1B2C3D4.ANM 4"),
        Command::MediaBench {
            name: name("A1B2C3D4.ANM"),
            mib: Some(4)
        }
    );
}

#[test]
fn rejects_bad_usage_instead_of_guessing() {
    assert_eq!(
        parse_command("device/info now"),
        Command::BadUsage("usage: device/info")
    );
    assert_eq!(
        parse_command("media/list all"),
        Command::BadUsage("usage: media/list")
    );
    assert_eq!(
        parse_command("media/add X.ANM"),
        Command::BadUsage("usage: media/add <name> <len>")
    );
    assert_eq!(
        parse_command("media/add X.ANM 0"),
        Command::BadUsage("bad length")
    );
    assert_eq!(
        parse_command("media/add X.ANM 1 2"),
        Command::BadUsage("usage: media/add <name> <len>")
    );
    assert_eq!(
        parse_command("media/get X.ANM x"),
        Command::BadUsage("bad offset")
    );
    assert_eq!(
        parse_command("media/get X.ANM 0 0"),
        Command::BadUsage("bad length")
    );
    assert_eq!(
        parse_command("media/stop now"),
        Command::BadUsage("usage: media/stop")
    );
    assert_eq!(
        parse_command("media/play A.ANM B.ANM"),
        Command::BadUsage("usage: media/play [<name>]")
    );
}

#[test]
fn unknown_commands_keep_their_text() {
    // 老的扁平命令名不能被当成新命令：必须落到 Unknown
    assert_eq!(
        parse_command("PUT X.ANM 100"),
        Command::Unknown(String::from("PUT"))
    );
    assert_eq!(
        parse_command("LIST"),
        Command::Unknown(String::from("LIST"))
    );
    // 命令名大小写敏感
    assert_eq!(
        parse_command("DEVICE/INFO"),
        Command::Unknown(String::from("DEVICE/INFO"))
    );
    assert_eq!(parse_command(""), Command::Unknown(String::new()));
}

#[test]
fn parses_playlist_text() {
    let text = "\
# Pet Board 播放清单
A1B2C3D4.ANM 20

  BBBB2222.ANM   0  
CCCC3333.ANM not-a-number
DDDD4444.ANM
EEEE5555.ANM 70000
FFFF6666.ANM 1
";
    assert_eq!(
        parse_playlist(text),
        vec![
            (name("A1B2C3D4.ANM"), 20),
            (name("BBBB2222.ANM"), 0),
            (name("FFFF6666.ANM"), 1),
        ],
        "注释/空行/坏行都跳过；行尾空格要能容忍"
    );
    assert!(parse_playlist("").is_empty());
    assert!(parse_playlist("# 只有注释\n").is_empty());
}

#[test]
fn device_info_lines_pin_the_wire_format() {
    let idle = PlaybackState::default();
    assert_eq!(
        device_info_lines(
            "aa:bb:cc:dd:ee:ff",
            "c6-lcd-147",
            32,
            "CoreUsbUart 0x15",
            "microSD 63700MB (FAT)",
            (320, 172),
            &idle,
            IoStats::default()
        ),
        vec![
            String::from("id aa:bb:cc:dd:ee:ff"),
            format!("api {API_VERSION}"), // 版本号从常量来，别在测试里抄死
            String::from("board c6-lcd-147"),
            String::from("chunk 32"),
            String::from("reset CoreUsbUart 0x15"),
            String::from("sd microSD 63700MB (FAT)"),
            String::from("screen 320 172"),
            String::from("playing 0"),
            String::from("io fail 0 tx_stuck 0 ack_timeout 0 host_left 0 resends 0"),
        ]
    );

    let mut playing = PlaybackState::default();
    playing.start("A1B2C3D4.ANM", 2, 5);
    playing.set_loop(3);
    playing.set_frame(7, 28);
    let lines = device_info_lines(
        "aa:bb",
        "s3-lcd-35",
        512,
        "ChipPowerOn 0x01",
        "microSD 8MB (FAT)",
        (480, 320),
        &playing,
        IoStats {
            get_failed: 9,
            tx_stuck: 3,
            ack_timeout: 4,
            host_left: 2,
            resends: 7,
        },
    );
    assert_eq!(lines.len(), 14);
    // 板级参数紧跟版本号：网页先拿到它们，后面的行才好解释
    assert_eq!(lines[2], "board s3-lcd-35");
    assert_eq!(lines[3], "chunk 512");
    assert_eq!(lines[7], "playing 1");
    // I/O 计数也在这条回复里：日志可能被 esp-println 跳过，这几个数不能丢
    assert_eq!(
        lines[8],
        "io fail 9 tx_stuck 3 ack_timeout 4 host_left 2 resends 7"
    );
    assert_eq!(lines[9], "item A1B2C3D4.ANM");
    assert_eq!(lines[10], "index 2");
    assert_eq!(lines[11], "total 5");
    assert_eq!(lines[12], "loop 3");
    assert_eq!(lines[13], "frame 7 28");
}

/// 网页侧常量是**本 crate 生成的**（`web/src/lib/serial/wire.ts`，`pnpm wire`）。
///
/// 这里检查的是"生成物有没有跟着源码一起重生成"：手抄会过期，生成物忘了重生成同样会过期，
/// 所以逐个常量比对，而不是只比版本号。两份生成物（这一份 + 帧切分 fixture）都随仓库跟踪，
/// CI 不再重跑 `wiregen`：这一条测试就是防漂移的闸 —— 改了 Rust 忘了 `pnpm wire` 就红。
#[test]
fn web_constants_match_the_generated_module() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/src/lib/serial/wire.ts");
    let text = fs::read_to_string(&path)
        .expect("读不到网页侧的生成常量 wire.ts —— 跑 `cd web && pnpm wire` 重生成");
    let ack = CHUNK_ACK
        .iter()
        .map(|byte| byte.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let expected: [(&str, String); 10] = [
        ("API_VERSION", API_VERSION.to_string()),
        ("SENTINEL", format!("'{}'", SENTINEL as char)),
        ("CHUNK_UP", wire::CHUNK_UP.to_string()),
        ("GET_CHUNK_FALLBACK", GET_CHUNK_C6.to_string()),
        ("TAG_DATA", TAG_DATA.to_string()),
        ("TAG_CTRL", TAG_CTRL.to_string()),
        ("CHUNK_ACK", format!("new Uint8Array([{ack}])")),
        ("CHUNK_ACK_COUNT_LEN", CHUNK_ACK_COUNT_LEN.to_string()),
        ("MAX_LINE", wire::MAX_LINE.to_string()),
        ("LOOPS_INFINITE", LOOPS_INFINITE.to_string()),
    ];
    for (key, value) in expected {
        let prefix = format!("export const {key} = ");
        let found = text
            .lines()
            .find_map(|line| line.trim().strip_prefix(prefix.as_str()))
            .unwrap_or_else(|| panic!("wire.ts 里少了 {key}"));
        assert_eq!(
            found.trim_end_matches(';').trim(),
            value,
            "{key} 和 Rust 侧对不上：wire.ts 过期了，重跑 `pnpm wire`"
        );
    }
}
