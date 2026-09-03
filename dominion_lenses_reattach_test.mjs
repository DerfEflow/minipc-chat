/*
 * Streams lane self-test - run with: node dominion_lenses_reattach_test.mjs
 *
 * public/dominion-lenses.js is a browser IIFE (no exports, top-level code touches document/window
 * unconditionally), so this executes the REAL source inside a vm context with a minimal shim —
 * genuine behavioral coverage of the incremental-reattach logic, not a regex proxy over the text.
 *
 * The shim deliberately leaves #cru / #cru-body unresolved (querySelector returns null for them),
 * which makes render()/paintLink() no-op through their own existing `if (!x) return;` guards —
 * this exercises follow()/attachStream()'s real control flow (state.events, state.seenRecords,
 * state.link, the EventSource URLs it opens) without needing to also shim the heavy blueprint()/
 * workshop() DOM renderers, which is not what this test is about.
 *
 * Proves:
 *   1. a fresh follow() attaches at from=0
 *   2. a drop (onerror, not terminal) keeps state.jobId and state.events — no clearing — and
 *      flips state.link to "reconnecting"
 *   3. the reconnect resumes at from=<events already seen>, not from=0 (no full replay)
 *   4. the reconnect's onopen flips state.link back to "live"
 *   5. a duplicate `_record` on the new connection is deduped (state.events does not grow)
 *   6. a new `_record` on the new connection IS applied (state.events grows)
 *   7. only {type:"gone"} clears state.jobId — a plain drop never does
 *   8. a terminal event closes the EventSource
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./public/dominion-lenses.js", import.meta.url), "utf8");

let passed = 0, failed = 0;
// async-aware so a test that needs to wait for a real setTimeout (the reconnect delay) can just
// await fn() like any other; a synchronous fn() awaits trivially and runs in the same tick.
const t = async (name, fn) => {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); }
};

// ---- minimal shim: just enough surface for this file's top-level code + the reattach path ----
function makeEl(id) {
  const el = {
    id: id || "",
    dataset: {},
    _classes: new Set(),
    classList: {
      add(c) { el._classes.add(c); }, remove(c) { el._classes.delete(c); },
      toggle(c, on) { if (on) el._classes.add(c); else el._classes.delete(c); },
      contains(c) { return el._classes.has(c); },
    },
    children: [],
    append() {}, appendChild() {}, prepend() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    replaceChildren() {},
  };
  return el;
}
const bodyEl = makeEl("body");
bodyEl.classList.add("ide-open");   // the mutation-observer / visibilitychange gates read this; never fires in this test anyway

// #cru / #cru-body deliberately absent: render()/paintLink() see `null` and no-op, which is exactly
// what lets this test drive real follow()/attachStream() logic without a full DOM.
const documentShim = {
  body: bodyEl,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  addEventListener: () => {},
  dispatchEvent: () => true,
};

const createdEventSources = [];
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.onopen = null; this.onmessage = null; this.onerror = null;
    this.closed = false;
    createdEventSources.push(this);
  }
  close() { this.closed = true; }
  // test helpers, not part of the real EventSource API
  emit(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
  open() { if (this.onopen) this.onopen(); }
  fail() { if (this.onerror) this.onerror(new Event("error")); }
}

const localStorageShim = (() => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
})();

const sandbox = {
  window: {},
  document: documentShim,
  localStorage: localStorageShim,
  EventSource: FakeEventSource,
  MutationObserver: class { constructor() {} observe() {} disconnect() {} },
  fetch: async () => ({ ok: true, json: async () => ({ jobs: [] }) }),
  console,
  setTimeout, clearTimeout,
  Event: (typeof Event !== "undefined" ? Event : class { constructor(t) { this.type = t; } }),
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "dominion-lenses.js" });

const lenses = sandbox.window.dominionLenses;
assert.ok(lenses, "the module must expose window.dominionLenses");

// ---- 1. fresh follow() attaches at from=0, link starts "live" ----
await t("a fresh follow() opens the attach stream at from=0", () => {
  lenses.follow("job1");
  assert.equal(createdEventSources.length, 1, "exactly one EventSource so far");
  assert.match(createdEventSources[0].url, /\/ide\/job\/attach\?job=job1&from=0$/);
  assert.equal(lenses.state.jobId, "job1");
  assert.equal(lenses.state.link, "live");
  assert.equal(lenses.state.events.length, 0);
});

const es1 = createdEventSources[0];

await t("received events accumulate in state.events", () => {
  es1.emit({ type: "job", id: "job1", _record: "w1:1" });
  es1.emit({ type: "plan", moves: [], _record: "w1:2" });
  es1.emit({ type: "move", id: "m1", state: "running", _record: "w1:3" });
  assert.equal(lenses.state.events.length, 3);
  assert.equal(lenses.state.jobId, "job1", "job id unchanged by ordinary events");
});

// ---- 2 + 3. a drop keeps state and reconnects incrementally (from=<count seen>, not from=0) ----
await t("a drop (onerror, not terminal) keeps jobId+events and flips link to reconnecting", () => {
  es1.fail();
  assert.equal(lenses.state.jobId, "job1", "job id must survive a transient drop");
  assert.equal(lenses.state.events.length, 3, "already-rendered events must survive a transient drop");
  assert.equal(lenses.state.link, "reconnecting");
  assert.equal(es1.closed, true, "the dead EventSource is closed explicitly");
});

let es2;
await t("the reconnect resumes at from=<events already seen>, never from=0 (no full replay)", async () => {
  // attachStream's retry is scheduled via setTimeout(..., 2000) — real timers, so wait for it.
  const deadline = Date.now() + 5000;
  while (createdEventSources.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(createdEventSources.length, 2, "exactly one reconnect attempt");
  es2 = createdEventSources[1];
  assert.match(es2.url, /\/ide\/job\/attach\?job=job1&from=3$/, "must resume at from=3, not from=0: " + es2.url);
});

// ---- 4. onopen flips link back to "live" ----
await t("the reconnect's onopen flips link back to live", () => {
  assert.equal(lenses.state.link, "reconnecting", "still reconnecting before onopen fires");
  es2.open();
  assert.equal(lenses.state.link, "live");
});

// ---- 5 + 6. dedupe by _record on the reconnected stream ----
await t("a duplicate _record on the new connection is deduped, not double-applied", () => {
  es2.emit({ type: "move", id: "m1", state: "running", _record: "w1:3" });   // same _record already seen
  assert.equal(lenses.state.events.length, 3, "a resent duplicate must not grow state.events");
});
await t("a genuinely new _record on the new connection is applied", () => {
  es2.emit({ type: "move", id: "m1", state: "done", _record: "w1:4" });
  assert.equal(lenses.state.events.length, 4, "a new record must be appended");
});

// ---- 7. only {type:"gone"} clears state.jobId ----
await t("a further drop still does not clear jobId (only gone does)", () => {
  es2.fail();
  assert.equal(lenses.state.jobId, "job1");
  assert.equal(lenses.state.link, "reconnecting");
});

let es3;
await t("the second reconnect resumes at from=4", async () => {
  const deadline = Date.now() + 5000;
  while (createdEventSources.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(createdEventSources.length, 3);
  es3 = createdEventSources[2];
  assert.match(es3.url, /\/ide\/job\/attach\?job=job1&from=4$/, es3.url);
});

await t("{type:\"gone\"} is the ONLY thing that clears jobId and resets to a fresh empty state", () => {
  es3.emit({ type: "gone" });
  assert.equal(lenses.state.jobId, "", "gone must clear the job id");
  assert.equal(es3.closed, true);
});

// ---- 8. a terminal event closes the stream on a normal live follow ----
await t("a terminal event (done) closes the EventSource explicitly", () => {
  createdEventSources.length = 0;
  lenses.follow("job2");
  const es = createdEventSources[0];
  es.emit({ type: "job", id: "job2", _record: "w2:1" });
  es.emit({ type: "done", _record: "w2:2" });
  assert.equal(es.closed, true, "a terminal event must close the stream itself");
  assert.equal(lenses.state.jobId, "job2", "a terminal job id is NOT cleared — it stays on screen");
});

console.log(`\ndominion_lenses_reattach_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
