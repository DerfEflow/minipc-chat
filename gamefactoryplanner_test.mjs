import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MANDATORY_ARTIFACT_BACKENDS, REQUIRED_GAME_ARTIFACTS } from "./gamefactory.mjs";
import { createGameFactoryPlanner } from "./gamefactoryplanner.mjs";
import { renderGameArtifact } from "./gamefactorytemplates.mjs";

const clone = (value) => structuredClone(value);
const digest = (value) => createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");

function harness({
  localWritesEnabled = true,
  driveWritesEnabled = true,
  failIngestOnce = "",
  failMirror = "",
  nativeCopiesVerified = false,
  mirrorEvidenceMissing = "",
} = {}) {
  const commands = new Map();
  const versions = new Map();
  const project = {
    id: "gf_owner_vector-vault", uid: "owner", name: "Vector Vault", slug: "vector-vault",
    state: "IDEA", version: 1, artifacts: [], approvals: [],
    evidence: { specificationApproved: false },
    approvalSubjects: { SPECIFICATION: { ready: false, code: "approval_subject_missing" } },
  };
  let executeCalls = 0, ingestCalls = 0, mirrorCalls = 0;
  const store = {
    getProject(uid, projectId) {
      if (uid !== project.uid || projectId !== project.id) return null;
      const copy = clone(project);
      const relevant = new Set(["00_GAME_BRIEF", "01_MARKET_CASE", "02_RELEASE_ROADMAP", "03_BUILD_WORKFLOW"]);
      const relevantReady = copy.artifacts.filter((item) => relevant.has(item.artifactKey)).length === relevant.size
        && copy.artifacts.filter((item) => relevant.has(item.artifactKey)).every((item) => item.complete);
      copy.approvalSubjects.SPECIFICATION = relevantReady ? { ready: true, hash: "a".repeat(64) } : { ready: false, code: "approval_artifact_copies_missing" };
      return copy;
    },
    executeCommand(input) {
      executeCalls++;
      const request = JSON.stringify({ projectId: input.projectId, expectedVersion: input.expectedVersion, type: input.type, payload: input.payload });
      const prior = commands.get(input.key);
      if (prior) {
        if (prior.request !== request) return { status: 409, body: { code: "idempotency_conflict" } };
        return { status: prior.status, body: { ...clone(prior.body), replayed: true } };
      }
      let response;
      if (Number(input.expectedVersion) !== project.version) response = { status: 409, body: { code: "version_conflict", currentVersion: project.version } };
      else if (project.state !== "IDEA") response = { status: 409, body: { code: "specification_approval_required" } };
      else {
        project.state = "SPECIFICATION";
        project.version++;
        response = { status: 200, body: { ok: true, project: { id: project.id, state: project.state, version: project.version } } };
      }
      commands.set(input.key, { request, status: response.status, body: clone(response.body) });
      return response;
    },
  };
  const artifactMirror = {
    health() {
      return { localWritesEnabled, driveWritesEnabled, nativeProjectConfigured: false };
    },
    async ingestBuffer({ artifactKey, data, mimeType, provenance }) {
      ingestCalls++;
      if (artifactKey === failIngestOnce) {
        failIngestOnce = "";
        throw new Error("transient local interruption");
      }
      const sha256 = digest(data), size = Buffer.byteLength(data);
      let artifact = project.artifacts.find((item) => item.artifactKey === artifactKey);
      if (artifact && artifact.sha256 === sha256 && artifact.size === size && artifact.mimeType === mimeType) {
        const primary = artifact.copies.find((copy) => copy.backend === "primary");
        if (!primary) artifact.copies.push({ backend: "primary", status: "VERIFIED", algorithm: "sha256", fingerprint: sha256 });
        if (nativeCopiesVerified && !artifact.copies.some((copy) => copy.backend === "chatgpt_project")) {
          artifact.copies.push({ backend: "chatgpt_project", status: "OWNER_ATTESTED", algorithm: "sha256", fingerprint: sha256 });
        }
        return { status: 200, body: { ok: true, artifactId: artifact.id, version: artifact.version, sha256, size, reused: true } };
      }
      const version = (versions.get(artifactKey) || 0) + 1;
      versions.set(artifactKey, version);
      const copies = [{ backend: "primary", status: "VERIFIED", algorithm: "sha256", fingerprint: sha256 }];
      if (nativeCopiesVerified) copies.push({ backend: "chatgpt_project", status: "OWNER_ATTESTED", algorithm: "sha256", fingerprint: sha256 });
      artifact = {
        id: `artifact-${artifactKey}-${version}`, artifactKey, version, sha256, size, mimeType,
        provenance, copies, complete: false,
      };
      project.artifacts.push(artifact);
      project.version++;
      return { status: 201, body: { ok: true, artifactId: artifact.id, version, sha256, size } };
    },
    async mirrorArtifact({ artifactId }) {
      mirrorCalls++;
      const artifact = project.artifacts.find((item) => item.id === artifactId);
      if (artifact?.artifactKey === failMirror) return { status: 502, body: { code: "drive_mirror_failed", error: "Drive unavailable" } };
      if (artifact?.artifactKey === mirrorEvidenceMissing) {
        return { status: 200, body: { ok: true, artifactId, sha256: artifact.sha256, size: artifact.size } };
      }
      artifact.copies = artifact.copies.filter((copy) => copy.backend !== "google_drive");
      artifact.copies.push({ backend: "google_drive", status: "VERIFIED", algorithm: "sha256", fingerprint: artifact.sha256 });
      artifact.complete = MANDATORY_ARTIFACT_BACKENDS.every((backend) => artifact.copies.some((copy) => copy.backend === backend
        && (copy.status === "VERIFIED" || (backend === "chatgpt_project" && copy.status === "OWNER_ATTESTED"))));
      project.version++;
      return { status: 200, body: { ok: true, artifactId, sha256: artifact.sha256, size: artifact.size } };
    },
  };
  return {
    project, store, artifactMirror, versions,
    counts: () => ({ executeCalls, ingestCalls, mirrorCalls }),
  };
}

