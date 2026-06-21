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
// qwen3 and friends emit <think>...</think>; never show that to the user.
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

// ---------- models ----------
async function loadModels() {
  try {
    const r = await fetch("/ollama/v1/models");
    const j = await r.json();
    const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
    modelSel.innerHTML = "";
    if (!ids.length) { const o = document.createElement("option"); o.textContent = "no models"; modelSel.appendChild(o); return; }
    for (const id of ids) { const o = document.createElement("option"); o.value = id; o.textContent = id; modelSel.appendChild(o); }
    const saved = localStorage.getItem(LS_MODEL);
    if (saved && ids.includes(saved)) modelSel.value = saved;
  } catch {
    modelSel.innerHTML = "<option>offline</option>";
  }
}

// ---------- send ----------
async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  busy = true; sendBtn.disabled = true;
  input.value = ""; autosize();
  document.querySelector(".err")?.remove();

  messages.push({ role: "user", content: text });
  empty.style.display = "none";
  bubble("user", text); save(); scroll();

  const liveRow = document.createElement("div");
  liveRow.className = "msg ai";
  const live = document.createElement("div");
  live.className = "bubble think cursor";
  live.textContent = "thinking…";
  liveRow.appendChild(live); wrap.appendChild(liveRow); scroll();

  let raw = "";
  try {
    const res = await fetch("/ollama/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelSel.value, messages, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status + " " + (await res.text().catch(() => "")).slice(0, 120));

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
    const final = stripThink(raw) || "(no response)";
    live.classList.remove("think", "cursor");
    live.textContent = final;
    messages.push({ role: "assistant", content: final });
    save();
  } catch (e) {
    liveRow.remove();
    const err = document.createElement("div");
    err.className = "err";
    err.textContent = "Couldn't reach your assistant: " + e.message + " (is the mini-PC + Ollama running?)";
    wrap.appendChild(err);
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
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener("click", send);
newBtn.addEventListener("click", newChat);
modelSel.addEventListener("change", () => localStorage.setItem(LS_MODEL, modelSel.value));

load();
renderAll();
loadModels();
autosize();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
