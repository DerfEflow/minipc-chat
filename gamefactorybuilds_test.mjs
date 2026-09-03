import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGameFactoryBuilds } from "./gamefactorybuilds.mjs";

const dir = mkdtempSync(join(tmpdir(), "gf-builds-"));
const BUILD = "gfb_11111111-2222-3333-4444-555555555555";
const OTHER = "gfb_99999999-2222-3333-4444-555555555555";
const bundle = join(dir, "game-factory", "builds", BUILD, "bundle");
mkdirSync(join(bundle, "game"), { recursive: true });
mkdirSync(join(dir, "game-factory", "builds", BUILD, "qa"), { recursive: true });
writeFileSync(join(bundle, "index.html"), "<title>Vector Vault</title>");
writeFileSync(join(bundle, "game", "rules.js"), "export const meta = {};");
writeFileSync(join(dir, "game-factory", "builds", BUILD, "build.json"), JSON.stringify({ buildId: BUILD, versionName: "0.1.1", bundleSha256: "a".repeat(64), files: [{ path: "index.html" }, { path: "game/rules.js" }], toolchain: { lane: "web-canvas" }, createdAt: "2026-09-03T00:00:00.000Z" }));
writeFileSync(join(dir, "game-factory", "builds", BUILD, "qa", "results.json"), JSON.stringify({ schema: "gf-qa/1", runner: "server-qa", suites: { "core-loop": { status: "PASSED", summary: "ok" }, offline: { status: "FAILED", summary: "fetch( found" } } }));
// A bundle for a build the store does not know about.
mkdirSync(join(dir, "game-factory", "builds", OTHER, "bundle"), { recursive: true });
writeFileSync(join(dir, "game-factory", "builds", OTHER, "bundle", "index.html"), "stranger");

const store = {
  getProject(uid, projectId) {
    if (uid !== "owner" || projectId !== "gf_owner_vector-vault") return null;
    return { id: projectId, activeBuild: { id: BUILD } };
  },
};
const builds = createGameFactoryBuilds({ dataDir: dir, store });
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const ctx = { uid: "owner", projectId: "gf_owner_vector-vault", buildId: BUILD };

test("exists only for a bundle the store binds to the game", () => {
  assert.equal(builds.exists(ctx), true);
  assert.equal(builds.exists({ ...ctx, buildId: OTHER }), false, "a stranger's bundle is not this game's build");
  assert.equal(builds.exists({ ...ctx, projectId: "gf_owner_bolt-bloom" }), false);
  assert.equal(builds.exists({ ...ctx, uid: "guest" }), false);
});
test("resolveFile serves bundle files with the right MIME and refuses escapes", () => {
  const index = builds.resolveFile({ ...ctx, relPath: "index.html" });
  assert.ok(index && index.mime.startsWith("text/html") && index.size > 0);
  assert.equal(builds.resolveFile({ ...ctx, relPath: "" }).mime, index.mime, "empty path is index.html");
  assert.equal(builds.resolveFile({ ...ctx, relPath: "game/rules.js" }).mime, "text/javascript; charset=utf-8");
  for (const bad of ["../build.json", "..\\build.json", "game/../../build.json", "/etc/passwd", "game//rules.js", ".hidden", "game/.secret", "missing.js", "game"]) {
    assert.equal(builds.resolveFile({ ...ctx, relPath: bad }), null, `refused: ${bad}`);
  }
  assert.equal(builds.resolveFile({ ...ctx, buildId: OTHER, relPath: "index.html" }), null);
  assert.equal(builds.resolveFile({ ...ctx, buildId: "../../connectors", relPath: "google-oauth.json" }), null);
});
test("summary tallies the QA results against the build record", () => {
  const s = builds.summary(ctx);
  assert.equal(s.versionName, "0.1.1");
  assert.equal(s.status, "TESTED", "QA results on disk outrank a PLANNED store status");
  assert.equal(s.fileCount, 2);
  assert.equal(s.playable, true);
  assert.deepEqual([s.qa.passed, s.qa.failed, s.qa.total], [1, 1, 2]);
  assert.deepEqual(s.qa.failedSuites, ["offline"]);
  assert.equal(builds.summary({ ...ctx, buildId: OTHER }), null);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} gamefactorybuilds tests passed.`);
