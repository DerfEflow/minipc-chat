/*
 * Restart-aware control-plane orchestrator for SD Tech Mobile Game Factory.
 *
 * SQLite task leases remain authoritative. This module adds a durable dispatch journal around the
 * external Hands effect, uses a deterministic run id per task attempt, polls the explicit node,
 * and converts remote terminal truth into store completion/failure. It never infers success from a
 * timeout. A short leadership lease prevents duplicate dispatch loops in one shared-volume app.
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { brokerProject } from "./hands/gamefactory-broker-projects.mjs";

const TERMINAL_REMOTE = new Set(["SUCCEEDED", "PAUSED", "CANCELLED", "FAILED", "INTERRUPTED"]);
const ACTIVE_REMOTE = new Set(["STARTING", "RUNNING", "CANCEL_REQUESTED"]);
const SECURITY_CANCEL_REQUESTED = "SECURITY_CANCEL_REQUESTED";
const SECURITY_INTERRUPTED = "SECURITY_INTERRUPTED";
const isSecurityStatus = (value) => value === SECURITY_CANCEL_REQUESTED || value === SECURITY_INTERRUPTED;
const PAYLOAD_GENERATION_ID = /^[a-f0-9]{64}$/;
const AUTHORITY_ABSENCE_PROOF_PROTOCOL = "game-factory-controller-authorization-absence-proof/1";
// The live GX10 broker has one reviewed Web/Godot lane. Mobile SDKs, licenses, signing, and
// release/publisher writes are intentionally outside this capability set.
const DEFAULT_CAPABILITIES = Object.freeze(["quality_assurance", "godot"]);
const clean = (value, max = 500) => String(value == null ? "" : value).trim().slice(0, max);
const SECRET_NAME = /(authorization|cookie|credential|password|passwd|private.?key|recovery.?code|secret|signature|token|keystore|api.?key|database.?url|connection.?string|access.?key|client.?secret|webhook.?secret|(^|[_-])pat($|[_-]))/i;
function redact(value, max = 20_000) {
  return String(value == null ? "" : value).slice(0, max)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi, "[redacted-private-key]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted-jwt]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, "[redacted-token]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted-access-key]")
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g, "[redacted-token]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, "[redacted-token]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, "[redacted-token]")
    .replace(/\b((?:proxy-)?authorization\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/("(?:authorization|cookie|credential|password|passwd|private.?key|secret|signature|token|keystore|api.?key|database.?url|connection.?string|access.?key|client.?secret|webhook.?secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/('(?:authorization|cookie|credential|password|passwd|private.?key|secret|signature|token|keystore|api.?key|database.?url|connection.?string|access.?key|client.?secret|webhook.?secret)'\s*:\s*)'(?:\\.|[^'\\])*'/gi, "$1'[redacted]'")
    .replace(/\b((?:database|redis|postgres|mysql|mongo(?:db)?|amqp)_?url|connection_?string|aws_access_key_id|aws_secret_access_key|gh_pat|client_?secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_?token|api_?key|key|password|secret|signature)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/\b(access_?token|api_?key|password|passwd|private_?key|secret|signature)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}
function safeValue(value, depth = 0, key = "") {
  if (SECRET_NAME.test(key)) return "[redacted]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redact(value);
  if (depth >= 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeValue(item, depth + 1));
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary:${value.byteLength}]`;
  if (typeof value !== "object") return redact(value);
  return Object.fromEntries(Object.entries(value).slice(0, 200).map(([name, item]) => [clean(name, 120), safeValue(item, depth + 1, name)]));
}
const safeText = (value, max = 1000) => redact(value, max).trim();
const json = (value) => JSON.stringify(safeValue(value == null ? null : value));
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
const stableHash = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_SCHEMA_CHECKSUM = createHash("sha256").update("dispatches:v1|dispatch_events:v1|orchestrator_leader:v1").digest("hex");

function asDispatch(row) {
  if (!row) return null;
  return {
    runId: row.runId, taskId: row.taskId, attempt: row.attempt, uid: row.uid,
    projectId: row.projectId, buildId: row.buildId || "", workerId: row.workerId,
    capability: row.capability, status: row.status, remoteStatus: row.remoteStatus || "",
    requestHash: row.requestHash,
    task: parse(row.taskJson, {}), request: parse(row.requestJson, {}),
    lastResponse: parse(row.lastResponse, null), error: row.error || "",
    createdAt: row.createdAt, updatedAt: row.updatedAt, lastSeenAt: row.lastSeenAt,
    endedAt: row.endedAt,
  };
}

export function createGameFactoryDispatchJournal({ dir, now = () => Date.now() } = {}) {
  if (!dir) throw new Error("createGameFactoryDispatchJournal needs a dir");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
  const file = join(dir, "gamefactory-dispatch.db");
  const db = new DatabaseSync(file);
  try { chmodSync(file, 0o600); } catch {}
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  const existingSchemaVersion = Number(db.prepare("PRAGMA user_version").get().user_version) || 0;
  if (existingSchemaVersion > JOURNAL_SCHEMA_VERSION) {
    db.close();
    throw new Error(`Game Factory dispatch journal schema ${existingSchemaVersion} is newer than supported schema ${JOURNAL_SCHEMA_VERSION}.`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_schema (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      version INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      appliedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dispatches (
      runId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      uid TEXT NOT NULL,
      projectId TEXT NOT NULL,
      buildId TEXT NOT NULL DEFAULT '',
      workerId TEXT NOT NULL,
      capability TEXT NOT NULL,
      requestHash TEXT NOT NULL,
      taskJson TEXT NOT NULL,
      requestJson TEXT NOT NULL,
      status TEXT NOT NULL,
      remoteStatus TEXT NOT NULL DEFAULT '',
      lastResponse TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      lastSeenAt INTEGER NOT NULL DEFAULT 0,
      endedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS gf_dispatch_active ON dispatches(endedAt, updatedAt);
    CREATE INDEX IF NOT EXISTS gf_dispatch_task ON dispatches(taskId, attempt DESC);
    CREATE TABLE IF NOT EXISTS dispatch_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gf_dispatch_events_run ON dispatch_events(runId, id);
    CREATE TABLE IF NOT EXISTS orchestrator_leader (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      instanceId TEXT NOT NULL,
      leaseUntil INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
  const at = () => Number(now()) || Date.now();
  const schemaRow = db.prepare("SELECT version,checksum FROM dispatch_schema WHERE singleton=1").get();
  if ((schemaRow && (Number(schemaRow.version) !== JOURNAL_SCHEMA_VERSION || schemaRow.checksum !== JOURNAL_SCHEMA_CHECKSUM)) ||
      (existingSchemaVersion === JOURNAL_SCHEMA_VERSION && !schemaRow)) {
    db.close();
    throw new Error("Game Factory dispatch journal schema metadata does not match this build.");
  }
  if (!schemaRow) {
    db.prepare("INSERT INTO dispatch_schema (singleton,version,checksum,appliedAt) VALUES (1,?,?,?)")
      .run(JOURNAL_SCHEMA_VERSION, JOURNAL_SCHEMA_CHECKSUM, at());
  }
  if (existingSchemaVersion < JOURNAL_SCHEMA_VERSION) db.exec(`PRAGMA user_version=${JOURNAL_SCHEMA_VERSION}`);

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }

  function event(runId, type, payload = {}) {
    db.prepare("INSERT INTO dispatch_events (runId,type,payload,createdAt) VALUES (?,?,?,?)")
      .run(clean(runId, 500), clean(type, 100), json(payload), at());
  }

  function payloadTuple(value) {
    if (!value || typeof value !== "object"
        || !Number.isSafeInteger(value.stepIndex) || value.stepIndex < 0
        || !Number.isSafeInteger(value.totalSteps) || value.totalSteps < 1
        || value.stepIndex >= value.totalSteps
        || typeof value.generationId !== "string" || !PAYLOAD_GENERATION_ID.test(value.generationId)) return null;
    const previousGenerationId = value.previousGenerationId;
    if (value.stepIndex === 0 ? previousGenerationId !== null
      : typeof previousGenerationId !== "string" || !PAYLOAD_GENERATION_ID.test(previousGenerationId)) return null;
    return {
      stepIndex: value.stepIndex, totalSteps: value.totalSteps,
      generationId: value.generationId, previousGenerationId,
    };
  }

  const samePayloadTuple = (left, right) => !!left && !!right
    && left.stepIndex === right.stepIndex && left.totalSteps === right.totalSteps
    && left.generationId === right.generationId
    && left.previousGenerationId === right.previousGenerationId;

  function readPayloadGenerationState(runId) {
    const entries = [];
    for (const row of db.prepare(`SELECT payload FROM dispatch_events
      WHERE runId=? AND type='dispatch.payload_generation_bound' ORDER BY id`).all(runId)) {
      const entry = payloadTuple(parse(row.payload, null));
      const prior = entries.at(-1) || null;
      if (!entry || entry.stepIndex !== entries.length
          || (prior && (entry.totalSteps !== prior.totalSteps || entry.previousGenerationId !== prior.generationId))
          || entries.some((candidate) => candidate.generationId === entry.generationId)) {
        return { ok: false, entries, latest: null, error: "the durable payload generation chain is invalid" };
      }
      entries.push(entry);
    }
    return { ok: true, entries, latest: entries.at(-1) || null, error: "" };
  }

  function expectedPayloadTotal(request) {
    const planTotal = Array.isArray(request?.plan?.steps) ? request.plan.steps.length : 0;
    const resume = request?.resumeFrom;
    if (!planTotal) return 0;
    if (resume == null) return planTotal;
    const completedSteps = Number(resume?.completedSteps);
    return resume && typeof resume === "object"
      && resume.protocol === "game-factory-broker-resume/1"
      && Number.isSafeInteger(completedSteps) && completedSteps > 0 && completedSteps < planTotal
      && Number(resume.totalSteps) === planTotal && resume.safeBoundary === true && resume.complete === false
      ? planTotal - completedSteps : 0;
  }

  function bindPayloadGeneration(runId, evidence, source = "status") {
    const id = clean(runId, 500);
    const origin = clean(source, 20).toLowerCase();
    if (!id || !["start", "status"].includes(origin) || evidence?.ok !== true || evidence.runId !== id) {
      return { ok: false, error: "payload generation evidence has invalid origin or run identity" };
    }
    const scalar = payloadTuple({
      stepIndex: evidence.payloadStepIndex,
      totalSteps: evidence.payloadTotalSteps,
      generationId: evidence.payloadGenerationId,
      previousGenerationId: evidence.payloadPreviousGenerationId,
    });
    const rawPrefix = origin === "status" ? evidence.payloadGenerations
      : Array.isArray(evidence.payloadGenerations) ? evidence.payloadGenerations : [scalar];
    if (!scalar || !Array.isArray(rawPrefix) || !rawPrefix.length || rawPrefix.length > 1000) {
      return { ok: false, error: "payload generation evidence is missing a canonical ordered prefix" };
    }
    const prefix = rawPrefix.map(payloadTuple);
    if (prefix.some((entry) => !entry) || !samePayloadTuple(prefix.at(-1), scalar)
        || (origin === "start" && prefix.length !== 1)) {
      return { ok: false, error: "payload generation scalars do not match the canonical ordered prefix" };
    }
    for (let index = 0; index < prefix.length; index++) {
      const entry = prefix[index], prior = prefix[index - 1] || null;
      if (entry.stepIndex !== index || entry.totalSteps !== prefix[0].totalSteps
          || (index === 0 ? entry.previousGenerationId !== null : entry.previousGenerationId !== prior.generationId)
          || prefix.slice(0, index).some((candidate) => candidate.generationId === entry.generationId)) {
        return { ok: false, error: "payload generation prefix is not contiguous and immutable" };
      }
    }
    return tx(() => {
      const dispatch = db.prepare("SELECT requestJson FROM dispatches WHERE runId=?").get(id);
      if (!dispatch) return { ok: false, error: "payload generation evidence has no durable dispatch" };
      if (db.prepare("SELECT 1 AS yes FROM dispatch_events WHERE runId=? AND type='dispatch.authorization_absent_bound' LIMIT 1")
        .get(id)) return { ok: false, error: "payload generation evidence conflicts with durable no-authorization proof" };
      const request = parse(dispatch.requestJson, {});
      const expectedTotal = expectedPayloadTotal(request);
      if (!expectedTotal || prefix[0].totalSteps !== expectedTotal || prefix.length > expectedTotal) {
        return { ok: false, error: "payload generation total does not match the immutable dispatch plan" };
      }
      const state = readPayloadGenerationState(id);
      if (!state.ok) return state;
      if (prefix.length < state.entries.length) {
        return { ok: false, error: "payload generation evidence regressed behind durable controller evidence" };
      }
      // Once this controller has durably observed a generation, a later response may only replay
      // that prefix or append the immediately following step. Accepting a multi-step jump would let
      // a compromised relay backfill generations that the controller never observed. The sole
      // exception is the first STATUS bind above: it may recover the full prefix after a lost START
      // acknowledgement because there is no prior controller generation to skip.
      if (state.entries.length > 0 && prefix.length > state.entries.length + 1) {
        return { ok: false, error: "payload generation evidence skipped a controller-observed step boundary" };
      }
      for (let index = 0; index < state.entries.length; index++) {
        if (!samePayloadTuple(prefix[index], state.entries[index])) {
          return { ok: false, error: "payload generation evidence conflicts with the durable controller chain" };
        }
      }
      for (const entry of prefix.slice(state.entries.length)) {
        event(id, "dispatch.payload_generation_bound", { ...entry, source: origin });
      }
      const latest = prefix.at(-1);
      return { ok: true, replayed: prefix.length === state.entries.length, latest };
    });
  }

  function payloadGeneration(runId) {
    const id = clean(runId, 500);
    const state = readPayloadGenerationState(id);
    if (!state.ok || !state.latest) return null;
    const dispatch = db.prepare("SELECT requestJson FROM dispatches WHERE runId=?").get(id);
    const request = parse(dispatch?.requestJson, {});
    const expectedTotal = expectedPayloadTotal(request);
    return expectedTotal === state.latest.totalSteps && state.entries.length <= expectedTotal ? state.latest : null;
  }

  function authorityAbsenceProofBody(value) {
    return {
      protocol: value?.protocol, runId: value?.runId,
      orchestratorRequestHash: value?.orchestratorRequestHash,
      controllerRequestHash: value?.controllerRequestHash,
      absenceReceiptSha256: value?.absenceReceiptSha256,
      controllerRecoveryEpoch: value?.controllerRecoveryEpoch,
      brokerInstanceId: value?.brokerInstanceId,
      containerGenerationId: value?.containerGenerationId,
      brokerBootIdSha256: value?.brokerBootIdSha256,
      recordedControllerRecoveryEpoch: value?.recordedControllerRecoveryEpoch,
      recordedBrokerInstanceId: value?.recordedBrokerInstanceId,
      recordedContainerGenerationId: value?.recordedContainerGenerationId,
      recordedBrokerBootIdSha256: value?.recordedBrokerBootIdSha256,
      generations: value?.generations,
    };
  }

  function bindAuthorizationAbsence(runId, evidence, workerProof) {
    const id = clean(runId, 500);
    const proof = evidence?.dispatchAuthorityAbsenceProof;
    const body = authorityAbsenceProofBody(proof);
    if (!id || evidence?.ok !== true || evidence.runId !== id
        || clean(evidence.status, 80).toUpperCase() !== "INTERRUPTED"
        || evidence.cancellationResolved !== true || evidence.dispatchAuthorityAbsent !== true
        || evidence.payloadGenerationId != null || evidence.payloadDeathProof != null
        || !proof || typeof proof !== "object" || Array.isArray(proof)
        || JSON.stringify(Object.keys(proof)) !== JSON.stringify([...Object.keys(body), "proofSha256"])
        || body.protocol !== AUTHORITY_ABSENCE_PROOF_PROTOCOL || body.runId !== id
        || !PAYLOAD_GENERATION_ID.test(body.orchestratorRequestHash || "")
        || !PAYLOAD_GENERATION_ID.test(body.controllerRequestHash || "")
        || !PAYLOAD_GENERATION_ID.test(body.absenceReceiptSha256 || "")
        || !PAYLOAD_GENERATION_ID.test(body.controllerRecoveryEpoch || "")
        || !PAYLOAD_GENERATION_ID.test(body.brokerInstanceId || "")
        || !PAYLOAD_GENERATION_ID.test(body.containerGenerationId || "")
        || !PAYLOAD_GENERATION_ID.test(body.brokerBootIdSha256 || "")
        || !PAYLOAD_GENERATION_ID.test(body.recordedControllerRecoveryEpoch || "")
        || !PAYLOAD_GENERATION_ID.test(body.recordedBrokerInstanceId || "")
        || !PAYLOAD_GENERATION_ID.test(body.recordedContainerGenerationId || "")
        || !PAYLOAD_GENERATION_ID.test(body.recordedBrokerBootIdSha256 || "")
        || proof.proofSha256 !== createHash("sha256").update(JSON.stringify(body)).digest("hex")
        || workerProof?.ok !== true || workerProof.secureForUntrustedCode !== true
        || body.controllerRecoveryEpoch !== workerProof.controllerRecoveryEpoch
        || body.brokerInstanceId !== workerProof.brokerInstanceId
        || body.containerGenerationId !== workerProof.containerGenerationId
        || body.brokerBootIdSha256 !== workerProof.brokerBootIdSha256) {
      return { ok: false, error: "controller no-authorization proof is invalid or is not bound to the current worker recovery epoch" };
    }
    if (!Array.isArray(body.generations) || !body.generations.length || body.generations.length > 24) {
      return { ok: false, error: "controller no-authorization proof has no bounded planned generation chain" };
    }
    const generations = []; const ids = new Set();
    for (let index = 0; index < body.generations.length; index++) {
      const item = body.generations[index], prior = body.generations[index - 1] || null;
      const keys = ["stepIndex", "totalSteps", "generationId", "previousGenerationId", "packetSha256"];
      if (!item || typeof item !== "object" || Array.isArray(item)
          || JSON.stringify(Object.keys(item)) !== JSON.stringify(keys)
          || item.stepIndex !== index || item.totalSteps !== body.generations.length
          || !PAYLOAD_GENERATION_ID.test(item.generationId || "")
          || !PAYLOAD_GENERATION_ID.test(item.packetSha256 || "")
          || (index === 0 ? item.previousGenerationId !== null : item.previousGenerationId !== prior.generationId)
          || ids.has(item.generationId)) {
        return { ok: false, error: "controller no-authorization planned generation chain is invalid" };
      }
      ids.add(item.generationId); generations.push(item);
    }
    return tx(() => {
      const dispatch = db.prepare("SELECT requestHash,requestJson FROM dispatches WHERE runId=?").get(id);
      if (!dispatch || dispatch.requestHash !== body.orchestratorRequestHash) {
        return { ok: false, error: "controller no-authorization proof does not match the immutable dispatch request" };
      }
      if (expectedPayloadTotal(parse(dispatch.requestJson, {})) !== generations.length) {
        return { ok: false, error: "controller no-authorization generation total does not match the immutable dispatch plan" };
      }
      const generationState = readPayloadGenerationState(id);
      if (!generationState.ok || generationState.entries.length) {
        return { ok: false, error: "controller no-authorization proof conflicts with a bound payload generation" };
      }
      const prior = db.prepare(`SELECT payload FROM dispatch_events
        WHERE runId=? AND type='dispatch.authorization_absent_bound' ORDER BY id LIMIT 1`).get(id);
      if (prior) {
        const priorProof = parse(prior.payload, null)?.proof;
        return priorProof?.proofSha256 === proof.proofSha256
          ? { ok: true, replayed: true, proof: priorProof }
          : { ok: false, error: "controller no-authorization proof conflicts with durable prior proof" };
      }
      event(id, "dispatch.authorization_absent_bound", { proof });
      return { ok: true, replayed: false, proof };
    });
  }

  function recordIntent({ task, request, workerId }) {
    if (!task || !request || request.taskId !== task.id || request.projectId !== task.projectId
        || clean(request.buildId, 240) !== clean(task.buildId, 240)
        || clean(request.capability, 100) !== clean(task.capability, 100)
        || Number(request.attempt) !== Number(task.attempt)) {
      throw new Error("dispatch request identity does not match the claimed task attempt");
    }
    const hash = stableHash(request);
    const durableRequest = safeValue(request);
    if (JSON.stringify(durableRequest) !== JSON.stringify(request)) {
      throw new Error("dispatch request contains credential material or exceeds durable journal bounds");
    }
    const durableTask = safeValue(task);
    if (JSON.stringify(durableTask) !== JSON.stringify(task)) {
      throw new Error("claimed task contains credential material or exceeds durable journal bounds");
    }
    return tx(() => {
      const prior = db.prepare("SELECT * FROM dispatches WHERE runId=?").get(request.runId);
      if (prior) {
        if (prior.requestHash !== hash) throw new Error("dispatch runId conflicts with an existing immutable request");
        return asDispatch(prior);
      }
      const stamp = at();
      db.prepare(`INSERT INTO dispatches
        (runId,taskId,attempt,uid,projectId,buildId,workerId,capability,requestHash,taskJson,requestJson,status,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        request.runId, task.id, Number(task.attempt) || 1, task.uid, task.projectId,
        task.buildId || "", workerId, task.capability, hash, json(durableTask), json(durableRequest),
        "CLAIMED", stamp, stamp,
      );
      event(request.runId, "dispatch.claimed", { taskId: task.id, attempt: task.attempt, workerId });
      return asDispatch(db.prepare("SELECT * FROM dispatches WHERE runId=?").get(request.runId));
    });
  }

  function update(runId, patch = {}, type = "dispatch.updated") {
    return tx(() => {
      const row = db.prepare("SELECT * FROM dispatches WHERE runId=?").get(runId);
      if (!row) return null;
      // Terminal journal truth is first-writer-wins. A leadership lease can expire while a slow
      // remote call is in flight; a successor may then reconcile the same idempotent run. Never
      // let that stale second observer overwrite the already committed terminal outcome.
      if (row.endedAt || isSecurityStatus(row.status)) return asDispatch(row);
      const next = {
        status: clean(patch.status ?? row.status, 80),
        remoteStatus: clean(patch.remoteStatus ?? row.remoteStatus, 80),
        lastResponse: patch.lastResponse === undefined ? row.lastResponse : json(patch.lastResponse),
        error: safeText(patch.error ?? row.error, 2000),
        lastSeenAt: patch.lastSeenAt === undefined ? row.lastSeenAt : Number(patch.lastSeenAt) || 0,
        endedAt: patch.endedAt === undefined ? row.endedAt : Number(patch.endedAt) || 0,
      };
      const stamp = at();
      db.prepare(`UPDATE dispatches SET status=?,remoteStatus=?,lastResponse=?,error=?,lastSeenAt=?,endedAt=?,updatedAt=? WHERE runId=?`)
        .run(next.status, next.remoteStatus, next.lastResponse, next.error, next.lastSeenAt, next.endedAt, stamp, runId);
      event(runId, type, patch);
      return asDispatch(db.prepare("SELECT * FROM dispatches WHERE runId=?").get(runId));
    });
  }

  function finish(runId, status, response = null, error = "") {
    return update(runId, {
      status, remoteStatus: clean(response && response.status, 80), lastResponse: response,
      error, lastSeenAt: response && response.ok !== false ? at() : undefined, endedAt: at(),
    }, "dispatch.finished");
  }

  const pendingSecurity = () => !!db.prepare("SELECT 1 AS yes FROM dispatches WHERE endedAt=0 AND status=? LIMIT 1")
    .get(SECURITY_CANCEL_REQUESTED);
  const securityEpochValue = () => Number(db.prepare(`SELECT COALESCE(MAX(id),0) AS epoch FROM dispatch_events
    WHERE type IN ('dispatch.security_latched','worker.security_proof_lost')`).get().epoch) || 0;

  function writeSecurityLatch(row, response = null, error = "worker isolation proof was lost") {
    if (!row) return null;
    if (row.status === SECURITY_INTERRUPTED) return asDispatch(row);
    const stamp = at();
    db.prepare(`UPDATE dispatches SET status=?,remoteStatus=?,lastResponse=?,error=?,endedAt=0,updatedAt=?
      WHERE runId=?`).run(
      SECURITY_CANCEL_REQUESTED,
      clean(response?.cancellation?.status
        ?? (response?.status && typeof response.status === "object" ? response.status.status : response?.status)
        ?? row.remoteStatus, 80),
      response === null ? row.lastResponse : json(response),
      safeText(error || row.error, 2000), stamp, row.runId,
    );
    event(row.runId, "dispatch.security_latched", { status: SECURITY_CANCEL_REQUESTED, response, error });
    return asDispatch(db.prepare("SELECT * FROM dispatches WHERE runId=?").get(row.runId));
  }

  /*
   * A failed force probe is global worker-lane evidence, not merely an attribute of whichever
   * dispatches happen to be visible in the next SELECT. Persist it before taking that snapshot so a
   * stale leader cannot claim, start, complete, or normally finish in the probe/snapshot gap.
   */
  function observeProofLoss(response = null, error = "worker isolation proof was lost") {
    return tx(() => {
      event("", "worker.security_proof_lost", { response, error: safeText(error, 2000) });
      // Do not leave a crash window between the global observation and the active-dispatch
      // snapshot. A successor may obtain a fresh secure probe, but that later proof cannot make a
      // payload safe retroactively if it was active while isolation was unproved. SQLite gives us a
      // stable write-transaction snapshot here: every dispatch already durable at observation time
      // is latched in the same commit, while a stale leader that inserts afterward is fenced by the
      // changed epoch before it can start or normally finish.
      const active = db.prepare("SELECT * FROM dispatches WHERE endedAt=0 ORDER BY createdAt").all();
      for (const row of active) {
        if (!isSecurityStatus(row.status)) {
          writeSecurityLatch(row, { probe: response },
            safeText(error, 2000) || "worker isolation proof was lost");
        }
      }
      return securityEpochValue();
    });
  }

  /*
   * This is the normal terminal commit fence. Checking the epoch and ending the journal row in one
   * SQLite write transaction closes the final check/finish race. On mismatch it reopens even stale
   * normal terminal truth under the absorbing security latch; the caller then repairs the separate
   * task-store transaction with securityStopTask().
   */
  function finishIfSecurityEpoch(runId, expectedSecurityEpoch, status, response = null, error = "") {
    return tx(() => {
      const row = db.prepare("SELECT * FROM dispatches WHERE runId=?").get(clean(runId, 500));
      if (!row) return { ok: false, dispatch: null, error: "dispatch not found" };
      const expected = Number(expectedSecurityEpoch);
      const epoch = securityEpochValue();
      if (!Number.isSafeInteger(expected) || expected < 0 || epoch !== expected || pendingSecurity()) {
        const dispatch = writeSecurityLatch(row, { terminal: response, observedSecurityEpoch: epoch, expectedSecurityEpoch: expected },
          "The worker security epoch changed before the normal terminal result became durable.");
        return { ok: false, securityChanged: true, epoch, dispatch };
      }
      if (isSecurityStatus(row.status)) return { ok: false, securityChanged: true, epoch, dispatch: asDispatch(row) };
      if (row.endedAt) return { ok: true, replayed: true, epoch, dispatch: asDispatch(row) };
      const stamp = at();
      db.prepare(`UPDATE dispatches SET status=?,remoteStatus=?,lastResponse=?,error=?,lastSeenAt=?,endedAt=?,updatedAt=?
        WHERE runId=?`).run(
        clean(status, 80), clean(response && response.status, 80), json(response), safeText(error, 2000),
        response && response.ok !== false ? stamp : row.lastSeenAt, stamp, stamp, row.runId,
      );
      event(row.runId, "dispatch.finished", { status, response, error, expectedSecurityEpoch: expected });
      return { ok: true, epoch, dispatch: asDispatch(db.prepare("SELECT * FROM dispatches WHERE runId=?").get(row.runId)) };
    });
  }

  /*
   * Proof loss is an absorbing, security-wins latch. It may reopen a normal terminal row when a
   * stale leader committed success concurrently with the observer that detected proof loss. Normal
   * update()/finish() can never overwrite this state; only securityFinish() can close it.
   */
  function securityLatch(runId, response = null, error = "worker isolation proof was lost") {
    return tx(() => {
      const row = db.prepare("SELECT * FROM dispatches WHERE runId=?").get(runId);
      return writeSecurityLatch(row, response, error);
    });
  }

  function securityFinish(runId, response = null, error = "worker isolation proof was lost") {
    return tx(() => {
      const row = db.prepare("SELECT * FROM dispatches WHERE runId=?").get(runId);
      if (!row) return null;
      if (row.status === SECURITY_INTERRUPTED && row.endedAt) return asDispatch(row);
      if (row.status !== SECURITY_CANCEL_REQUESTED) return asDispatch(row);
      const stamp = at();
      db.prepare(`UPDATE dispatches SET status=?,remoteStatus=?,lastResponse=?,error=?,lastSeenAt=?,endedAt=?,updatedAt=?
        WHERE runId=?`).run(
        SECURITY_INTERRUPTED, clean(response?.cancellation?.status
          ?? (response?.status && typeof response.status === "object" ? response.status.status : response?.status), 80),
        json(response), safeText(error, 2000),
        response?.ok !== false ? stamp : row.lastSeenAt, stamp, stamp, runId,
      );
      event(runId, "dispatch.security_finished", { status: SECURITY_INTERRUPTED, response, error });
      return asDispatch(db.prepare("SELECT * FROM dispatches WHERE runId=?").get(runId));
    });
  }

  function listActive(limit = 100) {
    return db.prepare("SELECT * FROM dispatches WHERE endedAt=0 ORDER BY createdAt LIMIT ?")
      .all(Math.min(Math.max(Number(limit) || 100, 1), 1000)).map(asDispatch);
  }

  function recordRetentionAck(runId, response) {
    return tx(() => {
      const row = db.prepare("SELECT * FROM dispatches WHERE runId=?").get(clean(runId, 500));
      if (!row || !row.endedAt || response?.ok !== true || response.runId !== row.runId
          || response.retentionAcknowledged !== true || response.retentionPruned !== true) return false;
      const absenceBound = !!db.prepare("SELECT 1 AS yes FROM dispatch_events WHERE runId=? AND type='dispatch.authorization_absent_bound' LIMIT 1")
        .get(row.runId);
      if (absenceBound && (response.dispatchAuthorityAbsent !== true || response.generationsPruned !== 0)) return false;
      if (!db.prepare("SELECT 1 AS yes FROM dispatch_events WHERE runId=? AND type='dispatch.retention_pruned' LIMIT 1")
        .get(row.runId)) event(row.runId, "dispatch.retention_pruned", response);
      return true;
    });
  }

  function listRetentionPending(limit = 100) {
    return db.prepare(`SELECT d.* FROM dispatches d
      WHERE d.endedAt>0
        AND EXISTS (SELECT 1 FROM dispatch_events g
          WHERE g.runId=d.runId AND g.type IN ('dispatch.payload_generation_bound','dispatch.authorization_absent_bound'))
        AND NOT EXISTS (SELECT 1 FROM dispatch_events a
          WHERE a.runId=d.runId AND a.type='dispatch.retention_pruned')
      ORDER BY d.endedAt LIMIT ?`)
      .all(Math.min(Math.max(Number(limit) || 100, 1), 1000)).map(asDispatch);
  }

  function get(runId) {
    return asDispatch(db.prepare("SELECT * FROM dispatches WHERE runId=?").get(clean(runId, 500)));
  }

  function hasPendingSecurity() {
    return pendingSecurity();
  }

  function securityEpoch() {
    return securityEpochValue();
  }

  function latestForTask(taskId) {
    return asDispatch(db.prepare("SELECT * FROM dispatches WHERE taskId=? ORDER BY attempt DESC, createdAt DESC LIMIT 1").get(taskId));
  }

  function acquireLeadership(instanceId, leaseMs = 30_000) {
    const id = clean(instanceId, 160), stamp = at(), until = stamp + Math.max(Number(leaseMs) || 30_000, 5_000);
    return tx(() => {
      const row = db.prepare("SELECT * FROM orchestrator_leader WHERE singleton=1").get();
      if (row && row.instanceId !== id && row.leaseUntil > stamp) return false;
      db.prepare(`INSERT INTO orchestrator_leader (singleton,instanceId,leaseUntil,updatedAt) VALUES (1,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET instanceId=excluded.instanceId,leaseUntil=excluded.leaseUntil,updatedAt=excluded.updatedAt`)
        .run(id, until, stamp);
      return true;
    });
  }

  function releaseLeadership(instanceId) {
    db.prepare("UPDATE orchestrator_leader SET leaseUntil=0,updatedAt=? WHERE singleton=1 AND instanceId=?")
      .run(at(), clean(instanceId, 160));
  }

  function health() {
    const integrity = db.prepare("PRAGMA quick_check").get();
    const active = Number(db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE endedAt=0").get().n) || 0;
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM dispatches").get().n) || 0;
    const leader = db.prepare("SELECT * FROM orchestrator_leader WHERE singleton=1").get() || null;
    return {
      ok: String(integrity.quick_check || "").toLowerCase() === "ok", active, total, leader,
      schema: { version: JOURNAL_SCHEMA_VERSION, checksum: JOURNAL_SCHEMA_CHECKSUM },
    };
  }

  return {
    file, recordIntent, update, finish, finishIfSecurityEpoch, securityLatch, securityFinish,
    observeProofLoss, get, hasPendingSecurity, securityEpoch,
    bindPayloadGeneration, payloadGeneration, bindAuthorizationAbsence,
    listActive, listRetentionPending, recordRetentionAck, latestForTask,
    acquireLeadership, releaseLeadership, health,
    close() { try { db.close(); } catch {} },
  };
}

