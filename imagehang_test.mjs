/*
 * Image panel liveness self-test — run with: node imagehang_test.mjs
 *
 * The bug (Fred, 2026-08-08): "it would hang and all other images after did not generate."
 *
 * It reads like a stuck lock and is not one. onIgnite raises state.generating, awaits the work,
 * and clears the flag in a `finally` — which is correct. The failure is that an await can hang
 * FOREVER, so the finally simply never runs. The flag stays true, every later click hits
 * `if (state.generating) return`, and the panel is dead for the rest of the session with no error
 * anywhere. Two separate awaits could do it:
 *
 *   1. apiJson's bare `fetch(url, opts)` with no signal. A stalled connection neither resolves nor
 *      rejects.
 *   2. `await armFolder()` sitting ABOVE the try, so a browser permission prompt nobody answers
 *      hangs outside the guard entirely.
 *
 * The invariant these tests defend: between raising state.generating and the finally that clears
 * it, no await may sit outside the guard, and no await may be unbounded.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + ((e && e.message) || e)); }
}

const src = readFileSync(new URL("./public/dominion-images.js", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

console.log("image panel liveness");

t("every request carries a deadline", () => {
  const fn = code.slice(code.indexOf("async function apiJson"));
  const body = fn.slice(0, fn.indexOf("\n  function friendly"));
  assert.ok(body.length > 100, "failed to isolate apiJson");
  assert.match(body, /AbortController/, "a fetch with no signal can hang forever");
  assert.match(body, /signal: ac\.signal/, "the controller must actually be attached to the request");
  assert.match(body, /setTimeout\(\(\) => ac\.abort\(\)/, "and something must eventually fire it");
  assert.match(body, /clearTimeout\(timer\)/, "the timer must be cleared or it leaks per request");
});

t("the deadline is generous enough not to kill slow-but-working generations", () => {
  const m = /timeoutMs = (\d+)/.exec(code);
  assert.ok(m, "the timeout must be a named, findable default");
  const secs = Number(m[1]) / 1000;
  assert.ok(secs >= 120, `a high-quality generation genuinely takes minutes; ${secs}s would cut real work off`);
  assert.ok(secs <= 600, `${secs}s is long enough that a user would give up before the error arrives`);
});

t("a timeout is reported as an ordinary error, not a silent stall", () => {
  const fn = code.slice(code.indexOf("async function apiJson"));
  const body = fn.slice(0, fn.indexOf("\n  function friendly"));
  assert.match(body, /AbortError/, "an abort must be recognised and translated");
  assert.match(body, /code = "timeout"/, "so the panel can tell it apart from a server refusal");
});

t("nothing awaits outside the guard once the lock is raised", () => {
  const fn = code.slice(code.indexOf("async function onIgnite"));
  const body = fn.slice(0, fn.indexOf("\n  function renderFoundry"));
  assert.ok(body.length > 500, "failed to isolate onIgnite");

  const lockAt = body.indexOf("state.generating = true");
  const tryAt = body.indexOf("try {", lockAt);
  assert.ok(lockAt > 0 && tryAt > lockAt, "the lock must be raised before the guarded section");

  // The window between raising the flag and entering the try is where a hang becomes permanent.
  const window = body.slice(lockAt, tryAt);
  assert.ok(!/\bawait\b/.test(window),
    "an await between raising state.generating and the try can hang the panel forever:\n" + window);
});

t("the lock is released on every path", () => {
  const fn = code.slice(code.indexOf("async function onIgnite"));
  const body = fn.slice(0, fn.indexOf("\n  function renderFoundry"));
  const finallyAt = body.indexOf("} finally {");
  assert.ok(finallyAt > 0, "there must be a finally");
  const tail = body.slice(finallyAt);
  assert.match(tail, /state\.generating = false/, "the flag must clear in the finally, not in the happy path");
  assert.match(tail, /btn\.disabled = false/, "and the button must come back, or the panel still looks dead");
});

t("armFolder is inside the guard", () => {
  const fn = code.slice(code.indexOf("async function onIgnite"));
  const body = fn.slice(0, fn.indexOf("\n  function renderFoundry"));
  const armAt = body.indexOf("armFolder()");
  const tryAt = body.indexOf("try {");
  assert.ok(armAt > tryAt, "a permission prompt nobody answers must not be able to strand the lock");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
