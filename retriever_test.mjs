/*
 * Free retrieval stack self-test (ARSENAL Wave 5) — run: node retriever_test.mjs
 * Part 1 drives retriever.mjs against a MOCK NVIDIA server: embedding shape (input_type
 * asymmetry), rerank ordering, the null-on-failure contract, and the applyRerank helper.
 * Part 2 exercises memory.mjs space safety: mixed-dimension vectors score as unembedded
 * instead of being half-buried, and the query lane rides embedQuery.
 * No real NVIDIA calls.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFreeRetriever, applyRerank } from "./retriever.mjs";
import { createMemoryStore } from "./memory.mjs";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

/* ---------- mock NVIDIA: /v1/embeddings + the reranking path ---------- */
const PORT = 8770 + (process.pid % 200);
let mode = "ok"; // ok | boom
const seen = { embeds: [], reranks: [] };
const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => b += d);
  req.on("end", () => {
    const send = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (mode === "boom") return send(500, { error: "kaboom" });
    if (req.url === "/v1/embeddings") {
      const body = JSON.parse(b);
      seen.embeds.push(body);
      // query-type vectors point one way, passage-type the other, so the test can PROVE the
      // asymmetry reached the wire; 4 dims is plenty for the contract.
      const v = body.input_type === "query" ? [1, 0, 0, 0] : [0, 1, 0, 0];
      return send(200, { data: [{ embedding: v }] });
    }
    if (/\/reranking$/.test(req.url)) {
      const body = JSON.parse(b);
      seen.reranks.push(body);
      // Highest logit to the passage containing "forge", lowest to "cafeteria".
      const rankings = body.passages.map((p, i) => ({ index: i, logit: /forge/i.test(p.text) ? 10 + i : /cafeteria/i.test(p.text) ? -10 : 0 }))
        .sort((a, b) => b.logit - a.logit);
      return send(200, { rankings });
    }
    send(404, {});
  });
});
await new Promise((r) => mock.listen(PORT, "127.0.0.1", r));

const R = createFreeRetriever({
  key: () => "test-key",
  embedBase: "http://127.0.0.1:" + PORT,
  rerankUrl: "http://127.0.0.1:" + PORT + "/v1/retrieval/mock/reranking",
});

await t("embed carries the model and the input_type asymmetry", async () => {
  const q = await R.embed("what temp", { inputType: "query" });
  const p = await R.embed("the forge runs hot", { inputType: "passage" });
  if (!q || !p) throw new Error("embed returned null");
  if (JSON.stringify(q) === JSON.stringify(p)) throw new Error("query and passage vectors identical — input_type not honored");
  const calls = seen.embeds.slice(-2);
  if (calls[0].input_type !== "query" || calls[1].input_type !== "passage") throw new Error("input_type not sent: " + JSON.stringify(calls.map((c) => c.input_type)));
  if (calls[0].model !== "nvidia/nemotron-3-embed-1b") throw new Error("model: " + calls[0].model);
});

await t("rerank orders by relevance and carries the probed request shape", async () => {
  const r = await R.rerank("what temperature does the forge run at",
    ["The cafeteria closes at 3pm.", "The forge runs at 1400 degrees.", "Forge temperature control uses a thermocouple."]);
  if (!r) throw new Error("rerank returned null");
  if (r[0].index === 0) throw new Error("cafeteria won the rerank");
  const call = seen.reranks.at(-1);
  if (!call.query || call.query.text !== "what temperature does the forge run at") throw new Error("query shape wrong");
  if (!Array.isArray(call.passages) || call.passages.length !== 3 || !call.passages[0].text) throw new Error("passages shape wrong");
});

await t("a single passage is not reranked (nothing to reorder)", async () => {
  const r = await R.rerank("q", ["only one"]);
  if (r !== null) throw new Error("expected null for <2 passages");
});

await t("failures return null, never throw (the availability contract)", async () => {
  mode = "boom";
  const e = await R.embed("x");
  const r = await R.rerank("q", ["a", "b"]);
  mode = "ok";
  if (e !== null || r !== null) throw new Error("expected nulls on upstream failure");
});

await t("no key = not available, both lanes null, zero network calls", async () => {
  const dark = createFreeRetriever({ key: () => "", embedBase: "http://127.0.0.1:1" });
  if (dark.available()) throw new Error("available without key");
  if ((await dark.embed("x")) !== null || (await dark.rerank("q", ["a", "b"])) !== null) throw new Error("expected nulls");
});

await t("applyRerank reorders, dedupes, and backfills uncovered items in original order", async () => {
  const items = ["a", "b", "c", "d"];
  const out = applyRerank(items, [{ index: 2, logit: 5 }, { index: 0, logit: 1 }], 3);
  if (JSON.stringify(out) !== JSON.stringify(["c", "a", "b"])) throw new Error(JSON.stringify(out));
  const noVerdict = applyRerank(items, null, 2);
  if (JSON.stringify(noVerdict) !== JSON.stringify(["a", "b"])) throw new Error("null verdict should keep original order");
  const bogus = applyRerank(items, [{ index: 9, logit: 3 }, { index: 1, logit: 2 }], 2);
  if (JSON.stringify(bogus) !== JSON.stringify(["b", "a"])) throw new Error("out-of-range index not ignored: " + JSON.stringify(bogus));
});

/* ---------- memory.mjs space safety ---------- */
const dir = mkdtempSync(join(tmpdir(), "dominion-retr-mem-"));
// Item embedder: OLD 2-dim space. Query embedder: NEW 4-dim space (mismatch on purpose).
const mem = createMemoryStore({
  dir,
  embed: async () => [0.5, 0.5],
  embedQuery: async () => [1, 0, 0, 0],
});

await t("memory: a vector from another space scores as unembedded, not half-buried", async () => {
  const { item } = mem.propose({ content: "Fred prefers brass fittings on the forge exhaust", source: { kind: "user_explicit" } });
  await new Promise((r) => setTimeout(r, 50));   // let the fire-and-forget embed land
  if (!mem.get(item.id).vec) throw new Error("item never embedded");
  const hits = await mem.retrieveHybrid("brass fittings forge exhaust", { limit: 4, minScore: 0.1 });
  if (!hits.length || hits[0].id !== item.id) throw new Error("cross-space item was buried: " + JSON.stringify(hits.map((h) => h.id)));
});

await t("memory: same-space vectors still ride the hybrid blend", async () => {
  const mem2 = createMemoryStore({
    dir: mkdtempSync(join(tmpdir(), "dominion-retr-mem2-")),
    embed: async () => [1, 0, 0, 0],
    embedQuery: async () => [1, 0, 0, 0],
  });
  const { item } = mem2.propose({ content: "The kiln schedule is Tuesdays", source: { kind: "user_explicit" } });
  await new Promise((r) => setTimeout(r, 50));
  const hits = await mem2.retrieveHybrid("kiln schedule", { limit: 4, minScore: 0.1 });
  if (!hits.length || hits[0].id !== item.id) throw new Error("same-space retrieval failed");
  if (!(hits[0].score > 0.5)) throw new Error("cosine blend missing: score=" + hits[0].score);
});

console.log(`\nretriever: ${passed} passed, ${failed} failed`);
mock.close();
process.exit(failed ? 1 : 0);
