// Dominion AI — chat client. Server-side agent loop at /chat (routes models + runs tools).
// Multi-conversation history, per-message actions, persona/temperature, and a Mode selector that
// drives the Phase-1 router (Auto = the server's light model classifies + picks 8B vs 30B).
const $ = (id) => document.getElementById(id);
const wrap = $("wrap"), main = $("main"), input = $("input"), sendBtn = $("send"),
      modelSel = $("model"), modeSel = $("mode"), privacyModeSel = $("privacy-mode"), cloudBadge = $("cloudbadge"), empty = $("empty"),
      sidebar = $("sidebar"), overlay = $("overlay"), menuBtn = $("menu"), newBtn = $("newchat"), chatlist = $("chatlist"),
      settingsBtn = $("settings"), smodal = $("smodal"), sclose = $("sclose"), ssave = $("ssave"),
      personaSel = $("persona-sel"), personaCustom = $("persona-custom"), tempInput = $("temp"), tempVal = $("temp-val"),
      memBtn = $("memory"), mmodal = $("mmodal"), mclose = $("mclose"), madd = $("madd"), msave = $("msave"),
      mlist = $("mlist"), mstats = $("mstats"), mfilterStatus = $("mfilter-status"),
      toolsBtn = $("tools"), tmodal = $("tmodal"), tclose = $("tclose"), tlist = $("tlist"), tstats = $("tstats"),
      confirmToolsBox = $("confirm-tools"),
      artifactsBtn = $("artifacts"), amodal = $("amodal"), aclose = $("aclose"), alist = $("alist"), adetail = $("adetail"), astats = $("astats"), ahead = $("ahead"),
      improveBtn = $("improve"), imodal = $("imodal"), iclose = $("iclose"), ilist = $("ilist"), istats = $("istats"), iadd = $("iadd"), iaddbtn = $("iaddbtn"),
      chatSearch = $("chatsearch"), privacySel = $("privacy-sel"),
      personaBtn = $("persona"), pmodal = $("pmodal"), pclose = $("pclose"), pstats = $("pstats"),
      padd = $("padd"), pkind = $("pkind"), ptitle = $("ptitle"), paddbtn = $("paddbtn"),
      purl = $("purl"), pscrape = $("pscrape"), pscan = $("pscan"), pdistill = $("pdistill"),
      pprofile = $("pprofile"), pfilterKind = $("pfilter-kind"), pmsg = $("pmsg"), plist = $("plist"),
      costChip = $("cost-chip"),
      attachBtn = $("attach"), attachFile = $("attach-file"), attachStrip = $("attach-strip"), attachWarn = $("attach-warn");

const LS_CHATS = "dominion.chats.v1", LS_CUR = "dominion.cur.v1", LS_MODEL = "minipc-chat.model.v1",
      LS_MODE = "dominion.mode.v1", LS_SET = "dominion.settings.v1", OLD_MSGS = "minipc-chat.messages.v1",
      LS_PMODE = "dominion.privacy-mode.v1";
// Live turns are now a PER-CHAT map ({ [chatId]: {jobId, eventIndex} }) so runs in several chats can
// stream in the background at once. LS_LIVEJOB_OLD is the legacy single-job key, migrated once.
const LS_LIVEJOBS = "dominion.livejobs.v1", LS_LIVEJOB_OLD = "dominion.livejob";

/*
 * Money wording (Fred, 2026-07-30: guests never read dollars). dominion-money.js owns the rule for
 * every surface; this accessor exists so a failed/stale load of that file degrades to the old
 * dollar wording instead of throwing inside a render loop. See dominion-money.js for the doctrine.
 */
const money = () => window.DominionMoney || {
  cost: (u, o) => ((o && o.approx) ? "~" : "") + "$" + (Number(u) || 0).toFixed(2),
  rate: (i, o) => (!i && !o) ? "Free" : "$" + i + "/" + o,
  balance: (u) => "$" + (Number(u) || 0).toFixed(2),
  // Exact, matching billing.mjs creditsForCostUsd: no one-credit floor, and zero stays zero.
  inCredits: () => false, toCredits: (u) => { const n = Number(u) || 0; return n <= 0 ? 0 : Math.round(n * 100 * 1e6) / 1e6; },
};

// ---- Phase 2 privacy modes (Fred's hard allow-list; the SERVER enforces, this mirrors it) ----
// normal = all providers · trusted = OpenAI/Anthropic direct · private = Anthropic direct only
// (the single-provider lane, repurposed 2026-07-30 when Local Qwen left the picker).
let privacyCfg = { trustedProviders: ["openai", "anthropic"], privateProviders: ["anthropic"] };   // filled from /api/models .privacy
let availCache = {};                                              // provider -> has-key, from /api/models
const providerAllowedClient = (mode, provider) => {
  if (provider === "local" || !provider) return true;
  if (mode === "normal") return true;
  if (mode === "private") return privacyCfg.privateProviders.includes(provider);
  return privacyCfg.trustedProviders.includes(provider);   // trusted
};
// Disable (never remove) model options the current privacy mode disallows, with an honest suffix.
// We do NOT auto-switch the selection — Fred's pick is honored or refused, never silently swapped.
function applyPrivacyFilter() {
  if (!modelSel) return;
  const mode = privacyModeSel ? privacyModeSel.value : "normal";
  for (const og of modelSel.querySelectorAll("optgroup")) {
    const isLocal = og.id === "model-local-group";
    for (const o of og.querySelectorAll("option")) {
      const provider = isLocal || o.value === "local" ? "local" : (o.dataset.provider || "openrouter");
      const modeOk = providerAllowedClient(mode, provider);
      // strip any prior mode suffix, then re-annotate
      o.textContent = o.textContent.replace(/ — (blocked in .*|key needed)$/,"");
      if (!modeOk) { o.disabled = true; o.textContent += " — blocked in " + mode; }
      else if (o.dataset.noKey === "1") { o.disabled = true; o.textContent += " — key needed"; }
      else o.disabled = false;
    }
  }
  if (cloudBadge) updateCloudBadge();
  if (typeof renderModelPanel === "function") renderModelPanel();   // reflect mode changes in the panel
}

const PRESETS = {
  default: "",
  concise: "Be maximally concise — short, direct answers, minimal preamble.",
  brainstorm: "Act as a sharp brainstorming partner: offer ideas, angles, and honest pushback; think briefly out loud.",
  code: "You are a precise coding assistant: give exact, runnable specifics; for real file changes use forge_send with complete instructions.",
};

let chats = [], curId = null, aborter = null, chatQuery = "";
// Per-chat live turns (persisted). An entry means that chat has a run generating server-side right
// now; it survives chat switches, minimize, reload, and — via the durable store — server restarts.
let liveJobs = {};
// "busy" is now per-chat: does THIS chat have a live run? The composer, Stop button, and the
// Continue/Regenerate actions all key off the chat on screen, so other chats keep streaming freely.
const busyFor = (id) => !!liveJobs[id];
const anyBusy = () => Object.keys(liveJobs).length > 0;
// ctxMem/ctxDocs/ctxChats (Fred, 2026-07-25): the 🧠/📄/💬 context chips are diagnostic clutter to
// most people, so they are OFF by default and each has its own restore checkbox in System Settings.
let settings = { persona: "default", personaCustom: "", temperature: 0.7, confirmTools: false, privacy: "redacted_external", ctxMem: false, ctxDocs: false, ctxChats: false };
// View binding for the open chat's pendingAttachments. The durable source of truth lives on each
// chat, just like draft text; this array is rebound whenever the sidebar changes conversations.
let pendingAtt = [];

// Background video: muted+playsinline autoplay is usually allowed, but Android suppresses it under
// battery saver / when the PWA resumes from background — kick it back to life on those signals.
(() => {
  const v = document.getElementById("bgvideo"); if (!v) return;
  // The footage has a slow camera pan baked in; half-speed playback tames the drift without
  // the stutter of near-freeze rates. (A locked-camera cut removes the pan entirely.)
  const RATE = 0.5;
  v.defaultPlaybackRate = RATE; v.playbackRate = RATE;
  const kick = () => { v.playbackRate = RATE; if (v.paused) v.play().catch(() => {}); };
  v.addEventListener("ratechange", () => { if (v.playbackRate !== RATE) v.playbackRate = RATE; });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
  window.addEventListener("pageshow", kick);
  window.addEventListener("pointerdown", kick, { once: true });
  kick();
})();

// ---------- persistence ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "c" + Date.now() + Math.random().toString(36).slice(2));
// Attachment bytes are the one thing that can blow the ~5MB localStorage quota: full pixels are
// kept for only the ATT_KEEP_CHATS most recently updated chats; older chats keep honest name-only
// placeholders. If a save STILL overflows, one retry strips all attachment data rather than
// silently losing the whole history write.
const ATT_KEEP_CHATS = 12;
function attachmentForStorage(a) {
  if (a.kind === "image" && a.dataUrl) return { kind: "image_ref", name: a.name };
  if (a.kind === "text") return { kind: "text", name: a.name, text: "" };
  return a;
}
function serializeChats(stripAll) {
  const byRecency = [...chats].sort((a, b) => (b.activityAt || b.updatedAt || 0) - (a.activityAt || a.updatedAt || 0));
  const keep = new Set(byRecency.slice(0, ATT_KEEP_CHATS).map((c) => c.id));
  return JSON.stringify(chats.slice(0, 100).map((c) => {
    const staged = Array.isArray(c.pendingAttachments) ? c.pendingAttachments : [];
    const hasSentAttachments = c.messages.some((m) => m.attachments && m.attachments.length);
    if (!hasSentAttachments && !staged.length) return c;
    const full = keep.has(c.id) && !stripAll;
    return { ...c, pendingAttachments: full ? staged : staged.map(attachmentForStorage), messages: c.messages.map((m) => {
      if (!m.attachments || !m.attachments.length) return m;
      if (full) return m;
      return { ...m, attachments: m.attachments.map(attachmentForStorage) };
    }) };
  }));
}
const save = () => {
  try { localStorage.setItem(LS_CHATS, serializeChats(false)); localStorage.setItem(LS_CUR, curId || ""); }
  catch { try { localStorage.setItem(LS_CHATS, serializeChats(true)); localStorage.setItem(LS_CUR, curId || ""); } catch {} }
  scheduleSync();
};
const saveSettings = () => { try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch {} };
function load() {
  try { const r = localStorage.getItem(LS_CHATS); const a = r && JSON.parse(r); if (Array.isArray(a)) chats = a; } catch {}
  if (!chats.length) { try { const old = JSON.parse(localStorage.getItem(OLD_MSGS) || "null"); if (Array.isArray(old) && old.length) chats = [{ id: uid(), title: titleFrom(old), messages: old, updatedAt: Date.now() }]; } catch {} }
  // Chats created before model/draft became session state must stop borrowing whichever model was
  // changed most recently. activityAt keeps preference-sync revisions from reordering the sidebar.
  let migratedSessionState = false;
  const legacyModel = localStorage.getItem(LS_MODEL) || "";   // never "local": unset stays unset and resolves to the cloud default at use time
  const legacyForgeTier = ["ember", "flame", "furnace"].includes(localStorage.getItem("dominion.forgeTier"))
    ? localStorage.getItem("dominion.forgeTier") : "ember";
  const legacyForgeMode = localStorage.getItem("dominion.forgeModeEnabled") === "1";
  for (const c of chats) {
    const legacyClock = Math.max(1, Number(c.updatedAt) || Date.now());
    const hadTrustedTranscriptClock = c.transcriptClockTrusted === true && Number(c.transcriptUpdatedAt) > 0;
    if (typeof c.model !== "string" || !c.model) { c.model = legacyModel; migratedSessionState = true; }
    if (typeof c.draft !== "string") { c.draft = ""; migratedSessionState = true; }
    if (!Array.isArray(c.pendingAttachments)) { c.pendingAttachments = []; migratedSessionState = true; }
    if (!["ember", "flame", "furnace"].includes(c.forgeTier)) { c.forgeTier = legacyForgeTier; migratedSessionState = true; }
    if (typeof c.forgeMode !== "boolean") { c.forgeMode = legacyForgeMode; migratedSessionState = true; }
    if (!Number.isFinite(c.activityAt)) { c.activityAt = c.updatedAt || 0; migratedSessionState = true; }
    // `updatedAt` used to govern the entire chat. Split it once into component clocks so changing
    // a model or typing a draft on a stale device can never make that device's old messages newer.
    for (const field of ["transcriptUpdatedAt", "titleUpdatedAt", "modelUpdatedAt", "draftUpdatedAt", "forgeUpdatedAt"]) {
      if (!(Number(c[field]) > 0)) { c[field] = legacyClock; migratedSessionState = true; }
    }
    // A legacy updatedAt may have come from typing or changing a model, not from messages. Until
    // this browser performs an actual transcript mutation, mark the derived transcript clock as
    // untrusted so its first upgraded sync cannot shrink a newer device's conversation.
    if (c.transcriptClockTrusted !== hadTrustedTranscriptClock) {
      c.transcriptClockTrusted = hadTrustedTranscriptClock;
      migratedSessionState = true;
    }
    // Old messages predate model history, so their exact picker state cannot be reconstructed.
    // Freeze the session's migrated model onto that legacy transcript once. Every new user message
    // gets an exact picker snapshot, making future model changes durable and scrollable.
    if (c.modelHistoryVersion !== 1) {
      let inheritedModel = c.model;
      for (const m of c.messages || []) {
        if (m.role === "user") inheritedModel = m.modelId || inheritedModel;
        if (!m.modelId) m.modelId = inheritedModel;
      }
      c.modelHistoryVersion = 1;
      migratedSessionState = true;
    }
  }
  if (migratedSessionState) {
    try { localStorage.setItem(LS_CHATS, JSON.stringify(chats.slice(0, 100))); } catch {}
  }
  curId = localStorage.getItem(LS_CUR) || (chats[0] && chats[0].id) || null;
  if (!curId) newChat();
  try { const s = JSON.parse(localStorage.getItem(LS_SET) || "null"); if (s && typeof s === "object") settings = { ...settings, ...s }; } catch {}
  try { const m = localStorage.getItem(LS_MODE); if (m && modeSel) modeSel.value = m; } catch {}
  try { const p = localStorage.getItem(LS_PMODE); if (p && privacyModeSel) privacyModeSel.value = p; } catch {}
  loadLiveJobs();
}
// ---------- cross-device sync (Fred, 2026-07-19: start on the phone, continue on the laptop) ----------
// Conversations used to live only in this browser's localStorage, so every device was an island.
// The server now keeps a faithful per-account copy (chatsync.mjs) and this is the client half:
// push what changed here, pull what changed elsewhere, merge by chat id.
//
// MERGE RULE: transcript, title, model, draft, and Forge state each have their own freshness clock.
// `updatedAt` only tells us a chat needs syncing; a newer draft/model choice on a stale device can
// no longer replace newer messages. Strict component-clock ties also keep the server's pixel-stripped
// echo from overwriting the fuller local attachment copy.
//
// PIXELS DO NOT TRAVEL. The server does not store image bytes (Fred's standing ruling: the service
// does not pay to house user images), and a data URL per image would blow the request. They are
// replaced with the same {kind:"image_ref"} placeholder the app already uses for its own older
// chats, and the other device renders the honest "no longer stored on this device" note.
const LS_SYNC = "dominion.sync.v1";
let syncState = { lastRev: 0, pushed: {}, deletes: [] };
try {
  const s = JSON.parse(localStorage.getItem(LS_SYNC) || "null");
  if (s && typeof s === "object") syncState = { lastRev: s.lastRev || 0, pushed: s.pushed || {}, deletes: Array.isArray(s.deletes) ? s.deletes : [] };
} catch {}
const saveSync = () => { try { localStorage.setItem(LS_SYNC, JSON.stringify(syncState)); } catch {} };
let syncOff = false, syncing = false, syncTimer = null;

function chatForPush(c) {
  const messages = (c.messages || []).map((m) => {
    if (!m.attachments || !m.attachments.length) return m;
    return { ...m, attachments: m.attachments.map((a) => (a.kind === "image" && a.dataUrl ? { kind: "image_ref", name: a.name } : a)) };
  });
  return {
    id: c.id, title: c.title, updatedAt: c.updatedAt || 0,
    activityAt: c.activityAt || c.updatedAt || 0,
    model: c.model, draft: c.draft || "", lastMode: c.lastMode,
    forgeTier: c.forgeTier || "ember", forgeMode: c.forgeMode === true,
    transcriptUpdatedAt: c.transcriptUpdatedAt || c.updatedAt || 0,
    titleUpdatedAt: c.titleUpdatedAt || c.updatedAt || 0,
    modelUpdatedAt: c.modelUpdatedAt || c.updatedAt || 0,
    draftUpdatedAt: c.draftUpdatedAt || c.updatedAt || 0,
    forgeUpdatedAt: c.forgeUpdatedAt || c.updatedAt || 0,
    transcriptClockTrusted: c.transcriptClockTrusted === true,
    messages,
  };
}

function syncClock(chat, field) {
  const value = Number(chat && chat[field]);
  if (Number.isFinite(value) && value > 0) return value;
  return Math.max(0, Number(chat && chat.updatedAt) || 0);
}

// Merge server state by field. `updatedAt` remains the cheap "does this chat need a push?" marker,
// but it no longer grants an unrelated draft/model edit authority to replace the transcript.
function mergeIncomingChat(local, inc) {
  let changed = false;
  const take = (clockField, fields) => {
    const nextClock = syncClock(inc, clockField);
    if (!(nextClock > syncClock(local, clockField))) return;
    let took = false;
    for (const field of fields) {
      if (inc[field] === undefined) continue;
      local[field] = inc[field];
      took = true;
    }
    if (took) {
      local[clockField] = nextClock;
      changed = true;
    }
  };

  take("transcriptUpdatedAt", ["messages", "lastMode"]);
  if (inc.transcriptClockTrusted === true && local.transcriptClockTrusted !== true) {
    local.transcriptClockTrusted = true;
    changed = true;
  }
  take("titleUpdatedAt", ["title"]);
  take("modelUpdatedAt", ["model"]);
  take("draftUpdatedAt", ["draft"]);
  take("forgeUpdatedAt", ["forgeTier", "forgeMode"]);

  const nextActivity = Math.max(Number(local.activityAt) || 0, Number(inc.activityAt) || 0);
  if (nextActivity !== (Number(local.activityAt) || 0)) {
    local.activityAt = nextActivity;
    changed = true;
  }
  local.updatedAt = Math.max(Number(local.updatedAt) || 0, Number(inc.updatedAt) || 0);
  return changed;
}

// Fold the server's changes into the local array. Returns what moved so the caller can decide
// between a cheap sidebar repaint and a full transcript rebuild.
function mergeIncoming(incoming, deleted) {
  let changedAny = false, changedCur = false;
  for (const inc of incoming || []) {
    if (!inc || !inc.id) continue;
    if (syncState.deletes.some((d) => d.id === inc.id && (d.deletedAt || 0) >= (inc.updatedAt || 0))) continue;  // deleted here, not yet pushed
    const local = chats.find((c) => c.id === inc.id);
    if (!local) {
      chats.unshift({
        id: inc.id, title: inc.title || "New chat", messages: inc.messages || [],
        updatedAt: inc.updatedAt || 0, activityAt: inc.activityAt || inc.updatedAt || 0,
        model: inc.model, draft: inc.draft || "", lastMode: inc.lastMode,
        forgeTier: ["ember", "flame", "furnace"].includes(inc.forgeTier) ? inc.forgeTier : "ember",
        forgeMode: inc.forgeMode === true,
        transcriptUpdatedAt: syncClock(inc, "transcriptUpdatedAt"),
        transcriptClockTrusted: inc.transcriptClockTrusted === true,
        titleUpdatedAt: syncClock(inc, "titleUpdatedAt"),
        modelUpdatedAt: syncClock(inc, "modelUpdatedAt"),
        draftUpdatedAt: syncClock(inc, "draftUpdatedAt"),
        forgeUpdatedAt: syncClock(inc, "forgeUpdatedAt"),
      });
      changedAny = true;
    } else if (mergeIncomingChat(local, inc)) {
      changedAny = true;
      if (local.id === curId) changedCur = true;
    }
    syncState.pushed[inc.id] = Math.max(syncState.pushed[inc.id] || 0, inc.updatedAt || 0);
  }
  for (const d of deleted || []) {
    if (!d || !d.id) continue;
    const local = chats.find((c) => c.id === d.id);
    if (!local) continue;
    if ((local.updatedAt || 0) > (d.deletedAt || 0)) continue;   // edited here after the delete elsewhere
    chats = chats.filter((c) => c.id !== d.id);
    delete syncState.pushed[d.id];
    if (liveJobs[d.id]) { delete liveJobs[d.id]; persistLiveJobs(); }   // no phantom running-dot on a synced-away chat
    changedAny = true;
    if (d.id === curId) changedCur = true;
  }
  return { changedAny, changedCur };
}

async function syncNow() {
  // never mutate the transcript mid-stream — `anyBusy()` is the per-chat successor to the old global
  // `busy` flag, so a run generating in ANY chat still pauses sync just as before.
  if (syncOff || syncing || anyBusy()) return;
  syncing = true;
  try {
    for (let round = 0; round < 12; round++) {
      const pending = chats.filter((c) => (c.updatedAt || 0) !== (syncState.pushed[c.id] || 0)).slice(0, 40);
      const dels = syncState.deletes.slice(0, 40);
      const r = await fetch("/chats/sync", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ since: syncState.lastRev, chats: pending.map(chatForPush), deletes: dels }),
      });
      if (r.status === 401 || r.status === 403) { syncOff = true; return; }   // not signed in: stay quiet
      if (!r.ok) return;
      const j = await r.json();

      for (const a of j.accepted || []) {
        const c = chats.find((x) => x.id === a.id);
        if (c) syncState.pushed[a.id] = c.updatedAt || 0;
      }
      // A push refused as "deleted" means another device deleted this chat. Honor it here rather
      // than leaving a ghost the user already threw away.
      const goneIds = (j.rejected || []).filter((x) => x && x.reason === "deleted").map((x) => x.id);
      if (goneIds.length) {
        chats = chats.filter((c) => !goneIds.includes(c.id));
        for (const id of goneIds) { delete syncState.pushed[id]; if (liveJobs[id]) delete liveJobs[id]; }
        persistLiveJobs();
      }
      syncState.deletes = syncState.deletes.filter((d) => !dels.some((x) => x.id === d.id));

      const moved = mergeIncoming(j.chats, j.deleted);
      // Anything still refused (stale losers) is marked at its current value so it does not spin.
      for (const rj of j.rejected || []) {
        const c = chats.find((x) => x.id === rj.id);
        if (c) syncState.pushed[rj.id] = c.updatedAt || 0;
      }
      syncState.lastRev = j.rev || syncState.lastRev;
      saveSync();

      const changed = moved.changedAny || goneIds.length > 0;
      if (changed) {
        if (!curId || !chats.find((c) => c.id === curId)) curId = (chats[0] && chats[0].id) || null;
        if (!curId) { newChat(); }
        else {
          try { localStorage.setItem(LS_CHATS, serializeChats(false)); localStorage.setItem(LS_CUR, curId || ""); } catch {}
          if (moved.changedCur || goneIds.length) renderAll(); else renderSidebar();
          // Kept as a cheap re-assert: the fold is unconditional now, but a sync can rebuild the
          // header, and re-running this costs nothing and guarantees the handles survive it.
          try { updateFocusMode(); } catch {}
        }
      }
      const more = chats.some((c) => (c.updatedAt || 0) !== (syncState.pushed[c.id] || 0)) || syncState.deletes.length > 0;
      if (!more) break;
    }
  } catch {} finally { syncing = false; }
}
function scheduleSync(delay = 2500) {
  if (syncOff) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), delay);
}
// Coming back to the app is exactly when the other device's work should appear.
document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSync(300); });
window.addEventListener("online", () => scheduleSync(600));
setInterval(() => { if (!document.hidden) syncNow(); }, 60000);

// Restore the per-chat live-job map, migrating the legacy single-job key one last time (then drop it).
function loadLiveJobs() {
  try { const m = JSON.parse(localStorage.getItem(LS_LIVEJOBS) || "null"); if (m && typeof m === "object") liveJobs = m; } catch {}
  try {
    const old = JSON.parse(localStorage.getItem(LS_LIVEJOB_OLD) || "null");
    if (old && old.jobId && old.chatId && !liveJobs[old.chatId]) liveJobs[old.chatId] = { jobId: old.jobId, eventIndex: old.eventIndex || 0 };
    localStorage.removeItem(LS_LIVEJOB_OLD);
  } catch {}
}
const persistLiveJobs = () => { try { localStorage.setItem(LS_LIVEJOBS, JSON.stringify(liveJobs)); } catch {} };
const cur = () => chats.find((c) => c.id === curId);
function touchChatComponent(c, clockField, at = Date.now()) {
  if (!c) return 0;
  const stamp = Math.max(Number(at) || 0, (Number(c[clockField]) || 0) + 1);
  c[clockField] = stamp;
  if (clockField === "transcriptUpdatedAt") c.transcriptClockTrusted = true;
  c.updatedAt = Math.max(Number(c.updatedAt) || 0, stamp);
  return stamp;
}
// The Forge controls are conversation state, not browser-global state. dominion-forge.js loads
// before this file, so it discovers this bridge lazily each time the dial is read or changed.
window.dominionForgeSession = {
  get() {
    const c = cur();
    return c ? { tier: c.forgeTier || "ember", mode: c.forgeMode === true } : null;
  },
  set(patch) {
    const c = cur();
    if (!c || !patch || typeof patch !== "object") return;
    let changed = false;
    if (["ember", "flame", "furnace"].includes(patch.tier) && c.forgeTier !== patch.tier) {
      c.forgeTier = patch.tier; changed = true;
    }
    if (typeof patch.mode === "boolean" && c.forgeMode !== patch.mode) {
      c.forgeMode = patch.mode; changed = true;
    }
    if (changed) {
      touchChatComponent(c, "forgeUpdatedAt");
      save();
    }
  },
};
const titleFrom = (msgs) => { const u = msgs.find((m) => m.role === "user"); const base = u ? (u.content || (Array.isArray(u.attachments) && u.attachments[0] && ("📎 " + u.attachments[0].name)) || "") : "New chat"; return String(base).replace(/\s+/g, " ").trim().slice(0, 40) || "New chat"; };
const resolvePersona = () => settings.persona === "custom" ? (settings.personaCustom || "") : (PRESETS[settings.persona] || "");
const forcedModel = () => { const v = modelSel ? modelSel.value : "local"; return (v && v !== "auto" && v !== "local") ? v : ""; };
let draftSaveTimer = null;
function chatPendingAttachments(c) {
  if (!c) return [];
  if (!Array.isArray(c.pendingAttachments)) c.pendingAttachments = [];
  return c.pendingAttachments;
}
function captureChatDraft() {
  const c = cur();
  if (!c) return false;
  const next = input.value || "";
  if ((c.draft || "") === next) return false;
  c.draft = next;
  c.activityAt = touchChatComponent(c, "draftUpdatedAt");
  return true;
}
function captureChatAttachments() {
  const c = cur();
  if (!c || c.pendingAttachments === pendingAtt) return false;
  c.pendingAttachments = pendingAtt;
  c.activityAt = touchChatComponent(c, "draftUpdatedAt");
  return true;
}
function persistChatComposer() {
  clearTimeout(draftSaveTimer);
  captureChatDraft();
  captureChatAttachments();
  // Switching must persist earlier in-memory changes even when both view bindings already point at
  // their chat fields (the normal case after an attachment add/remove).
  save();
}
function restoreChatDraft() {
  if (input.dataset.chatId === (curId || "")) return;
  const c = cur();
  input.value = (c && c.draft) || "";
  input.dataset.chatId = curId || "";
  autosize();
}
function restoreChatAttachments() {
  pendingAtt = chatPendingAttachments(cur());
  renderAttachStrip();
}
function setChatPendingAttachments(c, attachments) {
  if (!c || !chats.some((x) => x.id === c.id)) return false;
  const next = Array.isArray(attachments) ? attachments : [];
  c.pendingAttachments = next;
  c.activityAt = touchChatComponent(c, "draftUpdatedAt");
  if (c.id === curId) {
    pendingAtt = next;
    renderAttachStrip();
    updateEstimate();
  }
  save();
  return true;
}
function restoreChatModel() {
  if (!modelSel) return;
  const c = cur();
  const saved = (c && c.model) || localStorage.getItem(LS_MODEL) || "";
  const desired = (saved && saved !== "local" && saved !== "auto") ? saved : defaultCloudModel();
  const opt = Array.from(modelSel.options).find((o) => o.value === desired);
  modelSel.value = opt ? desired : defaultCloudModel();
  updateModelTrigger();
  updateCloudBadge();
  renderModelPanel();
  updateAttachGate();
}

