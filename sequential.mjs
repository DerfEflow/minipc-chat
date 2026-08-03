/*
 * Dominion AI - SEQUENTIAL THINKING. The framework above the Ember floor.
 *
 * Fred, 2026-08-02: "yes I agree that flame and furnace can be replaced by the sequential thinking
 * MCP while ember remains the floor for every turn." And on the control itself: "we can leave the
 * forge dial now because I have not decided whether I want to let the user override the automated
 * settings or not. For now, disable it but leave it."
 *
 * So this module owns three things:
 *   1. A client for the sequential-thinking MCP server, with an honest degradation path.
 *   2. classifyComplexity, the ONE complexity router in this repo (see the contract note below).
 *   3. effectiveForgeTier, which resolves how deep a turn goes while the dial is off.
 *
 *
 * WHAT THE MCP SERVER ACTUALLY IS, verified by launching it on 2026-08-03.
 *
 * `@modelcontextprotocol/server-sequential-thinking` is a THOUGHT LOG. It is not a reasoner. It
 * exposes exactly one tool, `sequentialthinking`, which accepts a thought the caller already
 * produced and answers with bookkeeping:
 *
 *     initialize -> { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } },
 *                     serverInfo: { name: "sequential-thinking-server", version: "0.2.0" } }
 *     tools/call -> { thoughtNumber, totalThoughts, nextThoughtNeeded, branches, thoughtHistoryLength }
 *
 * That shape decides this module's design. The server cannot generate a plan on its own, so
 * `plan()` requires a `think` callback that produces each thought, and the server supplies the
 * structure: step numbering, a live total that can move up or down, revision and branch tracking,
 * and the explicit "another step is needed" signal that stops a model from declaring victory at
 * step two. Anything claiming this server does the reasoning has not run it.
 *
 *
 * DEGRADATION IS A FIRST-CLASS PATH, NOT AN ERROR PATH.
 *
 * The server is launched with npx. On a host with no npm, no route to the registry, or a spawn
 * failure, it cannot start. A turn must never fail because of that. Every entry point here returns
 * a record with `degraded: true`, a plain reason, and the prompt-only directive from
 * forgeFrameworkPrompt so the executor keeps the depth it had before this module existed. Nothing
 * in this file throws at the caller.
 *
 * The launcher itself is imported from connectors.mjs on purpose. Five connectors in this repo
 * could never start for weeks because `spawn("npx", ...)` is ENOENT on Windows, and the failure
 * lied as a 90-second timeout. The fix is npm's own npx-cli.js run through this process's node
 * binary, never with shell:true. There is one implementation of that, in connectors.mjs, and this
 * module calls it rather than owning a second copy that could drift back into the defect.
 */
import { spawnMcpStdio, stdioRpc, STDIO_FIRST_MS, STDIO_CALL_MS } from "./connectors.mjs";
import {
  classifyTaskIntent, forgeFrameworkPrompt, normalizeForgeTier,
  FORGE_DIAL_ENABLED, DEFAULT_FORGE_TIER,
} from "./execution-policy.mjs";

// Verified 2026-08-03 by a real handshake; see the header. Version is deliberately unpinned so the
// registry serves the current build, matching how every other npx connector here is launched.
export const SEQUENTIAL_SERVER = Object.freeze({
  package: "@modelcontextprotocol/server-sequential-thinking",
  tool: "sequentialthinking",
  protocol: "2025-03-26",
  expectedServerName: "sequential-thinking-server",
});

const MAX_STEPS_DEFAULT = 12;    // a hard ceiling; the server will happily loop forever
const MAX_STEPS_CEILING = 40;

// ---- complexity ---------------------------------------------------------------------------------

export const COMPLEXITY_BANDS = Object.freeze(["trivial", "simple", "moderate", "complex", "deep"]);

/*
 * THE THRESHOLD IS OBSERVABLE AND TUNABLE, WHICH THE SOW REQUIRES.
 *
 * Sequential thinking is slower and costs more per task by design. It earns its keep only behind a
 * gate where simple work stays light. That gate is a number, and a number buried in an expression
 * is a number nobody can move after a week of real traffic. So it is named, exported, overridable
 * at runtime, and echoed back inside every classification result next to the score it was compared
 * against. Anyone reading a routing decision can see both halves of it.
 */
