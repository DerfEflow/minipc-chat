/*
 * Dominion AI — server-side tools ("the hands").
 *
 * These run on the mini-PC inside server.mjs, NOT in the browser, so SYNC_SECRET and the Forge
 * run-password never leave the box. The model (Qwen via Ollama) asks for a tool by name; the
 * agent loop in server.mjs calls runTool() here and feeds the result back to the model.
 *
 * Mirrors the Open WebUI tool surface (openwebui_tools.py) but in zero-dep Node:
 *   deck_*      -> read/append to the Command Deck portfolio (via the cloud /api/agent)
 *   forge_read  -> read files on Fred's machine through the bridge (READ-ONLY, under its roots)
 *   forge_send  -> queue a real code/file work order for Claude Code (GATED by the run-password)
 *   sandbox_*   -> a private read/write folder jailed on the mini-PC
 */
import http from "node:http";
import https from "node:https";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fetchUrl, htmlToText } from "./persona.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiny dependency-free HTTP(S) JSON request (handles both protocols; the cloud is https).
function request(method, url, headers = {}, body = null) {
  return new Promise((res) => {
    let u;
    try { u = new URL(url); } catch { return res({ status: 0, text: "bad url" }); }
    const mod = u.protocol === "https:" ? https : http;
    const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data != null) { if (!h["content-type"]) h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    const r = mod.request(
      { method, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, headers: h, timeout: 35000 },
      (resp) => { let buf = ""; resp.on("data", (d) => (buf += d)); resp.on("end", () => res({ status: resp.statusCode || 0, text: buf })); }
    );
    r.on("error", (e) => res({ status: 0, text: String(e.message) }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, text: "timeout" }); });
    if (data != null) r.write(data);
    r.end();
  });
}
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

// ---- Command Deck (cloud /api/agent) ----
async function agent(ctx, action, extra = {}) {
  if (!ctx.syncKey) return { error: "no SYNC_SECRET configured on the server" };
  const r = await request("POST", ctx.baseUrl + "/api/agent", { "x-sync-key": ctx.syncKey }, { action, ...extra });
  return parse(r.text) || { error: `HTTP ${r.status}: ${r.text.slice(0, 160)}` };
}

// ---- the bridge read API (read-only files on Fred's machine) ----
async function forgeRead(ctx, op, path = "", query = "") {
  if (!ctx.syncKey) return "Not configured: no SYNC_SECRET on the server.";
  const r = await request("POST", ctx.baseUrl + "/api/bridge/read", { "x-sync-key": ctx.syncKey }, { op, path, query });
  const rd = (parse(r.text) || {}).read;
  if (!rd) return "Couldn't queue the read: " + ((parse(r.text) || {}).error || `HTTP ${r.status}`);
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const c = await request("GET", ctx.baseUrl + "/api/bridge/read?id=" + encodeURIComponent(rd.id), { "x-sync-key": ctx.syncKey });
    const cur = (parse(c.text) || {}).read;
    if (!cur) continue;
    if (cur.status === "done") return (cur.content || "(empty)").slice(0, 8000);
    if (cur.status === "error") return "Bridge couldn't read that: " + cur.error;
  }
  return "The bridge didn't answer in time — it may be busy on the mini-PC.";
}

// ---- sandbox (jailed to ctx.sandboxDir on the mini-PC) ----
function jail(ctx, filename) {
  const root = resolve(ctx.sandboxDir);
  mkdirSync(root, { recursive: true });
  const target = resolve(join(root, filename || ""));
  if (target !== root && !target.startsWith(root + sep)) throw new Error("Path escapes the sandbox.");
  return target;
}

