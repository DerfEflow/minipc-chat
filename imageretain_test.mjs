/*
 * Image retention + billing-order self-test — run with: node imageretain_test.mjs
 *
 * The bug: handleGenerate charged with meter() and THEN wrote the response, while keeping no copy
 * of the image. The generation itself was never fragile (Node does not abort a handler when a
 * client disconnects, so OpenAI always delivered), but a user who navigated away mid-generation
 * paid in full for an image that then existed nowhere.
 *
 * The rule now under test:
 *   kept                          -> charge
 *   not kept, socket still open   -> charge (it goes out inline)
 *   not kept, socket already gone -> DO NOT charge (nobody received anything)
 *
 * The third case costs Dominion the provider fee. That is the right way round: OpenAI is paid
 * either way, and eating it beats taking money from somebody for nothing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + ((e && e.message) || e)); }
}

const images = readFileSync(new URL("./images.mjs", import.meta.url), "utf8");
const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

console.log("image retention and billing order");

t("the copy is taken BEFORE the charge is decided", () => {
  const code = strip(images);
  const gen = code.slice(code.indexOf("async function handleGenerate"));
  const body = gen.slice(0, gen.indexOf("\n  async function"));
  const retainAt = body.indexOf("retain(");
  const meterAt = body.indexOf("meter(T, costUsd)");
  assert.ok(retainAt > 0, "handleGenerate must attempt to keep a copy");
  assert.ok(meterAt > 0, "handleGenerate must still meter");
  assert.ok(retainAt < meterAt, "keeping the image must happen before the charge is decided");
});

t("a disconnected client with no copy is not charged", () => {
  const code = strip(images);
  assert.match(code, /res\.writableEnded \|\| res\.destroyed \|\| req\.destroyed/,
    "the handler must actually check whether anyone is still listening");
  assert.match(code, /if \(resultRef \|\| !clientGone\) meter\(T, costUsd\)/,
    "the charge must depend on the image having reached somebody");
  // The unpaid case has to be loud: a rise in it means retention broke, not that users are unlucky.
  assert.match(code, /NOT CHARGED/, "an unbilled generation must announce itself in the log");
});

t("retain is optional, so the module still stands alone", () => {
  assert.match(images, /retain = null/, "a default keeps images.mjs testable without the kernel");
  assert.match(strip(images), /typeof retain === "function"/, "and guards the call");
});

t("a failed retain never takes the user's image down with it", () => {
  const code = strip(images);
  const block = code.slice(code.indexOf("if (typeof retain === \"function\")"), code.indexOf("const clientGone"));
  assert.match(block, /catch/, "a retention failure must not fail a generation the user already paid for");
});

t("the record is only created after the bytes are on disk", () => {
  const code = strip(server);
  const fn = code.slice(code.indexOf("async function retainImages"));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  const writeAt = body.indexOf("writeFile");
  const createAt = body.indexOf("tasks.createTask");
  assert.ok(writeAt > 0 && createAt > 0, "both steps must exist");
  assert.ok(writeAt < createAt, "a task must never point at bytes that are not there yet");
});

t("collecting a kept image is identity-scoped and unprobeable", () => {
  const code = strip(server);
  const fn = code.slice(code.indexOf("async function handleImageKept"));
  const body = fn.slice(0, fn.indexOf("\nconst imagesFeature"));
  assert.match(body, /row\.uid !== T\.uid/, "one user must not collect another's image");
  assert.match(body, /role === "anon"/, "an anonymous caller must not collect at all");
  // Unknown and foreign must be the same answer, or this becomes an id oracle.
  assert.match(body, /return sjson\(res, 404, \{ error: "not found" \}\)/,
    "foreign and unknown must be indistinguishable");
});

t("the retention window actually deletes the pictures", () => {
  const code = strip(server);
  assert.match(code, /IMAGE_RETAIN_MS/, "the window must be one named number");
  // gcRetention hands back refs precisely so the caller can delete what they point at. Dropping
  // rows without deleting files turns a privacy window into an unbounded folder of other people's
  // images, which is the exact opposite of the point.
  assert.match(code, /for \(const ref of swept\.orphanedRefs/, "swept artifacts must be deleted, not just forgotten");
  assert.match(code, /fsp\.rm\(ref, \{ recursive: true, force: true \}\)/, "and actually removed from disk");
  // Only ever inside our own directory: a resultRef is data, and data must not steer an rm -rf.
  assert.match(code, /ref\.startsWith\(IMAGE_KEEP_DIR\)/,
    "deletion must be confined to the retention directory, whatever a record claims");
});

t("the window is short, because this is a delivery buffer and not a gallery", () => {
  const m = /IMAGE_RETAIN_MS", String\((\d+) \* 3600000\)/.exec(server);
  assert.ok(m, "the default must be stated as hours in one place");
  const hours = Number(m[1]);
  assert.ok(hours > 0 && hours <= 168, `a delivery buffer should be days at most, found ${hours}h`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
