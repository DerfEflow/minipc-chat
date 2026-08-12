/*
 * Lane H self-test: Maps, BigQuery, People (Contacts) -- run: node google-tools_test.mjs
 *
 * Drives the REAL public surface of each module (createMapsTools / createBigQueryTools /
 * createPeopleTools -> .TOOLS[].run) exactly the way google.mjs and the chat loop call it. No
 * test-only hook exists in the product; only the network boundary (globalThis.fetch) and, for
 * BigQuery/People, the injected accessToken() are stubbed where a real Google credential is not
 * available on this build machine.
 *
 * WHAT IS LIVE vs STUBBED, and why (do not skim past this):
 *   - Maps: LIVE against the real Google Maps Platform, using GOOGLE_MAPS_API_KEY and
 *     GOOGLE_MAPS_PLACES_SEARCH_API_KEY read from ~/.app-secrets.env at runtime (never written into
 *     this file). If those keys are ever absent from the wallet, the live block reports UNVERIFIED
 *     by name instead of silently passing.
 *   - BigQuery: NOT live. This build machine has no <DATA_DIR>/connectors/google-oauth.json (no
 *     account has completed the Google OAuth grant here at all), and even a token from a machine
 *     that HAS connected predates the bigquery.readonly scope this lane added -- reconnecting needs
 *     an interactive browser this session does not have. The dry-run-refusal LOGIC is exercised for
 *     real, for real, against a stubbed fetch that returns a realistic BigQuery dry-run response
 *     shape; every line of google-bigquery.mjs's cap/refusal code runs, only the network reply is
 *     canned. Marked [unverified: live network] everywhere this matters.
 *   - People: NOT live, same missing-credential reason (contacts.readonly is a second added scope).
 *     Query-required refusal and response formatting are exercised against a stubbed fetch.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMapsTools } from "./google-maps.mjs";
import { createBigQueryTools } from "./google-bigquery.mjs";
import { createPeopleTools } from "./google-people.mjs";

let passed = 0, failed = 0, skipped = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); } };
const skip = (name, why) => { skipped++; console.log("  --  " + name + "  (SKIPPED: " + why + ")"); };

/*
 * A LIVE check that could not REACH the network is unverified, not failed (2026-08-12).
 *
 * This file already draws that line for a missing key: no key means SKIPPED with "UNVERIFIED, not
 * faked", which is exactly the right instinct. It did not draw the same line for the network itself,
 * so a blip on the way to Google turned into a red suite, and `run-tests.mjs` is the gate that blocks
 * a deploy. Observed: "maps_geocode ... Error: fetch failed" inside a full run, with the same suite
 * passing 26/26 on its own a minute later. The code under test had not changed and was not wrong.
 *
 * The distinction is kept narrow on purpose. Only a failure to reach the host at all is downgraded.
 * An API that answers with an error, or coordinates that come back wrong, is still a real failure and
 * still fails the build, which is the entire point of testing against the live API.
 */
const UNREACHABLE = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|socket hang up|getaddrinfo/i;
const liveT = async (name, fn) => {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) {
    const msg = String((e && e.message) || e);
    if (UNREACHABLE.test(msg) && !(e instanceof assert.AssertionError)) {
      skip(name, "could not reach the live API (" + msg.slice(0, 60) + ") -- UNVERIFIED, not faked");
      return;
    }
    failed++; console.error("FAIL  " + name + "\n      " + ((e && e.stack) || e));
  }
};

