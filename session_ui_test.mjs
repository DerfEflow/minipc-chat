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
assert.match(app, /function restoreChatModel\(\)/, "sidebar switches need an explicit model restore");
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

console.log("session_ui_test: per-chat model, budget, and draft state are pinned");
