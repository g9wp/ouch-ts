// Ouch: a WASM-backed (de)compression library.
//
// Architecture:
//   TS API  ->  ouch wasm (rust)  ->  pure-Rust codecs (zip/tar/7z/gz/xz/...)
//
// All file I/O happens inside the wasm module's in-memory virtual filesystem
// (VFS). The host registers input bytes with `writeFile`, runs `compress` /
// `decompress` / `list` / `walk`, and reads results back with `readFile`.

import initWasm, {
  CompressArgs,
  CompressFileArgs,
  CompressFromArgs,
  DecompressArgs,
  ListArgs,
  OuchWasm,
  ReadEntryArgs,
  SeekableArgs,
  StreamEntryArgs,
} from "./pkg/ouch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Formats available in the WASM build (pure-Rust codecs only).
 * `zst` and `rar` are decompress-only. */
export type OuchFormat =
  | "tar"
  | "zip"
  | "7z"
  | "gz"
  | "xz"
  | "lzma"
  | "lz"
  | "lz4"
  | "sz"
  | "br"
  | "bz2"
  | "zst"
  | "rar";

/**
 * A synchronous random-access byte source. Most archive metadata (zip central
 * directory, tar headers, 7z header) lives at known offsets, and a single
 * entry can be decompressed by seeking to its data — so the whole archive
 * never needs to enter wasm memory. `readAt` must be synchronous; see
 * [`fromBytes`], [`fromFileSync`] / [`fromFile`] (random-access file
 * handles, sync and async open) and [`loadFile`] / [`fromBlob`]
 * (whole-file buffers) for ready-made implementations.
 */
export interface SeekableSource {
  /** Total byte length of the source. */
  readonly size: number;
  /** Read up to `length` bytes starting at `offset` (clamped to EOF). */
  readAt(offset: number, length: number): Uint8Array;
}

/** A seekable source over an in-memory byte buffer. */
export function fromBytes(bytes: Uint8Array): SeekableSource {
  return {
    size: bytes.length,
    readAt(offset, length) {
      return bytes.slice(offset, Math.min(offset + length, bytes.length));
    },
  };
}

/**
 * A seekable source over a Deno/Node file, opened read-only and kept open
 * until `close()` is called. Gives true disk random access: listing a huge
 * archive only reads its header blocks. Deno is detected automatically; in
 * Node, `node:fs` is picked up via `process.getBuiltinModule` (or pass `fs`
 * explicitly on older versions / bundlers). Browsers have no sync file API.
 */
export function fromFileSync(
  path: string | URL,
  fs?: SyncFs,
): SeekableSource & { close(): void } {
  const file = openFile(path, fs, "r");
  return {
    size: file.statSize(),
    readAt(offset, length) {
      return file.readAt(offset, length);
    },
    close() {
      file.close();
    },
  };
}

/**
 * A synchronous random-access byte sink. Zip/7z encoders require a `Seek`
 * output, so streaming compression for those formats writes into a host-side
 * sink (a Deno/Node file) instead of wasm memory; see [`fileSinkSync`].
 */
export interface SeekableSink {
  /** Total bytes written so far. */
  size: number;
  /** Write `bytes` at `offset`, returning the new end offset. */
  writeAt(offset: number, bytes: Uint8Array): number;
  /** Read up to `length` bytes starting at `offset` (for streaming the result back). */
  readAt(offset: number, length: number): Uint8Array;
}

/**
 * The asynchronous counterpart of [`SeekableSink`]: the same random-access
 * contract, but every operation is promise-based and never blocks the event
 * loop. Produced by [`fileSink`]. [`Ouch#compressTo`] accepts either sink
 * type; with an async sink it buffers the wasm encoder's writes in JS memory
 * (the encoder itself is synchronous) and flushes them asynchronously — for
 * huge archives prefer the bounded-memory [`fileSinkSync`].
 */
