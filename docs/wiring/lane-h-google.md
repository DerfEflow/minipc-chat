# Lane H wiring: Maps, BigQuery, People (Contacts) as callable Google tools

Written 2026-08-03. Branch `iter/assistant-build-core`. Owned files: `google-maps.mjs` (new),
`google-bigquery.mjs` (new), `google-people.mjs` (new), `google.mjs` (edited), `google-tools_test.mjs`
(new). Lane H does not own and did not touch `tools.mjs`, `toolschema.mjs`, `connectors.mjs`,
`server.mjs`, `public/app.js`, `public/index.html`.

---

## The one thing to read before anything else: tools.mjs is NOT the anchor for this

The brief for this lane assumed tool registration lives in `tools.mjs` and `toolschema.mjs`. It does
not, for Google specifically, and building against that assumption would have shipped three files
nothing ever calls -- the exact failure this repo has already paid for once. What is actually true,
read from the working tree today:

- `tools.mjs` exports a single static `TOOLS` array (built-in tools only: forge_*, sandbox_*,
  deck_*, memory, artifacts, web_search, github_*, format_as_*...) and `runTool()`, which dispatches
  by a hard-coded `switch` over that same static list. Nothing in it is per-provider or
  per-connector; a new entry there means a new `case` in `runTool`, which is off limits to this lane.
- `toolschema.mjs` does exactly one job: repairs malformed JSON Schema (`required` naming a property
  that was never defined in `properties`) on ANY tool list before it reaches a model. It is not a
  registry. It runs automatically over every tool from every source, connector tools included, and
  needed no changes for this lane's schemas (all four new modules were checked against
  `findUndefinedRequired` -- see Tests below -- and came back clean).
- Google's actual wiring is `connectors.mjs` (REGISTRY row `id: "google"`, `provider: true`, line 78
  as of this writing) plus `server.mjs` line 1625-1626 as of this writing. **Caveat, live and
  confirmed during this same build session: `connectors.mjs` is Lane E's file and was edited
  concurrently in this shared worktree while this doc was being written (grew from 663 to 688 lines
  mid-session; `configured()` moved from line 332 to 357, `usable()` from 342 to 367, `toolDefsFor()`
  from 537 to 562). Every anchor below was re-verified by grep immediately before this doc was saved,
  but treat every line number here as "as of 2026-08-03, this session" and re-grep before trusting
  it, not as a promise the file will still look like this tomorrow.**
  ```js
  const googleProvider = createGoogleProvider({ dir: DATA_DIR, cfgGet, baseUrl: () => APP_BASE_URL, enc: cxCrypto.enc, dec: cxCrypto.dec });
  const connectors = createConnectors({ dir: DATA_DIR, cfgGet, providers: { google: googleProvider } });
  ```
  `createGoogleProvider` returns `{ toolDefs(), call(T, name, args) }`. `connectors.mjs` calls
  `toolDefs()` for every tool this provider offers and mangles each name to `cx_google__<name>` (see
  `connectors.mjs` `toolDefsFor`, line 562, and `mangle`, line 125). **Every tool `google.mjs`'s
  `TOOLS` array contains is already reachable the moment it is in that array.** Nothing downstream
  needs to change per tool.

Both files were owned by other lanes this wave anyway (`connectors.mjs` is Lane E's per the build
brief), so even the "ideal" design below could not have been wired directly by this lane. What
follows is what was actually built, then what an integrator with access to those files should do if
Fred wants the cleaner shape later.

---

## What was actually built: fold onto the existing "google" connector

`google.mjs` already assembles a `TOOLS` array (Gmail, Calendar, Drive, Sheets, Docs -- 10 tools
before this lane) and exposes it through the provider interface above. This lane added three sibling
modules and merged their tool lists into that same array:

**`google.mjs`, right after the existing `TOOLS` array literal closes** (today, immediately before
`const byName = new Map(TOOLS.map(...))`):

```js
const mapsTools = createMapsTools({ cfgGet }).TOOLS;
const bigqueryTools = createBigQueryTools({ accessToken, cfgGet }).TOOLS;
const peopleTools = createPeopleTools({ accessToken }).TOOLS;
TOOLS.push(...mapsTools, ...bigqueryTools, ...peopleTools);
const byName = new Map(TOOLS.map((t) => [t.name, t]));
```

Imports added at the top of `google.mjs`:

```js
import { createMapsTools } from "./google-maps.mjs";
import { createBigQueryTools } from "./google-bigquery.mjs";
import { createPeopleTools } from "./google-people.mjs";
```