export const SEQUENTIAL_THRESHOLD_DEFAULT = 45;

/*
 * A BLANK ENV VAR IS NOT A ZERO. Fixed 2026-08-03 during review.
 *
 * This read used to be `Number(env && env.DOMINION_SEQUENTIAL_THRESHOLD)`. `Number("")` is 0,
 * `Number("   ")` is 0, and `Number(null)` is 0, and every one of those passed the `>= 0` guard and
 * returned a threshold of ZERO. A threshold of zero opens the gate for every turn, including a
 * one-word greeting, which is the precise cost blowout the gate exists to prevent. The shape that
 * triggers it is the ordinary one: a Railway or Docker variable that is declared and left empty
 * ships as "", not as unset. Passing `env: null` did the same thing.
 *
 * An explicit "0" is still honored, because someone who types a zero means it.
 */
export function sequentialThreshold(env = process.env) {
  const src = env && typeof env === "object" ? env.DOMINION_SEQUENTIAL_THRESHOLD : undefined;
  const text = typeof src === "number" ? String(src) : String(src ?? "").trim();
  if (!text) return SEQUENTIAL_THRESHOLD_DEFAULT;
  const raw = Number(text);
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : SEQUENTIAL_THRESHOLD_DEFAULT;
}

const KIND_BASE = Object.freeze({ simple: 5, research: 20, audit: 32, build: 38, "long-run": 55 });

