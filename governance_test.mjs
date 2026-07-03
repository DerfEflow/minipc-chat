/*
 * Group B+C restoration self-test — run with: node governance_test.mjs
 * Proves (mocked models, no live Ollama needed):
 *   B1: the three-tier gating matrix routes every category correctly in SPEC mode, and LAX mode
 *       auto-approves while RECORDING gatedAs/gatedReasons (flip-to-spec stays meaningful)
 *   B2: scope is validated on write and ENFORCED on read (chat/tool/model/workspace filtering,
 *       global always, alwaysLoaded included)
 *   B3: the never-save list blocks each listed class in BOTH modes; mentor claims stay pending
 *       (unverified) even under LAX until approval verifies them
 *   C1: requires_confirmation is really assigned — statically (deck_* external sends) and
 *       dynamically (sandbox overwrite, inferred-memory save)
 *   C2: the 9-state lifecycle machinery emits the full state chain in LAX (auto_approved) and
 *       interactive (approve / deny) modes
 *   C3: flywheel description overlays change what the model sees via toolDefs(); the pipeline
 *       generates overlay candidates from mentor tool findings
 *   C4: the six formatting tools are real registered tools that run the light model
 *   C5: the abort path cancels abortable tools (pre-aborted, HTTP in-flight, python mid-run)
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, GATING_MATRIX, classifyGate, neverSaveCheck } from "./memory.mjs";
import { TOOLS, TOOL_DEFS, toolDefs, toolMeta, effectivePermission, needsConfirm, lifecycle, passConfirmGate, runTool, assertNotProtected } from "./tools.mjs";
import { createFlywheel } from "./flywheel.mjs";
import { createMentor } from "./mentor.mjs";
import { createReviewEngine } from "./review.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); });
}

const tmp = mkdtempSync(join(tmpdir(), "dominion-governance-test-"));
const dir = (n) => { const d = join(tmp, n); return d; };

// ---------------- B1: three-tier gating matrix ----------------
await t("B1: matrix is data-driven and covers every source kind", () => {
  for (const k of ["user_explicit", "assistant_inferred", "mentor_suggested", "tool_observed", "eval_failure"])
    assert.ok(["auto", "approval"].includes(GATING_MATRIX[k]), k);
  assert.equal(GATING_MATRIX.user_explicit, "auto");
  assert.equal(classifyGate({ source: { kind: "assistant_inferred" } }).tier, "approval");
  assert.equal(classifyGate({ source: { kind: "assistant_inferred" }, confirmedWorkflow: true }).tier, "auto", "confirmed workflow preference auto-saves (spec)");
  assert.equal(classifyGate({ source: { kind: "user_explicit" }, type: "failure" }).tier, "approval", "failure memories always need approval");
  assert.equal(classifyGate({ source: { kind: "user_explicit" } }, { sensitive: true }).tier, "approval", "sensitive content always needs approval");
});

await t("B1: SPEC mode — approval tier lands PENDING, auto tier commits", () => {
  const mem = createMemoryStore({ dir: dir("spec"), gating: "spec" });
  const a = mem.propose({ content: "Fred prefers metric units", source: { kind: "user_explicit" } });
  assert.equal(a.item.status, "approved", "user_explicit auto-saves");
  assert.ok(!a.item.gatedAs, "auto tier carries no gatedAs");
  const b = mem.propose({ content: "Fred seems to like short answers", source: { kind: "assistant_inferred" } });
  assert.equal(b.item.status, "pending", "inferred preference requires approval");
  assert.equal(b.item.gatedAs, "approval");
  assert.ok(b.item.gatedReasons.includes("source:assistant_inferred"));
  const c = mem.propose({ content: "Watch for off-by-one errors in loop bounds", type: "failure", source: { kind: "eval_failure" } });
  assert.equal(c.item.status, "pending", "failure memory requires approval");
  const d = mem.propose({ content: "Always cite growth statistics", source: { kind: "mentor_suggested" } });
  assert.equal(d.item.status, "pending");
  assert.equal(d.item.unverified, true, "mentor claim flagged unverified");
});

await t("B1: LAX mode — approval tier auto-approves but RECORDS gatedAs (flip-to-spec meaningful)", () => {
  const mem = createMemoryStore({ dir: dir("lax"), gating: "lax" });
  const a = mem.propose({ content: "Fred prefers metric units", source: { kind: "user_explicit" } });
  assert.equal(a.item.status, "approved");
  assert.ok(!a.item.gatedAs, "auto tier not marked");
  const b = mem.propose({ content: "Fred seems to like short answers", source: { kind: "assistant_inferred" } });
  assert.equal(b.item.status, "approved", "LAX auto-approves the approval tier");
  assert.equal(b.item.gatedAs, "approval", "…but records what spec mode would have gated");
  assert.ok(Array.isArray(b.item.gatedReasons) && b.item.gatedReasons.length, "with reasons");
  assert.ok(mem.stats().gatedLax >= 1, "stats expose the lax-auto-approved count");
  assert.equal(mem.gating, "lax");
});

await t("B3: mentor_suggested stays PENDING even under LAX (unverified until approved)", () => {
  const mem = createMemoryStore({ dir: dir("mentor"), gating: "lax" });
  const r = mem.propose({ content: "The mentor says growth stats must cite a source", source: { kind: "mentor_suggested" } });
  assert.equal(r.item.status, "pending", "the ONE lax exception — unverified mentor claims never auto-commit");
  assert.equal(r.item.unverified, true);
  const ok = mem.update(r.item.id, { action: "approve" });
  assert.equal(ok.item.status, "approved");
  assert.equal(ok.item.unverified, false, "approval IS the validation");
  assert.ok(ok.item.verifiedAt, "verification timestamped");
});

// ---------------- B3: never-save list ----------------
await t("B3: never-save blocks each listed class, in BOTH modes", () => {
  for (const gating of ["lax", "spec"]) {
    const mem = createMemoryStore({ dir: dir("ns-" + gating), gating });
    const cot = mem.propose({ content: "<think>the user probably wants…</think> He wants brevity", source: { kind: "user_explicit" } });
    assert.ok(cot.error && /raw hidden reasoning/.test(cot.error), gating + ": raw CoT blocked even when user_explicit");
    const intr = mem.propose({ content: "Fred prefers his reports to be structured with", interrupted: true, source: { kind: "user_explicit" } });
    assert.ok(intr.error && /interrupted/.test(intr.error), gating + ": interrupted output blocked");
    const sec = mem.propose({ content: "Fred's OpenRouter key is sk-abcdefghij1234567890", source: { kind: "user_explicit" } });
    assert.ok(sec.error && /private data/.test(sec.error), gating + ": secret blocked");
    const hal = mem.propose({ content: "The city has 90 million people", hallucination: true, source: { kind: "assistant_inferred" } });
    assert.ok(hal.error && /hallucination/i.test(hal.error), gating + ": unlabeled hallucination blocked");
    const halOk = mem.propose({ content: "Hallucinated a 90M population figure — verify populations", hallucination: true, type: "failure", source: { kind: "eval_failure" } });
    assert.ok(halOk.item, gating + ": hallucination IS savable as a labeled failure record");
    assert.ok(mem.propose({ content: "x" }).error, gating + ": one-off trivia floor");
    mem.propose({ content: "Fred golfs on Sundays", source: { kind: "user_explicit" } });
    const dup = mem.propose({ content: "  fred golfs on sundays ", source: { kind: "user_explicit" } });
    assert.ok(dup.deduped, gating + ": near-duplicate deduped");
  }
});

await t("B3: sensitive detection flags (approval tier) without blocking; hard secrets block", () => {
  const ns1 = neverSaveCheck("Fred's social security number ends in 1234");
  assert.equal(ns1.blocked, null);
  assert.equal(ns1.sensitive, true, "SSN mention = sensitive flag");
  const ns2 = neverSaveCheck("email him at fred@example.com");
  assert.equal(ns2.blocked, null);
  assert.equal(ns2.sensitive, true, "redact-detected PII = sensitive flag");
  const ns3 = neverSaveCheck("password = hunter2secret");
  assert.ok(ns3.blocked, "secret assignment blocks outright");
  const mem = createMemoryStore({ dir: dir("sens"), gating: "lax" });
  const r = mem.propose({ content: "Fred's medical appointment is on Fridays", source: { kind: "user_explicit" } });
  assert.equal(r.item.sensitive, true);
  assert.equal(r.item.gatedAs, "approval", "sensitive forces the approval tier even for user_explicit");
});

// ---------------- B2: scope validated + enforced ----------------
await t("B2: scope validated on write, enforced on read (retrieve/alwaysLoaded)", async () => {
  const mem = createMemoryStore({ dir: dir("scope"), gating: "lax" });
  const g = mem.propose({ content: "favorite color is forest green", scope: "global", source: { kind: "user_explicit" } });
  const c = mem.propose({ content: "favorite color for this chat is crimson", scope: "chat", scopeRef: "chat_A", source: { kind: "user_explicit" } });
  const tl = mem.propose({ content: "favorite color output format is hex", scope: "tool", scopeRef: "format_as_json", source: { kind: "user_explicit" } });
  const md = mem.propose({ content: "favorite color phrasing for the light model", scope: "model", scopeRef: "qwen3:8b", source: { kind: "user_explicit" } });
  const bad = mem.propose({ content: "favorite color scope junk", scope: "galaxy", source: { kind: "user_explicit" } });
  assert.equal(bad.item.scope, "global", "invalid scope coerced to global on write");
  assert.equal(c.item.scope, "chat"); assert.equal(c.item.scopeRef, "chat_A");

  const ids = (hits) => hits.map((h) => h.id);
  const inA = mem.retrieve("favorite color", { limit: 10, minScore: 0.05, scopeCtx: { chatId: "chat_A" } });
  assert.ok(ids(inA).includes(g.item.id) && ids(inA).includes(c.item.id), "chat_A sees global + its chat memory");
  assert.ok(!ids(inA).includes(tl.item.id) && !ids(inA).includes(md.item.id), "chat_A does NOT see tool/model-scoped");
  const inB = mem.retrieve("favorite color", { limit: 10, minScore: 0.05, scopeCtx: { chatId: "chat_B" } });
  assert.ok(ids(inB).includes(g.item.id), "global surfaces everywhere");
  assert.ok(!ids(inB).includes(c.item.id), "chat-scoped memory never leaks into another chat");
  const inTool = mem.retrieve("favorite color", { limit: 10, minScore: 0.05, scopeCtx: { chatId: "chat_B", tool: "format_as_json" } });
  assert.ok(ids(inTool).includes(tl.item.id), "tool-scoped surfaces for its tool");
  const inModel = mem.retrieve("favorite color", { limit: 10, minScore: 0.05, scopeCtx: { model: "qwen3:8b" } });
  assert.ok(ids(inModel).includes(md.item.id), "model-scoped surfaces for its model");
  const wrongModel = mem.retrieve("favorite color", { limit: 10, minScore: 0.05, scopeCtx: { model: "qwen3:30b-a3b" } });
  assert.ok(!ids(wrongModel).includes(md.item.id), "model-scoped hidden on other models");
  // hybrid path (no embedder -> lexical fallback) honors the same filter
  const hyb = await mem.retrieveHybrid("favorite color", { limit: 10, minScore: 0.05, scopeCtx: { chatId: "chat_B" } });
  assert.ok(!ids(hyb).includes(c.item.id), "retrieveHybrid scope-filters too");
  // alwaysLoaded: a PINNED chat-scoped item must not leak into other chats
  mem.update(c.item.id, { action: "pin" });
  const alB = mem.alwaysLoaded({ limit: 10, scopeCtx: { chatId: "chat_B" } });
  assert.ok(!ids(alB).includes(c.item.id), "pinned chat memory stays inside its chat");
  const alA = mem.alwaysLoaded({ limit: 10, scopeCtx: { chatId: "chat_A" } });
  assert.ok(ids(alA).includes(c.item.id), "…and still always-loads in its own chat");
});

// ---------------- C1: requires_confirmation really assigned ----------------
await t("C1: static assignments — external sends gated, forge_send stays dangerous", () => {
  for (const n of ["deck_capture", "deck_add_note", "deck_add_next_step", "deck_set_next_proof", "deck_create_project"])
    assert.equal(toolMeta(n).permissionClass, "requires_confirmation", n + " (external send)");
  assert.equal(toolMeta("deck_list_projects").permissionClass, "read_only", "reads stay ungated");
  assert.equal(toolMeta("forge_send").permissionClass, "dangerous");
  assert.equal(toolMeta("run_python_sandbox").permissionClass, "dangerous");
  assert.ok(needsConfirm("requires_confirmation") && needsConfirm("dangerous") && !needsConfirm("safe_local_write"));
});

await t("C1: dynamic escalation — sandbox OVERWRITE and INFERRED memory save", async () => {
  const ctx = { sandboxDir: dir("sbx") };
  assert.equal(effectivePermission("sandbox_write", { filename: "new.txt" }, ctx), "safe_local_write", "new file = plain write");
  await runTool("sandbox_write", { filename: "exists.txt", content: "v1" }, ctx);
  assert.equal(effectivePermission("sandbox_write", { filename: "exists.txt" }, ctx), "requires_confirmation", "existing file = overwrite = confirm");
  assert.equal(effectivePermission("remember", { content: "x" }, ctx), "safe_local_write", "explicit remember = plain write");
  assert.equal(effectivePermission("remember", { content: "x", source: "assistant_inferred" }, ctx), "requires_confirmation", "inferred memory save = confirm");
});

// ---------------- C2: 9-state lifecycle machinery ----------------
await t("C2: LAX gated chain — proposed → awaiting_confirmation → auto_approved(lax) → executing → succeeded", async () => {
  const life = lifecycle();
  life.push("proposed");
  const gate = await passConfirmGate({ cls: "requires_confirmation", interactive: false, ask: () => { throw new Error("must not ask under LAX"); }, life });
  assert.ok(gate.proceed && gate.autoApproved);
  life.push("executing"); life.push("succeeded");
  assert.deepEqual(life.states.map((s) => s.state), ["proposed", "awaiting_confirmation", "auto_approved", "executing", "succeeded"]);
  assert.equal(life.states[2].lax, true, "auto-approval marked as the lax skip");
  assert.ok(life.states.every((s) => s.at), "every transition timestamped");
});

await t("C2: interactive approve + deny chains; ungated tools skip the gate", async () => {
  const lifeY = lifecycle(); lifeY.push("proposed");
  const y = await passConfirmGate({ cls: "dangerous", interactive: true, ask: async () => "approved", life: lifeY });
  assert.ok(y.proceed && y.confirmedByUser === true);
  lifeY.push("executing"); lifeY.push("failed");
  assert.deepEqual(lifeY.states.map((s) => s.state), ["proposed", "awaiting_confirmation", "executing", "failed"]);

  const lifeN = lifecycle(); lifeN.push("proposed");
  const n = await passConfirmGate({ cls: "requires_confirmation", interactive: true, ask: async () => "denied", life: lifeN });
  assert.ok(!n.proceed && n.decision === "denied");
  assert.deepEqual(lifeN.states.map((s) => s.state), ["proposed", "awaiting_confirmation", "denied"]);

  const lifeR = lifecycle(); lifeR.push("proposed");
  const r = await passConfirmGate({ cls: "read_only", interactive: true, ask: () => { throw new Error("never asks for reads"); }, life: lifeR });
  assert.ok(r.proceed);
  assert.deepEqual(lifeR.states.map((s) => s.state), ["proposed"], "no confirmation states for ungated classes");
});

// ---------------- C3: description overlays ----------------
await t("C3: toolDefs() folds ACTIVE overlays into what the model sees", () => {
  const base = toolDefs().find((d) => d.function.name === "sandbox_write").function.description;
  assert.ok(!base.includes("LEARNED GUIDANCE"));
  const over = toolDefs({ sandbox_write: ["Check sandbox_list first so you never clobber a file blind."] });
  const d = over.find((x) => x.function.name === "sandbox_write").function.description;
  assert.ok(d.startsWith(base) && d.includes("LEARNED GUIDANCE") && d.includes("never clobber"), "overlay appended to the description");
  assert.equal(over.find((x) => x.function.name === "sandbox_read").function.description,
    toolDefs().find((x) => x.function.name === "sandbox_read").function.description, "other tools untouched");
  assert.ok(TOOL_DEFS.length === TOOLS.length, "static snapshot intact");
});

await t("C3: flywheel stores overlays; only ACTIVE ones apply; pipeline generates candidates", async () => {
  const fw = createFlywheel({ dir: dir("fw") });
  const cand = fw.addToolOverlay({ toolName: "export_artifact", content: "Confirm the format before exporting.", source: "mentor" });
  assert.equal(cand.item.status, "candidate", "pipeline-style overlays arrive as candidates");
  assert.deepEqual(fw.activeToolOverlays(), {}, "candidates do NOT apply");
  fw.update("toolOverlays", cand.item.id, { status: "active" });
  assert.deepEqual(fw.activeToolOverlays(), { export_artifact: ["Confirm the format before exporting."] }, "activation applies it");
  // Pipeline: a mentor tool finding that names a real tool becomes an overlay candidate.
  const mockChat = async (m, msgs) => ({ message: { content: JSON.stringify(/Classify this AI-assistant failure/i.test(msgs[msgs.length - 1].content) ? { category: "tool_misuse" } : {}) } });
  const mem = { propose: () => ({ item: { id: "m1", status: "approved" } }) };
  const mentor = createMentor({ localChat: mockChat, mainModel: "mock", cfg: {} });
  const engine = createReviewEngine({ mentor, flywheel: fw, memory: mem, ollamaChat: mockChat, lightModel: "mock", mainModel: "mock", autoApply: true, toolNames: TOOL_DEFS.map((d) => d.function.name) });
  const critique = {
    overall_score: 5, revision_priority: "medium", major_findings: ["misused a tool"], unsupported_claims: [], reasoning_errors: [],
    tool_use_issues: ["export_artifact was called without confirming the format with Fred"], safety_or_privacy_issues: [], style_or_format_issues: [],
    memory_candidates: [], eval_case_candidates: [], prompt_rule_candidates: [], retrieval_rule_candidates: [],
  };
  const out = await engine.runPipeline(critique, { answer: "exported it", originalRequest: "export the doc", samplingCategory: "toolChainWithErrors", tier: 2, skipResponse: true, toolCount: 1 });
  assert.equal(out.generated.toolOverlays.length, 1, "overlay candidate generated from the tool finding");
  const stored = fw.get("toolOverlays", out.generated.toolOverlays[0]);
  assert.equal(stored.toolName, "export_artifact");
  assert.equal(stored.status, "candidate", "needs activation before it changes the prompt");
});

// ---------------- C4: the six formatting tools ----------------
await t("C4: all six spec formatting tools registered (category formatting, read_only)", () => {
  for (const n of ["format_as_markdown", "format_as_json", "format_as_checklist", "format_as_table", "format_as_report", "format_as_scope"]) {
    const m = toolMeta(n);
    assert.equal(m.category, "formatting", n);
    assert.equal(m.permissionClass, "read_only", n);
    assert.ok(TOOL_DEFS.some((d) => d.function.name === n), n + " in TOOL_DEFS");
  }
});

await t("C4: formatting tools run the LIGHT model (mocked) with sane output", async () => {
  const calls = [];
  const ctx = {
    lightChat: async (messages, opts) => {
      calls.push({ prompt: messages[0].content, opts });
      if (opts.format === "json") return { message: { content: '{"tasks":["buy milk","fix bug"]}' } };
      return { message: { content: "- [ ] buy milk\n- [ ] fix bug" } };
    },
  };
  const cl = await runTool("format_as_checklist", { content: "buy milk and fix the bug" }, ctx);
  assert.ok(cl.includes("- [ ]"), "checklist output");
  assert.ok(calls[0].opts.think === false, "think:false (qwen3 gotcha)");
  const js = await runTool("format_as_json", { content: "buy milk and fix the bug" }, ctx);
  assert.deepEqual(JSON.parse(js), { tasks: ["buy milk", "fix bug"] }, "valid JSON validated before return");
  assert.equal(calls[1].opts.format, "json", "json tool forces format:json");
  const bad = await runTool("format_as_json", { content: "x" }, { lightChat: async () => ({ message: { content: "not json at all" } }) });
  assert.ok(/invalid JSON/.test(bad), "invalid model JSON reported honestly");
  const none = await runTool("format_as_markdown", { content: "hello" }, {});
  assert.ok(/isn't available/.test(none), "graceful without a light model");
});

// ---------------- C5: abort path ----------------
await t("C5: pre-aborted signal short-circuits any tool as CANCELLED", async () => {
  const ac = new AbortController(); ac.abort();
  const r = await runTool("run_python_sandbox", { code: "print(1)" }, { sandboxDir: dir("sbx2") }, ac.signal);
  assert.ok(String(r).startsWith("CANCELLED"), "cancelled without spawning python");
});

await t("C5: HTTP tool aborts in flight (request destroyed)", async () => {
  // A local server that accepts and never answers — only an abort can end the call quickly.
  const srv = http.createServer(() => { /* hold the socket open */ });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const ctx = { baseUrl: "http://127.0.0.1:" + srv.address().port, syncKey: "test-key" };
  const ac = new AbortController();
  const t0 = Date.now();
  const p = runTool("deck_capture", { text: "abort me" }, ctx, ac.signal);
  setTimeout(() => ac.abort(), 60);
  const r = await p;
  assert.ok(Date.now() - t0 < 5000, "returned promptly on abort (not the 35s timeout)");
  assert.ok(/abort/i.test(String(r)), "abort reported: " + String(r).slice(0, 80));
  srv.close();
});

