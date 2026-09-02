/*
 * SD Tech Mobile Game Factory — trusted specification-start service.
 *
 * Starting a game is a small saga rather than one database transaction: the lifecycle commit is
 * durable first, then immutable specification objects are reconciled one at a time. Repeating the
 * same idempotency key replays that commit and repairs any missing objects without creating new
 * artifact versions. Storage-copy and human-approval truth always comes back from the store.
 */
import { createHash } from "node:crypto";
import { MANDATORY_ARTIFACT_BACKENDS, REQUIRED_GAME_ARTIFACTS } from "./gamefactory.mjs";
import { nativeProjectEvidenceCanComplete } from "./gamefactorynativeevidence.mjs";
import { PORTFOLIO_PACKAGE_DATE, renderGameArtifact } from "./gamefactorytemplates.mjs";

const result = (status, body) => ({ status, body });
const clean = (value, max = 1000) => String(value == null ? "" : value).trim().slice(0, max);
const safeError = (value) => clean(value, 1200)
  .replace(/\bBearer\s+[^\s,;]+/ig, "Bearer [redacted]")
  .replace(/([?&](?:access_?token|api_?key|key|password|secret|signature)=)[^&#\s]*/ig, "$1[redacted]")
  .replace(/\b(?:access_?token|api_?key|password|secret)\s*[:=]\s*[^\s,;]+/ig, "credential=[redacted]");

function renderedSpecification(slug) {
  return REQUIRED_GAME_ARTIFACTS.map((artifactKey) => {
    const content = renderGameArtifact(slug, artifactKey);
    const bytes = Buffer.from(content, "utf8");
    return {
      artifactKey,
      content,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

function verifiedCopy(artifact, backend) {
  const copy = (artifact?.copies || []).find((candidate) => candidate.backend === backend) || null;
  return {
    backend,
    status: copy?.status || "MISSING",
    verified: !!copy && copy.algorithm === "sha256" && copy.fingerprint === artifact?.sha256
      && (backend === "chatgpt_project" ? nativeProjectEvidenceCanComplete(copy) : copy.status === "VERIFIED"),
  };
}

export function createGameFactoryPlanner({ store, artifactMirror, log = () => {} } = {}) {
  if (!store || typeof store.getProject !== "function" || typeof store.executeCommand !== "function") {
    throw new Error("createGameFactoryPlanner needs a game factory store");
  }
  if (!artifactMirror || typeof artifactMirror.health !== "function" || typeof artifactMirror.ingestBuffer !== "function") {
    throw new Error("createGameFactoryPlanner needs the game factory artifact mirror");
  }

  async function startSpecification({
    uid, email = "", projectId, key, expectedVersion, actor = "owner", tenant = null,
  } = {}) {
    const who = clean(uid, 80).toLowerCase();
    const project = clean(projectId, 180);
    const commandKey = clean(key, 160);
    if (!who) return result(401, { error: "Sign in to start a game specification.", code: "no_identity" });
    if (!project) return result(400, { error: "projectId is required.", code: "project_required" });
    if (!commandKey) return result(400, { error: "An idempotency key is required.", code: "idempotency_required" });
    if (!Number.isInteger(Number(expectedVersion)) || Number(expectedVersion) < 1) {
      return result(428, { error: "expectedVersion is required.", code: "version_required" });
    }

    const before = store.getProject(who, project);
    if (!before) return result(404, { error: "No such game.", code: "not_found" });
    if (!["IDEA", "SPECIFICATION"].includes(before.state)) {
      return result(409, { error: `A specification start cannot run while this game is ${before.state}.`, code: "specification_start_not_available" });
    }

    let storageHealth;
    try { storageHealth = await artifactMirror.health(); }
    catch (error) {
      return result(503, { error: safeError(error?.message || error) || "Artifact storage preflight failed.", code: "artifact_preflight_failed" });
    }
    // Fail closed before the lifecycle command. A configuration label such as "configured" is
    // insufficient: this exact local immutable-write capability must be explicitly enabled.
    if (!storageHealth || storageHealth.localWritesEnabled !== true) {
      return result(503, {
        error: "Local immutable artifact writes must be enabled before a game can enter specification.",
        code: "artifact_writes_disabled",
        project: { id: before.id, state: before.state, version: before.version },
      });
    }
    // The project protocol requires an off-box Drive copy for every persistent artifact. Treating
    // mirroring as optional here would let the owner commit a lifecycle transition that can only
    // produce a single local copy. Require both write paths before committing START; an individual
    // upload can still fail afterward, but that remains a loud, idempotently repairable partial
    // operation rather than a falsely successful one-copy specification.
    if (storageHealth.driveWritesEnabled !== true) {
      return result(503, {
        error: "Google Drive artifact mirroring must be enabled before a game can enter specification.",
        code: "mirror_writes_disabled",
        project: { id: before.id, state: before.state, version: before.version },
      });
    }

    let manifest;
    try { manifest = renderedSpecification(before.slug); }
    catch (error) {
      return result(409, { error: safeError(error?.message || error) || "The portfolio specification is unavailable.", code: "specification_template_invalid" });
    }
    if (manifest.length !== REQUIRED_GAME_ARTIFACTS.length || new Set(manifest.map((item) => item.artifactKey)).size !== REQUIRED_GAME_ARTIFACTS.length) {
      return result(409, { error: "The deterministic specification manifest is incomplete.", code: "specification_manifest_incomplete" });
    }

    // Always issue the same store command, including during recovery. A matching key replays the
    // committed IDEA -> SPECIFICATION transition before version checking; a different key cannot
    // smuggle an advance from SPECIFICATION into the artifact-repair path.
    const started = store.executeCommand({
      uid: who,
      email: clean(email, 320),
      projectId: project,
      key: commandKey,
      expectedVersion: Number(expectedVersion),
      type: "advance",
      payload: { toState: "SPECIFICATION" },
      actor: clean(actor || email || who, 320) || who,
    });
    if (!started || started.status >= 300) return started || result(500, { error: "The specification transition was not committed.", code: "specification_transition_failed" });
    if (started.body?.project?.state !== "SPECIFICATION") {
      return result(409, { error: "The durable start command did not leave the game in SPECIFICATION.", code: "specification_state_mismatch" });
    }

    const driveEnabled = true;
    const operation = new Map();
    for (const item of manifest) {
      let ingest;
      try {
        ingest = await artifactMirror.ingestBuffer({
          uid: who,
          projectId: project,
          artifactKey: item.artifactKey,
          data: item.content,
          mimeType: "text/markdown",
          extension: "md",
          provenance: {
            generator: "gamefactorytemplates",
            packageDate: PORTFOLIO_PACKAGE_DATE,
            deterministic: true,
            gameSlug: before.slug,
            artifactKey: item.artifactKey,
            contentSha256: item.sha256,
          },
        });
      } catch (error) {
        ingest = result(500, { error: safeError(error?.message || error) || "Local artifact ingestion failed.", code: "artifact_ingest_failed" });
      }

      const record = { ingest, mirror: null };
      operation.set(item.artifactKey, record);
      const ingestMatches = ingest?.status < 300
        && ingest.body?.artifactId
        && ingest.body?.sha256 === item.sha256
        && Number(ingest.body?.size) === item.size;
      if (!ingestMatches) {
        if (ingest?.status < 300) record.ingest = result(409, { error: "The stored artifact fingerprint did not match its deterministic template.", code: "artifact_fingerprint_mismatch" });
        continue;
      }
      if (!driveEnabled) continue;
      if (typeof artifactMirror.mirrorArtifact !== "function") {
        record.mirror = result(503, { error: "Google Drive mirroring is enabled but no mirror operation is available.", code: "mirror_not_configured" });
        continue;
      }
      try {
        record.mirror = await artifactMirror.mirrorArtifact({ uid: who, projectId: project, artifactId: ingest.body.artifactId, tenant });
      } catch (error) {
        record.mirror = result(502, { error: safeError(error?.message || error) || "Google Drive mirroring failed.", code: "drive_mirror_failed" });
      }
    }

    const detail = store.getProject(who, project);
    if (!detail) return result(500, { error: "The game disappeared while its specification was being reconciled.", code: "project_lost" });
    const current = new Map((detail.artifacts || []).map((artifact) => [artifact.artifactKey, artifact]));
    const artifacts = manifest.map((expected) => {
      const artifact = current.get(expected.artifactKey) || null;
      const local = verifiedCopy(artifact, "primary");
      const requiredCopies = MANDATORY_ARTIFACT_BACKENDS.map((backend) => verifiedCopy(artifact, backend));
      const op = operation.get(expected.artifactKey) || {};
      const ingestStatus = Number(op.ingest?.status) || 500;
      const mirrorStatus = op.mirror
        ? { attempted: true, status: Number(op.mirror.status) || 500, code: clean(op.mirror.body?.code, 120), error: safeError(op.mirror.body?.error) }
        : { attempted: false, status: driveEnabled ? 503 : 0, code: driveEnabled ? "mirror_not_attempted" : "mirror_writes_disabled", error: "" };
      return {
        artifactKey: expected.artifactKey,
        expected: { sha256: expected.sha256, size: expected.size, mimeType: "text/markdown" },
        artifact: artifact ? { id: artifact.id, version: artifact.version, sha256: artifact.sha256, size: artifact.size, mimeType: artifact.mimeType } : null,
        deterministicMatch: !!artifact && artifact.sha256 === expected.sha256 && Number(artifact.size) === expected.size && artifact.mimeType === "text/markdown",
        ingest: { status: ingestStatus, reused: op.ingest?.body?.reused === true, code: clean(op.ingest?.body?.code, 120), error: safeError(op.ingest?.body?.error) },
        localPrimary: local,
        mirror: mirrorStatus,
        requiredCopies,
        mandatoryCopiesVerified: requiredCopies.filter((copy) => copy.verified).length,
        twoCopyReady: requiredCopies.length === 2 && requiredCopies.every((copy) => copy.verified),
      };
    });

    const localFailures = artifacts.filter((artifact) => !artifact.deterministicMatch || !artifact.localPrimary.verified);
    const mirrorFailures = artifacts.filter((artifact) => artifact.mirror.attempted && artifact.mirror.status >= 300);
    const mandatoryCopyFailures = artifacts.filter((artifact) => !artifact.twoCopyReady).map((artifact) => ({
      artifactKey: artifact.artifactKey,
      backends: artifact.requiredCopies.filter((copy) => !copy.verified).map((copy) => copy.backend),
    }));
    const stateMismatch = detail.state !== "SPECIFICATION";
    // A multi-status response is still considered successful by fetch(). Keep partial storage
    // failures outside 2xx so the owner UI cannot celebrate a start that still needs recovery. A
    // mirror adapter's 2xx is not storage truth: only the re-read store attestations above can prove
    // every mandatory backend. Missing native-project evidence is therefore a loud 503 even when
    // the local write and Drive operation themselves succeeded.
    const status = stateMismatch ? 409 : localFailures.length ? 500 : mirrorFailures.length ? 502
      : mandatoryCopyFailures.length ? 503 : 200;
    if (localFailures.length || mirrorFailures.length || mandatoryCopyFailures.length || stateMismatch) {
      try {
        log("game_factory_specification_start_partial", {
          projectId: project,
          localFailures: localFailures.map((item) => item.artifactKey),
          mirrorFailures: mirrorFailures.map((item) => item.artifactKey),
          mandatoryCopyFailures,
          state: detail.state,
        });
      } catch {}
    }
    return result(status, {
      ...(mandatoryCopyFailures.length ? { code: "mandatory_artifact_copies_incomplete" } : {}),
      ok: !stateMismatch && localFailures.length === 0 && mirrorFailures.length === 0 && mandatoryCopyFailures.length === 0,
      partial: localFailures.length > 0 || mirrorFailures.length > 0 || mandatoryCopyFailures.length > 0,
      transitioned: before.state === "IDEA" && started.body?.replayed !== true,
      commandReplayed: started.body?.replayed === true,
      project: { id: detail.id, name: detail.name, slug: detail.slug, state: detail.state, version: detail.version },
      specification: {
        localReady: localFailures.length === 0,
        requiredCopiesComplete: artifacts.every((artifact) => artifact.twoCopyReady),
        approvalSubjectReady: detail.approvalSubjects?.SPECIFICATION?.ready === true,
        specificationApprovalRecorded: detail.evidence?.specificationApproved === true,
        requiredHumanApproval: "SPECIFICATION",
      },
      storage: {
        localWritesEnabled: true,
        driveWritesEnabled: driveEnabled,
        nativeProjectConfigured: storageHealth.nativeProjectConfigured === true,
        requiredVerifiedBackends: [...MANDATORY_ARTIFACT_BACKENDS],
        complianceComplete: artifacts.every((artifact) => artifact.twoCopyReady),
      },
      failures: {
        local: localFailures.map((item) => item.artifactKey),
        mirror: mirrorFailures.map((item) => item.artifactKey),
        mandatoryCopies: mandatoryCopyFailures,
      },
      artifacts,
    });
  }

  return { startSpecification };
}
