#!/usr/bin/env node
/*
 * ops/prod-verify.mjs (2026-09-03, foundry lane, LANE-foundry.md item 5) — an owner-level
 * production smoke test, run from THIS LAPTOP against the live app.
 *
 * Authenticates through Cloudflare Access with a SERVICE TOKEN: CF-Access-Client-Id /
 * CF-Access-Client-Secret headers, read from C:\Users\rjfla\.dominion-verify-token
 * (VERIFY_CF_CLIENT_ID=... / VERIFY_CF_CLIENT_SECRET=...). Values are read into memory only long
 * enough to build the header object below; nothing from that file is ever logged or included in an
 * error message.
 *
 * WHAT THIS TOKEN DOES AND DOES NOT DO (DEFICIENCIES.md #26): Cloudflare's edge validates these
 * headers against the Access app's service-token policy and, if they match, forwards the request to
 * origin instead of redirecting to the login page. That is authentication at the EDGE. It is not,
 * by itself, "the owner" inside Dominion's own tenancy layer -- resolveTenant() in server.mjs
 * decides isOwner from an email claim that a service-token identity does not carry. Until the app
 * is taught to recognize this token as owner (or a different mechanism is wired), several checks
 * below (isOwner, and anything gated behind identity/credits) are EXPECTED to come back as a plain
 * refusal rather than a network error. That is a legitimate FAIL line, not a crash, and this script
 * says so rather than pretending otherwise.
 *
 * A 3xx response (redirect to the Access login page) is the other honest failure mode this script
 * must never mistake for success or explode on -- every request below uses redirect:"manual" and
 * turns a 3xx into a named FAIL line instead of silently following it to an HTML login page.
 *
 * Run: node ops/prod-verify.mjs
 * Exit code: 0 = every check PASS, 1 = at least one FAIL (including a check that could not run).
 * Never prints a secret value.
 */
import { readFileSync } from "node:fs";

const HOST = "https://app.dominion.tools";
const TOKEN_FILE = "C:\\Users\\rjfla\\.dominion-verify-token";
const TIMEOUT_MS = 30000;

function loadToken() {
  const out = {};
  try {
    for (const line of readFileSync(TOKEN_FILE, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch (e) {
    console.error("[prod-verify] could not read " + TOKEN_FILE + ": " + ((e && e.message) || e));
  }
  return out;
}

const tok = loadToken();
const AUTH_HEADERS = (tok.VERIFY_CF_CLIENT_ID && tok.VERIFY_CF_CLIENT_SECRET)
  ? { "CF-Access-Client-Id": tok.VERIFY_CF_CLIENT_ID, "CF-Access-Client-Secret": tok.VERIFY_CF_CLIENT_SECRET }
  : {};
if (!AUTH_HEADERS["CF-Access-Client-Id"]) {
  console.error("[prod-verify] WARNING: no verification token loaded from " + TOKEN_FILE + " — every check below will hit the Cloudflare Access login wall.");
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || "" });
  } catch (e) {
    results.push({ name, ok: false, detail: String((e && e.message) || e).slice(0, 300) });
  }
}

