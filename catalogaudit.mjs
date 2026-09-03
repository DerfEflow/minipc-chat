/*
 * Catalog audit core — shared by the CLI (tools_audit.mjs) and the server's boot/hourly self-check.
 * Verifies the model catalog against LIVE provider data instead of trusting labels:
 *   - OpenRouter models: id exists, tool support matches toolCapable, context drift.
 *   - Direct models (openai/anthropic/deepseek): the directId exists on that provider's model list.
 *   - NVIDIA models: BOTH the list check above AND a real chat-completion invocation (see
 *     probeNvidiaChatLive below) — see that function's header for why presence alone is a lie here.
 * Everything is best-effort per provider: a missing key or a network failure marks that provider
 * "unchecked" rather than failing the audit. PROBLEMS (mislabel / dead id) flip ok=false — those are
 * the classes that throw errors in a guest's face. Every model that fails EITHER check lands in
 * `result.unavailable` (id -> reason), which server.mjs hands to models.catalog.mjs's
 * setUnavailableSeats() so /api/models can hide it and a request-time caller can resolve its
 * fallback (STABILIZE Step 1, 2026-09-03, deficiency #3-#5).
 *
 * DEBOUNCE (added 2026-09-03, lead review follow-up on Step 1's first live rig proof). The live
 * NVIDIA probe hid two seats it should not have on that first rig run:
 *   - nvidia/nemotron-3-nano-omni-30b-a3b on a single transient HTTP 503 "ResourceExhausted" —
 *     a rate-limit blip, not a dead seat.
 *   - nvidia/nemotron-3-ultra-550b-a55b on the flat 20s probe timeout, though it is a 550B
 *     reasoning model that legitimately answers in 50-57s.
 * Fixes, both load-bearing for the NVIDIA live-probe path only (list-based dead-id checks for
 * every OTHER provider are unaffected — that signal has never been observed to flap):
 *   1. A seat only flips to `unavailable` after 2 CONSECUTIVE failed probes, tracked in
 *      `result.failCounts` (id -> consecutive-failure count), persisted in catalog-audit.json by
 *      server.mjs so a restart does not reset the count back to zero. A single failure (including a
 *      5xx "resource exhausted" — deliberately NOT special-cased to skip the debounce; it counts as
 *      one ordinary strike toward the two required, same as any other failure shape) lands in
 *      `result.notes` as a warning, not `result.unavailable`.
 *   2. One success immediately restores a seat and zeroes its counter — no debounce on the way back
 *      up, only on the way down.
 *   3. The probe timeout is 60s for a seat the catalog flags `slow: true` (models.catalog.mjs:
 *      nvidia/nemotron-3-ultra-550b-a55b, deepseek/deepseek-r1, arcee-ai/trinity-large-thinking —
 *      the last two are not NVIDIA-provider so this only actually changes ultra-550b's behavior
 *      today, but all three are flagged for when/if live-probing ever widens past NVIDIA) and 20s
 *      otherwise.
 *   4. `opts.onlyIds` restricts the per-model loop to a specific id list — server.mjs uses this for
 *      a 10-MINUTE reprobe of only the seats currently marked unavailable, instead of making every
 *      seat wait out the full hourly cycle to recover. `result.unavailable`/`result.failCounts` are
 *      seeded from `opts.priorUnavailable`/`opts.priorFailCounts` so a run that does not visit a
 *      given id (onlyIds excludes it, or that id's provider could not be checked this pass) leaves
 *      its prior status untouched rather than silently clearing or reasserting it.
 */
import { MODELS, modelById, TENANT_DEFAULT_MODEL, DEFAULT_MODEL, UTILITY_MODEL } from "./models.catalog.mjs";

const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

