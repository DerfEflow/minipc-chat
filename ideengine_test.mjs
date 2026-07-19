/*
 * Dominion Works build engine self-test. Run with: node ideengine_test.mjs
 * The whole engine is exercised with fake dependencies, so this proves real behaviour with no
 * server, no provider, and no filesystem:
 *   1. the cacheable system prefix is byte-identical across every move (the cache-hit KPI)
 *   2. a snapshot is taken BEFORE any write, and no snapshot means no write at all
 *   3. carve-out refusals name the file and the offending words, and cost nothing
 *   4. metering happens ONCE per move on a FINALLY path, including on failure
 *   5. one repair round on a failed check, then the truth, never an infinite loop
 *   6. path traversal and absolute paths are refused rather than normalized
 */
import assert from "node:assert/strict";
import {
  isSmallAsk, parseBlueprint, parseFileBlocks, carveOutReport, budgetCheck, estimateMove,
  verifyCommandFor, buildMoveMessages, createIdeEngine, SYSTEM_PREFIX,
} from "./ideengine.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}

/* ---- planning ---------------------------------------------------------------------------- */
await t("a small ask skips planning; a real build gets a plan", () => {
  assert.equal(isSmallAsk("fix the typo in the header").small, true);
  assert.equal(isSmallAsk("rename the button component", { files: ["a.tsx"] }).small, true);
  assert.equal(isSmallAsk("build me a invoicing app with login and stripe").small, false);
  assert.equal(isSmallAsk("create a dashboard").small, false);
  assert.equal(isSmallAsk("refactor the whole data layer").small, false);
  assert.equal(isSmallAsk("").small, false);
  assert.match(isSmallAsk("fix the typo").why, /straight away/);
});

await t("a blueprint is dug out of prose and fences, and normalized", () => {
  const messy = 'Sure! Here is the plan:\n```json\n[{"id":"m1","title":"Set up the project","why":"Nothing exists yet","files":["package.json"],"verify":"npm run build"}]\n```\nHope that helps!';
  const r = parseBlueprint(messy);
  assert.equal(r.ok, true);
  assert.equal(r.moves.length, 1);
  assert.equal(r.moves[0].title, "Set up the project");
  assert.deepEqual(r.moves[0].files, ["package.json"]);

  assert.equal(parseBlueprint('[{"title":"A"},{"title":"B"}]').moves.length, 2);
  assert.equal(parseBlueprint('{"moves":[{"title":"A"}]}').moves.length, 1);
  assert.equal(parseBlueprint("here is no json at all").ok, false, "refuses honestly rather than inventing a plan");
  assert.equal(parseBlueprint("[]").ok, false);
});

/* ---- file blocks ------------------------------------------------------------------------- */
await t("file blocks are parsed, and escapes from the workspace are REFUSED", () => {
  const out = parseFileBlocks([
    "```path=src/a.ts", "export const a = 1;", "```",
    "```path=../../etc/passwd", "nope", "```",
    "```path=C:/Windows/system32/x.dll", "nope", "```",
    "```path=/etc/hosts", "nope", "```",
  ].join("\n"));
  assert.equal(out.files.length, 1, "only the safe one survives");
  assert.equal(out.files[0].path, "src/a.ts");
  assert.equal(out.issues.length, 3);
  assert.match(out.issues[0].reason, /climb out/);
  assert.match(out.issues[1].reason, /absolute/);
});

await t("a plain language fence is not mistaken for a file", () => {
  const out = parseFileBlocks("```json\n{\"a\":1}\n```");
  assert.equal(out.files.length, 0);
});

await t("a move can say it needs a file it was not given", () => {
  const out = parseFileBlocks("```path=NEED: src/config.ts\n\n```");
  assert.deepEqual(out.needs, ["src/config.ts"]);
  assert.equal(out.files.length, 0);
});

