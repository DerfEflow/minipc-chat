/*
 * SD Tech Mobile Game Factory — native ChatGPT Project evidence vocabulary.
 *
 * There is currently no documented native Project verification API available to this runtime.
 * These validators deliberately distinguish a future machine-verifiable API receipt from the
 * narrowly approved, offline owner-attested browser-upload fallback.  Neither is a browser API;
 * callers must use the durable store's append-only evidence functions.
 */
import { createHash } from "node:crypto";

export const LOCKED_NATIVE_CHATGPT_PROJECT_ID = "g-p-6a97fd4de8ac8191ae375fe1242c1ea8";
export const NATIVE_PROJECT_EVIDENCE_FORMAT_VERSION = 1;
export const NATIVE_PROJECT_OWNER_ATTESTED_STATUS = "OWNER_ATTESTED";
export const NATIVE_PROJECT_API_VERIFIED_STATUS = "NATIVE_API_VERIFIED";
export const OWNER_ATTESTED_NATIVE_PROJECT_FALLBACK_APPROVED = true;
export const OWNER_ATTESTATION_OPERATOR = "Fred Wolfe";
export const OWNER_ATTESTATION_ACKNOWLEDGEMENT = "I directly verified in the owner-controlled native ChatGPT Project browser UI that exactly one file was uploaded with this exact filename to the locked Project.";

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
const HEX64 = /^[a-f0-9]{64}$/;
const REF_SEGMENT = /^[A-Za-z0-9._~/-]{8,400}$/;
const OPERATOR = /^[A-Za-z][A-Za-z .,'@_-]{1,159}$/;
const INVALIDATION_REASONS = new Set(["SOURCE_REMOVED", "SOURCE_AMBIGUOUS", "PROJECT_MISMATCH", "UPLOAD_METHOD_INVALID"]);

const text = (value, max = 1000) => String(value == null ? "" : value).trim().slice(0, max);
const plainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
export function canonicalNativeEvidenceJson(value) {
  return JSON.stringify(stable(value));
}
export function nativeEvidenceManifestHash(value) {
  return createHash("sha256").update(canonicalNativeEvidenceJson(value)).digest("hex");
}
function exactKeys(value, keys, label) {
  if (!plainObject(value)) fail("bad_native_project_manifest", `${label} must be an object.`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    fail("bad_native_project_manifest", `${label} has an unexpected field.`);
  }
}
function canonicalTimestamp(value, field = "observedAt") {
  const raw = text(value, 64);
  const at = Date.parse(raw);
  if (!raw || !Number.isFinite(at) || new Date(at).toISOString() !== raw) {
    fail("bad_native_project_manifest", `${field} must be an exact ISO-8601 timestamp.`);
  }
  return raw;
}
function expectedArtifact(artifact) {
  if (!plainObject(artifact)) fail("native_project_artifact_missing", "A current artifact is required.");
  const id = text(artifact.id, 180);
  const key = text(artifact.artifactKey, 120).toUpperCase();
  const version = Number(artifact.version);
  const sha256 = text(artifact.sha256, 64).toLowerCase();
  const size = Number(artifact.size);
  if (!id || !key || !Number.isSafeInteger(version) || version < 1 || !HEX64.test(sha256)
      || !Number.isSafeInteger(size) || size < 0) {
    fail("native_project_artifact_invalid", "The current artifact has invalid immutable metadata.");
  }
  return { id, key, version, sha256, size, mimeType: text(artifact.mimeType, 160).toLowerCase() };
}
function extensionFor(artifact) {
  const requested = text(artifact?.provenance?.localObject?.extension, 20).toLowerCase().replace(/^\.+/, "").replace(/[^a-z0-9]/g, "");
  return requested || MIME_EXTENSIONS[text(artifact?.mimeType, 160).toLowerCase()] || "bin";
}
function filenameSegment(value) {
  return text(value, 180).normalize("NFKC").toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "").slice(0, 120);
}
export function expectedNativeProjectFilename(artifact) {
  const current = expectedArtifact(artifact);
  const key = filenameSegment(current.key);
  const id = filenameSegment(current.id);
  if (!key || !id) fail("native_project_artifact_invalid", "The current artifact cannot form a canonical native Project filename.");
  return `${key}__v${current.version}__${id}__${current.sha256.slice(0, 20)}.${extensionFor(artifact)}`;
}
function browserReference(value) {
  const raw = text(value, 500);
  const prefix = `chatgpt-project-browser://${LOCKED_NATIVE_CHATGPT_PROJECT_ID}/`;
  const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : "";
  if (!rest || !REF_SEGMENT.test(rest) || rest.includes("..") || raw.includes("?") || raw.includes("#")) {
    fail("bad_browser_evidence_reference", "browserEvidenceRef must be an opaque owner-browser reference for the locked native Project.");
  }
  return raw;
}
function apiReference(value) {
  const raw = text(value, 500);
  const prefix = `chatgpt-project-api://${LOCKED_NATIVE_CHATGPT_PROJECT_ID}/`;
  const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : "";
  if (!rest || !REF_SEGMENT.test(rest) || rest.includes("..") || raw.includes("?") || raw.includes("#")) {
    fail("bad_native_api_receipt", "verificationReceiptRef must be an opaque documented-native-API reference for the locked Project.");
  }
  return raw;
}
function boundArtifactFields(input, artifact, filename) {
  const current = expectedArtifact(artifact);
  if (text(input.artifactId, 180) !== current.id || text(input.artifactKey, 120).toUpperCase() !== current.key
      || Number(input.artifactVersion) !== current.version || text(input.sha256, 64).toLowerCase() !== current.sha256
      || Number(input.size) !== current.size || text(input.filename, 300) !== filename) {
    fail("native_project_artifact_mismatch", "The native Project evidence does not bind the exact current artifact version, hash, size, and filename.");
  }
  return current;
}
function bind(payload) {
  return Object.freeze({ ...payload, manifestHash: nativeEvidenceManifestHash(payload) });
}