// ---------- chats ----------
// Leaving a substantial chat triggers a server-side episodic summary (fire-and-forget; the server
// dedupes and skips chats it already summarized).
function summarizeLeft(id) {
  const c = chats.find((x) => x.id === id);
  if (!c || c.messages.length < 4) return;
  fetch("/memory/summarize-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: id }) }).catch(() => {});
}
function newChat() {
  const prev = curId;
  if (prev) persistChatComposer();
  if (typeof window.closeForgeDial === "function") window.closeForgeDial();
  detachCurrentSession();
  const now = Date.now();
  const lsModel = localStorage.getItem(LS_MODEL);
  const defaultModel = (lsModel && lsModel !== "local" && lsModel !== "auto") ? lsModel : ((modelSel && modelSel.value) || defaultCloudModel());
  const savedTier = localStorage.getItem("dominion.forgeTier");
  const c = {
    id: uid(), title: "New chat", messages: [], model: defaultModel, draft: "", pendingAttachments: [],
    forgeTier: ["ember", "flame", "furnace"].includes(savedTier) ? savedTier : "ember",
    forgeMode: localStorage.getItem("dominion.forgeModeEnabled") === "1",
    transcriptUpdatedAt: now, titleUpdatedAt: now, modelUpdatedAt: now, draftUpdatedAt: now, forgeUpdatedAt: now,
    transcriptClockTrusted: true,
    updatedAt: now, activityAt: now,
  };
  chats.unshift(c); curId = c.id; save(); renderAll(); scroll(true); closeSidebar();
  igniteChatSurface(); input.focus(); if (prev) summarizeLeft(prev);
  try { fetchBudget(); } catch {}
}
// Fresh-start ignition: a quick green scan-sweep over the chat surface as the rail closes.
function igniteChatSurface() {
  const surf = document.getElementById("neural-glass") || document.body;
  surf.classList.remove("nc-ignite"); void surf.offsetWidth;   // retrigger
  surf.classList.add("nc-ignite");
  setTimeout(() => surf.classList.remove("nc-ignite"), 1000);
}
// Switching chats no longer blocks on a running turn: the run keeps generating server-side and its
// per-chat liveJobs entry persists. We tear down the on-screen streaming session (WITHOUT stopping
// the server job), render the target chat, then reattach if IT has a live run.
function switchChat(id) {
  if (id === curId) { closeSidebar(); return; }
  const prev = curId;
  persistChatComposer();
  if (typeof window.closeForgeDial === "function") window.closeForgeDial();
  detachCurrentSession();
  curId = id; save(); renderAll(); scroll(true); closeSidebar();
  if (prev && prev !== id) summarizeLeft(prev);
  maybeReattach();
  try { fetchBudget(); } catch {}
}
function deleteChat(id) {
  // Deleting a chat is also an explicit stop for that chat's durable turn. Merely removing the
  // sidebar row used to orphan the server job; boot reconciliation could later rediscover it and
  // resurrect output for a conversation the user had deliberately forgotten.
  const running = liveJobs[id];
  if (running && running.jobId) {
    fetch("/chat/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: running.jobId }),
    }).catch(() => {});
  }
  if (curId === id && running) detachCurrentSession();
  if (running) {
    delete liveJobs[id];
    persistLiveJobs();
  }
  // True forget: also erase the server's transcript copy + any episodic memory distilled from this
  // chat, so cross-chat retrieval can never resurrect it (fire-and-forget; nothing breaks offline).
  const deletedAt = Date.now();
  fetch("/chatlog/forget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: id, deletedAt }) }).catch(() => {});
  // Queue a tombstone for sync as well, so the delete reaches the other devices even if the call
  // above never lands (offline). The server treats both paths as the same idempotent tombstone.
  syncState.deletes.push({ id, deletedAt });
  delete syncState.pushed[id];
  saveSync();
  chats = chats.filter((c) => c.id !== id); if (curId === id) curId = (chats[0] && chats[0].id) || null; if (!curId) { newChat(); return; } save(); renderAll();
}
async function renameChat(id) { const c = chats.find((x) => x.id === id); if (!c) return; const t = await askText({ kicker: "Conversation", title: "Rename chat", multiline: false, value: c.title, maxlen: 60, saveLabel: "Rename" }); if (t != null) { c.title = t.trim().slice(0, 60) || c.title; touchChatComponent(c, "titleUpdatedAt"); save(); renderSidebar(); } }

// ---------- sidebar ----------
const openSidebar = () => { sidebar.classList.add("open"); overlay.classList.add("show"); document.body.classList.add("rail-open"); };
const closeSidebar = () => { sidebar.classList.remove("open"); overlay.classList.remove("show"); document.body.classList.remove("rail-open"); };
const MODE_LABEL = { fast: "Fast", normal: "Normal", deep_think: "Deep", long_context: "Long", draft: "Draft", tool: "Tool", mentor: "Mentor" };
// Friendly tier labels — raw LOCAL model names never surface anywhere in the UI (Fred's lock).
// Cloud (OpenRouter) models DO surface by name on purpose: Fred chose one and is spending on it.
const MODEL_TIER_LABEL = {
  "qwen3:8b": "Fast", "qwen3:30b-a3b": "Deep", local: "Local Qwen",
  "anthropic/claude-haiku-4.5": "Claude Haiku 4.5", "openai/gpt-4o": "GPT-4o",
  "google/gemini-2.5-flash": "Gemini 2.5 Flash", "meta-llama/llama-4-maverick": "Llama 4 Maverick",
  "meta-llama/llama-3.1-70b-instruct": "Llama 3.1 70B", "z-ai/glm-5.2": "GLM 5.2",
  "moonshotai/kimi-k2.6": "Kimi K2.6", "qwen/qwen3-235b-a22b-2507": "Qwen3 235B",
};
// A model id is "cloud" when it carries a provider prefix (contains "/"); local ids never do.
const isCloudModel = (v) => typeof v === "string" && v.includes("/");
// Toggle the header "via OpenRouter" spend indicator to match the current selection.
function updateCloudBadge() { if (cloudBadge) cloudBadge.hidden = !isCloudModel(modelSel ? modelSel.value : ""); }
const relTime = (ts) => { const d = Date.now() - (ts || 0); const m = Math.round(d / 60000); if (m < 60) return m + "m"; const h = Math.round(m / 60); if (h < 24) return h + "h"; return Math.round(h / 24) + "d"; };
function renderSidebar() {
  chatlist.innerHTML = "";
  const q = chatQuery.trim().toLowerCase();
  for (const c of [...chats].sort((a, b) => (b.activityAt || b.updatedAt || 0) - (a.activityAt || a.updatedAt || 0))) {
    if (q && !(c.title || "").toLowerCase().includes(q) && !c.messages.some((m) => (m.content || "").toLowerCase().includes(q))) continue;
    const row = document.createElement("div"); row.className = "ci" + (c.id === curId ? " active" : "") + (busyFor(c.id) ? " running" : "");
    const ttl = document.createElement("div"); ttl.className = "ttl"; ttl.textContent = c.title || "New chat"; ttl.onclick = () => switchChat(c.id);
    if (busyFor(c.id)) { const dot = document.createElement("span"); dot.className = "runrun"; dot.title = "A run is generating in this chat"; ttl.prepend(dot); }
    const meta = document.createElement("span"); meta.className = "meta";
    const activeAt = c.activityAt || c.updatedAt;
    meta.textContent = (c.lastMode && MODE_LABEL[c.lastMode] ? MODE_LABEL[c.lastMode] + " · " : "") + (activeAt ? relTime(activeAt) : "");
    const ren = document.createElement("span"); ren.className = "x"; ren.textContent = "✎"; ren.title = "Rename"; ren.onclick = (e) => { e.stopPropagation(); renameChat(c.id); };
    const del = document.createElement("span"); del.className = "x"; del.textContent = "×"; del.title = "Delete"; del.onclick = (e) => { e.stopPropagation(); if (confirm("Delete this chat?")) deleteChat(c.id); };
    row.append(ttl, meta, ren, del); chatlist.appendChild(row);
  }
  if (!chatlist.children.length && q) { const n = document.createElement("div"); n.className = "none"; n.style.cssText = "color:var(--muted);font-size:13px;text-align:center;padding:14px"; n.textContent = "No chats match."; chatlist.appendChild(n); }
}

// ---------- rendering ----------
const stripThink = (t) => t.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
// Follow the stream only while the reader is AT the bottom. The old unconditional snap fought any
// upward scroll during generation (the "shaking"). Scrolling up hands control to the user; coming
// back to the bottom re-engages the follow; scroll(true) re-engages explicitly (send / chat switch).
let followStream = true;
const nearBottom = () => main.scrollHeight - main.scrollTop - main.clientHeight < 140;
main.addEventListener("scroll", () => { followStream = nearBottom(); }, { passive: true });
const scroll = (force) => { if (force) followStream = true; if (followStream) main.scrollTop = main.scrollHeight; };
function mkAct(label, fn, title) { const b = document.createElement("button"); b.className = "act"; b.textContent = label; if (title) b.title = title; b.onclick = fn; return b; }
// A produced document, as a control you can actually press. The server guarantees one of these
// per exported file (Fred, 2026-07-19: "generate a downloadable document" used to end in an
// artifact id and a server path, which is not a document you can open).
const FILE_ICON = { pdf: "📕", docx: "📘", xlsx: "📗", csv: "📗", md: "📄", txt: "📄", json: "🧾", html: "🌐" };
function fileChip(f) {
  const a = document.createElement("a");
  a.className = "filechip";
  a.href = f.url;
  a.download = f.name;
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  a.textContent = (FILE_ICON[ext] || "📄") + " Download " + f.name;
  a.title = "Save " + f.name + " to this device";
  return a;
}
// The user prompt that preceded message i (feeds hallucination check / save lesson / convert-to-eval).
function precedingUser(c, i) { for (let k = i - 1; k >= 0; k--) if (c.messages[k].role === "user") return c.messages[k].content; return ""; }
async function copyText(t) { try { await navigator.clipboard.writeText(t); } catch { const a = document.createElement("textarea"); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand("copy"); } catch {} a.remove(); } }
function renderMsg(m, i, isLastAi, mount = wrap) {
  const turn = document.createElement("div"); turn.className = "turn";
  const row = document.createElement("div"); row.className = "msg " + (m.role === "user" ? "me" : "ai");
  const b = document.createElement("div"); b.className = "bubble";
  if (m.role === "assistant" && window.DominionMarkdown) {
    b.classList.add("markdown");
    window.DominionMarkdown.renderInto(b, m.content);
  } else {
    b.textContent = m.content;
  }
  row.appendChild(b); turn.appendChild(row);
  // Per-answer speak buttons (Fred, 2026-07-18): top-right and bottom-right of every AI bubble,
  // for speaking THIS answer on demand. The composer's big toggle is the auto-speak master.
  if (m.role === "assistant" && m.content) {
    b.classList.add("has-speak");
    const mkSpk = (pos) => {
      const sp = document.createElement("button");
      sp.className = "bspeak " + pos; sp.type = "button"; sp.title = "Speak this answer";
      sp.innerHTML = "&#128266;";
      // Toggle, not fire-and-forget: tapping the button that is currently speaking stops it.
      // Before this, starting playback meant sitting through the whole answer with no way out.
      sp.onclick = (e) => { e.stopPropagation(); voice.toggle(m.content, sp); };
      return sp;
    };
    b.append(mkSpk("bspeak-top"), mkSpk("bspeak-bottom"));
  }
  // Sent attachments render inside the bubble: picture thumbnails (tap to open full size) and
  // file chips. Pruned ones (storage cap) show an honest placeholder instead of vanishing.
  if (m.role === "user" && Array.isArray(m.attachments) && m.attachments.length) {
    const gal = document.createElement("div"); gal.className = "att-gallery";
    for (const a of m.attachments) {
      if (a.kind === "image" && a.dataUrl) {
        const img = document.createElement("img"); img.src = a.dataUrl; img.alt = a.name || "picture"; img.title = a.name || "";
        img.onclick = () => openImageFull(a.dataUrl);
        gal.appendChild(img);
      } else {
        const chip = document.createElement("span"); chip.className = "att-file";
        chip.textContent = a.kind === "text" ? "📄 " + (a.name || "file") : "🖼 " + (a.name || "picture") + " (no longer stored on this device)";
        gal.appendChild(chip);
      }
    }
    b.prepend(gal);
  }
  // Persistent "context used" line (spec: show context/tool usage per message) — survives reloads.
  // F4: the 🧠/📄/💬 chip expands on tap to list WHICH items were loaded (when the meta carries
  // them); the 🔧 chip opens the tool panel filtered to this message's runs. ⏸ marks interrupted.
  if (m.role === "assistant" && m.meta && (m.meta.memory || m.meta.artifacts || m.meta.chats || m.meta.tools || m.meta.mode || m.meta.interrupted || m.meta.outputTokens || m.meta.costUsd)) {
    const mm = document.createElement("div"); mm.className = "msgmeta";
    const sep = () => mm.appendChild(document.createTextNode(" · "));
    const bit = (text, title, fn) => { const s = document.createElement("span"); s.textContent = text; if (title) s.title = title; if (fn) { s.style.cursor = "pointer"; s.onclick = fn; } if (mm.childNodes.length) sep(); mm.appendChild(s); return s; };
    if (m.meta.mode && MODE_LABEL[m.meta.mode]) bit(MODE_LABEL[m.meta.mode]);
    if (m.meta.checkpoint) {
      const b = bit("⏸ checkpointed", "The task is unfinished and can resume from this saved checkpoint");
      b.style.color = "#9ee6ad";
    } else if (m.meta.interrupted) {
      const b = bit("⏸ interrupted", m.meta.stopReason === "server_restart"
        ? "A server restart interrupted this run before it finished"
        : "You stopped this answer before it finished");
      b.style.color = "#e8b07c";
    }
    // The Continue the orphan tail has always promised (Fred, 2026-07-30: it named a button that
    // did not exist). Offered on the newest AI message of an unfinished run only.
    if ((m.meta.checkpoint || m.meta.interrupted) && m.meta.jobId && isLastAi) {
      const r = bit("▶ Continue this run", "Resume from the verified progress; finished work is never redone");
      r.style.color = "#9ee6ad"; r.style.fontWeight = "700";
      r.onclick = () => resumeInterruptedRun(m.meta.jobId);
    }
    // Context chips are individually gated on settings (all OFF by default — Fred, 2026-07-25;
    // System Settings has a restore checkbox for each). Split from the old single fused span so
    // each can be toggled on its own; any of them still taps open the per-item detail.
    const ci = m.meta.contextItems;
    const ctxChip = (txt) => bit(txt, ci ? "Tap to see which items were loaded" : "Context loaded for this answer (per-item detail unavailable for this message)", ci ? () => toggleCtxDetail(turn, mm, ci) : null);
    if (m.meta.memory && settings.ctxMem) ctxChip("🧠 " + m.meta.memory);
    if (m.meta.artifacts && settings.ctxDocs) ctxChip("📄 " + m.meta.artifacts);
    if (m.meta.chats && settings.ctxChats) ctxChip("💬 " + m.meta.chats);
    if (m.meta.tools) bit("🔧 " + m.meta.tools, "Tap to show this message's tool log", () => openTools({ runIds: m.meta.runIds, chatId: curId, label: "this message" }));
    // Documents this turn produced stay downloadable after a reload.
    if (Array.isArray(m.meta.files)) for (const f of m.meta.files) turn.appendChild(fileChip(f));
    // Per-exchange usage total (Fred, 2026-07-18): the running cost counter is gone from the
    // composer; the honest numbers land HERE, once, after the answer finishes.
    if (m.meta.outputTokens || m.meta.costUsd) {
      const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n));
      const toks = [m.meta.inputTokens ? fmt(m.meta.inputTokens) + " in" : null, m.meta.outputTokens ? fmt(m.meta.outputTokens) + " out" : null].filter(Boolean).join(" / ");
      // Guests read this in credits, the only currency they hold (Fred, 2026-07-30). DominionMoney
      // owns the wording for every surface; the number itself is the server's, untouched.
      const cost = typeof m.meta.costUsd === "number" && m.meta.costUsd > 0 ? money().cost(m.meta.costUsd) : "";
      const label = ["⚡ " + (toks || "tokens n/a"), cost].filter(Boolean).join(" · ");
      bit(label, "Tokens and cost for this exchange");
    }
    // BATTALION manifest (Wave 6): which crew worked, how many parts, how long, and that it was
    // free — this line IS the product. Fallbacks/replacements live in the hover title, announced.
    if (m.meta.battalion) {
      const b = m.meta.battalion;
      const n = (b.models && b.models.length) || 1;
      const secs = Math.max(1, Math.round((b.ms || 0) / 1000));
      const time = secs >= 90 ? Math.round(secs / 60) + " min" : secs + "s";
      const label = "⚔ " + n + " model" + (n === 1 ? "" : "s") + (b.parts ? " · " + b.parts + " parts" : "") + " · " + time + " · free";
      bit(label, (b.models || []).join(", ") + (b.notes && b.notes.length ? " — " + b.notes.join("; ") : ""));
    }
    turn.appendChild(mm);
  }
  const acts = document.createElement("div"); acts.className = "acts" + (m.role === "user" ? " me" : "");
  if (m.role === "user") { acts.append(mkAct("Edit", () => editUser(i)), mkAct("Copy", () => copyText(m.content))); }
  else {
    acts.appendChild(mkAct("Copy", () => copyText(m.content)));
    acts.appendChild(mkAct("Save", () => saveAsArtifact(m.content), "Save as artifact"));
    acts.appendChild(mkAct("Critique", () => critiqueMessage(i), "Full mentor critique"));
    // F1 (audit items 23-25): distinct per-message spec controls, compact glyphs to fit 375px.
    acts.appendChild(mkAct("🔎", () => critiqueMessage(i, "hallucination_check"), "Hallucination check"));
    acts.appendChild(mkAct("💡", () => saveLesson(i), "Save lesson"));
    acts.appendChild(mkAct("🧪", () => convertToEval(i), "Convert to eval"));
    if (isLastAi && !busyFor(curId)) { acts.appendChild(mkAct("Continue", () => continueLast())); acts.appendChild(mkAct("Regenerate", () => regenerate())); }
  }
  turn.appendChild(acts); mount.appendChild(turn);
}
// F4: expandable context detail — lists the actual memory/artifact/chat items the server loaded.
function toggleCtxDetail(turn, anchor, ci) {
  const old = turn.querySelector(".ctxdetail"); if (old) { old.remove(); return; }
  const d = document.createElement("div"); d.className = "ctx ctxdetail"; d.style.whiteSpace = "pre-wrap";
  const lines = [];
  for (const it of ci.memory || []) lines.push("🧠 " + (it.title || "memory") + (it.label ? "  [" + it.label + "]" : ""));
  for (const it of ci.artifacts || []) lines.push("📄 " + (it.title || "artifact"));
  for (const it of ci.chats || []) lines.push("💬 " + (it.title || "past chat"));
  d.textContent = lines.length ? lines.join("\n") : "(nothing was loaded)";
  anchor.after(d);
}
// F1 (item 24): Save lesson — pick where it lands: failure ledger / eval case / prompt rule.
async function saveLesson(i) {
  const c = cur(); if (!c || !c.messages[i]) return;
  const answer = c.messages[i].content, orig = precedingUser(c, i);
  const kind = (await askText({ kicker: "Teach Dominion", title: "Save this lesson as…", multiline: false, value: "failure",
    hint: "Type one: failure (log what went wrong), eval (a re-runnable test), or rule (a standing instruction).", saveLabel: "Continue" }) || "").trim().toLowerCase();
  if (!kind) return;
  if (kind.startsWith("f")) {
    const note = await askText({ kicker: "Failure ledger", title: "The lesson", placeholder: "What should have happened instead…",
      hint: "This is filed against the answer above so the model learns from it." }); if (note == null) return;
    const r = await aApi("/ledger", { category: "manual", severity: "low", originalRequest: orig.slice(0, 2000), flawedOutput: answer.slice(0, 4000), correctedOutput: note.trim(), detectedBy: "user" });
    alert(r.item ? "Lesson logged to the failure ledger." : "Ledger: " + (r.error || "failed"));
  } else if (kind.startsWith("e")) {
    await convertToEval(i);
  } else if (kind.startsWith("r")) {
    const t = await askText({ kicker: "Standing rule", title: "A rule the assistant should follow", placeholder: "A compact instruction…" }); if (t == null || !t.trim()) return;
    const r = await aApi("/rules", { content: t.trim(), scope: "global", status: "candidate" });
    alert(r.item ? "Saved as a candidate rule — test/activate it in Mentor & Improvement." : "Rule: " + (r.error || "failed"));
  } else alert("Unknown kind — use failure, eval, or rule.");
}
// F1 (item 25): Convert to eval — the preceding user prompt becomes the eval input.
async function convertToEval(i) {
  const c = cur(); if (!c || !c.messages[i]) return;
  const orig = precedingUser(c, i) || c.messages[i].content;
  const exp = await askText({ kicker: "Evaluation", title: "Expected behavior", placeholder: "What a good answer must do…" }); if (exp == null) return;
  const r = await aApi("/evals", { title: orig.replace(/\s+/g, " ").slice(0, 80), input: orig.slice(0, 4000), expectedBehavior: exp, source: "manual" });
  alert(r.item ? "Eval case saved — run it from Mentor & Improvement." : "Eval: " + (r.error || "failed"));
}
/*
 * The ledger rail: which engine each stretch of the transcript ran on.
 *
 * The UNKNOWN-model fallback used to be the literal string "local", left over from when Local Qwen
 * was the default engine. Since it left the picker (b6f0b03) that fallback has been actively
 * misleading: a brand new chat has no c.model until the first send, so the rail rendered a "Local
 * Qwen" chip above a picker plainly reading DeepSeek V4 Pro (Fred, 2026-07-30: "that picked, it
 * loaded my local Qwen model which should no longer be even available"). Nothing had loaded local.
 * The server routes these turns to the cloud default correctly; only this label lied, and it named
 * the one engine most alarming to see.
 *
 * Unknown now resolves to the same cloud default the send path uses, so the rail and the picker
 * cannot disagree. A message that genuinely RAN on local still carries modelId "local" and still
 * reads Local Qwen, because history stays honest.
 */
function transcriptModelPlan(c) {
  const entries = [], slots = [];
  const unknown = () => defaultCloudModel() || c.model || "";
  let actualModel = "", slot = -1;
  for (const m of c.messages || []) {
    const id = m.modelId || actualModel || c.model || unknown();
    if (!actualModel || id !== actualModel) {
      actualModel = id;
      if (entries.length < 3) {
        entries.push({ id, pending: false });
        slot = entries.length - 1;
      }
    }
    slots.push(Math.max(0, slot));
  }
  if (!entries.length) {
    entries.push({ id: c.model || unknown(), pending: true });
  } else if (c.model && c.model !== actualModel && entries.length < 3) {
    entries.push({ id: c.model, pending: true });
  }
  return { entries, slots };
}
function renderTranscript() {
  wrap.querySelectorAll(".model-ledger, .model-era, .turn, .err").forEach((n) => n.remove());
  const c = cur();
  empty.style.display = (c && c.messages.length) ? "none" : "";
  if (c) {
    const plan = transcriptModelPlan(c);
    const mobile = window.innerWidth <= 700;
    const ledger = document.createElement("div"); ledger.className = "model-ledger"; ledger.setAttribute("aria-hidden", "true");
    const list = document.createElement("div"); list.className = "model-ledger-list";
    ledger.appendChild(list); wrap.insertBefore(ledger, wrap.firstChild);
    // Size against the actual scroll field, not the whole window: header/footer height varies with
    // device and focus mode, and using 100vh is what let long names run past both field edges. The
    // ledger is in-flow before this measurement so the top padding of the real field is included.
    const fieldBox = main && main.getBoundingClientRect();
    const ledgerBox = ledger.getBoundingClientRect();
    const available = fieldBox ? fieldBox.bottom - Math.max(fieldBox.top, ledgerBox.top) - 8 : window.innerHeight - 80;
    const span = Math.max(100, Math.min(mobile ? 570 : 690, available));
    const sizeCap = plan.entries.length === 1 ? (mobile ? 43 : 62)
      : plan.entries.length === 2 ? (mobile ? 31 : 46) : (mobile ? 24 : 36);
    ledger.style.setProperty("--model-span", span + "px");
    let railWidth = 0;
    plan.entries.forEach((entry, i) => {
      const display = modelDisplayName(entry.id);
      let fit = Math.max(mobile ? 12 : 14, Math.min(sizeCap, Math.floor(span / Math.max(7, display.length * .82))));
      const item = document.createElement("div"); item.className = "model-ledger-entry" + (entry.pending ? " pending" : "");
      item.style.setProperty("--model-hue", String(modelHue(entry.id)));
      const index = document.createElement("span"); index.className = "model-ledger-index"; index.textContent = String(i + 1);
      const name = document.createElement("span"); name.className = "model-ledger-name"; name.textContent = display;
      name.style.fontSize = fit + "px";
      item.append(index, name); list.appendChild(item);
      // Font metrics vary by platform. Measure the real rendered label and trim once more if its
      // glyphs exceed the vertical track; this is the mechanical guarantee that the full name fits.
      if (name.scrollWidth > name.clientWidth) {
        fit = Math.max(mobile ? 12 : 14, Math.floor(fit * (name.clientWidth / name.scrollWidth) * .96));
        name.style.fontSize = fit + "px";
      }
      item.style.width = (fit + (mobile ? 6 : 9)) + "px";
      railWidth += fit + (mobile ? 6 : 9);
    });
    wrap.style.setProperty("--model-rail-width", Math.max(mobile ? 34 : 46, railWidth + (mobile ? 7 : 12)) + "px");

    let lastAi = -1; for (let i = c.messages.length - 1; i >= 0; i--) if (c.messages[i].role === "assistant") { lastAi = i; break; }
    let era = null, eraIndex = -1;
    const openEra = (index) => {
      const entry = plan.entries[index] || plan.entries[plan.entries.length - 1];
      const section = document.createElement("section"); section.className = "model-era" + (entry.pending ? " pending" : "");
      section.dataset.model = entry.id; section.dataset.era = String(index + 1);
      if (index > 0) {
        const divider = document.createElement("div"); divider.className = "model-era-divider"; divider.setAttribute("aria-label", "Model " + (index + 1) + " begins");
        const badge = document.createElement("span"); badge.textContent = String(index + 1);
        divider.appendChild(badge); section.appendChild(divider);
      }
      const turns = document.createElement("div"); turns.className = "model-era-turns";
      section.appendChild(turns); wrap.appendChild(section);
      eraIndex = index; era = turns;
    };
    c.messages.forEach((m, i) => {
      const messageEra = Math.min(plan.slots[i] || 0, plan.entries.length - 1);
      if (!era || messageEra !== eraIndex) openEra(messageEra);
      renderMsg(m, i, i === lastAi, era);
    });
    if (!era || (plan.entries[plan.entries.length - 1].pending && eraIndex !== plan.entries.length - 1)) {
      openEra(plan.entries.length - 1);
    }
  }
}
function renderAll() {
  restoreChatDraft();
  restoreChatAttachments();
  restoreChatModel();
  try { document.dispatchEvent(new CustomEvent("dominion-chat-changed", { detail: { chatId: curId } })); } catch {}
  updateFocusMode();   // Chat Focus Mode: the header is folded on every load, handles always available
  try { paintToCrucible(); } catch {}   // the hand-off button follows the same chat
  renderTranscript();  // measure after focus mode settles so names fit the field's real height
  renderSidebar(); renderBudget(); syncComposer(); scroll();
}
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px"; }
function showErr(t) { document.querySelector(".err")?.remove(); const e = document.createElement("div"); e.className = "err"; e.textContent = t; wrap.appendChild(e); scroll(); }