`accessToken` is `google.mjs`'s own OAuth accessor (defined earlier in the same file, unchanged);
`cfgGet` is the same config getter `createGoogleProvider({ dir, cfgGet, ... })` already receives from
`server.mjs`. No new plumbing anywhere. **This is a complete, working wire already, in this diff.**
Nine new tool names are live: `maps_geocode`, `maps_place_search`, `maps_distance`,
`maps_directions`, `bigquery_list_datasets`, `bigquery_list_tables`, `bigquery_estimate_query`,
`bigquery_query`, `people_search_contacts`. Verified by importing the real module and calling
`toolDefs()` -- see Tests.

### The tradeoff this creates, stated plainly

`connectors.mjs`'s `usable()` (line 367) gates the WHOLE "google" provider behind
`p.ready() && p.connected(T)` -- `connected(T)` means the account completed Google OAuth. Maps needs
no OAuth at all (a plain API key), but because its tools now live in the same `TOOLS` array as
Gmail/Calendar/Drive, they are only OFFERED to the model once that account has connected Google OAuth
for Workspace, even though Maps itself would work without it. For Fred (the owner, who already
connects Google for Gmail/Calendar) this is invisible in practice. For a guest who wants only Maps
and never touches Gmail, it is a real, avoidable gate. See "For the integrator" below for the fix.

### The drawer: already built, and it already covers this

The mission line asked for these tools to be "available when a task needs them and absent from every
other call." That mechanism exists today and needed no new code from this lane:

- `server.mjs` (read only, not edited) builds `cloudTools` from the static `TOOL_DEFS` plus, per
  account, `await connectors.toolDefsFor(T)` (line 8140) -- which is where the nine `cx_google__*`
  tools enter the set, exactly like every other connector tool.
- `fullCloudTools = withToolbox(cloudTools)` (`toolbox.mjs`, imported line 39) keeps the complete set
  off the wire and adds one small always-present tool, `toolbox_open`.
- Unless Wildfire (full preload) is on, `server.mjs` (line 8160-8177) scores every tool in
  `fullCloudTools` -- connector tools included -- against the turn's own text via `openToolbox`
  (`toolbox.mjs` line 35), and only the top matches ride in the initial prompt. The model can also
  call `toolbox_open` itself with a query like "BigQuery" or "geocode an address" to pull more.
**Say plainly which of the two options the brief offered this is:** the existing mechanism
(`tools.mjs`'s static list plus the `openToolbox` scorer) already does per-turn gating for every tool
in the app, built-in and connector alike. This lane did not need to, and did not, build a second one.

### Drawer: MEASURED, and the original claim here was too strong

An earlier version of this section claimed a turn unrelated to maps, queries, or contacts "scores
zero against all nine new tool descriptions." That is false, and it was corrected after the
adversarial review measured it by running `openToolbox` directly.

`openToolbox` (`toolbox.mjs` line 38-48) tokenizes the turn text into 2-or-more-character runs and
scores a tool by plain SUBSTRING containment against `name + " " + description`. It applies no
stopword list and no word-boundary check, so `the` matches inside "whether", `sea` matches inside
"search", and `me` matches inside "name". Nearly every tool in the app scores above zero on nearly
every turn. The thing that keeps a tool OFF the prompt is the capacity cap (7 on an ordinary turn,
10 on a research turn) plus the index tiebreak in `openToolbox`'s sort, and connector tools are
appended AFTER the box tools in `server.mjs` (line 8148, `cloudTools.concat(cxDefs)`), so they hold
the highest indices and lose every tie.

Measured against the REAL catalog (`tools.mjs` `toolDefs()`, 60 box tools, plus these nine):

| turn | google tools that ride |
|---|---|
| "hey what did you think of the last chapter I sent you" | none |
| "write me a poem about the sea" | none |
| "what is on my calendar tomorrow" | none |
| "summarize this document for me" | none |
| "fix the login bug and push it" | none |
| "how much did we spend on ads last month" | none |
| "geocode 1600 amphitheatre parkway" | `maps_geocode` |
| "what is the driving distance from boise to meridian" | `maps_distance` |
| "run a bigquery query on our analytics dataset" | all four bigquery tools |
| "find sarah's phone number in my google contacts" | `people_search_contacts` first |
| "search for coffee shops near downtown boise" | `maps_place_search` |
| "give me directions to the jobsite" | `maps_directions` |

So the behaviour Fred asked for is real: off-topic turns carry none of the nine, on-topic turns carry
the right ones. The cost avoided is roughly 1,050 tokens (4,206 bytes of JSON schema, ~117 tokens per
tool) that would otherwise ride every single turn.

The mechanism is fragile, though, and the reason matters. It works because 60 box tools with longer
descriptions outrank these nine on noise words and win the index tiebreak. Swap the box catalog for a
smaller one and the nine start leaking onto unrelated turns: with a 60-tool filler bench of SHORT
descriptions, `people_search_contacts` scored 8 on "hey what did you think of the last chapter I sent
you" and rode the prompt. The nine descriptions in this lane were shortened during review to cut that
noise surface, which measurably helped, and it is still a mitigation rather than a fix.

**The real fix belongs in `toolbox.mjs`, which this lane does not own:** score on word boundaries
(`new RegExp("\\\\b" + escaped + "\\\\b")`) instead of `haystack.includes(w)`, and drop a small
stopword list before scoring. Two lines. Until then, treat the drawer as reliable-in-practice rather
than guaranteed.

---

## BLOCKER for BigQuery: the OAuth scope google.mjs asks for is not accepted by the BigQuery API

Found by adversarial review, 2026-08-03, verified against Google live. This is the headline defect of
the lane and it is in `google.mjs`, which neither the builder nor the reviewer owns.

`google.mjs`'s `SCOPES` requests `https://www.googleapis.com/auth/bigquery.readonly`. That scope is
not accepted by any `bigquery/v2` method. Fetched live from
`https://bigquery.googleapis.com/discovery/v1/apis/bigquery/v2/rest`:

| method used by this lane | scopes it accepts |
|---|---|
| `jobs.query` | `auth/bigquery`, `auth/cloud-platform`, `auth/cloud-platform.read-only` |
| `datasets.list` | same three |
| `tables.list` | same three |

`bigquery.readonly` appears nowhere in that document's `auth.oauth2.scopes` block, and no
BigQuery-family API in Google's discovery directory (`bigquery`, `bigqueryconnection`,
`bigquerydatapolicy`, `bigquerydatatransfer`, `bigqueryreservation`) declares it either.

