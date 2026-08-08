/*
 * Dominion AI — the learning loop (Fred, 2026-08-08).
 *
 * WHAT THIS IS. One tap under any answer teaches Dominion something durable. A guest presses
 * "Good job" or "This answer sucked"; Claude Opus 5 reads that turn and distills ONE standing
 * lesson from it; the lesson waits in a queue; Fred approves, denies, or defers it; an approval
 * becomes a line in that account's own system prompt from the next turn onward. Fred's own taps
 * skip the queue and land in his account immediately, because he is the one who would be
 * approving them.
 *
 * THREE RULES THIS MODULE EXISTS TO ENFORCE, each of them a thing Fred asked for by name:
 *
 * 1. THE REVIEW QUEUE CARRIES NO IDENTITY. "I dont need to know any identifiable info about the
 *    user, just the distillation and why the distillation makes a difference." The uid is stored
 *    here because a per-user lesson has to be applied to a specific account, but it never leaves:
 *    pending() selects the anonymous columns only, the compiled file is written from that same
 *    projection, and the distiller is told in its own instructions to write lessons that would
 *    make sense to someone who never saw the conversation. Three layers, because one is a typo
 *    away from a leak. The anonymity of pending() is a unit test, not a convention.
 *
 * 2. THE GUEST NEVER PAYS FOR THE JUDGE. The distillation runs on Fred's Anthropic key through a
 *    server-internal call that never touches meterTurn() or the credits store, so a guest teaching
 *    Dominion something costs them nothing. That is a property of WHERE this is called from (a
 *    plain route handler, not the chat pipeline), so the caller injects the distiller and this
 *    module never reaches for a billing surface at all.
 *
 * 3. TEN AND TEN, PER GUEST, PER DAY. A tap is cheap for the person tapping and costs Fred an
 *    Opus 5 call, so the counter is checked BEFORE the model is called, never after. The owner is
 *    exempt because the owner is the one paying.
 *
 * WHAT AN APPROVAL ACTUALLY CHANGES. Approved lessons are rendered into one block that the server
 * adds as a system message. Guest thumbs approve to scope "user" (that account only). Fred's
 * critique and inspect reports approve to scope "global", which is his ruling: "once I approve
 * them to be employed, are then to be deployed to both my account and globally to all guests."
 * The block is deliberately stable between turns — it changes only when a decision is made — so it
 * sits inside the cached prompt prefix instead of re-billing the whole conversation every turn.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["positive", "negative", "critique", "inspect"];
export const THUMB_KINDS = ["positive", "negative"];
const SCOPES = ["user", "global"];
const DEFAULT_DAILY_LIMIT = 10;      // Fred: "Limit feedback to 10 positive and 10 negative per day"
const MAX_LESSON = 400;
const MAX_WHY = 400;
const MAX_REPORT = 6000;
const MAX_ACTIVE_LESSONS = 40;       // per scope; the prompt block is a budget, not a landfill

const clamp = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
const dayOf = (iso) => String(iso).slice(0, 10);

/*
 * A last-ditch scrub of anything that reads like a person, applied to what the model wrote before
 * it is ever stored. The distiller is instructed not to produce these, and this catches the day it
 * does anyway. Deliberately blunt: a lesson that loses a word to over-redaction is a small cost,
 * and a lesson that carries a guest's email past Fred's "no identifiable info" rule is not.
 */
