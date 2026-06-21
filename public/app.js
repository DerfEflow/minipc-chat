// Minimal chat client for the local Ollama (via the same-origin /ollama proxy).
const $ = (id) => document.getElementById(id);
const wrap = $("wrap"), main = $("main"), input = $("input"), sendBtn = $("send"),
      modelSel = $("model"), newBtn = $("new"), empty = $("empty");

const LS_MSGS = "minipc-chat.messages.v1";
const LS_MODEL = "minipc-chat.model.v1";

let messages = [];      // [{role:"user"|"assistant", content}]
let busy = false;

// ---------- persistence ----------
const save = () => { try { localStorage.setItem(LS_MSGS, JSON.stringify(messages.slice(-100))); } catch {} };
function load() {
  try { const r = localStorage.getItem(LS_MSGS); const a = r && JSON.parse(r); if (Array.isArray(a)) messages = a; } catch {}
}

// ---------- helpers ----------
const stripThink = (t) => t.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
const scroll = () => { main.scrollTop = main.scrollHeight; };

function bubble(role, text) {
  const row = document.createElement("div");
  row.className = "msg " + (role === "user" ? "me" : "ai");
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  row.appendChild(b);
  wrap.appendChild(row);
  return b;
}
function renderAll() {
  wrap.querySelectorAll(".msg").forEach((n) => n.remove());
  empty.style.display = messages.length ? "none" : "";
  for (const m of messages) bubble(m.role, m.content);
  scroll();
}
function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px";
}
function showErr(t) {
  document.querySelector(".err")?.remove();
  const e = document.createElement("div"); e.className = "err"; e.textContent = t; wrap.appendChild(e); scroll();
}

// ---------- models ----------
// A real, selectable model id (not a placeholder). Empty string means "not ready yet".
function currentModel() {
  const v = modelSel.value;
  return v && !/connecting|offline|no models|^$/i.test(v) ? v : "";
}
// Awaitable: retries a cold server; resolves true once the picker holds a real model.
let loading = null;
async function loadModels() {
  if (loading) return loading;
  loading = (async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await fetch("/ollama/v1/models", { cache: "no-store" });
        if (!r.ok) throw 0;
        const j = await r.json();
        const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
        if (!ids.length) throw 0;
        modelSel.innerHTML = "";
        for (const id of ids) { const o = document.createElement("option"); o.value = id; o.textContent = id; modelSel.appendChild(o); }
        const saved = localStorage.getItem(LS_MODEL);
        modelSel.value = (saved && ids.includes(saved)) ? saved
          : (ids.find((x) => /:(8b|7b|4b|3b|1\.5b)\b/i.test(x) || /mini/i.test(x)) || ids[0]);
        return true;
      } catch {
        if (!currentModel()) modelSel.innerHTML = "<option value=''>connecting…</option>";
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
    if (!currentModel()) modelSel.innerHTML = "<option value=''>offline — tap to retry</option>";
    return false;
  })();
  try { return await loading; } finally { loading = null; }
}

// ---------- send ----------
async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  busy = true; sendBtn.disabled = true;
  document.querySelector(".err")?.remove();

  // GUARD: never POST without a real model (that returns an instant 400). Wait for the list first.
  let model = currentModel();
  if (!model) { await loadModels(); model = currentModel(); }
  if (!model) {
    showErr("Still connecting to your AI — give it a few seconds, then tap send again.");
    busy = false; sendBtn.disabled = false;
    return;
  }

  input.value = ""; autosize();
  messages.push({ role: "user", content: text });
  empty.style.display = "none";
  bubble("user", text); save(); scroll();

  const liveRow = document.createElement("div");
  liveRow.className = "msg ai";
  const live = document.createElement("div");
  live.className = "bubble think cursor";
  live.textContent = "thinking…";
  liveRow.appendChild(live); wrap.appendChild(liveRow); scroll();

  // First reply loads the model into memory (~15-25s); reassure rather than look frozen.
  const warm = setTimeout(() => { if (live.classList.contains("think")) { live.textContent = "waking the model… first reply can take ~20s"; scroll(); } }, 6000);

  async function attempt() {
    let raw = "";
    const res = await fetch("/ollama/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error("HTTP " + res.status + (t ? ": " + t.replace(/\s+/g, " ").slice(0, 90) : "")); }
    if (!res.body) throw new Error("no response stream");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || "";
          if (delta) raw += delta;
        } catch {}
      }
      const shown = stripThink(raw);
      live.classList.toggle("think", !shown);
      live.textContent = shown || "thinking…";
      scroll();
    }
    return stripThink(raw);
  }

  try {
    let final;
    try {
      final = await attempt();
    } catch {
      live.textContent = "waking the model… retrying";
      await new Promise((r) => setTimeout(r, 3000));
      final = await attempt();
    }
    clearTimeout(warm);
    final = final || "(no response)";
    live.classList.remove("think", "cursor");
    live.textContent = final;
    messages.push({ role: "assistant", content: final });
    save();
  } catch (e) {
    clearTimeout(warm);
    liveRow.remove();
    showErr("Chat failed: " + ((e && e.message) || "network error") + " — tap send to retry.");
  } finally {
    busy = false; sendBtn.disabled = false; scroll();
  }
}

function newChat() {
  if (busy) return;
  messages = []; save(); renderAll(); input.focus();
}

// ---------- wire up ----------
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
sendBtn.addEventListener("click", send);
newBtn.addEventListener("click", newChat);
modelSel.addEventListener("change", () => { if (currentModel()) localStorage.setItem(LS_MODEL, modelSel.value); else loadModels(); });

load();
renderAll();
loadModels();
autosize();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
