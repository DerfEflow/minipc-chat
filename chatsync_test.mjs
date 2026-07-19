/*
 * Cross-device chat sync self-test — run: node chatsync_test.mjs
 *
 * Part 1: unit tests on chatsync.mjs (revision cursor, last-write-wins, tombstones, the
 * shrink-insurance copy, image stripping, caps).
 * Part 2: END-TO-END against the REAL server with MULTI_TENANT=1 — the actual story Fred asked
 * for (phone writes, laptop pulls, laptop replies, phone pulls, phone deletes, laptop loses it)
 * plus the thing that must never happen: one account's chats reaching another account.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createChatSync } from "./chatsync.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };
const chat = (id, updatedAt, msgs, title) => ({ id, updatedAt, title: title || "Chat " + id, messages: msgs });
const msg = (role, content) => ({ role, content });

// ---------------- Part 1: unit ----------------
const unitDir = mkdtempSync(join(tmpdir(), "chatsync-unit-"));
const store = createChatSync({ dir: unitDir });

await t("push assigns revisions; pull(0) returns everything", async () => {
  store.push([chat("a", 1000, [msg("user", "hello")]), chat("b", 1100, [msg("user", "second")])]);
  const p = store.pull(0);
  if (p.chats.length !== 2) throw new Error("expected 2, got " + p.chats.length);
  if (p.rev !== 2) throw new Error("rev " + p.rev);
  if (p.chats[0].rev !== 1 || p.chats[1].rev !== 2) throw new Error("revs not assigned in order");
});

await t("the revision cursor is incremental (a device only gets what it lacks)", async () => {
  const before = store.pull(0).rev;
  store.push([chat("c", 1200, [msg("user", "third")])]);
  const p = store.pull(before);
  if (p.chats.length !== 1 || p.chats[0].id !== "c") throw new Error("cursor leaked older chats");
});

await t("last-write-wins: newer updatedAt replaces, older is refused as stale", async () => {
  store.push([chat("a", 2000, [msg("user", "hello"), msg("assistant", "hi")])]);
  let got = store.pull(0).chats.find((c) => c.id === "a");
  if (got.messages.length !== 2) throw new Error("newer push not stored");
  const r = store.push([chat("a", 1500, [msg("user", "stale")])]);
  if (!r.rejected.some((x) => x.id === "a" && x.reason === "stale")) throw new Error("stale push accepted: " + JSON.stringify(r));
  got = store.pull(0).chats.find((c) => c.id === "a");
  if (got.messages.length !== 2) throw new Error("stale push overwrote the newer copy");
});

await t("a shrinking write keeps the previous version as recovery ballast (never shipped to devices)", async () => {
  store.push([chat("a", 3000, [msg("user", "only one now")])]);
  const p = store.pull(0).chats.find((c) => c.id === "a");
  if (p.messages.length !== 1) throw new Error("shrink not applied");
  if ("prev" in p) throw new Error("prev leaked to the device payload");
});

await t("delete tombstones, propagates via pull, and refuses a later re-push of the same copy", async () => {
  const revBefore = store.pull(0).rev;
  store.push([], [{ id: "b", deletedAt: 4000 }]);
  const p = store.pull(revBefore);
  if (!p.deleted.some((d) => d.id === "b")) throw new Error("tombstone not published");
  if (store.pull(0).chats.some((c) => c.id === "b")) throw new Error("chat still present");
  const r = store.push([chat("b", 3500, [msg("user", "zombie")])]);
  if (!r.rejected.some((x) => x.id === "b" && x.reason === "deleted")) throw new Error("zombie accepted");
});

await t("a chat edited AFTER the delete elsewhere is deliberately resurrected", async () => {
  const r = store.push([chat("b", 5000, [msg("user", "I want it back")])]);
  if (!r.accepted.some((x) => x.id === "b")) throw new Error("resurrection refused");
  if (!store.pull(0).chats.some((c) => c.id === "b")) throw new Error("not restored");
});

await t("image pixels are stripped to placeholders; text attachments survive intact", async () => {
  store.push([{ id: "img", updatedAt: 6000, title: "with pics", messages: [
    { role: "user", content: "look", attachments: [
      { kind: "image", name: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAAA" },
      { kind: "text", name: "notes.txt", text: "keep me" },
    ] },
  ] }]);
  const got = store.pull(0).chats.find((c) => c.id === "img");
  const atts = got.messages[0].attachments;
  if (atts[0].kind !== "image_ref" || atts[0].dataUrl) throw new Error("pixels stored: " + JSON.stringify(atts[0]));
  if (atts[0].name !== "a.png") throw new Error("image name lost");
  if (atts[1].text !== "keep me") throw new Error("text attachment damaged");
});

await t("malformed pushes are refused, not stored", async () => {
  const r = store.push([{ nope: true }, { id: "x" }, null]);
  if (r.accepted.length) throw new Error("accepted garbage");
  if (r.rejected.length < 2) throw new Error("did not report the refusals");
});

await t("oversized chats are truncated from the head and flagged", async () => {
  const many = Array.from({ length: 600 }, (_, i) => msg(i % 2 ? "assistant" : "user", "turn " + i));
  const r = store.push([chat("big", 7000, many)]);
  if (!r.accepted[0].truncated) throw new Error("truncation not reported");
  const got = store.pull(0).chats.find((c) => c.id === "big");
  if (got.messages.length > 400) throw new Error("cap not applied: " + got.messages.length);
  if (got.messages[got.messages.length - 1].content !== "turn 599") throw new Error("kept the wrong end (live end must survive)");
});

await t("state survives a reopen of the same directory", async () => {
  const again = createChatSync({ dir: unitDir });
  const p = again.pull(0);
  if (!p.chats.some((c) => c.id === "a")) throw new Error("did not reload from disk");
  if (p.rev !== store.pull(0).rev) throw new Error("rev not persisted");
});

// ---------------- Part 2: e2e over the wire ----------------
const PORT = 8500 + Math.floor(process.uptime() * 11) % 300;
const MOCK_OLLAMA = PORT + 1;
const OWNER = "owner@test.com";
const GUEST = "guest@test.com";

const mockOllama = http.createServer((req, res) => { let b = ""; req.on("data", (d) => b += d); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 5 }) : "{}"); }); });
await new Promise((r) => mockOllama.listen(MOCK_OLLAMA, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "chatsync-e2e-"));
const env = { ...process.env, PORT: String(PORT), OLLAMA_URL: "http://127.0.0.1:" + MOCK_OLLAMA,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"), DATA_DIR: dir,
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", CATALOG_AUDIT: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  MULTI_TENANT: "1", OWNER_EMAIL: OWNER,
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "", STRIPE_SECRET_KEY: "" };
const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let bootLog = ""; child.stdout.on("data", (d) => bootLog += d); child.stderr.on("data", (d) => bootLog += d);

const H = (email) => (email ? { "cf-access-authenticated-user-email": email } : {});
function req(method, path, { email = "", body = null } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...H(email) } },
      (res) => { let b = ""; res.on("data", (d) => b += d); res.on("end", () => { let j; try { j = JSON.parse(b); } catch { j = b; } resolve({ status: res.statusCode, body: j }); }); });
    r.on("error", () => resolve({ status: 0, body: null }));
    if (data) r.write(data); r.end();
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

// Two devices for one person: each keeps its own revision cursor, exactly like the browsers do.
const phone = { since: 0 }, laptop = { since: 0 };
const sync = async (device, email, chats = [], deletes = []) => {
  const r = await req("POST", "/chats/sync", { email, body: { since: device.since, chats, deletes } });
  if (r.status === 200) device.since = r.body.rev;
  return r;
};

await t("e2e: anon is refused", async () => {
  const r = await req("GET", "/chats/sync");
  if (r.status !== 401 || r.body.code !== "no_identity") throw new Error(r.status + " " + JSON.stringify(r.body));
});

await t("e2e: THE STORY — a chat started on the phone appears on the laptop", async () => {
  await sync(phone, OWNER, [chat("story", 1000, [msg("user", "plan the roof job"), msg("assistant", "here is the plan")], "Roof job")]);
  const r = await sync(laptop, OWNER);
  const got = (r.body.chats || []).find((c) => c.id === "story");
  if (!got) throw new Error("laptop did not receive it: " + JSON.stringify(r.body).slice(0, 200));
  if (got.title !== "Roof job" || got.messages.length !== 2) throw new Error("fidelity lost: " + JSON.stringify(got));
  if (got.messages[1].content !== "here is the plan") throw new Error("content truncated (this is not the retrieval index)");
});

await t("e2e: the laptop continues that chat and the phone catches up", async () => {
  await sync(laptop, OWNER, [chat("story", 2000, [msg("user", "plan the roof job"), msg("assistant", "here is the plan"), msg("user", "add gutters")], "Roof job")]);
  const r = await sync(phone, OWNER);
  const got = (r.body.chats || []).find((c) => c.id === "story");
  if (!got || got.messages.length !== 3) throw new Error("phone did not get the continuation");
});

await t("e2e: an incremental pull returns nothing when nothing changed", async () => {
  const r = await sync(phone, OWNER);
  if ((r.body.chats || []).length !== 0) throw new Error("re-sent unchanged chats: " + r.body.chats.length);
});

await t("e2e: deleting on the phone removes it from the laptop", async () => {
  await sync(phone, OWNER, [], [{ id: "story", deletedAt: 3000 }]);
  const r = await sync(laptop, OWNER);
  if (!(r.body.deleted || []).some((d) => d.id === "story")) throw new Error("tombstone did not reach the laptop");
});

await t("e2e: /chatlog/forget also tombstones sync (delete from the UI propagates)", async () => {
  await sync(phone, OWNER, [chat("viaui", 4000, [msg("user", "delete me from the sidebar")])]);
  await sync(laptop, OWNER);
  const f = await req("POST", "/chatlog/forget", { email: OWNER, body: { chatId: "viaui", deletedAt: 5000 } });
  if (f.status !== 200) throw new Error("forget failed " + f.status);
  const r = await sync(laptop, OWNER);
  if (!(r.body.deleted || []).some((d) => d.id === "viaui")) throw new Error("forget did not propagate to sync");
});

await t("e2e: /chatlog/forget requires identity (was reaching the owner's stores for anyone)", async () => {
  const r = await req("POST", "/chatlog/forget", { body: { chatId: "whatever" } });
  if (r.status !== 401) throw new Error("anon delete accepted: " + r.status);
});

await t("e2e: ISOLATION — a guest never sees the owner's chats, and vice versa", async () => {
  await sync(phone, OWNER, [chat("private", 6000, [msg("user", "owner only secret")])]);
  const g = { since: 0 };
  const guestPull = await sync(g, GUEST);
  if ((guestPull.body.chats || []).some((c) => c.id === "private")) throw new Error("OWNER CHAT LEAKED TO GUEST");
  await sync(g, GUEST, [chat("guestchat", 6100, [msg("user", "guest business")])]);
  const ownerPull = await req("GET", "/chats/sync?since=0", { email: OWNER });
  if ((ownerPull.body.chats || []).some((c) => c.id === "guestchat")) throw new Error("GUEST CHAT LEAKED TO OWNER");
  const guestOwn = await req("GET", "/chats/sync?since=0", { email: GUEST });
  if (!(guestOwn.body.chats || []).some((c) => c.id === "guestchat")) throw new Error("guest lost their own chat");
});

await t("e2e: a fresh device (cursor 0) receives the whole account", async () => {
  const fresh = await req("GET", "/chats/sync?since=0", { email: OWNER });
  const ids = (fresh.body.chats || []).map((c) => c.id);
  if (!ids.includes("private")) throw new Error("fresh device missing chats: " + ids.join(","));
  if (!fresh.body.limits || !fresh.body.limits.MAX_CHATS) throw new Error("limits not published");
});

console.log(`\nchatsync: ${passed} passed, ${failed} failed`);
child.kill();
mockOllama.close();
process.exit(failed ? 1 : 0);