// ---- sandboxed python execution (real code exec, jailed cwd, scrubbed env, hard timeout) ----
function runPythonSandbox(ctx, code, timeoutMs = 30000) {
  return new Promise((res) => {
    let file;
    try {
      const root = jail(ctx, "");
      file = join(root, "_run_" + randomUUID().slice(0, 8) + ".py");
      writeFileSync(file, String(code || ""), "utf8");
    } catch (e) { return res("Couldn't stage the script: " + e.message); }
    // Scrubbed env: no inherited secrets (SYNC_SECRET / RUN_PASSWORD / API keys never reach the child).
    const env = { PATH: process.env.PATH || "", SYSTEMROOT: process.env.SYSTEMROOT || "", TEMP: process.env.TEMP || "", TMP: process.env.TMP || "" };
    let out = "", done = false;
    const finish = (msg) => { if (done) return; done = true; try { rmSync(file, { force: true }); } catch {} res(msg); };
    let p;
    try { p = spawn("python", ["-I", file], { cwd: jail(ctx, ""), env, windowsHide: true }); }
    catch (e) { return finish("Couldn't start python: " + e.message); }
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} finish("TIMED OUT after " + Math.round(timeoutMs / 1000) + "s.\n" + out.slice(0, 4000)); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => { clearTimeout(t); finish("python failed to run: " + e.message); });
    p.on("close", (code2) => { clearTimeout(t); finish(`exit ${code2}\n${out.slice(0, 6000)}` + (out.length > 6000 ? "\n…(truncated)" : "")); });
  });
}

