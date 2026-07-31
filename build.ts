// (Re)build the ouch wasm package with wasm-pack, then copy the artifacts
// into ./pkg so the TS package can import them without dragging the whole
// rust repo into the published package.
//
// Usage:
//   deno task build
//
// Output: ./pkg/ (ouch.js, ouch_bg.wasm, ouch.d.ts, ...)

const args = [
  "build",
  "--target",
  "web",
  "--no-default-features",
  "--features",
  "wasm",
];

console.log(`wasm-pack ${args.join(" ")}`);

const cmd = new Deno.Command("wasm-pack", {
  args,
  cwd: "./ouch",
  stdout: "inherit",
  stderr: "inherit",
});

const result = await cmd.output();
if (!result.success) {
  console.error("wasm-pack failed");
  Deno.exit(result.code);
}

// Copy the generated bindings into the package root.
const outDir = "./pkg";
Deno.mkdirSync(outDir, { recursive: true });
let copied = 0;
for (const file of Deno.readDirSync("./ouch/pkg")) {
  Deno.copyFileSync(`./ouch/pkg/${file.name}`, `${outDir}/${file.name}`);
  copied += 1;
}
console.log(`done: ./pkg/ (${copied} files)`);