// redirect:"manual" is load-bearing here: a 3xx to the Access login page is the exact failure mode
// this script exists to name honestly (see file header). Letting fetch follow it would turn a clear
// auth failure into a confusing "non-JSON response" error instead.
async function request(path, { method = "GET", body = null } = {}) {
  const headers = { ...AUTH_HEADERS };
  if (body !== null) headers["content-type"] = "application/json";
  const r = await fetch(HOST + path, {
    method, redirect: "manual", headers,
    body: body !== null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (r.status >= 300 && r.status < 400) {
    throw new Error(`HTTP ${r.status} (redirected -- almost certainly the Cloudflare Access login page, not the app)`);
  }
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${json && json.error ? json.error : text.slice(0, 200)}`);
  }
  return { status: r.status, json, text };
}

async function getJson(path) {
  const { json, text } = await request(path);
  if (json === null) throw new Error("non-JSON response: " + text.slice(0, 200));
  return json;
}

async function postJson(path, body) {
  const { json, text } = await request(path, { method: "POST", body: body || {} });
  if (json === null) throw new Error("non-JSON response: " + text.slice(0, 200));
  return json;
}

// SSE bodies (Simplify) come back as one text blob from a non-streaming fetch; parse the frames out
// of it the same way the browser's EventSource would.
async function postSse(path, body) {
  const { text } = await request(path, { method: "POST", body: body || {} });
  return text.split("\n\n").map((l) => l.replace(/^data:\s?/, "").trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

await check("GET /api/version — commit reported", async () => {
  const j = await getJson("/api/version");
  if (!j.commit) throw new Error("no `commit` field in the response: " + JSON.stringify(j).slice(0, 200));
  return `commit ${j.commit}, build ${j.build}`;
});

await check("GET /ide/state — isOwner true", async () => {
  const j = await getJson("/ide/state");
  if (j.isOwner !== true) throw new Error("isOwner is " + JSON.stringify(j.isOwner) + " — this token is not (yet) recognized as owner inside Dominion's tenancy layer; see this file's header comment and DEFICIENCIES.md #26.");
  return "isOwner: true";
});

await check("GET /api/models — count and zero provider-unkeyed models", async () => {
  const j = await getJson("/api/models");
  if (!Number.isFinite(j.count) || j.count <= 0) throw new Error("bad or missing `count`: " + JSON.stringify(j.count));
  const avail = j.available || {};
  const unavailable = [];
  for (const g of j.groups || []) for (const m of g.models || []) {
    if (avail[m.provider] === false) unavailable.push(m.id);
  }
  // This is a SHALLOW smoke check (provider has a key at all), not the deep per-model liveness
  // audit -- that lives in ops/health-check.mjs's catalog-audit checks, which read the server's own
  // catalog-audit.json over `railway ssh` and can tell a specific retired model id from a merely
  // unkeyed provider.
  if (unavailable.length) throw new Error(`${unavailable.length} model(s) on an unkeyed provider: ${unavailable.slice(0, 10).join(", ")}`);
  return `${j.count} models, every provider they route through is keyed`;
});

await check("POST /api/simplify/chat — one prompt, served + no error", async () => {
  const frames = await postSse("/api/simplify/chat", { message: "What is 2+2? Answer in one short sentence." });
  const errFrame = frames.find((f) => f.type === "error");
  if (errFrame) throw new Error("error frame: " + String(errFrame.message || "").slice(0, 160));
  const sawDelta = frames.some((f) => f.type === "delta");
  if (!sawDelta) throw new Error("no delta frames at all -- got " + JSON.stringify(frames.map((f) => f.type)));
  const sawServed = frames.some((f) => f.type === "served");
  // Tolerant of a missing `served` event, same as ops/health-check.mjs's Simplify smoke: that event
  // is lane/simplify's to add (a SIBLING lane in this stabilization program), not this one's, and a
  // production verification script should not hard-fail on another lane's not-yet-merged work.
  return sawServed ? "answered, no error, `served` event present" : "answered, no error (no `served` event yet -- lane/simplify may not have shipped it)";
});

await check("POST /api/images/generate — one low-quality square image", async () => {
  const j = await postJson("/api/images/generate", { prompt: "a small brass gear, studio lighting, plain background", n: 1, quality: "low", aspect: "square" });
  if (!j.images || !j.images.length || !j.images[0].b64) throw new Error("no image in the response: " + JSON.stringify(j).slice(0, 200));
  const servedBy = j.servedBy ? ` servedBy=${j.servedBy.engine}/${j.servedBy.model}` : "";
  return `${j.images.length} image(s), costUsd=${j.costUsd}${servedBy}`;
});

await check("GET /api/video/ — config responds", async () => {
  const j = await getJson("/api/video/");
  return "responded: " + JSON.stringify(j).slice(0, 160);
});

await check("GET /api/game-factory/config — reachable (human-owner gate intact)", async () => {
  // The Game Factory deliberately admits only a verified HUMAN owner session (a 2026-07-18 hardening in
  // server.mjs's gameFactoryPrincipalDenial). A service-token identity is refused with 403 by design, so
  // that refusal is the expected, healthy answer here: the gate is up and the route is alive.
  try {
    const j = await getJson("/api/game-factory/config");
    return "responded: " + JSON.stringify(j).slice(0, 160);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/HTTP 403/.test(msg) && /human owner/i.test(msg)) return "route alive; service identity refused by the human-owner gate, as designed";
    throw e;
  }
});

await check("GET /api/version — game-factory supervisor and forge running", async () => {
  // The factory's owner surfaces sit behind the human-owner gate, so the running process reports the
  // two new background pieces on the public version line as bare booleans (no identities, no secrets):
  // factorySupervisor (approvals become transitions) and factoryForge (tasks become game bundles).
  const j = await getJson("/api/version");
  if (j.factorySupervisor !== true) throw new Error("factorySupervisor is not running: " + JSON.stringify(j.factorySupervisor));
  if (j.factoryForge !== true) throw new Error("factoryForge is not running: " + JSON.stringify(j.factoryForge));
  return `supervisor and forge both running (commit ${j.commit}, ${j.runningFactoryTasks} factory task(s) running)`;
});

console.log(`\nDominion AI production verification — ${HOST}`);
console.log("=".repeat(78));
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? " — " + r.detail : ""}`);
console.log("=".repeat(78));
const fails = results.filter((r) => !r.ok).length;
console.log(fails ? `${fails} of ${results.length} check(s) FAILED` : `ALL ${results.length} CHECKS PASSED`);
process.exitCode = fails ? 1 : 0;
