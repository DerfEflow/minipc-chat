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
const stripThink = (t) => String(t || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
const ABORTED = "CANCELLED: the run was aborted (client stopped/disconnected).";

// Tiny dependency-free HTTP(S) JSON request (handles both protocols; the cloud is https).
// C5: an optional AbortSignal destroys the in-flight request when the client stops mid-run.
function request(method, url, headers = {}, body = null, signal = null) {
  return new Promise((res) => {
    let u;
    try { u = new URL(url); } catch { return res({ status: 0, text: "bad url" }); }
    if (signal && signal.aborted) return res({ status: 0, text: "aborted", aborted: true });
    const mod = u.protocol === "https:" ? https : http;
    const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data != null) { if (!h["content-type"]) h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    const r = mod.request(
      { method, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, headers: h, timeout: 35000 },
      (resp) => { let buf = ""; resp.on("data", (d) => (buf += d)); resp.on("end", () => res({ status: resp.statusCode || 0, text: buf })); }
    );
    if (signal) signal.addEventListener("abort", () => { try { r.destroy(new Error("aborted")); } catch {} res({ status: 0, text: "aborted", aborted: true }); }, { once: true });
    r.on("error", (e) => res({ status: 0, text: String(e.message), aborted: signal ? signal.aborted : false }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, text: "timeout" }); });
    if (data != null) r.write(data);
    r.end();
  });
}
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

// ---- bridge poke (instant wake) ----
// The bridge poller idles on a slow poll (transfer allowance!) and exposes a localhost poke
// listener; after we queue work for it in the cloud, poke it so it acts now. Fire-and-forget.
function pokeBridge(ctx) {
  try {
    const r = http.request({ hostname: "127.0.0.1", port: ctx.bridgePokePort || 8188, path: "/poke", method: "POST", timeout: 2000 }, (resp) => resp.resume());
    r.on("error", () => {});
    r.on("timeout", () => r.destroy());
    r.end();
  } catch {}
}

// ---- Command Deck (cloud /api/agent) ----
async function agent(ctx, action, extra = {}, signal = null) {
  if (!ctx.syncKey) return { error: "no SYNC_SECRET configured on the server" };
  const r = await request("POST", ctx.baseUrl + "/api/agent", { "x-sync-key": ctx.syncKey }, { action, ...extra }, signal);
  if (r.aborted) return { error: "aborted" };
  return parse(r.text) || { error: `HTTP ${r.status}: ${r.text.slice(0, 160)}` };
}

// ---- the bridge read API (read-only files on Fred's machine) ----
async function forgeRead(ctx, op, path = "", query = "", signal = null) {
  if (!ctx.syncKey) return "Not configured: no SYNC_SECRET on the server.";
  const r = await request("POST", ctx.baseUrl + "/api/bridge/read", { "x-sync-key": ctx.syncKey }, { op, path, query }, signal);
  if (r.aborted) return ABORTED;
  const rd = (parse(r.text) || {}).read;
  if (!rd) return "Couldn't queue the read: " + ((parse(r.text) || {}).error || `HTTP ${r.status}`);
  pokeBridge(ctx); // wake the poller so the read is fulfilled within seconds, not on its idle cycle
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return ABORTED;   // C5: stop polling the bridge on client stop
    await sleep(1500);
    const c = await request("GET", ctx.baseUrl + "/api/bridge/read?id=" + encodeURIComponent(rd.id), { "x-sync-key": ctx.syncKey }, null, signal);
    if (c.aborted) return ABORTED;
    const cur = (parse(c.text) || {}).read;
    if (!cur) continue;
    if (cur.status === "done") return (cur.content || "(empty)").slice(0, 8000);
    if (cur.status === "error") return "Bridge couldn't read that: " + cur.error;
  }
  return "The bridge didn't answer in time — it may be busy on the mini-PC.";
}

// ---- machine access via the hands node (replaces the retired Command Deck bridge) ----
// ctx.hands.dispatch(tool, args) reaches the connected node; the node enforces the carve-outs and its
// allowed roots. These are how the cloud assistant reads/writes/runs on Fred's (or a user's) machine.
function fmtHands(r, okFmt) {
  if (!r) return "No response from the machine.";
  if (r.refused) return "Refused (carve-out): " + (r.reason || "protected resource — never touched.");
  if (r.offline) return r.error || "That machine is offline. Start your Dominion hands node on it, then retry.";
  if (!r.ok) return "Couldn't do that on the machine: " + (r.error || "unknown error");
  return okFmt(r);
}
// Render a list of relative paths as an ASCII file tree (dirs before files, alphabetical) — the way
// Claude Code shows a scaffold. Used by scaffold_project's report.
function renderTree(root, relPaths) {
  const rootTree = {};
  for (const p of relPaths) {
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    let node = rootTree;
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      node[parts[i]] = node[parts[i]] || (isFile ? null : {});
      if (!isFile) node = node[parts[i]];
    }
  }
  const lines = [root.replace(/[\\/]+$/, "") + "/"];
  const walk = (node, prefix) => {
    const keys = Object.keys(node).sort((a, b) => {
      const ad = node[a] === null ? 1 : 0, bd = node[b] === null ? 1 : 0;   // dirs first
      return ad - bd || a.localeCompare(b);
    });
    keys.forEach((k, i) => {
      const last = i === keys.length - 1;
      lines.push(prefix + (last ? "└── " : "├── ") + k + (node[k] === null ? "" : "/"));
      if (node[k]) walk(node[k], prefix + (last ? "    " : "│   "));
    });
  };
  walk(rootTree, "");
  return lines.join("\n");
}

