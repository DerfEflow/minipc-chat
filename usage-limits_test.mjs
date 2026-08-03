/*
 * usage-limits self-test - run: node usage-limits_test.mjs
 *
 * Covers the wargamed defenses from the Lane D mission:
 *   D2 (instrumentation must answer the narrowing question): finish_reason, usedTokens,
 *       budgetTokens, and hitCeiling are mandatory on every written record.
 *   D3 (no PII): message/answer text never reaches a written record, including through the three
 *       fields that legitimately ARE strings (model, mode, finish_reason).
 * Plus: ceiling-hit classification per finish-reason spelling, the empty-output (starvation)
 * signature, disk persistence/reload, torn-write recovery, rotation, and the summary rollup Fred
 * reads after several hundred turns.
 *
 * The adversarial cases (marked ATTACK) each reproduce a defect found in the first cut of the
 * module during the 2026-08-03 review. They are written to FAIL if the fix is ever reverted, not to
 * restate what the code does.
 *
 * Disk-reading tests construct the store with `sync: true`. Production writes are batched and
 * asynchronous so no model round pays for a disk syscall inline; a test that reads the file
 * immediately would otherwise be racing the writer. One test below exercises the async path
 * explicitly via flush().
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUsageLimits, isCeilingFinish } from "./usage-limits.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.stack || e)); } };
const ta = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.stack || e)); } };
const tmp = () => mkdtempSync(join(tmpdir(), "ulim-"));
const lines = (dir) => readFileSync(join(dir, "usage-limits.jsonl"), "utf8").trim().split("\n").filter(Boolean);

t("finish-reason classifier recognizes every provider spelling of a ceiling hit", () => {
  assert.equal(isCeilingFinish("length"), true);
  assert.equal(isCeilingFinish("LENGTH"), true);
  assert.equal(isCeilingFinish("max_output_tokens"), true);
  assert.equal(isCeilingFinish("token_limit"), true);
  assert.equal(isCeilingFinish("incomplete"), true);
  assert.equal(isCeilingFinish("stop"), false);
  assert.equal(isCeilingFinish("tool_calls"), false);
  assert.equal(isCeilingFinish(""), false);
  assert.equal(isCeilingFinish(undefined), false);
});

t("ATTACK: Anthropic's native 'max_tokens' and every spacing variant count as a ceiling hit", () => {
  // anthropicmessages.mjs maps max_tokens -> length on its own lane, but the raw spelling reaches
  // this module from any lane that passes a provider string through. Missing it would silently
  // undercount truncation on Claude models and tell Fred a binding ceiling was comfortable.
  assert.equal(isCeilingFinish("max_tokens"), true, "Anthropic's stop_reason for a ceiling hit");
  assert.equal(isCeilingFinish("MAX TOKENS"), true, "spaced variant");
  assert.equal(isCeilingFinish("max-tokens"), true, "hyphenated variant");
  assert.equal(isCeilingFinish("  Max_Output_Tokens  "), true, "padded and mixed case");
});

t("ATTACK: an input-context overflow is NOT counted as an output-ceiling hit", () => {
  // context_length_exceeded means the PROMPT did not fit. Counting it as ceiling evidence would
  // tell Fred to raise an output cap that was never the constraint.
  assert.equal(isCeilingFinish("context_length_exceeded"), false);
  assert.equal(isCeilingFinish("context_length"), false);
});

t("D2: a written record carries finish_reason, usedTokens, budgetTokens, and hitCeiling", () => {
  const dir = tmp();
  const ul = createUsageLimits({ dir, sync: true });
  const e = ul.record({ model: "deepseek/deepseek-v4-pro", mode: "normal", ceiling: 1024, usedTokens: 1024, finishReason: "length" });
  assert.ok(e, "record() must return the written entry");
  for (const key of ["finish_reason", "usedTokens", "budgetTokens", "hitCeiling"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(e, key), key + " must be present");
  }
  assert.equal(typeof e.hitCeiling, "boolean", "hitCeiling must be an explicit boolean, never truthy junk");
  assert.equal(e.finish_reason, "length");
  assert.equal(e.usedTokens, 1024);
  assert.equal(e.budgetTokens, 1024);
  assert.equal(e.hitCeiling, true);

  // Same four fields must also survive to the ON-DISK line, not just the in-memory return value.
  const onDisk = lines(dir).map((l) => JSON.parse(l));
  assert.equal(onDisk.length, 1);
  for (const key of ["finish_reason", "usedTokens", "budgetTokens", "hitCeiling"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(onDisk[0], key), "on-disk record missing " + key);
  }
});

t("D2: the four mandatory fields survive every degenerate input a provider can produce", () => {
  const dir = tmp();
  const ul = createUsageLimits({ dir, sync: true });
  const inputs = [
    { model: "m", ceiling: 0, usedTokens: 0, finishReason: "" },
    { model: "m", ceiling: null, usedTokens: null, finishReason: null },
    { model: "m", ceiling: NaN, usedTokens: NaN, finishReason: undefined },
    { model: "m", ceiling: -5, usedTokens: -9, finishReason: "STOP" },
    { model: "m", ceiling: "2048", usedTokens: "600", finishReason: "tool_calls" },
    { model: "m", ceiling: 1e12, usedTokens: 1e12, finishReason: "length" },
    { model: "m" },
  ];
  for (const input of inputs) {
    const e = ul.record(input);
    assert.ok(e, "record must not drop an identified round: " + JSON.stringify(input));
    for (const key of ["finish_reason", "usedTokens", "budgetTokens", "hitCeiling"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(e, key), key + " missing for " + JSON.stringify(input));
    }
    assert.equal(typeof e.finish_reason, "string");
    assert.equal(typeof e.usedTokens, "number");
    assert.equal(Number.isFinite(e.usedTokens), true, "usedTokens must never be NaN");
    assert.equal(typeof e.budgetTokens, "number");
    assert.equal(Number.isFinite(e.budgetTokens), true, "budgetTokens must never be NaN");
    assert.equal(typeof e.hitCeiling, "boolean");
    assert.ok(e.usedTokens >= 0 && e.budgetTokens >= 0, "no negative token counts");
  }
  const onDisk = lines(dir).map((l) => JSON.parse(l));
  assert.equal(onDisk.length, inputs.length);
  for (const row of onDisk) {
    for (const key of ["finish_reason", "usedTokens", "budgetTokens", "hitCeiling"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, key), "on-disk record missing " + key);
    }
  }
});

t("hitCeiling is true when finish_reason says so, even if usedTokens looks low", () => {
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  const e = ul.record({ model: "m", ceiling: 2048, usedTokens: 3, finishReason: "length" });
  assert.equal(e.hitCeiling, true, "the provider's own word for truncation must win even with odd token counts");
});

t("hitCeiling is true when usedTokens reaches the ceiling even without a 'length' label", () => {
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  const e = ul.record({ model: "m", ceiling: 500, usedTokens: 500, finishReason: "stop" });
  assert.equal(e.hitCeiling, true, "a round that spent every token it was given hit the ceiling regardless of the reported label");
});

t("hitCeiling is false on a clean stop well under the ceiling", () => {
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  const e = ul.record({ model: "m", ceiling: 2048, usedTokens: 40, finishReason: "stop" });
  assert.equal(e.hitCeiling, false);
});

t("ATTACK: a missing usage row is recorded as unmeasured, never as a genuine zero-token round", () => {
  // The generic streaming lane only sets `usage` if a chunk carries one (server.mjs line 998), and
  // include_usage is a request, not a guarantee. Reading a transport gap as "this round was cheap"
  // drags the percentiles down and would recommend a cap far below the truth.
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  const unknown = ul.record({ model: "m", ceiling: 4096, usedTokens: null, finishReason: "stop" });
  const genuineZero = ul.record({ model: "m", ceiling: 4096, usedTokens: 0, finishReason: "stop" });
  assert.equal(unknown.usageKnown, false, "no usage row means unmeasured");
  assert.equal(genuineZero.usageKnown, true, "an explicit 0 is a measurement");
  assert.notEqual(unknown.usageKnown, genuineZero.usageKnown, "the two must not be indistinguishable");
  // And an unmeasured round must never be silently classed as a ceiling hit by the used>=budget arm.
  assert.equal(unknown.hitCeiling, false);
});

t("ATTACK: unmeasured rounds are excluded from the percentiles they would otherwise poison", () => {
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  for (let i = 0; i < 10; i++) ul.record({ model: "m", ceiling: 4096, usedTokens: 2000, finishReason: "stop" });
  for (let i = 0; i < 10; i++) ul.record({ model: "m", ceiling: 4096, usedTokens: null, finishReason: "stop" });
  const s = ul.summary().m;
  assert.equal(s.n, 20, "every round is still counted");
  assert.equal(s.nMeasured, 10, "only the measured half feeds the token distribution");
  assert.equal(s.p50UsedTokens, 2000, "p50 must reflect the measured rounds only");
});

t("ATTACK: a round that did not settle is recorded but excluded from every statistic", () => {
  // The wiring spec records the auto-continuation round. A continuation whose transport FAILED has
  // no usage and no finish reason; counting it as a clean cheap round halves the true hit rate.
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  for (let i = 0; i < 5; i++) ul.record({ model: "m", ceiling: 2048, usedTokens: 2048, finishReason: "length" });
  for (let i = 0; i < 5; i++) ul.record({ model: "m", ceiling: 2048, usedTokens: null, finishReason: "", ok: false });
  const s = ul.summary().m;
  assert.equal(s.n, 10);
  assert.equal(s.nSettled, 5, "failed transports are not settled rounds");
  assert.equal(s.hitCeilingFraction, 1, "all five settled rounds hit the ceiling; the truth is 1.0, not 0.5");
  assert.equal(s.p50UsedTokens, 2048, "p50 must not be dragged to 0 by dead transports");
});

t("ATTACK: a budget-squeezed cap is not counted as evidence the model ceiling is too low", () => {
  // affordableWorkerOutput can offer a round far less than outLimitFor(model, mode). A round that
  // truncated at a budget-shrunk 300 says nothing about whether 32768 is the right model ceiling.
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  const squeezed = ul.record({ model: "m", mode: "normal", ceiling: 300, modelCeiling: 32768, usedTokens: 300, finishReason: "length" });
  assert.equal(squeezed.budgetConstrained, true);
  assert.equal(squeezed.hitCeiling, true, "it did hit the cap it was given, and that stays true");
  assert.equal(squeezed.modelCeiling, 32768, "the model's own ceiling must be on the record");

  for (let i = 0; i < 39; i++) ul.record({ model: "m", mode: "normal", ceiling: 300, modelCeiling: 32768, usedTokens: 300, finishReason: "length" });
  for (let i = 0; i < 40; i++) ul.record({ model: "m", mode: "normal", ceiling: 32768, modelCeiling: 32768, usedTokens: 900, finishReason: "stop" });
  const s = ul.summary().m;
  assert.equal(s.hitCeilingFraction, 0.5, "half of all rounds truncated at the cap they were given");
  assert.equal(s.ceilingEvidenceFraction, 0, "none of that is evidence about the MODEL ceiling");
  assert.equal(s.budgetConstrainedFraction, 0.5);
  assert.equal(s.verdict, "narrow", "with no model-ceiling hits at all, the ceiling can come down");
  assert.equal(s.p50UsedTokens, 900, "budget-squeezed rounds must not enter the token distribution");
});

t("ATTACK: percentiles are split by mode, because the cap itself is per mode", () => {
  // models.catalog.mjs: OUT_MODE_CEIL = { fast: 2048 }. A model used in both modes has two
  // different caps, so one blended p95 answers nothing about either.
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  for (let i = 0; i < 40; i++) ul.record({ model: "m", mode: "fast", ceiling: 2048, modelCeiling: 2048, usedTokens: 2048, finishReason: "length" });
  for (let i = 0; i < 40; i++) ul.record({ model: "m", mode: "normal", ceiling: 32768, modelCeiling: 32768, usedTokens: 900, finishReason: "stop" });
  const s = ul.summary().m;
  assert.ok(s.byMode, "a per-mode breakdown must exist");
  assert.ok(s.byMode.fast && s.byMode.normal, "both modes must appear");
  assert.equal(s.byMode.fast.ceilingEvidenceFraction, 1, "fast mode truncates every round");
  assert.equal(s.byMode.fast.verdict, "raise", "a cap that binds every round must be raised, and no number invented from censored data");
  assert.equal(s.byMode.fast.suggestedCeiling, null, "no cap suggestion from a censored sample");
  assert.equal(s.byMode.normal.ceilingEvidenceFraction, 0);
  assert.equal(s.byMode.normal.verdict, "narrow");
  assert.ok(s.byMode.normal.suggestedCeiling >= 900, "the suggestion must cover the observed p95");
  assert.ok(s.byMode.normal.suggestedCeiling < 32768, "and must actually narrow the ceiling");
});

t("ATTACK: no cap is recommended from too few samples", () => {
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  for (let i = 0; i < 5; i++) ul.record({ model: "m", ceiling: 8192, modelCeiling: 8192, usedTokens: 100, finishReason: "stop" });
  const s = ul.summary().m;
  assert.equal(s.verdict, "insufficient_data");
  assert.equal(s.suggestedCeiling, null, "five samples is a guess wearing a decimal point");
});

t("the starvation signature (emptyOutput) is recorded as an explicit boolean and rolled up", () => {
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  const starved = ul.record({ model: "deepseek/deepseek-r1", mode: "fast", ceiling: 64, modelCeiling: 64, usedTokens: 64, finishReason: "length", emptyOutput: true });
  assert.equal(starved.emptyOutput, true);
  const normal = ul.record({ model: "deepseek/deepseek-r1", mode: "fast", ceiling: 8192, modelCeiling: 8192, usedTokens: 300, finishReason: "stop", emptyOutput: false });
  assert.equal(normal.emptyOutput, false);
  const s = ul.summary()["deepseek/deepseek-r1"];
  assert.equal(s.emptyOutputFraction, 0.5);
  assert.equal(s.starvedFraction, 0.5, "empty output AND a ceiling hit together is the starvation signature");
});

t("reasoningFloor rides along when the caller supplies one, and is null when it does not", () => {
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  const withFloor = ul.record({ model: "deepseek/deepseek-r1", ceiling: 8192, usedTokens: 500, finishReason: "stop", reasoningFloor: 8192 });
  assert.equal(withFloor.reasoningFloor, 8192);
  const withoutFloor = ul.record({ model: "z-ai/glm-5.2", ceiling: 2048, usedTokens: 500, finishReason: "stop" });
  assert.equal(withoutFloor.reasoningFloor, null, "no floor applies to a non-reasoning model; must be null, never 0 or undefined-as-falsy-hiding-data");
});

t("D3: no PII, message/answer text passed on an unknown field never reaches the written record", () => {
  const dir = tmp();
  const ul = createUsageLimits({ dir, sync: true });
  const secret = "Fred's SSN is 555-12-3456 and his address is 1600 Secret Lane, call him at 555-867-5309";
  const e = ul.record({
    model: "openai/gpt-5.6-luna", ceiling: 4096, usedTokens: 200, finishReason: "stop",
    messageText: secret, answer: secret, content: secret, prompt: secret, text: secret,
    nested: { deep: { deeper: secret } }, list: [secret, { secret }], err: new Error(secret),
  });
  const serialized = JSON.stringify(e);
  const onDiskRaw = readFileSync(join(dir, "usage-limits.jsonl"), "utf8");
  for (const needle of ["555-12-3456", "Secret Lane", "555-867-5309"]) {
    assert.ok(!serialized.includes(needle), needle + " leaked into the in-memory record");
    assert.ok(!onDiskRaw.includes(needle), needle + " leaked into the on-disk log");
  }
  assert.equal(e.model, "openai/gpt-5.6-luna");
  assert.equal(e.usedTokens, 200);
});

t("ATTACK: D3, PII cannot ride in on the three fields that ARE strings", () => {
  // The first cut only guarded unknown field names. model, mode, and finishReason were written
  // verbatim, so a careless caller could put an entire sentence on any of them.
  const dir = tmp();
  const ul = createUsageLimits({ dir, sync: true });
  ul.record({
    model: "openai/gpt-5.6 (user said his SSN is 555-12-3456)",
    mode: "Fred lives at 1600 Secret Lane, call 555-867-5309",
    ceiling: 100,
    usedTokens: 10,
    finishReason: "error: upstream rejected prompt 'my card is 4111 1111 1111 1111'",
  });
  const raw = readFileSync(join(dir, "usage-limits.jsonl"), "utf8");
  for (const needle of ["555-12-3456", "Secret Lane", "555-867-5309", "4111", "SSN", "card"]) {
    assert.ok(!raw.includes(needle), needle + " leaked through a string field: " + raw.trim());
  }
  const row = JSON.parse(raw.trim());
  assert.equal(row.model, "openai/gpt-5.6", "the real catalog id survives, the prose after it does not");
  assert.equal(row.finish_reason, "error", "an unknown finish reason is reduced to its first token");
  assert.ok(row.mode.length <= 24, "mode is clamped");
});

t("ATTACK: D3, a model id long enough to be a paragraph is clamped", () => {
  const dir = tmp();
  const ul = createUsageLimits({ dir, sync: true });
  const e = ul.record({ model: "a".repeat(5000) + "/" + "b".repeat(5000), ceiling: 10, usedTokens: 1, finishReason: "stop" });
  assert.ok(e.model.length <= 80, "model id clamped to a sane identifier length, got " + e.model.length);
  const line = lines(dir)[0];
  assert.ok(line.length < 400, "a single record line stays small, got " + line.length);
});

t("a record with no model is never written (nothing is logged for an unidentified round)", () => {
  const dir = tmp();
  const ul = createUsageLimits({ dir, sync: true });
  assert.equal(ul.record({ ceiling: 100, usedTokens: 50, finishReason: "stop" }), null);
  assert.equal(ul.record({ model: "   ", ceiling: 100, usedTokens: 50 }), null, "whitespace is not a model id");
  assert.equal(ul.record({ model: "!!!", ceiling: 100, usedTokens: 50 }), null, "punctuation is not a model id");
  assert.equal(ul.samples(""), 0);
  assert.ok(!existsSync(join(dir, "usage-limits.jsonl")), "nothing at all was written");
});

t("ATTACK: record() never throws, whatever a caller hands it", () => {
  // A throw here lands in the hot path of a live chat turn. record(null) used to throw, because a
  // default parameter only fires on undefined.
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  const hostile = [
    undefined, null, 0, "", [], { model: {} }, { model: [] }, { model: "m", mode: {} },
    { model: "m", ceiling: {}, usedTokens: [], finishReason: {} },
    { model: "m", reasoningFloor: "8192" }, { model: "m", emptyOutput: "yes" },
    { model: "m", ceiling: Infinity, usedTokens: Infinity },
  ];
  for (const h of hostile) {
    assert.doesNotThrow(() => ul.record(h), "threw on " + JSON.stringify(h));
  }
});

t("ATTACK: the in-memory window stays bounded over months of use", () => {
  const ul = createUsageLimits({});   // no dir: in-memory only, never touches the filesystem
  for (let i = 0; i < 5000; i++) ul.record({ model: "m", ceiling: 100, usedTokens: 1, finishReason: "stop" });
  assert.ok(ul.samples("m") <= 2000, "rolling window must cap, held " + ul.samples("m"));
  assert.ok(ul.summary().m, "an in-memory-only store still summarizes");
});

t("summary reports per-model hit-ceiling fraction, empty-output fraction, and p50/p95/max used tokens", () => {
  const ul = createUsageLimits({ dir: tmp(), sync: true });
  const M = "deepseek/deepseek-v4-flash";
  const used = [10, 20, 30, 40, 50, 60, 70, 1024, 1024, 1024];
  for (let i = 0; i < used.length; i++) {
    const hit = used[i] === 1024;
    ul.record({ model: M, mode: "normal", ceiling: 1024, usedTokens: used[i], finishReason: hit ? "length" : "stop" });
  }
  const s = ul.summary();
  assert.ok(s[M], "summary must have an entry for the model");
  assert.equal(s[M].n, 10);
  assert.equal(s[M].hitCeilingFraction, 0.3);
  assert.equal(s[M].emptyOutputFraction, 0);
  assert.equal(s[M].maxUsedTokens, 1024);
  assert.ok(s[M].p95UsedTokens >= s[M].p50UsedTokens, "p95 must never sit below p50");
  assert.ok(s[M].p50UsedTokens > 0 && s[M].p50UsedTokens <= 1024);
});

t("telemetry survives a reload from disk", () => {
  const dir = tmp();
  const a = createUsageLimits({ dir, sync: true });
  for (let i = 0; i < 5; i++) a.record({ model: "moonshotai/kimi-k3", ceiling: 2048, usedTokens: 2048, finishReason: "length" });
  const b = createUsageLimits({ dir, sync: true });
  assert.equal(b.samples("moonshotai/kimi-k3"), 5, "reloaded the samples from the JSONL file");
  const s = b.summary();
  assert.equal(s["moonshotai/kimi-k3"].n, 5);
  assert.equal(s["moonshotai/kimi-k3"].hitCeilingFraction, 1);
});

t("a corrupt line in the on-disk log is skipped, not fatal", () => {
  const dir = tmp();
  const a = createUsageLimits({ dir, sync: true });
  a.record({ model: "z-ai/glm-5.2", ceiling: 1000, usedTokens: 5, finishReason: "stop" });
  appendFileSync(join(dir, "usage-limits.jsonl"), "{not json\n");
  const b = createUsageLimits({ dir, sync: true });
  assert.equal(b.samples("z-ai/glm-5.2"), 1, "the one good line before the corruption must still load");
});

t("ATTACK: a torn final line (crash mid-append, no newline) does not destroy the NEXT record too", () => {
  // The pre-existing corrupt-line test appended a broken line WITH a trailing newline, which is not
  // what a crash leaves behind. A real torn write ends mid-JSON with no newline, and the next
  // append fuses onto it, taking a good record down with it.
  const dir = tmp();
  const a = createUsageLimits({ dir, sync: true });
  a.record({ model: "m", ceiling: 100, usedTokens: 5, finishReason: "stop" });
  appendFileSync(join(dir, "usage-limits.jsonl"), '{"at":1,"model":"m","budget');   // torn, no newline
  const b = createUsageLimits({ dir, sync: true });
  b.record({ model: "m", ceiling: 100, usedTokens: 7, finishReason: "stop" });
  const c = createUsageLimits({ dir, sync: true });
  assert.equal(c.samples("m"), 2, "both good records must survive a torn write between them");
});

t("ATTACK: the log rotates instead of growing without bound", () => {
  const dir = tmp();
  const file = join(dir, "usage-limits.jsonl");
  // Stand in for months of use: a file already past the rotation threshold.
  writeFileSync(file, "x".repeat(9 * 1024 * 1024) + "\n");
  const ul = createUsageLimits({ dir, sync: true });
  ul.record({ model: "m", ceiling: 100, usedTokens: 5, finishReason: "stop" });
  assert.ok(existsSync(join(dir, "usage-limits.1.jsonl")), "the oversized generation must be rotated aside");
  const size = readFileSync(file, "utf8").length;
  assert.ok(size < 4096, "the active log restarts small, got " + size);
});

await ta("writes are batched off the hot path and land after flush()", async () => {
  const dir = tmp();
  const ul = createUsageLimits({ dir });   // default: asynchronous, the production configuration
  for (let i = 0; i < 50; i++) ul.record({ model: "m", ceiling: 1024, usedTokens: i * 10, finishReason: "stop" });
  await ul.flush();
  const rows = lines(dir).map((l) => JSON.parse(l));
  assert.equal(rows.length, 50, "every record must reach disk");
  assert.equal(rows[0].usedTokens, 0, "order is preserved");
  assert.equal(rows[49].usedTokens, 490, "order is preserved");
});

console.log("\nusage-limits: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
