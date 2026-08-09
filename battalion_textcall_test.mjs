/*
 * Tool calls that arrive as prose.
 *
 * Fred's second real BATTALION turn. The model was given the schema and used it correctly in every
 * respect that mattered: it chose forge_read, op "list", path "Z:\Apps". It simply wrote the call in
 * its own training format as TEXT rather than returning it through the structured channel. So
 * r.toolCalls was empty, nothing ran, and the raw markup was STREAMED to him as the answer.
 *
 * Two separate guarantees are under test here, and the second is the one that matters more:
 *   1. a call written as prose is parsed and run, if and only if it names a tool actually offered;
 *   2. tool-call markup NEVER reaches the user, whether or not it could be run.
 *
 * The second cannot be satisfied by parsing alone. The markup reached Fred because it was streamed
 * as it arrived, before any code could look at it. The loop now buffers every round and emits once,
 * after inspection, which is why these tests assert on what was streamed rather than only on the
 * returned content.
 */
import assert from "node:assert/strict";
import { createBattalion, parseTextToolCalls } from "./battalion.mjs";
import { toolDefs, toolMeta } from "./tools.mjs";

let passed = 0;
const t = async (name, fn) => { await fn(); console.log("  ok  " + name); passed++; };

const ROSTER = {
  assess: "seat-assess", orchestrator: "seat-orch", synthesizer: "seat-synth",
  single: "seat-single", workers: ["seat-w1", "seat-w2", "seat-w3", "seat-w4"],
};
const TENANT = { tenant: { email: "owner@dev" }, hands: "OWNER_HANDS" };
const readOnlyDefs = () => toolDefs(null).filter((d) => toolMeta(d.function.name).permissionClass === "read_only");

// Exactly what Fred saw on screen, reproduced character for character.
const PATH = "Z:" + String.fromCharCode(92) + "Apps";
const HARMONY = [
  "<tool_call>", "<function=forge_read>",
  "<parameter=op>", "list", "</parameter>",
  "<parameter=path>", PATH, "</parameter>",
  "</function>", "</tool_call>",
].join("\n");

await t("a call written as prose is parsed and run with its arguments intact", async () => {
  const executed = [], streamed = [];
  let round = 0;
  const callSeat = async (id) => {
    if (id !== ROSTER.single) return { ok: true, content: "unused" };
    return round++ === 0 ? { ok: true, content: HARMONY } : { ok: true, content: "Drive Z holds four projects." };
  };
  const battalion = createBattalion({
    callSeat, roster: ROSTER, tools: readOnlyDefs,
    runTool: async (name, args) => { executed.push([name, args.op, args.path]); return "a listing"; },
  });
  const r = await battalion.run({ question: "what is on Drive Z", toolContext: TENANT, onToken: (d) => streamed.push(d) });
  assert.ok(r.ok);
  assert.deepEqual(executed, [["forge_read", "list", PATH]], "the parsed call must run, with its arguments");
  assert.match(r.content, /four projects/, "the answer must be the model's reply, not the markup");
  assert.ok(r.manifest.notes.some((n) => /wrote its tool call as text/.test(n)),
    "a parsed text call must be announced, so this stops being invisible");
});

await t("markup NEVER reaches the user, even when it runs", async () => {
  const streamed = [];
  let round = 0;
  const callSeat = async (id) => {
    if (id !== ROSTER.single) return { ok: true, content: "unused" };
    return round++ === 0 ? { ok: true, content: HARMONY } : { ok: true, content: "Drive Z holds four projects." };
  };
  const battalion = createBattalion({
    callSeat, roster: ROSTER, tools: readOnlyDefs, runTool: async () => "a listing",
  });
  await battalion.run({ question: "what is on Drive Z", toolContext: TENANT, onToken: (d) => streamed.push(d) });
  const all = streamed.join("");
  for (const leak of ["<tool_call>", "<function=", "<parameter=", "</tool_call>"]) {
    assert.ok(!all.includes(leak), "markup reached the user: " + leak + " in " + JSON.stringify(all.slice(0, 90)));
  }
  assert.match(all, /four projects/, "the real answer still reached the user");
});

await t("markup naming a tool that was never offered is stripped, never run", async () => {
  const executed = [], streamed = [];
  const evil = [
    "<tool_call>", "<function=forge_write>",
    "<parameter=path>", "C:" + String.fromCharCode(92) + "x", "</parameter>",
    "</function>", "</tool_call>", "Here is my answer.",
  ].join("\n");
  let round = 0;
  const callSeat = async (id) => {
    if (id !== ROSTER.single) return { ok: true, content: "unused" };
    return round++ === 0 ? { ok: true, content: evil } : { ok: true, content: "fallback" };
  };
  const battalion = createBattalion({
    callSeat, roster: ROSTER, tools: readOnlyDefs,
    runTool: async (name) => { executed.push(name); return "SHOULD NOT RUN"; },
  });
  const r = await battalion.run({ question: "do a thing", toolContext: TENANT, onToken: (d) => streamed.push(d) });
  assert.deepEqual(executed, [], "a write tool named in prose must never execute");
  assert.ok(!streamed.join("").includes("<tool_call>"), "markup reached the user");
  assert.match(r.content, /Here is my answer/, "prose around the markup survives");
});

await t("parseTextToolCalls resolves only what was offered, and leaves prose alone", () => {
  const offered = new Set(["forge_read"]);
  const good = parseTextToolCalls(HARMONY, offered);
  assert.equal(good.calls.length, 1);
  assert.equal(good.calls[0].function.name, "forge_read");
  assert.deepEqual(JSON.parse(good.calls[0].function.arguments), { op: "list", path: PATH });
  assert.equal(good.stripped, "", "the block is removed from the visible text");
  // A real tool that was not offered THIS turn resolves to nothing.
  assert.equal(parseTextToolCalls(HARMONY, new Set(["web_search"])).calls.length, 0);
  // A model discussing tool syntax is not mistaken for calling one.
  assert.deepEqual(parseTextToolCalls("I could use <tool_call> syntax but I will not.", offered).calls, []);
  // Ordinary text passes through untouched.
  assert.equal(parseTextToolCalls("just an answer", offered).stripped, "just an answer");
  assert.deepEqual(parseTextToolCalls("", offered).calls, []);
});

await t("the first turn's shape is deliberately NOT parsed, because it names no tool", () => {
  // {"command":"ls","path":"F:\"} was the first failure. It resolves to nothing in the catalog, so
  // there is nothing to run and a mapping would be invention. It is left to the no-tools answer path.
  const json = '{"command": "ls", "path": "F:' + String.fromCharCode(92) + '"}';
  const out = parseTextToolCalls(json, new Set(["forge_read"]));
  assert.deepEqual(out.calls, []);
  assert.equal(out.stripped, json, "content with no tool_call block is returned untouched");
});

console.log(`\nbattalion_textcall: ${passed} passed, 0 failed`);
