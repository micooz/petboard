# AGENTS.md

Agent-facing guide for this repository. Source comments, JSDoc, and everything
under `docs/` are written in Chinese — match the surrounding language when
editing them. Commit messages and this file are English.

The closest `AGENTS.md` wins. `crates/fm-esp-c6/AGENTS.md`,
`crates/fm-esp-s3/AGENTS.md`, and `web/AGENTS.md` add local context and must be
read before touching their areas. `web/AGENTS.md` contains a generated
Next.js block that `next dev` re-adds — keep it in diffs. `web/CLAUDE.md` just
re-exports `web/AGENTS.md`.

`README.md` is the user-facing entry point: overview, quick start, the hardware
demo recording and the web console screenshot. This file plus the tracked notes
under `docs/` are the agent-facing entry points.

## Project overview

**Pet Board** is an ESP32 photo frame that plays GIF/WebP animations off an SD
card, driven entirely from the browser over Web Serial. The browser uploads
media, arranges a playlist, and presses play; the firmware then loops the
playlist on its own even after the tab is closed.

Three layers, one message vocabulary:

1. **Web** (`web/`) — Next.js 16 static export (`output: 'export'`), React 19,
   Tailwind v4, Radix/shadcn. Connects over the Web Serial API and encodes media
   to the on-card formats through WebAssembly.
2. **Shared Rust** (`crates/fm-core/`, `crates/{anmfmt,bmpfmt,serial,wasmfmt}/`)
   — `fm-core` is the chip-independent `no_std` firmware logic (PetBoard message
   layer `src/wire/`, command implementations, playback engine, Embassy adapter
   `src/link.rs`, FAT storage, screen drawing). The small crates are
   host-testable: the format crates are the authoritative implementations used
   by both firmware and browser, and `serial` is a **generic** wire codec.
3. **Board crates** (`crates/fm-esp-c6/`, `crates/fm-esp-s3/`) — wiring only:
   pins, peripheral init, and adapters for the traits in `fm-core` (`Serial`,
   `BusClock`, `Screen`, `BlockDevice`).

There is **no Cargo workspace**: each crate is standalone with its own
`Cargo.lock`, and the board crates have their own `.cargo/config.toml` with the
target and `espflash` runner pinned. Every `cargo` command is run from the
crate's own directory.

## Repository layout

| Path | What lives here |
| --- | --- |
| `crates/fm-core/` | Shared `no_std` firmware logic. Host-testable. |
| `crates/fm-esp-c6/` | C6 wiring: pins, SPI2 sharing, ST7789 via `mipidsi`, `Serial`/`BusClock` adapters. |
| `crates/fm-esp-s3/` | S3 wiring: QSPI ST77922 driver (`panel.rs` / `qspi.rs` / `st77922_init.rs`), SDIO block device, panel test card (`testcard.rs`). |
| `crates/anmfmt/`, `crates/bmpfmt/` | Authoritative implementations of the two on-card formats. No deps, host-testable. |
| `crates/serial/` | Generic serial wire codec: `~` framing, message-id pairing, tagged transfer slots, chunk ACKs, TX-FIFO throttling, notice queue. |
| `crates/wasmfmt/` | `wasm-bindgen` facade exposing the formats to the browser. |
| `web/` | Next.js static-export UI: Web Serial client, encoders, library/playlist UI, Vitest tests. |
| `scripts/` | `web.sh` (dev server), `flash-c6.sh` / `flash-s3.sh` (+ shared `_common.sh`). |
| `docs/` | Tracked Chinese notes: `anm-format.md` (authoritative `.ANM` spec), `basics.md` (embedded glossary), per-board hardware bring-up. |
| `assets/` | Sample source animations (GIF / WebP sprite sheets). |
| `README.md`, `pet-board-demo.mp4` / `.jpg`, `pet-board-web.png` | User-facing overview plus the tracked demo recording, its poster frame, and the web console screenshot. |
| `.docs/` | Local process notes (debug history, perf measurements). **Gitignored** — absent in a fresh clone, do not rely on it. |

