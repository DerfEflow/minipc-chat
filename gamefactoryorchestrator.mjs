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

const TERMINAL_REMOTE = new Set(["SUCCEEDED", "PAUSED", "CANCELLED", "FAILED", "INTERRUPTED"]);
const ACTIVE_REMOTE = new Set(["STARTING", "RUNNING", "CANCEL_REQUESTED"]);
const DEFAULT_CAPABILITIES = Object.freeze([
  "gameplay_engineering", "quality_assurance", "godot", "android", "ios",
]);
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
      if (row.endedAt) return asDispatch(row);
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

  function listActive(limit = 100) {
    return db.prepare("SELECT * FROM dispatches WHERE endedAt=0 ORDER BY createdAt LIMIT ?")
      .all(Math.min(Math.max(Number(limit) || 100, 1), 1000)).map(asDispatch);
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
    file, recordIntent, update, finish, listActive, latestForTask,
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
  const rawWorkspaceRoot = String(payload.workspaceRoot || plan.workspaceRoot || project?.workspaceRoot || "").trim();
  const workspaceRoot = clean(rawWorkspaceRoot, 2000);
  if (!workspaceRoot) throw new Error("worker task has no attached workspace root");
  if (workspaceRoot !== rawWorkspaceRoot) throw new Error("worker workspace root exceeds the protocol limit");
  return {
    runId: `${task.id}:attempt:${Math.max(Number(task.attempt) || 1, 1)}`,
    taskId: task.id, projectId: task.projectId, buildId: task.buildId || "",
    capability: task.capability, attempt: Math.max(Number(task.attempt) || 1, 1),
    workspaceRoot, plan, resumeFrom,
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
  const stableWorkerId = safeText(workerId || `game-factory:${worker.node || "unconfigured"}`, 160);
  const workerCaps = [...new Set((Array.isArray(capabilities) ? capabilities : DEFAULT_CAPABILITIES).map((v) => clean(v, 100)).filter(Boolean))];
  const concurrency = Math.min(Math.max(Number(maxConcurrent) || 1, 1), 8);
  let timer = null, ticking = null, closed = false;
  let lastTickAt = 0, lastSuccessAt = 0, lastError = "", leader = false, lastProbe = null, lastProbeAt = 0;

  async function heartbeat(dispatch) {
    const result = store.heartbeatTask({
      uid: dispatch.uid, taskId: dispatch.taskId, workerId: stableWorkerId, attempt: dispatch.attempt, leaseMs,
    });
    if (!result || result.status !== 200) {
      durable.finish(dispatch.runId, "LEASE_LOST", result, safeText(responseBody(result).error, 1000) || "task lease was lost");
      return { ok: false, stopRequested: false };
    }
    return { ok: true, stopRequested: responseBody(result).stopRequested === true };
  }

  async function terminal(dispatch, remote) {
    if (remote.status === "FAILED" || remote.status === "INTERRUPTED") {
      const failed = store.failTask({
        uid: dispatch.uid, taskId: dispatch.taskId, workerId: stableWorkerId,
        attempt: dispatch.attempt,
        error: safeText(remote.error || `worker ended ${remote.status.toLowerCase()}`, 2000),
        retryable: dispatch.task.safeToRetry === true,
      });
      durable.finish(dispatch.runId, remote.status, remote, safeText(responseBody(failed).error, 1000));
      return;
    }

    const beat = await heartbeat(dispatch);
    if (!beat.ok) return;
    if ((remote.status === "PAUSED" || remote.status === "CANCELLED") && !beat.stopRequested) {
      const failed = store.failTask({
        uid: dispatch.uid, taskId: dispatch.taskId, workerId: stableWorkerId,
        attempt: dispatch.attempt,
        error: `worker reported an unexpected ${remote.status.toLowerCase()} state without an owner pause or stop request`,
        retryable: false,
      });
      durable.finish(dispatch.runId, "REMOTE_PROTOCOL_ERROR", remote, safeText(responseBody(failed).error, 1000));
      return;
    }
    const collected = await worker.collect(dispatch.runId);
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
      durable.finish(dispatch.runId, "REMOTE_PROTOCOL_ERROR", collected, safeText(responseBody(failed).error, 1000));
      return;
    }
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
    if (!completed || completed.status !== 200) {
      durable.finish(dispatch.runId, "LEASE_LOST", collected, safeText(responseBody(completed).error, 1000) || "could not commit worker result");
      return;
    }
    durable.finish(dispatch.runId, remote.status, collected);
  }

  async function reconcileOne(dispatch) {
    let remote = await worker.status(dispatch.runId);
    if (remote && remote.notFound && dispatch.lastSeenAt === 0) {
      remote = await worker.start(dispatch.request);
    }
    const stamp = Number(now()) || Date.now();
    if (!remote || remote.ok === false) {
      const since = dispatch.lastSeenAt || dispatch.createdAt;
      if (stamp - since <= remoteGraceMs) {
        await heartbeat(dispatch);
        durable.update(dispatch.runId, {
          status: "REMOTE_UNAVAILABLE", lastResponse: remote,
          error: safeText(remote && (remote.error || remote.reason), 1000) || "worker node is temporarily unavailable",
        }, "dispatch.remote_unavailable");
      } else {
        const failed = store.failTask({
          uid: dispatch.uid, taskId: dispatch.taskId, workerId: stableWorkerId,
          attempt: dispatch.attempt,
          error: "The explicit worker node remained unavailable beyond the recovery window.",
          retryable: dispatch.task.safeToRetry === true,
        });
        durable.finish(dispatch.runId, "REMOTE_LOST", remote, safeText(responseBody(failed).error, 1000));
      }
      return;
    }

    const remoteStatus = clean(remote.status, 80).toUpperCase();
    if (!TERMINAL_REMOTE.has(remoteStatus) && !ACTIVE_REMOTE.has(remoteStatus)) {
      const failed = store.failTask({
        uid: dispatch.uid, taskId: dispatch.taskId, workerId: stableWorkerId,
        attempt: dispatch.attempt,
        error: `worker reported unknown protocol state ${remoteStatus || "EMPTY"}`,
        retryable: false,
      });
      durable.finish(dispatch.runId, "REMOTE_PROTOCOL_ERROR", remote, safeText(responseBody(failed).error, 1000));
      return;
    }
    durable.update(dispatch.runId, {
      status: TERMINAL_REMOTE.has(remoteStatus) ? "COLLECTING" : remoteStatus || "RUNNING",
      remoteStatus, lastResponse: remote, lastSeenAt: stamp, error: "",
    }, "dispatch.remote_status");
    if (TERMINAL_REMOTE.has(remoteStatus)) return terminal(dispatch, { ...remote, status: remoteStatus });

    const beat = await heartbeat(dispatch);
    if (!beat.ok) return;
    if (beat.stopRequested) {
      const project = store.getProject(dispatch.uid, dispatch.projectId, { eventLimit: 1 });
      const immediate = project && project.operation === "STOP_REQUESTED";
      const cancelled = await worker.cancel(dispatch.runId, {
        mode: immediate ? "immediate" : "safe",
        reason: immediate ? "owner requested stop" : "owner requested pause at the next safe boundary",
      });
      durable.update(dispatch.runId, {
        status: "CANCEL_REQUESTED", remoteStatus: clean(cancelled && cancelled.status, 80),
        lastResponse: cancelled, error: cancelled && cancelled.ok === false ? safeText(cancelled.error || cancelled.reason, 1000) : "",
        lastSeenAt: cancelled && cancelled.ok !== false ? stamp : dispatch.lastSeenAt,
      }, "dispatch.cancel_requested");
    }
  }

  async function probe(force = false) {
    const stamp = Number(now()) || Date.now();
    if (!force && lastProbe && stamp - lastProbeAt < 60_000) return lastProbe;
    lastProbe = await worker.probe();
    lastProbeAt = stamp;
    return lastProbe;
  }

  async function claimOne(capability) {
    const task = store.claimNextTask({ workerId: stableWorkerId, capability, leaseMs });
    if (!task) return false;
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
    const started = await worker.start(request);
    if (!started || started.ok === false) {
      // A transport timeout is an ambiguous external effect: the detached runner may already have
      // accepted the deterministic runId. Keep the lease and reconcile by status/idempotent start;
      // requeueing here could execute a non-idempotent build twice.
      if (started && started.retryable === true) {
        durable.update(request.runId, {
          status: "START_UNCERTAIN", remoteStatus: "", lastResponse: started,
          error: safeText(started.error || started.reason, 1000) || "worker start acknowledgement was not received",
        }, "dispatch.start_uncertain");
        return true;
      }
      const failed = store.failTask({
        uid: task.uid, taskId: task.id, workerId: stableWorkerId,
        attempt: task.attempt,
        error: safeText(started && (started.error || started.reason), 2000) || "worker did not accept the task",
        retryable: started && started.retryable === true,
      });
      durable.finish(request.runId, "START_FAILED", started, safeText(responseBody(failed).error, 1000));
      return true;
    }
    durable.update(request.runId, {
      status: clean(started.status, 80).toUpperCase() || "STARTING",
      remoteStatus: clean(started.status, 80).toUpperCase(), lastResponse: started,
      lastSeenAt: Number(now()) || Date.now(), error: "",
    }, "dispatch.started");
    return true;
  }

  async function runTick() {
    if (closed) return { ok: false, closed: true };
    const stamp = Number(now()) || Date.now();
    leader = durable.acquireLeadership(instanceId, leaderLeaseMs);
    lastTickAt = stamp;
    if (!leader) return { ok: true, leader: false, active: durable.listActive().length };
    const report = { ok: true, leader: true, reconciled: 0, claimed: 0, storeRecovery: null };
    try {
      for (const dispatch of durable.listActive(1000)) {
        await reconcileOne(dispatch);
        report.reconciled++;
      }
      report.storeRecovery = store.reconcile({ limit: 100 });
      const workerReady = await probe(false);
      if (workerReady && workerReady.ok !== false) {
        let active = durable.listActive().length;
        for (const capability of workerCaps) {
          if (active >= concurrency) break;
          if (await claimOne(capability)) { report.claimed++; active = durable.listActive().length; }
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