// ---------- models (advanced override; the router picks by default) ----------
// The LOCAL optgroup is rebuilt from Ollama's live list. The CLOUD groups are rebuilt from the
// server's live catalog (/api/models) — categorized, priced, with a bench tag (🔧 = can drive your
// tools, 💬 = chat-only) and dimmed when that provider has no key configured. If either fetch fails
// the static options in index.html survive as a fallback. Fred's lock: local raw names never surface.
function fmtCtxShort(n) { if (!n) return ""; return n >= 1e6 ? (n % 1e6 ? (n / 1e6).toFixed(1) : n / 1e6) + "M" : Math.round(n / 1e3) + "K"; }
/*
 * The cloud default, now that Local Qwen left the picker (Fred, 2026-07-30). Everything that used
 * to fall back to "local" resolves here instead: Fred's daily driver first, then the first keyed,
 * privacy-allowed model in the catalog. Returns "" only before the catalog has loaded; the
 * post-load re-render resolves it for real. Never returns "battalion" — a swarm is a deliberate
 * pick, not a silent default.
 */
const PREFERRED_DEFAULT_MODEL = "deepseek/deepseek-v4-pro";
function defaultCloudModel() {
  const mode = privacyModeSel ? privacyModeSel.value : "normal";
  const ok = (m) => {
    if (!m || m.id === "battalion") return false;
    const keyed = m.provider === "openrouter" ? availCache.openrouter : m.provider === "openai" ? availCache.openai : m.provider === "deepseek" ? availCache.deepseek : m.provider === "anthropic" ? availCache.anthropic : true;
    return keyed !== false && providerAllowedClient(mode, m.provider);
  };
  for (const g of catalogGroups) for (const m of g.models || []) if (m.id === PREFERRED_DEFAULT_MODEL && ok(m)) return m.id;
  // A default should answer promptly: prefer a model with no hidden thinking step, so the slow-
  // settings banner never greets a fresh install. Reasoning models remain one deliberate tap away.
  for (const g of catalogGroups) for (const m of g.models || []) if (ok(m) && !m.reasoning) return m.id;
  for (const g of catalogGroups) for (const m of g.models || []) if (ok(m)) return m.id;
  return "";
}
/*
 * The id STAMPED onto a stored message. Its one job is to name the engine the turn actually ran on,
 * because the ledger rail reads it back forever.
 *
 * Every stamp used to end its fallback chain in the literal "local". The send path had already been
 * taught to resolve local/auto to the cloud default (see the send-model resolution above), so those
 * turns really ran on DeepSeek while being recorded as Local Qwen: a permanent, and after b6f0b03
 * an impossible, claim about an engine the app no longer offers. Unknown now records the resolved
 * cloud default, or "" when the catalog has not loaded yet, because "" is honestly unknown and gets
 * resolved at display time, whereas "local" is an assertion that happens to be false.
 */
function stampedModelId(c) {
  const picked = modelSel && modelSel.value;
  if (picked && picked !== "auto" && picked !== "local") return picked;
  if (c && c.model && c.model !== "auto" && c.model !== "local") return c.model;
  return defaultCloudModel() || "";
}
function fmtPriceShort(m) { return money().rate(m.inCost, m.outCost); }
/*
 * One composer for a native <select> row, so the money-ready repaint can rewrite the labels without
 * refetching the catalog. The native list is aria-hidden but still reachable by keyboard and by some
 * mobile pickers, and it must never disagree with the panel about the price or the currency.
 */
function optionLabel(m) {
  const bench = m.toolCapable ? "🔧" : "💬";
  const bits = [m.name, fmtPriceShort(m), fmtCtxShort(m.ctx)].filter(Boolean);
  return `${m.broadCapable ? "★ " : ""}${bench} ${bits.join(" · ")}`;
}
function relabelModelOptions() {
  if (!modelSel) return;
  for (const g of catalogGroups) {
    for (const m of g.models || []) {
      const o = Array.from(modelSel.options).find((x) => x.value === m.id);
      if (o) o.textContent = optionLabel(m);
    }
  }
  applyPrivacyFilter();   // re-applies the "blocked in x" / "key needed" suffixes it owns
}
let catalogGroups = [];   // live /api/models groups — the source for the custom model panel

/* ---- THE FAST LANE (OpenAI service_tier "fast", announced 2026-07-30) --------------------------
 * Up to 2.5x the speed for exactly 2x the price, with no change in intelligence, and offered on
 * one model. Three rules shape the control:
 *
 *   1. It is only DRAWN when the chosen model actually offers it. A switch that silently does
 *      nothing on most models teaches people to distrust every switch.
 *   2. It says the price on its face. Doubling a bill is not something to discover afterwards.
 *   3. It DISARMS after every send. A per-turn decision that quietly persists is how somebody ends
 *      up paying double for a week, and the whole point of this control is that it be deliberate.
 */
let fastArmed = false;
function catalogRec(id) {
  for (const g of catalogGroups) for (const m of (g.models || [])) if (m.id === id) return m;
  return null;
}
function fastLaneRec() {
  /*
   * Read the PICKER, not the chat state. The first version read st.modelId, which is a local inside
   * the send path and does not exist at module scope, so this threw and the control never appeared
   * however the model was set. The picker is the more honest source anyway: it is the model the
   * person can see they chose.
   */
  let id = "";
  try { id = (modelSel && modelSel.value) || ""; } catch { id = ""; }
  if (!id || id === "auto" || id === "local") { try { id = defaultCloudModel() || ""; } catch { id = ""; } }
  const rec = id ? catalogRec(id) : null;
  return rec && rec.fastTier ? rec : null;
}
const fastLaneArmed = () => fastArmed && !!fastLaneRec();
function paintFastLane() {
  const el = document.getElementById("fast-lane");
  if (!el) return;
  const rec = fastLaneRec();
  el.hidden = !rec;
  if (!rec) {
    // Moved to a seat without the lane. Disarm AND clear the lit styling, so the control cannot
    // reappear looking armed for a heartbeat if the model changes back.
    fastArmed = false;
    el.classList.remove("on");
    el.setAttribute("aria-pressed", "false");
    const l = el.querySelector(".fl-label"); if (l) l.textContent = "";
    return;
  }
  const mult = Number(rec.fastMultiplier) || 2;
  el.classList.toggle("on", fastArmed);
  el.setAttribute("aria-pressed", fastArmed ? "true" : "false");
  const label = el.querySelector(".fl-label");
  if (label) label.textContent = fastArmed ? `Fast lane on · this turn costs ${mult}x` : `Fast lane · ${mult}x price, up to 2.5x faster`;
}
function setFastLane(on) { fastArmed = !!on && !!fastLaneRec(); paintFastLane(); }
async function loadModels() {
  if (!modelSel) return;
  const saved = (cur() && cur().model) || localStorage.getItem(LS_MODEL);
  // Local Qwen left this picker (Fred, 2026-07-30): no /ollama model probe, no local optgroup.
  // The model itself keeps running for Command Deck and the persona pipeline; only Dominion chat
  // stopped offering it.
  // Cloud groups from the live catalog. Only rebuild if the fetch succeeds — otherwise leave the
  // static index.html options intact so a picked cloud id never vanishes.
  try {
    const r = await fetch("/api/models", { cache: "no-store" });
    if (r.ok) {
      const cat = await r.json();
      const avail = cat.available || {};
      availCache = avail;
      if (cat.privacy && Array.isArray(cat.privacy.trustedProviders)) privacyCfg.trustedProviders = cat.privacy.trustedProviders;
      if (cat.privacy && Array.isArray(cat.privacy.privateProviders)) privacyCfg.privateProviders = cat.privacy.privateProviders;
      // Owner-only surfaces (the Wildfire switch and the roster star) key off this. The server is
      // the authority: it both sets this flag and refuses a non-owner arming attempt independently.
      window.dominionIsOwner = cat.wildfire === true;
      try { document.dispatchEvent(new CustomEvent("dominion-owner-known")); } catch {}
      catalogGroups = cat.groups || [];
      // Drop every existing optgroup before rebuilding from the live catalog.
      Array.from(modelSel.querySelectorAll("optgroup")).forEach((g) => g.remove());
      for (const grp of (cat.groups || [])) {
        if (!grp.models || !grp.models.length) continue;
        const og = document.createElement("optgroup");
        og.label = grp.category;
        for (const m of grp.models) {
          const o = document.createElement("option");
          o.value = m.id;
          o.dataset.provider = m.provider || "openrouter";
          const bench = m.toolCapable ? "🔧" : "💬"; // 🔧 doing / 💬 chatting
          const bits = [m.name, fmtPriceShort(m), fmtCtxShort(m.ctx)].filter(Boolean);
          // The Wildfire star. Owner-only: the server strips broadCapable from a guest's payload
          // entirely, so a guest's picker never renders one. Deliberately plain, per Fred: it marks
          // "trusted with broad authority", which is a narrower claim than the wrench (tool-capable).
          if (m.broadCapable) o.dataset.broad = "1";
          // Same owner-only machine-grant mark on the native <select>. The custom panel is what
          // Fred normally sees, but the native list is still reachable (keyboard, some mobile
          // browsers), and it should not disagree with the panel about which models can act.
          if (m.broadAccess) o.dataset.grant = "1";
          o.textContent = optionLabel(m);
          const provOk = m.provider === "openrouter" ? avail.openrouter : m.provider === "openai" ? avail.openai : m.provider === "deepseek" ? avail.deepseek : m.provider === "anthropic" ? avail.anthropic : true;
          if (provOk === false) o.dataset.noKey = "1";   // key-vs-privacy annotation applied by applyPrivacyFilter
          og.appendChild(o);
        }
        modelSel.appendChild(og);
      }
      applyPrivacyFilter();   // annotate/disable per current privacy mode + key availability
    }
  } catch {}
  // Restore this chat's pick if it exists in the live catalog. Privacy may disable it, but does
  // not silently change it: the user must explicitly pick a different model. A saved "local"/
  // "auto" (or a model that left the catalog) resolves to the cloud default instead.
  const opt = saved && Array.from(modelSel.options).find((o) => o.value === saved);
  modelSel.value = (saved === "auto" || saved === "local" || !opt) ? defaultCloudModel() : saved;
  updateCloudBadge();
  updateModelTrigger();
  renderModelPanel();
}

// ---------- custom Model dropdown (replaces the unreadable native <select> list) ----------
// The native <select id="model"> stays the state holder; this renders a framed, column-aligned
// panel from the live catalog and mirrors the same key/privacy disabling the picker already computes.
const modelTrigger = $("model-trigger"), modelPanel = $("model-panel"), modelCurrent = $("model-current");
const provLabel = (p) => ({ openrouter: "OpenRouter", openai: "OpenAI", deepseek: "DeepSeek", anthropic: "Anthropic", local: "Local" }[p] || p);
const findCatalogModel = (id) => { for (const g of catalogGroups) { const m = (g.models || []).find((x) => x.id === id); if (m) return m; } return null; };
function modelDisplayName(id) {
  // "local" still reads Local Qwen: a turn that genuinely ran there should say so forever. But an
  // EMPTY or "auto" id means "not resolved yet", which is not the same thing and must never be
  // labelled with an engine the app no longer offers. Those resolve to the cloud default instead.
  if (id === "local") return "Local Qwen";
  if (!id || id === "auto") {
    const d = defaultCloudModel();
    if (!d) return "Default";                 // catalog still loading; the re-render fills it in
    const m = findCatalogModel(d);
    return (m && m.name) || "Default";
  }
  const m = findCatalogModel(id);
  if (m && m.name) return m.name;
  const o = modelSel && Array.from(modelSel.options).find((x) => x.value === id);
  if (o) return o.textContent.replace(/\s*\(local\)$/, "").replace(/^[🔧💬👁]\s*/u, "");
  if (MODEL_TIER_LABEL[id]) return MODEL_TIER_LABEL[id];
  return String(id).split("/").pop().replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}
function modelHue(id) {
  let h = 0;
  for (const ch of String(id || "local")) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function updateModelTrigger() {
  if (!modelCurrent || !modelSel) return;
  const v = modelSel.value; let name = "Default", price = "", local = false, granted = false;
  if (v && v !== "local") {
    const m = findCatalogModel(v);
    if (m) { name = m.name; price = (!m.inCost && !m.outCost) ? "Free" : fmtPriceShort(m); local = false; granted = m.broadAccess === true; }
    else { const o = Array.from(modelSel.options).find((x) => x.value === v); name = o ? o.textContent.replace(/\s*\(local\)$/, "").replace(/^[🔧💬]\s*/, "") : v; }
  }
  modelCurrent.classList.toggle("is-local", local);
  // The picked model's own name carries the same red/bold mark as its row in the list.
  modelCurrent.classList.toggle("has-machine-grant", granted);
  modelCurrent.innerHTML = escapeHtml(name) + (price ? ` <span class="mc-price">${escapeHtml(price)}</span>` : "");
}

function modelRowHtml(o, cur, mode) {
  const disabled = o.noKey || o.blocked, sel = o.id === cur;
  const cls = ["model-row"]; if (sel) cls.push("is-selected"); if (disabled) cls.push("is-disabled"); if (o.blocked) cls.push("is-blocked");
  const price = o.free ? `<span class="mr-price is-free">Free</span>` : (o.price ? `<span class="mr-price">${escapeHtml(o.price)}</span>` : "");
  const note = o.blocked ? `<span class="mr-note">blocked · ${escapeHtml(mode)}</span>` : (o.noKey ? `<span class="mr-note">key needed</span>` : "");
  return `<div class="${cls.join(" ")}" data-value="${escapeHtml(o.id)}" ${disabled ? 'aria-disabled="true"' : 'role="option"'}${sel ? ' aria-selected="true"' : ""}>
    <span class="mr-name"><span class="mr-bench">${o.tool ? "🔧" : "💬"}${o.vis ? "👁" : ""}</span><span class="mr-text${o.broadAccess ? " has-machine-grant" : ""}">${escapeHtml(o.name)}</span></span>
    <span class="mr-meta">${escapeHtml(o.meta || "")}</span>
    <span class="mr-tag">${price}${note}</span></div>`;
}

function renderModelPanel() {
  if (!modelPanel || !modelSel) return;
  const mode = privacyModeSel ? privacyModeSel.value : "normal", cur = modelSel.value;
  // No local rows: Local Qwen left this picker (Fred, 2026-07-30). Cloud catalog only.
  let html = "";
  for (const g of catalogGroups) {
    if (!g.models || !g.models.length) continue;
    html += `<div class="model-group">${escapeHtml(g.category)}</div>`;
    for (const m of g.models) {
      const keyed = m.provider === "openrouter" ? availCache.openrouter : m.provider === "openai" ? availCache.openai : m.provider === "deepseek" ? availCache.deepseek : m.provider === "anthropic" ? availCache.anthropic : true;
      html += modelRowHtml({
        id: m.id, name: m.name, tool: m.toolCapable, vis: !!m.vision, free: (!m.inCost && !m.outCost), price: fmtPriceShort(m),
        // Owner-only red/bold: the server only sends broadAccess to Fred's payload, so a guest's
        // rows can never carry the class no matter what the client does.
        broadAccess: m.broadAccess === true,
        meta: [(m.params && m.params !== "undisclosed") ? m.params : null, fmtCtxShort(m.ctx)].filter(Boolean).join(" · "),
        noKey: keyed === false, blocked: !providerAllowedClient(mode, m.provider),
      }, cur, mode);
    }
  }
  modelPanel.innerHTML = html;
}

function openModelPanel() { renderModelPanel(); modelPanel.hidden = false; if (modelTrigger) modelTrigger.setAttribute("aria-expanded", "true"); requestAnimationFrame(() => { const s = modelPanel.querySelector(".is-selected"); if (s) s.scrollIntoView({ block: "nearest" }); }); }
function closeModelPanel() { if (modelPanel) modelPanel.hidden = true; if (modelTrigger) modelTrigger.setAttribute("aria-expanded", "false"); }
if (modelTrigger) modelTrigger.addEventListener("click", (e) => { e.stopPropagation(); modelPanel.hidden ? openModelPanel() : closeModelPanel(); });
if (modelPanel) modelPanel.addEventListener("click", (e) => {
  const row = e.target.closest(".model-row"); if (!row || row.classList.contains("is-disabled")) return;
  modelSel.value = row.dataset.value; modelSel.dispatchEvent(new Event("change")); closeModelPanel();
});
document.addEventListener("click", (e) => { if (modelPanel && !modelPanel.hidden && !e.target.closest("#model-picker")) closeModelPanel(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modelPanel && !modelPanel.hidden) closeModelPanel(); });

/* ---------- pace warning: say a slow setup is slow BEFORE the wait --------------------------
 * THE FAILURE THIS PREVENTS (Fred, 2026-07-24, from his brother's pass). A beginner does not know
 * that a small local model is slower than a data centre, or that Deep Think and Furnace each add
 * time. They come from ChatGPT, where an answer starts immediately. So they pick the slowest
 * combination in the app, wait, and conclude the app does not work very well.
 *
 * WHAT THIS IS NOT. Not a countdown, and not a made-up estimate. The image forge already taught us
 * what a wrong number costs: it always ran longer than promised, so the number was worse than
 * silence. Every reason printed here is a real property of what the user picked (the catalog's own
 * `reasoning` flag, the mode in the dropdown, the dial position), and the only DURATION ever shown
 * is one this device actually measured on this same combination. Below three samples it says
 * nothing about time at all.
 */
const paceWarn = $("pace-warn");
const LS_PACE = "dominion.paceSamples";
const PACE_MIN_SAMPLES = 3;          // below this, the average is noise and we stay quiet
let paceSamples = {};
try { paceSamples = JSON.parse(localStorage.getItem(LS_PACE) || "{}") || {}; } catch {}
let paceOpen = false;

const paceTier = () => (window.forgeTierValue ? window.forgeTierValue() : "ember");
const paceSetup = () => ({ model: modelSel ? modelSel.value : "local", mode: modeSel ? modeSel.value : "auto", tier: paceTier() });
const paceKey = (s) => [s.model || "local", s.mode || "auto", s.tier || "ember"].join("|");

// Modes that add real work, in the user's vocabulary rather than ours. The number is how much
// weight each one carries toward the "this is slow" threshold.
const PACE_MODES = {
  deep_think:   ["Deep Think reasons the whole problem through before it writes anything", 2],
  long_context: ["Long Context reads a great deal of material before answering", 2],
  mentor:       ["Mentor answers and then reviews its own answer, so it runs twice", 2],
  as_fred:      ["As Fred applies the whole voice framework to every line", 1],
};
const PACE_TIERS = {
  flame:   ["The forge dial is on Flame, which thinks harder than Ember", 1],
  furnace: ["The forge dial is on Furnace, the slowest and most thorough setting", 2],
};

// Every reason is checked against a real fact about the pick. Score >= 3 is the slow band.
function paceRead(s) {
  const why = [];
  let score = 0;
  const add = (text, n) => { why.push(text); score += n; };
  if (!s.model) {
    // Unresolved (catalog still loading): unknown is not slow — say nothing rather than guess.
  } else if (s.model === "local" || s.model.startsWith("local")) {
    add("Local Qwen runs on one computer here instead of a data centre, so it writes slowly", 3);
  } else {
    const m = findCatalogModel(s.model);
    if (m && m.reasoning) add((m.name || "This model") + " thinks privately before it answers, which adds to every reply", 2);
    if (m && m.reasoningEffort === "max") add("Its thinking effort is fixed at maximum and cannot be turned down", 1);
  }
  const mode = PACE_MODES[s.mode];
  if (mode) add(mode[0], mode[1]);
  const tier = PACE_TIERS[s.tier];
  if (tier) add(tier[0], tier[1]);
  return { slow: score >= 3, why };
}

// The quick picks are DERIVED, never hardcoded: models with no hidden thinking step, that this
// account has a key for and the current privacy mode allows, cheapest output first (which in this
// catalog tracks with the light, fast tiers). Naming two real ones beats "choose a faster model".
function paceQuickPicks() {
  const mode = privacyModeSel ? privacyModeSel.value : "normal";
  const direct = new Set(["openai", "anthropic", "deepseek"]);
  const out = [];
  for (const g of catalogGroups) {
    for (const m of g.models || []) {
      if (m.reasoning) continue;                 // a thinking step is the thing being avoided
      if (!(m.outCost > 0)) continue;            // the free OpenRouter hosts are the slowest of all
      const keyed = m.provider === "openrouter" ? availCache.openrouter : m.provider === "openai" ? availCache.openai : m.provider === "deepseek" ? availCache.deepseek : m.provider === "anthropic" ? availCache.anthropic : true;
      if (keyed === false || !providerAllowedClient(mode, m.provider)) continue;
      out.push(m);
    }
  }
  // Direct providers first (no middleman hop), then cheapest, which in this catalog tracks with the
  // light, quick tiers. Returns [] on a box with no keys at all, and the caller has a plain-words
  // fallback for that rather than a dangling sentence.
  out.sort((a, b) => (direct.has(a.provider) ? 0 : 1) - (direct.has(b.provider) ? 0 : 1) || (a.outCost || 0) - (b.outCost || 0));
  return out.slice(0, 2).map((m) => m.name);
}

function paceMeasured(key) {
  const s = paceSamples[key];
  if (!s || !s.n || s.n < PACE_MIN_SAMPLES) return "";
  const secs = Math.round(s.avgMs / 1000);
  return "Measured on this device: your last " + s.n + " replies with these exact settings took about "
       + (secs >= 90 ? Math.round(secs / 60) + " minutes" : secs + " seconds") + " each.";
}

function renderPace() {
  if (!paceWarn) return;
  // Dismissed FOR GOOD, per setup (Fred, 2026-07-30: "on by default and it has not changed no
  // matter what the settings are"). The old sessionStorage dismissal resurrected the banner every
  // visit, which read as an unkillable nag. The ✕ now records the exact setup it was dismissed on
  // (model|mode|dial) in localStorage: that combination never warns again on this device, while a
  // DIFFERENT slow combination still gets its one honest warning.
  try {
    const dismissed = JSON.parse(localStorage.getItem("dominion.pace.dismissed.v2") || "{}");
    if (dismissed[paceKey(paceSetup())]) { paceWarn.hidden = true; paceWarn.innerHTML = ""; return; }
  } catch {}
  const s = paceSetup();
  const read = paceRead(s);
  if (!read.slow) { paceWarn.hidden = true; paceWarn.innerHTML = ""; paceOpen = false; return; }
  const fixes = [];
  if (s.mode !== "fast") fixes.push("choose <b>Fast</b> under Operating mode");
  const picks = paceQuickPicks();
  if (picks.length) fixes.push("pick a model that answers straight away, such as <b>" + picks.map(escapeHtml).join("</b> or <b>") + "</b>");
  else fixes.push("pick a lighter model from the <b>Model</b> list");
  if (s.tier === "furnace") fixes.push("turn the forge dial down to <b>Ember</b> or <b>Flame</b>");
  else if (s.tier === "flame") fixes.push("turn the forge dial down to <b>Ember</b>");
  const measured = paceMeasured(paceKey(s));
  paceWarn.hidden = false;
  paceWarn.innerHTML =
    '<button type="button" class="pace-line" id="pace-toggle" aria-expanded="' + (paceOpen ? "true" : "false") + '">' +
      '<span>SLOW SETTINGS · this reply will take a while. It is working the whole time.</span>' +
      '<span class="pace-caret">' + (paceOpen ? "hide" : "why?") + '</span>' +
    '</button>' +
    '<button type="button" id="pace-dismiss" title="Dismiss for these settings" aria-label="Dismiss the slow-settings warning for these settings" ' +
      'style="position:absolute;top:2px;right:4px;background:none;border:0;color:inherit;font-size:15px;line-height:1;cursor:pointer;padding:4px;opacity:.8">×</button>' +
    (paceOpen
      ? '<div class="pace-body">' +
          '<ul>' + read.why.map((w) => "<li>" + escapeHtml(w) + "</li>").join("") + '</ul>' +
          (fixes.length ? '<span class="pace-fix">To go faster: ' + fixes.join("; ") + ".</span>" : "") +
          (measured ? '<span class="pace-measured">' + escapeHtml(measured) + "</span>" : "") +
        '</div>'
      : "");
  paceWarn.style.position = "relative";   // anchor for the dismiss ✕
  const t = document.getElementById("pace-toggle");
  if (t) t.onclick = () => { paceOpen = !paceOpen; renderPace(); };
  const dx = document.getElementById("pace-dismiss");
  if (dx) dx.onclick = () => {
    try {
      const dismissed = JSON.parse(localStorage.getItem("dominion.pace.dismissed.v2") || "{}");
      dismissed[paceKey(paceSetup())] = 1;
      localStorage.setItem("dominion.pace.dismissed.v2", JSON.stringify(dismissed));
    } catch {}
    paceWarn.hidden = true; paceWarn.innerHTML = "";
  };
}

// Record what a finished turn actually cost in wall-clock, per exact setup. A rolling mean, capped
// so one pathological run cannot poison the average forever.
function paceRecord(key, ms) {
  if (!key || !(ms > 0) || ms > 30 * 60 * 1000) return;
  const s = paceSamples[key] || { n: 0, avgMs: 0 };
  s.avgMs = (s.avgMs * s.n + ms) / (s.n + 1);
  s.n = Math.min(s.n + 1, 20);
  paceSamples[key] = s;
  try { localStorage.setItem(LS_PACE, JSON.stringify(paceSamples)); } catch {}
}

if (modelSel) modelSel.addEventListener("change", renderPace);
// The lane control follows the model: switching to a seat without a fast tier hides it AND
// disarms it, so an armed switch can never survive onto a model that does not offer the lane.
if (modelSel) modelSel.addEventListener("change", paintFastLane);
document.addEventListener("DOMContentLoaded", () => {
  const fl = document.getElementById("fast-lane");
  if (fl) fl.addEventListener("click", () => setFastLane(!fastArmed));
  paintFastLane();
});
if (modeSel) modeSel.addEventListener("change", renderPace);
if (privacyModeSel) privacyModeSel.addEventListener("change", renderPace);
document.addEventListener("dominion-forge-tier", renderPace);   // the dial fires this on every turn of it

// ---------- attachments (pictures + text files) ----------
// Staged in pendingAtt, sent as an OPTIONAL `attachments` field on the user message; content stays
// a plain string so history, search, titles, and every server subsystem keep working unchanged.
// Pictures are downscaled ON THE PHONE (long edge 1568px) so a 12MP camera shot becomes a few
// hundred KB, and only vision-badged models may receive them (the server enforces the same gate).
const ATT_MAX_IMAGES = 4, ATT_MAX_TEXTS = 4, ATT_MAX_TEXT_BYTES = 200 * 1024, ATT_IMG_EDGE = 1568;
const ATT_TEXT_EXT = /\.(txt|md|markdown|csv|json|log|xml|yaml|yml|html|css|js|mjs|ts|py|sql|sh|ps1)$/i;
const ATT_DOC_EXT = /\.(pdf|docx|xlsx)$/i;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// PDFs and Word docs extract to text ON THE DEVICE (lazy-loaded module + vendored pdf.js),
// then ride the same {kind:"text"} wire as any pasted file — which is why they work with
// every model, local included, and never add binary parsing to the server.
let extractMod = null, pdfjsLib = null;
function attStatus(msg) {   // transient progress line above the composer (OCR can take ~10-20s)
  if (!attachWarn) return;
  if (msg) { attachWarn.hidden = false; attachWarn.textContent = msg; }
  else updateAttachGate();
}
// One wire for both OCR callers (scanned-PDF pages and photographed documents).
async function postOcr(pages, name, source) {
  const resp = await fetch("/api/ocr", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, pages, source, privacyMode: privacyModeSel ? privacyModeSel.value : "normal" }) });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || j.error) throw new Error(j.error || "OCR failed");
  return j;
}
// "Read text instead": staged pictures transcribe via /api/ocr and become a text attachment,
// so a photo of a document reaches models that can't see pixels. Never automatic — the user
// taps it from the vision-gate warning, because on a vision model real pixels beat OCR.
let ocrBusy = false;
async function ocrPendingImages() {
  const targetChatId = curId;
  const target = chats.find((c) => c.id === targetChatId);
  const imgs = chatPendingAttachments(target).filter((a) => a.kind === "image" && a.dataUrl);
  if (!imgs.length || ocrBusy) return;
  ocrBusy = true; if (attachBtn) attachBtn.classList.add("busy");
  attStatus("Reading " + imgs.length + " picture" + (imgs.length === 1 ? "" : "s") + " with OCR… (~" + Math.max(5, imgs.length * 2) + "s)");
  try {
    const j = await postOcr(imgs.map((a) => a.dataUrl), imgs[0].name || "photo", "photo");
    const source = new Set(imgs);
    const liveTarget = chats.find((c) => c.id === targetChatId);
    const current = chatPendingAttachments(liveTarget);
    // A removal while OCR was running wins; never resurrect an attachment the user discarded.
    if (liveTarget && current.some((a) => source.has(a))) {
      const next = current.filter((a) => !source.has(a));
      const base = imgs.length === 1 ? (imgs[0].name || "photo").replace(/\.[a-z0-9]+$/i, "") : imgs.length + " pictures";
      next.push({ kind: "text", name: (base + " — transcribed").slice(0, 120), text: j.text });
      setChatPendingAttachments(liveTarget, next);
    }
    attStatus("");
  } catch (e) {
    attStatus("");
    if (targetChatId === curId) {
      attachWarn.hidden = false; attachWarn.textContent = "OCR: " + ((e && e.message) || "failed");
      setTimeout(updateAttachGate, 6000);
    }
  } finally { ocrBusy = false; if (attachBtn) attachBtn.classList.remove("busy"); }
}
async function extractDocFile(f) {
  if (!("DecompressionStream" in window)) throw new Error("this browser can't unpack documents; paste the text instead");
  extractMod ||= await import("/attach-extract.mjs?v=2");
  const buf = await f.arrayBuffer();
  if (f.type === XLSX_MIME || /\.xlsx$/i.test(f.name || "")) {
    const r = await extractMod.extractXlsx(buf, { maxChars: ATT_MAX_TEXT_BYTES });
    return { kind: "text", name: (f.name || "sheet.xlsx").slice(0, 120), text: r.text };
  }
  if (f.type === "application/pdf" || /\.pdf$/i.test(f.name || "")) {
    pdfjsLib ||= await extractMod.loadPdfjsBrowser();
    try {
      const r = await extractMod.extractPdf(buf, pdfjsLib, { maxChars: ATT_MAX_TEXT_BYTES });
      return { kind: "text", name: (f.name || "document.pdf").slice(0, 120), text: r.text };
    } catch (e) {
      if (!/scanned or image-only/.test((e && e.message) || "")) throw e;
      // Scanned PDF: render pages on the device, let the server's vision OCR transcribe them,
      // and the text comes back to ride the normal wire (works with every model afterward).
      attStatus("Scanned PDF — rendering pages for OCR…");
      const rp = await extractMod.renderPdfPages(buf, pdfjsLib, { maxPages: 12 });
      attStatus("Reading " + rp.rendered + (rp.total > rp.rendered ? " of " + rp.total : "") + " page(s) with OCR… (~" + Math.max(5, rp.rendered * 2) + "s)");
      let j;
      try { j = await postOcr(rp.pages, f.name || "document.pdf", "pdf"); }
      finally { attStatus(""); }
      let text = j.text;
      if (rp.total > rp.rendered) text += "\n\n(Only the first " + rp.rendered + " of " + rp.total + " pages were transcribed — the OCR cap.)";
      return { kind: "text", name: (f.name || "document.pdf").slice(0, 120), text };
    }
  }
  const r = await extractMod.extractDocx(buf, { maxChars: ATT_MAX_TEXT_BYTES });
  return { kind: "text", name: (f.name || "document.docx").slice(0, 120), text: r.text };
}
const attImages = (attachments = pendingAtt) => attachments.filter((a) => a.kind === "image").length;
const attTexts = (attachments = pendingAtt) => attachments.filter((a) => a.kind === "text").length;
const usablePendingAttachment = (a) => !!(a && (
  (a.kind === "image" && a.dataUrl) ||
  (a.kind === "text" && typeof a.text === "string" && a.text.length)
));

