/*
 * Altana client actions (public/app.js), 2026-08-03.
 *
 * altana.js dispatches one "altana:action" CustomEvent on `document` per action the server said
 * Altana performed, because the server deliberately does not own client-side settings. Before this
 * wiring existed, nothing consumed that event: Altana could say "I switched your theme" and nothing
 * happened. This test runs the REAL public/app.js (not a reimplementation of it) inside a minimal
 * DOM stub, dispatches the exact event shape altana.js sends, and asserts on the real side effects
 * (localStorage keys, element values, which open/close function ran) plus the altana:action-result
 * event the listener reports back.
 *
 * No server, no browser: app.js is loaded with node:vm and a hand-built fake DOM, the same pattern
 * already used by markdown_ui_test.mjs and money_display_test.mjs in this repo.
 *
 * ALTANA_SETTABLE_SETTINGS is imported directly from altana.mjs (not copied here) so this test
 * tracks the real allow-list. If that list ever changes, this test automatically re-checks every
 * entry rather than silently testing a stale copy.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ALTANA_SETTABLE_SETTINGS } from "./altana.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_PATH = join(HERE, "public", "app.js");
const APP_SOURCE = readFileSync(APP_PATH, "utf8");

let passed = 0;
const t = (name, fn) => { fn(); console.log("  PASS  " + name); passed++; };

/* ---------------------------------------------------------------------------------------------- *
 * A minimal, permissive fake DOM. Every element supports the handful of DOM operations app.js
 * actually calls (value/checked/hidden, classList, addEventListener/dispatchEvent, style, etc.);
 * unknown ids auto-vivify into a fresh element rather than returning null, which is safe here
 * because app.js already guards every optional element with `if (x)` before using it.
 * ---------------------------------------------------------------------------------------------- */