export function normalizeOwnerAttestedNativeProjectManifest(input, artifact, { stored = false } = {}) {
  const keys = [
    "formatVersion", "kind", "nativeProjectId", "artifactId", "artifactKey", "artifactVersion", "sha256", "size", "filename",
    "sourceCount", "operator", "observedAt", "browserEvidenceRef", "uploadMethod", "evidenceOrigin", "sourceListVisible", "screenshotOnly", "ownerAttestation",
    ...(stored ? ["manifestHash"] : []),
  ];
  exactKeys(input, keys, "owner-attested native Project manifest");
  if (Number(input.formatVersion) !== NATIVE_PROJECT_EVIDENCE_FORMAT_VERSION || input.kind !== NATIVE_PROJECT_OWNER_ATTESTED_STATUS
      || text(input.nativeProjectId, 120) !== LOCKED_NATIVE_CHATGPT_PROJECT_ID) {
    fail("bad_native_project_manifest", "The owner-attested manifest is not for the locked native Project evidence format.");
  }
  const filename = expectedNativeProjectFilename(artifact);
  const current = boundArtifactFields(input, artifact, filename);
  if (Number(input.sourceCount) !== 1 || text(input.uploadMethod, 80) !== "BROWSER_FILE_UPLOAD"
      || text(input.evidenceOrigin, 120) !== "OWNER_CONTROLLED_CHATGPT_PROJECT_BROWSER"
      || input.sourceListVisible !== true || input.screenshotOnly !== false) {
    fail("native_project_browser_proof_invalid", "Owner-attested fallback requires one visible file uploaded through the native Project browser file-upload control; screenshots, pasted text, and local observations are insufficient.");
  }
  const operator = text(input.operator, 160);
  if (!OPERATOR.test(operator) || operator !== OWNER_ATTESTATION_OPERATOR) {
    fail("owner_attestation_operator_required", "The fallback requires the exact named project owner as operator.");
  }
  if (text(input.ownerAttestation, 500) !== OWNER_ATTESTATION_ACKNOWLEDGEMENT) {
    fail("owner_attestation_acknowledgement_required", "The required owner browser-upload acknowledgement is missing.");
  }
  const payload = {
    formatVersion: NATIVE_PROJECT_EVIDENCE_FORMAT_VERSION,
    kind: NATIVE_PROJECT_OWNER_ATTESTED_STATUS,
    nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
    artifactId: current.id,
    artifactKey: current.key,
    artifactVersion: current.version,
    sha256: current.sha256,
    size: current.size,
    filename,
    sourceCount: 1,
    operator,
    observedAt: canonicalTimestamp(input.observedAt),
    browserEvidenceRef: browserReference(input.browserEvidenceRef),
    uploadMethod: "BROWSER_FILE_UPLOAD",
    evidenceOrigin: "OWNER_CONTROLLED_CHATGPT_PROJECT_BROWSER",
    sourceListVisible: true,
    screenshotOnly: false,
    ownerAttestation: OWNER_ATTESTATION_ACKNOWLEDGEMENT,
  };
  const bound = bind(payload);
  if (stored && text(input.manifestHash, 64).toLowerCase() !== bound.manifestHash) {
    fail("native_project_manifest_hash_mismatch", "The stored owner-attested manifest hash does not match its canonical payload.");
  }
  return bound;
}

