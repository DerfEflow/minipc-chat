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
// Retries on a cold server (the mini-PC / Tailscale may still be coming up), and defaults to the
// faster small model so the first reply is snappy.
async function loadModels(attempt = 0) {
  try {
    const r = await fetch("/ollama/v1/models", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
    if (!ids.length) throw new Error("no models");
    modelSel.innerHTML = "";
    for (const id of ids) { const o = document.createElement("option"); o.value = id; o.textContent = id; modelSel.appendChild(o); }
    const saved = localStorage.getItem(LS_MODEL);
    if (saved && ids.includes(saved)) modelSel.value = saved;
    else modelSel.value = ids.find((x) => /:(8b|7b|4b|3b|1\.5b)\b/i.test(x) || /mini/i.test(x)) || ids[0];
  } catch {
    if (attempt < 5) {
      if (!modelSel.value) modelSel.innerHTML = "<option>connecting…</option>";
      setTimeout(() => loadModels(attempt + 1), 2500);
    } else if (!modelSel.value || modelSel.value === "connecting…") {
      modelSel.innerHTML = "<option>offline — reload</option>";
    }
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

  // The first reply has to load the model into memory (can take ~20s); reassure instead of failing.
  const warm = setTimeout(() => { if (live.classList.contains("think")) { live.textContent = "waking the model… first reply can take ~20s"; scroll(); } }, 6000);

  // One streamed attempt. Throws on transport/HTTP error so the caller can retry once.
  async function attempt() {
    let raw = "";
    const res = await fetch("/ollama/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelSel.value, messages, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
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
    } catch (e1) {
      // cold-start transient (server/model just waking) — wait and retry once
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
    const err = document.createElement("div");
    err.className = "err";
    err.textContent = "Couldn't reach your assistant — it may still be waking up. Give it a few seconds and tap send again.";
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