// Write a whole file tree to the connected machine in one call — the "structure code as a tree" tool.
// Each file goes through the node's fs_write (mkdir -p, allowed-roots + carve-out enforced per file).
async function scaffoldProject(ctx, args) {
  if (!ctx.hands) return "Scaffolding a project needs a connected Dominion hands node. Start it on the computer you want to build on.";
  const root = String(args.root || "").trim().replace(/[\\/]+$/, "");
  const files = Array.isArray(args.files) ? args.files : [];
  if (!root) return "scaffold_project needs `root` (an absolute folder path on the machine).";
  if (!files.length) return "scaffold_project needs a `files` array of { path, content }.";
  if (files.length > 200) return `Too many files at once (${files.length}); scaffold in batches of 200 or fewer.`;
  const written = [], issues = [];
  let ok = 0, failed = 0, bytes = 0;
  for (const f of files) {
    const raw = String(f && f.path || "").trim();
    if (!raw) { failed++; issues.push("• (a file had no path — skipped)"); continue; }
    const isAbs = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\");
    const rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
    const abs = isAbs ? raw : root + "/" + rel;
    const r = await ctx.hands.dispatch("fs_write", { path: abs, content: (f && f.content) ?? "" });
    if (r && r.ok) { ok++; bytes += (r.bytes || 0); written.push(isAbs ? abs : rel); }
    else { failed++; issues.push("• " + rel + ": " + (r && (r.reason || r.error) || "refused")); }
  }
  const tree = renderTree(root, written);
  return `Scaffolded ${ok} file(s)${failed ? `, ${failed} failed` : ""} (${bytes} bytes) under ${root}:\n\n${tree}` +
    (issues.length ? `\n\nIssues:\n${issues.join("\n")}` : "");
}

async function handsRead(ctx, op, path, query) {
  if (op === "list") return fmtHands(await ctx.hands.dispatch("fs_list", { path }), (r) => (r.entries || []).map((e) => `${e.type === "dir" ? "[dir] " : "      "}${e.name}${e.size != null ? "  (" + e.size + " b)" : ""}`).join("\n") || "(empty)");
  if (op === "tree") return fmtHands(await ctx.hands.dispatch("fs_tree", { path, depth: 3 }), (r) => (r.tree || []).join("\n") || "(empty)");
  if (op === "grep") return "To search on the machine, use forge_run with a search command for that OS (PowerShell Select-String on Windows, grep/rg on Linux), or use forge_read op:list/tree/read to browse.";
  return fmtHands(await ctx.hands.dispatch("fs_read", { path }), (r) => String(r.text ?? "(empty)").slice(0, 8000));
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
// C5: an AbortSignal SIGKILLs the child mid-run when the client stops/disconnects.
function runPythonSandbox(ctx, code, timeoutMs = 30000, signal = null) {
  return new Promise((res) => {
    if (signal && signal.aborted) return res(ABORTED);
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
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); try { p.kill("SIGKILL"); } catch {} finish(ABORTED + "\n" + out.slice(0, 2000)); }, { once: true });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => { clearTimeout(t); finish("python failed to run: " + e.message); });
    p.on("close", (code2) => { clearTimeout(t); finish(`exit ${code2}\n${out.slice(0, 6000)}` + (out.length > 6000 ? "\n…(truncated)" : "")); });
  });
}

// ---- C4: the six formatting tools (spec 858-865) — REAL tools on the LIGHT model ----
// Fast + cheap deterministic-ish reformatting via ctx.lightChat (wired by the server to the 8B).
// format_as_json runs with format:"json" + think:false (the qwen3 gotcha); the rest run plain.
const FORMAT_SPECS = {
  format_as_markdown: { json: false, instruction: "Reformat the content below as clean, well-structured markdown (headings, lists, emphasis, code fences where apt). Preserve ALL information — change structure only, add nothing. Output ONLY the markdown." },
  format_as_json:     { json: true,  instruction: "Convert the content below into well-structured JSON that captures its data faithfully (sensible keys, arrays for lists). Add no new facts. Return ONLY the JSON." },
  format_as_checklist:{ json: false, instruction: "Convert the content below into an actionable markdown checklist of '- [ ]' items, grouped under headings where natural, most important first. Output ONLY the checklist." },
  format_as_table:    { json: false, instruction: "Convert the content below into one or more markdown tables with sensible column headers. Preserve all data. Output ONLY the table(s)." },
  format_as_report:   { json: false, instruction: "Reformat the content below as a short structured report: a title, an executive summary, sections with headings, and a brief conclusion. Preserve all facts; add no new claims. Output ONLY the report." },
  format_as_scope:    { json: false, instruction: "Rewrite the content below as a scope document with these sections: Objective, In Scope, Out of Scope, Deliverables, Assumptions & Constraints. Preserve all stated facts; mark anything you had to infer as (assumed). Output ONLY the scope document." },
};
async function runFormatting(ctx, name, args, signal = null) {
  if (typeof ctx.lightChat !== "function") return "Formatting isn't available right now (no light model wired on the server).";
  const spec = FORMAT_SPECS[name];
  const content = String(args.content || "").slice(0, 12000);
  if (!content.trim()) return "Nothing to format — pass the content to reformat.";
  const prompt = spec.instruction +
    (args.instructions ? "\nExtra instructions: " + String(args.instructions).slice(0, 500) : "") +
    "\n\nCONTENT:\n" + content;
  const opts = { temperature: 0.2, num_predict: 3000, think: false, signal };
  if (spec.json) opts.format = "json";
  const d = await ctx.lightChat([{ role: "user", content: prompt }], opts);
  if (signal && signal.aborted) return ABORTED;
  const out = stripThink((d && d.message && d.message.content) || "");
  if (!out) return "The formatting model returned nothing — try again.";
  if (spec.json) { try { JSON.parse(out); } catch { return "The model returned invalid JSON — raw output:\n" + out.slice(0, 4000); } }
  return out.slice(0, 8000);
}

