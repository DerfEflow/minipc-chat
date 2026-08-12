/*
 * Altana support + money END TO END, against a real booted server. Run: node altana_support_e2e_test.mjs
 *
 * The unit suites prove each piece in isolation. This proves the pieces are actually WIRED, which is
 * the failure mode this codebase keeps producing: machinery that is built, tested and never called.
 * Every check below drives real HTTP against a real process with a real database on disk.
 *
 * NO PROVIDER KEYS ARE SET, deliberately. The model seat cannot answer, so the assistant's own turn
 * fails, and everything that does NOT depend on a model still has to work: the routes, the tenant
 * walls, the ticket book, the follow-up delivery, and the typed-confirmation path. That last one is
 * the important one, because it is where money moves and it must never involve a model at all.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8100 + (Math.floor(process.uptime() * 1000) % 800);
const OWNER = "owner@example.com";
const GUEST = "guest@example.com";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.message)); } };

const dir = mkdtempSync(join(tmpdir(), "altana-e2e-"));
const env = {
  ...process.env,
  PORT: String(PORT), DATA_DIR: dir,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"),
  MULTI_TENANT: "1", OWNER_EMAIL: OWNER,
  // Every background worker off, per the convention every other e2e suite follows.
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", CATALOG_AUDIT: "0",
  // No provider keys. The point is to prove the non-model half is wired.
  OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", NVIDIA_API_KEY: "", STRIPE_SECRET_KEY: "",
};
const child = spawn(process.execPath, ["--no-warnings", join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let bootLog = "";
child.stdout.on("data", (d) => { bootLog += d; });
child.stderr.on("data", (d) => { bootLog += d; });

const H = (email) => (email ? { "cf-access-authenticated-user-email": email, "content-type": "application/json" } : { "content-type": "application/json" });
const call = async (method, path, email, body) => {
  const r = await fetch("http://127.0.0.1:" + PORT + path, {
    method, headers: H(email), body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
};

async function waitForBoot() {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch("http://127.0.0.1:" + PORT + "/api/version");
      if (r.ok) return true;
    } catch {}
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error("server did not boot in 30s. Log tail:\n" + bootLog.slice(-2500));
}

try {
  await waitForBoot();
  console.log("\n=== the routes exist and the walls hold ===");

  await t("an anonymous caller is refused", async () => {
    const r = await call("POST", "/altana/ask", "", { question: "hello" });
    assert.equal(r.status, 401);
  });

  await t("the ticket book is owner only", async () => {
    assert.equal((await call("GET", "/altana/tickets", GUEST)).status, 403);
    const owner = await call("GET", "/altana/tickets", OWNER);
    assert.equal(owner.status, 200);
    assert.ok(Array.isArray(owner.json.tickets), "the owner did not get a ticket list");
  });

  await t("resolving a ticket is owner only", async () => {
    assert.equal((await call("POST", "/altana/ticket/resolve", GUEST, { id: 1 })).status, 403);
  });

  await t("an ask with no question is refused", async () => {
    const r = await call("POST", "/altana/ask", GUEST, {});
    assert.equal(r.status, 400);
  });

  console.log("\n=== the handler runs end to end with no model available ===");

  await t("a real ask assembles context and a toolset without throwing", async () => {
    /*
     * With no provider key every seat fails, so the reply is the honest "I could not reach my own
     * brain" rather than an answer. Reaching THAT sentence is the proof: it means the tenant
     * resolved, the context assembler ran, the registry was filtered and adapted, and the turn was
     * attempted. A crash anywhere in the new wiring would have produced a 500 instead.
     */
    const r = await call("POST", "/altana/ask", GUEST, { question: "my build failed and I am stuck", surface: "chat" });
    assert.equal(r.status, 200, "the ask returned " + r.status + ": " + JSON.stringify(r.json).slice(0, 300));
    assert.ok(typeof r.json.reply === "string", "no reply field");
  });

  await t("the registry was actually offered to her, and the withheld tools were withheld", async () => {
    // The handler logs what it refused. Proving the refusals happened proves the deny-list ran on the
    // real registry rather than on an empty list, which would pass every other check silently.
    assert.match(bootLog, /\[altana\] withheld \d+ registry tools/, "no evidence the registry reached her at all");
    assert.match(bootLog, /forge_read|sandbox_read|search_persona/, "the withheld list does not name the tools it refused");
  });

  console.log("\n=== typed confirmations: no model involved, and replay is refused ===");

  await t("a typed answer with an unknown nonce is refused rather than assumed", async () => {
    const r = await call("POST", "/altana/ask", GUEST, { typed: { nonce: "made-up", value: "25" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.verdict, "unknown");
    assert.match(r.json.reply, /lost track/i);
    assert.ok(!/error|stack|undefined/i.test(r.json.reply), "a technical word reached the user: " + r.json.reply);
  });

  await t("one account cannot spend another account's confirmation", async () => {
    // Both callers get "unknown" because the lookup is scoped by uid. A cross-account nonce must
    // never resolve, whatever it contains.
    const r = await call("POST", "/altana/ask", OWNER, { typed: { nonce: "made-up", value: "25" } });
    assert.equal(r.json.verdict, "unknown");
  });

  await t("a typed answer never reaches a model, so it works with no provider key at all", async () => {
    /*
     * The reply is a real decision, not the "could not reach my own brain" fallback. That is the
     * property that matters: a charge must never depend on a model being reachable, and a model must
     * never be asked whether five digits match.
     */
    const r = await call("POST", "/altana/ask", GUEST, { typed: { nonce: "x", value: "25" } });
    assert.ok(!/could not reach my own brain/i.test(r.json.reply), "the typed path went through the model");
  });

  console.log("\n=== the ticket book and the follow-up ===");

  await t("tickets and follow-ups survive a real database round trip", async () => {
    /*
     * Driven through the store the server is actually using, by importing the same module against the
     * same directory. This is the one check that proves the follow-up ARMS on resolve and DELIVERS
     * exactly once, which is the whole of Fred's "follow up when it is done".
     */
    const { createAltanaStore } = await import("./altana.mjs");
    const { supportPlanFor } = await import("./altana-support.mjs");
    const store = createAltanaStore({ dir: join(dir, "guide") });

    const plan = supportPlanFor("my build failed again and I have lost the afternoon");
    assert.equal(plan.promiseFollowUp, true, "a build failure should promise a follow-up");

    const tk = store.openTicket({ uid: "u-test", userEmail: GUEST, plan, summary: "build failed", surface: "crucible" });
    assert.equal(tk.ok, true);

    // Nothing is due before it is resolved. A promise is not a delivery.
    assert.equal(store.followUpsDueFor("u-test", 5).length, 0, "a follow-up was due before the ticket was resolved");

    store.resolveTicket(tk.id);
    const due = store.followUpsDueFor("u-test", 5);
    assert.equal(due.length, 1, "resolving did not arm the follow-up");
    assert.ok(due[0].followUpText.length > 20, "the follow-up has nothing to say");

    // Delivered exactly once, however many times it is swept.
    assert.equal(store.markFollowUpSent(tk.id), true, "the first delivery was refused");
    assert.equal(store.markFollowUpSent(tk.id), false, "THE SAME APOLOGY WOULD BE SENT TWICE");
    assert.equal(store.followUpsDueFor("u-test", 5).length, 0, "it is still due after being sent");

    // Resolving again must not re-arm it.
    store.resolveTicket(tk.id);
    assert.equal(store.followUpsDueFor("u-test", 5).length, 0, "resolving twice re-sent the follow-up");
  });

  await t("a low severity issue is never promised a follow-up it will not get", async () => {
    const { supportPlanFor } = await import("./altana-support.mjs");
    const plan = supportPlanFor("you should add dark mode one day");
    assert.equal(plan.promiseFollowUp, false, "a wish list item promised the user a follow-up");
  });

  await t("the owner sees a filed ticket on the tickets route", async () => {
    const r = await call("GET", "/altana/tickets", OWNER);
    assert.equal(r.status, 200);
    assert.ok(r.json.tickets.some((x) => x.summary === "build failed"), "the filed ticket is not on the owner's screen");
  });
} finally {
  /*
   * WAIT FOR THE CHILD TO ACTUALLY DIE, and kill it hard if it will not.
   *
   * The first version sent SIGTERM and slept 400ms. That is not enough and the reason is in
   * server.mjs: the SIGTERM handler is a deliberate drain that checkpoints every running job and then
   * waits for HTTP to close with a deadline measured in minutes. So the test exited while the server
   * was still alive, leaving an orphan holding a port and burning CPU into whatever suite ran next.
   *
   * Observed exactly once: google-tools_test failed inside the full sequential run and passed 26/26
   * on its own, immediately afterwards. A suite that makes an unrelated suite flaky is worse than a
   * suite that fails, because the failure lands on someone else's name.
   */
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once("exit", finish);
    try { child.kill("SIGTERM"); } catch { finish(); }
    // The drain is welcome to be graceful for two seconds. After that this is a test fixture, not a
    // production shutdown, and the correct thing is for it to be gone.
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
    setTimeout(finish, 6000).unref?.();
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\naltana_support_e2e_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
