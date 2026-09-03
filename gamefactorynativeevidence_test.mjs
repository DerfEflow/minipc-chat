import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createGameFactoryStore } from "./gamefactorystore.mjs";
import { REQUIRED_GAME_ARTIFACTS } from "./gamefactory.mjs";
import {
  LOCKED_NATIVE_CHATGPT_PROJECT_ID, NATIVE_PROJECT_API_VERIFIED_STATUS, NATIVE_PROJECT_OWNER_ATTESTED_STATUS,
  OWNER_ATTESTATION_ACKNOWLEDGEMENT, OWNER_ATTESTATION_OPERATOR, expectedNativeProjectFilename,
  nativeProjectEvidenceCanComplete, normalizeNativeApiProjectManifest,
} from "./gamefactorynativeevidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OPERATOR = join(HERE, "ops", "record-native-chatgpt-project-attestation.mjs");
const V1_CHECKSUM = createHash("sha256").update([
  "game_projects:v1", "game_builds:v1", "game_tasks:v1", "game_checkpoints:v1",
  "game_events:v1", "game_artifacts:v1", "game_artifact_copies:v1",
  "game_test_runs:v1", "game_approvals:v1", "game_releases:v1",
  "game_model_runs:v1", "command_idempotency:v1", "outbox_events:v1",
].join("|")).digest("hex");

const root = mkdtempSync(join(tmpdir(), "dominion-gamefactory-native-evidence-"));
const BASE_TIME = Date.parse("2026-09-02T12:00:00.000Z");
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

function manifest(artifact, { observedAt = "2026-09-02T12:00:00.000Z", suffix = "visible-source" } = {}) {
  return {
    formatVersion: 1,
    kind: NATIVE_PROJECT_OWNER_ATTESTED_STATUS,
    nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
    artifactId: artifact.id,
    artifactKey: artifact.artifactKey,
    artifactVersion: artifact.version,
    sha256: artifact.sha256,
    size: artifact.size,
    filename: expectedNativeProjectFilename(artifact),
    sourceCount: 1,
    operator: OWNER_ATTESTATION_OPERATOR,
    observedAt,
    browserEvidenceRef: `chatgpt-project-browser://${LOCKED_NATIVE_CHATGPT_PROJECT_ID}/visible/${artifact.id}-${suffix}`,
    uploadMethod: "BROWSER_FILE_UPLOAD",
    evidenceOrigin: "OWNER_CONTROLLED_CHATGPT_PROJECT_BROWSER",
    sourceListVisible: true,
    screenshotOnly: false,
    ownerAttestation: OWNER_ATTESTATION_ACKNOWLEDGEMENT,
  };
}

function invalidation(evidenceId, { reason = "SOURCE_REMOVED", observedSourceCount = 0, observedAt = "2026-09-02T12:05:00.000Z" } = {}) {
  return {
    formatVersion: 1,
    kind: "INVALIDATED",
    nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
    evidenceId,
    operator: OWNER_ATTESTATION_OPERATOR,
    observedAt,
    reason,
    observedSourceCount,
    browserEvidenceRef: `chatgpt-project-browser://${LOCKED_NATIVE_CHATGPT_PROJECT_ID}/visible/invalidation-${evidenceId}`,
  };
}