// ===================== typed tool registry (Phase 3) =====================
// Each tool carries a category + permission class alongside its model-facing function schema.
// Permission classes (spec): read_only | draft_only | safe_local_write | requires_confirmation | dangerous.
// allowedModes (optional): modes a tool may run in — e.g. forge_send is barred from Draft mode
// (spec: Draft mode avoids irreversible actions). Omitted = allowed in every mode.
// The server enforces all of this (carve-out hard-deny + mode gate + confirmation machinery) and logs every run.
// C1 (spec 780-791): requires_confirmation is a REAL assigned class — external sends (the deck_*
// writes push data to the cloud Command Deck API) carry it statically; sandbox_write escalates to it
// dynamically when it would OVERWRITE an existing file, and remember escalates when the model saves
// an INFERRED (not user-explicit) memory — see effectivePermission(). Under LAX the confirmation
// auto-answers "approve" (recorded in the lifecycle as auto_approved); CONFIRM_TOOLS=1 makes it interactive.
export const TOOLS = [
  { category: "system", permissionClass: "read_only", logsInputs: false, def: { type: "function", function: { name: "deck_list_projects", description: "List Fred's Command Deck projects (id, name, status, priority, next proof, open next-steps). Use this before acting on a project so you have its id and current state.", parameters: { type: "object", properties: {} } } } },
  { category: "system", permissionClass: "requires_confirmation", logsInputs: true, def: { type: "function", function: { name: "deck_capture", description: "Drop an idea, reminder, or link into Fred's capture inbox to triage later.", parameters: { type: "object", properties: { text: { type: "string", description: "What to capture." }, url: { type: "string", description: "Optional URL." } }, required: ["text"] } } } },
  { category: "system", permissionClass: "requires_confirmation", logsInputs: true, def: { type: "function", function: { name: "deck_add_note", description: "Append a note/log entry to a project (get the project id from deck_list_projects first).", parameters: { type: "object", properties: { project_id: { type: "string" }, text: { type: "string" } }, required: ["project_id", "text"] } } } },
  { category: "system", permissionClass: "requires_confirmation", logsInputs: true, def: { type: "function", function: { name: "deck_add_next_step", description: "Add an actionable next-step to a project.", parameters: { type: "object", properties: { project_id: { type: "string" }, text: { type: "string" } }, required: ["project_id", "text"] } } } },
  { category: "system", permissionClass: "requires_confirmation", logsInputs: true, def: { type: "function", function: { name: "deck_set_next_proof", description: "Set a project's Next Proof — the single riskiest thing it must prove next.", parameters: { type: "object", properties: { project_id: { type: "string" }, proof: { type: "string" } }, required: ["project_id", "proof"] } } } },
  { category: "system", permissionClass: "requires_confirmation", logsInputs: true, def: { type: "function", function: { name: "deck_create_project", description: "Create a new Command Deck project. discipline: Apps|Writing|Business|Product Development|Saints Dominion. status: Idea|Building|Live|Paused|Done.", parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, discipline: { type: "string" }, status: { type: "string" }, priority: { type: "string" } }, required: ["name"] } } } },
  { category: "file", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "forge_read", description: "Read files on the connected machine (READ-ONLY). op: 'read' a file, 'list' a folder, 'tree' a folder tree, 'grep' (search hint). Reaches the machine through its Dominion hands node; the node enforces allowed folders + carve-outs.", parameters: { type: "object", properties: { op: { type: "string", enum: ["read", "list", "tree", "grep"] }, path: { type: "string" }, query: { type: "string" } }, required: ["op"] } } } },
  { category: "code", permissionClass: "dangerous", logsInputs: true, def: { type: "function", function: { name: "forge_write", description: "Write (create or overwrite) a file on the connected machine, in a folder the machine allows. Reaches it through the Dominion hands node (carve-outs + allowed-folders enforced). Use for real file changes as you build.", parameters: { type: "object", properties: { path: { type: "string", description: "Absolute path on that machine." }, content: { type: "string" } }, required: ["path", "content"] } } } },
  { category: "code", permissionClass: "dangerous", logsInputs: true, def: { type: "function", function: { name: "forge_run", description: "Run a shell command on the connected machine and return its output (PowerShell on Windows, sh on Linux). Reaches it through the Dominion hands node; the node enforces carve-outs and refuses destructive commands against protected dirs. Use to build, test, and inspect as you work.", parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number", description: "Optional, default 60000, max 600000." } }, required: ["command"] } } } },
  { category: "code", permissionClass: "dangerous", logsInputs: true, def: { type: "function", function: { name: "scaffold_project", description: "Create a whole project/app as a file TREE on the connected machine in one call. Give `root` (an absolute base folder on that machine) and `files` (each { path relative to root, content }). Creates all folders and files, then returns the rendered tree. Use this when the user asks you to build an app or project — lay out the full structure at once. Reaches the machine through its Dominion hands node (allowed folders + carve-outs enforced per file).", parameters: { type: "object", properties: { root: { type: "string", description: "Absolute base folder on the machine, e.g. C:/Users/Fred/projects/my-app." }, files: { type: "array", description: "Files to create.", items: { type: "object", properties: { path: { type: "string", description: "Path relative to root (e.g. src/index.js). Absolute paths allowed but discouraged." }, content: { type: "string" } }, required: ["path", "content"] } } }, required: ["root", "files"] } } } },
  { category: "code", permissionClass: "dangerous", logsInputs: true, allowedModes: ["fast", "normal", "deep_think", "long_context", "tool", "mentor"], def: { type: "function", function: { name: "forge_send", description: "Queue a REAL code/file work order for Claude Code on Fred's machine (the Forge). Use only for actual source/file changes or builds. repo is a named shortcut ('command-deck','cad-sandbox') or an absolute path under the allowed roots. Needs the run-password (configured on the server). The change snapshots first and is always rollback-able.", parameters: { type: "object", properties: { repo: { type: "string" }, title: { type: "string" }, instructions: { type: "string", description: "Clear, complete plain-English steps." } }, required: ["repo", "title", "instructions"] } } } },
  { category: "file", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "sandbox_write", description: "Write (overwrite) a text file in your private sandbox folder on the mini-PC.", parameters: { type: "object", properties: { filename: { type: "string" }, content: { type: "string" } }, required: ["filename", "content"] } } } },
  { category: "file", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "sandbox_read", description: "Read a text file from your private sandbox folder.", parameters: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"] } } } },
  { category: "file", permissionClass: "read_only", logsInputs: false, def: { type: "function", function: { name: "sandbox_list", description: "List the files in your private sandbox folder.", parameters: { type: "object", properties: {} } } } },
  { category: "memory", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "remember", description: "Save a durable fact or preference to long-term memory when Fred asks you to remember something, or clearly states a lasting preference (e.g. units, formats, how he likes answers). Keep it ONE concise fact — don't save one-off chatter, secrets, or hidden reasoning. If Fred did NOT explicitly ask and you are inferring the preference yourself, set source to assistant_inferred (it goes through approval gating).", parameters: { type: "object", properties: { content: { type: "string", description: "The single fact/preference to remember." }, type: { type: "string", description: "profile (a preference about Fred, default) | workspace | episodic | failure" }, source: { type: "string", enum: ["user_explicit", "assistant_inferred"], description: "user_explicit (default) when Fred asked; assistant_inferred when you deduced it yourself." }, scope: { type: "string", enum: ["global", "workspace", "chat", "tool", "model"], description: "Where the memory applies (default global). chat = only this conversation." }, tags: { type: "array", items: { type: "string" } } }, required: ["content"] } } } },
  { category: "memory", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "recall_memory", description: "Search Fred's saved long-term memory for facts/preferences relevant to a query. Relevant memory is usually already provided automatically; use this to look up something specific.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } } },
  { category: "document", permissionClass: "draft_only", logsInputs: true, def: { type: "function", function: { name: "create_artifact", description: "Save a generated document as a versioned artifact (not disposable chat text). Use when you produce a document, report, checklist, spec, or other reusable output Fred may revise or export. Returns the artifact id.", parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string", description: "The full document text (markdown preferred)." }, type: { type: "string", description: "markdown|report|checklist|code|json|other (default markdown)" }, tags: { type: "array", items: { type: "string" } } }, required: ["title", "content"] } } } },
  { category: "document", permissionClass: "draft_only", logsInputs: true, def: { type: "function", function: { name: "revise_artifact", description: "Save a revision of an existing artifact as a NEW version (prior versions are kept). Get the id from list_artifacts.", parameters: { type: "object", properties: { id: { type: "string" }, content: { type: "string", description: "The full revised document text." }, note: { type: "string", description: "Short summary of what changed." } }, required: ["id", "content"] } } } },
  { category: "document", permissionClass: "read_only", logsInputs: false, def: { type: "function", function: { name: "list_artifacts", description: "List Fred's saved artifacts (id, title, type, status, version count).", parameters: { type: "object", properties: { q: { type: "string", description: "Optional keyword filter." } } } } } },
  { category: "document", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "read_artifact", description: "Read the current content of an artifact by id.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } } },
  { category: "document", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "export_artifact", description: "Export an artifact to a file in the exports folder — md/txt/json/html AND native docx/pdf/xlsx/csv. Every export passes the safety gate (title/format/destination echo, review-skipped + unsupported-claims warnings, sensitive-data block). Source versions are always preserved.", parameters: { type: "object", properties: { id: { type: "string" }, format: { type: "string", description: "md|txt|json|html|docx|pdf|xlsx|csv" }, acknowledge_sensitive: { type: "boolean", description: "ONLY set true when Fred has explicitly approved exporting despite a sensitive-data warning." } }, required: ["id"] } } } },
  // E3 (spec 809-821): the three native document-generation tools. Each creates a versioned
  // artifact AND exports it through the same safety gate the REST endpoint uses.
  { category: "document", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "create_docx", description: "Create a Word document natively on the mini-PC: saves the content as a versioned artifact, then exports a real .docx (headings, bold/italic, lists from markdown). Returns the artifact id and the exported file path.", parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string", description: "The full document text (markdown — headings/lists/bold render in the docx)." } }, required: ["title", "content"] } } } },
  { category: "document", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "create_pdf", description: "Create a PDF natively on the mini-PC: saves the content as a versioned artifact, then exports a real multi-page .pdf. Returns the artifact id and the exported file path.", parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string", description: "The full document text (markdown)." } }, required: ["title", "content"] } } } },
  { category: "document", permissionClass: "safe_local_write", logsInputs: true, def: { type: "function", function: { name: "create_spreadsheet", description: "Create a spreadsheet natively on the mini-PC: saves the data as a versioned artifact, then exports .xlsx when the content is a markdown table or CSV (falls back to .csv otherwise). Returns the artifact id and the exported file path.", parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string", description: "A markdown table or CSV data." }, format: { type: "string", enum: ["xlsx", "csv"], description: "default xlsx (auto-falls back to csv when no table parses)" } }, required: ["title", "content"] } } } },
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
  // Live web access (Fred's ask: search wired into the UI so ANY model can look things up).
  // web_search = SerpApi (SERP_API_KEY on the box); web_read fetches one page as readable text.
  { category: "retrieval", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "web_search", description: "Search the live web (Google via SerpApi) for current information — news, prices, docs, anything after your training data. Returns the top results (title, url, snippet) plus a direct answer when Google shows one. Follow up with web_read on a promising url when you need the full page.", parameters: { type: "object", properties: { query: { type: "string", description: "The search query." }, num: { type: "number", description: "How many results (default 6, max 10)." } }, required: ["query"] } } } },
  { category: "retrieval", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "web_read", description: "Fetch a web page and return its readable text (article/main content). Use after web_search to read a specific result in full.", parameters: { type: "object", properties: { url: { type: "string", description: "The page URL to read." } }, required: ["url"] } } } },
  // C4: the six spec formatting tools — real tools on the light model (fast, cheap), read_only.
  { category: "formatting", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "format_as_markdown", description: "Reformat text/data as clean structured markdown (headings, lists, emphasis). Runs on the fast model — use for pure reformatting instead of doing it yourself.", parameters: { type: "object", properties: { content: { type: "string", description: "The content to reformat." }, instructions: { type: "string", description: "Optional extra formatting guidance." } }, required: ["content"] } } } },
  { category: "formatting", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "format_as_json", description: "Convert text/data into well-structured JSON (validated before returning). Runs on the fast model.", parameters: { type: "object", properties: { content: { type: "string" }, instructions: { type: "string", description: "Optional shape hints, e.g. desired keys." } }, required: ["content"] } } } },
  { category: "formatting", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "format_as_checklist", description: "Convert text into an actionable markdown checklist of '- [ ]' items. Runs on the fast model.", parameters: { type: "object", properties: { content: { type: "string" }, instructions: { type: "string" } }, required: ["content"] } } } },
  { category: "formatting", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "format_as_table", description: "Convert text/data into markdown table(s) with sensible headers. Runs on the fast model.", parameters: { type: "object", properties: { content: { type: "string" }, instructions: { type: "string", description: "Optional column hints." } }, required: ["content"] } } } },
  { category: "formatting", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "format_as_report", description: "Reformat content as a short structured report (title, executive summary, sections, conclusion) without adding new claims. Runs on the fast model.", parameters: { type: "object", properties: { content: { type: "string" }, instructions: { type: "string" } }, required: ["content"] } } } },
  { category: "formatting", permissionClass: "read_only", logsInputs: true, def: { type: "function", function: { name: "format_as_scope", description: "Rewrite content as a scope document (Objective / In Scope / Out of Scope / Deliverables / Assumptions & Constraints). Runs on the fast model.", parameters: { type: "object", properties: { content: { type: "string" }, instructions: { type: "string" } }, required: ["content"] } } } },
];