// Current model's vision capability: cloud models per the live catalog flag; local has none.
function modelSeesImages() {
  const v = modelSel ? modelSel.value : "local";
  if (!v || v === "local" || !isCloudModel(v)) return false;
  const m = findCatalogModel(v);
  return !!(m && m.vision);
}

async function downscaleImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, ATT_IMG_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    // Screenshots keep PNG crispness when small enough; photos go JPEG. GIFs lose animation
    // by design (models see a single frame anyway).
    let dataUrl = "";
    if (file.type === "image/png") { const png = cv.toDataURL("image/png"); if (png.length < 1.25 * 1024 * 1024) dataUrl = png; }
    if (!dataUrl) dataUrl = cv.toDataURL("image/jpeg", 0.85);
    const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
    return { kind: "image", name: (file.name || "picture").slice(0, 120), mime, dataUrl };
  } catch { return null; }
}

function readTextFile(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => { const text = String(r.result || "").slice(0, ATT_MAX_TEXT_BYTES); resolve(text.trim() ? { kind: "text", name: (file.name || "file.txt").slice(0, 120), text } : null); };
    r.onerror = () => resolve(null);
    r.readAsText(file.slice(0, ATT_MAX_TEXT_BYTES));
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []); if (!files.length) return;
  const targetChatId = curId;
  if (!chats.some((c) => c.id === targetChatId)) return;
  let rejected = [];
  const hasSlot = (kind, max) => {
    const c = chats.find((x) => x.id === targetChatId);
    const staged = chatPendingAttachments(c);
    return !!c && (kind === "image" ? attImages(staged) : attTexts(staged)) < max;
  };
  const stage = (a, kind, max, fullMessage) => {
    const c = chats.find((x) => x.id === targetChatId);
    if (!c) return false;
    const staged = chatPendingAttachments(c);
    if ((kind === "image" ? attImages(staged) : attTexts(staged)) >= max) {
      rejected.push(fullMessage);
      return false;
    }
    return setChatPendingAttachments(c, [...staged, a]);
  };
  if (attachBtn) attachBtn.classList.add("busy");   // PDF extraction on a phone can take a couple seconds
  try {
    for (const f of files) {
      if (f.type && f.type.startsWith("image/")) {
        const fullMessage = f.name + " (max " + ATT_MAX_IMAGES + " pictures)";
        if (!hasSlot("image", ATT_MAX_IMAGES)) { rejected.push(fullMessage); continue; }
        const a = await downscaleImage(f);
        if (a) stage(a, "image", ATT_MAX_IMAGES, fullMessage);
        else rejected.push((f.name || "picture") + " (couldn't read it)");
      } else if (f.type === "application/pdf" || f.type === DOCX_MIME || ATT_DOC_EXT.test(f.name || "")) {
        const fullMessage = f.name + " (max " + ATT_MAX_TEXTS + " files)";
        if (!hasSlot("text", ATT_MAX_TEXTS)) { rejected.push(fullMessage); continue; }
        try { stage(await extractDocFile(f), "text", ATT_MAX_TEXTS, fullMessage); }
        catch (e) { rejected.push((f.name || "document") + " (" + ((e && e.message) || "couldn't read it") + ")"); }
      } else if (/\.(doc|xls)$/i.test(f.name || "")) {
        rejected.push(f.name + (/\.doc$/i.test(f.name) ? " (old .doc format; save it as .docx first)" : " (old .xls format; save it as .xlsx first)"));
      } else if ((f.type && f.type.startsWith("text/")) || f.type === "application/json" || ATT_TEXT_EXT.test(f.name || "")) {
        const fullMessage = f.name + " (max " + ATT_MAX_TEXTS + " files)";
        if (!hasSlot("text", ATT_MAX_TEXTS)) { rejected.push(fullMessage); continue; }
        const a = await readTextFile(f);
        if (a) stage(a, "text", ATT_MAX_TEXTS, fullMessage);
        else rejected.push((f.name || "file") + " (empty or unreadable)");
      } else {
        rejected.push((f.name || "file") + " (pictures, PDFs, Word .docx, Excel .xlsx, and text files only)");
      }
    }
  } finally { if (attachBtn) attachBtn.classList.remove("busy"); }
  if (targetChatId === curId) {
    renderAttachStrip();
    if (rejected.length) { attachWarn.hidden = false; attachWarn.textContent = "Skipped: " + rejected.join(", "); setTimeout(updateAttachGate, 4000); }
    updateEstimate();
  }
}

function removeAttachment(i) {
  const c = cur();
  if (!c) return;
  const staged = chatPendingAttachments(c);
  if (i < 0 || i >= staged.length) return;
  setChatPendingAttachments(c, staged.filter((_, n) => n !== i));
}

function renderAttachStrip() {
  if (!attachStrip) return;
  attachStrip.innerHTML = "";
  attachStrip.hidden = pendingAtt.length === 0;
  pendingAtt.forEach((a, i) => {
    const cell = document.createElement("div"); cell.className = "att-cell";
    if (a.kind === "image" && a.dataUrl) {
      const img = document.createElement("img"); img.src = a.dataUrl; img.alt = a.name; img.title = a.name;
      img.onclick = () => openImageFull(a.dataUrl);
      cell.appendChild(img);
    } else {
      const available = usablePendingAttachment(a);
      const chip = document.createElement("span"); chip.className = "att-file";
      chip.textContent = (available ? "📄 " : "⚠ ") + a.name;
      chip.title = available ? a.name : a.name + " is no longer stored on this device; remove and re-attach it";
      cell.appendChild(chip);
    }
    const x = document.createElement("button"); x.className = "att-x"; x.textContent = "×"; x.title = "Remove"; x.setAttribute("aria-label", "Remove " + a.name);
    x.onclick = () => removeAttachment(i);
    cell.appendChild(x);
    attachStrip.appendChild(cell);
  });
  updateAttachGate();
}

// The honest gate, mirrored from the server: pictures need a vision-badged model. Never swaps the
// model, never silently drops the picture — it says so, and offers the one real fix that doesn't
// change the user's model pick: transcribing the picture to text ("Read text instead"). Since
// Private became the Anthropic-direct lane (2026-07-30), OCR and vision both work there too, so
// no mode needs a special buttonless message any more.
function attachSendBlocked(attachments = pendingAtt) {
  return attachments.some((a) => !usablePendingAttachment(a)) || (attImages(attachments) > 0 && !modelSeesImages());
}
function updateAttachGate() {
  if (!attachWarn) return;
  const unavailable = pendingAtt.filter((a) => !usablePendingAttachment(a));
  if (unavailable.length) {
    attachWarn.hidden = false;
    attachWarn.textContent = "A staged attachment is no longer stored on this device. Remove it and attach the file again before sending.";
  } else if (attachSendBlocked()) {
    attachWarn.hidden = false;
    attachWarn.replaceChildren();
    const span = document.createElement("span");
    span.textContent = "This model can't view pictures — pick one with the 👁 badge, remove it, or transcribe it: ";
    attachWarn.appendChild(span);
    {
      const b = document.createElement("button");
      b.type = "button"; b.className = "att-ocr"; b.textContent = "Read text instead";
      b.title = "Transcribe the picture(s) with OCR so this model can read them";
      b.onclick = ocrPendingImages;
      attachWarn.appendChild(b);
    }
  } else { attachWarn.hidden = true; attachWarn.replaceChildren(); }
}

// Chrome blocks top-frame data: navigation; a Blob URL opens fine in a new tab.
function openImageFull(dataUrl) {
  try {
    const [head, b64] = dataUrl.split(",");
    const mime = head.slice(5, head.indexOf(";"));
    const bin = atob(b64); const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    window.open(URL.createObjectURL(new Blob([buf], { type: mime })), "_blank");
  } catch {}
}

// ---------- agent loop over SSE ----------
// The Send/Stop button reflects the CHAT ON SCREEN: it shows Stop only while THIS chat has a live
// run. Background chats keep streaming; their state shows as a sidebar dot, not this button.
function syncComposer() {
  const on = busyFor(curId);
  sendBtn.classList.toggle("stop", on); sendBtn.innerHTML = on ? "&#9632;" : "&#8593;"; sendBtn.title = on ? "Stop" : "Send";
  if (on && typeof hideCostChip === "function") hideCostChip();
}

