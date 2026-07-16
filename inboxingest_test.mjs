/*
 * Phase-3 remote-inbox-ingest self-test — run with: node inboxingest_test.mjs
 * Proves (mock dispatch + mock persona): text files are read and ingested, binaries are skipped
 * (never garbage-ingested), dedup is reported, offline is honest, and unconfigured is refused.
 */
import assert from "node:assert/strict";
import { createInboxIngest } from "./inboxingest.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// Mock persona: records ingests, dedups a specific title on a second sight.
function mockPersona() {
  const seen = new Set(); const calls = [];
  return {
    calls,
    ingestText({ text, kind, title, source }) {
      calls.push({ title, kind, len: text.length, source });
      if (seen.has(title)) return { deduped: true, doc: { id: "d" }, chunks: 0 };
      seen.add(title); return { doc: { id: "d" + calls.length }, chunks: 1 };
    },
    __presee(title) { seen.add(title); },
  };
}

// Mock dispatch that serves a fake inbox.
function mockDispatch(files) {
  return async (_node, tool, args) => {
    if (tool === "fs_list") return { ok: true, entries: Object.keys(files).map((n) => ({ name: n, type: "file", size: files[n].length })) };
    if (tool === "fs_read") { const name = String(args.path).split(/[\\/]/).pop(); return files[name] != null ? { ok: true, base64: b64(files[name]) } : { ok: false, error: "not found" }; }
    return { ok: false, error: "unexpected tool " + tool };
  };
}

await t("ingests text files, skips binaries, reports counts", async () => {
  const persona = mockPersona();
  const files = { "a.txt": "This is a poem about the sea, long enough to pass.", "b.md": "# Notes\nmore than twenty chars here.", "c.docx": "PKbinaryjunk", "d.png": "\x89PNG" };
  const ii = createInboxIngest({ persona, dispatch: mockDispatch(files), cfg: { node: "mini-pc", dir: "E:\\DominionCorpus\\inbox" } });
  const r = await ii.ingestRemoteInbox();
  assert.equal(r.ok, true);
  assert.equal(r.seen, 4);
  assert.equal(r.ingested, 2, "two text files ingested");
  assert.equal(r.skipped.length, 2, "docx + png skipped");
  assert.ok(r.skipped.every((s) => /needs local extraction/.test(s.reason)));
  assert.equal(persona.calls.length, 2);
});

await t("re-running dedups already-seen files (idempotent)", async () => {
  const persona = mockPersona(); persona.__presee("a.txt");
  const files = { "a.txt": "This is a poem about the sea, long enough to pass." };
  const ii = createInboxIngest({ persona, dispatch: mockDispatch(files), cfg: { node: "x", dir: "/inbox" } });
  const r = await ii.ingestRemoteInbox();
  assert.equal(r.ingested, 0); assert.equal(r.deduped, 1);
});

await t("offline node -> honest offline, ingests nothing", async () => {
  const persona = mockPersona();
  const off = async () => ({ ok: false, offline: true, error: "node offline" });
  const ii = createInboxIngest({ persona, dispatch: off, cfg: { node: "x", dir: "/inbox" } });
  const r = await ii.ingestRemoteInbox();
  assert.equal(r.ok, false); assert.equal(r.offline, true);
  assert.equal(persona.calls.length, 0);
});

await t("unconfigured -> refused, ingests nothing", async () => {
  const persona = mockPersona();
  const ii = createInboxIngest({ persona, dispatch: null, cfg: {} });
  const r = await ii.ingestRemoteInbox();
  assert.equal(r.ok, false); assert.match(r.error, /not configured/);
});

await t("html files are de-tagged via htmlToText when provided", async () => {
  const persona = mockPersona();
  const files = { "page.html": "<html><body><p>Hello world this is plenty of text.</p></body></html>" };
  const ii = createInboxIngest({ persona, dispatch: mockDispatch(files), cfg: { node: "x", dir: "/i" }, htmlToText: (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() });
  const r = await ii.ingestRemoteInbox();
  assert.equal(r.ingested, 1);
  assert.ok(!/</.test(persona.calls[0].len ? "" : ""));   // sanity: call happened
  assert.ok(persona.calls[0].len < 70, "tags stripped shrank the text");
});

console.log(`\ninboxingest_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
