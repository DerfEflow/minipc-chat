/*
 * Feature-map self-test — run: node features_test.mjs
 *
 * Fred, 2026-07-19: he wants every model able to answer "what can this do, how do I use it, where
 * is it", and to point at the image studio when someone asks for an image instead of improvising.
 * The danger with feature copy is drift: the moment it describes a control that no longer exists,
 * it is worse than nothing. These tests check the map is complete, that the lookup answers, and
 * that the locations it claims are real by checking them against the shipped interface.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURES, featureIndex, featureHelp } from "./features.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

t("every feature carries a location, a purpose and real steps", () => {
  for (const f of FEATURES) {
    if (!f.id || !f.name) throw new Error("a feature is missing id/name");
    if (!f.where || f.where.length < 8) throw new Error(f.id + ": no usable location");
    if (!f.what || f.what.length < 15) throw new Error(f.id + ": no purpose");
    if (!Array.isArray(f.how) || !f.how.length) throw new Error(f.id + ": no steps");
  }
});

t("the always-on index stays small enough to ride every turn", () => {
  const idx = featureIndex();
  const approxTokens = Math.ceil(idx.length / 4);
  if (approxTokens > 400) throw new Error("index is " + approxTokens + " tokens, too heavy for every call");
  if (!/Forge Images/.test(idx)) throw new Error("index missing image generation");
});

t("lookup answers for names, ids, keywords and 'all'", () => {
  for (const q of ["images", "Dominion Forge Images", "image", "forge dial", "documents", "artifacts", "voice", "chat sync", "privacy", "connectors"]) {
    const r = featureHelp(q);
    if (!/WHERE:/.test(r)) throw new Error("no answer for: " + q);
  }
  if (featureHelp("all").split("WHERE:").length - 1 !== FEATURES.length) throw new Error("'all' did not return every feature");
});

t("an unknown topic says so and lists the real options, never invents one", () => {
  const r = featureHelp("time machine");
  if (!/No feature matches/.test(r)) throw new Error("did not admit the miss");
  if (!/Dominion Forge Images/.test(r)) throw new Error("did not offer the real list");
});

t("the image answer names the control a user can actually find", () => {
  const r = featureHelp("images");
  if (!/picture button/.test(r) || !/message bar/.test(r)) throw new Error("image location is not concrete: " + r.slice(0, 160));
});

// The anti-drift check: claimed controls must exist in the shipped interface.
const html = readFileSync(join(HERE, "public", "index.html"), "utf8");
const appJs = readFileSync(join(HERE, "public", "app.js"), "utf8");
const imagesJs = readFileSync(join(HERE, "public", "dominion-images.js"), "utf8");
const forgeJs = readFileSync(join(HERE, "public", "dominion-forge.js"), "utf8");

t("the controls the map points at exist in the interface", () => {
  const musts = [
    ['id="attach"', "the paperclip"],
    ['id="forge-trigger"', "the flame (Forge dial)"],
    ['id="mic"', "the microphone"],
    ['id="speak"', "the speaker toggle"],
    ['id="artifacts"', "the artifacts button"],
    ['id="memory"', "the memory button"],
    ['id="sb-setup"', "the Setup button"],
  ];
  for (const [needle, label] of musts) if (!html.includes(needle)) throw new Error("interface is missing " + label + " (" + needle + ")");
  if (!imagesJs.includes('id = "dfi-trigger"')) throw new Error("the image studio trigger is gone");
  if (!imagesJs.includes("IGNITE THE FORGE")) throw new Error("the ignite control the map names is gone");
  if (!imagesJs.includes("BATCH FOUNDRY")) throw new Error("the batch control the map names is gone");
  if (!forgeJs.includes("Seal Setting")) throw new Error("the dial's close control the map names is gone");
  if (!appJs.includes("downloadArtifact")) throw new Error("artifact download is gone but the map promises it");
});

t("features the map claims are wired are actually reachable in code", () => {
  const tools = readFileSync(join(HERE, "tools.mjs"), "utf8");
  if (!tools.includes('"app_help"')) throw new Error("app_help tool is not registered");
  const tenancy = readFileSync(join(HERE, "tenantstores.mjs"), "utf8");
  if (!tenancy.includes('"app_help"')) throw new Error("guests cannot call app_help");
  const server = readFileSync(join(HERE, "server.mjs"), "utf8");
  if (!server.includes("featureIndex()")) throw new Error("the feature index never reaches the system prompt");
});

console.log(`\nfeatures: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
