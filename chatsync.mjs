/*
 * Dominion AI — cross-device chat sync (Fred, 2026-07-19: "start on my phone, continue on laptop").
 *
 * The problem this solves: conversations lived ONLY in each device's localStorage, so every device
 * was its own island. chatlog.mjs could not serve as the shared copy — it is a retrieval index by
 * construction (turns truncated to 900 chars, 40 turns kept, no attachments, titles derived rather
 * than synced). This store is the faithful one.
 *
 * SHAPE. One JSON file per user (atomic tmp+rename, same discipline as chatlog.mjs):
 *   { rev, chats: { <id>: {id, title, updatedAt, rev, model, lastMode, forgeTier, forgeMode, messages[], prev?} },
 *     tombstones: { <id>: {deletedAt, rev} } }
 * `rev` is a per-user monotonic counter. Every accepted write stamps the chat with the next rev,
 * which is what makes an incremental pull possible: a device asks "everything after rev N".
 *
 * MERGE RULE: transcript, title, model, draft, and Forge state each have their own freshness clock.
 * A newer preference can therefore merge without granting a stale device permission to replace
 * newer messages. `updatedAt` remains the cheap dirty/sync marker, not an authority over every field.
 *
 * INSURANCE: when an intentional transcript write has FEWER messages than the stored one, the
 * stored version is kept in `prev` before being overwritten. Preference-only writes never replace
 * the transcript and therefore never create a misleading recovery copy.
 *
 * IMAGES DO NOT SYNC. Pixels are stripped to {kind:"image_ref"} before storage, matching Fred's
 * standing ruling that the service does not pay to house user images (and matching what the client
 * already does to its own older chats). The other device renders the honest placeholder the UI
 * already has. Text attachments keep their text: they are small and they are the content.
 *
 * ISOLATION: one instance per tenant, constructed from the per-uid directory by tenantstores.mjs.
 * A user's file is reachable only through their own resolved tenant bundle.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_CHATS = 300;                       // per user, newest-updated kept
const MAX_BYTES_PER_CHAT = 1_000_000;        // ~1MB of text after image stripping
const MAX_MESSAGES_PER_CHAT = 400;
const TOMBSTONE_TTL_MS = 180 * 24 * 3600 * 1000;   // 6 months: long enough that no device resurrects
const MAX_PUSH_CHATS = 60;                   // per request

// Strip image pixels; keep every other field intact. Returns [messages, strippedCount].
function stripPixels(messages) {
  let stripped = 0;
  const out = (Array.isArray(messages) ? messages : []).map((m) => {
    if (!m || !Array.isArray(m.attachments) || !m.attachments.length) return m;
    const atts = m.attachments.map((a) => {
      if (a && a.kind === "image" && a.dataUrl) { stripped++; return { kind: "image_ref", name: a.name || "image" }; }
      return a;
    });
    return { ...m, attachments: atts };
  });
  return [out, stripped];
}

// Validate + normalize one incoming chat. Returns null when it is not a usable chat object.
function normalizeChat(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.slice(0, 120) : "";
  if (!id) return null;
  const updatedAt = Number(raw.updatedAt) || 0;
  if (!updatedAt) return null;
  // Presence alone is not provenance: the first upgraded browser may have derived this clock from
  // legacy whole-chat updatedAt, which could represent only a draft/model edit. Trust it only after
  // that browser explicitly reports a real transcript mutation.
  const explicitTranscriptClock = raw.transcriptClockTrusted === true
    && Number.isFinite(Number(raw.transcriptUpdatedAt))
    && Number(raw.transcriptUpdatedAt) > 0;
  const componentClock = (name, present = true) => {
    if (!present) return undefined;
    const value = Number(raw[name]);
    return Number.isFinite(value) && value > 0 ? value : updatedAt;
  };
  let [messages] = stripPixels(raw.messages);
  messages = messages.filter((m) => m && typeof m.role === "string");
  let truncated = false;
  if (messages.length > MAX_MESSAGES_PER_CHAT) { messages = messages.slice(-MAX_MESSAGES_PER_CHAT); truncated = true; }
  const chat = {
    id,
    title: typeof raw.title === "string" ? raw.title.slice(0, 300) : "New chat",
    updatedAt,
    activityAt: raw.activityAt == null ? undefined : Math.max(0, Number(raw.activityAt) || 0),
    model: typeof raw.model === "string" ? raw.model.slice(0, 160) : undefined,
    draft: typeof raw.draft === "string" ? raw.draft.slice(0, 50_000) : undefined,
    lastMode: typeof raw.lastMode === "string" ? raw.lastMode.slice(0, 40) : undefined,
    forgeTier: ["ember", "flame", "furnace"].includes(raw.forgeTier) ? raw.forgeTier : undefined,
    forgeMode: typeof raw.forgeMode === "boolean" ? raw.forgeMode : undefined,
    transcriptUpdatedAt: componentClock("transcriptUpdatedAt"),
    transcriptClockTrusted: explicitTranscriptClock,
    titleUpdatedAt: componentClock("titleUpdatedAt", typeof raw.title === "string"),
    modelUpdatedAt: componentClock("modelUpdatedAt", typeof raw.model === "string"),
    draftUpdatedAt: componentClock("draftUpdatedAt", typeof raw.draft === "string"),
    forgeUpdatedAt: componentClock("forgeUpdatedAt",
      ["ember", "flame", "furnace"].includes(raw.forgeTier) || typeof raw.forgeMode === "boolean"),
    messages,
  };
  // Rolling-deployment guard. This flag is deliberately non-enumerable: it controls this merge
  // only and must never become part of the stored/synced chat shape.
  Object.defineProperty(chat, "_explicitTranscriptClock", {
    value: explicitTranscriptClock,
    enumerable: false,
  });
  // Byte cap: drop from the HEAD (oldest turns) so the live end of the conversation survives.
  while (messages.length > 2 && Buffer.byteLength(JSON.stringify(chat)) > MAX_BYTES_PER_CHAT) {
    messages.shift();
    chat.messages = messages;
    truncated = true;
  }
  if (truncated) chat.truncated = true;
  return chat;
}

const componentClock = (chat, field) => {
  const value = Number(chat && chat[field]);
  if (Number.isFinite(value) && value > 0) return value;
  return Math.max(0, Number(chat && chat.updatedAt) || 0);
};

function normalizeStoredClocks(chat) {
  if (!chat) return chat;
  const base = Math.max(0, Number(chat.updatedAt) || 0);
  if (!(Number(chat.transcriptUpdatedAt) > 0)) chat.transcriptUpdatedAt = base;
  if (!(Number(chat.titleUpdatedAt) > 0)) chat.titleUpdatedAt = base;
  if (chat.model !== undefined && !(Number(chat.modelUpdatedAt) > 0)) chat.modelUpdatedAt = base;
  if (chat.draft !== undefined && !(Number(chat.draftUpdatedAt) > 0)) chat.draftUpdatedAt = base;
  if ((chat.forgeTier !== undefined || chat.forgeMode !== undefined) && !(Number(chat.forgeUpdatedAt) > 0)) {
    chat.forgeUpdatedAt = base;
  }
  return chat;
}

/*
 * Merge one device's chat by component rather than replacing the whole object on `updatedAt`.
 * A draft or model selection is allowed to be newer than the transcript without carrying a newer
 * transcript. That distinction is what prevents a stale phone with two messages from erasing the
 * twenty messages a laptop already wrote.
 */
