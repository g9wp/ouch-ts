import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  fileSink,
  fileSinkSync,
  fromBlob,
  fromBytes,
  fromFile,
  fromFileSync,
  init,
  loadFile,
  readFile,
  type AsyncFs,
  type SeekableSource,
  walk,
  writeFile,
} from "./mod.ts";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

Deno.test("gz single-file roundtrip", async () => {
  const ouch = await init();
  ouch.clear();

  const content = bytes("hello gz!");
  ouch.writeFile("a.txt", content);

  ouch.compress({ files: ["a.txt"], output: "a.txt.gz" });
  assert(ouch.exists("a.txt.gz"));

  const listed = ouch.listArchive({ archives: ["a.txt.gz"] });
  assertEquals(listed.length, 1);

  const result = ouch.decompress({ files: ["a.txt.gz"] });
  assertEquals(result.files_unpacked, 1);
  assertEquals(result.entries.map((e) => e.path), ["a.txt"]);
  assertEquals(text(ouch.readFile("a.txt")), "hello gz!");
});

Deno.test("tar.gz roundtrip with directories", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("in/hello.txt", bytes("hello wasm!"));
  ouch.writeFile("in/sub/nested.txt", bytes("nested!"));

  const result = ouch.compress({ files: ["in"], output: "out.tar.gz" });
  assert(result.output_size > 0);
  assertEquals(result.entries, 4); // "in" + 2 files + "in/sub"

  const entries = ouch.listArchive({ archives: ["out.tar.gz"] });
  assertEquals(
    entries.map((e) => e.path),
    ["in", "in/hello.txt", "in/sub", "in/sub/nested.txt"],
  );

  const unpacked = ouch.decompress({ files: ["out.tar.gz"] });
  assertEquals(unpacked.files_unpacked, 2);
  assertEquals(text(ouch.readFile("out/in/hello.txt")), "hello wasm!");
  assertEquals(text(ouch.readFile("out/in/sub/nested.txt")), "nested!");
});

Deno.test("zip roundtrip with encryption", async () => {
  const ouch = await init();
  ouch.clear();

  const content = bytes("secret zip content");
  ouch.writeFile("doc.txt", content);

  ouch.compress({ files: ["doc.txt"], output: "doc.zip", password: "pw" });

  // Encrypted archives need the password even to list.
  assertThrows(() => ouch.listArchive({ archives: ["doc.zip"] }));
  const entries = ouch.listArchive({ archives: ["doc.zip"], password: "pw" });
  assertEquals(entries.map((e) => e.path), ["doc.txt"]);

  // Wrong / missing password must fail.
  assertThrows(() => ouch.decompress({ files: ["doc.zip"], outputDir: "out" }));
  assertThrows(() => ouch.readEntry("doc.zip", "doc.txt"));

  const unpacked = ouch.decompress({
    files: ["doc.zip"],
    password: "pw",
    outputDir: "out",
  });
  assertEquals(unpacked.files_unpacked, 1);
  assertEquals(text(ouch.readFile("out/doc.txt")), "secret zip content");
});

Deno.test("7z roundtrip with encryption", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("data.bin", bytes("seven zip secret"));
  ouch.compress({ files: ["data.bin"], output: "data.7z", password: "pw" });

  assertThrows(() => ouch.listArchive({ archives: ["data.7z"] }));
  assertThrows(() => ouch.decompress({ files: ["data.7z"] }));

  const entries = ouch.listArchive({ archives: ["data.7z"], password: "pw" });
  assertEquals(entries.map((e) => e.path), ["data.bin"]);

  const unpacked = ouch.decompress({
    files: ["data.7z"],
    password: "pw",
    outputDir: "out7z",
  });
  assertEquals(unpacked.files_unpacked, 1);
  assertEquals(text(ouch.readFile("out7z/data.bin")), "seven zip secret");
});

