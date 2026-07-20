/*
 * Guest wall self-test - run with: node guest_wall_test.mjs
 *
 * The bug this exists to prevent, found 2026-07-19: tenantstores.mjs exported toolAllowedFor() and
 * server.mjs never imported it. filterToolDefs() stripped owner-only tools from the schema a guest
 * was SHOWN, and nothing re-checked at execution time. A guest session that emitted forge_run or
 * desktop_control by hallucination or replay would have executed it.
 *
 * So the first and most important check here is a SOURCE check, not a behaviour check: a wall
 * function that nobody calls passes every behavioural test ever written.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toolAllowedFor, filterToolDefs, SAFE_TOOLS, FORGE_TOOLS } from "./tenantstores.mjs";
import { TOOLS } from "./tools.mjs";

let passed = 0;
const ok = (n) => { console.log("  PASS  " + n); passed++; };
const server = readFileSync("./server.mjs", "utf8");

// 1. THE REGRESSION GUARD: the runtime check must be imported and actually called.
{
  assert.match(server, /import\s*\{[^}]*\btoolAllowedFor\b[^}]*\}\s*from\s*["']\.\/tenantstores\.mjs["']/,
    "server.mjs must IMPORT toolAllowedFor - this is the exact bug from 2026-07-19");
  const calls = (server.match(/toolAllowedFor\s*\(/g) || []).length;
  assert.ok(calls >= 2, `server.mjs must CALL toolAllowedFor on both the cloud and local tool paths, found ${calls}`);
  ok("server.mjs imports and calls toolAllowedFor on both dispatch paths");
}

// 2. the local model's tool payload is filtered by role, not handed over whole
{
  assert.match(server, /payload\.tools\s*=\s*filterToolDefs\(/,
    "the local path must filter its tool payload by role");
  ok("the local tool payload is role-filtered");
}

// 3. owner-only tools are refused for every non-owner role
{
  const ownerOnly = ["forge_run", "forge_write", "desktop_control", "browser_control", "deck_capture",
                     "github_read", "search_persona", "scrape_to_persona", "claude_work_order"];
  for (const role of ["credit", "invited", "anon", "guest"]) {
    for (const t of ownerOnly) {
      assert.equal(toolAllowedFor(role, t), false, `${role} must NOT reach ${t}`);
    }
  }
  ok("every non-owner role is refused all 9 sampled owner-only tools");
}

// 4. the owner still gets everything (the wall must not break the product)
{
  for (const t of TOOLS.map((x) => x.def.function.name)) {
    assert.equal(toolAllowedFor("owner", t), true, `owner must reach ${t}`);
  }
  ok(`the owner still reaches all ${TOOLS.length} tools`);
}

// 5. safe tools stay available to guests
{
  for (const t of ["web_search", "create_artifact", "app_help", "sandbox_write", "remember"]) {
    assert.equal(toolAllowedFor("credit", t), true, `a paying guest should keep ${t}`);
  }
  ok("guests keep the safe toolset");
}

// 6. Forge tools reach a guest ONLY when their own Forge is engaged that turn
{
  assert.equal(toolAllowedFor("credit", "forge_run"), false, "no Forge engaged: refused");
  assert.equal(toolAllowedFor("credit", "forge_run", FORGE_TOOLS), true, "Forge engaged: allowed on their OWN node");
  assert.equal(toolAllowedFor("credit", "forge_rollback", FORGE_TOOLS), true, "undo rides along with the ability to change");
  // Engaging Forge must not smuggle in the Wave 3 surfaces Fred deliberately withheld.
  assert.equal(toolAllowedFor("credit", "desktop_control", FORGE_TOOLS), false, "desktop control stays owner-only even with Forge on");
  assert.equal(toolAllowedFor("credit", "browser_control", FORGE_TOOLS), false, "browser control stays owner-only even with Forge on");
  ok("Forge Mode grants only the 5 Forge tools, never desktop or browser control");
}

// 7. schema filtering agrees with the runtime check (no tool shown that would then be refused)
{
  const defs = TOOLS.map((t) => t.def);
  const shown = filterToolDefs(defs, "credit", null).map((d) => d.function.name);
  for (const n of shown) assert.equal(toolAllowedFor("credit", n), true, `${n} is SHOWN to a guest but refused at runtime`);
  const shownForge = filterToolDefs(defs, "credit", FORGE_TOOLS).map((d) => d.function.name);
  for (const n of shownForge) assert.equal(toolAllowedFor("credit", n, FORGE_TOOLS), true, `${n} shown with Forge but refused at runtime`);
  ok("what a guest is shown exactly matches what a guest may run");
}

// 8. Wildfire is owner-only at the server, not merely hidden in the UI
{
  assert.match(server, /wildfireAsked\s*&&\s*!T\.isOwner/, "a non-owner arming Wildfire must be refused server-side");
  ok("Wildfire cannot be armed by a non-owner even if they post the flag");
}

console.log(`\n${passed}/8 checks passed - guest wall verified, including the import that was missing`);