const realFetch = globalThis.fetch;
const stub = (handler) => { globalThis.fetch = handler; };
const restore = () => { globalThis.fetch = realFetch; };
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Wallet keys, read at runtime only -- never a literal in this file, never printed.
function walletKeys() {
  try {
    const raw = readFileSync(join(homedir(), ".app-secrets.env"), "utf8");
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch { return {}; }
}

// ================================================================================================
// PART 1: MAPS -- live against the real API.
// ================================================================================================
const wallet = walletKeys();
const mapsKey = process.env.GOOGLE_MAPS_API_KEY || wallet.GOOGLE_MAPS_API_KEY || "";
const placesKey = process.env.GOOGLE_MAPS_PLACES_SEARCH_API_KEY || wallet.GOOGLE_MAPS_PLACES_SEARCH_API_KEY || "";

if (!mapsKey) {
  skip("maps: geocode / distance / directions (live)", "GOOGLE_MAPS_API_KEY not found in env or ~/.app-secrets.env -- UNVERIFIED, not faked");
} else {
  const maps = createMapsTools({ cfgGet: (k, d) => ({ GOOGLE_MAPS_API_KEY: mapsKey, GOOGLE_MAPS_PLACES_SEARCH_API_KEY: placesKey }[k] ?? d) });
  const byName = new Map(maps.TOOLS.map((x) => [x.name, x]));

  await liveT("maps_geocode: real address -> real coordinates (LIVE)", async () => {
    const out = await byName.get("maps_geocode").run({}, { address: "1600 Amphitheatre Parkway, Mountain View, CA" });
    assert.match(out, /Mountain View/i);
    assert.match(out, /lat 37\./);
    console.log("      -> " + out.split("\n")[0]);
  });

  await liveT("maps_distance: SF -> Mountain View, real distance (LIVE)", async () => {
    const out = await byName.get("maps_distance").run({}, { origins: "San Francisco, CA", destinations: "Mountain View, CA" });
    assert.match(out, /km|mi/);
    console.log("      -> " + out);
  });

  await liveT("maps_directions: real route (LIVE)", async () => {
    const out = await byName.get("maps_directions").run({}, { origin: "San Francisco, CA", destination: "Mountain View, CA" });
    assert.match(out, /Route via/);
    console.log("      -> " + out);
  });
}

if (!placesKey && !mapsKey) {
  skip("maps_place_search (live)", "no Places key available -- UNVERIFIED, not faked");
} else {
  const maps = createMapsTools({ cfgGet: (k, d) => ({ GOOGLE_MAPS_API_KEY: mapsKey, GOOGLE_MAPS_PLACES_SEARCH_API_KEY: placesKey }[k] ?? d) });
  await liveT("maps_place_search: real text search (LIVE)", async () => {
    const out = await maps.TOOLS.find((x) => x.name === "maps_place_search").run({}, { query: "coffee near Mountain View CA", max: 5 });
    assert.match(out, /-/);
    console.log("      -> " + out.split("\n")[0]);
  });
}

await t("maps_geocode: neither address nor lat/lng -> refused, no call made", async () => {
  const maps = createMapsTools({ cfgGet: (k, d) => ({ GOOGLE_MAPS_API_KEY: "fake-key-for-arg-validation-test" }[k] ?? d) });
  let called = false;
  stub(async () => { called = true; return jsonRes(200, {}); });
  const out = await maps.TOOLS.find((x) => x.name === "maps_geocode").run({}, {});
  restore();
  assert.equal(called, false);
  assert.match(out, /Give either/);
});

await t("maps tools: missing key -> honest refusal, not a crash", async () => {
  const maps = createMapsTools({ cfgGet: (k, d) => d });
  const out = await maps.TOOLS.find((x) => x.name === "maps_geocode").run({}, { address: "x" });
  assert.match(out, /not set up/);
});

// ================================================================================================
// PART 2: BIGQUERY -- the HIGH-blast-radius lane. H1/H2 wargame proof below.
// ================================================================================================
const fakeAccessToken = async () => "fake-token-for-logic-test";

await t("bigquery_query: write-keyword refused BEFORE any network call (defense-in-depth layer)", async () => {
  const bq = createBigQueryTools({ accessToken: fakeAccessToken, cfgGet: (k, d) => d });
  let calls = 0;
  stub(async () => { calls++; return jsonRes(200, {}); });
  const out = await bq.TOOLS.find((x) => x.name === "bigquery_query").run({}, { projectId: "p1", query: "DELETE FROM t WHERE 1=1" });
  // A second query that PASSES the SELECT-start gate and is then caught by the keyword scan, so
  // both halves of the gate are exercised rather than only the first one to fire.
  const out2 = await bq.TOOLS.find((x) => x.name === "bigquery_query").run({}, { projectId: "p1", query: "SELECT 1; DELETE FROM t WHERE 1=1" });
  restore();
  assert.equal(calls, 0, "a write-shaped query must never reach the network at all");
  assert.match(out, /Refused/);
  assert.match(out, /SELECT or WITH/, "a non-read statement is refused on shape");
  assert.match(out2, /Refused/);
  assert.match(out2, /DELETE/, "a write smuggled after a semicolon is named in the refusal");
});

// ---- THE WARGAME: H1 + H2, live-proof-equivalent (stubbed network, real refusal code) ----
await t("*** H1+H2 LIVE PROOF (stubbed network): oversized query is REFUSED before it can bill ***", async () => {
  const cap = 1000; // 1000-byte cap for this test, so a "huge" estimate is easy to construct
  const bq = createBigQueryTools({ accessToken: fakeAccessToken, cfgGet: (k, d) => (k === "BIGQUERY_MAX_BYTES_BILLED" ? String(cap) : d) });
  let calls = 0, sawRealJob = false;
  stub(async (url, opts) => {
    calls++;
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (body.dryRun === true) {
      // A realistic BigQuery dry-run response shape (statistics live at top level for jobs.query).
      return jsonRes(200, { jobComplete: true, totalBytesProcessed: "5000000000" }); // 5GB estimate, way over the 1000-byte cap
    }
    sawRealJob = true; // the real (billable) job must NEVER be reached in this test
    return jsonRes(200, { jobComplete: true, totalBytesProcessed: "5000000000", rows: [] });
  });
  const out = await bq.TOOLS.find((x) => x.name === "bigquery_query").run({}, { projectId: "fred-project", query: "SELECT * FROM huge_table" });
  restore();

  console.log("\n      ACTUAL REFUSAL TEXT RETURNED BY bigquery_query:\n      \"" + out + "\"\n");

  assert.equal(calls, 1, "exactly one call (the dry run) may happen; the real job must never fire");
  assert.equal(sawRealJob, false, "H1: the billable job must never run when the estimate exceeds the cap");
  assert.match(out, /REFUSED/, "the caller must be told this was refused, not silently thinned");
  assert.match(out, /5\.0 GB|5000000000/, "H2: the estimate must be reported back even on refusal");
  assert.match(out, /1000 B|1000 bytes|cap of/i, "the cap that triggered the refusal must be stated");
  assert.doesNotMatch(out, /truncat/i, "H1 explicitly forbids truncating and running anyway");
});

await t("bigquery_query: estimate WITHIN cap proceeds, and the hard cap still rides on the real job (belt+suspenders)", async () => {
  const cap = 10_000_000; // 10MB
  const bq = createBigQueryTools({ accessToken: fakeAccessToken, cfgGet: (k, d) => (k === "BIGQUERY_MAX_BYTES_BILLED" ? String(cap) : d) });
  let realJobBody = null;
  stub(async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.dryRun === true) return jsonRes(200, { jobComplete: true, totalBytesProcessed: "500000" }); // 500KB, well under cap
    realJobBody = body;
    return jsonRes(200, { jobComplete: true, totalBytesProcessed: "500000", totalRows: "1",
      schema: { fields: [{ name: "n" }] }, rows: [{ f: [{ v: "42" }] }] });
  });
  const out = await bq.TOOLS.find((x) => x.name === "bigquery_query").run({}, { projectId: "p1", query: "SELECT 42 AS n" });
  restore();
  assert.ok(realJobBody, "the real job must run when the estimate is within the cap");
  assert.equal(realJobBody.maximumBytesBilled, String(cap), "H1: maximumBytesBilled must ride on EVERY real job, not just be advisory");
  assert.equal(realJobBody.dryRun, false);
  assert.match(out, /42/);
});

