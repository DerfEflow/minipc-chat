// Dominion AI — chat client. Server-side agent loop at /chat (routes models + runs tools).
// Multi-conversation history, per-message actions, persona/temperature, and a Mode selector that
// drives the Phase-1 router (Auto = the server's light model classifies + picks 8B vs 30B).
const $ = (id) => document.getElementById(id);
const wrap = $("wrap"), main = $("main"), input = $("input"), sendBtn = $("send"),
      modelSel = $("model"), modeSel = $("mode"), empty = $("empty"),
      sidebar = $("sidebar"), overlay = $("overlay"), menuBtn = $("menu"), newBtn = $("newchat"), chatlist = $("chatlist"),
      settingsBtn = $("settings"), smodal = $("smodal"), sclose = $("sclose"), ssave = $("ssave"),
      personaSel = $("persona-sel"), personaCustom = $("persona-custom"), tempInput = $("temp"), tempVal = $("temp-val"),
      memBtn = $("memory"), mmodal = $("mmodal"), mclose = $("mclose"), madd = $("madd"), msave = $("msave"),
      mlist = $("mlist"), mstats = $("mstats"), mfilterStatus = $("mfilter-status"),
      toolsBtn = $("tools"), tmodal = $("tmodal"), tclose = $("tclose"), tlist = $("tlist"), tstats = $("tstats"),
      confirmToolsBox = $("confirm-tools"),
      artifactsBtn = $("artifacts"), amodal = $("amodal"), aclose = $("aclose"), alist = $("alist"), adetail = $("adetail"), astats = $("astats"), ahead = $("ahead"),
      improveBtn = $("improve"), imodal = $("imodal"), iclose = $("iclose"), ilist = $("ilist"), istats = $("istats"), iadd = $("iadd"), iaddbtn = $("iaddbtn");

const LS_CHATS = "dominion.chats.v1", LS_CUR = "dominion.cur.v1", LS_MODEL = "minipc-chat.model.v1",
      LS_MODE = "dominion.mode.v1", LS_SET = "dominion.settings.v1", OLD_MSGS = "minipc-chat.messages.v1";

const PRESETS = {
  default: "",
  concise: "Be maximally concise — short, direct answers, minimal preamble.",
  brainstorm: "Act as a sharp brainstorming partner: offer ideas, angles, and honest pushback; think briefly out loud.",
  code: "You are a precise coding assistant: give exact, runnable specifics; for real file changes use forge_send with complete instructions.",
};

let chats = [], curId = null, busy = false, aborter = null;
let settings = { persona: "default", personaCustom: "", temperature: 0.7, confirmTools: false };

// ---------- persistence ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "c" + Date.now() + Math.random().toString(36).slice(2));
const save = () => { try { localStorage.setItem(LS_CHATS, JSON.stringify(chats.slice(0, 100))); localStorage.setItem(LS_CUR, curId || ""); } catch {} };
const saveSettings = () => { try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch {} };
function load() {
  try { const r = localStorage.getItem(LS_CHATS); const a = r && JSON.parse(r); if (Array.isArray(a)) chats = a; } catch {}
  if (!chats.length) { try { const old = JSON.parse(localStorage.getItem(OLD_MSGS) || "null"); if (Array.isArray(old) && old.length) chats = [{ id: uid(), title: titleFrom(old), messages: old, updatedAt: Date.now() }]; } catch {} }
  curId = localStorage.getItem(LS_CUR) || (chats[0] && chats[0].id) || null;
  if (!curId) newChat();
  try { const s = JSON.parse(localStorage.getItem(LS_SET) || "null"); if (s && typeof s === "object") settings = { ...settings, ...s }; } catch {}
  try { const m = localStorage.getItem(LS_MODE); if (m && modeSel) modeSel.value = m; } catch {}
}
const cur = () => chats.find((c) => c.id === curId);
const titleFrom = (msgs) => { const u = msgs.find((m) => m.role === "user"); return (u ? u.content : "New chat").replace(/\s+/g, " ").trim().slice(0, 40) || "New chat"; };
const resolvePersona = () => settings.persona === "custom" ? (settings.personaCustom || "") : (PRESETS[settings.persona] || "");
const forcedModel = () => { const v = modelSel ? modelSel.value : "auto"; return v && v !== "auto" ? v : ""; };