function responseBody(result) {
  return result && typeof result === "object" && result.body && typeof result.body === "object" ? result.body : {};
}

function defaultRequest(task, project, resumeFrom = null) {
  const payload = task.payload && typeof task.payload === "object" ? task.payload : {};
  const plan = payload.workerPlan || payload.plan;
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
    throw new Error("worker task has no executable plan.steps recipe");
  }
  const syntheticCanary = /^gft_canary_[a-f0-9]{32}$/.test(String(task?.id || ""))
    && task.capability === "quality_assurance";
  const selected = brokerProject(syntheticCanary ? "system-canary" : project?.slug);
  if (!selected) throw new Error("worker project is not one of the reviewed fixed GX10 broker subtrees");
  const rawWorkspaceRoot = String(payload.workspaceRoot || plan.workspaceRoot || project?.workspaceRoot || "").trim();
  if (rawWorkspaceRoot && rawWorkspaceRoot !== selected.workspaceRoot) {
    throw new Error("worker workspace root does not match the reviewed project subtree");
  }
  if (syntheticCanary && rawWorkspaceRoot !== "/workspace/system-canary") {
    throw new Error("synthetic canary must use only /workspace/system-canary");
  }
  return {
    runId: `${task.id}:attempt:${Math.max(Number(task.attempt) || 1, 1)}`,
    taskId: task.id, projectId: task.projectId, buildId: task.buildId || "",
    capability: task.capability, attempt: Math.max(Number(task.attempt) || 1, 1),
    workspaceRoot: selected.workspaceRoot, projectRelative: selected.slug, projectQuotaId: selected.quotaId,
    plan, resumeFrom,
  };
}

