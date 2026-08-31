/*
 * SD Tech Mobile Game Factory — pure domain rules.
 *
 * The UI, HTTP handler, worker and database all import this module. Keeping the lifecycle here
 * prevents a button label, prompt, or background process from inventing a transition the other
 * layers do not understand.
 */

export const FACTORY_MODE_DEFAULT = "off";

export const GAME_STATES = Object.freeze([
  "IDEA",
  "SPECIFICATION",
  "ARCHITECTURE",
  "ASSET_GENERATION",
  "IMPLEMENTATION",
  "INTEGRATION",
  "AUTOMATED_TESTING",
  "PLAYTEST_READY",
  "REVISION",
  "RELEASE_CANDIDATE",
  "APPROVED",
  "STORE_PREP",
  "DEPLOYED",
  "PAUSED",
  "BLOCKED",
  "FAILED",
]);

export const HAPPY_PATH = Object.freeze([
  "IDEA",
  "SPECIFICATION",
  "ARCHITECTURE",
  "ASSET_GENERATION",
  "IMPLEMENTATION",
  "INTEGRATION",
  "AUTOMATED_TESTING",
  "PLAYTEST_READY",
  "RELEASE_CANDIDATE",
  "APPROVED",
  "STORE_PREP",
  "DEPLOYED",
]);

export const TERMINAL_STATES = new Set(["DEPLOYED"]);
export const HOLD_STATES = new Set(["PAUSED", "BLOCKED", "FAILED"]);

const FORWARD = Object.freeze({
  IDEA: ["SPECIFICATION"],
  SPECIFICATION: ["ARCHITECTURE", "REVISION"],
  ARCHITECTURE: ["ASSET_GENERATION", "REVISION"],
  ASSET_GENERATION: ["IMPLEMENTATION", "REVISION"],
  IMPLEMENTATION: ["INTEGRATION", "REVISION"],
  INTEGRATION: ["AUTOMATED_TESTING", "REVISION"],
  AUTOMATED_TESTING: ["PLAYTEST_READY", "REVISION"],
  PLAYTEST_READY: ["RELEASE_CANDIDATE", "REVISION"],
  REVISION: ["SPECIFICATION", "ARCHITECTURE", "ASSET_GENERATION", "IMPLEMENTATION", "INTEGRATION", "AUTOMATED_TESTING", "PLAYTEST_READY"],
  RELEASE_CANDIDATE: ["APPROVED", "REVISION"],
  APPROVED: ["STORE_PREP", "REVISION"],
  STORE_PREP: ["DEPLOYED", "REVISION"],
  DEPLOYED: ["REVISION"],
  PAUSED: [],
  BLOCKED: [],
  FAILED: [],
});

export const PORTFOLIO = Object.freeze([
  { order: 1, name: "Vector Vault", slug: "vector-vault" },
  { order: 2, name: "Bolt Bloom", slug: "bolt-bloom" },
  { order: 3, name: "Pocket Gravity", slug: "pocket-gravity" },
  { order: 4, name: "Chromalock", slug: "chromalock" },
  { order: 5, name: "Tiny Foundry", slug: "tiny-foundry" },
  { order: 6, name: "Letter Loom", slug: "letter-loom" },
  { order: 7, name: "Pulse Path", slug: "pulse-path" },
  { order: 8, name: "Shelf Shift", slug: "shelf-shift" },
  { order: 9, name: "Wobble Works", slug: "wobble-works" },
  { order: 10, name: "Signal Grid", slug: "signal-grid" },
]);

export const REQUIRED_GAME_ARTIFACTS = Object.freeze([
  "00_GAME_BRIEF",
  "01_MARKET_CASE",
  "02_RELEASE_ROADMAP",
  "03_BUILD_WORKFLOW",
  "04_GAME_ARCHITECTURE",
  "05_VISUAL_SYSTEM",
  "06_MONETIZATION",
  "07_QA_AND_TESTING",
  "08_STORE_RELEASE",
  "09_HANDOFF_PROMPT",
  "10_COMPLETENESS_REVIEW",
]);

export const MANDATORY_ARTIFACT_BACKENDS = Object.freeze(["chatgpt_project", "google_drive"]);
export const KNOWN_ARTIFACT_BACKENDS = Object.freeze(["primary", ...MANDATORY_ARTIFACT_BACKENDS]);

export const QA_REQUIRED_SUITES = Object.freeze([
  "core-loop",
  "launch-smoke",
  "crash-regression",
  "controls",
  "save-state",
  "viewport",
  "performance",
  "monetization",
  "offline",
  "analytics",
  "privacy-consent",
  "store-readiness",
]);

export const APPROVAL_GATES = Object.freeze([
  "SPECIFICATION",
  "VISUAL_SYSTEM",
  "PLAYTEST",
  "RELEASE_CANDIDATE",
  "LEGAL_AND_PRIVACY",
  "STORE_SUBMISSION",
  "PRODUCTION_RELEASE",
]);

export const APPROVAL_GATE_STATES = Object.freeze({
  SPECIFICATION: ["SPECIFICATION"],
  VISUAL_SYSTEM: ["ARCHITECTURE", "ASSET_GENERATION"],
  PLAYTEST: ["PLAYTEST_READY"],
  RELEASE_CANDIDATE: ["RELEASE_CANDIDATE"],
  LEGAL_AND_PRIVACY: ["RELEASE_CANDIDATE", "APPROVED", "STORE_PREP"],
  STORE_SUBMISSION: ["STORE_PREP"],
  PRODUCTION_RELEASE: ["STORE_PREP"],
});

