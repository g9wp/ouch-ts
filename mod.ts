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
 * [`fromBytes`] and [`fromFile`] for ready-made implementations.
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
 * A seekable source over a Deno file, opened read-only and kept open until
 * `close()` is called. This gives true disk random access: listing a huge
 * archive only reads its header blocks. Not available in browsers (no sync
 * file API); pass `--allow-read` when running under Deno.
 */
export function fromFile(
  path: string | URL,
): SeekableSource & { close(): void } {
  const deno = (globalThis as unknown as {
    Deno?: {
      openSync(p: string | URL, opts: { read: true }): {
        statSync(): { size: number };
        seekSync(offset: number, mode: number): number;
        readSync(buf: Uint8Array): number | null;
        close(): void;
      };
    };
  }).Deno;
  if (!deno) {
    throw new Error("fromFile is only available in Deno");
  }
  const file = deno.openSync(path, { read: true });
  return {
    size: file.statSync().size,
    readAt(offset, length) {
      // Deno.SeekMode.Start === 0
      file.seekSync(offset, 0);
      const buf = new Uint8Array(length);
      const n = file.readSync(buf);
      return n === null ? new Uint8Array(0) : buf.slice(0, n);
    },
    close() {
      file.close();
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
