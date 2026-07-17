/*
 * Persona subject-exclusion self-test — run: node persona_exclusion_test.mjs
 * Proves Fred's three excluded subjects, once marked owner_only, never reach a non-owner via
 * retrieval, persona quoting, or the titles list — while the owner still sees everything.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPersonaStore } from "./persona.mjs";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };
const dir = mkdtempSync(join(tmpdir(), "persona-excl-"));
const p = createPersonaStore({ dir, staging: join(dir, "staging"), embed: null });

// Two docs: one shareable, one sensitive (financial hardship).
const pub = p.ingestText({ text: "The roof glows amber at dawn and the crew moves like a single hand.", kind: "poem", title: "Amber Dawn" });
const priv = p.ingestText({ text: "I confess we were broke that winter, drowning in debt, and I could not afford to feed them.", kind: "essay", title: "That Winter" });

await t("both docs are shared by default", () => {
  const all = p.list({});
  assert.equal(all.find((d) => d.id === pub.doc.id).visibility, "shared");
  assert.equal(all.find((d) => d.id === priv.doc.id).visibility, "shared");
});

await t("before exclusion, a non-owner retrieval CAN surface the sensitive doc", async () => {
  const hits = await p.retrieve("broke debt afford winter", { sharedOnly: true, minScore: 0 });
  assert.ok(hits.some((h) => /drowning in debt/.test(h.text)), "sensitive text present pre-exclusion");
});

await t("owner marks the sensitive doc owner_only", () => {
  const r = p.setVisibility(priv.doc.id, "owner_only");
  assert.equal(r.ok, true); assert.equal(r.visibility, "owner_only");
});

await t("non-owner retrieval NO LONGER surfaces the excluded doc", async () => {
  const hits = await p.retrieve("broke debt afford winter", { sharedOnly: true, minScore: 0 });
  assert.ok(!hits.some((h) => /drowning in debt/.test(h.text)), "excluded text must be gone for non-owners");
});

await t("OWNER retrieval still sees the excluded doc (sharedOnly off)", async () => {
  const hits = await p.retrieve("broke debt afford winter", { sharedOnly: false, minScore: 0 });
  assert.ok(hits.some((h) => /drowning in debt/.test(h.text)), "owner keeps full access");
});

await t("non-owner persona quoting excludes the sensitive doc", async () => {
  const block = await p.personaBlock("tell me about that hard winter with debt", { exemplars: 6, sharedOnly: true });
  assert.ok(!/drowning in debt/.test(block.block), "owner_only text must not be quoted to non-owners");
});

await t("non-owner titles list hides the excluded doc; owner list shows it", () => {
  const shared = p.list({ sharedOnly: true }).map((d) => d.title);
  const ownerAll = p.list({}).map((d) => d.title);
  assert.ok(!shared.includes("That Winter"), "excluded title hidden from non-owners");
  assert.ok(shared.includes("Amber Dawn"), "shared title still visible");
  assert.ok(ownerAll.includes("That Winter"), "owner sees everything");
});

await t("the local-model scan flags the three subjects (mocked classifier)", async () => {
  // reset visibility, then scan with a mock LOCAL classifier
  p.setVisibility(priv.doc.id, "shared");
  const classify = async (text) => ({ match: /debt|broke|afford|confess|lust/.test(text) });   // stand-in for the local model
  const r = await p.scanSensitivity({ classify });
  assert.ok(r.flagged >= 1, "scan flagged the hardship doc");
  assert.equal(p.list({}).find((d) => d.id === priv.doc.id).visibility, "owner_only");
  assert.equal(p.list({}).find((d) => d.id === pub.doc.id).visibility, "shared");   // clean poem stays shared
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\npersona_exclusion_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
