import assert from "node:assert/strict";
import { createGameFactoryReleaseReadiness, gameFactoryReleaseFlags } from "./gamefactoryrelease.mjs";
import {
  LOCKED_NATIVE_CHATGPT_PROJECT_ID, NATIVE_PROJECT_OWNER_ATTESTED_STATUS, OWNER_ATTESTATION_ACKNOWLEDGEMENT,
  OWNER_ATTESTATION_OPERATOR, expectedNativeProjectFilename, nativeProjectEvidenceCanComplete,
  normalizeOwnerAttestedNativeProjectManifest,
} from "./gamefactorynativeevidence.mjs";

const buildId = "build-1";
function nativeCopy(artifact) {
  const observedAt = "2026-09-02T12:00:00.000Z";
  const manifest = normalizeOwnerAttestedNativeProjectManifest({
    formatVersion: 1, kind: NATIVE_PROJECT_OWNER_ATTESTED_STATUS,
    nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID, artifactId: artifact.id,
    artifactKey: artifact.artifactKey, artifactVersion: artifact.version, sha256: artifact.sha256,
    size: artifact.size, filename: expectedNativeProjectFilename(artifact), sourceCount: 1,
    operator: OWNER_ATTESTATION_OPERATOR, observedAt,
    browserEvidenceRef: `chatgpt-project-browser://${LOCKED_NATIVE_CHATGPT_PROJECT_ID}/visible/${artifact.id}`,
    uploadMethod: "BROWSER_FILE_UPLOAD", evidenceOrigin: "OWNER_CONTROLLED_CHATGPT_PROJECT_BROWSER",
    sourceListVisible: true, screenshotOnly: false, ownerAttestation: OWNER_ATTESTATION_ACKNOWLEDGEMENT,
  }, artifact);
  return {
    id: "gfn_00000000-0000-4000-8000-000000000000", backend: "chatgpt_project",
    status: NATIVE_PROJECT_OWNER_ATTESTED_STATUS, fingerprint: artifact.sha256, algorithm: "sha256",
    nativeProjectId: manifest.nativeProjectId, manifestHash: manifest.manifestHash,
    artifactId: artifact.id, artifactKey: artifact.artifactKey, artifactVersion: artifact.version,
    size: artifact.size, filename: manifest.filename, sourceCount: 1,
    provenance: "OWNER_ATTESTED_BROWSER_UPLOAD", operator: OWNER_ATTESTATION_OPERATOR,
    observedAt, browserEvidenceRef: manifest.browserEvidenceRef,
    uploadMethod: manifest.uploadMethod, evidenceOrigin: manifest.evidenceOrigin,
    sourceListVisible: manifest.sourceListVisible, screenshotOnly: manifest.screenshotOnly,
    ownerAttestation: manifest.ownerAttestation,
  };
}

function project(overrides = {}) {
  const artifactHash = "b".repeat(64);
  const artifact = {
    id: "artifact-1", artifactKey: "00_GAME_BRIEF", version: 1, sha256: artifactHash, size: 12,
    mimeType: "text/markdown", provenance: {}, copies: [],
  };
  artifact.copies = [
    nativeCopy(artifact),
    { backend: "google_drive", status: "VERIFIED", algorithm: "sha256", fingerprint: artifactHash },
  ];
  return {
    id: "game_owner_vector-vault",
    activeBuild: { id: buildId, sourceCommit: "abc123", targets: ["android", "ios"], versionName: "1.0.0", versionCode: 7 },
    required: ["00_GAME_BRIEF"],
    artifacts: [artifact],
    missing: [], complete: true,
    evidence: { qaReady: true, qaMissing: [] },
    tests: [
      { buildId, target: "android", status: "PASSED", sourceHash: "abc123" },
      { buildId, target: "ios", status: "PASSED", sourceHash: "abc123" },
    ],
    approvals: [
      { buildId, gate: "RELEASE_CANDIDATE", decision: "APPROVED", invalidatedAt: 0 },
      { buildId, gate: "LEGAL_AND_PRIVACY", decision: "APPROVED", invalidatedAt: 0 },
      { buildId, gate: "STORE_SUBMISSION", decision: "APPROVED", invalidatedAt: 0 },
      { buildId, gate: "PRODUCTION_RELEASE", decision: "APPROVED", invalidatedAt: 0 },
    ],
    ...overrides,
  };
}