const IDENTIFIERS = [
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[email]"],
  [/\b(?:\+?\d[\d\s().-]{8,}\d)\b/g, "[number]"],
  [/\b[A-Za-z]:\\[^\s"']+/g, "[path]"],
  [/\bhttps?:\/\/\S+/g, "[link]"],
];
export function deidentify(text) {
  let out = String(text == null ? "" : text);
  for (const [re, tag] of IDENTIFIERS) out = out.replace(re, tag);
  return out;
}

export function createFeedback({
  dir,
  distill,                                  // async (kind, {question, answer}) -> {ok, lesson, why, report, fix, model, error}
  dailyLimit = DEFAULT_DAILY_LIMIT,
  log = () => {},
  now = () => new Date().toISOString(),
} = {}) {
  if (!dir) throw new Error("createFeedback needs a dir");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "feedback.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS distillations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,
    scope TEXT NOT NULL,
    kind TEXT NOT NULL,
    lesson TEXT NOT NULL,
    why TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    model TEXT NOT NULL DEFAULT '',
    createdAt TEXT, decidedAt TEXT )`);
  db.exec(`CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    uid TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    lesson TEXT NOT NULL,
    sourceId INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT )`);
  db.exec(`CREATE TABLE IF NOT EXISTS counters (
    uid TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (uid, day, kind) )`);

  const q = {
    insertDist: db.prepare("INSERT INTO distillations (uid,scope,kind,lesson,why,status,model,createdAt) VALUES (?,?,?,?,?,?,?,?)"),
    getDist: db.prepare("SELECT * FROM distillations WHERE id=?"),
    // The anonymous projection. `uid` is deliberately absent: this is the ONLY statement the
    // owner-facing surfaces read through, so the privacy rule holds by construction rather than by
    // every future caller remembering to delete a field.
    pending: db.prepare("SELECT id,scope,kind,lesson,why,model,createdAt FROM distillations WHERE status IN ('pending','later') ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id"),
    recent: db.prepare("SELECT id,scope,kind,lesson,why,status,createdAt,decidedAt FROM distillations WHERE status IN ('approved','denied') ORDER BY id DESC LIMIT ?"),
    decide: db.prepare("UPDATE distillations SET status=?, decidedAt=? WHERE id=?"),
    countPending: db.prepare("SELECT COUNT(*) AS n FROM distillations WHERE status IN ('pending','later')"),
    insertLesson: db.prepare("INSERT INTO lessons (scope,uid,kind,lesson,sourceId,active,createdAt) VALUES (?,?,?,?,?,1,?)"),
    lessonsGlobal: db.prepare("SELECT lesson,kind FROM lessons WHERE active=1 AND scope='global' ORDER BY id DESC LIMIT ?"),
    lessonsUser: db.prepare("SELECT lesson,kind FROM lessons WHERE active=1 AND scope='user' AND uid=? ORDER BY id DESC LIMIT ?"),
    retireLesson: db.prepare("UPDATE lessons SET active=0 WHERE sourceId=?"),
    counterGet: db.prepare("SELECT n FROM counters WHERE uid=? AND day=? AND kind=?"),
    counterBump: db.prepare("INSERT INTO counters (uid,day,kind,n) VALUES (?,?,?,1) ON CONFLICT(uid,day,kind) DO UPDATE SET n=n+1"),
  };

  const uidOf = (T) => (T && T.isOwner ? "owner" : String((T && T.uid) || ""));

  /*
   * The gate, checked before the model is called. The owner is exempt: he is the account the
   * Opus 5 call bills to, so rationing him against his own key would be theatre.
   */
  function quota(T, kind) {
    const limit = dailyLimit;
    if (T && T.isOwner) return { ok: true, owner: true, used: 0, limit: null, remaining: null };
    if (!THUMB_KINDS.includes(kind)) return { ok: false, used: 0, limit, remaining: 0, error: "unknown feedback kind" };
    const row = q.counterGet.get(uidOf(T), dayOf(now()), kind);
    const used = (row && row.n) || 0;
    const remaining = Math.max(0, limit - used);
    if (used >= limit) {
      return { ok: false, used, limit, remaining: 0,
        error: `That is all ${limit} of today's ${kind === "positive" ? "positive" : "negative"} notes. The counter resets tomorrow — thank you, this genuinely does teach it.` };
    }
    return { ok: true, used, limit, remaining };
  }

  function storeDistillation({ uid, scope, kind, lesson, why, status, model }) {
    const r = q.insertDist.run(uid, scope, kind, clamp(deidentify(lesson), MAX_LESSON),
      clamp(deidentify(why), MAX_WHY), status, String(model || ""), now());
    return Number(r.lastInsertRowid);
  }

  function applyLesson({ id, scope, uid, kind, lesson }) {
    q.insertLesson.run(scope, scope === "global" ? "" : uid, kind, clamp(deidentify(lesson), MAX_LESSON), id, now());
  }

  /*
   * A guest tap, end to end: gate, distil, queue. A guest's lesson is scoped to that guest's own
   * account, because one person's taste is not a global truth and Fred is the only one who can
   * decide otherwise.
   *
   * The owner's tap runs the same distillation and then skips the queue entirely ("In my interface
   * only, the same buttons do not need to be evaluated and go into my own account immediately").
   * It still has to be distilled — a thumb with no lesson attached teaches nothing — so the only
   * thing his path skips is waiting for his own approval.
   */
  async function react(T, { kind, question = "", answer = "" } = {}) {
    if (!THUMB_KINDS.includes(kind)) return { ok: false, error: "unknown feedback kind" };
    if (!String(answer).trim()) return { ok: false, error: "there is no answer to learn from" };
    const gate = quota(T, kind);
    if (!gate.ok) return { ok: false, error: gate.error, rateLimited: true, used: gate.used, limit: gate.limit };

    const uid = uidOf(T);
    if (!uid) return { ok: false, error: "sign in" };
    const out = await distill(kind, { question, answer });
    if (!out || !out.ok || !String(out.lesson || "").trim()) {
      return { ok: false, error: (out && out.error) || "the reviewer could not read that turn just now" };
    }
    // Counted only on a distillation that actually happened, so a provider outage never silently
    // eats a guest's ten.
    if (!(T && T.isOwner)) q.counterBump.run(uid, dayOf(now()), kind);

    const ownerTap = !!(T && T.isOwner);
    const id = storeDistillation({
      uid, scope: "user", kind, lesson: out.lesson, why: out.why || "",
      status: ownerTap ? "approved" : "pending", model: out.model,
    });
    if (ownerTap) applyLesson({ id, scope: "user", uid, kind, lesson: out.lesson });
    writeCompiled();
    const left = quota(T, kind);
    return {
      ok: true, id, applied: ownerTap,
      lesson: clamp(deidentify(out.lesson), MAX_LESSON),
      why: clamp(deidentify(out.why || ""), MAX_WHY),
      remaining: left.remaining, limit: left.limit,
    };
  }

  /*
   * Critique and Inspect: the owner's two adversarial lenses. Both hand back a report immediately
   * (it is a report TO Fred, so it belongs on screen now) and queue their lesson at GLOBAL scope,
   * because his ruling is that an approved one lands on his account and on every guest at once.
   * The queue entry is what makes that deliberate rather than automatic.
   */
  async function report(T, { kind, question = "", answer = "" } = {}) {
    if (!(T && T.isOwner)) return { ok: false, error: "owner only" };
    if (!["critique", "inspect"].includes(kind)) return { ok: false, error: "unknown report kind" };
    if (!String(answer).trim()) return { ok: false, error: "there is no answer to review" };
    const out = await distill(kind, { question, answer });
    if (!out || !out.ok) return { ok: false, error: (out && out.error) || "the reviewer could not read that turn just now" };
    const id = String(out.lesson || "").trim()
      ? storeDistillation({ uid: "owner", scope: "global", kind, lesson: out.lesson, why: out.why || "", status: "pending", model: out.model })
      : 0;
    writeCompiled();
    return {
      ok: true, id, kind,
      report: clamp(out.report || "", MAX_REPORT),
      fix: clamp(out.fix || "", MAX_REPORT),
      lesson: clamp(deidentify(out.lesson || ""), MAX_LESSON),
      why: clamp(deidentify(out.why || ""), MAX_WHY),
      model: out.model || "",
    };
  }

  /*
   * Approve / deny / later. "Later" is a real state rather than a synonym for pending, because
   * Fred asked for exactly that: "there should also be an option for me to decide later and save
   * it to be brought up the next time I open Dominion AI." It keeps its place in the queue and
   * sorts below anything genuinely new.
   */
  function decide(T, id, action) {
    if (!(T && T.isOwner)) return { ok: false, error: "owner only" };
    if (!["approve", "deny", "later"].includes(action)) return { ok: false, error: "unknown decision" };
    const row = q.getDist.get(Number(id));
    if (!row) return { ok: false, error: "not found" };
    if (["approved", "denied"].includes(row.status)) return { ok: false, error: "already decided" };
    const status = action === "approve" ? "approved" : action === "deny" ? "denied" : "later";
    q.decide.run(status, action === "later" ? null : now(), row.id);
    if (action === "approve") {
      applyLesson({ id: row.id, scope: row.scope, uid: row.uid, kind: row.kind, lesson: row.lesson });
      // A global approval from a critique/inspect is Fred's ruling applied everywhere at once.
      log(`[feedback] approved #${row.id} (${row.kind}) into ${row.scope === "global" ? "every account" : "one account"}`);
    }
    if (action === "deny") q.retireLesson.run(row.id);
    writeCompiled();
    return { ok: true, id: row.id, status, scope: row.scope };
  }

  // The owner's review list. Anonymous by construction — see the `pending` statement above.
  const pending = () => q.pending.all().map((r) => ({ ...r, deferred: undefined }));
  const pendingCount = () => Number((q.countPending.get() || {}).n || 0);
  const recent = (n = 20) => q.recent.all(Math.max(1, Math.min(200, Number(n) || 20)));

  /*
   * What the model is actually told. Global lessons first (they are policy), then this account's
   * own (they are taste). Rendered identically every turn so the block stays byte-stable inside
   * the cached prefix; it changes only when Fred decides something.
   */
  function lessonsFor(T) {
    const uid = uidOf(T);
    const global = q.lessonsGlobal.all(MAX_ACTIVE_LESSONS).map((r) => r.lesson);
    const mine = uid ? q.lessonsUser.all(uid, MAX_ACTIVE_LESSONS).map((r) => r.lesson) : [];
    return { global, user: mine };
  }
  function promptBlock(T) {
    const { global, user } = lessonsFor(T);
    const seen = new Set();
    const lines = [...global, ...user].filter((l) => l && !seen.has(l) && seen.add(l));
    if (!lines.length) return "";
    return "Learned from feedback on your past answers — follow these:\n"
      + lines.map((l) => "- " + l).join("\n");
  }

  /*
   * The compiled file Fred asked for ("These distillations must be compiled in a file"). The
   * database is the source of truth; this is the readable copy, written from the anonymous
   * projection so the file on disk cannot carry what the screen refuses to show.
   */
  const filePath = join(dir, "distillations.md");
  function writeCompiled() {
    try {
      const open = pending(), done = recent(20);
      const line = (d) => `- **${d.kind}**${d.scope === "global" ? " · everyone" : ""}: ${d.lesson}\n  - why: ${d.why}\n  - id ${d.id} · ${d.createdAt}${d.status ? " · " + d.status : ""}`;
      const body = [
        "# Dominion — lessons waiting on you",
        "",
        `_${open.length} waiting, written ${now()}. No account details appear here by design._`,
        "",
        open.length ? "## Waiting for a decision" : "## Nothing waiting",
        ...open.map(line),
        "",
        "## Recently decided",
        ...(done.length ? done.map(line) : ["- (none yet)"]),
        "",
      ].join("\n");
      writeFileSync(filePath, body, "utf8");
    } catch (e) { log(`[feedback] could not write the compiled file: ${e && e.message}`); }
  }

  const stats = () => ({
    pending: pendingCount(),
    globalLessons: q.lessonsGlobal.all(MAX_ACTIVE_LESSONS).length,
    file: filePath,
  });

  // Windows keeps a lock on the WAL file for as long as the handle is open, so anything that
  // wants to delete this directory afterwards (tests, a teardown script) needs a way to let go.
  const close = () => { try { db.close(); } catch {} };

  return { react, report, decide, pending, pendingCount, recent, lessonsFor, promptBlock, quota, stats, filePath, writeCompiled, close };
}

