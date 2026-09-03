/*
 * video.mjs additions for the video-characters lane: project.characters attachment,
 * scene.characterIds through the normal checkpoint path, applyVisualPlan's characterIds
 * passthrough, and the productions ledger (createProduction/updateProductionScene/getProduction).
 * Mirrors video_test.mjs's own harness conventions (mocked fetch, temp dataDir).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoFeature, VideoFeatureError } from "./video.mjs";

function suite(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dominion-video-characters-"));
  let tick = 0;
  const now = () => Date.UTC(2026, 0, 1, 0, 0, tick++);
  const api = createVideoFeature({ dataDir: dir, now, billingGate: async () => ({ allowed: true }), runwareApiKey: "test-key", fetch: async () => { throw new Error("no network expected"); }, ...overrides });
  return { dir, api };
}
function clean(t) { t.after(() => rmSync(t.context.dir, { recursive: true, force: true })); }
const rev = (api, tenantId, projectId) => api.getClientProject(tenantId, projectId).projectRevision;
function emptyState(project) {
  return {
    project: { id: project.id, name: project.name, model: "google:gemini@omni-flash", purpose: "Campaign", platform: "YouTube", ratio: "16:9", resolution: "720p", format: "mp4", duration: 30 },
    screenplay: "", scenes: [],
    tracks: [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `v${i + 1}`, type: "video", name: `Video ${i + 1}` })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i + 1}`, type: "audio", name: `Audio ${i + 1}` })),
    ], clips: [], ui: { panels: { writer: "regular", board: "regular" }, focus: false, zoom: 1 },
  };
}
const EMPTY_SHA = createHash("sha256").update("").digest("hex");

test("a new project starts with an empty characters attachment list and empty productions ledger", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const p = api.createProject("alice", { name: "Ad" });
  assert.deepEqual(p.characters, []);
  assert.deepEqual(p.productions, []);
  const client = api.getClientProject("alice", p.id);
  assert.deepEqual(client.characters, []);
  assert.deepEqual(client.productions, []);
});

test("setProjectCharacters replaces the attachment list, dedupes, caps at 50, and is tenant-isolated", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const p = api.createProject("alice", { name: "Ad" });
  const saved = api.setProjectCharacters("alice", p.id, [{ id: "char-1", role: "lead" }, "char-2", "char-1"]);
  assert.deepEqual(saved.characters, [{ id: "char-1", role: "lead" }, { id: "char-2", role: null }]);
  assert.throws(() => api.getProject("bob", p.id), VideoFeatureError);
  const tooMany = Array.from({ length: 51 }, (_, i) => `char-${i}`);
  assert.throws(() => api.setProjectCharacters("alice", p.id, tooMany), /at most 50/);
});

test("scenes carry characterIds through the normal checkpoint path", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const p = api.createProject("alice", { name: "Ad" });
  const state = emptyState(p);
  state.scenes.push({ id: "scene_1", title: "Opening", prompt: "Jake on the roof", characterIds: ["char-1", "char-2"] });
  const saved = api.checkpointProject("alice", p.id, { label: "Cast the scene", state, expectedScreenplaySha256: EMPTY_SHA, expectedProjectRevision: rev(api, "alice", p.id) });
  assert.deepEqual(saved.scenes[0].characterIds, ["char-1", "char-2"]);
  // A scene with no characterIds omits the field rather than carrying an empty array forever.
  state.scenes[0].characterIds = [];
  const saved2 = api.checkpointProject("alice", p.id, { label: "Uncast", state, expectedScreenplaySha256: EMPTY_SHA, expectedProjectRevision: rev(api, "alice", p.id) });
  assert.equal(Object.hasOwn(saved2.scenes[0], "characterIds"), false);
});

test("applyVisualPlan carries a resolved characterIds array through from the visual-plan-apply command", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const p = api.createProject("alice", { name: "Ad" });
  api.applyCommand("alice", p.id, { type: "visual.plan.apply", scenes: [{ sceneId: "scene_1", title: "Opening", imagePrompt: "Jake on a roof", characterIds: ["char-1"] }, { sceneId: "scene_2", title: "Two-shot", imagePrompt: "Jake and Mia", characterIds: ["char-1", "char-2"] }] });
  const saved = api.getClientProject("alice", p.id);
  assert.deepEqual(saved.scenes[0].characterIds, ["char-1"]);
  assert.deepEqual(saved.scenes[1].characterIds, ["char-1", "char-2"]);
});

test("isCharacterAttached checks both project.characters and every scene.characterIds, tenant-scoped", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const p1 = api.createProject("alice", { name: "Ad 1" });
  const p2 = api.createProject("alice", { name: "Ad 2" });
  assert.equal(api.isCharacterAttached("alice", "char-1"), false);
  api.setProjectCharacters("alice", p1.id, ["char-1"]);
  assert.equal(api.isCharacterAttached("alice", "char-1"), true);
  assert.equal(api.isCharacterAttached("bob", "char-1"), false);
  // Only via a scene, in the OTHER project, still counts.
  api.setProjectCharacters("alice", p1.id, []);
  api.applyCommand("alice", p2.id, { type: "visual.plan.apply", scenes: [{ sceneId: "scene_1", imagePrompt: "x", characterIds: ["char-9"] }] });
  assert.equal(api.isCharacterAttached("alice", "char-9"), true);
  assert.equal(api.isCharacterAttached("alice", "char-1"), false);
});

test("removeCharacterFromAllProjects detaches a character from every project and every scene tenant-wide", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const p1 = api.createProject("alice", { name: "Ad 1" });
  const p2 = api.createProject("alice", { name: "Ad 2" });
  api.setProjectCharacters("alice", p1.id, ["char-1", "char-2"]);
  api.applyCommand("alice", p2.id, { type: "visual.plan.apply", scenes: [{ sceneId: "scene_1", imagePrompt: "x", characterIds: ["char-1"] }] });
  const result = api.removeCharacterFromAllProjects("alice", "char-1");
  assert.equal(result.touched, 2);
  assert.deepEqual(api.getClientProject("alice", p1.id).characters, [{ id: "char-2", role: null }]);
  assert.deepEqual(api.getClientProject("alice", p2.id).scenes[0].characterIds, []);
  assert.equal(api.isCharacterAttached("alice", "char-1"), false);
});

test("restoring an earlier checkpoint reverts character attachment (creative state) but keeps the productions ledger (operational state)", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const p = api.createProject("alice", { name: "Ad" });
  api.createProduction("alice", p.id, { id: "prod-1", model: "google:gemini@omni-flash", quality: "medium", sceneJobs: [{ sceneId: "scene_1", jobId: "job-1", status: "queued", prompt: "x", duration: 5, ratio: "16:9", resolution: "720p" }] });
  const beforeAttach = rev(api, "alice", p.id);
  api.setProjectCharacters("alice", p.id, ["char-1"]);
  assert.deepEqual(api.getClientProject("alice", p.id).characters, [{ id: "char-1", role: null }]);
  const restored = api.restoreCheckpoint("alice", p.id, beforeAttach, rev(api, "alice", p.id));
  assert.deepEqual(restored.characters, []);
  assert.equal(restored.productions.length, 1);
  assert.equal(restored.productions[0].id, "prod-1");
});

test("createProduction/getProduction/updateProductionScene carry per-scene prompt/duration/mode for the once-only text-fallback retry", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const p = api.createProject("alice", { name: "Ad" });
  api.createProduction("alice", p.id, { id: "prod-1", model: "google:gemini@omni-flash", quality: "medium", sceneJobs: [{ sceneId: "scene_1", jobId: "job-1", status: "queued", mode: "reference", prompt: "Jake on a roof. CHARACTERS: Jake: a foreman.", duration: 5, ratio: "16:9", resolution: "720p" }] });
  const loaded = api.getProduction("alice", p.id, "prod-1");
  assert.equal(loaded.scenes[0].prompt, "Jake on a roof. CHARACTERS: Jake: a foreman.");
  assert.equal(loaded.scenes[0].mode, "reference");
  assert.equal(loaded.scenes[0].textFallbackAttempted, false);
  api.updateProductionScene("alice", p.id, "prod-1", "scene_1", { jobId: "job-2", status: "retrying: consistency degraded", mode: "text", textFallbackAttempted: true });
  const afterFallback = api.getProduction("alice", p.id, "prod-1");
  assert.equal(afterFallback.scenes[0].jobId, "job-2");
  assert.equal(afterFallback.scenes[0].mode, "text");
  assert.equal(afterFallback.scenes[0].textFallbackAttempted, true);
  assert.throws(() => api.getProduction("alice", p.id, "does-not-exist"), (error) => error.code === "video_production_missing" && error.status === 404);
  assert.throws(() => api.updateProductionScene("alice", p.id, "prod-1", "does-not-exist", { status: "x" }), (error) => error.code === "video_production_scene_missing");
});

test("productions ledger is bounded to the most recent 50 entries", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const p = api.createProject("alice", { name: "Ad" });
  for (let i = 0; i < 55; i++) api.createProduction("alice", p.id, { id: `prod-${i}`, model: "google:gemini@omni-flash", quality: "medium", sceneJobs: [] });
  const saved = api.getClientProject("alice", p.id);
  assert.equal(saved.productions.length, 50);
  assert.equal(saved.productions[0].id, "prod-5");
  assert.equal(saved.productions.at(-1).id, "prod-54");
});

test("project settings carry a free-text style field used by /produce's style block", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const p = api.createProject("alice", { name: "Ad" });
  assert.equal(api.getClientProject("alice", p.id).project.style, "");
  const state = emptyState(p); state.project.style = "moody, backlit, 35mm film grain";
  const saved = api.checkpointProject("alice", p.id, { label: "Set style", state, expectedScreenplaySha256: EMPTY_SHA, expectedProjectRevision: rev(api, "alice", p.id) });
  assert.equal(saved.settings.style, "moody, backlit, 35mm film grain");
});