// Each rule is [label, test, points]. Kept as data so the scoring is auditable at a glance and a
// classification can name exactly which rules fired.
const RAISERS = Object.freeze([
  ["multi-step", (t) => (t.match(/(?:^|\s)\d+[.)]\s/g) || []).length >= 2 || /\bthen\b[\s\S]{0,120}\bthen\b/i.test(t), 10],
  ["conjoined-asks", (t) => (t.match(/\b(?:and then|after that|once that|followed by)\b/gi) || []).length >= 1, 6],
  ["mechanism", (t) => /\bwhy\b|root[- ]cause|diagnos|trade[- ]?off|architect|\bdesign\b|\bcompare\b/i.test(t), 10],
  ["formal", (t) => /\bprove\b|\bproof\b|algorithm|time complexity|optimi[sz]|derive|theorem|invariant|\bregex\b/i.test(t), 10],
  ["ambiguity", (t) => /figure out|not sure|best way|what should|how should|which approach|\boptions\b/i.test(t), 8],
  ["wide-scope", (t) => /\bentire\b|\bwhole\b|all (?:the )?files|codebase|repo(?:sitory)?|end[- ]to[- ]end|migrat/i.test(t), 8],
  ["code-present", (t) => /```|\bfunction \w+\(|=>\s*\{|\bclass \w+/.test(t), 5],
]);

const CONSTRAINT_RE = /\b(?:must|never|only|without|except|cannot|do not|don't)\b/gi;

/*
 * "JUST" IS USUALLY A TIME ADVERB, NOT A REQUEST FOR BREVITY. Fixed 2026-08-03 during review.
 *
 * A bare `\bjust\b` in this list subtracted 12 points from "I just read this article", "I just
 * deployed and it broke", "it just started failing". Those are the openings of hard debugging asks,
 * and the lowerer was quietly pushing every one of them below the gate. Measured: a 1600 character
 * pasted article scored 3 out of 100 purely because it contained the word "just".
 *
 * "just" now counts only where it actually asks for less work: in front of a request verb, or
 * paired with a brevity word. "simply" has the same two lives and gets the same treatment.
 */
const BREVITY_RE = new RegExp([
  "\\b(?:quick|quickly|brief|briefly|short|one line|tl;?dr|in a sentence|in one sentence)\\b",
  "\\b(?:just|simply)\\s+(?:tell|give|show|say|answer|list|name|confirm|check)\\b",
  "\\b(?:just|simply)\\s+(?:a|the)?\\s*(?:yes|no|short|quick|one)\\b",
].join("|"), "i");

const LOOKUP_RE = /^\s*(?:what|who|when|where)\s+(?:is|are|was|were|does|do)\b/i;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const bandFor = (score) => score < 15 ? "trivial" : score < 30 ? "simple" : score < 50 ? "moderate" : score < 70 ? "complex" : "deep";

/*
 * CONTRACT FOR LANE I (Simplify My Chat) AND THE PHASE 3 GATE. One classifier, one signal, two
 * outputs. Simplify reads `band`/`score`/`reasoning`/`minContextTokens` to choose WHO answers.
 * Phase 3 reads `needsSequential`/`suggestedTier` to choose HOW HARD to think. Neither side owns a
 * second scoring function, because two routers built separately will disagree and the disagreement
 * shows up as a user getting a cheap model on hard work.
 *
 * This deliberately does NOT map to a model id. The routing table is Lane I's, the catalog is
 * models.catalog.mjs, and a model list embedded here would be a third place to keep in sync.
 *
 * Intent comes from classifyTaskIntent in execution-policy.mjs rather than a private copy, so the
 * task class this scores is the same task class the execution contract was built from.
 *
 * Pass `text` as the ASK SLICE, never the raw message. A pasted article read as an instruction is
 * a defect this repo has already paid for once: a pasted piece of writing was classified as a
 * build and the completion gate replaced the answer with "Work paused". Use askSliceOf(message)
 * from routing.mjs at the call site.
 */
export function classifyComplexity(input, { env = process.env } = {}) {
  const src = typeof input === "string" ? { text: input } : (input || {});
  const text = String(src.text ?? "").replace(/\s+/g, " ").trim();
  const attachments = clamp(Number(src.attachments) || 0, 0, 50);
  const historyTurns = clamp(Number(src.historyTurns) || 0, 0, 10_000);

  const intent = classifyTaskIntent(text);
  const kind = src.taskKind && Object.hasOwn(KIND_BASE, String(src.taskKind)) ? String(src.taskKind) : intent.kind;
  const signals = [];
  let score = KIND_BASE[kind] ?? 5;
  signals.push("task:" + kind);

  for (const [label, test, points] of RAISERS) {
    if (test(text)) { score += points; signals.push(label); }
  }
  const constraints = (text.match(CONSTRAINT_RE) || []).length;
  if (constraints) { score += clamp(constraints * 2, 0, 10); signals.push("constraints:" + constraints); }
  if (text.length > 1200) { score += 10; signals.push("very-long-ask"); }
  else if (text.length > 400) { score += 5; signals.push("long-ask"); }
  if (attachments) { score += clamp(attachments * 6, 0, 12); signals.push("attachments:" + attachments); }
  if (historyTurns > 12) { score += 5; signals.push("deep-history"); }
  if (src.toolsRequested === true) { score += 6; signals.push("tools-requested"); }

  // Lowerers. A person who asked for a quick answer and got a twelve-step deliberation was not
  // served, and they paid for it. An explicit request for brevity outranks most raisers.
  if (BREVITY_RE.test(text)) { score -= 12; signals.push("brevity-requested"); }
  if (LOOKUP_RE.test(text) && text.length < 140) { score -= 10; signals.push("plain-lookup"); }
  if (!text) { score = 0; signals.push("empty-ask"); }

  score = clamp(Math.round(score), 0, 100);
  const threshold = sequentialThreshold(env);
  const band = bandFor(score);
  const needsSequential = score >= threshold;

  return Object.freeze({
    score,
    band,
    threshold,
    needsSequential,
    suggestedTier: score >= 70 ? "furnace" : needsSequential ? "flame" : "ember",
    reasoning: score >= 30,
    minContextTokens: score >= 70 ? 128_000 : score >= 50 ? 64_000 : score >= 30 ? 32_000 : 8_000,
    taskKind: kind,
    workKind: intent.baseKind,
    signals: Object.freeze(signals),
    rationale: `Scored ${score} of 100 (${band}) against a threshold of ${threshold}; ${
      needsSequential ? "sequential thinking is warranted" : "the light path is sufficient"}. Signals: ${signals.join(", ")}.`,
  });
}

/*
 * How deep does this turn go, given that the dial is off?
 *
 * With FORGE_DIAL_ENABLED false, whatever tier the client sent is recorded and ignored, and the
 * router's complexity judgment decides. "As Fred" still reaches furnace because it is a MODE and
 * not the dial: the whole reasoning motion is what makes that voice real, and disabling a user
 * control was never meant to flatten a persona.
 *
 * `honoredRequest` and `source` exist so a turn can be explained after the fact. A depth decision
 * nobody can account for is the thing this build is replacing.
 */
export function effectiveForgeTier({
  requestedTier = "",
  mode = "",
  ask = "",
  taskKind = "",
  attachments = 0,
  historyTurns = 0,
  toolsRequested = false,
  dialEnabled = FORGE_DIAL_ENABLED,
  env = process.env,
} = {}) {
  const complexity = classifyComplexity({ text: ask, taskKind, attachments, historyTurns, toolsRequested }, { env });
  let requested = "";
  try { requested = requestedTier ? normalizeForgeTier(requestedTier) : ""; } catch { requested = ""; }

  if (dialEnabled && requested) {
    return Object.freeze({ tier: requested, source: "user-dial", dialEnabled, requestedTier: requested, honoredRequest: true, complexity });
  }
  const tier = String(mode || "").toLowerCase() === "as_fred" ? "furnace" : complexity.suggestedTier;
  return Object.freeze({
    tier,
    source: tier === "furnace" && String(mode || "").toLowerCase() === "as_fred" ? "as-fred-mode" : "complexity-router",
    dialEnabled,
    requestedTier: requested,
    honoredRequest: false,
    complexity,
  });
}

// ---- the MCP client -----------------------------------------------------------------------------

function degraded(reason, tier, complexity = null, task = "") {
  return Object.freeze({
    ok: true,
    via: "degraded",
    degraded: true,
    reason: String(reason || "the sequential-thinking server is unavailable"),
    task: String(task || ""),
    tier: normalizeForgeTier(tier || DEFAULT_FORGE_TIER),
    complexity,
    steps: Object.freeze([]),
    totalThoughts: 0,
    branches: Object.freeze([]),
    historyLength: 0,
    // The whole point of degrading: the executor still gets the depth it had before this module.
    directive: forgeFrameworkPrompt(tier || DEFAULT_FORGE_TIER),
  });
}
export { degraded as sequentialDegraded };

/*
 * A thinker owns at most one child process and reuses it. Dependencies are injected so the
 * degradation path can be tested without a network, an npm registry, or a two-minute wait, which
 * is the only way that path ever gets exercised before a user finds it.
 */
export function createSequentialThinker({
  spawn: spawnFn = spawnMcpStdio,
  rpc = stdioRpc,
  pkg = SEQUENTIAL_SERVER.package,
  cacheDir = "",
  firstMs = STDIO_FIRST_MS,
  callMs = STDIO_CALL_MS,
  log = () => {},
} = {}) {
  let conn = null;
  let ready = false;
  let unavailable = "";
  let server = null;

  const withTimeout = (promise, ms, what) => Promise.race([
    promise,
    new Promise((_, rej) => {
      const t = setTimeout(() => rej(new Error(`the sequential-thinking server did not answer ${what} within ${Math.round(ms / 1000)}s`)), ms);
      if (typeof t.unref === "function") t.unref();
    }),
  ]);

  async function connect() {
    if (ready && conn && !conn.dead) return "";
    if (conn && conn.dead) { ready = false; conn = null; }
    try {
      conn = spawnFn({ command: "npx", argv: ["-y", pkg], cacheDir });
      if (conn && conn.dead) { unavailable = conn.deadReason || "the server process is not running"; return unavailable; }
      const init = await withTimeout(
        rpc(conn, "initialize", { protocolVersion: SEQUENTIAL_SERVER.protocol, capabilities: {}, clientInfo: { name: "dominion-ai", version: "1.0" } }),
        firstMs, "initialize",
      );
      await rpc(conn, "notifications/initialized", {}, true);
      server = (init && init.serverInfo) || null;
      ready = true;
      unavailable = "";
      log(`[sequential] ${(server && server.name) || pkg} ready`);
      return "";
    } catch (e) {
      unavailable = String((e && e.message) || e);
      ready = false;
      return unavailable;
    }
  }

  /*
   * One recorded thought. Returns the server's bookkeeping, or throws for plan() to absorb.
   *
   * A REJECTED CALL MUST NOT READ AS A FINISHED SEQUENCE. Fixed 2026-08-03 during review, against
   * the live server. `tools/call` answers a bad payload with
   * `{ content: [{ type: "text", text: "MCP error -32602: ..." }], isError: true }`, which is not
   * JSON. The old body parsed that, failed, swallowed the failure, and returned `{}`. Back in
   * plan(), `{}` has no `nextThoughtNeeded`, so the loop broke and the call returned
   * `ok: true, via: "mcp", degraded: false` with one step. A caller was told a plan succeeded when
   * the server had refused every word of it. The same held for any non-bookkeeping body, such as a
   * proxy returning an HTML error page.
   *
   * Both cases now throw, which is the honest outcome: plan() catches, keeps whatever steps really
   * were recorded, and hands back a degraded record carrying the fallback directive. Degradation is
   * the designed path here, and silence is the one thing that is not.
   */
  async function record(payload) {
    const r = await withTimeout(rpc(conn, "tools/call", { name: SEQUENTIAL_SERVER.tool, arguments: payload }), callMs, "a thought");
    const textOf = () => {
      const c = r && Array.isArray(r.content) ? r.content.find((x) => x && x.type === "text") : null;
      return String((c && c.text) || "").trim();
    };
    if (r && r.isError === true) {
      throw new Error("the sequential-thinking server rejected the thought: " + (textOf().slice(0, 300) || "no reason given"));
    }
    let book = r && r.structuredContent;
    if (!book) { try { book = JSON.parse(textOf() || "null"); } catch { book = null; } }
    if (!book || typeof book !== "object" || !Number.isFinite(Number(book.thoughtNumber))) {
      throw new Error("the sequential-thinking server answered with something that is not step bookkeeping: "
        + (textOf().slice(0, 200) || JSON.stringify(r).slice(0, 200)));
    }
    return book;
  }

  /*
   * Drive a task through the server as a numbered sequence.
   *
   * `think` is required and it is the reasoner: an async function given
   * { task, stepNumber, totalThoughts, previous[] } that returns either a string thought or
   * { thought, isRevision, revisesThought, branchFromThought, branchId, totalThoughts,
   *   nextThoughtNeeded }. Without it there is nothing to log, so the call degrades and says so
   * plainly rather than returning an empty plan that reads like success.
   */
  async function plan(task, {
    think = null,
    tier = DEFAULT_FORGE_TIER,
    maxSteps = MAX_STEPS_DEFAULT,
    initialThoughts = 5,
    complexity = null,
    signal = null,
  } = {}) {
    const taskText = String(task ?? "").trim();
    const resolvedTier = normalizeForgeTier(tier);
    if (!taskText) return degraded("no task text was supplied", resolvedTier, complexity, taskText);
    if (typeof think !== "function") {
      return degraded("no thought source was supplied; the sequential-thinking server records reasoning and does not produce it", resolvedTier, complexity, taskText);
    }
    const why = await connect();
    if (why) return degraded(why, resolvedTier, complexity, taskText);

    const cap = clamp(Number(maxSteps) || MAX_STEPS_DEFAULT, 1, MAX_STEPS_CEILING);
    const steps = [];
    let total = clamp(Number(initialThoughts) || 5, 1, cap);
    let branches = [];
    let historyLength = 0;

    try {
      for (let n = 1; n <= cap; n++) {
        if (signal && signal.aborted) break;
        const raw = await think({ task: taskText, stepNumber: n, totalThoughts: total, previous: steps.slice() });
        const t = typeof raw === "string" ? { thought: raw } : (raw || {});
        const thought = String(t.thought ?? "").trim();
        if (!thought) break;
        if (Number.isFinite(Number(t.totalThoughts))) total = clamp(Number(t.totalThoughts), n, cap);

        const payload = {
          thought,
          thoughtNumber: n,
          totalThoughts: Math.max(total, n),
          nextThoughtNeeded: t.nextThoughtNeeded === undefined ? n < total : t.nextThoughtNeeded === true,
        };
        if (t.isRevision === true) { payload.isRevision = true; payload.revisesThought = clamp(Number(t.revisesThought) || 1, 1, n); }
        if (Number.isFinite(Number(t.branchFromThought))) {
          payload.branchFromThought = clamp(Number(t.branchFromThought), 1, n);
          payload.branchId = String(t.branchId || `b${n}`);
        }

        const book = await record(payload);
        total = Number(book.totalThoughts) || payload.totalThoughts;
        branches = Array.isArray(book.branches) ? book.branches : branches;
        historyLength = Number(book.thoughtHistoryLength) || historyLength;
        steps.push(Object.freeze({
          n,
          total,
          thought,
          isRevision: payload.isRevision === true,
          revisesThought: payload.revisesThought ?? null,
          branchId: payload.branchId ?? null,
          nextNeeded: book.nextThoughtNeeded === true,
        }));
        if (book.nextThoughtNeeded !== true) break;
      }
    } catch (e) {
      // A server that dies mid-sequence must not take the turn with it. Keep what was recorded,
      // hand back the fallback directive, and say what happened.
      const why2 = String((e && e.message) || e);
      ready = false;
      const fell = degraded(why2, resolvedTier, complexity, taskText);
      return Object.freeze({ ...fell, steps: Object.freeze(steps), totalThoughts: total, historyLength,
        reason: steps.length ? `${why2} (kept ${steps.length} recorded step${steps.length === 1 ? "" : "s"})` : why2 });
    }

    if (!steps.length) return degraded("the sequential-thinking server recorded no steps", resolvedTier, complexity, taskText);
    return Object.freeze({
      ok: true,
      via: "mcp",
      degraded: false,
      reason: "",
      task: taskText,
      tier: resolvedTier,
      complexity,
      steps: Object.freeze(steps),
      totalThoughts: total,
      branches: Object.freeze([...branches]),
      historyLength,
      truncated: steps.length >= cap && steps[steps.length - 1].nextNeeded,
      directive: forgeFrameworkPrompt(resolvedTier),
      server,
    });
  }

  function close() {
    try { if (conn && conn.child) conn.child.kill(); } catch {}
    conn = null; ready = false; server = null;
  }
  const status = () => Object.freeze({ ready, unavailable, server, package: pkg });

  return { connect, plan, record, close, status };
}

// A single shared thinker for the server process. Created lazily so importing this module never
// spawns anything, which matters because half this repo's tests import half the repo.
let shared = null;
export function sequentialThinker(opts) {
  if (!shared) shared = createSequentialThinker(opts);
  return shared;
}

/*
 * The one call a route needs. Decide depth, and either run the sequence or hand back the
 * prompt-only fallback. It never throws and it always returns the same record shape, so a caller
 * can read `.directive` without ever branching on whether the server was reachable.
 */
export async function sequentialPlan(task, {
  ask = "",
  mode = "",
  requestedTier = "",
  taskKind = "",
  attachments = 0,
  historyTurns = 0,
  toolsRequested = false,
  think = null,
  maxSteps = MAX_STEPS_DEFAULT,
  thinker = null,
  env = process.env,
  signal = null,
} = {}) {
  const decision = effectiveForgeTier({
    requestedTier, mode, ask: ask || task, taskKind, attachments, historyTurns, toolsRequested, env,
  });
  const complexity = decision.complexity;
  // Below the gate, sequential thinking costs more and buys nothing. Ember is the floor and the
  // floor is the whole answer for simple work.
  if (!complexity.needsSequential) {
    return Object.freeze({ ...degraded("below the sequential threshold; the Ember floor governs this turn", decision.tier, complexity, task), gated: true, decision });
  }
  const t = thinker || sequentialThinker();
  const result = await t.plan(task, { think, tier: decision.tier, maxSteps, complexity, signal });
  return Object.freeze({ ...result, gated: false, decision });
}
