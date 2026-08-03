/*
 * Dominion AI - Google BigQuery tools (Lane H, Wave "Google callable tools", 2026-08-03).
 *
 * BLAST RADIUS: HIGH per Fred's wargame -- BigQuery bills per byte SCANNED, not per row returned,
 * so a careless "select * from a 4TB table" from an assistant that can query is a real invoice. The
 * wargame already run for this lane names two failure modes and their defenses; both are built here
 * as HARD gates, not advisory checks:
 *
 *   H1: an assistant-issued query scans a huge table and bills accordingly.
 *       DEFENSE: maximumBytesBilled is attached to EVERY real job, always, capped at a server
 *       ceiling the caller cannot raise. If the pre-flight estimate already exceeds the cap, the
 *       query is REFUSED before any billable job runs -- never truncated, never run "just this once."
 *   H2: the dry-run estimate gets skipped, so the cap is the only thing standing between a bad
 *       query and the bill, with no warning first.
 *       DEFENSE: every real query dry-runs FIRST, unconditionally, inside bigquery_query itself
 *       (not left to the caller's discipline), and the estimate is always returned to the caller,
 *       whether the query proceeds or is refused.
 *
 * READ-ONLY enforcement in this file:
 *   - the query text is normalized (comments and string literals stripped) and must BEGIN with
 *     SELECT or WITH, so a statement shaped like anything else is refused outright;
 *   - the normalized text is then scanned for write/DDL/scripting keywords, which catches a write
 *     smuggled after a semicolon in a multi-statement script;
 *   - no insert/update/delete/merge/create/drop/alter/truncate/tables.insert/tables.delete path is
 *     implemented anywhere in this file. jobs.query is the only job-submission call this module
 *     makes, and it is only ever used for SELECT-shaped reads.
 *
 * SCOPE DEFECT, OPEN, OWNED BY google.mjs (adversarial review, 2026-08-03, verified live):
 *   google.mjs requests https://www.googleapis.com/auth/bigquery.readonly. That scope is NOT
 *   accepted by any bigquery/v2 method. Fetched live from
 *   https://bigquery.googleapis.com/discovery/v1/apis/bigquery/v2/rest on 2026-08-03: jobs.query,
 *   datasets.list and tables.list each declare exactly
 *     [auth/bigquery, auth/cloud-platform, auth/cloud-platform.read-only]
 *   and bigquery.readonly appears nowhere in that document's auth.oauth2.scopes block. Google's
 *   authorization server does recognize the string (an authorize request carrying it returns
 *   restricted_client "Unregistered scope(s)", the same answer a real-but-unregistered scope gives,
 *   rather than invalid_scope), so consent will not break. Every call in this file will still come
 *   back 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT until google.mjs's SCOPES swaps that entry for
 *   https://www.googleapis.com/auth/cloud-platform.read-only, which IS accepted by all three
 *   methods and keeps the IAM-level read-only guarantee. Until that lands, treat the IAM layer as
 *   ABSENT and this file's own SQL gate as the only enforcement.
 *
 * Every call cites the doc page read for it. Live-verified against Google: NONE. See
 * google-tools_test.mjs and the build report for why (no BigQuery-scoped OAuth token exists on this
 * build machine, and completing the consent flow needs an interactive browser this session does not
 * have). The refusal logic itself IS exercised for real, against a stubbed network boundary that
 * returns a realistic dry-run response -- see the test file. That is a stub, labeled as such
 * everywhere it is claimed.
 */

const BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";

// [verified] https://bigquery.googleapis.com/discovery/v1/apis/bigquery/v2/rest (jobs.query method,
// read 2026-08-03): POST projects/{projectId}/queries, request fields query/dryRun/useLegacySql/
// maximumBytesBilled/timeoutMs/location; response fields jobComplete/totalBytesProcessed/schema/
// rows/totalRows/cacheHit/errors. maximumBytesBilled is documented as a STRING (int64-as-string).
/*
 * ADVERSARIAL REVIEW FIX (2026-08-03). The original gate was a bare keyword regex over the RAW
 * query text. Two holes were proven by running it:
 *   - it let write statements through whose verbs it never listed. EXPORT DATA (writes a whole
 *     table out to GCS), LOAD DATA INTO (writes a table), EXECUTE IMMEDIATE (runs SQL assembled at
 *     runtime, so CONCAT('DEL','ETE FROM t') never shows a listed keyword at all) all passed;
 *   - it refused harmless reads whose verbs appeared inside a string literal, e.g.
 *     SELECT * FROM logs WHERE body LIKE '%call%'.
 * Both come from scanning text that has not been normalized. The gate below strips comments and
 * string literals first, then demands the statement START as a read, then scans what is left.
 */
