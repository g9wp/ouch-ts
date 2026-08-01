# ouch-ts

[Ouch](https://github.com/ouch-org/ouch) — a CLI for easily compressing and
decompressing files — recompiled as a **WASM + TypeScript development library**.

```
TS API (mod.ts)  ->  ouch wasm (rust)  ->  pure-Rust codecs (zip/tar/7z/gz/xz/...)
```

## Supported formats

`tar`, `zip`, `7z`, `gz`, `xz`, `lzma`, `lz`, `lz4`, `sz` (snappy), `br` (brotli),
`bz2`, including chains like `tar.gz` and `tar.bz2`.

- `zst` (zstd) and `rar` are **decompress-only** (no pure-Rust encoder for zstd;
  rar is a read-only format by design).
- `bz3` needs a C toolchain (`libbzip3`) and is not available in the WASM build;
  the native CLI supports it.

## Building the wasm package

Requires `rustup` (with the `wasm32-unknown-unknown` target), `wasm-pack`, and
`deno`.

```sh
deno task build        # release build of ./ouch/pkg/
deno task build:dev    # fast dev build
```

## Usage

```ts
import { init, walk } from "./mod.ts";

const ouch = await init();

// 1. write inputs into the in-memory virtual filesystem
ouch.writeFile("docs/hello.txt", new TextEncoder().encode("hello wasm!"));

// 2. compress (format comes from the output extension)
ouch.compress({ files: ["docs"], output: "docs.tar.gz" });

// 3. list archive contents — each entry reads its bytes lazily
const entries = ouch.listArchive({ archives: ["docs.tar.gz"] });
const first = entries[0];
const bytes = first.bytes; // decodes only this entry from the archive

// 4. iterate lazily without extracting everything
for await (const entry of walk({ archives: ["docs.tar.gz"] })) {
  const data = await entry.readable.getReader().read();
}

// 5. read outputs back out of the VFS
const archive = ouch.readFile("docs.tar.gz");
```

## Entry points

The package ships three entry points; they share one wasm core and differ only
in which file helpers they provide (and how they detect the runtime):

| Import                        | File helpers                            |
| ----------------------------- | --------------------------------------- |
| `@g9wp/ouch` (default)        | Universal: auto-detect Deno → Node (`process.getBuiltinModule`) → browser `fetch`; accepts explicit `node:fs`-style backends. |
| `@g9wp/ouch/deno`             | Deno-only: backed directly by `Deno.*` APIs, no detection.        |
| `@g9wp/ouch/node`             | Node-only: statically imports `node:fs` / `node:fs/promises`, bundler-friendly. |

Pick the subpath matching your runtime to avoid the default entry's probing;
the default entry stays for browsers, bundlers, and mixed environments.
`fromBytes` / `fromBlob` and everything else live in the shared core, so all
three entries expose the same `Ouch` API.

## API

| Function                     | Description                                              |
| ---------------------------- | -------------------------------------------------------- |
| `init(moduleOrPath?)`        | Load the wasm module (once) and return the `Ouch` API.   |
| `ouch.writeFile/readFile`    | Input/output of the in-memory virtual filesystem.        |
| `ouch.compress(options)`     | Compress VFS files into an archive in the VFS.           |
| `ouch.decompress(options)`   | Extract archives into the VFS.                           |
| `ouch.listArchive(options)`  | List archive entries; `bytes`/`readable` decode lazily.  |
| `ouch.readEntry(archive, e)` | Read one entry's bytes from an archive.                  |
| `ouch.streamEntry(archive, e)` | **Stream** one entry in bounded chunks (large files).  |
| `ouch.listFrom(src, opts)`      | List an archive held by a JS-side [`SeekableSource`]. |
| `ouch.readEntryFrom(src, e)`    | Read one entry via random access (seek, no full load). |
| `ouch.streamEntryFrom(src, e)`  | Stream one entry from a seekable source in chunks.     |
| `ouch.compressTo(files, w)`     | **Stream**-compress JS-owned files into a writable.   |
| `readFile/writeFile`          | Async whole-file I/O (Deno / Node / browser fetch).   |
| `fromFile(path)` / `fromFileSync(path)` | Random-access disk sources (async/sync open). |
| `fileSink(path)` / `fileSinkSync(path)` | Random-access disk sinks for zip/7z streaming (async/sync I/O). |
| `loadFile(path)` / `fromBlob(b)` | Whole-file buffered seekable sources.       |
| `ouch.walk(options)`         | Async-generator over entries, decoded on demand.         |
| `ouch.clear()`               | Reset the virtual filesystem.                            |

## Project layout

```
├── deno.json       # deno tasks (build / test / check) + exports + publish config
├── mod.ts          # universal entry: core + auto-detecting file helpers
├── core.ts         # runtime-agnostic core (Ouch, wasm init, entries, sources/sinks)
├── deno.ts         # "./deno" entry: Deno file helpers (Deno.* APIs)
├── node.ts         # "./node" entry: Node file helpers (node:fs / node:fs/promises)
├── mod_test.ts     # end-to-end tests (run: deno test -A)
├── entry_test.ts   # entry-point tests for ./deno and ./node
├── cross_test.ts   # interop tests vs external tools (tar/zip/7z/...)
├── fixtures/       # sample .zst/.rar archives for codec tests
├── build.ts        # wasm-pack build script
├── pkg/            # generated: ouch.js + ouch_bg.wasm + ouch.d.ts
└── ouch/           # the ouch rust repo (vendor)
    ├── src/lib.rs  # library root (module gating per feature)
    ├── src/wasm/   # wasm bindings: vfs / codecs / archives / entry
    └── pkg/        # intermediate wasm-pack output (gitignored)
```

## Publishing (JSR)

Pushing a `vX.Y.Z` tag runs `.github/workflows/publish.yml`: it builds the
wasm package and publishes `@g9wp/ouch` to JSR using tokenless OIDC
authentication (the tag version must match `version` in `deno.json`).

Prerequisites:

1. Create the package scope/name on [jsr.io](https://jsr.io) first.
2. Link the package to this GitHub repository in the package settings
   (JSR > your package > Settings > GitHub repository).

Release flow:

```sh
# 1. bump the version in deno.json
# 2. commit, then tag and push
git tag v0.1.0
git push origin v0.1.0
```

`pkg/` is gitignored but included in the published package via
`publish.exclude: ["!pkg", ...]`; the workflow regenerates it with
`deno task build` before publishing.

Alternatively, publish from a local machine with `deno publish` (browser
authentication).

## Notes

- All file I/O happens inside the wasm module's **in-memory virtual
  filesystem**; nothing touches the real disk. The VFS is shared by one
  `Ouch` instance — call `clear()` between independent jobs.
- `walk` and `listArchive` are fully lazy: entry `bytes`/`readable` decode
  only that entry from the archive on demand. `decompress` materializes
  entries into the VFS instead.
- **Streaming reads for large files**: `entry.readable` (from `listArchive` /
  `walk`) and `ouch.streamEntry()` are true streams — wasm decodes the entry
  in 256 KiB chunks and pushes each chunk to JS, so memory stays bounded no
  matter how big the uncompressed entry is. This works for every format
  (`tar.gz` chains are decoded as one stream). 7z/rar entries go through their
  libraries' sequential readers, so they are not random-access.
  `readEntry()` / `entry.bytes` / `decompress()` still materialize the whole
  entry in memory — prefer streaming for anything large.
- **Random access via `SeekableSource`**: `listFrom` / `readEntryFrom` /
  `streamEntryFrom` keep the archive on the JS side (`fromBytes`, or the
  file handles `fromFile`/`fromFileSync` and `fileSink`/`fileSinkSync` in
  Deno and Node) and wasm pulls only the ranges it needs through a
  synchronous `readAt(offset, length)` callback. Zip metadata (central
  directory), tar headers and 7z headers are read by seeking, and a single
  entry is decompressed by seeking to its data — the whole archive never
  enters wasm memory. `tar.*` chains decode sequentially; wrapped
  zip/7z/rar and `rar` (no random-access reader) fall back to whole-source
  reads. Byte sizes are JS `number`s (exact up to 2^53).

  File helpers are async by default (sync gets the `Sync` suffix).
  `fromFile` opens a Deno/Node file handle asynchronously and exposes
  synchronous random access over it (only the *open* blocks the event loop —
  reads hit the disk at the requested offset, no whole-file load);
  `fromFileSync` is the same with a synchronous open. `fileSink` is a fully
  async sink: `writeAt`/`readAt`/`size` are promise-based and never block,
  and `fileSinkSync` is its synchronous counterpart. `loadFile` /
  `readFile` / `writeFile` are the explicit whole-file I/O helpers (use
  `loadFile` only for moderate files). Deno is detected automatically, then
  Node's `node:fs` / `node:fs/promises` via `process.getBuiltinModule` (Node
  ≥ 22.3); pass `node:fs` / `node:fs/promises` (or compatible
  `SyncFs`/`AsyncFs`) explicitly on older Node / bundlers. Browsers have no
  file API — use `loadFile` (URLs fall back to `fetch`) or `fromBlob` for a
  `File`/`Blob`. Note the wasm parsers are synchronous, so random-access
  reads during parsing use the sync callbacks; the async helpers cover the
  I/O around them (opening handles, loading inputs, writing outputs).
- **Streaming compression**: `ouch.compressTo(files, writable, options)` (or
  the module-level `compressTo`) pulls each input file from its
  [`SeekableSource`] and pushes 256 KiB output chunks to `writable`, so
  neither inputs nor the archive materialize in wasm memory. Supports `tar`
  (including chains like `tar.gz` / `tar.xz` / `tar.br`) and the single-stream
  formats (gz/xz/lzma/lz/lz4/sz/br). `zip`/`7z` need a seekable output, so on
  Deno/Node pass `options.sink = fileSinkSync(path)` and the archive is
  written to a file and streamed back in chunks (bounded memory, real
  backpressure); `bz2`'s pure-Rust encoder is one-shot, so it uses the
  buffered VFS flow (`compress`) — `compressTo` rejects those with a hint.
  The sinks `fileSink(path)` / `fileSinkSync(path)` are async/sync
  counterparts of the same handle: with a sync sink the encoder writes
  straight to disk (bounded memory), while an async sink buffers the
  encoder's writes in JS memory and flushes them without blocking — pick
  `fileSinkSync` for huge archives.
- `password` enables AES-256 encryption when compressing to zip/7z;
  encrypted archives need it to list, read or extract. `level` (0-9) applies
  to zip (deflate), 7z (LZMA2) and the streaming formats.
- The native CLI is unaffected: `cargo build --features cli,use_zlib` (the
  `bzip3` default feature additionally needs `libclang` for bindgen).