await t("bigquery_query: caller cannot raise the cap above the server ceiling", async () => {
  const ceiling = 10_000_000;
  const bq = createBigQueryTools({ accessToken: fakeAccessToken, cfgGet: (k, d) => (k === "BIGQUERY_MAX_BYTES_BILLED" ? String(ceiling) : d) });
  let realJobBody = null;
  stub(async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.dryRun === true) return jsonRes(200, { jobComplete: true, totalBytesProcessed: "9000000" });
    realJobBody = body;
    return jsonRes(200, { jobComplete: true, totalBytesProcessed: "9000000", rows: [] });
  });
  // caller asks for a MUCH higher cap than the ceiling allows
  await bq.TOOLS.find((x) => x.name === "bigquery_query").run({}, { projectId: "p1", query: "SELECT 1", maxBytesBilled: 999_000_000_000 });
  restore();
  assert.equal(realJobBody.maximumBytesBilled, String(ceiling), "a caller-supplied cap must never exceed the server ceiling");
});

await t("bigquery_estimate_query: dry-run only, never touches the billable endpoint shape", async () => {
  const bq = createBigQueryTools({ accessToken: fakeAccessToken, cfgGet: (k, d) => d });
  let calls = 0;
  stub(async (url, opts) => { calls++; assert.equal(JSON.parse(opts.body).dryRun, true); return jsonRes(200, { totalBytesProcessed: "12345" }); });
  const out = await bq.TOOLS.find((x) => x.name === "bigquery_estimate_query").run({}, { projectId: "p1", query: "SELECT 1" });
  restore();
  assert.equal(calls, 1);
  assert.match(out, /12345/);
});