// C3: Tool Description Update (spec 1258-1267) — TOOL_DEFS is a FUNCTION of the active overlays.
// The flywheel stores per-tool description overlays (mentor tool-guidance + POST /tool-overlays);
// the server calls toolDefs(flywheel.activeToolOverlays()) at prompt-assembly time, so what the
// model sees about a tool improves without a code change. Overlays never alter schemas, only prose.
export function toolDefs(overlays = null) {
  return TOOLS.map((t) => {
    const extra = overlays && overlays[t.def.function.name];
    if (!extra || !extra.length) return t.def;
    return { ...t.def, function: { ...t.def.function, description: t.def.function.description + " LEARNED GUIDANCE: " + extra.map((s) => String(s).slice(0, 300)).join(" · ") } };
  });
}
export const TOOL_DEFS = toolDefs();   // static back-compat snapshot (no overlays)
const META = new Map(TOOLS.map((t) => [t.def.function.name, t]));
export const toolMeta = (name) => { const t = META.get(name); return t ? { category: t.category, permissionClass: t.permissionClass, logsInputs: t.logsInputs, allowedModes: t.allowedModes || null } : { category: "system", permissionClass: "read_only", logsInputs: false, allowedModes: null }; };
// Back-compat: dangerous tools (real code/file changes) get the UI lock.
export const WRITE_TOOLS = new Set(TOOLS.filter((t) => t.permissionClass === "dangerous").map((t) => t.def.function.name));