function mergeChat(stored, incoming) {
  normalizeStoredClocks(stored);
  const merged = { ...stored };
  let changed = false;
  let transcriptChanged = false;

  const incomingTranscriptAt = componentClock(incoming, "transcriptUpdatedAt");
  const storedTranscriptAt = componentClock(stored, "transcriptUpdatedAt");
  const sameTranscript = JSON.stringify(incoming.messages || []) === JSON.stringify(stored.messages || []);
  // An old browser has no component clock, so its updatedAt may represent typing a draft. During a
  // rolling deploy, accept only transcript growth from that client; an equal/shorter transcript is
  // preserved until the upgraded client can identify a deliberate edit with an explicit clock.
  const legacyTranscriptSafe = incoming._explicitTranscriptClock
    || (incoming.messages || []).length > (stored.messages || []).length
    || sameTranscript;
  if (incomingTranscriptAt > storedTranscriptAt && legacyTranscriptSafe) {
    if (!sameTranscript) {
      merged.messages = incoming.messages || [];
      transcriptChanged = true;
    }
    merged.transcriptUpdatedAt = incomingTranscriptAt;
    merged.transcriptClockTrusted = incoming._explicitTranscriptClock === true;
    if (incoming.lastMode !== undefined) merged.lastMode = incoming.lastMode;
    if (incoming.truncated) merged.truncated = true;
    else delete merged.truncated;
    changed = true;
  }

  const take = (clockField, valueFields) => {
    const nextClock = componentClock(incoming, clockField);
    const priorClock = componentClock(stored, clockField);
    if (!(nextClock > priorClock)) return;
    let took = false;
    for (const field of valueFields) {
      if (incoming[field] === undefined) continue;
      merged[field] = incoming[field];
      took = true;
    }
    if (took) {
      merged[clockField] = nextClock;
      changed = true;
    }
  };
  take("titleUpdatedAt", ["title"]);
  take("modelUpdatedAt", ["model"]);
  take("draftUpdatedAt", ["draft"]);
  take("forgeUpdatedAt", ["forgeTier", "forgeMode"]);

  const nextActivity = Math.max(Number(stored.activityAt) || 0, Number(incoming.activityAt) || 0);
  if (nextActivity !== (Number(stored.activityAt) || 0)) {
    merged.activityAt = nextActivity;
    changed = true;
  }
  const nextUpdated = Math.max(
    Number(stored.updatedAt) || 0,
    Number(incoming.updatedAt) || 0,
    componentClock(merged, "transcriptUpdatedAt"),
    componentClock(merged, "titleUpdatedAt"),
    componentClock(merged, "modelUpdatedAt"),
    componentClock(merged, "draftUpdatedAt"),
    componentClock(merged, "forgeUpdatedAt"),
  );
  if (nextUpdated !== (Number(stored.updatedAt) || 0)) {
    merged.updatedAt = nextUpdated;
    changed = true;
  }
  return { chat: merged, changed, transcriptChanged };
}