export function normalizeNativeApiProjectManifest(input, artifact, { stored = false } = {}) {
  const keys = [
    "formatVersion", "kind", "nativeProjectId", "artifactId", "artifactKey", "artifactVersion", "sha256", "size", "filename",
    "sourceCount", "verifiedAt", "apiVersion", "verificationReceiptRef",
    ...(stored ? ["manifestHash"] : []),
  ];
  exactKeys(input, keys, "native API Project manifest");
  if (Number(input.formatVersion) !== NATIVE_PROJECT_EVIDENCE_FORMAT_VERSION || input.kind !== NATIVE_PROJECT_API_VERIFIED_STATUS
      || text(input.nativeProjectId, 120) !== LOCKED_NATIVE_CHATGPT_PROJECT_ID || Number(input.sourceCount) !== 1) {
    fail("bad_native_project_manifest", "The native API manifest is not for the locked Project or does not prove exactly one source.");
  }
  const filename = expectedNativeProjectFilename(artifact);
  const current = boundArtifactFields(input, artifact, filename);
  const apiVersion = text(input.apiVersion, 120);
  if (!apiVersion || !/^[A-Za-z0-9._-]{1,120}$/.test(apiVersion)) fail("bad_native_api_receipt", "A documented native API version is required.");
  const payload = {
    formatVersion: NATIVE_PROJECT_EVIDENCE_FORMAT_VERSION,
    kind: NATIVE_PROJECT_API_VERIFIED_STATUS,
    nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
    artifactId: current.id,
    artifactKey: current.key,
    artifactVersion: current.version,
    sha256: current.sha256,
    size: current.size,
    filename,
    sourceCount: 1,
    verifiedAt: canonicalTimestamp(input.verifiedAt, "verifiedAt"),
    apiVersion,
    verificationReceiptRef: apiReference(input.verificationReceiptRef),
  };
  const bound = bind(payload);
  if (stored && text(input.manifestHash, 64).toLowerCase() !== bound.manifestHash) {
    fail("native_project_manifest_hash_mismatch", "The stored native API manifest hash does not match its canonical payload.");
  }
  return bound;
}

export function normalizeNativeProjectInvalidationManifest(input, { stored = false } = {}) {
  const keys = [
    "formatVersion", "kind", "nativeProjectId", "evidenceId", "operator", "observedAt", "reason", "observedSourceCount", "browserEvidenceRef",
    ...(stored ? ["manifestHash"] : []),
  ];
  exactKeys(input, keys, "native Project invalidation manifest");
  const reason = text(input.reason, 80);
  const sourceCount = Number(input.observedSourceCount);
  if (Number(input.formatVersion) !== NATIVE_PROJECT_EVIDENCE_FORMAT_VERSION || input.kind !== "INVALIDATED"
      || text(input.nativeProjectId, 120) !== LOCKED_NATIVE_CHATGPT_PROJECT_ID || !INVALIDATION_REASONS.has(reason)
      || !Number.isSafeInteger(sourceCount) || sourceCount < 0) {
    fail("bad_native_project_invalidation", "The native Project invalidation manifest is invalid.");
  }
  if ((reason === "SOURCE_REMOVED" && sourceCount !== 0) || (reason === "SOURCE_AMBIGUOUS" && sourceCount < 2)) {
    fail("bad_native_project_invalidation", "The invalidation reason does not match the observed native Project source count.");
  }
  const evidenceId = text(input.evidenceId, 180);
  const operator = text(input.operator, 160);
  if (!evidenceId || !OPERATOR.test(operator) || operator !== OWNER_ATTESTATION_OPERATOR) {
    fail("owner_attestation_operator_required", "Only the named owner can invalidate native Project evidence.");
  }
  const payload = {
    formatVersion: NATIVE_PROJECT_EVIDENCE_FORMAT_VERSION,
    kind: "INVALIDATED",
    nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
    evidenceId,
    operator,
    observedAt: canonicalTimestamp(input.observedAt),
    reason,
    observedSourceCount: sourceCount,
    browserEvidenceRef: browserReference(input.browserEvidenceRef),
  };
  const bound = bind(payload);
  if (stored && text(input.manifestHash, 64).toLowerCase() !== bound.manifestHash) {
    fail("native_project_manifest_hash_mismatch", "The stored invalidation manifest hash does not match its canonical payload.");
  }
  return bound;
}

export function nativeProjectEvidenceCanComplete(copy) {
  if (!copy || copy.backend !== "chatgpt_project" || copy.algorithm !== "sha256" || !HEX64.test(String(copy.fingerprint || ""))) return false;
  return copy.status === NATIVE_PROJECT_API_VERIFIED_STATUS
    || (OWNER_ATTESTED_NATIVE_PROJECT_FALLBACK_APPROVED && copy.status === NATIVE_PROJECT_OWNER_ATTESTED_STATUS);
}
