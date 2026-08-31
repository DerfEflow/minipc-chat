import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGameFactoryArtifactMirror, gameFactoryArtifactFlags } from "./gamefactoryartifacts.mjs";
import { createGameFactoryStore } from "./gamefactorystore.mjs";

const clone = (value) => structuredClone(value);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fakeStore() {
  const detail = { id: "game_owner_vector-vault", slug: "vector-vault", artifacts: [], missing: ["00_GAME_BRIEF"], complete: false };
  let artifactNumber = 0;
  return {
    detail,
    getProject(uid, projectId) { return uid === "owner" && projectId === detail.id ? clone(detail) : null; },
    recordArtifact({ uid, projectId, artifactKey, sha256, size, mimeType, provenance }) {
      if (uid !== "owner" || projectId !== detail.id) return { status: 404, body: { code: "not_found" } };
      const version = detail.artifacts.filter((item) => item.artifactKey === artifactKey).length + 1;
      const id = `artifact-${++artifactNumber}`;
      detail.artifacts.unshift({ id, artifactKey, version, sha256, size, mimeType, provenance, copies: [], complete: false });
      return { status: 201, body: { ok: true, artifactId: id, version } };
    },
    recordArtifactCopy({ uid, artifactId, backend, locator = "", status, fingerprint = "", algorithm = "sha256", error = "" }) {
      const artifact = detail.artifacts.find((item) => item.id === artifactId);
      if (uid !== "owner" || !artifact) return { status: 404, body: { code: "not_found" } };
      let state = status;
      if (state === "VERIFIED" && (algorithm !== "sha256" || fingerprint !== artifact.sha256)) state = "CONFLICT";
      const copy = { backend, locator, status: state, fingerprint, algorithm, lastError: error };
      const index = artifact.copies.findIndex((item) => item.backend === backend);
      if (index >= 0) artifact.copies[index] = copy; else artifact.copies.push(copy);
      // `primary` is fallback only. Compliance needs both inaccessible native Project and Drive.
      artifact.complete = ["chatgpt_project", "google_drive"].every((required) => artifact.copies.some((item) => item.backend === required && item.status === "VERIFIED"));
      detail.complete = detail.artifacts.length > 0 && detail.artifacts.every((item) => item.complete);
      return { status: state === "CONFLICT" ? 409 : 200, body: { ok: state === "VERIFIED", status: state } };
    },
  };
}

class FakeDrive {
  constructor() { this.folders = new Map(); this.files = new Map(); this.uploads = 0; this.corruptDownloads = false; }
  async ensureFolder(name, parentId = "root") {
    const key = `${parentId}/${name}`;
    if (!this.folders.has(key)) this.folders.set(key, `folder-${this.folders.size + 1}`);
    return this.folders.get(key);
  }
  async list(folderId) { return [...this.files.values()].filter((file) => file.parentId === folderId).map(({ bytes, ...file }) => ({ ...file, size: bytes.length })); }
  async uploadStream(stream, { name, parentId, mimeType }) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), id = `file-${this.files.size + 1}`;
    const file = { id, name, parentId, mimeType, bytes };
    this.files.set(id, file); this.uploads++;
    return { id, name, size: bytes.length };
  }
  async meta(id) { const file = this.files.get(id); return { id, name: file.name, size: file.bytes.length }; }
  async download(id) {
    const file = this.files.get(id);
    const bytes = this.corruptDownloads ? Buffer.concat([file.bytes, Buffer.from("corrupt")]) : file.bytes;
    return { ok: true, body: Readable.from([bytes]) };
  }
}

const dir = mkdtempSync(join(tmpdir(), "dominion-gamefactory-artifacts-"));
let n = 0;
async function test(name, fn) { await fn(); console.log("ok", ++n, "-", name); }

