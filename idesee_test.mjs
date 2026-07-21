/*
 * Run-and-see + language register self-test. Run with: node idesee_test.mjs
 * Proves with fakes:
 *   1. every register has every phrase, and unknown keys are visible instead of silent
 *   2. the runner's answer matching accepts every register's wording for the same choice
 *   3. run detection: start script beats static, static needs index.html, neither skips honestly
 *   4. the see loop: happy path order (deps, launch, look, judge, fix, look again, stop), and
 *      every degradation path ends in a plain sentence, never a failure of the finished build
 *   5. GOOD short-circuits: no fixes are applied to a page the judge likes
 *   6. the preview process is stopped even when the loop dies mid-way
 */
import assert from "node:assert/strict";
import { REGISTERS, phrase, plannerVoice, ANSWER, DICT_KEYS, normalizeRegister } from "./idelang.mjs";
import { createRunAndSee, runPlanFor, visionMessages, PREVIEW_PORT } from "./idesee.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}

/* ---- language ---------------------------------------------------------------------------- */
await t("every phrase exists in every register, and typos surface instead of vanishing", () => {
  for (const key of DICT_KEYS) for (const reg of REGISTERS) {
    const v = phrase(key, reg, "$1.00", "$0.50");
    assert.ok(typeof v === "string" && v.length > 0, key + "/" + reg + " must produce a sentence");
  }
  assert.equal(phrase("no_such_key", "plain"), "no_such_key", "an unknown key must be VISIBLE");
  assert.equal(normalizeRegister("TECHNICAL"), "technical");
  assert.equal(normalizeRegister("klingon"), "plain", "nonsense falls back to the register that excludes nobody");
});

