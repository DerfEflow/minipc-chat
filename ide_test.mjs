/*
 * Dominion Works (IDE mode) self-test — run with: node ide_test.mjs
 * Phase 0 scope: the exposure gate only (pure function, no server needed).
 * Proves:
 *   1. the default is owner-only, so shipping every later phase to the LIVE container keeps the
 *      unfinished build surface invisible to guests (Fred's ruling 2026-07-19)
 *   2. "all"/"1" opens it to signed-in users but NEVER to anon
 *   3. "off"/"0" closes it to everyone including the owner
 *   4. an unreadable/garbage value FAILS CLOSED to owner-only — a typo in a Railway env var must
 *      never widen exposure
 */
import assert from "node:assert/strict";
import { createIdeGate, IDE_MODE_DEFAULT } from "./ide.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}

const owner = { role: "owner", isOwner: true, email: "fredwolfe@gmail.com" };
const credit = { role: "credit", isOwner: false, email: "guest@example.com" };
const sponsored = { role: "sponsored", isOwner: false, email: "kid@example.com" };
const anon = { role: "anon" };

await t("default is owner-only: guests stay dark through every pre-Phase-8 deploy", () => {
  const g = createIdeGate(IDE_MODE_DEFAULT);
  assert.equal(g.allowed(owner), true);
  assert.equal(g.allowed(credit), false);
  assert.equal(g.allowed(sponsored), false);
  assert.equal(g.allowed(anon), false);
});

await t("undefined/null env falls back to the owner-only default", () => {
  assert.equal(createIdeGate(undefined).allowed(owner), true);
  assert.equal(createIdeGate(undefined).allowed(credit), false);
  assert.equal(createIdeGate(null).allowed(credit), false);
});

await t('"all" and "1" open the surface to signed-in users, never to anon', () => {
  for (const v of ["all", "1"]) {
    const g = createIdeGate(v);
    assert.equal(g.allowed(owner), true, v + " owner");
    assert.equal(g.allowed(credit), true, v + " credit");
    assert.equal(g.allowed(sponsored), true, v + " sponsored");
    assert.equal(g.allowed(anon), false, v + " anon must stay out");
  }
});

await t('"off" and "0" close the surface to EVERYONE including the owner', () => {
  for (const v of ["off", "0"]) {
    const g = createIdeGate(v);
    assert.equal(g.allowed(owner), false, v + " owner");
    assert.equal(g.allowed(credit), false, v + " credit");
    assert.equal(g.allowed(anon), false, v + " anon");
  }
});

await t("garbage values FAIL CLOSED to owner-only (a typo must never widen exposure)", () => {
  for (const v of ["yes", "true", "ON", "everyone", "", "   ", "owner-ish", "2", "-1"]) {
    const g = createIdeGate(v);
    assert.equal(g.allowed(credit), false, JSON.stringify(v) + " must not admit a guest");
    assert.equal(g.allowed(anon), false, JSON.stringify(v) + " must not admit anon");
  }
});

await t("values are case- and whitespace-insensitive", () => {
  assert.equal(createIdeGate("  ALL  ").allowed(credit), true);
  assert.equal(createIdeGate(" Off ").allowed(owner), false);
  assert.equal(createIdeGate("OWNER").allowed(owner), true);
  assert.equal(createIdeGate("OWNER").allowed(credit), false);
});

await t("a missing/!isOwner tenant object is never admitted by accident", () => {
  const g = createIdeGate("owner");
  assert.equal(g.allowed(null), false);
  assert.equal(g.allowed(undefined), false);
  assert.equal(g.allowed({}), false);
  // isOwner must be strictly true, not merely truthy-by-coercion
  assert.equal(g.allowed({ role: "credit", isOwner: "yes" }), false);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
