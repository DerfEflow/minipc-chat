/*
 * The streaming tar packer (tarstream.mjs).
 *
 * The claim that justifies this module existing at all is the MEMORY one: it must archive a file
 * far larger than any buffer it holds. If that is not true, the module is pointless and the backup
 * dies the day /data outgrows the container, which is the day the data became worth protecting.
 *
 * The other claims are about not producing a corrupt archive under the conditions a LIVE volume
 * actually presents: files that vanish between the walk and the read, files that shrink while being
 * read, and paths too long for a plain ustar name field. Every one of those, handled wrong, does the
 * same thing: desynchronises the reader and silently ruins every file after it in the archive.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { tarStream } from "./tarstream.mjs";
import { unpack } from "./tarlite.mjs";

let passed = 0;
const t = async (name, fn) => { await fn(); console.log("  PASS  " + name); passed++; };

const DIR = mkdtempSync(join(tmpdir(), "tarstream-"));
const collect = async (stream) => {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
};

await t("a streamed archive is readable by the buffered reader", async () => {
  writeFileSync(join(DIR, "a.txt"), "hello");
  writeFileSync(join(DIR, "b.json"), '{"n":1}');
  const buf = await collect(tarStream([
    { path: join(DIR, "a.txt"), name: "a.txt" },
    { path: join(DIR, "b.json"), name: "sub/b.json" },
  ]));
  const back = Object.fromEntries(unpack(buf).filter((e) => !e.dir).map((e) => [e.name, e.data.toString()]));
  assert.equal(back["a.txt"], "hello");
  assert.equal(back["sub/b.json"], '{"n":1}');
});

await t("THE POINT: a file far larger than the buffer streams without holding it", async () => {
  // 40MB against a 64KB chunk. If the packer buffered, peak memory would track the file.
  const big = join(DIR, "big.bin");
  const block = Buffer.alloc(1024 * 1024, 0xab);
  writeFileSync(big, Buffer.concat(Array.from({ length: 40 }, () => block)));
  const size = statSync(big).size;
  assert.equal(size, 40 * 1024 * 1024);

  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  let peak = before, bytes = 0;
  const stream = tarStream([{ path: big, name: "big.bin" }], { chunkBytes: 64 * 1024 });
  for await (const c of stream) {
    bytes += c.length;                                   // consumed and dropped, never accumulated
    const now = process.memoryUsage().heapUsed;
    if (now > peak) peak = now;
  }
  const grew = peak - before;
  assert.ok(bytes >= size, "the whole file must come through: " + bytes + " of " + size);
  assert.ok(grew < 12 * 1024 * 1024,
    "heap grew " + Math.round(grew / 1e6) + "MB archiving a 40MB file; the packer is buffering");
});

await t("a path too long for a tar name still round-trips", async () => {
  const deep = join(DIR, "deep");
  const a = "a".repeat(80), b = "b".repeat(80);
  mkdirSync(join(deep, a, b), { recursive: true });
  writeFileSync(join(deep, a, b, "f.txt"), "deep value");
  const name = "deep/" + a + "/" + b + "/f.txt";
  const buf = await collect(tarStream([{ path: join(deep, a, b, "f.txt"), name }]));
  const back = unpack(buf).filter((e) => !e.dir);
  assert.equal(back.length, 1);
  assert.equal(back[0].name, name);
  assert.equal(back[0].data.toString(), "deep value");
});

await t("a file that vanished mid-walk is skipped and the archive stays valid", async () => {
  writeFileSync(join(DIR, "keep1.txt"), "one");
  writeFileSync(join(DIR, "keep2.txt"), "two");
  const skipped = [];
  const buf = await collect(tarStream([
    { path: join(DIR, "keep1.txt"), name: "keep1.txt" },
    { path: join(DIR, "gone.txt"), name: "gone.txt" },          // never existed
    { path: join(DIR, "keep2.txt"), name: "keep2.txt" },
  ], { onSkip: (f, why) => skipped.push(f.name + ": " + why) }));
  const back = Object.fromEntries(unpack(buf).filter((e) => !e.dir).map((e) => [e.name, e.data.toString()]));
  assert.equal(skipped.length, 1, "the skip must be REPORTED, not swallowed: " + JSON.stringify(skipped));
  assert.match(skipped[0], /^gone\.txt: /);
  // The files on BOTH sides of the missing one must survive intact. A desynchronised reader would
  // typically mangle everything after the gap, so keep2 is the real assertion here.
  assert.equal(back["keep1.txt"], "one");
  assert.equal(back["keep2.txt"], "two", "the entry AFTER a skipped file must not be corrupted");
});

await t("a file that shrinks after its header is written keeps the archive structurally valid", async () => {
  const shrink = join(DIR, "shrink.bin");
  writeFileSync(shrink, Buffer.alloc(300_000, 7));
  const declared = statSync(shrink).size;
  // Hand the packer a size larger than the file really is: the same desync a live truncation causes.
  const buf = await collect(tarStream([
    { path: shrink, name: "shrink.bin", size: declared + 100_000, mtime: 0 },
    { path: join(DIR, "a.txt"), name: "after.txt" },
  ]));
  const back = unpack(buf).filter((e) => !e.dir);
  const byName = Object.fromEntries(back.map((e) => [e.name, e.data]));
  assert.equal(byName["shrink.bin"].length, declared + 100_000, "the payload must match the declared size");
  assert.equal(byName["after.txt"].toString(), "hello", "the NEXT file must still be readable");
});

await t("it composes with gzip, which is how the backup actually ships", async () => {
  const out = [];
  const gz = createGzip();
  const src = tarStream([{ path: join(DIR, "a.txt"), name: "a.txt" }]);
  gz.on("data", (c) => out.push(c));
  await pipeline(src, gz);
  const back = unpack(gunzipSync(Buffer.concat(out))).filter((e) => !e.dir);
  assert.equal(back[0].data.toString(), "hello");
});

try { rmSync(DIR, { recursive: true, force: true }); } catch {}
console.log(`\n${passed}/6 checks passed - the packer streams, and a live volume cannot desync it`);
