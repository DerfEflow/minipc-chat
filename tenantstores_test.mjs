/*
 * Per-user isolation + tool-wall self-test — run: node tenantstores_test.mjs
 * Proves SOW success criteria: two users are walled off, and a non-owner's toolset excludes Fred's
 * machines, command deck, and persona-write. (wargame #3)
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUsersStore, HEADER } from "./tenancy.mjs";
import { createTenantResolver, SAFE_TOOLS, filterToolDefs, toolAllowedFor } from "./tenantstores.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };
const dir = mkdtempSync(join(tmpdir(), "tstores-"));
const users = createUsersStore({ dir, ownerEmail: "fredwolfe@gmail.com" });

// fake owner globals
const globals = { memory: { tag: "owner-mem" }, chatlog: { tag: "owner-log" }, artifacts: { tag: "owner-art" },
  flywheel: { tag: "owner-fly" }, sandboxDir: "OWNER_SANDBOX", persona: { tag: "shared-persona" },
  ctx: { serpKey: "k", lightChat: () => {}, exportGated: () => {} } };
const resolver = createTenantResolver({ baseDir: dir, embed: null, globals, users });
const reqWith = (email) => ({ headers: email ? { [HEADER]: email } : {} });

t("owner short-circuits to the EXACT global stores (path unchanged)", () => {
  const T = resolver.resolve(reqWith("fredwolfe@gmail.com"));
  assert.equal(T.role, "owner");
  assert.equal(T.memory, globals.memory); assert.equal(T.chatlog, globals.chatlog);
  assert.equal(T.artifacts, globals.artifacts); assert.equal(T.sandboxDir, "OWNER_SANDBOX");
  assert.equal(T.ctxBase, globals.ctx);
});

t("two different users get DIFFERENT, real store instances", () => {
  const A = resolver.resolve(reqWith("alice@x.com"));
  const B = resolver.resolve(reqWith("bob@x.com"));
  assert.notEqual(A.uid, B.uid);
  assert.notEqual(A.memory, B.memory); assert.notEqual(A.chatlog, B.chatlog); assert.notEqual(A.artifacts, B.artifacts);
  assert.notEqual(A.sandboxDir, B.sandboxDir);
  assert.notEqual(A.memory, globals.memory);   // and neither is the owner's
});

t("a user's own store is stable across requests (cache)", () => {
  const A1 = resolver.resolve(reqWith("alice@x.com"));
  const A2 = resolver.resolve(reqWith("alice@x.com"));
  assert.equal(A1.memory, A2.memory);
});

t("isolation is real: writing to A's memory does not appear in B's", () => {
  const A = resolver.resolve(reqWith("alice@x.com"));
  const B = resolver.resolve(reqWith("bob@x.com"));
  A.memory.propose({ content: "alice-secret", type: "profile", source: { kind: "user_explicit" } });
  const aHits = A.memory.list({}).map((m) => m.content);
  const bHits = B.memory.list({}).map((m) => m.content);
  assert.ok(aHits.includes("alice-secret"));
  assert.ok(!bHits.includes("alice-secret"), "B must not see A's memory");
});

t("all users share the SAME persona corpus (read-only), including the owner", () => {
  const A = resolver.resolve(reqWith("alice@x.com"));
  const O = resolver.resolve(reqWith("fredwolfe@gmail.com"));
  assert.equal(A.persona, globals.persona); assert.equal(O.persona, globals.persona);
});

t("tool wall: a non-owner CANNOT reach Fred's machines / deck / persona-write", () => {
  for (const blocked of ["forge_send", "forge_read", "deck_add_note", "deck_create_project", "add_to_persona", "scrape_to_persona"]) {
    assert.equal(toolAllowedFor("credit", blocked), false, blocked + " must be blocked for non-owner");
    assert.equal(SAFE_TOOLS.has(blocked), false);
  }
});

t("tool wall: a non-owner CAN use the safe tools", () => {
  for (const ok of ["web_search", "create_artifact", "remember", "search_persona", "sandbox_write", "run_python_sandbox"]) {
    assert.equal(toolAllowedFor("credit", ok), true);
  }
});

t("owner is unrestricted (every tool allowed)", () => {
  for (const any of ["forge_send", "deck_add_note", "add_to_persona", "web_search"]) assert.equal(toolAllowedFor("owner", any), true);
});

t("filterToolDefs strips machine/deck/persona-write tools for non-owner, keeps them for owner", () => {
  const defs = [{ function: { name: "forge_send" } }, { function: { name: "web_search" } }, { function: { name: "add_to_persona" } }, { function: { name: "create_artifact" } }];
  const nonOwner = filterToolDefs(defs, "credit").map((d) => d.function.name);
  assert.deepEqual(nonOwner.sort(), ["create_artifact", "web_search"]);
  assert.equal(filterToolDefs(defs, "owner").length, 4);
});

t("anonymous (no login) gets no stores at all", () => {
  const T = resolver.resolve(reqWith(""));
  assert.equal(T.role, "anon"); assert.equal(T.ctxBase, null); assert.equal(T.memory, undefined);
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\ntenantstores_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
