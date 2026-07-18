/*
 * Dominion AI - Google Workspace provider (Wave 2 of the connectors build).
 *
 * Not an MCP server: Google tools are implemented natively over Google's REST APIs with a
 * per-account OAuth token store. The connectors layer (connectors.mjs) mounts this as the
 * "google" registry entry, so the same tenant wall applies: each account (owner or guest)
 * connects its OWN Google account via /connectors/google/start and only that account's chat
 * turns can touch it. Tokens are AES-256-GCM encrypted at rest with the connectors key.
 *
 * Owner setup (one time, done by Fred in Google Cloud console):
 *   - OAuth client of type WEB APPLICATION with redirect URI <APP_BASE_URL>/connectors/google/callback
 *   - Gmail, Calendar, Drive, Sheets, Docs APIs enabled; users added as test users until verified.
 *   - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET set on the box.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHmac, randomBytes } from "node:crypto";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "openid", "email",
].join(" ");

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function createGoogleProvider({ dir, cfgGet, baseUrl, enc, dec }) {
  const clientId = () => cfgGet("GOOGLE_CLIENT_ID", "");
  const clientSecret = () => cfgGet("GOOGLE_CLIENT_SECRET", "");
  const redirect = () => baseUrl() + "/connectors/google/callback";
  const stateKey = () => createHmac("sha256", clientSecret() || "dominion").update("google-state").digest();

  const tokFile = (T) => T.isOwner ? join(dir, "connectors", "google-oauth.json") : join(dir, "users", T.uid, "google-oauth.json");
  function loadTok(T) { try { return JSON.parse(dec(readFileSync(tokFile(T), "utf8"))); } catch { return null; } }
  function saveTok(T, t) { const f = tokFile(T); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, enc(JSON.stringify(t))); }

  const ready = () => !!(clientId() && clientSecret());
  const connected = (T) => !!loadTok(T);

  // ---- OAuth flow ----
  function signState(uid) {
    const nonce = randomBytes(8).toString("hex"), body = uid + "." + nonce;
    return b64url(body) + "." + createHmac("sha256", stateKey()).update(body).digest("hex").slice(0, 32);
  }
  function verifyState(state) {
    const [b, sig] = String(state || "").split(".");
    if (!b || !sig) return null;
    const body = fromB64url(b).toString("utf8");
    const want = createHmac("sha256", stateKey()).update(body).digest("hex").slice(0, 32);
    return sig === want ? body.split(".")[0] : null;
  }
  function authUrl(T) {
    const uid = T.isOwner ? "owner" : T.uid;
    const q = new URLSearchParams({ client_id: clientId(), redirect_uri: redirect(), response_type: "code",
      scope: SCOPES, access_type: "offline", prompt: "consent", state: signState(uid) });
    return "https://accounts.google.com/o/oauth2/v2/auth?" + q;
  }
  async function handleCallback(query) {
    const uid = verifyState(query.get("state"));
    if (!uid) return { ok: false, error: "bad state" };
    if (query.get("error")) return { ok: false, error: query.get("error") };
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: query.get("code") || "", client_id: clientId(), client_secret: clientSecret(),
        redirect_uri: redirect(), grant_type: "authorization_code" }) });
    const t = await r.json();
    if (!t.access_token) return { ok: false, error: t.error_description || t.error || "token exchange failed" };
    const T = uid === "owner" ? { isOwner: true, uid: "owner" } : { isOwner: false, uid };
    const prev = loadTok(T) || {};
    saveTok(T, { refresh: t.refresh_token || prev.refresh, access: t.access_token, exp: Date.now() + (t.expires_in || 3500) * 1000 });
    return { ok: true, uid };
  }
  function disconnect(T) { try { saveTok(T, {}); } catch {} return { ok: true }; }

  async function accessToken(T) {
    const t = loadTok(T);
    if (!t || (!t.access && !t.refresh)) throw new Error("Google account not connected. Open Setup and connect Google first.");
    if (t.access && Date.now() < (t.exp || 0) - 60000) return t.access;
    if (!t.refresh) throw new Error("Google session expired and no refresh token was granted. Reconnect Google in Setup.");
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ refresh_token: t.refresh, client_id: clientId(), client_secret: clientSecret(), grant_type: "refresh_token" }) });
    const n = await r.json();
    if (!n.access_token) throw new Error("Google token refresh failed: " + (n.error_description || n.error || "unknown"));
    saveTok(T, { ...t, access: n.access_token, exp: Date.now() + (n.expires_in || 3500) * 1000 });
    return n.access_token;
  }
  async function g(T, method, url, body, raw = false) {
    const tok = await accessToken(T);
    const r = await fetch(url, { method, headers: { authorization: "Bearer " + tok, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    if (raw) return r;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && (d.error.message || d.error.status)) || ("HTTP " + r.status));
    return d;
  }

  // ---- gmail helpers ----
  function mailBody(payload) {
    // Prefer text/plain; fall back to stripped text/html; walk multipart trees.
    const stack = [payload]; let plain = "", html = "";
    while (stack.length) {
      const p = stack.pop();
      if (!p) continue;
      if (p.parts) stack.push(...p.parts);
      const data = p.body && p.body.data ? fromB64url(p.body.data).toString("utf8") : "";
      if (data && p.mimeType === "text/plain") plain += data;
      if (data && p.mimeType === "text/html") html += data;
    }
    return plain || html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  const hdr = (msg, name) => ((msg.payload && msg.payload.headers) || []).find((h) => h.name.toLowerCase() === name)?.value || "";

  // ---- the tools (names are UNprefixed; connectors.mjs namespaces to cx_google__*) ----
  const TOOLS = [
    { name: "gmail_search", description: "Search the connected Gmail account. Standard Gmail query syntax (from:, subject:, newer_than:2d, is:unread...). Returns id, from, subject, date, snippet per match.",
      parameters: { type: "object", properties: { query: { type: "string" }, max: { type: "number", description: "Max results, default 10, cap 25." } }, required: ["query"] },
      run: async (T, a) => {
        const list = await g(T, "GET", `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(a.query)}&maxResults=${Math.min(Number(a.max) || 10, 25)}`);
        const ids = (list.messages || []).map((m) => m.id);
        if (!ids.length) return "No messages matched.";
        const rows = [];
        for (const id of ids) {
          const m = await g(T, "GET", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
          rows.push(`- [${id}] ${hdr(m, "date")} | ${hdr(m, "from")} | ${hdr(m, "subject")} | ${String(m.snippet || "").slice(0, 120)}`);
        }
        return rows.join("\n");
      } },
    { name: "gmail_read", description: "Read one Gmail message in full (by id from gmail_search).",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: async (T, a) => {
        const m = await g(T, "GET", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${a.id}?format=full`);
        return `From: ${hdr(m, "from")}\nTo: ${hdr(m, "to")}\nDate: ${hdr(m, "date")}\nSubject: ${hdr(m, "subject")}\n\n${mailBody(m.payload).slice(0, 12000)}`;
      } },
    { name: "gmail_send", description: "Send an email from the connected Gmail account. Sends immediately as the account holder; be certain the recipient, subject and body are what the user asked for.",
      parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" } }, required: ["to", "subject", "body"] },
      run: async (T, a) => {
        const lines = [`To: ${a.to}`, a.cc ? `Cc: ${a.cc}` : null, `Subject: ${a.subject}`, "Content-Type: text/plain; charset=utf-8", "", a.body].filter((x) => x !== null);
        const d = await g(T, "POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { raw: b64url(lines.join("\r\n")) });
        return `Sent (message id ${d.id}).`;
      } },
    { name: "calendar_list", description: "List events on the connected Google Calendar (primary). ISO datetimes; defaults to the next 7 days.",
      parameters: { type: "object", properties: { timeMin: { type: "string" }, timeMax: { type: "string" }, max: { type: "number" } }, required: [] },
      run: async (T, a) => {
        const min = a.timeMin || new Date().toISOString(), max = a.timeMax || new Date(Date.now() + 7 * 864e5).toISOString();
        const d = await g(T, "GET", `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}&singleEvents=true&orderBy=startTime&maxResults=${Math.min(Number(a.max) || 15, 50)}`);
        const items = d.items || [];
        return items.length ? items.map((e) => `- [${e.id}] ${(e.start && (e.start.dateTime || e.start.date)) || "?"} | ${e.summary || "(no title)"}${e.location ? " @ " + e.location : ""}`).join("\n") : "No events in that window.";
      } },
    { name: "calendar_create", description: "Create an event on the connected Google Calendar (primary). start/end are ISO datetimes with timezone.",
      parameters: { type: "object", properties: { summary: { type: "string" }, start: { type: "string" }, end: { type: "string" }, description: { type: "string" }, location: { type: "string" } }, required: ["summary", "start", "end"] },
      run: async (T, a) => {
        const d = await g(T, "POST", "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          { summary: a.summary, description: a.description || "", location: a.location || "", start: { dateTime: a.start }, end: { dateTime: a.end } });
        return `Created "${d.summary}" (${d.id}) ${d.htmlLink || ""}`;
      } },
    { name: "drive_search", description: "Search the connected Google Drive by name/content. Returns id, name, type, modified.",
      parameters: { type: "object", properties: { query: { type: "string" }, max: { type: "number" } }, required: ["query"] },
      run: async (T, a) => {
        const q = `(name contains '${String(a.query).replace(/'/g, "\\'")}' or fullText contains '${String(a.query).replace(/'/g, "\\'")}') and trashed = false`;
        const d = await g(T, "GET", `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${Math.min(Number(a.max) || 10, 25)}&fields=files(id,name,mimeType,modifiedTime)`);
        const f = d.files || [];
        return f.length ? f.map((x) => `- [${x.id}] ${x.name} | ${x.mimeType} | ${x.modifiedTime}`).join("\n") : "Nothing matched.";
      } },
    { name: "drive_read", description: "Read a Drive file's text content by id (Google Docs/Sheets exported as text/CSV; plain text files read directly).",
      parameters: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] },
      run: async (T, a) => {
        const meta = await g(T, "GET", `https://www.googleapis.com/drive/v3/files/${a.fileId}?fields=id,name,mimeType,size`);
        const mt = meta.mimeType || "";
        let r;
        if (mt === "application/vnd.google-apps.document") r = await g(T, "GET", `https://www.googleapis.com/drive/v3/files/${a.fileId}/export?mimeType=text/plain`, null, true);
        else if (mt === "application/vnd.google-apps.spreadsheet") r = await g(T, "GET", `https://www.googleapis.com/drive/v3/files/${a.fileId}/export?mimeType=text/csv`, null, true);
        else if (/^text\/|json|xml|csv/.test(mt)) r = await g(T, "GET", `https://www.googleapis.com/drive/v3/files/${a.fileId}?alt=media`, null, true);
        else return `"${meta.name}" is ${mt}: not a text-readable type. Size ${meta.size || "?"} bytes.`;
        if (!r.ok) throw new Error("download failed: HTTP " + r.status);
        return `"${meta.name}":\n` + (await r.text()).slice(0, 15000);
      } },
    { name: "sheets_read", description: "Read a range from a Google Sheet (A1 notation, e.g. Sheet1!A1:F50).",
      parameters: { type: "object", properties: { spreadsheetId: { type: "string" }, range: { type: "string" } }, required: ["spreadsheetId", "range"] },
      run: async (T, a) => {
        const d = await g(T, "GET", `https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheetId}/values/${encodeURIComponent(a.range)}`);
        const rows = d.values || [];
        return rows.length ? rows.map((r) => r.join(" | ")).join("\n").slice(0, 12000) : "Range is empty.";
      } },
    { name: "sheets_append", description: "Append rows to a Google Sheet. values = array of rows, each an array of cell values.",
      parameters: { type: "object", properties: { spreadsheetId: { type: "string" }, range: { type: "string" }, values: { type: "array", items: { type: "array", items: {} } } }, required: ["spreadsheetId", "range", "values"] },
      run: async (T, a) => {
        const d = await g(T, "POST", `https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheetId}/values/${encodeURIComponent(a.range)}:append?valueInputOption=USER_ENTERED`, { values: a.values });
        return `Appended ${(d.updates && d.updates.updatedRows) || a.values.length} row(s) to ${a.range}.`;
      } },
    { name: "docs_create", description: "Create a new Google Doc with the given title and text content. Returns its link.",
      parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"] },
      run: async (T, a) => {
        const doc = await g(T, "POST", "https://docs.googleapis.com/v1/documents", { title: a.title });
        await g(T, "POST", `https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`,
          { requests: [{ insertText: { location: { index: 1 }, text: String(a.content).slice(0, 100000) } }] });
        return `Created "${a.title}": https://docs.google.com/document/d/${doc.documentId}/edit`;
      } },
  ];
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  return {
    id: "google",
    ready, connected, authUrl, handleCallback, disconnect,
    toolDefs() { return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })); },
    async call(T, name, args, _signal) {
      const t = byName.get(name);
      if (!t) return `Tool ${name} failed: not a Google tool.`;
      try { return String(await t.run(T, args || {})); }
      catch (e) { return `Tool ${name} failed: ` + String(e.message || e).slice(0, 300); }
    },
    async test(T) {
      try {
        const tok = await accessToken(T);
        const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { authorization: "Bearer " + tok } });
        const d = await r.json();
        return d.email ? { ok: true, tools: TOOLS.length, total: TOOLS.length, server: "google (" + d.email + ")" } : { ok: false, error: "userinfo failed" };
      } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }
    },
  };
}