await t("plain never says jargon; hybrid always explains its terms", () => {
  assert.ok(!/\babort\b|\bnode\b/i.test(phrase("no_node", "plain")), "plain speaks of computers and helpers");
  assert.match(phrase("no_node", "hybrid"), /\(/, "hybrid teaches the term in the same breath");
  assert.match(phrase("move_stop", "technical"), /abort/i);
  assert.ok(!/\babort\b/i.test(phrase("move_stop", "plain")));
});

await t("answer matching accepts every register's wording for the same choice", () => {
  for (const reg of REGISTERS) {
    assert.ok(ANSWER.keepGoing.test(phrase("budget_keep", reg)), "keep/" + reg);
    assert.ok(ANSWER.stop.test(phrase("budget_stop", reg)), "stop/" + reg);
    assert.ok(ANSWER.retry.test(phrase("move_retry", reg)), "retry/" + reg);
    assert.ok(ANSWER.skip.test(phrase("move_skip", reg)), "skip/" + reg);
    assert.ok(ANSWER.stop.test(phrase("move_stop", reg)), "moveStop/" + reg);
  }
  assert.ok(!ANSWER.stop.test(phrase("budget_keep", "hybrid")), "Continue (keep building) must never read as stop");
});

await t("the planner voice differs by register", () => {
  assert.match(plannerVoice("plain"), /plain English/i);
  assert.match(plannerVoice("technical"), /engineer/i);
  assert.match(plannerVoice("hybrid"), /gloss/i);
});

/* ---- run detection ----------------------------------------------------------------------- */
await t("run detection: script beats static, static needs index.html, neither skips", () => {
  assert.equal(runPlanFor('{"scripts":{"start":"node s.js"}}').mode, "script");
  assert.equal(runPlanFor('{"scripts":{"dev":"vite"}}', { hasIndexHtml: true }).mode, "script");
  assert.equal(runPlanFor("{}", { hasIndexHtml: true }).mode, "static");
  assert.equal(runPlanFor("not json", { hasIndexHtml: false }).mode, null);
  assert.match(runPlanFor("{}").why, /nothing runnable/i);
});

await t("vision messages carry the goal and the pixels, and demand GOOD or five fixes", () => {
  const m = visionMessages({ goal: "a bakery landing page", imageBase64: "AAAA" });
  assert.equal(m.length, 2);
  assert.match(m[0].content, /GOOD/);
  assert.match(m[1].content[0].text, /bakery/);
  assert.match(m[1].content[1].image_url.url, /^data:image\/png;base64,AAAA$/);
});

/* ---- the loop, with fakes ---------------------------------------------------------------- */
function rig({ judge = "GOOD", browserRefused = false, killLog = [] } = {}) {
  const events = [];
  const jobs = { emit: (id, ev) => events.push(ev) };
  const hands = async (tool, args) => {
    if (tool === "fs_read" && String(args.path).endsWith("package.json")) return { text: '{"name":"x"}' };
    if (tool === "fs_read" && args.base64) return { ok: true, base64: "UElYRUxT" };
    if (tool === "fs_list") return { entries: ["index.html", "style.css"] };
    if (tool === "shell_run" && /Start-Process/.test(args.command)) return { stdout: "4242" };
    if (tool === "shell_run" && /taskkill/.test(args.command)) { killLog.push(args.command); return { code: 0 }; }
    if (tool === "browser_control" && browserRefused) return { ok: false, refused: true, error: "owner only" };
    if (tool === "browser_control" && args.op === "screenshot") return { ok: true, path: "C:/shots/x.png" };
    if (tool === "browser_control") return { ok: true };
    return { ok: true };
  };
  const chat = async () => ({ ok: true, content: judge, costUsd: 0.002 });
  const see = createRunAndSee({ hands, chat, jobs });
  return { see, events, killLog, types: () => events.map((e) => (e.skipped ? "skip" : e.command || e.type)) };
}
const JOB = { id: "ide_t" };
const WS = { root: "C:/Projects/demo", name: "Demo" };

await t("GOOD short-circuits: it looks, approves, applies nothing, and stops the preview", async () => {
  const r = rig({ judge: "GOOD" });
  let fixed = 0;
  const out = await r.see.run(JOB, { workspace: WS, goal: "g", visionModel: "openai/gpt-4o", applyFixes: async () => { fixed++; return {}; } });
  assert.equal(out.good, true);
  assert.equal(fixed, 0, "a page the judge likes gets no paid fixes");
  assert.equal(r.killLog.length, 1, "the preview process must be stopped");
});

await t("a critique applies ONE fix round and takes the after shot", async () => {
  const r = rig({ judge: "1. Increase contrast on the header\n2. Center the card" });
  let guidance = "";
  const out = await r.see.run(JOB, { workspace: WS, goal: "g", visionModel: "openai/gpt-4o",
    applyFixes: async (c) => { guidance = c; return { costUsd: 0.01 }; } });
  assert.equal(out.improved, true);
  assert.match(guidance, /contrast/);
  assert.ok(r.types().some((c) => /look \(after\)/.test(String(c))), "the after shot goes on the record");
  assert.equal(r.killLog.length, 1);
});

await t("every missing piece skips with a sentence: browser refused, no vision model, nothing runnable", async () => {
  const refused = rig({ browserRefused: true });
  assert.equal((await refused.see.run(JOB, { workspace: WS, goal: "g", visionModel: "x", applyFixes: async () => ({}) })).skipped, "browser_refused");
  assert.equal(refused.killLog.length, 1, "even a refused look stops the preview it started");

  const noModel = rig({});
  assert.equal((await noModel.see.run(JOB, { workspace: WS, goal: "g", visionModel: "", applyFixes: async () => ({}) })).skipped, "no_vision_model");

  const nothing = rig({});
  const bare = createRunAndSee({ jobs: { emit: (id, ev) => nothing.events.push(ev) }, chat: async () => ({ ok: true }),
    hands: async (tool, args) => (tool === "fs_list" ? { entries: [] } : { ok: false }) });
  assert.equal((await bare.run(JOB, { workspace: WS, goal: "g", visionModel: "x" })).skipped, "not_runnable");
  assert.ok(nothing.events.some((e) => e.skipped && /nothing runnable/i.test(e.message || "")), "the skip explains itself");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