const WRITE_PATTERN = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|REPLACE|DROP|UNDROP|ALTER|RENAME|TRUNCATE|GRANT|REVOKE|CALL|EXPORT|LOAD|EXECUTE|BEGIN|DECLARE|ASSERT|SET)\b/i;
const READ_START = /^[\s(]*(?:WITH|SELECT)\b/i;

// Comments and quoted text carry no SQL verbs, so they are replaced with inert placeholders before
// any keyword scan. Backtick-quoted identifiers become a plain identifier for the same reason.
function normalizeSql(sql) {
  return String(sql == null ? "" : sql)
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ")
    .replace(/'''[\s\S]*?(?:'''|$)/g, " '' ")
    .replace(/"""[\s\S]*?(?:"""|$)/g, " '' ")
    .replace(/r?'(?:\\.|[^'\\\n])*'/gi, " '' ")
    .replace(/r?"(?:\\.|[^"\\\n])*"/gi, " '' ")
    .replace(/`[^`]*`/g, " ident ");
}

/*
 * Returns null when the query is allowed, or the refusal text when it is not. Callers must treat
 * a non-null result as final: no dry run, no job, no network call of any kind.
 */
function refuseIfNotRead(query) {
  const norm = normalizeSql(query);
  if (!norm.trim()) return "Refused: empty query.";
  if (!READ_START.test(norm)) {
    return "Refused: this tool is read-only and only runs SELECT-shaped queries. This statement does not begin with SELECT or WITH.";
  }
  const bad = WRITE_PATTERN.exec(norm);
  if (bad) return `Refused: this tool is read-only. The query contains a write, DDL, or scripting keyword ("${bad[0].toUpperCase()}"). Writes are never run through this tool.`;
  return null;
}

/*
 * The dry-run byte estimate must be a real, non-negative number or the caller gets nothing. The
 * original code did Number(d.totalBytesProcessed || 0), so an absent, null, or non-numeric field
 * became 0, 0 never exceeds the cap, and the billable job ran anyway with the refusal never firing.
 * Returns null when no trustworthy estimate exists, and the caller refuses on null (fail CLOSED).
 */
function estimateBytes(d) {
  const raw = d && (d.totalBytesProcessed != null ? d.totalBytesProcessed
    : (d.statistics && d.statistics.query && d.statistics.query.totalBytesProcessed));
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const humanBytes = (n) => {
  const x = Number(n) || 0;
  if (x < 1024) return x + " B";
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = x, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(1) + " " + units[i];
};

export function createBigQueryTools({ accessToken, cfgGet }) {
  // Ceiling the caller cannot raise. 100MB default -- generous for a metadata/lookup query, cheap
  // even at full price, and small enough that a runaway "select *" on a real table trips the refusal
  // instead of quietly billing. Fred can raise BIGQUERY_MAX_BYTES_BILLED on the box if a real
  // workload needs more; there is no in-chat way to override it upward.
  const ceilingBytes = () => { const n = Number(cfgGet("BIGQUERY_MAX_BYTES_BILLED", "104857600")); return Number.isFinite(n) && n > 0 ? n : 104857600; };
  const defaultProject = () => cfgGet("BIGQUERY_DEFAULT_PROJECT_ID", "");

  async function bq(T, method, path, body) {
    const tok = await accessToken(T);
    const r = await fetch(BQ_BASE + path, {
      method,
      headers: { authorization: "Bearer " + tok, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && (d.error.message || d.error.status)) || ("HTTP " + r.status));
    return d;
  }

  function projectOf(a) {
    const p = String(a.projectId || defaultProject() || "").trim();
    return p;
  }

  // The one and only job-submission call in this module. dryRun:true never bills or scans; this is
  // also called internally by bigquery_query before it will run anything for real (H2).
  async function dryRun(T, projectId, query) {
    const d = await bq(T, "POST", `/projects/${encodeURIComponent(projectId)}/queries`,
      { query, dryRun: true, useLegacySql: false });
    return { bytes: estimateBytes(d), schema: d.schema || null };
  }
  const NO_ESTIMATE =
    "REFUSED: the dry run came back without a usable byte estimate, so there is no way to know what " +
    "this query would cost. Nothing was run and nothing was billed. Try bigquery_estimate_query, or " +
    "narrow the query and try again.";

  const TOOLS = [
    { name: "bigquery_list_datasets",
      // [verified] https://docs.cloud.google.com/bigquery/docs/listing-datasets (read 2026-08-03):
      // GET /projects/{projectId}/datasets, empty body, scope bigquery.readonly is sufficient (list is a read).
      description: "List BigQuery datasets in a Google Cloud project. Read-only.",
      parameters: { type: "object", properties: { projectId: { type: "string", description: "GCP project id. Required unless BIGQUERY_DEFAULT_PROJECT_ID is set on the server." } }, required: [] },
      run: async (T, a) => {
        const projectId = projectOf(a);
        if (!projectId) return "Give a projectId (no default project is configured on this server).";
        const d = await bq(T, "GET", `/projects/${encodeURIComponent(projectId)}/datasets`);
        const rows = d.datasets || [];
        return rows.length ? rows.map((x) => `- ${x.datasetReference.datasetId}`).join("\n") : "No datasets in that project (or none visible to this account).";
      } },

    { name: "bigquery_list_tables",
      // [verified] https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/tables/list (read 2026-08-03):
      // GET /projects/{projectId}/datasets/{datasetId}/tables, empty body.
      description: "List BigQuery tables inside one dataset. Read-only.",
      parameters: { type: "object", properties: { projectId: { type: "string" }, datasetId: { type: "string" } }, required: ["datasetId"] },
      run: async (T, a) => {
        const projectId = projectOf(a);
        if (!projectId) return "Give a projectId (no default project is configured on this server).";
        const d = await bq(T, "GET", `/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(a.datasetId)}/tables`);
        const rows = d.tables || [];
        return rows.length ? rows.map((x) => `- ${x.tableReference.tableId} (${x.type || "TABLE"})`).join("\n") : "No tables in that dataset (or none visible to this account).";
      } },

    { name: "bigquery_estimate_query",
      description: "Dry-run BigQuery SQL without executing it. Reports bytes scanned and whether this server's byte cap would refuse it. Never bills, never scans.",
      parameters: { type: "object", properties: { projectId: { type: "string" }, query: { type: "string" } }, required: ["query"] },
      run: async (T, a) => {
        const projectId = projectOf(a);
        if (!projectId) return "Give a projectId (no default project is configured on this server).";
        const refusal = refuseIfNotRead(a.query);
        if (refusal) return refusal;
        const est = await dryRun(T, projectId, String(a.query));
        const cap = ceilingBytes();
        if (est.bytes == null) return "The dry run came back without a usable byte estimate, so the cost of this query is unknown. bigquery_query will refuse it for that reason alone.";
        return `Estimate: ${humanBytes(est.bytes)} (${est.bytes} bytes). Cap: ${humanBytes(cap)} (${cap} bytes). ` +
          (est.bytes > cap ? "This query WOULD BE REFUSED by bigquery_query for exceeding the cap." : "This query would be allowed to run.");
      } },

    { name: "bigquery_query",
      description: "Run read-only BigQuery SQL, capped by bytes billed. Dry-runs first; refuses without running when estimated scan exceeds this server's byte cap. SELECT or WITH statements only.",
      parameters: { type: "object", properties: {
        projectId: { type: "string" }, query: { type: "string" },
        maxBytesBilled: { type: "number", description: "Optional tighter cap for this call, in bytes. Cannot exceed the server ceiling." },
      }, required: ["query"] },
      run: async (T, a) => {
        const projectId = projectOf(a);
        if (!projectId) return "Give a projectId (no default project is configured on this server).";
        const query = String(a.query || "");
        const refusal = refuseIfNotRead(query);
        if (refusal) return refusal;

        // H2: dry-run first, unconditionally, and report the estimate whether or not the query proceeds.
        const est = await dryRun(T, projectId, query);
        const ceiling = ceilingBytes();
        const cap = Math.min(ceiling, Number(a.maxBytesBilled) > 0 ? Number(a.maxBytesBilled) : ceiling);

        // H1/H2 FAIL CLOSED. An unreadable estimate is not a green light. maximumBytesBilled would
        // still have bounded the damage at Google, but the promise this lane makes is that a query
        // whose cost is not known in advance does not run, so an absent estimate refuses.
        if (est.bytes == null) return NO_ESTIMATE;

        // H1: hard refusal. Never truncated, never run "just this once."
        if (est.bytes > cap) {
          return `REFUSED: estimated scan is ${humanBytes(est.bytes)} (${est.bytes} bytes), which exceeds the byte cap of ${humanBytes(cap)} (${cap} bytes). ` +
            `The query was NOT run and nothing was billed. Narrow the query (add a WHERE/date filter or select fewer columns) or ask to raise BIGQUERY_MAX_BYTES_BILLED on the server, then try again.`;
        }

        // The hard cap travels with the REAL job too: even if the estimate is stale by the time this
        // runs, BigQuery itself aborts the job before billing past maximumBytesBilled.
        let d;
        try {
          d = await bq(T, "POST", `/projects/${encodeURIComponent(projectId)}/queries`,
            { query, dryRun: false, useLegacySql: false, maximumBytesBilled: String(cap), maxResults: 50 });
        } catch (e) {
          return `Estimate was ${humanBytes(est.bytes)} (within the ${humanBytes(cap)} cap), but the job itself failed: ` + String(e.message || e).slice(0, 300);
        }
        const billedRaw = estimateBytes(d);
        const billed = billedRaw == null ? est.bytes : billedRaw;
        const fields = (d.schema && d.schema.fields) || [];
        const rows = (d.rows || []).map((r) => (r.f || []).map((c) => (c && c.v != null ? c.v : "")).join(" | "));
        const header = fields.length ? fields.map((f) => f.name).join(" | ") : "";
        const body = rows.length ? [header, ...rows].join("\n") : "(no rows)";
        // jobComplete:false means the job is STILL RUNNING past the request timeout and will bill
        // when it lands. Saying "0 rows" there would read as an empty table.
        const pending = d.jobComplete === false
          ? "\nNOTE: the job did not finish inside the request timeout. It is still running server-side and will bill up to the cap above. Rows shown here are incomplete."
          : "";
        return `Estimate ${humanBytes(est.bytes)}, actual ${humanBytes(billed)} of ${humanBytes(cap)} cap. ${d.totalRows || rows.length} row(s), showing up to 50:\n` + body.slice(0, 12000) + pending;
      } },
  ];

  return { TOOLS };
}
