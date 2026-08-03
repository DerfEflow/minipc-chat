import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createVideoWorkspace } from "./video-workspace.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "dominion-video-workspace-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = { dir, uploads: join(dir, "media", "uploads"), generated: join(dir, "media", "generated"), exports: join(dir, "media", "exports"), renders: join(dir, "media", "renders") };
  for (const path of Object.values(paths).slice(1)) mkdirSync(path, { recursive: true });
  const state = { settings: { platform: "YouTube", ratio: "16:9" }, jobs: [], timeline: { videoTracks: [1, 2, 3].map((n) => ({ id: `v${n}`, kind: "video", clips: [] })), audioTracks: [1, 2, 3, 4].map((n) => ({ id: `a${n}`, kind: "audio", clips: [] })) } };
  const exports = []; const feature = { getProject: () => structuredClone(state), recordExport: (...args) => exports.push(args) };
  return { dir, paths, state, exports, feature };
}

test("raw project imports are size-limited, project-local, and ffprobe verified", async (t) => {
  const f = fixture(t); const verified = [];
  const workspace = createVideoWorkspace({ feature: f.feature, processor: { verify: async (input) => { verified.push(input); return { duration: 2, video: [{}], audio: [{}] }; }, exportTimeline: async () => ({}) } });
  const req = Readable.from([Buffer.from("video-bytes")]); req.headers = { "content-length": "11" };
  const result = await workspace.importUpload({ req, tenantId: "a", projectId: "p", filename: "My clip.mp4", projectPaths: f.paths });
  assert.equal(result.bytes, 11); assert.equal(result.hasVideo, true); assert.equal(result.hasAudio, true); assert.match(result.filename, /^My-clip-.*\.mp4$/); assert.equal(verified.length, 1); assert.equal(verified[0].projectRoot, f.dir); assert.equal(verified[0].requireVideo, false);
});

test("timeline export resolves saved media, separates audio, and records a verified render", async (t) => {
  const f = fixture(t); const file = join(f.paths.uploads, "source.mp4"); writeFileSync(file, "fixture");
  f.state.timeline.videoTracks[0].clips.push({ id: "vclip", name: "Picture", mediaFile: "source.mp4", start: 0, sourceStart: 1, duration: 4, fit: "cover" });
  f.state.timeline.audioTracks[0].clips.push({ id: "aclip", name: "Sound", mediaFile: "source.mp4", start: 0, sourceStart: 1, duration: 4, volume: .8 });
  f.feature.getProject = () => structuredClone(f.state); const calls = [];
  const workspace = createVideoWorkspace({ feature: f.feature, now: () => Date.UTC(2026, 0, 1), processor: { verify: async () => ({ duration: 9, video: [{}], audio: [{}] }), exportTimeline: async (input) => { calls.push(input); writeFileSync(input.output, "render"); return { bytes: 6, encoder: "libx264", dimensions: { width: 1920, height: 1080 } }; } } });
  const result = await workspace.exportProject({ tenantId: "a", projectId: "11111111-1111-4111-8111-111111111111", request: { format: "mp4", platform: "YouTube", ratio: "16:9" }, projectPaths: f.paths });
  assert.equal(result.status, "ready"); assert.equal(calls[0].videoClips[0].sourceStart, 1); assert.equal(calls[0].audioClips[0].volume, .8); assert.equal(calls[0].quality, "maximum"); assert.equal(f.exports.length, 1); assert.match(result.url, /api\/video\/media/);
});

test("export rejects client clips whose durable source is missing", async (t) => {
  const f = fixture(t); f.state.timeline.videoTracks[0].clips.push({ id: "missing", name: "Missing", mediaFile: "gone.mp4", start: 0, duration: 1 }); f.feature.getProject = () => structuredClone(f.state);
  const workspace = createVideoWorkspace({ feature: f.feature, processor: { verify: async () => ({ video: [{}], audio: [] }), exportTimeline: async () => ({}) } });
  await assert.rejects(workspace.exportProject({ tenantId: "a", projectId: "p", request: {}, projectPaths: f.paths }), (error) => error.code === "video_export_source_missing");
});