## Setup commands

Web (Node 22, pnpm 12):

```bash
cd web
pnpm install
```

`pnpm test` / `pnpm typecheck` / `pnpm build` work with no Rust toolchain: the
format WASM output `web/src/wasm/pkg/` **is committed**.

Re-run `cd web && pnpm wasm` **only after touching `crates/anmfmt`,
`crates/bmpfmt`, or `crates/wasmfmt`**, and commit the regenerated `pkg/` in the
same change — CI never rebuilds it. That one command needs the rustup
`wasm32-unknown-unknown` target plus a `wasm-bindgen-cli` matching the pinned
`wasm-bindgen` in `crates/wasmfmt/Cargo.toml` (currently `0.2.129`):

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
```

`cd web && pnpm wire` must be re-run after touching `crates/serial` or
`crates/fm-core/src/wire/`. It regenerates two committed files:
`web/src/lib/serial/wire.ts` and `crates/fm-core/tests/fixtures/frames.jsonl`.

Firmware, C6 (RISC-V target ships with rustup; `rust-toolchain.toml` pins
nightly + `rust-src`):

```bash
cd crates/fm-esp-c6 && cargo build --release
```

Firmware, S3 (Xtensa is **not** in rustup; `rust-toolchain.toml` uses
`channel = "esp"`):

```bash
espup install          # one-time: the esp-rs fork toolchain
. ~/export-esp.sh      # every new shell
cd crates/fm-esp-s3 && cargo build --release
```

## Development workflow

Start the web dev server (installs deps, ensures the WASM artifact exists, then
serves on `localhost:3000`):

```bash
./scripts/web.sh                  # add --wire after touching the Rust protocol
./scripts/web.sh --port 5173      # other flags: --wasm, --no-wasm, --no-install
```

Web Serial needs a secure context and a Chromium browser — `https://` or
`http://localhost` only; Firefox and Safari are not supported. The board's
welcome screen prints `http://localhost:3000`, so keep the port in sync or pass
`--hint-url`.

Flash a board (builds release, flashes via `espflash`, opens the monitor):

```bash
./scripts/flash-c6.sh             # --no-monitor to leave the port to the web app
./scripts/flash-s3.sh             # --lcd-test for the panel self-test card
```

`cargo run --release` from each board directory does the same via the `runner`
in `.cargo/config.toml`. There is no Wi-Fi/OTA path: flashing is always over the
board's USB-Serial-JTAG port. `PET_BOARD_HINT_URL` overrides the URL baked into
the welcome screen (`build.rs`).

## Testing instructions

| Area | Command |
| --- | --- |
| `crates/fm-core` | `cargo test` |
| `crates/{anmfmt,bmpfmt,serial,wasmfmt}` | `cargo test` (run from each crate) |
| Web unit tests | `cd web && pnpm test` |
| Web types | `cd web && pnpm typecheck` |
| Formats end-to-end (committed WASM) | `cd web && pnpm test` |
| Rebuild format WASM after `crates/{anmfmt,bmpfmt,wasmfmt}` | `cd web && pnpm wasm` (then commit `pkg/`) |

- `crates/fm-core/tests/wire_contract.rs` pins the business message layer
  (command grammar, `device/info` line format, playlist parsing, generated
  `wire.ts` constants) and compares every constant against `wire.ts`, so a
  forgotten `pnpm wire` turns `rust_ci.yml` red. The frame-splitting fixture is
  replayed by the TypeScript mirror (`web/tests/lib/serial/wire-fixtures.test.ts`).
- `crates/serial` tests must stay free of PetBoard words — it is a reusable
  transport codec.
- Web tests live under `web/tests/` and mirror `web/src/` (`src/lib/foo.ts` →
  `tests/lib/foo.test.ts`), importing via the `@/` alias. Vitest loads the WASM
  in `web/tests/setup/wasm.ts`.