export function createChatSync({ dir }) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "chats.json");
  const tmp = file + ".tmp";

  let state = { rev: 0, chats: {}, tombstones: {} };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") {
        state = { rev: Number(parsed.rev) || 0, chats: parsed.chats || {}, tombstones: parsed.tombstones || {} };
      }
    } catch { /* unreadable file: start clean rather than throw the server's boot */ }
  }

  let dirty = false;
  function persist() {
    if (!dirty) return;
    try {
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, file);
      dirty = false;
    } catch { /* volume hiccup: keep serving from memory, retry on the next write */ }
  }

  // Enforce the per-user chat cap (newest-updated survive) and expire old tombstones.
  function prune() {
    const ids = Object.keys(state.chats);
    if (ids.length > MAX_CHATS) {
      ids.sort((a, b) => (state.chats[b].updatedAt || 0) - (state.chats[a].updatedAt || 0));
      for (const id of ids.slice(MAX_CHATS)) delete state.chats[id];
    }
    // Expire on the SERVER's receipt time, never on the client's deletedAt. A device with a wrong
    // clock (or a malformed push) would otherwise hand us a tombstone that looks ancient, we would
    // drop it on the spot, and the deleted chat would resurrect from the next device that still
    // had it. `at` is ours; `deletedAt` stays the client's and is only ever used for merge order.
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    for (const [id, t] of Object.entries(state.tombstones)) {
      if ((t.at || t.deletedAt || 0) < cutoff) delete state.tombstones[id];
    }
  }

  // Everything changed after `sinceRev`. sinceRev=0 returns the whole account (a fresh device).
  function pull(sinceRev = 0) {
    const since = Number(sinceRev) || 0;
    const chats = Object.values(state.chats)
      .filter((c) => (c.rev || 0) > since)
      .sort((a, b) => (a.rev || 0) - (b.rev || 0))
      .map((stored) => {
        normalizeStoredClocks(stored);
        const { prev, ...c } = stored;
        return c;
      });                                         // `prev` is recovery ballast, never shipped
    const deleted = Object.entries(state.tombstones)
      .filter(([, t]) => (t.rev || 0) > since)
      .map(([id, t]) => ({ id, deletedAt: t.deletedAt }));
    return { rev: state.rev, chats, deleted };
  }

  // Accept a device's changes. Returns what was taken and what was refused, honestly.
  //   chats   = [chat objects]
  //   deletes = [{id, deletedAt}]
  function push(chats = [], deletes = []) {
    const accepted = [], rejected = [];
    const incoming = (Array.isArray(chats) ? chats : []).slice(0, MAX_PUSH_CHATS);

    for (const raw of incoming) {
      const c = normalizeChat(raw);
      if (!c) { rejected.push({ id: raw && raw.id, reason: "malformed" }); continue; }

      // A tombstone wins unless the device edited the chat AFTER deleting it elsewhere.
      const tomb = state.tombstones[c.id];
      if (tomb && (tomb.deletedAt || 0) >= c.updatedAt) { rejected.push({ id: c.id, reason: "deleted" }); continue; }
      if (tomb) delete state.tombstones[c.id];       // deliberate resurrection: newer than the delete

      const stored = state.chats[c.id];
      let next = c;
      let transcriptChanged = true;
      if (stored) {
        const merged = mergeChat(stored, c);
        if (!merged.changed) {
          rejected.push({ id: c.id, reason: "stale" });
          continue;
        }
        next = merged.chat;
        transcriptChanged = merged.transcriptChanged;
      } else {
        normalizeStoredClocks(next);
        if (next.activityAt === undefined) next.activityAt = next.updatedAt;
      }

      state.rev += 1;
      next.rev = state.rev;
      // The insurance policy is now transcript-specific: preference-only writes never create a
      // "short previous copy" because they never replace the transcript in the first place.
      if (stored && transcriptChanged && stored.messages && next.messages.length < stored.messages.length) {
        const { prev, ...bare } = stored;
        next.prev = bare;
      }
      state.chats[next.id] = next;
      accepted.push({ id: next.id, rev: next.rev, truncated: !!next.truncated });
    }

    for (const d of (Array.isArray(deletes) ? deletes : []).slice(0, MAX_PUSH_CHATS)) {
      const id = d && typeof d.id === "string" ? d.id.slice(0, 120) : "";
      if (!id) continue;
      const deletedAt = Number(d.deletedAt) || Date.now();
      const stored = state.chats[id];
      if (stored && (stored.updatedAt || 0) > deletedAt) continue;   // edited elsewhere after the delete
      delete state.chats[id];
      state.rev += 1;
      state.tombstones[id] = { deletedAt, at: Date.now(), rev: state.rev };
    }

    prune();
    dirty = true;
    persist();
    return { rev: state.rev, accepted, rejected };
  }

  // Server-side delete (the /chatlog/forget path) so a delete propagates even when it did not
  // originate from the sync push.
  function remove(id, deletedAt = Date.now()) {
    const key = String(id || "");
    if (!key) return { removed: 0 };
    const had = !!state.chats[key];
    delete state.chats[key];
    state.rev += 1;
    state.tombstones[key] = { deletedAt, at: Date.now(), rev: state.rev };
    dirty = true;
    persist();
    return { removed: had ? 1 : 0, rev: state.rev };
  }

  function stats() {
    return {
      chats: Object.keys(state.chats).length,
      tombstones: Object.keys(state.tombstones).length,
      rev: state.rev,
      bytes: (() => { try { return Buffer.byteLength(JSON.stringify(state)); } catch { return 0; } })(),
    };
  }

  return { pull, push, remove, stats, limits: { MAX_CHATS, MAX_BYTES_PER_CHAT, MAX_MESSAGES_PER_CHAT, MAX_PUSH_CHATS } };
}