// ---------- chats ----------
function newChat() { if (busy) return; const c = { id: uid(), title: "New chat", messages: [], updatedAt: Date.now() }; chats.unshift(c); curId = c.id; save(); renderAll(); closeSidebar(); input.focus(); }
function switchChat(id) { if (busy) return; curId = id; save(); renderAll(); closeSidebar(); }
function deleteChat(id) { chats = chats.filter((c) => c.id !== id); if (curId === id) curId = (chats[0] && chats[0].id) || null; if (!curId) { newChat(); return; } save(); renderAll(); }
function renameChat(id) { const c = chats.find((x) => x.id === id); if (!c) return; const t = prompt("Rename chat", c.title); if (t != null) { c.title = t.trim().slice(0, 60) || c.title; save(); renderSidebar(); } }

// ---------- sidebar ----------
const openSidebar = () => { sidebar.classList.add("open"); overlay.classList.add("show"); };
const closeSidebar = () => { sidebar.classList.remove("open"); overlay.classList.remove("show"); };
function renderSidebar() {
  chatlist.innerHTML = "";
  for (const c of [...chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
    const row = document.createElement("div"); row.className = "ci" + (c.id === curId ? " active" : "");
    const ttl = document.createElement("div"); ttl.className = "ttl"; ttl.textContent = c.title || "New chat"; ttl.onclick = () => switchChat(c.id);
    const ren = document.createElement("span"); ren.className = "x"; ren.textContent = "✎"; ren.title = "Rename"; ren.onclick = (e) => { e.stopPropagation(); renameChat(c.id); };
    const del = document.createElement("span"); del.className = "x"; del.textContent = "×"; del.title = "Delete"; del.onclick = (e) => { e.stopPropagation(); if (confirm("Delete this chat?")) deleteChat(c.id); };
    row.append(ttl, ren, del); chatlist.appendChild(row);
  }
}

// ---------- rendering ----------
const stripThink = (t) => t.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
const scroll = () => { main.scrollTop = main.scrollHeight; };
function mkAct(label, fn) { const b = document.createElement("button"); b.className = "act"; b.textContent = label; b.onclick = fn; return b; }
async function copyText(t) { try { await navigator.clipboard.writeText(t); } catch { const a = document.createElement("textarea"); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand("copy"); } catch {} a.remove(); } }
function renderMsg(m, i, isLastAi) {
  const turn = document.createElement("div"); turn.className = "turn";
  const row = document.createElement("div"); row.className = "msg " + (m.role === "user" ? "me" : "ai");
  const b = document.createElement("div"); b.className = "bubble"; b.textContent = m.content; row.appendChild(b); turn.appendChild(row);
  const acts = document.createElement("div"); acts.className = "acts" + (m.role === "user" ? " me" : "");
  if (m.role === "user") { acts.append(mkAct("Edit", () => editUser(i)), mkAct("Copy", () => copyText(m.content))); }
  else { acts.appendChild(mkAct("Copy", () => copyText(m.content))); acts.appendChild(mkAct("Save", () => saveAsArtifact(m.content))); acts.appendChild(mkAct("Critique", () => critiqueMessage(i))); if (isLastAi && !busy) acts.appendChild(mkAct("Regenerate", () => regenerate())); }
  turn.appendChild(acts); wrap.appendChild(turn);
}
function renderAll() {
  wrap.querySelectorAll(".turn, .err").forEach((n) => n.remove());
  const c = cur();
  empty.style.display = (c && c.messages.length) ? "none" : "";
  if (c) {
    let lastAi = -1; for (let i = c.messages.length - 1; i >= 0; i--) if (c.messages[i].role === "assistant") { lastAi = i; break; }
    c.messages.forEach((m, i) => renderMsg(m, i, i === lastAi));
  }
  renderSidebar(); scroll();
}
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px"; }
function showErr(t) { document.querySelector(".err")?.remove(); const e = document.createElement("div"); e.className = "err"; e.textContent = t; wrap.appendChild(e); scroll(); }

