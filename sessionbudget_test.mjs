/*
 * Session-budget money tests — run with: node --test sessionbudget_test.mjs
 * HIGH blast radius module, so every rule Fred specified is pinned by name, including his exact
 * 750-balance / 500-earmarked / 250-available scenario, verbatim.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSessionBudgets, GUEST_DEFAULT_CREDITS, OWNER_DEFAULT_USD } from "./sessionbudget.mjs";

const dir = mkdtempSync(join(tmpdir(), "dominion-sb-test-"));
const sb = createSessionBudgets({ dir });
const G = "guest@example.com";

test("guest default is 1000 credits; owner default is $5", () => {
  const g = sb.ensure(G, "chat-a", { balance: 5000 });
  assert.equal(g.budget, GUEST_DEFAULT_CREDITS);
  assert.equal(g.unit, "credits");
  const o = sb.ensure("fred@owner", "chat-o", { isOwner: true });
  assert.equal(o.budget, OWNER_DEFAULT_USD);
  assert.equal(o.unit, "usd");
});

test("FRED'S SCENARIO: 750 balance, session 1 running with 500 earmarked -> new session sees 250", () => {
  const E = "fred750@example.com";
  sb.ensure(E, "s1", { balance: 750, title: "Project X" });
  sb.setBudget(E, "s1", 500, { balance: 750 });
  sb.setRunning(E, "s1", true);                         // hit send — working in the background
  // New session: the 1000 default can't fit; it clamps to 250 and reports the shortfall.
  const s2 = sb.ensure(E, "s2", { balance: 750 });
  assert.equal(s2.budget, 250, "default clamps to available");
  assert.ok(s2.shortfall, "shortfall raised for the popup");
  assert.equal(s2.shortfall.avail, 250);
  assert.equal(s2.shortfall.balance, 750);
  // User tries to set 500 on session 2 -> refused with the full transparent detail.
  const r = sb.setBudget(E, "s2", 500, { balance: 750 });
  assert.equal(r.error, "over_available");
  assert.equal(r.maxAllowable, 250);
  assert.equal(r.avail, 250);
  assert.equal(r.balance, 750);
  assert.equal(r.holders.length, 1);
  assert.equal(r.holders[0].title, "Project X");
  assert.equal(r.holders[0].hold, 500);
  // The message names the holder and carries all three numbers — never "not enough credits".
  assert.match(r.message, /"Project X" has 500 credits earmarked and still running/);
  assert.match(r.message, /750 credits total/);
  assert.match(r.message, /250 credits available/);
  assert.match(r.message, /250 credits or less/);
});

test("reducing a running session's budget releases credits immediately", () => {
  const E = "reduce@example.com";
  sb.ensure(E, "r1", { balance: 1000 });                // takes the full 1000 default
  sb.setRunning(E, "r1", true);
  assert.equal(sb.available(E, 1000, "other"), 0, "everything earmarked");
  const r = sb.setBudget(E, "r1", 400, { balance: 1000 });
  assert.equal(r.ok, true);
  assert.equal(sb.available(E, 1000, "other"), 600, "reduction released 600 instantly");
});

test("budget floor is what was already spent — spent money can never be released", () => {
  const E = "floor@example.com";
  sb.ensure(E, "f1", { balance: 2000 });
  sb.recordSpend(E, "f1", 300);
  const r = sb.setBudget(E, "f1", 100, { balance: 2000 });   // tries to go below spent
  assert.equal(r.ok, true);
  assert.equal(r.budget, 300, "clamped up to spent");
});

test("as a running session spends, its hold shrinks by exactly what it spent", () => {
  const E = "shrink@example.com";
  sb.ensure(E, "h1", { balance: 1000 });
  sb.setRunning(E, "h1", true);
  sb.recordSpend(E, "h1", 250);
  assert.equal(sb.available(E, 1000, "other"), 250, "hold is budget-spent (750), not the full budget");
});

test("recordSpend flags over=true at the cap — the server's pause cue", () => {
  const E = "cap@example.com";
  sb.ensure(E, "c1", { balance: 5000 });
  sb.setBudget(E, "c1", 100, { balance: 5000 });
  const a = sb.recordSpend(E, "c1", 60);
  assert.equal(a.over, false);
  const b = sb.recordSpend(E, "c1", 60);
  assert.equal(b.over, true);
  assert.equal(b.remaining, 0);
});

test("idle sessions hold nothing; only running sessions earmark", () => {
  const E = "idle@example.com";
  sb.ensure(E, "i1", { balance: 1000 });
  assert.equal(sb.available(E, 1000, "other"), 1000, "not running -> no hold");
  sb.setRunning(E, "i1", true);
  assert.equal(sb.available(E, 1000, "other"), 0);
  sb.setRunning(E, "i1", false);
  assert.equal(sb.available(E, 1000, "other"), 1000, "turn ended -> hold released");
});

test("owner budgets never clamp and never earmark a pool", () => {
  const o = sb.ensure("fred@owner2", "big", { isOwner: true });
  assert.equal(o.shortfall, null);
  const r = sb.setBudget("fred@owner2", "big", 250, {});     // any size, no pool check
  assert.equal(r.ok, true);
  assert.equal(r.budget, 250);
});

test("image generation draws from available only and sees the holders", () => {
  const E = "img@example.com";
  sb.ensure(E, "chatty", { balance: 800, title: "Logo brainstorm" });
  sb.setBudget(E, "chatty", 600, { balance: 800 });
  sb.setRunning(E, "chatty", true);
  const a = sb.imageAllowance(E, 800);
  assert.equal(a.available, 200);
  assert.equal(a.holders[0].title, "Logo brainstorm");
});

test("no-holder shortfall message blames the balance, never a phantom session", () => {
  const msg = sb.buildOverBudgetMessage({ requested: 1000, balance: 0, avail: 0, holders: [], unit: "credits" });
  assert.doesNotMatch(msg, /running session/i, "no phantom earmark blame");
  assert.match(msg, /Your account holds 0 credits/);
  assert.match(msg, /Add more credits/);
  const msg2 = sb.buildOverBudgetMessage({ requested: 1000, balance: 300, avail: 300, holders: [], unit: "credits" });
  assert.match(msg2, /up to 300 credits/);
  assert.match(msg2, /300 credits or less/);
});

test("boot sweep clears ghost holds from a crash", () => {
  const E = "crash@example.com";
  sb.ensure(E, "dead", { balance: 1000 });
  sb.setRunning(E, "dead", true);
  sb.sweepRunning();
  assert.equal(sb.available(E, 1000, "other"), 1000, "no ghost earmark after boot");
});

test("tenant wall: one guest's holds never touch another's availability", () => {
  sb.ensure("alice@example.com", "a1", { balance: 1000 });
  sb.setRunning("alice@example.com", "a1", true);
  assert.equal(sb.available("bob@example.com", 1000, ""), 1000);
});

test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
