/**
 * 跨语言一致性：把 Rust **真实实现**跑出来的期望表（`crates/fm-core/tests/fixtures/frames.jsonl`，
 * 由 `cargo run --features gen --bin wiregen -- fixtures` 生成）逐条重放到网页这一份镜像实现上。
 *
 * 为什么要这一层：网页不引 WASM（协议层只有字符串规则，编整个 crate 不值当），代价是
 * `frames.ts` 是**手写镜像**。镜像会漂移 —— 上一轮"每一次 `media/get` 都失败"就是同一条约定
 * 写在三处、只改了一处。这里把字节→行、行→帧、正文→命令、逐行装配四类答案全部钉住，
 * Rust 那边改了规则忘了同步，测试就红。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  SentinelScanner,
  encodeData,
  encodeEnd,
  encodeErr,
  encodeEvent,
  encodeOk,
  encodeOkLines,
  encodeReady,
  encodeRequest,
  parseCommand,
  parseControlLine,
  ReplyReader,
} from '@/lib/serial/frames';

/** fixture 的绝对路径：从测试文件往上四级就是仓库根 */
const FIXTURE = new URL(
  '../../../../crates/fm-core/tests/fixtures/frames.jsonl',
  import.meta.url,
);

interface FixtureCase {
  kind: string;
  [key: string]: unknown;
}

function cases(): FixtureCase[] {
  const raw = readFileSync(FIXTURE, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => JSON.parse(line) as FixtureCase);
}

const ALL = cases();

/** 按题型取出场景，顺便断言"这一类题不是空的"（生成器改坏了要能发现） */
function pick(kind: string): FixtureCase[] {
  const found = ALL.filter((item) => item.kind === kind);
  expect(found.length, `fixture 里 ${kind} 题型为空`).toBeGreaterThan(0);
  return found;
}

describe('fixture：字节流 → 行（Rust 的 LineScanner 与网页的 SentinelScanner 同答案）', () => {
  // 注意用 SentinelScanner，不用 WireReader：fixture 的 `dropped` 只算"丢掉的外来行/半行"，
  // WireReader 里 defmt 帧还会额外重置行缓冲，计数口径不一样。这些场景的字节里没有 `FF`，
  // 两条路径切出来的**行序列**相同，但只有 SentinelScanner 的 dropped 对得上表。
  for (const item of pick('scan')) {
    it(item.name as string, () => {
      const scanner = new SentinelScanner();
      const lines: string[] = [];
      for (const byte of item.bytes as number[]) {
        const line = scanner.feed(byte);
        if (line !== null) lines.push(line);
      }
      expect(lines).toEqual(item.lines);
      // 每一行是不是控制帧，也要和 Rust 的判定一致
      expect(lines.map((line) => line.startsWith('~'))).toEqual(item.control);
      expect(scanner.dropped()).toBe(item.dropped);
    });
  }
});

describe('fixture：编码形状（网页发出的帧必须和 Rust 拼的一字不差）', () => {
  const encoders: Record<string, () => string> = {
    request: () => encodeRequest(1, 'device/info'),
    ok: () => encodeOk(12),
    okLines: () => encodeOkLines(12, 3),
    end: () => encodeEnd(12),
    err: () => encodeErr(12, 'busy'),
    ready: () => encodeReady(4),
    data: () => encodeData(4, 16384),
    'event-frame': () => encodeEvent('frame', '12 28'),
    'event-play': () => encodeEvent('play', ''),
  };

  for (const item of pick('encode')) {
    it(item.label as string, () => {
      const build = encoders[item.label as string];
      expect(build, `没有 ${item.label} 的编码器`).toBeDefined();
      expect(build!()).toBe(item.wire);
    });
  }
});

describe('fixture：一行 → (id, 正文)（不是控制帧的必须判 null）', () => {
  for (const item of pick('parse')) {
    it(JSON.stringify(item.line), () => {
      // Rust 的 JSON 用 `{"id":..,"reply":{"t":".."}}`，网页的 Message 形状一样
      expect(parseControlLine(item.line as string)).toEqual(item.expect ?? null);
    });
  }
});

describe('fixture：命令正文 → 命令（网页发的那些字符串必须解析成同一条）', () => {
  for (const item of pick('command')) {
    it(item.text as string, () => {
      expect(parseCommand(item.text as string)).toEqual(item.command);
    });
  }
});

describe('fixture：逐行装配应答（ReplyReader 的步序列）', () => {
  for (const item of pick('reply')) {
    it(item.name as string, () => {
      const reader = new ReplyReader();
      const steps = (item.lines as string[]).map((line) => reader.feedLine(line));
      expect(steps).toEqual(item.steps);
    });
  }
});