- `web/src/lib/serial/fake-board.ts` is a protocol-accurate fake device — use it
  for serial-layer tests instead of hand-mocking byte streams.
- Only `fm-core` and the format/`serial` crates are host-testable. The board
  crates compile to bare-metal targets and have no unit tests; verify them by
  building (CI) and flashing (hardware).

Format and lint (CI enforces all of these):

```bash
cd crates/fm-core        && cargo fmt --all -- --check && cargo clippy --all-targets --features gen -- -D warnings
cd crates/<format-crate> && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings
cd crates/fm-esp-c6      && cargo fmt --all -- --check && cargo clippy -- -D warnings
cd crates/fm-esp-s3      && cargo fmt --all -- --check && cargo clippy -- -D warnings
cd web                   && pnpm typecheck
```

Always add or update tests for changed behavior, and run the owning area's
test + fmt + clippy before finishing.

## Code style

- Rust edition 2024, `rust-version = 1.95`. Firmware crates are `#![no_std]` /
  `#![no_main]`; use `core` and `alloc`, never `std`. `fm-core` and the format
  crates are `no_std` too and pull in `std` only under `#[cfg(test)]`.
- The board crates deny `clippy::mem_forget` and `clippy::large_stack_frames`;
  keep large buffers static or in PSRAM.
- Plain `rustfmt` with repo defaults — there is no `rustfmt.toml`. Run
  `cargo fmt` rather than hand-aligning.
- TypeScript is strict with single quotes, 2-space indent, and the `@/` path
  alias. Prettier is not configured — follow the existing files.
- User-visible web strings and firmware log text are Chinese; keep new ones
  consistent with the surrounding copy.
- `.vscode/settings.json` explicitly lists the rust-analyzer manifests and
  disables `--all-targets` (board crates would otherwise need a `std` test
  harness). Leave it as is unless you also update the manifest list.

## Build and deployment

- Web build: `cd web && pnpm build` → static export in `web/out/`.
  `NEXT_PUBLIC_BASE_PATH` is injected by CI for the GitHub Pages project path;
  leave it unset for local root-path dev.
- Three workflows, none of which builds the WASM or re-runs `wiregen` (both
  artifacts are committed):
  - `firmware.yml` — job matrix over `{c6, s3} × {build --release, fmt, clippy}`.
    C6 uses the rustup RISC-V target; S3 uses the esp-rs Xtensa toolchain. This
    is the only place the board crates are compiled without hardware. Triggers
    on `crates/**`.
  - `rust_ci.yml` — host checks: `fm-core` (`test`, `fmt`, `clippy
    --features gen`) plus a job per `crates/{anmfmt,bmpfmt,serial,wasmfmt}`.
    Triggers on `crates/**` and `web/src/lib/serial/wire.ts` (which
    `wire_contract.rs` reads).
  - `pages.yml` — `pnpm typecheck` → `pnpm test` → static export, then deploys
    `web/out` to GitHub Pages on pushes to `main`. Node/pnpm only, no Rust.
    Triggers on `web/**`, `crates/fm-core/src/wire/**`, and
    `crates/fm-core/tests/fixtures/**`.
- GitHub Pages would eat the `_next/` directory, so `pages.yml` drops an
  `out/.nojekyll` marker — keep that step. PR runs only build (no upload): a
  fork's `GITHUB_TOKEN` is read-only.

## Where changes go

- **Shared behavior belongs in `crates/fm-core`.** Board crates must stay
  wiring-only. When the boards differ, express the difference through
  `BoardConfig` (`crates/fm-core/src/lib.rs`) instead of branching on the chip —
  e.g. `x_align`/`y_align`, `y_inverted`, `get_chunk`, `sd_clock_mhz` /
  `lcd_phase_mhz`.