function setup(dir, uid = "owner-uid") {
  let clock = BASE_TIME;
  // This file tests the native-evidence ledger mechanics themselves (append-only, idempotent,
  // chronology, corruption/ambiguity detection, invalidation), using artifact.complete as a
  // convenient end-to-end signal of "is chatgpt_project evidence currently valid". Since 2026-09-03
  // chatgpt_project is a DEFERRED backend and no longer part of the application-wide default
  // MANDATORY_ARTIFACT_BACKENDS (see gamefactory.mjs), so this store is opened with an explicit
  // requiredArtifactBackends override to keep exercising that signal; the default (deferred,
  // non-gating) behavior is covered separately in gamefactorystore_test.mjs.
  const store = createGameFactoryStore({
    dir, now: () => typeof clock === "function" ? clock() : clock,
    requiredArtifactBackends: ["chatgpt_project", "google_drive"],
  });
  const project = store.seedPortfolio({ uid, email: "owner@example.com" })[0];
  const made = store.recordArtifact({
    uid, projectId: project.id, artifactKey: REQUIRED_GAME_ARTIFACTS[0], sha256: "a".repeat(64), size: 12, mimeType: "text/markdown",
  });
  assert.equal(made.status, 201);
  for (const backend of ["primary", "google_drive"]) {
    assert.equal(store.recordArtifactCopy({ uid, artifactId: made.body.artifactId, backend, status: "VERIFIED", fingerprint: "a".repeat(64) }).status, 200);
  }
  const artifact = store.getProject(uid, project.id).artifacts.find((item) => item.id === made.body.artifactId);
  return { store, uid, project, artifact, setNow(value) { clock = value; } };
}