/* ---- carve-outs -------------------------------------------------------------------------- */
await t("carve-out refusals name the FILE and the exact words that tripped it", () => {
  const r = carveOutReport([{ path: "scripts/backup.sh", content: "pg_dump mydb > out.sql" }]);
  assert.ok(r);
  assert.match(r.message, /scripts\/backup\.sh/);
  assert.match(r.message, /pg_dump/);
  assert.match(r.message, /contents as well as paths/i, "must explain WHY innocent text set it off");
  assert.match(r.message, /never relaxed/i, "and that the guard is not negotiable");
  assert.equal(carveOutReport([{ path: "src/a.ts", content: "const x = 1" }]), null);
  assert.ok(carveOutReport([{ path: "a.md", content: "see D:\\backups for details" }]));
});

/* ---- budget ------------------------------------------------------------------------------ */
await t("a budget cap stops BEFORE the move that would exceed it", () => {
  assert.equal(budgetCheck({ spentUsd: 0.2, capUsd: 2, nextEstUsd: 0.1 }).stop, false);
  const pre = budgetCheck({ spentUsd: 1.95, capUsd: 2, nextEstUsd: 0.2 });
  assert.equal(pre.stop, true);
  assert.equal(pre.reason, "next_move_would_exceed", "stopping after the overspend would be too late");
  assert.equal(budgetCheck({ spentUsd: 2, capUsd: 2 }).reason, "cap_reached");
  assert.equal(budgetCheck({ spentUsd: 1.6, capUsd: 2, nextEstUsd: 0.1 }).warn, true);
  assert.equal(budgetCheck({ spentUsd: 99, capUsd: 0 }).stop, false, "no cap means no cap (the owner)");
});

await t("estimates are arithmetic, never a model call", () => {
  const e = estimateMove({ manifestBytes: 36000, inCost: 2.5, outCost: 15, expectOutTokens: 2000 });
  assert.ok(e.inTok > 10000 && e.inTok < 12000);
  assert.ok(e.usd > 0 && e.usd < 1);
  assert.equal(estimateMove({ manifestBytes: 0, inCost: 0, outCost: 0 }).usd, 0);
});

/* ---- verify discovery -------------------------------------------------------------------- */
await t("the check command is DISCOVERED, never guessed", () => {
  assert.equal(verifyCommandFor('{"scripts":{"typecheck":"tsc --noEmit","test":"vitest"}}').cmd, "npm run typecheck --silent");
  assert.equal(verifyCommandFor('{"scripts":{"test":"vitest"}}').cmd, "npm run test --silent");
  assert.equal(verifyCommandFor('{"scripts":{}}').cmd, "", "no scripts means nothing is run");
  assert.equal(verifyCommandFor("not json").cmd, "");
  assert.match(verifyCommandFor("{}").why, /nothing to run|no check/);
});

/* ---- the cacheable prefix ---------------------------------------------------------------- */
await t("the system prefix is BYTE-IDENTICAL across different moves (the cache KPI)", () => {
  const a = buildMoveMessages({ move: { id: "m1", title: "One", why: "x", files: [] }, manifest: [], workspaceName: "A", goal: "g1" });
  const b = buildMoveMessages({ move: { id: "m2", title: "Two", why: "y", files: [] }, manifest: [{ path: "z.ts", content: "hello" }], workspaceName: "B", goal: "g2" });
  assert.equal(a[0].content, b[0].content, "any per-move text in the system block would defeat provider caching");
  assert.equal(a[0].content, SYSTEM_PREFIX);
  assert.ok(!a[0].content.includes("One") && !b[0].content.includes("Two"));
  assert.match(b[1].content, /z\.ts/, "per-move facts belong in the user turn");
  assert.match(b[1].content, /hello/);
});

await t("a file that does not exist yet is labelled, not silently blank", () => {
  const m = buildMoveMessages({ move: { title: "T", files: [] }, manifest: [{ path: "new.ts", missing: true }] });
  assert.match(m[1].content, /does not exist yet/);
});

