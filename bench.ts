// Performance comparison: the ouch WASM library vs the native ouch CLI vs
// external command-line tools (zip, tar, gzip, 7z). Run with `deno task bench`.
//
// Every scenario compresses the same on-disk test data set (compressible text
// + incompressible binary) and extracts it back, measuring wall-clock time.
// The library uses its random-access file sources/sinks (`fromFileSync`,
// `fileSinkSync`), so disk I/O is included for every tool. Tools that are not
// installed (or the native CLI, if not built) are skipped automatically.

import { fileSinkSync, fromFileSync, init } from "./deno.ts";
import type { Ouch } from "./mod.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Best-of-N per operation. Override with BENCH_RUNS; large data sets default
// to a single run so the benchmark stays practical.
let RUNS = 3;

// ---------------------------------------------------------------------------
// External tool detection
// ---------------------------------------------------------------------------

function available(cmd: string, args: string[]): boolean {
  try {
    new Deno.Command(cmd, { args, stdout: "null", stderr: "null" })
      .outputSync();
    return true;
  } catch {
    return false;
  }
}

const TOOLS = {
  zip: available("zip", ["-v"]),
  unzip: available("unzip", ["-v"]),
  tar: available("tar", ["--version"]),
  gzip: available("gzip", ["--version"]),
  "7z": available("7z", ["i"]),
};

/** The native ouch CLI: the local release build if present, else PATH. */
async function findNativeOuch(): Promise<string | null> {
  for (const p of ["ouch/target/release/ouch.exe", "ouch/target/release/ouch"]) {
    try {
      return await Deno.realPath(p);
    } catch {
      // not built here — try the next candidate
    }
  }
  return available("ouch", []) ? "ouch" : null;
}

// -- msys bash wrapper ------------------------------------------------------
//
// On Windows, the external tools (tar/zip/unzip/gzip) are msys programs whose
// path handling disagrees with the Windows paths Deno produces (e.g. GNU tar
// treats `G:\...` as a remote host, and `-C` rejects backslash paths). We run
// them inside the msys bash with paths converted through `cygpath`, so every
// tool sees consistent POSIX-style paths. Non-Windows hosts run tools directly.

interface Shell {
  bash: string | null;
  cygpath: string | null;
}

async function detectShell(): Promise<Shell> {
  for (const p of [
    "G:/dev/msys64/usr/bin/bash.exe",
    "C:/msys64/usr/bin/bash.exe",
    "C:/Program Files/Git/bin/bash.exe",
  ]) {
    try {
      await Deno.stat(p);
      return { bash: p, cygpath: p.replace(/bash\.exe$/i, "cygpath.exe") };
    } catch {
      // try the next candidate
    }
  }
  if (available("bash", ["--version"])) return { bash: "bash", cygpath: "cygpath" };
  return { bash: null, cygpath: null };
}

const SHELL: Shell = await detectShell();
/** Wrap msys tools in bash on Windows; run directly elsewhere. */
const USE_BASH = Deno.build.os === "windows" && SHELL.bash !== null;