await t("bigquery_list_datasets / bigquery_list_tables: correct read-only endpoints, no body", async () => {
  const bq = createBigQueryTools({ accessToken: fakeAccessToken, cfgGet: (k, d) => d });
  const seen = [];
  stub(async (url, opts) => { seen.push({ url: String(url), method: (opts && opts.method) || "GET", body: opts && opts.body }); return jsonRes(200, { datasets: [{ datasetReference: { datasetId: "d1" } }], tables: [{ tableReference: { tableId: "t1" }, type: "TABLE" }] }); });
  await bq.TOOLS.find((x) => x.name === "bigquery_list_datasets").run({}, { projectId: "p1" });
  await bq.TOOLS.find((x) => x.name === "bigquery_list_tables").run({}, { projectId: "p1", datasetId: "d1" });
  restore();
  assert.equal(seen.length, 2);
  assert.match(seen[0].url, /\/projects\/p1\/datasets$/);
  assert.equal(seen[0].body, undefined, "list calls must send no body");
  assert.match(seen[1].url, /\/projects\/p1\/datasets\/d1\/tables$/);
});

await t("bigquery tools: missing projectId -> refused, no call made", async () => {
  const bq = createBigQueryTools({ accessToken: fakeAccessToken, cfgGet: (k, d) => d });
  let called = false;
  stub(async () => { called = true; return jsonRes(200, {}); });
  const out = await bq.TOOLS.find((x) => x.name === "bigquery_query").run({}, { query: "SELECT 1" });
  restore();
  assert.equal(called, false);
  assert.match(out, /Give a projectId/);
});

// ================================================================================================
// PART 3: PEOPLE (Contacts) -- PII dump-prevention proof.
// ================================================================================================
await t("people_search_contacts: empty/short query refused BEFORE any network call (no bulk dump)", async () => {
  const ppl = createPeopleTools({ accessToken: fakeAccessToken });
  let called = false;
  stub(async () => { called = true; return jsonRes(200, {}); });
  const out1 = await ppl.TOOLS[0].run({}, { query: "" });
  const out2 = await ppl.TOOLS[0].run({}, { query: "a" });
  restore();
  assert.equal(called, false);
  assert.match(out1, /real search term/);
  assert.match(out2, /real search term/);
});