function storeFor(detail) {
  const releases = [];
  return {
    releases,
    getProject(uid, projectId) { return uid === "owner" && projectId === detail.id ? structuredClone(detail) : null; },
    artifactCopyComplete({ uid, projectId, artifactId, backend }) {
      if (uid !== "owner" || projectId !== detail.id) return false;
      const artifact = detail.artifacts.find((item) => item.id === artifactId);
      const copy = artifact?.copies?.find((item) => item.backend === backend);
      if (!copy || copy.algorithm !== "sha256" || copy.fingerprint !== artifact.sha256) return false;
      return backend === "chatgpt_project" ? nativeProjectEvidenceCanComplete(copy, artifact) : copy.status === "VERIFIED";
    },
    recordRelease(input) { releases.push(structuredClone(input)); return { status: 201, body: { ok: true, releaseId: `release-${releases.length}` } }; },
  };
}

const readyCapabilities = () => ({
  account: { connected: true, accountId: "account-42", teamId: "team-9", role: "admin", apiAccess: true, legalStatus: "accepted", accessToken: "never-store" },
  signing: { available: true, credentialId: "worker-signing-ref-2", certificateSha256: "a".repeat(64), keyAlias: "release", privateKey: "never-store", password: "never-store" },
  toolchain: { available: true, nodeId: "gx10", versions: { godot: "4.7", androidSdk: "36", secretToken: "never-store" }, missing: [] },
  store: { reachable: true, apiAccess: true, accountId: "account-42", track: "internal", authorization: "never-store" },
});

let n = 0;
async function test(name, fn) { await fn(); console.log("ok", ++n, "-", name); }

await test("release flags and capabilities fail closed", async () => {
  assert.deepEqual(gameFactoryReleaseFlags({}), { assessmentWritesEnabled: false, storeUploadsEnabled: false, finalSubmissionEnabled: false });
  assert.deepEqual(gameFactoryReleaseFlags({ GAME_FACTORY_RELEASE_WRITES: "yes", GAME_FACTORY_STORE_UPLOADS: "1" }), { assessmentWritesEnabled: true, storeUploadsEnabled: false, finalSubmissionEnabled: false });
  const store = storeFor(project());
  const service = createGameFactoryReleaseReadiness({ store });
  assert.deepEqual(service.health(), {
    configured: true, writesEnabled: false, assessmentWritesEnabled: false, storeUploadsEnabled: false,
    finalSubmissionSupported: false, signingMaterialAccepted: false, platforms: ["android", "ios"],
  });
  assert.equal("submit" in service, false);
  assert.equal("upload" in service, false);
});

await test("missing account, legal, signing, toolchain, and store capabilities block upload", async () => {
  const store = storeFor(project());
  const service = createGameFactoryReleaseReadiness({ store });
  const assessed = await service.assess({ uid: "owner", projectId: store.getProject("owner", "game_owner_vector-vault").id, platform: "android", packageId: "tools.dominion.vectorvault" });
  assert.equal(assessed.status, 200);
  assert.equal(assessed.body.readyForUpload, false);
  const codes = assessed.body.blockers.map((item) => item.code);
  for (const code of ["STORE_ACCOUNT_REQUIRED", "STORE_API_ACCESS_REQUIRED", "LEGAL_AGREEMENTS_REQUIRED", "SIGNING_REFERENCE_REQUIRED", "TOOLCHAIN_REQUIRED", "STORE_CAPABILITY_REQUIRED"]) {
    assert.ok(codes.includes(code), code);
  }
  assert.equal(assessed.body.readyForSubmission, false);
  assert.equal(assessed.body.finalSubmission.performed, false);
});