test("export accepts an audio-only source on an audio track while retaining video-track validation", async (t) => {
  const f = fixture(t); writeFileSync(join(f.paths.uploads, "picture.mp4"), "fixture"); writeFileSync(join(f.paths.uploads, "music.mp3"), "fixture");
  f.state.timeline.videoTracks[0].clips.push({ id: "picture", mediaFile: "picture.mp4", start: 0, duration: 2 });
  f.state.timeline.audioTracks[0].clips.push({ id: "music", mediaFile: "music.mp3", start: 0, duration: 2 });
  const verifies = []; const workspace = createVideoWorkspace({ feature: f.feature, processor: {
    verify: async (input) => { verifies.push(input); return input.path.endsWith("music.mp3") ? { duration: 2, video: [], audio: [{}] } : { duration: 2, video: [{}], audio: [] }; },
    exportTimeline: async (input) => { writeFileSync(input.output, "render"); return { bytes: 6, encoder: "libx264", dimensions: {} }; },
  } });
  const result = await workspace.exportProject({ tenantId: "a", projectId: "p", request: {}, projectPaths: f.paths });
  assert.equal(result.status, "ready"); assert.ok(verifies.every((call) => call.requireVideo === false));
});

test("uploads receive a project quota budget and concurrent exports are explicitly rejected", async (t) => {
  const f = fixture(t); f.feature.storageBudget = () => ({ remainingBytes: 2, quotaBytes: 2, usedBytes: 0 });
  const upload = createVideoWorkspace({ feature: f.feature, processor: { verify: async () => ({ duration: 1, video: [], audio: [{}] }), exportTimeline: async () => ({}) } });
  const req = Readable.from([Buffer.from("abc")]); req.headers = { "content-length": "3" };
  await assert.rejects(upload.importUpload({ req, tenantId: "a", projectId: "p", filename: "audio.mp3", projectPaths: f.paths }), (error) => error.code === "video_storage_quota_exceeded" && error.status === 507);

  delete f.feature.storageBudget; const source = join(f.paths.uploads, "source.mp4"); writeFileSync(source, "fixture"); f.state.timeline.videoTracks[0].clips.push({ id: "v", mediaFile: "source.mp4", start: 0, duration: 1 });
  let release; const workspace = createVideoWorkspace({ feature: f.feature, processor: { verify: async () => ({ duration: 1, video: [{}], audio: [] }), exportTimeline: async (input) => new Promise((resolve) => { release = () => { writeFileSync(input.output, "render"); resolve({ bytes: 6, encoder: "libx264", dimensions: {} }); }; }) } });
  const first = workspace.exportProject({ tenantId: "a", projectId: "p", request: {}, projectPaths: f.paths }); await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(workspace.exportProject({ tenantId: "a", projectId: "p", request: {}, projectPaths: f.paths }), (error) => error.code === "video_export_in_progress"); release(); assert.equal((await first).status, "ready");
});

test("a failed export record removes the verified final file", async (t) => {
  const f = fixture(t); const source = join(f.paths.uploads, "source.mp4"); writeFileSync(source, "fixture");
  f.state.timeline.videoTracks[0].clips.push({ id: "v", mediaFile: "source.mp4", start: 0, duration: 1 });
  f.feature.recordExport = () => { throw new Error("project checkpoint unavailable"); };
  let output;
  const workspace = createVideoWorkspace({ feature: f.feature, processor: {
    verify: async () => ({ duration: 1, video: [{}], audio: [] }),
    exportTimeline: async (input) => { output = input.output; writeFileSync(output, "render"); return { bytes: 6, encoder: "libx264", dimensions: {} }; },
  } });
  await assert.rejects(workspace.exportProject({ tenantId: "a", projectId: "p", request: {}, projectPaths: f.paths }), /checkpoint unavailable/);
  assert.equal(existsSync(output), false);
});