await t("people_search_contacts: warmup call fires, then the real search, capped page size honored", async () => {
  const ppl = createPeopleTools({ accessToken: fakeAccessToken });
  const seen = [];
  stub(async (url) => {
    seen.push(String(url));
    if (/pageSize=1(&|$)/.test(String(url))) return jsonRes(200, {}); // warmup (must not match pageSize=10)
    return jsonRes(200, { results: [{ person: { names: [{ displayName: "Fred Wolfe" }], emailAddresses: [{ value: "fred@example.com" }], phoneNumbers: [{ value: "+1 555 0100" }] } }] });
  });
  const out = await ppl.TOOLS[0].run({}, { query: "Fred", max: 25 }); // asks for way more than the cap
  restore();
  assert.equal(seen.length, 2, "a warmup call must precede the real search (lazy-cache quirk)");
  assert.match(seen[0], /pageSize=1/);
  assert.match(seen[1], /pageSize=10/, "the tool's own hard cap (10) must win over a caller asking for 25");
  assert.match(out, /Fred Wolfe/);
  assert.match(out, /fred@example\.com/);
});

await t("people_search_contacts: no results -> honest empty answer, not an error", async () => {
  const ppl = createPeopleTools({ accessToken: fakeAccessToken });
  stub(async (url) => jsonRes(200, {}));
  const out = await ppl.TOOLS[0].run({}, { query: "nobody-matches-this" });
  restore();
  assert.match(out, /No contacts matched/);
});

// ================================================================================================
// PART 4: ADVERSARIAL REVIEW REGRESSIONS (2026-08-03). Every case below is a defect that was
// PROVEN present by running the shipped code, then fixed. Each one fails loudly if the fix is
// ever reverted.
// ================================================================================================

// Helper: run bigquery_query against a stubbed BigQuery and report whether the BILLABLE job fired.
async function billableProbe({ cap = "1000", args, dryBody }) {
  const bq = createBigQueryTools({ accessToken: fakeAccessToken, cfgGet: (k, d) => (k === "BIGQUERY_MAX_BYTES_BILLED" ? cap : d) });
  let realJob = null;
  stub(async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (body.dryRun === true) return jsonRes(200, dryBody);
    realJob = body;
    return jsonRes(200, { jobComplete: true, totalBytesProcessed: "1", rows: [] });
  });
  const out = await bq.TOOLS.find((x) => x.name === "bigquery_query").run({}, args);
  restore();
  return { out, realJob };
}

await t("REGRESSION: an unreadable dry-run estimate FAILS CLOSED (was: billable job ran anyway)", async () => {
  // Number(d.totalBytesProcessed || 0) turned every one of these into 0, 0 never exceeds the cap,
  // and the refusal never fired. Proven by running the pre-fix code: the job fired in all five.
  for (const dry of [{}, { totalBytesProcessed: null }, { totalBytesProcessed: "" },
                     { totalBytesProcessed: "not-a-number" }, { totalBytesProcessed: "-1" },
                     { jobComplete: false }]) {
    const r = await billableProbe({ args: { projectId: "p", query: "SELECT * FROM huge" }, dryBody: dry });
    assert.equal(r.realJob, null, "no billable job may run without a trustworthy estimate: " + JSON.stringify(dry));
    assert.match(r.out, /REFUSED/, "the caller must be told why: " + JSON.stringify(dry));
    assert.match(r.out, /nothing was billed/i);
  }
});