await t("C5: python sandbox SIGKILLed mid-run on abort (skipped if python absent)", async () => {
  const probe = spawnSync("python", ["--version"], { windowsHide: true });
  if (probe.error || probe.status !== 0) { console.log("      (python not on PATH — skipping the mid-run kill case)"); return; }
  const ac = new AbortController();
  const t0 = Date.now();
  const p = runTool("run_python_sandbox", { code: "import time\ntime.sleep(20)\nprint('never')" }, { sandboxDir: dir("sbx3") }, ac.signal);
  setTimeout(() => ac.abort(), 400);
  const r = await p;
  assert.ok(Date.now() - t0 < 10000, "killed well before the sleep finished");
  assert.ok(String(r).startsWith("CANCELLED"), "cancellation reported: " + String(r).slice(0, 80));
});

// ---------------- carve-out stays ironclad ----------------
await t("carve-out: assertNotProtected still hard-denies D:/backups regardless of everything above", () => {
  assert.equal(assertNotProtected("sandbox_write", { filename: "notes.txt", content: "hi" }).ok, true);
  assert.equal(assertNotProtected("forge_read", { path: "D:\\backups\\db.sql" }).ok, false);
  assert.equal(assertNotProtected("run_python_sandbox", { code: "open('d:/app-backups/x')" }).ok, false);
  assert.equal(assertNotProtected("forge_send", { instructions: "pg_restore the customer db" }).ok, false);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