try {
  await test("artifact and mirror flags fail closed", async () => {
    assert.deepEqual(gameFactoryArtifactFlags({}), { localWritesEnabled: false, driveWritesEnabled: false });
    assert.deepEqual(gameFactoryArtifactFlags({ GAME_FACTORY_ARTIFACT_WRITES: "1", GAME_FACTORY_MIRROR_WRITES: "true" }), { localWritesEnabled: true, driveWritesEnabled: true });
    const store = fakeStore();
    const service = createGameFactoryArtifactMirror({ store, rootDir: join(dir, "disabled") });
    assert.equal((await service.ingestBuffer({ uid: "owner", projectId: store.detail.id, artifactKey: "00_GAME_BRIEF", data: "no" })).status, 503);
    assert.equal(service.health().nativeProjectConfigured, false);
    assert.equal(service.health().status, "blocked");
    assert.equal(service.health().reviewReadsSupported, true);
    assert.deepEqual(service.health().requiredVerifiedBackends, ["chatgpt_project", "google_drive"]);
    assert.equal("delete" in service, false);
  });

  const store = fakeStore(), drive = new FakeDrive();
  const service = createGameFactoryArtifactMirror({
    store, rootDir: join(dir, "objects"), localWritesEnabled: true, driveWritesEnabled: true,
    driveForTenant: async () => drive,
  });
  let made, firstPath;

  await test("local primary is immutable, verified, and strips secret provenance", async () => {
    assert.equal((await service.ingestBuffer({ uid: "owner", projectId: store.detail.id, artifactKey: "../../UNKNOWN", data: "no" })).body.code, "bad_artifact_key");
    made = await service.ingestBuffer({
      uid: "owner", projectId: store.detail.id, artifactKey: "00_GAME_BRIEF", data: "immutable brief", mimeType: "text/markdown",
      provenance: { sourceCommit: "abc123", accessToken: "must-not-persist", nested: { password: "no", workerRunId: "run-1" } },
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.size, Buffer.byteLength("immutable brief"));
    assert.equal(made.body.sha256, sha(Buffer.from("immutable brief")));
    assert.equal(made.body.local.backend, "primary");
    assert.equal(made.body.local.status, "VERIFIED");
    assert.equal(made.body.complete, false);
    assert.equal(made.body.compliance.status, "blocked");
    const rel = made.body.local.locator.replace("factory-local://", "").replaceAll("/", "\\");
    firstPath = join(dir, "objects", rel);
    assert.equal(existsSync(firstPath), true);
    assert.equal(readFileSync(firstPath, "utf8"), "immutable brief");
    const provenance = store.detail.artifacts.find((item) => item.id === made.body.artifactId).provenance;
    assert.equal(provenance.sourceCommit, "abc123");
    assert.equal(provenance.accessToken, undefined);
    assert.equal(provenance.nested.password, undefined);
    assert.equal(provenance.nested.workerRunId, "run-1");
    const replay = await service.ingestBuffer({ uid: "owner", projectId: store.detail.id, artifactKey: "00_GAME_BRIEF", data: "immutable brief", mimeType: "text/markdown" });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.reused, true);
    assert.equal(replay.body.artifactId, made.body.artifactId);
    assert.equal(store.detail.artifacts.filter((item) => item.artifactKey === "00_GAME_BRIEF").length, 1);
  });

  await test("owner review returns verified bytes without exposing a local path", async () => {
    const artifact = clone(store.detail.artifacts.find((item) => item.id === made.body.artifactId));
    const reviewed = await service.readArtifactContent({ uid: "owner", projectId: store.detail.id, artifact, maxBytes: 1024 });
    assert.ok(Buffer.isBuffer(reviewed.data));
    assert.equal(reviewed.data.toString("utf8"), "immutable brief");
    assert.equal(Object.values(reviewed).some((value) => typeof value === "string" && value.includes(firstPath)), false);
    await assert.rejects(
      service.readArtifactContent({ uid: "owner", projectId: store.detail.id, artifact: { ...artifact, sha256: "0".repeat(64) } }),
      /metadata changed/,
    );
    await assert.rejects(
      service.readArtifactContent({ uid: "owner", projectId: store.detail.id, artifact, maxBytes: 4 }),
      /too large/,
    );
  });

  await test("Drive mirror downloads and verifies exact SHA-256 and size", async () => {
    const mirrored = await service.mirrorArtifact({ uid: "owner", projectId: store.detail.id, artifactId: made.body.artifactId });
    assert.equal(mirrored.status, 200);
    assert.equal(mirrored.body.sha256, made.body.sha256);
    assert.equal(mirrored.body.complete, false);
    assert.equal(mirrored.body.compliance.status, "blocked");
    assert.equal(drive.uploads, 1);
    const artifact = store.detail.artifacts.find((item) => item.id === made.body.artifactId);
    assert.equal(artifact.copies.find((item) => item.backend === "google_drive").status, "VERIFIED");
    assert.equal(artifact.copies.some((item) => item.backend === "chatgpt_project"), false);
  });

  await test("retry reuses a verified immutable Drive object instead of duplicating it", async () => {
    const mirrored = await service.mirrorArtifact({ uid: "owner", projectId: store.detail.id, artifactId: made.body.artifactId });
    assert.equal(mirrored.status, 200);
    assert.equal(mirrored.body.reused, true);
    assert.equal(drive.uploads, 1);
  });

  await test("Drive corruption is recorded as conflict and never reported complete", async () => {
    const second = await service.ingestBuffer({ uid: "owner", projectId: store.detail.id, artifactKey: "01_MARKET_CASE", data: "market case", mimeType: "text/markdown" });
    drive.corruptDownloads = true;
    const mirrored = await service.mirrorArtifact({ uid: "owner", projectId: store.detail.id, artifactId: second.body.artifactId });
    assert.equal(mirrored.status, 409);
    assert.equal(mirrored.body.code, "drive_verification_failed");
    const artifact = store.detail.artifacts.find((item) => item.id === second.body.artifactId);
    assert.equal(artifact.copies.find((item) => item.backend === "google_drive").status, "CONFLICT");
    assert.equal(artifact.complete, false);
    drive.corruptDownloads = false;
  });

  await test("a changed local primary blocks mirroring and is downgraded to conflict", async () => {
    writeFileSync(firstPath, "tampered");
    const current = clone(store.detail.artifacts.find((item) => item.id === made.body.artifactId));
    await assert.rejects(
      service.readArtifactContent({ uid: "owner", projectId: store.detail.id, artifact: current }),
      /size changed|fingerprint changed/,
    );
    const mirrored = await service.mirrorArtifact({ uid: "owner", projectId: store.detail.id, artifactId: made.body.artifactId });
    assert.equal(mirrored.status, 409);
    assert.equal(mirrored.body.code, "local_primary_conflict");
    const artifact = store.detail.artifacts.find((item) => item.id === made.body.artifactId);
    assert.equal(artifact.copies.find((item) => item.backend === "primary").status, "CONFLICT");
    assert.equal(artifact.complete, false);
  });

  await test("the durable store never treats primary plus Drive as mandated two-copy completeness", async () => {
    const durable = createGameFactoryStore({ dir: join(dir, "sqlite") });
    try {
      const projectId = durable.seedPortfolio({ uid: "owner", email: "owner@example.com" })[0].id;
      const integrationDrive = new FakeDrive();
      const integration = createGameFactoryArtifactMirror({
        store: durable, rootDir: join(dir, "integration-objects"), localWritesEnabled: true, driveWritesEnabled: true,
        driveForTenant: async () => integrationDrive,
      });
      const ingested = await integration.ingestBuffer({ uid: "owner", projectId, artifactKey: "00_GAME_BRIEF", data: "durable brief", mimeType: "text/markdown" });
      assert.equal(ingested.status, 201);
      assert.equal((await integration.mirrorArtifact({ uid: "owner", projectId, artifactId: ingested.body.artifactId })).status, 200);
      const artifact = durable.getProject("owner", projectId).artifacts.find((item) => item.id === ingested.body.artifactId);
      assert.deepEqual(artifact.copies.map((item) => item.backend).sort(), ["google_drive", "primary"]);
      assert.equal(artifact.complete, false);
      assert.equal(durable.getProject("owner", projectId).complete, false);
    } finally {
      durable.close();
    }
  });

  console.log(`\n${n} game factory artifact tests passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