/* ---- the orchestrator, with fake everything ---------------------------------------------- */
function rig({ chatReplies = [], handsImpl = null } = {}) {
  const events = [], calls = [], metered = [];
  let reply = 0;
  const jobs = { emit: (id, ev) => events.push(ev), finish: (id, ev) => events.push(ev) };
  const chat = async (args) => { calls.push(args); const r = chatReplies[reply++] || { ok: false, error: "no reply" }; return r; };
  const hands = handsImpl || (async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "fs_read" && String(args.path).endsWith("package.json")) return { content: '{"scripts":{"test":"echo ok"}}' };
    if (tool === "fs_read") return { content: "existing contents" };
    if (tool === "shell_run" && /rev-parse/.test(args.command)) return { stdout: "true" };
    if (tool === "shell_run") return { code: 0, stdout: "" };
    if (tool === "fs_write") return { ok: true };
    return {};
  });
  const router = () => ({ taskClass: "build_code", model: "test/model", why: "test" });
  const meter = async (usd) => { metered.push(usd); };
  const engine = createIdeEngine({ jobs, chat, hands, router, meter });
  return { engine, events, calls, metered, types: () => events.map((e) => e.type + (e.state ? ":" + e.state : "")) };
}
const JOB = { id: "ide_test" };
const WS = { root: "C:/Projects/demo", name: "Demo" };
const MOVE = { id: "m1", title: "Add a thing", why: "because", files: ["src/a.ts"] };

await t("a successful move snapshots BEFORE writing, then verifies", async () => {
  const r = rig({ chatReplies: [{ ok: true, content: "```path=src/a.ts\nexport const a = 1;\n```", costUsd: 0.01 }] });
  const out = await r.engine.runMove(JOB, { move: MOVE, workspace: WS, assignments: {}, goal: "g" });
  assert.equal(out.ok, true);
  const order = r.calls.filter((c) => c.tool).map((c) => c.tool + (c.args.command ? ":" + (/commit/.test(c.args.command) ? "commit" : /rev-parse/.test(c.args.command) ? "isrepo" : "check") : ""));
  const snapAt = order.findIndex((o) => o === "shell_run:commit");
  const writeAt = order.findIndex((o) => o === "fs_write");
  assert.ok(snapAt >= 0, "a snapshot must happen");
  assert.ok(snapAt < writeAt, "and it must happen BEFORE the first write");
  assert.ok(r.types().includes("snapshot"));
  assert.ok(r.types().includes("file"));
  assert.ok(r.types().includes("move:done"));
});

await t("NO SNAPSHOT means NO WRITE: without a restore point the move refuses", async () => {
  const r = rig({
    chatReplies: [{ ok: true, content: "```path=src/a.ts\nx\n```", costUsd: 0.01 }],
    handsImpl: async (tool, args) => {
      if (tool === "shell_run") throw new Error("disk full");
      if (tool === "fs_write") throw new Error("should never be reached");
      return { content: "" };
    },
  });
  const out = await r.engine.runMove(JOB, { move: MOVE, workspace: WS, assignments: {} });
  assert.equal(out.ok, false);
  const failure = r.events.find((e) => e.state === "failed");
  assert.match(failure.message, /No restore point/i);
  assert.match(failure.message, /nothing was written/i);
});

await t("a carve-out hit blocks the move BEFORE any snapshot or write", async () => {
  const r = rig({ chatReplies: [{ ok: true, content: "```path=scripts/b.sh\npg_dump mydb\n```", costUsd: 0.02 }] });
  const out = await r.engine.runMove(JOB, { move: MOVE, workspace: WS, assignments: {} });
  assert.equal(out.blocked, true);
  assert.ok(!r.calls.some((c) => c.tool === "fs_write"), "nothing may be written");
  assert.ok(!r.types().includes("snapshot"), "and no snapshot is even needed");
  const blocked = r.events.find((e) => e.state === "blocked");
  assert.match(blocked.message, /pg_dump/);
});