// ===================== typed tool registry (Phase 3) =====================
// Each tool carries a category + permission class alongside its model-facing function schema.
// Permission classes (spec): read_only | draft_only | safe_local_write | requires_confirmation | dangerous.
// allowedModes (optional): modes a tool may run in — e.g. forge_send is barred from Draft mode
// (spec: Draft mode avoids irreversible actions). Omitted = allowed in every mode.
// The server enforces all of this (carve-out hard-deny + mode gate + optional confirmation) and logs every run.
// NOT duplicated as tools on purpose: formatting (format_as_markdown/json/table/…) and pure-language
// analysis (analyze_code, summarize_error, explain_stack_trace) — the model does these natively;
// registering no-op wrappers only degrades tool selection.
export const TOOLS = [
  { category: "system", permissionClass: "read_only", logsInputs: false, def: { type: "function", function: { name: "deck_list_projects", description: "List Fred's Command Deck projects (id, name, status, priority, next proof, open next-steps). Use this before acting on a project so you have its id and current state.", parameters: { type: "object", properties: {} } } } },
  { category: "system", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "deck_capture", description: "Drop an idea, reminder, or link into Fred's capture inbox to triage later.", parameters: { type: "object", properties: { text: { type: "string", description: "What to capture." }, url: { type: "string", description: "Optional URL." } }, required: ["text"] } } } },
  { category: "system", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "deck_add_note", description: "Append a note/log entry to a project (get the project id from deck_list_projects first).", parameters: { type: "object", properties: { project_id: { type: "string" }, text: { type: "string" } }, required: ["project_id", "text"] } } } },
  { category: "system", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "deck_add_next_step", description: "Add an actionable next-step to a project.", parameters: { type: "object", properties: { project_id: { type: "string" }, text: { type: "string" } }, required: ["project_id", "text"] } } } },
  { category: "system", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "deck_set_next_proof", description: "Set a project's Next Proof — the single riskiest thing it must prove next.", parameters: { type: "object", properties: { project_id: { type: "string" }, proof: { type: "string" } }, required: ["project_id", "proof"] } } } },
  { category: "system", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "deck_create_project", description: "Create a new Command Deck project. discipline: Apps|Writing|Business|Product Development|Saints Dominion. status: Idea|Building|Live|Paused|Done.", parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, discipline: { type: "string" }, status: { type: "string" }, priority: { type: "string" } }, required: ["name"] } } } },
  { category: "file", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "forge_read", description: "Read source/files on Fred's machine (READ-ONLY). op: 'read' a file or folder, 'list' a folder (omit path to see allowed roots), 'tree' a folder tree, 'grep' (needs query). Paths must be under the bridge's allowed roots.", parameters: { type: "object", properties: { op: { type: "string", enum: ["read", "list", "tree", "grep"] }, path: { type: "string" }, query: { type: "string" } }, required: ["op"] } } } },
  { category: "code", permissionClass: "dangerous", logsInputs: true, allowedModes: ["fast", "normal", "deep_think", "long_context", "tool", "mentor"], def: { type: "function", function: { name: "forge_send", description: "Queue a REAL code/file work order for Claude Code on Fred's machine (the Forge). Use only for actual source/file changes or builds. repo is a named shortcut ('command-deck','cad-sandbox') or an absolute path under the allowed roots. Needs the run-password (configured on the server). The change snapshots first and is always rollback-able.", parameters: { type: "object", properties: { repo: { type: "string" }, title: { type: "string" }, instructions: { type: "string", description: "Clear, complete plain-English steps." } }, required: ["repo", "title", "instructions"] } } } },
  { category: "file", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "sandbox_write", description: "Write (overwrite) a text file in your private sandbox folder on the mini-PC.", parameters: { type: "object", properties: { filename: { type: "string" }, content: { type: "string" } }, required: ["filename", "content"] } } } },
  { category: "file", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "sandbox_read", description: "Read a text file from your private sandbox folder.", parameters: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"] } } } },
  { category: "file", permissionClass: "read_only", logsInputs: false, def: { type: "function", function: { name: "sandbox_list", description: "List the files in your private sandbox folder.", parameters: { type: "object", properties: {} } } } },
  { category: "memory", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "remember", description: "Save a durable fact or preference to long-term memory when Fred asks you to remember something, or clearly states a lasting preference (e.g. units, formats, how he likes answers). Keep it ONE concise fact — don't save one-off chatter, secrets, or hidden reasoning.", parameters: { type: "object", properties: { content: { type: "string", description: "The single fact/preference to remember." }, type: { type: "string", description: "profile (a preference about Fred, default) | workspace | episodic | failure" }, tags: { type: "array", items: { type: "string" } } }, required: ["content"] } } } },
  { category: "memory", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "recall_memory", description: "Search Fred's saved long-term memory for facts/preferences relevant to a query. Relevant memory is usually already provided automatically; use this to look up something specific.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } } },
  { category: "document", permissionClass: "draft_only", logsInputs: true, def: { type: "function", function: { name: "create_artifact", description: "Save a generated document as a versioned artifact (not disposable chat text). Use when you produce a document, report, checklist, spec, or other reusable output Fred may revise or export. Returns the artifact id.", parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string", description: "The full document text (markdown preferred)." }, type: { type: "string", description: "markdown|report|checklist|code|json|other (default markdown)" }, tags: { type: "array", items: { type: "string" } } }, required: ["title", "content"] } } } },
  { category: "document", permissionClass: "draft_only", logsInputs: true, def: { type: "function", function: { name: "revise_artifact", description: "Save a revision of an existing artifact as a NEW version (prior versions are kept). Get the id from list_artifacts.", parameters: { type: "object", properties: { id: { type: "string" }, content: { type: "string", description: "The full revised document text." }, note: { type: "string", description: "Short summary of what changed." } }, required: ["id", "content"] } } } },
  { category: "document", permissionClass: "read_only", logsInputs: false, def: { type: "function", function: { name: "list_artifacts", description: "List Fred's saved artifacts (id, title, type, status, version count).", parameters: { type: "object", properties: { q: { type: "string", description: "Optional keyword filter." } } } } } },
  { category: "document", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "read_artifact", description: "Read the current content of an artifact by id.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } } },
  { category: "document", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "export_artifact", description: "Export an artifact to a text file (md/txt/json/html) in the exports folder. docx/pdf must go through forge_send. Source versions are preserved.", parameters: { type: "object", properties: { id: { type: "string" }, format: { type: "string", description: "md|txt|json|html" } }, required: ["id"] } } } },
  { category: "mentor", permissionClass: "read_only", logsInputs: false, def: { type: "function", function: { name: "request_review", description: "Ask the mentor to critique a piece of text and return a short structured critique. Use before finalizing important or high-stakes output. Runs locally (no data leaves the machine). taskType picks the review lens.", parameters: { type: "object", properties: { content: { type: "string" }, originalRequest: { type: "string" }, taskType: { type: "string", enum: ["answer_review", "code_review", "document_review", "hallucination_check", "tool_use_audit", "reasoning_review"] } }, required: ["content"] } } } },
  { category: "file", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "sandbox_append", description: "Append text to a file in your private sandbox folder (creates it if missing). Good for running logs and notes.", parameters: { type: "object", properties: { filename: { type: "string" }, content: { type: "string" } }, required: ["filename", "content"] } } } },
  { category: "code", permissionClass: "dangerous", logsInputs: true, def: { type: "function", function: { name: "run_python_sandbox", description: "Execute a short Python script INSIDE your private sandbox folder and return its output. 30s limit, no secrets in the environment. Use for real computation, data munging, or checking that generated code actually runs. Files it writes land in the sandbox.", parameters: { type: "object", properties: { code: { type: "string", description: "The complete Python script." } }, required: ["code"] } } } },
  { category: "retrieval", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "search_artifacts", description: "Keyword-search Fred's saved artifacts (titles + content). Returns id, title, and a snippet per hit.", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } } } },
  { category: "document", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "compare_artifacts", description: "Line-diff two versions of an artifact (defaults to previous vs current).", parameters: { type: "object", properties: { id: { type: "string" }, from: { type: "number" }, to: { type: "number" } }, required: ["id"] } } } },
  { category: "retrieval", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "search_chats", description: "Search earlier conversations with Fred for something that was discussed before. Returns chat title + matching snippet.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } } },
  { category: "retrieval", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "retrieve_context_pack", description: "One-shot retrieval bundle: searches memory, artifacts, AND past chats for a query and returns the best hits from each. Prefer this over separate searches when gathering context.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } } },
  { category: "memory", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "update_memory", description: "Manage a saved memory by id (get ids from recall_memory): approve, reject, archive, pin, or unpin it.", parameters: { type: "object", properties: { id: { type: "string" }, action: { type: "string", enum: ["approve", "reject", "archive", "pin", "unpin"] } }, required: ["id", "action"] } } } },
  { category: "analysis", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "save_lesson", description: "Feed the improvement flywheel: log a FAILURE you noticed, add an EVAL case to test a behavior, or propose a prompt RULE. Use after mistakes, corrections from Fred, or recurring patterns.", parameters: { type: "object", properties: { kind: { type: "string", enum: ["failure", "eval", "rule"] }, content: { type: "string", description: "failure: what went wrong; eval: the input prompt to test; rule: the compact instruction." }, expectedBehavior: { type: "string", description: "eval only — what a good answer must do." }, category: { type: "string" } }, required: ["kind", "content"] } } } },
  { category: "persona", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "add_to_persona", description: "Add a piece of Fred's OWN material to the Persona corpus (his voice-training set) — use when he shares one of his jokes, maxims, essays, stories, poems, stray thoughts, future plans, favorites, or a choice AI chat, or says 'save this as one of mine'. Not for facts to remember (use remember for those).", parameters: { type: "object", properties: { text: { type: "string", description: "The exact text in Fred's words." }, kind: { type: "string", enum: ["joke", "maxim", "essay", "story", "poem", "thought", "plan", "favorite", "chat", "other"] }, title: { type: "string" } }, required: ["text", "kind"] } } } },
  { category: "persona", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "search_persona", description: "Retrieve real examples of Fred's own writing from the Persona corpus (to match his voice or recall something he wrote). Optionally filter by kind.", parameters: { type: "object", properties: { query: { type: "string" }, kind: { type: "string", enum: ["joke", "maxim", "essay", "story", "poem", "thought", "plan", "favorite", "chat", "web", "other"] } }, required: ["query"] } } } },
  { category: "persona", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "scrape_to_persona", description: "Fetch a web page (e.g. one of Fred's own sites) and add its readable text to the Persona corpus as source material.", parameters: { type: "object", properties: { url: { type: "string" }, kind: { type: "string", description: "default 'web'" }, title: { type: "string" } }, required: ["url"] } } } },
];

