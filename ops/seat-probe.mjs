#!/usr/bin/env node
/*
 * SEAT PROBE — refresh the evidence that decides what a guest may pick.
 *
 * models.catalog.mjs ships SEAT_PROBES: a dated, measured record per seat. guestSeatRefusal()
 * blocks a seat for a guest when that record says the seat failed, answers too slowly, or has gone
 * stale (older than GUEST_PROBE_MAX_AGE_DAYS). Staleness is a real refusal, which means WITHOUT
 * THIS SCRIPT RUNNING the shipped defaults expire and every measured seat quietly disappears from
 * the guest picker. That is the whole reason this file exists.
 *
 * Run it FROM THE DEPLOYED CONTAINER, not a laptop. The shipped numbers were measured from Fred's
 * home connection; Railway runs in sfo and its path to the provider differs. See ledger L-007.
 *
 *   railway ssh "node ops/seat-probe.mjs"          # measure and write /data/catalog-probes.json
 *   node ops/seat-probe.mjs --dry                  # measure and print, write nothing
 *
 * Output overlays the shipped defaults at runtime, so a refresh needs no deploy.
 *
 * WHAT IS MEASURED: median time-to-first-token over N streaming samples, because that is the
 * number a waiting human feels. Not average latency, not total completion time. A seat that never
 * produces a first token inside the timeout is recorded ok:false, which is a hard refusal.
 */
import { writeFileSync } from "node:fs";
import { MODELS, SEAT_PROBES, GUEST_TTFT_CEILING_MS } from "../models.catalog.mjs";

const OUT = process.env.CATALOG_PROBE_FILE || "/data/catalog-probes.json";
const SAMPLES = Number(process.env.SEAT_PROBE_SAMPLES || 4);
const TIMEOUT_MS = Number(process.env.SEAT_PROBE_TIMEOUT_MS || 60000);
const DRY = process.argv.includes("--dry");

const KEY = process.env.NVIDIA_API_KEY || process.env.NVIDIA_KEY || "";
const URL = process.env.NVIDIA_URL || "https://integrate.api.nvidia.com/v1/chat/completions";

// Only the free NVIDIA lane is swept. The paid direct lanes are not probed and are deliberately
// NOT blocked when unmeasured (guestSeatRefusal returns "" for an unknown seat) — blocking the
// unmeasured would empty the picker of the lanes carrying the product. See ledger L-008.
const SEATS = MODELS.filter((m) => m.provider === "nvidia").map((m) => ({ id: m.id, directId: m.directId || m.id }));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

async function ttft(directId) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL, {
      method: "POST", signal: ac.signal,
      headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: directId, stream: true, max_tokens: 24, temperature: 0,
        messages: [{ role: "user", content: "Name three colors." }],
      }),
    });
    if (!res.ok) return { ms: null, err: "HTTP " + res.status };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const line of buf.split("\n")) {
        if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
        try {
          const d = JSON.parse(line.slice(6)).choices?.[0]?.delta || {};
          if ((d.content || "").length || (d.reasoning_content || "").length) {
            const ms = Date.now() - t0;
            reader.cancel().catch(() => {});
            return { ms, err: null };
          }
        } catch { /* a partial frame: keep reading */ }
      }
    }
    return { ms: null, err: "stream ended with no content" };
  } catch (e) {
    return { ms: null, err: e.name === "AbortError" ? "timeout" : String(e.message || e) };
  } finally { clearTimeout(timer); }
}

if (!KEY) {
  console.error("seat-probe: no NVIDIA key in env — nothing measured, nothing written.");
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);
const probes = {};
let blocked = 0;

for (const seat of SEATS) {
  const oks = [];
  let lastErr = "";
  for (let i = 0; i < SAMPLES; i++) {
    const r = await ttft(seat.directId);
    if (r.ms != null) oks.push(r.ms); else lastErr = r.err;
  }
  // A seat that answered at least once is alive; its ttft is the median of the answers it gave.
  const ms = median(oks);
  probes[seat.id] = oks.length
    ? { at: today, ttftMs: ms, ok: true }
    : { at: today, ttftMs: null, ok: false, note: lastErr };
  const verdict = !oks.length ? "DEAD" : ms > GUEST_TTFT_CEILING_MS ? "BLOCKED" : "ok";
  if (verdict !== "ok") blocked++;
  console.log(
    verdict.padEnd(8) + seat.id.padEnd(46) +
    (oks.length ? (ms / 1000).toFixed(1) + "s median of " + oks.length + "/" + SAMPLES : "no answer: " + lastErr)
  );
}

console.log("\n" + Object.keys(probes).length + " seats probed, " + blocked + " refused to guests.");
// Never write an empty or total-wipeout result over good data: a network outage on the probing
// side would otherwise blank the guest picker. If EVERY seat failed, that is far more likely to be
// our connectivity than every provider seat dying at once.
if (blocked === Object.keys(probes).length && Object.keys(probes).length > 1) {
  console.error("every seat failed — refusing to overwrite " + OUT + " (this looks like a local network fault, not a provider outage)");
  process.exit(3);
}
if (DRY) { console.log("\n--dry: nothing written."); process.exit(0); }
writeFileSync(OUT, JSON.stringify({ updated: today, probes }, null, 2));
console.log("wrote " + OUT);
