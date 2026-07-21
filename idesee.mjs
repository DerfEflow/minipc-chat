/*
 * The Crucible: run-and-see.
 *   Fred's ruling 2026-07-21: after a build passes its checks, the engine should LOOK at what it
 *   made. Checks prove the code runs; nothing proved it looked right, and a beginner asking for
 *   "something beautiful" was getting the model's taste, unverified.
 *
 * The loop: serve the project, open it in the machine's own Chrome through the hands node, take a
 * screenshot, pull the pixels back, show them to a vision-capable model next to what the user
 * asked for, and apply ONE round of visual fixes. Then look again so the after shot is on the
 * record. One round, deliberately: a taste loop that runs unattended is a money printer with no
 * off switch.
 *
 * EVERY step degrades honestly. No start script and no index.html: say so and skip. Browser
 * refused (guests do not get browser_control): say so and skip. No vision-capable model with a
 * key: say so and skip. The build is already a success by the time this runs; seeing is polish,
 * never a gate.
 *
 * Dependency-injected like the engine: hands(tool, args), chat({model, messages}), and the
 * caller's emit surface. Testable with fakes, no server required.
 */

export const PREVIEW_PORT = 37311;

// A static file server in one line of node, launched DETACHED on the user's machine. Written as
// an -e one-liner so it needs nothing installed beyond node itself, which the hands node proves.
const STATIC_SERVER_JS = [
  "const h=require('http'),f=require('fs'),p=require('path'),r=process.argv[1];",
  "h.createServer((q,s)=>{let u=decodeURIComponent((q.url||'/').split('?')[0]);if(u.endsWith('/'))u+='index.html';",
  "const fp=p.join(r,u);if(!fp.startsWith(r))return s.writeHead(403).end();",
  "f.readFile(fp,(e,b)=>{if(e){s.writeHead(404);return s.end('not found')}",
  "const x={'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.json':'application/json'};",
  "s.writeHead(200,{'content-type':x[p.extname(fp)]||'application/octet-stream'});s.end(b)})",
  "}).listen(" + PREVIEW_PORT + ",'127.0.0.1')",
].join("");

/*
 * What can we run? A start script wins; a bare index.html gets the static server. Neither means
 * an honest skip. Returns { mode: "script"|"static"|null, why, command? }.
 */
export function runPlanFor(packageJsonText, { hasIndexHtml = false } = {}) {
  let scripts = null;
  try { scripts = (JSON.parse(String(packageJsonText || "{}")) || {}).scripts || null; } catch {}
  const name = scripts && ["start", "dev", "serve", "preview"].find((n) => typeof scripts[n] === "string" && scripts[n].trim());
  if (name) return { mode: "script", command: "npm run " + name, why: "package.json defines a " + name + " script" };
  if (hasIndexHtml) return { mode: "static", why: "index.html at the project root, served statically" };
  return { mode: null, why: "nothing runnable: no start script and no index.html" };
}

// The vision prompt. The screenshot travels as pixels; the reply is a short list of concrete
// visual fixes, or the single word GOOD when there is nothing worth changing.
export function visionMessages({ goal, imageBase64 }) {
  return [
    { role: "system", content: [
      "You review a screenshot of a freshly built page against what the user asked for.",
      "Reply with AT MOST five concrete visual fixes, one per line, each something a stylesheet or",
      "markup change can achieve (spacing, contrast, alignment, hierarchy, overflow, empty states).",
      "Name what you see, plainly. If the page already serves the goal well, reply with the single",
      "word GOOD and nothing else.",
    ].join("\n") },
    { role: "user", content: [
      { type: "text", text: "The user asked for: " + String(goal || "").slice(0, 1200) },
      { type: "image_url", image_url: { url: "data:image/png;base64," + imageBase64 } },
    ] },
  ];
}