Deno.test("zip and 7z compression levels", async () => {
  const ouch = await init();
  ouch.clear();

  // Highly repetitive payload so higher levels produce a smaller archive.
  const payload = bytes("abracadabra ".repeat(2000));
  ouch.writeFile("f.txt", payload);

  for (const ext of ["zip", "7z"]) {
    const low = ouch.compress({
      files: ["f.txt"],
      output: `f1.${ext}`,
      level: 1,
    });
    const high = ouch.compress({
      files: ["f.txt"],
      output: `f9.${ext}`,
      level: 9,
    });
    assert(low.output_size > 0);
    assert(
      high.output_size <= low.output_size,
      `level 9 should not be bigger than level 1 for .${ext}`,
    );
    assertEquals(
      text(
        ouch.readFile(
          ouch.decompress({ files: [`f1.${ext}`], outputDir: `o1` }).entries[0]
            .path,
        ),
      ),
      "abracadabra ".repeat(2000),
    );
    assertEquals(
      text(
        ouch.readFile(
          ouch.decompress({ files: [`f9.${ext}`], outputDir: `o9` }).entries[0]
            .path,
        ),
      ),
      "abracadabra ".repeat(2000),
    );
  }
});

Deno.test("7z roundtrip", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("data.bin", bytes("seven zip data"));
  ouch.compress({ files: ["data.bin"], output: "data.7z" });

  const entries = ouch.listArchive({ archives: ["data.7z"] });
  assertEquals(entries.map((e) => e.path), ["data.bin"]);

  const unpacked = ouch.decompress({ files: ["data.7z"], outputDir: "out7z" });
  assertEquals(unpacked.files_unpacked, 1);
  assertEquals(text(ouch.readFile("out7z/data.bin")), "seven zip data");
});

Deno.test("xz + brotli single-file", async () => {
  const ouch = await init();
  ouch.clear();

  const content = bytes("compress me");
  for (const ext of ["xz", "br", "lz4", "sz", "lzma"]) {
    ouch.writeFile(`f.${ext}`, content);
    ouch.compress({ files: [`f.${ext}`], output: `f.${ext}.${ext}` });
    const result = ouch.decompress({ files: [`f.${ext}.${ext}`] });
    assertEquals(result.files_unpacked, 1);
    assertEquals(text(ouch.readFile(`f.${ext}`)), "compress me");
    ouch.clear();
  }
});

Deno.test("walk yields entries lazily", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("a.txt", bytes("aaa"));
  ouch.writeFile("b.txt", bytes("bbbb"));
  ouch.compress({ files: ["a.txt", "b.txt"], output: "pair.zip" });

  const seen: string[] = [];
  const contents: string[] = [];
  for await (const entry of walk({ archives: ["pair.zip"] })) {
    seen.push(entry.path);
    assert(entry.size > 0);
    const data = await entry.readable.getReader().read();
    assert(data.value instanceof Uint8Array);
    contents.push(text(data.value));
  }
  assertEquals(seen, ["a.txt", "b.txt"]);
  assertEquals(contents, ["aaa", "bbbb"]);
});

Deno.test("list entries read bytes lazily from the archive", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("secret.txt", bytes("read me lazily"));
  ouch.compress({ files: ["secret.txt"], output: "secret.zip" });

  const [entry] = ouch.listArchive({ archives: ["secret.zip"] });
  assertEquals(entry.path, "secret.txt");
  assertEquals(text(entry.bytes), "read me lazily");

  const chunk = await entry.readable.getReader().read();
  assertEquals(text(chunk.value!), "read me lazily");
});

Deno.test("readEntry reads a single zip entry", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("doc.txt", bytes("zip content"));
  ouch.compress({ files: ["doc.txt"], output: "plain.zip" });

  const raw = ouch.readEntry("plain.zip", "doc.txt");
  assertEquals(text(raw), "zip content");
  assertThrows(() => ouch.readEntry("plain.zip", "nope.txt"));
});

Deno.test("unsupported format errors cleanly", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("f.bin", bytes("x"));
  assertThrows(() => ouch.compress({ files: ["f.bin"], output: "f.bz3" }));
  assertThrows(() => ouch.compress({ files: ["f.bin"], output: "f.zst" }));
  assertThrows(() => ouch.compress({ files: ["f.bin"], output: "f.rar" }));
});

Deno.test("bz2 roundtrip (banzai encoder + bzip2-rs decoder)", async () => {
  const ouch = await init();
  ouch.clear();

  const content = bytes("hello bz2!");
  ouch.writeFile("a.txt", content);
  ouch.compress({ files: ["a.txt"], output: "a.txt.bz2" });

  const listed = ouch.listArchive({ archives: ["a.txt.bz2"] });
  assertEquals(listed.length, 1);

  const result = ouch.decompress({ files: ["a.txt.bz2"] });
  assertEquals(result.files_unpacked, 1);
  assertEquals(text(ouch.readFile("a.txt")), "hello bz2!");
});

