import { modelToolResult, toolMutationSucceeded, toolResultFailed } from "./toolresult.mjs";

let passed = 0;
const ok = (condition, message) => {
  if (!condition) throw new Error(message);
  passed++;
};

ok(modelToolResult("small result") === "small result", "small results must stay byte-identical");

const footer = "[file continues: call forge_read with offset:48000]";
const huge = "HEADER\n" + "x".repeat(90_000) + "\n" + footer;
const windowed = modelToolResult(huge, 20_000);
ok(windowed.length <= 20_000, "window must honor the cap");
ok(windowed.startsWith("HEADER"), "window must preserve the beginning");
ok(windowed.endsWith(footer), "window must preserve the paging footer");
ok(windowed.includes("middle was omitted"), "window must disclose truncation");

ok(toolResultFailed("exit 1\nTypeScript failed"), "nonzero command exit must fail");
ok(toolResultFailed("ran command\nexit 2\nbad"), "embedded nonzero exit must fail");
ok(toolResultFailed("BLOCKED: protected backup"), "blocked actions must fail");
ok(!toolResultFailed("exit 0\nall tests passed"), "successful command must not fail");
ok(toolResultFailed("NO CHANGE: file already contains those bytes"), "an unchanged direct write must fail");
ok(toolResultFailed("EDIT REFUSED: expected one match, found zero"), "a refused edit must fail");
ok(toolResultFailed("No response from the machine; try again"), "an offline hands result must fail");

const unchangedRun = "tests passed\nexit 0\nNO TRACKED CHANGE: the command ran but left every measured repository byte-for-byte equivalent.";
ok(!toolResultFailed(unchangedRun), "an exit-zero validation is successful even when it mutates nothing");
ok(!toolMutationSucceeded("forge_run", { command: "npm test" }, unchangedRun, "dangerous"),
  "an exit-zero read/test command must never count as mutation evidence");
ok(toolMutationSucceeded("forge_run", { command: "npm test" }, "exit 0\nCHANGE: 1 tracked repo changed.", "dangerous"),
  "measured repository change must count as mutation evidence");
ok(toolMutationSucceeded("forge_write", { path: "a" }, "CHANGED: wrote 12 bytes to a.", "dangerous"),
  "a measured direct write must count");
ok(!toolMutationSucceeded("forge_write", { path: "a" }, "NO CHANGE: identical bytes.", "dangerous"),
  "an unchanged direct write must not count");
ok(!toolMutationSucceeded("forge_run", { command: "git push origin main" }, "Everything up-to-date\nexit 0\nNO TRACKED CHANGE: local bytes unchanged.", "dangerous"),
  "a no-op external command must not count merely because it exited zero");
ok(toolMutationSucceeded("forge_run", { command: "git push origin main" }, "abc1234..def5678  main -> main\nexit 0\nNO TRACKED CHANGE: local bytes unchanged.", "dangerous"),
  "provider output proving an external publish may count despite unchanged local bytes");
ok(!toolMutationSucceeded("browser_control", { op: "read" }, "Current page text", "dangerous"),
  "browser reads must not masquerade as build mutations");
ok(!toolMutationSucceeded("browser_control", { op: "screenshot" }, "Screenshot saved", "dangerous"),
  "browser screenshots must not masquerade as build mutations");
ok(!toolMutationSucceeded("desktop_control", { op: "screenshot" }, "Screen captured", "dangerous"),
  "desktop screenshots must not masquerade as build mutations");
ok(!toolMutationSucceeded("run_python_sandbox", { code: "print(2 + 2)" }, "4", "dangerous"),
  "print-only computation must not masquerade as build mutation");
ok(toolMutationSucceeded("browser_control", { op: "click" }, "Clicked #save.", "dangerous"),
  "an observed browser interaction can support an explicitly requested external action");
ok(toolMutationSucceeded("cx_google__create_event", {}, "Created event id 17", "requires_confirmation"),
  "runtime connector creation verbs can supply mutation evidence");
ok(!toolMutationSucceeded("cx_google__list_events", {}, "three events", "requires_confirmation"),
  "runtime connector reads must not supply mutation evidence");

console.log(`toolresult: ${passed} passed, 0 failed`);
