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
assert.match(app, /messageModel\s*!==\s*eraModel/, "a changed message model must start a new visual era");
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
assert.match(tenantCss, /\.model-era-marker\s*\{[\s\S]*position:\s*sticky/, "the model name must follow its transcript segment while scrolling");
assert.match(tenantCss, /\.model-era-name\s*\{[\s\S]*opacity:\s*\.25/, "the background model name must stay at 25% opacity");
assert.match(tenantCss, /pointer-events:\s*none/, "the watermark must never block conversation controls");

console.log("session_ui_test: per-chat model, budget, and draft state are pinned");