Deno.test("zst decompress (fixture created by the zstd CLI)", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("sample.zst", await Deno.readFile("./fixtures/sample.zst"));

  const result = ouch.decompress({ files: ["sample.zst"] });
  assertEquals(result.files_unpacked, 1);
  assertEquals(
    text(ouch.readFile("sample")),
    "the quick brown fox jumps over the lazy dog. ".repeat(4),
  );
});

Deno.test("rar decompress (fixture created with the rars writer)", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("sample.rar", await Deno.readFile("./fixtures/sample.rar"));

  const listed = ouch.listArchive({ archives: ["sample.rar"] });
  assertEquals(listed.map((e) => e.path), ["hello.txt"]);

  const result = ouch.decompress({ files: ["sample.rar"], outputDir: "x" });
  assertEquals(result.files_unpacked, 1);
  assertEquals(
    text(ouch.readFile("x/hello.txt")),
    "the quick brown fox jumps over the lazy dog. ".repeat(8),
  );
});

async function collectStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

Deno.test("streamEntry streams a large zip entry in chunks", async () => {
  const ouch = await init();
  ouch.clear();

  // ~2 MiB payload: big enough to be split into several 256 KiB chunks.
  const payload = bytes("0123456789abcdef".repeat(128 * 1024));
  assertEquals(payload.length, 2 * 1024 * 1024);
  ouch.writeFile("big.bin", payload);
  ouch.compress({ files: ["big.bin"], output: "big.zip" });

  const [entry] = ouch.listArchive({ archives: ["big.zip"] });
  assertEquals(entry.path, "big.bin");
  assertEquals(entry.size, payload.length);

  const chunks = await collectStream(entry.readable);
  assert(chunks.length > 1, "expected multiple chunks");
  for (const chunk of chunks) {
    assert(chunk.length <= 256 * 1024, "chunk exceeds the chunk size");
  }
  assertEquals(joinChunks(chunks), payload);
});

Deno.test("streamEntry decodes a tar.gz chain without buffering", async () => {
  const ouch = await init();
  ouch.clear();

  const content = bytes("streamed through tar.gz".repeat(200));
  ouch.writeFile("in/doc.txt", content);
  ouch.compress({ files: ["in"], output: "docs.tar.gz" });

  const entries = ouch.listArchive({ archives: ["docs.tar.gz"] });
  const doc = entries.find((e) => e.path === "in/doc.txt")!;
  assertEquals(joinChunks(await collectStream(doc.readable)), content);
});

Deno.test("streamEntry streams the rar fixture entry", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("sample.rar", await Deno.readFile("./fixtures/sample.rar"));
  const [entry] = ouch.listArchive({ archives: ["sample.rar"] });
  const chunks = await collectStream(entry.readable);
  assertEquals(
    text(joinChunks(chunks)),
    "the quick brown fox jumps over the lazy dog. ".repeat(8),
  );
});

Deno.test("streamEntry decodes a single-file gz", async () => {
  const ouch = await init();
  ouch.clear();

  const content = bytes("single file stream".repeat(500));
  ouch.writeFile("a.txt", content);
  ouch.compress({ files: ["a.txt"], output: "a.txt.gz" });

  // For single-file formats the entry name is ignored.
  const chunks = await collectStream(
    ouch.streamEntry("a.txt.gz", "ignored"),
  );
  assertEquals(joinChunks(chunks), content);
});

Deno.test("listFrom / readEntryFrom / streamEntryFrom over a byte source", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("doc.txt", bytes("seekable content"));
  ouch.compress({ files: ["doc.txt"], output: "seek.zip" });
  const src = fromBytes(ouch.readFile("seek.zip"));

  const entries = await ouch.listFrom(src, { name: "seek.zip" });
  assertEquals(entries.map((e) => e.path), ["doc.txt"]);
  // Lazy read goes back through the seekable source.
  assertEquals(text(entries[0].bytes), "seekable content");
  assertEquals(
    text(await ouch.readEntryFrom(src, "doc.txt", { name: "seek.zip" })),
    "seekable content",
  );
  const chunks = await collectStream(
    ouch.streamEntryFrom(src, "doc.txt", { name: "seek.zip" }),
  );
  assertEquals(text(joinChunks(chunks)), "seekable content");
});

