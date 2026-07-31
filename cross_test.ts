// Cross-interop tests: every archive the ouch wasm backend produces must be
// readable by standard command-line tools (tar, gzip, xz, unzip, zip, 7z,
// brotli, lz4), and ouch must be able to read archives those tools produce.
//
// A test skips automatically when its tool is not installed, so the suite
// runs anywhere (local dev box, CI) with whatever tools are present.

import { assertEquals } from "@std/assert";
import { fileSinkSync, fromBytes, init, type Ouch } from "./mod.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (s: string): Uint8Array => encoder.encode(s);
const text = (d: Uint8Array): string => decoder.decode(d);

/** Repeatable payload that compresses well but is not trivially empty. */
const PAYLOAD = "the quick brown fox jumps over the lazy dog\n".repeat(32);

// ---------------------------------------------------------------------------
// External tool helpers
// ---------------------------------------------------------------------------

/** Detect which external tools are available on this machine. */
const TOOL = {
  tar: available("tar", ["--version"]),
  gzip: available("gzip", ["--version"]),
  xz: available("xz", ["--version"]),
  unzip: available("unzip", ["-v"]),
  zip: available("zip", ["-v"]),
  "7z": available("7z", ["i"]),
  brotli: available("brotli", ["--version"]),
  lz4: available("lz4", ["--version"]),
  bzip2: available("bzip2", ["--version"]),
  zstd: available("zstd", ["--version"]),
  // `rar` prints its usage banner and exits non-zero with no arguments.
  rar: available("rar", []),
};

function available(cmd: string, args: string[]): boolean {
  try {
    new Deno.Command(cmd, { args, stdout: "null", stderr: "null" })
      .outputSync();
    return true;
  } catch {
    return false;
  }
}

interface RunResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

/** Run an external tool without a shell; `cwd` (optional) is the work dir. */
function run(cmd: string, args: string[], cwd?: string): RunResult {
  const res = new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  return {
    code: res.code,
    stdout: res.stdout,
    stderr: decoder.decode(res.stderr),
  };
}

/** Relative path -> text content of every file under `root` in the VFS. */
function vfsFiles(ouch: Ouch, root: string): Map<string, string> {
  const prefix = root.replace(/\/+$/, "") + "/";
  const out = new Map<string, string>();
  for (const path of ouch.listFiles()) {
    if (!path.startsWith(prefix)) continue;
    if (ouch.isDir(path)) continue;
    out.set(path.slice(prefix.length), text(ouch.readFile(path)));
  }
  return out;
}

/** Relative path -> text content of every file under `dir` on the real disk. */
function diskFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of Deno.readDirSync(dir)) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      for (const [rel, content] of diskFiles(full)) {
        out.set(`${entry.name}/${rel}`, content);
      }
    } else if (entry.isFile) {
      out.set(entry.name, text(Deno.readFileSync(full)));
    }
  }
  return out;
}

/** `tar -t` output as sorted entry names (dirs keep their trailing `/` stripped). */
function tarNames(stdout: Uint8Array): string[] {
  return text(stdout)
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/\/+$/, ""))
    .sort();
}