try {
  test("owner-attested evidence is exact, append-only, idempotent, and invalidatable", () => {
    const h = setup(join(root, "ledger"));
    try {
      const prior = h.store.getProject(h.uid, h.project.id).artifacts.find((item) => item.id === h.artifact.id);
      assert.equal(prior.complete, false);
      assert.equal(h.store.artifactCopyComplete({ uid: h.uid, projectId: h.project.id, artifactId: h.artifact.id, backend: "chatgpt_project" }), false);
      // "DEFERRED" since 2026-09-03 (chatgpt_project has no API); informational, not "MISSING".
      assert.equal(prior.copies.find((copy) => copy.backend === "chatgpt_project").status, "DEFERRED");
      const generic = h.store.recordArtifactCopy({ uid: h.uid, artifactId: h.artifact.id, backend: "chatgpt_project", status: "VERIFIED", fingerprint: h.artifact.sha256 });
      assert.equal(generic.status, 403);
      assert.equal(generic.body.code, "native_project_evidence_offline_only");

      const recorded = h.store.recordOwnerAttestedNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: manifest(h.artifact) });
      assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
      const db = new DatabaseSync(join(root, "ledger", "gamefactory.db"));
      try {
        assert.throws(() => db.prepare("UPDATE game_artifact_native_evidence SET operator='not-the-owner' WHERE id=?").run(recorded.body.evidenceId), /append-only/);
        assert.throws(() => db.prepare("DELETE FROM game_artifact_native_evidence WHERE id=?").run(recorded.body.evidenceId), /append-only/);
      } finally { db.close(); }
      const replay = h.store.recordOwnerAttestedNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: manifest(h.artifact) });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replayed, true);
      let projected = h.store.getProject(h.uid, h.project.id).artifacts.find((item) => item.id === h.artifact.id);
      assert.equal(projected.complete, true);
      assert.equal(h.store.artifactCopyComplete({ uid: h.uid, projectId: h.project.id, artifactId: h.artifact.id, backend: "chatgpt_project" }), true);
      assert.equal(projected.copies.find((copy) => copy.backend === "chatgpt_project").status, "OWNER_ATTESTED");

      const changed = h.store.recordOwnerAttestedNativeProjectEvidence({
        uid: h.uid, artifactId: h.artifact.id, manifest: manifest(h.artifact, { observedAt: "2026-09-02T12:01:00.000Z", suffix: "different-source" }),
      });
      assert.equal(changed.status, 409);
      assert.equal(changed.body.code, "native_project_evidence_already_active");

      const badScreenshot = manifest(h.artifact, { observedAt: "2026-09-02T12:01:00.000Z", suffix: "screenshot" });
      badScreenshot.screenshotOnly = true;
      const rejected = h.store.recordOwnerAttestedNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: badScreenshot });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.code, "native_project_browser_proof_invalid");

      const driveLinked = manifest(h.artifact, { observedAt: "2026-09-02T12:02:00.000Z", suffix: "drive-link" });
      driveLinked.browserEvidenceRef = "gdrive://not-a-native-project-proof";
      const driveRejected = h.store.recordOwnerAttestedNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: driveLinked });
      assert.equal(driveRejected.status, 400);
      assert.equal(driveRejected.body.code, "bad_browser_evidence_reference");

      const pasted = manifest(h.artifact, { observedAt: "2026-09-02T12:03:00.000Z", suffix: "pasted" });
      pasted.uploadMethod = "TEXTAREA_PASTE";
      const pastedRejected = h.store.recordOwnerAttestedNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: pasted });
      assert.equal(pastedRejected.status, 400);
      assert.equal(pastedRejected.body.code, "native_project_browser_proof_invalid");

      const localObservation = manifest(h.artifact, { observedAt: "2026-09-02T12:04:00.000Z", suffix: "local" });
      localObservation.evidenceOrigin = "GENERIC_LOCAL_OBSERVATION";
      const localRejected = h.store.recordOwnerAttestedNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: localObservation });
      assert.equal(localRejected.status, 400);
      assert.equal(localRejected.body.code, "native_project_browser_proof_invalid");

      h.setNow(BASE_TIME + 5 * 60_000);
      const invalidated = h.store.invalidateNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: invalidation(recorded.body.evidenceId) });
      assert.equal(invalidated.status, 201);
      const invalidatedReplay = h.store.invalidateNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: invalidation(recorded.body.evidenceId) });
      assert.equal(invalidatedReplay.status, 200);
      assert.equal(invalidatedReplay.body.replayed, true);
      projected = h.store.getProject(h.uid, h.project.id).artifacts.find((item) => item.id === h.artifact.id);
      assert.equal(projected.complete, false);
      assert.equal(h.store.artifactCopyComplete({ uid: h.uid, projectId: h.project.id, artifactId: h.artifact.id, backend: "chatgpt_project" }), false);
      assert.equal(projected.copies.find((copy) => copy.backend === "chatgpt_project").status, "INVALIDATED");

      h.setNow(BASE_TIME + 10 * 60_000);
      const restored = h.store.recordOwnerAttestedNativeProjectEvidence({
        uid: h.uid, artifactId: h.artifact.id, manifest: manifest(h.artifact, { observedAt: "2026-09-02T12:10:00.000Z", suffix: "restored-source" }),
      });
      assert.equal(restored.status, 201);
      projected = h.store.getProject(h.uid, h.project.id).artifacts.find((item) => item.id === h.artifact.id);
      assert.equal(projected.complete, true);
    } finally { h.store.close(); }
  });

  test("completion requires the full store-validated artifact and evidence binding", () => {
    const h = setup(join(root, "completion-binding"), "binding-owner");
    try {
      assert.equal(nativeProjectEvidenceCanComplete({
        backend: "chatgpt_project", status: "OWNER_ATTESTED", algorithm: "sha256", fingerprint: h.artifact.sha256,
      }, h.artifact), false);
      const recorded = h.store.recordOwnerAttestedNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: manifest(h.artifact) });
      assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
      const artifact = h.store.getProject(h.uid, h.project.id).artifacts.find((item) => item.id === h.artifact.id);
      const copy = artifact.copies.find((item) => item.backend === "chatgpt_project");
      assert.equal(nativeProjectEvidenceCanComplete(copy, artifact), true);
      const mutations = [
        ["id", "gfn_not-an-evidence-id"],
        ["manifestHash", "0".repeat(64)],
        ["nativeProjectId", "g-p-wrong"],
        ["fingerprint", "0".repeat(64)],
        ["artifactId", "wrong-artifact"],
        ["artifactKey", "WRONG_KEY"],
        ["artifactVersion", artifact.version + 1],
        ["size", artifact.size + 1],
        ["filename", `wrong-${copy.filename}`],
        ["sourceCount", 2],
        ["operator", "Another Operator"],
        ["observedAt", "not-a-timestamp"],
        ["browserEvidenceRef", "gdrive://not-native-evidence"],
        ["provenance", "GENERIC_TRUSTED_ADAPTER"],
      ];
      for (const [field, value] of mutations) {
        assert.equal(nativeProjectEvidenceCanComplete({ ...copy, [field]: value }, artifact), false, field);
      }
    } finally { h.store.close(); }
  });

  test("the dormant documented-native-API vocabulary also requires a canonical bound receipt", () => {
    const h = setup(join(root, "native-api-vocabulary"), "api-owner");
    try {
      const verifiedAt = new Date(BASE_TIME).toISOString();
      const manifest = normalizeNativeApiProjectManifest({
        formatVersion: 1, kind: NATIVE_PROJECT_API_VERIFIED_STATUS,
        nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID, artifactId: h.artifact.id,
        artifactKey: h.artifact.artifactKey, artifactVersion: h.artifact.version,
        sha256: h.artifact.sha256, size: h.artifact.size,
        filename: expectedNativeProjectFilename(h.artifact), sourceCount: 1, verifiedAt,
        apiVersion: "documented-api-v1",
        verificationReceiptRef: `chatgpt-project-api://${LOCKED_NATIVE_CHATGPT_PROJECT_ID}/receipts/exact-artifact`,
      }, h.artifact);
      const copy = {
        id: "gfn_20000000-0000-4000-8000-000000000000", backend: "chatgpt_project",
        status: NATIVE_PROJECT_API_VERIFIED_STATUS, fingerprint: h.artifact.sha256, algorithm: "sha256",
        provenance: "NATIVE_API_VERIFIED", nativeProjectId: manifest.nativeProjectId,
        manifestHash: manifest.manifestHash, artifactId: manifest.artifactId, artifactKey: manifest.artifactKey,
        artifactVersion: manifest.artifactVersion, size: manifest.size, filename: manifest.filename,
        sourceCount: manifest.sourceCount, nativeVerifiedAt: manifest.verifiedAt,
        apiVersion: manifest.apiVersion, verificationReceiptRef: manifest.verificationReceiptRef,
      };
      assert.equal(nativeProjectEvidenceCanComplete(copy, h.artifact), true);
      assert.equal(nativeProjectEvidenceCanComplete({ ...copy, apiVersion: "undocumented-version" }, h.artifact), false);
      assert.equal(nativeProjectEvidenceCanComplete({ ...copy, verificationReceiptRef: "https://example.invalid/receipt" }, h.artifact), false);
      assert.equal(nativeProjectEvidenceCanComplete({ ...copy, manifestHash: "0".repeat(64) }, h.artifact), false);
    } finally { h.store.close(); }
  });

  test("manifest schema and per-artifact observation chronology fail closed", () => {
    const h = setup(join(root, "chronology"), "chronology-owner");
    try {
      const malformed = [
        { field: "formatVersion", value: "1" },
        { field: "artifactVersion", value: String(h.artifact.version) },
        { field: "size", value: String(h.artifact.size) },
        { field: "sourceCount", value: "1" },
        { field: "nativeProjectId", value: "g-p-not-the-locked-project" },
        { field: "artifactId", value: "not-this-artifact" },
        { field: "artifactKey", value: "99_WRONG" },
        { field: "sha256", value: "0".repeat(64) },
        { field: "filename", value: "drive-link.txt" },
        { field: "operator", value: "Another Operator" },
        { field: "browserEvidenceRef", value: "https://chatgpt.com/screenshot" },
      ];
      for (const mutation of malformed) {
        const candidate = { ...manifest(h.artifact), [mutation.field]: mutation.value };
        const response = h.store.recordOwnerAttestedNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: candidate });
        assert.equal(response.status, 400, mutation.field);
      }
      const extra = { ...manifest(h.artifact), untrustedAdapter: true };
      assert.equal(h.store.recordOwnerAttestedNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: extra }).status, 400);
      const invalidTime = manifest(h.artifact, { observedAt: "not-a-time" });
      assert.equal(h.store.recordOwnerAttestedNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: invalidTime }).status, 400);
      const beforeArtifact = manifest(h.artifact, { observedAt: new Date(BASE_TIME - 1).toISOString(), suffix: "before-artifact" });
      const before = h.store.recordOwnerAttestedNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: beforeArtifact });
      assert.equal(before.status, 409);
      assert.equal(before.body.code, "native_project_evidence_before_artifact");
      const tooFarFuture = manifest(h.artifact, { observedAt: new Date(BASE_TIME + 5 * 60_000 + 1).toISOString(), suffix: "future" });
      const future = h.store.recordOwnerAttestedNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: tooFarFuture });
      assert.equal(future.status, 409);
      assert.equal(future.body.code, "native_project_evidence_in_future");

      h.setNow(BASE_TIME + 60_000);
      const first = h.store.recordOwnerAttestedNativeProjectEvidence({
        uid: h.uid, artifactId: h.artifact.id,
        manifest: manifest(h.artifact, { observedAt: new Date(BASE_TIME + 60_000).toISOString(), suffix: "chronology-first" }),
      });
      assert.equal(first.status, 201);
      h.setNow(BASE_TIME + 2 * 60_000);
      const tiedInvalidation = h.store.invalidateNativeProjectEvidence({
        uid: h.uid, artifactId: h.artifact.id,
        manifest: invalidation(first.body.evidenceId, { observedAt: new Date(BASE_TIME + 60_000).toISOString() }),
      });
      assert.equal(tiedInvalidation.status, 409);
      assert.equal(tiedInvalidation.body.code, "native_project_evidence_not_monotonic");
      const invalidated = h.store.invalidateNativeProjectEvidence({
        uid: h.uid, artifactId: h.artifact.id,
        manifest: invalidation(first.body.evidenceId, { observedAt: new Date(BASE_TIME + 2 * 60_000).toISOString() }),
      });
      assert.equal(invalidated.status, 201);
      h.setNow(BASE_TIME + 3 * 60_000);
      const staleReplacement = h.store.recordOwnerAttestedNativeProjectEvidence({
        uid: h.uid, artifactId: h.artifact.id,
        manifest: manifest(h.artifact, { observedAt: new Date(BASE_TIME + 90_000).toISOString(), suffix: "stale-replacement" }),
      });
      assert.equal(staleReplacement.status, 409);
      assert.equal(staleReplacement.body.code, "native_project_evidence_not_monotonic");
      const replacement = h.store.recordOwnerAttestedNativeProjectEvidence({
        uid: h.uid, artifactId: h.artifact.id,
        manifest: manifest(h.artifact, { observedAt: new Date(BASE_TIME + 3 * 60_000).toISOString(), suffix: "new-replacement" }),
      });
      assert.equal(replacement.status, 201);
    } finally { h.store.close(); }
  });

  test("attestation and invalidation reject an invalid clock before any append", () => {
    const dir = join(root, "invalid-clock");
    const h = setup(dir, "invalid-clock-owner");
    const countRows = () => {
      const db = new DatabaseSync(join(dir, "gamefactory.db"));
      try { return Number(db.prepare("SELECT COUNT(*) AS count FROM game_artifact_native_evidence").get().count); }
      finally { db.close(); }
    };
    const badClocks = [NaN, Infinity, -Infinity, String(BASE_TIME), BASE_TIME + 0.5, -1, () => { throw new Error("clock unavailable"); }];
    try {
      for (const value of badClocks) {
        h.setNow(value);
        const response = h.store.recordOwnerAttestedNativeProjectEvidence({
          uid: h.uid, artifactId: h.artifact.id,
          manifest: manifest(h.artifact, { suffix: "invalid-clock-attestation" }),
        });
        assert.equal(response.status, 503);
        assert.equal(response.body.code, "native_project_clock_invalid");
        assert.equal(countRows(), 0);
      }

      h.setNow(BASE_TIME + 1_000);
      const recorded = h.store.recordOwnerAttestedNativeProjectEvidence({
        uid: h.uid, artifactId: h.artifact.id,
        manifest: manifest(h.artifact, { observedAt: new Date(BASE_TIME + 1_000).toISOString(), suffix: "valid-before-clock-failure" }),
      });
      assert.equal(recorded.status, 201);
      assert.equal(countRows(), 1);

      for (const value of badClocks) {
        h.setNow(value);
        const response = h.store.invalidateNativeProjectEvidence({
          uid: h.uid, artifactId: h.artifact.id,
          manifest: invalidation(recorded.body.evidenceId, { observedAt: new Date(BASE_TIME + 2_000).toISOString() }),
        });
        assert.equal(response.status, 503);
        assert.equal(response.body.code, "native_project_clock_invalid");
        assert.equal(countRows(), 1);
      }
    } finally { h.store.close(); }
  });

  test("unknown or injected ledger rows fail the durable projection closed", () => {
    const dir = join(root, "corrupt-ledger");
    const h = setup(dir, "corrupt-owner");
    try {
      const db = new DatabaseSync(join(dir, "gamefactory.db"));
      try {
        db.prepare(`INSERT INTO game_artifact_native_evidence
          (id,artifactId,projectId,uid,kind,targetEvidenceId,nativeProjectId,fingerprint,size,operator,browserEvidenceRef,manifestHash,manifest,createdAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          "gfn_10000000-0000-4000-8000-000000000000", h.artifact.id, h.project.id, h.uid,
          "GENERIC_TRUSTED_ADAPTER", "", LOCKED_NATIVE_CHATGPT_PROJECT_ID, h.artifact.sha256,
          h.artifact.size, OWNER_ATTESTATION_OPERATOR, "", "0".repeat(64), "{}", BASE_TIME,
        );
      } finally { db.close(); }
      const artifact = h.store.getProject(h.uid, h.project.id).artifacts.find((item) => item.id === h.artifact.id);
      assert.equal(artifact.complete, false);
      assert.equal(artifact.copies.find((copy) => copy.backend === "chatgpt_project").status, "EVIDENCE_CORRUPT");
      assert.equal(h.store.artifactCopyComplete({ uid: h.uid, projectId: h.project.id, artifactId: h.artifact.id, backend: "chatgpt_project" }), false);
    } finally { h.store.close(); }
  });

  test("v1 mutable native rows migrate without receiving v2 completion trust", () => {
    const legacyDir = join(root, "legacy");
    const h = setup(legacyDir, "legacy-owner");
    h.store.close();
    const db = new DatabaseSync(join(legacyDir, "gamefactory.db"));
    db.prepare(`INSERT INTO game_artifact_copies
      (id,artifactId,backend,locator,status,fingerprint,algorithm,attempts,lastError,verifiedAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("legacy-native-row", h.artifact.id, "chatgpt_project", "legacy://claim", "VERIFIED", h.artifact.sha256, "sha256", 1, "", 1, 1);
    db.exec("DROP TABLE game_artifact_native_evidence");
    db.prepare("UPDATE game_factory_schema SET version=1,checksum=? WHERE singleton=1").run(V1_CHECKSUM);
    db.exec("PRAGMA user_version=1");
    db.close();
    // Reopen with the same requiredArtifactBackends override as setup() above: this test's whole
    // point is that a legacy VERIFIED chatgpt_project row must not receive free v2 completion trust
    // after migration, which requires chatgpt_project to actually be a gating backend for this store.
    // Under the app-wide default (chatgpt_project deferred) google_drive alone already completes the
    // artifact, which would make this assertion meaningless.
    const migrated = createGameFactoryStore({ dir: legacyDir, requiredArtifactBackends: ["chatgpt_project", "google_drive"] });
    try {
      const artifact = migrated.getProject("legacy-owner", migrated.listProjects("legacy-owner")[0].id).artifacts[0];
      const native = artifact.copies.find((copy) => copy.backend === "chatgpt_project");
      assert.equal(native.status, "UNTRUSTED_LEGACY");
      assert.equal(artifact.complete, false);
      assert.equal(migrated.health().schema.version, 2);
    } finally { migrated.close(); }
  });

  test("offline operator command accepts only a manifest file and never needs an HTTP path", () => {
    const commandDir = join(root, "operator");
    const h = setup(commandDir, "operator-owner");
    const manifestFile = join(root, "operator-manifest.json");
    writeFileSync(manifestFile, JSON.stringify(manifest(h.artifact)));
    h.store.close();
    const rejected = spawnSync(process.execPath, [OPERATOR, "attest", "--offline", "--data-dir", commandDir, "--uid", h.uid, "--game-id", h.project.id, "--artifact-id", h.artifact.id, "--manifest", manifestFile], { encoding: "utf8" });
    assert.equal(rejected.status, 2, `${rejected.stdout}\n${rejected.stderr}`);
    const relativeRejected = spawnSync(process.execPath, [OPERATOR, "attest", "--offline", "--commit", "--data-dir", commandDir, "--uid", h.uid, "--game-id", h.project.id, "--artifact-id", h.artifact.id, "--manifest", "operator-manifest.json"], { encoding: "utf8" });
    assert.equal(relativeRejected.status, 2, `${relativeRejected.stdout}\n${relativeRejected.stderr}`);
    const stdinRejected = spawnSync(process.execPath, [OPERATOR, "attest", "--offline", "--commit", "--data-dir", commandDir, "--uid", h.uid, "--game-id", h.project.id, "--artifact-id", h.artifact.id, "--manifest", "-"], { input: JSON.stringify(manifest(h.artifact)), encoding: "utf8" });
    assert.equal(stdinRejected.status, 2, `${stdinRejected.stdout}\n${stdinRejected.stderr}`);
    const linkedManifest = join(root, "operator-manifest-link.json");
    let linkCreated = false;
    try { symlinkSync(manifestFile, linkedManifest, "file"); linkCreated = true; }
    catch (error) {
      if (!["EPERM", "EACCES", "EISDIR", "UNKNOWN"].includes(error?.code)) throw error;
    }
    if (linkCreated) {
      const linkRejected = spawnSync(process.execPath, [OPERATOR, "attest", "--offline", "--commit", "--data-dir", commandDir, "--uid", h.uid, "--game-id", h.project.id, "--artifact-id", h.artifact.id, "--manifest", linkedManifest], { encoding: "utf8" });
      assert.equal(linkRejected.status, 2, `${linkRejected.stdout}\n${linkRejected.stderr}`);
    } else {
      console.log("skip - this Windows filesystem cannot create the symlink fixture; Linux/ext4 must prove this denial");
    }
    const run = spawnSync(process.execPath, [OPERATOR, "attest", "--offline", "--commit", "--data-dir", commandDir, "--uid", h.uid, "--game-id", h.project.id, "--artifact-id", h.artifact.id, "--manifest", manifestFile], { encoding: "utf8" });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.status, 201);
    assert.equal(receipt.evidenceStatus, "OWNER_ATTESTED");
    assert.match(receipt.manifestHash, /^[a-f0-9]{64}$/);
    const check = createGameFactoryStore({ dir: commandDir });
    try {
      const artifact = check.getProject(h.uid, h.project.id).artifacts.find((item) => item.id === h.artifact.id);
      assert.equal(artifact.copies.find((copy) => copy.backend === "chatgpt_project").status, "OWNER_ATTESTED");
    } finally { check.close(); }
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} native Project evidence tests passed`);