export function createRunAndSee({ hands, chat, jobs, log = () => {} } = {}) {
  if (!hands || !chat || !jobs) throw new Error("createRunAndSee needs hands, chat, jobs");

  const emitRun = (job, o) => jobs.emit(job.id, { type: "run", ...o });

  /*
   * Install dependencies when the project declares some and node_modules is absent. Long timeout,
   * honest tail either way. npm quirk: `--no-audit --no-fund` keeps the output about the install.
   */
  async function ensureDeps(job, root, pkgText) {
    let deps = null;
    try { const p = JSON.parse(pkgText || "{}"); deps = { ...(p.dependencies || {}), ...(p.devDependencies || {}) }; } catch {}
    if (!deps || !Object.keys(deps).length) return { ok: true, skipped: "no dependencies declared" };
    const ls = await hands("fs_list", { path: root });
    const names = ((ls && ls.entries) || []).map((e) => (typeof e === "string" ? e : e.name));
    if (names.includes("node_modules")) return { ok: true, skipped: "node_modules already present" };
    emitRun(job, { command: "npm install", ok: true, output: "Installing what the project needs. This can take a few minutes the first time." });
    const r = await hands("shell_run", { command: "cd \"" + root + "\"; npm install --no-audit --no-fund", timeoutMs: 480000 });
    const code = (r && (r.code ?? r.exitCode)) || 0;
    const out = String((r && (r.stdout || r.output)) || "") + String((r && r.stderr) || "");
    emitRun(job, { command: "npm install", ok: code === 0, output: out.slice(-2500) });
    return { ok: code === 0, output: out };
  }

  /*
   * Launch detached and capture the PID, so the preview can be stopped no matter what happens
   * in between. PS 5.1 trap that broke the static path live (2026-07-21): Start-Process joins
   * ArgumentList elements UNQUOTED, so an -e script containing spaces arrived at node as many
   * arguments and the server never started. The elements carry their own double quotes now
   * (the one-liner contains no double quotes by construction; the assert keeps it that way).
   */
  async function launch(job, root, plan) {
    if (STATIC_SERVER_JS.includes('"')) return { ok: false, error: "static server script must stay double-quote-free" };
    const ps = plan.mode === "static"
      ? "$p = Start-Process node -ArgumentList @('-e', '\"" + STATIC_SERVER_JS.replace(/'/g, "''") + "\"', '\"" + root.replace(/'/g, "''") + "\"') -WindowStyle Hidden -PassThru; $p.Id"
      : "$env:PORT='" + PREVIEW_PORT + "'; $p = Start-Process cmd -ArgumentList @('/c', 'cd /d \"" + root + "\" && " + plan.command + "') -WindowStyle Hidden -PassThru; $p.Id";
    const r = await hands("shell_run", { command: ps, timeoutMs: 30000 });
    const pid = parseInt(String((r && (r.stdout || r.output)) || "").trim().split(/\s+/).pop(), 10);
    if (!pid || Number.isNaN(pid)) return { ok: false, error: "the preview process did not report a pid" };
    return { ok: true, pid };
  }

  async function stopPreview(pid) {
    if (!pid) return;
    try {
      // The child (npm) spawns the real server, so the tree goes together.
      await hands("shell_run", { command: "taskkill /F /T /PID " + pid, timeoutMs: 20000 });
    } catch {}
  }

  // The preview server was launched detached a moment ago; navigating before it listens parks
  // Chrome on a dead page and the later screenshot times out (seen live twice). Poll until the
  // port answers, briefly, before pointing the browser at it.
  async function waitUp() {
    for (let i = 0; i < 10; i++) {
      const r = await hands("shell_run", {
        command: "node -e \"require('http').get('http://127.0.0.1:" + PREVIEW_PORT + "/',r=>{process.exit(0)}).on('error',()=>process.exit(1))\"",
        timeoutMs: 8000 });
      if (((r && (r.code ?? r.exitCode)) || 0) === 0) return true;
      await new Promise((res) => setTimeout(res, 700));
    }
    return false;
  }

  async function screenshot(job, label) {
    const open = await hands("browser_control", { op: "navigate", url: "http://127.0.0.1:" + PREVIEW_PORT + "/" });
    if (!open || open.ok === false) {
      const first = await hands("browser_control", { op: "open", url: "http://127.0.0.1:" + PREVIEW_PORT + "/" });
      if (!first || first.ok === false) return { ok: false, refused: true, error: (first && first.error) || (open && open.error) || "browser refused" };
    }
    await new Promise((r) => setTimeout(r, 1800));   // let the page settle before judging it
    let shot = await hands("browser_control", { op: "screenshot" });
    if (!shot || shot.ok === false || !shot.path) {
      // One retry after a beat: a page mid-paint can time the first capture out.
      await new Promise((r) => setTimeout(r, 1500));
      shot = await hands("browser_control", { op: "screenshot" });
    }
    if (!shot || shot.ok === false || !shot.path) return { ok: false, error: (shot && shot.error) || "no screenshot" };
    const img = await hands("fs_read", { path: shot.path, base64: true, maxBytes: 15000000 });
    if (!img || img.ok === false || !img.base64) return { ok: false, error: "screenshot could not be read back" };
    emitRun(job, { command: "look (" + label + ")", ok: true, output: "Screenshot taken: " + shot.path });
    return { ok: true, base64: img.base64, path: shot.path };
  }

  /*
   * The whole loop. `applyFixes` is handed back to the caller (the build runner owns moves and
   * money); this module only decides WHAT the fixes are and proves the before and after.
   */
  async function run(job, { workspace, goal, visionModel, applyFixes }) {
    const root = workspace.root.replace(/[\\/]+$/, "");
    let pkg = "", hasIndex = false;
    try { const r = await hands("fs_read", { path: root + "/package.json", maxBytes: 40000 }); pkg = (r && (r.content || r.text)) || ""; } catch {}
    try { const r = await hands("fs_list", { path: root }); hasIndex = ((r && r.entries) || []).map((e) => (typeof e === "string" ? e : e.name)).includes("index.html"); } catch {}

    const plan = runPlanFor(pkg, { hasIndexHtml: hasIndex });
    if (!plan.mode) { emitRun(job, { skipped: true, message: "Did not run it: " + plan.why + "." }); return { skipped: "not_runnable" }; }

    const dep = await ensureDeps(job, root, pkg);
    if (!dep.ok) { emitRun(job, { skipped: true, message: "Dependencies did not install, so it was not run. The output is above." }); return { skipped: "deps_failed" }; }

    const started = await launch(job, root, plan);
    if (!started.ok) { emitRun(job, { skipped: true, message: "It could not be started: " + started.error + "." }); return { skipped: "launch_failed" }; }
    const up = await waitUp();
    if (!up) { await stopPreview(started.pid); emitRun(job, { skipped: true, message: "The preview never answered on its port, so the look was not checked." }); return { skipped: "server_never_up" }; }

    try {
      const before = await screenshot(job, "before");
      if (before.refused) { emitRun(job, { skipped: true, message: "This machine's browser is not available to Dominion, so the look was not checked." }); return { skipped: "browser_refused" }; }
      if (!before.ok) { emitRun(job, { skipped: true, message: "The page could not be photographed: " + before.error + "." }); return { skipped: "shot_failed" }; }

      if (!visionModel) { emitRun(job, { skipped: true, message: "No vision-capable model is available, so the look was not judged." }); return { skipped: "no_vision_model", shot: before.path }; }

      const judged = await chat({ model: visionModel, messages: visionMessages({ goal, imageBase64: before.base64 }) });
      if (!judged.ok) { emitRun(job, { skipped: true, message: "The look could not be judged: " + (judged.error || "the vision call failed") + "." }); return { skipped: "vision_failed", costUsd: judged.costUsd || 0 }; }

      const verdict = String(judged.content || "").trim();
      if (/^GOOD\b/i.test(verdict)) {
        emitRun(job, { command: "look", ok: true, output: "Looked at the running page: it serves the goal as asked. No visual changes needed." });
        return { good: true, costUsd: judged.costUsd || 0 };
      }

      emitRun(job, { command: "look", ok: true, output: "Looked at the running page. Improving:\n" + verdict.slice(0, 1200) });
      let fixCost = 0;
      if (typeof applyFixes === "function") {
        const fixed = await applyFixes(verdict);
        fixCost = (fixed && fixed.costUsd) || 0;
        const after = await screenshot(job, "after");
        if (after.ok) emitRun(job, { command: "look (after)", ok: true, output: "Second look taken after the improvements: " + after.path });
      }
      return { improved: true, critique: verdict, costUsd: (judged.costUsd || 0) + fixCost };
    } finally {
      await stopPreview(started.pid);
    }
  }

  return { run, ensureDeps, launch, stopPreview, screenshot };
}