/** Convert a Windows path to POSIX (`/g/dev/...`) via cygpath. */
function toPosix(p: string): string {
  if (!USE_BASH || !SHELL.cygpath || !(/^[A-Za-z]:/.test(p) || p.includes("\\"))) {
    return p;
  }
  const res = new Deno.Command(SHELL.cygpath, {
    args: ["-u", p],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (res.code === 0) return decoder.decode(res.stdout).trim();
  return p;
}

/** Shell-quote a single argument for `bash -c`. */
function shq(s: string): string {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

/** Build the `bash -c` script for a tool invocation (paths converted). */
function bashScript(cmd: string, args: string[], cwd: string): string {
  const parts = args.map((a) => shq(toPosix(a)));
  return `cd ${shq(toPosix(cwd))} && ${cmd} ${parts.join(" ")}`;
}

function runTool(
  cmd: string,
  args: string[],
  cwd: string,
  convert = true,
): void {
  // Only msys tools need the bash wrapper (for cygpath path translation);
  // native Windows programs (7z, the ouch CLI) are spawned directly so their
  // timings don't include bash startup.
  const useBash = USE_BASH && convert;
  const res = useBash
    ? new Deno.Command(SHELL.bash!, {
      args: ["-c", bashScript(cmd, args, cwd)],
      stdout: "null",
      stderr: "piped",
    }).outputSync()
    : new Deno.Command(cmd, {
      args,
      cwd,
      stdout: "null",
      stderr: "piped",
    }).outputSync();
  if (res.code !== 0) {
    throw new Error(`${cmd} exited ${res.code}: ${decoder.decode(res.stderr)}`);
  }
}

/** Run a tool and return its stdout (e.g. `gzip -c`). */
function runToolCapture(
  cmd: string,
  args: string[],
  cwd: string,
  convert = true,
): Uint8Array {
  const useBash = USE_BASH && convert;
  const res = useBash
    ? new Deno.Command(SHELL.bash!, {
      args: ["-c", bashScript(cmd, args, cwd)],
      stdout: "piped",
      stderr: "piped",
    }).outputSync()
    : new Deno.Command(cmd, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
  if (res.code !== 0) {
    throw new Error(`${cmd} exited ${res.code}: ${decoder.decode(res.stderr)}`);
  }
  return res.stdout;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEXT_BLOCK = encoder.encode(
  "the quick brown fox jumps over the lazy dog. ".repeat(64), // 4 KiB
);

/** Deterministic incompressible bytes. */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = 0x12345678;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state >> 24) & 0xff;
  }
  return out;
}

interface BenchData {
  /** Absolute root: CLI tools use it as their cwd (the library reads `files`). */
  dir: string;
  /** Every file under the root (absolute path + archive-relative path). */
  files: { abs: string; rel: string }[];
  /** Top-level entries (relative to `dir`) passed to the CLI tools. */
  topLevel: string[];
  /** The file used by the single-file (gz) scenario. */
  singleAbs: string;
  singleRel: string;
  singleName: string;
  singleSize: number;
  totalBytes: number;
  /** Human-readable description of the data source for the header. */
  sourceLabel: string;
}

/** Recursively collect every file under `root`. */
async function collectFiles(
  root: string,
): Promise<{ abs: string; rel: string; size: number }[]> {
  const out: { abs: string; rel: string; size: number }[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const abs = `${dir}/${entry.name}`;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await walk(abs, rel);
      } else if (entry.isFile) {
        out.push({ abs, rel, size: (await Deno.stat(abs)).size });
      }
    }
  }
  await walk(root, "");
  return out;
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MiB`;
}

/** Use `BENCH_DATA` (or a path argument, or `./.test_data`) when it has files;
 * otherwise generate synthetic data. */
async function makeData(): Promise<BenchData> {
  const dataPath = Deno.args[0] ?? Deno.env.get("BENCH_DATA") ?? "./.test_data";
  try {
    const stat = await Deno.stat(dataPath);
    if (stat.isDirectory) {
      const root = await Deno.realPath(dataPath);
      const collected = await collectFiles(root);
      if (collected.length > 0) {
        const topLevel: string[] = [];
        for await (const entry of Deno.readDir(root)) topLevel.push(entry.name);
        const largest = collected.reduce((a, b) => (b.size > a.size ? b : a));
        return {
          dir: root,
          files: collected.map(({ abs, rel }) => ({ abs, rel })),
          topLevel,
          singleAbs: largest.abs,
          singleRel: largest.rel,
          singleName: largest.rel.split("/").pop()!,
          singleSize: largest.size,
          totalBytes: collected.reduce((n, f) => n + f.size, 0),
          sourceLabel:
            `${dataPath} (${collected.length} files, ` +
            `${mb(collected.reduce((n, f) => n + f.size, 0))})`,
        };
      }
    }
  } catch {
    // data path missing or unreadable — fall through to synthetic data
  }

  const dir = await Deno.makeTempDir({ prefix: "ouch-bench-" });
  const files: { abs: string; rel: string }[] = [];
  let totalBytes = 0;
  let textBytes = 0;

  await Deno.mkdir(`${dir}/text`, { recursive: true });
  for (let i = 0; i < 8; i++) {
    const rel = `text/doc${i}.txt`;
    const data = new Uint8Array(TEXT_BLOCK.length * 64); // 256 KiB each
    for (let j = 0; j < 64; j++) data.set(TEXT_BLOCK, j * TEXT_BLOCK.length);
    await Deno.writeFile(`${dir}/${rel}`, data);
    files.push({ abs: `${dir}/${rel}`, rel });
    totalBytes += data.length;
    textBytes += data.length;
  }

  await Deno.mkdir(`${dir}/bin`, { recursive: true });
  const bin = noise(1024 * 1024);
  await Deno.writeFile(`${dir}/bin/data.bin`, bin);
  files.push({ abs: `${dir}/bin/data.bin`, rel: "bin/data.bin" });
  totalBytes += bin.length;

  const single = new Uint8Array(TEXT_BLOCK.length * 512); // 2 MiB text
  for (let j = 0; j < 512; j++) single.set(TEXT_BLOCK, j * TEXT_BLOCK.length);
  await Deno.writeFile(`${dir}/single.txt`, single);
  totalBytes += single.length;

  return {
    dir,
    files,
    topLevel: ["text", "bin"],
    singleAbs: `${dir}/single.txt`,
    singleRel: "single.txt",
    singleName: "single.txt",
    singleSize: single.length,
    totalBytes,
    sourceLabel:
      `synthetic (${mb(textBytes)} compressible text + ${mb(bin.length)} binary; ` +
      `put files in ./.test_data to benchmark real data)`,
  };
}

// ---------------------------------------------------------------------------
// Library (wasm) — random-access file sources/sinks, real disk I/O
// ---------------------------------------------------------------------------

async function libCompress(
  ouch: Ouch,
  data: BenchData,
  format: "zip" | "7z" | "tar.gz" | "gz",
  out: string,
): Promise<void> {
  // gz is a single-file format: compress only the single file. The archive
  // formats take the whole tree.
  const files = format === "gz"
    ? [{ path: data.singleName, source: fromFileSync(data.singleAbs) }]
    : data.files.map((f) => ({
      path: f.rel,
      source: fromFileSync(f.abs),
    }));
  const output = format === "tar.gz"
    ? "a.tar.gz"
    : format === "7z"
    ? "a.7z"
    : format === "gz"
    ? "a.gz"
    : "a.zip";

  if (format === "zip" || format === "7z") {
    // Encoders need a seekable output: write to a file sink, then stream the
    // file back (discarded here) — the archive lands on disk.
    const sink = fileSinkSync(out);
    try {
      await ouch.compressTo(
        files,
        new WritableStream<Uint8Array>({ write() {} }),
        { output, sink },
      );
    } finally {
      sink.close();
    }
    return;
  }

  const file = await Deno.open(out, { write: true, create: true, truncate: true });
  try {
    await ouch.compressTo(
      files,
      new WritableStream<Uint8Array>({
        write: async (c) => {
          await file.write(c);
        },
      }),
      { output },
    );
  } finally {
    file.close();
  }
}

async function libDecompress(
  ouch: Ouch,
  archive: string,
  outDir: string,
  name: string,
): Promise<void> {
  const src = fromFileSync(archive);
  try {
    const entries = await ouch.listFrom(src, { name });
    for (const entry of entries) {
      if (entry.isDir) continue;
      const target = `${outDir}/${entry.path}`;
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
      });
      const file = await Deno.open(target, {
        write: true,
        create: true,
        truncate: true,
      });
      try {
        const reader = ouch.streamEntryFrom(src, entry.path, { name })
          .getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await file.write(value);
        }
      } finally {
        file.close();
      }
    }
  } finally {
    src.close();
  }
}

/**
 * Single-file formats (gz) have no random-access reader: decode via the
 * virtual filesystem (the archive is loaded into wasm memory).
 */
async function libGzDecompress(
  ouch: Ouch,
  archive: string,
  outDir: string,
  singleName: string,
): Promise<void> {
  ouch.clear();
  ouch.writeFile("a.gz", await Deno.readFile(archive));
  const [entry] = ouch.listArchive({ archives: ["a.gz"] });
  await Deno.mkdir(outDir, { recursive: true });
  const file = await Deno.open(`${outDir}/${singleName}`, {
    write: true,
    create: true,
    truncate: true,
  });
  try {
    const reader = entry.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await file.write(value);
    }
  } finally {
    file.close();
  }
}

// ---------------------------------------------------------------------------
// Benchmark harness
// ---------------------------------------------------------------------------

interface Measured {
  compressMs: number;
  decompressMs: number;
}

async function bestOf(
  runs: number,
  fn: () => void | Promise<void>,
): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

type Scenario = "zip" | "7z" | "tar.gz" | "gz";

/** Measure a tool: compress `inputs` (relative to `data.dir`) into `work/a.*`,
 * then extract it into `work/out`. Returns ms or null when unavailable. */
async function measureLib(
  ouch: Ouch,
  data: BenchData,
  scenario: Scenario,
): Promise<Measured | null> {
  const work = await Deno.makeTempDir({ prefix: "ouch-bench-" });
  try {
    const ext = scenario === "tar.gz" ? "tar.gz" : scenario;
    const archive = `${work}/a.${ext}`;
    const name = `a.${ext}`;
    const compressMs = await bestOf(RUNS, () =>
      libCompress(ouch, data, scenario, archive)
    );
    const decompressMs = scenario === "gz"
      ? await bestOf(RUNS, () =>
        libGzDecompress(ouch, archive, `${work}/out`, data.singleName)
      )
      : await bestOf(RUNS, () => libDecompress(ouch, archive, `${work}/out`, name));
    return { compressMs, decompressMs };
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

async function measureNative(
  native: string,
  data: BenchData,
  scenario: Scenario,
): Promise<Measured | null> {
  const work = await Deno.makeTempDir({ prefix: "ouch-bench-" });
  try {
    const ext = scenario === "tar.gz" ? "tar.gz" : scenario;
    const archive = `${work}/a.${ext}`;
    const inputs = scenario === "gz" ? [data.singleRel] : data.topLevel;
    const compressMs = await bestOf(RUNS, () =>
      runTool(
        native,
        ["-q", "-y", "compress", ...inputs, archive],
        data.dir,
        false, // the native CLI is a Windows program: keep Windows paths
      )
    );
    await Deno.mkdir(`${work}/out`, { recursive: true });
    const decompressMs = await bestOf(RUNS, () =>
      runTool(
        native,
        ["-q", "-y", "decompress", archive, "-d", `${work}/out`],
        data.dir,
        false,
      )
    );
    return { compressMs, decompressMs };
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

async function measureExternal(
  data: BenchData,
  scenario: Scenario,
): Promise<Measured | null> {
  const work = await Deno.makeTempDir({ prefix: "ouch-bench-" });
  try {
    switch (scenario) {
      case "zip": {
        if (!TOOLS.zip || !TOOLS.unzip) return null;
        const archive = `${work}/a.zip`;
        const compressMs = await bestOf(RUNS, () =>
          runTool("zip", ["-r", "-q", archive, ...data.topLevel], data.dir)
        );
        await Deno.mkdir(`${work}/out`, { recursive: true });
        const decompressMs = await bestOf(RUNS, () =>
          runTool("unzip", ["-q", "-o", archive, "-d", `${work}/out`], data.dir)
        );
        return { compressMs, decompressMs };
      }
      case "7z": {
        if (!TOOLS["7z"]) return null;
        const archive = `${work}/a.7z`;
        const compressMs = await bestOf(RUNS, () =>
          runTool("7z", ["a", "-bd", archive, ...data.topLevel], data.dir, false)
        );
        await Deno.mkdir(`${work}/out`, { recursive: true });
        const decompressMs = await bestOf(RUNS, () =>
          runTool("7z", ["x", "-y", `-o${work}/out`, archive], data.dir, false)
        );
        return { compressMs, decompressMs };
      }
      case "tar.gz": {
        if (!TOOLS.tar || !TOOLS.gzip) return null;
        const archive = `${work}/a.tar.gz`;
        const compressMs = await bestOf(RUNS, () =>
          runTool(
            "tar",
            ["-czf", archive, ...data.topLevel],
            data.dir,
          )
        );
        await Deno.mkdir(`${work}/out`, { recursive: true });
        const decompressMs = await bestOf(RUNS, () =>
          runTool(
            "tar",
            ["-xzf", archive, "-C", `${work}/out`],
            data.dir,
          )
        );
        return { compressMs, decompressMs };
      }
      case "gz": {
        if (!TOOLS.gzip) return null;
        const archive = `${work}/a.gz`;
        const compressMs = await bestOf(RUNS, async () => {
          const gz = runToolCapture("gzip", ["-c", data.singleRel], data.dir);
          await Deno.writeFile(archive, gz);
        });
        await Deno.mkdir(`${work}/out`, { recursive: true });
        const decompressMs = await bestOf(RUNS, async () => {
          const raw = runToolCapture("gzip", ["-dc", archive], work);
          await Deno.writeFile(`${work}/out/${data.singleName}`, raw);
        });
        return { compressMs, decompressMs };
      }
    }
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function mbPerSec(bytes: number, ms: number): string {
  return `${(bytes / (ms / 1000) / 1e6).toFixed(1)} MB/s`;
}

function fmtMs(ms: number, bytes: number): string {
  return `${ms.toFixed(0).padStart(7)} ms (${mbPerSec(bytes, ms).padStart(9)})`;
}

function fmtRow(
  bytes: number,
  measured: Measured | null,
): { compress: string; decompress: string } {
  if (!measured) return { compress: "n/a", decompress: "n/a" };
  return {
    compress: fmtMs(measured.compressMs, bytes),
    decompress: fmtMs(measured.decompressMs, bytes),
  };
}

async function run() {
  const ouch = await init();
  const native = await findNativeOuch();
  const data = await makeData();

  const inputBytes = data.totalBytes;
  RUNS = Number(Deno.env.get("BENCH_RUNS") ?? "0") ||
    (inputBytes > 512e6 ? 1 : 3);

  console.log("=== ouch performance benchmark ===");
  console.log(
    `test data: ${data.sourceLabel}, ${RUNS} runs, best-of` +
      (Deno.env.get("BENCH_RUNS") ? ` (BENCH_RUNS=${Deno.env.get("BENCH_RUNS")})` : ""),
  );
  if (native) {
    console.log(`native ouch cli: ${native}`);
  } else {
    console.log("native ouch cli: not found (build with `cargo build --release` in ./ouch)");
  }
  console.log(
    `external tools: ${["zip", "unzip", "tar", "gzip", "7z"]
      .filter((t) => TOOLS[t as keyof typeof TOOLS])
      .join(", ") || "none"}`,
  );
  if (USE_BASH) {
    console.log(`msys tools run via ${SHELL.bash} (bash startup included)`);
  }
  console.log();

  for (const scenario of ["zip", "7z", "tar.gz", "gz"] as Scenario[]) {
    const bytes = scenario === "gz" ? data.singleSize : inputBytes;
    console.log(`--- ${scenario} ---`);
    console.log(
      `${"tool".padEnd(12)} ${"compress".padEnd(28)} ${"decompress".padEnd(28)}`,
    );

    const lib = await measureLib(ouch, data, scenario);
    const row = fmtRow(bytes, lib);
    console.log(
      `${"lib (wasm)".padEnd(12)} ${row.compress.padEnd(28)} ${row.decompress.padEnd(28)}`,
    );

    if (native) {
      const nativeRow = fmtRow(bytes, await measureNative(native, data, scenario));
      console.log(
        `${"ouch cli".padEnd(12)} ${nativeRow.compress.padEnd(28)} ${nativeRow.decompress.padEnd(28)}`,
      );
    }

    const external = fmtRow(bytes, await measureExternal(data, scenario));
    const toolName = scenario === "zip" ? "zip/unzip" : scenario === "gz" ? "gzip" : scenario;
    console.log(
      `${toolName.padEnd(12)} ${external.compress.padEnd(28)} ${external.decompress.padEnd(28)}`,
    );
    console.log();
  }

  await Deno.remove(data.dir, { recursive: true });
  console.log("done.");
}

if (import.meta.main) {
  await run();
}
