import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIO_TRACK_LIMIT, SOCIAL_PRESETS, VIDEO_TRACK_LIMIT, assertPathInside, buildAudioPeakCommand, buildContactSheetCommand,
  buildDiagnosticsCommands, buildExportPlan, buildExtractAudioCommand, buildProxyCommand, buildThumbnailCommand,
  buildTimelineFiltergraph, chooseVideoEncoder, createVideoMediaProcessor, detectMediaCapabilities, escapeFilterValue, isPathInside, parseAudioPeakData,
  parseDiagnostics, probeMedia, runProcess, socialPreset,
} from "./video-media.mjs";

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (error) { failed++; console.error(`FAIL  ${name}\n      ${error.stack || error}`); } }
const caps = { encoders: { h264_nvenc: false, h264_qsv: false, h264_amf: false, libx264: true, aac: true, libopus: true, libvpx_vp9: true, libsvtav1: true, pcm_s16le: true } };

await test("social presets include every promised destination", () => {
  for (const key of ["youtube", "youtube_shorts", "tiktok", "instagram_reels", "instagram_stories", "instagram_square", "instagram_portrait", "facebook", "x", "linkedin", "pinterest", "snapchat", "generic_16_9", "generic_9_16"]) assert.ok(SOCIAL_PRESETS[key], key);
  assert.equal(socialPreset("tiktok").height, 1920); assert.throws(() => socialPreset("nope"));
});
await test("project containment rejects sibling-prefix and traversal paths", () => { assert.ok(isPathInside("C:/projects/a", "C:/projects/a/media/x.mp4")); assert.ok(!isPathInside("C:/projects/a", "C:/projects/ab/x.mp4")); assert.throws(() => assertPathInside("C:/projects/a", "C:/projects/a/../secret.mp4")); });
await test("filter escaping treats separators as filter data", () => { assert.equal(escapeFilterValue("a:b,c'[x]\\y"), "a\\:b\\,c\\'\\[x\\]\\\\y"); });
await test("utility command builders are argv-only and project constrained", () => {
  const root = "C:/project"; const proxy = buildProxyCommand({ input: "C:/project/in.mp4", output: "C:/project/proxy.mp4", projectRoot: root });
  assert.equal(proxy.command, "ffmpeg"); assert.ok(proxy.args.includes("-vf")); assert.ok(!proxy.args.join(" ").includes(";"));
  assert.ok(buildExtractAudioCommand({ input: "C:/project/in.mp4", output: "C:/project/a.wav", projectRoot: root }).args.includes("pcm_s16le"));
  assert.ok(buildThumbnailCommand({ input: "C:/project/in.mp4", output: "C:/project/t.jpg", projectRoot: root }).args.includes("-frames:v"));
  assert.ok(buildContactSheetCommand({ input: "C:/project/in.mp4", output: "C:/project/c.jpg", duration: 12, projectRoot: root }).args.join(" ").includes("tile=4x3"));
  assert.ok(buildAudioPeakCommand({ input: "C:/project/in.mp4", projectRoot: root }).args.includes("astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-"));
  assert.throws(() => buildProxyCommand({ input: "C:/outside.mp4", output: "C:/project/o.mp4", projectRoot: root }));
});
await test("diagnostic and audio parsers return structured facts", () => {
  const diagnostics = buildDiagnosticsCommands({ input: "C:/project/in.mp4", projectRoot: "C:/project" }); assert.equal(diagnostics.length, 3);
  assert.deepEqual(parseDiagnostics("black_start:1 black_end:2 black_duration:1\nsilence_start: 3\nfreeze_start: 4"), { black: [{ start: 1, end: 2, duration: 1 }], freeze: [4], silence: [3] });
  assert.deepEqual(parseAudioPeakData("lavfi.astats.Overall.Peak_level=-4.2\nPeak_level=-inf"), { peaksDb: [-4.2, -Infinity], maxDb: -4.2, silent: false });
});
await test("timeline enforces 3 video/4 audio tracks and deterministic layer maps", () => {
  const graph = buildTimelineFiltergraph({ width: 1920, height: 1080, duration: 10, videoClips: [{ inputIndex: 0, start: 3, duration: 2 }, { inputIndex: 1, start: 0, duration: 3 }], audioClips: [{ inputIndex: 0, start: 0 }, { inputIndex: 1, start: 2, volume: .5 }] });
  assert.ok(graph.filterComplex.includes("amix=inputs=2")); assert.equal(graph.orderedVideo[0].inputIndex, 1);
  assert.throws(() => buildTimelineFiltergraph({ width: 1, height: 1, videoClips: [{ inputIndex: 0, track: VIDEO_TRACK_LIMIT }] }));
  assert.throws(() => buildTimelineFiltergraph({ width: 1, height: 1, audioClips: [{ inputIndex: 0, track: AUDIO_TRACK_LIMIT }] }));
});
await test("encoder selection is hardware first but never assumes libx264", () => {
  assert.equal(chooseVideoEncoder({ encoders: { h264_nvenc: true, libx264: true } }), "h264_nvenc");
  assert.equal(chooseVideoEncoder({ encoders: { h264_qsv: true } }), "h264_qsv");
  assert.throws(() => chooseVideoEncoder({ encoders: {} }));
});
await test("export plans use temporary output, valid maps, and container codec fallback", () => {
  const plan = buildExportPlan({ inputs: ["C:/project/a.mp4"], videoClips: [{ inputIndex: 0, duration: 2 }], output: "C:/project/render.mp4", preset: "youtube", capabilities: caps, projectRoot: "C:/project" });
  assert.ok(plan.partialOutput.includes(".partial.mp4")); assert.ok(plan.args.includes("-filter_complex")); assert.ok(plan.args.includes("+faststart")); assert.equal(plan.encoder, "libx264");
  const webm = buildExportPlan({ inputs: ["C:/project/a.mp4"], output: "C:/project/render.webm", preset: "youtube", container: "webm", capabilities: caps, projectRoot: "C:/project" }); assert.equal(webm.encoder, "libvpx_vp9");
});
await test("capability detector accepts a mock runner and parses encoders", async () => {
  const seen = []; const runner = async (cmd, args) => { seen.push([cmd, args]); return { stdout: args.includes("-encoders") ? " V..... h264_nvenc\n V..... libx264\n A..... aac\n" : "ffprobe version", stderr: "" }; };
  const d = await detectMediaCapabilities({ env: { FFMPEG_PATH: "custom-ff", FFPROBE_PATH: "custom-probe" }, runner });
  assert.ok(d.ffmpegAvailable && d.ffprobeAvailable && d.encoders.h264_nvenc && d.encoders.aac); assert.equal(seen[0][0], "custom-probe");
});
await test("configured media binary failure falls back to PATH", async () => {
  const runner = async (cmd, args) => { if (cmd.startsWith("stale")) throw new Error("ENOENT"); return { stdout: args.includes("-encoders") ? " V..... libx264\n A..... aac\n" : "ffprobe", stderr: "" }; };
  const d = await detectMediaCapabilities({ env: { FFMPEG_PATH: "stale-ff", FFPROBE_PATH: "stale-probe" }, runner });
  assert.equal(d.ffmpeg, "ffmpeg"); assert.equal(d.ffprobe, "ffprobe"); assert.ok(d.ffmpegAvailable);
});
await test("probe JSON validation works with a mock runner", async () => {
  const good = await probeMedia("C:/project/in.mp4", { projectRoot: "C:/project", runner: async () => ({ stdout: JSON.stringify({ format: { duration: "1.2" }, streams: [{ codec_type: "video" }] }) }) }); assert.equal(good.duration, 1.2);
  await assert.rejects(() => probeMedia("C:/project/in.mp4", { projectRoot: "C:/project", runner: async () => ({ stdout: "not json" }) }));
});
await test("generated output requires video while imports can be verified as audio-only media", async () => {
  const runner = async (command, args) => {
    if (args.includes("-encoders")) return { stdout: " V..... libx264\n A..... aac\n", stderr: "" };
    if (args.includes("-show_streams")) return { stdout: JSON.stringify({ format: { duration: "2" }, streams: [{ codec_type: "audio" }] }), stderr: "" };
    return { stdout: "version", stderr: "" };
  };
  const processor = createVideoMediaProcessor({ runner, env: {} });
  const audio = await processor.verify({ path: "C:/project/audio.mp3", projectRoot: "C:/project", requireVideo: false }); assert.equal(audio.audio.length, 1);
  await assert.rejects(() => processor.verify({ path: "C:/project/audio.mp3", projectRoot: "C:/project" }), (error) => error.code === "INVALID_VIDEO_OUTPUT");
});
await test("failed export verification removes the renamed final output", async () => {
  const root = await mkdtemp(join(tmpdir(), "dominion-video-media-"));
  try {
    const input = join(root, "input.mp4"); const output = join(root, "output.mp4"); await writeFile(input, "source");
    const runner = async (_command, args) => {
      if (args.includes("-encoders")) return { stdout: " V..... libx264\n A..... aac\n", stderr: "" };
      if (args.includes("-show_streams")) return { stdout: JSON.stringify({ format: { duration: "2" }, streams: [{ codec_type: "audio" }] }), stderr: "" };
      if (args.includes("-version")) return { stdout: "version", stderr: "" };
      await writeFile(args.at(-1), "render"); return { stdout: "", stderr: "" };
    };
    const processor = createVideoMediaProcessor({ runner, env: {} });
    await assert.rejects(processor.exportTimeline({ inputs: [input], videoClips: [{ inputIndex: 0, duration: 1 }], audioClips: [], output, preset: "youtube", projectRoot: root, duration: 1 }), (error) => error.code === "INVALID_VIDEO_OUTPUT");
    await assert.rejects(access(output));
  } finally { await rm(root, { recursive: true, force: true }); }
});
await test("an explicit zero-byte download budget rejects before network or partial-file work", async () => {
  const root = await mkdtemp(join(tmpdir(), "dominion-video-zero-budget-")); let fetches = 0;
  try {
    const processor = createVideoMediaProcessor({ fetchImpl: async () => { fetches++; throw new Error("must not fetch"); } });
    await assert.rejects(processor.download({ url: "https://provider.invalid/video.mp4", destination: join(root, "video.mp4"), maxBytes: 0 }), (error) => error.code === "STORAGE_QUOTA_EXCEEDED");
    assert.equal(fetches, 0); await assert.rejects(access(join(root, "video.mp4")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
await test("optional real ffmpeg/ffprobe capability smoke probe", async () => { const d = await detectMediaCapabilities(); assert.equal(typeof d.ffmpegAvailable, "boolean"); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
