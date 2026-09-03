/* SD Tech Mobile Game Factory owner surface contract. Run: node gamefactory_ui_test.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("./public/index.html");
const js = read("./public/dominion-game-factory.js");
const css = read("./public/dominion-game-factory.css");
const cinematic = read("./public/dominion-cinematic.js");
const navigationCss = read("./public/dominion-cinematic-04.css");
const sw = read("./public/sw.js");

let passed = 0;
function test(name, check) {
  try { check(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
const includes = (source, value, label = value) => assert.ok(source.includes(value), `missing ${label}`);

test("the classic owner surface parses and its versioned assets ship in the shell", () => {
  assert.doesNotThrow(() => new Script(js));
  for (const asset of ["/dominion-game-factory.css?v=3", "/dominion-game-factory.js?v=3"]) {
    includes(html, asset, `${asset} in index.html`);
    includes(sw, `"${asset}"`, `${asset} in the service-worker shell`);
  }
  includes(js, "window.DominionGameFactory", "stable surface global");
  includes(sw, '"/games"', "offline-capable deep route");
  assert.match(sw, /dominion-ai-v186-stabilize-video/, "asset changes must advance the PWA cache");
});

test("owner navigation stays hidden until the server account capability arrives", () => {
  includes(cinematic, 'accountCapability: "gameFactory"', "factory navigation capability marker");
  includes(cinematic, "b.hidden = true", "factory destinations hidden by default");
  includes(cinematic, "a?.gameFactory === true", "strict server account capability check");
  includes(cinematic, 'button.hidden = !factoryAllowed', "capability-controlled reveal");
  includes(navigationCss, ".rail-dest[hidden]{display:none!important}", "author-level hidden enforcement");
  includes(navigationCss, "#dock-nav.dgf-enabled{grid-template-columns:repeat(5,1fr)}", "five-column dock only after capability reveal");
  assert.doesNotMatch(cinematic, /localStorage[\s\S]{0,160}gameFactory|gameFactory[\s\S]{0,160}localStorage/, "browser storage cannot grant factory navigation");
});

test("direct /games and in-app history are both first-class", () => {
  includes(cinematic, 'location.assign("/games")', "deep-link fallback");
  includes(js, 'location.pathname === "/games"', "direct route boot");
  includes(js, 'history.pushState({ ...(history.state || {}), dominionSurface: "games" }, "", "/games")', "in-app route push");
  includes(js, 'window.addEventListener("popstate"', "browser back/forward reconciliation");
  includes(js, "history.replaceState", "safe close for a direct deep link");
  assert.doesNotMatch(js, /location\.hash\s*=|#games/, "the deep route must not degrade into hash navigation");
});

test("the browser is a projection of server state and renders only allowed actions", () => {
  includes(js, 'request("/bootstrap")', "server bootstrap");
  includes(js, 'request("/config")', "server lifecycle contract");
  includes(js, "detail.allowedActions", "server-provided action list");
  includes(js, "expectedVersion: detail.version", "optimistic concurrency precondition");
  includes(js, '"idempotency-key": key', "idempotent command key");
  includes(js, 'headers["X-Dominion-Action"] = "game-factory"', "same-origin mutation boundary");
  includes(js, "action.command || action.id", "server action mapping");
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB/, "durable lifecycle state cannot live in browser storage");
});

test("no model, provider, worker, path, file, or secret settings are exposed", () => {
  assert.doesNotMatch(js, /<select|type=["']file["']|showOpenFilePicker|showDirectoryPicker|webkitdirectory/i, "the surface must not expose execution or filesystem selectors");
  assert.doesNotMatch(js, /workspaceRoot|api[_ -]?key|password|private[_ -]?key|secret/i, "the surface must not request or display sensitive execution settings");
  assert.doesNotMatch(js, /prompt\s*\(/, "free-form browser prompts must not bypass structured server commands");
  assert.doesNotMatch(js, /confirm\s*\(/, "destructive actions must use the scoped accessible dialog, not a browser confirm box");
  includes(js, 'dialog.className = "dgf-input-dialog"', "scoped plain-language revision dialog");
  includes(js, 'maxlength="2000"', "bounded revision instruction");
  includes(js, "No browser file or path control is exposed.", "explicit workspace-control boundary");
});

test("pause and stop remain truthful while a writer reaches a safe boundary", () => {
  includes(js, 'game.operation === "PAUSE_REQUESTED"', "durable pause-request state");
  includes(js, "finishing at a safe checkpoint", "truthful pause copy");
  includes(js, "the lifecycle state has not been falsified", "no premature PAUSED claim");
  includes(js, 'game.operation === "STOP_REQUESTED"', "durable stop-request state");
  includes(js, "waiting for the active writer to leave a safe boundary", "truthful stop copy");
});

test("the working preview is server-authorized, sandboxed, and stopped on every close", () => {
  includes(js, 'action.clientAction === "preview"', "server-derived preview action");
  includes(js, 'fetch("/ide/preview/start"', "existing authenticated preview start");
  includes(js, "JSON.stringify({ workspaceId })", "durable workspace identity only");
  includes(js, '`/ide/preview/p/?t=${encodeURIComponent(buildId)}`', "active-build preview relay");
  includes(js, 'fetch("/ide/preview/stop"', "preview stop");
  includes(js, "previewDialog?.close()", "factory and game close cleanup");
  includes(js, 'window.addEventListener("pagehide"', "browser-close cleanup");
  includes(js, 'sandbox="allow-scripts allow-forms allow-pointer-lock"', "opaque-origin preview sandbox");
  assert.doesNotMatch(js, /sandbox=["'][^"']*allow-same-origin/i, "workspace code must not share the Dominion parent origin");
  includes(js, "It is not QA, approval, store, or release evidence.", "truthful preview boundary");
  includes(css, ".dgf-preview-dialog iframe", "responsive preview frame");
});

test("required artifact content is owner-authorized and rendered only as inert verified text", () => {
  includes(js, "artifact?.viewer?.enabled", "server-derived artifact viewer capability");
  includes(js, 'data-artifact-key="${esc(key)}"', "allowlisted required artifact action");
  includes(js, 'request(`/games/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(key)}/content`', "scoped artifact-content endpoint");
  includes(js, 'dialog.className = "dgf-input-dialog dgf-artifact-dialog"', "accessible artifact dialog");
  includes(js, 'dialog.setAttribute("aria-labelledby", "dgf-artifact-title")', "artifact dialog name");
  includes(js, 'tabindex="0" aria-label="${esc(key)} plain-text content"', "keyboard-scrollable content region");
  includes(js, 'result.viewer?.renderMode !== "plain_text"', "plain-text response contract");
  includes(js, "result.viewer?.markdownExecution !== false", "server attests Markdown execution is disabled");
  includes(js, "pre.textContent = result.content", "artifact bytes enter the DOM as text only");
  assert.doesNotMatch(js, /(?:innerHTML|outerHTML)\s*=\s*result\.content|insertAdjacentHTML\([^)]*result\.content/, "artifact content must never enter an HTML execution sink");
  includes(js, "Markdown is shown as plain text and is never executed.", "truthful Markdown boundary");
  includes(js, "local content verified; another required copy may still be pending", "local review does not imply mirror completion");
  includes(js, "viewer.reason || (artifact ?", "server-provided unavailable reason");
  includes(js, "Verified artifact content is unavailable on this runtime.", "truthful default-unavailable fallback");
  assert.ok((js.match(/artifactDialog\?\.close\(\)/g) || []).length >= 2, "game selection and factory close both dismiss the artifact view");
  includes(css, ".dgf-artifact-dialog pre", "bounded scrollable plain-text presentation");
  includes(css, ".dgf-artifact-unavailable", "non-interactive unavailable explanation");
});

test("SSE resumes from a durable event cursor and polling remains a safe fallback", () => {
  includes(js, "new EventSource", "event-stream client");
  includes(js, "after=${Math.max(0, lastEventId)}", "durable replay cursor");
  includes(js, "event.lastEventId", "server event id capture");
  includes(js, "source.addEventListener(type, receive)", "named domain-event subscriptions");
  includes(js, "source.onerror", "reconnecting status");
  includes(js, "setInterval(() =>", "bounded polling fallback");
  includes(js, 'document.visibilityState === "visible"', "background polling suppression");
  includes(sw, '"/api/game-factory"', "live factory APIs bypass the cache");
});

test("the overlay isolates the shell, traps focus, and restores it on close", () => {
  includes(js, 'root.setAttribute("role", "dialog")', "dialog role");
  includes(js, 'root.setAttribute("aria-modal", "true")', "modal semantics");
  includes(js, "item.node.inert = true", "background isolation");
  includes(js, "new MutationObserver", "late-mounted shell overlays are isolated too");
  includes(js, "item.node.inert = item.inert", "background state restoration");
  includes(js, "trapFocus(event)", "keyboard focus containment");
  includes(js, 'event.target.closest?.("dialog")', "nested dialogs retain their own focus and Escape behavior");
  includes(js, "moveTabFocus(event)", "ARIA tab keyboard navigation");
  includes(js, "focus?.focus?.()", "return focus");
  includes(html, "dominion-game-factory.css?v=3", "factory style link");
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/([^"?]+\.css)/g)].map((match) => match[1]);
  assert.equal(styles.at(-1), "dominion-mobile.css", "the established touch correction sheet must remain last");
});

test("mobile interaction and reduced-motion requirements are explicit", () => {
  includes(css, "#dgf-root", "factory style scope");
  includes(css, "min-height:44px", "touch target floor");
  includes(css, "font-size:16px", "iOS focus zoom prevention");
  includes(css, "@media (max-width:620px)", "phone layout");
  includes(css, "prefers-reduced-motion:reduce", "reduced motion support");
  includes(css, "env(safe-area-inset-bottom)", "safe-area support");
  includes(css, ":focus-visible", "visible keyboard focus");
});

test("release and artifact claims remain evidence-based", () => {
  // Deficiency 15 (2026-09-03 owner-ordered gate relaxation): mandatory completion is now the
  // primary object plus a byte-verified Drive copy; chatgpt_project is a DEFERRED, non-blocking
  // backend, and its status wording must read as informational rather than as a failure.
  includes(js, "Completion requires a byte-verified Drive copy for every required artifact", "mandatory artifact rule");
  includes(js, "Native ChatGPT Project evidence is deferred, not required", "deferred backend is informational, not a blocker");
  includes(js, 'copy.status === "VERIFIED"', "copy verification state");
  includes(js, 'copy.status === "OWNER_ATTESTED"', "owner-attested native Project provenance");
  includes(js, "Owner-attested browser upload", "truthful owner-attested label");
  includes(js, "Deferred (not required; owner may complete later)", "truthful deferred-copy label");
  includes(js, 'copy.algorithm === "sha256" && copy.fingerprint === artifact.sha256', "copy verification matches the registered artifact hash");
  includes(js, "Evidence must match the active build", "build-bound test evidence");
  includes(js, "New builds invalidate stale approvals", "approval invalidation truth");
  includes(js, "Final submission remains human-gated", "human release boundary");
  includes(js, "These accountable steps cannot be inferred or fabricated by the factory.", "plain-language publisher checklist");
  includes(js, "age rating, content rights, privacy/data safety", "accountable declaration checklist");
  includes(js, "Readiness only", "disabled release-write health wording");
  includes(js, 'worker.state === "running"', "worker readiness requires an affirmative running state");
  assert.doesNotMatch(js, /worker\.available\s*!==\s*false|worker\.healthy\s*!==\s*false/, "missing worker-health evidence must fail closed");
  includes(js, "· stale", "historical test and release evidence is visibly stale");
  includes(js, "action.subjectHash.slice(0, 12)", "owner confirmation names its immutable evidence subject");
});

if (!process.exitCode) console.log(`\n${passed} Game Factory UI tests passed.`);