**Consent will not break.** Probed against `accounts.google.com/o/oauth2/v2/auth` directly: a request
carrying `bigquery.readonly` comes back `restricted_client` / "Unregistered scope(s) in the request",
which is the same answer the definitely-real `contacts.readonly` gives for a client not registered for
it. A genuinely unknown scope answers `invalid_scope` instead. So Google's authorization server knows
the string, and Gmail / Calendar / Drive consent is not at risk from it.

**Every BigQuery call will still fail.** A token minted with only `bigquery.readonly` gets
`403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` from all four BigQuery tools. The lane's BigQuery surface is
dead on arrival, and the header comment in `google-bigquery.mjs` claiming "IAM enforces the read-only
boundary independently of this file's own refusal" is false for as long as that scope stands.

**Fix, one line in `google.mjs`'s `SCOPES`:**

```js
// replace
"https://www.googleapis.com/auth/bigquery.readonly",
// with
"https://www.googleapis.com/auth/cloud-platform.read-only",
```

`cloud-platform.read-only` is accepted by all three methods and is genuinely read-only, so the
IAM-level write ban the header claims becomes true rather than aspirational. The cost is breadth: it
grants read across Google Cloud, not BigQuery alone. `auth/bigquery` is the narrower alternative and
it permits writes, which would leave `google-bigquery.mjs`'s own SQL gate as the only thing stopping a
DML statement. Read-only is the better trade here.

**Also required of Fred before any of this works, and true for `contacts.readonly` too:** both scopes
must be added to the OAuth consent screen's scope list in Google Cloud console, and the BigQuery API
and People API must be enabled on the project. A production consent screen answers `restricted_client`
for a scope it has not declared, and that error aborts the WHOLE authorization request, so an
undeclared scope breaks the Connect Google button for every user, Gmail and Calendar included.
Existing tokens keep working untouched; it is the connect and reconnect path that would break.

---

## Tests

