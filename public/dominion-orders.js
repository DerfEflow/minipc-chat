/*
 * Dominion AI — Scheduled Work Orders, the surface (Fred, 2026-07-31).
 *
 * "You access that option in the hamburger menu on both mobile and desktop... the dashboard should
 * be a pop up layer that is exited upon sending the work order so we reduce clutter."
 *
 * So this is one overlay doing two jobs. It opens showing what is already scheduled and what ran
 * last night, and it closes the instant an order is sent. The list of standing orders is the
 * dashboard; there is no second screen to build or to keep in step.
 *
 * The layer is appended to <body> rather than nested in the drawer, because a fixed-position child
 * of a transformed ancestor is positioned against that ancestor instead of the viewport, and the
 * drawer is transformed. That trap has already cost this app one round of confused debugging.
 *
 * Nothing here interprets anything. The task list arrives from the server, every entry is a fixed
 * job with a fixed executor, and this screen only picks one and names a time.
 */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const state = { tasks: [], orders: [], machines: [], loaded: false, busy: false };
  // The zone of the device placing the order, so "3am" means 3am where the person is standing.
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
  const DEVICE = (() => (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "phone" : "desktop"))();

  const api = async (path, body) => {
    const r = await fetch(path, body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : { headers: { accept: "application/json" } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
    return j;
  };

  function layer() {
    let el = $("#wo-layer");
    if (el) return el;
    el = document.createElement("div");
    el.id = "wo-layer";
    el.className = "wo-layer";
    el.hidden = true;
    el.innerHTML =
      '<div class="wo-scrim" data-close="1"></div>' +
      '<div class="wo-panel" role="dialog" aria-modal="true" aria-label="Scheduled work orders">' +
        '<div class="wo-head">' +
          '<span class="wo-title">Scheduled Work Orders</span>' +
          '<button type="button" class="wo-x" data-close="1" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="wo-body">' +
          '<div class="wo-standing" id="wo-standing"></div>' +
          '<div class="wo-new">' +
            '<div class="wo-h">Place a new order</div>' +
            '<label class="wo-f"><span>Job</span><select id="wo-task"></select></label>' +
            '<p class="wo-blurb" id="wo-blurb"></p>' +
            '<label class="wo-f"><span>Folder</span><input id="wo-folder" type="text" spellcheck="false" placeholder="C:\\Users\\you\\Downloads" /></label>' +
            '<label class="wo-f"><span>Machine</span><select id="wo-node"></select></label>' +
            '<div class="wo-when">' +
              '<label class="wo-f"><span>How often</span><select id="wo-cadence">' +
                '<option value="daily">Every day</option><option value="weekly">Every week</option><option value="once">Once</option>' +
              '</select></label>' +
              '<label class="wo-f"><span>At</span><input id="wo-time" type="time" value="03:00" /></label>' +
              '<label class="wo-f wo-wd" id="wo-wd-wrap" hidden><span>On</span><select id="wo-weekday">' +
                '<option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option>' +
                '<option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="0">Sunday</option>' +
              '</select></label>' +
            '</div>' +
            '<p class="wo-note" id="wo-note"></p>' +
            '<div class="wo-actions">' +
              '<button type="button" id="wo-send" class="wo-send">Send work order</button>' +
            '</div>' +
            '<p class="wo-status" id="wo-status"></p>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener("click", (e) => { if (e.target && e.target.dataset && e.target.dataset.close) close(); });
    $("#wo-task", el).addEventListener("change", paintTask);
    $("#wo-cadence", el).addEventListener("change", paintTask);
    $("#wo-time", el).addEventListener("change", paintTask);
    $("#wo-send", el).addEventListener("click", send);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.hidden) close(); });
    return el;
  }

  const status = (msg, bad) => { const s = $("#wo-status"); if (s) { s.textContent = msg || ""; s.classList.toggle("bad", !!bad); } };

  function paintTask() {
    const t = state.tasks.find((x) => x.id === $("#wo-task").value);
    $("#wo-blurb").textContent = t ? t.blurb : "";
    const weekly = $("#wo-cadence").value === "weekly";
    $("#wo-wd-wrap").hidden = !weekly;
    // Say plainly what will happen the FIRST time, because for anything that moves files the answer
    // is "nothing yet", and a person who is not told that will think the job failed.
    const note = $("#wo-note");
    if (t && t.movesFiles) {
      note.textContent = "The first run is a dry run: it will list every move it would make and change nothing. You approve it here, and the run after that does the work. Nothing is ever deleted or overwritten, and any run can be undone.";
      note.hidden = false;
    } else if (t) {
      note.textContent = "This job only looks and reports. It changes nothing.";
      note.hidden = false;
    } else note.hidden = true;
  }

  function orderRow(o) {
    const el = document.createElement("div");
    el.className = "wo-row" + (o.enabled ? "" : " off");
    const when = o.lastRunAt ? new Date(o.lastRunAt).toLocaleString() : "";
    const statusBits = o.lastStatus === "waiting"
      ? `<span class="wo-badge wait">waiting for ${o.node || "a machine"}</span>`
      : o.lastStatus === "failed" ? '<span class="wo-badge bad">failed</span>'
      : o.lastStatus === "dry-run" ? '<span class="wo-badge dry">dry run done</span>'
      : o.lastStatus === "ok" ? '<span class="wo-badge ok">ran</span>' : "";
    el.innerHTML =
      `<div class="wo-row-top"><b>${esc(o.taskLabel)}</b>${statusBits}</div>` +
      `<div class="wo-row-sub">${esc(o.folder)}</div>` +
      `<div class="wo-row-sub">${esc(o.schedule)}${o.node ? " on " + esc(o.node) : ""}</div>` +
      (o.lastSummary ? `<div class="wo-row-last">${esc(o.lastSummary)}${when ? ` <span class="wo-dim">${esc(when)}</span>` : ""}</div>` : "") +
      '<div class="wo-row-btns">' +
        (o.dryRunFirst && o.lastStatus === "dry-run" ? '<button type="button" data-act="approve">Approve and run for real</button>' : "") +
        '<button type="button" data-act="run">Run now</button>' +
        (o.journal && o.journal.length ? '<button type="button" data-act="undo">Undo last run</button>' : "") +
        `<button type="button" data-act="toggle">${o.enabled ? "Pause" : "Resume"}</button>` +
        '<button type="button" data-act="delete" class="wo-del">Remove</button>' +
      '</div>';
    el.addEventListener("click", async (e) => {
      const act = e.target && e.target.dataset && e.target.dataset.act;
      if (!act || state.busy) return;
      state.busy = true;
      try {
        if (act === "run" || act === "approve") {
          status(act === "approve" ? "Running for real..." : "Running now...");
          const r = await api("/work-orders/run", { id: o.id, force: act === "approve" });
          status(r.waiting ? `That machine is not online. It will run the moment ${o.node || "it"} reconnects.`
            : r.ok ? r.summary : (r.error || "It did not run."), !r.ok && !r.waiting);
        } else if (act === "undo") {
          status("Putting the files back...");
          const r = await api("/work-orders/undo", { id: o.id });
          status(r.ok ? r.summary : (r.error || "Could not undo."), !r.ok);
        } else if (act === "toggle") { await api("/work-orders/enable", { id: o.id, enabled: !o.enabled }); }
        else if (act === "delete") { await api("/work-orders/delete", { id: o.id }); }
        await load();
      } catch (err) { status(String(err.message || err), true); }
      finally { state.busy = false; }
    });
    return el;
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function paint() {
    const box = $("#wo-standing");
    box.textContent = "";
    if (!state.orders.length) {
      const p = document.createElement("p");
      p.className = "wo-empty";
      p.textContent = "No standing orders yet. Pick a job below and it will run on its own from then on.";
      box.append(p);
    } else {
      const h = document.createElement("div");
      h.className = "wo-h";
      h.textContent = "Standing orders";
      box.append(h);
      for (const o of state.orders) box.append(orderRow(o));
    }
    const taskSel = $("#wo-task");
    if (taskSel && !taskSel.options.length) {
      for (const t of state.tasks) { const o = document.createElement("option"); o.value = t.id; o.textContent = t.label; taskSel.append(o); }
    }
    const nodeSel = $("#wo-node");
    if (nodeSel) {
      const prev = nodeSel.value;
      nodeSel.textContent = "";
      if (!state.machines.length) {
        const o = document.createElement("option"); o.value = ""; o.textContent = "No machine is connected right now";
        nodeSel.append(o);
      }
      for (const m of state.machines) { const o = document.createElement("option"); o.value = m; o.textContent = m; nodeSel.append(o); }
      if (prev && state.machines.includes(prev)) nodeSel.value = prev;
    }
    paintTask();
  }

  async function load() {
    const j = await api("/work-orders");
    state.tasks = j.tasks || []; state.orders = j.orders || []; state.machines = j.machines || [];
    state.loaded = true;
    paint();
    paintDot(j.unseen || 0);
  }

  function paintDot(n) {
    const b = $("#sb-orders");
    if (b) b.classList.toggle("has-new", Number(n) > 0);
  }

  async function open() {
    const el = layer();
    el.hidden = false;
    document.body.classList.add("wo-open");
    status("");
    try { await load(); await api("/work-orders/seen", {}); paintDot(0); }
    catch (e) { status(String(e.message || e), true); }
  }
  function close() { const el = $("#wo-layer"); if (el) el.hidden = true; document.body.classList.remove("wo-open"); }

  async function send() {
    if (state.busy) return;
    const folder = $("#wo-folder").value.trim();
    if (!folder) { status("Which folder should it work on?", true); return; }
    const [hh, mm] = String($("#wo-time").value || "03:00").split(":");
    state.busy = true;
    status("Sending...");
    try {
      const r = await api("/work-orders", {
        task: $("#wo-task").value, folder, node: $("#wo-node").value || "",
        cadence: $("#wo-cadence").value, atHour: Number(hh), atMinute: Number(mm),
        weekday: Number($("#wo-weekday").value), tz: TZ, createdFrom: DEVICE,
      });
      // Fred's rule: the layer exits on send, so the screen goes back to the conversation rather
      // than leaving a panel open over it. The confirmation rides in the chat status line instead.
      close();
      $("#wo-folder").value = "";
      const msg = `Work order placed: ${r.order.taskLabel}, ${r.order.schedule.toLowerCase()}${r.order.node ? " on " + r.order.node : ""}.`;
      try { document.dispatchEvent(new CustomEvent("dominion-toast", { detail: { message: msg } })); } catch {}
      if (window.DominionTenant && typeof window.DominionTenant.toast === "function") window.DominionTenant.toast(msg);
      else console.log("[work-orders] " + msg);
    } catch (e) { status(String(e.message || e), true); }
    finally { state.busy = false; }
  }

  function wire() {
    const btn = $("#sb-orders");
    if (btn && !btn.dataset.wired) { btn.dataset.wired = "1"; btn.addEventListener("click", (e) => { e.preventDefault(); open(); }); }
    // The dot is a background check: it tells you something ran without you having to look.
    api("/work-orders").then((j) => paintDot(j.unseen || 0)).catch(() => {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
  window.DominionWorkOrders = { open, close, reload: load };
})();
