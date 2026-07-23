/*
 * Dominion AI — per-user stores + the role-based tool wall (SOW items 3, 5, 6).
 *
 * Each non-owner user gets their OWN stores under /data/users/<uid>/, lazily created and cached, so
 * no user can see another's chats, memory, or artifacts. The OWNER short-circuits to the app's
 * existing global stores, so Fred's path is byte-for-byte unchanged.
 *
 * The tool wall: capabilities come from the CALLER's role. The owner gets everything (his machines,
 * deck, persona-write). Non-owners get a safe set with NO reach into Fred's machines, command deck,
 * or persona corpus. Their own machine access (Forge) arrives later as an explicitly own-node tool.
 */
import { createMemoryStore } from "./memory.mjs";
import { createArtifactStore } from "./artifacts.mjs";
import { createChatLog } from "./chatlog.mjs";
import { createChatSync } from "./chatsync.mjs";
import { createFlywheel } from "./flywheel.mjs";
import { createLongRun } from "./longrun.mjs";
import { sealInterrupted } from "./longrunglue.mjs";
import { join } from "node:path";

// Tools a non-owner may call. Everything here is safe: web, their own artifacts/memory/sandbox,
// documents, formatting, review, retrieval, and READ-only persona. Deliberately ABSENT: forge_read,
// forge_send, deck_* (Fred's machines + command deck), add_to_persona, scrape_to_persona (corpus write).
export const SAFE_TOOLS = new Set([
  "web_search", "web_read",
  "format_as_markdown", "format_as_json", "format_as_checklist", "format_as_table", "format_as_report", "format_as_scope",
  "create_artifact", "revise_artifact", "list_artifacts", "read_artifact", "export_artifact",
  "create_docx", "create_pdf", "create_spreadsheet", "search_artifacts", "compare_artifacts",
  "remember", "recall_memory", "update_memory", "save_lesson", "request_review",
  "search_chats", "retrieve_context_pack",
  // Long-run jobs (SOW item 7, D4): guests may promote a chat ask to a job. The money gates
  // live server-side (pay-before-access + D2 tranches), so listing the tool is safe.
  "long_job",
  // Every user, paying or not, gets to ask this app how it works and where its controls are.
  "app_help",
  // NOTE: search_persona is DELIBERATELY absent. Non-owners never read the corpus CONTENTS. They get
  // only titles + a summary of what it contributes (via a read-only panel), and the "As Fred" voice
  // is shaped by the distilled profile summary, never by injecting Fred's raw writing. (Fred, 2026-07-16)
  "sandbox_write", "sandbox_read", "sandbox_list", "sandbox_append", "run_python_sandbox",
]);

// The machine-reach tools a non-owner gets ONLY when they have enabled their own Forge node AND
// engaged Forge Mode this turn. They act on the user's OWN node (bound to their uid by the hub) within
// the folders the user picked; the ironclad carve-outs still hold node-side and hub-side.
//
// browser_control and desktop_control are DELIBERATELY ABSENT (Fred, 2026-07-18). Both were built
// for the owner's Wave 3 reach. desktop_control in particular acts below the tool-boundary
// carve-outs (it can drive any app a person could), so handing it to paying guests on their own
// machines is a liability decision Fred has not made. Adding them here is the only switch needed.
// forge_rollback rides along deliberately: anyone who can make a change on their own machine must
// be able to undo it without asking Fred. It only ever restores from snapshots this node took.
export const FORGE_TOOLS = new Set(["forge_read", "forge_write", "forge_run", "scaffold_project", "forge_rollback"]);

// Owner = all tools (null sentinel = no filter). Non-owner = SAFE_TOOLS (+ FORGE_TOOLS when engaged).
export function allowedToolNames(role) { return role === "owner" ? null : SAFE_TOOLS; }
export function toolAllowedFor(role, name, extra = null) { return role === "owner" || SAFE_TOOLS.has(name) || !!(extra && extra.has(name)); }

