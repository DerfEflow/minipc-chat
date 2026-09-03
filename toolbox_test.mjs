import assert from "node:assert/strict";
import { TOOLBOX_OPEN_NAME, withToolbox, openToolbox, capToolsToLimit } from "./toolbox.mjs";

const def = (name, description) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: {} } },
});
const catalog = withToolbox([
  def("forge_edit", "Edit a file in a repository"),
  def("create_pdf", "Create and export a PDF document"),
  def("cx_google_drive__search", "Search files in Google Drive"),
]);

assert.equal(catalog[0].function.name, TOOLBOX_OPEN_NAME, "the loader must survive provider tool caps");

const current = withToolbox([catalog[1]]);
const byQuery = openToolbox(catalog, current, { query: "Google Drive search" }, 12);
assert.deepEqual(byQuery.names, ["cx_google_drive__search"], "a capability query should load the matching connector tool");

const byName = openToolbox(catalog, current, { tools: ["create_pdf"] }, 12);
assert.deepEqual(byName.names, ["create_pdf"], "an exact tool request should load that schema");

const noDuplicate = openToolbox(catalog, catalog, { query: "edit repository" }, 12);
assert.deepEqual(noDuplicate.names, [], "already loaded schemas must not be loaded twice");

const capped = openToolbox(catalog, current, { query: "document" }, 0);
assert.deepEqual(capped.names, [], "the provider tool cap must remain a hard ceiling");

// ---- lane/chat, required behavior #2 (OpenAI's 128-tool cap): "select by the existing needs_*
// gating and route class, then by name relevance" — capToolsToLimit is the extracted, unit-testable
// version of the selection server.mjs now runs when the scoped/Wildfire toolbox still overflows the
// provider's cap. ----
{
  const box = ["forge_read", "forge_edit", "forge_run", "create_pdf", "create_docx", "web_search"]
    .map((n) => def(n, n + " box tool"));
  // 300 connector tools (well past scarcity for a 128 cap with room for only ~121 of them); three
  // scattered near the END of the list mention "roof" or "invoice", the rest are noise. A blind
  // "first N" or alphabetical-tail cut would keep low-index noise and drop these three; relevance
  // scoring must keep them regardless of where they sit.
  const connectors = Array.from({ length: 300 }, (_, i) => def(`cx_conn${i}__op`, `connector op ${i} does unrelated bulk work`));
  connectors[150] = def("cx_conn150__op", "connector op handles roof inspection reports");
  connectors[220] = def("cx_conn220__op", "connector op files an invoice for the roof job");
  connectors[295] = def("cx_conn295__op", "connector op searches roof warranty records");
  const all = withToolbox([...box, ...connectors]);   // 307 total (box 6 + toolbox_open + 300 connectors)

  const capped = capToolsToLimit(all, { limit: 128, query: "roof invoice" });
  assert.equal(capped.tools.length, 128, "the result must never exceed the provider's cap");
  assert.equal(capped.dropped, all.length - 128, "dropped count must match what was actually shed");
  const keptNames = capped.tools.map((d) => d.function.name);
  for (const n of [...box.map((d) => d.function.name), TOOLBOX_OPEN_NAME]) {
    assert.ok(keptNames.includes(n), `this app's own tool "${n}" must never be shed for a connector`);
  }
  assert.ok(keptNames.includes("cx_conn150__op"), "a connector tool relevant to the ask (roof), buried deep in the list, must survive the cap");
  assert.ok(keptNames.includes("cx_conn220__op"), "a connector tool relevant to the ask (invoice), buried deep in the list, must survive the cap");
  assert.ok(keptNames.includes("cx_conn295__op"), "a connector tool relevant to the ask (roof warranty), at the very end of the list, must survive the cap");
  assert.ok(!keptNames.includes("cx_conn299__op"), "with only ~121 connector seats for 300 candidates, an irrelevant tool must be the one shed, not a relevant one");
  assert.ok(capped.droppedNames.includes("cx_conn299__op"), "a shed tool must be named in droppedNames so it can be reported, never silent");
  assert.ok(!capped.droppedNames.includes("cx_conn150__op"), "a kept tool must not also be reported as dropped");
}
{
  // Under the cap: nothing changes, nothing is reported dropped.
  const small = withToolbox([def("forge_read", "read"), def("cx_x__y", "connector")]);
  const r = capToolsToLimit(small, { limit: 128, query: "anything" });
  assert.equal(r.tools, small, "an already-small list must be returned as-is (identity), not rebuilt");
  assert.equal(r.dropped, 0);
  assert.deepEqual(r.droppedNames, []);
}

console.log("toolbox_test: missing tools load on demand and expire with turn-local state");
