/*
 * The Guide: it must answer an engineer honestly, and it must be UNABLE to leak.
 * The safety checks here are about what the Guide is never GIVEN, since that is the real boundary.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { splitKnowledge, retrieve, guideSystemPrompt, extractComplaint, createGuideStore, createGuide, GUIDE_MODEL } from "./guide.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

const KPATH = new URL("./docs/GUIDE-KNOWLEDGE.md", import.meta.url);
const sections = splitKnowledge(readFileSync(KPATH, "utf8"));

t("the knowledge file splits into usable sections", () => {
  assert.ok(sections.length >= 6, "got " + sections.length + " sections");
  assert.ok(sections.some((s) => /DURABILITY/i.test(s.title)));
});

t("Fred's own example question retrieves the durability answer", () => {
  const hit = retrieve("how do I know my data isnt going to get lost?", sections);
  assert.match(hit[0].title, /DURABILITY/i, "got: " + hit[0].title);
  const body = hit.map((h) => h.body).join(" ");
  // The real mechanisms an engineer wants, not reassurance.
  for (const fact of [/durable jobs?|durable/i, /snapshot/i, /AES-256-GCM/, /journal/i]) {
    assert.match(body, fact, "the retrieved answer must carry " + fact);
  }
});

t("a spending question retrieves spending, not durability", () => {
  const hit = retrieve("how do I stop a build spending too much money?", sections);
  assert.match(hit[0].title, /SPENDING/i, "got: " + hit[0].title);
});

t("an off-topic question still yields the refusal rules", () => {
  const hit = retrieve("zzzz qqqq", sections);
  assert.ok(hit.length >= 1, "never returns nothing to ground on");
});

t("the prompt carries every hard limit Fred named", () => {
  const p = guideSystemPrompt(sections.slice(0, 2));
  assert.match(p, /cannot DO anything/i, "read-only");
  assert.match(p, /Never reveal or hint at credentials/i, "no secrets");
  assert.match(p, /intellectual property/i, "IP protection");
  assert.match(p, /not a general assistant/i, "scope limit");
  assert.match(p, /LOG_COMPLAINT:/, "complaint capture");
  assert.match(p, /engineer asking/i, "must serve engineers, not just beginners");
});

t("the model is Fred's pick", () => assert.equal(GUIDE_MODEL, "openai/gpt-5.6-luna"));

/* ---- the structural boundary: what the Guide is never handed ---- */
const dir = mkdtempSync(join(tmpdir(), "guide-"));
const store = createGuideStore({ dir });
const guide = createGuide({ knowledgePath: new URL("./docs/GUIDE-KNOWLEDGE.md", import.meta.url), store });

t("a turn contains ONLY the curated knowledge and this thread", () => {
  const msgs = guide.messagesFor("how does isolation work?", [
    { role: "user", content: "earlier guide question" },
    { role: "assistant", content: "earlier guide answer" },
  ]);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[msgs.length - 1].content, "how does isolation work?");
  const all = JSON.stringify(msgs);
  // If it never receives these, no prompt trick can extract them.
  for (const forbidden of ["process.env", "OPENAI_API_KEY", "HANDS_TOKEN", "app-secrets"]) {
    assert.ok(!all.includes(forbidden), "must never carry " + forbidden);
  }
});

t("the knowledge file itself holds no secrets or paths to leak", () => {
  const raw = readFileSync(KPATH, "utf8");
  for (const forbidden of [/sk-[a-zA-Z0-9]{10}/, /C:\Users/, /\.env\b/, /server\.mjs/, /supabase\.co/, /railway\.app/]) {
    assert.ok(!forbidden.test(raw), "knowledge must not contain " + forbidden);
  }
});

/* ---- complaints ---- */
t("a complaint marker is stripped from the reply and parsed", () => {
  const r = extractComplaint("I'm sorry that happened, I've noted it.\n\nLOG_COMPLAINT: Builds stall on large repos | EMAIL: fred@example.com");
  assert.equal(r.complaint.summary, "Builds stall on large repos");
  assert.equal(r.complaint.email, "fred@example.com");
  assert.ok(!/LOG_COMPLAINT/.test(r.reply), "the marker never reaches the user");
  assert.match(r.reply, /I've noted it/);
});

t("'none' and junk are not treated as an email address", () => {
  assert.equal(extractComplaint("ok\nLOG_COMPLAINT: it broke | EMAIL: none").complaint.email, "");
  assert.equal(extractComplaint("ok\nLOG_COMPLAINT: it broke").complaint.email, "");
  assert.equal(extractComplaint("ok\nLOG_COMPLAINT: it broke | EMAIL: not-an-address").complaint.email, "");
});

t("an ordinary reply is untouched", () => {
  const r = extractComplaint("Your data is journaled and snapshotted before every change.");
  assert.equal(r.complaint, null);
  assert.match(r.reply, /journaled/);
});

t("the complaint book records, counts and resolves", () => {
  const a = store.log({ uid: "u1", userEmail: "u@x.com", contactEmail: "u@x.com", summary: "preview never loads", surface: "crucible" });
  assert.ok(a.ok && a.id > 0);
  assert.equal(store.log({ summary: "   " }).ok, false, "an empty complaint is refused");
  assert.equal(store.openCount(), 1);
  store.resolve(a.id);
  assert.equal(store.openCount(), 0, "resolved complaints leave the open count");
  assert.equal(store.recent(10)[0].summary, "preview never loads");
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\nguide: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
