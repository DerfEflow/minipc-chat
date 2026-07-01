/*
 * Dominion AI — box-health watchdog (hardening).
 *
 * Runs INSIDE the chat server (no new admin/scheduled task needed). Every few minutes it:
 *   - writes a heartbeat (proves the server + its loop are alive) to logs/watchdog.jsonl,
 *   - checks Ollama is reachable,
 *   - checks the Command Deck bridge poller process is alive; if it's gone, best-effort restarts
 *     the "CommandDeck Bridge" scheduled task (own-user Start-ScheduledTask — no elevation for the
 *     task owner) so a crashed poller self-recovers within one interval instead of stranding the box.
 *
 * Note: this cannot fix an OFF-NETWORK box (e.g. after a WiFi password change) — nothing on the box
 * can. It covers the crashed/exited-poller case and gives a local health record for diagnosis.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

function httpOk(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const r = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout: timeoutMs }, (resp) => { resp.resume(); resolve((resp.statusCode || 0) < 500); });
      r.on("error", () => resolve(false));
      r.on("timeout", () => { r.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}
function powershell(script, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const c = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let out = ""; const t = setTimeout(() => { try { c.kill(); } catch {} resolve({ code: -1, out: "timeout" }); }, timeoutMs);
    c.stdout?.on("data", (d) => (out += d)); c.stderr?.on("data", (d) => (out += d));
    c.on("close", (code) => { clearTimeout(t); resolve({ code, out: out.trim() }); });
    c.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out: String(e.message) }); });
  });
}

export function startWatchdog({ logDir, ollamaUrl, intervalMs = 180000, pollerTask = "CommandDeck Bridge", pollerHint = "poller.mjs" }) {
  let ready = false;
  const log = async (o) => { try { if (!ready) { await mkdir(logDir, { recursive: true }); ready = true; } await appendFile(join(logDir, "watchdog.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n"); } catch {} };

  async function tick() {
    const e = { chat: "up" };
    e.ollama = (await httpOk(ollamaUrl.replace(/\/$/, "") + "/api/tags")) ? "up" : "down";
    // Is the bridge poller process alive?
    const q = await powershell(`@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*${pollerHint}*' }).Count`);
    const alive = (parseInt((q.out || "0").replace(/[^0-9]/g, ""), 10) || 0) > 0;
    e.poller = alive ? "up" : "down";
    if (!alive) {
      const r = await powershell(`try { Start-ScheduledTask -TaskName '${pollerTask}' -ErrorAction Stop; 'restarted' } catch { 'restart_failed: ' + $_.Exception.Message }`);
      e.pollerAction = r.out.slice(0, 160);
    }
    await log(e);
    return e;
  }

  // First check shortly after boot (let the server settle), then on the interval.
  setTimeout(() => { tick().catch(() => {}); }, 20000);
  const h = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  if (h.unref) h.unref();
  return { tick };
}