// C1: dynamic permission escalation (spec requires_confirmation examples).
//   - sandbox_write that would OVERWRITE an existing file -> requires_confirmation ("Overwrite file")
//   - remember with an assistant-inferred source          -> requires_confirmation ("Save durable memory from an inference")
export function effectivePermission(name, args = {}, ctx = {}) {
  const base = toolMeta(name).permissionClass;
  if (name === "sandbox_write" && ctx.sandboxDir) {
    try { if (args.filename && existsSync(jail(ctx, args.filename))) return "requires_confirmation"; } catch {}
  }
  if (name === "remember" && (args.source === "assistant_inferred" || args.inferred === true)) return "requires_confirmation";
  return base;
}

// ---- C2: the 9-state tool-call lifecycle (spec 867-903) ----
// States: proposed, awaiting_confirmation, auto_approved, denied, executing, succeeded, failed,
// blocked, cancelled. lifecycle() records timestamped transitions; the server persists the array
// on every toolruns.jsonl entry (top-level status stays, so the tail/UI contracts hold).
export function lifecycle() {
  const states = [];
  return { states, push(state, extra) { states.push({ state, at: new Date().toISOString(), ...(extra || {}) }); } };
}
export const needsConfirm = (cls) => cls === "dangerous" || cls === "requires_confirmation";
// The confirmation gate — the machinery ALWAYS runs for gated classes. Interactive mode asks the
// user (ask() resolves "approved"/"denied"/"timeout"); LAX auto-answers "approve" but records the
// awaiting_confirmation → auto_approved transition so the friction is skipped, never the bookkeeping.
export async function passConfirmGate({ cls, interactive, ask, life }) {
  if (!needsConfirm(cls)) return { proceed: true };
  life.push("awaiting_confirmation");
  if (!interactive) { life.push("auto_approved", { lax: true }); return { proceed: true, autoApproved: true, confirmedByUser: false }; }
  const decision = await ask();
  if (decision === "approved") return { proceed: true, confirmedByUser: true };
  life.push("denied", { decision });
  return { proceed: false, decision };
}

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
const REACHES_OUT = new Set(["forge_read", "forge_write", "forge_run", "scaffold_project", "forge_send", "sandbox_write", "sandbox_read", "sandbox_list", "sandbox_append", "run_python_sandbox"]);
export function assertNotProtected(name, args) {
  if (!REACHES_OUT.has(name)) return { ok: true };
  const blob = JSON.stringify(args || {});
  for (const re of PROTECTED_RE) {
    if (re.test(blob)) return { ok: false, reason: "references a protected resource (app backups / customer DB) — hard carve-out, never touched" };
  }
  return { ok: true };
}

