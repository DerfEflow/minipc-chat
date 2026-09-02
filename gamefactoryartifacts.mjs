/*
 * SD Tech Mobile Game Factory — immutable artifact storage and optional mirroring.
 *
 * The database stores truth about versions and copy verification. This module owns bytes. It
 * writes a content-addressed local primary first, verifies SHA-256 and byte count, then optionally
 * creates (never updates or deletes) a Google Drive copy. All write flags default off.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { MANDATORY_ARTIFACT_BACKENDS, REQUIRED_GAME_ARTIFACTS } from "./gamefactory.mjs";
import { LOCKED_NATIVE_CHATGPT_PROJECT_ID, OWNER_ATTESTED_NATIVE_PROJECT_FALLBACK_APPROVED } from "./gamefactorynativeevidence.mjs";

const TRUE = new Set(["1", "true", "yes", "on", "enabled"]);
const SECRET_KEY = /(authorization|cookie|credential|password|private.?key|secret|token)/i;
const MIME_EXTENSIONS = Object.freeze({
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "text/markdown": "md",
  "text/plain": "txt",
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/vnd.android.package-archive": "apk",
});

const result = (status, body) => ({ status, body });
const clean = (value, max = 500) => String(value == null ? "" : value).trim().slice(0, max);
const flag = (value) => TRUE.has(clean(value, 20).toLowerCase());
const safeError = (value) => clean(value, 1000)
  .replace(/\bBearer\s+[^\s,;]+/ig, "Bearer [redacted]")
  .replace(/([?&](?:access_?token|api_?key|key|password|secret|signature)=)[^&#\s]*/ig, "$1[redacted]")
  .replace(/\b(?:access_?token|api_?key|password|secret)\s*[:=]\s*[^\s,;]+/ig, "credential=[redacted]");
const compliance = () => ({
  status: "blocked",
  complete: false,
  requiredVerifiedBackends: [...MANDATORY_ARTIFACT_BACKENDS],
  nativeProjectConfigured: false,
  nativeProjectVerification: "DOCUMENTED_API_UNAVAILABLE",
  ownerAttestedBrowserFallback: {
    approved: OWNER_ATTESTED_NATIVE_PROJECT_FALLBACK_APPROVED,
    offlineOperatorOnly: true,
    projectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
  },
  fallbackBackend: "none",
  blocker: "No documented native ChatGPT Project verification API is configured. An approved owner-attested browser-upload record may be added only through the offline privileged operator command after primary and Drive verification.",
});

export function gameFactoryArtifactFlags(env = process.env) {
  return Object.freeze({
    localWritesEnabled: flag(env.GAME_FACTORY_ARTIFACT_WRITES),
    driveWritesEnabled: flag(env.GAME_FACTORY_MIRROR_WRITES),
  });
}

function segment(value, fallback = "item") {
  const safe = clean(value, 180).normalize("NFKC").toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 120);
  return safe && safe !== "." && safe !== ".." ? safe : fallback;
}

function extensionFor(mimeType, requested = "") {
  const asked = clean(requested, 20).toLowerCase().replace(/^\.+/, "").replace(/[^a-z0-9]/g, "");
  if (asked) return asked.slice(0, 12);
  return MIME_EXTENSIONS[clean(mimeType, 160).toLowerCase()] || "bin";
}

function safeObject(value, depth = 0) {
  if (depth > 5 || value == null) return value == null ? null : "[truncated]";
  if (["string", "number", "boolean"].includes(typeof value)) return typeof value === "string" ? clean(value, 1000) : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeObject(item, depth + 1));
  if (typeof value !== "object") return clean(value, 1000);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    const name = clean(key, 100);
    if (!name || SECRET_KEY.test(name)) continue;
    out[name] = safeObject(item, depth + 1);
  }
  return out;
}

function safeProvenance(value) {
  const sanitized = safeObject(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized : {};
}

function digestBuffer(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

async function digestIterable(iterable) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of iterable) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    size += bytes.length;
  }
  return { sha256: hash.digest("hex"), size };
}

async function digestFile(path) {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += chunk.length;
    }
    return { sha256: hash.digest("hex"), size };
  } finally {
    await handle.close();
  }
}

