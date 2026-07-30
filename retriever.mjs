// Free retrieval stack (ARSENAL Wave 5): NVIDIA's free embedding + reranking models as the
// precision layer over the app's retrieval, with the local Ollama path as the offline fallback.
// Zero-dep, same discipline as every provider wire: live-probed facts only, graceful null on any
// failure so retrieval NEVER blocks on a cloud call.
//
// Probed 2026-07-30 (embed_rerank_probe.mjs / rerank_probe2.mjs, committed):
//   EMBED  nvidia/nemotron-3-embed-1b  · integrate.api.nvidia.com/v1/embeddings · 2048 dims ·
//          REQUIRES input_type ("query" | "passage") — the retrieval-tuned asymmetry is real.
//   RERANK nvidia/llama-nemotron-rerank-1b-v2 ·
//          ai.api.nvidia.com/v1/retrieval/nvidia/llama-nemotron-rerank-1b-v2/reranking ·
//          {model, query:{text}, passages:[{text}]} -> {rankings:[{index, logit}]} sorted desc.
//          (The 2024-era rerank slugs are EOL: 410 Gone since 2026-05-18. Weekly audit re-checks.)
// Both lanes are $0 transport on the developer program.

const EMBED_MODEL = "nvidia/nemotron-3-embed-1b";
const RERANK_MODEL = "nvidia/llama-nemotron-rerank-1b-v2";
const PASSAGE_MAX_CHARS = 1800;   // reranker context guard per passage
const PASSAGE_MAX_COUNT = 64;     // sanity cap; callers send dozens at most

export function createFreeRetriever(opts = {}) {
  const key = typeof opts.key === "function" ? opts.key : () => "";
  const embedBase = (opts.embedBase || "https://integrate.api.nvidia.com").replace(/\/$/, "");
  const rerankUrl = opts.rerankUrl || ("https://ai.api.nvidia.com/v1/retrieval/" + RERANK_MODEL + "/reranking");
  const log = typeof opts.log === "function" ? opts.log : () => {};

  const available = () => !!key();

  // One text -> one vector in the nemotron-3-embed space (2048 dims), or null on ANY failure.
  // input_type matters: "query" for the question side, "passage" for stored content.
  async function embed(text, { inputType = "passage", timeoutMs = 20000 } = {}) {
    if (!key()) return null;
    try {
      const r = await fetch(embedBase + "/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer " + key(), "content-type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: [String(text || "").slice(0, 2000)], input_type: inputType }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status !== 200) return null;
      const j = await r.json();
      const v = j.data && j.data[0] && j.data[0].embedding;
      return Array.isArray(v) && v.length ? v : null;
    } catch { return null; }
  }

  // Score (query, passages) pairs. Returns [{index, logit}] sorted best-first, or null on ANY
  // failure — the caller keeps its original ordering, so a cloud hiccup costs precision, never
  // availability.
  async function rerank(query, passages, { timeoutMs = 12000 } = {}) {
    if (!key()) return null;
    const q = String(query || "").trim().slice(0, 2000);
    const list = (Array.isArray(passages) ? passages : []).slice(0, PASSAGE_MAX_COUNT)
      .map((t) => ({ text: String(t || "").slice(0, PASSAGE_MAX_CHARS) }));
    if (!q || list.length < 2) return null;   // nothing to reorder
    try {
      const r = await fetch(rerankUrl, {
        method: "POST",
        headers: { authorization: "Bearer " + key(), "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model: RERANK_MODEL, query: { text: q }, passages: list }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status !== 200) return null;
      const j = await r.json();
      if (!Array.isArray(j.rankings) || !j.rankings.length) return null;
      const rankings = j.rankings
        .filter((x) => Number.isInteger(x.index) && x.index >= 0 && x.index < list.length)
        .sort((a, b) => (b.logit ?? 0) - (a.logit ?? 0));
      return rankings.length ? rankings : null;
    } catch (e) { log("retriever: rerank failed: " + String(e && e.message || e).slice(0, 80)); return null; }
  }

  return { available, embed, rerank, embedModel: EMBED_MODEL, rerankModel: RERANK_MODEL };
}

// Pure helper: apply a rerank verdict to a candidate list. `rankings` is the [{index, logit}]
// array (already best-first) FROM rerank() over textOf(items[i]); returns the items reordered,
// cut to `take`. A null/short verdict returns the original order cut to `take` — identical to
// the pre-Wave-5 behavior, which is the whole fallback contract.
export function applyRerank(items, rankings, take) {
  const n = Math.max(0, take | 0) || items.length;
  if (!Array.isArray(rankings) || !rankings.length) return items.slice(0, n);
  const seen = new Set();
  const out = [];
  for (const r of rankings) {
    if (seen.has(r.index) || !items[r.index]) continue;
    seen.add(r.index);
    out.push(items[r.index]);
    if (out.length >= n) return out;
  }
  // Anything the verdict didn't cover keeps its original relative order at the tail.
  for (let i = 0; i < items.length && out.length < n; i++) if (!seen.has(i)) out.push(items[i]);
  return out;
}
