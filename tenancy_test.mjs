/*
 * Tenancy self-test — run: node tenancy_test.mjs
 * Proves identity resolution + role rules + the sponsored monthly ceiling (SOW items 1-2, wargame #1).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUsersStore, userIdFor, HEADER } from "./tenancy.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };
const dir = mkdtempSync(join(tmpdir(), "tenancy-"));
const users = createUsersStore({ dir, ownerEmail: "fredwolfe@gmail.com" });
const reqWith = (email) => ({ headers: email ? { [HEADER]: email } : {} });

t("userIdFor is stable + case/space-insensitive + 16 hex", () => {
  assert.equal(userIdFor("A@B.com "), userIdFor("a@b.com"));
  assert.match(userIdFor("a@b.com"), /^[0-9a-f]{16}$/);
});
t("no header => anonymous, no tenant", () => {
  const id = users.identify(reqWith(""));
  assert.equal(id.role, "anon"); assert.equal(id.uid, ""); assert.equal(id.isOwner, false);
});
t("owner email always resolves to owner role", () => {
  const id = users.identify(reqWith("FredWolfe@gmail.com"));
  assert.equal(id.role, "owner"); assert.equal(id.isOwner, true);
});
t("a new email autocreates as credit tier, active", () => {
  const id = users.identify(reqWith("friend@x.com"));
  assert.equal(id.role, "credit"); assert.equal(id.status, "active"); assert.equal(id.isOwner, false);
  assert.equal(id.uid, userIdFor("friend@x.com"));
});
t("owner cannot be demoted (forced back to owner on identify)", () => {
  users.setRole("fredwolfe@gmail.com", "credit");
  assert.equal(users.identify(reqWith("fredwolfe@gmail.com")).role, "owner");
});
t("coupon path: setRole sponsored sticks", () => {
  users.setRole("friend@x.com", "sponsored");
  assert.equal(users.identify(reqWith("friend@x.com")).role, "sponsored");
});
t("consent is one-time and recorded", () => {
  assert.equal(users.identify(reqWith("friend@x.com")).consented, false);
  users.markConsented("friend@x.com");
  assert.equal(users.identify(reqWith("friend@x.com")).consented, true);
});
t("sponsored $20 monthly ceiling pauses the account when crossed", () => {
  users.setSponsoredCap("friend@x.com", 20);
  let r = users.addSponsoredSpend("friend@x.com", 15, "2026-07");
  assert.equal(r.over, false); assert.equal(users.get("friend@x.com").status, "active");
  r = users.addSponsoredSpend("friend@x.com", 6, "2026-07");   // 15+6=21 > 20
  assert.equal(r.over, true); assert.equal(users.get("friend@x.com").status, "paused");
});
t("cap spend resets on a new month", () => {
  users.resetSponsoredSpend("friend@x.com");
  const r = users.addSponsoredSpend("friend@x.com", 5, "2026-08");
  assert.equal(r.spent, 5); assert.equal(r.over, false);
});
t("owner reset clears a paused sponsored account", () => {
  users.setStatus("friend@x.com", "active");
  assert.equal(users.get("friend@x.com").status, "active");
});
t("list returns all users", () => { assert.ok(users.list().length >= 2); });

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\ntenancy_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