/*
 * ---- the distiller ------------------------------------------------------------------------
 *
 * Four lenses, one shape out. These prompts are the whole quality of the feature, so they are
 * written to produce a STANDING instruction rather than a compliment or a complaint: "be more
 * concise about deployment steps" is worth keeping, "that was a good answer" is not.
 *
 * Every lens is told, in its own words, not to write anything that identifies a person. That is
 * belt to deidentify()'s braces.
 */
const NO_IDENTITY = "Never put a person, company, email address, file path, URL, or any other identifying "
  + "detail in `lesson` or `why`. Write both so they make complete sense to someone who never saw this "
  + "conversation. If the only lesson available would need such a detail to make sense, say so in `why` "
  + "and give a generalized lesson instead.";

const LENS = {
  positive: {
    system: "You distill durable lessons for an AI assistant from moments its user marked as good work.\n\n"
      + "You are given one exchange the user pressed a thumbs-up on. Find what actually made it land, and write it as ONE "
      + "standing instruction the assistant should follow in future, unrelated conversations. Generalize hard: the specific "
      + "topic is nearly always irrelevant, the behaviour behind it is the lesson. Prefer something about approach, format, "
      + "depth, tone, or what it chose to lead with.\n\n"
      + "Reject the temptation to write praise. \"The answer was thorough and clear\" teaches nothing. \"Lead with the "
      + "specific number or command being asked for, then explain it\" is a lesson.\n\n"
      + "If the exchange genuinely carries no generalizable lesson, return an empty `lesson`. A false lesson is worse than "
      + "no lesson, because it will be applied to every future answer.\n\n" + NO_IDENTITY,
    user: (q, a) => `The person asked:\n<question>\n${q}\n</question>\n\nThe assistant answered, and they marked it good:\n<answer>\n${a}\n</answer>\n\n`
      + `Return JSON only: {"lesson": "<one imperative standing instruction, under 240 characters, or empty>", "why": "<one sentence: what will be different about future answers if this is adopted>"}`,
  },
  negative: {
    system: "You distill durable lessons for an AI assistant from moments its user marked as bad work.\n\n"
      + "You are given one exchange the user pressed a thumbs-down on. Work out what the assistant did that they did not want, "
      + "and write ONE standing instruction that would prevent it in future, unrelated conversations. State what to do "
      + "INSTEAD, not merely what to avoid — an instruction phrased only as a prohibition tends to make the behaviour more "
      + "likely, not less.\n\n"
      + "Generalize. The user is not telling you this one answer was wrong, they are telling you a habit is wrong.\n\n"
      + "If the dissatisfaction is clearly about something the assistant cannot control (a missing capability, a refusal it "
      + "was right to make, a factual limit), return an empty `lesson` rather than teaching it to do something it should "
      + "not.\n\n" + NO_IDENTITY,
    user: (q, a) => `The person asked:\n<question>\n${q}\n</question>\n\nThe assistant answered, and they marked it bad:\n<answer>\n${a}\n</answer>\n\n`
      + `Return JSON only: {"lesson": "<one imperative standing instruction saying what to do instead, under 240 characters, or empty>", "why": "<one sentence: what will be different about future answers if this is adopted>"}`,
  },
  /*
   * Critique is the COMMUNICATION lens, and it is adversarial on purpose: it assumes the reader is
   * dissatisfied and its job is to find the reason rather than to decide whether one exists.
   */
  critique: {
    system: "You are a hostile reviewer of an AI assistant's answer, working for the person who received it. Assume they are "
      + "dissatisfied and that your job is to find out why — not to judge whether they are entitled to be.\n\n"
      + "Attack it on three axes and no others: is it UNSUITABLE (wrong shape, wrong register, wrong altitude for who asked), "
      + "is it IRRELEVANT (answers a question adjacent to the one asked, or buries the answer under things nobody asked "
      + "about), is it INCOMPLETE (stops short, leaves a promise unkept, omits the part that was actually hard). Quote the "
      + "specific line that fails wherever you can.\n\n"
      + "This lens is about what was communicated, not about whether the underlying work was technically right — a different "
      + "reviewer covers that. Be concrete and short. If an axis holds up, say so in one clause and move on rather than "
      + "manufacturing a complaint.\n\n"
      + "Then distill ONE standing instruction that would stop this class of failure across future conversations.\n\n" + NO_IDENTITY,
    user: (q, a) => `The person asked:\n<question>\n${q}\n</question>\n\nThe assistant answered:\n<answer>\n${a}\n</answer>\n\n`
      + `Return JSON only: {"report": "<your adversarial findings, markdown, under 400 words>", "lesson": "<one imperative standing instruction, under 240 characters, or empty>", "why": "<one sentence on what this changes>"}`,
  },
  /*
   * Inspect is the TECHNICAL lens. Fred's framing: it "assumes I am dissatisfied with the approach,
   * or the code itself, not necessarily the way it communicated" — so it is explicitly told to stop
   * reviewing the prose and go after the engineering, and to end with a fix rather than a verdict.
   */
  inspect: {
    system: "You are a hostile technical reviewer of an AI assistant's answer, working for the engineer who received it. "
      + "Assume they are dissatisfied with the APPROACH or the CODE — not with how it was worded. Do not comment on tone, "
      + "structure, or clarity at all; another reviewer owns that.\n\n"
      + "Go after the engineering: is the approach itself wrong or needlessly complex, is there a simpler or more standard "
      + "way, does the code have a bug, a race, an unhandled failure, a security or data-loss hazard, a wrong API, a "
      + "performance trap, a missing test. Name the specific line or decision. Rank what you find worst-first.\n\n"
      + "If the approach is actually sound, say that plainly in one line rather than inventing a problem — a fabricated "
      + "objection costs the reader more than silence.\n\n"
      + "Then propose the concrete fix: what to change, and why that change is correct. Finally distill ONE standing "
      + "instruction that would stop this class of technical mistake in future work.\n\n" + NO_IDENTITY,
    user: (q, a) => `The engineer asked:\n<question>\n${q}\n</question>\n\nThe assistant answered:\n<answer>\n${a}\n</answer>\n\n`
      + `Return JSON only: {"report": "<worst-first technical findings, markdown, under 400 words>", "fix": "<the concrete proposed fix, markdown, under 300 words>", "lesson": "<one imperative standing instruction, under 240 characters, or empty>", "why": "<one sentence on what this changes>"}`,
  },
};