/** Run `fn` with a fresh temp dir, removing it afterwards. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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

// ---------------------------------------------------------------------------
// streaming compression (compressTo) vs external tools
// ---------------------------------------------------------------------------

Deno.test({
  name: "cross: compressTo gz -> gzip -dc",
  ignore: !TOOL.gzip,
  async fn() {
    const ouch = await init();
    ouch.clear();
    const chunks: Uint8Array[] = [];
    await ouch.compressTo(
      [{ path: "a.txt", source: fromBytes(bytes(PAYLOAD)) }],
      new WritableStream<Uint8Array>({
        write: (c: Uint8Array) => {
          chunks.push(c);
        },
      }),
      { output: "a.gz" },
    );
    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.gz`, joinChunks(chunks));
      const res = run("gzip", ["-dc", "a.gz"], tmp);
      assertEquals(res.code, 0, res.stderr);
      assertEquals(text(res.stdout), PAYLOAD);
    });
  },
});

Deno.test({
  name: "cross: compressTo tar.gz -> tar -tzf / -xzf",
  ignore: !TOOL.tar,
  async fn() {
    const ouch = await init();
    ouch.clear();
    const chunks: Uint8Array[] = [];
    await ouch.compressTo(
      [
        {
          path: "in/hello.txt",
          source: fromBytes(bytes("hello from streaming")),
        },
        { path: "in/sub/nested.txt", source: fromBytes(bytes("nested!")) },
      ],
      new WritableStream<Uint8Array>({
        write: (c: Uint8Array) => {
          chunks.push(c);
        },
      }),
      { output: "out.tar.gz" },
    );
    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/out.tar.gz`, joinChunks(chunks));
      const listing = run("tar", ["-tzf", "out.tar.gz"], tmp);
      assertEquals(listing.code, 0, listing.stderr);
      assertEquals(tarNames(listing.stdout), [
        "in/hello.txt",
        "in/sub/nested.txt",
      ]);
      const extract = run("tar", ["-xzf", "out.tar.gz"], tmp);
      assertEquals(extract.code, 0, extract.stderr);
      assertEquals(
        text(await Deno.readFile(`${tmp}/in/hello.txt`)),
        "hello from streaming",
      );
      assertEquals(
        text(await Deno.readFile(`${tmp}/in/sub/nested.txt`)),
        "nested!",
      );
    });
  },
});

// ---------------------------------------------------------------------------
// ouch -> external tools: verify ouch output is standard-compliant
// ---------------------------------------------------------------------------

Deno.test({
  name: "cross: ouch tar -> tar -tf / -xf",
  ignore: !TOOL.tar,
  async fn() {
    const ouch = await init();
    ouch.clear();
    ouch.writeFile("in/hello.txt", bytes("hello from wasm"));
    ouch.writeFile("in/sub/nested.txt", bytes("nested!"));
    ouch.compress({ files: ["in"], output: "out.tar" });
    const archive = ouch.readFile("out.tar");

    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/out.tar`, archive);

      const listing = run("tar", ["-tf", "out.tar"], tmp);
      assertEquals(listing.code, 0, listing.stderr);
      assertEquals(tarNames(listing.stdout), [
        "in",
        "in/hello.txt",
        "in/sub",
        "in/sub/nested.txt",
      ]);

      const extract = run("tar", ["-xf", "out.tar"], tmp);
      assertEquals(extract.code, 0, extract.stderr);
      assertEquals(
        diskFiles(`${tmp}/in`),
        new Map([
          ["hello.txt", "hello from wasm"],
          ["sub/nested.txt", "nested!"],
        ]),
      );
    });
  },
});

Deno.test({
  name: "cross: ouch tar.gz -> tar -tzf / -xzf",
  ignore: !TOOL.tar,
  async fn() {
    const ouch = await init();
    ouch.clear();
    ouch.writeFile("in/hello.txt", bytes("hello from wasm"));
    ouch.writeFile("in/sub/nested.txt", bytes("nested!"));
    ouch.compress({ files: ["in"], output: "out.tar.gz" });

    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/out.tar.gz`, ouch.readFile("out.tar.gz"));

      const listing = run("tar", ["-tzf", "out.tar.gz"], tmp);
      assertEquals(listing.code, 0, listing.stderr);
      assertEquals(tarNames(listing.stdout), [
        "in",
        "in/hello.txt",
        "in/sub",
        "in/sub/nested.txt",
      ]);

      const extract = run("tar", ["-xzf", "out.tar.gz"], tmp);
      assertEquals(extract.code, 0, extract.stderr);
      assertEquals(
        diskFiles(`${tmp}/in`),
        new Map([
          ["hello.txt", "hello from wasm"],
          ["sub/nested.txt", "nested!"],
        ]),
      );
    });
  },
});

const OUCH_STREAM = [
  { name: "gz", ext: "gz", cmd: "gzip", tool: "gzip" },
  { name: "xz", ext: "xz", cmd: "xz", tool: "xz" },
  // `xz` also decodes the classic .lzma (lzma_alone) container.
  { name: "lzma", ext: "lzma", cmd: "xz", tool: "xz" },
  { name: "bz2", ext: "bz2", cmd: "bzip2", tool: "bzip2" },
] as const;

for (const { name, ext, cmd, tool } of OUCH_STREAM) {
  Deno.test({
    name: `cross: ouch ${name} -> ${cmd} -dc`,
    ignore: !TOOL[tool],
    async fn() {
      const ouch = await init();
      ouch.clear();
      ouch.writeFile("a.txt", bytes(PAYLOAD));
      ouch.compress({ files: ["a.txt"], output: `a.txt.${ext}` });

      await withTempDir(async (tmp) => {
        await Deno.writeFile(
          `${tmp}/a.txt.${ext}`,
          ouch.readFile(`a.txt.${ext}`),
        );
        const res = run(cmd, ["-dc", `a.txt.${ext}`], tmp);
        assertEquals(res.code, 0, res.stderr);
        assertEquals(text(res.stdout), PAYLOAD);
      });
    },
  });
}

Deno.test({
  name: "cross: ouch zip -> unzip -t / -p",
  ignore: !TOOL.unzip,
  async fn() {
    const ouch = await init();
    ouch.clear();
    ouch.writeFile("a.txt", bytes(PAYLOAD));
    ouch.compress({ files: ["a.txt"], output: "a.zip" });

    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.zip`, ouch.readFile("a.zip"));

      const integrity = run("unzip", ["-t", "a.zip"], tmp);
      assertEquals(integrity.code, 0, integrity.stderr);

      const res = run("unzip", ["-p", "a.zip", "a.txt"], tmp);
      assertEquals(res.code, 0, res.stderr);
      assertEquals(text(res.stdout), PAYLOAD);
    });
  },
});

Deno.test({
  name: "cross: ouch 7z -> 7z t / x",
  ignore: !TOOL["7z"],
  async fn() {
    const ouch = await init();
    ouch.clear();
    ouch.writeFile("a.txt", bytes(PAYLOAD));
    ouch.compress({ files: ["a.txt"], output: "a.7z" });

    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.7z`, ouch.readFile("a.7z"));

      const integrity = run("7z", ["t", "a.7z"], tmp);
      assertEquals(integrity.code, 0, integrity.stderr);

      const extract = run("7z", ["x", "-y", "-oout", "a.7z"], tmp);
      assertEquals(extract.code, 0, extract.stderr);
      assertEquals(diskFiles(`${tmp}/out`), new Map([["a.txt", PAYLOAD]]));
    });
  },
});

Deno.test({
  name: "cross: ouch AES-256 zip -> 7z",
  ignore: !TOOL["7z"],
  async fn() {
    const ouch = await init();
    ouch.clear();
    ouch.writeFile("doc.txt", bytes(PAYLOAD));
    ouch.compress({ files: ["doc.txt"], output: "doc.zip", password: "pw" });

    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/doc.zip`, ouch.readFile("doc.zip"));

      const integrity = run("7z", ["t", "-ppw", "doc.zip"], tmp);
      assertEquals(
        integrity.code,
        0,
        `7z rejected ouch AES zip: ${integrity.stderr}`,
      );

      const extract = run("7z", ["x", "-y", "-ppw", "-oout", "doc.zip"], tmp);
      assertEquals(extract.code, 0, extract.stderr);
      assertEquals(diskFiles(`${tmp}/out`), new Map([["doc.txt", PAYLOAD]]));
    });
  },
});

Deno.test({
  name: "cross: ouch encrypted 7z -> 7z",
  ignore: !TOOL["7z"],
  async fn() {
    const ouch = await init();
    ouch.clear();
    ouch.writeFile("doc.txt", bytes(PAYLOAD));
    ouch.compress({ files: ["doc.txt"], output: "doc.7z", password: "pw" });

    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/doc.7z`, ouch.readFile("doc.7z"));

      const integrity = run("7z", ["t", "-ppw", "doc.7z"], tmp);
      assertEquals(
        integrity.code,
        0,
        `7z rejected ouch encrypted 7z: ${integrity.stderr}`,
      );

      const extract = run("7z", ["x", "-y", "-ppw", "-oout", "doc.7z"], tmp);
      assertEquals(extract.code, 0, extract.stderr);
      assertEquals(diskFiles(`${tmp}/out`), new Map([["doc.txt", PAYLOAD]]));
    });
  },
});

Deno.test({
  name: "cross: ouch br -> brotli -dc",
  ignore: !TOOL.brotli,
  async fn() {
    const ouch = await init();
    ouch.clear();
    ouch.writeFile("a.txt", bytes(PAYLOAD));
    ouch.compress({ files: ["a.txt"], output: "a.txt.br" });

    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.txt.br`, ouch.readFile("a.txt.br"));
      const res = run("brotli", ["-dc", "a.txt.br"], tmp);
      assertEquals(res.code, 0, res.stderr);
      assertEquals(text(res.stdout), PAYLOAD);
    });
  },
});

Deno.test({
  name: "cross: ouch lz4 -> lz4 -dc",
  ignore: !TOOL.lz4,
  async fn() {
    const ouch = await init();
    ouch.clear();
    ouch.writeFile("a.txt", bytes(PAYLOAD));
    ouch.compress({ files: ["a.txt"], output: "a.txt.lz4" });

    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.txt.lz4`, ouch.readFile("a.txt.lz4"));
      const res = run("lz4", ["-dc", "a.txt.lz4"], tmp);
      assertEquals(res.code, 0, res.stderr);
      assertEquals(text(res.stdout), PAYLOAD);
    });
  },
});

// ---------------------------------------------------------------------------
// external tools -> ouch: verify ouch reads standard tool output
// ---------------------------------------------------------------------------

Deno.test({
  name: "cross: tar -> ouch",
  ignore: !TOOL.tar,
  async fn() {
    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.txt`, bytes(PAYLOAD));
      await Deno.mkdir(`${tmp}/sub`);
      await Deno.writeFile(`${tmp}/sub/b.txt`, bytes("nested from tar"));
      const made = run(
        "tar",
        ["-cf", "out.tar", "-C", tmp, "a.txt", "sub/b.txt"],
        tmp,
      );
      assertEquals(made.code, 0, made.stderr);

      const ouch = await init();
      ouch.clear();
      ouch.writeFile("out.tar", await Deno.readFile(`${tmp}/out.tar`));
      const result = ouch.decompress({ files: ["out.tar"], outputDir: "x" });
      assertEquals(result.files_unpacked, 2);
      assertEquals(
        vfsFiles(ouch, "x"),
        new Map([
          ["a.txt", PAYLOAD],
          ["sub/b.txt", "nested from tar"],
        ]),
      );
    });
  },
});

Deno.test({
  name: "cross: tar.gz -> ouch",
  ignore: !TOOL.tar,
  async fn() {
    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.txt`, bytes(PAYLOAD));
      await Deno.mkdir(`${tmp}/sub`);
      await Deno.writeFile(`${tmp}/sub/b.txt`, bytes("nested from tar"));
      const made = run(
        "tar",
        ["-czf", "out.tar.gz", "-C", tmp, "a.txt", "sub/b.txt"],
        tmp,
      );
      assertEquals(made.code, 0, made.stderr);

      const ouch = await init();
      ouch.clear();
      ouch.writeFile("out.tar.gz", await Deno.readFile(`${tmp}/out.tar.gz`));
      const result = ouch.decompress({ files: ["out.tar.gz"] });
      assertEquals(result.files_unpacked, 2);
      // No outputDir: ouch extracts into a wrapper dir named after the archive.
      assertEquals(
        vfsFiles(ouch, "out"),
        new Map([
          ["a.txt", PAYLOAD],
          ["sub/b.txt", "nested from tar"],
        ]),
      );
    });
  },
});

const EXTERNAL_STREAM = [
  { name: "gz", ext: "gz", cmd: "gzip", tool: "gzip", args: ["-c"] },
  { name: "xz", ext: "xz", cmd: "xz", tool: "xz", args: ["-c"] },
  // `xz --format=lzma` produces the classic .lzma (lzma_alone) container.
  {
    name: "lzma",
    ext: "lzma",
    cmd: "xz",
    tool: "xz",
    args: ["--format=lzma", "-c"],
  },
  { name: "bz2", ext: "bz2", cmd: "bzip2", tool: "bzip2", args: ["-c"] },
  // ouch cannot encode zstd, so this direction is decode-only.
  { name: "zst", ext: "zst", cmd: "zstd", tool: "zstd", args: ["-c"] },
] as const;

for (const { name, ext, cmd, tool, args } of EXTERNAL_STREAM) {
  Deno.test({
    name: `cross: ${cmd} ${name} -> ouch`,
    ignore: !TOOL[tool],
    async fn() {
      await withTempDir(async (tmp) => {
        await Deno.writeFile(`${tmp}/a.txt`, bytes(PAYLOAD));
        const made = run(cmd, [...args, "a.txt"], tmp);
        assertEquals(made.code, 0, made.stderr);

        const ouch = await init();
        ouch.clear();
        ouch.writeFile(`a.txt.${ext}`, made.stdout);
        const result = ouch.decompress({ files: [`a.txt.${ext}`] });
        assertEquals(result.files_unpacked, 1);
        assertEquals(text(ouch.readFile("a.txt")), PAYLOAD);
      });
    },
  });
}

Deno.test({
  name: "cross: zip -> ouch",
  ignore: !TOOL.zip,
  async fn() {
    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.txt`, bytes(PAYLOAD));
      const made = run("zip", ["-q", "out.zip", "a.txt"], tmp);
      assertEquals(made.code, 0, made.stderr);

      const ouch = await init();
      ouch.clear();
      ouch.writeFile("out.zip", await Deno.readFile(`${tmp}/out.zip`));
      const result = ouch.decompress({ files: ["out.zip"], outputDir: "x" });
      assertEquals(result.files_unpacked, 1);
      assertEquals(vfsFiles(ouch, "x"), new Map([["a.txt", PAYLOAD]]));
    });
  },
});

Deno.test({
  name: "cross: 7z -> ouch",
  ignore: !TOOL["7z"],
  async fn() {
    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.txt`, bytes(PAYLOAD));
      const made = run("7z", ["a", "-bso0", "-bsp0", "out.7z", "a.txt"], tmp);
      assertEquals(made.code, 0, made.stderr);

      const ouch = await init();
      ouch.clear();
      ouch.writeFile("out.7z", await Deno.readFile(`${tmp}/out.7z`));
      const result = ouch.decompress({ files: ["out.7z"], outputDir: "x" });
      assertEquals(result.files_unpacked, 1);
      assertEquals(vfsFiles(ouch, "x"), new Map([["a.txt", PAYLOAD]]));
    });
  },
});

Deno.test({
  name: "cross: 7z ZipCrypto zip -> ouch",
  ignore: !TOOL["7z"],
  async fn() {
    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.txt`, bytes(PAYLOAD));
      // 7z's default zip encryption is traditional ZipCrypto.
      const made = run(
        "7z",
        ["a", "-tzip", "-ppw", "out.zip", "a.txt"],
        tmp,
      );
      assertEquals(made.code, 0, made.stderr);

      const ouch = await init();
      ouch.clear();
      ouch.writeFile("out.zip", await Deno.readFile(`${tmp}/out.zip`));
      const result = ouch.decompress({
        files: ["out.zip"],
        password: "pw",
        outputDir: "x",
      });
      assertEquals(result.files_unpacked, 1);
      assertEquals(vfsFiles(ouch, "x"), new Map([["a.txt", PAYLOAD]]));
    });
  },
});

Deno.test({
  name: "cross: 7z AES-256 zip -> ouch",
  ignore: !TOOL["7z"],
  async fn() {
    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.txt`, bytes(PAYLOAD));
      const made = run(
        "7z",
        ["a", "-tzip", "-mem=AES256", "-ppw", "out.zip", "a.txt"],
        tmp,
      );
      assertEquals(made.code, 0, made.stderr);

      const ouch = await init();
      ouch.clear();
      ouch.writeFile("out.zip", await Deno.readFile(`${tmp}/out.zip`));
      const result = ouch.decompress({
        files: ["out.zip"],
        password: "pw",
        outputDir: "x",
      });
      assertEquals(result.files_unpacked, 1);
      assertEquals(vfsFiles(ouch, "x"), new Map([["a.txt", PAYLOAD]]));
    });
  },
});

Deno.test({
  name: "cross: 7z encrypted -> ouch",
  ignore: !TOOL["7z"],
  async fn() {
    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.txt`, bytes(PAYLOAD));
      const made = run("7z", ["a", "-ppw", "out.7z", "a.txt"], tmp);
      assertEquals(made.code, 0, made.stderr);

      const ouch = await init();
      ouch.clear();
      ouch.writeFile("out.7z", await Deno.readFile(`${tmp}/out.7z`));
      const result = ouch.decompress({
        files: ["out.7z"],
        password: "pw",
        outputDir: "x",
      });
      assertEquals(result.files_unpacked, 1);
      assertEquals(vfsFiles(ouch, "x"), new Map([["a.txt", PAYLOAD]]));
    });
  },
});

Deno.test({
  name: "cross: rar -> ouch",
  ignore: !TOOL.rar,
  async fn() {
    await withTempDir(async (tmp) => {
      await Deno.writeFile(`${tmp}/a.txt`, bytes(PAYLOAD));
      await Deno.mkdir(`${tmp}/sub`);
      await Deno.writeFile(`${tmp}/sub/b.txt`, bytes("nested from rar"));
      const made = run(
        "rar",
        ["a", "-y", "-idq", "out.rar", "a.txt", "sub/b.txt"],
        tmp,
      );
      assertEquals(made.code, 0, made.stderr);

      const ouch = await init();
      ouch.clear();
      ouch.writeFile("out.rar", await Deno.readFile(`${tmp}/out.rar`));
      const result = ouch.decompress({ files: ["out.rar"], outputDir: "x" });
      assertEquals(result.files_unpacked, 2);
      assertEquals(
        vfsFiles(ouch, "x"),
        new Map([
          ["a.txt", PAYLOAD],
          ["sub/b.txt", "nested from rar"],
        ]),
      );
    });
  },
});

Deno.test({
  name: "cross: compressTo zip via file sink -> unzip",
  ignore: !TOOL.unzip,
  async fn() {
    const ouch = await init();
    ouch.clear();
    const tmp = await Deno.makeTempFile({ suffix: ".zip" });
    try {
      const sink = fileSinkSync(tmp);
      try {
        const chunks: Uint8Array[] = [];
        await ouch.compressTo(
          [
            { path: "a.txt", source: fromBytes(bytes(PAYLOAD)) },
            { path: "sub/b.txt", source: fromBytes(bytes("nested from sink")) },
          ],
          new WritableStream<Uint8Array>({
            write: (c: Uint8Array) => {
              chunks.push(c);
            },
          }),
          { output: "out.zip", sink },
        );
        await withTempDir(async (dir) => {
          await Deno.writeFile(`${dir}/out.zip`, joinChunks(chunks));
          const integrity = run("unzip", ["-t", "out.zip"], dir);
          assertEquals(integrity.code, 0, integrity.stderr);
          const res = run("unzip", ["-p", "out.zip", "a.txt"], dir);
          assertEquals(res.code, 0, res.stderr);
          assertEquals(text(res.stdout), PAYLOAD);
        });
      } finally {
        sink.close();
      }
    } finally {
      await Deno.remove(tmp);
    }
  },
});
