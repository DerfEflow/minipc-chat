import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./public/dominion-ide.js", import.meta.url), "utf8");
const lensSrc = readFileSync(new URL("./public/dominion-lenses.js", import.meta.url), "utf8");

assert.match(src, /function forgeExecutionFields\(\)/,
  "Crucible should capture Forge controls at an execution request boundary");
assert.match(src, /return \{ wolfeTier: tier, forgeTier: tier, forgeMode: mode \}/,
  "the compatibility payload should carry explicit tier and mode values");

const payloadUses = src.match(/\.\.\.forgeExecutionFields\(\)/g) || [];
assert.equal(payloadUses.length, 2,
  "new builds and resumed waiting builds should both carry the Forge execution contract");
assert.match(src, /fetch\("\/ide\/job"[\s\S]*?\.\.\.forgeExecutionFields\(\)/,
  "a new Crucible build should carry Forge state");
assert.match(src, /fetch\("\/ide\/job\/answer"[\s\S]*?\.\.\.forgeExecutionFields\(\)/,
  "continuing a waiting Crucible build should carry Forge state");

for (const state of ["complete", "checkpointed", "paused", "failed", "stopped"]) {
  assert.match(src, new RegExp("\\b" + state + "\\b"),
    "Crucible should distinguish the " + state + " UI state");
}
assert.match(src, /dominion-build-checkpointed/);
assert.match(src, /dominion-build-paused/);

assert.match(lensSrc, /case "done": case "checkpoint": case "error": case "stopped"/,
  "the journal digest should preserve checkpoint as its own terminal outcome");
assert.match(lensSrc, /ev\.type === "done" \|\| ev\.type === "checkpoint"/,
  "EventSource should recognize checkpoint as terminal");
assert.match(lensSrc, /if \(terminal\) \{[\s\S]*?closed = true;[\s\S]*?es\.close\(\);/,
  "terminal events should close EventSource explicitly");
assert.match(lensSrc, /dominion-build-checkpointed/,
  "a live checkpoint should have a checkpoint-specific lifecycle event");
assert.match(lensSrc, /dominion-build-ended/,
  "a live checkpoint should also use the non-success ended lifecycle");
assert.match(lensSrc, /outcome: "checkpoint", complete: false/,
  "a checkpoint event should be explicitly marked incomplete");
assert.match(lensSrc, /if \(d\.outcome !== "done"/,
  "checkpointed builds must not earn the completion-only publish flow");
assert.match(lensSrc, /Checkpoint saved\. This build is not complete/,
  "checkpoint wording must not imply successful completion");

console.log("crucible forge client regression: ok");