await t("METERING happens once per move on a FINALLY path, even when the move FAILS", async () => {
  const ok = rig({ chatReplies: [{ ok: true, content: "```path=src/a.ts\nx\n```", costUsd: 0.03 }] });
  await ok.engine.runMove(JOB, { move: MOVE, workspace: WS, assignments: {} });
  assert.deepEqual(ok.metered, [0.03], "exactly one charge for the move, not one per call");

  const bad = rig({ chatReplies: [{ ok: false, error: "provider exploded", costUsd: 0.02 }] });
  const out = await bad.engine.runMove(JOB, { move: MOVE, workspace: WS, assignments: {} });
  assert.equal(out.ok, false);
  assert.deepEqual(bad.metered, [0.02], "a FAILED move still burned tokens and must still be charged");

  const blocked = rig({ chatReplies: [{ ok: true, content: "```path=x.sh\npg_dump\n```", costUsd: 0.05 }] });
  await blocked.engine.runMove(JOB, { move: MOVE, workspace: WS, assignments: {} });
  assert.deepEqual(blocked.metered, [0.05], "a carve-out block still paid for the model call");

  const free = rig({ chatReplies: [{ ok: true, content: "```path=src/a.ts\nx\n```", costUsd: 0 }] });
  await free.engine.runMove(JOB, { move: MOVE, workspace: WS, assignments: {} });
  assert.deepEqual(free.metered, [], "a zero-cost move is never charged a floor");
});

await t("a failed check gets ONE repair round, then the truth instead of a loop", async () => {
  let checks = 0;
  const r = rig({
    chatReplies: [
      { ok: true, content: "```path=src/a.ts\nbroken\n```", costUsd: 0.01 },
      { ok: true, content: "```path=src/a.ts\nstill broken\n```", costUsd: 0.01 },
      { ok: true, content: "```path=src/a.ts\nthird try\n```", costUsd: 0.01 },
    ],
    handsImpl: async (tool, args) => {
      if (tool === "fs_read" && String(args.path).endsWith("package.json")) return { content: '{"scripts":{"test":"x"}}' };
      if (tool === "fs_read") return { content: "c" };
      if (tool === "shell_run" && /rev-parse/.test(args.command)) return { stdout: "true" };
      if (tool === "shell_run" && /commit/.test(args.command)) return { code: 0 };
      if (tool === "shell_run") { checks++; return { code: 1, stdout: "TS2304: cannot find name" }; }
      if (tool === "fs_write") return { ok: true };
      return {};
    },
  });
  const out = await r.engine.runMove(JOB, { move: MOVE, workspace: WS, assignments: {} });
  assert.equal(out.ok, false);
  assert.equal(checks, 2, "the check runs twice: original then one repair, never a third");
  assert.ok(r.types().includes("move:repairing"));
  const fail = r.events.find((e) => e.state === "failed");
  assert.match(fail.message, /still fails after one repair/i);
  assert.match(fail.message, /nothing further was tried automatically/i);
  assert.deepEqual(r.metered, [0.02], "both calls charged together, once");
});

await t("a move that returns no files fails honestly and names what it wanted", async () => {
  const r = rig({ chatReplies: [{ ok: true, content: "```path=NEED: src/other.ts\n\n```", costUsd: 0.01 }] });
  const out = await r.engine.runMove(JOB, { move: MOVE, workspace: WS, assignments: {} });
  assert.equal(out.ok, false);
  const f = r.events.find((e) => e.state === "failed");
  assert.match(f.message, /src\/other\.ts/);
});

await t("the manifest is read straight off the node, not through the truncating tool loop", async () => {
  const r = rig({ chatReplies: [{ ok: true, content: "```path=src/a.ts\nx\n```", costUsd: 0 }] });
  await r.engine.runMove(JOB, { move: { ...MOVE, files: ["src/a.ts", "src/b.ts"] }, workspace: WS, assignments: {} });
  const reads = r.calls.filter((c) => c.tool === "fs_read" && !String(c.args.path).endsWith("package.json"));
  assert.equal(reads.length, 2, "one direct read per manifest file");
  assert.ok(reads[0].args.maxBytes >= 100000, "and a real byte budget, not an 8000-char truncation");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
