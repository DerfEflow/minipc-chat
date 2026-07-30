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
assert.match(app, /take\("modelUpdatedAt",\s*\["model"\]\)/, "incoming chat state must restore its model by model freshness");
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
// 2026-07-30: the default now filters out local/auto (Local Qwen left the picker) but must still
// originate from the stored per-device default, not the previous session's live selection.
assert.match(app, /const lsModel\s*=\s*localStorage\.getItem\(LS_MODEL\)/, "new chats must start with the user's default model, not the previous session's model");
assert.match(app, /lsModel !== "local" && lsModel !== "auto"/, "the stored default must never resolve to the local model");
assert.match(app, /loadModels\(\)\.then\(\(\)\s*=>\s*\{[\s\S]*renderAll\(\)/, "catalog arrival must replace raw provider ids with human model names");
assert.match(app, /!jobChat\.model && j\.model/, "legacy and paused chats must recover their model from the durable job ledger");
assert.match(app, /const budgetByChat\s*=\s*Object\.create\(null\)/, "budget state must be keyed by chat");
assert.match(app, /budgetByChat\[st\.c\.id\]/, "background SSE budget events must update their source chat");
assert.match(app, /requestedChat === curId/, "late budget responses must not repaint a different chat");
assert.match(app, /function captureChatDraft\(\)/, "typed text must be captured on its source chat");
assert.match(app, /function deleteChat\(id\)[\s\S]{0,700}fetch\("\/chat\/stop"/,
  "deleting a chat with a durable turn must stop the server job");
assert.match(app, /function deleteChat\(id\)[\s\S]{0,900}delete liveJobs\[id\][\s\S]{0,120}persistLiveJobs\(\)/,
  "deleting a chat must clear its persisted live-job pointer");
assert.match(app, /function restoreChatDraft\(\)/, "the destination chat must restore only its own draft");
assert.match(app, /draft:\s*c\.draft/, "draft text must travel with cross-device chat state");
assert.match(app, /c\.draft\s*=\s*""/, "sending must clear only that chat's draft");
assert.match(app, /transcriptUpdatedAt:\s*c\.transcriptUpdatedAt/, "sync payloads need a transcript-specific freshness clock");
assert.match(app, /transcriptClockTrusted:\s*c\.transcriptClockTrusted === true/,
  "a migrated whole-chat timestamp must not masquerade as transcript provenance");
assert.match(app, /clockField === "transcriptUpdatedAt"[\s\S]{0,80}transcriptClockTrusted = true/,
  "only a real transcript mutation should promote the transcript clock");
assert.match(app, /touchChatComponent\(c,\s*"modelUpdatedAt"\)/, "model selection must advance only the model clock");
assert.match(app, /touchChatComponent\(c,\s*"draftUpdatedAt"/, "typing must advance only the draft clock");
assert.match(app, /touchChatComponent\(c,\s*"transcriptUpdatedAt"/, "message mutations must advance the transcript clock");
assert.match(app, /function captureChatAttachments\(\)/, "staged attachments must be captured on their source chat");
assert.match(app, /function restoreChatAttachments\(\)/, "the destination chat must restore only its own staged attachments");
assert.match(app, /function switchChat\(id\)[\s\S]*?persistChatComposer\(\)[\s\S]*?curId\s*=\s*id/,
  "switching chats must persist the source composer before changing the active id");
assert.match(app, /function newChat\(\)[\s\S]*?persistChatComposer\(\)[\s\S]*?pendingAttachments:\s*\[\]/,
  "starting a chat must persist the old composer and give the new chat an empty attachment list");
assert.match(app, /function renderAll\(\)[\s\S]*?restoreChatAttachments\(\)/,
  "every full chat render must bind the attachment strip to the destination chat");
assert.match(app, /async function addFiles\(fileList\)[\s\S]*?const targetChatId\s*=\s*curId[\s\S]*?setChatPendingAttachments/,
  "async file reads must retain the chat id where the add began");
assert.match(app, /function removeAttachment\(i\)[\s\S]*?setChatPendingAttachments/,
  "attachment removal must update and persist the open chat");
assert.match(app, /function send\(\)[\s\S]*?c\.pendingAttachments\s*=\s*\[\]/,
  "sending must clear the source chat's staged attachments");
assert.match(app, /function editUser\(i\)[\s\S]*?c\.pendingAttachments\s*=\s*pendingAtt/,
  "editing a user turn must persist its restored attachments as composer state");
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

// Reproduce the original two-device loss in the browser merge itself: the laptop has twenty
// messages, while a stale phone changes its draft/model/Forge settings with a newer wall clock but
// still carries only two old messages. Preference clocks win; the older transcript clock cannot.
const mergeStart = app.indexOf("function syncClock(chat, field)");
const mergeEnd = app.indexOf("// Fold the server", mergeStart);
assert.ok(mergeStart >= 0 && mergeEnd > mergeStart, "field-specific sync merge must remain extractable");
const mergeIncomingChat = Function(`${app.slice(mergeStart, mergeEnd)}; return mergeIncomingChat;`)();
const laptopChat = {
  id: "shared", title: "Laptop work",
  messages: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "turn " + i })),
  model: "openai/gpt-5.6-sol", draft: "", forgeTier: "ember", forgeMode: false,
  updatedAt: 2000, activityAt: 2000,
  transcriptUpdatedAt: 2000, titleUpdatedAt: 2000,
  modelUpdatedAt: 1000, draftUpdatedAt: 1000, forgeUpdatedAt: 1000,
};
const stalePhone = {
  id: "shared", title: "Laptop work", messages: laptopChat.messages.slice(0, 2),
  model: "anthropic/claude-opus-4-8", draft: "phone draft", forgeTier: "furnace", forgeMode: true,
  updatedAt: 3000, activityAt: 3000,
  transcriptUpdatedAt: 1000, titleUpdatedAt: 1000,
  modelUpdatedAt: 3000, draftUpdatedAt: 3000, forgeUpdatedAt: 3000,
};
assert.equal(mergeIncomingChat(laptopChat, stalePhone), true, "newer preference fields should merge");
assert.equal(laptopChat.messages.length, 20, "a stale phone preference write shrank the browser transcript");
assert.equal(laptopChat.messages.at(-1).content, "turn 19", "the live end of the laptop transcript was lost");
assert.equal(laptopChat.model, "anthropic/claude-opus-4-8", "newer phone model did not merge");
assert.equal(laptopChat.draft, "phone draft", "newer phone draft did not merge");
assert.equal(laptopChat.forgeTier, "furnace", "newer phone Forge tier did not merge");

// Execute the shipped composer binding helpers with two chats. This is the exact switch lifecycle:
// persist A, bind B, mutate B, then return to A without either attachment list crossing the boundary.
const composerStart = app.indexOf("let draftSaveTimer = null;");
const composerEnd = app.indexOf("function restoreChatModel()", composerStart);
assert.ok(composerStart >= 0 && composerEnd > composerStart, "composer state helpers must remain extractable");
const touchStart = app.indexOf("function touchChatComponent(c, clockField");
const touchEnd = app.indexOf("// The Forge controls", touchStart);
assert.ok(touchStart >= 0 && touchEnd > touchStart, "component clock helper must remain extractable");
const makeComposer = Function("env", `
  let chats = env.chats, curId = env.curId, pendingAtt = env.pendingAtt;
  const input = env.input;
  const cur = () => chats.find((c) => c.id === curId);
  const save = () => { env.saves++; };
  const autosize = () => {};
  const renderAttachStrip = () => { env.renders++; };
  const updateEstimate = () => {};
  ${app.slice(touchStart, touchEnd)}
  ${app.slice(composerStart, composerEnd)}
  return {
    persistChatComposer, restoreChatDraft, restoreChatAttachments, setChatPendingAttachments,
    setChat(id) { curId = id; },
    pending() { return pendingAtt; },
  };
`);
const aFile = { kind: "text", name: "a.txt", text: "alpha" };
const bFile = { kind: "text", name: "b.txt", text: "bravo" };
const addedA = { kind: "text", name: "later.txt", text: "still A" };
const composerEnv = {
  chats: [
    { id: "a", draft: "saved A", pendingAttachments: [aFile], updatedAt: 1, activityAt: 1 },
    { id: "b", draft: "saved B", pendingAttachments: [bFile], updatedAt: 2, activityAt: 2 },
  ],
  curId: "a", pendingAtt: [], input: { value: "typed A", dataset: { chatId: "a" } },
  saves: 0, renders: 0,
};
const composer = makeComposer(composerEnv);
composer.restoreChatAttachments();
composer.pending().push(addedA);
composer.persistChatComposer();
assert.equal(composerEnv.chats[0].draft, "typed A", "source draft was not captured");
assert.deepEqual(composerEnv.chats[0].pendingAttachments, [aFile, addedA], "source attachments were not captured");
composer.setChat("b");
composer.restoreChatDraft();
composer.restoreChatAttachments();
assert.equal(composerEnv.input.value, "saved B", "target draft was not restored");
assert.deepEqual(composer.pending(), [bFile], "target attachment strip borrowed the source chat's files");
const lateA = [...composerEnv.chats[0].pendingAttachments,
  { kind: "text", name: "late.txt", text: "finished after switch" }];
composer.setChatPendingAttachments(composerEnv.chats[0], lateA);
assert.deepEqual(composerEnv.chats[0].pendingAttachments, lateA,
  "a late async add did not land on its source chat");
assert.deepEqual(composer.pending(), [bFile],
  "a late async add from the source repainted the target chat");
composer.setChatPendingAttachments(composerEnv.chats[1], []);
assert.deepEqual(composerEnv.chats[1].pendingAttachments, [], "target removal did not update chat state");
assert.ok(composerEnv.saves >= 2, "composer mutations were not persisted");
composer.setChat("a");
composer.restoreChatDraft();
composer.restoreChatAttachments();
assert.deepEqual(composer.pending(), lateA, "returning to the source chat lost its staged files");

// Run the real localStorage serializer: recent chats keep bytes, old chats get honest placeholders,
// and the quota retry strips every chat. Sent-attachment degradation remains byte-for-byte aligned.
const storageStart = app.indexOf("const ATT_KEEP_CHATS = 12;");
const storageEnd = app.indexOf("const save = () =>", storageStart);
assert.ok(storageStart >= 0 && storageEnd > storageStart, "attachment serializer must remain extractable");
const storageChats = Array.from({ length: 13 }, (_, i) => ({
  id: "storage-" + i, title: "Storage " + i, messages: [],
  updatedAt: 100 - i, activityAt: 100 - i,
  pendingAttachments: [
    { kind: "image", name: "photo-" + i + ".png", dataUrl: "data:image/png;base64,AAAA" },
    { kind: "text", name: "notes-" + i + ".txt", text: "full text " + i },
  ],
}));
const serializeChats = Function("chats", `${app.slice(storageStart, storageEnd)}; return serializeChats;`)(storageChats);
const normalStorage = JSON.parse(serializeChats(false));
assert.equal(normalStorage[0].pendingAttachments[0].dataUrl, "data:image/png;base64,AAAA",
  "a recent chat lost staged image bytes");
assert.equal(normalStorage[0].pendingAttachments[1].text, "full text 0",
  "a recent chat lost staged text");
assert.deepEqual(normalStorage[12].pendingAttachments[0],
  { kind: "image_ref", name: "photo-12.png" }, "an old staged image was not degraded");
assert.deepEqual(normalStorage[12].pendingAttachments[1],
  { kind: "text", name: "notes-12.txt", text: "" }, "an old staged text file was not degraded");
const fallbackStorage = JSON.parse(serializeChats(true));
assert.equal(fallbackStorage[0].pendingAttachments[0].kind, "image_ref",
  "the quota fallback retained staged image bytes");
assert.equal(fallbackStorage[0].pendingAttachments[1].text, "",
  "the quota fallback retained staged text bytes");

console.log("session_ui_test: per-chat model, budget, draft, and attachment state are pinned");