// ---- durable live turn (suspend/resume + long runs + concurrency) ----
// The server buffers every /chat turn as a JOB ({type:"job"} is the first SSE event) and keeps
// generating even if this socket dies (phone switched apps), for as long as the run takes — the
// durable store means it even survives a server restart. `liveJobs[chatId]` (persisted) tracks each
// in-flight run; `liveJob` points at whichever one the ON-SCREEN reader is currently consuming.
// When the stream drops we reattach via GET /chat/attach?job=<id>&from=<eventIndex> and catch up —
// mid-stream into the same bubble, straight to the finished answer, or (after a restart) into the
// preserved partial + a Continue affordance. Stop is a server call. Only the on-screen chat gets a
// streaming DOM bubble; background runs are merged when you open them or on the next reconcile.
let liveJob = null;        // pointer into liveJobs[...] for the on-screen reader (or null)
let liveSession = null;    // UI + parser state for the on-screen in-flight turn (null when detached/idle)
let readerActive = false;  // an SSE reader (original or reattach) is currently consuming
let reattachTimer = null, reattachTries = 0;
// Tear down the on-screen streaming session WITHOUT stopping the server job (used on chat switch):
// abort the local reader, drop the DOM session, but leave liveJobs[...] intact so the run is picked
// back up on return. The AbortError this triggers is recognized as a detach, not a stop.
function detachCurrentSession() {
  if (reattachTimer) { clearTimeout(reattachTimer); reattachTimer = null; }
  reattachTries = 0;
  if (liveSession) liveSession.detached = true;
  try { if (aborter) aborter.abort(); } catch {}
  liveSession = null; liveJob = null; readerActive = false;
}
const collectJob = (jobId) => { if (jobId) fetch("/chat/collect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId }) }).catch(() => {}); };
// Jobs whose result we've already merged into local history THIS session. Guards the narrow window
// where an on-screen finalize and a boot reconcile both race to deliver the same run before the
// server-side `collected` flag becomes visible; across reloads the `collected` flag itself guards.
const mergedJobs = new Set();

// One in-progress AI bubble + all per-turn parser state. Used by BOTH the original /chat stream
// and any /chat/attach reattach — the same session keeps accumulating into the same bubble.
function newSession(c) {
  document.querySelector(".err")?.remove();
  empty.style.display = "none";
  const row = document.createElement("div"); row.className = "turn";
  const inner = document.createElement("div"); inner.className = "msg ai";
  const tools = document.createElement("div"); tools.className = "tools";
  const live = document.createElement("div"); live.className = "bubble think cursor"; live.textContent = "Dominion AI is working…";
  inner.append(tools, live); row.appendChild(inner);
  const eraTurns = wrap.querySelector(".model-era:last-of-type .model-era-turns");
  (eraTurns || wrap).appendChild(row); scroll();
  const st = { c, inner, tools, live, chips: [], raw: "", ctxEl: null, ctxItems: null, doneMeta: null,
               mentorCritique: null, done: false, stopped: false, gone: false, errMsg: "", warm: 0,
               checkpoint: null, stopReason: "",
               jobId: "", detached: false, modelId: stampedModelId(c),
               // Wall-clock for the pace warning: the only duration it will ever quote is one
               // measured here, on this device, for this exact model/mode/dial combination.
               startedAt: Date.now(), paceKey: paceKey(paceSetup()) };
  st.warm = setTimeout(() => { if (live.classList.contains("think")) { live.textContent = "Dominion AI is working… (first reply can take ~20s)"; scroll(); } }, 6000);
  return st;
}

// THE event dispatcher — every SSE event (original stream AND reattach replay/tail) goes through
// here exactly once. Replayed token deltas re-concatenate into st.raw, so a from=0 replay after an
// app reload reconstitutes the partial text.
function processEvent(st, ev) {
  const { inner, tools, live, chips } = st;
  if (ev.type === "job") {
    st.jobId = ev.id;
    liveJobs[st.c.id] = liveJob = { jobId: ev.id, eventIndex: 0, modelId: st.modelId }; persistLiveJobs();
    renderSidebar();   // show the running dot the moment the job id lands
  } else if (ev.type === "reset") {
    // Server is about to re-send this turn from scratch (the resume cursor fell off its RAM tail, or
    // it's a post-restart DB replay): wipe the partial bubble so the replayed events rebuild it
    // cleanly with no duplicated text.
    st.raw = ""; chips.length = 0; tools.innerHTML = "";
    if (st.ctxEl) { st.ctxEl.remove(); st.ctxEl = null; st.ctxItems = null; }
    live.classList.add("think"); live.textContent = "Dominion AI is working…";
  } else if (ev.type === "cursor") {
    // Authoritative resume index after a compacted replay — adopt it absolutely so the live-tail
    // that follows lines up (readSse skips its usual ++ for this event).
    if (liveJob) { liveJob.eventIndex = ev.seq | 0; persistLiveJobs(); }
  } else if (ev.type === "route") {
    // Model/mode intentionally NOT shown — the in-progress bubble just says "Dominion AI is working".
  } else if (ev.type === "context") {
    // F4: keep the per-item detail the server sends (it was previously discarded).
    st.ctxItems = { memory: ev.items || [], artifacts: ev.artifactItems || [], chats: ev.chatItems || [] };
    if (!st.ctxEl) { st.ctxEl = document.createElement("div"); st.ctxEl.className = "ctx"; inner.insertBefore(st.ctxEl, tools); }
    const bits = [];
    if (ev.memory) bits.push("🧠 " + ev.memory + " memor" + (ev.memory === 1 ? "y" : "ies"));
    if (ev.artifacts) bits.push("📄 " + ev.artifacts + " artifact" + (ev.artifacts === 1 ? "" : "s"));
    if (ev.chats) bits.push("💬 " + ev.chats + " past chat" + (ev.chats === 1 ? "" : "s"));
    st.ctxEl.textContent = bits.join(" · ");
    scroll();
  } else if (ev.type === "wildfire") {
    /*
     * Wildfire feedback. Three shapes, all deliberately visible:
     *   blocked  armed on a model that is not on the roster, so it refused to arm
     *   denied   a non-owner tried (the server logs this as a denial too)
     *   nudge    a starred model, machine work asked for, and Wildfire left off
     */
    const note = document.createElement("div");
    note.className = "ctx wildfire-note wildfire-" + (ev.kind || "note");
    note.textContent = (ev.kind === "nudge" ? "🔥 " : "⚠ ") + (ev.text || "");
    inner.insertBefore(note, tools);
    scroll();
  } else if (ev.type === "disarmed") {
    /*
     * The turn asked for machine work while something had already removed the tools. This exists
     * because "As Fred" mode sat in the dropdown for weeks, silently stripping tools from every
     * turn on every device, and the app never once said so. A setting that takes away the app's
     * hands has to admit it at the exact moment you reach for them.
     */
    const note = document.createElement("div");
    note.className = "ctx wildfire-note wildfire-blocked";
    note.textContent = "⚠ " + (ev.text || "");
    inner.insertBefore(note, tools);
    scroll();
  } else if (ev.type === "tools_capped") {
    // The 128-tool ceiling silently shed connector tools for months. Never again silently.
    // The headline stays in plain sight; the raw tool identifiers fold behind a tap so a list
    // of internal names cannot bury the actual reply on a phone screen.
    const note = document.createElement("div");
    note.className = "ctx tools-capped";
    const head = document.createElement("div");
    head.textContent = "⚠ " + (ev.text || "");
    note.appendChild(head);
    if (ev.names && ev.names.length) {
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = "which tools were dropped (" + ev.names.length + ")";
      const list = document.createElement("div");
      list.className = "capped-names";
      list.textContent = ev.names.join(", ");
      det.append(sum, list);
      note.appendChild(det);
    }
    inner.insertBefore(note, tools);
    scroll();
  } else if (ev.type === "tools_unavailable") {
    // The worst failure mode: a normal-looking answer that touched nothing. Badge it loudly.
    const note = document.createElement("div");
    note.className = "ctx tools-unavailable";
    note.textContent = "⚠ " + (ev.text || "");
    inner.insertBefore(note, tools);
    scroll();
  } else if (ev.type === "battalion_detour") {
    // The swarm has no hands; real work was handed to a tool-capable engine, and the user is told.
    const note = document.createElement("div");
    note.className = "ctx wildfire-note";
    note.textContent = "⚔ " + (ev.text || "");
    inner.insertBefore(note, tools);
    scroll();
  } else if (ev.type === "mentor_full") {
    st.mentorCritique = ev.critique || null;
  } else if (ev.type === "done") {
    st.done = true; st.doneMeta = ev.meta || null;
  } else if (ev.type === "checkpoint") {
    st.checkpoint = ev;
    const note = document.createElement("div");
    note.className = "ctx";
    note.textContent = "⏸ Saved checkpoint · task unfinished" + (ev.nextAction ? " · next: " + ev.nextAction : "");
    inner.insertBefore(note, tools);
    scroll();
  } else if (ev.type === "stopped") {
    st.stopped = true;
    st.stopReason = ev.reason || "";
  } else if (ev.type === "gone") {
    st.gone = true;      // the job expired server-side — say so honestly, never a silent retry
  } else if (ev.type === "artifact") {
    const note = document.createElement("div"); note.className = "ctx"; note.style.cursor = "pointer";
    note.textContent = "📄 saved artifact: " + ev.title + " (tap to open)";
    note.onclick = () => { openArtifacts(); openArtifact(ev.id); };
    inner.insertBefore(note, tools); scroll();
  } else if (ev.type === "file") {
    // A document the turn produced. It arrives as a real download control rather than as a link
    // the model might forget to write, and it is recorded on the message so it survives a reload.
    st.files = st.files || [];
    if (!st.files.some((f) => f.url === ev.url)) st.files.push({ name: ev.name, url: ev.url });
    inner.insertBefore(fileChip({ name: ev.name, url: ev.url }), tools); scroll();
  } else if (ev.type === "mentor") {
    const note = document.createElement("div"); note.className = "ctx";
    note.textContent = "🎓 mentor: " + ev.score + "/10" + (ev.priority && ev.priority !== "none" ? " · revise " + ev.priority : "") + (ev.findings ? " · " + ev.findings + " finding(s)" : "");
    inner.insertBefore(note, tools); scroll();
  } else if (ev.type === "tool") {
    if (ev.status === "run") {
      /*
       * PROGRESS IN CHAT IS INFORMATIONAL ONLY (Fred, 2026-07-24). Every running tool used to
       * carry its permission class beside it, so a normal turn printed "dangerous" in red next to
       * the work it was doing and read as an alarm going off. It was never a warning to the user
       * in the first place: the class drives the server's confirm gate, and the real caution the
       * user needs is already on the section headers in the model dropdown, which stay. So the
       * class badge and the padlock are gone from the stream. The confirm prompt still appears
       * when a tool genuinely needs approval, and the outcome marks (done, failed, blocked,
       * skipped) stay, because those are facts about what happened.
       */
      const chip = document.createElement("div"); chip.className = "tool";
      chip.innerHTML = '<span class="sp"></span>'; const lab = document.createElement("span"); lab.textContent = "🔧 " + ev.name + "…"; chip.appendChild(lab);
      chip._runId = ev.runId; chip._name = ev.name; chip._lab = lab; tools.appendChild(chip); chips.push(chip); scroll();
    } else {
      const chip = [...chips].reverse().find((x) => (ev.runId ? x._runId === ev.runId : x._name === ev.name) && !x._done);
      if (chip) {
        chip._done = true; const sp = chip.querySelector(".sp"); if (sp) sp.remove();
        if (ev.status === "done") { chip.classList.add("done"); chip._lab.textContent = "✓ " + ev.name; }
        else if (ev.status === "failed") { chip.classList.add("failed"); chip._lab.textContent = "✗ " + ev.name; }
        else if (ev.status === "blocked") { chip.classList.add("blocked"); chip._lab.textContent = "⛔ " + ev.name + " — blocked"; }
        else if (ev.status === "cancelled") { chip.classList.add("cancelled"); chip._lab.textContent = "⃠ " + ev.name + " — skipped"; }
      }
    }
  } else if (ev.type === "tool_confirm") {
    const box = document.createElement("div"); box.className = "confirm";
    // The question names the tool and shows what it would do. The permission class was internal
    // vocabulary ("requires_confirmation") that told the user nothing they could act on.
    const q = document.createElement("div"); q.className = "cq"; q.textContent = "Run " + ev.name + "?" + (ev.preview ? "  " + ev.preview : "");
    const btns = document.createElement("div"); btns.className = "cbtns";
    const yes = document.createElement("button"); yes.className = "yes"; yes.textContent = "Approve";
    const no = document.createElement("button"); no.textContent = "Deny";
    const decide = (approved) => { yes.disabled = no.disabled = true; box.remove(); fetch("/tool-confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: ev.runId, approved }) }).catch(() => {}); };
    yes.onclick = () => decide(true); no.onclick = () => decide(false);
    btns.append(yes, no); box.append(q, btns); tools.appendChild(box); scroll();
  } else if (ev.type === "working") {
    // Server heartbeat while the model grinds — keeps the bubble alive instead of dead air.
    // Never names models; phases: reading context / thinking / writing / running tools.
    if (!stripThink(st.raw)) { clearTimeout(st.warm); live.textContent = "Dominion AI is working — " + (ev.phase || "thinking") + "… " + (ev.elapsed != null ? ev.elapsed + "s" : ""); scroll(); }
  } else if (ev.type === "token") {
    st.raw += ev.delta || ""; const shown = stripThink(st.raw); live.classList.toggle("think", !shown); live.textContent = shown || "Dominion AI is working…"; scroll();
  } else if (ev.type === "budget") {
    // Session budget lifecycle (Fred, 2026-07-25). "state" repaints the black budget window;
    // shortfall/clamped/over raise the big blurred popup with the fully transparent message.
    if (ev.event === "state") {
      const old = budgetByChat[st.c.id];
      budgetByChat[st.c.id] = { budget: ev.budget, spent: ev.spent, remaining: ev.remaining, unit: ev.unit, available: old && old.available };
      if (st.c.id === curId) {
        renderBudget();
        if (ev.over) openBudgetModal("This session has reached its budget. Raise it to continue exactly where you left off.", { raise: true });
      }
    }
    else if (ev.event === "shortfall" || ev.event === "clamped") {
      fetchBudget(st.c.id);
      if (st.c.id === curId) openBudgetModal(ev.message || "Session budget adjusted.", { credits: true });
    }
  } else if (ev.type === "error") {
    // Gate refusals (access code / credits) carry a human message and send the user to Setup —
    // never swallow them into a generic "server error".
    st.gateCode = (ev.code === "needs_invite" || ev.code === "needs_credits") ? ev.code : "";
    if (ev.code === "budget_exhausted") {
      fetchBudget(st.c.id);
      if (st.c.id === curId) openBudgetModal(ev.message || "This session's budget is spent.", { raise: true, credits: ev.balance !== undefined });
    }
    st.errMsg = ev.message || (ev.code === "privacy_mode_block"
      ? "Blocked by privacy mode."
      : "Chat failed: " + (ev.error || "server error") + " — tap send to retry.");
  }
}

// Shared SSE reader: parses the stream, dispatches each event once, and keeps liveJob.eventIndex
// exact (it's the resume cursor for /chat/attach?from=). localStorage writes are throttled — the
// in-memory index is what mid-session reattaches use; a reload always replays from 0.
async function readSse(res, st) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop() || "";
    for (const line of lines) {
      const s = line.trim(); if (!s.startsWith("data:")) continue;
      let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }
      processEvent(st, ev);
      // `cursor` sets the resume index absolutely (handled in processEvent); every other buffered
      // event advances it by one. `reset`/`cursor` are attach-only framing, never in the RAM buffer,
      // so they don't count toward the index.
      if (liveJob && liveJob.jobId && ev.type !== "cursor" && ev.type !== "reset") {
        liveJob.eventIndex++;
        if (ev.type !== "token" || liveJob.eventIndex % 25 === 0) persistLiveJobs();
      }
    }
  }
}

// The single end-of-turn: persist the message (full or honestly-interrupted partial), clear the
// live-job cursor, restore the composer, and show any error/critique. Used by every path.
function finalizeSession(st) {
  clearTimeout(st.warm);
  if (reattachTimer) { clearTimeout(reattachTimer); reattachTimer = null; }
  reattachTries = 0;
  const c = st.c, final = stripThink(st.raw);
  // Only a turn that RAN TO COMPLETION teaches anything about pace. A stop, a network drop or a
  // reattach after an app reload would each record a duration that means something else.
  if (st.done && st.startedAt && !st.detached) { paceRecord(st.paceKey, Date.now() - st.startedAt); renderPace(); }
  if (st.done) {
    const msg = { role: "assistant", content: final || "(no response)", modelId: st.modelId || stampedModelId(c) };
    if (st.doneMeta) { msg.meta = st.doneMeta; if (st.ctxItems) msg.meta.contextItems = st.ctxItems; if (st.doneMeta.mode) c.lastMode = st.doneMeta.mode; }
    // Produced documents belong to the message, so the download survives a reload and a device hop.
    if (st.files && st.files.length) { msg.meta = msg.meta || {}; msg.meta.files = st.files; }
    c.messages.push(msg); c.activityAt = touchChatComponent(c, "transcriptUpdatedAt"); save();
    if (speakOn && final) speakAnswer(final);   // voice: read the finished answer aloud (toggle)
  } else if (final) {
    c.messages.push({
      role: "assistant", content: final, modelId: st.modelId || stampedModelId(c),
      meta: st.checkpoint
        ? { interrupted: true, checkpoint: st.checkpoint, stopReason: st.stopReason || st.checkpoint.state || "", jobId: st.jobId || "" }
        : { interrupted: true, stopReason: st.stopReason || "", jobId: st.jobId || "" },
    });
    c.activityAt = touchChatComponent(c, "transcriptUpdatedAt"); save();
  } else if (st.errMsg) {
    // Nothing ever came back (e.g. "Failed to fetch") — the composer was already cleared when the
    // turn was sent, so "tap send to retry" would otherwise hit an empty box and do nothing. Pull
    // the unanswered question back out of history and into the composer so retry actually works.
    const last = c.messages[c.messages.length - 1];
    if (last && last.role === "user") {
      const at = Date.now();
      c.messages.pop();
      c.draft = last.content;
      c.pendingAttachments = Array.isArray(last.attachments)
        ? last.attachments.filter(usablePendingAttachment) : [];
      touchChatComponent(c, "transcriptUpdatedAt", at);
      c.activityAt = touchChatComponent(c, "draftUpdatedAt", at);
      save();
      // A background chat can fail after the user has switched away. Restore its own durable
      // composer state without overwriting the text or attachment strip of the chat now on screen.
      if (c.id === curId) {
        input.value = c.draft;
        pendingAtt = c.pendingAttachments;
        renderAttachStrip();
        autosize();
      }
    }
  }
  // Clear this chat's live-job entry and tell the server we've merged the result (starts the
  // collected-retention clock; also the idempotency guard against a reconcile re-delivering it).
  const finishedJobId = st.jobId || (liveJobs[c.id] && liveJobs[c.id].jobId) || "";
  delete liveJobs[c.id]; persistLiveJobs();
  if ((st.done || st.stopped || st.gone) && finishedJobId) { mergedJobs.add(finishedJobId); collectJob(finishedJobId); }
  if (liveSession === st) { liveSession = null; liveJob = null; }
  aborter = null; renderAll();
  if (st.errMsg) showErr(st.errMsg);
  // Access-code / credits gate: show the message, then take them to the Setup page that fixes it.
  if (st.gateCode) setTimeout(() => { location.href = "/setup"; }, 2500);
  if (st.mentorCritique) {   // Mentor mode: show the critique card under the fresh answer
    const card = document.createElement("div"); card.className = "critique";
    renderCritiqueCard(card, st.mentorCritique, (c.messages.filter((m) => m.role === "user").slice(-1)[0] || {}).content || "", final);
    wrap.appendChild(card); scroll();
  }
}

let RESUME_JOB = "";   // set by the Continue button, consumed by exactly one send
function resumeInterruptedRun(jobId) {
  if (busyFor(curId)) { showErr("A run is already in flight in this chat — let it finish or stop it first."); return; }
  RESUME_JOB = String(jobId || "");
  input.value = "Continue the interrupted run exactly where it left off. Do not redo work that already succeeded; verify current state, complete what remains, and finish properly.";
  send();
}

async function streamReply(c) {
  const st = liveSession = newSession(c);
  const wildfireForTurn = !!(window.wildfireValue && window.wildfireValue());
  // Provisional entry so THIS chat reads as busy the instant we send, before the job id arrives
  // (the real jobId fills in on the {type:"job"} event). Keeps a double-tap from firing two turns.
  liveJobs[c.id] = liveJob = { jobId: "", eventIndex: 0, modelId: st.modelId }; persistLiveJobs();
  syncComposer(); aborter = new AbortController();
  let netErr = "";
  readerActive = true;
  try {
    const res = await fetch("/chat", {
      method: "POST", headers: { "content-type": "application/json" }, signal: aborter.signal,
      body: JSON.stringify({
        messages: c.messages.map((m) => (m.attachments && m.attachments.length
          ? { role: m.role, content: m.content, attachments: m.attachments }
          : { role: m.role, content: m.content })),
        mode: modeSel ? modeSel.value : "auto",
        // Never "local", and "auto" only as a last resort before the catalog has loaded: the
        // server's auto-routing may still know the local lane, but the app no longer offers it.
        model: (st.modelId && st.modelId !== "local" && st.modelId !== "auto") ? st.modelId : (defaultCloudModel() || "auto"),
        privacyMode: privacyModeSel ? privacyModeSel.value : "normal",
        persona: resolvePersona(),
        // FAST LANE, one turn only. The switch disarms itself after every send, because it doubles
        // the price of the turn, and a control somebody flipped last Tuesday and forgot is exactly
        // the shape of a bill nobody expected. The server re-checks the catalog regardless, so
        // this can only ever ask for the fast lane, never decide it.
        ...(fastLaneArmed() ? { fast: true } : {}),
        temperature: settings.temperature,
        confirmTools: !!settings.confirmTools,
        chatId: c.id,
        // Resume of an interrupted run: the server pulls that job's verified progress into
        // context so the model continues instead of starting over. One-shot, cleared below.
        ...(RESUME_JOB ? { resumeFromJob: RESUME_JOB } : {}),
        // The dial controls reasoning effort. The side switch independently engages Forge Mode's
        // special tool/agent logic; neither control impersonates the other.
        // Send effort ONLY when raised above Ember: the server treats an explicit wolfeTier as final
        // (server.mjs ~2583), so sending "ember" every turn would suppress the automatic depth boost
        // that As-Fred / Deep-Think / Long-Context modes get. Omitting it at Ember lets those escalate
        // as before, while Flame/Furnace still override deliberately.
        ...((window.forgeTierValue && window.forgeTierValue() !== "ember") ? { wolfeTier: window.forgeTierValue() } : {}),
        ...(window.forgeModeValue && window.forgeModeValue() ? { forgeMode: true } : {}),
        // Wildfire: broad authority for this turn. Sent only when actually armed, so an unarmed
        // turn stays byte-identical to before (same reasoning as wolfeTier omitting "ember").
        ...(wildfireForTurn ? { wildfire: true } : {}),
      }),
    });
    RESUME_JOB = "";   // one-shot: the resume context belongs to exactly this send
    // The fast lane is one-shot for the same reason Wildfire is: a per-turn decision that costs
    // double must never carry silently into the next message.
    setFastLane(false);
    // Wildfire is a one-turn override. The ordinary toolbox now expands only as needed and closes
    // automatically; broad up-front authority must never leak into the next unrelated message.
    if (wildfireForTurn && window.setWildfire) window.setWildfire(false);
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    await readSse(res, st);
  } catch (e) {
    if (st.detached) return;   // switched away mid-stream: the run lives on server-side, we just let go
    if (e.name === "AbortError") st.stopped = true;   // legacy local stop (no jobId had arrived yet)
    else netErr = e.message || "network error";
  } finally { readerActive = false; }
  if (st.detached) return;
  if (!st.done && !st.stopped && !st.gone && !st.errMsg && liveJob && liveJob.jobId) {
    // The stream died mid-turn but the job survives server-side (phone suspended, wifi blip):
    // do NOT render the retry/error state — reattach and catch up (backoff + on next visible).
    scheduleReattach();
    return;
  }
  if (!st.done && !st.stopped && !st.gone && !st.errMsg) {
    // No jobId ever arrived (the POST itself failed) — there is nothing to reattach to. Drop the
    // provisional busy entry so the chat isn't stuck showing Stop, and surface the retry.
    delete liveJobs[c.id]; persistLiveJobs();
    st.errMsg = "Chat failed: " + (netErr || "connection lost") + " — tap send to retry.";
  }
  finalizeSession(st);
}

// ---- reattach: resume a live turn after suspend / reload / restart ----
// Backoff climbs then holds at 30s and repeats FOREVER — a run we know is live is never abandoned
// on the client's say-so; only a server verdict (done/stopped/gone/error) ends it. Retries pause
// while the tab is hidden (no point hammering a backgrounded PWA) and resume on visibilitychange.
const REATTACH_DELAYS = [1000, 3000, 10000, 30000];
function scheduleReattach(immediate) {
  if (!liveJob || !liveJob.jobId) return;
  if (document.hidden && !immediate) return;   // the visibility handler re-arms us on return
  clearTimeout(reattachTimer);
  reattachTimer = setTimeout(attemptReattach, immediate ? 0 : REATTACH_DELAYS[Math.min(reattachTries, REATTACH_DELAYS.length - 1)]);
}
async function attemptReattach() {
  if (readerActive || !liveJob || !liveJob.jobId) return;
  if (!liveJobs[curId] || liveJobs[curId].jobId !== liveJob.jobId) return;   // only the on-screen chat's run
  let st = liveSession;
  if (!st) {
    // Fresh session (reload, or first open of a background chat): there's no retained partial to
    // resume onto, so replay the whole turn from 0 — the token deltas reconstitute the text. (Only
    // a session that KEPT its accumulated st.raw resumes from a mid-stream cursor.)
    const c = cur(); if (!c) return;
    st = liveSession = newSession(c);
    st.jobId = liveJob.jobId;
    st.modelId = liveJob.modelId || st.modelId;
    liveJob.eventIndex = 0;
  }
  syncComposer();
  reattachTries++;
  readerActive = true;
  try {
    const r = await fetch("/chat/attach?job=" + encodeURIComponent(liveJob.jobId) + "&from=" + (liveJob.eventIndex || 0), { cache: "no-store" });
    if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
    await readSse(r, st);
  } catch {} finally { readerActive = false; }
  if (st.detached) return;
  if (st.done || st.stopped) return finalizeSession(st);
  if (st.gone) { st.errMsg = "That answer expired on the server — ask again."; return finalizeSession(st); }
  if (st.errMsg) return finalizeSession(st);
  // Died again mid-tail — keep trying (1s/3s/10s/30s… and on next visible). No give-up: the run is
  // still generating on the server, so we owe the user a reconnect however long it takes.
  scheduleReattach();
}
// Called on boot, visibilitychange→visible, pageshow, and chat switch: if the chat on screen has a
// live run and no reader is consuming it, reattach immediately.
function maybeReattach() {
  if (readerActive) return;
  const j = liveJobs[curId];
  if (!j || !j.jobId) return;
  liveJob = j;
  scheduleReattach(true);
}
// Reconcile local live-job state with the server's truth (boot + on return to the app). Adopts runs
// this device didn't know about, and DELIVERS finished background runs into their chats even when
// that chat isn't on screen — the whole point of "start it, walk away, come back to the answer".
let reconcileBusy = false, lastReconcile = 0;
async function reconcileJobs() {
  if (reconcileBusy) return;
  reconcileBusy = true;
  try {
    let jobs = [];
    try { const r = await fetch("/chat/jobs", { cache: "no-store" }); if (r.ok) jobs = (await r.json()).jobs || []; } catch { return; }
    let changed = false;
    for (const j of jobs) {
      if (!j.chatId) continue;
      // One-time migration for chats created before model-per-session existed. The durable job
      // ledger already knows which model actually ran that chat, including a paused background
      // coding job, so recover it instead of assigning whichever model another chat last used.
      const jobChat = chats.find((x) => x.id === j.chatId);
      if (jobChat && !jobChat.model && j.model) {
        jobChat.model = j.model;
        jobChat.activityAt = touchChatComponent(
          jobChat, "modelUpdatedAt", Math.max(Number(j.startedAt) || 0, Date.now())
        );
        changed = true;
      }
      if (j.status === "running") {
        if (!liveJobs[j.chatId]) { liveJobs[j.chatId] = { jobId: j.id, eventIndex: 0, modelId: j.model || (jobChat && jobChat.model) || defaultCloudModel() || "" }; changed = true; }
      } else if (!j.collected) {
        const c = chats.find((x) => x.id === j.chatId);
        if (c) { if (await deliverResult(j.id, c)) changed = true; }
      }
    }
    if (changed) { persistLiveJobs(); renderAll(); }
    maybeReattach();
  } finally { reconcileBusy = false; lastReconcile = Date.now(); }
}
// Merge a finished (or interrupted/orphaned) background run's result into its chat without opening
// an SSE stream. Returns true if it changed anything. The on-screen live session is left to its own
// finalize (which collects), so we never double-append.
async function deliverResult(jobId, c) {
  if (mergedJobs.has(jobId)) { if (liveJobs[c.id] && liveJobs[c.id].jobId === jobId) { delete liveJobs[c.id]; } return false; }
  if (liveSession && liveSession.c.id === c.id) return false;
  let r; try { const resp = await fetch("/chat/result?job=" + encodeURIComponent(jobId), { cache: "no-store" }); if (!resp.ok) return false; r = await resp.json(); } catch { return false; }
  mergedJobs.add(jobId);
  const text = stripThink(r.text || "");
  if (text) {
    const interrupted = r.status === "stopped" || r.status === "orphaned" || r.status === "error";
    const ranModel = (liveJobs[c.id] && liveJobs[c.id].modelId) || (r.meta && r.meta.model) || stampedModelId(c);
    const msg = { role: "assistant", content: text, modelId: ranModel };
    if (r.meta && typeof r.meta === "object") { msg.meta = { ...r.meta }; if (r.meta.mode) c.lastMode = r.meta.mode; }
    if (interrupted) { msg.meta = msg.meta || {}; msg.meta.interrupted = true; }
    c.messages.push(msg); c.activityAt = touchChatComponent(c, "transcriptUpdatedAt"); save();
  }
  if (liveJobs[c.id] && liveJobs[c.id].jobId === jobId) { delete liveJobs[c.id]; }
  collectJob(jobId);
  return true;
}

function send() {
  if (busyFor(curId)) {
    // Stop = a server-side call now (generation no longer dies with the socket), targeting THIS
    // chat's run. Falls back to the local abort if the job id hasn't arrived yet or the POST fails.
    const j = liveJobs[curId];
    if (j && j.jobId) {
      fetch("/chat/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: j.jobId }) })
        .catch(() => { if (aborter) aborter.abort(); });
    } else if (aborter) aborter.abort();
    return;
  }
  const c = cur(); if (!c) return;
  const staged = chatPendingAttachments(c);
  const text = input.value.trim(); if (!text && !staged.length) return;
  if (attachSendBlocked(staged)) { updateAttachGate(); attachWarn.classList.remove("shake"); void attachWarn.offsetWidth; attachWarn.classList.add("shake"); return; }
  const at = Date.now();
  input.value = ""; c.draft = "";
  touchChatComponent(c, "draftUpdatedAt", at);
  autosize(); hideCostChip();
  scroll(true);   // a fresh send always re-engages the follow so the reply starts in view
  const msg = { role: "user", content: text || "", modelId: stampedModelId(c) };
  if (staged.length) {
    msg.attachments = staged;
    c.pendingAttachments = [];
    pendingAtt = c.pendingAttachments;
    renderAttachStrip();
  }
  c.messages.push(msg);
  touchChatComponent(c, "transcriptUpdatedAt", at);
  if (c.title === "New chat") {
    c.title = titleFrom(c.messages);
    touchChatComponent(c, "titleUpdatedAt", at);
  }
  c.activityAt = c.updatedAt; save(); renderAll();
  streamReply(c);
}
function regenerate() {
  if (busyFor(curId)) return; const c = cur(); if (!c) return;
  for (let i = c.messages.length - 1; i >= 0; i--) if (c.messages[i].role === "assistant") {
    c.messages.splice(i, 1); c.activityAt = touchChatComponent(c, "transcriptUpdatedAt"); break;
  }
  save(); renderAll(); streamReply(c);
}
// Pick up where a (possibly stopped) answer left off (spec: offer continuation after stop).
function continueLast() {
  if (busyFor(curId)) return; const c = cur(); if (!c) return;
  c.messages.push({ role: "user", content: "Continue the unfinished work from the prior run now. Resume with the next concrete tool action; do not merely restate what remains. Work until complete unless a safety, context, or funded session-budget guard pauses you.", modelId: stampedModelId(c) });
  c.activityAt = touchChatComponent(c, "transcriptUpdatedAt"); save(); renderAll(); streamReply(c);
}
function editUser(i) {
  if (busyFor(curId)) return; const c = cur(); if (!c) return;
  const at = Date.now();
  input.value = c.messages[i].content;
  c.draft = input.value;
  touchChatComponent(c, "draftUpdatedAt", at);
  // Attachments come back to the staging strip with the text, so an edited resend keeps them.
  const att = c.messages[i].attachments;
  pendingAtt = Array.isArray(att) ? att.filter(usablePendingAttachment) : [];
  c.pendingAttachments = pendingAtt;
  renderAttachStrip();
  c.messages = c.messages.slice(0, i);
  c.activityAt = touchChatComponent(c, "transcriptUpdatedAt", at);
  save(); renderAll(); autosize(); input.focus();
}

// ---------- settings ----------
function openSettings() {
  personaSel.value = settings.persona; personaCustom.value = settings.personaCustom || "";
  personaCustom.hidden = settings.persona !== "custom";
  tempInput.value = String(settings.temperature); tempVal.textContent = String(settings.temperature);
  if (confirmToolsBox) confirmToolsBox.checked = !!settings.confirmTools;
  if (privacySel) privacySel.value = settings.privacy || "redacted_external";
  for (const [id, key] of [["show-ctx-mem", "ctxMem"], ["show-ctx-docs", "ctxDocs"], ["show-ctx-chats", "ctxChats"]]) {
    const el = document.getElementById(id); if (el) el.checked = !!settings[key];
  }
  smodal.hidden = false;
}
const closeSettings = () => { smodal.hidden = true; };
function saveSettingsUI() {
  settings.persona = personaSel.value; settings.personaCustom = personaCustom.value.trim();
  settings.temperature = parseFloat(tempInput.value);
  if (confirmToolsBox) settings.confirmTools = confirmToolsBox.checked;
  if (privacySel) settings.privacy = privacySel.value;
  for (const [id, key] of [["show-ctx-mem", "ctxMem"], ["show-ctx-docs", "ctxDocs"], ["show-ctx-chats", "ctxChats"]]) {
    const el = document.getElementById(id); if (el) settings[key] = el.checked;
  }
  if (modelSel) try { localStorage.setItem(LS_MODEL, modelSel.value); } catch {}
  updateCloudBadge();
  saveSettings(); closeSettings(); renderAll();   // context-chip toggles repaint existing messages
}

// ---------- session budget window + popup (Fred, 2026-07-25) ----------
// The black window beside the composer shows spent-of-budget for THIS chat, live off SSE budget
// events; tapping Set edits it in place. Refusals and shortfalls open the big blurred popup with
// the server's fully transparent message (who holds what, every number) — wording identical on
// both sides because the server composes it once.
const budgetByChat = Object.create(null);
const currentBudget = () => curId ? budgetByChat[curId] || null : null;
/*
 * The session's own unit leads, because the server created the session with it and every figure in
 * the row is denominated in it. A guest whose session was nevertheless opened in dollars (an older
 * row, or a session inherited from an owner-side context) gets the FIGURE converted as well as the
 * word, so the box can never label a dollar amount as credits (Fred, 2026-07-30).
 */
const fmtBudget = (n, unit) => {
  if (unit !== "usd") return Math.floor(Number(n) || 0).toLocaleString() + " credits";
  if (money().inCredits()) return money().balance(n);
  return "$" + (Number(n) || 0).toFixed(2);
};
function renderBudget() {
  const box = document.getElementById("budgetbox"); if (!box) return;
  const budgetCur = currentBudget();
  if (!budgetCur || !curId) { box.hidden = true; return; }
  box.hidden = false;
  const el = document.getElementById("bb-nums");
  // The free-balance tail carried a bare number ("· 1240 free"), which is the one place in a money
  // window where a unitless figure is unforgivable. It wears the session's own unit now.
  if (el) el.textContent = fmtBudget(budgetCur.spent || 0, budgetCur.unit) + " of " + fmtBudget(budgetCur.budget || 0, budgetCur.unit)
    + (budgetCur.available != null ? " · " + fmtBudget(budgetCur.available, budgetCur.unit) + " free" : "");
}
async function fetchBudget(chatId = curId) {
  if (!chatId) { renderBudget(); return; }
  const requestedChat = chatId;
  try {
    const d = await memApi("/budget?chat=" + encodeURIComponent(requestedChat));
    if (d && d.session) {
      budgetByChat[requestedChat] = { budget: d.session.budget, spent: d.session.spent, remaining: d.session.remaining, unit: d.session.unit, available: d.available };
      if (requestedChat === curId) {
        renderBudget();
        if (d.shortfallMessage && d.session.created) openBudgetModal(d.shortfallMessage, { credits: true });
      }
    }
  } catch {}
}
function openBudgetModal(message, { raise = false, credits = false } = {}) {
  const m = document.getElementById("bmodal"); if (!m) return;
  const msg = document.getElementById("bmsg"); if (msg) msg.textContent = message || "";
  const br = document.getElementById("braise"); if (br) br.hidden = !raise;
  const bc = document.getElementById("bcredits"); if (bc) bc.hidden = !credits;
  m.hidden = false;
}
function startBudgetEdit() {
  const nums = document.getElementById("bb-nums"), edit = document.getElementById("bb-editwrap");
  if (!nums || !edit) return;
  nums.hidden = true; edit.hidden = false;
  const inp = document.getElementById("bb-input");
  const budgetCur = currentBudget();
  if (inp) { inp.value = budgetCur ? String(budgetCur.unit === "usd" ? budgetCur.budget : Math.floor(budgetCur.budget)) : ""; inp.focus(); inp.select(); }
}
function endBudgetEdit() {
  const nums = document.getElementById("bb-nums"), edit = document.getElementById("bb-editwrap");
  if (nums) nums.hidden = false; if (edit) edit.hidden = true;
}
async function submitBudgetEdit() {
  const inp = document.getElementById("bb-input"); if (!inp || !curId) return endBudgetEdit();
  const requestedChat = curId;
  const want = parseFloat(inp.value);
  if (!Number.isFinite(want) || want < 0) return endBudgetEdit();
  const requested = chats.find((c) => c.id === requestedChat);
  const d = await memApi("/budget", { chat: requestedChat, budget: want, title: requested ? requested.title : "" });
  endBudgetEdit();
  if (d && d.ok === false && d.message) {
    if (requestedChat === curId) openBudgetModal(d.message, { credits: true });
    fetchBudget(requestedChat);
    return;
  }
  if (d && d.ok && d.session) {
    budgetByChat[requestedChat] = { budget: d.session.budget, spent: d.session.spent, remaining: d.session.remaining, unit: d.session.unit, available: d.available };
    if (requestedChat === curId) renderBudget();
  }
}
function wireBudgetUi() {
  const set = document.getElementById("bb-edit"); if (set) set.addEventListener("click", startBudgetEdit);
  const ok = document.getElementById("bb-ok"); if (ok) ok.addEventListener("click", submitBudgetEdit);
  const inp = document.getElementById("bb-input");
  if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submitBudgetEdit(); if (e.key === "Escape") endBudgetEdit(); });
  const x = document.getElementById("bclose"); if (x) x.addEventListener("click", () => { document.getElementById("bmodal").hidden = true; });
  const br = document.getElementById("braise"); if (br) br.addEventListener("click", () => { document.getElementById("bmodal").hidden = true; startBudgetEdit(); });
  const bc = document.getElementById("bcredits"); if (bc) bc.addEventListener("click", () => { location.href = "/setup.html"; });
}
try { wireBudgetUi(); fetchBudget(); } catch {}

/*
 * Money wording starts as guest wording and firms up when /account answers (dominion-money.js).
 * Anything already painted with a price repaints once, here, so the owner never keeps a credits
 * figure from the first few hundred milliseconds of a cold load.
 */
/* ---------- Send to Crucible (Fred, 2026-07-30) --------------------------------------------
 * The crossing from "we talked about an app" to "the app is being built". It appears once the
 * conversation is actually about something, reads the chat into a project brief on the server,
 * makes the folder, and hands off to the Crucible with the level picker showing — because the
 * skill level stays the person's choice, and the surface then reacts to what the chat said.
 */
