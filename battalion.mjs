// BATTALION (ARSENAL Wave 6, docs/BATTALION-SOW.md). Fred's copy, verbatim, no quality
// qualifier: "a handpicked swarm of AI models to do more work in less time- for free."
//
// Picking BATTALION in the chat dropdown is an EXECUTION MODE, not a model id: the turn is
// assessed (simple turns get ONE free seat, no war council), complex turns are split by a free
// orchestrator seat, worked by parallel free specialists, and synthesized into one voice by a
// strong free seat. Every seat is a live-probed free-lane model from the Wave 2 fleet; the whole
// run bills $0. Fallbacks are announced in the manifest, never silent; if the free lane is down
// entirely, the run says so and the server offers the user's normal model instead. It never
// quietly bills a paid swarm.
//
// This module is pure orchestration: the server injects callSeat (its cloudChatStream), the
// roster (models.catalog.mjs BATTALION_ROSTER), and an isSimple heuristic. Nothing here spends.

const PART_MIN = 2, PART_MAX = 4;
const HISTORY_TAIL_CHARS = 24000;   // context handed to seats — recent turns, capped
const PLAN_TOKENS = 3000;           // reasoning seats eat budget before the first word:
const PART_TOKENS = 4096;           // keep every stage generous (GPT-5.x starvation lesson)
const SYNTH_TOKENS = 8192;

// Defensive JSON extraction: take the first {...} block that parses; reasoning models love to
// wrap JSON in prose no matter what the prompt says.
export function extractPlan(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  for (let end = s.length; end > start; end--) {
    const cand = s.slice(start, end);
    if (!cand.trimEnd().endsWith("}")) continue;
    try {
      const j = JSON.parse(cand);
      if (j && Array.isArray(j.parts)) {
        const parts = j.parts
          .filter((p) => p && typeof p.title === "string" && typeof p.instructions === "string")
          .map((p) => ({ title: p.title.slice(0, 160), instructions: p.instructions.slice(0, 2000) }))
          .slice(0, PART_MAX);
        return { parts };
      }
    } catch {}
  }
  return null;
}

/*
 * A plan the CALLER already has, held to exactly the bounds extractPlan enforces on the
 * orchestrator's own output (Fred, 2026-08-09, blueprint fan-outs).
 *
 * The point is not saving the orchestrator call, though it saves one. It is that a blueprint's
 * fan-out lanes are a DESIGNED split - "security, performance, correctness, readability" - where the
 * orchestrator invents one per turn and sometimes cannot be reached at all ("orchestrator
 * unreachable; single seat answered"). A designed split beats an invented one wherever it applies.
 *
 * Validated rather than trusted: the same 2-4 bound and the same standalone-instruction contract
 * protect the workers regardless of who wrote the parts. A supplied plan that fails these checks is
 * DISCARDED and the orchestrator runs as usual, because a bad hand-off must degrade to the normal
 * path and never break the turn.
 */
export function normalizePlan(parts) {
  if (!Array.isArray(parts)) return null;
  const clean = parts
    .filter((p) => p && typeof p.title === "string" && typeof p.instructions === "string"
      && p.title.trim() && p.instructions.trim())
    .map((p) => ({ title: p.title.slice(0, 160), instructions: p.instructions.slice(0, 2000) }));
  if (clean.length < PART_MIN || clean.length > PART_MAX) return null;
  return clean;
}

