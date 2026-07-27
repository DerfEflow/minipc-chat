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
