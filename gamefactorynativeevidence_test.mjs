import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createGameFactoryStore } from "./gamefactorystore.mjs";
import { REQUIRED_GAME_ARTIFACTS } from "./gamefactory.mjs";
import {
  LOCKED_NATIVE_CHATGPT_PROJECT_ID, NATIVE_PROJECT_OWNER_ATTESTED_STATUS, OWNER_ATTESTATION_ACKNOWLEDGEMENT,
  OWNER_ATTESTATION_OPERATOR, expectedNativeProjectFilename,
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

function invalidation(evidenceId, { reason = "SOURCE_REMOVED", observedSourceCount = 0 } = {}) {
  return {
    formatVersion: 1,
    kind: "INVALIDATED",
    nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
    evidenceId,
    operator: OWNER_ATTESTATION_OPERATOR,
    observedAt: "2026-09-02T12:05:00.000Z",
    reason,
    observedSourceCount,
    browserEvidenceRef: `chatgpt-project-browser://${LOCKED_NATIVE_CHATGPT_PROJECT_ID}/visible/invalidation-${evidenceId}`,
  };
}

function setup(dir, uid = "owner-uid") {
  const store = createGameFactoryStore({ dir });
  const project = store.seedPortfolio({ uid, email: "owner@example.com" })[0];
  const made = store.recordArtifact({
    uid, projectId: project.id, artifactKey: REQUIRED_GAME_ARTIFACTS[0], sha256: "a".repeat(64), size: 12, mimeType: "text/markdown",
  });
  assert.equal(made.status, 201);
  for (const backend of ["primary", "google_drive"]) {
    assert.equal(store.recordArtifactCopy({ uid, artifactId: made.body.artifactId, backend, status: "VERIFIED", fingerprint: "a".repeat(64) }).status, 200);
  }
  const artifact = store.getProject(uid, project.id).artifacts.find((item) => item.id === made.body.artifactId);
  return { store, uid, project, artifact };
}

try {
  test("owner-attested evidence is exact, append-only, idempotent, and invalidatable", () => {
    const h = setup(join(root, "ledger"));
    try {
      const prior = h.store.getProject(h.uid, h.project.id).artifacts.find((item) => item.id === h.artifact.id);
      assert.equal(prior.complete, false);
      assert.equal(prior.copies.find((copy) => copy.backend === "chatgpt_project").status, "MISSING");
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

      const invalidated = h.store.invalidateNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: invalidation(recorded.body.evidenceId) });
      assert.equal(invalidated.status, 201);
      const invalidatedReplay = h.store.invalidateNativeProjectEvidence({ uid: h.uid, artifactId: h.artifact.id, manifest: invalidation(recorded.body.evidenceId) });
      assert.equal(invalidatedReplay.status, 200);
      assert.equal(invalidatedReplay.body.replayed, true);
      projected = h.store.getProject(h.uid, h.project.id).artifacts.find((item) => item.id === h.artifact.id);
      assert.equal(projected.complete, false);
      assert.equal(projected.copies.find((copy) => copy.backend === "chatgpt_project").status, "INVALIDATED");

      const restored = h.store.recordOwnerAttestedNativeProjectEvidence({
        uid: h.uid, artifactId: h.artifact.id, manifest: manifest(h.artifact, { observedAt: "2026-09-02T12:10:00.000Z", suffix: "restored-source" }),
      });
      assert.equal(restored.status, 201);
      projected = h.store.getProject(h.uid, h.project.id).artifacts.find((item) => item.id === h.artifact.id);
      assert.equal(projected.complete, true);
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
    const migrated = createGameFactoryStore({ dir: legacyDir });
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