await test("complete preflight can be ready for upload but never performs final submission", async () => {
  const store = storeFor(project());
  const service = createGameFactoryReleaseReadiness({ store, capabilityProvider: async () => readyCapabilities(), now: () => 1_800_000_000_000 });
  const assessed = await service.assess({ uid: "owner", projectId: "game_owner_vector-vault", platform: "android", packageId: "tools.dominion.vectorvault" });
  assert.equal(assessed.status, 200);
  assert.equal(assessed.body.readyForUpload, true);
  assert.deepEqual(assessed.body.blockers, []);
  assert.equal(assessed.body.readyForSubmission, false);
  assert.ok(assessed.body.submissionBlockers.some((item) => item.code === "FINAL_SUBMISSION_NOT_AUTOMATED"));
  assert.equal(assessed.body.evidence.capabilities.account.accountId, "account-42");
  assert.equal(assessed.body.evidence.capabilities.signing.certificateSha256, "a".repeat(64));
  const serialized = JSON.stringify(assessed.body);
  assert.equal(serialized.includes("never-store"), false);
  assert.equal(serialized.includes("privateKey"), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(serialized.includes("accessToken"), false);
});

await test("a caller-shaped google_drive copy cannot convince release preflight; a caller-shaped chatgpt_project copy is irrelevant (deferred)", async () => {
  const detail = project();
  // chatgpt_project is a DEFERRED backend since the 2026-09-03 gate relaxation: a browser/caller
  // cannot fake it into mandatory status because it was never mandatory to begin with. What must
  // still resist caller-shaped fakery is google_drive, the one remaining mandatory backend.
  detail.artifacts[0].copies[0] = {
    backend: "chatgpt_project", status: "OWNER_ATTESTED", algorithm: "sha256", fingerprint: detail.artifacts[0].sha256,
  };
  detail.artifacts[0].copies[1] = {
    backend: "google_drive", status: "VERIFIED", algorithm: "sha256", fingerprint: "not-the-real-sha256",
  };
  detail.complete = true;
  detail.missing = [];
  const store = storeFor(detail);
  const service = createGameFactoryReleaseReadiness({ store, capabilityProvider: async () => readyCapabilities() });
  const assessed = await service.assess({ uid: "owner", projectId: detail.id, platform: "android", packageId: "tools.dominion.vectorvault" });
  assert.equal(assessed.body.readyForUpload, false);
  assert.ok(assessed.body.blockers.some((item) => item.code === "ARTIFACT_COPIES_INCOMPLETE"));
});

await test("a genuinely verified google_drive copy alone is sufficient; a missing/fake chatgpt_project copy never blocks", async () => {
  const detail = project();
  // Same artifact as the base fixture, but strip chatgpt_project entirely (never attested at all).
  detail.artifacts[0].copies = detail.artifacts[0].copies.filter((copy) => copy.backend !== "chatgpt_project");
  const store = storeFor(detail);
  const service = createGameFactoryReleaseReadiness({ store, capabilityProvider: async () => readyCapabilities(), now: () => 1_800_000_000_000 });
  const assessed = await service.assess({ uid: "owner", projectId: detail.id, platform: "android", packageId: "tools.dominion.vectorvault" });
  assert.equal(assessed.body.readyForUpload, true);
  assert.equal(assessed.body.blockers.some((item) => item.code === "ARTIFACT_COPIES_INCOMPLETE"), false);
  assert.deepEqual(assessed.body.evidence.artifacts.requiredVerifiedBackends, ["google_drive"]);
});

await test("build-bound quality and approval evidence fail closed", async () => {
  const detail = project({
    complete: false,
    missing: ["00_GAME_BRIEF"],
    artifacts: [{ id: "artifact-1", artifactKey: "00_GAME_BRIEF", sha256: "b".repeat(64), copies: [{ backend: "primary", status: "VERIFIED", algorithm: "sha256", fingerprint: "b".repeat(64) }] }],
    tests: [{ buildId: "old-build", target: "ios", status: "PASSED", sourceHash: "old" }],
    evidence: { qaReady: false, qaMissing: ["core-loop"] },
    approvals: [{ buildId: "old-build", gate: "RELEASE_CANDIDATE", decision: "APPROVED", invalidatedAt: 0 }],
  });
  const store = storeFor(detail);
  const service = createGameFactoryReleaseReadiness({ store, capabilityProvider: async () => readyCapabilities() });
  const assessed = await service.assess({ uid: "owner", projectId: detail.id, platform: "ios", packageId: "tools.dominion.vectorvault" });
  const codes = assessed.body.blockers.map((item) => item.code);
  assert.ok(codes.includes("ARTIFACT_COPIES_INCOMPLETE"));
  assert.ok(codes.includes("AUTOMATED_TESTS_REQUIRED"));
  assert.ok(codes.includes("QA_GATE_REQUIRED"));
  assert.ok(codes.includes("RELEASE_CANDIDATE_APPROVAL_REQUIRED"));
  assert.ok(codes.includes("LEGAL_PRIVACY_APPROVAL_REQUIRED"));
  assert.ok(assessed.body.submissionBlockers.some((item) => item.code === "PRODUCTION_RELEASE_APPROVAL_REQUIRED"));
});

await test("recording remains disabled until explicitly enabled", async () => {
  const store = storeFor(project());
  const service = createGameFactoryReleaseReadiness({ store, capabilityProvider: async () => readyCapabilities() });
  const recorded = await service.recordAssessment({ uid: "owner", projectId: "game_owner_vector-vault", platform: "android", packageId: "tools.dominion.vectorvault" });
  assert.equal(recorded.status, 503);
  assert.equal(recorded.body.code, "release_writes_disabled");
  assert.equal(store.releases.length, 0);
});

await test("enabled assessment persistence records only IDs, hashes, status, and sanitized locator", async () => {
  const store = storeFor(project());
  const service = createGameFactoryReleaseReadiness({ store, assessmentWritesEnabled: true, capabilityProvider: async () => readyCapabilities() });
  const recorded = await service.recordAssessment({
    uid: "owner", projectId: "game_owner_vector-vault", platform: "ios", packageId: "tools.dominion.vectorvault",
    storeLocator: "https://store.example/apps/app-7?access_token=never-store#secret",
  });
  assert.equal(recorded.status, 201);
  assert.equal(recorded.body.status, "READY");
  assert.equal(store.releases.length, 1);
  const release = store.releases[0];
  assert.equal(release.status, "READY");
  assert.equal(release.storeLocator, "https://store.example/apps/app-7");
  assert.equal(release.evidence.finalSubmission.performed, false);
  const serialized = JSON.stringify(release);
  assert.equal(serialized.includes("never-store"), false);
  assert.equal(serialized.includes("privateKey"), false);
  assert.equal(serialized.includes("password"), false);
});

await test("an unavailable capability probe is an explicit blocker", async () => {
  const store = storeFor(project());
  const service = createGameFactoryReleaseReadiness({ store, capabilityProvider: async () => { throw new Error("GX10 unavailable?access_token=never-store"); } });
  const assessed = await service.assess({ uid: "owner", projectId: "game_owner_vector-vault", platform: "android", packageId: "tools.dominion.vectorvault" });
  assert.ok(assessed.body.blockers.some((item) => item.code === "CAPABILITY_PROBE_FAILED"));
  assert.equal(assessed.body.readyForUpload, false);
  assert.equal(JSON.stringify(assessed.body).includes("never-store"), false);
});

await test("unknown platforms and tenant misses are rejected", async () => {
  const store = storeFor(project());
  const service = createGameFactoryReleaseReadiness({ store, capabilityProvider: async () => readyCapabilities() });
  assert.equal((await service.assess({ uid: "owner", projectId: "game_owner_vector-vault", platform: "windows" })).status, 400);
  assert.equal((await service.assess({ uid: "another", projectId: "game_owner_vector-vault", platform: "android" })).status, 404);
});

console.log(`\n${n} game factory release tests passed`);
