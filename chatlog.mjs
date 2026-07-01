/*
 * Dominion AI — server-side chat transcript store ("what we talked about").
 *
 * The PWA keeps chats in localStorage (phone-side), which made cross-chat search and
 * episodic memory impossible server-side. This store keeps a lightweight rolling copy of each
 * conversation (recent turns, truncated) so search_chats / retrieve_context_pack / session
 * summaries work. It is a retrieval index, not the source of truth — the phone still owns chats.
 * Never touches customer DBs or backups.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

const nowIso = () => new Date().toISOString();
const tokenize = (s) => (String(s || "").toLowerCase().match(/[a-z0-9]{2,}/g) || []);

export function createChatLog(opts = {}) {
  const dir = resolve(opts.dir || "C:\\minipc-chat\\chatlog");
  const file = join(dir, "chats.json");
  const MAX_CHATS = opts.maxChats || 200;
  const MAX_TURNS = opts.maxTurns || 40;
  const MAX_TURN_LEN = opts.maxTurnLen || 900;
  let chats = [];

  const load = () => { try { if (existsSync(file)) { const j = JSON.parse(readFileSync(file, "utf8")); if (Array.isArray(j)) chats = j; } } catch { chats = []; } };
  const persist = () => { try { mkdirSync(dir, { recursive: true }); const tmp = file + ".tmp"; writeFileSync(tmp, JSON.stringify(chats)); renameSync(tmp, file); } catch {} };
  load();

  // Upsert the rolling transcript for a chat (called after each completed /chat run).
  function record(chatId, messages, answer) {
    if (!chatId) return;
    const turns = [...(Array.isArray(messages) ? messages : []), ...(answer ? [{ role: "assistant", content: answer }] : [])]
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_TURNS)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_TURN_LEN) }));
    if (!turns.length) return;
    const firstUser = turns.find((t) => t.role === "user");
    const title = (firstUser ? firstUser.content : "Chat").replace(/\s+/g, " ").trim().slice(0, 60);
    let c = chats.find((x) => x.id === chatId);
    if (!c) { c = { id: chatId, title, turns: [], updatedAt: nowIso(), summarized: false }; chats.push(c); }
    c.title = title; c.turns = turns; c.updatedAt = nowIso();
    chats.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (chats.length > MAX_CHATS) chats = chats.slice(0, MAX_CHATS);
    persist();
    return c;
  }

  // Lexical search across all recorded conversations -> snippets around the best-matching turn.
  function search(query, { limit = 3, excludeId = "" } = {}) {
    const q = tokenize(query); if (!q.length) return [];
    const hits = [];
    for (const c of chats) {
      if (excludeId && c.id === excludeId) continue;
      let best = 0, bestTurn = null;
      for (const t of c.turns) {
        const tt = new Set(tokenize(t.content)); if (!tt.size) continue;
        let n = 0; for (const w of q) if (tt.has(w)) n++;
        const s = n / q.length;
        if (s > best) { best = s; bestTurn = t; }
      }
      if (best >= 0.2 && bestTurn) hits.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, score: Number(best.toFixed(3)), snippet: bestTurn.content.slice(0, 300) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  const get = (id) => chats.find((c) => c.id === id) || null;
  const list = () => chats.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, turnCount: c.turns.length }));
  const markSummarized = (id) => { const c = get(id); if (c) { c.summarized = true; persist(); } };
  const stats = () => ({ chats: chats.length });

  return { record, search, get, list, markSummarized, stats };
}
