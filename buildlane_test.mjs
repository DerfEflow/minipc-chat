/*
 * Where a build runs (buildlane.mjs), and the persistence of that choice (ide.mjs prefs).
 *
 * The claim that matters most is the SAFETY one, and it is the whole reason the rule is a module:
 * flipping the preference must never redirect a project that already exists. A workshop project's
 * files live only inside the sandbox and a laptop project's files live only on the laptop, so a
 * preference with the power to redirect either one would silently report an empty repository the
 * first time someone changed a setting — a failure nobody would ever trace back to a dropdown.
 *
 * The rest holds the honest edges: no machine attached means no choice to offer, a stored "mine"
 * from before the helper was uninstalled must not route into a void, and a typo must not become a
 * third lane.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { laneFor, canChooseLane, normalizeBuildWhere, LANES, lifecycleRoot } from "./buildlane.mjs";
import { createIdeStore } from "./ide.mjs";

let passed = 0;
const t = async (name, fn) => { await fn(); console.log("  PASS  " + name); passed++; };

const GUEST = { isOwner: false, nodeLive: true, cloudPref: false };
const CLOUD_WS = { id: "w1", root: "/data/workshops/g1/my-app", node: "workshop" };
const MINE_WS = { id: "w2", root: "C:\\Projects\\my-app", node: "" };

await t("a guest with a machine attached builds on it by default", async () => {
  assert.equal(laneFor(GUEST, null), "node");
});

await t("choosing the cloud sends NEW work to the workshop", async () => {
  assert.equal(laneFor({ ...GUEST, cloudPref: true }, null), "workshop");
});

await t("a guest with no machine lands in the workshop whatever they once chose", async () => {
  // The dangerous case: they chose "mine" while the helper was installed, then uninstalled it.
  assert.equal(laneFor({ isOwner: false, nodeLive: false, cloudPref: false }, null), "workshop");
  assert.equal(laneFor({ isOwner: false, nodeLive: false, cloudPref: true }, null), "workshop");
});

await t("THE SAFETY RULE: an existing project always runs where its files are", async () => {
  // A workshop project stays in the workshop even for someone who prefers their own machine...
  assert.equal(laneFor({ ...GUEST, cloudPref: false }, CLOUD_WS), "workshop");
  // ...and a project on their own drive stays there even after they switch to the cloud.
  assert.equal(laneFor({ ...GUEST, cloudPref: true }, MINE_WS), "node");
  // Same for the owner, whose real drives must never be shadowed by a sandbox.
  assert.equal(laneFor({ isOwner: true, nodeLive: true, cloudPref: true }, MINE_WS), "owner");
});

await t("the owner keeps his own machines until he asks otherwise", async () => {
  assert.equal(laneFor({ isOwner: true, nodeLive: true, cloudPref: false }, null), "owner");
  assert.equal(laneFor({ isOwner: true, nodeLive: true, cloudPref: true }, null), "workshop");
});

await t("every answer is a real lane", async () => {
  for (const isOwner of [true, false]) {
    for (const nodeLive of [true, false]) {
      for (const cloudPref of [true, false]) {
        for (const ws of [null, CLOUD_WS, MINE_WS]) {
          assert.ok(LANES.includes(laneFor({ isOwner, nodeLive, cloudPref }, ws)), "lane must be known");
        }
      }
    }
  }
});

await t("the control is offered only when both lanes exist", async () => {
  assert.equal(canChooseLane({ isOwner: false, nodeLive: true }), true);
  assert.equal(canChooseLane({ isOwner: false, nodeLive: false }), false, "a toggle that cannot move is worse than none");
  assert.equal(canChooseLane({ isOwner: true, nodeLive: false }), true);
});

await t("a typo is never a third lane", async () => {
  for (const bad of ["CLOUD", "workshop", "", null, undefined, 0, {}, "min"]) {
    assert.equal(normalizeBuildWhere(bad), "mine", "must fall back safely: " + String(bad));
  }
  assert.equal(normalizeBuildWhere("cloud"), "cloud");
});

await t("the choice survives a restart, and defaults to your own computer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lane-"));
  try {
    const a = createIdeStore({ dir });
    assert.equal(a.prefs().buildWhere, "mine", "a fresh account builds on its own machine");
    a.setPrefs({ engaged: true, buildWhere: "cloud" });
    // A second store over the same directory is what a server restart looks like.
    assert.equal(createIdeStore({ dir }).prefs().buildWhere, "cloud");
    // An unrelated preference write must not silently reset the lane.
    const b = createIdeStore({ dir });
    b.setPrefs({ engaged: true, language: "plain" });
    assert.equal(createIdeStore({ dir }).prefs().buildWhere, "cloud", "an absent field leaves the lane alone");
    b.setPrefs({ engaged: true, buildWhere: "nonsense" });
    assert.equal(createIdeStore({ dir }).prefs().buildWhere, "mine", "and a bad value lands on the safe default");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed}/9 checks passed - a build runs where its files are, and the choice is only offered when it is real`);

/* ---------- the lifecycle order, baked in 2026-07-31 --------------------------------------- */
await t("new apps go to F:, iterations go to Z:", () => {
  const roots = ["C:\\", "F:\\", "Z:\\"];
  assert.equal(lifecycleRoot({ isOwner: true, roots, name: "my-app", kind: "new" }), "F:\\Claude Sandbox\\my-app");
  assert.equal(lifecycleRoot({ isOwner: true, roots, name: "my-app", kind: "iteration" }), "Z:\\Apps\\my-app");
});

await t("a GUEST is never pushed onto Fred's drives", () => {
  // The owner guard: someone else's computer has no F: or Z: to honour, and this order is about
  // Fred's machines. "" means "no opinion, keep the previous behaviour".
  assert.equal(lifecycleRoot({ isOwner: false, roots: ["C:\\", "F:\\", "Z:\\"], name: "my-app" }), "");
});

await t("an unmounted drive never gets a confident path composed onto it", () => {
  // Laptop with the SSD unplugged: fall back rather than inventing a path on a drive that is gone.
  assert.equal(lifecycleRoot({ isOwner: true, roots: ["C:\\", "F:\\"], name: "a", kind: "iteration" }), "F:\\Claude Sandbox\\a");
  assert.equal(lifecycleRoot({ isOwner: true, roots: ["C:\\", "Z:\\"], name: "a", kind: "new" }), "Z:\\Apps\\a");
  // Neither present: no opinion at all, so the caller keeps its home-directory path.
  assert.equal(lifecycleRoot({ isOwner: true, roots: ["C:\\"], name: "a", kind: "new" }), "");
  assert.equal(lifecycleRoot({ isOwner: true, roots: [], name: "a" }), "");
});

await t("a nameless request yields no path", () => {
  assert.equal(lifecycleRoot({ isOwner: true, roots: ["F:\\"], name: "" }), "");
});
