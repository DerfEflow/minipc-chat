/*
 * Per-chat UI state regression test. The server budget ledger was already session-scoped; these
 * assertions pin the client wiring that previously leaked the visible budget and selected model
 * across sidebar switches.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
const sync = readFileSync(new URL("./chatsync.mjs", import.meta.url), "utf8");

assert.match(app, /model:\s*c\.model/, "cross-device chat payload must carry the selected model");
assert.match(app, /local\.model\s*=\s*inc\.model/, "incoming chat state must restore its model");
assert.match(app, /c\.model\s*=\s*modelSel\.value/, "a user model change must update the open chat");
assert.match(app, /const legacyModel[\s\S]*c\.model\s*=\s*legacyModel/, "legacy sessions must receive an explicit model before switching");
assert.match(app, /b\.activityAt\s*\|\|\s*b\.updatedAt/, "preference changes must not reorder the sidebar");
assert.doesNotMatch(app, /c\.model\s*=\s*modelSel\.value[\s\S]{0,180}renderSidebar\(\)/, "changing a model must not rebuild and reorder the sidebar under the pointer");
assert.match(app, /function restoreChatModel\(\)/, "sidebar switches need an explicit model restore");
assert.match(app, /modelId:\s*modelSel\s*\?\s*modelSel\.value/, "every sent user message must snapshot the dropdown model");
assert.match(app, /modelHistoryVersion\s*!==\s*1/, "legacy transcripts need a one-time model-history migration");
assert.match(app, /className\s*=\s*"model-era"/, "the transcript must render model change segments");
assert.match(app, /function transcriptModelPlan\(c\)/, "model history must be derived from models actually saved on messages");
assert.match(app, /entries\.length\s*<\s*3/, "the visual model ledger must stop after three entries");
assert.match(app, /c\.model\s*!==\s*actualModel/, "a newly selected model must render as a pending era without falsifying message history");
assert.match(app, /className\s*=\s*"model-era-divider"/, "model changes need a visible transcript boundary");
assert.match(app, /const defaultModel\s*=\s*localStorage\.getItem\(LS_MODEL\)/, "new chats must start with the user's default model, not the previous session's model");
assert.match(app, /loadModels\(\)\.then\(\(\)\s*=>\s*\{[\s\S]*renderAll\(\)/, "catalog arrival must replace raw provider ids with human model names");
assert.match(app, /!jobChat\.model && j\.model/, "legacy and paused chats must recover their model from the durable job ledger");
assert.match(app, /const budgetByChat\s*=\s*Object\.create\(null\)/, "budget state must be keyed by chat");
assert.match(app, /budgetByChat\[st\.c\.id\]/, "background SSE budget events must update their source chat");
assert.match(app, /requestedChat === curId/, "late budget responses must not repaint a different chat");
assert.match(app, /function captureChatDraft\(\)/, "typed text must be captured on its source chat");
assert.match(app, /function restoreChatDraft\(\)/, "the destination chat must restore only its own draft");
assert.match(app, /draft:\s*c\.draft/, "draft text must travel with cross-device chat state");
assert.match(app, /c\.draft\s*=\s*""/, "sending must clear only that chat's draft");
assert.match(sync, /model:\s*typeof raw\.model/, "the sync store must preserve model identity");
assert.match(sync, /draft:\s*typeof raw\.draft/, "the sync store must preserve unfinished typing");
assert.match(sync, /activityAt:/, "cross-device state must preserve conversation recency separately from preference revisions");

const tenantCss = readFileSync(new URL("./public/dominion-tenant.css", import.meta.url), "utf8");
assert.match(tenantCss, /\.model-ledger\s*\{[\s\S]*position:\s*sticky/, "the model ledger must remain visible while scrolling");
assert.match(tenantCss, /\.model-ledger-name\s*\{[\s\S]*opacity:\s*\.25/, "the background model names must stay at 25% opacity");
assert.match(tenantCss, /\.model-era-divider::before,[\s\S]*#20ff79/, "model boundaries must use a bright green dividing line");
assert.match(tenantCss, /pointer-events:\s*none/, "the watermark must never block conversation controls");

// Execute the pure timeline planner directly from the shipped client. This pins the behavioral
// distinction between a pre-send selection, a pending next model, and models actually used.
const planStart = app.indexOf("function transcriptModelPlan(c)");
const planEnd = app.indexOf("function renderTranscript()", planStart);
assert.ok(planStart >= 0 && planEnd > planStart, "timeline planner must remain extractable for behavior tests");
const transcriptModelPlan = Function(`${app.slice(planStart, planEnd)}; return transcriptModelPlan;`)();
const emptyPlan = transcriptModelPlan({ model: "model-b", messages: [] });
assert.deepEqual(emptyPlan.entries, [{ id: "model-b", pending: true }], "pre-send changes replace the default instead of logging it");
const pendingPlan = transcriptModelPlan({ model: "model-b", messages: [
  { role: "user", modelId: "model-a" }, { role: "assistant", modelId: "model-a" },
] });
assert.deepEqual(pendingPlan.entries, [{ id: "model-a", pending: false }, { id: "model-b", pending: true }],
  "a post-send picker change must appear beside the locked first model");
const changedBeforeSend = transcriptModelPlan({ model: "model-c", messages: [
  { role: "user", modelId: "model-a" }, { role: "assistant", modelId: "model-a" },
] });
assert.deepEqual(changedBeforeSend.entries.map((e) => e.id), ["model-a", "model-c"],
  "changing a pending choice before send must replace it rather than falsely logging an unused model");
const cappedPlan = transcriptModelPlan({ model: "model-d", messages: [
  { role: "user", modelId: "model-a" }, { role: "assistant", modelId: "model-a" },
  { role: "user", modelId: "model-b" }, { role: "assistant", modelId: "model-b" },
  { role: "user", modelId: "model-c" }, { role: "assistant", modelId: "model-c" },
  { role: "user", modelId: "model-d" },
] });
assert.deepEqual(cappedPlan.entries.map((e) => e.id), ["model-a", "model-b", "model-c"], "the visual log must ignore model four");
assert.equal(cappedPlan.slots.at(-1), 2, "messages after the third logged model stay in the final visual lane");

console.log("session_ui_test: per-chat model, budget, and draft state are pinned");