export const TOOL_DEFS = TOOLS.map((t) => t.def);
const META = new Map(TOOLS.map((t) => [t.def.function.name, t]));
export const toolMeta = (name) => { const t = META.get(name); return t ? { category: t.category, permissionClass: t.permissionClass, logsInputs: t.logsInputs, allowedModes: t.allowedModes || null } : { category: "system", permissionClass: "read_only", logsInputs: false, allowedModes: null }; };
// Back-compat: dangerous tools (real code/file changes) get the UI lock.
export const WRITE_TOOLS = new Set(TOOLS.filter((t) => t.permissionClass === "dangerous").map((t) => t.def.function.name));

// ---- ironclad carve-out guard (ALWAYS on, even under LAX) ----
// Two resources the assistant must NEVER touch: (1) customer/production databases,
// (2) app backups (mini-PC D: + the backup system). Enforced at the tool bus as defense-in-depth
// on top of the bridge's root-scoping. Conservative patterns to avoid false-denials on dev work.
const PROTECTED_RE = [
  /(^|[^a-z0-9])d:[\\/]/i,        // mini-PC D: = the backup SSD
  /app[-_ ]?backups?/i,          // the app-backup system
  /\bdb[-_ ]?backups?\b/i,
  /pg_dump|pg_restore/i,         // dumping/restoring a (prod) DB
];
const REACHES_OUT = new Set(["forge_read", "forge_send", "sandbox_write", "sandbox_read", "sandbox_list", "sandbox_append", "run_python_sandbox"]);
export function assertNotProtected(name, args) {
  if (!REACHES_OUT.has(name)) return { ok: true };
  const blob = JSON.stringify(args || {});
  for (const re of PROTECTED_RE) {
    if (re.test(blob)) return { ok: false, reason: "references a protected resource (app backups / customer DB) — hard carve-out, never touched" };
  }
  return { ok: true };
}