export function createGameFactoryOrchestrator({
  store, worker, journalDir, journal = null,
  workerId = "", capabilities = DEFAULT_CAPABILITIES, maxConcurrent = 1,
  leaseMs = 120_000, pollMs = 10_000, leaderLeaseMs = 30_000,
  remoteGraceMs = 5 * 60_000, now = () => Date.now(),
  taskToRequest = defaultRequest, log = () => {},
} = {}) {
  if (!store) throw new Error("createGameFactoryOrchestrator needs a store");
  if (!worker) throw new Error("createGameFactoryOrchestrator needs a worker adapter");
  const durable = journal || createGameFactoryDispatchJournal({ dir: journalDir, now });
  const instanceId = "gfo_" + randomUUID();
  const expectedWorkerNode = typeof worker.node === "string" ? worker.node : "";
  const stableWorkerId = safeText(workerId || `game-factory:${expectedWorkerNode || "unconfigured"}`, 160);
  const workerCaps = [...new Set((Array.isArray(capabilities) ? capabilities : DEFAULT_CAPABILITIES).map((v) => clean(v, 100)).filter(Boolean))];
  const requestedConcurrency = Number(maxConcurrent);
  if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency !== 1) {
    throw new Error("the static GX10 broker topology requires exact maxConcurrent=1");
  }
  const concurrency = 1;
  let timer = null, ticking = null, closed = false;
  let lastTickAt = 0, lastSuccessAt = 0, lastError = "", leader = false, lastProbe = null, lastProbeAt = 0;

  function secureProbeMatchesExpectedWorker(result) {
    return expectedWorkerNode !== ""
      && result?.ok === true
      && result.secureForUntrustedCode === true
      && result.node === expectedWorkerNode
      && result.externalBroker === true
      && result.separateBrokerCgroup === true
      && PAYLOAD_GENERATION_ID.test(result.controllerRecoveryEpoch || "")
      && PAYLOAD_GENERATION_ID.test(result.brokerInstanceId || "")
      && PAYLOAD_GENERATION_ID.test(result.containerGenerationId || "")
      && PAYLOAD_GENERATION_ID.test(result.brokerBootIdSha256 || "")
      && result.maxConcurrent === 1
      && Array.isArray(result.programs) && result.programs.length === 2
      && result.programs[0] === "node" && result.programs[1] === "godot"
      && Array.isArray(result.capabilities) && result.capabilities.length === 2
      && result.capabilities[0] === "quality_assurance" && result.capabilities[1] === "godot";
  }

  function hasPayloadDeathProof(response, runId) {
    if (!response || response.ok !== true || response.runId !== runId
        || response.cancellationResolved !== true
        || !TERMINAL_REMOTE.has(clean(response.status, 80).toUpperCase())) return false;
    const bound = durable.payloadGeneration(runId);
    const generationId = String(response.payloadGenerationId || "");
    const proof = response.payloadDeathProof;
    if (!bound || !PAYLOAD_GENERATION_ID.test(generationId)
        || response.payloadStepIndex !== bound.stepIndex
        || response.payloadTotalSteps !== bound.totalSteps
        || response.payloadPreviousGenerationId !== bound.previousGenerationId
        || generationId !== bound.generationId
        || !proof || typeof proof !== "object"
        || proof.protocol !== "game-factory-payload-death/1"
        || proof.stepIndex !== bound.stepIndex
        || proof.totalSteps !== bound.totalSteps
        || proof.generationId !== generationId
        || proof.previousGenerationId !== bound.previousGenerationId
        || !Number.isFinite(Date.parse(String(proof.observedAt || "")))) return false;
    if (proof.state === "reaped") {
      return Number.isSafeInteger(proof.pid) && proof.pid > 0
        && typeof proof.starttime === "string" && /^[1-9][0-9]*$/.test(proof.starttime)
        && proof.decisionId === null;
    }
    if (proof.state === "never_started") {
      return proof.pid === null && proof.starttime === null
        && typeof proof.decisionId === "string" && /^[a-f0-9]{64}$/.test(proof.decisionId);
    }
    return false;
  }

  const currentDispatch = (runId) => durable.get(runId);
  const securityLatched = (runId) => isSecurityStatus(currentDispatch(runId)?.status);

  async function interruptForMissingDeathProof(dispatch, evidence, reason, workerProof = null) {
    const current = durable.securityLatch(dispatch.runId, evidence,
      safeText(reason, 1000) || "The worker did not prove that the bound payload generation is dead.")
      || currentDispatch(dispatch.runId) || dispatch;
    await interruptForProofLoss(current, workerProof);
    return false;
  }

  async function acknowledgeRetention(dispatch) {
    if (!dispatch || !dispatch.endedAt || typeof worker.acknowledge !== "function") return false;
    let response;
    try { response = await worker.acknowledge(dispatch.runId); }
    catch (error) {
      response = { ok: false, runId: dispatch.runId,
        error: safeText(error?.message || error, 1000) || "worker retention acknowledgement failed" };
    }
    if (response?.ok === true && response.runId === dispatch.runId
        && response.retentionAcknowledged === true && response.retentionPruned === true) {
      return durable.recordRetentionAck(dispatch.runId, response) === true;
    }
    return false;
  }

  async function finishNormally(dispatch, status, response, error, expectedSecurityEpoch) {
    if (!hasPayloadDeathProof(response, dispatch.runId)) {
      return interruptForMissingDeathProof(dispatch, response,
        `The worker attempted to close ${clean(status, 80) || "a dispatch"} without a valid latest-generation payload death proof.`);
    }
    const finished = durable.finishIfSecurityEpoch(
      dispatch.runId, expectedSecurityEpoch, status, response, error,
    );
    if (finished?.ok === true) {
      await acknowledgeRetention(finished.dispatch);
      return true;
    }
    if (finished?.dispatch) await interruptForProofLoss(finished.dispatch);
    return false;
  }

  async function heartbeat(dispatch, expectedSecurityEpoch) {
    const result = store.heartbeatTask({
      uid: dispatch.uid, taskId: dispatch.taskId, workerId: stableWorkerId, attempt: dispatch.attempt, leaseMs,
    });
    if (!result || result.status !== 200) {
      await interruptForMissingDeathProof(dispatch, result,
        safeText(responseBody(result).error, 1000)
          || "The task lease was lost before the worker proved that its payload was dead.");
      return { ok: false, stopRequested: false };
    }
    return { ok: true, stopRequested: responseBody(result).stopRequested === true };
  }

  async function proofLossFence(dispatch, expectedSecurityEpoch) {
    let current = currentDispatch(dispatch.runId) || dispatch;
    const epochChanged = Number.isSafeInteger(Number(expectedSecurityEpoch))
      && durable.securityEpoch() !== Number(expectedSecurityEpoch);
    if (!isSecurityStatus(current.status) && !durable.hasPendingSecurity() && !epochChanged) return false;
    if (!isSecurityStatus(current.status)) {
      current = durable.securityLatch(current.runId, null,
        epochChanged
          ? "The worker security epoch changed while this dispatch was in flight."
          : "Another task on this worker lost isolation proof; this dispatch is fenced from completion.") || current;
    }
    await interruptForProofLoss(current);
    return true;
  }

  async function terminal(dispatch, remote, expectedSecurityEpoch) {
    if (await proofLossFence(dispatch, expectedSecurityEpoch)) return;
    if (!hasPayloadDeathProof(remote, dispatch.runId)) {
      await interruptForMissingDeathProof(dispatch, remote,
        `The worker reported terminal state ${clean(remote?.status, 80) || "UNKNOWN"} without a valid latest-generation payload death proof.`);
      return;
    }
    if (remote.status === "FAILED" || remote.status === "INTERRUPTED") {
      if (await proofLossFence(dispatch, expectedSecurityEpoch)) return;
      const failed = store.failTask({
        uid: dispatch.uid, taskId: dispatch.taskId, workerId: stableWorkerId,
        attempt: dispatch.attempt,
        error: safeText(remote.error || `worker ended ${remote.status.toLowerCase()}`, 2000),
        retryable: dispatch.task.safeToRetry === true,
      });
      if (await proofLossFence(dispatch, expectedSecurityEpoch)) return;
      await finishNormally(dispatch, remote.status, remote,
        safeText(responseBody(failed).error, 1000), expectedSecurityEpoch);
      return;
    }

    if (await proofLossFence(dispatch, expectedSecurityEpoch)) return;
    const beat = await heartbeat(dispatch, expectedSecurityEpoch);
    if (!beat.ok) return;
    if (await proofLossFence(dispatch, expectedSecurityEpoch)) return;
    if ((remote.status === "PAUSED" || remote.status === "CANCELLED") && !beat.stopRequested) {
      const failed = store.failTask({
        uid: dispatch.uid, taskId: dispatch.taskId, workerId: stableWorkerId,
        attempt: dispatch.attempt,
        error: `worker reported an unexpected ${remote.status.toLowerCase()} state without an owner pause or stop request`,
        retryable: false,
      });
      if (await proofLossFence(dispatch, expectedSecurityEpoch)) return;
      await finishNormally(dispatch, "REMOTE_PROTOCOL_ERROR", remote,
        safeText(responseBody(failed).error, 1000), expectedSecurityEpoch);
      return;
    }
    if (await proofLossFence(dispatch, expectedSecurityEpoch)) return;
    const collected = await worker.collect(dispatch.runId);
    if (await proofLossFence(dispatch, expectedSecurityEpoch)) return;
    if (!collected || collected.ok === false) {
      durable.update(dispatch.runId, {
        status: "COLLECTING", remoteStatus: remote.status, lastResponse: remote,
        error: safeText(collected && (collected.error || collected.reason), 1000) || "worker result collection is temporarily unavailable",
        lastSeenAt: Number(now()) || Date.now(),
      }, "dispatch.collect_retry");
      return;
    }
    const collectedStatus = clean(collected.status, 80).toUpperCase();
    if (collectedStatus !== remote.status) {
      const failed = store.failTask({
        uid: dispatch.uid, taskId: dispatch.taskId, workerId: stableWorkerId,
        attempt: dispatch.attempt,
        error: `worker collection status ${collectedStatus || "UNKNOWN"} contradicted terminal status ${remote.status}`,
        retryable: false,
      });
      if (await proofLossFence(dispatch, expectedSecurityEpoch)) return;
      await finishNormally(dispatch, "REMOTE_PROTOCOL_ERROR", collected,
        safeText(responseBody(failed).error, 1000), expectedSecurityEpoch);
      return;
    }
    if (!hasPayloadDeathProof(collected, dispatch.runId)) {
      await interruptForMissingDeathProof(dispatch, collected,
        "The worker collection response did not retain the valid latest-generation payload death proof.");
      return;
    }
    if (await proofLossFence(dispatch, expectedSecurityEpoch)) return;
    const completed = store.completeTask({
      uid: dispatch.uid, taskId: dispatch.taskId, workerId: stableWorkerId,
      attempt: dispatch.attempt,
      result: {
        runId: dispatch.runId, node: worker.node, status: collected.status,
        result: collected.result || null, artifacts: collected.artifacts || [],
        stdout: safeText(collected.stdout, 64_000), stderr: safeText(collected.stderr, 16_000),
      },
      checkpoint: collected.checkpoint || remote.checkpoint || null,
    });
    if (await proofLossFence(dispatch, expectedSecurityEpoch)) return;
    if (!completed || completed.status !== 200) {
      await finishNormally(dispatch, "LEASE_LOST", collected,
        safeText(responseBody(completed).error, 1000) || "could not commit worker result", expectedSecurityEpoch);
      return;
    }
    await finishNormally(dispatch, remote.status, collected, "", expectedSecurityEpoch);
  }

  async function interruptForProofLoss(dispatch, workerProof = null) {
    const proofLoss = "The worker lost its current isolation proof while this task was active.";
    const detail = safeText(dispatch?.error, 1000);
    const reason = detail && detail !== proofLoss ? `${proofLoss} ${detail}` : proofLoss;
    let current = currentDispatch(dispatch.runId) || dispatch;
    if (current.status === SECURITY_INTERRUPTED) return;
    if (current.status !== SECURITY_CANCEL_REQUESTED) {
      current = durable.securityLatch(dispatch.runId, null, reason) || current;
    }

    // Repair the store on every pass. This is intentionally idempotent: a crash can happen after
    // the journal latch commits but before the separate store transaction, and a stale completion
    // may have won while this process was down.
    const stopAttempt = (attempt, error) => {
      try {
        return store.securityStopTask({
          uid: current.uid, taskId: current.taskId, attempt, error,
        });
      } catch (exception) {
        return { status: 503, body: {
          error: safeText(exception?.message || exception, 1000) || "security stop persistence failed",
        } };
      }
    };

    let taskFailure = stopAttempt(current.attempt, reason);
    let storeStopped = taskFailure?.status === 200 && responseBody(taskFailure).securityStopped === true;
    let storeBoundary = {
      dispatchAttempt: current.attempt,
      stoppedAttempt: storeStopped ? current.attempt : 0,
      overlap: false,
    };

    // A lease can expire and the same task row can be claimed as a newer attempt while the old
    // external payload/journal entry still exists. Preserve exact-attempt writes: discover the
    // current row, latch its own durable dispatch intent when present, and issue a second explicit
    // stop for that exact newer attempt. The obsolete latch may close only after this re-read proves
    // that the current attempt is still the one just security-stopped.
    if (!storeStopped && taskFailure?.status === 409 && responseBody(taskFailure).code === "attempt_lost") {
      const project = store.getProject(current.uid, current.projectId, { eventLimit: 1 });
      const task = project?.tasks?.find((candidate) => candidate.id === current.taskId);
      if (task && Number.isSafeInteger(task.attempt) && task.attempt > current.attempt) {
        const newerDispatch = durable.latestForTask(current.taskId);
        let newerJournalSafe = !newerDispatch || newerDispatch.attempt < task.attempt;
        if (newerDispatch && newerDispatch.attempt === task.attempt
            && newerDispatch.status !== SECURITY_INTERRUPTED) {
          const newerLatch = durable.securityLatch(newerDispatch.runId, null,
            "A prior attempt lost isolation proof while this newer attempt was active.");
          newerJournalSafe = isSecurityStatus(newerLatch?.status);
        } else if (newerDispatch?.attempt === task.attempt) {
          newerJournalSafe = newerDispatch.status === SECURITY_INTERRUPTED;
        }
        const newerReason = `A prior dispatch lost isolation proof while task attempt ${task.attempt} was current.`;
        const newerFailure = stopAttempt(task.attempt, newerReason);
        const rereadProject = store.getProject(current.uid, current.projectId, { eventLimit: 1 });
        const rereadTask = rereadProject?.tasks?.find((candidate) => candidate.id === current.taskId);
        const newerStopped = newerFailure?.status === 200
          && responseBody(newerFailure).securityStopped === true
          && rereadTask?.attempt === task.attempt
          && rereadTask.status === "FAILED"
          && rereadTask.result?.securityStopped === true
          && newerJournalSafe;
        storeStopped = newerStopped;
        storeBoundary = {
          dispatchAttempt: current.attempt,
          currentAttempt: Number(rereadTask?.attempt) || 0,
          stoppedAttempt: newerStopped ? task.attempt : 0,
          overlap: true,
          newerDispatchRunId: newerDispatch?.attempt === task.attempt ? newerDispatch.runId : "",
        };
        if (!newerStopped) taskFailure = newerFailure;
      }
    }
    const taskFailureError = storeStopped ? ""
      : safeText(responseBody(taskFailure).error, 1000) || "the task security stop is not yet durable";

    let remote;
    try { remote = await worker.status(current.runId); }
    catch (error) {
      remote = { ok: false, runId: current.runId, error: safeText(error?.message || error, 1000) || "worker status failed" };
    }
    const remoteAbsenceBinding = remote?.dispatchAuthorityAbsent === true
      ? durable.bindAuthorizationAbsence(current.runId, remote, workerProof)
      : null;
    const remoteBinding = remoteAbsenceBinding
      ? { ok: remoteAbsenceBinding.ok, skipped: true, error: remoteAbsenceBinding.error }
      : remote?.ok === true
        ? durable.bindPayloadGeneration(current.runId, remote, "status")
        : { ok: true, skipped: true };
    if (storeStopped && remoteAbsenceBinding?.ok === true) {
      const finished = durable.securityFinish(current.runId,
        { status: remote, cancellation: null, storeBoundary }, reason);
      if (finished?.endedAt) await acknowledgeRetention(finished);
      return;
    }
    if (storeStopped && remoteBinding.ok && hasPayloadDeathProof(remote, current.runId)) {
      durable.securityFinish(current.runId, { status: remote, cancellation: null, storeBoundary }, reason);
      return;
    }

    let cancelled;
    try {
      cancelled = await worker.cancel(current.runId, {
        mode: "immediate", reason: "security stop: current worker isolation proof was lost",
      });
    } catch (error) {
      cancelled = { ok: false, runId: current.runId, error: safeText(error?.message || error, 1000) || "security cancellation failed" };
    }
    const cancelledAbsenceBinding = cancelled?.dispatchAuthorityAbsent === true
      ? durable.bindAuthorizationAbsence(current.runId, cancelled, workerProof)
      : null;
    if (storeStopped && cancelledAbsenceBinding?.ok === true) {
      const evidence = { status: remote || null, cancellation: cancelled, storeBoundary };
      const finished = durable.securityFinish(current.runId, evidence, reason);
      if (finished?.endedAt) await acknowledgeRetention(finished);
      return;
    }
    let authorityAbsent = null; let authorityAbsentBinding = null;
    const plainStatusAbsent = remote?.ok === false && remote.commandAbsent === true
      && remote.runId === current.runId && remote.cancellationResolved === false;
    const plainCancelAbsent = cancelled?.ok === false && cancelled.commandAbsent === true
      && cancelled.runId === current.runId && cancelled.cancellationResolved === false;
    if (plainStatusAbsent && plainCancelAbsent && typeof worker.authorizationAbsent === "function"
        && secureProbeMatchesExpectedWorker(workerProof) && durable.payloadGeneration(current.runId) === null) {
      try { authorityAbsent = await worker.authorizationAbsent(current.request); }
      catch (error) {
        authorityAbsent = { ok: false, runId: current.runId,
          error: safeText(error?.message || error, 1000) || "controller no-authorization proof failed" };
      }
      authorityAbsentBinding = durable.bindAuthorizationAbsence(current.runId, authorityAbsent, workerProof);
      if (storeStopped && authorityAbsentBinding.ok) {
        const evidence = { status: remote, cancellation: cancelled, authorityAbsent, storeBoundary };
        const finished = durable.securityFinish(current.runId, evidence, reason);
        if (finished?.endedAt) await acknowledgeRetention(finished);
        return;
      }
    }
    const evidence = { status: remote || null, cancellation: cancelled || null,
      authorityAbsent, storeBoundary };
    if (storeStopped && remoteBinding.ok && hasPayloadDeathProof(cancelled, current.runId)) {
      durable.securityFinish(current.runId, evidence, reason);
      return;
    }

    // Plain notFound/commandAbsent is deliberately unresolved: only a generation-bound broker
    // death proof can establish that no payload remains. Retain the absorbing latch and retry the
    // deterministic immediate cancellation on the next tick.
    const evidenceError = [remoteBinding.ok ? "" : safeText(remoteBinding.error, 1000),
      cancelledAbsenceBinding && !cancelledAbsenceBinding.ok ? safeText(cancelledAbsenceBinding.error, 1000) : "",
      authorityAbsentBinding && !authorityAbsentBinding.ok ? safeText(authorityAbsentBinding.error, 1000) : "",
    ].filter(Boolean).join(" ");
    durable.securityLatch(current.runId, evidence,
      [reason, taskFailureError, evidenceError].filter(Boolean).join(" "));
  }

  async function reconcileOne(dispatch, workerSecure, workerProof = null, expectedSecurityEpoch = null) {
    let current = currentDispatch(dispatch.runId) || dispatch;
    if (!workerSecure || current.status === SECURITY_CANCEL_REQUESTED || durable.hasPendingSecurity()) {
      if (current.status !== SECURITY_CANCEL_REQUESTED) {
        current = durable.securityLatch(current.runId, { probe: workerProof },
          workerSecure
            ? "Another task on this worker lost isolation proof; this active dispatch is also stopped."
            : "The worker lost its current isolation proof while this task was active.") || current;
      }
      await interruptForProofLoss(current, workerProof);
      return;
    }
    if (current.status === SECURITY_INTERRUPTED) return;

    let remote = await worker.status(current.runId);
    let generationSource = "status";
    current = currentDispatch(current.runId) || current;
    let generationBinding = remote?.ok === true
      ? durable.bindPayloadGeneration(current.runId, remote, generationSource)
      : { ok: true, skipped: true };
    if (!generationBinding.ok) {
      current = durable.securityLatch(current.runId, remote,
        `The worker returned invalid payload generation evidence: ${safeText(generationBinding.error, 1000)}`) || current;
      await interruptForProofLoss(current, workerProof);
      return;
    }
    if (await proofLossFence(current, expectedSecurityEpoch)) return;
    if (remote && remote.notFound && current.lastSeenAt === 0) {
      remote = await worker.start(current.request);
      generationSource = "start";
      current = currentDispatch(current.runId) || current;
      generationBinding = remote?.ok === true
        ? durable.bindPayloadGeneration(current.runId, remote, generationSource)
        : { ok: true, skipped: true };
      if (!generationBinding.ok) {
        current = durable.securityLatch(current.runId, remote,
          `The worker returned invalid payload generation evidence: ${safeText(generationBinding.error, 1000)}`) || current;
        await interruptForProofLoss(current, workerProof);
        return;
      }
      if (isSecurityStatus(current.status) || durable.hasPendingSecurity()
          || durable.securityEpoch() !== Number(expectedSecurityEpoch)) {
        if (!isSecurityStatus(current.status)) current = durable.securityLatch(current.runId, remote,
          "Another task on this worker lost isolation proof while this dispatch was starting.") || current;
        return interruptForProofLoss(current, workerProof);
      }
    }
    const stamp = Number(now()) || Date.now();
    if (!remote || remote.ok === false) {
      const since = current.lastSeenAt || current.createdAt;
      if (stamp - since <= remoteGraceMs) {
        if (await proofLossFence(current, expectedSecurityEpoch)) return;
        await heartbeat(current, expectedSecurityEpoch);
        if (await proofLossFence(current, expectedSecurityEpoch)) return;
        current = durable.update(current.runId, {
          status: "REMOTE_UNAVAILABLE", lastResponse: remote,
          error: safeText(remote && (remote.error || remote.reason), 1000) || "worker node is temporarily unavailable",
        }, "dispatch.remote_unavailable");
        if (await proofLossFence(current || dispatch, expectedSecurityEpoch)) return;
      } else {
        await interruptForMissingDeathProof(current, remote,
          "The explicit worker node remained unavailable beyond the recovery window without proving that the bound payload was dead.");
      }
      return;
    }

    const remoteStatus = clean(remote.status, 80).toUpperCase();
    if (!TERMINAL_REMOTE.has(remoteStatus) && !ACTIVE_REMOTE.has(remoteStatus)) {
      await interruptForMissingDeathProof(current, remote,
        `The worker reported unknown protocol state ${remoteStatus || "EMPTY"} without proving that the bound payload was dead.`);
      return;
    }
    const observed = durable.update(current.runId, {
      status: TERMINAL_REMOTE.has(remoteStatus) ? "COLLECTING" : remoteStatus || "RUNNING",
      remoteStatus, lastResponse: remote, lastSeenAt: stamp, error: "",
    }, "dispatch.remote_status");
    if (isSecurityStatus(observed?.status)) return interruptForProofLoss(observed, workerProof);
    if (TERMINAL_REMOTE.has(remoteStatus)) {
      return terminal(observed || current, { ...remote, status: remoteStatus }, expectedSecurityEpoch);
    }

    if (await proofLossFence(current, expectedSecurityEpoch)) return;
    const beat = await heartbeat(current, expectedSecurityEpoch);
    if (!beat.ok) return;
    if (await proofLossFence(current, expectedSecurityEpoch)) return;
    if (beat.stopRequested) {
      const project = store.getProject(current.uid, current.projectId, { eventLimit: 1 });
      const immediate = project && project.operation === "STOP_REQUESTED";
      const cancelled = await worker.cancel(current.runId, {
        mode: immediate ? "immediate" : "safe",
        reason: immediate ? "owner requested stop" : "owner requested pause at the next safe boundary",
      });
      current = durable.update(current.runId, {
        status: "CANCEL_REQUESTED", remoteStatus: clean(cancelled && cancelled.status, 80),
        lastResponse: cancelled, error: cancelled && cancelled.ok === false ? safeText(cancelled.error || cancelled.reason, 1000) : "",
        lastSeenAt: cancelled && cancelled.ok !== false ? stamp : current.lastSeenAt,
      }, "dispatch.cancel_requested");
      if (await proofLossFence(current || dispatch, expectedSecurityEpoch)) return;
    }
  }

  async function probe(force = false) {
    const stamp = Number(now()) || Date.now();
    if (!force && lastProbe && stamp - lastProbeAt < 60_000) return lastProbe;
    lastProbe = await worker.probe();
    lastProbeAt = stamp;
    return lastProbe;
  }

  async function claimOne(capability, expectedSecurityEpoch, workerProof = null) {
    const incidentChanged = () => durable.hasPendingSecurity()
      || durable.securityEpoch() !== expectedSecurityEpoch;
    if (incidentChanged()) return false;
    const task = store.claimNextTask({ workerId: stableWorkerId, capability, leaseMs });
    if (!task) return false;
    if (incidentChanged()) {
      store.securityStopTask({
        uid: task.uid, taskId: task.id, attempt: task.attempt,
        error: "The worker lane entered a security stop while this task was being claimed.",
      });
      return true;
    }
    let request;
    try {
      const project = store.getProject(task.uid, task.projectId, { eventLimit: 1 });
      const prior = durable.latestForTask(task.id);
      const checkpoint = prior?.lastResponse?.checkpoint || null;
      request = taskToRequest(task, project, checkpoint);
      durable.recordIntent({ task, request, workerId: stableWorkerId });
    } catch (error) {
      store.failTask({
        uid: task.uid, taskId: task.id, workerId: stableWorkerId,
        attempt: task.attempt,
        error: safeText(error && error.message, 2000) || "invalid worker task recipe", retryable: false,
      });
      log(`[game-factory] task ${task.id} was refused before dispatch: ${safeText(error && error.message, 1000)}`);
      return true;
    }
    if (incidentChanged()) {
      const latched = durable.securityLatch(request.runId, null,
        "The worker lane entered a security stop before this dispatch left the orchestrator.");
      store.securityStopTask({
        uid: task.uid, taskId: task.id, attempt: task.attempt,
        error: "The worker lane entered a security stop before this dispatch left the orchestrator.",
      });
      // worker.start has not been called, so this process can authoritatively close its own local
      // intent without pretending to possess a broker death proof.
      durable.securityFinish(request.runId, {
        ok: true, runId: request.runId, status: "INTERRUPTED", cancellationResolved: true,
        orchestratorNeverDispatched: true, latched: !!latched,
      }, "The dispatch was security-stopped before worker.start was called.");
      return true;
    }
    const started = await worker.start(request);
    const generationBinding = started?.ok === true
      ? durable.bindPayloadGeneration(request.runId, started, "start")
      : { ok: true, skipped: true };
    let current = currentDispatch(request.runId);
    if (!generationBinding.ok) {
      current = durable.securityLatch(request.runId, started,
        `The worker returned invalid payload generation evidence: ${safeText(generationBinding.error, 1000)}`) || current;
      await interruptForProofLoss(current || durable.get(request.runId), workerProof);
      return true;
    }
    if (isSecurityStatus(current?.status) || incidentChanged()) {
      if (!isSecurityStatus(current?.status)) current = durable.securityLatch(request.runId, started,
        "The worker lane entered a security stop while worker.start was in flight.") || current;
      await interruptForProofLoss(current || durable.get(request.runId), workerProof);
      return true;
    }
    if (!started || started.ok === false) {
      // A transport timeout is an ambiguous external effect: the detached runner may already have
      // accepted the deterministic runId. Keep the lease and reconcile by status/idempotent start;
      // requeueing here could execute a non-idempotent build twice.
      if (started && started.retryable === true) {
        current = durable.update(request.runId, {
          status: "START_UNCERTAIN", remoteStatus: "", lastResponse: started,
          error: safeText(started.error || started.reason, 1000) || "worker start acknowledgement was not received",
        }, "dispatch.start_uncertain");
        if (incidentChanged()) {
          current = durable.securityLatch(request.runId, started,
            "The worker lane entered a security stop while an uncertain start was being journaled.") || current;
          await interruptForProofLoss(current || durable.get(request.runId), workerProof);
        }
        return true;
      }
      await interruptForMissingDeathProof(current || durable.get(request.runId), started,
        safeText(started && (started.error || started.reason), 1000)
          || "The worker did not accept the task and did not prove that no payload was started.", workerProof);
      return true;
    }
    current = durable.update(request.runId, {
      status: clean(started.status, 80).toUpperCase() || "STARTING",
      remoteStatus: clean(started.status, 80).toUpperCase(), lastResponse: started,
      lastSeenAt: Number(now()) || Date.now(), error: "",
    }, "dispatch.started");
    if (incidentChanged()) {
      current = durable.securityLatch(request.runId, started,
        "The worker lane entered a security stop while the accepted start was being journaled.") || current;
      await interruptForProofLoss(current || durable.get(request.runId), workerProof);
    }
    return true;
  }

  async function runTick() {
    if (closed) return { ok: false, closed: true };
    const stamp = Number(now()) || Date.now();
    leader = durable.acquireLeadership(instanceId, leaderLeaseMs);
    lastTickAt = stamp;
    if (!leader) return { ok: true, leader: false, active: durable.listActive().length };
    const report = { ok: true, leader: true, retentionPruned: 0, reconciled: 0, claimed: 0, storeRecovery: null };
    try {
      // Terminal spool evidence is pruned only after both durable terminal commits. A lost reply is
      // harmless: unfinished two-phase acknowledgements remain queryable here and are retried on
      // every leader tick, before any new admission can add more spool entries.
      for (const dispatch of durable.listRetentionPending(100)) {
        if (await acknowledgeRetention(dispatch)) report.retentionPruned++;
      }
      // Execution admission is fail-closed on a probe from this tick. The cached probe is useful
      // for status surfaces, but it must never authorize a new claim or recreate a missing remote
      // intent after the worker has gone offline or lost its isolation attestation.
      const securityEpochBeforeProbe = durable.securityEpoch();
      let workerReady;
      try {
        workerReady = await probe(true);
      } catch (error) {
        workerReady = {
          ok: false, node: expectedWorkerNode, configured: worker.enabled === true,
          secureForUntrustedCode: false,
          error: safeText(error?.message || error, 1000) || "worker isolation probe failed",
        };
        lastProbe = workerReady;
        lastProbeAt = Number(now()) || Date.now();
      }
      const securityEpochAfterProbe = durable.securityEpoch();
      const workerSecure = secureProbeMatchesExpectedWorker(workerReady);
      // Persist the global observation before listing active rows. A stale leader may be between
      // its own final fence and a claim/start/complete write, so the dispatch snapshot alone is not
      // a sufficient fence. Awaiting also gives deterministic tests a point after the durable epoch
      // commit but before the snapshot; the production journal method itself is synchronous.
      const reconciliationSecurityEpoch = workerSecure
        ? securityEpochAfterProbe
        : await durable.observeProofLoss(workerReady,
          safeText(workerReady?.error || workerReady?.reason, 1000) || "the force probe did not prove current worker isolation");
      const activeDispatches = durable.listActive(1000);
      const securityIncident = !workerSecure || durable.hasPendingSecurity();
      if (securityIncident) {
        // Fence the complete active snapshot before the first asynchronous cancellation. Otherwise
        // a restart could resolve one old latch after probe recovery and accidentally allow another
        // payload that was active during the same incident to continue or commit output.
        for (const dispatch of activeDispatches) {
          if (!isSecurityStatus(currentDispatch(dispatch.runId)?.status)) {
            durable.securityLatch(dispatch.runId, { probe: workerReady },
              workerSecure
                ? "Another task on this worker lost isolation proof; this active dispatch is also stopped."
                : "The worker lost its current isolation proof while this task was active.");
          }
        }
      }
      for (const dispatch of activeDispatches) {
        await reconcileOne(dispatch, workerSecure, workerReady, reconciliationSecurityEpoch);
        report.reconciled++;
      }
      report.storeRecovery = store.reconcile({ limit: 100 });
      const retentionBlocksAdmission = durable.listRetentionPending(1000)
        .some((dispatch) => clean(dispatch.status, 80).toUpperCase() !== "PAUSED");
      // A proof-loss incident that began pending, or appeared and resolved while this probe was in
      // flight, invalidates the probe for admission. A stale leader cannot authorize a claim with
      // evidence that predates a newer durable security epoch.
      if (!securityIncident && workerSecure && !durable.hasPendingSecurity() && !retentionBlocksAdmission
          && securityEpochBeforeProbe === securityEpochAfterProbe
          && durable.securityEpoch() === reconciliationSecurityEpoch) {
        let active = durable.listActive().length;
        for (const capability of workerCaps) {
          if (active >= concurrency || durable.hasPendingSecurity()) break;
          if (await claimOne(capability, reconciliationSecurityEpoch, workerReady)) {
            report.claimed++;
            active = durable.listActive().length;
          }
        }
      }
      lastSuccessAt = stamp;
      lastError = "";
      return report;
    } catch (error) {
      lastError = safeText(error && error.message, 2000) || "orchestrator tick failed";
      log(`[game-factory] orchestrator tick failed: ${lastError}`);
      return { ...report, ok: false, error: lastError };
    }
  }

  function tick() {
    if (ticking) return ticking;
    ticking = runTick().finally(() => { ticking = null; });
    return ticking;
  }

  async function start() {
    if (closed) throw new Error("orchestrator is closed");
    const first = await tick();
    if (!timer) {
      timer = setInterval(() => { tick().catch(() => {}); }, Math.max(Number(pollMs) || 10_000, 1_000));
      if (typeof timer.unref === "function") timer.unref();
    }
    return first;
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (ticking) await ticking.catch(() => {});
    if (!closed) durable.releaseLeadership(instanceId);
  }

  async function close() {
    if (closed) return;
    await stop();
    closed = true;
    durable.close();
  }

  function health() {
    return {
      enabled: worker.enabled === true, node: worker.node || "", workerId: stableWorkerId,
      leader, instanceId, capabilities: workerCaps.slice(), maxConcurrent: concurrency,
      lastTickAt, lastSuccessAt, lastError, probe: lastProbe,
      journal: durable.health(), worker: typeof worker.health === "function" ? worker.health() : null,
    };
  }

  return { start, stop, close, tick, probe, health, journal: durable };
}
