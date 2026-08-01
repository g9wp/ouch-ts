// Ouch: a WASM-backed (de)compression library.
//
// Node entry point (`@g9wp/ouch/node`): re-exports the runtime-agnostic core
// and provides file helpers backed directly by `node:fs` / `node:fs/promises`
// — no runtime detection, no `process.getBuiltinModule`, so it also works
// with Node bundlers. Positions go through the raw file descriptor, so the
// same code runs on real Node and Deno's node compatibility layer.

export * from "./mod.ts";
import {
  fromBytes,
  type AsyncSeekableSink,
  type AsyncSeekableSource,
  type SeekableSink,
  type SeekableSource,
} from "./mod.ts";
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import {
  open as openPromise,
  readFile as readFilePromise,
  writeFile as writeFilePromise,
} from "node:fs/promises";

/**
 * A seekable source over a Node file, opened read-only and kept open until
 * `close()` is called. True disk random access: listing a huge archive only
 * reads its header blocks.
 */
export function fromFileSync(
  path: string | URL,
): SeekableSource & { close(): void } {
  const fd = openSync(path, "r");
  return {
    size: fstatSync(fd).size,
    readAt(offset, length) {
      const buf = new Uint8Array(length);
      const n = readSync(fd, buf, 0, length, offset);
      return n <= 0 ? new Uint8Array(0) : buf.slice(0, n);
    },
    close() {
      closeSync(fd);
    },
  };
}

/**
 * A seekable sink over a Node file (created/truncated), kept open until
 * `close()` is called. Enables streaming zip/7z compression with bounded
 * memory: the archive is written to disk, then streamed back in chunks.
 */
export function fileSinkSync(
  path: string | URL,
): SeekableSink & { close(): void } {
  const fd = openSync(path, "w+");
  return {
    get size() {
      return fstatSync(fd).size;
    },
    writeAt(offset, bytes) {
      writeSync(fd, bytes, 0, bytes.length, offset);
      return offset + bytes.length;
    },
    readAt(offset, length) {
      const buf = new Uint8Array(length);
      const n = readSync(fd, buf, 0, length, offset);
      return n <= 0 ? new Uint8Array(0) : buf.slice(0, n);
    },
    close() {
      closeSync(fd);
    },
  };
}

/**
 * Asynchronously open a Node file and return a seekable random-access
 * source — the async counterpart of [`fromFileSync`]. Every operation is
 * promise-based: `size()`/`readAt()` use async file I/O and never block the
 * event loop, and reads hit the disk at the requested offset — no whole-file
 * load. Because the wasm parsers are synchronous, the seekable `Ouch` methods
 * buffer an async source in memory before parsing; prefer [`fromFileSync`]
 * for huge archives. Close the handle with `await src.close()`.
 */
export async function fromFile(
  path: string | URL,
): Promise<AsyncSeekableSource> {
  const handle = await openPromise(path, "r");
  return {
    size: async () => (await handle.stat()).size,
    async readAt(offset, length) {
      const buf = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await handle.read(
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
    close: () => handle.close(),
  };
}

/**
 * Asynchronously create a seekable sink over a Node file (created/truncated)
 * — the async counterpart of [`fileSinkSync`]. Every operation is
 * promise-based: `writeAt`/`readAt` use async file I/O and never block the
 * event loop. Close the handle with `await sink.close()`.
 */
export async function fileSink(path: string | URL): Promise<AsyncSeekableSink> {
  const handle = await openPromise(path, "w+");
  return {
    size: async () => (await handle.stat()).size,
    async writeAt(offset, bytes) {
      let written = 0;
      while (written < bytes.length) {
        const { bytesWritten } = await handle.write(
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
        const { bytesRead } = await handle.read(
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
    close: () => handle.close(),
  };
}

/** Asynchronously read a whole file. */
export async function readFile(path: string | URL): Promise<Uint8Array> {
  // node:fs returns a Buffer (a Uint8Array subclass); normalize so callers
  // always get a plain Uint8Array, like the Deno entry does.
  return new Uint8Array((await readFilePromise(path)) as Uint8Array);
}

/** Asynchronously write a whole file. */
export async function writeFile(
  path: string | URL,
  data: Uint8Array,
): Promise<void> {
  await writeFilePromise(path, data);
}

/**
 * Asynchronously load a *whole* file into memory as a buffered seekable
 * source. Prefer [`fromFile`] / [`fromFileSync`] for anything large — they
 * read from disk on demand instead of copying everything up front.
 */
export async function loadFile(path: string | URL): Promise<SeekableSource> {
  return fromBytes(await readFile(path));
}