await t("REGRESSION: a valid estimate of exactly 0 bytes still RUNS (fail-closed must not block metadata reads)", async () => {
  const r = await billableProbe({ args: { projectId: "p", query: "SELECT 1" }, dryBody: { totalBytesProcessed: "0" } });
  assert.ok(r.realJob, "a genuine zero-byte estimate is a real answer and must be allowed through");
  assert.equal(r.realJob.maximumBytesBilled, "1000");
});

await t("REGRESSION: write statements the old keyword list missed are now refused", async () => {
  const bq = createBigQueryTools({ accessToken: fakeAccessToken, cfgGet: (k, d) => d });
  const mustRefuse = [
    "EXPORT DATA OPTIONS(uri='gs://bucket/*.csv', format='CSV') AS SELECT * FROM ds.secrets",
    "LOAD DATA INTO ds.t FROM FILES(uris=['gs://x/*.csv'])",
    "EXECUTE IMMEDIATE CONCAT('DEL','ETE FROM ds.t WHERE 1=1')",
    "BEGIN EXECUTE IMMEDIATE 'TRUNCA'||'TE TABLE ds.t'; END",
    "DECLARE x INT64 DEFAULT 1",
    "CREATE OR REPLACE TABLE ds.t AS SELECT 1",
    "SELECT 1; DROP TABLE ds.t",                                   // write smuggled after a semicolon
    "SELECT 1 /* harmless */ ; DELETE FROM ds.t",                  // and behind a comment
    "INSERT INTO t VALUES(1)",
    "DELETE FROM t WHERE 1=1",
  ];
  for (const q of mustRefuse) {
    let touched = false;
    stub(async () => { touched = true; return jsonRes(200, { totalBytesProcessed: "1" }); });
    const out = await bq.TOOLS.find((x) => x.name === "bigquery_query").run({}, { projectId: "p", query: q });
    restore();
    assert.equal(touched, false, "must not reach the network at all: " + q);
    assert.match(out, /Refused/, "must be refused: " + q);
  }
});

await t("REGRESSION: a harmless SELECT whose STRING LITERAL contains a write verb is allowed", async () => {
  // The old raw-text regex refused this real, read-only query because of the word inside the quotes.
  const bq = createBigQueryTools({ accessToken: fakeAccessToken, cfgGet: (k, d) => d });
  for (const q of ["SELECT * FROM ds.logs WHERE body LIKE '%call%'",
                   "SELECT status FROM ds.orders WHERE status = 'CREATED'",
                   "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
                   "SELECT 'we had to DROP the old plan' AS note"]) {
    let reached = false;
    stub(async () => { reached = true; return jsonRes(200, { totalBytesProcessed: "1" }); });
    const out = await bq.TOOLS.find((x) => x.name === "bigquery_estimate_query").run({}, { projectId: "p", query: q });
    restore();
    assert.equal(reached, true, "a read-only query must be allowed to dry-run: " + q);
    assert.doesNotMatch(out, /Refused/, q);
  }
});

await t("REGRESSION: the model cannot slip past the cap with undeclared job-config arguments", async () => {
  // Tool schemas are advisory; a model can send any JSON. The body must be built from a fixed
  // literal, never spread from the caller's args.
  const r = await billableProbe({
    args: { projectId: "p", query: "SELECT * FROM huge", dryRun: false, maximumBytesBilled: "999999999999",
            configuration: { query: { maximumBytesBilled: "9e18" } }, useLegacySql: true, location: "US" },
    dryBody: { totalBytesProcessed: "5000000000" },
  });
  assert.equal(r.realJob, null, "an oversized query must still be refused however the args are dressed up");
  assert.match(r.out, /REFUSED/);
});