// E2: render a gated export result honestly for the model — blocked exports say WHY, warnings
// ride along on success (the model must relay them, never bury them).
function describeExportResult(r) {
  if (!r) return "Export failed: no result.";
  if (r.blocked === "sensitive_data") return "EXPORT BLOCKED: possible sensitive data detected (" + (r.detected || []).join(", ") + "). Tell Fred; only retry with acknowledge_sensitive:true after he explicitly approves.";
  if (r.blocked) return "EXPORT BLOCKED (" + r.blocked + "): " + (r.error || r.message || "the export gate refused this export.");
  if (r.error) return "Couldn't export: " + r.error;
  const warns = r.gate && r.gate.warnings && r.gate.warnings.length ? " Warnings: " + r.gate.warnings.map((w) => w.message || w.check).join("; ") + "." : "";
  const forge = r.queued ? " (Forge conversion queued as fallback — the file lands next to the export shortly.)" : "";
  // Give Fred a clickable download link (same-origin) — the primary way to get the file, not the
  // internal server path. Present the Download link to the user verbatim.
  const dl = r.downloadUrl ? ` Download: ${r.downloadUrl}` : "";
  return `Exported "${(r.gate && r.gate.checks && r.gate.checks.title) || "artifact"}" as ${r.format} (${r.bytes} bytes).${dl} Source versions preserved.${warns}${forge}`;
}