const toCrucibleBtn = document.getElementById("to-crucible");
function paintToCrucible() {
  if (!toCrucibleBtn) return;
  const c = cur();
  const turns = c && c.messages ? c.messages.filter((m) => m.role === "user").length : 0;
  const words = c && c.messages
    ? c.messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.split(/\s+/).length : 0), 0)
    : 0;
  // Two exchanges or a substantial first one. A button offering to start a project after "hello"
  // is noise, and noise is what people learn to ignore.
  toCrucibleBtn.hidden = !(turns >= 2 || words > 120);
}
if (toCrucibleBtn) toCrucibleBtn.addEventListener("click", async () => {
  const c = cur();
  if (!c || busyFor(curId)) return;
  toCrucibleBtn.disabled = true;
  const label = toCrucibleBtn.querySelector("span:last-child");
  const was = label ? label.textContent : "";
  if (label) label.textContent = "Reading the plan…";
  try {
    const r = await fetch("/ide/from-chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: c.messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" })) }),
    });
    const j = await r.json();
    if (!r.ok || j.error) { if (label) label.textContent = was; alert(j.error || "The plan could not be read."); return; }
    // The Crucible owns everything past this point: it makes the folder, fills the brief, and shows
    // the level picker. Handing it an event rather than reaching into its internals keeps the two
    // surfaces separable.
    document.dispatchEvent(new CustomEvent("dominion-to-crucible", { detail: { name: j.name, brief: j.brief, chatId: curId } }));
  } catch {
    alert("The server could not be reached.");
  } finally {
    toCrucibleBtn.disabled = false;
    if (label) label.textContent = was || "Send to Crucible";
  }
});

document.addEventListener("dominion-money-ready", () => {
  try { relabelModelOptions(); updateModelTrigger(); renderModelPanel(); renderAll(); renderBudget(); paintFastLane(); } catch {}
});

/*
 * CHAT FOCUS MODE (Fred, 2026-07-25) — mobile. Once the open chat has a sent message, the
 * model/mode/privacy container and the panel-button container fold into the header; each comes
 * back through its own handle (small drawer for controls, narrow right-edge handle for panels).
 * The class only ever reflects the OPEN chat, so a fresh chat always starts with full chrome.
 * All visual gating lives in CSS behind a max-width media query — desktop never changes.
 */
/*
 * FOLDED ON EVERY LOAD (Fred, 2026-07-30 evening): "the header was supposed to minimize
 * automatically upon load every time."
 *
 * The condition used to be earned rather than given: first the OPEN chat needed a sent message,
 * then any chat did. Both readings kept a state in which the header loads full height, and every
 * time Fred met that state he read it as the feature having been reverted again. A condition that
 * has been wrong twice is the wrong shape. The header now folds unconditionally on load, and the
 * handles are always present to open it, so there is no state left that can look like a
 * regression. A first-timer sees the same chat-first screen and reaches every control through the
 * upper-right handle. All visual gating still lives in CSS behind max-width: desktop is untouched.
 */
function updateFocusMode() {
  document.body.classList.add("chat-focus");
  const h1 = document.getElementById("focus-controls-handle"), h2 = document.getElementById("focus-actions-handle");
  if (h1) h1.hidden = false;
  if (h2) h2.hidden = false;
}
/* Closing is one job, so it lives in one place: the handles, the input, and the sheets all call it. */
function collapseFocusSheets() {
  document.body.classList.remove("reveal-controls", "reveal-actions");
  const h1 = document.getElementById("focus-controls-handle"), h2 = document.getElementById("focus-actions-handle");
  if (h1) h1.setAttribute("aria-expanded", "false");
  if (h2) h2.setAttribute("aria-expanded", "false");
}
(function wireFocusHandles() {
  const h1 = document.getElementById("focus-controls-handle"), h2 = document.getElementById("focus-actions-handle");
  if (h1) h1.addEventListener("click", () => { const on = document.body.classList.toggle("reveal-controls"); document.body.classList.remove("reveal-actions"); h1.setAttribute("aria-expanded", on ? "true" : "false"); });
  if (h2) h2.addEventListener("click", () => { const on = document.body.classList.toggle("reveal-actions"); document.body.classList.remove("reveal-controls"); h2.setAttribute("aria-expanded", on ? "true" : "false"); });
  /*
   * Returning to the typing field closes the header again (Fred: "tapping the field where you type
   * should collapse the header"). pointerdown rather than focus, because the controls sheet hangs
   * over the top of the chat and the tap that dismisses it should not also have to land twice.
   * focus is kept as the belt-and-braces path for hardware keyboards and voice entry.
   */
  const input = document.getElementById("input");
  if (input) {
    input.addEventListener("pointerdown", collapseFocusSheets);
    input.addEventListener("focus", collapseFocusSheets);
  }
})();
try { updateFocusMode(); } catch {}

// ---------- memory panel (Phase 2) ----------
function badge(text, cls) { const b = document.createElement("span"); b.className = "mbadge" + (cls ? " " + cls : ""); b.textContent = text; return b; }
async function memApi(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  return r.json().catch(() => ({}));
}
async function loadMemory() {
  mlist.textContent = "Loading…";
  const status = mfilterStatus ? mfilterStatus.value : "";
  const d = await memApi("/memory" + (status ? "?status=" + encodeURIComponent(status) : ""));
  const items = (d && d.items) || [];
  if (mstats && d.stats) { const p = d.stats.byStatus && d.stats.byStatus.pending; mstats.textContent = (d.stats.total || 0) + " saved" + (p ? " · " + p + " pending" : ""); }
  renderMemory(items);
}
function renderMemory(items) {
  mlist.innerHTML = "";
  if (!items.length) { const n = document.createElement("div"); n.className = "none"; n.textContent = "No memories yet. Add one above, or tell me “remember that…”"; mlist.appendChild(n); return; }
  for (const m of items) {
    const it = document.createElement("div"); it.className = "mitem";
    const top = document.createElement("div"); top.className = "mtop";
    top.append(badge(m.type), badge(m.status, m.status));
    if (m.scope && m.scope !== "global") top.append(badge("scope: " + m.scope));
    if (m.unverified) top.append(badge("unverified mentor claim", "rejected"));          // pending until Fred validates it
    else if (m.gatedAs === "approval" && m.status === "approved") top.append(badge("lax auto-approve", "pending"));   // spec mode would have gated this
    if (m.sensitive) top.append(badge("sensitive", "pending"));
    if (m.pinned) { const p = document.createElement("span"); p.className = "pinned"; p.textContent = "📌"; top.appendChild(p); }
    const c = document.createElement("div"); c.className = "mc"; c.textContent = m.content;
    const acts = document.createElement("div"); acts.className = "macts";
    if (m.status === "pending") acts.append(mkAct("Approve", () => memUpdate(m.id, { action: "approve" })), mkAct("Reject", () => memUpdate(m.id, { action: "reject" })));
    acts.append(
      mkAct(m.pinned ? "Unpin" : "Pin", () => memUpdate(m.id, { action: m.pinned ? "unpin" : "pin" })),
      mkAct("Edit", async () => { const t = await askText({ kicker: "Memory", title: "Edit memory", value: m.content }); if (t != null && t.trim()) memUpdate(m.id, { content: t.trim() }); }),
      mkAct("→ Eval", async (ev) => { const exp = await askText({ kicker: "Evaluation", title: "Expected behavior", placeholder: "What a good answer must do…" }); if (exp == null) return; await aApi("/evals", { title: m.content.slice(0, 80), input: m.content, expectedBehavior: exp, source: "manual" }); if (ev && ev.target) ev.target.textContent = "saved ✓"; }),
      mkAct("→ Rule", async (ev) => { await aApi("/rules", { content: m.content, scope: "global", status: "candidate" }); if (ev && ev.target) ev.target.textContent = "saved ✓"; }),
      // F3 (item 28, spec 616): the 8th inbox action — convert a memory into a retrieval-scope note
      // (guides what gets looked up; mirrors → Rule with scope:"retrieval").
      mkAct("→ Retrieval note", async (ev) => { await aApi("/rules", { content: m.content, scope: "retrieval", status: "candidate" }); if (ev && ev.target) ev.target.textContent = "saved ✓"; }, "Save as a retrieval guidance note"),
      mkAct(m.status === "archived" ? "Unarchive" : "Archive", () => memUpdate(m.id, { action: m.status === "archived" ? "approve" : "archive" })),
      mkAct("Delete", () => { if (confirm("Delete this memory?")) memDelete(m.id); }),
    );
    it.append(top, c, acts); mlist.appendChild(it);
  }
}
async function memUpdate(id, patch) { await memApi("/memory/update", { id, ...patch }); loadMemory(); }
async function memDelete(id) { await memApi("/memory/delete", { id }); loadMemory(); }
async function addMemory() { const v = (madd.value || "").trim(); if (!v) return; await memApi("/memory", { content: v, source: "user_explicit" }); madd.value = ""; loadMemory(); }
function openMemory() { mmodal.hidden = false; loadMemory(); }
const closeMemory = () => { mmodal.hidden = true; };

// ---------- persona forge ("become an expert in me") ----------
let pKindsFilled = false;
function setPMsg(t) { if (!pmsg) return; pmsg.textContent = t || ""; }
async function loadPersona() {
  const d = await memApi("/persona");
  const s = (d && d.stats) || {};
  if (pstats) pstats.textContent = (s.docs || 0) + " item" + (s.docs === 1 ? "" : "s") + " · " + (s.chunks || 0) + " chunks" + (s.pendingEmbeds ? " · " + s.pendingEmbeds + " embedding…" : "");
  renderProfile(d && d.profile);
  if (!pKindsFilled && d && Array.isArray(d.kinds)) {
    for (const k of d.kinds) { const o = document.createElement("option"); o.value = k; o.textContent = k[0].toUpperCase() + k.slice(1); pfilterKind.appendChild(o); }
    pKindsFilled = true;
  }
  loadPersonaList();
}
function renderProfile(profile) {
  pprofile.innerHTML = "";
  if (!profile || !profile.systemBlock) { const n = document.createElement("div"); n.className = "none"; n.textContent = "No voice profile yet. Add some of your writing, then tap “Refresh profile” to distill your voice."; pprofile.appendChild(n); return; }
  const when = profile.updatedAt ? " (updated " + String(profile.updatedAt).slice(0, 10) + ")" : "";
  pprofile.textContent = "Fred Profile" + when + "\n\n" + profile.systemBlock;
}
async function loadPersonaList() {
  plist.textContent = "Loading…";
  const kind = pfilterKind ? pfilterKind.value : "";
  const d = await memApi("/persona/list" + (kind ? "?kind=" + encodeURIComponent(kind) : ""));
  renderPersonaDocs((d && d.items) || []);
}
function renderPersonaDocs(items) {
  plist.innerHTML = "";
  if (!items.length) { const n = document.createElement("div"); n.className = "none"; n.textContent = "Nothing in the corpus yet."; plist.appendChild(n); return; }
  for (const it of items) {
    const row = document.createElement("div"); row.className = "mitem";
    const top = document.createElement("div"); top.className = "mtop";
    const kb = document.createElement("span"); kb.className = "pkind-badge"; kb.textContent = it.kind; top.appendChild(kb);
    const meta = document.createElement("span"); meta.textContent = (it.chunks || 0) + " chunk" + (it.chunks === 1 ? "" : "s") + " · " + it.chars + " chars"; top.appendChild(meta);
    const c = document.createElement("div"); c.className = "mc"; c.textContent = it.title;
    const acts = document.createElement("div"); acts.className = "macts";
    acts.append(mkAct("Delete", () => { if (confirm("Remove this from the corpus?")) memApi("/persona/delete", { id: it.id }).then(loadPersona); }));
    row.append(top, c, acts); plist.appendChild(row);
  }
}
async function addPersonaText() {
  const v = (padd.value || "").trim(); if (!v) return;
  setPMsg("Adding…");
  const d = await memApi("/persona/ingest", { text: v, kind: pkind.value, title: (ptitle.value || "").trim() });
  if (d && d.error) return setPMsg(d.error);
  padd.value = ""; ptitle.value = "";
  setPMsg(d.deduped ? "Already had that." : "Added ✓ (" + (d.chunks || 0) + " chunks)");
  loadPersona();
}
async function scrapePersona() {
  const url = (purl.value || "").trim(); if (!url) return;
  setPMsg("Fetching " + url + " …");
  const d = await memApi("/persona/scrape", { url });
  if (d && d.error) return setPMsg(d.error);
  purl.value = "";
  setPMsg("Scraped ✓ (" + (d.chars || 0) + " chars, " + (d.chunks || 0) + " chunks)");
  loadPersona();
}
let scanTimer = null;
async function scanPersonaInbox() {
  pscan.disabled = true;
  setPMsg("Scanning inboxes…");
  const d = await memApi("/persona/scan", {});
  if (d && d.error) { pscan.disabled = false; return setPMsg(d.error); }
  pollScan();
}
async function pollScan() {
  const s = await memApi("/persona/scan/status");
  if (!s) { pscan.disabled = false; return; }
  if (s.running) {
    setPMsg("Ingesting… " + (s.ingested || 0) + " file(s), " + (s.chunks || 0) + " chunks so far" + (s.skipped ? " · " + s.skipped + " skipped" : ""));
    clearTimeout(scanTimer); scanTimer = setTimeout(pollScan, 2000);
    return;
  }
  pscan.disabled = false;
  if (s.error) return setPMsg("Scan failed: " + s.error);
  setPMsg("Ingested " + (s.ingested || 0) + " file(s), " + (s.chunks || 0) + " chunks" + (s.skipped ? " · " + s.skipped + " skipped" : "") + (s.backup && String(s.backup).includes("corpus-") ? " · backed up ✓" : ""));
  loadPersona();
}
let distillTimer = null;
async function distillProfile() {
  pdistill.disabled = true;
  setPMsg("Starting a full read of your corpus…");
  const start = await memApi("/persona/distill", {});
  if (start && start.error) { pdistill.disabled = false; return setPMsg(start.error); }
  pollDistill();
}
async function pollDistill() {
  const s = await memApi("/persona/distill/status");
  if (!s) { pdistill.disabled = false; return; }
  if (s.running) {
    const phase = s.phase === "reading" ? "Reading your whole corpus" : s.phase === "synthesizing" ? "Synthesizing your voice" : "Starting";
    const prog = s.batchesTotal ? " — batch " + s.batchesDone + "/" + s.batchesTotal : "";
    const cap = s.capped ? " · digesting " + s.digestedChunks + "/" + s.totalChunks + " chunks" : "";
    setPMsg(phase + "…" + prog + cap);
    clearTimeout(distillTimer); distillTimer = setTimeout(pollDistill, 2500);
    return;
  }
  pdistill.disabled = false;
  if (s.phase === "error") return setPMsg("Distill failed: " + (s.error || "unknown"));
  if (s.phase === "done") {
    const cov = s.capped ? " (digested " + s.digestedChunks + "/" + s.totalChunks + " chunks — cap reached)" : " (read the whole corpus)";
    setPMsg("Profile refreshed ✓" + cov);
    const d = await memApi("/persona/profile"); renderProfile(d && d.profile); loadPersona();
  }
}
async function resumeDistillIfRunning() {
  const s = await memApi("/persona/distill/status"); if (s && s.running) { pdistill.disabled = true; pollDistill(); }
  const sc = await memApi("/persona/scan/status"); if (sc && sc.running) { pscan.disabled = true; pollScan(); }
}
function openPersona() { pmodal.hidden = false; setPMsg(""); loadPersona(); resumeDistillIfRunning(); }
const closePersona = () => { pmodal.hidden = true; };

// ---------- tool activity panel (Phase 3) ----------
const tfmt = (ts) => { try { return new Date(ts).toLocaleString(); } catch { return ts || ""; } };
// F1 (item 26): the panel can open FILTERED to one message's runs — exact runIds when the message
// meta carries them, else the honest fallback of everything logged for this chat.
let toolFilter = null;   // { runIds?: [], chatId?: "", label: "" }
async function loadTools() {
  tlist.textContent = "Loading…";
  let all = [];
  try { all = ((await (await fetch("/toolruns", { cache: "no-store" })).json()).runs) || []; } catch {}
  let runs = all;
  if (toolFilter) {
    runs = (toolFilter.runIds && toolFilter.runIds.length)
      ? all.filter((r) => toolFilter.runIds.includes(r.runId))
      : toolFilter.chatId ? all.filter((r) => r.chatId === toolFilter.chatId) : all;
  }
  if (tstats) tstats.textContent = toolFilter ? runs.length + " of " + all.length + " (" + (toolFilter.label || "filtered") + ")" : (runs.length ? runs.length + " recent" : "");
  tlist.innerHTML = "";
  if (toolFilter) {
    const bar = document.createElement("div"); bar.className = "mfilter";
    bar.appendChild(Object.assign(document.createElement("span"), { textContent: "Filtered to " + (toolFilter.label || "selection") }));
    bar.appendChild(mkAct("Show all", () => { toolFilter = null; loadTools(); }));
    tlist.appendChild(bar);
  }
  if (!runs.length) { const n = document.createElement("div"); n.className = "none"; n.textContent = toolFilter ? "No matching tool runs (runs before this update aren't tracked per message)." : "No tool activity yet."; tlist.appendChild(n); return; }
  for (const r of runs) {
    const it = document.createElement("div"); it.className = "tritem";
    const top = document.createElement("div"); top.className = "trtop";
    const nm = document.createElement("span"); nm.className = "trname"; nm.textContent = r.name;
    const cb = document.createElement("span"); cb.className = "tbadge " + (r.cls || ""); cb.textContent = String(r.cls || "").replace(/_/g, " ");
    const sb = document.createElement("span"); sb.className = "tbadge " + (r.status || ""); sb.textContent = r.status || "";
    const tm = document.createElement("span"); tm.textContent = tfmt(r.ts);
    top.append(nm, cb, sb, tm);
    it.appendChild(top);
    const prevText = r.output || r.reason || r.input || "";
    if (prevText) { const p = document.createElement("div"); p.className = "trprev"; p.textContent = prevText; it.appendChild(p); }
    tlist.appendChild(it);
  }
}
function openTools(filter) { toolFilter = filter && (filter.runIds || filter.chatId) ? filter : null; tmodal.hidden = false; loadTools(); }
const closeTools = () => { tmodal.hidden = true; };