Deno.test("listFrom reads tar metadata via seek (data is skipped)", async () => {
  const ouch = await init();
  ouch.clear();

  const payload = bytes("x".repeat(2 * 1024 * 1024));
  ouch.writeFile("big.bin", payload);
  ouch.writeFile("small.txt", bytes("small"));
  ouch.compress({ files: ["big.bin", "small.txt"], output: "big.tar" });
  const src = fromBytes(ouch.readFile("big.tar"));

  const entries = await ouch.listFrom(src, { name: "big.tar" });
  assertEquals(entries.map((e) => e.path).sort(), ["big.bin", "small.txt"]);
  // Reading only the small entry: big.bin's data is skipped by seek.
  assertEquals(
    text(await ouch.readEntryFrom(src, "small.txt", { name: "big.tar" })),
    "small",
  );
  assertEquals(
    await ouch.readEntryFrom(src, "big.bin", { name: "big.tar" }),
    payload,
  );
});

Deno.test("listFrom over a 7z source", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("a.txt", bytes("seven"));
  ouch.compress({ files: ["a.txt"], output: "a.7z" });
  const src = fromBytes(ouch.readFile("a.7z"));

  const entries = await ouch.listFrom(src, { name: "a.7z" });
  assertEquals(entries.map((e) => e.path), ["a.txt"]);
  assertEquals(
    text(await ouch.readEntryFrom(src, "a.txt", { name: "a.7z" })),
    "seven",
  );
});

Deno.test("fromFileSync reads a zip on disk via random access", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("doc.txt", bytes("from file source"));
  ouch.compress({ files: ["doc.txt"], output: "disk.zip" });
  const archiveBytes = ouch.readFile("disk.zip");

  const tmp = await Deno.makeTempFile({ suffix: ".zip" });
  try {
    await Deno.writeFile(tmp, archiveBytes);
    const src = fromFileSync(tmp);
    try {
      const entries = await ouch.listFrom(src, { name: "disk.zip" });
      assertEquals(entries.map((e) => e.path), ["doc.txt"]);
      assertEquals(
        text(await ouch.readEntryFrom(src, "doc.txt", { name: "disk.zip" })),
        "from file source",
      );
    } finally {
      src.close();
    }
  } finally {
    await Deno.remove(tmp);
  }
});

/** A seekable source that counts how many bytes the wasm side actually pulled. */
function countingSource(
  bytes: Uint8Array,
): { source: SeekableSource; bytesRead: () => number } {
  let total = 0;
  const source: SeekableSource = {
    size: bytes.length,
    readAt(offset, length) {
      const chunk = bytes.slice(
        offset,
        Math.min(offset + length, bytes.length),
      );
      total += chunk.length;
      return chunk;
    },
  };
  return { source, bytesRead: () => total };
}

/** Deterministic pseudo-random bytes (incompressible, unlike repeated text). */
function noise(len: number): Uint8Array {
  const out = new Uint8Array(len);
  let state = 0x12345678;
  for (let i = 0; i < len; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state >> 24) & 0xff;
  }
  return out;
}

Deno.test("listFrom reads only metadata, not the whole archive", async () => {
  const ouch = await init();
  ouch.clear();

  // 2 MiB of incompressible payload: the zip central directory is at the end,
  // so listing must not pull the file data.
  const payload = noise(2 * 1024 * 1024);
  ouch.writeFile("big.bin", payload);
  ouch.compress({ files: ["big.bin"], output: "big.zip" });
  const archive = ouch.readFile("big.zip");
  assert(archive.length > payload.length);

  const { source, bytesRead } = countingSource(archive);
  const entries = await ouch.listFrom(source, { name: "big.zip" });
  assertEquals(entries.map((e) => e.path), ["big.bin"]);

  const read = bytesRead();
  assert(read > 0, "expected at least the central directory to be read");
  assert(
    read < archive.length / 100,
    `listing pulled ${read} bytes from a ${archive.length}-byte zip; expected only metadata`,
  );
});

