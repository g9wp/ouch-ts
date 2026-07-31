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

## API

| Function                     | Description                                              |
| ---------------------------- | -------------------------------------------------------- |
| `init(moduleOrPath?)`        | Load the wasm module (once) and return the `Ouch` API.   |
| `ouch.writeFile/readFile`    | Input/output of the in-memory virtual filesystem.        |
| `ouch.compress(options)`     | Compress VFS files into an archive in the VFS.           |
| `ouch.decompress(options)`   | Extract archives into the VFS.                           |
| `ouch.listArchive(options)`  | List archive entries; `bytes`/`readable` decode lazily.  |
| `ouch.readEntry(archive, e)` | Read one entry's bytes from an archive.                  |
| `ouch.walk(options)`         | Async-generator over entries, decoded on demand.         |
| `ouch.clear()`               | Reset the virtual filesystem.                            |

## Project layout

```
├── deno.json       # deno tasks (build / test / check) + publish config
├── mod.ts          # TypeScript API
├── mod_test.ts     # end-to-end tests (run: deno test -A)
├── cross_test.ts   # interop tests vs external tools (tar/zip/7z/...)
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
- `password` enables AES-256 encryption when compressing to zip/7z;
  encrypted archives need it to list, read or extract. `level` (0-9) applies
  to zip (deflate), 7z (LZMA2) and the streaming formats.
- The native CLI is unaffected: `cargo build --features cli,use_zlib` (the
  `bzip3` default feature additionally needs `libclang` for bindgen).
