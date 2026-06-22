// Dominion AI — chat client. Talks to the server-side agent loop at /chat (which runs tools),
// with multi-conversation history in a sidebar. Model list still comes from /ollama/v1/models.
const $ = (id) => document.getElementById(id);
const wrap = $("wrap"), main = $("main"), input = $("input"), sendBtn = $("send"),
      modelSel = $("model"), empty = $("empty"),
      sidebar = $("sidebar"), overlay = $("overlay"), menuBtn = $("menu"), newBtn = $("newchat"), chatlist = $("chatlist");

const LS_CHATS = "dominion.chats.v1";
const LS_CUR = "dominion.cur.v1";
const LS_MODEL = "minipc-chat.model.v1";
const OLD_MSGS = "minipc-chat.messages.v1";

let chats = [];        // [{id, title, messages:[{role,content}], updatedAt}]
let curId = null;
let busy = false;
let aborter = null;

// ---------- persistence ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "c" + Date.now() + Math.random().toString(36).slice(2));
const save = () => { try { localStorage.setItem(LS_CHATS, JSON.stringify(chats.slice(0, 100))); localStorage.setItem(LS_CUR, curId || ""); } catch {} };
function load() {
  try { const r = localStorage.getItem(LS_CHATS); const a = r && JSON.parse(r); if (Array.isArray(a)) chats = a; } catch {}
  // migrate a pre-sidebar single conversation
  if (!chats.length) {
    try { const old = JSON.parse(localStorage.getItem(OLD_MSGS) || "null"); if (Array.isArray(old) && old.length) chats = [{ id: uid(), title: titleFrom(old), messages: old, updatedAt: Date.now() }]; } catch {}
  }
  curId = localStorage.getItem(LS_CUR) || (chats[0] && chats[0].id) || null;
  if (!curId) newChat();
}
const cur = () => chats.find((c) => c.id === curId);
const titleFrom = (msgs) => { const u = msgs.find((m) => m.role === "user"); return (u ? u.content : "New chat").replace(/\s+/g, " ").trim().slice(0, 40) || "New chat"; };

function newChat() {
  if (busy) return;
  const c = { id: uid(), title: "New chat", messages: [], updatedAt: Date.now() };
  chats.unshift(c); curId = c.id; save();
  renderAll(); closeSidebar(); input.focus();
}
function switchChat(id) { if (busy) return; curId = id; save(); renderAll(); closeSidebar(); }
function deleteChat(id) {
  chats = chats.filter((c) => c.id !== id);
  if (curId === id) curId = (chats[0] && chats[0].id) || null;
  if (!curId) { newChat(); return; }
  save(); renderAll();
}
function renameChat(id) {
  const c = chats.find((x) => x.id === id); if (!c) return;
  const t = prompt("Rename chat", c.title); if (t != null) { c.title = t.trim().slice(0, 60) || c.title; save(); renderSidebar(); }
}

// ---------- sidebar ----------
const openSidebar = () => { sidebar.classList.add("open"); overlay.classList.add("show"); };
const closeSidebar = () => { sidebar.classList.remove("open"); overlay.classList.remove("show"); };
function renderSidebar() {
  chatlist.innerHTML = "";
  const sorted = [...chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const c of sorted) {
    const row = document.createElement("div");
    row.className = "ci" + (c.id === curId ? " active" : "");
    const ttl = document.createElement("div"); ttl.className = "ttl"; ttl.textContent = c.title || "New chat";
    ttl.onclick = () => switchChat(c.id);
    const ren = document.createElement("span"); ren.className = "x"; ren.textContent = "✎"; ren.title = "Rename";
    ren.onclick = (e) => { e.stopPropagation(); renameChat(c.id); };
    const del = document.createElement("span"); del.className = "x"; del.textContent = "×"; del.title = "Delete";
    del.onclick = (e) => { e.stopPropagation(); if (confirm("Delete this chat?")) deleteChat(c.id); };
    row.appendChild(ttl); row.appendChild(ren); row.appendChild(del);
    chatlist.appendChild(row);
  }
}

// ---------- rendering ----------
const stripThink = (t) => t.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
const scroll = () => { main.scrollTop = main.scrollHeight; };
function bubble(role, text) {
  const row = document.createElement("div"); row.className = "msg " + (role === "user" ? "me" : "ai");
  const b = document.createElement("div"); b.className = "bubble"; b.textContent = text;
  row.appendChild(b); wrap.appendChild(row); return b;
}
function renderAll() {
  wrap.querySelectorAll(".msg, .err").forEach((n) => n.remove());
  const c = cur();
  empty.style.display = (c && c.messages.length) ? "none" : "";
  if (c) for (const m of c.messages) bubble(m.role, m.content);
  renderSidebar(); scroll();
}
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px"; }
function showErr(t) { document.querySelector(".err")?.remove(); const e = document.createElement("div"); e.className = "err"; e.textContent = t; wrap.appendChild(e); scroll(); }