await t("REGRESSION: degenerate BIGQUERY_MAX_BYTES_BILLED values fall back to the 100MB default", async () => {
  for (const v of ["", "0", "-1", "abc", "Infinity", "1e999", "   ", null, undefined]) {
    const bq = createBigQueryTools({ accessToken: fakeAccessToken, cfgGet: (k, d) => (k === "BIGQUERY_MAX_BYTES_BILLED" ? (v === undefined ? d : v) : d) });
    let realJob = null;
    stub(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.dryRun === true) return jsonRes(200, { totalBytesProcessed: "1" });
      realJob = body; return jsonRes(200, { jobComplete: true, totalBytesProcessed: "1", rows: [] });
    });
    await bq.TOOLS.find((x) => x.name === "bigquery_query").run({}, { projectId: "p", query: "SELECT 1" });
    restore();
    assert.equal(realJob && realJob.maximumBytesBilled, "104857600", "cap env " + JSON.stringify(v) + " must not disable the cap");
  }
});

await t("REGRESSION: an unfinished job says so instead of reporting an empty table", async () => {
  const bq = createBigQueryTools({ accessToken: fakeAccessToken, cfgGet: (k, d) => d });
  stub(async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.dryRun === true) return jsonRes(200, { totalBytesProcessed: "1000" });
    return jsonRes(200, { jobComplete: false });    // still running past the request timeout
  });
  const out = await bq.TOOLS.find((x) => x.name === "bigquery_query").run({}, { projectId: "p", query: "SELECT 1" });
  restore();
  assert.match(out, /did not finish/i, "a still-running job must never read as zero rows");
});

await t("REGRESSION: a People result row with no `person` object does not crash the tool", async () => {
  const ppl = createPeopleTools({ accessToken: fakeAccessToken });
  stub(async (url) => (/pageSize=1(&|$)/.test(String(url)) ? jsonRes(200, {})
    : jsonRes(200, { results: [{}, { person: {} }, { person: { names: [{ displayName: "Real Person" }] } }] })));
  const out = await ppl.TOOLS[0].run({}, { query: "ab" });
  restore();
  assert.match(out, /Real Person/);
  assert.match(out, /\(no name\)/, "malformed rows degrade, they do not throw");
});

await t("REGRESSION: People query string cannot smuggle extra URL parameters", async () => {
  const ppl = createPeopleTools({ accessToken: fakeAccessToken });
  const seen = [];
  stub(async (url) => { seen.push(String(url)); return jsonRes(200, { results: [] }); });
  await ppl.TOOLS[0].run({}, { query: "ab&pageSize=1000&sources=READ_SOURCE_TYPE_DOMAIN_CONTACT", max: 1000, pageToken: "x" });
  restore();
  assert.match(seen[1], /pageSize=10$/, "the tool's own page cap must be the last word");
  assert.doesNotMatch(seen[1], /&sources=/, "sources must not be reachable from the query string");
  assert.doesNotMatch(seen[1], /pageToken/, "no pagination verb is exposed");
});

await t("REGRESSION: a Maps API key never appears in an error handed back to the model", async () => {
  const maps = createMapsTools({ cfgGet: (k, d) => (k === "GOOGLE_MAPS_API_KEY" ? "SENTINEL_KEY_VALUE" : d) });
  const geocode = maps.TOOLS.find((x) => x.name === "maps_geocode");
  // transport failure whose message carries the whole URL
  stub(async (u) => { throw new Error("connect ECONNREFUSED " + u); });
  let msg = "";
  try { await geocode.run({}, { address: "x" }); } catch (e) { msg = String(e.message); }
  restore();
  assert.doesNotMatch(msg, /SENTINEL_KEY_VALUE/, "the API key must be redacted out of transport errors");
  assert.match(msg, /redacted/);
  // non-2xx from Google
  stub(async () => ({ ok: false, status: 403, json: async () => ({ error_message: "denied" }) }));
  let msg2 = "";
  try { await geocode.run({}, { address: "x" }); } catch (e) { msg2 = String(e.message); }
  restore();
  assert.doesNotMatch(msg2, /SENTINEL_KEY_VALUE/);
});

console.log(`\ngoogle-tools: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exitCode = failed ? 1 : 0;
