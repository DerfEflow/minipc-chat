/*
 * Wave 3 (browser + desktop reach) — the guards, the wiring, and the tenant wall.
 * Run: node wave3_test.mjs
 */
import assert from "node:assert/strict";
import { TOOL_DEFS, toolMeta, assertNotProtected, runTool } from "./tools.mjs";
import { SAFE_TOOLS, FORGE_TOOLS, filterToolDefs, toolAllowedFor } from "./tenantstores.mjs";
import { _test as desktopTest } from "./hands/desktop.mjs";

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok - " + name); }
  catch (e) { fail++; console.log("  FAIL - " + name + "\n        " + (e.message || e)); }
}
console.log("wave3_test:");

const names = TOOL_DEFS.map((d) => d.function.name);

await t("both tools exist and are gated dangerous", () => {
  for (const n of ["browser_control", "desktop_control"]) {
    assert.ok(names.includes(n), n + " missing from TOOL_DEFS");
    assert.equal(toolMeta(n).permissionClass, "dangerous", n + " must be dangerous-class");
    assert.equal(toolMeta(n).category, "machine");
  }
});

await t("schemas expose the ops the node implements", () => {
  const b = TOOL_DEFS.find((d) => d.function.name === "browser_control").function.parameters;
  for (const op of ["open", "navigate", "read", "elements", "click", "type", "eval", "screenshot", "tabs", "back", "close"]) {
    assert.ok(b.properties.op.enum.includes(op), "browser op missing: " + op);
  }
  const d = TOOL_DEFS.find((d) => d.function.name === "desktop_control").function.parameters;
  for (const op of ["screenshot", "windows", "focus", "move", "click", "type", "key"]) {
    assert.ok(d.properties.op.enum.includes(op), "desktop op missing: " + op);
  }
});

await t("CARVE-OUT: protected paths refused in browser and desktop args", () => {
  for (const args of [{ op: "navigate", url: "file:///D:/backups/corpus.db" }, { op: "eval", expression: "fetch('D:\\\\app-backups')" }]) {
    assert.equal(assertNotProtected("browser_control", args).ok, false, "should refuse: " + JSON.stringify(args));
  }
  assert.equal(assertNotProtected("desktop_control", { op: "type", text: "cd D:\\db-backups" }).ok, false);
  assert.equal(assertNotProtected("desktop_control", { op: "type", text: "pg_dump prod" }).ok, false);
  // and normal work is NOT refused
  assert.equal(assertNotProtected("browser_control", { op: "navigate", url: "https://github.com" }).ok, true);
  assert.equal(assertNotProtected("desktop_control", { op: "click", x: 100, y: 200 }).ok, true);
});

await t("node-side desktop guard refuses protected typed text and window titles", () => {
  assert.equal(desktopTest.protectedHit("open D:\\backups"), true);
  assert.equal(desktopTest.protectedHit("app-backups"), true);
  assert.equal(desktopTest.protectedHit("pg_restore"), true);
  assert.equal(desktopTest.protectedHit("hello world"), false);
});

await t("desktop scripts build for every op and escape quotes safely", () => {
  for (const op of ["screenshot", "windows", "focus", "move", "click", "type", "key"]) {
    const built = desktopTest.desktopScript(op, { x: 5, y: 6, text: "hi", keys: "^s", title: "Notepad" }, "C:\\shots");
    assert.ok(built && built.script.length > 20, op + " produced no script");
  }
  const inj = desktopTest.desktopScript("type", { text: "it's a 'quoted' string" }, "C:\\shots");
  assert.ok(inj.script.includes("it''s"), "single quotes must be doubled for PowerShell");
  const special = desktopTest.desktopScript("type", { text: "50% + 3^2 (test)" }, "C:\\shots");
  assert.ok(/\{%\}/.test(special.script) && /\{\+\}/.test(special.script), "SendKeys metacharacters must be braced");
});

await t("TENANT WALL: guests never see browser/desktop, even with Forge engaged", () => {
  for (const n of ["browser_control", "desktop_control"]) {
    assert.equal(SAFE_TOOLS.has(n), false, n + " must not be in SAFE_TOOLS");
    assert.equal(FORGE_TOOLS.has(n), false, n + " must not be in FORGE_TOOLS");
    assert.equal(toolAllowedFor("credit", n, FORGE_TOOLS), false, n + " reachable by a credit user");
    assert.equal(toolAllowedFor("sponsored", n, FORGE_TOOLS), false, n + " reachable by a sponsored user");
    assert.equal(toolAllowedFor("owner", n), true, n + " must be owner-reachable");
  }
  const guestDefs = filterToolDefs(TOOL_DEFS, "credit", FORGE_TOOLS).map((d) => d.function.name);
  assert.ok(!guestDefs.includes("browser_control") && !guestDefs.includes("desktop_control"));
  const ownerDefs = filterToolDefs(TOOL_DEFS, "owner").map((d) => d.function.name);
  assert.ok(ownerDefs.includes("browser_control") && ownerDefs.includes("desktop_control"));
});

await t("no hands node = honest refusal, never a silent success", async () => {
  const b = await runTool("browser_control", { op: "read" }, {});
  assert.match(b, /needs a connected Dominion hands node/i);
  const d = await runTool("desktop_control", { op: "screenshot" }, {});
  assert.match(d, /needs a connected Dominion hands node/i);
});

await t("node refusals surface as BLOCKED, node errors surface honestly", async () => {
  const refusing = { hands: { dispatch: async () => ({ ok: false, refused: true, reason: "desktop control is switched off on this node" }) } };
  assert.match(await runTool("desktop_control", { op: "screenshot" }, refusing), /^BLOCKED: desktop control is switched off/);
  const erroring = { hands: { dispatch: async () => ({ ok: false, error: "browser did not open its debugging port in 10s" }) } };
  assert.match(await runTool("browser_control", { op: "open" }, erroring), /failed.*debugging port/i);
});

await t("browser results render for the model in each op shape", async () => {
  const ctx = (r) => ({ hands: { dispatch: async () => r } });
  assert.match(await runTool("browser_control", { op: "read" }, ctx({ ok: true, title: "Hi", url: "https://x.com", text: "body text" })), /^Hi — https:\/\/x\.com\n\nbody text$/);
  assert.match(await runTool("browser_control", { op: "elements" }, ctx({ ok: true, elements: [{ tag: "button", type: "", text: "Sign in", id: "go", name: "", href: "" }] })), /<button> #go "Sign in"/);
  assert.match(await runTool("browser_control", { op: "screenshot" }, ctx({ ok: true, path: "C:\\shots\\a.png", bytes: 1234 })), /Screenshot saved on the machine: C:\\shots\\a\.png \(1234 bytes\)/);
  assert.match(await runTool("desktop_control", { op: "windows" }, ctx({ ok: true, windows: ["12 | notepad | Untitled"] })), /notepad \| Untitled/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