Deno.test("readEntryFrom pulls only the target entry's data", async () => {
  const ouch = await init();
  ouch.clear();

  const big = bytes("x".repeat(2 * 1024 * 1024));
  ouch.writeFile("big.bin", big);
  ouch.writeFile("small.txt", bytes("small"));
  ouch.compress({ files: ["big.bin", "small.txt"], output: "pair.tar" });
  const archive = ouch.readFile("pair.tar");

  const { source, bytesRead } = countingSource(archive);
  // Reading the small entry must seek over big.bin's 2 MiB of data.
  assertEquals(
    text(await ouch.readEntryFrom(source, "small.txt", { name: "pair.tar" })),
    "small",
  );
  const read = bytesRead();
  assert(
    read < big.length / 10,
    `reading one entry pulled ${read} bytes; big.bin's ${big.length} bytes should be seek-skipped`,
  );
});

Deno.test("seekable source handles tar.gz chains", async () => {
  const ouch = await init();
  ouch.clear();

  const content = bytes("chained seekable read");
  ouch.writeFile("in/doc.txt", content);
  ouch.compress({ files: ["in"], output: "docs.tar.gz" });
  const src = fromBytes(ouch.readFile("docs.tar.gz"));

  const entries = await ouch.listFrom(src, { name: "docs.tar.gz" });
  assertEquals(entries.map((e) => e.path).sort(), ["in", "in/doc.txt"]);
  assertEquals(
    text(await ouch.readEntryFrom(src, "in/doc.txt", { name: "docs.tar.gz" })),
    text(content),
  );
});

Deno.test("seekable source rejects wrapped zip/7z/rar archives", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("a.txt", bytes("wrapped"));
  ouch.compress({ files: ["a.txt"], output: "a.zip.gz" });
  const src = fromBytes(ouch.readFile("a.zip.gz"));

  assertRejects(() => ouch.listFrom(src, { name: "a.zip.gz" }));
});

function collectWritable(chunks: Uint8Array[]): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
}

Deno.test("compressTo streams a gz file in chunks", async () => {
  const ouch = await init();
  ouch.clear();

  // ~2 MiB of incompressible payload -> several 256 KiB output chunks.
  const payload = noise(2 * 1024 * 1024);
  const chunks: Uint8Array[] = [];
  const result = await ouch.compressTo(
    [{ path: "big.bin", source: fromBytes(payload) }],
    collectWritable(chunks),
    { output: "big.gz" },
  );
  assertEquals(result.entries, 1);
  assertEquals(result.output_size, chunks.reduce((n, c) => n + c.length, 0));
  assert(chunks.length > 1, "expected the output to arrive in multiple chunks");
  for (const chunk of chunks) {
    assert(chunk.length <= 256 * 1024, "chunk exceeds the chunk size");
  }

  // The streamed bytes form a valid archive: decompress them via the VFS.
  ouch.writeFile("big.gz", joinChunks(chunks));
  const unpacked = ouch.decompress({ files: ["big.gz"] });
  assertEquals(unpacked.files_unpacked, 1);
  assertEquals(ouch.readFile("big"), payload);
});

Deno.test("compressTo builds a tar.gz from multiple files", async () => {
  const ouch = await init();
  ouch.clear();

  const a = bytes("hello from compressTo");
  const b = noise(512 * 1024);
  const chunks: Uint8Array[] = [];
  const result = await ouch.compressTo(
    [
      { path: "docs", source: fromBytes(new Uint8Array(0)), isDir: true },
      { path: "docs/a.txt", source: fromBytes(a) },
      { path: "docs/b.bin", source: fromBytes(b) },
    ],
    collectWritable(chunks),
    { output: "docs.tar.gz" },
  );
  assertEquals(result.entries, 3);

  ouch.writeFile("docs.tar.gz", joinChunks(chunks));
  const unpacked = ouch.decompress({ files: ["docs.tar.gz"], outputDir: "x" });
  assertEquals(unpacked.files_unpacked, 2);
  assertEquals(ouch.readFile("x/docs/a.txt"), a);
  assertEquals(ouch.readFile("x/docs/b.bin"), b);
});