// ---------- models ----------
function currentModel() { const v = modelSel.value; return v && !/connecting|offline|no models|^$/i.test(v) ? v : ""; }
let loading = null;
async function loadModels() {
  if (loading) return loading;
  loading = (async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await fetch("/ollama/v1/models", { cache: "no-store" }); if (!r.ok) throw 0;
        const ids = ((await r.json()).data || []).map((m) => m.id || m.name).filter(Boolean);
        if (!ids.length) throw 0;
        modelSel.innerHTML = "";
        for (const id of ids) { const o = document.createElement("option"); o.value = id; o.textContent = id; modelSel.appendChild(o); }
        const saved = localStorage.getItem(LS_MODEL);
        modelSel.value = (saved && ids.includes(saved)) ? saved : (ids.find((x) => /:(8b|7b|4b|3b|1\.5b)\b/i.test(x)) || ids[0]);
        return true;
      } catch { if (!currentModel()) modelSel.innerHTML = "<option value=''>connecting…</option>"; await new Promise((r) => setTimeout(r, 2000)); }
    }
    if (!currentModel()) modelSel.innerHTML = "<option value=''>offline — tap to retry</option>";
    return false;
  })();
  try { return await loading; } finally { loading = null; }
}

// ---------- send (agent loop over SSE) ----------
function setBusy(on) {
  busy = on;
  sendBtn.classList.toggle("stop", on);
  sendBtn.innerHTML = on ? "&#9632;" : "&#8593;";
  sendBtn.title = on ? "Stop" : "Send";
}

async function send() {
  if (busy) { if (aborter) aborter.abort(); return; }
  const text = input.value.trim(); if (!text) return;
  document.querySelector(".err")?.remove();
  let model = currentModel();
  if (!model) { await loadModels(); model = currentModel(); }
  if (!model) { showErr("Still connecting to your AI — give it a few seconds, then send again."); return; }

  const c = cur(); if (!c) return;
  input.value = ""; autosize();
  c.messages.push({ role: "user", content: text });
  if (c.title === "New chat") c.title = titleFrom(c.messages);
  c.updatedAt = Date.now(); save();
  empty.style.display = "none"; bubble("user", text); renderSidebar(); scroll();

  // live assistant row: a tools strip + the answer bubble
  const row = document.createElement("div"); row.className = "msg ai";
  const tools = document.createElement("div"); tools.className = "tools";
  const live = document.createElement("div"); live.className = "bubble think cursor"; live.textContent = "thinking…";
  row.appendChild(tools); row.appendChild(live); wrap.appendChild(row); scroll();

  const warm = setTimeout(() => { if (live.classList.contains("think")) { live.textContent = "waking the model… first reply can take ~20s"; scroll(); } }, 6000);

  setBusy(true);
  aborter = new AbortController();
  let raw = "";
  const chips = [];
  try {
    const res = await fetch("/chat", {
      method: "POST", headers: { "content-type": "application/json" }, signal: aborter.signal,
      body: JSON.stringify({ model, messages: c.messages.map((m) => ({ role: m.role, content: m.content })) }),
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
        if (ev.type === "tool") {
          if (ev.status === "run") {
            const chip = document.createElement("div"); chip.className = "tool" + (ev.gated ? " gated" : "");
            chip.innerHTML = '<span class="sp"></span>';
            const lab = document.createElement("span"); lab.textContent = (ev.gated ? "🔒 " : "🔧 ") + ev.name + "…"; chip.appendChild(lab);
            chip._name = ev.name; chip._lab = lab; tools.appendChild(chip); chips.push(chip); scroll();
          } else if (ev.status === "done") {
            const chip = [...chips].reverse().find((x) => x._name === ev.name && !x._done);
            if (chip) { chip._done = true; chip.classList.add("done"); chip._lab.textContent = "✓ " + ev.name; }
          }
        } else if (ev.type === "token") {
          raw += ev.delta || ""; const shown = stripThink(raw);
          live.classList.toggle("think", !shown); live.textContent = shown || "thinking…"; scroll();
        } else if (ev.type === "error") {
          throw new Error(ev.error || "server error");
        } else if (ev.type === "done") {
          /* finished */
        }
      }
    }
    clearTimeout(warm);
    const final = stripThink(raw) || "(no response)";
    live.classList.remove("think", "cursor"); live.textContent = final;
    c.messages.push({ role: "assistant", content: final }); c.updatedAt = Date.now(); save(); renderSidebar();
  } catch (e) {
    clearTimeout(warm);
    if (e.name === "AbortError") {
      const partial = stripThink(raw);
      live.classList.remove("think", "cursor"); live.textContent = partial || "(stopped)";
      if (partial) { c.messages.push({ role: "assistant", content: partial }); save(); }
    } else {
      row.remove(); showErr("Chat failed: " + (e.message || "network error") + " — tap send to retry.");
    }
  } finally {
    setBusy(false); aborter = null; scroll();
  }
}

// ---------- wire up ----------
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
sendBtn.addEventListener("click", send);
menuBtn.addEventListener("click", () => (sidebar.classList.contains("open") ? closeSidebar() : openSidebar()));
overlay.addEventListener("click", closeSidebar);
newBtn.addEventListener("click", newChat);
modelSel.addEventListener("change", () => { if (currentModel()) localStorage.setItem(LS_MODEL, modelSel.value); else loadModels(); });

load();
renderAll();
loadModels();
autosize();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
