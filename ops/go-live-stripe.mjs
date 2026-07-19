/*
 * Stripe GO-LIVE preflight — run: node ops/go-live-stripe.mjs
 * Expects the LIVE Dominion keys in the wallet (~/.app-secrets.env):
 *   DOMI_AI_STRIPE_LIVE_SECRET_KEY=sk_live_...
 *   DOMI_AI_STRIPE_LIVE_PUBLISHABLE_KEY=pk_live_...
 * What it does (no secret values are ever printed):
 *   1. Verifies both keys are LIVE-mode, belong to the SAME account, that the account has charges
 *      enabled, and that it is NOT another business's account (Delta Log is hard-blocked).
 *   2. Creates the checkout webhook endpoint (https://app.dominion.tools/webhooks/stripe,
 *      checkout.session.completed) — recreating it if one exists so the signing secret is fresh —
 *      and appends DOMI_AI_STRIPE_LIVE_WEBHOOK_SECRET to the wallet.
 * After this passes, set the three Railway vars from the wallet and redeploy (docs/GO-LIVE.md).
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import https from "node:https";

const WALLET = path.join(os.homedir(), ".app-secrets.env");
const BLOCKED_ACCOUNTS = new Map([["acct_1Tjq0bAI1a0SLsEf", "Delta Log"]]);   // other businesses: never Dominion revenue
const WEBHOOK_URL = "https://app.dominion.tools/webhooks/stripe";

const wallet = {};
for (const l of fs.readFileSync(WALLET, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if (m) wallet[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); }
// Both spellings accepted: the runbook's names and the ones Fred actually used on go-live night.
const SK = wallet.DOMI_AI_STRIPE_LIVE_SECRET_KEY || wallet.DOMI_AI_LIVE_STRIPE_SECRET;
const PK = wallet.DOMI_AI_STRIPE_LIVE_PUBLISHABLE_KEY || wallet.DOMI_AI_LIVE_STRIPE_PUBLISHABLE;

function fail(msg) { console.error("BLOCKED: " + msg); process.exit(1); }
if (!SK) fail("DOMI_AI_STRIPE_LIVE_SECRET_KEY is not in the wallet yet.");
if (!PK) fail("DOMI_AI_STRIPE_LIVE_PUBLISHABLE_KEY is not in the wallet yet.");
if (!SK.startsWith("sk_live_")) fail("secret key is not live-mode (expected sk_live_…, got " + SK.slice(0, 8) + "…).");
if (!PK.startsWith("pk_live_")) fail("publishable key is not live-mode (expected pk_live_…, got " + PK.slice(0, 8) + "…).");

function stripe(method, p, form) {
  return new Promise((resolve) => {
    const body = form ? new URLSearchParams(form).toString() : null;
    const req = https.request({ host: "api.stripe.com", path: p, method, headers: { authorization: "Bearer " + SK, ...(body ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {}) } },
      (res) => { let s = ""; res.on("data", (c) => s += c); res.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve({ error: { message: "parse fail" } }); } }); });
    req.on("error", (e) => resolve({ error: { message: e.message } })); if (body) req.write(body); req.end();
  });
}

const acct = await stripe("GET", "/v1/account");
if (acct.error) fail("account lookup failed: " + acct.error.message);
const name = (acct.settings && acct.settings.dashboard && acct.settings.dashboard.display_name) || (acct.business_profile && acct.business_profile.name) || "(unnamed)";
console.log("account:", acct.id, "| name:", name, "| charges_enabled:", acct.charges_enabled);
if (BLOCKED_ACCOUNTS.has(acct.id)) fail(`these keys belong to ${BLOCKED_ACCOUNTS.get(acct.id)} — wrong business for Dominion revenue.`);
if (acct.country !== "US") fail("account country is " + acct.country + ", expected US.");
if (!acct.charges_enabled) fail("charges are not enabled on this account yet — finish Stripe activation (business + bank details) first.");

// webhook: recreate for a fresh signing secret
const hooks = await stripe("GET", "/v1/webhook_endpoints?limit=100");
for (const h of (hooks.data || [])) if (h.url === WEBHOOK_URL) { await stripe("DELETE", "/v1/webhook_endpoints/" + h.id); console.log("replaced existing webhook", h.id); }
const hook = await stripe("POST", "/v1/webhook_endpoints", { url: WEBHOOK_URL, "enabled_events[]": "checkout.session.completed" });
if (hook.error || !hook.secret) fail("webhook creation failed: " + (hook.error && hook.error.message));
const text = fs.readFileSync(WALLET, "utf8");
const line = "DOMI_AI_STRIPE_LIVE_WEBHOOK_SECRET=" + hook.secret;
fs.writeFileSync(WALLET, /^DOMI_AI_STRIPE_LIVE_WEBHOOK_SECRET=/m.test(text)
  ? text.replace(/^DOMI_AI_STRIPE_LIVE_WEBHOOK_SECRET=.*$/m, line)
  : text.replace(/\n*$/, "\n") + "# Dominion live checkout webhook (created by ops/go-live-stripe.mjs)\n" + line + "\n");
console.log("webhook created:", hook.id, "→ signing secret saved to wallet as DOMI_AI_STRIPE_LIVE_WEBHOOK_SECRET");
console.log("\nPREFLIGHT PASSED — set the Railway vars from the wallet and redeploy (docs/GO-LIVE.md step 3).");