- **One format implementation, one protocol parser.** Never re-implement
  `.ANM`/`.BMP` packing in TypeScript; go through `web/src/lib/encode/*.ts` →
  `crates/wasmfmt` → `crates/anmfmt`/`crates/bmpfmt`. Framing/parsing lives in
  `crates/serial`; PetBoard's vocabulary sits on top in
  `crates/fm-core/src/wire/` (`command.rs`, `device.rs`, `playlist.rs`,
  `vocab.rs`).
- **Cross-language constants are generated, not hand-synced.**
  `web/src/lib/serial/wire.ts` and `crates/fm-core/tests/fixtures/frames.jsonl`
  are artifacts of `crates/fm-core/src/wire/codegen.rs`. Never edit them by
  hand; run `cd web && pnpm wire` and commit the output. They are tracked and CI
  no longer regenerates them.

## Protocol and format invariants

Break one of these and the link fails in a way that is hard to debug — there is
no negotiation beyond a single integer.

- **Frames are `~`-sentinel lines with a message id (`API_VERSION = 1`).**
  Requests are `~<id> <ns>/<action> …`; replies are `~<id> OK` / `OK <n> … END`
  / `ERR <reason>`; `id = 0` is reserved for non-reply frames (`~0 ev …`). The
  host only accepts replies matching the in-flight request; anything else is
  dropped and counted. Bump the version and reflash both boards together.
- **Never log inside the `media/get` payload loop.** Payload bytes are raw; a
  defmt frame mixed into the stream corrupts the transfer. `commands/download.rs`
  silences `storage` logging via `PayloadQuiet` while `Link::payload_open()` is
  true (opened by `data()`, closed by `ok()`/`err()`) — preserve that coupling.
- **Upload transfers use tagged slots**: host→device is `0x00` +
  `min(CHUNK_UP, remaining)` raw bytes, or `0x01` + one ASCII control line, so
  `media/abort` can interrupt at a slot boundary. Device→host carries **no tag**
  byte (its first byte is unambiguous: `~` for a control frame, `0x06` for an
  ACK). `media/abort` names the request id it interrupts: on upload it deletes
  the partial file and replies `ERR aborted` then `OK`; a stale abort (wrong id)
  answers `ERR stale` while uploading but must be **silently dropped** while
  downloading — a text line there would be read as payload.
- **Download ACKs carry the received byte count** (`06 09 <u16 little-endian>`,
  `CHUNK_ACK_COUNT_LEN = 2`). The firmware resends only the missing tail. Do not
  "simplify" this to a 2-byte ACK, and never ACK a chunk where zero bytes
  arrived.
- **TX writes must flush as they fill.** The USB-Serial-JTAG TX FIFO is 64 B and
  only hands data to the host once flushed; `serial` retries the same byte and
  gives the closing flush a bounded budget. Measured chunk sizes:
  `get_chunk` = **32** (C6), **512** (S3). Do not change either without
  re-measuring on hardware. `GET_CHUNK_FALLBACK` in `wire.ts` is only the C6-era
  fallback; the authoritative value is what `device/info` reports
  (`BoardConfig::get_chunk`).
- **Playback progress is pushed, not polled.** The device emits
  `~0 ev play|stop|item|loop|frame|error` (`ev frame` throttled, newest-wins per
  kind, nothing during an open payload interval). `web/src/lib/useDevice.ts`
  falls back to `device/info` polling only while connected but silent. During
  playback the firmware rejects every command except `media/stop`, `media/play`,
  `media/abort`, and `device/info` (`ERR busy` otherwise).
- **`.ANM` is v1** (`MAGIC = b"ANM\0"`, `VERSION = 1`). The 18-byte header has
  **no loop count** — loops come from `data/PLAYLIST`. The frame header is 12 B;
  the frame bitmap is 1 bit/pixel MSB-first with `(width + 7) / 8` bytes per row,
  and `colors.len() == popcount(bitmap) * 2` (RGB565 little-endian).
  `MAX_FILE_BYTES` is 32 MiB. On-card files use `data/INDEX` (JSON, web-written)
  + `data/PLAYLIST` (`<name> <loops>`).