Deno.test("compressTo reads input from a disk file", async () => {
  const ouch = await init();
  ouch.clear();

  const payload = bytes("from disk to gz");
  const tmp = await Deno.makeTempFile();
  try {
    await Deno.writeFile(tmp, payload);
    const src = fromFileSync(tmp);
    try {
      const chunks: Uint8Array[] = [];
      await ouch.compressTo(
        [{ path: "d.txt", source: src }],
        collectWritable(chunks),
        { output: "d.gz" },
      );
      ouch.writeFile("d.gz", joinChunks(chunks));
      const unpacked = ouch.decompress({ files: ["d.gz"] });
      assertEquals(unpacked.files_unpacked, 1);
      assertEquals(text(ouch.readFile("d")), "from disk to gz");
    } finally {
      src.close();
    }
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("fromFileSync / fileSinkSync work through a node:fs backend", async () => {
  // Exercises the Node position-based I/O path via Deno's node:fs shim.
  const fs = await import("node:fs");
  const ouch = await init();
  ouch.clear();

  const payload = bytes("node backend roundtrip");
  const tmp = await Deno.makeTempFile();
  try {
    await Deno.writeFile(tmp, payload);
    const src = fromFileSync(tmp, fs);
    try {
      assertEquals(src.size, payload.length);
      assertEquals(text(src.readAt(5, 7)), "backend");
    } finally {
      src.close();
    }

    // fileSinkSync via node:fs: zip streams through the sink.
    const sinkPath = `${tmp}.zip`;
    try {
      const sink = fileSinkSync(sinkPath, fs);
      try {
        const chunks: Uint8Array[] = [];
        await ouch.compressTo(
          [{ path: "n.txt", source: fromBytes(payload) }],
          collectWritable(chunks),
          { output: "out.zip", sink },
        );
        ouch.writeFile("out.zip", joinChunks(chunks));
        const unpacked = ouch.decompress({
          files: ["out.zip"],
          outputDir: "x",
        });
        assertEquals(unpacked.files_unpacked, 1);
        assertEquals(ouch.readFile("x/n.txt"), payload);
      } finally {
        sink.close();
      }
    } finally {
      await Deno.remove(sinkPath);
    }
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("compressTo rejects formats that need a buffered encoder", async () => {
  const ouch = await init();
  ouch.clear();

  const src = fromBytes(bytes("x"));
  for (const output of ["out.zip", "out.7z", "out.bz2"]) {
    await assertRejects(
      () =>
        ouch.compressTo([{ path: "f.bin", source: src }], collectWritable([]), {
          output,
        }),
      Error,
    );
  }
});

Deno.test("compressTo writes zip through a file sink", async () => {
  const ouch = await init();
  ouch.clear();

  const a = bytes("zip via file sink");
  const b = noise(256 * 1024);
  const tmp = await Deno.makeTempFile({ suffix: ".zip" });
  try {
    const sink = fileSinkSync(tmp);
    try {
      const chunks: Uint8Array[] = [];
      const result = await ouch.compressTo(
        [
          { path: "a.txt", source: fromBytes(a) },
          { path: "b.bin", source: fromBytes(b) },
        ],
        collectWritable(chunks),
        { output: "out.zip", sink },
      );
      assertEquals(result.entries, 2);
      assertEquals(
        result.output_size,
        chunks.reduce((n, c) => n + c.length, 0),
      );

      ouch.writeFile("out.zip", joinChunks(chunks));
      const unpacked = ouch.decompress({ files: ["out.zip"], outputDir: "x" });
      assertEquals(unpacked.files_unpacked, 2);
      assertEquals(ouch.readFile("x/a.txt"), a);
      assertEquals(ouch.readFile("x/b.bin"), b);
    } finally {
      sink.close();
    }
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("compressTo writes 7z through a file sink", async () => {
  const ouch = await init();
  ouch.clear();

  const payload = bytes("seven via file sink");
  const tmp = await Deno.makeTempFile({ suffix: ".7z" });
  try {
    const sink = fileSinkSync(tmp);
    try {
      const chunks: Uint8Array[] = [];
      const result = await ouch.compressTo(
        [{ path: "doc.txt", source: fromBytes(payload) }],
        collectWritable(chunks),
        { output: "out.7z", sink },
      );
      assertEquals(result.entries, 1);

      ouch.writeFile("out.7z", joinChunks(chunks));
      const unpacked = ouch.decompress({ files: ["out.7z"], outputDir: "x" });
      assertEquals(unpacked.files_unpacked, 1);
      assertEquals(ouch.readFile("x/doc.txt"), payload);
    } finally {
      sink.close();
    }
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("compressTo zip via file sink with encryption", async () => {
  const ouch = await init();
  ouch.clear();

  const payload = bytes("secret zip via sink");
  const tmp = await Deno.makeTempFile({ suffix: ".zip" });
  try {
    const sink = fileSinkSync(tmp);
    try {
      const chunks: Uint8Array[] = [];
      await ouch.compressTo(
        [{ path: "s.txt", source: fromBytes(payload) }],
        collectWritable(chunks),
        { output: "out.zip", password: "pw", sink },
      );
      ouch.writeFile("out.zip", joinChunks(chunks));
      assertThrows(() =>
        ouch.decompress({ files: ["out.zip"], outputDir: "x" })
      );
      const unpacked = ouch.decompress({
        files: ["out.zip"],
        password: "pw",
        outputDir: "x",
      });
      assertEquals(unpacked.files_unpacked, 1);
      assertEquals(ouch.readFile("x/s.txt"), payload);
    } finally {
      sink.close();
    }
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("readFile / writeFile / loadFile roundtrip", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("a.txt", bytes("async file io"));
  ouch.compress({ files: ["a.txt"], output: "a.zip" });
  const archive = ouch.readFile("a.zip");

  const tmp = await Deno.makeTempFile({ suffix: ".zip" });
  try {
    await writeFile(tmp, archive);
    assertEquals(await readFile(tmp), archive);

    // loadFile buffers the whole file (explicitly named as such).
    const src = await loadFile(tmp);
    const entries = await ouch.listFrom(src, { name: "a.zip" });
    assertEquals(entries.map((e) => e.path), ["a.txt"]);
    assertEquals(text(entries[0].bytes), "async file io");
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("fromFile opens a disk handle: random access, no whole-file load", async () => {
  const ouch = await init();
  ouch.clear();

  // 4 MiB of incompressible payload: the zip central directory is at the end,
  // so a random-access source only touches metadata during listFrom.
  const payload = noise(4 * 1024 * 1024);
  ouch.writeFile("big.bin", payload);
  ouch.compress({ files: ["big.bin"], output: "big.zip" });
  const archive = ouch.readFile("big.zip");
  assert(archive.length > payload.length);

  const tmp = await Deno.makeTempFile({ suffix: ".zip" });
  try {
    await Deno.writeFile(tmp, archive);

    const src = await fromFile(tmp);
    try {
      assertEquals(await src.size(), archive.length);
      // Live handle: seeking to an arbitrary offset returns those exact bytes.
      const mid = Math.floor(archive.length / 2);
      assertEquals([...await src.readAt(mid, 8)], [...archive.slice(mid, mid + 8)]);
      assertEquals((await src.readAt(archive.length + 10, 16)).length, 0);

      const entries = await ouch.listFrom(src, { name: "big.zip" });
      assertEquals(entries.map((e) => e.path), ["big.bin"]);
    } finally {
      await src.close();
    }
    // A buffered source would keep working after close; a handle must not.
    await assertRejects(() => src.readAt(0, 4));
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("fromFile works through a node:fs/promises backend", async () => {
  const promises = await import("node:fs/promises");
  const tmp = await Deno.makeTempFile();
  try {
    await Deno.writeFile(tmp, bytes("node promises"));
    // Deno's node-compat types omit FileHandle's sync methods (the runtime
    // adapts via `fd` + `node:fs` instead), so cast away the type gap.
    const src = await fromFile(tmp, promises as unknown as AsyncFs);
    try {
      assertEquals(text(await src.readAt(0, 13)), "node promises");
    } finally {
      await src.close();
    }
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("fileSink is an async seekable sink and streams zip compression", async () => {
  const ouch = await init();
  ouch.clear();

  const tmp = await Deno.makeTempFile({ suffix: ".zip" });
  try {
    const sink = await fileSink(tmp);
    try {
      // Async I/O contract: every op returns a Promise and never blocks.
      await sink.writeAt(0, bytes("async"));
      await sink.writeAt(5, bytes(" sink"));
      assertEquals(await sink.size(), 10);
      assertEquals(text(await sink.readAt(0, 10)), "async sink");
      // Position-based writes: overwrite in the middle.
      await sink.writeAt(6, bytes("x"));
      assertEquals(text(await sink.readAt(0, 10)), "async xink");

      // Streaming zip compression through the async sink.
      const a = bytes("async sink zip");
      const b = noise(256 * 1024);
      const chunks: Uint8Array[] = [];
      const result = await ouch.compressTo(
        [
          { path: "a.txt", source: fromBytes(a) },
          { path: "b.bin", source: fromBytes(b) },
        ],
        collectWritable(chunks),
        { output: "out.zip", sink },
      );
      assertEquals(result.entries, 2);
      assertEquals(
        result.output_size,
        chunks.reduce((n, c) => n + c.length, 0),
      );

      ouch.writeFile("out.zip", joinChunks(chunks));
      const unpacked = ouch.decompress({ files: ["out.zip"], outputDir: "x" });
      assertEquals(unpacked.files_unpacked, 2);
      assertEquals(ouch.readFile("x/a.txt"), a);
      assertEquals(ouch.readFile("x/b.bin"), b);
    } finally {
      await sink.close();
    }
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("fileSink works through a node:fs/promises backend", async () => {
  const promises = await import("node:fs/promises");
  const tmp = await Deno.makeTempFile();
  try {
    const sink = await fileSink(tmp, promises as unknown as AsyncFs);
    try {
      await sink.writeAt(0, bytes("node async"));
      assertEquals(await sink.size(), 10);
      assertEquals(text(await sink.readAt(0, 10)), "node async");
    } finally {
      await sink.close();
    }
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("fromBlob loads a Blob into a seekable source", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("doc.txt", bytes("blob source"));
  ouch.compress({ files: ["doc.txt"], output: "b.zip" });
  const blob = new Blob([ouch.readFile("b.zip").buffer as ArrayBuffer]);

  const src = await fromBlob(blob);
  const entries = await ouch.listFrom(src, { name: "b.zip" });
  assertEquals(entries.map((e) => e.path), ["doc.txt"]);
  assertEquals(text(entries[0].bytes), "blob source");
});

Deno.test("async source drives listFrom / readEntryFrom / streamEntryFrom", async () => {
  const ouch = await init();
  ouch.clear();

  ouch.writeFile("a.txt", bytes("async source content"));
  ouch.compress({ files: ["a.txt"], output: "as.zip" });

  const tmp = await Deno.makeTempFile({ suffix: ".zip" });
  try {
    await Deno.writeFile(tmp, ouch.readFile("as.zip"));
    const src = await fromFile(tmp);
    try {
      assertEquals((await src.size()) > 0, true);
      const entries = await ouch.listFrom(src, { name: "as.zip" });
      assertEquals(entries.map((e) => e.path), ["a.txt"]);
      // listFrom buffered the async source, so lazy `bytes` still works.
      assertEquals(text(entries[0].bytes), "async source content");

      assertEquals(
        text(await ouch.readEntryFrom(src, "a.txt", { name: "as.zip" })),
        "async source content",
      );
      assertEquals(
        text(joinChunks(await collectStream(
          ouch.streamEntryFrom(src, "a.txt", { name: "as.zip" }),
        ))),
        "async source content",
      );
    } finally {
      await src.close();
    }
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("compressTo reads async input sources", async () => {
  const ouch = await init();
  ouch.clear();

  const tmp = await Deno.makeTempFile();
  try {
    await Deno.writeFile(tmp, bytes("async compress input"));
    const src = await fromFile(tmp);
    try {
      const chunks: Uint8Array[] = [];
      await ouch.compressTo(
        [{ path: "in.txt", source: src }],
        collectWritable(chunks),
        { output: "in.tar.gz" },
      );
      ouch.writeFile("in.tar.gz", joinChunks(chunks));
      const unpacked = ouch.decompress({
        files: ["in.tar.gz"],
        outputDir: "x",
      });
      assertEquals(unpacked.files_unpacked, 1);
      assertEquals(text(ouch.readFile("x/in.txt")), "async compress input");
    } finally {
      await src.close();
    }
  } finally {
    await Deno.remove(tmp);
  }
});

function assertThrows(fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, "expected the call to throw");
}