export interface AsyncSeekableSink {
  /** Total bytes written so far. */
  size(): Promise<number>;
  /** Write `bytes` at `offset`, resolving with the new end offset. */
  writeAt(offset: number, bytes: Uint8Array): Promise<number>;
  /** Read up to `length` bytes starting at `offset` (clamped to EOF). */
  readAt(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * A seekable sink over a Deno/Node file (created/truncated), kept open until
 * `close()` is called. Enables streaming zip/7z compression with bounded
 * memory: the archive is written to disk, then streamed back in chunks. Deno
 * is detected automatically; in Node, `node:fs` is picked up via
 * `process.getBuiltinModule` (or pass `fs` explicitly on older versions).
 */
export function fileSinkSync(
  path: string | URL,
  fs?: SyncFs,
): SeekableSink & { close(): void } {
  const file = openFile(path, fs, "rw");
  return {
    get size() {
      return file.statSize();
    },
    writeAt(offset, bytes) {
      return file.writeAt(offset, bytes);
    },
    readAt(offset, length) {
      return file.readAt(offset, length);
    },
    close() {
      file.close();
    },
  };
}

/**
 * The subset of the synchronous `node:fs` API used by [`fromFileSync`] /
 * [`fileSinkSync`]. Pass `node:fs` itself in Node, or a compatible shim.
 */
export interface SyncFs {
  openSync(path: string | URL, flags: string): number;
  fstatSync(fd: number): { size: number };
  readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  writeSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  closeSync(fd: number): void;
}

/** Common view over a Deno file handle or a Node file descriptor. */
interface OpenFile {
  statSize(): number;
  readAt(offset: number, length: number): Uint8Array;
  writeAt(offset: number, bytes: Uint8Array): number;
  close(): void;
}

function openFile(
  path: string | URL,
  fs: SyncFs | undefined,
  mode: "r" | "rw",
): OpenFile {
  const deno = (globalThis as unknown as { Deno?: unknown }).Deno;
  if (deno) {
    return openDenoFile(deno as DenoLike, path, mode);
  }
  const nfs = fs ?? nodeFs();
  if (nfs) {
    return openNodeFile(nfs, path, mode);
  }
  throw new Error(
    "fromFileSync/fileSinkSync need Deno or Node; pass a node:fs-like `fs` in other runtimes",
  );
}

/** Node's `process.getBuiltinModule` (Node >= 22.3); undefined elsewhere. */
function nodeFs(): SyncFs | undefined {
  const getBuiltin = (globalThis as unknown as {
    process?: { getBuiltinModule?: (name: string) => unknown };
  }).process?.getBuiltinModule;
  return getBuiltin?.("fs") as SyncFs | undefined;
}

interface DenoLike {
  openSync(
    path: string | URL,
    opts: { read: true; write?: true; create?: true; truncate?: true },
  ): {
    statSync(): { size: number };
    seekSync(offset: number, mode: number): number;
    readSync(buf: Uint8Array): number | null;
    writeSync(bytes: Uint8Array): number;
    close(): void;
  };
}

function openDenoFile(
  deno: DenoLike,
  path: string | URL,
  mode: "r" | "rw",
): OpenFile {
  const file = deno.openSync(
    path,
    mode === "rw"
      ? { read: true, write: true, create: true, truncate: true }
      : { read: true },
  );
  return {
    statSize() {
      return file.statSync().size;
    },
    readAt(offset, length) {
      // Deno.SeekMode.Start === 0
      file.seekSync(offset, 0);
      const buf = new Uint8Array(length);
      const n = file.readSync(buf);
      return n === null ? new Uint8Array(0) : buf.slice(0, n);
    },
    writeAt(offset, bytes) {
      file.seekSync(offset, 0);
      file.writeSync(bytes);
      return offset + bytes.length;
    },
    close() {
      file.close();
    },
  };
}

/** Node: `readSync`/`writeSync` are position-based, so no explicit seek. */
function openNodeFile(
  fs: SyncFs,
  path: string | URL,
  mode: "r" | "rw",
): OpenFile {
  const fd = fs.openSync(path, mode === "rw" ? "w+" : "r");
  return {
    statSize() {
      return fs.fstatSync(fd).size;
    },
    readAt(offset, length) {
      const buf = new Uint8Array(length);
      const n = fs.readSync(fd, buf, 0, length, offset);
      return n <= 0 ? new Uint8Array(0) : buf.slice(0, n);
    },
    writeAt(offset, bytes) {
      fs.writeSync(fd, bytes, 0, bytes.length, offset);
      return offset + bytes.length;
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

// ---------------------------------------------------------------------------
// Async file I/O
// ---------------------------------------------------------------------------
//
// The wasm archive parsers and encoders are synchronous, so the random-access
// *sources* must stay synchronous (readAt callbacks run inside wasm calls).
// The async helpers below cover the I/O around them: opening handles,
// whole-file reads/writes without blocking the event loop, and loading files
// into memory for browsers (which have no synchronous file API). Sinks are
// fully async — the synchronous encoder's writes are buffered and flushed by
// the JS caller ([`Ouch#compressTo`]), so [`fileSink`] never blocks.

/**
 * The promise-based `fs` API subset used by [`readFile`] /
 * [`writeFile`] / [`loadFile`] and the async handles of [`fromFile`] /
 * [`fileSink`]. Pass `node:fs/promises` (or a compatible shim); Deno is
 * detected automatically.
 */
export interface AsyncFs {
  readFile(path: string | URL): Promise<Uint8Array>;
  writeFile(path: string | URL, data: Uint8Array): Promise<void>;
  /** `node:fs/promises.open`, used by [`fromFile`] / [`fileSink`]. */
  open?(path: string | URL, flags: string): Promise<AsyncFileHandle>;
}

/** Minimal `node:fs/promises` `FileHandle`-shaped handle. */
export interface AsyncFileHandle {
  fd?: number;
  statSync?(): { size: number };
  readSync?(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  writeSync?(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  closeSync?(): void;
  stat?(): Promise<{ size: number }>;
  read?(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  write?(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  close(): Promise<void>;
}

/** Asynchronously read a whole file (Deno / Node / browser `fetch` for URLs). */
export async function readFile(
  path: string | URL,
  fs?: AsyncFs,
): Promise<Uint8Array> {
  return (await asyncFs(fs)).readFile(path);
}

/** Asynchronously write a whole file (Deno / Node; browsers have no file API). */
export async function writeFile(
  path: string | URL,
  data: Uint8Array,
  fs?: AsyncFs,
): Promise<void> {
  return (await asyncFs(fs)).writeFile(path, data);
}

/**
 * Asynchronously open a file and return a seekable random-access source —
 * the async counterpart of [`fromFileSync`]. Only the *open* is async:
 * `readAt` stays synchronous (the wasm parsers run synchronously), but every
 * read hits the disk at the requested offset — no whole-file load — so
 * listing a huge archive only touches its header blocks. Deno is detected
 * automatically; in Node, `node:fs/promises` is picked up via
 * `process.getBuiltinModule` (or pass `fs` explicitly). Close the handle with
 * `await src.close()`.
 */
export async function fromFile(
  path: string | URL,
  fs?: AsyncFs,
): Promise<SeekableSource & { close(): Promise<void> }> {
  const file = await openFileAsync(path, fs, "r");
  return {
    size: file.statSize(),
    readAt(offset, length) {
      return file.readAt(offset, length);
    },
    close() {
      return file.close();
    },
  };
}

/**
 * Asynchronously create a seekable sink over a file (created/truncated) —
 * the async counterpart of [`fileSinkSync`]. Unlike the sync sink, every
 * operation is promise-based: `writeAt`/`readAt` use async file I/O and never
 * block the event loop. Deno is detected automatically; in Node,
 * `node:fs/promises` is picked up via `process.getBuiltinModule` (or pass
 * `fs` explicitly). Close the handle with `await sink.close()`.
 */
export async function fileSink(
  path: string | URL,
  fs?: AsyncFs,
): Promise<AsyncSeekableSink> {
  if (fs?.open) {
    return asyncSinkFromHandle(await fs.open(path, "w+"));
  }
  const deno = (globalThis as unknown as { Deno?: DenoAsyncOpenLike }).Deno;
  if (deno?.open) {
    const file = await deno.open(path, {
      read: true,
      write: true,
      create: true,
      truncate: true,
    });
    return {
      size: async () => (await file.stat()).size,
      async writeAt(offset, bytes) {
        let written = 0;
        while (written < bytes.length) {
          await file.seek(offset + written, 0);
          const n = await file.write(bytes.subarray(written));
          if (n === 0) throw new Error("short async write");
          written += n;
        }
        return offset + bytes.length;
      },
      async readAt(offset, length) {
        const buf = new Uint8Array(length);
        let got = 0;
        while (got < length) {
          await file.seek(offset + got, 0);
          const n = await file.read(buf.subarray(got));
          if (n === null || n === 0) break;
          got += n;
        }
        return buf.slice(0, got);
      },
      close: async () => {
        file.close();
      },
    };
  }
  const nfs = await nodeAsyncFs();
  if (nfs?.open) {
    return asyncSinkFromHandle(await nfs.open(path, "w+"));
  }
  throw new Error(
    "fileSink needs Deno or Node; pass a node:fs/promises-like `fs` in other runtimes",
  );
}

/** Adapt a `node:fs/promises` `FileHandle` to an [`AsyncSeekableSink`]. */
function asyncSinkFromHandle(
  h: {
    stat?(): Promise<{ size: number }>;
    read?(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
    write?(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
    close(): Promise<void>;
  },
): AsyncSeekableSink {
  return {
    size: async () => (await h.stat!()).size,
    async writeAt(offset, bytes) {
      let written = 0;
      while (written < bytes.length) {
        const { bytesWritten } = await h.write!(
          bytes,
          written,
          bytes.length - written,
          offset + written,
        );
        if (bytesWritten === 0) throw new Error("short async write");
        written += bytesWritten;
      }
      return offset + bytes.length;
    },
    async readAt(offset, length) {
      const buf = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await h.read!(
          buf,
          got,
          length - got,
          offset + got,
        );
        if (bytesRead === 0) break; // EOF
        got += bytesRead;
      }
      return buf.slice(0, got);
    },
    close: () => h.close(),
  };
}

/**
 * Asynchronously load a *whole* file into memory as a buffered seekable
 * source (Deno / Node / browser `fetch` for URLs). Prefer [`fromFile`] /
 * [`fromFileSync`] for anything large — they read from disk on demand
 * instead of copying everything up front. For browser `File`/`Blob` objects
 * use [`fromBlob`].
 */
export async function loadFile(
  path: string | URL,
  fs?: AsyncFs,
): Promise<SeekableSource> {
  return fromBytes(await readFile(path, fs));
}

/** A seekable source over a Blob (e.g. a browser `File`), loaded asynchronously. */
export async function fromBlob(blob: Blob): Promise<SeekableSource> {
  return fromBytes(new Uint8Array(await blob.arrayBuffer()));
}

/** Resolve an async fs backend: explicit, Deno, Node, or browser `fetch`. */
async function asyncFs(fs?: AsyncFs): Promise<AsyncFs> {
  if (fs) return fs;
  const deno = (globalThis as unknown as {
    Deno?: {
      readFile(p: string | URL): Promise<Uint8Array>;
      writeFile(p: string | URL, data: Uint8Array): Promise<void>;
    };
  }).Deno;
  if (deno?.readFile) {
    return {
      readFile: (p) => deno.readFile(p),
      writeFile: (p, d) => deno.writeFile(p, d),
    };
  }
  const node = nodeAsyncFs();
  if (node) return node;
  return {
    readFile: async (p) =>
      new Uint8Array(await (await fetch(String(p))).arrayBuffer()),
    writeFile: () =>
      Promise.reject(new Error("no async file-write backend in this runtime")),
  };
}

function nodeAsyncFs(): AsyncFs | undefined {
  const getBuiltin = (globalThis as unknown as {
    process?: { getBuiltinModule?: (name: string) => unknown };
  }).process?.getBuiltinModule;
  if (!getBuiltin) return undefined;
  return (getBuiltin("node:fs/promises") ?? getBuiltin("fs/promises")) as
    | AsyncFs
    | undefined;
}

interface DenoOpenLike {
  open(
    path: string | URL,
    opts: { read: true; write?: true; create?: true; truncate?: true },
  ): Promise<{
    statSync(): { size: number };
    seekSync(offset: number, mode: number): number;
    readSync(buf: Uint8Array): number | null;
    writeSync(bytes: Uint8Array): number;
    close(): void;
  }>;
}

/** The async `Deno.open` handle shape used by [`fileSink`]. */
interface DenoAsyncOpenLike {
  open(
    path: string | URL,
    opts: { read: true; write?: true; create?: true; truncate?: true },
  ): Promise<{
    stat(): Promise<{ size: number }>;
    seek(offset: number, mode: number): Promise<number>;
    read(buf: Uint8Array): Promise<number | null>;
    write(bytes: Uint8Array): Promise<number>;
    close(): void;
  }>;
}

/** Common view over an async-opened Deno file handle or Node FileHandle. */
interface AsyncOpenHandle {
  statSize(): number;
  readAt(offset: number, length: number): Uint8Array;
  writeAt(offset: number, bytes: Uint8Array): number;
  close(): Promise<void>;
}

/**
 * Open a file asynchronously, then adapt it to synchronous random access.
 * An explicitly passed `fs` wins (so Node backends are testable from Deno);
 * otherwise Deno's `Deno.open` and then Node's `fs/promises` are detected.
 */
async function openFileAsync(
  path: string | URL,
  fs: AsyncFs | undefined,
  mode: "r" | "rw",
): Promise<AsyncOpenHandle> {
  if (fs?.open) {
    return adaptAsyncHandle(await fs.open(path, mode === "rw" ? "w+" : "r"));
  }
  const deno = (globalThis as unknown as { Deno?: DenoOpenLike }).Deno;
  if (deno?.open) {
    const file = await deno.open(
      path,
      mode === "rw"
        ? { read: true, write: true, create: true, truncate: true }
        : { read: true },
    );
    return {
      statSize() {
        return file.statSync().size;
      },
      readAt(offset, length) {
        // Deno.SeekMode.Start === 0
        file.seekSync(offset, 0);
        const buf = new Uint8Array(length);
        const n = file.readSync(buf);
        return n === null ? new Uint8Array(0) : buf.slice(0, n);
      },
      writeAt(offset, bytes) {
        file.seekSync(offset, 0);
        file.writeSync(bytes);
        return offset + bytes.length;
      },
      close() {
        return Promise.resolve(file.close());
      },
    };
  }
  const nfs = await nodeAsyncFs();
  if (nfs?.open) {
    return adaptAsyncHandle(await nfs.open(path, mode === "rw" ? "w+" : "r"));
  }
  throw new Error(
    "fromFile/fileSink need Deno or Node; pass a node:fs/promises-like `fs` in other runtimes",
  );
}

/**
 * Adapt a `node:fs/promises` `FileHandle` (or Deno's node-compat handle) to
 * synchronous random access. Real Node (>= 20.1) FileHandles expose
 * `readSync`/`writeSync`/`statSync`; Deno's node-compat FileHandle does not,
 * but it exposes `fd`, so sync reads route through `node:fs` instead.
 */
function adaptAsyncHandle(handle: unknown): AsyncOpenHandle {
  const h = handle as {
    fd?: number;
    statSync?: () => { size: number };
    readSync?(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): number;
    writeSync?(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): number;
    close(): Promise<void>;
  };
  const syncFs = h.readSync ? undefined : nodeFs();
  const fd = h.fd ?? -1;
  return {
    statSize() {
      if (h.statSync) return h.statSync().size;
      return syncFs!.fstatSync(fd).size;
    },
    readAt(offset, length) {
      const buf = new Uint8Array(length);
      const n = h.readSync
        ? h.readSync(buf, 0, length, offset)
        : syncFs!.readSync(fd, buf, 0, length, offset);
      return n <= 0 ? new Uint8Array(0) : buf.slice(0, n);
    },
    writeAt(offset, bytes) {
      if (h.writeSync) h.writeSync(bytes, 0, bytes.length, offset);
      else syncFs!.writeSync(fd, bytes, 0, bytes.length, offset);
      return offset + bytes.length;
    },
    close() {
      return h.close();
    },
  };
}

export interface CompressOptions {
  /** Paths (in the virtual filesystem) to compress. */
  files: string[];
  /** Output path in the virtual filesystem; its extension selects the format. */
  output: string;
  /** Override the format inferred from `output`, e.g. "tar.gz". */
  format?: string;
  /** Compression level (0-9 for most formats; brotli 0-11). */
  level?: number;
  /** AES-256 encrypt the archive (zip and 7z only). */
  password?: string;
}

/**
 * One input file for streaming compression ([`Ouch#compressTo`]). The bytes
 * are pulled from `source` in bounded chunks; `source.size` must be exact.
 */
export interface CompressFile {
  /** Path inside the archive. */
  path: string;
  /** File content (a seekable source, e.g. [`fromBytes`] or [`fromFileSync`]). */
  source: SeekableSource;
  /** Unix permission bits (default `0o644`). */
  mode?: number;
  /** Write a directory entry instead of reading `source`. */
  isDir?: boolean;
}

export interface DecompressOptions {
  /** Paths (in the virtual filesystem) to decompress. */
  files: string[];
  /** Directory in the VFS to extract into. Defaults to a wrapper dir named after the archive. */
  outputDir?: string;
  /** Password for encrypted archives. */
  password?: string;
  /** Override the format inferred from each file's extension. */
  format?: string;
  /** Replace existing files in the VFS. Defaults to `true`. */
  overwrite?: boolean;
}

export interface ListOptions {
  /** Archives (in the virtual filesystem) whose contents should be listed. */
  archives: string[];
  password?: string;
  format?: string;
}

export interface CompressResult {
  /** Output path in the virtual filesystem. */
  output: string;
  /** Size of the produced archive, in bytes. */
  output_size: number;
  /** Number of entries written into the archive. */
  entries: number;
}

export interface DecompressResult {
  files_unpacked: number;
  /** Entries written into the virtual filesystem (paths are VFS paths). */
  entries: DecompressEntry[];
}

/** Raw entry object as returned by the wasm bindings (snake_case). */
interface RawEntry {
  archive?: string;
  path: string;
  size: number;
  is_dir: boolean;
  is_symlink: boolean;
  symlink_target?: string;
}

/** Where an entry's bytes can be read from. */
type EntrySource =
  | { kind: "vfs"; path: string }
  | { kind: "archive"; archive: string; password?: string; format?: string }
  | {
    kind: "seekable";
    source: SeekableSource;
    /** Name used to infer the format for lazy reads (e.g. "archive.zip"). */
    name: string;
    password?: string;
    format?: string;
  };

// ---------------------------------------------------------------------------
// DecompressEntry
// ---------------------------------------------------------------------------

/**
 * One entry of an archive.
 *
 * `path`/`size` come from the archive metadata. `bytes`/`readable` return
 * the entry's contents: from the virtual filesystem when the entry was
 * extracted (`walk`/`decompress`), or lazily from the archive itself
 * (`list` results). Reading is deferred until `bytes` is accessed, so
 * iterating many entries does not decode everything up front.
 */
export class DecompressEntry {
  readonly path: string;
  /** Uncompressed size in bytes (as recorded in the archive). */
  readonly size: number;
  readonly isDir: boolean;
  readonly isSymlink: boolean;
  readonly symlinkTarget?: string;
  #ouch: Ouch;
  #source: EntrySource | null;

  constructor(ouch: Ouch, raw: RawEntry, source: EntrySource | null) {
    this.#ouch = ouch;
    this.#source = source;
    this.path = raw.path;
    this.size = raw.size;
    this.isDir = raw.is_dir;
    this.isSymlink = raw.is_symlink;
    this.symlinkTarget = raw.symlink_target;
  }

  /** The entry's contents. Directories and symlinks yield no bytes. */
  get bytes(): Uint8Array {
    if (this.isDir || this.isSymlink) return new Uint8Array(0);
    if (this.#source === null) {
      throw new Error(`entry "${this.path}" has no readable contents`);
    }
    if (this.#source.kind === "vfs") {
      return this.#ouch.readFile(this.#source.path);
    }
    if (this.#source.kind === "seekable") {
      return this.#ouch.readEntryFrom(this.#source.source, this.path, {
        name: this.#source.name,
        password: this.#source.password,
        format: this.#source.format,
      });
    }
    return this.#ouch.readEntry(this.#source.archive, this.path, {
      password: this.#source.password,
      format: this.#source.format,
    });
  }

  /** The entry's contents as a Web stream.
   *
   * For archive-backed entries this is a **true streaming** read: the entry is
   * decoded in bounded chunks inside wasm and pushed chunk by chunk, so memory
   * stays at chunk size even for huge entries (7z/rar entries are decoded
   * through their libraries' sequential readers). VFS-backed entries (already
   * extracted) are emitted as a single chunk. */
  get readable(): ReadableStream<Uint8Array> {
    if (this.isDir || this.isSymlink) {
      return new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new Uint8Array(0));
          controller.close();
        },
      });
    }
    const source = this.#source;
    if (source === null) {
      throw new Error(`entry "${this.path}" has no readable contents`);
    }
    if (source.kind === "vfs") {
      return new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(this.#ouch.readFile(source.path));
          controller.close();
        },
      });
    }
    if (source.kind === "seekable") {
      return this.#ouch.streamEntryFrom(source.source, this.path, {
        name: source.name,
        password: source.password,
        format: source.format,
      });
    }
    return this.#ouch.streamEntry(source.archive, this.path, {
      password: source.password,
      format: source.format,
    });
  }
}

