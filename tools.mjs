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
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, join, sep } from "node:path";

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

// ===================== tool schemas (handed to the model) =====================
export const TOOL_DEFS = [
  { type: "function", function: { name: "deck_list_projects", description: "List Fred's Command Deck projects (id, name, status, priority, next proof, open next-steps). Use this before acting on a project so you have its id and current state.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "deck_capture", description: "Drop an idea, reminder, or link into Fred's capture inbox to triage later.", parameters: { type: "object", properties: { text: { type: "string", description: "What to capture." }, url: { type: "string", description: "Optional URL." } }, required: ["text"] } } },
  { type: "function", function: { name: "deck_add_note", description: "Append a note/log entry to a project (get the project id from deck_list_projects first).", parameters: { type: "object", properties: { project_id: { type: "string" }, text: { type: "string" } }, required: ["project_id", "text"] } } },
  { type: "function", function: { name: "deck_add_next_step", description: "Add an actionable next-step to a project.", parameters: { type: "object", properties: { project_id: { type: "string" }, text: { type: "string" } }, required: ["project_id", "text"] } } },
  { type: "function", function: { name: "deck_set_next_proof", description: "Set a project's Next Proof — the single riskiest thing it must prove next.", parameters: { type: "object", properties: { project_id: { type: "string" }, proof: { type: "string" } }, required: ["project_id", "proof"] } } },
  { type: "function", function: { name: "deck_create_project", description: "Create a new Command Deck project. discipline: Apps|Writing|Business|Product Development|Saints Dominion. status: Idea|Building|Live|Paused|Done.", parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, discipline: { type: "string" }, status: { type: "string" }, priority: { type: "string" } }, required: ["name"] } } },
  { type: "function", function: { name: "forge_read", description: "Read source/files on Fred's machine (READ-ONLY). op: 'read' a file or folder, 'list' a folder (omit path to see allowed roots), 'tree' a folder tree, 'grep' (needs query). Paths must be under the bridge's allowed roots.", parameters: { type: "object", properties: { op: { type: "string", enum: ["read", "list", "tree", "grep"] }, path: { type: "string" }, query: { type: "string" } }, required: ["op"] } } },
  { type: "function", function: { name: "forge_send", description: "Queue a REAL code/file work order for Claude Code on Fred's machine (the Forge). Use only for actual source/file changes or builds. repo is a named shortcut ('command-deck','cad-sandbox') or an absolute path under the allowed roots. Needs the run-password (configured on the server). The change snapshots first and is always rollback-able.", parameters: { type: "object", properties: { repo: { type: "string" }, title: { type: "string" }, instructions: { type: "string", description: "Clear, complete plain-English steps." } }, required: ["repo", "title", "instructions"] } } },
  { type: "function", function: { name: "sandbox_write", description: "Write (overwrite) a text file in your private sandbox folder on the mini-PC.", parameters: { type: "object", properties: { filename: { type: "string" }, content: { type: "string" } }, required: ["filename", "content"] } } },
  { type: "function", function: { name: "sandbox_read", description: "Read a text file from your private sandbox folder.", parameters: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"] } } },
  { type: "function", function: { name: "sandbox_list", description: "List the files in your private sandbox folder.", parameters: { type: "object", properties: {} } } },
];

// Tools that change real code/files (need the run-password) — surfaced so the UI can label them.
export const WRITE_TOOLS = new Set(["forge_send"]);

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
      default: return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Tool ${name} failed: ${e.message}`;
  }
}
