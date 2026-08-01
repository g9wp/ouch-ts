// Ouch: a WASM-backed (de)compression library.
//
// Deno entry point (`@g9wp/ouch/deno`): re-exports the runtime-agnostic core
// and provides file helpers backed directly by the Deno file APIs — no
// runtime detection, no `fs` parameters. Import this from Deno to avoid the
// Node probing in the universal `mod.ts`. Browsers: use `mod.ts` or `loadFile`
// via `fetch`. Node: use `@g9wp/ouch/node`.

export * from "./core.ts";
import {
  fromBytes,
  type AsyncSeekableSink,
  type AsyncSeekableSource,
  type SeekableSink,
  type SeekableSource,
} from "./core.ts";

/**
 * A seekable source over a Deno file, opened read-only and kept open until
 * `close()` is called. True disk random access: listing a huge archive only
 * reads its header blocks.
 */
export function fromFileSync(
  path: string | URL,
): SeekableSource & { close(): void } {
  const file = Deno.openSync(path, { read: true });
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

/**
 * A seekable sink over a Deno file (created/truncated), kept open until
 * `close()` is called. Enables streaming zip/7z compression with bounded
 * memory: the archive is written to disk, then streamed back in chunks.
 */
export function fileSinkSync(
  path: string | URL,
): SeekableSink & { close(): void } {
  const file = Deno.openSync(path, {
    read: true,
    write: true,
    create: true,
    truncate: true,
  });
  return {
    get size() {
      return file.statSync().size;
    },
    writeAt(offset, bytes) {
      file.seekSync(offset, 0);
      file.writeSync(bytes);
      return offset + bytes.length;
    },
    readAt(offset, length) {
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

/**
 * Asynchronously open a Deno file and return a seekable random-access
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
  const file = await Deno.open(path, { read: true });
  return {
    size: async () => (await file.stat()).size,
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

/**
 * Asynchronously create a seekable sink over a Deno file (created/truncated)
 * — the async counterpart of [`fileSinkSync`]. Every operation is
 * promise-based: `writeAt`/`readAt` use async file I/O and never block the
 * event loop. Close the handle with `await sink.close()`.
 */
export async function fileSink(path: string | URL): Promise<AsyncSeekableSink> {
  const file = await Deno.open(path, {
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

/** Asynchronously read a whole file. */
export async function readFile(path: string | URL): Promise<Uint8Array> {
  return Deno.readFile(path);
}

/** Asynchronously write a whole file. */
export async function writeFile(
  path: string | URL,
  data: Uint8Array,
): Promise<void> {
  await Deno.writeFile(path, data);
}

/**
 * Asynchronously load a *whole* file into memory as a buffered seekable
 * source. Prefer [`fromFile`] / [`fromFileSync`] for anything large — they
 * read from disk on demand instead of copying everything up front.
 */
export async function loadFile(path: string | URL): Promise<SeekableSource> {
  return fromBytes(await Deno.readFile(path));
}
