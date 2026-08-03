/*
 * Catalog audit core — shared by the CLI (tools_audit.mjs) and the server's weekly self-check.
 * Verifies the model catalog against LIVE provider data instead of trusting labels:
 *   - OpenRouter models: id exists, tool support matches toolCapable, context drift.
 *   - Direct models (openai/anthropic/deepseek): the directId exists on that provider's model list.
 * Everything is best-effort per provider: a missing key or a network failure marks that provider
 * "unchecked" rather than failing the audit. Only PROBLEMS (mislabel / dead id) flip ok=false —
 * those are the two classes that throw errors in a guest's face.
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
   * Google AI Studio (added 2026-08-03). UNVERIFIED SHAPE: no AI Studio key existed when this was
   * written, so the parse below has never seen a real response. It is written to fail SAFE — an
   * unexpected body yields an empty set, which throws here and marks the provider "unchecked"
   * rather than declaring every Google model dead. Confirm against a live call the moment a key
   * lands, and delete this warning when it has actually run.
   * Generative Language returns names as "models/<id>"; both forms are accepted.
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

// keys: { openrouter, openai, anthropic, deepseek, nvidia, google } — pass what you have; missing = that check skipped.
export async function runCatalogAudit(keys = {}) {
  const result = { checkedAt: new Date().toISOString(), ok: true, problems: [], notes: [], providers: {} };

  let orLive = null;
  try { orLive = await listOpenRouter(keys.openrouter); result.providers.openrouter = "checked (" + orLive.size + " live models)"; }
  catch (e) { result.providers.openrouter = "unchecked: " + (e.message || e); }

  const directSets = {};
  for (const p of ["openai", "anthropic", "deepseek", "nvidia", "google"]) {
    try { const s = await listDirect(p, keys); directSets[p] = s; result.providers[p] = s ? "checked (" + s.size + " live models)" : "unchecked: no key"; }
    catch (e) { directSets[p] = null; result.providers[p] = "unchecked: " + (e.message || e); }
  }

  for (const raw of MODELS) {
    const m = modelById(raw.id);
    const special = [m.id === TENANT_DEFAULT_MODEL ? "GUEST-DEFAULT" : "", m.id === DEFAULT_MODEL ? "OWNER-DEFAULT" : "", m.id === UTILITY_MODEL ? "UTILITY" : ""].filter(Boolean).join("+");
    if (m.provider === "openrouter") {
      if (!orLive) continue;
      const l = orLive.get(m.id);
      if (!l) { result.ok = false; result.problems.push({ kind: "dead-id", id: m.id, note: "not on OpenRouter; every call 404s" + (special ? " · " + special : "") }); continue; }
      const supportsTools = (l.supported_parameters || []).includes("tools");
      if (m.toolCapable && !supportsTools) { result.ok = false; result.problems.push({ kind: "mislabel", id: m.id, note: "flagged tool-capable but no OpenRouter endpoint supports tools" + (special ? " · " + special : "") }); }
      else if (!m.toolCapable && supportsTools) result.notes.push({ kind: "undersell", id: m.id, note: "supports tools but flagged chat-only" });
      // Vision drift, same discipline as tools: a wrong TRUE throws provider errors in a guest's
      // face (problem); a wrong FALSE just hides a capability (note). Direct providers are not
      // governed by OpenRouter data, so this check applies to openrouter-routed models only.
      const supportsImages = ((l.architecture && l.architecture.input_modalities) || []).includes("image");
      if (m.vision && !supportsImages) { result.ok = false; result.problems.push({ kind: "vision-mislabel", id: m.id, note: "flagged vision but OpenRouter reports no image input" + (special ? " · " + special : "") }); }
      else if (!m.vision && supportsImages) result.notes.push({ kind: "vision-undersell", id: m.id, note: "accepts image input but not flagged vision" });
      const liveCtx = l.context_length || 0;
      if (m.ctx && liveCtx && Math.abs(m.ctx - liveCtx) / liveCtx > 0.5) result.notes.push({ kind: "ctx-drift", id: m.id, note: `catalog ${m.ctx} vs live ${liveCtx}` });
    } else {
      const s = directSets[m.provider];
      if (!s) continue;   // unchecked provider
      if (!s.has(m.directId)) { result.ok = false; result.problems.push({ kind: "dead-id", id: m.id, note: `directId '${m.directId}' not on ${m.provider}` + (special ? " · " + special : "") }); }
    }
  }
  return result;
}