// Filter a list of tool defs to what a role may see/call. Owner passes through unchanged. `extra` is an
// optional Set of extra tool names allowed for THIS turn (e.g. FORGE_TOOLS when Forge is engaged).
export function filterToolDefs(defs, role, extra = null) {
  if (role === "owner") return defs;
  return (defs || []).filter((d) => { const n = d && d.function && d.function.name; return SAFE_TOOLS.has(n) || !!(extra && extra.has(n)); });
}

export function createTenantStores({ baseDir, uid, embed }) {
  const root = join(baseDir, "users", uid);
  const memory = createMemoryStore({ dir: join(root, "memory"), gating: "lax", embed });
  const chatlog = createChatLog({ dir: join(root, "chatlog") });
  // Cross-device chat sync: the faithful copy of this user's conversations (chatlog above is the
  // lossy retrieval index). Per-uid directory = a user's chats are reachable only through their own
  // resolved tenant bundle.
  const chatsync = createChatSync({ dir: join(root, "chatsync") });
  const artifacts = createArtifactStore({ dir: join(root, "artifacts") });
  const flywheel = createFlywheel({ dir: join(root, "flywheel") });
  // Long-run jobs (the 36-hour harness): per-uid dir, so one user's job ledger is reachable
  // only through their own resolved bundle. The chatsync lesson made this a law: a store added
  // here must ALSO ride the resolver's owner branch below, or guests get 503s.
  const longrun = createLongRun({ dir: join(root, "jobs") });
  // Bundles are built lazily on first touch, so this runs once per user per process: any job
  // left "running" by a dead process seals paused before anyone reads a lying state.
  try { sealInterrupted(longrun); } catch {}
  const sandboxDir = join(root, "sandbox");
  return { root, memory, chatlog, chatsync, artifacts, flywheel, longrun, sandboxDir };
}

// A resolver caches per-user store bundles and returns a tenant view for a request.
//   globals  = { memory, chatlog, artifacts, flywheel, sandboxDir, ctx, persona }  (the owner's)
//   users    = the tenancy users store (identify())
export function createTenantResolver({ baseDir, embed, globals, users }) {
  const cache = new Map();   // uid -> stores bundle
  function storesFor(id) {
    if (!cache.has(id.uid)) cache.set(id.uid, createTenantStores({ baseDir, uid: id.uid, embed }));
    return cache.get(id.uid);
  }
  function resolve(req) {
    const id = users.identify(req);
    if (id.role === "owner") {
      return { ...id, memory: globals.memory, chatlog: globals.chatlog, chatsync: globals.chatsync,
        artifacts: globals.artifacts, flywheel: globals.flywheel, longrun: globals.longrun,
        sandboxDir: globals.sandboxDir, persona: globals.persona, ctxBase: globals.ctx };
    }
    const s = id.role === "anon" ? null : storesFor(id);
    // Non-owner ctx: their stores + their sandbox + the SHARED persona (read-only) + owner secrets
    // are NOT copied (no deck/forge creds), so those tools are inert for them even before the filter.
    const ctxBase = s ? { sandboxDir: s.sandboxDir, memory: s.memory, artifacts: s.artifacts,
      chatlog: s.chatlog, flywheel: s.flywheel, persona: globals.persona, serpKey: globals.ctx.serpKey,
      lightChat: globals.ctx.lightChat,
      // Export through the CALLER's own artifact store so non-owners never touch the owner's artifacts.
      exportGated: (id, fmt, o) => globals.ctx.exportGated(id, fmt, o, s.artifacts) } : null;
    return s ? { ...id, memory: s.memory, chatlog: s.chatlog, chatsync: s.chatsync, artifacts: s.artifacts,
      flywheel: s.flywheel, longrun: s.longrun, sandboxDir: s.sandboxDir, persona: globals.persona, ctxBase } : { ...id, ctxBase: null };
  }
  return { resolve, storesFor, cache };
}
