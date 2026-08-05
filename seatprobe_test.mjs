/*
 * SEAT PROBE contract (2026-08-05) — run: node seatprobe_test.mjs
 *
 * Guests may only pick seats we have watched answer. The rule has three edges that each cost
 * something real if they slip, so each gets a test:
 *   1. UNMEASURED IS NOT BLOCKED. Blocking every unprobed seat would empty the picker of the paid
 *      direct lanes carrying the product.
 *   2. STALE IS BLOCKED — and therefore a refresh path must exist. Without ops/seat-probe.mjs
 *      writing fresh evidence, the shipped defaults expire and the free lane vanishes for guests
 *      with no error and no deploy. That is the failure this file is mostly here to catch.
 *   3. SLOW IS BLOCKED at Fred's chosen ceiling, measured as time to FIRST TOKEN.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  SEAT_PROBES, GUEST_TTFT_CEILING_MS, GUEST_PROBE_MAX_AGE_DAYS,
  guestSeatRefusal, isGuestSeat, MODELS, BATTALION_ROSTER, UTILITY_MODEL,
} from "./models.catalog.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

const DAY = 86400000;
const at = (iso) => Date.parse(iso + "T00:00:00Z");
const FRESH = { at: "2026-08-05", ttftMs: 500, ok: true };
const NOW = at("2026-08-05");

t("a seat that was never probed is left alone, not blocked", () => {
  assert.equal(guestSeatRefusal("some/never-probed-model", NOW, {}), "");
  assert.equal(isGuestSeat("some/never-probed-model", NOW, {}), true);
});

t("a fast, fresh seat is offered to guests", () => {
  assert.equal(guestSeatRefusal("x", NOW, { x: FRESH }), "");
});

t("a seat that did not answer is refused", () => {
  const r = guestSeatRefusal("x", NOW, { x: { at: "2026-08-05", ok: false } });
  assert.match(r, /did not answer/);
});

t("a seat slower than the ceiling is refused, and says how slow", () => {
  const r = guestSeatRefusal("x", NOW, { x: { at: "2026-08-05", ttftMs: GUEST_TTFT_CEILING_MS + 1, ok: true } });
  assert.match(r, /too slow/);
  assert.match(r, /10\.0s|10\.1s/);
  // Exactly at the ceiling is still allowed: the rule is "over", not "at".
  assert.equal(guestSeatRefusal("x", NOW, { x: { at: "2026-08-05", ttftMs: GUEST_TTFT_CEILING_MS, ok: true } }), "");
});

t("a probe older than the window is refused as stale", () => {
  const stale = NOW + (GUEST_PROBE_MAX_AGE_DAYS + 1) * DAY;
  assert.match(guestSeatRefusal("x", stale, { x: FRESH }), /last checked more than/);
  // ...and one day inside the window is still good.
  assert.equal(guestSeatRefusal("x", NOW + (GUEST_PROBE_MAX_AGE_DAYS - 1) * DAY, { x: FRESH }), "");
});

t("STALENESS IS A TIME BOMB WITHOUT A REFRESH PATH: the probe script and the overlay both exist", () => {
  // If this fails, the shipped defaults expire and every measured seat silently leaves the guest
  // picker. The gate is only honest if the evidence can be renewed without a deploy.
  assert.ok(existsSync(new URL("./ops/seat-probe.mjs", import.meta.url)),
    "ops/seat-probe.mjs must exist: it is the only way SEAT_PROBES gets refreshed");
  const probe = readFileSync(new URL("./ops/seat-probe.mjs", import.meta.url), "utf8");
  assert.match(probe, /catalog-probes\.json/, "the probe must write the file the server overlays");
  assert.match(probe, /every seat failed/,
    "a total sweep failure must refuse to overwrite good data, or one network fault blanks the picker");

  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(server, /function readSeatProbes\(\)/, "the server must read the refreshed file");
  assert.match(server, /guestSeatRefusal\(m\.id, probeNow, probes\)/,
    "the models route must consult the overlay, not only the shipped defaults");
});

t("every seat the product uses automatically is inside the guest ceiling", () => {
  // Hot paths must never be seated on something a guest is not allowed to pick. If a re-seating
  // ever puts a slow model back on the swarm or the utility path, this fails loudly.
  const hot = [UTILITY_MODEL, BATTALION_ROSTER.assess, BATTALION_ROSTER.orchestrator,
    BATTALION_ROSTER.synthesizer, BATTALION_ROSTER.single, ...BATTALION_ROSTER.workers];
  for (const id of new Set(hot)) {
    const refusal = guestSeatRefusal(id, NOW);
    assert.equal(refusal, "", "hot-path seat " + id + " is refused to guests: " + refusal);
  }
});

t("every probed id is a real catalog seat", () => {
  const ids = new Set(MODELS.map((m) => m.id));
  for (const id of Object.keys(SEAT_PROBES)) {
    assert.ok(ids.has(id), "SEAT_PROBES names " + id + ", which is not in the catalog");
  }
});

t("the seats measured bad on 2026-08-05 are the ones refused", () => {
  assert.match(guestSeatRefusal("z-ai/glm-5.2", NOW), /too slow/);
  assert.match(guestSeatRefusal("meta/llama-3.1-70b-instruct", NOW), /too slow/);
  assert.match(guestSeatRefusal("minimax/minimax-m3", NOW), /too slow/);
  assert.equal(guestSeatRefusal("nvidia/nemotron-3-super-120b-a12b:free", NOW), "");
  assert.equal(guestSeatRefusal("openai/gpt-oss-20b", NOW), "");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