async function listOpenRouter(orKey) {
  const r = await fetch("https://openrouter.ai/api/v1/models", { headers: { ...UA, ...(orKey ? { authorization: "Bearer " + orKey } : {}) } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return new Map(((await r.json()).data || []).map((m) => [m.id, m]));
}
async function listDirect(provider, keys) {
  if (provider === "openai") {
    if (!keys.openai) return null;
    const r = await fetch("https://api.openai.com/v1/models", { headers: { authorization: "Bearer " + keys.openai } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return new Set(((await r.json()).data || []).map((m) => m.id));
  }
  if (provider === "anthropic") {
    if (!keys.anthropic) return null;
    const r = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": keys.anthropic, "anthropic-version": "2023-06-01" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return new Set(((await r.json()).data || []).map((m) => m.id));
  }
  if (provider === "deepseek") {
    if (!keys.deepseek) return null;
    const r = await fetch("https://api.deepseek.com/models", { headers: { authorization: "Bearer " + keys.deepseek } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return new Set(((await r.json()).data || []).map((m) => m.id));
  }
  /*
   * NVIDIA (added 2026-08-03). The lane was invisible to this audit: nvidia-provider models fell
   * into the direct branch, found no set for their provider, and were skipped silently. That is how
   * a whole free fleet shipped unaudited. Shape verified live 2026-08-03: OpenAI-compatible
   * /v1/models returning {data:[{id}]}, 102 models on the developer tier.
   */
  if (provider === "nvidia") {
    if (!keys.nvidia) return null;
    const r = await fetch("https://integrate.api.nvidia.com/v1/models", { headers: { authorization: "Bearer " + keys.nvidia } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return new Set(((await r.json()).data || []).map((m) => m.id));
  }
  /*
   * Google AI Studio (added 2026-08-03, VERIFIED LIVE the same day once Fred minted
   * GOOGLE_AI_STUDIO_API_KEY: 116 models parsed). Generative Language returns names as
   * "models/<id>"; both forms are accepted. Still fails SAFE: an unexpected body yields an empty
   * set, which throws and marks the provider "unchecked" rather than declaring models dead.
   */
  if (provider === "google") {
    if (!keys.google) return null;
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=" + encodeURIComponent(keys.google));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const body = await r.json();
    const list = Array.isArray(body.models) ? body.models : [];
    const ids = new Set();
    for (const m of list) {
      const n = String(m && m.name || "").trim();
      if (!n) continue;
      ids.add(n);
      if (n.startsWith("models/")) ids.add(n.slice(7));
    }
    if (!ids.size) throw new Error("no models parsed (response shape may have changed)");
    return ids;
  }
  return null;
}

/*
 * NVIDIA LIVE CHAT PROBE (STABILIZE Step 1, 2026-09-03, deficiency #1-#5).
 *
 * Presence in NVIDIA's /v1/models list is NOT proof a seat answers — measured fact, not a guess:
 * three seats (z-ai/glm-5.2, nvidia/nemotron-nano-12b-v2-vl, meta/llama-3.1-70b-instruct) served
 * HTTP 410 "has reached its end of life" while (at the time) still appearing on the list, and
 * nvidia/nemotron-3.5-content-safety is STILL on the list today and returns HTTP 200 to an
 * ordinary chat turn — but the 200 carries "Conversation roles must alternate user/assistant/..."
 * as the answer, because it is a moderation classifier, not a chat model. A presence check sees
 * three of those four as fine. Only an actual invocation catches all four, which is why this file
 * now sends one alongside the list check, for every NVIDIA-provider seat, every audit run.
 *
 * Kept to NVIDIA on purpose: it is the one provider with a documented listed-but-dead trap (this
 * comment, and docs/SIMPLIFY-ROUTING-TABLE.md section 1: "being on that list does NOT mean the
 * account can invoke it"). OpenAI/Anthropic/DeepSeek/Google have no such history in this codebase;
 * adding a live-invoke probe for them would be four more live calls a run for a problem nobody has
 * measured. Revisit if one of them ever shows the same symptom.
 *
 * Timeout mirrors simplify.mjs's own first-token budget (20s) rather than a fresh number: the
 * documented minimax-m3 hang was 150s+, so 20s is already enough to call it dead without the
 * hourly audit itself hanging for minutes on one bad seat.
 *
 * STREAMING, not stream:false (changed same day, live-measured). A non-streaming probe of
 * nvidia/nemotron-3.5-content-safety came back {ok:true} three times in a row (plain "OK", every
 * time) while specs/seat_sweep.mjs, run minutes later against the SAME key through the real /chat
 * pipeline (which streams, temperature:0, exactly like every other Simplify/chat call), hit the
 * documented "Conversation roles must alternate..." failure on that same seat. Re-probing with
 * stream:true + temperature:0 reproduces the failure path the real traffic actually takes; a
 * non-streaming probe was measurably not proof of streaming liveness for this classifier model.
 * Kept as an SSE reader here (own client, not openAiCompatStream) to avoid pulling a second file
 * into this lane's ownership boundary for one probe function.
 */
// Exported (not just const) so tests can assert on the exact numbers without waiting them out.
export const NVIDIA_PROBE_TIMEOUT_MS = 20000;
export const NVIDIA_PROBE_TIMEOUT_MS_SLOW = 60000;   // catalog-flagged slow/reasoning seats (see header)
export const NVIDIA_UNAVAILABLE_STRIKES = 2;          // consecutive failed probes before a seat is hidden
const NVIDIA_PROBE_BAD_CONTENT_RE = /must alternate|invalid.{0,20}role|unsupported.{0,20}conversation|content.{0,10}safety.{0,10}(model|classifier)/i;

export async function probeNvidiaChatLive(directId, url, key, timeoutMs = NVIDIA_PROBE_TIMEOUT_MS) {
  if (!key) return { ok: false, unchecked: true, reason: "no key" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({ model: directId, messages: [{ role: "user", content: "Reply with exactly the word OK and nothing else." }], max_tokens: 16, temperature: 0, stream: true }),
      signal: ac.signal,
    });
    if (!r.ok) {
      let text = ""; try { text = (await r.text()).slice(0, 200); } catch {}
      return { ok: false, reason: `HTTP ${r.status}${text ? ": " + text : ""}` };
    }
    if (!r.body) return { ok: false, reason: "response had no body" };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", content = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (!data || data === "[DONE]") continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        if (ev && ev.error) return { ok: false, reason: String((ev.error && ev.error.message) || ev.error).slice(0, 200) };
        const delta = ev && ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content;
        if (delta) content += delta;
      }
    }
    content = content.trim();
    if (!content) return { ok: false, reason: "empty response (no content returned)" };
    if (NVIDIA_PROBE_BAD_CONTENT_RE.test(content)) return { ok: false, reason: content.slice(0, 200) };
    return { ok: true };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
    return { ok: false, reason: aborted ? `no response within ${timeoutMs}ms` : String((e && e.message) || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

// keys: { openrouter, openai, anthropic, deepseek, nvidia, google, nvidiaUrl } — pass what you
// have; missing = that check skipped. nvidiaUrl overrides the live chat-completions endpoint the
// probe posts to (tests point this at a local mock; production leaves it unset for the real one).
// opts.skipLiveProbe short-circuits the NVIDIA invocation pass — used by boot-time callers that
// want the (cheap, list-only) check immediately and the live probe on the next hourly run, and by
// tests that only care about the list-based checks. opts.onlyIds restricts the per-model loop to
// those catalog ids (the 10-minute unavailable-seat reprobe); opts.priorUnavailable/
// opts.priorFailCounts seed state so ids this run does not visit keep their last known status —
// see the DEBOUNCE section of this file's header comment.
export async function runCatalogAudit(keys = {}, opts = {}) {
  const priorUnavailable = opts.priorUnavailable || {};
  const priorFailCounts = opts.priorFailCounts || {};
  const onlyIds = opts.onlyIds ? new Set(opts.onlyIds) : null;
  const result = {
    checkedAt: new Date().toISOString(), ok: true, problems: [], notes: [], providers: {},
    unavailable: { ...priorUnavailable }, failCounts: { ...priorFailCounts },
  };

  let orLive = null;
  try { orLive = await listOpenRouter(keys.openrouter); result.providers.openrouter = "checked (" + orLive.size + " live models)"; }
  catch (e) { result.providers.openrouter = "unchecked: " + (e.message || e); }

  const directSets = {};
  for (const p of ["openai", "anthropic", "deepseek", "nvidia", "google"]) {
    try { const s = await listDirect(p, keys); directSets[p] = s; result.providers[p] = s ? "checked (" + s.size + " live models)" : "unchecked: no key"; }
    catch (e) { directSets[p] = null; result.providers[p] = "unchecked: " + (e.message || e); }
  }

  const nvidiaChatUrl = keys.nvidiaUrl || "https://integrate.api.nvidia.com/v1/chat/completions";

  for (const raw of MODELS) {
    const m = modelById(raw.id);
    if (onlyIds && !onlyIds.has(m.id)) continue;   // not visited this pass -- seeded state stands
    const special = [m.id === TENANT_DEFAULT_MODEL ? "GUEST-DEFAULT" : "", m.id === DEFAULT_MODEL ? "OWNER-DEFAULT" : "", m.id === UTILITY_MODEL ? "UTILITY" : ""].filter(Boolean).join("+");
    let deadByList = false;
    if (m.provider === "openrouter") {
      if (!orLive) continue;   // list unchecked this pass -- leave seeded state untouched
      const l = orLive.get(m.id);
      if (!l) { result.ok = false; result.problems.push({ kind: "dead-id", id: m.id, note: "not on OpenRouter; every call 404s" + (special ? " · " + special : "") }); result.unavailable[m.id] = "not on OpenRouter"; continue; }
      delete result.unavailable[m.id];   // confirmed present -- no debounce on OpenRouter's own check
      const supportsTools = (l.supported_parameters || []).includes("tools");
      if (m.toolCapable && !supportsTools) { result.ok = false; result.problems.push({ kind: "mislabel", id: m.id, note: "flagged tool-capable but no OpenRouter endpoint supports tools" + (special ? " · " + special : "") }); }
      else if (!m.toolCapable && supportsTools) result.notes.push({ kind: "undersell", id: m.id, note: "supports tools but flagged chat-only" });
      // Vision drift, same discipline as tools: a wrong TRUE throws provider errors in a guest's
      // face (problem); a wrong FALSE just hides a capability (note). Direct providers are not
      // governed by OpenRouter data, so this check applies to openrouter-routed models only.
      const supportsImages = ((l.architecture && l.architecture.input_modalities) || []).includes("image");
      if (m.vision && !supportsImages) { result.ok = false; result.problems.push({ kind: "vision-mislabel", id: m.id, note: "flagged vision but OpenRouter reports no image input" + (special ? " · " + special : "") }); }
      else if (!m.vision && supportsImages) result.notes.push({ kind: "vision-undersell", id: m.id, note: "accepts image input but not flagged vision" });
      /*
       * Context drift is ASYMMETRIC and used to be reported as if it were not (fixed 2026-08-03).
       * server.mjs sets contextTokens from the catalog figure and the compactor targets about half
       * of it, so a catalog that OVERCLAIMS hands the model more history than it can hold and the
       * provider rejects the call. That is a launch-day problem. A catalog that UNDERCLAIMS merely
       * wastes window, which is a note. Found by qwen3-coder: catalog 1000000, live 262144, so
       * long repo work was being handed roughly 512k tokens against a real 262k ceiling.
       */
      const liveCtx = l.context_length || 0;
      if (m.ctx && liveCtx) {
        if (m.ctx > liveCtx * 1.1) {
          result.ok = false;
          result.problems.push({ kind: "ctx-overclaim", id: m.id, note: `catalog ${m.ctx} vs live ${liveCtx}; the history budget is sized from the catalog, so long turns overflow` + (special ? " · " + special : "") });
        } else if (liveCtx > m.ctx * 1.5) {
          result.notes.push({ kind: "ctx-underclaim", id: m.id, note: `catalog ${m.ctx} vs live ${liveCtx}; safe, but window is being wasted` });
        }
      }
    } else {
      const s = directSets[m.provider];
      if (s) {
        if (!s.has(m.directId)) {
          result.ok = false; deadByList = true;
          const reason = `directId '${m.directId}' not on ${m.provider}`;
          result.problems.push({ kind: "dead-id", id: m.id, note: reason + (special ? " · " + special : "") });
          result.unavailable[m.id] = reason;
          result.failCounts[m.id] = 0;
        } else if (m.provider !== "nvidia") {
          // Non-NVIDIA direct providers have no live-probe/debounce layer below: list presence IS
          // the whole check, so passing it clears a stale mark immediately, same as before this
          // pass. NVIDIA deliberately does NOT clear here -- the live probe below is the sole
          // authority on an NVIDIA seat (that is the entire reason it exists: list presence is not
          // proof of liveness), and skipping the clear here also means a skipLiveProbe pass
          // (server.mjs's fast boot check) cannot accidentally un-hide a seat only a live probe
          // ever condemned.
          delete result.unavailable[m.id];
        }
      }
      // s === null: this provider's list wasn't checked this pass (no key, or a network failure)
      // -- leave whatever was seeded from opts.priorUnavailable/opts.priorFailCounts untouched.
    }
    // The live invocation pass: NVIDIA only (see probeNvidiaChatLive's header), skipped when the
    // list check already proved the id dead (no need to spend a second call finding that out
    // again), when there is no key (nothing to call with), or when the caller asked to skip it.
    if (m.provider === "nvidia" && keys.nvidia && !deadByList && !opts.skipLiveProbe) {
      const timeoutMs = opts.nvidiaProbeTimeoutMs != null ? opts.nvidiaProbeTimeoutMs : (m.slow ? NVIDIA_PROBE_TIMEOUT_MS_SLOW : NVIDIA_PROBE_TIMEOUT_MS);
      const probe = await probeNvidiaChatLive(m.directId, nvidiaChatUrl, keys.nvidia, timeoutMs);
      if (!probe.unchecked) {
        if (probe.ok) {
          if (result.unavailable[m.id]) {
            delete result.unavailable[m.id];
            result.notes.push({ kind: "restored", id: m.id, note: "live chat probe succeeded; seat restored" + (special ? " · " + special : "") });
          }
          result.failCounts[m.id] = 0;   // restored on the first success -- no debounce on the way up
        } else {
          const newCount = (result.failCounts[m.id] || 0) + 1;
          result.failCounts[m.id] = newCount;
          if (newCount >= NVIDIA_UNAVAILABLE_STRIKES) {
            result.ok = false;
            result.problems.push({ kind: "unavailable", id: m.id, note: `live chat probe failed ${newCount}x consecutively: ${probe.reason}` + (special ? " · " + special : "") });
            result.unavailable[m.id] = probe.reason;
          } else {
            result.notes.push({ kind: "probe-warn", id: m.id, note: `live chat probe failed (${newCount}/${NVIDIA_UNAVAILABLE_STRIKES} consecutive), not yet hidden: ${probe.reason}` + (special ? " · " + special : "") });
          }
        }
      }
    }
  }
  return result;
}