let n = 0;
async function test(name, fn) { await fn(); n++; console.log("ok", n, "-", name); }

await test("disabled local artifact writes fail before the lifecycle transition", async () => {
  const h = harness({ localWritesEnabled: false });
  const planner = createGameFactoryPlanner({ store: h.store, artifactMirror: h.artifactMirror });
  const response = await planner.startSpecification({ uid: "owner", projectId: h.project.id, key: "start-disabled", expectedVersion: 1 });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "artifact_writes_disabled");
  assert.equal(h.project.state, "IDEA");
  assert.deepEqual(h.counts(), { executeCalls: 0, ingestCalls: 0, mirrorCalls: 0 });
});

await test("disabled Drive mirroring fails before the lifecycle transition", async () => {
  const h = harness({ driveWritesEnabled: false });
  const planner = createGameFactoryPlanner({ store: h.store, artifactMirror: h.artifactMirror });
  const response = await planner.startSpecification({ uid: "owner", projectId: h.project.id, key: "start-no-mirror", expectedVersion: 1 });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "mirror_writes_disabled");
  assert.equal(h.project.state, "IDEA");
  assert.deepEqual(h.counts(), { executeCalls: 0, ingestCalls: 0, mirrorCalls: 0 });
});

await test("a trusted start renders all eleven exact templates and records no approval", async () => {
  const h = harness({ nativeCopiesVerified: true });
  const planner = createGameFactoryPlanner({ store: h.store, artifactMirror: h.artifactMirror });
  const response = await planner.startSpecification({ uid: "owner", email: "owner@example.com", projectId: h.project.id, key: "start-vector", expectedVersion: 1, actor: "owner@example.com" });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.project.state, "SPECIFICATION");
  assert.equal(response.body.specification.localReady, true);
  assert.equal(response.body.specification.requiredCopiesComplete, true);
  assert.equal(response.body.specification.approvalSubjectReady, true);
  assert.equal(response.body.specification.specificationApprovalRecorded, false);
  assert.equal(response.body.specification.requiredHumanApproval, "SPECIFICATION");
  assert.equal(response.body.artifacts.length, 11);
  assert.equal(h.counts().mirrorCalls, 11);
  assert.deepEqual(h.project.approvals, []);
  for (const artifact of response.body.artifacts) {
    const rendered = renderGameArtifact("vector-vault", artifact.artifactKey);
    assert.equal(artifact.expected.sha256, digest(rendered));
    assert.equal(artifact.expected.size, Buffer.byteLength(rendered));
    assert.equal(artifact.artifact.sha256, artifact.expected.sha256);
    assert.equal(artifact.deterministicMatch, true);
    assert.equal(artifact.localPrimary.verified, true);
    assert.equal(artifact.twoCopyReady, true);
    assert.deepEqual(artifact.requiredCopies.map((copy) => copy.backend), [...MANDATORY_ARTIFACT_BACKENDS]);
    assert.equal(artifact.requiredCopies.some((copy) => copy.backend === "google_drive" && copy.verified), true);
    assert.equal(artifact.requiredCopies.some((copy) => copy.backend === "chatgpt_project" && copy.verified), true);
  }
});

await test("2xx Drive results cannot hide a missing mandatory native-project copy", async () => {
  const h = harness();
  const planner = createGameFactoryPlanner({ store: h.store, artifactMirror: h.artifactMirror });
  const response = await planner.startSpecification({ uid: "owner", projectId: h.project.id, key: "start-native-missing", expectedVersion: 1 });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "mandatory_artifact_copies_incomplete");
  assert.equal(response.body.ok, false);
  assert.equal(response.body.partial, true);
  assert.equal(response.body.project.state, "SPECIFICATION");
  assert.equal(response.body.specification.requiredCopiesComplete, false);
  assert.equal(response.body.storage.complianceComplete, false);
  assert.equal(response.body.failures.mirror.length, 0);
  assert.equal(response.body.failures.mandatoryCopies.length, REQUIRED_GAME_ARTIFACTS.length);
  for (const failure of response.body.failures.mandatoryCopies) assert.deepEqual(failure.backends, ["chatgpt_project"]);
});