function driveBody(response) {
  if (response == null) throw new Error("Drive returned no download response.");
  if (response.ok === false) throw new Error(`Drive download failed with HTTP ${response.status || "unknown"}.`);
  if (response.body && response.body[Symbol.asyncIterator]) return response.body;
  if (response[Symbol.asyncIterator]) return response;
  if (Buffer.isBuffer(response) || typeof response === "string" || response instanceof Uint8Array) return [response];
  throw new Error("Drive download did not provide a readable body.");
}

function copyByBackend(artifact, backend) {
  return (artifact?.copies || []).find((copy) => copy.backend === backend) || null;
}

export function createGameFactoryArtifactMirror({
  store,
  rootDir,
  localWritesEnabled = false,
  driveWritesEnabled = false,
  driveForTenant = null,
  driveFolderName = "SD Tech Mobile Game Factory",
  log = () => {},
} = {}) {
  if (!store || typeof store.recordArtifact !== "function" || typeof store.recordArtifactCopy !== "function") {
    throw new Error("createGameFactoryArtifactMirror needs a game factory store");
  }
  if (!rootDir) throw new Error("createGameFactoryArtifactMirror needs rootDir");
  const root = resolve(rootDir);

  function objectPath({ uid, projectId, artifactKey, sha256, extension }) {
    const rel = join(segment(uid, "owner"), segment(projectId, "project"), segment(artifactKey, "artifact"), `${sha256}.${extension}`);
    const absolute = resolve(root, rel);
    const check = relative(root, absolute);
    if (!check || check.startsWith(".." + sep) || check === "..") throw new Error("Artifact path escaped its storage root.");
    return { absolute, relative: check.split(sep).join("/") };
  }

  function locateArtifact(uid, projectId, artifactId) {
    const detail = store.getProject(uid, projectId);
    if (!detail) return { detail: null, artifact: null };
    return { detail, artifact: (detail.artifacts || []).find((item) => item.id === artifactId) || null };
  }

  function pathForArtifact(uid, projectId, artifact) {
    const extension = extensionFor(artifact.mimeType, artifact.provenance?.localObject?.extension);
    return objectPath({ uid, projectId, artifactKey: artifact.artifactKey, sha256: artifact.sha256, extension });
  }

  function recordCopy(args) {
    return store.recordArtifactCopy(args);
  }

  async function ingestBuffer({ uid, projectId, artifactKey, data, mimeType = "application/octet-stream", extension = "", provenance = {} } = {}) {
    if (!localWritesEnabled) return result(503, { error: "Local artifact writes are disabled.", code: "artifact_writes_disabled" });
    const who = clean(uid, 80).toLowerCase();
    const project = clean(projectId, 180);
    const key = clean(artifactKey, 120).toUpperCase();
    if (!who || !project || !key) return result(400, { error: "uid, projectId, and artifactKey are required.", code: "bad_artifact" });
    if (!REQUIRED_GAME_ARTIFACTS.includes(key)) return result(400, { error: "Unknown required game artifact key.", code: "bad_artifact_key" });
    const projectDetail = store.getProject(who, project);
    if (!projectDetail) return result(404, { error: "No such game.", code: "not_found" });
    if (!(Buffer.isBuffer(data) || typeof data === "string" || data instanceof Uint8Array)) {
      return result(400, { error: "Artifact data must be bytes or text.", code: "bad_artifact_data" });
    }
    const { bytes, sha256, size } = digestBuffer(data);
    const ext = extensionFor(mimeType, extension);
    const path = objectPath({ uid: who, projectId: project, artifactKey: key, sha256, extension: ext });
    mkdirSync(dirname(path.absolute), { recursive: true });
    try {
      writeFileSync(path.absolute, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const verified = await digestFile(path.absolute);
    if (verified.sha256 !== sha256 || verified.size !== size) {
      return result(409, { error: "The immutable local object conflicts with these bytes.", code: "local_artifact_conflict", expected: { sha256, size }, actual: verified });
    }

    const prior = projectDetail.artifacts?.find((artifact) => artifact.artifactKey === key);
    if (prior && prior.sha256 === sha256 && Number(prior.size) === size && prior.mimeType === (clean(mimeType, 160) || "application/octet-stream")) {
      const local = recordCopy({
        uid: who, artifactId: prior.id, backend: "primary",
        locator: `factory-local://${path.relative}`, status: "VERIFIED", fingerprint: sha256, algorithm: "sha256",
      });
      if (!local || local.status >= 300) return local || result(500, { error: "Local copy verification could not be recorded.", code: "copy_record_failed" });
      const current = locateArtifact(who, project, prior.id).artifact;
      return result(200, {
        ok: true, artifactId: prior.id, version: prior.version, sha256, size, reused: true,
        local: copyByBackend(current, "primary"), complete: false, compliance: compliance(),
      });
    }

    const made = store.recordArtifact({
      uid: who, projectId: project, artifactKey: key, sha256, size,
      mimeType: clean(mimeType, 160) || "application/octet-stream",
      provenance: { ...safeProvenance(provenance), localObject: { formatVersion: 1, extension: ext } },
    });
    if (!made || made.status >= 300) return made || result(500, { error: "Artifact metadata could not be recorded.", code: "artifact_record_failed" });
    const local = recordCopy({
      uid: who, artifactId: made.body.artifactId, backend: "primary",
      locator: `factory-local://${path.relative}`, status: "VERIFIED", fingerprint: sha256, algorithm: "sha256",
    });
    if (!local || local.status >= 300) return local || result(500, { error: "Local copy verification could not be recorded.", code: "copy_record_failed" });
    const current = locateArtifact(who, project, made.body.artifactId).artifact;
    return result(201, {
      ok: true, artifactId: made.body.artifactId, version: made.body.version, sha256, size,
      local: copyByBackend(current, "primary"), complete: false, compliance: compliance(),
    });
  }

  async function verifyDriveFile(drive, file, artifact) {
    const meta = typeof drive.meta === "function" ? await drive.meta(file.id, "id,name,size,md5Checksum") : file;
    if (meta?.size != null && Number(meta.size) !== Number(artifact.size)) {
      return { ok: false, reason: "size_mismatch", actual: { size: Number(meta.size) } };
    }
    if (typeof drive.download !== "function") throw new Error("Drive adapter cannot verify uploaded bytes.");
    const digest = await digestIterable(driveBody(await drive.download(file.id)));
    return digest.sha256 === artifact.sha256 && digest.size === Number(artifact.size)
      ? { ok: true, ...digest }
      : { ok: false, reason: "fingerprint_mismatch", actual: digest };
  }

  async function mirrorArtifact({ uid, projectId, artifactId, tenant = null } = {}) {
    if (!driveWritesEnabled) return result(503, { error: "Google Drive mirror writes are disabled.", code: "mirror_writes_disabled" });
    if (typeof driveForTenant !== "function") return result(503, { error: "Google Drive is not configured for artifact mirroring.", code: "mirror_not_configured" });
    const who = clean(uid, 80).toLowerCase(), project = clean(projectId, 180), id = clean(artifactId, 180);
    const found = locateArtifact(who, project, id);
    if (!found.detail || !found.artifact) return result(404, { error: "No such current artifact version.", code: "not_found" });
    const artifact = found.artifact;
    const path = pathForArtifact(who, project, artifact);
    let localDigest;
    try {
      if (!existsSync(path.absolute) || !statSync(path.absolute).isFile()) throw new Error("The local primary object is missing.");
      localDigest = await digestFile(path.absolute);
    } catch (error) {
      recordCopy({ uid: who, artifactId: id, backend: "primary", locator: `factory-local://${path.relative}`, status: "FAILED", error: clean(error.message, 1000) });
      return result(409, { error: clean(error.message, 1000), code: "local_primary_unavailable" });
    }
    if (localDigest.sha256 !== artifact.sha256 || localDigest.size !== Number(artifact.size)) {
      recordCopy({ uid: who, artifactId: id, backend: "primary", locator: `factory-local://${path.relative}`, status: "CONFLICT", fingerprint: localDigest.sha256, algorithm: "sha256", error: "Local byte fingerprint or size changed." });
      return result(409, { error: "The local primary no longer matches registered artifact metadata.", code: "local_primary_conflict", expected: { sha256: artifact.sha256, size: artifact.size }, actual: localDigest });
    }
    recordCopy({ uid: who, artifactId: id, backend: "primary", locator: `factory-local://${path.relative}`, status: "VERIFIED", fingerprint: artifact.sha256, algorithm: "sha256" });

    let locator = "";
    try {
      const drive = await driveForTenant({ uid: who, tenant, project: found.detail });
      if (!drive || typeof drive.ensureFolder !== "function" || typeof drive.list !== "function" || typeof drive.uploadStream !== "function") {
        throw new Error("Google Drive adapter is missing immutable mirror operations.");
      }
      recordCopy({ uid: who, artifactId: id, backend: "google_drive", status: "COPYING" });
      const rootFolder = await drive.ensureFolder(clean(driveFolderName, 120) || "SD Tech Mobile Game Factory");
      const ownerFolder = await drive.ensureFolder(segment(who, "owner"), rootFolder);
      const projectFolder = await drive.ensureFolder(segment(found.detail.slug || project, "project"), ownerFolder);
      const ext = extensionFor(artifact.mimeType, artifact.provenance?.localObject?.extension);
      const fileName = `${segment(artifact.artifactKey, "artifact")}__v${Number(artifact.version) || 1}__${segment(artifact.id, "id")}__${artifact.sha256.slice(0, 20)}.${ext}`;
      const exact = (await drive.list(projectFolder, { fields: "files(id,name,size,md5Checksum,createdTime)" }))
        .filter((file) => file?.name === fileName);
      let uploaded = null;
      if (exact.length) {
        for (const candidate of exact) {
          const check = await verifyDriveFile(drive, candidate, artifact);
          if (check.ok) { uploaded = candidate; break; }
        }
        if (!uploaded) {
          locator = exact[0]?.id ? `gdrive://${clean(exact[0].id, 500)}` : "";
          recordCopy({ uid: who, artifactId: id, backend: "google_drive", locator, status: "CONFLICT", error: "An immutable Drive object with this name exists but its bytes do not match." });
          return result(409, { error: "The existing immutable Drive copy does not match this artifact.", code: "drive_copy_conflict" });
        }
      } else {
        uploaded = await drive.uploadStream(createReadStream(path.absolute), {
          name: fileName, parentId: projectFolder, mimeType: artifact.mimeType,
        });
      }
      if (!uploaded?.id) throw new Error("Google Drive did not return an immutable file identifier.");
      locator = `gdrive://${clean(uploaded.id, 500)}`;
      const verification = await verifyDriveFile(drive, uploaded, artifact);
      if (!verification.ok) {
        recordCopy({ uid: who, artifactId: id, backend: "google_drive", locator, status: "CONFLICT", fingerprint: verification.actual?.sha256 || "", algorithm: "sha256", error: `Drive verification failed: ${verification.reason}.` });
        return result(409, { error: "The uploaded Drive copy failed SHA-256 or size verification.", code: "drive_verification_failed", expected: { sha256: artifact.sha256, size: artifact.size }, actual: verification.actual || null });
      }
      const recorded = recordCopy({ uid: who, artifactId: id, backend: "google_drive", locator, status: "VERIFIED", fingerprint: artifact.sha256, algorithm: "sha256" });
      if (!recorded || recorded.status >= 300) return recorded || result(500, { error: "Drive verification could not be recorded.", code: "copy_record_failed" });
      return result(200, { ok: true, artifactId: id, locator, sha256: artifact.sha256, size: artifact.size, complete: false, reused: exact.length > 0, compliance: compliance() });
    } catch (error) {
      const message = safeError(error?.message || error) || "Drive mirroring failed.";
      recordCopy({ uid: who, artifactId: id, backend: "google_drive", locator, status: "RETRYABLE", error: message });
      log("game_factory_artifact_mirror_failed", { projectId: project, artifactId: id, error: message });
      return result(502, { error: message, code: "drive_mirror_failed" });
    }
  }

  async function mirrorProject({ uid, projectId, tenant = null } = {}) {
    if (!driveWritesEnabled) return result(503, { error: "Google Drive mirror writes are disabled.", code: "mirror_writes_disabled" });
    const detail = store.getProject(uid, projectId);
    if (!detail) return result(404, { error: "No such game.", code: "not_found" });
    const copies = [];
    for (const artifact of detail.artifacts || []) copies.push(await mirrorArtifact({ uid, projectId, artifactId: artifact.id, tenant }));
    const failed = copies.filter((item) => item.status >= 300).length;
    return result(failed ? 207 : 200, { ok: failed === 0, mirrored: copies.length - failed, failed, complete: false, compliance: compliance(), results: copies });
  }

  /*
   * Owner review receives verified bytes, never a path. The caller supplies the artifact selected
   * from the durable project detail, but this boundary looks it up again and validates every
   * identity and content field before reading. That keeps browser input and stale metadata from
   * becoming a local-file oracle.
   */
  async function readArtifactContent({ uid, projectId, artifact, maxBytes = 512 * 1024 } = {}) {
    const who = clean(uid, 80).toLowerCase();
    const project = clean(projectId, 180);
    const artifactId = clean(artifact?.id, 180);
    if (!who || !project || !artifactId) throw new Error("A current artifact identity is required.");
    const found = locateArtifact(who, project, artifactId);
    if (!found.detail || !found.artifact) throw new Error("The current artifact is unavailable.");
    const current = found.artifact;
    if (!REQUIRED_GAME_ARTIFACTS.includes(current.artifactKey)) throw new Error("The artifact key is not reviewable.");
    if (!new Set(["text/markdown", "text/plain"]).has(current.mimeType)) throw new Error("The artifact type is not reviewable.");
    if (current.id !== artifactId
      || current.artifactKey !== clean(artifact?.artifactKey, 120).toUpperCase()
      || current.sha256 !== clean(artifact?.sha256, 128).toLowerCase()
      || Number(current.size) !== Number(artifact?.size)
      || current.mimeType !== clean(artifact?.mimeType, 160).toLowerCase()) {
      throw new Error("The artifact metadata changed before review.");
    }
    const limit = Math.min(Math.max(Number(maxBytes) || 0, 1), 512 * 1024);
    if (!Number.isSafeInteger(Number(current.size)) || Number(current.size) < 0 || Number(current.size) > limit) {
      throw new Error("The artifact is too large to review here.");
    }
    const path = pathForArtifact(who, project, current);
    if (!existsSync(path.absolute)) throw new Error("The immutable local artifact is unavailable.");
    const linkStat = lstatSync(path.absolute);
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) throw new Error("The immutable local artifact is not a regular file.");
    const canonical = realpathSync(path.absolute);
    const canonicalRelative = relative(realpathSync(root), canonical);
    if (!canonicalRelative || canonicalRelative === ".." || canonicalRelative.startsWith(".." + sep)) {
      throw new Error("The immutable local artifact escaped its storage root.");
    }
    const handle = await open(canonical, "r");
    try {
      const live = await handle.stat();
      if (!live.isFile() || Number(live.size) !== Number(current.size) || live.size > limit) {
        throw new Error("The immutable local artifact size changed.");
      }
      const data = await handle.readFile();
      const digest = digestBuffer(data);
      if (digest.size !== Number(current.size) || digest.sha256 !== current.sha256) {
        throw new Error("The immutable local artifact fingerprint changed.");
      }
      return { data };
    } finally {
      await handle.close();
    }
  }

  function health() {
    return {
      configured: true,
      status: "blocked",
      localWritesEnabled: !!localWritesEnabled,
      driveConfigured: typeof driveForTenant === "function",
      driveWritesEnabled: !!driveWritesEnabled,
      nativeProjectConfigured: false,
      nativeProjectVerification: "DOCUMENTED_API_UNAVAILABLE",
      ownerAttestedBrowserFallback: {
        approved: OWNER_ATTESTED_NATIVE_PROJECT_FALLBACK_APPROVED,
        offlineOperatorOnly: true,
        projectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
      },
      requiredVerifiedBackends: [...MANDATORY_ARTIFACT_BACKENDS],
      fallbackBackend: "none",
      complianceComplete: false,
      blocker: compliance().blocker,
      immutable: true,
      deletionSupported: false,
      reviewReadsSupported: true,
    };
  }

  return { ingestBuffer, mirrorArtifact, mirrorProject, readArtifactContent, health };
}