// ---------------------------------------------------------------------------
// Ouch
// ---------------------------------------------------------------------------

/**
 * The ouch API. All operations happen on the shared in-memory virtual
 * filesystem: write inputs with [`Ouch#writeFile`], run operations, read
 * outputs with [`Ouch#readFile`]. Call [`Ouch#clear`] to reset between
 * independent jobs.
 */
export class Ouch {
  #wasm: typeof OuchWasm;

  private constructor(wasm: typeof OuchWasm) {
    this.#wasm = wasm;
  }

  /** @internal Factory used by [`init`]. */
  static create(wasm: typeof OuchWasm): Ouch {
    return new Ouch(wasm);
  }

  // -- VFS -------------------------------------------------------------

  /** Write (or overwrite) a file in the virtual filesystem. */
  writeFile(path: string, data: Uint8Array | ArrayBuffer): void {
    this.#wasm.vfs_write_file(path, toBytes(data));
  }

  /** Read a file from the virtual filesystem. */
  readFile(path: string): Uint8Array {
    return this.#wasm.vfs_read_file(path);
  }

  /** Check whether a path exists in the virtual filesystem. */
  exists(path: string): boolean {
    return this.#wasm.vfs_exists(path);
  }

  /** Check whether a path is a directory in the virtual filesystem. */
  isDir(path: string): boolean {
    return this.#wasm.vfs_is_dir(path);
  }

