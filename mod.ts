// Ouch: a WASM-backed (de)compression library.
//
// Universal entry point: re-exports the runtime-agnostic core and adds file
// helpers that auto-detect the runtime (Deno, Node via `process.getBuiltinModule`,
// or browser `fetch`). Runtime-specific entry points without detection logic:
//   - "./deno": Deno file helpers (Deno.* APIs)
//   - "./node": Node file helpers (node:fs / node:fs/promises)

export * from "./core.ts";
import {
  fromBytes,
  type AsyncSeekableSink,
  type SeekableSink,
  type SeekableSource,
} from "./core.ts";

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
