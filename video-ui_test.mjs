import { readFileSync } from "node:fs";

const read = name => readFileSync(new URL(name, import.meta.url), "utf8");
const html = read("./public/index.html");
const js = read("./public/dominion-video.js");
// The public stylesheet is intentionally split: the base file owns the full studio layout and
// the wrapper imports it before applying small, removable hotfixes.  Test the effective stylesheet
// instead of treating the wrapper as though it still contained every base declaration inline.
const css = `${read("./public/dominion-video-base.css")}\n${read("./public/dominion-video.css")}`;
const sw = read("./public/sw.js");
let passed = 0;

function test(name, check) {
  try { check(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
function includes(source, value, label = value) {
  if (!source.includes(value)) throw new Error(`missing ${label}`);
}

const uncommentedCss = css.replace(/\/\*[\s\S]*?\*\//g, "");
function cssDeclarations(selector, property) {
  const values = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of uncommentedCss.matchAll(rule)) {
    const selectors = match[1].split(",").map(value => value.trim());
    if (!selectors.includes(selector)) continue;
    const declaration = new RegExp(`(?:^|;)\\s*${property.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*:\\s*([^;]+)`, "g");
    for (const value of match[2].matchAll(declaration)) values.push(value[1].trim());
  }
  return values;
}
function hasCssDeclaration(selector, property, expected, label = `${selector} ${property}`) {
  const values = cssDeclarations(selector, property);
  if (!values.some(value => expected.test(value))) throw new Error(`missing ${label}; found ${values.join(", ") || "no declaration"}`);
}

test("versioned video assets match the offline shell", () => {
  for (const asset of ["/dominion-video.css?v=8", "/dominion-video.js?v=14"]) {
    includes(html, asset, `${asset} in index`);
    includes(sw, `"${asset}"`, `${asset} in service worker`);
  }
  includes(js, "l.href='/dominion-video.css?v=8'", "dynamic stylesheet fallback version");
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

test("desktop default follows the sketched writer-player-storyboard composition", () => {
  const baseStart = js.indexOf("function baseMarkup()");
  const baseEnd = js.indexOf("function captureDrafts()", baseStart);
  if (baseStart < 0 || baseEnd <= baseStart) throw new Error("base workspace markup could not be isolated");
  const markup = js.slice(baseStart, baseEnd);
  const previewMatch = /(?:id|class)="[^"]*\bdv-(?:scene-previews|preview-strip|scene-preview-strip|previews)\b[^"]*"/.exec(markup);
  const positions = {
    writer: markup.indexOf('id="dv-writer"'),
    stage: markup.indexOf('class="dv-stage"'),
    board: markup.indexOf('id="dv-board"'),
    previews: previewMatch?.index ?? -1,
    chat: markup.indexOf('id="dv-chat"'),
    tray: markup.indexOf('id="dv-tray"'),
    timeline: markup.indexOf('class="dv-timeline-panel"'),
  };
  for (const [name, position] of Object.entries(positions)) if (position < 0) throw new Error(`missing ${name} surface`);
  const expectedOrder = ["writer", "stage", "board", "previews", "chat", "tray", "timeline"];
  for (let index = 1; index < expectedOrder.length; index++) {
    const before = expectedOrder[index - 1], after = expectedOrder[index];
    if (positions[before] >= positions[after]) throw new Error(`${before} must precede ${after} in the desktop workspace`);
  }
  const chatClose = markup.indexOf("</aside>", positions.chat);
  if (chatClose < 0 || positions.tray < chatClose) throw new Error("the minimized-panel tray must be a separate surface below the chat, not part of the liaison rail");
  includes(markup, "AI CHAT · Liaison", "wide AI chat label from the sketch");

  const desktopAreas = cssDeclarations(".dv-workspace", "grid-template-areas").find(value => /["']writer\s+(?:stage|player)\s+board["']\s*["']previews\s+previews\s+previews["']\s*["']chat\s+chat\s+chat["']\s*["']tray\s+tray\s+tray["']/.test(value));
  if (!desktopAreas) throw new Error("desktop layout must explicitly declare writer/player/storyboard, scene previews, wide chat, then tray rows");
  if (/timeline\s+timeline\s+timeline/.test(desktopAreas)) throw new Error("the secondary timeline must not consume a permanent row in the default sketch layout");
  hasCssDeclaration(".dv-writer.regular", "grid-area", /^writer$/, "regular screenwriter in the left desktop column");
  hasCssDeclaration(".dv-stage", "grid-area", /^(?:stage|player)$/, "player in the center desktop column");
  hasCssDeclaration(".dv-board.regular", "grid-area", /^board$/, "regular storyboard in the right desktop column");
  const previewSelectors = [".dv-scene-previews", ".dv-preview-strip", ".dv-scene-preview-strip", ".dv-previews"];
  const previewSelector = previewSelectors.find(selector => cssDeclarations(selector, "grid-area").some(value => value === "previews"));
  if (!previewSelector) throw new Error("scene preview strip is not assigned to the full-width previews grid area");
  hasCssDeclaration(previewSelector, "display", /^(?:flex|grid)$/, "visible scene preview strip");
  hasCssDeclaration(".dv-chat", "grid-area", /^chat$/, "wide chat below all three primary columns");
  hasCssDeclaration(".dv-tray", "grid-area", /^tray$/, "minimized-panel tray below chat");
  hasCssDeclaration(".dv-timeline-panel", "display", /^none$/, "timeline hidden from the default sketch layout");

  const rightRail = cssDeclarations(".dv-chat", "grid-column").some(value => /^\d+\s*$/.test(value)) &&
    cssDeclarations(".dv-chat", "grid-row").some(value => /^1\s*\/\s*(?:3|4|-1)$/.test(value));
  if (rightRail) throw new Error("liaison chat regressed to the forbidden full-height right rail");
});

test("storyboard is a visual thumbnail grid rather than a compact text list", () => {
  hasCssDeclaration(".dv-scenes", "display", /^grid$/, "storyboard grid display");
  hasCssDeclaration(".dv-scenes", "grid-template-columns", /repeat\(\s*2\s*,\s*minmax\(\s*0\s*,\s*1fr\s*\)\s*\)/, "two-column storyboard thumbnail grid");
  hasCssDeclaration(".dv-thumb", "aspect-ratio", /^(?:16\s*\/\s*9|1\.777)/, "widescreen storyboard thumbnails");
  const start = js.indexOf("function paintScenes()");
  const end = js.indexOf("function paintPanels()", start);
  if (start < 0 || end <= start) throw new Error("storyboard renderer could not be isolated");
  const renderer = js.slice(start, end);
  if (!/(?:<img\b|<video\b|background-image)/.test(renderer)) throw new Error("storyboard cards do not render visual media");
  if (!/(?:thumbnail|frameImages|\.src\b)/.test(renderer)) throw new Error("storyboard visuals are not sourced from scene or generated media");
});

test("timeline stays secondary but has a clear reversible editor focus mode", () => {
  includes(js, "case 'focus': mutate(state.focus?'Exited editor focus':'Entered editor focus'", "reversible editor focus action");
  includes(js, "state.focus?'↙ Exit player + editor':'⛶ Player + editor'", "clear player and editor focus exit control");
  includes(js, "node.classList.add(state.panels[p])", "panel states retained across focus render");
  hasCssDeclaration(".dv-focus-mode .dv-timeline-panel", "display", /^(?:block|grid|flex)$/, "focus mode promotes the secondary timeline into a usable editor surface");
});

/*
 * THE CHAT IS THE FRONT DOOR (Fred, 2026-08-05: "the button to generate the video is in a strange
 * place above the video player. It should be in the chat where you are describing the video you
 * want."). The sketched panel composition above is unchanged and still pinned; only the entry
 * point moved, and the numbered pipeline is an overlay on the existing panels rather than a
 * relayout.
 */
test("generation starts from the chat, not from the settings bar above the player", () => {
  const baseStart = js.indexOf("function baseMarkup()");
  const baseEnd = js.indexOf("function captureDrafts()", baseStart);
  const markup = js.slice(baseStart, baseEnd);
  const barStart = markup.indexOf('class="dv-controlbar"');
  const barEnd = markup.indexOf("</section>", barStart);
  const chatStart = markup.indexOf('id="dv-chat"');
  const chatEnd = markup.indexOf("</aside>", chatStart);
  if (barStart < 0 || chatStart < 0) throw new Error("control bar or chat could not be isolated");
  const bar = markup.slice(barStart, barEnd);
  const chat = markup.slice(chatStart, chatEnd);
  if (/data-action="generate"/.test(bar)) throw new Error("the generate button must not sit in the settings bar above the player");
  if (!/data-action="generate"/.test(chat)) throw new Error("the generate button must live in the chat, where the video is described");
  // The chips are assembled above the template and interpolated into the chat, so assert the
  // relationship rather than the literal: they must be BUILT as tappable and PLACED in the chat.
  if (!/\$\{chipMarkup\}/.test(chat)) throw new Error("the producer's suggested next step must be rendered inside the chat");
  if (!/const chipMarkup[\s\S]{0,400}data-action="chip"/.test(markup)) throw new Error("the suggested next step must be a real tappable control");
  // Settings stay where Fred likes them.
  for (const control of ["dv-model", "dv-ratio", "dv-resolution", "dv-format"]) {
    if (!bar.includes(control)) throw new Error(`the settings bar lost ${control}`);
  }
});

/*
 * The render button must never impersonate the send button (Fred, 2026-08-05, with screenshots):
 * he typed his whole request into the chat, pressed the wide primary bar underneath it, and got a
 * modal asking for the prompt he had just written.
 */
test("the render control is secondary, conditional, and never eats a typed message", () => {
  const baseStart = js.indexOf("function baseMarkup()");
  const markup = js.slice(baseStart, js.indexOf("function captureDrafts()", baseStart));
  const chat = markup.slice(markup.indexOf('id="dv-chat"'), markup.indexOf("</aside>", markup.indexOf('id="dv-chat"')));
  if (/class="dv-generate"/.test(chat)) throw new Error("the render button must not use the wide primary generate styling inside the chat");
  if (!/dv-generate-secondary/.test(chat)) throw new Error("the render button must be visually secondary to the conversation");
  if (!/renderableScene\(\)/.test(chat)) throw new Error("the render button must only appear when a scene can actually be rendered");
  // Enter sends: its absence is half of why a button underneath read as the send control.
  includes(js, "e.key==='Enter'&&!e.shiftKey", "Enter sends the message, Shift+Enter makes a newline");
  // A typed message is routed to the producer rather than dropped into an empty modal.
  const gen = js.slice(js.indexOf("async function generate()"), js.indexOf("function mergeServerClips"));
  if (!/typed[\s\S]{0,120}sendChat\(\)/.test(gen)) throw new Error("text in the chat box must reach the producer instead of opening an empty prompt modal");
});

test("the numbered pipeline reflects real project state and never invents a step", () => {
  const start = js.indexOf("function stageState()");
  const end = js.indexOf("function baseMarkup()", start);
  if (start < 0 || end <= start) throw new Error("stageState could not be isolated");
  const fn = js.slice(start, end);
  for (const [signal, why] of [
    ["state.messages", "brief comes from the real conversation"],
    ["state.screenplay", "script stage reads the real screenplay"],
    ["state.scenes", "storyboard stage reads real scenes"],
    ["state.clips", "clip stage reads real generated clips"],
  ]) if (!fn.includes(signal)) throw new Error(`stageState must derive from project state: ${why}`);
  if (!/skipped/.test(fn)) throw new Error("a deliberately skipped stage must read as skipped, not pending");
  includes(js, 'class="dv-stage-strip"', "the pipeline strip is rendered");
  includes(js, 'class="dv-step-badge"', "panels carry their step number");
  hasCssDeclaration(".dv-stage-step[data-state=\"current\"]", "color", /#/, "the current stage is lit");
  hasCssDeclaration(".dv-stage-step[data-state=\"skipped\"]", "opacity", /^\./, "a skipped stage is dimmed rather than hidden");
});

if (!process.exitCode) console.log(`\nvideo UI: ${passed} passed, 0 failed`);