// ---------- models (advanced override; the router picks by default) ----------
async function loadModels() {
  if (!modelSel) return;
  try {
    const r = await fetch("/ollama/v1/models", { cache: "no-store" }); if (!r.ok) return;
    const ids = ((await r.json()).data || []).map((m) => m.id || m.name).filter(Boolean);
    const FRIENDLY = { "qwen3:8b": "Fast", "qwen3:30b-a3b": "Deep" };
    modelSel.innerHTML = "<option value='auto'>Auto (recommended)</option>";
    for (const id of ids) { const o = document.createElement("option"); o.value = id; o.textContent = FRIENDLY[id] || id.replace(/:.*$/, ""); modelSel.appendChild(o); }
    const saved = localStorage.getItem(LS_MODEL);
    modelSel.value = (saved && (saved === "auto" || ids.includes(saved))) ? saved : "auto";
  } catch {}
}

// ---------- agent loop over SSE ----------
function setBusy(on) { busy = on; sendBtn.classList.toggle("stop", on); sendBtn.innerHTML = on ? "&#9632;" : "&#8593;"; sendBtn.title = on ? "Stop" : "Send"; }

async function streamReply(c) {
  document.querySelector(".err")?.remove();
  empty.style.display = "none";
  const row = document.createElement("div"); row.className = "turn";
  const inner = document.createElement("div"); inner.className = "msg ai";
  const tools = document.createElement("div"); tools.className = "tools";
  const live = document.createElement("div"); live.className = "bubble think cursor"; live.textContent = "Dominion AI is working…";
  inner.append(tools, live); row.appendChild(inner); wrap.appendChild(row); scroll();
  const warm = setTimeout(() => { if (live.classList.contains("think")) { live.textContent = "Dominion AI is working… (first reply can take ~20s)"; scroll(); } }, 6000);

  setBusy(true); aborter = new AbortController();
  let raw = ""; let errMsg = ""; let routeEl = null; let ctxEl = null; const chips = [];
  try {
    const res = await fetch("/chat", {
      method: "POST", headers: { "content-type": "application/json" }, signal: aborter.signal,
      body: JSON.stringify({
        messages: c.messages.map((m) => ({ role: m.role, content: m.content })),
        mode: modeSel ? modeSel.value : "auto",
        model: forcedModel() || "auto",
        persona: resolvePersona(),
        temperature: settings.temperature,
        confirmTools: !!settings.confirmTools,
        chatId: c.id,
      }),
    });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop() || "";
      for (const line of lines) {
        const s = line.trim(); if (!s.startsWith("data:")) continue;
        let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }
        if (ev.type === "route") {
          // Model/mode intentionally NOT shown — the in-progress bubble just says "Dominion AI is working".
        } else if (ev.type === "context") {
          if (!ctxEl) { ctxEl = document.createElement("div"); ctxEl.className = "ctx"; inner.insertBefore(ctxEl, tools); }
          ctxEl.textContent = "🧠 used " + ev.memory + " memor" + (ev.memory === 1 ? "y" : "ies");
          scroll();
        } else if (ev.type === "artifact") {
          const note = document.createElement("div"); note.className = "ctx"; note.style.cursor = "pointer";
          note.textContent = "📄 saved artifact: " + ev.title + " (tap to open)";
          note.onclick = () => { openArtifacts(); openArtifact(ev.id); };
          inner.insertBefore(note, tools); scroll();
        } else if (ev.type === "mentor") {
          const note = document.createElement("div"); note.className = "ctx";
          note.textContent = "🎓 mentor: " + ev.score + "/10" + (ev.priority && ev.priority !== "none" ? " · revise " + ev.priority : "") + (ev.findings ? " · " + ev.findings + " finding(s)" : "");
          inner.insertBefore(note, tools); scroll();
        } else if (ev.type === "tool") {
          if (ev.status === "run") {
            const chip = document.createElement("div"); chip.className = "tool" + (ev.gated ? " gated" : "");
            chip.innerHTML = '<span class="sp"></span>'; const lab = document.createElement("span"); lab.textContent = (ev.gated ? "🔒 " : "🔧 ") + ev.name + "…"; chip.appendChild(lab);
            if (ev.cls) { const cb = document.createElement("span"); cb.className = "cls"; cb.textContent = ev.cls.replace(/_/g, " "); chip.appendChild(cb); }
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
          const q = document.createElement("div"); q.className = "cq"; q.textContent = "Run " + ev.name + " (" + String(ev.cls || "").replace(/_/g, " ") + ")?" + (ev.preview ? "  " + ev.preview : "");
          const btns = document.createElement("div"); btns.className = "cbtns";
          const yes = document.createElement("button"); yes.className = "yes"; yes.textContent = "Approve";
          const no = document.createElement("button"); no.textContent = "Deny";
          const decide = (approved) => { yes.disabled = no.disabled = true; box.remove(); fetch("/tool-confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: ev.runId, approved }) }).catch(() => {}); };
          yes.onclick = () => decide(true); no.onclick = () => decide(false);
          btns.append(yes, no); box.append(q, btns); tools.appendChild(box); scroll();
        } else if (ev.type === "token") { raw += ev.delta || ""; const shown = stripThink(raw); live.classList.toggle("think", !shown); live.textContent = shown || "Dominion AI is working…"; scroll(); }
        else if (ev.type === "error") { throw new Error(ev.error || "server error"); }
      }
    }
    clearTimeout(warm);
    const final = stripThink(raw) || "(no response)";
    c.messages.push({ role: "assistant", content: final }); c.updatedAt = Date.now(); save();
  } catch (e) {
    clearTimeout(warm);
    if (e.name === "AbortError") { const partial = stripThink(raw); if (partial) { c.messages.push({ role: "assistant", content: partial }); save(); } }
    else { errMsg = "Chat failed: " + (e.message || "network error") + " — tap send to retry."; }
  } finally {
    setBusy(false); aborter = null; renderAll(); if (errMsg) showErr(errMsg);
  }
}

function send() {
  if (busy) { if (aborter) aborter.abort(); return; }
  const text = input.value.trim(); if (!text) return;
  const c = cur(); if (!c) return;
  input.value = ""; autosize();
  c.messages.push({ role: "user", content: text });
  if (c.title === "New chat") c.title = titleFrom(c.messages);
  c.updatedAt = Date.now(); save(); renderAll();
  streamReply(c);
}
function regenerate() {
  if (busy) return; const c = cur(); if (!c) return;
  for (let i = c.messages.length - 1; i >= 0; i--) if (c.messages[i].role === "assistant") { c.messages.splice(i, 1); break; }
  save(); renderAll(); streamReply(c);
}
function editUser(i) {
  if (busy) return; const c = cur(); if (!c) return;
  input.value = c.messages[i].content; c.messages = c.messages.slice(0, i); c.updatedAt = Date.now(); save(); renderAll(); autosize(); input.focus();
}

// ---------- settings ----------
function openSettings() {
  personaSel.value = settings.persona; personaCustom.value = settings.personaCustom || "";
  personaCustom.hidden = settings.persona !== "custom";
  tempInput.value = String(settings.temperature); tempVal.textContent = String(settings.temperature);
  if (confirmToolsBox) confirmToolsBox.checked = !!settings.confirmTools;
  smodal.hidden = false;
}
const closeSettings = () => { smodal.hidden = true; };
function saveSettingsUI() {
  settings.persona = personaSel.value; settings.personaCustom = personaCustom.value.trim();
  settings.temperature = parseFloat(tempInput.value);
  if (confirmToolsBox) settings.confirmTools = confirmToolsBox.checked;
  if (modelSel) try { localStorage.setItem(LS_MODEL, modelSel.value); } catch {}
  saveSettings(); closeSettings();
}

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
    if (m.pinned) { const p = document.createElement("span"); p.className = "pinned"; p.textContent = "📌"; top.appendChild(p); }
    const c = document.createElement("div"); c.className = "mc"; c.textContent = m.content;
    const acts = document.createElement("div"); acts.className = "macts";
    if (m.status === "pending") acts.append(mkAct("Approve", () => memUpdate(m.id, { action: "approve" })), mkAct("Reject", () => memUpdate(m.id, { action: "reject" })));
    acts.append(
      mkAct(m.pinned ? "Unpin" : "Pin", () => memUpdate(m.id, { action: m.pinned ? "unpin" : "pin" })),
      mkAct("Edit", () => { const t = prompt("Edit memory", m.content); if (t != null && t.trim()) memUpdate(m.id, { content: t.trim() }); }),
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

// ---------- tool activity panel (Phase 3) ----------
const tfmt = (ts) => { try { return new Date(ts).toLocaleString(); } catch { return ts || ""; } };
async function loadTools() {
  tlist.textContent = "Loading…";
  let runs = [];
  try { runs = ((await (await fetch("/toolruns", { cache: "no-store" })).json()).runs) || []; } catch {}
  if (tstats) tstats.textContent = runs.length ? runs.length + " recent" : "";
  tlist.innerHTML = "";
  if (!runs.length) { const n = document.createElement("div"); n.className = "none"; n.textContent = "No tool activity yet."; tlist.appendChild(n); return; }
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
function openTools() { tmodal.hidden = false; loadTools(); }
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
    top.append(ty, st, vc, wc); it.append(ttl, top); it.onclick = () => openArtifact(a.id); alist.appendChild(it);
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
  adetail.appendChild(meta);
  const vrow = document.createElement("div"); vrow.className = "arow";
  const sel = document.createElement("select");
  for (let v = 1; v <= a.versionCount; v++) { const o = document.createElement("option"); o.value = v; o.textContent = "v" + v; if (v === a.version) o.selected = true; sel.appendChild(o); }
  sel.onchange = async () => { await aApi("/artifacts/setversion", { id: a.id, version: Number(sel.value) }); openArtifact(a.id); };
  vrow.append(Object.assign(document.createElement("span"), { textContent: "Version" }), sel);
  if (a.versionCount > 1) vrow.appendChild(mkAct("Diff vs prev", () => showDiff(a.id, a.version - 1 || 1, a.version)));
  adetail.appendChild(vrow);
  const c = document.createElement("div"); c.className = "acontent"; c.textContent = a.content; adetail.appendChild(c);
  const acts = document.createElement("div"); acts.className = "arow"; acts.style.marginTop = "8px";
  acts.append(
    mkAct("Revise", () => reviseArtifact(a)),
    mkAct("Export", () => exportArtifact(a)),
    mkAct(a.status === "final" ? "Unfinalize" : "Mark final", () => setArtStatus(a.id, a.status === "final" ? "draft" : "final")),
    mkAct("Review", () => reviewArtifact(a.id)),
    mkAct("Rename", () => renameArt(a)),
    mkAct("Delete", () => { if (confirm("Delete this artifact and all versions?")) delArt(a.id); }),
  );
  adetail.appendChild(acts);
  if (a.reviewNotes) { const rv = document.createElement("div"); rv.className = "areview"; rv.textContent = a.reviewNotes; adetail.appendChild(rv); }
}
async function showDiff(id, from, to) {
  const d = await aApi(`/artifacts/diff?id=${encodeURIComponent(id)}&a=${from}&b=${to}`);
  const box = document.createElement("div"); box.className = "adiff";
  (d.diff || "(no diff)").split("\n").forEach((l) => { const ln = document.createElement("div"); if (l[0] === "+") ln.className = "add"; else if (l[0] === "-") ln.className = "del"; ln.textContent = l; box.appendChild(ln); });
  const old = adetail.querySelector(".adiff"); if (old) old.remove(); adetail.appendChild(box); box.scrollIntoView();
}
async function reviseArtifact(a) { const t = prompt("Revise — the full new content:", a.content); if (t != null && t.trim()) { await aApi("/artifacts/version", { id: a.id, content: t }); openArtifact(a.id); } }
async function exportArtifact(a) { const f = prompt("Export format (md, txt, json, html):", "md"); if (f == null) return; const r = await aApi("/artifacts/export", { id: a.id, format: (f || "md").trim() }); alert(r.error ? "Export: " + r.error : "Exported to " + r.path); }
async function setArtStatus(id, status) { await aApi("/artifacts/update", { id, status }); openArtifact(id); }
async function renameArt(a) { const t = prompt("Rename artifact:", a.title); if (t != null && t.trim()) { await aApi("/artifacts/update", { id: a.id, title: t.trim() }); openArtifact(a.id); } }
async function reviewArtifact(id) { const note = document.createElement("div"); note.className = "areview"; note.textContent = "Reviewing with the local model (≈20s)…"; adetail.appendChild(note); await aApi("/artifacts/review", { id }); openArtifact(id); }
async function delArt(id) { await aApi("/artifacts/delete", { id }); showArtifactList(); }
async function saveAsArtifact(content) {
  const guess = (String(content).split("\n").find((l) => l.trim()) || "Document").replace(/^#+\s*/, "").replace(/[*_`]/g, "").slice(0, 60);
  const t = prompt("Save as artifact — title:", guess); if (t == null) return;
  const r = await aApi("/artifacts", { title: t || "Document", content, type: "markdown" });
  if (r.item) { openArtifacts(); openArtifact(r.item.id); }
}

// ---------- mentor critique (Phase 5) ----------
const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
async function critiqueMessage(i) {
  const c = cur(); if (!c || !c.messages[i]) return;
  const answer = c.messages[i].content; let orig = "";
  for (let k = i - 1; k >= 0; k--) if (c.messages[k].role === "user") { orig = c.messages[k].content; break; }
  const card = document.createElement("div"); card.className = "critique"; card.textContent = "🎓 Mentor reviewing… (local model, ~15s)"; wrap.appendChild(card); scroll();
  try {
    const d = await aApi("/mentor/review", { content: answer, originalRequest: orig, taskType: "answer_review" });
    renderCritiqueCard(card, d.critique || {}, orig);
  } catch { card.textContent = "Mentor review failed."; }
}
function renderCritiqueCard(card, c, orig) {
  card.innerHTML = "";
  const head = document.createElement("div"); head.className = "crhead";
  const sp = document.createElement("span"); sp.className = "scorepill"; sp.textContent = (c.overall_score ?? "?") + "/10"; head.appendChild(sp);
  head.appendChild(Object.assign(document.createElement("span"), { className: "crsec", textContent: "risk " + (c.hallucination_risk || "?") + " · revise " + (c.revision_priority || "none") + " · " + (c._provider || "") }));
  const x = document.createElement("button"); x.className = "act"; x.textContent = "✕"; x.style.marginLeft = "auto"; x.onclick = () => card.remove(); head.appendChild(x);
  card.appendChild(head);
  const sec = (label, a) => { if (!a || !a.length) return; const d = document.createElement("div"); d.className = "crsec"; d.innerHTML = "<b>" + label + ":</b> " + a.map(escapeHtml).join("; "); card.appendChild(d); };
  sec("Major", c.major_findings); sec("Unsupported", c.unsupported_claims); sec("Reasoning", c.reasoning_errors); sec("Safety/Privacy", c.safety_or_privacy_issues);
  if (c.recommended_revision) { const d = document.createElement("div"); d.className = "crsec"; d.innerHTML = "<b>Suggestion:</b> " + escapeHtml(c.recommended_revision); card.appendChild(d); }
  const cand = (label, text, save) => { const r = document.createElement("div"); r.className = "cand"; r.appendChild(Object.assign(document.createElement("span"), { textContent: "💡 " + text })); const b = document.createElement("button"); b.textContent = label; b.onclick = async () => { b.disabled = true; await save(); b.textContent = "saved ✓"; }; r.appendChild(b); card.appendChild(r); };
  (c.memory_candidates || []).forEach((t) => cand("→ memory", t, () => memApi("/memory", { content: t, source: "mentor_suggested" })));
  (c.eval_case_candidates || []).forEach((t) => cand("→ eval", t, () => aApi("/evals", { title: t.slice(0, 80), input: t, source: "mentor" })));
  (c.prompt_rule_candidates || []).forEach((t) => cand("→ rule", t, () => aApi("/rules", { content: t, scope: "global", status: "candidate" })));
  cand("→ ledger", "log this review as a failure entry", () => aApi("/ledger", { category: "mentor_flag", severity: "low", originalRequest: orig, flawedOutput: "(see chat)", detectedBy: "mentor" }));
  scroll();
}

// ---------- mentor & improvement panel (Phase 5) ----------
let itab = "ledger";
function openImprove() { imodal.hidden = false; setITab(itab); }
const closeImprove = () => { imodal.hidden = true; };
function setITab(t) {
  itab = t; document.querySelectorAll(".itab").forEach((el) => el.classList.toggle("on", el.dataset.tab === t));
  iadd.placeholder = t === "ledger" ? "Log a failure / lesson…" : t === "evals" ? "Eval input prompt…" : "Prompt rule (a compact instruction)…";
  loadImprove();
}
async function loadImprove() {
  ilist.textContent = "Loading…";
  const path = itab === "ledger" ? "/ledger" : itab === "evals" ? "/evals" : "/rules";
  const d = await aApi(path); const items = (d && d.items) || [];
  if (istats && d.stats) { const s = d.stats; istats.textContent = `${s.failures}F · ${s.evals}E · ${s.rules}R (${s.activeRules} active)`; }
  ilist.innerHTML = "";
  if (!items.length) { const n = document.createElement("div"); n.className = "none"; n.textContent = "Nothing here yet."; ilist.appendChild(n); return; }
  for (const it of items) ilist.appendChild(itab === "ledger" ? renderFailure(it) : itab === "evals" ? renderEval(it) : renderRule(it));
}
function renderFailure(f) {
  const it = document.createElement("div"); it.className = "mitem";
  const top = document.createElement("div"); top.className = "mtop";
  top.append(badge(f.category), badge(f.severity, f.severity === "high" || f.severity === "critical" ? "rejected" : ""), badge(f.status, f.status === "open" ? "pending" : ""), Object.assign(document.createElement("span"), { textContent: "by " + f.detectedBy }));
  const c = document.createElement("div"); c.className = "mc"; c.textContent = (f.originalRequest || "").slice(0, 160) || "(no request)";
  const acts = document.createElement("div"); acts.className = "macts";
  acts.append(mkAct(f.status === "open" ? "Mark resolved" : "Reopen", () => fUpdate("/ledger/update", { id: f.id, status: f.status === "open" ? "resolved" : "open" })), mkAct("Delete", () => fUpdate("/ledger/delete", { id: f.id })));
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
  const c = document.createElement("div"); c.className = "mc"; c.textContent = r.content;
  const acts = document.createElement("div"); acts.className = "macts";
  acts.append(mkAct(r.status === "active" ? "Retire" : "Activate", () => fUpdate("/rules/update", { id: r.id, status: r.status === "active" ? "retired" : "active" })), mkAct("Delete", () => fUpdate("/rules/delete", { id: r.id })));
  it.append(top, c, acts); return it;
}
async function fUpdate(path, body) { await aApi(path, body); loadImprove(); }
async function addImprove() {
  const v = (iadd.value || "").trim(); if (!v) return;
  if (itab === "ledger") await aApi("/ledger", { category: "manual", severity: "low", originalRequest: v, detectedBy: "user" });
  else if (itab === "evals") { const exp = prompt("Expected behavior (what a good answer must do):", ""); await aApi("/evals", { title: v.slice(0, 80), input: v, expectedBehavior: exp || "", source: "manual" }); }
  else await aApi("/rules", { content: v, scope: "global", status: "candidate" });
  iadd.value = ""; loadImprove();
}

// ---------- wire up ----------
input.addEventListener("input", autosize);
// Desktop (mouse) sends on Enter; phone/touch lets Enter insert a newline (use the send button).
const enterSends = !(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && enterSends) { e.preventDefault(); send(); } });
sendBtn.addEventListener("click", send);
menuBtn.addEventListener("click", () => (sidebar.classList.contains("open") ? closeSidebar() : openSidebar()));
overlay.addEventListener("click", closeSidebar);
newBtn.addEventListener("click", newChat);
if (modeSel) modeSel.addEventListener("change", () => { try { localStorage.setItem(LS_MODE, modeSel.value); } catch {} });
settingsBtn.addEventListener("click", openSettings);
sclose.addEventListener("click", closeSettings);
ssave.addEventListener("click", saveSettingsUI);
smodal.addEventListener("click", (e) => { if (e.target === smodal) closeSettings(); });
memBtn.addEventListener("click", openMemory);
mclose.addEventListener("click", closeMemory);
msave.addEventListener("click", addMemory);
mmodal.addEventListener("click", (e) => { if (e.target === mmodal) closeMemory(); });
if (mfilterStatus) mfilterStatus.addEventListener("change", loadMemory);
toolsBtn.addEventListener("click", openTools);
tclose.addEventListener("click", closeTools);
tmodal.addEventListener("click", (e) => { if (e.target === tmodal) closeTools(); });
artifactsBtn.addEventListener("click", openArtifacts);
aclose.addEventListener("click", closeArtifacts);
amodal.addEventListener("click", (e) => { if (e.target === amodal) closeArtifacts(); });
improveBtn.addEventListener("click", openImprove);
iclose.addEventListener("click", closeImprove);
imodal.addEventListener("click", (e) => { if (e.target === imodal) closeImprove(); });
iaddbtn.addEventListener("click", addImprove);
document.querySelectorAll(".itab").forEach((el) => el.addEventListener("click", () => setITab(el.dataset.tab)));
personaSel.addEventListener("change", () => { personaCustom.hidden = personaSel.value !== "custom"; });
tempInput.addEventListener("input", () => { tempVal.textContent = tempInput.value; });

load(); renderAll(); loadModels(); autosize();
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