`node google-tools_test.mjs` -- 26 assertions, 0 failed, 0 skipped on a machine with
`GOOGLE_MAPS_API_KEY` / `GOOGLE_MAPS_PLACES_SEARCH_API_KEY` in the wallet (16 from the build, 10
regression cases added by the adversarial review, each one pinning a defect that was proven present
by running the shipped code).
Drives the real `createMapsTools` / `createBigQueryTools` / `createPeopleTools` surfaces exactly as
`google.mjs` calls them; only `globalThis.fetch` and, for BigQuery/People, the injected
`accessToken()` are stubbed where no live Google credential exists on this build machine (see the
file's own header comment for exactly which paths are live and which are not, and why).

`node google_connect_test.mjs` (pre-existing, not owned by this lane, re-run to confirm the SCOPES
edit did not break the OAuth round trip) -- 7/7 still pass.

Schema sanity: every new tool's `parameters` was run through `findUndefinedRequired` from
`toolschema.mjs` (read-only use, no edits) during development; all four modules came back clean.

---

## For the integrator: the standalone-connector version, if Fred wants Maps decoupled from OAuth

Out of scope for this lane (needs files this lane does not own), written here so it is one lookup
away instead of a rediscovery. Two changes, both additive:

1. **`connectors.mjs` REGISTRY`** (today at line 28, the `google` row is at line 78): add a sibling
   row that is NOT `provider: true` and NOT `auth: "oauth"` -- something like:
   ```js
   { id: "google_maps", name: "Google Maps", group: "Google", guestDefault: true,
     blurb: "Geocoding, place search, distance and directions. No account connection needed.",
     // no OAuth, no MCP transport: this would need a THIRD kind of registry row (server-key-only),
     // which connectors.mjs's usable()/configured() do not currently model at all (today they only
     // know "builtin", "provider+oauth", and "MCP transport with user-supplied fields"). That is
     // real new logic in connectors.mjs, not a copy-paste of the google row.
   },
   ```
   This is the honest scope: it is not a two-line change, because `configured()` (line 357) and
   `usable()` (line 367) have no notion of "always configured, server-key-backed, no OAuth." Someone
   owning `connectors.mjs` would need to add that case.
2. Move `createMapsTools`'s output behind its own small provider object (`ready: () => !!mapsKey,
   connected: () => true, toolDefs, call`) and register it in `server.mjs`'s `providers: { google:
   googleProvider, google_maps: mapsProvider }` (today at line 1626).

Until that lands, Maps rides the existing OAuth gate as described above. This is a known, written-down
limitation, not a silent one.

---

## Files Lane H changed

| file | what |
|---|---|
| `google-maps.mjs` | new. `createMapsTools({ cfgGet })`. 4 tools: geocode (fwd+reverse), place text search, distance matrix, directions. No OAuth; server API keys only. |
| `google-bigquery.mjs` | new. `createBigQueryTools({ accessToken, cfgGet })`. 4 tools: list datasets, list tables, dry-run estimate, capped query. Read-only; see the WARGAME section of the build report for the H1/H2 defenses. |
| `google-people.mjs` | new. `createPeopleTools({ accessToken })`. 1 tool: query-required contact search, hard-capped page size, no list-all-contacts verb exists in this file. |
| `google-tools_test.mjs` | new. 16 tests: live for Maps, stubbed-network logic tests for BigQuery/People (credential gap explained in the file header and the build report). |
| `google.mjs` | edited. Added 3 imports, 2 new OAuth scopes (`bigquery.readonly`, `contacts.readonly`), the 4-line merge shown above, and corrected the stale "test users" comment Fred flagged (2026-08-02: the consent screen is in production, verified live). No existing tool's behavior changed; `google_connect_test.mjs` re-run clean. |

## Adversarial review, 2026-08-03: defects found by running the code, and what happened to them

Every item below was demonstrated against the shipped code before it was changed. All are fixed in
the three module files unless marked otherwise.

1. **BigQuery failed OPEN when the dry run returned no usable estimate.** `dryRun()` did
   `Number(d.totalBytesProcessed || 0)`, so an absent field, `null`, `""`, a non-numeric string, or a
   negative value all became `0`. Zero never exceeds the cap, so the refusal never fired and the
   billable job ran. Proven in five variants. The damage was bounded, because `maximumBytesBilled`
   still rode the real job, so Google would have aborted past the cap. The promise the lane makes was
   still broken. FIXED: `estimateBytes()` parses strictly and returns `null` when the answer is not a
   real non-negative number, and both query tools refuse on `null`. A genuine estimate of exactly 0
   still runs, which is tested.
2. **Write statements the keyword regex never listed sailed through.** `EXPORT DATA OPTIONS(...) AS
   SELECT * FROM ds.secrets` (writes an entire table out to a GCS bucket), `LOAD DATA INTO`, and
   `EXECUTE IMMEDIATE CONCAT('DEL','ETE FROM t')` (the verb never appears in the text at all) were all
   allowed. FIXED: the query is normalized first (comments and string literals stripped), must then
   BEGIN with `SELECT` or `WITH`, and is then keyword-scanned, which also catches a write smuggled
   after a semicolon.
3. **The same regex refused legitimate reads.** `SELECT * FROM ds.logs WHERE body LIKE '%call%'` was
   refused because the verb sat inside a string literal. FIXED by the same normalization.
4. **`people_search_contacts` crashed on a malformed result row.** `results.map(({ person: p }) =>
   ...)` threw `Cannot read properties of undefined` for any row without a `person` object, which
   `google.mjs`'s `call()` turns into "Tool failed" for a search that actually succeeded. FIXED.
5. **A Maps API key could ride out inside a transport error.** The legacy Maps endpoints take the key
   as a query parameter, and `google.mjs`'s `call()` hands `String(e.message)` straight back to the
   model. Node's own fetch does not leak the query string (verified: message is "fetch failed", cause
   is `getaddrinfo ENOTFOUND <host>`), so this was latent rather than live. FIXED anyway with a
   redaction pass, since a proxy agent or a retry wrapper could change that at any time.
6. **A still-running job read as an empty table.** `jobComplete: false` means the job blew past the
   request timeout and is still running server-side, and it will bill. The old output said "0 row(s)".
   FIXED: it now says so.
7. **The OAuth scope for BigQuery is wrong.** See the BLOCKER section above. NOT FIXED, because it
   lives in `google.mjs`.
8. **The drawer claim was too strong.** See the drawer section above. Claim corrected; the underlying
   scorer weakness lives in `toolbox.mjs` and is NOT FIXED.

Attacks that were tried and FAILED to get through, all now pinned by regression tests: raising the
cap through `maxBytesBilled` (huge numbers, `Infinity`, `1e999`, negatives, `NaN`, an object with a
`valueOf`); disabling the cap through `BIGQUERY_MAX_BYTES_BILLED` set to empty, `0`, `-1`, `abc`,
`Infinity`, `1e999`, or whitespace; sending `dryRun: false`, `maximumBytesBilled`, `configuration`,
`useLegacySql`, or `location` as undeclared arguments (the request body is a fixed literal and never a
spread of caller args); path and query traversal through `projectId`; smuggling `pageSize`, `sources`,
or `pageToken` into the People query string; and injecting `&key=` through the Maps `mode` parameter.

Two behaviours worth knowing about that are correct as they stand:

- `connectors.mjs`'s `PROTECTED_RE` runs over the whole argument blob before dispatch, so any
  BigQuery query whose text contains `app_backups`, `db_backups`, `pg_dump`, or a `D:\` path is
  blocked before it reaches this provider. That is the intended carve-out. It does mean a table
  legitimately named `app_backups` is unqueryable, which is the right side to err on.
- Connector tools reach the CLOUD path only. `connectors.toolDefsFor(T)` has exactly one call site
  (`server.mjs` line 8140), inside the `if (cloudModel)` branch, so a turn running on the local model
  cannot call any of these nine.

## Open, for Fred or a later session

- **Fix the BigQuery scope in `google.mjs` before shipping.** See the BLOCKER section. Until it is
  swapped for `cloud-platform.read-only`, all four BigQuery tools return 403 and the "IAM enforces
  read-only" claim in `google-bigquery.mjs`'s header is not true. The header now says so.
- **Fred must declare both scopes on the OAuth consent screen** in Google Cloud console, and enable
  the BigQuery API and the People API on the project, before this ships. An undeclared scope makes
  Google reject the entire authorization request with `restricted_client`, which would break the
  Connect Google button for every user rather than only for the new tools.
- **Reconnect required.** Any account that connected Google before this lane shipped has an OAuth
  token without the new scopes. BigQuery and People tools will fail with an insufficient-scope error
  from Google, which is an honest error rather than a crash or a silent no-op, until that account does
  Setup -> Disconnect -> Connect Google again. Gmail/Calendar/Drive/Sheets/Docs are unaffected.
  This is UNVERIFIED end-to-end on a real account (see build report) because no such reconnect could
  be performed in this non-interactive session.
- **Contact enumeration is a cost barrier, not a wall.** Google's `searchContacts` matches PREFIX
  phrases, so a 2-character query is a prefix sweep and "aa" through "zz" is 676 calls at up to 10
  results each. The minimum stays at 2 because real lookups need it. If Fred wants a real wall, the
  place for it is a per-turn connector call budget, not a longer minimum in `google-people.mjs`.
- **No `BIGQUERY_DEFAULT_PROJECT_ID` or `BIGQUERY_MAX_BYTES_BILLED` is set anywhere today.** Every
  BigQuery tool call needs an explicit `projectId` until one is configured. The byte cap defaults to
  100MB (104,857,600 bytes) in code if the env var is unset; raise it only by setting
  `BIGQUERY_MAX_BYTES_BILLED` on the box, never in chat.
- **The Maps-behind-OAuth tradeoff** above is real and unresolved; decide whether it is worth the
  `connectors.mjs` work before a guest account ever needs Maps without Gmail.
