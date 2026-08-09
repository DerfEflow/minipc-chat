/*
 * The local engine is not a seat anyone can be offered, and not a route the world can reach.
 *
 * Fred, 2026-08-09: "The local model is DEAD! No more local model! The only things we can use the
 * local model for is internal routing or local jobs that will be helpful."
 *
 * Local Qwen left the picker on 2026-07-30, but six user-facing error strings went on recommending
 * it for another ten days - including to guests, who cannot reach it at all. An error message that
 * tells someone to fall back to a model they are not allowed to select is worse than no advice.
 *
 * What this file protects, in order of importance:
 *   1. No guest can be routed to the local engine. This is the structural one. The non-owner branch
 *      redirects to the tenant cloud default with NO explicitLocal exemption, and if an exemption is
 *      ever added there, the local engine is serving customers again.
 *   2. No user-facing copy offers it as a fallback.
 * What it deliberately does NOT forbid: ollamaChat for internal routing, classification, map-reduce
 * digests and judges, and model:"local" as the test harness lane that exercises the job and persist
 * machinery without paying for cloud calls. Those are the uses Fred kept.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODELS as CATALOG } from "./models.catalog.mjs";

const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
let passed = 0;
const t = (name, fn) => { fn(); console.log("  ok  " + name); passed++; };

// Comment lines are history and may name it freely; only live code is under test.
const codeLines = server.split("\n").filter((l) => {
  const s = l.trim();
  return s && !s.startsWith("//") && !s.startsWith("*") && !s.startsWith("/*");
});

t("no guest can be routed to the local engine", () => {
  // The non-owner redirect must stay unconditional. `!T.isOwner && !cloudModel` with no local
  // exemption is what keeps a guest sending model:"local" on the tenant cloud default instead.
  assert.match(server, /if \(!T\.isOwner && !cloudModel\) \{/,
    "the non-owner cloud-default redirect is missing or its condition changed");
  const guard = server.slice(server.indexOf("if (!T.isOwner && !cloudModel) {"));
  const block = guard.slice(0, guard.indexOf("\n  }") + 4);
  assert.ok(!/explicitLocal/.test(block),
    "the non-owner redirect must NOT exempt explicit local — that would serve guests the local engine");
  assert.match(block, /cloudModel = defaultModelFor\(false\)/,
    "non-owners must land on the tenant cloud default");
});

t("no user-facing string offers Local Qwen as a fallback", () => {
  const offenders = codeLines.filter((l) => /Local Qwen/.test(l));
  assert.deepEqual(offenders, [],
    "live code still names Local Qwen to the user:\n" + offenders.join("\n"));
});

t("no error copy recommends falling back to the local engine", () => {
  // The shape the old copy took, in all its variants, so a reworded version is caught too.
  const recommends = codeLines.filter((l) => /(use|switch (back )?to|try) .{0,12}local/i.test(l)
    && /error|message:/i.test(l));
  assert.deepEqual(recommends, [],
    "error copy still points at the local engine:\n" + recommends.join("\n"));
});

t("the local engine is not in the catalog, so it cannot appear in the picker", () => {
  const local = CATALOG.find((m) => /^local$/i.test(m.id) || /qwen3:/.test(m.id || ""));
  assert.equal(local, undefined, "an Ollama-style local id is in the catalog: " + (local && local.id));
});

console.log(`\nlocalengine: ${passed} passed, 0 failed`);
