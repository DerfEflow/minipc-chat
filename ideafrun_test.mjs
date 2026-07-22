import test from "node:test";
import assert from "node:assert/strict";
import { ownershipFilter, afPlanMoves, afWorkerMove, afReviewMove, afQcMove } from "./ideafrun.mjs";
import { MAX_FILES_PER_MOVE } from "./ideengine.mjs";

test("ideafrun", async (t) => {
  await t.test("ownershipFilter keeps granted files and drops grabs, case and slash blind", () => {
    const { kept, dropped } = ownershipFilter(
      [{ path: "SRC\\App.js", content: "a" }, { path: "src/other.js", content: "b" }],
      ["src/app.js"],
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].path, "SRC\\App.js");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].path, "src/other.js");
  });

  await t.test("ownershipFilter with an empty grant drops everything", () => {
    const { kept, dropped } = ownershipFilter([{ path: "a.js" }], []);
    assert.equal(kept.length, 0);
    assert.equal(dropped.length, 1);
  });

  await t.test("afPlanMoves lays the relay out honestly: divide, parts, reviews, qc", () => {
    const parts = [
      { title: "Header", files: ["h.js"], contract: "exports header()" },
      { title: "Footer", files: ["f.js"], contract: "exports footer()" },
    ];
    const moves = afPlanMoves({ dividerTask: "Divide", parts, reviewerTask: "Review and fix", qcTask: "Final check" });
    assert.equal(moves.length, 1 + 2 + 2 + 1);
    assert.equal(moves[0].id, "af-divide");
    assert.equal(moves[1].id, "af-p1");
    assert.equal(moves[3].id, "af-review-1");
    assert.equal(moves[5].id, "af-qc");
  });

  await t.test("afPlanMoves without reviewer or qc rows shows only divide and parts", () => {
    const moves = afPlanMoves({ dividerTask: "Divide", parts: [{ title: "X", files: ["x.js"], contract: "c" }] });
    assert.deepEqual(moves.map((m) => m.id), ["af-divide", "af-p1"]);
  });

  await t.test("worker move carries the exclusive grant and the contract", () => {
    const m = afWorkerMove({ title: "Header", files: ["h.js"], contract: "exports header()" }, 1);
    assert.equal(m.id, "af-p1");
    assert.deepEqual(m.files, ["h.js"]);
    assert.match(m.why, /EXCLUSIVELY/);
    assert.match(m.why, /exports header\(\)/);
  });

  await t.test("review move includes the failing check output when given", () => {
    const m = afReviewMove({ title: "Header", files: ["h.js"], contract: "c" }, 2, { reviewerTask: "Review and fix", checkOutput: "1 test failed" });
    assert.equal(m.id, "af-review-2");
    assert.match(m.why, /1 test failed/);
    assert.match(m.why, /no files at all/);
  });

  await t.test("qc move unions files without duplicates and caps at the engine limit", () => {
    const parts = [];
    for (let i = 0; i < 30; i++) parts.push({ title: "P" + i, files: ["f" + i + ".js", "F" + i + ".JS"], contract: "c" });
    const m = afQcMove(parts, "Final check");
    assert.equal(m.id, "af-qc");
    assert.ok(m.files.length <= MAX_FILES_PER_MOVE);
    const lower = m.files.map((f) => f.toLowerCase());
    assert.equal(new Set(lower).size, lower.length);
  });
});