- **Playback allocates nothing from the heap.** The canvas, LCD buffer, color
  read buffer, and frame bitmap live in `.bss` (or PSRAM); the heap also serves
  protocol/log `String`/`format!`. Drawing from the heap previously panicked on
  the next allocation.
- **Round-change ghosting is the renderer's job.** `canvas.fill(0)` alone does
  not clear the panel; the firmware erases the previous round's union rectangle
  outside the new frame's bbox. See `docs/anm-format.md` before touching
  playback.
- **FAT 8.3, FAT12/16/32 only.** `embedded_sdmmc` has no exFAT, so cards above
  32 GB (which ship as exFAT) fail to mount. Filenames must fit 8.3 — which is
  why the extension is `.ANM`.

## Board-specific gotchas

Read the nested `AGENTS.md` in each board crate before touching it.

C6 (`crates/fm-esp-c6/`) — the LCD and the TF card share SPI2, so the driver
switches the bus clock by phase (`sd_clock_mhz` vs `lcd_phase_mhz`); the shared
`Spi` config must always set `min_async_transfer_size` or small transfers
regress to DMA and fail on flash-resident constants. SD SPI caps at 25 MHz. The
panel is ST7789 (172×320, landscape) via `mipidsi` with offsets.

S3 (`crates/fm-esp-s3/`) — read `crates/fm-esp-s3/AGENTS.md` and
`docs/esp32-s3-lcd-35.md` before touching the panel. Key contracts:

- This is an **ST77922**, not ST7796. `mipidsi` was abandoned; the driver is
  `panel.rs` + `qspi.rs` + `st77922_init.rs` (vendor init table).
- This panel ignores `MV`: `MADCTL` is `0x00`, the software transposes, the
  window is `x → 0x2B` / `y → 0x2A`, and CASET (logical `y`) must be aligned to
  4 pixels — hence `BoardConfig::y_align = 4`. Do not copy the vendor
  "landscape = `MADCTL 0xA0`" recipe.
- **It needs a real power-on reset after flashing.** `LCD_RST` is tied to `EN`;
  USB/USB-JTAG resets only the CPU, so the panel can be black with an
  error-free log and `SWRESET` will not recover it. Press the board's RST or
  replug USB.
- Large buffers (the 300 KiB playback canvas, LCD buffers) must be PSRAM, not
  `static`. Never place `Atomic*` in PSRAM.
- `build.rs` deliberately omits `--error-handling-script` (GNU ld rejects it)
  but adds `-Wl,--no-warn-rwx-segments`.

## Web gotchas

- Playback state arrives as device-pushed `ev …` frames (`EVENTS` in
  `web/src/lib/serial/wire.ts`); `device/info` polling is a fallback for boards
  that stay silent.
- Hover previews read up to 1 MiB and hand back whatever decoded if a segment
  fails; the first-frame poster and the conversion cache are stored separately
  (`posters` vs `media` in IndexedDB). Don't clear posters together with media.
- The `.ANM` first frame is variable length (header + bitmap + colors), so
  posters must be sized from the frame geometry — never sliced at a fixed byte
  offset, and reject byte-shifted data that would render corrupt frames.
- `web/AGENTS.md`'s "This is NOT the Next.js you know" block is rewritten by
  `next dev`. Read `node_modules/next/dist/docs/` before writing Next code and
  keep that block in diffs.

## Pull requests

- Use Conventional Commits (`feat(web): …`, `fix(serial): …`,
  `refactor(formats): …`) as in the existing history.
- Required checks before submitting: the owning area's `cargo test` / `pnpm
  test`, plus `cargo fmt --all -- --check`, clippy (or `pnpm typecheck`), and
  `pnpm build` if you touched anything under `web/` or the format crates.
- State plainly which claims are verified. Static/CI evidence (build, tests) is
  not hardware evidence: say when an S3 panel change or a real-device behavior
  was only built or tested with the fake board, and was not confirmed on a
  device.