// ---------- artifact studio (Phase 4) ----------
const aApi = async (path, body) => { const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" }); return r.json().catch(() => ({})); };
function openArtifacts() { amodal.hidden = false; showArtifactList(); }
const closeArtifacts = () => { amodal.hidden = true; };
async function showArtifactList() {
  adetail.hidden = true; alist.hidden = false; alist.textContent = "Loading…";
  const d = await aApi("/artifacts"); const items = (d && d.items) || [];
  if (astats) astats.textContent = d.stats ? (d.stats.total || 0) + " saved" : "";
  alist.innerHTML = "";
  if (!items.length) { const n = document.createElement("div"); n.className = "none"; n.textContent = "No artifacts yet. Generate a document in Draft mode, or use “Save” on a reply."; alist.appendChild(n); return; }
  for (const a of items) {
    const it = document.createElement("div"); it.className = "aitem";
    const ttl = document.createElement("div"); ttl.className = "atitle"; ttl.textContent = a.title;
    const top = document.createElement("div"); top.className = "atop";
    const ty = document.createElement("span"); ty.className = "abadge"; ty.textContent = a.type;
    const st = document.createElement("span"); st.className = "abadge " + a.status; st.textContent = a.status;
    const vc = document.createElement("span"); vc.textContent = "v" + a.version + (a.versionCount > 1 ? " of " + a.versionCount : "");
    const wc = document.createElement("span"); wc.textContent = a.wordCount + " words";
    top.append(ty, st, vc, wc);
    // The list used to be titles only, which read as a dead index (Fred, 2026-07-19: "all it does
    // is list the names"). Every row now says plainly that it opens, and offers the two formats
    // people actually want without opening anything.
    const row = document.createElement("div"); row.className = "arow aitem-acts";
    row.append(
      mkAct("Open", (e) => { e.stopPropagation(); openArtifact(a.id); }, "Read this document"),
      mkAct("PDF", (e) => { e.stopPropagation(); downloadArtifact(a, "pdf", { confirmReview: false }); }, "Download as PDF"),
      mkAct("Word", (e) => { e.stopPropagation(); downloadArtifact(a, "docx", { confirmReview: false }); }, "Download as a Word document"),
    );
    it.append(ttl, top, row); it.onclick = () => openArtifact(a.id); alist.appendChild(it);
  }
}
async function openArtifact(id) {
  const a = await aApi("/artifacts/get?id=" + encodeURIComponent(id));
  if (!a || a.error) return;
  alist.hidden = true; adetail.hidden = false; adetail.innerHTML = "";
  const back = document.createElement("button"); back.className = "back"; back.textContent = "← All artifacts"; back.onclick = showArtifactList; adetail.appendChild(back);
  const h = document.createElement("div"); h.className = "sheet-h"; h.textContent = a.title; adetail.appendChild(h);
  const meta = document.createElement("div"); meta.className = "arow";
  meta.innerHTML = `<span class="abadge ${a.status}">${a.status}</span><span>${a.type}</span><span>v${a.version} of ${a.versionCount}</span><span>${a.wordCount} words</span>`;
  // F4: model used (friendly tier label only — underlying model names never surface).
  if (a.modelProviderId) meta.appendChild(Object.assign(document.createElement("span"), { textContent: "model: " + (MODEL_TIER_LABEL[a.modelProviderId] || "local") }));
  // F4: explicit mentor-review status — "reviewed" only when the CURRENT version was reviewed.
  if (a.mentorReviewed && a.reviewedVersion === a.version) { const b = document.createElement("span"); b.className = "abadge reviewed"; b.textContent = "reviewed"; meta.appendChild(b); }
  else if (a.reviewRecommended && a.reviewRecommended.length) { const b = document.createElement("span"); b.className = "abadge draft"; b.textContent = "review suggested"; b.title = a.reviewRecommended.join(", ").replace(/_/g, " "); meta.appendChild(b); }
  // F4: tappable source-chat link (chats live in this browser's storage; gone = said honestly).
  if (a.sourceChatId) {
    const l = mkAct("from chat ↗", () => {
      const ch = chats.find((x) => x.id === a.sourceChatId);
      if (!ch) return alert("The source chat no longer exists on this device.");
      closeArtifacts(); switchChat(ch.id);
    }, "Open the chat this artifact came from");
    meta.appendChild(l);
  }
  adetail.appendChild(meta);
  const vrow = document.createElement("div"); vrow.className = "arow";
  const sel = document.createElement("select");
  for (let v = 1; v <= a.versionCount; v++) { const o = document.createElement("option"); o.value = v; o.textContent = "v" + v; if (v === a.version) o.selected = true; sel.appendChild(o); }
  sel.onchange = async () => { await aApi("/artifacts/setversion", { id: a.id, version: Number(sel.value) }); openArtifact(a.id); };
  vrow.append(Object.assign(document.createElement("span"), { textContent: "Version" }), sel);
  if (a.versionCount > 1) {
    // Any-to-any version diff (the API always supported it; the UI now does too)
    const dsel = document.createElement("select");
    for (let v = 1; v <= a.versionCount; v++) { const o = document.createElement("option"); o.value = v; o.textContent = "vs v" + v; if (v === (a.version - 1 || 1)) o.selected = true; dsel.appendChild(o); }
    vrow.append(dsel, mkAct("Diff", () => showDiff(a.id, Number(dsel.value), a.version)));
  }
  adetail.appendChild(vrow);
  const c = document.createElement("div"); c.className = "acontent"; c.textContent = a.content; adetail.appendChild(c);
  // Downloads sit directly under the document, where someone reading it looks for them.
  adetail.appendChild(exportRow(a));
  const acts = document.createElement("div"); acts.className = "arow"; acts.style.marginTop = "8px";
  acts.append(
    mkAct("Revise", () => reviseArtifact(a)),
    mkAct(a.status === "final" ? "Unfinalize" : "Mark final", () => markFinal(a)),
    mkAct("Review", () => reviewArtifact(a.id)),
    mkAct("Duplicate", async () => { const r = await aApi("/artifacts/duplicate", { id: a.id }); if (r.item) openArtifact(r.item.id); }),
    mkAct("Save as template", async () => { const r = await aApi("/artifacts/duplicate", { id: a.id, asTemplate: true }); if (r.item) openArtifact(r.item.id); }),
    mkAct("Rename", () => renameArt(a)),
    // E4: archived status reachable from the artifact panel (backend always supported it).
    mkAct(a.status === "archived" ? "Unarchive" : "Archive", () => setArtStatus(a.id, a.status === "archived" ? "draft" : "archived")),
    mkAct("Delete", () => { if (confirm("Delete this artifact and all versions?")) delArt(a.id); }),
  );
  adetail.appendChild(acts);
  // E1: server-side trigger sweep marked this artifact review-recommended.
  if (a.reviewRecommended && a.reviewRecommended.length && !(a.mentorReviewed && a.reviewedVersion === a.version)) {
    const rr = document.createElement("div"); rr.className = "arow";
    rr.textContent = "⚠ Mentor review recommended: " + a.reviewRecommended.join(", ").replace(/_/g, " ");
    adetail.appendChild(rr);
  }
  const xrow = document.createElement("div"); xrow.className = "arow";
  xrow.append(
    mkAct("→ Checklist", () => transformArt(a.id, "checklist")),
    mkAct("Extract tasks", () => transformArt(a.id, "tasks")),
    mkAct("Extract memories", async (ev) => { if (ev && ev.target) ev.target.textContent = "extracting…"; const r = await aApi("/artifacts/transform", { id: a.id, kind: "memory" }); alert(r.error ? "Extract: " + r.error : (r.count ? "Saved " + r.count + " memor" + (r.count === 1 ? "y" : "ies") + ":\n\n- " + r.saved.join("\n- ") : "Nothing durable found.")); openArtifact(a.id); }),
  );
  adetail.appendChild(xrow);
  if (a.reviewNotes) { const rv = document.createElement("div"); rv.className = "areview"; rv.textContent = a.reviewNotes; adetail.appendChild(rv); }
}
async function showDiff(id, from, to) {
  const d = await aApi(`/artifacts/diff?id=${encodeURIComponent(id)}&a=${from}&b=${to}`);
  const box = document.createElement("div"); box.className = "adiff";
  (d.diff || "(no diff)").split("\n").forEach((l) => { const ln = document.createElement("div"); if (l[0] === "+") ln.className = "add"; else if (l[0] === "-") ln.className = "del"; ln.textContent = l; box.appendChild(ln); });
  const old = adetail.querySelector(".adiff"); if (old) old.remove(); adetail.appendChild(box); box.scrollIntoView();
}
async function reviseArtifact(a) { const t = await askText({ kicker: "Artifact", title: "Revise — the full new content", value: a.content, saveLabel: "Save version", hint: "Edit freely. Saving creates a new version; earlier ones are kept." }); if (t != null && t.trim()) { await aApi("/artifacts/version", { id: a.id, content: t }); openArtifact(a.id); } }
// Export safety (spec, E2): the SERVER gate runs the seven checks — docx/pdf/xlsx/csv now export
// natively. Sensitive-data detection blocks until explicitly overridden; other warnings ride along.
// Download an artifact as a real file. The old version asked the user to TYPE a format, then
// showed the server's own file path in an alert — a path on a machine he cannot browse, which is
// why Fred said the documents landed "on the mini PC or some obscure file" (2026-07-19). The
// server was already returning a downloadUrl; now it is actually used, and the browser saves the
// file where the user's downloads go.
async function downloadArtifact(a, fmt, { confirmReview = true } = {}) {
  // The review nudge belongs on the detail view, where someone is deliberating. A one-tap download
  // from the list should just download; the sensitive-data block below is the real gate.
  if (confirmReview && !a.mentorReviewed && !confirm("This artifact hasn't been mentor-reviewed. Download anyway?")) return;
  let r = await aApi("/artifacts/export", { id: a.id, format: fmt });
  if (r.blocked === "sensitive_data") {
    if (!confirm("⚠ Possible sensitive data detected: " + (r.detected || []).join(", ") + "\n\nDownload anyway?")) return;
    r = await aApi("/artifacts/export", { id: a.id, format: fmt, override_sensitive: true });
  }
  if (r.error) return alert("Download failed: " + r.error);
  if (!r.downloadUrl) return alert("The file was created but the server did not return a download link.\n\nServer path: " + (r.path || "unknown"));
  const link = document.createElement("a");
  link.href = r.downloadUrl;
  link.download = r.fileName || (a.title + "." + fmt);
  document.body.appendChild(link); link.click(); link.remove();
  const warns = r.gate && r.gate.warnings && r.gate.warnings.length ? " Warnings: " + r.gate.warnings.map((w) => w.message || w.check).join("; ") : "";
  if (warns) setTimeout(() => alert("Downloaded " + (r.fileName || "") + "." + warns), 300);
}
// The format row: one tap per format, no typing.
const EXPORT_FORMATS = ["pdf", "docx", "xlsx", "csv", "md", "txt", "html", "json"];
function exportRow(a) {
  const row = document.createElement("div");
  row.className = "arow aexports";
  const lab = document.createElement("span"); lab.textContent = "Download as:"; row.appendChild(lab);
  for (const f of EXPORT_FORMATS) row.appendChild(mkAct(f.toUpperCase(), () => downloadArtifact(a, f), "Download this artifact as " + f.toUpperCase()));
  return row;
}
// Mark final offers a mentor review first (spec: review trigger on final) — one tap, never a blocker.
async function markFinal(a) {
  if (a.status === "final") return setArtStatus(a.id, "draft");
  if (!a.mentorReviewed && confirm("Run a mentor review before finalizing? (Recommended — takes ~20s)")) {
    const note = document.createElement("div"); note.className = "areview"; note.textContent = "Reviewing…"; adetail.appendChild(note);
    await aApi("/artifacts/review", { id: a.id });
  }
  await setArtStatus(a.id, "final");
}
async function transformArt(id, kind) {
  const note = document.createElement("div"); note.className = "areview"; note.textContent = "Transforming with the local model (~20s)…"; adetail.appendChild(note);
  const r = await aApi("/artifacts/transform", { id, kind });
  if (r.item) openArtifact(r.item.id); else { note.remove(); alert("Transform: " + (r.error || "failed")); }
}
async function setArtStatus(id, status) { await aApi("/artifacts/update", { id, status }); openArtifact(id); }
async function renameArt(a) { const t = await askText({ kicker: "Artifact", title: "Rename artifact", multiline: false, value: a.title, saveLabel: "Rename" }); if (t != null && t.trim()) { await aApi("/artifacts/update", { id: a.id, title: t.trim() }); openArtifact(a.id); } }
async function reviewArtifact(id) { const note = document.createElement("div"); note.className = "areview"; note.textContent = "Reviewing with the local model (≈20s)…"; adetail.appendChild(note); await aApi("/artifacts/review", { id }); openArtifact(id); }
async function delArt(id) { await aApi("/artifacts/delete", { id }); showArtifactList(); }
async function saveAsArtifact(content) {
  const guess = (String(content).split("\n").find((l) => l.trim()) || "Document").replace(/^#+\s*/, "").replace(/[*_`]/g, "").slice(0, 60);
  const t = await askText({ kicker: "Artifact", title: "Save as artifact — title", multiline: false, value: guess, saveLabel: "Save" }); if (t == null) return;
  const r = await aApi("/artifacts", { title: t || "Document", content, type: "markdown" });
  if (r.item) { openArtifacts(); openArtifact(r.item.id); }
}

// ---------- mentor critique (Phase 5) ----------
const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
// F1 (item 23): taskType picks the lens — the default full critique or the distinct
// hallucination_check (the server maps it to the factual-review specialist rubric).
async function critiqueMessage(i, taskType = "answer_review") {
  const c = cur(); if (!c || !c.messages[i]) return;
  const answer = c.messages[i].content; const orig = precedingUser(c, i);
  const card = document.createElement("div"); card.className = "critique";
  card.textContent = (taskType === "hallucination_check" ? "🔎 Checking for hallucinations…" : "🎓 Mentor reviewing…") + " (~15s)";
  wrap.appendChild(card); scroll();
  try {
    const d = await aApi("/mentor/review", { content: answer, originalRequest: orig, taskType, privacyMode: settings.privacy || "redacted_external", chatId: c.id });
    renderCritiqueCard(card, d.critique || {}, orig, answer, { reviewId: d.reviewId, ledgerId: d.ledgerId, taskType });
  } catch { card.textContent = "Mentor review failed."; }
}
function renderCritiqueCard(card, c, orig, answer, ids = {}) {
  card.innerHTML = "";
  const head = document.createElement("div"); head.className = "crhead";
  const sp = document.createElement("span"); sp.className = "scorepill"; sp.textContent = (c.overall_score ?? "?") + "/10"; head.appendChild(sp);
  head.appendChild(Object.assign(document.createElement("span"), { className: "crsec", textContent: (ids.taskType === "hallucination_check" ? "hallucination check · " : "") + "risk " + (c.hallucination_risk || "?") + " · revise " + (c.revision_priority || "none") + " · " + (c._provider || "") }));
  // F2 (item 27): rejecting a critique is RECORDED — the review record is marked rejected and the
  // auto-created ledger entry is removed, so a bad critique never poisons the flywheel.
  const x = document.createElement("button"); x.className = "act"; x.textContent = "✕"; x.title = "Reject critique (recorded — removes its ledger entry)"; x.style.marginLeft = "auto";
  x.onclick = () => {
    card.remove();
    aApi("/mentor/reject", { reviewId: ids.reviewId || null, ledgerId: ids.ledgerId || null, taskType: ids.taskType || "answer_review", chatId: curId, contentPreview: String(answer || "").slice(0, 300) }).catch(() => {});
  };
  head.appendChild(x);
  card.appendChild(head);
  const sec = (label, a) => { if (!a || !a.length) return; const d = document.createElement("div"); d.className = "crsec"; d.innerHTML = "<b>" + label + ":</b> " + a.map(escapeHtml).join("; "); card.appendChild(d); };
  sec("Major", c.major_findings); sec("Unsupported", c.unsupported_claims); sec("Reasoning", c.reasoning_errors); sec("Safety/Privacy", c.safety_or_privacy_issues);
  if (c.recommended_revision) { const d = document.createElement("div"); d.className = "crsec"; d.innerHTML = "<b>Suggestion:</b> " + escapeHtml(c.recommended_revision); card.appendChild(d); }
  // Apply revision (spec): one tap -> the local model rewrites the answer using this critique.
  if (answer && (c.recommended_revision || (c.major_findings || []).length)) {
    const row = document.createElement("div"); row.className = "cand";
    row.appendChild(Object.assign(document.createElement("span"), { textContent: "✍️ apply this critique to the answer" }));
    const b = document.createElement("button"); b.textContent = "Apply revision";
    b.onclick = async () => {
      b.disabled = true; b.textContent = "revising… (~30s)";
      try {
        const d = await aApi("/mentor/revise", { content: answer, originalRequest: orig, critique: c });
        if (d.revised) {
          const ch = cur();
          if (ch) {
            ch.messages.push({ role: "assistant", content: d.revised, meta: { revised: true } });
            ch.activityAt = touchChatComponent(ch, "transcriptUpdatedAt");
            save(); renderAll();
          }
          b.textContent = "applied ✓";
        } else { b.textContent = "failed"; b.disabled = false; }
      } catch { b.textContent = "failed"; b.disabled = false; }
    };
    row.appendChild(b); card.appendChild(row);
  }
  const cand = (label, text, save) => { const r = document.createElement("div"); r.className = "cand"; r.appendChild(Object.assign(document.createElement("span"), { textContent: "💡 " + text })); const b = document.createElement("button"); b.textContent = label; b.onclick = async () => { b.disabled = true; await save(); b.textContent = "saved ✓"; }; r.appendChild(b); card.appendChild(r); };
  (c.memory_candidates || []).forEach((t) => cand("→ memory", t, () => memApi("/memory", { content: t, source: "mentor_suggested" })));
  (c.eval_case_candidates || []).forEach((t) => cand("→ eval", t, () => aApi("/evals", { title: t.slice(0, 80), input: t, source: "mentor" })));
  (c.prompt_rule_candidates || []).forEach((t) => cand("→ rule", t, () => aApi("/rules", { content: t, scope: "global", status: "candidate" })));
  (c.retrieval_rule_candidates || []).forEach((t) => cand("→ retrieval rule", t, () => aApi("/rules", { content: t, scope: "retrieval", status: "candidate" })));
  cand("→ ledger", "log this review as a failure entry", () => aApi("/ledger", { category: "mentor_flag", severity: "low", originalRequest: orig, flawedOutput: "(see chat)", detectedBy: "mentor" }));
  scroll();
}

// ---------- mentor & improvement panel (Phase 5) ----------
let itab = "ledger";
function openImprove() { imodal.hidden = false; setITab(itab); }
const closeImprove = () => { imodal.hidden = true; };
function setITab(t) {
  itab = t; document.querySelectorAll(".itab").forEach((el) => el.classList.toggle("on", el.dataset.tab === t));
  iadd.placeholder = t === "ledger" ? "Log a failure / lesson…" : t === "evals" ? "Eval input prompt…" : t === "prompts" ? "Prompt content (name/scope asked next)…" : t === "finetune" ? "Instruction / input (ideal output asked next)…" : "Prompt rule (a compact instruction)…";
  loadImprove();
}
async function loadImprove() {
  ilist.textContent = "Loading…";
  const path = itab === "ledger" ? "/ledger" : itab === "evals" ? "/evals" : itab === "prompts" ? "/prompts" : itab === "finetune" ? "/finetune" : "/rules";
  const d = await aApi(path); const items = (d && d.items) || [];
  if (istats && d.stats) { const s = d.stats; istats.textContent = `${s.failures}F · ${s.evals}E · ${s.rules}R (${s.activeRules} active) · ${s.prompts || 0}P · ${s.finetune || 0}FT`; }
  ilist.innerHTML = "";
  if (!items.length) { const n = document.createElement("div"); n.className = "none"; n.textContent = "Nothing here yet."; ilist.appendChild(n); return; }
  for (const it of items) ilist.appendChild(itab === "ledger" ? renderFailure(it) : itab === "evals" ? renderEval(it) : itab === "prompts" ? renderPrompt(it) : itab === "finetune" ? renderFinetune(it) : renderRule(it));
}
function renderPrompt(p) {
  const it = document.createElement("div"); it.className = "mitem";
  const top = document.createElement("div"); top.className = "mtop";
  top.append(badge(p.name), badge(p.scope), badge("v" + p.version), badge(p.active ? "active" : "inactive", p.active ? "" : "pending"));
  const c = document.createElement("div"); c.className = "mc"; c.textContent = p.content;
  if (p.changeReason) { const r = document.createElement("div"); r.className = "mtop"; r.textContent = "why: " + p.changeReason; it.appendChild(r); }
  const acts = document.createElement("div"); acts.className = "macts";
  acts.append(
    mkAct(p.active ? "Deactivate" : "Activate", async () => { if (p.active) await aApi("/prompts/update", { id: p.id, active: false }); else await aApi("/prompts/activate", { id: p.id }); loadImprove(); }),
    mkAct("New version", async () => { const t = await askText({ kicker: "Prompt", title: "New version of “" + p.name + "”", value: p.content, saveLabel: "Next →" }); if (t == null || !t.trim()) return; const why = await askText({ kicker: "Prompt", title: "Reason for the change", multiline: false, placeholder: "Optional…", saveLabel: "Save version" }) || ""; await aApi("/prompts", { name: p.name, scope: p.scope, content: t.trim(), changeReason: why }); loadImprove(); }),
    mkAct("Delete", () => fUpdate("/prompts/delete", { id: p.id })),
  );
  it.append(top, c, acts); return it;
}
function renderFailure(f) {
  const it = document.createElement("div"); it.className = "mitem";
  const top = document.createElement("div"); top.className = "mtop";
  top.append(badge(f.category), badge(f.severity, f.severity === "high" || f.severity === "critical" ? "rejected" : ""), badge(f.status, f.status === "open" ? "pending" : ""), Object.assign(document.createElement("span"), { textContent: "by " + f.detectedBy }));
  const c = document.createElement("div"); c.className = "mc"; c.textContent = (f.originalRequest || "").slice(0, 160) || "(no request)";
  const acts = document.createElement("div"); acts.className = "macts";
  acts.append(mkAct(f.status === "open" ? "Mark resolved" : "Reopen", () => fUpdate("/ledger/update", { id: f.id, status: f.status === "open" ? "resolved" : "open" })), mkAct("Delete", () => fUpdate("/ledger/delete", { id: f.id })));
  it.append(top, c);
  // F4 (spec 1819-1831): root cause + improvement actions (+ sampling category / linked items)
  // were stored by the Group-A pipeline but never displayed.
  const detail = [
    f.rootCause && f.rootCause !== "unknown" ? "root: " + f.rootCause.replace(/_/g, " ") : "",
    (f.improvementActions || []).length ? "actions: " + f.improvementActions.map((a) => a.replace(/_/g, " ")).join(", ") : "",
    f.samplingCategory ? "sampled: " + f.samplingCategory : "",
    (f.linkedEvalIds || []).length ? "evals: " + f.linkedEvalIds.length : "",
    (f.linkedRuleIds || []).length ? "rules: " + f.linkedRuleIds.length : "",
  ].filter(Boolean).join(" · ");
  if (detail) { const d = document.createElement("div"); d.className = "mtop"; d.textContent = detail; it.appendChild(d); }
  if (f.correctedOutput) { const d = document.createElement("div"); d.className = "mtop"; d.textContent = "lesson: " + String(f.correctedOutput).slice(0, 140); it.appendChild(d); }
  it.appendChild(acts); return it;
}
// A7 completion: the fine-tuning candidate queue tab (store/endpoints landed in Group A; the tab
// itself never did). Candidates need explicit approval here before any training use.
function renderFinetune(t) {
  const it = document.createElement("div"); it.className = "mitem";
  const top = document.createElement("div"); top.className = "mtop";
  top.append(badge(t.source.replace(/_/g, " ")), badge(t.status, t.status === "candidate" ? "pending" : t.status === "rejected" ? "rejected" : ""));
  const c = document.createElement("div"); c.className = "mc"; c.textContent = (t.input || "").slice(0, 160) + (t.idealOutput ? "\n→ " + String(t.idealOutput).slice(0, 120) : "");
  const acts = document.createElement("div"); acts.className = "macts";
  if (t.status === "candidate") acts.append(mkAct("Approve", () => fUpdate("/finetune/update", { id: t.id, status: "approved" })), mkAct("Reject", () => fUpdate("/finetune/update", { id: t.id, status: "rejected" })));
  acts.append(mkAct("Delete", () => fUpdate("/finetune/delete", { id: t.id })));
  it.append(top, c, acts); return it;
}
function renderEval(e) {
  const it = document.createElement("div"); it.className = "mitem";
  const top = document.createElement("div"); top.className = "mtop";
  top.append(badge(e.category), Object.assign(document.createElement("span"), { textContent: e.latestScore == null ? "not run" : "score " + e.latestScore + "/10" }), Object.assign(document.createElement("span"), { textContent: "src:" + e.source }));
  const c = document.createElement("div"); c.className = "mc"; c.textContent = e.title;
  const acts = document.createElement("div"); acts.className = "macts";
  acts.append(mkAct("Run", async (ev) => { const b = ev && ev.target; if (b) { b.textContent = "running…"; } const r = await aApi("/evals/run", { id: e.id }); alert(r.run ? `Score ${r.run.score}/10 · ${r.run.passed ? "PASS" : "FAIL"}\n\n${(r.output || "").slice(0, 400)}` : "Run failed"); loadImprove(); }), mkAct("Delete", () => fUpdate("/evals/delete", { id: e.id })));
  it.append(top, c, acts); return it;
}
function renderRule(r) {
  const it = document.createElement("div"); it.className = "mitem";
  const top = document.createElement("div"); top.className = "mtop";
  top.append(badge(r.scope), badge(r.status, r.status === "active" ? "" : "pending"));
  if (typeof r.evalDelta === "number") top.append(badge((r.evalDelta > 0 ? "+" : "") + r.evalDelta + " on evals", r.evalDelta < 0 ? "rejected" : ""));
  const c = document.createElement("div"); c.className = "mc"; c.textContent = r.content;
  const acts = document.createElement("div"); acts.className = "macts";
  acts.append(
    mkAct(r.status === "active" ? "Retire" : "Activate", () => fUpdate("/rules/update", { id: r.id, status: r.status === "active" ? "retired" : "active" })),
    mkAct("Test", async (ev) => { const b = ev && ev.target; if (b) b.textContent = "testing… (minutes)"; const d = await aApi("/rules/test", { id: r.id }); alert(d.error ? "Test: " + d.error : "Δ " + d.delta + " — " + d.verdict + "\n\n" + d.results.map((x) => `${x.title}: ${x.before} → ${x.after}`).join("\n")); loadImprove(); }),
    mkAct("Delete", () => fUpdate("/rules/delete", { id: r.id })),
  );
  it.append(top, c, acts); return it;
}
async function fUpdate(path, body) { await aApi(path, body); loadImprove(); }
async function addImprove() {
  const v = (iadd.value || "").trim(); if (!v) return;
  if (itab === "ledger") await aApi("/ledger", { category: "manual", severity: "low", originalRequest: v, detectedBy: "user" });
  else if (itab === "evals") { const exp = await askText({ kicker: "Evaluation", title: "Expected behavior", placeholder: "What a good answer must do…" }); await aApi("/evals", { title: v.slice(0, 80), input: v, expectedBehavior: exp || "", source: "manual" }); }
  else if (itab === "prompts") {
    const name = await askText({ kicker: "Prompt", title: "Prompt name", multiline: false, value: "house-style", hint: "Same name = a new version of that prompt.", saveLabel: "Next →" }); if (name == null) return;
    const scope = await askText({ kicker: "Prompt", title: "Scope", multiline: false, value: "global", hint: "One of: global, mode, tool, mentor, router.", saveLabel: "Next →" }) || "global";
    const why = await askText({ kicker: "Prompt", title: "Reason for this prompt", multiline: false, placeholder: "Optional…", saveLabel: "Save" }) || "";
    await aApi("/prompts", { name: name.trim() || "unnamed", scope: scope.trim(), content: v, changeReason: why });
  }
  else if (itab === "finetune") {
    const ideal = await askText({ kicker: "Finetune", title: "Ideal output", placeholder: "What the model SHOULD produce for this input…" }); if (ideal == null) return;
    await aApi("/finetune", { input: v, idealOutput: ideal, source: "user_authored_instruction" });
  }
  else await aApi("/rules", { content: v, scope: "global", status: "candidate" });
  iadd.value = ""; loadImprove();
}

// ---------- pre-send cost estimate chip (docs/CLOUD-MIGRATION.md §6) ----------
// A live, deterministic preflight (/estimate — no model call): what THIS turn costs before you send.
// Debounced on typing; superseded-by-newer-keystroke guard; hides while empty or streaming.
let estTimer = null, estSeq = 0;
function scheduleEstimate() { if (estTimer) clearTimeout(estTimer); estTimer = setTimeout(updateEstimate, 350); }
function hideCostChip() { if (costChip) costChip.hidden = true; }
async function updateEstimate() {
  if (!costChip) return;
  const text = input.value.trim();
  if ((!text && !pendingAtt.length) || busyFor(curId)) { hideCostChip(); return; }
  const c = cur();
  const history = c ? c.messages.map((m) => ({ role: m.role, content: m.content })) : [];
  history.push({ role: "user", content: text });
  // Pictures ride the estimate as a COUNT only (the server prices them at a flat per-image token
  // figure); the chip also mirrors the vision gate so a doomed send says so before the tap.
  // Staged file text (a 40-page PDF is real tokens) rides as a CHAR COUNT, never the bytes.
  const attachChars = pendingAtt.reduce((n, a) => n + (a.kind === "text" && a.text ? a.text.length : 0), 0);
  const payload = { messages: history, mode: modeSel ? modeSel.value : "auto", model: forcedModel() || "auto", privacyMode: privacyModeSel ? privacyModeSel.value : "normal", images: attImages(), attachChars };
  const seq = ++estSeq;
  // No cost talk while typing (Fred, 2026-07-18): the preflight still runs silently so a DOOMED
  // send (vision gate, privacy block) can warn before the tap, but numbers wait for the answer.
  let est;
  try {
    const r = await fetch("/estimate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    est = await r.json();
  } catch { if (seq === estSeq) hideCostChip(); return; }
  if (seq !== estSeq) return;                       // a newer keystroke already superseded this
  if (busyFor(curId) || (!input.value.trim() && !pendingAtt.length)) { hideCostChip(); return; }
  renderCostChip(est);
}
function renderCostChip(est) {
  // Warnings only: the chip appears ONLY when this send would be refused (vision gate, privacy
  // block). Costs and tokens now report once per exchange, under the finished answer.
  if (!costChip || !est || est.backend !== "blocked") { hideCostChip(); return; }
  const label = est.blocked === "attachments_unsupported" ? "Blocked · model can't see pictures" : "Blocked · " + (privacyModeSel ? privacyModeSel.value : "") + " mode";
  costChip.className = "cost-chip cc-cold";
  costChip.innerHTML = `<span class="cc-dot"></span><span class="cc-cost">${escapeHtml(label)}</span>`;
  costChip.hidden = false;
}

// ---------- wire up ----------
input.addEventListener("input", () => {
  autosize();
  captureChatDraft();
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => persistChatComposer(), 350);
});
input.addEventListener("input", scheduleEstimate);
// Desktop (mouse) sends on Enter; phone/touch lets Enter insert a newline (use the send button).
const enterSends = !(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && enterSends) { e.preventDefault(); send(); } });
sendBtn.addEventListener("click", send);
menuBtn.addEventListener("click", () => (sidebar.classList.contains("open") ? closeSidebar() : openSidebar()));
// Setup door in the rail: connectors + credits. Everyone gets their own setup page (the page
// itself renders owner vs guest panels by role; the server enforces owner-only endpoints).
const sbSetup = $("sb-setup");
if (sbSetup) sbSetup.addEventListener("click", () => { location.href = "/setup"; });
// Guides open in a new tab: the browser shows the PDF as directions and offers a download.
const openGuide = (path) => { try { window.open(path, "_blank", "noopener"); } catch { location.href = path; } };
const sbQuick = $("sb-quickstart");
if (sbQuick) sbQuick.addEventListener("click", () => openGuide("/guides/Dominion-AI-QuickStart.pdf"));
const sbManual = $("sb-manual");
if (sbManual) sbManual.addEventListener("click", () => openGuide("/guides/Dominion-AI-Manual.pdf"));
// Guests never see the Private/Local lane: the local model is owner-only (the server already
// refuses it; offering a dead option would just confuse a paying guest). Owner path unchanged.
fetch("/account").then((r) => r.json()).then((a) => {
  if (a && a.multiTenant && !a.isOwner && privacyModeSel) {
    const opt = privacyModeSel.querySelector('option[value="private"]');
    if (opt) opt.remove();
    if (privacyModeSel.value === "private" || (localStorage.getItem(LS_PMODE) || "") === "private") {
      try { localStorage.setItem(LS_PMODE, "normal"); } catch {}
      privacyModeSel.value = "normal";
      privacyModeSel.dispatchEvent(new Event("change"));
    }
  }
}).catch(() => {});
overlay.addEventListener("click", closeSidebar);
newBtn.addEventListener("click", newChat);
if (chatSearch) chatSearch.addEventListener("input", () => { chatQuery = chatSearch.value || ""; renderSidebar(); });
if (modeSel) modeSel.addEventListener("change", () => { try { localStorage.setItem(LS_MODE, modeSel.value); } catch {} updateEstimate(); });
// Privacy mode persists, re-filters the picker to the allowed providers, and refreshes the estimate.
if (privacyModeSel) privacyModeSel.addEventListener("change", () => { try { localStorage.setItem(LS_PMODE, privacyModeSel.value); } catch {} applyPrivacyFilter(); updateEstimate(); updateAttachGate(); explainPrivacy(privacyModeSel.value); });
// Why the privacy dial matters (Fred, 2026-07-18): the selector decides WHERE your words may
// travel. Explain it in place the moment it's touched, not in a manual nobody opens.
const PRIVACY_NOTES = {
  normal: "Normal: any model, any provider. Fine for everyday questions with nothing sensitive in them.",
  trusted: "Trusted: only providers with the strictest data-retention terms (OpenAI, Anthropic) plus the local engine. Use it for business details, client names, and money.",
  private: "Private: nothing leaves this machine; local model only. Use it for secrets, credentials, legal matters, or anything you would not put in an email.",
};
function explainPrivacy(mode) {
  const text = PRIVACY_NOTES[mode];
  if (!text) return;
  document.querySelector(".privacy-note")?.remove();
  const n = document.createElement("div");
  n.className = "privacy-note";
  n.innerHTML = "<b>Privacy dial</b> — it controls where your words are allowed to travel.<br>" + text;
  document.body.appendChild(n);
  setTimeout(() => { n.classList.add("gone"); setTimeout(() => n.remove(), 400); }, 8000);
  n.addEventListener("click", () => n.remove());
}
if (privacyModeSel) privacyModeSel.addEventListener("pointerdown", () => {
  if (!explainPrivacy._seen) { explainPrivacy._seen = true; explainPrivacy(privacyModeSel.value); }
}, { passive: true });
// The pick belongs to the open chat. LS_MODEL remains only the default inherited by a NEW chat;
// switching an existing chat restores its own model and never borrows the last chat's selection.
if (modelSel) modelSel.addEventListener("change", () => {
  try { localStorage.setItem(LS_MODEL, modelSel.value); } catch {}
  const c = cur();
  if (c && c.model !== modelSel.value) {
    c.model = modelSel.value;
    touchChatComponent(c, "modelUpdatedAt");
    save();
    if (!busyFor(c.id)) { renderTranscript(); scroll(); }
  }
  updateModelTrigger(); updateCloudBadge(); updateEstimate(); updateAttachGate(); modelLaser();
});
// Selection ceremony: a green laser races the trigger's border, then the model name flares and
// settles. Pure class choreography; the CSS lives in dominion-tenant.css.
function modelLaser() {
  if (!modelTrigger || !modelCurrent) return;
  modelTrigger.classList.remove("laser"); modelCurrent.classList.remove("name-flare");
  void modelTrigger.offsetWidth;   // retrigger
  modelTrigger.classList.add("laser");
  setTimeout(() => { modelTrigger.classList.remove("laser"); modelCurrent.classList.add("name-flare"); }, 900);
  setTimeout(() => modelCurrent.classList.remove("name-flare"), 2600);
}
// Attachments: button opens the picker; picked/pasted/dropped files stage into the strip.
if (attachBtn && attachFile) {
  attachBtn.addEventListener("click", () => attachFile.click());
  attachFile.addEventListener("change", async () => { await addFiles(attachFile.files); attachFile.value = ""; });
}
input.addEventListener("paste", (e) => {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) { e.preventDefault(); addFiles(files); }
});
{
  const footer = document.querySelector("#neural-glass footer") || document.body;
  footer.addEventListener("dragover", (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); footer.classList.add("att-drag"); } });
  footer.addEventListener("dragleave", () => footer.classList.remove("att-drag"));
  footer.addEventListener("drop", (e) => { footer.classList.remove("att-drag"); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
}
settingsBtn.addEventListener("click", openSettings);
sclose.addEventListener("click", closeSettings);
ssave.addEventListener("click", saveSettingsUI);
smodal.addEventListener("click", (e) => { if (e.target === smodal) closeSettings(); });
memBtn.addEventListener("click", openMemory);
mclose.addEventListener("click", closeMemory);
msave.addEventListener("click", addMemory);
mmodal.addEventListener("click", (e) => { if (e.target === mmodal) closeMemory(); });
if (mfilterStatus) mfilterStatus.addEventListener("change", loadMemory);
toolsBtn.addEventListener("click", () => openTools());   // unfiltered (a click event is not a filter)
tclose.addEventListener("click", closeTools);
tmodal.addEventListener("click", (e) => { if (e.target === tmodal) closeTools(); });
artifactsBtn.addEventListener("click", openArtifacts);
aclose.addEventListener("click", closeArtifacts);
amodal.addEventListener("click", (e) => { if (e.target === amodal) closeArtifacts(); });
improveBtn.addEventListener("click", openImprove);
iclose.addEventListener("click", closeImprove);
imodal.addEventListener("click", (e) => { if (e.target === imodal) closeImprove(); });
if (personaBtn) {
  personaBtn.addEventListener("click", openPersona);
  pclose.addEventListener("click", closePersona);
  pmodal.addEventListener("click", (e) => { if (e.target === pmodal) closePersona(); });
  paddbtn.addEventListener("click", addPersonaText);
  pscrape.addEventListener("click", scrapePersona);
  pscan.addEventListener("click", scanPersonaInbox);
  pdistill.addEventListener("click", distillProfile);
  pfilterKind.addEventListener("change", loadPersonaList);
}
iaddbtn.addEventListener("click", addImprove);
document.querySelectorAll(".itab").forEach((el) => el.addEventListener("click", () => setITab(el.dataset.tab)));
personaSel.addEventListener("change", () => { personaCustom.hidden = personaSel.value !== "custom"; });
tempInput.addEventListener("input", () => { tempVal.textContent = tempInput.value; });
// Durable-turn resume: coming back to the app reattaches the on-screen run AND reconciles with the
// server (adopting runs from other devices, delivering finished background runs). Reconcile is
// throttled so a rapid visible/hidden flicker doesn't spam /chat/jobs.
document.addEventListener("visibilitychange", () => { if (!document.hidden) { maybeReattach(); if (Date.now() - lastReconcile > 10000) reconcileJobs(); } });
window.addEventListener("pageshow", () => { maybeReattach(); reconcileJobs(); });
// Heartbeat reconcile (Fred, 2026-07-30): a run the server sealed (deploy cutover, restart) must
// read as DEAD within seconds even when the tab never changed visibility — he pulled the alarm on
// a chat that had been dead 16 minutes while the screen still looked alive. Cheap when idle.
setInterval(() => {
  try { if (Object.keys(liveJobs || {}).length) { maybeReattach(); if (Date.now() - lastReconcile > 15000) reconcileJobs(); } } catch {}
}, 20000);

load(); renderAll(); fetchBudget(); loadModels().then(() => { renderPace(); renderAll(); }, renderPace); autosize();
// Re-measure the vertical tracks after the real typeface arrives and whenever the chat field
// changes height. Skip active streams so a resize never removes their in-progress bubble.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!busyFor(curId)) renderTranscript(); });
let modelLedgerResizeTimer = null;
let modelLedgerViewportWidth = window.innerWidth;
window.addEventListener("resize", () => {
  // Opening or closing a phone keyboard changes viewport HEIGHT many times during its animation.
  // Rebuilding the transcript on every one of those frames made the page jump under the focused
  // composer. The ledger only needs a new measurement when its available WIDTH actually changes.
  const nextWidth = window.innerWidth;
  if (Math.abs(nextWidth - modelLedgerViewportWidth) < 2) return;
  modelLedgerViewportWidth = nextWidth;
  clearTimeout(modelLedgerResizeTimer);
  modelLedgerResizeTimer = setTimeout(() => { if (!busyFor(curId)) renderTranscript(); }, 120);
});
renderPace();   // the saved model/mode/dial can already be a slow combination on the first paint
maybeReattach();   // an answer may still be generating server-side from before this (re)load
reconcileJobs();   // adopt/deliver any runs the server knows about that this device doesn't
// Pull whatever the other device did before this one was opened. A brand-new device (lastRev 0)
// receives the whole account here, which is the phone-to-laptop handoff.
scheduleSync(400);
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

// ---- update watcher ----
// This tab can stay open for days, and an installed PWA RESUMES its frozen page rather than
// reloading, so a deploy never reaches a running app unless something in here reloads it. Poll
// the server's build id and reload once it changes.
//
// THE DEADLOCK THIS REPLACES (Fred, 2026-07-28: "hard refresh literally never works, only
// clearing data updates the app"): the old guard deferred while ANY chat had a live run, and on
// Fred's devices some long detached job nearly always exists, so the pending reload waited
// forever and every deploy died in the queue. Wrong guard: detached jobs are DESIGNED to survive
// a reload (journal, replay, reattach); only the chat visibly streaming on screen deserves a
// courtesy wait, and even that gets a hard deadline rather than a veto.
let lastBuild = null, pendingSince = 0;
async function doReload() {
  try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch {}
  try { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch {}
  location.reload();
}
const RELOAD_WAIT_MAX_MS = 10 * 60 * 1000;   // a visible stream defers the update, never vetoes it
const visibleChatStreaming = () => { try { return busyFor(curId); } catch { return false; } };
function maybeReload() {
  if (!pendingSince) return;
  if (!visibleChatStreaming() || Date.now() - pendingSince > RELOAD_WAIT_MAX_MS) doReload();
}
async function checkVersion() {
  try {
    const r = await fetch("/api/version", { cache: "no-store" });
    if (!r.ok) return;
    const { build } = await r.json();
    if (!build) return;
    if (lastBuild === null) { lastBuild = build; return; }
    if (build !== lastBuild && !pendingSince) pendingSince = Date.now();
    maybeReload();
  } catch {}
}
setInterval(() => { if (pendingSince) maybeReload(); else checkVersion(); }, 90000);
// Resuming the app is the moment the user expects freshness: check immediately, and a pending
// update applies right away (they were not mid-read; they just arrived).
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });
checkVersion();

