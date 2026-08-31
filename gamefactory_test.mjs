import assert from "node:assert/strict";
import {
  GAME_STATES, HAPPY_PATH, PORTFOLIO, REQUIRED_GAME_ARTIFACTS,
  createGameFactoryGate, allowedTransitions, defaultNextState, transitionDecision,
  stateProgress, projectIdFor, normalizeIdempotencyKey,
} from "./gamefactory.mjs";

let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok", n, "-", name); };

test("the required lifecycle has every handoff state exactly once", () => {
  assert.equal(GAME_STATES.length, 16);
  assert.equal(new Set(GAME_STATES).size, 16);
  for (const state of ["IDEA", "SPECIFICATION", "ARCHITECTURE", "ASSET_GENERATION", "IMPLEMENTATION", "INTEGRATION", "AUTOMATED_TESTING", "PLAYTEST_READY", "REVISION", "RELEASE_CANDIDATE", "APPROVED", "STORE_PREP", "DEPLOYED", "PAUSED", "BLOCKED", "FAILED"]) assert.ok(GAME_STATES.includes(state));
});

test("portfolio and artifact standards are complete", () => {
  assert.equal(PORTFOLIO.length, 10);
  assert.equal(PORTFOLIO[0].name, "Vector Vault");
  assert.equal(PORTFOLIO[9].name, "Signal Grid");
  assert.equal(REQUIRED_GAME_ARTIFACTS.length, 11);
});

test("factory gate fails closed and requires an explicit mode", () => {
  assert.equal(createGameFactoryGate().allowed({ isOwner: true, role: "owner" }), false);
  assert.equal(createGameFactoryGate("owner").allowed({ isOwner: true, role: "owner" }), true);
  assert.equal(createGameFactoryGate().allowed({ isOwner: false, role: "credit" }), false);
  assert.equal(createGameFactoryGate("all").allowed({ isOwner: false, role: "credit" }), true);
  assert.equal(createGameFactoryGate("off").allowed({ isOwner: true, role: "owner" }), false);
  assert.equal(createGameFactoryGate("typo").allowed({ isOwner: true, role: "owner" }), false);
});

test("happy path is forward-only and interruption states are explicit", () => {
  assert.equal(defaultNextState("IDEA"), "SPECIFICATION");
  assert.equal(defaultNextState("STORE_PREP"), "DEPLOYED");
  assert.equal(defaultNextState("DEPLOYED"), "");
  assert.deepEqual(allowedTransitions("PAUSED", { resumeState: "IMPLEMENTATION" }), ["IMPLEMENTATION"]);
  assert.ok(allowedTransitions("IMPLEMENTATION").includes("PAUSED"));
  assert.ok(!allowedTransitions("IDEA").includes("DEPLOYED"));
});

test("evidence gates refuse unproved progress", () => {
  assert.equal(transitionDecision({ state: "SPECIFICATION" }, "ARCHITECTURE").code, "specification_approval_required");
  assert.equal(transitionDecision({ state: "ARCHITECTURE" }, "ASSET_GENERATION").code, "visual_approval_required");
  assert.equal(transitionDecision({ state: "AUTOMATED_TESTING" }, "PLAYTEST_READY", { automatedTestsPassed: true }).code, "tests_required");
  assert.equal(transitionDecision({ state: "AUTOMATED_TESTING" }, "PLAYTEST_READY", { qaReady: true }).ok, true);
  assert.equal(transitionDecision({ state: "PLAYTEST_READY" }, "RELEASE_CANDIDATE").code, "playtest_approval_required");
  assert.equal(transitionDecision({ state: "RELEASE_CANDIDATE" }, "APPROVED").code, "release_approval_required");
  assert.equal(transitionDecision({ state: "RELEASE_CANDIDATE" }, "APPROVED", { releaseCandidateApproved: true }).code, "qa_gate_required");
  assert.equal(transitionDecision({ state: "RELEASE_CANDIDATE" }, "APPROVED", { releaseCandidateApproved: true, qaReady: true }).ok, true);
  assert.equal(transitionDecision({ state: "APPROVED" }, "STORE_PREP").code, "artifact_copies_required");
  assert.equal(transitionDecision({ state: "APPROVED" }, "STORE_PREP", { artifactsComplete: true }).code, "legal_privacy_approval_required");
  assert.equal(transitionDecision({ state: "APPROVED" }, "STORE_PREP", { artifactsComplete: true, legalAndPrivacyApproved: true }).ok, true);
  assert.equal(transitionDecision({ state: "STORE_PREP" }, "DEPLOYED", { productionReleaseApproved: true }).code, "store_submission_approval_required");
  assert.equal(transitionDecision({ state: "STORE_PREP" }, "DEPLOYED", { storeSubmissionApproved: true, productionReleaseApproved: true }).code, "release_not_ready");
  assert.equal(transitionDecision({ state: "STORE_PREP" }, "DEPLOYED", { storeSubmissionApproved: true, productionReleaseApproved: true, releaseReady: true }).ok, true);
});

test("progress and identifiers are stable", () => {
  assert.equal(stateProgress(HAPPY_PATH[0]), 0);
  assert.equal(stateProgress(HAPPY_PATH.at(-1)), 100);
  assert.equal(projectIdFor("OWNER", "Vector Vault"), "gf_owner_vector-vault");
  assert.equal(normalizeIdempotencyKey(" a/b:c? "), "ab:c");
});

console.log(`\n${n} game factory domain tests passed`);
