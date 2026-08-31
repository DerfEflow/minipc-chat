/*
 * SD Tech Mobile Game Factory — release capability and preflight truth.
 *
 * This adapter evaluates whether an already-built package may be uploaded. It never signs a build,
 * never accepts key material, never uploads to a store, and never submits a production release.
 * Persisting a READY/BLOCKED assessment is independently feature-flagged and defaults off.
 */
import { MANDATORY_ARTIFACT_BACKENDS } from "./gamefactory.mjs";

const TRUE = new Set(["1", "true", "yes", "on", "enabled"]);
const SHA256 = /^[a-f0-9]{64}$/i;
const SECRET_KEY = /(authorization|cookie|password|private.?key|secret|token|p12|keystore|provisioning.?profile.?data)/i;
const PLATFORMS = Object.freeze(["android", "ios"]);

const clean = (value, max = 500) => String(value == null ? "" : value).trim().slice(0, max);
const flag = (value) => TRUE.has(clean(value, 20).toLowerCase());
const result = (status, body) => ({ status, body });
const safeError = (value) => clean(value, 500)
  .replace(/\bBearer\s+[^\s,;]+/ig, "Bearer [redacted]")
  .replace(/([?&](?:access_?token|api_?key|key|password|secret|signature)=)[^&#\s]*/ig, "$1[redacted]")
  .replace(/\b(?:access_?token|api_?key|password|secret)\s*[:=]\s*[^\s,;]+/ig, "credential=[redacted]");

export function gameFactoryReleaseFlags(env = process.env) {
  return Object.freeze({
    assessmentWritesEnabled: flag(env.GAME_FACTORY_RELEASE_WRITES),
    storeUploadsEnabled: false,
    finalSubmissionEnabled: false,
  });
}

function bool(value) { return value === true; }
function safeHash(value) { const v = clean(value, 128).toLowerCase(); return SHA256.test(v) ? v : ""; }
function safeId(value, max = 240) { return clean(value, max).replace(/[\r\n\t]/g, " "); }

function safeVersions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, version] of Object.entries(value).slice(0, 30)) {
    if (SECRET_KEY.test(key)) continue;
    const name = clean(key, 60).replace(/[^a-zA-Z0-9._-]/g, "");
    if (name) out[name] = safeId(version, 120);
  }
  return out;
}

function capabilitySnapshot(raw = {}) {
  const account = raw.account && typeof raw.account === "object" ? raw.account : {};
  const signing = raw.signing && typeof raw.signing === "object" ? raw.signing : {};
  const toolchain = raw.toolchain && typeof raw.toolchain === "object" ? raw.toolchain : {};
  const store = raw.store && typeof raw.store === "object" ? raw.store : {};
  return {
    account: {
      connected: bool(account.connected),
      accountId: safeId(account.accountId),
      teamId: safeId(account.teamId),
      role: safeId(account.role, 80),
      apiAccess: bool(account.apiAccess),
      legalStatus: safeId(account.legalStatus, 80).toLowerCase(),
    },
    signing: {
      available: bool(signing.available),
      credentialId: safeId(signing.credentialId),
      keyAlias: safeId(signing.keyAlias, 160),
      certificateSha256: safeHash(signing.certificateSha256),
      profileId: safeId(signing.profileId),
      profileSha256: safeHash(signing.profileSha256),
      expiresAt: safeId(signing.expiresAt, 80),
    },
    toolchain: {
      available: bool(toolchain.available),
      nodeId: safeId(toolchain.nodeId, 160),
      versions: safeVersions(toolchain.versions),
      missing: Array.isArray(toolchain.missing) ? toolchain.missing.slice(0, 30).map((item) => safeId(item, 120)).filter(Boolean) : [],
    },
    store: {
      reachable: bool(store.reachable),
      apiAccess: bool(store.apiAccess),
      accountId: safeId(store.accountId),
      track: safeId(store.track, 80),
    },
  };
}