await test("a 2xx mirror response without verified store evidence remains a loud partial failure", async () => {
  const missingEvidence = REQUIRED_GAME_ARTIFACTS[6];
  const h = harness({ nativeCopiesVerified: true, mirrorEvidenceMissing: missingEvidence });
  const planner = createGameFactoryPlanner({ store: h.store, artifactMirror: h.artifactMirror });
  const response = await planner.startSpecification({ uid: "owner", projectId: h.project.id, key: "start-store-evidence-missing", expectedVersion: 1 });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "mandatory_artifact_copies_incomplete");
  assert.equal(response.body.ok, false);
  assert.equal(response.body.partial, true);
  assert.deepEqual(response.body.failures.mirror, []);
  assert.deepEqual(response.body.failures.mandatoryCopies, [{ artifactKey: missingEvidence, backends: ["google_drive"] }]);
  const artifact = response.body.artifacts.find((item) => item.artifactKey === missingEvidence);
  assert.equal(artifact.mirror.status, 200);
  assert.equal(artifact.requiredCopies.find((copy) => copy.backend === "google_drive").verified, false);
});

await test("the same command safely recovers a partial ingest without duplicate artifact versions", async () => {
  const missingOnce = REQUIRED_GAME_ARTIFACTS[4];
  const h = harness({ failIngestOnce: missingOnce, nativeCopiesVerified: true });
  const planner = createGameFactoryPlanner({ store: h.store, artifactMirror: h.artifactMirror });
  const input = { uid: "owner", projectId: h.project.id, key: "start-recover", expectedVersion: 1 };
  const first = await planner.startSpecification(input);
  assert.equal(first.status, 500);
  assert.equal(first.body.project.state, "SPECIFICATION");
  assert.deepEqual(first.body.failures.local, [missingOnce]);
  assert.equal(h.project.artifacts.length, 10);

  const second = await planner.startSpecification(input);
  assert.equal(second.status, 200);
  assert.equal(second.body.commandReplayed, true);
  assert.equal(second.body.specification.localReady, true);
  assert.equal(h.project.artifacts.length, REQUIRED_GAME_ARTIFACTS.length);
  assert.equal(new Set(h.project.artifacts.map((artifact) => artifact.artifactKey)).size, REQUIRED_GAME_ARTIFACTS.length);
  for (const key of REQUIRED_GAME_ARTIFACTS) assert.equal(h.versions.get(key), 1, `${key} must stay at v1`);
  assert.equal(second.body.artifacts.filter((artifact) => artifact.ingest.reused).length, 10);
  assert.equal(h.counts().executeCalls, 2);
});

await test("a different start key cannot enter recovery or bypass optimistic concurrency", async () => {
  const h = harness({ failIngestOnce: REQUIRED_GAME_ARTIFACTS[0] });
  const planner = createGameFactoryPlanner({ store: h.store, artifactMirror: h.artifactMirror });
  await planner.startSpecification({ uid: "owner", projectId: h.project.id, key: "original", expectedVersion: 1 });
  const count = h.project.artifacts.length;
  const response = await planner.startSpecification({ uid: "owner", projectId: h.project.id, key: "different", expectedVersion: h.project.version });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "specification_approval_required");
  assert.equal(h.project.artifacts.length, count);
});

await test("Drive mirror failures remain visible and never invent the missing native-project copy", async () => {
  const failedKey = REQUIRED_GAME_ARTIFACTS[7];
  const h = harness({ driveWritesEnabled: true, failMirror: failedKey });
  const planner = createGameFactoryPlanner({ store: h.store, artifactMirror: h.artifactMirror });
  const response = await planner.startSpecification({ uid: "owner", projectId: h.project.id, key: "start-mirror", expectedVersion: 1, tenant: { uid: "owner" } });
  assert.equal(response.status, 502);
  assert.equal(response.body.specification.localReady, true);
  assert.equal(response.body.specification.requiredCopiesComplete, false);
  assert.deepEqual(response.body.failures.mirror, [failedKey]);
  assert.equal(response.body.artifacts.find((artifact) => artifact.artifactKey === failedKey).mirror.code, "drive_mirror_failed");
  assert.equal(response.body.artifacts.filter((artifact) => artifact.requiredCopies.find((copy) => copy.backend === "google_drive")?.verified).length, 10);
  assert.equal(response.body.artifacts.some((artifact) => artifact.requiredCopies.find((copy) => copy.backend === "chatgpt_project")?.verified), false);
  assert.equal(response.body.storage.nativeProjectConfigured, false);
  assert.equal(response.body.storage.complianceComplete, false);
  assert.equal(response.body.specification.specificationApprovalRecorded, false);
  assert.equal(h.counts().mirrorCalls, 11);
});

console.log(`\n${n} game factory planner tests passed`);
