/*
 * Dominion AI — task notices: the popup that tells you a thing you started has finished.
 *
 * Fred's concurrent-work spec: a task keeps working no matter what you start in the meantime, and
 * when it completes or hard-fails you get a notice with a button that takes you to the screen it
 * came from. This is that notice. It is deliberately surface-agnostic: it renders whatever
 * /tasks/notices returns, and each notice already carries its own deep link, built server-side by
 * the task kind's registered href(). A new surface joining the kernel appears here for free, with
 * no edit to this file.
 *
 * WHY A CARD AND NOT A TOAST. A toast that vanishes after five seconds is how a finished video
 * reads as nothing having happened (Video Studio learned this the hard way and left a comment
 * about it). These persist until acknowledged, because the whole point is that the user was
 * somewhere else when the thing finished.
 *
 * SEEN IS NOT NOTIFIED. The server tracks those separately. A push delivered to a phone in a
 * pocket counts as notified and must not silence the card; only a human dismissing it or following
 * it counts as seen. That is why dismissing posts to /tasks/seen rather than just removing a node.
 */
(() => {
  if (window.DominionTaskNotices) return;

  const POLL_VISIBLE_MS = 30000;
  const shown = new Map();          // id -> card element, so a poll cannot render the same notice twice
  let root = null, timer = null;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.createElement("div");
    root.id = "dtn-root";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Finished work");
    document.body.appendChild(root);
    if (!document.getElementById("dtn-style")) {
      const st = document.createElement("style");
      st.id = "dtn-style";
      st.textContent = `
#dtn-root{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;max-width:min(380px,calc(100vw - 32px));pointer-events:none}
.dtn-card{pointer-events:auto;background:var(--dtn-bg,#12161c);color:var(--dtn-fg,#e8eef6);border:1px solid var(--dtn-line,#2a3644);border-left:3px solid var(--dtn-accent,#4da3ff);border-radius:10px;padding:12px 14px;box-shadow:0 8px 28px rgba(0,0,0,.45);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;animation:dtn-in .22s ease-out}
.dtn-card.dtn-bad{border-left-color:var(--dtn-bad,#ff6b5e)}
.dtn-title{font-weight:600;margin:0 0 8px;padding-right:20px}
.dtn-kind{display:block;font-weight:400;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.6;margin-bottom:3px}
.dtn-actions{display:flex;gap:8px;align-items:center}
.dtn-go{flex:1;background:var(--dtn-accent,#4da3ff);color:#06121f;border:0;border-radius:7px;padding:7px 12px;font:inherit;font-weight:600;cursor:pointer}
.dtn-card.dtn-bad .dtn-go{background:var(--dtn-bad,#ff6b5e);color:#1a0603}
.dtn-go:hover{filter:brightness(1.08)}
.dtn-dismiss{background:transparent;color:inherit;border:1px solid var(--dtn-line,#2a3644);border-radius:7px;padding:7px 10px;font:inherit;opacity:.75;cursor:pointer}
.dtn-dismiss:hover{opacity:1}
@keyframes dtn-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.dtn-card{animation:none}}
@media(prefers-color-scheme:light){.dtn-card{--dtn-bg:#fff;--dtn-fg:#16202b;--dtn-line:#d7dee7}}`;
      document.head.appendChild(st);
    }
    return root;
  }

  async function markSeen(id) {
    try {
      await fetch("/tasks/seen", { method: "POST", headers: { "content-type": "application/json" },
                                   body: JSON.stringify({ id }) });
    } catch {}
  }

  function dismiss(id) {
    const card = shown.get(id);
    if (card) { card.remove(); shown.delete(id); }
    if (root && !root.children.length) { root.remove(); root = null; }
    void markSeen(id);
  }

  /*
   * Following a notice acknowledges it. Same-origin only, and taken from the server's own href
   * rather than anything a page supplied, so this cannot be turned into an open redirect.
   */
  function go(notice) {
    const href = String(notice.href || "/");
    dismiss(notice.id);
    let target = "/";
    try { const u = new URL(href, location.origin); if (u.origin === location.origin) target = u.pathname + u.search + u.hash; } catch {}
    if (target === location.pathname + location.search + location.hash) location.reload();
    else location.assign(target);
  }

  function render(notice) {
    if (shown.has(notice.id)) return;
    const bad = notice.status !== "done";
    const card = document.createElement("div");
    card.className = "dtn-card" + (bad ? " dtn-bad" : "");
    card.setAttribute("role", "alert");
    card.innerHTML =
      `<p class="dtn-title"><span class="dtn-kind">${esc(notice.kind || "task")}</span>${esc(notice.title || "Finished")}</p>
       <div class="dtn-actions">
         <button type="button" class="dtn-go">Take me there</button>
         <button type="button" class="dtn-dismiss" aria-label="Dismiss">Later</button>
       </div>`;
    card.querySelector(".dtn-go").addEventListener("click", () => go(notice));
    card.querySelector(".dtn-dismiss").addEventListener("click", () => dismiss(notice.id));
    ensureRoot().appendChild(card);
    shown.set(notice.id, card);
  }

  async function poll() {
    if (document.hidden) return;
    let data = null;
    try {
      const r = await fetch("/tasks/notices", { headers: { accept: "application/json" } });
      if (!r.ok) return;                    // 401 before sign-in is normal, not an error worth surfacing
      data = await r.json();
    } catch { return; }
    for (const n of (data && data.unseen) || []) render(n);
  }

  function arm() {
    if (timer) clearInterval(timer);
    timer = setInterval(poll, POLL_VISIBLE_MS);
    void poll();
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden) void poll(); });
  window.addEventListener("pageshow", () => void poll());
  // A payload-free push wakes the service worker, which tells any open tab to look. The card and
  // the system notification therefore never disagree: both read the same server state.
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e && e.data && (e.data.type === "tasks-changed" || e.data.type === "ide-open")) void poll();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arm, { once: true });
  else arm();

  window.DominionTaskNotices = { poll, dismiss, _shown: shown };
})();