// ===================== dispatcher =====================
export async function runTool(name, args, ctx) {
  args = args || {};
  try {
    switch (name) {
      case "deck_list_projects": {
        const d = await agent(ctx, "list_projects");
        if (d.error) return "Couldn't list projects: " + d.error;
        const ps = d.projects || [];
        if (!ps.length) return "No synced projects yet.";
        return ps.map((p) => {
          let line = `- [${p.id}] ${p.name} (${p.status}/${p.priority})`;
          if (p.nextProof) line += ` | Next proof: ${p.nextProof}`;
          const steps = p.openNextSteps || [];
          if (steps.length) line += " | next: " + steps.join("; ");
          return line;
        }).join("\n");
      }
      case "deck_capture": { const d = await agent(ctx, "capture_inbox", { text: args.text, url: args.url || "" }); return d.message || d.error || "Captured."; }
      case "deck_add_note": { const d = await agent(ctx, "add_note", { projectId: args.project_id, text: args.text }); return d.message || d.error || "Note added."; }
      case "deck_add_next_step": { const d = await agent(ctx, "add_next_step", { projectId: args.project_id, text: args.text }); return d.message || d.error || "Next step added."; }
      case "deck_set_next_proof": { const d = await agent(ctx, "set_next_proof", { projectId: args.project_id, proof: args.proof }); return d.message || d.error || "Next proof set."; }
      case "deck_create_project": { const d = await agent(ctx, "create_project", { name: args.name, description: args.description || "", discipline: args.discipline || "", status: args.status || "", priority: args.priority || "" }); return d.message || d.error || "Project created."; }
      case "forge_read": return await forgeRead(ctx, args.op, args.path || "", args.query || "");
      case "forge_send": {
        if (!ctx.runPassword) return "I can read and plan, but real code/file changes need the run-password configured on the server (RUN_PASSWORD). Ask Fred to set it on the mini-PC.";
        const r = await request("POST", ctx.baseUrl + "/api/jobs", { "x-sync-key": ctx.syncKey }, { repo: args.repo, title: args.title, instructions: args.instructions, pin: ctx.runPassword });
        const d = parse(r.text) || {};
        if (r.status === 200 && d.job) return `Queued work order "${d.job.title}" (id ${d.job.id.slice(0, 8)}). It runs on the mini-PC, snapshots first, and is rollback-able from the Forge.`;
        if (d.code === "bad_pin" || d.code === "pin_required") return "The run-password was wrong — ask Fred to check it.";
        return "Couldn't queue the work order: " + (d.error || `HTTP ${r.status}`);
      }
      case "sandbox_write": { const t = jail(ctx, args.filename); writeFileSync(t, args.content ?? "", "utf8"); return `Wrote ${Buffer.byteLength(args.content || "")} bytes to ${args.filename}.`; }
      case "sandbox_read": { const t = jail(ctx, args.filename); if (!existsSync(t)) return "Not found: " + args.filename; return readFileSync(t, "utf8").slice(0, 8000); }
      case "sandbox_list": {
        const root = jail(ctx, "");
        const walk = (dir, pre = "") => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          const rel = pre + e.name; const full = join(dir, e.name);
          return e.isDirectory() ? walk(full, rel + "/") : [`${rel} (${statSync(full).size} b)`];
        });
        const items = walk(root);
        return items.length ? items.join("\n") : "(sandbox is empty)";
      }
      case "remember": {
        if (!ctx.memory) return "Memory isn't available right now.";
        const r = ctx.memory.propose({ content: args.content, type: args.type, tags: args.tags, source: { kind: "user_explicit" } });
        if (r.error) return "Couldn't save that to memory: " + r.error;
        return r.deduped ? "I already had that in memory." : `Saved to long-term memory (${r.item.type}).`;
      }
      case "recall_memory": {
        if (!ctx.memory) return "Memory isn't available right now.";
        const hits = ctx.memory.retrieve(args.query || "", { limit: 6, minScore: 0.1 });
        if (!hits.length) return "No saved memory matches that.";
        return hits.map((h) => `- (${h.title}) ${h.content}`).join("\n");
      }
      case "create_artifact": {
        if (!ctx.artifacts) return "The artifact studio isn't available right now.";
        const r = ctx.artifacts.create({ title: args.title, type: args.type, content: args.content, tags: args.tags, model: "qwen-local" });
        if (r.error) return "Couldn't save the artifact: " + r.error;
        return `Saved artifact "${r.item.title}" (id ${r.item.id.slice(0, 8)}, v1, ${r.item.wordCount} words). Fred can view, revise, diff, and export it from the Artifacts panel.`;
      }
      case "revise_artifact": {
        if (!ctx.artifacts) return "The artifact studio isn't available right now.";
        const r = ctx.artifacts.addVersion(args.id, { content: args.content, promptSummary: args.note, model: "qwen-local" });
        if (r.error) return "Couldn't revise that artifact: " + r.error;
        return `Saved revision v${r.item.version} of "${r.item.title}" (prior versions kept).`;
      }
      case "list_artifacts": {
        if (!ctx.artifacts) return "The artifact studio isn't available right now.";
        const list = ctx.artifacts.list({ q: args.q || "" });
        if (!list.length) return "No artifacts yet.";
        return list.slice(0, 20).map((a) => `- [${a.id.slice(0, 8)}] ${a.title} (${a.type}/${a.status}, v${a.version})`).join("\n");
      }
      case "read_artifact": {
        if (!ctx.artifacts) return "The artifact studio isn't available right now.";
        const c = ctx.artifacts.getContent(args.id);
        return c == null ? "No artifact with that id." : c.slice(0, 8000);
      }
      case "export_artifact": {
        if (!ctx.artifacts) return "The artifact studio isn't available right now.";
        const r = ctx.artifacts.exportArtifact(args.id, args.format);
        return r.error ? "Couldn't export: " + r.error : `Exported to ${r.path} (${r.bytes} bytes).`;
      }
      case "sandbox_append": { const t = jail(ctx, args.filename); appendFileSync(t, args.content ?? "", "utf8"); return `Appended ${Buffer.byteLength(args.content || "")} bytes to ${args.filename}.`; }
      case "run_python_sandbox": return await runPythonSandbox(ctx, args.code);
      case "search_artifacts": {
        if (!ctx.artifacts) return "The artifact studio isn't available right now.";
        const hits = ctx.artifacts.list({ q: args.q || "" }).slice(0, 8);
        if (!hits.length) return "No artifacts match that.";
        return hits.map((a) => `- [${a.id.slice(0, 8)}] ${a.title} (${a.type}/${a.status}, v${a.version})`).join("\n");
      }
      case "compare_artifacts": {
        if (!ctx.artifacts) return "The artifact studio isn't available right now.";
        const d = ctx.artifacts.diff(args.id, Number(args.from) || 0, Number(args.to) || 0);
        return d.error ? "Couldn't diff: " + d.error : `Diff v${d.from} -> v${d.to}:\n` + String(d.diff).slice(0, 6000);
      }
      case "search_chats": {
        if (!ctx.chatlog) return "Chat history search isn't available right now.";
        const hits = ctx.chatlog.search(args.query || "", { limit: 5 });
        if (!hits.length) return "No earlier conversation matches that.";
        return hits.map((h) => `- "${h.title}" (${String(h.updatedAt).slice(0, 10)}): ${h.snippet}`).join("\n");
      }
      case "retrieve_context_pack": {
        const q = args.query || "";
        const mem = ctx.memory ? (await ctx.memory.retrieveHybrid(q, { limit: 4, minScore: 0.1 })) : [];
        const arts = ctx.artifacts ? ctx.artifacts.list({ q }).slice(0, 3) : [];
        const chats = ctx.chatlog ? ctx.chatlog.search(q, { limit: 3 }) : [];
        const out = [];
        if (mem.length) out.push("MEMORY:\n" + mem.map((h) => `- (${h.title}) ${h.content}`).join("\n"));
        if (arts.length) out.push("ARTIFACTS:\n" + arts.map((a) => `- [${a.id.slice(0, 8)}] ${a.title} (${a.type}, v${a.version})`).join("\n"));
        if (chats.length) out.push("PAST CHATS:\n" + chats.map((h) => `- "${h.title}": ${h.snippet.slice(0, 200)}`).join("\n"));
        return out.length ? out.join("\n\n").slice(0, 7000) : "Nothing relevant found in memory, artifacts, or past chats.";
      }
      case "update_memory": {
        if (!ctx.memory) return "Memory isn't available right now.";
        const r = ctx.memory.update(args.id, { action: args.action });
        return r.error ? "Couldn't update that memory: " + r.error : `Memory ${args.action}d.`;
      }
      case "save_lesson": {
        if (!ctx.flywheel) return "The improvement flywheel isn't available right now.";
        if (args.kind === "failure") { const r = ctx.flywheel.addFailure({ category: args.category || "self_reported", severity: "low", originalRequest: args.content, detectedBy: "self_check", improvementActions: ["manual_review"] }); return r.error ? "Couldn't log it: " + r.error : "Logged to the failure ledger."; }
        if (args.kind === "eval") { const r = ctx.flywheel.addEval({ title: String(args.content).slice(0, 80), input: args.content, expectedBehavior: args.expectedBehavior || "", category: args.category || "reasoning", source: "failure_log" }); return r.error ? "Couldn't add the eval: " + r.error : "Eval case added."; }
        if (args.kind === "rule") { const r = ctx.flywheel.addRule({ content: args.content, scope: "global", status: "candidate" }); return r.error ? "Couldn't add the rule: " + r.error : "Prompt rule saved as a candidate (Fred activates it from the Improvement panel)."; }
        return "Unknown lesson kind: " + args.kind;
      }
      case "request_review": {
        if (!ctx.mentor) return "The mentor isn't available right now.";
        const c = await ctx.mentor.critique({ taskType: args.taskType || "answer_review", originalRequest: args.originalRequest || "", content: args.content || "", privacyMode: "local_only" });
        const lines = [`Score ${c.overall_score}/10 · hallucination risk ${c.hallucination_risk} · revise: ${c.revision_priority}`];
        if ((c.major_findings || []).length) lines.push("Major: " + c.major_findings.join("; "));
        if ((c.unsupported_claims || []).length) lines.push("Unsupported claims: " + c.unsupported_claims.join("; "));
        if (c.recommended_revision) lines.push("Suggestion: " + c.recommended_revision);
        return lines.join("\n");
      }
      case "add_to_persona": {
        if (!ctx.persona) return "The Persona corpus isn't available right now.";
        const r = ctx.persona.ingestText({ text: args.text, kind: args.kind, title: args.title, source: "chat" });
        if (r.error) return "Couldn't add that: " + r.error;
        return r.deduped ? "Fred already has that in his corpus." : `Added to Fred's Persona corpus (${args.kind}, ${r.chunks} chunk${r.chunks === 1 ? "" : "s"}). Refresh the profile from the Persona panel to fold it into his voice.`;
      }
      case "search_persona": {
        if (!ctx.persona) return "The Persona corpus isn't available right now.";
        const hits = await ctx.persona.retrieve(args.query || "", { limit: 6, kind: args.kind || "" });
        if (!hits.length) return "No matching material in Fred's corpus.";
        return hits.map((h) => `— [${h.kind}] ${h.text.slice(0, 400)}`).join("\n\n");
      }
      case "scrape_to_persona": {
        if (!ctx.persona) return "The Persona corpus isn't available right now.";
        const r = await fetchUrl(String(args.url || ""));
        if (r.error) return "Couldn't fetch that URL: " + r.error;
        if ((r.status || 0) >= 400) return "The site returned HTTP " + r.status + ".";
        const text = /html/i.test(r.contentType || "") || /<html/i.test(r.body || "") ? htmlToText(r.body) : String(r.body || "");
        if (!text || text.length < 40) return "Nothing readable came back from that page.";
        const ing = ctx.persona.ingestText({ text, kind: args.kind || "web", title: args.title || args.url, source: "scrape:" + args.url });
        return ing.error ? "Couldn't add it: " + ing.error : `Scraped ${text.length} chars into Fred's corpus (${ing.chunks} chunk${ing.chunks === 1 ? "" : "s"}).`;
      }
      default: return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Tool ${name} failed: ${e.message}`;
  }
}
