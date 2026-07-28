/*
 * Model-facing tool results must never end in a silent slice. Silent truncation hid forge_read's
 * next-offset footer and made capable models repeat the same read forever. Keep ordinary results
 * byte-for-byte; for genuinely large output preserve both the beginning and the actionable tail.
 */
export const TOOL_RESULT_LIMIT = 64_000;

export function modelToolResult(value, limit = TOOL_RESULT_LIMIT) {
  const text = String(value ?? "");
  const cap = Math.max(4_000, Math.floor(Number(limit) || TOOL_RESULT_LIMIT));
  if (text.length <= cap) return text;

  const tailSize = Math.min(12_000, Math.floor(cap * 0.3));
  const marker = [
    "",
    `[Dominion result window: ${text.length} characters total; the middle was omitted to fit the model context.]`,
    "[The beginning and end are preserved. Narrow the command or use the tool's offset/range arguments before acting on omitted content.]",
    "",
  ].join("\n");
  const headSize = Math.max(1, cap - tailSize - marker.length);
  return text.slice(0, headSize) + marker + text.slice(-tailSize);
}

export function toolResultFailed(value) {
  const text = String(value ?? "").trim();
  if (!text) return true;
  return /^(?:Tool .+ failed|Unknown tool|Unknown connector|Connector .+ (?:is not|not found)|Couldn't|I can read and plan|Memory isn't available|BLOCKED|REFUSED|CANCELLED|TIMED OUT|NO CHANGE\b|EDIT REFUSED\b|No response from the machine\b|No machine is connected\b|That machine is offline\b|hands node .+ is not connected\b|(?:Writing to|Editing a|Running commands on) a machine needs a connected\b|The bridge didn't answer\b|ERROR\b|\{\s*"(?:error|offline)"\s*:|exit\s+[1-9]\d*\b)/i.test(text) ||
    /\nexit\s+[1-9]\d*\b/i.test(text);
}

/*
 * A successful tool call is not necessarily a successful mutation. `forge_run`
 * deliberately appends "NO TRACKED CHANGE" to exit-zero tests and reads; treating
 * its dangerous permission class as edit evidence allowed a model to run `npm
 * test`, claim it had implemented the task, and pass the completion gate.
 *
 * These rules prefer observed/measured evidence. The only exception is a small
 * allow-list of recognizable external publish commands whose state change cannot
 * appear in a local git-byte comparison.
 */
function externalMutationEvidence(command, text) {
  if (/\bgit\s+push\b/i.test(command)) {
    return /(?:\[[^\]]+\]\s+|\b[0-9a-f]{4,}\.{2,3}[0-9a-f]{4,}\s+)[^\r\n]*->/i.test(text);
  }
  if (/\brailway\s+(?:up|deploy)\b/i.test(command)) {
    return /\b(?:deployment|deployed|uploaded|build logs?)\b|https:\/\/[^\s]*railway/i.test(text);
  }
  if (/\bvercel(?:\s+deploy|\s+--prod)\b/i.test(command)) {
    return /\b(?:production|deployed|deployment)\b|https:\/\/[^\s]*vercel/i.test(text);
  }
  if (/\bnpm\s+publish\b/i.test(command)) return /(?:^|\n)\+\s+\S+@\S+/m.test(text);
  if (/\bdocker\s+push\b/i.test(command)) return /\bdigest:\s*sha256:[0-9a-f]+/i.test(text);
  if (/\bgh\s+pr\s+create\b/i.test(command)) return /https:\/\/github\.com\/\S+\/pull\/\d+/i.test(text);
  if (/\bgh\s+pr\s+merge\b/i.test(command)) return /\b(?:merged|already merged)\b/i.test(text);
  return false;
}

export function toolMutationSucceeded(name, args, value, permissionClass = "") {
  const toolName = String(name || "");
  const text = String(value ?? "").trim();
  if (!toolName || toolResultFailed(text)) return false;

  if (toolName === "forge_write" || toolName === "forge_edit") {
    return /(?:^|\n)CHANGED:\s+/i.test(text);
  }
  if (toolName === "forge_run") {
    if (/(?:^|\n)CHANGE:\s+(?!UNKNOWN\b|NO\b)/i.test(text)) return true;
    const command = String(args && args.command || "");
    return /(?:^|\n)exit\s+0\b/i.test(text) && externalMutationEvidence(command, text);
  }
  if (toolName === "forge_rollback") {
    return !!(args && args.id) && !/\b(?:nothing|not found|no snapshot|refused|failed)\b/i.test(text);
  }
  if (toolName === "scaffold_project") return /\bScaffolded\s+[1-9]\d*\s+file\(s\)/i.test(text);
  if (toolName === "sandbox_write") return /^Wrote\s+\d+\s+bytes\b/i.test(text);
  if (toolName === "sandbox_append") return /^Appended\s+\d+\s+bytes\b/i.test(text);

  if (toolName === "browser_control") {
    // Read/elements/screenshot/tabs/eval/open/navigation do not prove that the
    // requested external state changed. A successful click/type is at least an
    // observed interaction, though the completion evidence must still cite it.
    return ["click", "type"].includes(String(args && args.op || "").toLowerCase());
  }
  if (toolName === "desktop_control") {
    return ["click", "type", "key"].includes(String(args && args.op || "").toLowerCase());
  }
  if (toolName === "long_job") {
    return ["create", "pause", "resume"].includes(String(args && args.action || "").toLowerCase());
  }

  const explicitMutationTools = new Set([
    "deck_capture", "deck_add_note", "deck_add_next_step", "deck_set_next_proof", "deck_create_project",
    "sandbox_write", "remember", "create_artifact", "save_plan", "revise_artifact",
    "export_artifact", "create_docx", "create_pdf", "create_spreadsheet", "sandbox_append",
    "update_memory", "save_lesson", "add_to_persona", "scrape_to_persona",
  ]);
  if (explicitMutationTools.has(toolName)) {
    return !/\b(?:already had|already exists|dedup|nothing changed|not available|couldn't|refused|blocked)\b/i.test(text);
  }

  // Connector schemas are discovered at runtime. Accept only tool names whose
  // action verb itself denotes a mutation; never infer mutation merely from the
  // connector's blanket confirmation permission.
  if (/^cx_/.test(toolName)) {
    const action = toolName.split("__").pop().toLowerCase();
    return /^(?:create|add|append|update|set|send|post|publish|upload|deploy|insert|delete|remove|archive|move|copy|rename|write|edit|execute|trigger|start|stop|cancel|merge|approve|reject)(?:_|$)/.test(action);
  }

  // Queuing work, running a computation, or holding a dangerous permission is
  // not proof that the requested build state changed.
  return false;
}
