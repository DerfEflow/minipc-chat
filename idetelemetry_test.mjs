/*
 * build telemetry self-test - run: node idetelemetry_test.mjs
 * Prior throughput by tier, part-size estimate, the measured-beats-prior crossover at 3 samples,
 * agent parallelism (more agents = less wall-time, same total tokens, more overhead), and the
 * whole-plan roll-up summing sequential parts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTelemetry, priorThroughput, estimatePartTokens } from "./idetelemetry.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.stack || e)); } };
const tmp = () => mkdtempSync(join(tmpdir(), "tel-"));

const FRONTIER = { id: "openai/gpt-5.6-sol", outCost: 30 };
const TINY = { id: "qwen/qwen3-tiny", outCost: 0.2 };

t("prior throughput falls as the model gets cheaper/faster", () => {
  assert.ok(priorThroughput(FRONTIER) < priorThroughput(TINY));
  assert.ok(priorThroughput({ outCost: 5 }) > priorThroughput(FRONTIER));
});

t("part token estimate scales with files and floors for a one-file part", () => {
  assert.ok(estimatePartTokens({ files: ["a"] }) >= 600);
  assert.ok(estimatePartTokens({ files: ["a", "b", "c"] }) > estimatePartTokens({ files: ["a"] }));
});

t("a fresh model estimates from the PRIOR and says so", () => {
  const tel = createTelemetry({ dir: tmp() });
  const e = tel.estimatePart({ files: ["a", "b"], contract: "x" }, FRONTIER, 1);
  assert.equal(e.basis, "prior");
  assert.ok(e.seconds > 0 && e.tokens > 0 && e.usd > 0);
});

t("after 3 real samples the basis flips to measured and tracks them", () => {
  const dir = tmp();
  const tel = createTelemetry({ dir });
  // Feed FAST samples: 500 tok in 1s = 500 tok/s, far above the frontier prior of 22.
  for (let i = 0; i < 3; i++) tel.record({ model: FRONTIER.id, outTokens: 500, ms: 1000, costUsd: 0.01 });
  const e = tel.estimatePart({ files: ["a"], contract: "" }, FRONTIER, 1);
  assert.equal(e.basis, "measured");
  // Measured 500 tok/s makes ~600 tokens take ~1-2s + ramp, far faster than the prior would.
  const prior = createTelemetry({ dir: tmp() }).estimatePart({ files: ["a"], contract: "" }, FRONTIER, 1);
  assert.ok(e.seconds < prior.seconds, "measured fast model beats the slow prior");
});

t("more agents cut wall-time but not total tokens, and add overhead", () => {
  const tel = createTelemetry({ dir: tmp() });
  const part = { files: ["a", "b", "c", "d"], contract: "y" };
  const one = tel.estimatePart(part, FRONTIER, 1);
  const four = tel.estimatePart(part, FRONTIER, 4);
  assert.ok(four.seconds < one.seconds, "four agents finish sooner");
  assert.equal(four.tokens, one.tokens, "same total work");
  assert.equal(four.agents, 4);
});

t("agents beyond the file count do not help (no fractional-file agents)", () => {
  const tel = createTelemetry({ dir: tmp() });
  const part = { files: ["only-one.js"], contract: "" };
  const e = tel.estimatePart(part, FRONTIER, 8);
  assert.equal(e.agents, 1, "one file cannot use eight agents");
});

t("plan roll-up sums sequential parts and reports prior if any part is prior", () => {
  const tel = createTelemetry({ dir: tmp() });
  const parts = [{ files: ["a"], contract: "" }, { files: ["b", "c"], contract: "" }];
  const roll = tel.estimatePlan(parts, () => ({ rec: FRONTIER, agents: 1 }));
  const p0 = tel.estimatePart(parts[0], FRONTIER, 1);
  const p1 = tel.estimatePart(parts[1], FRONTIER, 1);
  assert.equal(roll.seconds, p0.seconds + p1.seconds);
  assert.equal(roll.basis, "prior");
});

t("telemetry survives a reload from disk", () => {
  const dir = tmp();
  const a = createTelemetry({ dir });
  for (let i = 0; i < 3; i++) a.record({ model: FRONTIER.id, outTokens: 400, ms: 1000, costUsd: 0.01 });
  const b = createTelemetry({ dir });
  assert.ok(b.samples(FRONTIER.id) >= 3, "reloaded the samples");
  assert.equal(b.estimatePart({ files: ["a"], contract: "" }, FRONTIER, 1).basis, "measured");
});

console.log("\nidetelemetry: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
