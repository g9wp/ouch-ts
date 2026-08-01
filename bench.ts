// Performance comparison: the ouch WASM library vs the native ouch CLI vs
// external command-line tools (zip, tar, gzip, 7z). Run with `deno task bench`.
//
// When `./.test_data` (or the path argument / BENCH_DATA) contains archive
// files (.zip/.7z/.tar.gz/.tar/.gz), each archive is benchmarked individually:
//   - decompress: every tool extracts the archive,
//   - compress:    every tool re-compresses the archive's extracted contents.
// The library uses its random-access file sources/sinks (`fromFileSync`,
// `fileSinkSync`), so disk I/O is included for every tool. Without archives
// the benchmark falls back to compressing the whole directory (zip / 7z /
// tar.gz / gz scenarios) with synthetic data if the directory is empty.

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
// Formats and test data
// ---------------------------------------------------------------------------

type Format = "zip" | "7z" | "tar.gz" | "tar" | "gz";

const FORMAT_EXT: [Format, RegExp][] = [
  ["tar.gz", /\.tar\.gz$/i],
  ["tar", /\.tar$/i],
  ["zip", /\.zip$/i],
  ["7z", /\.7z$/i],
  ["gz", /\.gz$/i],
];

function formatOf(name: string): Format | null {
  for (const [fmt, re] of FORMAT_EXT) {
    if (re.test(name)) return fmt;
  }
  return null;
}

function extOf(format: Format): string {
  switch (format) {
    case "zip":
      return "zip";
    case "7z":
      return "7z";
    case "tar.gz":
      return "tar.gz";
    case "tar":
      return "tar";
    case "gz":
      return "gz";
  }
}

interface Archive {
  abs: string;
  rel: string;
  name: string;
  format: Format;
  size: number;
}

