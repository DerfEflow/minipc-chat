import assert from "node:assert/strict";
import { TOOLBOX_OPEN_NAME, withToolbox, openToolbox } from "./toolbox.mjs";

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

console.log("toolbox_test: missing tools load on demand and expire with turn-local state");
