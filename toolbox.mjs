/*
 * A tiny, always-visible loader for tool-capable cloud models.
 *
 * The model starts with the tools most relevant to the turn. If that focused bench is missing a
 * capability, toolbox_open can add matching schemas for the next agent round. The expanded schemas
 * live only for this turn, so they disappear automatically when the turn ends.
 */
export const TOOLBOX_OPEN_NAME = "toolbox_open";
export const TOOLBOX_OPEN_DEF = {
  type: "function",
  function: {
    name: TOOLBOX_OPEN_NAME,
    description:
      "Open Dominion's tool cabinet when the tool you need is not currently available. " +
      "Request exact tool names when known, or describe the missing capability in query. " +
      "Matching tools are loaded for the next work round only; then call the newly loaded tool.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What capability is missing, such as 'Google Drive search', 'PDF export', or 'desktop screenshot'." },
        tools: { type: "array", items: { type: "string" }, description: "Optional exact tool names to load." },
      },
    },
  },
};

const nameOf = (d) => String(d && d.function && d.function.name || "");
const searchable = (d) => `${nameOf(d)} ${d && d.function && d.function.description || ""}`.toLowerCase();

export function withToolbox(defs) {
  const rest = (defs || []).filter((d) => nameOf(d) !== TOOLBOX_OPEN_NAME);
  return [TOOLBOX_OPEN_DEF, ...rest];
}

/*
 * The provider tool-count ceiling (OpenAI enforces exactly 128 today; other providers may grow one
 * of their own later, hence the caller-supplied `limit`). This app's OWN tools — everything not
 * carrying the connector "cx_" prefix, which already includes toolbox_open and the internal
 * task_complete bookkeeping tool — are NEVER shed: the needs_*-gated / route-scoped selection that
 * built this list upstream already decided they belong. Only when even the connector overflow can't
 * fit does anything get cut, and what gets cut is the LEAST relevant to this turn's ask (the same
 * name/description overlap scoring openToolbox already uses for its on-demand loads), not a blind
 * alphabetical tail. Never mutates its input; returns a NEW array plus what it left out, named, so a
 * caller can say out loud what did not make the cut instead of a silently thinner toolbox.
 */
export function capToolsToLimit(defs, { limit, query = "" } = {}) {
  const list = Array.isArray(defs) ? defs : [];
  if (!Number.isFinite(limit) || list.length <= limit) return { tools: list, dropped: 0, droppedNames: [] };
  const isCore = (d) => { const n = nameOf(d); return !!n && !n.startsWith("cx_"); };
  const core = list.filter(isCore);
  const connectorPool = list.filter((d) => !isCore(d));
  let kept;
  if (core.length <= limit) {
    const room = limit - core.length;
    // A full RANK, not a filtered match set: openToolbox drops anything scoring 0 (correct for its
    // own job — don't load a schema nobody asked for), but here every slot up to `room` must be
    // filled regardless of relevance; the score only decides WHICH ones win a scarce seat. Ties keep
    // original order, so behavior is unchanged for a query that matches nothing at all.
    const words = String(query || "").toLowerCase().match(/[a-z0-9_-]{2,}/g) || [];
    const ranked = connectorPool
      .map((d, index) => {
        const haystack = searchable(d);
        const score = words.reduce((n, w) => n + (haystack.includes(w) ? (nameOf(d).toLowerCase().includes(w) ? 8 : 2) : 0), 0);
        return { d, index, score };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, Math.max(0, room))
      .map((x) => x.d);
    kept = [...core, ...ranked];
  } else {
    kept = core.slice(0, Math.max(0, limit));   // even this app's own tools alone overflow the cap
  }
  const keptSet = new Set(kept);
  const droppedNames = list.filter((d) => !keptSet.has(d)).map(nameOf).filter(Boolean);
  return { tools: kept, dropped: list.length - kept.length, droppedNames };
}

export function openToolbox(allDefs, currentDefs, args = {}, capacity = 12) {
  const current = new Set((currentDefs || []).map(nameOf));
  const exact = new Set((Array.isArray(args.tools) ? args.tools : []).map((s) => String(s).trim()).filter(Boolean));
  const words = String(args.query || "").toLowerCase().match(/[a-z0-9_-]{2,}/g) || [];
  const candidates = (allDefs || [])
    .filter((d) => {
      const name = nameOf(d);
      return name && name !== TOOLBOX_OPEN_NAME && !current.has(name);
    })
    .map((d, index) => {
      const name = nameOf(d);
      const haystack = searchable(d);
      const exactScore = exact.has(name) ? 1000 : 0;
      const wordScore = words.reduce((n, w) => n + (haystack.includes(w) ? (name.toLowerCase().includes(w) ? 8 : 2) : 0), 0);
      return { d, name, index, score: exactScore + wordScore };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, capacity));
  return { defs: candidates.map((x) => x.d), names: candidates.map((x) => x.name) };
}
