/*
 * Dominion AI - Connectors: outside services as first-class tools (Fred's "complete access" build).
 *
 * Every connector speaks MCP (Model Context Protocol, JSON-RPC 2.0) over one of two transports:
 *   http  - a hosted MCP endpoint (Zapier, GitHub remote, any custom URL the user adds)
 *   stdio - an npx-spawned MCP server process inside this container (Supabase, Stripe, Postgres...)
 *
 * TENANCY IS THE LAW HERE. Connector credentials and enabled-state live per-account:
 *   owner  -> <data>/connectors.json           (creds default from server env, owner may override)
 *   guest  -> <data>/users/<uid>/connectors.json  (guest MUST paste their own creds - the env
 *             fallback is owner-only and never, under any code path, reaches a non-owner)
 * A guest can only use a connector at all when the owner has allowed it for guests (guestFlags,
 * defaulting from the registry) and the transport is not an owner-pending OAuth one.
 *
 * Secrets are AES-256-GCM encrypted at rest with a key auto-minted next to the state files
 * (CONNECTORS_SECRET env overrides). Namespaced tool names: cx_<connector>__<tool>.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { spawn } from "node:child_process";

// ---- registry ---------------------------------------------------------------------------------
// fields: what a user must supply. secret:true fields are encrypted at rest and never echoed back.
// ownerEnv: env var names the OWNER's copy defaults from (guests never touch these).
// guestDefault: whether guests may bring their own account before the owner flips anything.
export const REGISTRY = [
  { id: "web", name: "Web search + reader", group: "Built in", builtin: true,
    blurb: "Live Google search and full-page reading. Always on for every account." },
  { id: "machine", name: "Your machine (Forge)", group: "Built in", builtin: true,
    blurb: "File and command reach on your own computer through your Dominion node. Managed in the Forge panel below." },
  { id: "zapier", name: "Zapier", group: "Automation", transport: "http", auth: "token", guestDefault: true,
    blurb: "Bridge to 6,000+ apps: Gmail, Sheets, Slack, SMS, CRMs and more, through your own Zapier MCP server.",
    fields: [{ k: "url", label: "Zapier MCP URL" }, { k: "token", label: "Zapier MCP token", secret: true }],
    ownerEnv: { url: "ZAPIER_MCP_URL", token: "ZAPIER_MCP_TOKEN" },
    help: "mcp.zapier.com: create an MCP server, pick the apps and actions you want, copy the URL and token here." },
  { id: "github", name: "GitHub", group: "Development", transport: "http", auth: "token", guestDefault: true,
    fixedUrl: "https://api.githubcopilot.com/mcp/",
    blurb: "Repos, issues, pull requests, code search on your GitHub account.",
    fields: [{ k: "token", label: "GitHub personal access token", secret: true }],
    ownerEnv: { token: "GITHUB_MCP_TOKEN" },
    help: "github.com/settings/tokens: a fine-grained token with the repo permissions you want to grant." },
  { id: "supabase", name: "Supabase", group: "Development", transport: "stdio", auth: "token", guestDefault: true,
    cmd: "npx", argsTpl: ["-y", "@supabase/mcp-server-supabase@latest", "--access-token={token}"],
    blurb: "Your Supabase projects: SQL, tables, migrations, logs, edge functions.",
    fields: [{ k: "token", label: "Supabase access token", secret: true }],
    ownerEnv: { token: "SUPABASE_MCP_TOKEN" },
    help: "supabase.com/dashboard/account/tokens: generate an access token." },
  { id: "stripe", name: "Stripe", group: "Business", transport: "stdio", auth: "token", guestDefault: true,
    cmd: "npx", argsTpl: ["-y", "@stripe/mcp", "--tools=all", "--api-key={token}"],
    blurb: "Your Stripe account: customers, payments, invoices, subscriptions.",
    fields: [{ k: "token", label: "Stripe secret key", secret: true }],
    ownerEnv: { token: "CONNECTOR_STRIPE_KEY" },
    help: "dashboard.stripe.com/apikeys: use a restricted key scoped to what you want it to reach." },
  { id: "postgres", name: "Postgres", group: "Development", transport: "stdio", auth: "token", guestDefault: true,
    cmd: "npx", argsTpl: ["-y", "@modelcontextprotocol/server-postgres", "{url}"],
    blurb: "Read-oriented SQL against any Postgres database you connect.",
    fields: [{ k: "url", label: "Connection string (postgresql://...)", secret: true }],
    ownerEnv: { url: "CONNECTOR_PG_URL" },
    help: "Any Postgres connection string. Use a read-only role unless you mean it." },
  { id: "railway", name: "Railway", group: "Development", transport: "stdio", auth: "token", guestDefault: true, experimental: true,
    cmd: "npx", argsTpl: ["-y", "@jasontanswe/railway-mcp"], envTpl: { RAILWAY_API_TOKEN: "{token}" },
    blurb: "Railway projects, services, deploys and variables (community server).",
    fields: [{ k: "token", label: "Railway API token", secret: true }],
    ownerEnv: { token: "CONNECTOR_RAILWAY_TOKEN" },
    help: "railway.app/account/tokens: create an account token." },
  { id: "cloudflare", name: "Cloudflare", group: "Development", transport: "stdio", auth: "token", guestDefault: true, experimental: true,
    cmd: "npx", argsTpl: ["-y", "@cloudflare/mcp-server-cloudflare", "run", "{account}"], envTpl: { CLOUDFLARE_API_TOKEN: "{token}" },
    blurb: "Workers, KV, R2, D1 and DNS on your Cloudflare account (community server).",
    fields: [{ k: "token", label: "Cloudflare API token", secret: true }, { k: "account", label: "Cloudflare account ID" }],
    ownerEnv: { token: "CONNECTOR_CF_TOKEN", account: "CONNECTOR_CF_ACCOUNT" },
    help: "dash.cloudflare.com: My Profile, API Tokens. The account ID is on any zone's overview page." },
  { id: "vercel", name: "Vercel", group: "Development", auth: "oauth", pending: true,
    blurb: "Deployments, projects and logs. Vercel's official server requires an interactive OAuth sign-in; not wired yet." },
  // Provider-backed (native implementation, not MCP): the "provider" flag makes the engine route
  // this entry to the matching object in the providers map (google.mjs). OAuth per account.
  { id: "google", name: "Google Workspace", group: "Google", auth: "oauth", provider: true, guestDefault: false,
    blurb: "Gmail, Calendar, Drive, Docs and Sheets on this account's own connected Google account.",
    help: "Click Connect Google, approve the consent screen, and the tools go live for this account." },
];
const BY_ID = new Map(REGISTRY.map((r) => [r.id, r]));

// Same ironclad carve-out spirit as tools.mjs assertNotProtected: connector calls whose arguments
// reference the backup SSD or a prod dump/restore are refused outright, every account, every mode.
const PROTECTED_RE = [/(^|[^a-z0-9])d:[\\/]/i, /app[-_ ]?backups?/i, /\bdb[-_ ]?backups?\b/i, /pg_dump|pg_restore/i];

const TOOL_CAP = 40;               // max tools injected per connector (keeps prompts lean; logged, never silent)
const LIST_TTL_MS = 10 * 60 * 1000;   // tools/list cache
const IDLE_KILL_MS = 5 * 60 * 1000;   // stdio child reaper
const PROTOCOL = "2025-03-26";

// ---- crypto -----------------------------------------------------------------------------------
// connectorCrypto: the same key + cipher the engine uses, exported so provider modules
// (google.mjs) can encrypt their own token stores without a second key to manage.
export function connectorCrypto({ dir, cfgGet }) {
  const key = loadKey(join(dir, "connectors"), cfgGet("CONNECTORS_SECRET", ""));
  return { enc: (s) => enc(key, s), dec: (s) => dec(key, s) };
}
function loadKey(dir, envSecret) {
  if (envSecret) return createHash("sha256").update(String(envSecret)).digest();
  const f = join(dir, ".connector-key");
  try { return Buffer.from(readFileSync(f, "utf8").trim(), "hex"); } catch {}
  const k = randomBytes(32);
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, k.toString("hex"), { mode: 0o600 });
  return k;
}
function enc(key, text) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return "enc:v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function dec(key, blob) {
  if (!String(blob).startsWith("enc:v1:")) return String(blob);
  const raw = Buffer.from(String(blob).slice(7), "base64");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

// ---- name mangling ----------------------------------------------------------------------------
const sane = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, "_");
export const isConnectorTool = (name) => /^cx_/.test(String(name || ""));
const mangle = (cxId, tool) => "cx_" + sane(cxId) + "__" + sane(tool);

// ---- MCP wire: http transport -----------------------------------------------------------------
function sseExtract(text) {
  // Streamable-HTTP servers may answer a POST with an SSE body; the response is the message whose
  // JSON parses and carries an id. Concatenate multi-line data: fields per event.
  const out = [];
  for (const block of String(text).split(/\n\n/)) {
    const data = block.split(/\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch {}
  }
  return out;
}
async function httpRpc(conn, method, params, id, signal) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...conn.headers };
  if (conn.sessionId) headers["mcp-session-id"] = conn.sessionId;
  const body = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}), ...(id !== undefined ? { id } : {}) };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), conn.timeoutMs || 60000);
  const onAbort = () => ctl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const r = await fetch(conn.url, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
    const sid = r.headers.get("mcp-session-id");
    if (sid) conn.sessionId = sid;
    if (id === undefined) return null;                    // notification: fire and forget
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
    const ct = r.headers.get("content-type") || "";
    const msgs = ct.includes("text/event-stream") ? sseExtract(text) : [JSON.parse(text)];
    const msg = msgs.find((m) => m && m.id === id) || msgs.find((m) => m && (m.result !== undefined || m.error));
    if (!msg) throw new Error("no JSON-RPC response in body");
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error).slice(0, 300));
    return msg.result;
  } finally { clearTimeout(t); if (signal) signal.removeEventListener("abort", onAbort); }
}

// ---- MCP wire: stdio transport ----------------------------------------------------------------
function stdioSpawn(entry, cfg, cacheDir) {
  const fill = (s) => String(s).replace(/\{(\w+)\}/g, (_, k) => cfg[k] || "");
  const args = (entry.argsTpl || []).map(fill);
  const env = { ...process.env, NPM_CONFIG_CACHE: cacheDir, NPM_CONFIG_UPDATE_NOTIFIER: "false" };
  for (const [k, v] of Object.entries(entry.envTpl || {})) env[k] = fill(v);
  const child = spawn(entry.cmd, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const conn = { child, pending: new Map(), buf: "", nextId: 1, dead: false, deadReason: "", lastUsed: Date.now() };
  child.stdout.on("data", (d) => {
    conn.buf += d.toString("utf8");
    let nl;
    while ((nl = conn.buf.indexOf("\n")) >= 0) {
      const line = conn.buf.slice(0, nl).trim(); conn.buf = conn.buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = conn.pending.get(msg.id);
      if (p) { conn.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message || "rpc error")) : p.resolve(msg.result); }
    }
  });
  let errTail = "";
  child.stderr.on("data", (d) => { errTail = (errTail + d.toString("utf8")).slice(-500); });
  child.on("exit", (code) => {
    conn.dead = true; conn.deadReason = `process exited (${code}) ${errTail.trim().slice(-200)}`;
    for (const p of conn.pending.values()) p.reject(new Error(conn.deadReason));
    conn.pending.clear();
  });
  child.on("error", (e) => { conn.dead = true; conn.deadReason = e.message; });
  return conn;
}
function stdioRpc(conn, method, params, notify = false) {
  if (conn.dead) return Promise.reject(new Error("connector process is not running: " + conn.deadReason));
  conn.lastUsed = Date.now();
  const msg = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
  if (notify) { conn.child.stdin.write(JSON.stringify(msg) + "\n"); return Promise.resolve(null); }
  msg.id = conn.nextId++;
  return new Promise((resolve, reject) => {
    conn.pending.set(msg.id, { resolve, reject });
    const t = setTimeout(() => { conn.pending.delete(msg.id); reject(new Error("connector timed out (90s)")); }, 90000);
    const wrap = (fn) => (v) => { clearTimeout(t); fn(v); };
    conn.pending.set(msg.id, { resolve: wrap(resolve), reject: wrap(reject) });
    conn.child.stdin.write(JSON.stringify(msg) + "\n");
  });
}

// ---- the store + engine -----------------------------------------------------------------------
export function createConnectors({ dir, cfgGet, providers = {} }) {
  // dir = the data root (owner state at <dir>/connectors.json, guests at <dir>/users/<uid>/connectors.json)
  const keyDir = join(dir, "connectors");
  const key = loadKey(keyDir, cfgGet("CONNECTORS_SECRET", ""));
  const npmCache = join(dir, "npm-cache");

  const stateFile = (T) => T.isOwner ? join(dir, "connectors.json") : join(dir, "users", T.uid, "connectors.json");
  function loadState(T) {
    try { return JSON.parse(readFileSync(stateFile(T), "utf8")); } catch { return { enabled: {}, config: {}, custom: [], guestFlags: {} }; }
  }
  function saveState(T, s) { const f = stateFile(T); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(s, null, 1)); }

  // Owner state doubles as the policy store: guestFlags[id] overrides the registry's guestDefault.
  const ownerT = { isOwner: true, uid: "owner" };
  const guestAllowed = (id) => {
    const flags = loadState(ownerT).guestFlags || {};
    if (id in flags) return !!flags[id];
    const e = BY_ID.get(id);
    return !!(e && e.guestDefault);
  };

  // Entries visible to an account = registry + that account's OWN custom rows.
  function entriesFor(T) {
    const s = loadState(T);
    const custom = (s.custom || []).map((c) => ({ id: c.id, name: c.name, group: "Custom", transport: "http",
      auth: "token", custom: true, blurb: c.url, fields: [], guestDefault: true }));
    return [...REGISTRY, ...custom];
  }
  function entryFor(T, id) {
    const e = BY_ID.get(id);
    if (e) return e;
    const c = (loadState(T).custom || []).find((x) => x.id === id);
    return c ? { id: c.id, name: c.name, transport: "http", auth: "token", custom: true, fields: [], guestDefault: true } : null;
  }

  // Effective config: the account's own saved fields; the OWNER additionally falls back to env.
  function configFor(T, id) {
    const e = entryFor(T, id);
    if (!e) return null;
    const s = loadState(T);
    const saved = (s.config || {})[id] || {};
    const cust = (s.custom || []).find((x) => x.id === id);
    const out = {};
    for (const f of (e.fields || [])) {
      let v = saved[f.k];
      if (v) v = dec(key, v);
      if (!v && T.isOwner && e.ownerEnv && e.ownerEnv[f.k]) v = cfgGet(e.ownerEnv[f.k], "");
      if (v) out[f.k] = v;
    }
    if (cust) { out.url = dec(key, cust.url); if (cust.token) out.token = dec(key, cust.token); }
    if (e.fixedUrl) out.url = e.fixedUrl;
    return out;
  }
  const providerOf = (e) => (e && e.provider && providers[e.id]) || null;
  const configured = (T, id) => {
    const e = entryFor(T, id); if (!e) return false;
    const p = providerOf(e);
    if (p) return p.ready() && p.connected(T);
    const c = configFor(T, id) || {};
    if (e.custom) return !!c.url;
    return (e.fields || []).every((f) => !!c[f.k]);
  };

  // May THIS account use THIS connector right now?
  function usable(T, id) {
    const e = entryFor(T, id);
    if (!e || e.builtin || (e.pending && !providerOf(e))) return { ok: false, reason: e && e.pending ? "not available yet" : "built in" };
    const p = providerOf(e);
    if (e.provider && !p) return { ok: false, reason: "not available yet" };
    if (p && !p.ready()) return { ok: false, reason: "not set up on the server yet" };
    if (!T.isOwner && !e.custom && !guestAllowed(id)) return { ok: false, reason: "not enabled for guest accounts" };
    if (!configured(T, id)) return { ok: false, reason: p ? "account not connected yet" : "needs credentials" };
    return { ok: true };
  }

  // ---- live connections (cache per account+connector) ----
  const conns = new Map();   // cacheKey -> { kind, conn, tools, toolsAt, nameMap }
  const cacheKey = (T, id) => (T.isOwner ? "owner" : T.uid) + "::" + id;
  setInterval(() => {   // stdio reaper
    const now = Date.now();
    for (const [k, c] of conns) {
      if (c.kind === "stdio" && c.conn && !c.conn.dead && now - c.conn.lastUsed > IDLE_KILL_MS) { try { c.conn.child.kill(); } catch {} conns.delete(k); }
      if (c.kind === "stdio" && c.conn && c.conn.dead) conns.delete(k);
    }
  }, 60 * 1000).unref();

  async function connect(T, id) {
    const k = cacheKey(T, id);
    let c = conns.get(k);
    if (c && (c.kind === "http" || (c.conn && !c.conn.dead))) return c;
    const e = entryFor(T, id);
    const cfg = configFor(T, id);
    if (!e || !cfg) throw new Error("connector not configured");
    if (e.transport === "http" || e.custom) {
      const headers = {};
      if (cfg.token) headers.authorization = "Bearer " + cfg.token;
      const conn = { url: cfg.url, headers, sessionId: null, timeoutMs: 60000 };
      const init = await httpRpc(conn, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "dominion-ai", version: "1.0" } }, 1);
      await httpRpc(conn, "notifications/initialized", {});
      c = { kind: "http", conn, server: init && init.serverInfo, tools: null, toolsAt: 0, nameMap: new Map() };
    } else {
      const conn = stdioSpawn(e, cfg, npmCache);
      const init = await stdioRpc(conn, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "dominion-ai", version: "1.0" } });
      await stdioRpc(conn, "notifications/initialized", {}, true);
      c = { kind: "stdio", conn, server: init && init.serverInfo, tools: null, toolsAt: 0, nameMap: new Map() };
    }
    conns.set(k, c);
    return c;
  }
  const rpc = (c, method, params, signal) => c.kind === "http" ? httpRpc(c.conn, method, params, ++rpcId, signal) : stdioRpc(c.conn, method, params);
  let rpcId = 100;

  async function toolsOf(T, id, force = false) {
    const c = await connect(T, id);
    if (!force && c.tools && Date.now() - c.toolsAt < LIST_TTL_MS) return c;
    const r = await rpc(c, "tools/list", {});
    const all = (r && r.tools) || [];
    const kept = all.slice(0, TOOL_CAP);
    if (all.length > kept.length) console.log(`[connectors] ${id}: capped ${all.length} tools to ${TOOL_CAP}`);
    c.total = all.length;
    c.tools = kept;
    c.toolsAt = Date.now();
    c.nameMap = new Map(kept.map((t) => [mangle(id, t.name), t.name]));
    return c;
  }

  // ---- public API ----
  async function listFor(T) {
    const s = loadState(T);
    const rows = [];
    for (const e of entriesFor(T)) {
      const row = { id: e.id, name: e.name, group: e.group || "Other", blurb: e.blurb || "", builtin: !!e.builtin,
        pending: !!e.pending, experimental: !!e.experimental, custom: !!e.custom, help: e.help || "",
        fields: (e.fields || []).map((f) => ({ k: f.k, label: f.label, secret: !!f.secret })) };
      if (e.builtin) { row.enabled = true; row.status = "on"; rows.push(row); continue; }
      const prov = providerOf(e);
      if (e.pending || (e.provider && !prov) || (prov && !prov.ready())) { row.enabled = false; row.status = "pending"; rows.push(row); continue; }
      if (prov) {
        row.guestAllowed = T.isOwner ? guestAllowed(e.id) : undefined;
        row.usable = T.isOwner || guestAllowed(e.id);
        row.configured = prov.connected(T);
        row.enabled = !!(s.enabled || {})[e.id];
        row.authUrl = "/connectors/" + e.id + "/start";
        row.disconnectable = row.configured;
        row.status = !row.usable ? "guest-locked" : !row.configured ? "needs-auth" : row.enabled ? "ready" : "off";
        rows.push(row); continue;
      }
      row.guestAllowed = T.isOwner ? guestAllowed(e.id) || !!e.custom : undefined;
      row.usable = T.isOwner || e.custom || guestAllowed(e.id);
      row.configured = configured(T, e.id);
      const saved = (s.config || {})[e.id] || {};
      row.savedFields = Object.keys(saved);
      row.enabled = !!(s.enabled || {})[e.id];
      row.status = !row.usable ? "guest-locked" : !row.configured ? "needs-key" : row.enabled ? "ready" : "off";
      rows.push(row);
    }
    return rows;
  }
  function setEnabled(T, id, on) {
    const e = entryFor(T, id);
    if (!e || e.builtin || (e.pending && !providerOf(e))) return { ok: false, error: "cannot toggle this connector" };
    if (on) { const u = usable(T, id); if (!u.ok) return { ok: false, error: u.reason }; }
    const s = loadState(T);
    s.enabled = s.enabled || {}; s.enabled[id] = !!on;
    saveState(T, s);
    if (!on) { const k = cacheKey(T, id); const c = conns.get(k); if (c && c.kind === "stdio" && c.conn) { try { c.conn.child.kill(); } catch {} } conns.delete(k); }
    return { ok: true, enabled: !!on };
  }
  function setConfig(T, id, fields) {
    const e = entryFor(T, id);
    if (!e || e.builtin || e.pending || e.custom) return { ok: false, error: "no credentials to set here" };
    if (!T.isOwner && !guestAllowed(id)) return { ok: false, error: "not enabled for guest accounts" };
    const s = loadState(T);
    s.config = s.config || {}; s.config[id] = s.config[id] || {};
    for (const f of (e.fields || [])) {
      const v = fields && typeof fields[f.k] === "string" ? fields[f.k].trim() : "";
      if (!v) continue;
      s.config[id][f.k] = f.secret ? enc(key, v) : v;
    }
    saveState(T, s);
    conns.delete(cacheKey(T, id));   // force fresh connection with the new creds
    return { ok: true, configured: configured(T, id) };
  }
  function addCustom(T, { name, url, token }) {
    name = String(name || "").trim(); url = String(url || "").trim();
    if (!name || !/^https:\/\//i.test(url)) return { ok: false, error: "a name and an https:// MCP URL are required" };
    const s = loadState(T);
    s.custom = s.custom || [];
    if (s.custom.length >= 10) return { ok: false, error: "custom connector limit (10) reached" };
    const id = "custom_" + sane(name.toLowerCase()).slice(0, 24) + "_" + randomBytes(2).toString("hex");
    s.custom.push({ id, name, url: enc(key, url), ...(token ? { token: enc(key, String(token).trim()) } : {}) });
    s.enabled = s.enabled || {}; s.enabled[id] = true;
    saveState(T, s);
    return { ok: true, id };
  }
  function removeCustom(T, id) {
    const s = loadState(T);
    s.custom = (s.custom || []).filter((c) => c.id !== id);
    if (s.enabled) delete s.enabled[id];
    if (s.config) delete s.config[id];
    saveState(T, s);
    conns.delete(cacheKey(T, id));
    return { ok: true };
  }
  function setGuestAllowed(T, id, on) {
    if (!T.isOwner) return { ok: false, error: "owner only" };
    const s = loadState(ownerT);
    s.guestFlags = s.guestFlags || {}; s.guestFlags[id] = !!on;
    saveState(ownerT, s);
    return { ok: true, guestAllowed: !!on };
  }
  async function test(T, id) {
    const u = usable(T, id);
    if (!u.ok) return { ok: false, error: u.reason };
    const p = providerOf(entryFor(T, id));
    if (p) return await p.test(T);
    try {
      conns.delete(cacheKey(T, id));
      const c = await toolsOf(T, id, true);
      return { ok: true, tools: c.tools.length, total: c.total, server: c.server && c.server.name };
    } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
  }

  // Tool defs for the chat loop: every ENABLED + usable connector of THIS account, namespaced.
  async function toolDefsFor(T) {
    const s = loadState(T);
    const out = [];
    for (const e of entriesFor(T)) {
      if (e.builtin || (e.pending && !providerOf(e))) continue;
      if (!(s.enabled || {})[e.id]) continue;
      if (!usable(T, e.id).ok) continue;
      const p = providerOf(e);
      try {
        const tools = p ? p.toolDefs() : (await toolsOf(T, e.id)).tools;
        for (const t of tools) out.push({ type: "function", function: {
          name: mangle(e.id, t.name),
          description: `[${e.name} connector] ` + String(t.description || t.name).slice(0, 700),
          parameters: t.inputSchema || { type: "object", properties: {} } } });
      } catch (err) { console.log(`[connectors] ${e.id} tool listing failed for ${T.isOwner ? "owner" : T.uid}: ${String(err.message || err).slice(0, 200)}`); }
    }
    return out;
  }

  async function run(T, mangled, args, signal) {
    const m = /^cx_(.+?)__(.+)$/.exec(String(mangled));
    if (!m) return "Unknown connector tool: " + mangled;
    const blob = JSON.stringify(args || {});
    for (const re of PROTECTED_RE) if (re.test(blob)) return "BLOCKED: this call references a protected resource (app backups / customer DB) - hard carve-out, never touched.";
    // Resolve the mangled name via the live nameMap (exact original casing), falling back over
    // every enabled connector whose sane() id matches.
    for (const e of entriesFor(T)) {
      if (e.builtin || (e.pending && !providerOf(e)) || sane(e.id) !== m[1]) continue;
      const u = usable(T, e.id);
      if (!u.ok) return `Connector ${e.name} is not available: ${u.reason}.`;
      if (!(loadState(T).enabled || {})[e.id]) return `Connector ${e.name} is switched off.`;
      const p = providerOf(e);
      if (p) return String(await p.call(T, m[2], args || {}, signal));
      try {
        const c = await toolsOf(T, e.id);
        const real = c.nameMap.get(mangled);
        if (!real) return `Tool ${mangled} is not offered by ${e.name} right now.`;
        const r = await rpc(c, "tools/call", { name: real, arguments: args || {} }, signal);
        const parts = (r && r.content) || [];
        const text = parts.filter((p) => p && p.type === "text").map((p) => p.text).join("\n").trim();
        const body = text || JSON.stringify(r && (r.structuredContent ?? r) || {}).slice(0, 6000);
        return (r && r.isError ? `Tool ${real} failed: ` : "") + body.slice(0, 12000);
      } catch (err) { return `Tool ${mangled} failed: ` + String(err.message || err).slice(0, 400); }
    }
    return `Connector for ${mangled} not found or not enabled.`;
  }

  const metaFor = () => ({ category: "connector", permissionClass: "requires_confirmation", logsInputs: true, allowedModes: null });

  // Provider-backed disconnect (OAuth un-link): wipes the account's token store + disables.
  function disconnect(T, id) {
    const p = providerOf(entryFor(T, id));
    if (!p) return { ok: false, error: "nothing to disconnect" };
    p.disconnect(T);
    const s = loadState(T);
    if (s.enabled) delete s.enabled[id];
    saveState(T, s);
    return { ok: true };
  }
  const provider = (id) => providers[id] || null;

  return { listFor, setEnabled, setConfig, addCustom, removeCustom, setGuestAllowed, test, toolDefsFor, run, metaFor, disconnect, provider, REGISTRY };
}