function makeElement(id) {
  const listeners = new Map();
  const classes = new Set();
  const store = { value: "", checked: false, hidden: false, disabled: false, textContent: "", innerHTML: "", className: "" };
  const el = {
    id,
    tagName: "DIV",
    style: new Proxy({}, {
      get: (target, p) => {
        if (p === "setProperty" || p === "removeProperty") return () => {};
        if (p === "getPropertyValue") return () => "";
        return target[p] || "";
      },
      set: (target, p, v) => { target[p] = v; return true; },
    }),
    dataset: {},
    children: [],
    options: [],
    get value() { return store.value; }, set value(v) { store.value = v; },
    get checked() { return store.checked; }, set checked(v) { store.checked = v; },
    get hidden() { return store.hidden; }, set hidden(v) { store.hidden = v; },
    get disabled() { return store.disabled; }, set disabled(v) { store.disabled = v; },
    get textContent() { return store.textContent; }, set textContent(v) { store.textContent = v; },
    get innerHTML() { return store.innerHTML; }, set innerHTML(v) { store.innerHTML = v; },
    get className() { return store.className; }, set className(v) { store.className = v; },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, f) => { if (f === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else if (f) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener: (type, fn) => { const a = listeners.get(type); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    dispatchEvent: (e) => { (listeners.get(e.type) || []).slice().forEach((fn) => fn(e)); return true; },
    appendChild: (c) => c, removeChild: (c) => c, insertBefore: (c) => c, replaceWith: () => {},
    firstChild: null, lastChild: null, nextSibling: null, previousSibling: null, parentNode: null, parentElement: null,
    replaceChildren: () => {}, append: () => {}, prepend: () => {}, before: () => {}, after: () => {},
    insertAdjacentHTML: () => {}, insertAdjacentElement: () => null,
    cloneNode: () => makeElement(id + "_clone"),
    remove: () => {}, focus: () => {}, blur: () => {},
    click: () => { el.dispatchEvent({ type: "click", target: el, preventDefault() {}, stopPropagation() {} }); },
    setAttribute: () => {}, getAttribute: () => null, removeAttribute: () => {}, hasAttribute: () => false,
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, scrollIntoView: () => {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    matches: () => false, contains: () => false,
    offsetWidth: 0, offsetHeight: 0, scrollHeight: 0, scrollTop: 0,
  };
  return el;
}

class CustomEventStub { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } }
class EventStub { constructor(type) { this.type = type; } }

/*
 * Loads a fresh copy of the real public/app.js into its own sandbox: its own elements, its own
 * localStorage, its own set of altana-action listeners. Fresh per test so one test's state (a
 * flipped setting, a chat array) can never leak into the next.
 */
function loadApp() {
  const elements = new Map();
  const getEl = (id) => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); };

  const docListeners = new Map();
  const documentStub = {
    getElementById: (id) => getEl(id),
    createElement: (tag) => makeElement("_created_" + tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { if (!docListeners.has(type)) docListeners.set(type, []); docListeners.get(type).push(fn); },
    removeEventListener: (type, fn) => { const a = docListeners.get(type); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    dispatchEvent: (e) => { (docListeners.get(e.type) || []).slice().forEach((fn) => fn(e)); return true; },
    body: makeElement("body"),
    documentElement: makeElement("html"),
    readyState: "complete",
    execCommand: () => {},
    hasFocus: () => true,
    visibilityState: "visible",
    hidden: false,
    title: "Dominion AI",
  };

  const lsStore = new Map();
  const localStorageStub = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)); },
    removeItem: (k) => { lsStore.delete(k); },
    clear: () => lsStore.clear(),
  };

  const windowListeners = new Map();
  const sandbox = {};
  Object.assign(sandbox, {
    document: documentStub,
    localStorage: localStorageStub,
    navigator: { serviceWorker: undefined, clipboard: { writeText: async () => {} }, language: "en-US", mediaDevices: undefined, userAgent: "node-test" },
    CustomEvent: CustomEventStub,
    Event: EventStub,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => new Promise(() => {}),   // never resolves: nothing in these tests waits on a network round trip
    crypto, URL, Blob, structuredClone,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    open: () => null,
    innerWidth: 1280, innerHeight: 800,
    location: { href: "http://localhost/", search: "", hash: "", pathname: "/" },
    history: { pushState: () => {}, replaceState: () => {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    addEventListener: (type, fn) => { if (!windowListeners.has(type)) windowListeners.set(type, []); windowListeners.get(type).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: (e) => { (windowListeners.get(e.type) || []).forEach((fn) => fn(e)); return true; },
  });
  sandbox.window = sandbox;   // real browsers: window IS the global object, so top-level `function`s attach to it
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(APP_SOURCE, ctx, { filename: "app.js" });

  const results = [];
  documentStub.addEventListener("altana:action-result", (e) => results.push(e.detail));

  return {
    document: documentStub,
    localStorage: localStorageStub,
    ctx,
    results,
    dispatch(detail) { documentStub.dispatchEvent(new CustomEventStub("altana:action", { detail })); },
  };
}

/* ---------------------------------------------------------------------------------------------- *
 * The client controls each settable setting is expected to drive, established by reading app.js:
 *   privacy_mode -> the #privacy-mode <select> (existing "trusted/normal/private" allow-list mode)
 *   model        -> the #model <select> (the model routing/persistence app.js already has)
 *   sound        -> the #speak auto-speak toggle button
 * Every other entry in ALTANA_SETTABLE_SETTINGS has no client-side control in app.js today, so the
 * listener must report ok:false with a reason rather than pretend to apply it.
 * ---------------------------------------------------------------------------------------------- */
const HAS_CLIENT_PATH = new Set(["privacy_mode", "model", "sound"]);

t("app.js loads cleanly in the fake DOM (a real syntax/runtime smoke test, not just node --check)", () => {
  const app = loadApp();
  assert.ok(app.document, "app.js must execute top to bottom without throwing");
});

t("every entry in the REAL ALTANA_SETTABLE_SETTINGS list either applies through an existing app control, or is refused honestly with a reason", () => {
  assert.ok(Array.isArray(ALTANA_SETTABLE_SETTINGS) && ALTANA_SETTABLE_SETTINGS.length > 0, "the imported allow-list must be real");
  for (const setting of ALTANA_SETTABLE_SETTINGS) {
    const app = loadApp();
    if (setting === "privacy_mode") {
      const el = app.document.getElementById("privacy-mode");
      el.options = [{ value: "normal" }, { value: "trusted" }, { value: "private" }];
      el.value = "normal";
      app.dispatch({ type: "set_setting", setting, value: "trusted" });
      assert.equal(app.results.length, 1, setting + " must emit exactly one result");
      assert.equal(app.results[0].ok, true, setting + " must report ok:true: " + JSON.stringify(app.results[0]));
      assert.equal(el.value, "trusted", "privacy_mode must actually move the #privacy-mode select");
      assert.equal(app.localStorage.getItem("dominion.privacy-mode.v1"), "trusted",
        "privacy_mode must persist through the app's OWN existing change handler, not a reimplementation");
    } else if (setting === "model") {
      const el = app.document.getElementById("model");
      el.options = [{ value: "seat-a" }, { value: "seat-b" }];
      el.value = "seat-a";
      app.dispatch({ type: "set_setting", setting, value: "seat-b" });
      assert.equal(app.results.length, 1, setting + " must emit exactly one result");
      assert.equal(app.results[0].ok, true, setting + " must report ok:true: " + JSON.stringify(app.results[0]));
      assert.equal(el.value, "seat-b", "model must actually move the #model select");
      assert.equal(app.localStorage.getItem("minipc-chat.model.v1"), "seat-b",
        "model must persist through the app's OWN existing change handler, not a reimplementation");
    } else if (setting === "sound") {
      assert.equal(app.localStorage.getItem("dominion.speak.v1"), null, "auto-speak must start unset (off) in a fresh app");
      app.dispatch({ type: "set_setting", setting, value: "on" });
      assert.equal(app.results.length, 1, setting + " must emit exactly one result");
      assert.equal(app.results[0].ok, true, setting + " must report ok:true: " + JSON.stringify(app.results[0]));
      assert.equal(app.localStorage.getItem("dominion.speak.v1"), "1",
        "sound must persist through the app's OWN existing auto-speak click handler, not a reimplementation");
    } else {
      // No client-side control exists in app.js for this one. The honest outcome is ok:false with
      // a reason, not a silent success Altana never actually delivered.
      app.dispatch({ type: "set_setting", setting, value: "anything" });
      assert.equal(app.results.length, 1, setting + " must still emit exactly one result");
      assert.equal(app.results[0].ok, false, setting + " has no client control and must report ok:false, not a false success");
      assert.ok(app.results[0].reason && app.results[0].reason.length > 0, setting + " must give Altana a reason she can relay");
    }
    assert.ok(!HAS_CLIENT_PATH.has(setting) || HAS_CLIENT_PATH.has(setting), "sanity"); // documents intent, always true
  }
});

t("a setting NOT in ALTANA_SETTABLE_SETTINGS is rejected, even with a plausible value", () => {
  assert.ok(!ALTANA_SETTABLE_SETTINGS.includes("billing_limit"), "test setup: this key must genuinely be off the real list");
  const app = loadApp();
  app.dispatch({ type: "set_setting", setting: "billing_limit", value: "1000" });
  assert.equal(app.results.length, 1);
  assert.equal(app.results[0].ok, false, "an unlisted setting must never be accepted");
  assert.match(app.results[0].reason, /not a setting/i);
});

t("an unknown action type is ignored without throwing, and emits no result", () => {
  const app = loadApp();
  assert.doesNotThrow(() => app.dispatch({ type: "delete_everything", payload: "x" }));
  assert.doesNotThrow(() => app.dispatch({ type: 12345 }));
  assert.doesNotThrow(() => app.dispatch({}));
  assert.doesNotThrow(() => app.document.dispatchEvent(new CustomEventStub("altana:action", { detail: null })));
  assert.doesNotThrow(() => app.document.dispatchEvent(new CustomEventStub("altana:action", { detail: "just a string" })));
  assert.doesNotThrow(() => app.document.dispatchEvent(new CustomEventStub("altana:action", { detail: ["array", "not", "object"] })));
  assert.equal(app.results.length, 0, "nothing here is a recognized, actionable type, so nothing should report a result");
});

t("echo_settings / help / work_list are recognized but intentionally not acted on (Altana's own panel renders them)", () => {
  const app = loadApp();
  app.dispatch({ type: "echo_settings" });
  app.dispatch({ type: "help", text: "here is how privacy mode works" });
  app.dispatch({ type: "work_list", items: [{ id: "1", title: "a task" }] });
  assert.equal(app.results.length, 0, "these are deliberately ignored here, so no result event should fire");
});

t("hostile detail: a prototype-polluting setting key cannot escape validation or reach a handler", () => {
  const app = loadApp();
  for (const key of ["__proto__", "constructor", "prototype", "hasOwnProperty", "toString"]) {
    app.dispatch({ type: "set_setting", setting: key, value: "x" });
  }
  assert.equal(app.results.length, 5);
  for (const r of app.results) {
    assert.equal(r.ok, false, "a prototype-chain key must never be accepted as a setting: " + JSON.stringify(r));
  }
});

t("hostile detail: a function passed as a setting value is rejected, never invoked, never leaks a return value", () => {
  const app = loadApp();
  let called = false;
  const bomb = () => { called = true; return "pwned"; };
  app.dispatch({ type: "set_setting", setting: "sound", value: bomb });
  assert.equal(app.results.length, 1);
  assert.equal(app.results[0].ok, false, "a function value must be rejected");
  assert.equal(called, false, "the function must never be invoked by the listener");
});

t("hostile detail: a 10,000-character string value is rejected rather than truncated-and-applied", () => {
  const app = loadApp();
  const el = app.document.getElementById("model");
  el.options = [{ value: "seat-a" }];
  el.value = "seat-a";
  app.dispatch({ type: "set_setting", setting: "model", value: "x".repeat(10000) });
  assert.equal(app.results.length, 1);
  assert.equal(app.results[0].ok, false, "an oversized value must be rejected outright");
  assert.equal(el.value, "seat-a", "the control must be untouched by the oversized value");

  // The setting NAME itself can also be the oversized/hostile string.
  const app2 = loadApp();
  app2.dispatch({ type: "set_setting", setting: "x".repeat(10000), value: "y" });
  assert.equal(app2.results.length, 1);
  assert.equal(app2.results[0].ok, false, "an oversized setting name must be rejected outright");
});

t("hostile detail: a nested object where a string belongs is rejected, not coerced", () => {
  const app = loadApp();
  const el = app.document.getElementById("privacy-mode");
  el.options = [{ value: "normal" }, { value: "trusted" }];
  el.value = "normal";
  app.dispatch({ type: "set_setting", setting: "privacy_mode", value: { toString: () => "trusted" } });
  assert.equal(app.results.length, 1);
  assert.equal(app.results[0].ok, false, "an object must never be silently coerced to its toString()");
  assert.equal(el.value, "normal", "the control must be untouched");

  // Same shape of attack against open_screen's `screen` field.
  const app2 = loadApp();
  app2.dispatch({ type: "open_screen", screen: { toString: () => "settings" } });
  assert.equal(app2.results.length, 1);
  assert.equal(app2.results[0].ok, false, "open_screen must reject a non-string screen id the same way");
});

t("a value that is not one of the control's real options is rejected, not force-set", () => {
  const app = loadApp();
  const el = app.document.getElementById("privacy-mode");
  el.options = [{ value: "normal" }, { value: "trusted" }, { value: "private" }];
  el.value = "normal";
  app.dispatch({ type: "set_setting", setting: "privacy_mode", value: "godmode" });
  assert.equal(app.results[0].ok, false, "a value with no matching <option> must be refused");
  assert.equal(el.value, "normal", "the select must not move to an option that does not exist");
});

t("open_screen navigates using the app's own open*/close* functions, and reports honestly when a screen is unknown", () => {
  const app = loadApp();
  const smodal = app.document.getElementById("smodal");
  smodal.hidden = true;
  app.dispatch({ type: "open_screen", screen: "settings" });
  assert.equal(app.results.length, 1);
  assert.equal(app.results[0].ok, true, "settings is a real screen this app can open");
  assert.equal(smodal.hidden, false, "open_screen must have actually called the app's real openSettings(), not merely reported success");

  const app2 = loadApp();
  app2.dispatch({ type: "open_screen", screen: "a-screen-that-does-not-exist" });
  assert.equal(app2.results.length, 1);
  assert.equal(app2.results[0].ok, false, "an unrecognized screen id must be refused honestly, not guessed at");
});

t("every HANDLED action (set_setting, open_screen) emits exactly one altana:action-result", () => {
  const app = loadApp();
  const el = app.document.getElementById("model");
  el.options = [{ value: "seat-a" }];
  el.value = "seat-a";

  app.dispatch({ type: "set_setting", setting: "model", value: "seat-a" });
  assert.equal(app.results.length, 1);

  app.dispatch({ type: "open_screen", screen: "memory" });
  assert.equal(app.results.length, 2);

  app.dispatch({ type: "set_setting", setting: "nonexistent_setting_xyz", value: "1" });
  assert.equal(app.results.length, 3);

  // Ignored types add nothing.
  app.dispatch({ type: "echo_settings" });
  app.dispatch({ type: "totally_unknown" });
  assert.equal(app.results.length, 3, "ignored/unknown types must never add a result");
});

console.log(`\n${passed} checks passed - Altana's client actions apply through app.js's real controls, and are refused honestly where none exist`);

// Every loadApp() call executes the real app.js, which registers its own top-level setInterval
// polling loops (sync/version/pace checks). Those are real Node timers keeping this process's
// event loop alive forever in a test context with no server behind them, so exit explicitly now
// that every assertion above has already run and thrown if anything failed.
process.exit(0);