interface BenchData {
  /** Absolute data root. */
  dir: string;
  sourceLabel: string;
  /** Recognized archive files (each is benchmarked individually). */
  archives: Archive[];
  /** Every file under the data root. */
  files: { abs: string; rel: string; size: number }[];
  totalBytes: number;
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

/** Top-level entry names of `dir` (relative), for CLI tools. */
async function topEntries(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) out.push(entry.name);
  return out;
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MiB`;
}

/** Use the data directory when it has files; otherwise generate synthetic data. */
async function makeData(): Promise<BenchData> {
  const dataPath = Deno.args[0] ?? Deno.env.get("BENCH_DATA") ?? "./.test_data";
  try {
    const stat = await Deno.stat(dataPath);
    if (stat.isDirectory) {
      const root = await Deno.realPath(dataPath);
      const files = await collectFiles(root);
      if (files.length > 0) {
        const archives: Archive[] = [];
        for (const f of files) {
          const format = formatOf(f.rel);
          if (format) {
            archives.push({
              abs: f.abs,
              rel: f.rel,
              name: f.rel.split("/").pop()!,
              format,
              size: f.size,
            });
          }
        }
        const total = files.reduce((n, f) => n + f.size, 0);
        const kind = archives.length > 0
          ? `${archives.length} archives`
          : `${files.length} files`;
        return {
          dir: root,
          sourceLabel: `${dataPath} (${kind}, ${mb(total)})`,
          archives,
          files,
          totalBytes: total,
        };
      }
    }
  } catch {
    // data path missing or unreadable — fall through to synthetic data
  }

  // Synthetic fallback: ~4 MiB of compressible text + binary.
  const dir = await Deno.makeTempDir({ prefix: "ouch-bench-" });
  const files: { abs: string; rel: string; size: number }[] = [];
  let totalBytes = 0;
  const textBlock = encoder.encode(
    "the quick brown fox jumps over the lazy dog. ".repeat(64),
  );

  await Deno.mkdir(`${dir}/text`, { recursive: true });
  for (let i = 0; i < 8; i++) {
    const rel = `text/doc${i}.txt`;
    const data = new Uint8Array(textBlock.length * 64); // 256 KiB each
    for (let j = 0; j < 64; j++) data.set(textBlock, j * textBlock.length);
    await Deno.writeFile(`${dir}/${rel}`, data);
    files.push({ abs: `${dir}/${rel}`, rel, size: data.length });
    totalBytes += data.length;
  }

  await Deno.mkdir(`${dir}/bin`, { recursive: true });
  let state = 0x12345678;
  const bin = new Uint8Array(1024 * 1024);
  for (let i = 0; i < bin.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bin[i] = (state >> 24) & 0xff;
  }
  await Deno.writeFile(`${dir}/bin/data.bin`, bin);
  files.push({ abs: `${dir}/bin/data.bin`, rel: "bin/data.bin", size: bin.length });
  totalBytes += bin.length;

  return {
    dir,
    sourceLabel:
      `synthetic (${mb(totalBytes)}; put archives in ./.test_data to benchmark them)`,
    archives: [],
    files,
    totalBytes,
  };
}

// ---------------------------------------------------------------------------
// Library (wasm) — random-access file sources/sinks, real disk I/O
// ---------------------------------------------------------------------------

async function libCompress(
  ouch: Ouch,
  files: { abs: string; rel: string }[],
  format: Format,
  out: string,
): Promise<void> {
  const sources = files.map((f) => ({
    path: f.rel,
    source: fromFileSync(f.abs),
  }));
  const output = `a.${extOf(format)}`;

  if (format === "zip" || format === "7z") {
    // Encoders need a seekable output: write to a file sink, then stream the
    // file back (discarded here) — the archive lands on disk.
    const sink = fileSinkSync(out);
    try {
      await ouch.compressTo(
        sources,
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
      sources,
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

/** Extract an archive into `outDir` via random access; every entry is written
 * to disk. `name` (e.g. "a.zip") selects the format. */
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

/** gz has no random-access reader: decode via the virtual filesystem (the
 * archive is loaded into wasm memory). Returns the content file name. */
async function libGzDecompress(
  ouch: Ouch,
  archive: string,
  outDir: string,
): Promise<string> {
  ouch.clear();
  ouch.writeFile("a.gz", await Deno.readFile(archive));
  const [entry] = ouch.listArchive({ archives: ["a.gz"] });
  await Deno.mkdir(outDir, { recursive: true });
  const file = await Deno.open(`${outDir}/${entry.path}`, {
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
  return entry.path;
}

// ---------------------------------------------------------------------------
// Benchmark harness
// ---------------------------------------------------------------------------

interface Measured {
  decompressMs: number;
  compressMs: number;
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

/** Extract an archive once (unmeasured) to get its original contents. */
async function extractContent(
  ouch: Ouch,
  archive: Archive,
  outDir: string,
): Promise<void> {
  if (archive.format === "gz") {
    await libGzDecompress(ouch, archive.abs, outDir);
  } else {
    await libDecompress(ouch, archive.abs, outDir, archive.name);
  }
}

// -- per-archive tools ------------------------------------------------------

/** Tools required by the external commands for a format (decompress+compress). */
function extTools(format: Format): string[] {
  switch (format) {
    case "zip":
      return ["zip", "unzip"];
    case "7z":
      return ["7z"];
    case "tar.gz":
    case "tar":
      return ["tar"];
    case "gz":
      return ["gzip"];
  }
}

function extAvailable(format: Format): boolean {
  return extTools(format).every((t) => TOOLS[t as keyof typeof TOOLS]);
}

async function measureLib(
  ouch: Ouch,
  archive: Archive,
  contentDir: string,
): Promise<Measured> {
  const decompressMs = await bestOf(RUNS, async () => {
    const outDir = await Deno.makeTempDir({ prefix: "ouch-bench-" });
    try {
      if (archive.format === "gz") await libGzDecompress(ouch, archive.abs, outDir);
      else await libDecompress(ouch, archive.abs, outDir, archive.name);
    } finally {
      await Deno.remove(outDir, { recursive: true });
    }
  });

  const contentFiles = await collectFiles(contentDir);
  const compressMs = await bestOf(RUNS, async () => {
    const work = await Deno.makeTempDir({ prefix: "ouch-bench-" });
    try {
      await libCompress(ouch, contentFiles, archive.format, `${work}/a.${extOf(archive.format)}`);
    } finally {
      await Deno.remove(work, { recursive: true });
    }
  });
  return { decompressMs, compressMs };
}

async function measureNative(
  native: string,
  archive: Archive,
  contentDir: string,
): Promise<Measured> {
  const decompressMs = await bestOf(RUNS, async () => {
    const work = await Deno.makeTempDir({ prefix: "ouch-bench-" });
    try {
      const outDir = `${work}/out`;
      await Deno.mkdir(outDir);
      runTool(
        native,
        ["-q", "-y", "decompress", archive.abs, "-d", outDir],
        work,
        false, // the native CLI is a Windows program: keep Windows paths
      );
    } finally {
      await Deno.remove(work, { recursive: true });
    }
  });

  const compressMs = await bestOf(RUNS, async () => {
    const work = await Deno.makeTempDir({ prefix: "ouch-bench-" });
    try {
      runTool(
        native,
        ["-q", "-y", "compress", ...await topEntries(contentDir), `${work}/a.${extOf(archive.format)}`],
        contentDir,
        false,
      );
    } finally {
      await Deno.remove(work, { recursive: true });
    }
  });
  return { decompressMs, compressMs };
}

async function measureExternal(
  archive: Archive,
  contentDir: string,
): Promise<Measured> {
  const decompressMs = await bestOf(RUNS, async () => {
    const work = await Deno.makeTempDir({ prefix: "ouch-bench-" });
    try {
      const outDir = `${work}/out`;
      await Deno.mkdir(outDir);
      switch (archive.format) {
        case "zip":
          runTool("unzip", ["-q", "-o", archive.abs, "-d", outDir], work);
          break;
        case "7z":
          runTool("7z", ["x", "-y", `-o${outDir}`, archive.abs], work, false);
          break;
        case "tar.gz":
          runTool("tar", ["-xzf", archive.abs, "-C", outDir], work);
          break;
        case "tar":
          runTool("tar", ["-xf", archive.abs, "-C", outDir], work);
          break;
        case "gz": {
          const raw = runToolCapture("gzip", ["-dc", archive.abs], work);
          const [content] = await collectFiles(contentDir);
          await Deno.writeFile(`${outDir}/${content.rel}`, raw);
          break;
        }
      }
    } finally {
      await Deno.remove(work, { recursive: true });
    }
  });

  const compressMs = await bestOf(RUNS, async () => {
    const work = await Deno.makeTempDir({ prefix: "ouch-bench-" });
    try {
      const out = `${work}/a.${extOf(archive.format)}`;
      const top = await topEntries(contentDir);
      switch (archive.format) {
        case "zip":
          runTool("zip", ["-r", "-q", out, ...top], contentDir);
          break;
        case "7z":
          runTool("7z", ["a", "-bd", out, ...top], contentDir, false);
          break;
        case "tar.gz":
          runTool("tar", ["-czf", out, ...top], contentDir);
          break;
        case "tar":
          runTool("tar", ["-cf", out, ...top], contentDir);
          break;
        case "gz": {
          const gz = runToolCapture("gzip", ["-c", top[0]], contentDir);
          await Deno.writeFile(out, gz);
          break;
        }
      }
    } finally {
      await Deno.remove(work, { recursive: true });
    }
  });
  return { decompressMs, compressMs };
}

// -- report helpers ---------------------------------------------------------

function mbPerSec(bytes: number, ms: number): string {
  return `${(bytes / (ms / 1000) / 1e6).toFixed(1)} MB/s`;
}

function fmtMs(ms: number, bytes: number): string {
  return `${ms.toFixed(0).padStart(7)} ms (${mbPerSec(bytes, ms).padStart(9)})`;
}

function fmtRow(
  dBytes: number,
  cBytes: number,
  measured: Measured,
): { compress: string; decompress: string } {
  return {
    decompress: fmtMs(measured.decompressMs, dBytes),
    compress: fmtMs(measured.compressMs, cBytes),
  };
}

async function printRow(
  label: string,
  dBytes: number,
  cBytes: number,
  measured: Measured | null,
): Promise<void> {
  if (!measured) return;
  const row = fmtRow(dBytes, cBytes, measured);
  console.log(
    `${label.padEnd(12)} ${row.decompress.padEnd(30)} ${row.compress.padEnd(30)}`,
  );
}

// ---------------------------------------------------------------------------
// Mode A: benchmark each archive in .test_data individually
// ---------------------------------------------------------------------------

async function benchArchives(
  ouch: Ouch,
  native: string | null,
  data: BenchData,
): Promise<void> {
  // Smallest archives first, so quick results show up immediately and a slow
  // huge archive can be interrupted without losing everything before it.
  const sorted = [...data.archives].sort((a, b) => a.size - b.size);
  for (const archive of sorted) {
    console.log(`--- ${archive.rel} (${mb(archive.size)} archive) ---`);
    const contentDir = await Deno.makeTempDir({ prefix: "ouch-bench-" });
    try {
      try {
        await extractContent(ouch, archive, contentDir);
      } catch (err) {
        console.log(`  skip: the library could not extract it: ${err}`);
        continue;
      }
      const content = await collectFiles(contentDir);
      const contentBytes = content.reduce((n, f) => n + f.size, 0);
      console.log(
        `tool${"".padEnd(6)} ${"decompress".padEnd(30)} ${"compress".padEnd(30)}`,
      );

      await printRow(
        "lib (wasm)",
        archive.size,
        contentBytes,
        await measureLib(ouch, archive, contentDir),
      );
      if (native) {
        await printRow(
          "ouch cli",
          archive.size,
          contentBytes,
          await measureNative(native, archive, contentDir),
        );
      }
      if (extAvailable(archive.format)) {
        await printRow(
          extTools(archive.format).join("/"),
          archive.size,
          contentBytes,
          await measureExternal(archive, contentDir),
        );
      }
      console.log();
    } finally {
      await Deno.remove(contentDir, { recursive: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Mode B: no archives — compress the whole directory (zip / 7z / tar.gz / gz)
// ---------------------------------------------------------------------------

async function benchDataset(
  ouch: Ouch,
  native: string | null,
  data: BenchData,
): Promise<void> {
  const inputBytes = data.totalBytes;
  const largest = data.files.reduce((a, b) => (b.size > a.size ? b : a));
  const top = await topEntries(data.dir);

  for (const format of ["zip", "7z", "tar.gz", "gz"] as Format[]) {
    const bytes = format === "gz" ? largest.size : inputBytes;
    console.log(`--- ${format} ---`);
    console.log(
      `${"tool".padEnd(12)} ${"compress".padEnd(30)} ${"decompress".padEnd(30)}`,
    );

    const compressFiles = format === "gz"
      ? [{ abs: largest.abs, rel: largest.rel }]
      : data.files;
    const lib = await measureDatasetLib(ouch, data.dir, format, compressFiles, largest);
    await printRow("lib (wasm)", bytes, bytes, lib);

    if (native) {
      const nat = await measureDatasetNative(native, data.dir, format, top, largest);
      await printRow("ouch cli", bytes, bytes, nat);
    }

    const ext = await measureDatasetExternal(data.dir, format, top, largest);
    const toolName = format === "zip" ? "zip/unzip" : format === "gz" ? "gzip" : format;
    await printRow(toolName, bytes, bytes, ext);
    console.log();
  }
}

async function measureDatasetLib(
  ouch: Ouch,
  dir: string,
  format: Format,
  files: { abs: string; rel: string }[],
  largest: { abs: string; rel: string; size: number },
): Promise<Measured | null> {
  const archivePath = `${dir}/.bench-a.${extOf(format)}`;
  const compressMs = await bestOf(RUNS, () =>
    libCompress(ouch, files, format, archivePath)
  );
  const decompressMs = format === "gz"
    ? await bestOf(RUNS, async () => {
      await libGzDecompress(ouch, archivePath, `${dir}/.bench-out`);
    })
    : await bestOf(RUNS, () =>
      libDecompress(ouch, archivePath, `${dir}/.bench-out`, `a.${extOf(format)}`)
    );
  return { decompressMs, compressMs };
}

async function measureDatasetNative(
  native: string,
  dir: string,
  format: Format,
  top: string[],
  largest: { abs: string; rel: string; size: number },
): Promise<Measured | null> {
  const archivePath = `${dir}/.bench-native.${extOf(format)}`;
  const compressMs = await bestOf(RUNS, () =>
    runTool(
      native,
      ["-q", "-y", "compress", ...(format === "gz" ? [largest.rel] : top), archivePath],
      dir,
      false,
    )
  );
  await Deno.mkdir(`${dir}/.bench-native-out`, { recursive: true });
  const decompressMs = await bestOf(RUNS, () =>
    runTool(
      native,
      ["-q", "-y", "decompress", archivePath, "-d", `${dir}/.bench-native-out`],
      dir,
      false,
    )
  );
  return { decompressMs, compressMs };
}

async function measureDatasetExternal(
  dir: string,
  format: Format,
  top: string[],
  largest: { abs: string; rel: string; size: number },
): Promise<Measured | null> {
  if (!extAvailable(format)) return null;
  const archivePath = `${dir}/.bench-ext.${extOf(format)}`;
  const compressMs = await bestOf(RUNS, async () => {
    switch (format) {
      case "zip":
        runTool("zip", ["-r", "-q", archivePath, ...top], dir);
        break;
      case "7z":
        runTool("7z", ["a", "-bd", archivePath, ...top], dir, false);
        break;
      case "tar.gz":
        runTool("tar", ["-czf", archivePath, ...top], dir);
        break;
      case "gz": {
        const gz = runToolCapture("gzip", ["-c", largest.rel], dir);
        await Deno.writeFile(archivePath, gz);
        break;
      }
    }
  });
  await Deno.mkdir(`${dir}/.bench-ext-out`, { recursive: true });
  const decompressMs = await bestOf(RUNS, async () => {
    switch (format) {
      case "zip":
        runTool("unzip", ["-q", "-o", archivePath, "-d", `${dir}/.bench-ext-out`], dir);
        break;
      case "7z":
        runTool("7z", ["x", "-y", `-o${dir}/.bench-ext-out`, archivePath], dir, false);
        break;
      case "tar.gz":
        runTool("tar", ["-xzf", archivePath, "-C", `${dir}/.bench-ext-out`], dir);
        break;
      case "gz": {
        const raw = runToolCapture("gzip", ["-dc", archivePath], dir);
        await Deno.writeFile(`${dir}/.bench-ext-out/${largest.rel}`, raw);
        break;
      }
    }
  });
  return { decompressMs, compressMs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const ouch = await init();
  const native = await findNativeOuch();
  const data = await makeData();

  RUNS = Number(Deno.env.get("BENCH_RUNS") ?? "0") ||
    (data.totalBytes > 512e6 ? 1 : 3);

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

  if (data.archives.length > 0) {
    await benchArchives(ouch, native, data);
  } else {
    await benchDataset(ouch, native, data);
  }

  if (data.sourceLabel.startsWith("synthetic")) {
    await Deno.remove(data.dir, { recursive: true });
  }
  console.log("done.");
}

if (import.meta.main) {
  await run();
}