// ---------- voice (Phase D): OpenAI ears + mouth, the PICKED model as the brain ----------
// Tap mic -> record; tap again -> stop -> /api/voice/transcribe (OpenAI STT on the box) -> the
// transcript auto-sends through the normal /chat flow (whatever model is picked, tools included).
// The speaker toggle speaks finished answers via /api/voice/tts. Voice I/O is OpenAI; the brain
// stays Fred's choice — that's the point of Dominion.
const micBtn = $("mic"), speakBtn = $("speak");
const LS_SPEAK = "dominion.speak.v1";
let speakOn = false; try { speakOn = localStorage.getItem(LS_SPEAK) === "1"; } catch {}
let rec = null, recChunks = [], recStream = null;

function paintSpeak() {
  if (!speakBtn) return;
  speakBtn.classList.toggle("speakon", speakOn);
  speakBtn.innerHTML = speakOn
    ? '<span class="spk-ic">&#128266;</span><span class="spk-state">ON</span>'
    : '<span class="spk-ic">&#128264;</span>';
  speakBtn.title = "Auto-speak every answer (" + (speakOn ? "on" : "off") + ")";
}
if (speakBtn) { paintSpeak(); speakBtn.addEventListener("click", () => {
  speakOn = !speakOn; try { localStorage.setItem(LS_SPEAK, speakOn ? "1" : "0"); } catch {}
  paintSpeak(); if (!speakOn) voice.stop();   // turning auto-speak off stops what is playing now
}); }

// A small status chip above the composer for the two mic phases. Recording shows a running clock
// (you cannot tell a live mic from a dead one otherwise); transcribing shows an indeterminate
// state. Both were previously invisible, which is what "it feels like it is hanging" meant.
let micTimer = null, micT0 = 0;
function micStatus(label, withClock) {
  let chip = document.getElementById("mic-status");
  if (!label) {
    if (micTimer) { clearInterval(micTimer); micTimer = null; }
    if (chip) chip.hidden = true;
    return;
  }
  if (!chip) {
    chip = document.createElement("div");
    chip.id = "mic-status"; chip.className = "mic-status";
    const bar = document.querySelector(".bar");
    if (bar && bar.parentElement) bar.parentElement.insertBefore(chip, bar); else document.body.appendChild(chip);
  }
  chip.hidden = false;
  chip.dataset.mode = withClock ? "rec" : "work";
  const paint = () => {
    const secs = withClock ? Math.floor((Date.now() - micT0) / 1000) : 0;
    chip.innerHTML = '<i class="mic-status-dot"></i><span>' + label + "</span>" +
      (withClock ? '<b>' + Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0") + "</b>" : "");
  };
  if (micTimer) { clearInterval(micTimer); micTimer = null; }
  if (withClock) { micT0 = Date.now(); paint(); micTimer = setInterval(paint, 1000); } else paint();
}

/* ARSENAL Wave 4: when the server's transcription lane dies (OpenAI quota being the standing
 * cause), the device's own speech recognition takes over for the rest of the session — free,
 * on-device, announced in the status chip as "(device)". If the device lane itself errors, the
 * next tap goes back to the server, which may have recovered. Never silent either way. */
let sttDevice = false;      // sticky for the session once the server lane fails
let deviceRec = null;       // live SpeechRecognition handle (second tap stops it)
function deviceRecognizerAvailable() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
function deviceMicTap() {
  if (deviceRec) { try { deviceRec.stop(); } catch {} return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const r = new SR();
  deviceRec = r;
  r.lang = navigator.language || "en-US";
  r.interimResults = true;
  r.continuous = true;
  let finalText = "";
  const oldPlaceholder = input.placeholder;
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t; else interim += t;
    }
    input.value = (finalText + " " + interim).trim();
    autosize();
  };
  r.onerror = (e) => {
    // not-allowed/no-speech etc.: report, and let the SERVER lane try again next tap.
    sttDevice = false;
    showErr("Device transcription failed (" + (e.error || "error") + "). Next tap uses the server again.");
  };
  r.onend = () => {
    deviceRec = null;
    micBtn.classList.remove("rec");
    micStatus("");
    input.placeholder = oldPlaceholder;
    input.value = finalText.trim() || input.value;
    captureChatDraft(); autosize();
    if (input.value.trim() && !busyFor(curId)) send();
  };
  try { r.start(); } catch { deviceRec = null; sttDevice = false; showErr("Device transcription could not start."); return; }
  micBtn.classList.add("rec");
  micStatus("Listening (device)… tap to finish", true);
  input.placeholder = "Listening on your device… tap the mic again to finish.";
}

async function micTap() {
  if (!micBtn) return;
  if (sttDevice && deviceRecognizerAvailable()) { deviceMicTap(); return; }
  if (rec && rec.state === "recording") { rec.stop(); return; }   // second tap = stop -> transcribe -> send
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    if (deviceRecognizerAvailable()) { sttDevice = true; deviceMicTap(); return; }
    showErr("Voice input isn't supported in this browser."); return;
  }
  try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { showErr("Microphone permission denied — allow the mic for this site."); return; }
  // Chrome/Android = webm+opus; iOS Safari = mp4. The server forwards whatever mime it gets.
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
  recChunks = [];
  try { rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined); }
  catch { showErr("Couldn't start the recorder."); try { recStream.getTracks().forEach((t) => t.stop()); } catch {} return; }
  rec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  rec.onstop = async () => {
    try { recStream.getTracks().forEach((t) => t.stop()); } catch {}
    micBtn.classList.remove("rec"); micBtn.classList.add("busy");
    // The placeholder alone was not enough: it is easy to miss, and .busy only DIMMED the button,
    // which looks identical to "disabled and broken". The mic now carries a live spinner ring for
    // the whole transcribe round trip, so there is always something moving while you wait.
    const oldPlaceholder = input.placeholder;
    input.placeholder = "Transcribing your voice…";
    micStatus("Transcribing…");
    try {
      const blob = new Blob(recChunks, { type: (rec && rec.mimeType) || mime || "audio/webm" });
      if (blob.size < 1000) { showErr("Didn't catch that — recording was too short."); return; }
      const r = await fetch("/api/voice/transcribe", { method: "POST", headers: { "content-type": blob.type || "audio/webm" }, body: blob });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.text) {
        // Server lane down: flip this session to the device's own recognition, and SAY so.
        if (j && j.fallback === "device" && deviceRecognizerAvailable()) {
          sttDevice = true;
          showErr("Server transcription is down (" + (j.reason || "OpenAI error") + "). Tap the mic again — your device will transcribe on its own, free.");
          return;
        }
        showErr((j && j.error) || "Transcription failed — try again.");
        return;
      }
      input.value = j.text; captureChatDraft(); autosize();
      if (!busyFor(curId)) send();   // straight through the normal flow: picked model, tools, the works
    } finally { micBtn.classList.remove("busy"); micStatus(""); rec = null; input.placeholder = oldPlaceholder; }
  };
  rec.start();
  micBtn.classList.add("rec");
  micStatus("Listening… tap to finish", true);
  input.placeholder = "Listening… tap the mic again to finish.";
}
if (micBtn) micBtn.addEventListener("click", micTap);

// FIRE ALARM button removed from the command rail (Fred, 2026-07-30). The server endpoint
// POST /chat/fire-alarm stays as an owner API escape hatch; per-turn Stop remains in the UI.

// ---------- the voice player (Fred, 2026-07-19) ----------
// Three complaints, one object. (1) Hitting speak felt like the app hung: generating a minute of
// audio takes seconds and NOTHING said so. (2) Once it started there was no way to stop it, so you
// sat through the whole answer. (3) Every call was fire-and-forget, so overlapping taps could
// stack two voices on top of each other.
//
// So: one player, one audio element, one visible transport bar. Every state the user can be in
// (preparing / speaking / paused) is on screen with a control that acts on it. The bar is the
// progress indicator AND the stop button, which is why it appears the instant a request starts
// rather than when audio is ready.
const VOICE_PREF = "dominion.voice.name.v1";
function voicePref() { try { return localStorage.getItem(VOICE_PREF) || ""; } catch { return ""; } }

const voice = (() => {
  let audio = null;            // the HTMLAudioElement for the CHUNK currently sounding
  let token = 0;               // bumped on every start and stop, so a slow response from a
                               // cancelled request can never come back and hijack the player
  let source = null;           // the .bspeak button that started this, for its lit state
  let bar = null, els = null;
  let currentText = "";
  let queue = [], queueAt = 0; // chunk texts, and which one is sounding
  let truncated = false;       // only when an answer exceeds CHUNK_CEILING, and it is announced
  let device = false;          // ARSENAL Wave 4: true while the DEVICE's own voice is reading
                               // (server TTS down) — announced on the bar, never silent
  let deviceUtter = null;      // the utterance currently sounding, for pause/resume state

  // Synthesis latency is LINEAR in characters: measured on this account at ~9.4ms/char, so a
  // 4000-character answer is ~37 seconds of silence before the first word. A spinner does not fix
  // a 37 second wait. Chunking does: we synthesize ~450 characters at a time (~4s), start speaking
  // as soon as chunk one lands, and generate the rest while it plays. Time-to-first-word becomes
  // roughly constant instead of proportional to answer length.
  // Split on sentence ends so a chunk boundary never lands mid-clause, which you WOULD hear.
  const CHUNK = 450;
  // Hard ceiling per REQUEST, not per answer. OpenAI's speech endpoint takes 4096 characters and
  // the box caps a request at 4000, so no single chunk may cross this. Sentence splitting alone
  // does not guarantee that: one unpunctuated wall of text (a long list, a pasted table) is a
  // single "sentence" and would sail past the cap and be truncated server-side, which is exactly
  // the silent cut we are removing. Anything oversized gets hard-wrapped at word boundaries.
  const CHUNK_MAX = 900;
  function hardWrap(s) {
    if (s.length <= CHUNK_MAX) return [s];
    const parts = [], words = s.split(/(\s+)/);
    let buf = "";
    for (const w of words) {
      if (buf && (buf.length + w.length) > CHUNK_MAX) { parts.push(buf.trim()); buf = ""; }
      buf += w;
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
  }
  function splitForSpeech(t) {
    const out = [];
    const sentences = String(t).match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) || [String(t)];
    let buf = "";
    for (const s of sentences) {
      if (buf && (buf.length + s.length) > CHUNK) { out.push(buf.trim()); buf = ""; }
      buf += s;
    }
    if (buf.trim()) out.push(buf.trim());
    return out.flatMap(hardWrap).filter(Boolean);
  }

  function build() {
    if (bar) return;
    bar = document.createElement("div");
    bar.className = "voice-bar";
    bar.hidden = true;
    bar.innerHTML =
      '<button type="button" class="vb-play" aria-label="Pause or resume"></button>' +
      '<div class="vb-body"><div class="vb-top"><b class="vb-state"></b><small class="vb-time"></small></div>' +
      '<div class="vb-track"><i></i></div></div>' +
      '<button type="button" class="vb-stop" aria-label="Stop speaking">&#10005;</button>';
    document.body.appendChild(bar);
    els = {
      play: bar.querySelector(".vb-play"), stop: bar.querySelector(".vb-stop"),
      state: bar.querySelector(".vb-state"), time: bar.querySelector(".vb-time"),
      fill: bar.querySelector(".vb-track i"),
    };
    els.play.onclick = () => {
      if (device) {
        try { if (speechSynthesis.paused) speechSynthesis.resume(); else speechSynthesis.pause(); } catch {}
        paint();
        return;
      }
      if (!audio) return;
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
      paint();
    };
    els.stop.onclick = () => stop();
  }

  const mmss = (s) => (isFinite(s) && s >= 0 ? Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0") : "0:00");

  function paint(state) {
    build();
    const s = state || (device
      ? ((() => { try { return speechSynthesis.paused ? "paused" : "speaking"; } catch { return "speaking"; } })())
      : (!audio ? "preparing" : audio.paused ? "paused" : "speaking"));
    bar.hidden = false;
    bar.dataset.state = s;
    const many = queue.length > 1;
    els.state.textContent = (s === "preparing" ? "PREPARING VOICE" : s === "paused" ? "PAUSED" : "SPEAKING")
      + (device ? "  · DEVICE VOICE" : "")
      + (many ? "  " + (queueAt + 1) + "/" + queue.length : "")
      + (truncated ? "  LONG ANSWER" : "");
    els.play.innerHTML = s === "speaking" ? "&#10074;&#10074;" : "&#9654;";
    els.play.disabled = s === "preparing";
    if (audio && isFinite(audio.duration) && audio.duration > 0) {
      // Progress spans the WHOLE answer, not the current chunk: a bar that resets to zero every
      // few seconds tells the user nothing about how much is left.
      const within = audio.currentTime / audio.duration;
      els.time.textContent = mmss(audio.currentTime) + " / " + mmss(audio.duration);
      els.fill.style.width = Math.min(100, ((queueAt + within) / Math.max(1, queue.length)) * 100) + "%";
    } else {
      els.time.textContent = "";
      els.fill.style.width = "";
    }
    if (source) source.classList.add("bspeak-active");
  }

  function dropAudio() {
    if (audio) {
      try { audio.pause(); } catch {}
      audio.onended = audio.ontimeupdate = audio.onloadedmetadata = null;
      if (audio.src && audio.src.startsWith("blob:")) { try { URL.revokeObjectURL(audio.src); } catch {} }
    }
    audio = null;
  }

  function teardown() {
    dropAudio();
    if (device) { try { speechSynthesis.cancel(); } catch {} }
    device = false; deviceUtter = null;
    queue = []; queueAt = 0; currentText = ""; truncated = false;
    if (source) { source.classList.remove("bspeak-active"); source = null; }
    if (bar) { bar.hidden = true; bar.dataset.state = ""; }
  }

  function stop() { token++; teardown(); }

  // No length cap on the ANSWER (Fred, 2026-07-19: "it cut off the response ... reads back half of
  // it without any explanation at all"). This used to slice(0, 4000), which is where that came
  // from: a long answer was chopped mid-sentence and nothing said so. That cap only made sense
  // when the whole answer went out as ONE request against OpenAI's 4096-character limit. Now that
  // playback is chunked, the per-request limit is a property of a chunk, not of the answer, so
  // there is nothing left to truncate. Length is bounded by CHUNK_CEILING below instead, and when
  // that bites the user is TOLD, out loud and on the bar. Never re-add a silent slice here.
  const norm = (t) => String(t || "").replace(/```[\s\S]*?```/g, " . code omitted . ").trim();
  // A sane stop on runaway length: ~90 chunks is roughly 40,000 characters, call it 45 minutes of
  // speech. Past that we read what we can and say so rather than pretending that was the whole
  // thing. This is a spoken-length guard, not a truncation of the answer on screen.
  const CHUNK_CEILING = 90;
  const isSpeaking = (text) => !!(bar && !bar.hidden) && currentText === norm(text);

  // One chunk to one object URL. Returns "" on failure so the caller can report it once.
  async function fetchChunk(text, mine) {
    const r = await fetch("/api/voice/tts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: voicePref() || undefined }),
    });
    if (mine !== token) return "";
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      const e = new Error((j && j.error) || ("HTTP " + r.status));
      e.reason = (j && j.reason) || "";
      e.deviceFallback = !!(j && j.fallback === "device");
      throw e;
    }
    const blob = await r.blob();
    if (mine !== token) return "";
    return URL.createObjectURL(blob);
  }

  /* ARSENAL Wave 4: the free backup lane. NVIDIA's free speech models turned out to be
   * gRPC-only (probed 2026-07-29), so the free voice that actually exists everywhere is the
   * device's own speech synthesis: no key, no quota, no network. When the server's TTS fails,
   * the remaining chunks are read by the device, the bar says DEVICE VOICE, and a one-time
   * note names the reason. Never silent, never stacked (same token discipline). */
  let deviceNoteShown = false;
  function playDeviceChunk(text, mine) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      deviceUtter = u;
      u.onend = () => resolve(true);
      u.onerror = () => resolve(false);
      try { speechSynthesis.speak(u); } catch { resolve(false); return; }
      if (mine === token) paint("speaking");
    });
  }
  async function deviceFallback(mine, reason) {
    if (!("speechSynthesis" in window)) return false;
    device = true;
    if (!deviceNoteShown) {
      deviceNoteShown = true;
      showErr("Server voice is down (" + (reason || "OpenAI error") + "). Your device's built-in voice is reading instead — free, and it says so on the bar.");
    }
    try { speechSynthesis.cancel(); } catch {}
    for (let i = queueAt; i < queue.length; i++) {
      if (mine !== token) return true;
      queueAt = i;
      paint();
      const finished = await playDeviceChunk(queue[i], mine);
      if (mine !== token) return true;
      if (!finished) return false;
    }
    if (mine === token) teardown();
    return true;
  }

  // Play one chunk to its end. Resolves early (false) if the player was stopped mid-chunk.
  function playChunk(url, mine) {
    return new Promise((resolve) => {
      dropAudio();
      audio = new Audio(url);
      audio.onloadedmetadata = () => paint();
      audio.ontimeupdate = () => { if (mine === token) paint(); };
      audio.onended = () => resolve(true);
      audio.play().then(() => { if (mine === token) paint("speaking"); }).catch(() => {
        showErr("Your browser blocked audio playback. Tap anywhere once, then press speak again.");
        resolve(false);
      });
    });
  }

  async function speak(text, srcBtn) {
    const t = norm(text);
    if (!t) return;
    stop();                       // never stack two voices
    const mine = ++token;
    currentText = t;
    source = srcBtn || null;
    queue = splitForSpeech(t); queueAt = 0;
    // If an answer is long enough to hit the ceiling, say so at the end instead of just stopping.
    // The old behaviour cut at 4000 characters mid-word and left the user to guess.
    truncated = queue.length > CHUNK_CEILING;
    if (truncated) {
      queue = queue.slice(0, CHUNK_CEILING);
      queue.push("That is as far as I will read aloud. The rest of the answer is on screen.");
    }
    paint("preparing");
    try {
      let ahead = fetchChunk(queue[0], mine);   // chunk 1 is already in flight before the loop
      for (let i = 0; i < queue.length; i++) {
        if (mine !== token) return;
        queueAt = i;
        const url = await ahead;
        if (mine !== token || !url) return;
        // Kick off the NEXT chunk before playing this one, so generation overlaps playback and
        // the gap between chunks stays inaudible on anything but the shortest sentences.
        ahead = (i + 1 < queue.length) ? fetchChunk(queue[i + 1], mine) : Promise.resolve("");
        ahead.catch(() => {});    // a later failure is reported when we await it, not here
        const finished = await playChunk(url, mine);
        if (mine !== token || !finished) return;
      }
      if (mine === token) teardown();
    } catch (e) {
      if (mine !== token) return;
      // The server lane died mid-answer. Before giving up, hand the REST of the answer to the
      // device's own voice (free, no quota), announced on the bar and in a one-time note.
      const handled = await deviceFallback(mine, (e && e.reason) || "");
      if (handled) return;
      teardown();
      showErr("Voice failed: " + (e && e.message ? e.message : "could not reach the box") + ".");
    }
  }

  function toggle(text, srcBtn) { if (isSpeaking(text)) stop(); else speak(text, srcBtn); }

  return { speak, stop, toggle, isSpeaking };
})();

// Auto-speak path keeps its old name so callers elsewhere are unchanged.
function speakAnswer(text) { voice.speak(text); }

// Voice picker. The list comes from the server so the box stays the single source of truth about
// which voices exist; the CHOICE is per-device in localStorage, because it is a preference of the
// ear using the phone, not a property of the account.
(async function wireVoicePicker() {
  const sel = document.getElementById("voice-sel"), tryBtn = document.getElementById("voice-try");
  if (!sel) return;
  let cfg = null;
  try { cfg = await (await fetch("/api/voice/config")).json(); } catch {}
  if (!cfg || !Array.isArray(cfg.voices)) { sel.innerHTML = '<option value="">Voice unavailable</option>'; sel.disabled = true; if (tryBtn) tryBtn.disabled = true; return; }
  const saved = voicePref();
  sel.innerHTML = cfg.voices.map((v, i) =>
    '<option value="' + v + '">' + v.charAt(0).toUpperCase() + v.slice(1) +
    (v === cfg.voice ? " (default)" : "") + (i < 2 ? " · most natural" : "") + "</option>").join("");
  sel.value = cfg.voices.includes(saved) ? saved : cfg.voice;
  sel.addEventListener("change", () => {
    try { localStorage.setItem(VOICE_PREF, sel.value); } catch {}
    voice.speak("Voice set to " + sel.value + ". This is how Dominion will read your answers.");
  });
  if (tryBtn) tryBtn.addEventListener("click", () => {
    try { localStorage.setItem(VOICE_PREF, sel.value); } catch {}
    voice.speak("This is " + sel.value + ", reading a sentence at the pace and register Dominion will use for your answers.");
  });
})();

/*
 * Command-bar dropdowns open from ANY click, including the drawn chevron (Fred, 2026-07-26: "the
 * drop down boxes are non-responsive to clicking the arrow, you have to click the bar"). The
 * chevron is a decorative ::after on the wrapping <label>, and the native <select> only fills part
 * of that label, so a click on the arrow landed on the label, which merely FOCUSES a native select
 * rather than opening it. This delegated handler calls showPicker() for a click anywhere on the
 * wrapper, which pops the native dropdown reliably. A direct click on the select itself is left to
 * the browser (it already opens), so nothing double-fires. Scoped away from .model-select, which
 * is a custom JS panel with its own trigger.
 */
(() => {
  document.addEventListener("click", (e) => {
    const wrap = e.target.closest && e.target.closest(".command-select:not(.model-select)");
    if (!wrap) return;
    const sel = wrap.querySelector("select");
    if (!sel || e.target === sel) return;                 // native handles a direct hit on the select
    if (typeof sel.showPicker === "function") { try { sel.showPicker(); return; } catch {} }
    sel.focus();                                          // older engines: at least focus it
  });
})();
