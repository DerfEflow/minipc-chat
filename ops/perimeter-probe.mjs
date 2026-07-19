/*
 * Dominion AI — outside-in perimeter probe. CREDENTIAL-FREE.
 *
 * WHY THIS IS SEPARATE FROM ops/health-check.mjs:
 * health-check.mjs audits from the INSIDE and needs the Railway CLI plus live Stripe/Cloudflare
 * credentials. That is fine on Fred's laptop, where those already live. It is NOT fine to copy
 * live payment and infrastructure credentials onto a second machine just so a security checker can
 * run there — that widens the blast radius in order to watch the blast radius.
 *
 * So this probe carries NO secrets and asks only what any stranger on the internet could ask. That
 * limitation is also its strength: it tests the perimeter from where an attacker actually stands,
 * and it can run anywhere, always, on a box that holds nothing worth stealing.
 *
 * It runs on the mini-PC (always on) every few hours and appends one JSON line per run. The
 * biweekly health check reads that log, so a failure here still surfaces in the report even though
 * nobody is watching this box.
 *
 * Run:  node ops/perimeter-probe.mjs [--log <path>]
 * Exit: 0 = perimeter intact, 1 = at least one FAIL.
 */
import { appendFileSync } from "node:fs";

const HOST = "app.dominion.tools";
const TEAM = "domi-ai.cloudflareaccess.com";        // the AUTH domain, not the org display name
const LOG = (() => { const i = process.argv.indexOf("--log"); return i > -1 ? process.argv[i + 1] : ""; })();

const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });

const get = (url, headers = {}) => fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(20000) });

// 1. The door is shut. An unauthenticated request must be bounced to Cloudflare Access, not served.
try {
  const r = await get(`https://${HOST}/`);
  const loc = r.headers.get("location") || "";
  if (r.status >= 300 && r.status < 400 && loc.includes("cloudflareaccess.com")) {
    // The redirect target also proves which team domain is live — this catches the exact
    // misconfiguration that silently disabled JWT verification once already, from the outside.
    loc.includes(TEAM)
      ? add("PASS", "access challenge", `302 to ${TEAM}`)
      : add("FAIL", "access challenge", `302 to an UNEXPECTED team domain: ${loc.slice(0, 90)}`);
  } else {
    add("FAIL", "access challenge", `unauthenticated GET / returned ${r.status} instead of an Access redirect — the app may be exposed.`);
  }
} catch (e) {
  add("FAIL", "access challenge", "unreachable: " + String(e.message).slice(0, 80));
}

// 2. THE INCIDENT, re-run as a live probe. On 2026-07-18 this exact request returned isOwner:true
//    from the open internet. It must never again return anything that looks like an identity.
try {
  const r = await get(`https://${HOST}/api/me`, { "cf-access-authenticated-user-email": "fredwolfe@gmail.com" });
  const body = (await r.text()).slice(0, 2000);
  const leaked = /isOwner|"email"\s*:\s*"[^"]+@|"role"\s*:\s*"owner"/.test(body);
  leaked
    ? add("FAIL", "forged header refused", `FORGED HEADER RETURNED IDENTITY DATA (${r.status}). This is the 2026-07-18 exposure, live again.`)
    : add("PASS", "forged header refused", `${r.status}, no identity in body`);
} catch (e) {
  add("WARN", "forged header refused", "probe failed: " + String(e.message).slice(0, 80));
}

// 3. Signing keys are actually published. keys:0 means JWT verification has nothing to verify with.
try {
  const j = await (await fetch(`https://${TEAM}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(20000) })).json();
  const n = (j.keys || []).length;
  n > 0 ? add("PASS", "JWKS published", `${n} signing key(s)`)
        : add("FAIL", "JWKS published", "0 keys — Access token verification is inert.");
} catch (e) {
  add("FAIL", "JWKS published", "certs unreachable: " + String(e.message).slice(0, 80));
}

// 4. Liveness. /api/version is deliberately public so the PWA can detect updates; it is the one
//    endpoint that should answer without auth. If it stops, the app is down.
try {
  const r = await fetch(`https://${HOST}/api/version`, { signal: AbortSignal.timeout(20000) });
  const t = (await r.text()).slice(0, 100);
  r.ok ? add("PASS", "app alive", t) : add("FAIL", "app alive", "HTTP " + r.status);
} catch (e) {
  add("FAIL", "app alive", String(e.message).slice(0, 80));
}

const fails = results.filter((r) => r.level === "FAIL");
const line = { checkedAt: new Date().toISOString(), host: HOST, ok: fails.length === 0, results };

if (LOG) { try { appendFileSync(LOG, JSON.stringify(line) + "\n"); } catch (e) { console.error("log write failed:", e.message); } }

console.log(`perimeter probe ${HOST} — ${fails.length === 0 ? "INTACT" : fails.length + " FAILURE(S)"}`);
for (const r of results) console.log(`  ${r.level.padEnd(5)} ${r.name.padEnd(24)} ${r.detail}`);

process.exitCode = fails.length ? 1 : 0;
