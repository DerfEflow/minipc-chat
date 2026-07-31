/*
 * Tool-schema repair (toolschema.mjs).
 *
 * Built from a real production failure, so the first test IS that failure, reproduced from the
 * error Moonshot actually returned:
 *
 *   At path 'properties.migrations.items.required': required property 'tag' is not defined in
 *   properties
 *
 * Two claims carry equal weight here. The obvious one is that a malformed schema gets repaired.
 * The one that matters just as much is that a VALID schema is left completely alone: quietly
 * rewriting a working tool definition would be a worse bug than the one being fixed, and it would
 * be far harder to notice.
 */
import assert from "node:assert/strict";
import { sanitizeToolParameters, sanitizeToolList, findUndefinedRequired } from "./toolschema.mjs";

let passed = 0;
const t = (name, fn) => { fn(); console.log("  PASS  " + name); passed++; };

// The shape that broke the live run: a nested array whose items require a property nobody defined.
const BROKEN = {
  type: "object",
  properties: {
    project_id: { type: "string" },
    migrations: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, sql: { type: "string" } },
        required: ["name", "sql", "tag"],          // "tag" is never defined
      },
    },
  },
  required: ["project_id"],
};

t("THE LIVE FAILURE: the exact fault Moonshot named is found", () => {
  const found = findUndefinedRequired(BROKEN);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0], /properties\.migrations\.items\.required: "tag" is not defined/);
});

t("and it is repaired, keeping every property that really exists", () => {
  const r = sanitizeToolParameters(BROKEN);
  assert.equal(r.changed, true);
  assert.deepEqual(r.dropped, ["tag"], "the drop must be reported, never silent");
  assert.deepEqual(findUndefinedRequired(r.parameters), [], "no fault may survive the repair");
  const items = r.parameters.properties.migrations.items;
  assert.deepEqual(items.required, ["name", "sql"], "the legitimate requirements must survive");
  assert.deepEqual(Object.keys(items.properties), ["name", "sql"], "properties are untouched");
  assert.deepEqual(r.parameters.required, ["project_id"], "the outer schema was already fine");
});

t("the input is never mutated: connector tool lists are cached and reused", () => {
  const before = JSON.stringify(BROKEN);
  sanitizeToolParameters(BROKEN);
  assert.equal(JSON.stringify(BROKEN), before, "mutating the cached schema would corrupt every later request");
});

t("A VALID SCHEMA IS RETURNED BYTE-IDENTICAL, not rebuilt", () => {
  const good = {
    type: "object",
    properties: { path: { type: "string" }, depth: { type: "integer" } },
    required: ["path"],
  };
  const r = sanitizeToolParameters(good);
  assert.equal(r.changed, false, "a healthy schema must not be touched");
  assert.equal(r.parameters, good, "and must be the SAME object, not a copy");
});

t("required that empties out entirely is dropped rather than left as []", () => {
  const r = sanitizeToolParameters({ type: "object", properties: { a: { type: "string" } }, required: ["ghost"] });
  assert.equal("required" in r.parameters, false);
  assert.deepEqual(r.dropped, ["ghost"]);
});

t("an object schema with no properties gets an empty one", () => {
  const r = sanitizeToolParameters({ type: "object" });
  assert.deepEqual(r.parameters.properties, {});
  assert.equal(r.changed, true);
  // A non-object schema must NOT have properties invented for it.
  const s = sanitizeToolParameters({ type: "object", properties: { s: { type: "string" } } });
  assert.equal(s.parameters.properties.s.properties, undefined);
});

t("the fault is repaired wherever it hides: anyOf, $defs, tuple items", () => {
  const nasty = {
    type: "object",
    properties: {
      choice: { anyOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a", "b"] }] },
      pair: { type: "array", items: [{ type: "object", properties: {}, required: ["x"] }, { type: "string" }] },
    },
    $defs: { thing: { type: "object", properties: { id: { type: "string" } }, required: ["id", "missing"] } },
  };
  assert.equal(findUndefinedRequired(nasty).length, 3, "three faults planted");
  const r = sanitizeToolParameters(nasty);
  assert.deepEqual(findUndefinedRequired(r.parameters), [], "all three must be gone");
  assert.deepEqual(r.parameters.properties.choice.anyOf[0].required, ["a"]);
  assert.deepEqual(r.parameters.$defs.thing.required, ["id"]);
  assert.equal("required" in r.parameters.properties.pair.items[0], false);
});

t("a whole tool list is repaired, and the repair is reported by tool name", () => {
  const logs = [];
  const tools = [
    { type: "function", function: { name: "fs_read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    { type: "function", function: { name: "supabase__apply_migration", parameters: BROKEN } },
  ];
  const r = sanitizeToolList(tools, { log: (m) => logs.push(m) });
  assert.equal(r.tools.length, 2, "a repairable tool is kept, never thrown away");
  assert.equal(r.repaired, 1, "only the broken one is touched");
  assert.equal(r.tools[0], tools[0], "the healthy tool is the same object it went in as");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /supabase__apply_migration/);
  assert.match(logs[0], /"tag"/, "the log must name what was dropped, so this is findable");
  assert.deepEqual(findUndefinedRequired(r.tools[1].function.parameters), []);
});

t("a tool with no name at all is dropped instead of poisoning the request", () => {
  const r = sanitizeToolList([{ type: "function", function: {} }, null, "nonsense"]);
  assert.equal(r.tools.length, 0);
  assert.equal(r.dropped.length, 3, "one bad tool must never cost the user the whole turn");
});

t("a missing or non-object parameters block becomes a legal empty object", () => {
  for (const bad of [undefined, null, "string", 42, []]) {
    const r = sanitizeToolParameters(bad);
    assert.equal(r.parameters.type, "object");
    assert.deepEqual(r.parameters.properties, {});
  }
});

t("a cyclic schema terminates instead of hanging the request", () => {
  const cyc = { type: "object", properties: {} };
  cyc.properties.self = cyc;
  const r = sanitizeToolParameters(cyc);       // must simply return, not recurse forever
  assert.ok(r.parameters);
  assert.deepEqual(findUndefinedRequired(cyc), []);
});

console.log(`\n${passed}/11 checks passed - a malformed connector schema can no longer cost a whole turn`);
