/*
 * Multi-tenant END-TO-END self-test — run: node multitenant_e2e_test.mjs
 * Boots the REAL server with MULTI_TENANT=1 and a mock Ollama, then drives the whole tenant flow over
 * HTTP using simulated Cloudflare Access identities (the cf-access-authenticated-user-email header):
 * owner mints codes, a new user is invite-gated then redeems, the credit gate bites at zero balance,
 * a free code makes a sponsored user, admin is owner-only, and Forge setup works. No cloud calls (the
 * chat gates fire before any provider call), so this needs no API keys.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8100 + Math.floor(process.uptime() * 7) % 500;
const MOCK_PORT = PORT + 1;
const OWNER = "owner@test.com";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

// mock Ollama (so boot + any local utility call is harmless)
const mockSrv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => b += d); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 5 }) : "{}"); }); });
await new Promise((r) => mockSrv.listen(MOCK_PORT, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "dominion-mt-e2e-"));
const env = { ...process.env, PORT: String(PORT), OLLAMA_URL: "http://127.0.0.1:" + MOCK_PORT,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"), DATA_DIR: dir,
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  MULTI_TENANT: "1", OWNER_EMAIL: OWNER,
  // no cloud keys on purpose: a gate-passed chat fails at the provider, which is how we tell "gate passed".
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "", STRIPE_SECRET_KEY: "" };
const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let bootLog = ""; child.stdout.on("data", (d) => bootLog += d); child.stderr.on("data", (d) => bootLog += d);

const H = (email) => (email ? { "cf-access-authenticated-user-email": email } : {});
function req(method, path, { email = "", body = null } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...H(email) } },
      (res) => { let b = ""; res.on("data", (d) => b += d); res.on("end", () => { let j; try { j = JSON.parse(b); } catch { j = b; } resolve({ status: res.statusCode, body: j, headers: res.headers }); }); });
    r.on("error", () => resolve({ status: 0, body: null }));
    if (data) r.write(data); r.end();
  });
}
// POST /chat and return the error codes seen (gate refusals carry a `code`; a passed gate that then
// fails at the provider emits an error with no code).
function chatCodes(email, model) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: model || "auto", mode: "fast" });
    const codes = []; let done = false;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: "/chat", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...H(email) } },
      (res) => { let buf = ""; res.on("data", (d) => { buf += d; const ls = buf.split("\n"); buf = ls.pop() || ""; for (const l of ls) { const s = l.trim(); if (!s.startsWith("data:")) continue; let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; } if (ev.type === "error") codes.push(ev.code || "provider_error"); } }); res.on("end", () => { done = true; resolve(codes); }); });
    r.on("error", () => resolve(codes));
    r.write(data); r.end();
    setTimeout(() => { if (!done) { try { r.destroy(); } catch {} resolve(codes); } }, 9000);
  });
}

async function waitForBoot() {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((r) => { const rq = http.get({ host: "127.0.0.1", port: PORT, path: "/api/version" }, (rs) => { rs.resume(); r(rs.statusCode === 200); }); rq.on("error", () => r(false)); });
    if (ok) return; await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server never came up:\n" + bootLog.slice(-2000));
}
await waitForBoot();

let inviteCode, freeCode, zeroCode;
await t("owner is recognized and can mint invite + free codes", async () => {
  const acct = await req("GET", "/account", { email: OWNER });
  if (!acct.body || acct.body.role !== "owner") throw new Error("owner not resolved: " + JSON.stringify(acct.body));
  const inv = await req("POST", "/admin/codes/mint", { email: OWNER, body: { type: "invite", credits: 500 } });
  const fre = await req("POST", "/admin/codes/mint", { email: OWNER, body: { type: "free" } });
  const zero = await req("POST", "/admin/codes/mint", { email: OWNER, body: { type: "invite", credits: 0 } });
  inviteCode = inv.body.codes[0].code; freeCode = fre.body.codes[0].code; zeroCode = zero.body.codes[0].code;
  if (!/^DOMI-/.test(inviteCode) || !/^DOMI-/.test(freeCode)) throw new Error("codes not minted");
});

await t("a new user is INVITE-GATED until they redeem a code", async () => {
  const acct = await req("GET", "/account", { email: "newbie@test.com" });
  if (acct.body.invited !== false) throw new Error("new user should not be invited");
  const codes = await chatCodes("newbie@test.com");
  if (!codes.includes("needs_invite")) throw new Error("expected needs_invite, got " + JSON.stringify(codes));
});

await t("a non-invited user opening the app is sent to /setup (never a dead chat)", async () => {
  const r = await req("GET", "/", { email: "newbie@test.com" });
  if (r.status !== 302 || r.headers.location !== "/setup") throw new Error("expected 302 /setup, got " + r.status + " " + r.headers.location);
  const owner = await req("GET", "/", { email: OWNER });
  if (owner.status !== 200) throw new Error("owner should get the app, got " + owner.status);
});

await t("minting a code WITH an email reports door-list status (no CF creds here => honest failure)", async () => {
  const r = await req("POST", "/admin/codes/mint", { email: OWNER, body: { type: "invite", credits: 100, email: "doortest@test.com" } });
  if (!r.body.codes || !/^DOMI-/.test(r.body.codes[0].code)) throw new Error("mint with email failed: " + JSON.stringify(r.body));
  if (r.body.doorListed !== false || !r.body.doorError) throw new Error("expected doorListed:false + doorError, got " + JSON.stringify(r.body));
});

await t("redeeming an invite code activates a CREDIT user; promo is HELD, chat stays locked (pay-before-access)", async () => {
  const r = await req("POST", "/account/redeem", { email: "newbie@test.com", body: { code: inviteCode } });
  if (!r.body.ok || r.body.role !== "credit") throw new Error("redeem failed: " + JSON.stringify(r.body));
  const acct = await req("GET", "/account", { email: "newbie@test.com" });
  if (!acct.body.invited || acct.body.role !== "credit") throw new Error("not activated");
  if (!acct.body.credits || acct.body.credits.balance !== 0) throw new Error("balance should be 0 pre-purchase: " + JSON.stringify(acct.body.credits));
  if (acct.body.credits.pendingPromo !== 500) throw new Error("welcome bonus not held: " + JSON.stringify(acct.body.credits));
  const codes = await chatCodes("newbie@test.com");
  if (!codes.includes("needs_credits")) throw new Error("chat should be locked until first purchase, got " + JSON.stringify(codes));
  const page = await req("GET", "/", { email: "newbie@test.com" });
  if (page.status !== 302 || page.headers.location !== "/setup") throw new Error("never-paid user should be sent to /setup, got " + page.status);
});

await t("a credit user WITH balance passes the gates (fails only at the provider)", async () => {
  // No Stripe in this test env, so stand in for the first purchase with an owner credit grant.
  await req("POST", "/admin/user", { email: OWNER, body: { email: "newbie@test.com", adjustCredits: 300 } });
  const codes = await chatCodes("newbie@test.com");
  if (codes.includes("needs_invite") || codes.includes("needs_credits")) throw new Error("should have passed gates: " + JSON.stringify(codes));
  const page = await req("GET", "/", { email: "newbie@test.com" });
  if (page.status !== 200) throw new Error("funded user should get the app, got " + page.status);
});

await t("a credit user with ZERO balance is credit-gated", async () => {
  await req("POST", "/account/redeem", { email: "broke@test.com", body: { code: zeroCode } });
  const codes = await chatCodes("broke@test.com");
  if (!codes.includes("needs_credits")) throw new Error("expected needs_credits, got " + JSON.stringify(codes));
});

await t("a free code makes a SPONSORED user with the $20 cap", async () => {
  const r = await req("POST", "/account/redeem", { email: "family@test.com", body: { code: freeCode } });
  if (r.body.role !== "sponsored") throw new Error("free code should make sponsored: " + JSON.stringify(r.body));
  const acct = await req("GET", "/account", { email: "family@test.com" });
  if (acct.body.role !== "sponsored" || !acct.body.sponsored || acct.body.sponsored.capUsd !== 20) throw new Error("cap not set: " + JSON.stringify(acct.body));
});

await t("admin is owner-only; a non-owner is refused", async () => {
  const r = await req("GET", "/admin/users", { email: "newbie@test.com" });
  if (r.status !== 403) throw new Error("non-owner reached admin: " + r.status);
  const ok = await req("GET", "/admin/users", { email: OWNER });
  if (!Array.isArray(ok.body.users) || ok.body.users.length < 3) throw new Error("owner admin list wrong: " + JSON.stringify(ok.body).slice(0, 200));
});

await t("Forge setup: token mint + enable are per-caller", async () => {
  const st0 = await req("GET", "/forge/status", { email: "newbie@test.com" });
  if (st0.body.enabled !== false || st0.body.hasToken !== false) throw new Error("fresh forge state wrong");
  const tok = await req("POST", "/forge/token", { email: "newbie@test.com" });
  if (!/^dfk_/.test(tok.body.token)) throw new Error("no forge token");
  await req("POST", "/forge/enable", { email: "newbie@test.com", body: { on: true } });
  const st1 = await req("GET", "/forge/status", { email: "newbie@test.com" });
  if (st1.body.enabled !== true || st1.body.hasToken !== true) throw new Error("forge not enabled");
});

await t("the onboarding tutorial content is served", async () => {
  const r = await req("GET", "/content/tutorial", { email: "newbie@test.com" });
  if (!r.body.tutorial || !Array.isArray(r.body.tutorial.sections) || !r.body.consent) throw new Error("tutorial payload wrong");
});

if (failed) { try { (await import("node:fs")).writeFileSync(join(tmpdir(), "mt_e2e_boot.log"), bootLog.slice(-4000)); console.log("server log tail -> " + join(tmpdir(), "mt_e2e_boot.log")); } catch {} }
try { child.kill(); } catch {}
try { mockSrv.close(); } catch {}
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\nmultitenant_e2e_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
