import { readFileSync } from "node:fs";

const read = name => readFileSync(new URL(name, import.meta.url), "utf8");
const html = read("./public/index.html");
const js = read("./public/dominion-video.js");
const css = read("./public/dominion-video.css");
const sw = read("./public/sw.js");
let passed = 0;

function test(name, check) {
  try { check(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
function includes(source, value, label = value) {
  if (!source.includes(value)) throw new Error(`missing ${label}`);
}

test("versioned video assets match the offline shell", () => {
  for (const asset of ["/dominion-video.css?v=5", "/dominion-video.js?v=11"]) {
    includes(html, asset, `${asset} in index`);
    includes(sw, `"${asset}"`, `${asset} in service worker`);
  }
  includes(js, "l.href='/dominion-video.css?v=5'", "dynamic stylesheet fallback version");
});

test("the editor exposes the promised models and seven media layers", () => {
  for (const label of ["Gemini Omni Flash", "Seedance 2.0", "Kling 3.0 Turbo", "Grok Imagine 1.5"]) includes(js, label);
  for (const layer of ["Video 1", "Video 2", "Video 3", "Audio 1", "Audio 2", "Audio 3", "Audio 4"]) includes(js, layer);
  includes(js, "115,000 tokens", "screenwriter token ceiling");
  includes(js, "Trinity Large Thinking", "Trinity screenwriter status");
  includes(js, "new TextEncoder()", "UTF-8-aware token estimator");
  includes(js, "configured===true&&state.config?.screenwriter?.available===true", "fail-closed screenwriter availability");
  includes(js, "dominion.privacy-mode.v1", "global privacy-mode handoff");
  includes(js, "privacyMode:currentPrivacyMode()", "video provider privacy payloads");
});

test("desktop authority and saved history stay server-backed", () => {
  includes(js, "X-Dominion-Desktop-Capability", "desktop capability header");
  includes(js, "/history", "history endpoint");
  includes(js, "historyCommand('undo')", "durable undo");
  includes(js, "historyCommand('redo')", "durable redo");
  const classifier = js.match(/const device = \(\) => \{[\s\S]*?\n  \};/)?.[0] || "";
  if (!classifier || /innerWidth|matchMedia/.test(classifier)) throw new Error("device authority regressed to a viewport heuristic");
});

test("screenwriter uses and parses the required event-stream transport", () => {
  includes(js, "eventStream:true", "screenwriter event-stream request flag");
  includes(js, "Accept:'text/event-stream'", "event-stream Accept header");
  includes(js, "eventStreamResult(res)", "event-stream response parser");
  includes(js, "includes('text/event-stream')", "event-stream content-type detection");
  includes(js, "event==='result'", "screenwriter result event handling");
  includes(js, "event==='error'", "screenwriter error event handling");
  includes(js, "res.body.getReader()", "streaming response reader");
  includes(js, "const prompt=$('#dv-script',root)?.value||''", "untrimmed screenplay checkpoint payload");
  includes(js, "if(!prompt.trim())", "trimmed emptiness validation without payload mutation");
  includes(js, "async function reconcileScreenwriterProject(projectId", "project-scoped screenwriter failure reconciliation helper");
  includes(js, "request(`/screenwriter/status?projectId=${encodeURIComponent(projectId)}`)", "durable screenwriter status recovery");
  includes(js, "request(`/projects/${encodeURIComponent(projectId)}`)", "authoritative project refetch after stream failure");
  includes(js, "applyPayload(payload)", "authoritative project payload application");
  includes(js, "setScreenwriterRecovery(turnProjectId", "durable screenwriter recovery lock");
  includes(js, "reconcileScreenwriterProject(turnProjectId,{epoch,waitForTerminal:true})", "screenwriter catch reconciliation before retry");
  includes(js, "sameSession(turnProjectId,epoch)", "screenwriter result project/session guard");
  includes(js, "state.screenwriterRecovery?.pending", "writer remains disabled during recovery");
  includes(js, "state.screenplay=d.text;state.screenplaySha256=d.screenplaySha256", "verified screenplay result revision");
  includes(js, "expectedScreenplaySha256", "checkpoint screenplay compare-and-swap precondition");
  includes(js, "expectedProjectRevision", "checkpoint whole-project compare-and-swap precondition");
  includes(js, "state.screenplaySha256=saved.screenplaySha256", "checkpoint revision advancement");
  includes(js, "state.projectRevision=Number(saved.projectRevision)", "whole-project revision advancement");
  includes(js, "request('/screenwriter/reconcile'", "durable Trinity settlement repair action");
  includes(js, "persistDirtyEdits('Saved edits before opening history')", "history waits for delayed screenplay saves");
  includes(js, "runProjectSwitch(d,async()", "serialized project dashboard actions");
  includes(js, "checkpointEpoch++;creatingProject=null;screenwriterSetup=null;projectSwitching=", "close invalidates prior async callbacks");
  includes(js, "state.open=false;state.playing=false", "close marks the prior studio session inactive");
  includes(js, "clearTimeout(scriptSaveTimer);scriptSaveTimer=null", "close cancels delayed screenplay saves");
});

test("authoritative screenplay adoption cannot be overwritten by stale textarea DOM", () => {
  const start = js.indexOf("function render(capture=true)");
  const end = js.indexOf("function applyControls", start);
  if (start < 0 || end <= start) throw new Error("render function could not be isolated");
  const renderSource = js.slice(start, end);
  includes(renderSource, "const script=state.screenplay", "render sources screenplay only from authoritative state");
  const beforeDomReplacement = renderSource.slice(0, renderSource.indexOf("root.innerHTML=baseMarkup()"));
  if (beforeDomReplacement.includes("$('#dv-script'") || /state\.screenplay\s*=/.test(renderSource)) throw new Error("render can still copy stale textarea text over authoritative screenplay state");
  includes(js, "if(e.target.id==='dv-script'){ state.screenplay=e.target.value", "textarea input synchronously owns local screenplay edits");
});

test("conflict and Trinity recovery controls require preservation before destructive reload or unlock", () => {
  includes(js, "data-conflict-reload disabled", "server reload starts disabled until the local conflict is downloaded");
  includes(js, "if(downloadConflictDraft()){reload.disabled=false", "conflict download unlocks authoritative reload");
  includes(js, "if(conflictDraft){event.preventDefault();event.returnValue='';}", "beforeunload protects a held conflict draft");
  includes(js, "input.oninput=()=>apply.disabled=input.value!==required", "typed quarantine confirmation gates the action");
  includes(js, "if(input.value!==required||state.inflight.screenwriter)return", "quarantine handler rechecks exact confirmation");
  includes(js, "request('/screenwriter/quarantine'", "unrecoverable-turn quarantine endpoint");
  includes(js, "error?.code==='screenwriter_generation_now_recoverable'||Number(error?.status)===409", "quarantine race refreshes changed server recovery state");
  includes(js, "OpenRouter status changed during the final safety check", "quarantine race refreshes stale modal state");
  includes(js, "if(!activeDialog?.node?.isConnected)render()", "quarantine completion redraws unlocked controls after clearing inflight state");
  includes(js, "recoveryAction:'retry_status'", "durable status retry state");
  includes(js, "if(action==='retry_status')", "status-only recovery path");
});

test("paid generation retries and mobile reloads keep their durable identity", () => {
  includes(js, "generationIntent", "retained generation intent");
  includes(js, "prepareGenerationBody", "generation request normalization");
  includes(js, "delete body.referenceImages", "inactive reference-media omission");
  includes(js, "/jobs/recover-mobile", "mobile job discovery");
  includes(js, "resumeMobileJob", "mobile job resume loop");
  includes(js, "/delivered", "mobile delivery acknowledgement");
  includes(js, "job.hasLocalOutput", "settled output recovery guard");
  includes(js, "generationDisabled=generationBusy()||!!projectSwitching||(!single&&projectEditLocked())", "mobile single generation ignores unrelated saved-project recovery locks but still disables while busy");
  const generationLocked = (single, busy, switching, projectLocked) => busy || switching || (!single && projectLocked);
  if (generationLocked(true, false, false, true)) throw new Error("saved-project recovery still disables an idle mobile single generation");
  if (!generationLocked(true, true, false, true)) throw new Error("an active mobile single generation does not disable its generate button");
});

test("panel, focus, and narrow editor states cannot overlap", () => {
  for (const rule of [
    ".dv-panel.regular{position:relative",
    ".dv-panel.expanded{position:fixed",
    ".dv-two-expanded .dv-panel.expanded",
    ".dv-no-regular:not(.dv-focus-mode)",
    ".dv-focus-mode .dv-top-actions #dv-focus{display:block!important",
    ".dv-workspace{overflow-x:hidden;overflow-y:auto}",
    ".dv-stage{height:300px;flex:0 0 300px;overflow:hidden}",
  ]) includes(css, rule);
  includes(js, "dv-timeline-detail", "compact timeline label");
});

if (!process.exitCode) console.log(`\nvideo UI: ${passed} passed, 0 failed`);