export function historyTail(history, capChars = HISTORY_TAIL_CHARS) {
  const out = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const text = typeof m.content === "string" ? m.content : "";
    if (used + text.length > capChars && out.length) break;
    used += text.length;
    out.unshift({ role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user", content: text });
    if (out.length >= 24) break;
  }
  return out;
}

export function createBattalion({ callSeat, roster, isSimple = () => false, log = () => {} }) {
  const seatsUsed = (manifest) => [...new Set(manifest.stages.map((s) => s.seat))];

  async function seat(catalogId, messages, { tokens, onDelta = null, signal } = {}) {
    const t0 = Date.now();
    const r = await callSeat(catalogId, messages, { num_predict: tokens, signal }, onDelta);
    return { ...r, ms: Date.now() - t0 };
  }

  // One part, with one announced replacement on failure: the roster IS the bench.
  async function runPart(part, idx, context, workers, signal, manifest) {
    const primary = workers[idx % workers.length];
    const sys = "You are one specialist in BATTALION, a crew of models splitting one request. " +
      "Produce ONLY your assigned part, fully worked: no preamble, no summary of the other parts, " +
      "no coordination talk. Your output will be merged with the other parts by an editor.";
    const msgs = [
      { role: "system", content: sys },
      ...context,
      { role: "user", content: "THE ASSIGNED PART (" + (idx + 1) + "): " + part.title + "\n\n" + part.instructions },
    ];
    let r = await seat(primary, msgs, { tokens: PART_TOKENS, signal });
    if (r.ok && String(r.content || "").trim()) {
      manifest.stages.push({ stage: "part " + (idx + 1), title: part.title, seat: primary, ms: r.ms, ok: true });
      return { title: part.title, text: r.content };
    }
    const backup = workers[(idx + 1) % workers.length];
    log(`battalion: part ${idx + 1} failed on ${primary} (${String(r.error || "empty").slice(0, 80)}) — replacing with ${backup}`);
    const r2 = await seat(backup, msgs, { tokens: PART_TOKENS, signal });
    if (r2.ok && String(r2.content || "").trim()) {
      manifest.stages.push({ stage: "part " + (idx + 1), title: part.title, seat: backup, ms: r2.ms, ok: true, replaced: primary });
      manifest.notes.push("part " + (idx + 1) + " seat " + primary + " failed; " + backup + " took it over");
      return { title: part.title, text: r2.content };
    }
    manifest.stages.push({ stage: "part " + (idx + 1), title: part.title, seat: backup, ms: r.ms + r2.ms, ok: false, replaced: primary });
    manifest.notes.push("part " + (idx + 1) + " (" + part.title + ") failed on two seats and was dropped");
    return null;
  }

  /*
   * The full turn. sse/working are the server's own event emitters; deltas stream through
   * onToken. Returns { ok:true, manifest } after streaming the answer, or { ok:false, error }
   * WITHOUT having streamed anything (so the caller can offer the normal model honestly).
   */
  async function run({ question, history = [], contextBlock = "", personaStyle = "", onToken, working = () => {}, signal, isAborted = () => false, plan: suppliedPlan = null }) {
    const t0 = Date.now();
    const manifest = { mode: "single", parts: 0, stages: [], notes: [], models: [], ms: 0, costUsd: 0 };
    // A caller-supplied split (a blueprint's fan-out lanes). Malformed input falls through to the
    // normal orchestrator path rather than failing the turn, and either outcome is announced.
    const supplied = suppliedPlan ? normalizePlan(suppliedPlan) : null;
    if (suppliedPlan && !supplied) manifest.notes.push("a supplied plan was rejected as malformed; the orchestrator planned this turn instead");
    const context = historyTail(history);
    const preamble = [
      ...(personaStyle ? [{ role: "system", content: personaStyle }] : []),
      ...(contextBlock ? [{ role: "system", content: contextBlock }] : []),
    ];

    // 1. ASSESS. The heuristic answers the easy cases for free; the light seat gets the rest.
    // "When appropriate" is this gate: a two-line question never convenes a war council.
    let complex = false;
    if (supplied) {
      // The caller already decided this splits, and how. Sizing it up again spends a seat call to
      // reopen a settled question.
      complex = true;
      manifest.notes.push("plan supplied by the caller (" + supplied.length + " parts); no sizing or orchestrator seat was called");
    } else if (!isSimple(question) && question.length > 160) {
      working("battalion: sizing up the job");
      const a = await seat(roster.assess, [
        { role: "system", content: "Classify the user's request. Reply with EXACTLY one word: SIMPLE if one model should answer it directly, COMPLEX if it is large enough to split between several models (multi-part builds, long documents, multi-file code, broad research)." },
        ...context.slice(-4),
        { role: "user", content: question.slice(0, 4000) },
      ], { tokens: 2500, signal });
      complex = a.ok ? /COMPLEX/i.test(String(a.content || "")) : question.length > 800;
      manifest.stages.push({ stage: "assess", seat: roster.assess, ms: a.ms, ok: !!a.ok });
    }

    // 2-4. SWARM (or the single seat).
    if (complex && !isAborted()) {
      // A supplied plan skips this entirely: no orchestrator seat, no JSON to recover from prose.
      let parts = supplied;
      if (!parts) {
        working("battalion: drawing the plan");
        const plan = await seat(roster.orchestrator, [
          { role: "system", content: "You are the BATTALION orchestrator. Split the user's request into " + PART_MIN + "-" + PART_MAX + " independent parts that different models can work IN PARALLEL without coordinating. Parts must not overlap. Reply with ONLY JSON: {\"parts\":[{\"title\":\"...\",\"instructions\":\"complete standalone instructions for that part\"}]}. If the request genuinely should not be split, reply {\"parts\":[]}." },
          ...preamble,
          ...context,
          { role: "user", content: question },
        ], { tokens: PLAN_TOKENS, signal });
        manifest.stages.push({ stage: "plan", seat: roster.orchestrator, ms: plan.ms, ok: !!plan.ok });
        const parsed = plan.ok ? extractPlan(plan.content) : null;
        parts = parsed && parsed.parts.length >= PART_MIN ? parsed.parts : null;
        if (!parts) manifest.notes.push(plan.ok ? "orchestrator chose not to split; single seat answered" : "orchestrator unreachable; single seat answered");
      }

      if (parts && !isAborted()) {
        manifest.mode = "swarm";
        manifest.parts = parts.length;
        working("battalion: " + parts.length + " models working in parallel");
        const partCtx = [...preamble, ...context, { role: "user", content: "THE FULL REQUEST (for context; you handle only your part):\n" + question }];
        const results = await Promise.all(parts.map((p, i) => runPart(p, i, partCtx, roster.workers, signal, manifest)));
        const good = results.filter(Boolean);
        if (good.length && !isAborted()) {
          // 4. SYNTHESIZE, streaming: this stage IS the visible answer.
          working("battalion: merging " + good.length + " parts");
          const synth = await seat(roster.synthesizer, [
            { role: "system", content: "You are the BATTALION editor. Merge the specialists' parts into ONE complete, coherent answer in a single voice: resolve overlaps, reconcile interfaces and terminology, keep every substantive detail, add nothing false. Never mention the parts, the specialists, or this process." },
            ...preamble,
            { role: "user", content: "THE REQUEST:\n" + question + "\n\n" + good.map((g, i) => "=== PART " + (i + 1) + ": " + g.title + " ===\n" + g.text).join("\n\n") },
          ], { tokens: SYNTH_TOKENS, onDelta: onToken, signal });
          manifest.stages.push({ stage: "synthesize", seat: roster.synthesizer, ms: synth.ms, ok: !!synth.ok });
          if (synth.ok && String(synth.content || "").trim()) {
            manifest.models = seatsUsed(manifest); manifest.ms = Date.now() - t0;
            return { ok: true, manifest, content: synth.content };
          }
          // Synthesis died: the parts still exist — deliver them as honest sections, announced.
          manifest.notes.push("synthesis seat failed; parts delivered as sections");
          const stitched = good.map((g) => "## " + g.title + "\n\n" + g.text).join("\n\n");
          onToken && onToken(stitched);
          manifest.models = seatsUsed(manifest); manifest.ms = Date.now() - t0;
          return { ok: true, manifest, content: stitched };
        }
        if (!good.length) manifest.notes.push("every part failed; single seat answered instead");
      }
    }

    // SINGLE: one strong free seat, streaming, with one announced replacement.
    if (isAborted()) return { ok: false, error: "stopped" };
    manifest.mode = manifest.mode === "swarm" ? "single (swarm fell through)" : "single";
    working("battalion: answering");
    const msgs = [...preamble, ...context, { role: "user", content: question }];
    let r = await seat(roster.single, msgs, { tokens: SYNTH_TOKENS, onDelta: onToken, signal });
    manifest.stages.push({ stage: "answer", seat: roster.single, ms: r.ms, ok: !!r.ok });
    if (!r.ok || !String(r.content || "").trim()) {
      const backup = roster.workers.find((w) => w !== roster.single) || roster.orchestrator;
      log("battalion: single seat failed (" + String(r.error || "empty").slice(0, 80) + ") — replacing with " + backup);
      r = await seat(backup, msgs, { tokens: SYNTH_TOKENS, onDelta: onToken, signal });
      manifest.stages.push({ stage: "answer", seat: backup, ms: r.ms, ok: !!r.ok, replaced: roster.single });
      manifest.notes.push("answer seat " + roster.single + " failed; " + backup + " took it over");
    }
    if (!r.ok || !String(r.content || "").trim()) {
      // The free lane is down entirely. Say so; the server offers the user's normal model.
      return { ok: false, error: String(r.error || "the free lane returned nothing"), manifest };
    }
    manifest.models = seatsUsed(manifest); manifest.ms = Date.now() - t0;
    return { ok: true, manifest, content: r.content };
  }

  return { run };
}
