/*
 * Dominion hands node - real browser control over the Chrome DevTools Protocol.
 *
 * ZERO npm dependencies, matching the rest of this repo: Chrome/Edge is launched with
 * --remote-debugging-port, discovered over plain HTTP, and driven through Node 24's built-in
 * global WebSocket. No Playwright, no puppeteer, no browser download.
 *
 * It drives a PERSISTENT dedicated profile (HANDS_BROWSER_PROFILE, default <node dir>/.browser),
 * so a site you log into once inside this browser stays logged in for later runs. That is the
 * point of the feature: reach sites that need a real session.
 *
 * Carve-outs: executeJob() in hands.mjs scans every arg blob before we are called, so a
 * file:///D:/backups URL is already refused. We additionally refuse the whole file: scheme, so
 * filesystem reads keep going through fs_read and stay inside the node's configured roots.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const IS_WIN = process.platform === "win32";
const PORT = Number(process.env.HANDS_BROWSER_PORT || 9333) || 9333;
const HEADLESS = String(process.env.HANDS_BROWSER_HEADLESS || "") === "1";

const CHROME_CANDIDATES = IS_WIN ? [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];

let child = null;          // the browser process we launched (null if we attached to an existing one)
let ws = null;             // active page WebSocket
let wsTargetId = "";
let nextId = 1;
const pending = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (dir) => join(dir, `shot-${Date.now()}.png`);

function browserExe() {
  const override = String(process.env.HANDS_BROWSER_EXE || "").trim();
  if (override && existsSync(override)) return override;
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  return "";
}

async function httpJson(path, timeoutMs = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: ctl.signal });
    return await r.json();
  } finally { clearTimeout(t); }
}

async function portAlive() { try { await httpJson("/json/version", 1500); return true; } catch { return false; } }

export async function ensureBrowser({ profileDir }) {
  if (await portAlive()) return { ok: true, alreadyRunning: true };
  const exe = browserExe();
  if (!exe) return { ok: false, error: "no Chrome or Edge found on this machine. Set HANDS_BROWSER_EXE to the browser executable." };
  mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-features=Translate",
    "--remote-allow-origins=*",
    ...(HEADLESS ? ["--headless=new"] : []),
    "about:blank",
  ];
  try { child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false }); child.unref(); }
  catch (e) { return { ok: false, error: "could not launch browser: " + (e && e.message) }; }
  for (let i = 0; i < 40; i++) { await sleep(250); if (await portAlive()) return { ok: true, launched: true, exe }; }
  return { ok: false, error: "browser did not open its debugging port in 10s" };
}

async function pageTargets() {
  const list = await httpJson("/json/list");
  return (Array.isArray(list) ? list : []).filter((t) => t.type === "page");
}

async function attach(targetId) {
  const targets = await pageTargets();
  let target = targetId ? targets.find((t) => t.id === targetId) : targets[0];
  if (!target) {
    await httpJson("/json/new?about:blank").catch(() => {});
    await sleep(400);
    target = (await pageTargets())[0];
  }
  if (!target) throw new Error("no page target available in the browser");
  if (ws && wsTargetId === target.id && ws.readyState === 1) return ws;
  if (ws) { try { ws.close(); } catch {} ws = null; }
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("websocket connect timeout")), 8000);
    sock.onopen = () => { clearTimeout(t); res(); };
    sock.onerror = () => { clearTimeout(t); rej(new Error("websocket error")); };
  });
  sock.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message || "cdp error")) : p.res(m.result); }
  };
  sock.onclose = () => { if (ws === sock) { ws = null; wsTargetId = ""; } };
  ws = sock; wsTargetId = target.id;
  await send("Page.enable", {}).catch(() => {});
  await send("Runtime.enable", {}).catch(() => {});
  return ws;
}

function send(method, params = {}) {
  if (!ws || ws.readyState !== 1) return Promise.reject(new Error("browser is not attached"));
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out`)); }, 45000);
    const wrap = (fn) => (v) => { clearTimeout(t); fn(v); };
    pending.set(id, { res: wrap(res), rej: wrap(rej) });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Evaluate JS in the page and return the plain value.
async function evaluate(expression, awaitPromise = true) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || "").slice(0, 200));
  return r.result?.value;
}
const jsStr = (s) => JSON.stringify(String(s));

async function waitForLoad(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evaluate("document.readyState") === "complete") return true; } catch {}
    await sleep(250);
  }
  return false;
}

// ---- the verbs -------------------------------------------------------------------------------
export async function browserOp(op, args, { profileDir, shotDir }) {
  if (op === "close") {
    if (ws) { try { ws.close(); } catch {} ws = null; wsTargetId = ""; }
    if (child) { try { process.kill(-child.pid); } catch { try { child.kill(); } catch {} } child = null; }
    else { try { await evaluate("window.close()"); } catch {} }
    return { ok: true, closed: true };
  }

  const up = await ensureBrowser({ profileDir });
  if (!up.ok) return { ok: false, error: up.error };
  await attach(args.targetId);

  switch (op) {
    case "open":
      return { ok: true, launched: !!up.launched, alreadyRunning: !!up.alreadyRunning, port: PORT, profile: profileDir };

    case "tabs": {
      const t = await pageTargets();
      return { ok: true, tabs: t.map((x) => ({ id: x.id, title: x.title, url: x.url, active: x.id === wsTargetId })) };
    }

    case "navigate": {
      const url = String(args.url || "");
      if (/^file:/i.test(url)) return { ok: false, refused: true, reason: "the file: scheme is refused in the browser; use fs_read so filesystem reach stays inside this node's allowed roots" };
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "url must start with http:// or https://" };
      await send("Page.navigate", { url });
      await waitForLoad();
      const title = await evaluate("document.title").catch(() => "");
      return { ok: true, url: await evaluate("location.href").catch(() => url), title };
    }

    case "read": {
      const max = Math.min(Number(args.max) || 12000, 40000);
      const text = await evaluate(`(()=>{const m=document.querySelector('main,article')||document.body;return (m&&m.innerText||'').replace(/\\n{3,}/g,'\\n\\n').slice(0,${max})})()`);
      return { ok: true, url: await evaluate("location.href"), title: await evaluate("document.title"), text: text || "" };
    }

    case "elements": {
      // Interactive inventory, so the model can pick a target without guessing selectors.
      const max = Math.min(Number(args.max) || 60, 200);
      const list = await evaluate(`(()=>{const out=[];const q=document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[onclick]');
        for(const e of q){ if(out.length>=${max}) break; const r=e.getBoundingClientRect(); if(r.width===0&&r.height===0) continue;
          out.push({tag:e.tagName.toLowerCase(),type:e.getAttribute('type')||'',text:(e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').trim().slice(0,80),
            id:e.id||'',name:e.getAttribute('name')||'',href:(e.getAttribute('href')||'').slice(0,120)}); }
        return out})()`);
      return { ok: true, elements: list || [] };
    }

    case "click": {
      const sel = String(args.selector || "");
      if (!sel) return { ok: false, error: "selector is required" };
      const hit = await evaluate(`(()=>{const e=document.querySelector(${jsStr(sel)}); if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,text:(e.innerText||e.value||'').slice(0,80)}})()`);
      if (!hit) return { ok: false, error: `no element matched ${sel}` };
      // Real input events, so handlers that ignore synthetic .click() still fire.
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: Math.round(hit.x), y: Math.round(hit.y), button: "left", clickCount: 1 });
      }
      await sleep(400);
      await waitForLoad(6000);
      return { ok: true, clicked: sel, label: hit.text, url: await evaluate("location.href").catch(() => "") };
    }

    case "type": {
      const sel = String(args.selector || ""), text = String(args.text ?? "");
      if (!sel) return { ok: false, error: "selector is required" };
      const focused = await evaluate(`(()=>{const e=document.querySelector(${jsStr(sel)}); if(!e) return false; e.focus(); if('value' in e) e.value=''; return true})()`);
      if (!focused) return { ok: false, error: `no element matched ${sel}` };
      await send("Input.insertText", { text });
      await evaluate(`(()=>{const e=document.querySelector(${jsStr(sel)}); if(e){e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
      if (args.enter) {
        for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await sleep(500); await waitForLoad(8000);
      }
      return { ok: true, typed: text.length + " chars into " + sel, url: await evaluate("location.href").catch(() => "") };
    }

    case "eval": {
      const out = await evaluate(String(args.expression || "null"));
      return { ok: true, result: typeof out === "string" ? out.slice(0, 8000) : out };
    }

    case "screenshot": {
      mkdirSync(shotDir, { recursive: true });
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: !!args.fullPage });
      const path = shot(shotDir);
      writeFileSync(path, Buffer.from(r.data, "base64"));
      return { ok: true, path, bytes: Buffer.byteLength(r.data, "base64"), note: "saved on the node; open it there or pull it with fs_read" };
    }

    case "back": { await send("Runtime.evaluate", { expression: "history.back()" }); await sleep(600); return { ok: true, url: await evaluate("location.href") }; }

    default:
      return { ok: false, error: "unknown browser op: " + op };
  }
}