/*
 * Pull the JSON object out of whatever came back. Structured outputs make this almost always a
 * no-op, and "almost always" is why the fallback exists rather than a bare JSON.parse.
 */
export function parseDistillation(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const braced = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  if (braced.length > 1) candidates.push(braced);
  for (const c of candidates) {
    try { const o = JSON.parse(c); if (o && typeof o === "object") return o; } catch {}
  }
  return null;
}

export const DISTILL_SCHEMA = {
  type: "object",
  properties: {
    report: { type: "string" },
    fix: { type: "string" },
    lesson: { type: "string" },
    why: { type: "string" },
  },
  required: ["lesson", "why"],
  additionalProperties: false,
};

/*
 * The Opus 5 call itself, wired by the server (it owns the key). Kept here beside its prompts so
 * the lens and the request that carries it cannot drift apart.
 *
 * Opus 5 specifics that are load-bearing rather than stylistic: thinking is on by default and
 * max_tokens caps thinking AND text together, so the budget is generous for what is a short
 * answer; sampling parameters are rejected outright, so none are passed; and a safety classifier
 * can decline with a normal HTTP 200 and stop_reason "refusal", which is why the refusal check
 * comes before anything reads the content.
 */
export function createDistiller({ stream, apiKey, model = "claude-opus-5", effort = "medium", log = () => {} }) {
  return async function distill(kind, { question = "", answer = "" } = {}) {
    const lens = LENS[kind];
    if (!lens) return { ok: false, error: "unknown feedback kind" };
    if (!apiKey || !apiKey()) return { ok: false, error: "the reviewer is not configured on this server yet" };
    const messages = [
      { role: "system", content: lens.system },
      { role: "user", content: lens.user(clamp(question, 4000) || "(the question was not captured)", String(answer).slice(0, 12000)) },
    ];
    let r;
    try {
      r = await stream(model, messages, {
        apiKey: apiKey(),
        maxTokens: 8000,
        effort,
        output_config: { format: { type: "json_schema", schema: DISTILL_SCHEMA } },
        maxRetries: 1,
      }, () => {});
    } catch (e) {
      log(`[feedback] distillation transport failed: ${e && e.message}`);
      return { ok: false, error: "the reviewer could not be reached just now" };
    }
    if (r && r.stopReason === "refusal") {
      log(`[feedback] distillation declined by safety classifiers (${(r.stopDetails && r.stopDetails.category) || "no category"})`);
      return { ok: false, error: "the reviewer declined to read that turn" };
    }
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || "the reviewer returned nothing" };
    const parsed = parseDistillation(r.content);
    if (!parsed) {
      log("[feedback] distillation was unparseable");
      return { ok: false, error: "the reviewer's answer could not be read" };
    }
    return {
      ok: true,
      lesson: String(parsed.lesson || "").trim(),
      why: String(parsed.why || "").trim(),
      report: String(parsed.report || "").trim(),
      fix: String(parsed.fix || "").trim(),
      model: String(r.model || model),
    };
  };
}