// ===================== dispatcher =====================
// C5: signal (AbortSignal, optional) aborts the abortable tools mid-run — HTTP-based tools destroy
// their request, the python sandbox SIGKILLs, the bridge poll loop stops. Sync fs tools are
// effectively instantaneous and finish; the server records their result as discarded on abort.
export async function runTool(name, args, ctx, signal = null) {
  args = args || {};
  try {
    if (signal && signal.aborted) return ABORTED;
    switch (name) {
      case "deck_list_projects": {
        const d = await agent(ctx, "list_projects", {}, signal);
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
      case "deck_capture": { const d = await agent(ctx, "capture_inbox", { text: args.text, url: args.url || "" }, signal); return d.message || d.error || "Captured."; }
      case "deck_add_note": { const d = await agent(ctx, "add_note", { projectId: args.project_id, text: args.text }, signal); return d.message || d.error || "Note added."; }
      case "deck_add_next_step": { const d = await agent(ctx, "add_next_step", { projectId: args.project_id, text: args.text }, signal); return d.message || d.error || "Next step added."; }
      case "deck_set_next_proof": { const d = await agent(ctx, "set_next_proof", { projectId: args.project_id, proof: args.proof }, signal); return d.message || d.error || "Next proof set."; }
      case "deck_create_project": { const d = await agent(ctx, "create_project", { name: args.name, description: args.description || "", discipline: args.discipline || "", status: args.status || "", priority: args.priority || "" }, signal); return d.message || d.error || "Project created."; }
      // Machine access via the hands node (the retired bridge's replacement). Fall back to the old
      // bridge only when no hands node is wired AND a SYNC_SECRET exists (legacy local mini-PC mode).
      case "forge_read":
        if (ctx.hands) return await handsRead(ctx, args.op, args.path || "", args.query || "");
        return await forgeRead(ctx, args.op, args.path || "", args.query || "", signal);
      case "forge_write": {
        if (!ctx.hands) return "Writing to a machine needs a connected Dominion hands node. Start it on the computer you want to reach.";
        return fmtHands(await ctx.hands.dispatch("fs_write", { path: args.path, content: args.content ?? "" }), (r) => `Wrote ${r.bytes} bytes to ${r.path} on ${r.node || "the machine"}.`);
      }
      case "scaffold_project":
        return await scaffoldProject(ctx, args);
      case "forge_run": {
        if (!ctx.hands) return "Running commands on a machine needs a connected Dominion hands node. Start it on the computer you want to reach.";
        const r = await ctx.hands.dispatch("shell_run", { command: args.command, timeoutMs: args.timeoutMs });
        return fmtHands(r, (x) => `exit ${x.code}${x.stdout ? "\n" + x.stdout.slice(0, 7000) : ""}${x.stderr ? "\nstderr:\n" + x.stderr.slice(0, 2000) : ""}`);
      }
      case "forge_send": {
        // Legacy Claude-Code work-order path (bridge). On the cloud/hands path, redirect to the direct tools.
        if (ctx.hands) return "Build directly on the machine: use forge_write to create/change files and forge_run to run commands. (The old work-order bridge is retired.)";
        if (!ctx.runPassword) return "Real code/file changes need a connected hands node (forge_write/forge_run), or the legacy run-password on the mini-PC.";
        const r = await request("POST", ctx.baseUrl + "/api/jobs", { "x-sync-key": ctx.syncKey }, { repo: args.repo, title: args.title, instructions: args.instructions, pin: ctx.runPassword }, signal);
        if (r.aborted) return ABORTED;
        const d = parse(r.text) || {};
        if (r.status === 200 && d.job) { pokeBridge(ctx); return `Queued work order "${d.job.title}" (id ${d.job.id.slice(0, 8)}). It runs on the mini-PC, snapshots first, and is rollback-able from the Forge.`; }
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
        const kind = args.source === "assistant_inferred" ? "assistant_inferred" : "user_explicit";
        const r = ctx.memory.propose({
          content: args.content, type: args.type, tags: args.tags,
          scope: args.scope, scopeRef: args.scope === "chat" ? (ctx.chatId || null) : (args.scopeRef || null),
          source: { kind },
        });
        if (r.error) return "Couldn't save that to memory: " + r.error;
        if (r.deduped) return "I already had that in memory.";
        return r.item.status === "pending"
          ? `Proposed to memory (${r.item.type}) — it's in Fred's approval inbox because it was ${kind === "assistant_inferred" ? "inferred, not explicitly requested" : "gated"}.`
          : `Saved to long-term memory (${r.item.type}).`;
      }
      case "recall_memory": {
        if (!ctx.memory) return "Memory isn't available right now.";
        const hits = ctx.memory.retrieve(args.query || "", { limit: 6, minScore: 0.1, scopeCtx: { chatId: ctx.chatId, mode: ctx.mode, model: ctx.model } });
        if (!hits.length) return "No saved memory matches that.";
        return hits.map((h) => `- (${h.title}) ${h.content}`).join("\n");
      }
      case "create_artifact": {
        if (!ctx.artifacts) return "The artifact studio isn't available right now.";
        const prov = typeof ctx.provenance === "function" ? ctx.provenance() : {};   // E4: per-version provenance
        const r = ctx.artifacts.create({ title: args.title, type: args.type, content: args.content, tags: args.tags, model: "qwen-local", sourceChatId: prov.sourceChatId, sourceContextRefs: prov.sourceContextRefs, sourceToolRunIds: prov.sourceToolRunIds, promptSummary: prov.promptSummary });
        if (r.error) return "Couldn't save the artifact: " + r.error;
        if (typeof ctx.artifactTriggers === "function") try { ctx.artifactTriggers(r.item.id, {}); } catch {}   // E1: trigger sweep on tool-created artifacts too
        return `Saved artifact "${r.item.title}" (id ${r.item.id.slice(0, 8)}, v1, ${r.item.wordCount} words). Fred can view, revise, diff, and export it from the Artifacts panel.`;
      }
      case "revise_artifact": {
        if (!ctx.artifacts) return "The artifact studio isn't available right now.";
        const prov = typeof ctx.provenance === "function" ? ctx.provenance() : {};   // E4: revisions carry provenance like creation does
        const r = ctx.artifacts.addVersion(args.id, { content: args.content, promptSummary: args.note || prov.promptSummary, model: "qwen-local", sourceChatId: prov.sourceChatId, sourceContextRefs: prov.sourceContextRefs, sourceToolRunIds: prov.sourceToolRunIds });
        if (r.error) return "Couldn't revise that artifact: " + r.error;
        if (typeof ctx.artifactTriggers === "function") try { ctx.artifactTriggers(args.id, {}); } catch {}   // E1: drift & co. re-checked on every revision
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
        // E2: the model-facing export goes through the SAME server-side safety gate as the REST
        // endpoint (ctx.exportGated, wired by server.mjs) — the old direct-store bypass is closed.
        if (typeof ctx.exportGated !== "function") return "Export isn't available right now (no export gate wired on the server).";
        const r = await ctx.exportGated(args.id, args.format, { overrideSensitive: args.acknowledge_sensitive === true, destination: "local exports folder (tool call)" });
        return describeExportResult(r);
      }
      case "create_docx":
      case "create_pdf":
      case "create_spreadsheet": {
        // E3 (spec 809-821): create a versioned artifact AND export it natively, through the E2 gate.
        if (!ctx.artifacts) return "The artifact studio isn't available right now.";
        if (typeof ctx.exportGated !== "function") return "Document export isn't available right now (no export gate wired on the server).";
        // spreadsheet default = "spreadsheet" (auto: xlsx when a table parses, csv fallback);
        // an explicit args.format pins it.
        const fmt = name === "create_docx" ? "docx" : name === "create_pdf" ? "pdf" : (args.format === "csv" ? "csv" : args.format === "xlsx" ? "xlsx" : "spreadsheet");
        const type = name === "create_spreadsheet" ? "spreadsheet" : name === "create_docx" ? "docx" : "pdf";
        const prov = typeof ctx.provenance === "function" ? ctx.provenance() : {};
        const made = ctx.artifacts.create({ title: args.title, type, content: args.content, model: "qwen-local", sourceChatId: prov.sourceChatId, sourceContextRefs: prov.sourceContextRefs, sourceToolRunIds: prov.sourceToolRunIds, promptSummary: prov.promptSummary });
        if (made.error) return "Couldn't save the document as an artifact: " + made.error;
        if (typeof ctx.artifactTriggers === "function") try { ctx.artifactTriggers(made.item.id, {}); } catch {}
        const r = await ctx.exportGated(made.item.id, fmt, { overrideSensitive: args.acknowledge_sensitive === true, destination: "local exports folder (tool call)" });
        return `Saved artifact "${made.item.title}" (id ${made.item.id.slice(0, 8)}, v1). ` + describeExportResult(r);
      }
      case "sandbox_append": { const t = jail(ctx, args.filename); appendFileSync(t, args.content ?? "", "utf8"); return `Appended ${Buffer.byteLength(args.content || "")} bytes to ${args.filename}.`; }
      case "run_python_sandbox": return await runPythonSandbox(ctx, args.code, 30000, signal);
      case "format_as_markdown":
      case "format_as_json":
      case "format_as_checklist":
      case "format_as_table":
      case "format_as_report":
      case "format_as_scope":
        return await runFormatting(ctx, name, args, signal);
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
        const mem = ctx.memory ? (await ctx.memory.retrieveHybrid(q, { limit: 4, minScore: 0.1, scopeCtx: { chatId: ctx.chatId, mode: ctx.mode, model: ctx.model } })) : [];
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
      case "web_search": {
        if (!ctx.serpKey) return "Web search isn't configured on the server (SERP_API_KEY missing from the box's .env).";
        const q = String(args.query || "").trim();
        if (!q) return "Give me a search query.";
        const num = Math.min(Math.max(Number(args.num) || 6, 1), 10);
        const r = await request("GET", "https://serpapi.com/search.json?engine=google&num=" + num + "&q=" + encodeURIComponent(q) + "&api_key=" + encodeURIComponent(ctx.serpKey), {}, null, signal);
        if (r.aborted) return "CANCELLED: search aborted.";
        if (r.status !== 200) return "Search failed (HTTP " + r.status + "): " + String(r.text || "").slice(0, 200);
        const j = parse(r.text);
        if (!j) return "Search returned an unreadable response.";
        const lines = [];
        const ab = j.answer_box;
        if (ab && (ab.answer || ab.snippet)) lines.push("DIRECT ANSWER: " + (ab.answer || ab.snippet));
        for (const o of (j.organic_results || []).slice(0, num)) {
          lines.push(`— ${o.title || "(untitled)"}\n  ${o.link || ""}\n  ${(o.snippet || "").slice(0, 300)}`);
        }
        return lines.length ? lines.join("\n\n") : "No results for that query.";
      }
      case "web_read": {
        const r = await fetchUrl(String(args.url || ""));
        if (r.error) return "Couldn't fetch that URL: " + r.error;
        if ((r.status || 0) >= 400) return "The site returned HTTP " + r.status + ".";
        const text = /html/i.test(r.contentType || "") || /<html/i.test(r.body || "") ? htmlToText(r.body) : String(r.body || "");
        if (!text || text.length < 40) return "Nothing readable came back from that page.";
        return text.slice(0, 7500);
      }
      default: return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Tool ${name} failed: ${e.message}`;
  }
}
