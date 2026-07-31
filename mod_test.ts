import { assert, assertEquals } from "@std/assert";
import { init, walk } from "./mod.ts";

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

function assertThrows(fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, "expected the call to throw");
}