  /** List every path currently in the virtual filesystem (sorted). */
  listFiles(): string[] {
    return this.#wasm.vfs_list();
  }

  /** Remove a path (and everything under it) from the virtual filesystem. */
  remove(path: string): void {
    this.#wasm.vfs_remove(path);
  }

  /** Clear the whole virtual filesystem. */
  clear(): void {
    this.#wasm.vfs_clear();
  }

  /** Formats supported by this build. */
  static supportedFormats(): OuchFormat[] {
    return OuchWasm.supported_formats() as OuchFormat[];
  }

  // -- operations -------------------------------------------------------

  /**
   * Compress VFS files into `options.output`. The format comes from the
   * output extension (e.g. `out.tar.gz`) unless `options.format` is set.
   */
  compress(options: CompressOptions): CompressResult {
    const args = new CompressArgs([...options.files], options.output);
    if (options.format !== undefined) args.set_format(options.format);
    if (options.level !== undefined) args.set_level(options.level);
    if (options.password !== undefined) args.set_password(options.password);
    return this.#wasm.compress(args) as CompressResult;
  }

  /** Decompress VFS archives; outputs are written back into the VFS. */
  decompress(options: DecompressOptions): DecompressResult {
    const args = new DecompressArgs([...options.files]);
    if (options.outputDir !== undefined) args.set_output_dir(options.outputDir);
    if (options.password !== undefined) args.set_password(options.password);
    if (options.format !== undefined) args.set_format(options.format);
    if (options.overwrite !== undefined) args.set_overwrite(options.overwrite);
    const raw = this.#wasm.decompress(args) as {
      files_unpacked: number;
      entries: RawEntry[];
    };
    return {
      files_unpacked: raw.files_unpacked,
      // Decompressed entries live at their full VFS path.
      entries: raw.entries.map((entry) =>
        new DecompressEntry(this, entry, { kind: "vfs", path: entry.path })
      ),
    };
  }

  /** List the contents of archives. The returned entries read their bytes
   * lazily from the archive itself. */
  listArchive(options: ListOptions): DecompressEntry[] {
    const args = new ListArgs([...options.archives]);
    if (options.password !== undefined) args.set_password(options.password);
    if (options.format !== undefined) args.set_format(options.format);
    return (this.#wasm.list(args) as RawEntry[]).map((raw) =>
      new DecompressEntry(this, raw, {
        kind: "archive",
        archive: raw.archive ?? options.archives[0],
        password: options.password,
        format: options.format,
      })
    );
  }

  /** Read one entry's contents from an archive without extracting it. */
  readEntry(
    archive: string,
    entry: string,
    options: { password?: string; format?: string } = {},
  ): Uint8Array {
    const args = new ReadEntryArgs(archive, entry);
    if (options.password !== undefined) args.set_password(options.password);
    if (options.format !== undefined) args.set_format(options.format);
    return this.#wasm.read_entry(args);
  }

  /**
   * Stream-compress JS-owned files into `writable`. Input bytes are pulled
   * from each file's source in bounded chunks. `tar` (including chains like
   * `tar.gz` / `tar.xz` / `tar.br`) and the single-stream formats push output
   * chunks directly to `writable`; `zip`/`7z` write into `options.sink` (a
   * host-side seekable file, see [`fileSink`] / [`fileSinkSync`]) because
   * their encoders need a seekable output, then stream the file back in
   * chunks — wasm memory stays bounded either way. With a [`fileSinkSync`]
   * sink the encode writes straight to disk (bounded JS memory too); with an
   * async [`fileSink`] sink the encoder's writes are buffered in JS memory
   * and flushed asynchronously, so prefer the sync sink for huge archives.
   * `bz2` needs the buffered VFS flow ([`Ouch#compress`]).
   */
  async compressTo(
    files: CompressFile[],
    writable: WritableStream<Uint8Array>,
    options: {
      output: string;
      format?: string;
      level?: number;
      password?: string;
      /** Required for zip/7z: a seekable file sink, sync or async. */
      sink?: SeekableSink | AsyncSeekableSink;
    },
  ): Promise<CompressResult> {
    const args = new CompressFromArgs(options.output);
    if (options.format !== undefined) args.set_format(options.format);
    if (options.level !== undefined) args.set_level(options.level);
    if (options.password !== undefined) args.set_password(options.password);
    const fileArgs = files.map((f) => {
      const a = new CompressFileArgs(
        f.path,
        f.isDir ? 0 : f.source.size,
        readAtOf(f.source),
      );
      a.set_mode(f.mode ?? 0o644);
      if (f.isDir) a.set_dir(true);
      return a;
    });
    const wasm = this.#wasm;

    const fmt = (options.format ?? lastSegment(options.output)).toLowerCase();
    if (fmt === "zip" || fmt === "7z") {
      if (!options.sink) {
        throw new Error(
          `${fmt} streaming compression needs a seekable sink (Deno/Node file); pass options.sink = fileSinkSync(path) or fileSink(path)`,
        );
      }
      const writer = writable.getWriter();
      try {
        let result: CompressResult;
        if (isAsyncSink(options.sink)) {
          // The wasm encoder is synchronous, so capture its writes during the
          // call, then flush them to the async sink (and read the archive
          // back) without blocking the event loop.
          const writes: { offset: number; bytes: Uint8Array }[] = [];
          result = wasm.compress_to_sink(
            fileArgs,
            args,
            (offset: number, bytes: Uint8Array) => {
              writes.push({ offset, bytes });
              return offset + bytes.length;
            },
          ) as CompressResult;
          for (const w of writes) {
            await options.sink.writeAt(w.offset, w.bytes);
          }
          let offset = 0;
          while (offset < result.output_size) {
            const chunk = await options.sink.readAt(offset, STREAM_CHUNK);
            if (chunk.length === 0) break;
            await writer.write(chunk);
            offset += chunk.length;
          }
        } else {
          // Encode into the file, then stream it back in bounded chunks (this
          // path has real backpressure since the read-back loop is async).
          result = wasm.compress_to_sink(
            fileArgs,
            args,
            writeAtOf(options.sink),
          ) as CompressResult;
          let offset = 0;
          while (offset < result.output_size) {
            const chunk = options.sink.readAt(offset, STREAM_CHUNK);
            if (chunk.length === 0) break;
            await writer.write(chunk);
            offset += chunk.length;
          }
        }
        return result;
      } finally {
        writer.releaseLock();
      }
    }

    let result!: CompressResult;
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        try {
          result = wasm.compress_from(fileArgs, args, (chunk: Uint8Array) => {
            try {
              controller.enqueue(chunk);
            } catch {
              // Consumer cancelled; wasm aborts on the next emit.
            }
          }) as CompressResult;
          controller.close();
        } catch (err) {
          try {
            controller.error(err);
          } catch {
            // Already cancelled.
          }
        }
      },
    });
    await readable.pipeTo(writable);
    return result;
  }

  /**
   * Stream one entry's contents out of an archive (or a single-file format)
   * in bounded chunks. The underlying wasm call runs synchronously once the
   * stream is constructed, pushing each chunk into the stream; `entry` is
   * ignored for single-file formats (gz, xz, bz2, ...). Prefer this over
   * [`Ouch#readEntry`] for large files.
   */
  streamEntry(
    archive: string,
    entry: string,
    options: { password?: string; format?: string } = {},
  ): ReadableStream<Uint8Array> {
    const args = new StreamEntryArgs(archive, entry);
    if (options.password !== undefined) args.set_password(options.password);
    if (options.format !== undefined) args.set_format(options.format);
    const wasm = this.#wasm;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        try {
          wasm.stream_entry(args, (chunk: Uint8Array) => {
            try {
              controller.enqueue(chunk);
            } catch {
              // Consumer cancelled the stream; wasm aborts on the next emit.
            }
          });
          controller.close();
        } catch (err) {
          try {
            controller.error(err);
          } catch {
            // Already cancelled.
          }
        }
      },
    });
  }

  // -- seekable (random-access) sources ----------------------------------

  /**
   * List the contents of an archive held by a JS-side [`SeekableSource`].
   * Only the metadata blocks are pulled from the host (zip central
   * directory, tar headers, 7z header), so the whole archive never enters
   * wasm memory. `options.name` (e.g. "archive.zip") is used to infer the
   * format unless `options.format` is given.
   */
  listFrom(
    source: SeekableSource,
    options: { name?: string; format?: string; password?: string } = {},
  ): DecompressEntry[] {
    const args = seekableArgs(options, "");
    const raw = this.#wasm.seekable_list(
      args,
      readAtOf(source),
      source.size,
    ) as RawEntry[];
    return raw.map((entry) =>
      new DecompressEntry(this, entry, {
        kind: "seekable",
        source,
        name: options.name ?? "",
        password: options.password,
        format: options.format,
      })
    );
  }

  /** Read one entry from an archive held by a JS-side [`SeekableSource`];
   * only that entry's data is pulled from the host. */
  readEntryFrom(
    source: SeekableSource,
    entry: string,
    options: { name?: string; format?: string; password?: string } = {},
  ): Uint8Array {
    const args = seekableArgs(options, entry);
    return this.#wasm.seekable_read_entry(args, readAtOf(source), source.size);
  }

  /** Stream one entry from an archive held by a JS-side [`SeekableSource`]
   * in bounded chunks (see [`Ouch#streamEntry`]). */
  streamEntryFrom(
    source: SeekableSource,
    entry: string,
    options: { name?: string; format?: string; password?: string } = {},
  ): ReadableStream<Uint8Array> {
    const args = seekableArgs(options, entry);
    const wasm = this.#wasm;
    const readAt = readAtOf(source);
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        try {
          wasm.seekable_stream_entry(
            args,
            readAt,
            source.size,
            (chunk: Uint8Array) => {
              try {
                controller.enqueue(chunk);
              } catch {
                // Consumer cancelled the stream; wasm aborts on the next emit.
              }
            },
          );
          controller.close();
        } catch (err) {
          try {
            controller.error(err);
          } catch {
            // Already cancelled.
          }
        }
      },
    });
  }

  /**
   * Iterate over archive entries lazily. Nothing is extracted: each
   * yielded entry's `readable`/`bytes` decode just that entry on demand.
   */
  async *walk(options: ListOptions): AsyncGenerator<DecompressEntry> {
    yield* this.listArchive(options);
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

let instance: Promise<Ouch> | null = null;

/**
 * Initialize the wasm module (once) and return the ouch API.
 *
 * `moduleOrPath` optionally overrides how the wasm binary is loaded (URL,
 * bytes, or precompiled `WebAssembly.Module`); by default the `ouch_bg.wasm`
 * next to the bindings is fetched.
 */
export function init(
  moduleOrPath?: InitInput | Promise<InitInput>,
): Promise<Ouch> {
  instance ??= initWasm(moduleOrPath).then(() => Ouch.create(OuchWasm));
  return instance;
}

type InitInput =
  | RequestInfo
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function seekableArgs(
  options: { name?: string; format?: string; password?: string },
  entry: string,
): SeekableArgs {
  const args = new SeekableArgs(options.name ?? "", entry);
  if (options.format !== undefined) args.set_format(options.format);
  if (options.password !== undefined) args.set_password(options.password);
  return args;
}

function readAtOf(
  source: SeekableSource,
): (offset: number, length: number) => Uint8Array {
  return (offset, length) => source.readAt(offset, length);
}

function writeAtOf(
  sink: SeekableSink,
): (offset: number, bytes: Uint8Array) => number {
  return (offset, bytes) => sink.writeAt(offset, bytes);
}

/** Narrow a `SeekableSink | AsyncSeekableSink` union to the async side. */
function isAsyncSink(
  sink: SeekableSink | AsyncSeekableSink,
): sink is AsyncSeekableSink {
  return typeof (sink as AsyncSeekableSink).size === "function";
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? path : path.slice(i + 1);
}

/** Same as the wasm chunk size: 256 KiB. */
const STREAM_CHUNK = 256 * 1024;

// ---------------------------------------------------------------------------
// Module-level convenience helpers
// ---------------------------------------------------------------------------

/**
 * Compress and pipe the produced bytes into `writer` (e.g.
 * `new WritableStream({ write: (c) => ... })`).
 */
export async function compress(
  writer: WritableStream<Uint8Array>,
  options: CompressOptions,
): Promise<CompressResult> {
  const ouch = await init();
  const result = ouch.compress(options);
  const bytes = ouch.readFile(result.output);
  const w = writer.getWriter();
  try {
    await w.write(bytes);
  } finally {
    w.releaseLock();
  }
  return result;
}

/**
 * Stream-compress JS-owned files into `writable` in bounded chunks (see
 * [`Ouch#compressTo`]).
 */
export async function compressTo(
  files: CompressFile[],
  writable: WritableStream<Uint8Array>,
  options: {
    output: string;
    format?: string;
    level?: number;
    password?: string;
  },
): Promise<CompressResult> {
  return (await init()).compressTo(files, writable, options);
}

/** List archive contents (metadata only). */
export async function list(options: ListOptions): Promise<DecompressEntry[]> {
  return (await init()).listArchive(options);
}

/**
 * Iterate over archive entries lazily, decoding each entry's contents only
 * when its `readable`/`bytes` are accessed.
 */
export async function* walk(
  options: ListOptions,
): AsyncGenerator<DecompressEntry> {
  yield* (await init()).walk(options);
}