function safeLocator(value) {
  const locator = safeId(value, 500);
  if (!locator) return "";
  // Store only an opaque ID or a normal store-console URL. Query strings may contain credentials.
  if (/^https:\/\//i.test(locator)) {
    try { const url = new URL(locator); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
    catch { return ""; }
  }
  if (SECRET_KEY.test(locator)) return "";
  return locator.replace(/[?&#].*$/, "");
}

function approvalCurrent(detail, gate, buildId) {
  return (detail.approvals || []).some((approval) => approval.gate === gate && approval.decision === "APPROVED"
    && !approval.invalidatedAt && approval.buildId === buildId);
}

function matchingTestPassed(detail, platform, build) {
  const commit = clean(build.sourceCommit, 128).toLowerCase();
  return (detail.tests || []).some((test) => test.status === "PASSED" && test.buildId === build.id
    && (!test.target || clean(test.target, 40).toLowerCase() === platform)
    && (!commit || clean(test.sourceHash, 128).toLowerCase() === commit));
}

function artifactCompliance(detail) {
  const required = Array.isArray(detail.required) ? detail.required.map((item) => safeId(item, 120)).filter(Boolean) : [];
  const artifacts = Array.isArray(detail.artifacts) ? detail.artifacts : [];
  const byKey = new Map(artifacts.map((artifact) => [artifact.artifactKey, artifact]));
  const verified = (artifact, backend) => (artifact?.copies || []).some((copy) => copy.backend === backend
    && copy.status === "VERIFIED" && clean(copy.algorithm, 32).toLowerCase() === "sha256"
    && clean(copy.fingerprint, 128).toLowerCase() === clean(artifact.sha256, 128).toLowerCase());
  const missing = required.filter((key) => {
    const artifact = byKey.get(key);
    return !artifact || MANDATORY_ARTIFACT_BACKENDS.some((backend) => !verified(artifact, backend));
  });
  return { complete: required.length > 0 && missing.length === 0, required, missing, nativeProjectRequired: true, requiredVerifiedBackends: [...MANDATORY_ARTIFACT_BACKENDS] };
}

function packageIdValid(platform, packageId) {
  if (!packageId || packageId.length > 240) return false;
  if (platform === "android") return /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,}$/i.test(packageId);
  return /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*){1,}$/i.test(packageId);
}

function blocker(code, gate, message) { return { code, gate, message }; }

export function createGameFactoryReleaseReadiness({
  store,
  assessmentWritesEnabled = false,
  capabilityProvider = async () => ({}),
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (!store || typeof store.getProject !== "function" || typeof store.recordRelease !== "function") {
    throw new Error("createGameFactoryReleaseReadiness needs a game factory store");
  }
  if (typeof capabilityProvider !== "function") throw new Error("capabilityProvider must be a function");

  async function assess({ uid, projectId, platform, packageId = "", versionName = "", versionCode = 0, tenant = null } = {}) {
    const target = clean(platform, 40).toLowerCase();
    if (!PLATFORMS.includes(target)) return result(400, { error: "Platform must be android or ios.", code: "bad_platform" });
    const detail = store.getProject(clean(uid, 80).toLowerCase(), clean(projectId, 180));
    if (!detail) return result(404, { error: "No such game.", code: "not_found" });
    const build = detail.activeBuild;
    const blockers = [];
    if (!build?.id) blockers.push(blocker("BUILD_REQUIRED", "build", "Create a versioned build before release preflight."));
    const buildId = build?.id || "";
    const targets = (Array.isArray(build?.targets) ? build.targets : []).map((item) => clean(item, 40).toLowerCase());
    if (build && !targets.includes(target)) blockers.push(blocker("PLATFORM_BUILD_REQUIRED", "build", `The active build does not target ${target}.`));
    if (build && !clean(build.sourceCommit, 128)) blockers.push(blocker("SOURCE_COMMIT_REQUIRED", "build", "Bind the release build to an immutable source commit."));
    const pkg = clean(packageId, 240);
    const releaseVersion = clean(versionName || build?.versionName, 80);
    const codeCandidate = Number(versionCode || build?.versionCode);
    const releaseCode = Number.isSafeInteger(codeCandidate) && codeCandidate > 0 ? codeCandidate : 0;
    if (!packageIdValid(target, pkg)) blockers.push(blocker("PACKAGE_ID_REQUIRED", "package", `Provide a valid ${target} package identifier.`));
    if (!releaseVersion) blockers.push(blocker("VERSION_NAME_REQUIRED", "package", "Provide a release version name."));
    if (releaseCode < 1) blockers.push(blocker("VERSION_CODE_REQUIRED", "package", "Provide a positive immutable version/build code."));
    const artifactStatus = artifactCompliance(detail);
    if (!artifactStatus.complete) blockers.push(blocker("ARTIFACT_COPIES_INCOMPLETE", "artifacts", "Every required artifact needs verified ChatGPT Project and Google Drive copies; a local primary does not substitute for either."));
    const testsPassed = !!build && matchingTestPassed(detail, target, build);
    if (!testsPassed) blockers.push(blocker("AUTOMATED_TESTS_REQUIRED", "quality", `A passing ${target} test run bound to this build is required.`));
    const qaReady = detail.evidence?.qaReady === true;
    if (!qaReady) blockers.push(blocker("QA_GATE_REQUIRED", "quality", "Every mandatory QA suite must pass for this exact build."));
    const releaseCandidateApproved = !!buildId && approvalCurrent(detail, "RELEASE_CANDIDATE", buildId);
    if (!releaseCandidateApproved) blockers.push(blocker("RELEASE_CANDIDATE_APPROVAL_REQUIRED", "approval", "The owner must approve this exact release candidate."));
    const legalAndPrivacyApproved = !!buildId && approvalCurrent(detail, "LEGAL_AND_PRIVACY", buildId);
    if (!legalAndPrivacyApproved) blockers.push(blocker("LEGAL_PRIVACY_APPROVAL_REQUIRED", "approval", "The publisher must approve the current legal and privacy evidence."));
    const storeSubmissionApproved = !!buildId && approvalCurrent(detail, "STORE_SUBMISSION", buildId);
    const productionReleaseApproved = !!buildId && approvalCurrent(detail, "PRODUCTION_RELEASE", buildId);

    let snapshot;
    try {
      snapshot = capabilitySnapshot(await capabilityProvider({ uid: clean(uid, 80).toLowerCase(), tenant, platform: target, project: detail, build }));
    } catch (error) {
      const message = safeError(error?.message || error) || "Capability probe failed.";
      log("game_factory_release_capability_failed", { projectId: detail.id, platform: target, error: message });
      snapshot = capabilitySnapshot({});
      blockers.push(blocker("CAPABILITY_PROBE_FAILED", "capability", message));
    }
    if (!snapshot.account.connected) blockers.push(blocker("STORE_ACCOUNT_REQUIRED", "account", `Connect the ${target} store account.`));
    if (!snapshot.account.apiAccess) blockers.push(blocker("STORE_API_ACCESS_REQUIRED", "account", "Grant the configured account the required store API role."));
    if (!["accepted", "active", "complete"].includes(snapshot.account.legalStatus)) {
      blockers.push(blocker("LEGAL_AGREEMENTS_REQUIRED", "legal", "Required developer and commercial agreements must be accepted by the account owner."));
    }
    const signingReference = snapshot.signing.credentialId || snapshot.signing.certificateSha256 || snapshot.signing.profileId || snapshot.signing.profileSha256;
    if (!snapshot.signing.available || !signingReference) {
      blockers.push(blocker("SIGNING_REFERENCE_REQUIRED", "signing", "A worker-held signing identity reference is required; private signing material is never stored here."));
    }
    const signingExpiry = Date.parse(snapshot.signing.expiresAt);
    if (snapshot.signing.expiresAt && Number.isFinite(signingExpiry) && signingExpiry <= now()) {
      blockers.push(blocker("SIGNING_REFERENCE_EXPIRED", "signing", "The referenced signing identity is expired."));
    }
    if (!snapshot.toolchain.available || snapshot.toolchain.missing.length) blockers.push(blocker("TOOLCHAIN_REQUIRED", "toolchain", `A healthy ${target} build toolchain is required.`));
    if (!snapshot.store.reachable || !snapshot.store.apiAccess) blockers.push(blocker("STORE_CAPABILITY_REQUIRED", "store", "The store API capability probe must pass."));
    if (snapshot.account.accountId && snapshot.store.accountId && snapshot.account.accountId !== snapshot.store.accountId) {
      blockers.push(blocker("STORE_ACCOUNT_MISMATCH", "account", "The authenticated store capability belongs to a different account."));
    }

    const readyForUpload = blockers.length === 0;
    const submissionBlockers = [...blockers];
    if (!storeSubmissionApproved) submissionBlockers.push(blocker("STORE_SUBMISSION_APPROVAL_REQUIRED", "approval", "The owner must approve store submission for this exact build."));
    if (!productionReleaseApproved) submissionBlockers.push(blocker("PRODUCTION_RELEASE_APPROVAL_REQUIRED", "approval", "The owner must approve production release for this exact build."));
    // Final submission deliberately remains outside this adapter even when every preflight passes.
    submissionBlockers.push(blocker("FINAL_SUBMISSION_NOT_AUTOMATED", "submission", "Final store submission is a separate owner-controlled action and is not implemented by this service."));

    return result(200, {
      ok: true,
      projectId: detail.id,
      platform: target,
      assessedAt: new Date(now()).toISOString(),
      build: { id: buildId, sourceCommit: safeId(build?.sourceCommit, 128), targets, versionName: releaseVersion, versionCode: releaseCode },
      packageId: pkg,
      readyForUpload,
      readyForSubmission: false,
      assessmentWritesEnabled: !!assessmentWritesEnabled,
      blockers,
      submissionBlockers,
      evidence: {
        artifacts: artifactStatus,
        quality: { testsPassed, qaReady, releaseCandidateApproved, legalAndPrivacyApproved, storeSubmissionApproved, productionReleaseApproved },
        capabilities: snapshot,
      },
      finalSubmission: { supported: false, performed: false },
    });
  }

  async function recordAssessment(input = {}) {
    const assessment = await assess(input);
    if (assessment.status !== 200) return assessment;
    if (!assessmentWritesEnabled) {
      return result(503, { error: "Release assessment writes are disabled.", code: "release_writes_disabled", assessment: assessment.body });
    }
    const body = assessment.body;
    const persisted = store.recordRelease({
      uid: clean(input.uid, 80).toLowerCase(),
      projectId: body.projectId,
      buildId: body.build.id,
      platform: body.platform,
      packageId: body.packageId,
      versionName: body.build.versionName,
      versionCode: body.build.versionCode,
      status: body.readyForUpload ? "READY" : "BLOCKED",
      storeLocator: safeLocator(input.storeLocator),
      evidence: {
        assessedAt: body.assessedAt,
        readyForUpload: body.readyForUpload,
        readyForSubmission: false,
        blockers: body.blockers,
        submissionBlockers: body.submissionBlockers,
        artifacts: body.evidence.artifacts,
        quality: body.evidence.quality,
        capabilities: body.evidence.capabilities,
        finalSubmission: { supported: false, performed: false },
      },
    });
    if (!persisted || persisted.status >= 300) return persisted || result(500, { error: "Release assessment could not be recorded.", code: "release_record_failed" });
    return result(201, { ok: true, releaseId: persisted.body.releaseId, status: body.readyForUpload ? "READY" : "BLOCKED", assessment: body });
  }

  function health() {
    return {
      configured: true,
      writesEnabled: !!assessmentWritesEnabled,
      assessmentWritesEnabled: !!assessmentWritesEnabled,
      storeUploadsEnabled: false,
      finalSubmissionSupported: false,
      signingMaterialAccepted: false,
      platforms: [...PLATFORMS],
    };
  }

  return { assess, recordAssessment, health };
}
