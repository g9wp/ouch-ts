// Entry-point tests: verify the "./deno" and "./node" subpath exports expose
// working runtime-specific file helpers on top of the shared core.

import { assert, assertEquals } from "@std/assert";
import * as denoEntry from "./deno.ts";
import * as nodeEntry from "./node.ts";
import { init, type SeekableSource } from "./mod.ts";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

Deno.test("deno entry: file helpers backed by Deno APIs", async () => {
  const tmp = await Deno.makeTempFile();
  try {
    await denoEntry.writeFile(tmp, bytes("deno entry"));
    assertEquals(await denoEntry.readFile(tmp), bytes("deno entry"));

    const src = denoEntry.fromFileSync(tmp);
    assertEquals(text(src.readAt(0, 10)), "deno entry");
    src.close();

    const asrc = await denoEntry.fromFile(tmp);
    assertEquals(text(await asrc.readAt(0, 10)), "deno entry");
    await asrc.close();

    const loaded: SeekableSource = await denoEntry.loadFile(tmp);
    assertEquals(text(loaded.readAt(0, 10)), "deno entry");

    const sink = await denoEntry.fileSink(tmp);
    await sink.writeAt(0, bytes("sink!"));
    assertEquals(await sink.size(), 5);
    assertEquals(text(await sink.readAt(0, 5)), "sink!");
    await sink.close();

    const sinkSync = denoEntry.fileSinkSync(tmp);
    assertEquals(sinkSync.writeAt(0, bytes("sync!")), 5);
    sinkSync.close();
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("node entry: file helpers backed by node:fs", async () => {
  const tmp = await Deno.makeTempFile();
  try {
    await nodeEntry.writeFile(tmp, bytes("node entry"));
    assertEquals(await nodeEntry.readFile(tmp), bytes("node entry"));

    const src = nodeEntry.fromFileSync(tmp);
    assertEquals(text(src.readAt(0, 10)), "node entry");
    src.close();

    const asrc = await nodeEntry.fromFile(tmp);
    assertEquals(text(await asrc.readAt(0, 10)), "node entry");
    await asrc.close();

    const loaded: SeekableSource = await nodeEntry.loadFile(tmp);
    assertEquals(text(loaded.readAt(0, 10)), "node entry");

    const sink = await nodeEntry.fileSink(tmp);
    await sink.writeAt(0, bytes("sink!"));
    assertEquals(await sink.size(), 5);
    assertEquals(text(await sink.readAt(0, 5)), "sink!");
    await sink.close();
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("deno and node entries share one wasm core instance", async () => {
  const viaDeno = await denoEntry.init();
  const viaNode = await nodeEntry.init();
  assertEquals(viaDeno, viaNode, "init() must return the same singleton");

  viaDeno.clear();
  viaDeno.writeFile("x.txt", bytes("shared core"));
  viaDeno.compress({ files: ["x.txt"], output: "x.zip" });
  assert(viaNode.exists("x.zip"));
  viaNode.clear();
});

Deno.test("deno entry drives a full zip roundtrip", async () => {
  const ouch = await init();
  ouch.clear();

  const tmp = await Deno.makeTempFile({ suffix: ".zip" });
  try {
    const sink = await denoEntry.fileSink(tmp);
    try {
      const chunks: Uint8Array[] = [];
      const result = await ouch.compressTo(
        [{ path: "a.txt", source: denoEntry.fromBytes(bytes("deno zip")) }],
        new WritableStream<Uint8Array>({
          write: (c: Uint8Array) => {
            chunks.push(c);
          },
        }),
        { output: "out.zip", sink },
      );
      assertEquals(result.entries, 1);
      const archive = new Uint8Array(
        chunks.reduce((n, c) => n + c.length, 0),
      );
      let off = 0;
      for (const c of chunks) {
        archive.set(c, off);
        off += c.length;
      }

      ouch.writeFile("out.zip", archive);
      const unpacked = ouch.decompress({ files: ["out.zip"], outputDir: "x" });
      assertEquals(unpacked.files_unpacked, 1);
      assertEquals(text(ouch.readFile("x/a.txt")), "deno zip");
    } finally {
      await sink.close();
    }
  } finally {
    await Deno.remove(tmp);
  }
});
