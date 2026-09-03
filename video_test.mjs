import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVideoFeature, VideoFeatureError, validateVideoRequest, compileRunwareTask,
  parseRunwareEnvelope, classifyVideoRetry, directorCompactionNeeded,
} from "./video.mjs";

const validRequest = (overrides = {}) => ({ model: "google:gemini@omni-flash", mode: "text", prompt: "A quiet sunrise over the mountains", duration: 5, ratio: "16:9", resolution: "720p", ...overrides });
function providerResponse(task) {
  return task.taskType === "getResponse"
    ? { data: [{ taskType: "videoInference", taskUUID: task.taskUUID, status: "success", progress: 100, videoUUID: "video-1", videoURL: "https://provider.invalid/output.mp4", cost: 0.18, outputs: { videoId: "continuation-1" } }] }
    : { data: [{ taskType: "videoInference", taskUUID: task.taskUUID, status: "processing", progress: 2 }] };
}
function suite(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dominion-video-")); let tick = 0;
  const now = () => Date.UTC(2026, 0, 1, 0, 0, tick++);
  const calls = [];
  const fetch = async (url, options = {}) => {
    const payload = JSON.parse(options.body); calls.push({ url: String(url), options, payload });
    return new Response(JSON.stringify(providerResponse(payload[0])), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { dir, calls, api: createVideoFeature({ dataDir: dir, now, billingGate: async () => ({ allowed: true }), runwareApiKey: "test-key", fetch, ...overrides }) };
}
function clean(t) { t.after(() => rmSync(t.context.dir, { recursive: true, force: true })); }
const currentProjectRevision = (api, tenantId, projectId) => api.getClientProject(tenantId, projectId).projectRevision;
function emptyClientState(project) {
  return {
    project: { id: project.id, name: project.name, model: "google:gemini@omni-flash", purpose: "Campaign", platform: "YouTube", ratio: "16:9", resolution: "720p", format: "mp4", duration: 30 },
    screenplay: "", scenes: [],
    tracks: [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `v${i + 1}`, type: "video", name: `Video ${i + 1}` })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i + 1}`, type: "audio", name: `Audio ${i + 1}` })),
    ], clips: [], ui: { panels: { writer: "regular", board: "regular" }, focus: false, zoom: 1 },
  };
}

test("CRUD and full checkpoints are tenant-safe and deletion is explicit", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const p = api.createProject("alice", { name: "Film" });
  assert.equal(api.listProjects("alice").length, 1); assert.equal(api.listProjects("bob").length, 0);
  const payload = emptyClientState(p); payload.scenes.push({ id: "scene_1", title: "Opening", prompt: "Wind across grass" }); payload.screenplay = "FADE IN. Wind moves through the field.";
  const emptyHash = createHash("sha256").update("").digest("hex");
  assert.throws(() => api.checkpointProject("alice", p.id, { label: "Missing revision", state: payload, expectedProjectRevision: currentProjectRevision(api, "alice", p.id) }), (error) => error.code === "video_screenplay_precondition_required" && error.status === 428);
  const saved = api.checkpointProject("alice", p.id, { label: "Opening drafted", state: payload, expectedScreenplaySha256: emptyHash, expectedProjectRevision: currentProjectRevision(api, "alice", p.id) });
  assert.equal(saved.scenes.length, 1); assert.equal(api.getClientProject("alice", p.id).project.name, "Film");
  assert.equal(api.renameProject("alice", p.id, "New").name, "New"); assert.throws(() => api.deleteProject("alice", p.id), /confirmation/);
  assert.deepEqual(api.deleteProject("alice", p.id, { confirmDelete: true }), { deleted: true, id: p.id });
  assert.throws(() => api.getProject("bob", p.id), VideoFeatureError); assert.throws(() => api.createProject("../escape"), VideoFeatureError);
});

test("history preserves commands, bounded scenes, screenplay tokens, undo and redo", (t) => {
  t.context = suite(); clean(t); const { api } = t.context; const p = api.createProject("a");
  assert.equal(p.ai.screenwriter.model, "arcee-ai/trinity-large-thinking"); assert.equal(Object.hasOwn(p.ai, "palmyra"), false);
  for (let i = 0; i < 100; i++) api.applyCommand("a", p.id, { type: "scene.add", scene: { id: "scene_" + i } });
  assert.throws(() => api.applyCommand("a", p.id, { type: "scene.add", scene: { id: "scene_101" } }), /100 scenes/);
  api.applyCommand("a", p.id, { type: "screenplay.set", text: "one two three" });
  const restarted = createVideoFeature({ dataDir: t.context.dir });
  assert.equal(restarted.undo("a", p.id, currentProjectRevision(restarted, "a", p.id)).screenplay.text, "");
  const restartedAgain = createVideoFeature({ dataDir: t.context.dir });
  assert.equal(restartedAgain.redo("a", p.id, currentProjectRevision(restartedAgain, "a", p.id)).screenplay.text, "one two three");
  assert.throws(() => api.applyCommand("a", p.id, { type: "screenplay.set", text: "x ".repeat(115001) }), /115,000/);
  const paths = api.paths("a", p.id); assert.ok(existsSync(paths.events)); assert.match(readFileSync(paths.events, "utf8"), /command.scene.add/); assert.ok(existsSync(paths.checkpoints));
});

test("legacy Palmyra project state migrates to Trinity and screenplay usage is checkpointed", (t) => {
  t.context = suite(); clean(t); const { api } = t.context; const project = api.createProject("a"); const file = api.paths("a", project.id).state;
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  delete legacy.ai.screenwriter; legacy.ai.palmyra = { model: "writer/palmyra-creative-122b", available: false, state: { priorMarker: "preserved" } };
  writeFileSync(file, JSON.stringify(legacy));
  const restarted = createVideoFeature({ dataDir: t.context.dir });
  const migrated = restarted.getProject("a", project.id);
  assert.equal(migrated.ai.screenwriter.model, "arcee-ai/trinity-large-thinking");
  assert.equal(migrated.ai.screenwriter.contextWindow, 115_000); assert.equal(migrated.ai.screenwriter.reasoning, true);
  assert.equal(migrated.ai.screenwriter.state.priorMarker, "preserved"); assert.equal(Object.hasOwn(migrated.ai, "palmyra"), false);
  restarted.applyCommand("a", project.id, { type: "screenplay.set", text: "FADE IN.", model: "arcee-ai/trinity-large-thinking", generationId: "gen-1", finishReason: "stop", brief: "A private story brief", generatedSections: 1, sessionId: "dominion-video-writer-private", lastTurn: { userContent: "private prompt", content: "FADE IN.", reasoningDetails: [{ type: "reasoning.text", text: "opaque private reasoning" }] }, usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.0000192, completion_tokens_details: { reasoning_tokens: 8 } } });
  const saved = restarted.getProject("a", project.id);
  assert.equal(saved.ai.screenwriter.state.generationId, "gen-1"); assert.equal(saved.ai.screenwriter.state.usage.reasoningTokens, 8); assert.equal(saved.ai.screenwriter.state.usage.costUsd, 0.0000192);
  assert.equal(saved.ai.screenwriter.state.lastTurn.reasoningDetails[0].text, "opaque private reasoning");
  const client = restarted.getClientProject("a", project.id);
  assert.equal(client.ai.screenwriter.state.generatedSections, 1);
  assert.equal(client.ai.screenwriter.state.lastFinishReason, "stop");
  assert.equal(JSON.stringify(client).includes("opaque private reasoning"), false);
  assert.equal(JSON.stringify(client).includes("A private story brief"), false);
  assert.equal(JSON.stringify(client).includes("dominion-video-writer-private"), false);
});

test("screenwriter compare-and-save cannot overwrite a newer screenplay checkpoint", (t) => {
  t.context = suite(); clean(t); const { api } = t.context; const project = api.createProject("a");
  const originalHash = createHash("sha256").update("").digest("hex");
  api.applyCommand("a", project.id, { type: "screenplay.set", text: "USER EDIT SAVED WHILE TRINITY WAS WRITING" });
  assert.throws(() => api.applyCommand("a", project.id, {
    type: "screenplay.set", text: "STALE PROVIDER RESULT", model: "arcee-ai/trinity-large-thinking",
    expectedScreenplaySha256: originalHash, expectedScreenwriterGenerationId: null,
    generationId: "gen-stale", finishReason: "stop", usage: { cost: 0.001 },
  }), (error) => error.code === "screenwriter_stale_write" && error.status === 409);
  assert.equal(api.getProject("a", project.id).screenplay.text, "USER EDIT SAVED WHILE TRINITY WAS WRITING");
});

test("a stale checkpoint hash cannot overwrite a newer server screenplay", (t) => {
  t.context = suite(); clean(t); const { api } = t.context; const project = api.createProject("a");
  const emptyHash = createHash("sha256").update("").digest("hex");
  api.applyCommand("a", project.id, { type: "screenplay.set", text: "NEWER SERVER SCREENPLAY" });
  const stale = emptyClientState(project); stale.screenplay = "STALE BROWSER SCREENPLAY";
  assert.throws(() => api.checkpointProject("a", project.id, {
    label: "Stale browser checkpoint", state: stale, expectedScreenplaySha256: emptyHash, expectedProjectRevision: currentProjectRevision(api, "a", project.id),
  }), (error) => error.code === "video_checkpoint_stale" && error.status === 409);
  assert.equal(api.getProject("a", project.id).screenplay.text, "NEWER SERVER SCREENPLAY");
});

test("provider pre-submit and canonical ledgers block checkpoints only while unresolved", (t) => {
  t.context = suite(); clean(t); const { api } = t.context; const project = api.createProject("a");
  const revision = createHash("sha256").update("").digest("hex"); const state = emptyClientState(project);
  const local = { attemptId: "sw_local_presubmit", generationId: null, status: "provider_submitting", settlement: { status: "awaiting_response", costUsd: 0 }, sourceScreenplaySha256: revision };
  api.applyCommand("a", project.id, { type: "screenwriter.attempt", begin: true, attempt: local });
  assert.throws(() => api.checkpointProject("a", project.id, { state, expectedScreenplaySha256: revision, expectedProjectRevision: currentProjectRevision(api, "a", project.id) }), (error) => error.code === "screenwriter_busy" && error.status === 409);
  api.applyCommand("a", project.id, { type: "screenwriter.attempt", attempt: { ...local, generationId: "gen-correlated", status: "provider_correlated", settlement: { status: "not_billed", costUsd: 0 } } });
  assert.doesNotThrow(() => api.checkpointProject("a", project.id, { state, expectedScreenplaySha256: revision, expectedProjectRevision: currentProjectRevision(api, "a", project.id) }));

  const canonical = { attemptId: "sw_canonical", generationId: "gen-correlated", status: "provider_in_progress", settlement: { status: "awaiting_response", costUsd: 0 }, sourceScreenplaySha256: revision };
  api.applyCommand("a", project.id, { type: "screenwriter.attempt", attempt: canonical });
  assert.throws(() => api.checkpointProject("a", project.id, { state, expectedScreenplaySha256: revision, expectedProjectRevision: currentProjectRevision(api, "a", project.id) }), (error) => error.code === "screenwriter_busy");
  api.applyCommand("a", project.id, { type: "screenwriter.attempt", attempt: { ...canonical, status: "provider_contract_rejected", settlement: { status: "not_billed", costUsd: 0 } } });
  assert.doesNotThrow(() => api.checkpointProject("a", project.id, { state, expectedScreenplaySha256: revision, expectedProjectRevision: currentProjectRevision(api, "a", project.id) }));
  assert.equal(JSON.stringify(api.getClientProject("a", project.id)).includes("sw_local_presubmit"), false);
});

test("canonical Trinity success atomically supersedes the local submission and unlocks checkpoints", (t) => {
  t.context = suite(); clean(t); const { api } = t.context; const project = api.createProject("a");
  const revision = createHash("sha256").update("").digest("hex");
  const local = { attemptId: "sw_local_atomic", generationId: null, status: "provider_submitting", sourceScreenplaySha256: revision, sourceGenerationId: null, settlement: { status: "awaiting_response", costUsd: 0 } };
  const canonical = { attemptId: "sw_canonical_atomic", generationId: "gen-atomic", status: "provider_in_progress", sourceScreenplaySha256: revision, sourceGenerationId: null, settlement: { status: "awaiting_response", costUsd: 0 } };
  api.applyCommand("a", project.id, { type: "screenwriter.attempt", begin: true, attempt: local });
  api.applyCommand("a", project.id, { type: "screenwriter.attempt", attempt: canonical, supersedeAttemptId: local.attemptId });
  let stored = api.getProject("a", project.id).providerAttempts;
  assert.equal(stored.find((item) => item.attemptId === local.attemptId).status, "provider_correlated");
  assert.equal(stored.find((item) => item.attemptId === canonical.attemptId).status, "provider_in_progress");
  api.applyCommand("a", project.id, { type: "screenwriter.attempt", attempt: { ...canonical, status: "provider_accepted", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 }, settlement: { status: "settled", costUsd: 0.001 } } });
  api.applyCommand("a", project.id, { type: "screenplay.set", text: "EXT. HARBOR - DAWN", model: "arcee-ai/trinity-large-thinking", generationId: "gen-atomic", attemptId: canonical.attemptId, expectedScreenplaySha256: revision, expectedScreenwriterGenerationId: null, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 }, settlement: { status: "settled", costUsd: 0.001 } });
  stored = api.getProject("a", project.id).providerAttempts;
  assert.equal(stored.find((item) => item.attemptId === local.attemptId).status, "provider_correlated");
  assert.equal(stored.find((item) => item.attemptId === canonical.attemptId).status, "applied");
  const state = emptyClientState(project); state.screenplay = "EXT. HARBOR - DAWN";
  assert.doesNotThrow(() => api.checkpointProject("a", project.id, { label: "post-Trinity checkpoint", state, expectedScreenplaySha256: createHash("sha256").update(state.screenplay).digest("hex"), expectedProjectRevision: currentProjectRevision(api, "a", project.id) }));
});

test("valid large Trinity recovery candidates fit the bounded durable ledger", (t) => {
  t.context = suite(); clean(t); const { api } = t.context; const project = api.createProject("a");
  const revision = createHash("sha256").update("").digest("hex");
  const large = "界".repeat(450_000), brief = "語".repeat(150_000);
  const attempt = { attemptId: "sw_large_candidate", generationId: "gen-large-candidate", status: "provider_accepted", sourceScreenplaySha256: revision, sourceGenerationId: null, usage: { cost: 0.01 }, settlement: { status: "pending", costUsd: 0.01 }, candidate: { text: large, brief, generatedSections: 1, lastTurn: { userContent: "brief", content: "section" }, finishReason: "stop" } };
  assert.ok(Buffer.byteLength(JSON.stringify(attempt.candidate), "utf8") > 1_750_000);
  assert.doesNotThrow(() => api.applyCommand("a", project.id, { type: "screenwriter.attempt", attempt }));
  assert.equal(api.getProject("a", project.id).providerAttempts.at(-1).candidate.text.length, large.length);
});

test("load repairs state from an atomic checkpoint written ahead of project.json", (t) => {
  t.context = suite(); clean(t); const { api, dir } = t.context; const project = api.createProject("a");
  const revision = createHash("sha256").update("").digest("hex");
  const local = { attemptId: "sw_local_crash", generationId: null, status: "provider_submitting", sourceScreenplaySha256: revision, sourceGenerationId: null, settlement: { status: "awaiting_response", costUsd: 0 } };
  api.applyCommand("a", project.id, { type: "screenwriter.attempt", begin: true, attempt: local });
  const beforeCanonical = readFileSync(api.paths("a", project.id).state, "utf8");
  const canonical = { attemptId: "sw_canonical_crash", generationId: "gen-crash-recovery", status: "provider_in_progress", sourceScreenplaySha256: revision, sourceGenerationId: null, settlement: { status: "awaiting_response", costUsd: 0 } };
  api.applyCommand("a", project.id, { type: "screenwriter.attempt", attempt: canonical, supersedeAttemptId: local.attemptId });
  writeFileSync(api.paths("a", project.id).state, beforeCanonical, "utf8");
  const restarted = createVideoFeature({ dataDir: dir, minFreeDiskBytes: 0 });
  const recovered = restarted.getProject("a", project.id);
  assert.equal(recovered.providerAttempts.find((item) => item.attemptId === local.attemptId).status, "provider_correlated");
  assert.equal(recovered.providerAttempts.find((item) => item.attemptId === canonical.attemptId).generationId, "gen-crash-recovery");
  assert.equal(JSON.parse(readFileSync(restarted.paths("a", project.id).state, "utf8")).history.head, recovered.history.head);
});

test("project revision CAS rejects a stale whole-project checkpoint", (t) => {
  t.context = suite(); clean(t); const { api } = t.context; const project = api.createProject("a");
  const client = api.getClientProject("a", project.id); const staleRevision = client.projectRevision;
  api.applyCommand("a", project.id, { type: "scene.add", scene: { id: "server_scene", title: "Server scene" } });
  assert.throws(() => api.checkpointProject("a", project.id, { state: client, expectedScreenplaySha256: client.screenplaySha256, expectedProjectRevision: staleRevision }), (error) => error.code === "video_project_revision_stale" && error.status === 409);
  assert.equal(api.getProject("a", project.id).scenes[0].id, "server_scene");
});

test("an AI turn atomically applies a matching visual plan and quarantines a stale plan without losing conversation", (t) => {
  t.context = suite(); clean(t); const { api } = t.context; const project = api.createProject("a");
  const firstRevision = currentProjectRevision(api, "a", project.id);
  const first = api.updateAiState("a", project.id, {
    expectedProjectRevision: firstRevision,
    director: { model: "deepseek-ai/deepseek-v4-pro", directive: "Open on the harbor.", usage: { total_tokens: 12 } },
    visualOrchestrator: { model: "nvidia/nemotron-3-ultra-550b-a55b", available: true, plan: { scenes: [{ sceneId: "ai_opening", imagePrompt: "A harbor at blue hour" }] } },
    liaison: { model: "claude-sonnet-5", reply: "The harbor opening is saved." },
    visualPlanScenes: [{ sceneId: "ai_opening", title: "Harbor", imagePrompt: "A harbor at blue hour", videoPrompt: "Slow crane down" }],
    conversation: { at: "2026-01-01T00:00:00.000Z", user: "Open on the harbor", reply: "The harbor opening is saved." },
  });
  assert.equal(first.history.head, firstRevision + 1);
  assert.equal(first.scenes[0].id, "ai_opening");
  assert.equal(first.ai.visualOrchestrator.state.applyStatus, "applied");
  assert.deepEqual(first.conversation.map((message) => message.content), ["Open on the harbor", "The harbor opening is saved."]);
  assert.equal(api.listCheckpoints("a", project.id)[0].type, "ai.turn");

  const staleRevision = currentProjectRevision(api, "a", project.id);
  api.applyCommand("a", project.id, { type: "scene.add", scene: { id: "newer_user_scene", title: "Newer user edit", prompt: "Do not overwrite" } });
  const newerScenes = structuredClone(api.getProject("a", project.id).scenes);
  const beforeStaleTurn = currentProjectRevision(api, "a", project.id);
  const stale = api.updateAiState("a", project.id, {
    expectedProjectRevision: staleRevision,
    director: { model: "deepseek-ai/deepseek-v4-pro", directive: "Replace the storyboard.", usage: { total_tokens: 7 } },
    visualOrchestrator: { model: "nvidia/nemotron-3-ultra-550b-a55b", available: true, plan: { scenes: [{ sceneId: "stale_ai_scene", imagePrompt: "A stale replacement" }] } },
    liaison: { model: "claude-sonnet-5", reply: "The plan is preserved but not applied." },
    visualPlanScenes: [{ sceneId: "stale_ai_scene", imagePrompt: "A stale replacement" }],
    conversation: { at: "2026-01-01T00:00:01.000Z", user: "Replace it", reply: "The plan is preserved but not applied." },
  });
  assert.equal(stale.history.head, beforeStaleTurn + 1);
  assert.deepEqual(stale.scenes, newerScenes);
  assert.equal(stale.ai.visualOrchestrator.state.applyStatus, "quarantined_stale");
  assert.equal(stale.ai.visualOrchestrator.state.plan.scenes[0].sceneId, "stale_ai_scene");
  assert.equal(stale.ai.director.state.directive, "Replace the storyboard.");
  assert.equal(stale.ai.liaison.state.reply, "The plan is preserved but not applied.");
  assert.deepEqual(stale.conversation.slice(-2).map((message) => message.content), ["Replace it", "The plan is preserved but not applied."]);
  assert.equal(api.listCheckpoints("a", project.id)[0].type, "ai.turn");
});

test("history and deletion cannot erase provider work or evade settlement", async (t) => {
  t.context = suite({ mediaProcessor: { download: async () => ({ bytes: 1 }), verify: async () => ({ valid: true, duration: 5, video: [{}], audio: [] }) } }); clean(t); const { api } = t.context; const project = api.createProject("a");
  const firstCheckpoint = api.listCheckpoints("a", project.id).at(-1).seq;
  const submitted = await api.submitGeneration("a", project.id, validRequest({ idempotencyKey: "retained-job" }));
  assert.equal(api.recoverJobs("a", project.id).length, 1);
  api.undo("a", project.id, currentProjectRevision(api, "a", project.id)); api.undo("a", project.id, currentProjectRevision(api, "a", project.id));
  assert.equal(api.recoverJobs("a", project.id)[0].id, submitted.jobId);
  api.redo("a", project.id, currentProjectRevision(api, "a", project.id));
  assert.equal(api.recoverJobs("a", project.id)[0].id, submitted.jobId);
  api.restoreCheckpoint("a", project.id, firstCheckpoint, currentProjectRevision(api, "a", project.id));
  assert.equal(api.recoverJobs("a", project.id)[0].id, submitted.jobId);
  assert.throws(() => api.deleteProject("a", project.id, { confirmDelete: true }), (error) => error.code === "video_job_in_progress" && error.status === 409);
  const ready = await api.pollJob("a", project.id, submitted.jobId); assert.equal(ready.status, "ready");
  assert.throws(() => api.deleteProject("a", project.id, { confirmDelete: true }), (error) => error.code === "video_job_in_progress");
  api.markJobSettled("a", project.id, submitted.jobId, { settlementKey: "paid", costUsd: ready.cost });
  assert.equal(api.recoverJobs("a", project.id)[0].id, submitted.jobId);
  assert.throws(() => api.deleteProject("a", project.id, { confirmDelete: true }), (error) => error.code === "video_job_in_progress");
  await api.downloadJobOutput("a", project.id, submitted.jobId);
  assert.deepEqual(api.deleteProject("a", project.id, { confirmDelete: true }), { deleted: true, id: project.id });
});

test("tenant project, temporary-job, aggregate-storage, and disk-reserve limits are enforced", (t) => {
  t.context = suite({ maxProjectsPerTenant: 2, minFreeDiskBytes: 0 }); clean(t); const { api } = t.context;
  api.createProject("a", { name: "One" }); api.createProject("a", { name: "Two" });
  assert.throws(() => api.createProject("a", { name: "Three" }), (error) => error.code === "video_project_limit");
  assert.doesNotThrow(() => api.createProject("b", { name: "Separate tenant" }));

  const tempRoot = join(t.context.dir, "temporary");
  const temporary = createVideoFeature({ dataDir: tempRoot, maxProjectsPerTenant: 5, minFreeDiskBytes: 0 });
  temporary.createProject("mobile", { temporary: true });
  assert.throws(() => temporary.createProject("mobile", { temporary: true }), (error) => error.code === "video_mobile_generation_in_progress");

  const aggregateRoot = join(t.context.dir, "aggregate");
  const aggregate = createVideoFeature({ dataDir: aggregateRoot, storageQuotaBytes: 64 * 1024 * 1024, tenantStorageQuotaBytes: 64 * 1024 * 1024, minFreeDiskBytes: 0 });
  const first = aggregate.createProject("a"); const second = aggregate.createProject("a");
  const large = join(aggregate.paths("a", first.id).generated, "large.mp4"); writeFileSync(large, ""); truncateSync(large, 40 * 1024 * 1024);
  assert.throws(() => aggregate.storageBudget("a", second.id, 30 * 1024 * 1024), (error) => error.code === "video_tenant_storage_quota_exceeded");

  const diskRoot = join(t.context.dir, "disk-reserve");
  const diskLimited = createVideoFeature({ dataDir: diskRoot, minFreeDiskBytes: Number.MAX_SAFE_INTEGER });
  assert.throws(() => diskLimited.createProject("a"), (error) => error.code === "video_disk_space_low" && error.status === 507);
});

test("mobile one-off jobs remain discoverable after a server or browser restart", async (t) => {
  const mediaProcessor = { download: async () => ({ bytes: 1 }), verify: async () => ({ valid: true, duration: 5, video: [{}], audio: [] }) };
  t.context = suite({ mediaProcessor }); clean(t); const project = t.context.api.createProject("mobile", { temporary: true });
  const submitted = await t.context.api.submitGeneration("mobile", project.id, validRequest({ idempotencyKey: "mobile-recovery" }));
  const ready = await t.context.api.pollJob("mobile", project.id, submitted.jobId); t.context.api.markJobSettled("mobile", project.id, submitted.jobId, { settlementKey: "paid", costUsd: ready.cost });
  const restarted = createVideoFeature({ dataDir: t.context.dir, now: () => Date.UTC(2026, 0, 1, 0, 5), runwareApiKey: "test-key", billingGate: async () => ({ allowed: true }), fetch: async () => { throw new Error("poll not requested"); }, mediaProcessor });
  const jobs = restarted.recoverTemporaryJobs("mobile"); assert.equal(jobs.length, 1); assert.equal(jobs[0].id, submitted.jobId); assert.equal(jobs[0].projectId, project.id); assert.equal(jobs[0].singleGeneration, true);
  assert.throws(() => restarted.deleteProject("mobile", project.id, { confirmDelete: true }), (error) => error.code === "video_job_in_progress");
  await restarted.downloadJobOutput("mobile", project.id, submitted.jobId); assert.equal(restarted.recoverTemporaryJobs("mobile").length, 1);
  restarted.markJobDelivered("mobile", project.id, submitted.jobId); assert.equal(restarted.recoverTemporaryJobs("mobile").length, 0);
  assert.deepEqual(restarted.deleteProject("mobile", project.id, { confirmDelete: true }), { deleted: true, id: project.id });
});

test("model validation and Runware compilation honor documented constraints", () => {
  const omni = compileRunwareTask(validRequest(), "11111111-1111-4111-8111-111111111111");
  assert.equal(omni.width, 1280); assert.equal(omni.height, 720); assert.equal(omni.positivePrompt, "A quiet sunrise over the mountains");
  for (const appField of ["mode", "ratio", "images", "audio", "generateAudio"]) assert.ok(!Object.hasOwn(omni, appField));
  assert.equal(omni.deliveryMethod, "async"); assert.equal(omni.includeCost, true); assert.equal(omni.outputFormat, "MP4");

  const seedance = compileRunwareTask(validRequest({ model: "bytedance:seedance@2.0", mode: "image", duration: 15, resolution: "4k", ratio: "21:9", frameImages: ["asset:first", "asset:last"], generateAudio: false }), "22222222-2222-4222-8222-222222222222");
  assert.equal(seedance.resolution, "4k"); assert.deepEqual(seedance.inputs.frameImages, ["asset:first", "asset:last"]); assert.deepEqual(seedance.settings, { audio: false }); assert.ok(!Object.hasOwn(seedance, "width"));
  const kling = validateVideoRequest(validRequest({ model: "klingai:kling-video@3.0-turbo", prompt: "Six-shot city reveal", duration: 15, resolution: "1080p" })); assert.equal(kling.duration, 15);
  const grok = validateVideoRequest(validRequest({ model: "xai:grok-imagine@video-1.5", mode: "image", prompt: "Move", duration: 1, ratio: "3:2", resolution: "1080p", frameImages: ["asset:frame"] })); assert.equal(grok.ratio, "3:2");

  assert.throws(() => validateVideoRequest(validRequest({ duration: 2 })), /3 to 10/);
  assert.throws(() => validateVideoRequest(validRequest({ model: "bytedance:seedance@2.0", duration: 4, frameImages: ["a"], referenceImages: ["b"] })), /cannot be combined/);
  assert.throws(() => validateVideoRequest(validRequest({ model: "xai:grok-imagine@video-1.5", mode: "text", duration: 5 })), /does not support/);
  assert.throws(() => validateVideoRequest(validRequest({ model: "xai:grok-imagine@video-1.5", mode: "image", duration: 5, frameImages: ["asset:frame"], referenceImages: ["asset:reference"] })), /cannot be combined/);
  assert.throws(() => validateVideoRequest(validRequest({ model: "klingai:kling-video@3.0-turbo", prompt: "ok", duration: 4 })), /prompt length/);
});

test("Runware submission and polling use one array-based async endpoint and persist final facts", async (t) => {
  const downloads = [];
  t.context = suite({ mediaProcessor: { download: async (args) => { downloads.push(args); return { bytes: 42 }; }, verify: async () => ({ valid: true }) } }); clean(t);
  const { api, calls } = t.context; const p = api.createProject("a"); const submitted = await api.submitGeneration("a", p.id, validRequest());
  assert.equal(calls[0].url, "https://api.runware.ai/v1"); assert.equal(calls[0].options.method, "POST"); assert.ok(Array.isArray(calls[0].payload)); assert.equal(calls[0].payload[0].taskType, "videoInference");
  const job = await api.pollJob("a", p.id, submitted.jobId); assert.equal(calls[1].payload[0].taskType, "getResponse"); assert.equal(calls[1].payload[0].taskUUID, submitted.jobId);
  assert.equal(job.status, "ready"); assert.equal(job.output, "https://provider.invalid/output.mp4"); assert.equal(job.videoUUID, "video-1"); assert.equal(job.videoId, "continuation-1"); assert.equal(job.cost, 0.18);
  const saved = await api.downloadJobOutput("a", p.id, submitted.jobId); assert.match(saved.localOutput, /media[\\/]generated/); assert.equal(downloads.length, 1);
});

/*
 * Required behavior #4 (stabilize 2026-09-03): a mid-poll transport outage (network error, not a
 * task-level result) must not lose the job or charge it twice. The job stays "retrying" through the
 * outage and recovers cleanly once the provider answers again - the same durable job id polled
 * throughout, never resubmitted as a fresh paid task.
 */
test("a mid-poll transport outage keeps the job retrying without losing it or double-charging", async (t) => {
  let pollAttempts = 0;
  const fetch = async (url, options) => {
    const payload = JSON.parse(options.body); const task = payload[0];
    if (task.taskType === "getResponse") {
      pollAttempts++;
      // runwareRequest retries transport errors internally (2 attempts by default) before ever
      // throwing back to pollJob - fail both of those internal attempts so the outage genuinely
      // reaches pollJob's own retry path, then let the NEXT outer poll call recover cleanly.
      if (pollAttempts <= 2) throw Object.assign(new Error("network down"), { cause: { code: "ECONNRESET" } });
    }
    return new Response(JSON.stringify(providerResponse(task)), { status: 200 });
  };
  t.context = suite({ fetch }); clean(t);
  const { api } = t.context; const p = api.createProject("a");
  const submitted = await api.submitGeneration("a", p.id, validRequest());
  const duringOutage = await api.pollJob("a", p.id, submitted.jobId);
  assert.equal(duringOutage.status, "retrying", "a transport outage must never surface as failed");
  assert.equal(duringOutage.id, submitted.jobId, "the same job survives the outage, not a fresh one");
  assert.equal(pollAttempts, 2, "runwareRequest's own internal backoff was exhausted before pollJob saw the failure");
  const recovered = await api.pollJob("a", p.id, submitted.jobId);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.id, submitted.jobId);
  assert.equal(pollAttempts, 3, "recovery took exactly one more poll - no duplicate submission was made along the way");
});

/*
 * Required behavior #4: a job Runware itself accepted and RAN, then reported "failed" on
 * (definitive task-level result, not a transport error), is retried once with the IDENTICAL request
 * (same durable job id as taskUUID) before ever being shown to the user as failed.
 */
test("a Runware-reported failed task is retried once with the identical request and can still succeed", async (t) => {
  const submissionTasks = []; let pollAttempts = 0;
  const fetch = async (url, options) => {
    const payload = JSON.parse(options.body); const task = payload[0];
    if (task.taskType === "videoInference") { submissionTasks.push(structuredClone(task)); return new Response(JSON.stringify({ data: [{ taskType: "videoInference", taskUUID: task.taskUUID, status: "processing", progress: 0 }] }), { status: 200 }); }
    pollAttempts++;
    if (pollAttempts === 1) return new Response(JSON.stringify({ data: [{ taskType: "videoInference", taskUUID: task.taskUUID, status: "failed", error: { code: "generationFailed", message: "raw provider text that must never reach the user" } }] }), { status: 200 });
    return new Response(JSON.stringify(providerResponse(task)), { status: 200 });
  };
  t.context = suite({ fetch }); clean(t);
  const { api } = t.context; const p = api.createProject("a");
  const submitted = await api.submitGeneration("a", p.id, validRequest());
  const reportedFailed = await api.pollJob("a", p.id, submitted.jobId);
  assert.equal(reportedFailed.status, "retrying", "a provider-reported failure is not shown to the user on the first report");
  assert.equal(reportedFailed.submission.state, "provider_failed_retry");
  assert.equal(submissionTasks.length, 1, "the retry has not been sent yet - only the automatic poll observed the failure");
  const retried = await api.pollJob("a", p.id, submitted.jobId);
  assert.equal(submissionTasks.length, 2, "the next poll resubmits the identical task exactly once");
  assert.equal(submissionTasks[1].taskUUID, submitted.jobId, "the retry reuses the SAME durable job id, never a fresh task");
  assert.deepEqual({ ...submissionTasks[1], taskUUID: undefined }, { ...submissionTasks[0], taskUUID: undefined }, "the retried request is identical to the original, not a different model/settings substitution");
  assert.equal(retried.status, "generating");
  assert.equal(retried.id, submitted.jobId);
});

test("a Runware-reported failure retried once and failing again shows a plain-language message, never raw provider text", async (t) => {
  let videoInferenceCalls = 0;
  const rawProviderText = "internal_diagnostic_stack_trace_12345 unexpected token at offset 88";
  const failedResponse = (task) => new Response(JSON.stringify({ data: [{ taskType: "videoInference", taskUUID: task.taskUUID, status: "failed", error: { code: "generationFailed", message: rawProviderText } }] }), { status: 200 });
  const fetch = async (url, options) => {
    const payload = JSON.parse(options.body); const task = payload[0];
    if (task.taskType === "videoInference") {
      videoInferenceCalls++;
      // The original submission is accepted normally; the RETRIED (2nd) submission is itself the
      // definitive second failure, matching how Runware can report failure on a submission call.
      if (videoInferenceCalls === 1) return new Response(JSON.stringify({ data: [{ taskType: "videoInference", taskUUID: task.taskUUID, status: "processing", progress: 0 }] }), { status: 200 });
      return failedResponse(task);
    }
    return failedResponse(task); // getResponse poll: the first definitive failure.
  };
  t.context = suite({ fetch }); clean(t);
  const { api } = t.context; const p = api.createProject("a");
  const submitted = await api.submitGeneration("a", p.id, validRequest());
  const firstFailure = await api.pollJob("a", p.id, submitted.jobId);
  assert.equal(firstFailure.status, "retrying");
  const secondFailure = await api.pollJob("a", p.id, submitted.jobId);
  assert.equal(secondFailure.status, "failed", "only the SECOND definitive failure, after the one retry, is shown to the user");
  assert.equal(videoInferenceCalls, 2, "the original submission plus exactly one identical retry");
  assert.ok(!JSON.stringify(secondFailure.providerError).includes(rawProviderText), "the raw provider message text must never reach the user");
  assert.match(secondFailure.providerError.message, /automatically retried the identical request once/);
});

test("a client idempotency key can create only one paid provider job", async (t) => {
  t.context = suite(); clean(t);
  const { api, calls } = t.context; const p = api.createProject("a");
  const request = validRequest({ idempotencyKey: "generation_click_1" });
  const first = await api.submitGeneration("a", p.id, request);
  const repeated = await api.submitGeneration("a", p.id, request);
  assert.equal(repeated.jobId, first.jobId); assert.equal(repeated.deduplicated, true); assert.equal(calls.length, 1);
  await assert.rejects(api.submitGeneration("a", p.id, { ...request, prompt: "A different scene" }), (error) => error.code === "video_idempotency_conflict" && error.status === 409);
  assert.throws(() => validateVideoRequest(validRequest({ idempotencyKey: "bad key" })), /identity is invalid/);
});

test("billing, provider errors, retry classification and recovery are explicit", async (t) => {
  let calls = 0; t.context = suite({ billingGate: async () => ({ allowed: false }), fetch: async () => { calls++; return new Response("down", { status: 503 }); } }); clean(t);
  const { api } = t.context; const p = api.createProject("a"); await assert.rejects(api.submitGeneration("a", p.id, validRequest()), /auto top-up/); assert.equal(calls, 0);
  const failing = createVideoFeature({ dataDir: join(t.context.dir, "retry"), runwareApiKey: "test", billingGate: async () => ({ allowed: true }), fetch: async () => new Response(JSON.stringify({ errors: [{ code: "timeoutProvider", message: "try again" }] }), { status: 200 }) });
  const q = failing.createProject("a"); const recoveredSubmit = await failing.submitGeneration("a", q.id, validRequest()); assert.equal(recoveredSubmit.status, "retrying"); assert.equal(recoveredSubmit.recoveredFrom, "timeoutProvider");
  assert.equal(failing.recoverJobs("a", q.id)[0].status, "retrying");
  assert.throws(() => parseRunwareEnvelope({ errors: [{ code: "invalidPrompt", message: "bad" }] }, "x"), (error) => error.code === "invalidPrompt");
  assert.throws(() => parseRunwareEnvelope({ data: [{ taskUUID: "another-task", status: "success", videoURL: "https://wrong.invalid" }] }, "expected-task"), (error) => error.code === "runware_task_mismatch");
  assert.equal(classifyVideoRetry({ code: "providerRateLimitExceeded", status: 400 }).retryable, true); assert.equal(classifyVideoRetry({ code: "invalidPrompt", status: 400 }).retryable, false);
  assert.equal(classifyVideoRetry({ cause: { code: "ECONNRESET" } }).retryable, true);
});

test("safe pre-accept failures resubmit the original inference UUID while ambiguous submits only poll", async (t) => {
  const calls = []; let inferenceCalls = 0;
  const root = mkdtempSync(join(tmpdir(), "dominion-video-resubmit-")); t.context = { dir: root }; clean(t);
  const fetch = async (_url, options) => {
    const task = JSON.parse(options.body)[0]; calls.push(structuredClone(task));
    if (task.taskType === "videoInference" && ++inferenceCalls === 1) return new Response(JSON.stringify({ errors: [{ code: "providerUnavailable", message: "not accepted" }] }), { status: 503 });
    return new Response(JSON.stringify({ data: [{ taskType: task.taskType, taskUUID: task.taskUUID, status: "processing", progress: 1 }] }), { status: 200 });
  };
  const api = createVideoFeature({ dataDir: root, runwareApiKey: "test", runwareRetries: 1, billingGate: async () => ({ allowed: true }), fetch });
  const project = api.createProject("a"); const submitted = await api.submitGeneration("a", project.id, validRequest());
  assert.equal(submitted.status, "retrying"); assert.equal(api.getProject("a", project.id).jobs[0].submission.state, "retry_safe");
  const resumed = await api.pollJob("a", project.id, submitted.jobId); assert.equal(resumed.status, "generating"); assert.equal(resumed.submission.state, "accepted");
  assert.deepEqual(calls.map((task) => task.taskType), ["videoInference", "videoInference"]); assert.equal(calls[0].taskUUID, calls[1].taskUUID);

  const ambiguousRoot = join(root, "ambiguous"); const ambiguousCalls = []; let first = true;
  const ambiguous = createVideoFeature({ dataDir: ambiguousRoot, runwareApiKey: "test", runwareRetries: 1, billingGate: async () => ({ allowed: true }), fetch: async (_url, options) => {
    const task = JSON.parse(options.body)[0]; ambiguousCalls.push(task.taskType);
    if (first) { first = false; const error = new Error("response lost"); error.name = "AbortError"; throw error; }
    return new Response(JSON.stringify({ errors: [{ code: "taskNotFound", message: "not visible yet", taskUUID: task.taskUUID }] }), { status: 200 });
  } });
  const p2 = ambiguous.createProject("a"); const uncertain = await ambiguous.submitGeneration("a", p2.id, validRequest());
  assert.equal(ambiguous.getProject("a", p2.id).jobs[0].submission.state, "ack_unknown");
  const stillPolling = await ambiguous.pollJob("a", p2.id, uncertain.jobId); assert.equal(stillPolling.status, "retrying"); assert.deepEqual(ambiguousCalls, ["videoInference", "getResponse"]);
});

test("director context compacts only at the configured 70 percent boundary", () => {
  assert.equal(directorCompactionNeeded({ usedTokens: 700000 }), true); assert.equal(directorCompactionNeeded({ usedTokens: 699999 }), false);
});

test("checkpoints preserve per-scene generation settings, bound the timeline, and restore durable history", (t) => {
  t.context = suite(); clean(t); const { api } = t.context; const p = api.createProject("a"); const state = emptyClientState(p);
  state.scenes = [{ id: "scene_1", title: "Reference cut", prompt: "Camera drifts", model: "bytedance:seedance@2.0", duration: 12, mode: "reference", frameImages: ["frame"], referenceImages: ["image"], referenceVideos: ["video"], referenceAudios: ["audio"], generateAudio: false, shots: [{ duration: 4, prompt: "First move" }] }];
  const revision = createHash("sha256").update("").digest("hex");
  api.checkpointProject("a", p.id, { label: "scene settings", state, expectedScreenplaySha256: revision, expectedProjectRevision: currentProjectRevision(api, "a", p.id) });
  const saved = api.getProject("a", p.id).scenes[0]; assert.equal(saved.duration, 12); assert.deepEqual(saved.frameImages, ["frame"]); assert.deepEqual(saved.referenceVideos, ["video"]); assert.equal(saved.generateAudio, false); assert.deepEqual(saved.shots, [{ duration: 4, prompt: "First move" }]);
  state.clips = [{ id: "bad", trackId: "v1", start: 21599, duration: 2 }];
  assert.throws(() => api.checkpointProject("a", p.id, { state, expectedScreenplaySha256: revision, expectedProjectRevision: currentProjectRevision(api, "a", p.id) }), /invalid timing/);
  const history = api.listCheckpoints("a", p.id); assert.ok(history.length >= 2); api.renameProject("a", p.id, "Changed");
  api.restoreCheckpoint("a", p.id, history.find((item) => item.label === "scene settings").seq, currentProjectRevision(api, "a", p.id)); assert.equal(api.getProject("a", p.id).name, p.name);
});

test("verified output creates one durable generated clip with real audio facts", async (t) => {
  t.context = suite({ mediaProcessor: { download: async () => ({ bytes: 42 }), verify: async () => ({ valid: true, duration: 6.5, video: [{}], audio: [{}] }) } }); clean(t);
  const { api } = t.context; const p = api.createProject("a"); const first = await api.submitGeneration("a", p.id, validRequest()); await api.pollJob("a", p.id, first.jobId); const job = await api.downloadJobOutput("a", p.id, first.jobId);
  const second = await api.submitGeneration("a", p.id, validRequest()); await api.pollJob("a", p.id, second.jobId); await api.downloadJobOutput("a", p.id, second.jobId);
  assert.equal(job.media.hasVideo, true); assert.equal(job.media.hasAudio, true); const state = api.getProject("a", p.id); const clips = state.timeline.videoTracks[0].clips;
  assert.equal(clips.length, 2); assert.equal(clips[0].mediaFile, `${first.jobId}.mp4`); assert.equal(clips[0].start, 0); assert.equal(clips[1].start, 6.5); assert.equal(clips[0].linked, `audio-${first.jobId}`);
  const audio = state.timeline.audioTracks[0].clips; assert.equal(audio.length, 2); assert.equal(audio[0].linked, `clip-${first.jobId}`); assert.equal(audio[1].start, 6.5);
  await api.downloadJobOutput("a", p.id, first.jobId); const repeat = api.getProject("a", p.id); assert.equal(repeat.timeline.videoTracks[0].clips.length, 2); assert.equal(repeat.timeline.audioTracks[0].clips.length, 2);
});

test("verified silent output remains a durable video clip without a fabricated audio layer", async (t) => {
  t.context = suite({ mediaProcessor: { download: async () => ({ bytes: 42 }), verify: async () => ({ valid: true, duration: 4, video: [{}], audio: [] }) } }); clean(t);
  const { api } = t.context; const p = api.createProject("a"); const submitted = await api.submitGeneration("a", p.id, validRequest()); await api.pollJob("a", p.id, submitted.jobId); const job = await api.downloadJobOutput("a", p.id, submitted.jobId);
  const state = api.getProject("a", p.id); assert.equal(job.media.hasAudio, false); assert.equal(state.timeline.videoTracks[0].clips[0].linked, null); assert.equal(state.timeline.audioTracks[0].clips.length, 0);
});

test("failed generated-media verification removes the final destination", async (t) => {
  let destination;
  t.context = suite({ mediaProcessor: {
    download: async (input) => { destination = input.destination; writeFileSync(destination, "bad-media"); return { bytes: 9 }; },
    verify: async () => { throw new Error("ffprobe rejected output"); },
  } }); clean(t);
  const { api } = t.context; const project = api.createProject("a");
  const submitted = await api.submitGeneration("a", project.id, validRequest()); await api.pollJob("a", project.id, submitted.jobId);
  await assert.rejects(api.downloadJobOutput("a", project.id, submitted.jobId), (error) => error.code === "video_media_download_failed");
  assert.equal(existsSync(destination), false);
});

test("Runware compiler follows each model's distinct dimensions and multi-shot contract", () => {
  const task = compileRunwareTask(validRequest({ model: "bytedance:seedance@2.0", duration: 4, ratio: "21:9", resolution: "4k" }), "33333333-3333-4333-8333-333333333333"); assert.deepEqual([task.width, task.height], [4398, 1886]);
  const kling = compileRunwareTask(validRequest({ model: "klingai:kling-video@3.0-turbo", prompt: "A deliberate city reveal", duration: 3, ratio: "1:1", resolution: "1080p" }), "44444444-4444-4444-8444-444444444444"); assert.deepEqual([kling.width, kling.height], [1440, 1440]);
  const grok = compileRunwareTask(validRequest({ model: "xai:grok-imagine@video-1.5", mode: "image", prompt: "Move", duration: 1, ratio: "3:2", resolution: "720p", frameImages: ["asset:frame"] }), "55555555-5555-4555-8555-555555555555"); assert.equal(grok.resolution, "720p"); assert.equal(Object.hasOwn(grok, "width"), false);
  const geminiImage = compileRunwareTask(validRequest({ mode: "image", frameImages: ["asset:first"] }), "66666666-6666-4666-8666-666666666666"); assert.deepEqual([geminiImage.width, geminiImage.height], [1280, 720]); assert.equal(Object.hasOwn(geminiImage, "resolution"), false);
  const seedanceReference = compileRunwareTask(validRequest({ model: "bytedance:seedance@2.0", mode: "reference", duration: 4, resolution: "720p", referenceVideos: ["asset:video"] }), "77777777-7777-4777-8777-777777777777"); assert.deepEqual([seedanceReference.width, seedanceReference.height], [1280, 720]); assert.equal(Object.hasOwn(seedanceReference, "resolution"), false);
  const klingImage = compileRunwareTask(validRequest({ model: "klingai:kling-video@3.0-turbo", mode: "image", prompt: "Camera moves through rain", duration: 3, resolution: "1080p", frameImages: ["asset:frame"] }), "99999999-9999-4999-8999-999999999999"); assert.equal(klingImage.resolution, "1080p"); assert.equal(Object.hasOwn(klingImage, "width"), false); assert.equal(Object.hasOwn(klingImage, "height"), false);
  const multiShot = compileRunwareTask(validRequest({ model: "klingai:kling-video@3.0-turbo", duration: 6, prompt: "A city sequence", shots: [{ duration: 2, prompt: "Wide skyline" }, { duration: 4, prompt: "Move through rain" }] }), "88888888-8888-4888-8888-888888888888"); assert.equal(multiShot.positivePrompt, "shot 1, 2, Wide skyline; shot 2, 4, Move through rain;"); assert.equal(Object.hasOwn(multiShot, "shots"), false);
  assert.throws(() => validateVideoRequest(validRequest({ mode: "edit", sourceVideo: "asset:source", referenceImages: ["1", "2", "3", "4", "5", "6"] })), /Too many reference images/);
});
