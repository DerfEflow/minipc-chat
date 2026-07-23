/*
 * Unit test for chatjobs.mjs (the durable store) — run with: node chatjobs_unit_test.mjs
 * No server, no network: exercises coalesceEvents + the store's persist/replay/orphan/retention/cap
 * logic directly against a temp SQLite DB. Uses an injectable clock so retention windows are exact.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatJobs, coalesceEvents } from "./chatjobs.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); }
}

// ---- coalesceEvents: token runs collapse; structural events survive; working drops ----
t("coalesce: contiguous token runs merge into one fat delta with correct span", () => {
  const evs = [
    { type: "job", id: "j" },
    { type: "token", delta: "a" }, { type: "token", delta: "b" }, { type: "token", delta: "c" },
    { type: "tool", name: "x", status: "run" },
    { type: "token", delta: "d" }, { type: "token", delta: "e" },
    { type: "done", meta: {} },
  ];
  const rows = coalesceEvents(evs, 0);
  // job(0), token-run[1..3]->one row, tool(4), token-run[5..6]->one row, done(6-index7)
  assert.deepEqual(rows.map((r) => r.ev.type), ["job", "token", "tool", "token", "done"]);
  const tok = rows.filter((r) => r.ev.type === "token");
  assert.equal(tok[0].ev.delta, "abc"); assert.equal(tok[0].seq, 1); assert.equal(tok[0].span, 3);
  assert.equal(tok[1].ev.delta, "de"); assert.equal(tok[1].seq, 5); assert.equal(tok[1].span, 2);
  assert.equal(rows[rows.length - 1].seq, 7);   // done sits at the right absolute seq
});
t("coalesce: working heartbeats are not persisted but still consume a seq", () => {
  const rows = coalesceEvents([{ type: "token", delta: "a" }, { type: "working", phase: "x" }, { type: "token", delta: "b" }], 10);
  // the working event splits the token run (seq 10 then seq 12) and is itself dropped
  assert.deepEqual(rows.map((r) => [r.seq, r.ev.delta]), [[10, "a"], [12, "b"]]);
});

const dir = mkdtempSync(join(tmpdir(), "chatjobs-unit-"));
let clock = 1_000_000;
const now = () => clock;
const store = createChatJobs({ dir, now });

t("createJob + appendRows + resultFor reconstructs the full answer and tool trail", () => {
  store.createJob({ id: "j1", chatId: "c1", email: "A@x.com", uid: "ua", startedAt: now() });
  const evs = [
    { type: "job", id: "j1" }, { type: "route", model: "m", mode: "normal" },
    { type: "token", delta: "Hello " }, { type: "token", delta: "world" },
    { type: "tool", name: "search", status: "done" },
    { type: "token", delta: "!" }, { type: "done", meta: { costUsd: 0.01 } },
  ];
  store.appendRows("j1", coalesceEvents(evs, 0), evs.length, 12);
  store.finish("j1", "done", { costUsd: 0.01 });
  const r = store.resultFor("j1");
  assert.equal(r.text, "Hello world!");
  assert.equal(r.status, "done");
  assert.deepEqual(r.tools, ["search:done"]);
  assert.equal(r.meta.costUsd, 0.01);
});

t("email scoping: listFor + runningCountFor are per-identity", () => {
  store.createJob({ id: "j2", chatId: "c2", email: "B@x.com", startedAt: now() });   // still running
  store.createJob({ id: "j3", chatId: "c3", email: "A@x.com", startedAt: now() });   // still running
  assert.equal(store.runningCountFor("a@x.com"), 1);   // j1 finished, j3 running (lowercased match)
  assert.equal(store.runningCountFor("b@x.com"), 1);
  const aJobs = store.listFor("A@x.com");
  assert.ok(aJobs.every((j) => j.id !== "j2"), "user A never sees user B's job");
  assert.deepEqual(store.listFor("A@x.com", { chatId: "c1" }).map((j) => j.id), ["j1"]);
});

t("replayRows: from>0 returns rows whose span still covers the cursor", () => {
  // j1's stored rows: job@0, route@1, token'Hello world'@2(span2), tool@4, token'!'@5, done@6
  const all = store.replayRows("j1", 0);
  assert.deepEqual(all.map((r) => r.seq), [0, 1, 2, 4, 5, 6]);
  const from3 = store.replayRows("j1", 3);   // 3 lands INSIDE the span-2 token row at seq 2 -> included
  assert.equal(from3[0].seq, 2, "the straddling coalesced row is returned whole");
});

t("collect starts the retention clock; gcRetention drops collected events then the row", () => {
  store.collect("j1");
  // events survive until collectedTtlMs passes
  store.gcRetention({ collectedTtlMs: 1000, uncollectedTtlMs: 0 });
  assert.ok(store.replayRows("j1", 0).length > 0, "still within collected TTL");
  clock += 2000;
  store.gcRetention({ collectedTtlMs: 1000, uncollectedTtlMs: 0 });
  assert.equal(store.replayRows("j1", 0).length, 0, "events swept after collected TTL");
  assert.ok(store.get("j1"), "bare row lingers for the debug/inbox trail");
});

t("sweepOrphans: a fresh store over the same dir turns 'running' rows into orphans", () => {
  // j2 (B) and j3 (A) were left running above. A brand-new store instance = a simulated reboot.
  const store2 = createChatJobs({ dir, now });
  assert.equal(store2.orphanedAtBoot >= 2, true, "the reboot swept the still-running rows");
  const r = store2.resultFor("j3");
  assert.equal(r.status, "orphaned");
  assert.ok(r.errors.some((e) => /restarted/i.test(e)), "orphan carries the server_restart explanation");
  // the synthetic tail is a real error + stopped the client already knows how to render
  const types = store2.replayRows("j3", 0).map((x) => x.ev.type);
  assert.ok(types.includes("error") && types.includes("stopped"));
  assert.equal(store2.runningCountFor("a@x.com"), 0, "nothing is 'running' after the sweep");
});

// Windows: an open sqlite handle can EPERM the cleanup after every assertion passed. Same
// pattern as longrun_e2e: retry briefly, then let the OS sweep its own temp dir.
try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir, OS sweeps it */ }
console.log(`\nchatjobs_unit_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