export function approvalAllowed(state, gate) {
  return !!APPROVAL_GATE_STATES[String(gate || "").toUpperCase()]?.includes(String(state || "").toUpperCase());
}

export const TASK_CAPABILITIES = Object.freeze([
  "product_planning",
  "gameplay_engineering",
  "visual_design",
  "quality_assurance",
  "release_coordination",
  "godot",
  "android",
  "ios",
  "artifact_mirroring",
]);

export function createGameFactoryGate(raw) {
  const mode = String(raw ?? FACTORY_MODE_DEFAULT).trim().toLowerCase();
  const all = mode === "all" || mode === "1";
  const owner = mode === "owner";
  return {
    mode,
    allowed(T) {
      if (!T || T.role === "anon") return false;
      return all || (owner && T.isOwner === true);
    },
  };
}

export function isGameState(value) {
  return GAME_STATES.includes(String(value || ""));
}

export function allowedTransitions(state, { resumeState = "" } = {}) {
  const from = String(state || "");
  if (from === "PAUSED" || from === "BLOCKED" || from === "FAILED") {
    return isGameState(resumeState) && !HOLD_STATES.has(resumeState) ? [resumeState] : [];
  }
  const ordinary = FORWARD[from] || [];
  if (from === "DEPLOYED") return [...ordinary];
  return [...ordinary, "PAUSED", "BLOCKED", "FAILED"];
}

export function defaultNextState(state) {
  const i = HAPPY_PATH.indexOf(String(state || ""));
  return i >= 0 && i < HAPPY_PATH.length - 1 ? HAPPY_PATH[i + 1] : "";
}

export function transitionDecision(project, toState, evidence = {}) {
  const from = String(project && project.state || "");
  const to = String(toState || "");
  if (!isGameState(from) || !isGameState(to)) return { ok: false, code: "bad_state", error: "Unknown game lifecycle state." };
  if (from === to) return { ok: true, noop: true };
  if (!allowedTransitions(from, { resumeState: project.resumeState }).includes(to)) {
    return { ok: false, code: "illegal_transition", error: `A game cannot move from ${from} to ${to}.` };
  }

  // These gates are facts, not suggestions. The store passes evidence from durable records.
  if (from === "SPECIFICATION" && to === "ARCHITECTURE" && !evidence.specificationApproved) {
    return { ok: false, code: "specification_approval_required", error: "The owner must approve the current game specification before architecture work begins." };
  }
  if (from === "ARCHITECTURE" && to === "ASSET_GENERATION" && !evidence.visualSystemApproved) {
    return { ok: false, code: "visual_approval_required", error: "The owner must approve the current visual system before asset generation begins." };
  }
  if (from === "AUTOMATED_TESTING" && to === "PLAYTEST_READY" && !evidence.qaReady) {
    return {
      ok: false,
      code: "tests_required",
      error: "Every required automated QA suite must pass for this exact build before owner playtesting.",
      missing: evidence.qaMissing || [],
    };
  }
  if (from === "PLAYTEST_READY" && to === "RELEASE_CANDIDATE" && !evidence.playtestApproved) {
    return { ok: false, code: "playtest_approval_required", error: "Owner playtest approval is required for this exact build." };
  }
  if (from === "RELEASE_CANDIDATE" && to === "APPROVED" && !evidence.releaseCandidateApproved) {
    return { ok: false, code: "release_approval_required", error: "The release candidate must be approved for this exact build." };
  }
  if (from === "RELEASE_CANDIDATE" && to === "APPROVED" && !evidence.qaReady) {
    return { ok: false, code: "qa_gate_required", error: "Every required QA suite must pass for this exact build before approval.", missing: evidence.qaMissing || [] };
  }
  if (from === "APPROVED" && to === "STORE_PREP" && !evidence.artifactsComplete) {
    return { ok: false, code: "artifact_copies_required", error: "Every required artifact needs two verified copies before store preparation." };
  }
  if (from === "APPROVED" && to === "STORE_PREP" && !evidence.legalAndPrivacyApproved) {
    return { ok: false, code: "legal_privacy_approval_required", error: "The publisher must approve the current legal and privacy evidence before store preparation." };
  }
  if (from === "STORE_PREP" && to === "DEPLOYED") {
    if (!evidence.storeSubmissionApproved) {
      return { ok: false, code: "store_submission_approval_required", error: "A current human store-submission approval is required." };
    }
    if (!evidence.productionReleaseApproved) {
      return { ok: false, code: "production_approval_required", error: "A current human production-release approval is required." };
    }
    if (!evidence.releaseReady) {
      return { ok: false, code: "release_not_ready", error: "The platform release record is not ready for production." };
    }
  }
  return { ok: true };
}

export function stateProgress(state) {
  const value = String(state || "");
  const i = HAPPY_PATH.indexOf(value);
  if (i >= 0) return Math.round((i / (HAPPY_PATH.length - 1)) * 100);
  if (value === "REVISION") return 55;
  return 0;
}

export function projectIdFor(uid, slug) {
  const cleanUid = String(uid || "owner").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "owner";
  const cleanSlug = String(slug || "game").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "game";
  return `gf_${cleanUid}_${cleanSlug}`;
}

export function normalizeIdempotencyKey(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 160);
}
