/*
 * SD Tech Mobile Game Factory — durable control-plane store.
 *
 * SQLite is the source of truth. Browser state and worker memory are projections only. Every
 * command is idempotent, every mutation is tenant-scoped, and every external effect gets an outbox
 * row so a restart can reconcile it instead of guessing whether it happened.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  PORTFOLIO, REQUIRED_GAME_ARTIFACTS, MANDATORY_ARTIFACT_BACKENDS, KNOWN_ARTIFACT_BACKENDS, QA_REQUIRED_SUITES, APPROVAL_GATES, TASK_CAPABILITIES,
  GAME_STATES, HOLD_STATES, projectIdFor, normalizeIdempotencyKey,
  defaultNextState, transitionDecision, allowedTransitions, stateProgress, approvalAllowed,
} from "./gamefactory.mjs";
import {
  LOCKED_NATIVE_CHATGPT_PROJECT_ID, NATIVE_PROJECT_API_VERIFIED_STATUS, NATIVE_PROJECT_EVIDENCE_CLOCK_SKEW_MS,
  NATIVE_PROJECT_OWNER_ATTESTED_STATUS, nativeProjectEvidenceCanComplete, nativeProjectEvidenceIdValid,
  normalizeNativeApiProjectManifest,
  normalizeNativeProjectInvalidationManifest, normalizeOwnerAttestedNativeProjectManifest,
} from "./gamefactorynativeevidence.mjs";

const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const cleanText = (value, max = 1000) => String(value == null ? "" : value).trim().slice(0, max);
const SECRET_NAME = /(authorization|cookie|credential|password|passwd|private.?key|recovery.?code|secret|signature|token|keystore|database.?url|connection.?string|access.?key|client.?secret|webhook.?secret|(^|[_-])pat($|[_-]))/i;
function redactString(value, max = 20_000) {
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
  if (typeof value === "string") return redactString(value);
  if (depth >= 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeValue(item, depth + 1));
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary:${value.byteLength}]`;
  if (typeof value !== "object") return redactString(value);
  return Object.fromEntries(Object.entries(value).slice(0, 200).map(([name, item]) => [cleanText(name, 120), safeValue(item, depth + 1, name)]));
}
const json = (value) => JSON.stringify(safeValue(value == null ? null : value));
const safeText = (value, max = 1000) => redactString(value, max).trim();
const cleanUid = (value) => cleanText(value, 80).toLowerCase();
const nowIso = (ms) => new Date(ms).toISOString();

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
const requestHash = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
export const SYNTHETIC_CANARY_SCHEMA = "game-factory.synthetic-worker-canary.v1";
const SYNTHETIC_CANARY_TITLE = "Trusted synthetic worker canary";
const SYNTHETIC_CANARY_CAPABILITY = "quality_assurance";
const SYNTHETIC_CANARY_MAX_ATTEMPTS = 2;
// Deficiency 17: outbox_events accumulated 132 PENDING rows with 0 attempts and no consumer. Every
// row's kind is "domain_event" (see emit() below); nothing else has ever called insertOutbox. The
// drainer below is generic over kind so a future insertOutbox caller is not silently ignored.
const OUTBOX_MAX_ATTEMPTS = 8;
const OUTBOX_BACKOFF_BASE_MS = 30_000;
const OUTBOX_BACKOFF_MAX_MS = 30 * 60_000;
const outboxBackoffMs = (attempts) => Math.min(OUTBOX_BACKOFF_BASE_MS * (2 ** Math.max(Number(attempts) || 0, 0)), OUTBOX_BACKOFF_MAX_MS);
const MIRROR_WRITES_TRUE = new Set(["1", "true", "yes", "on", "enabled"]);
function syntheticCanaryRecipe() {
  return {
    payload: {
      syntheticCanary: { schema: SYNTHETIC_CANARY_SCHEMA, evidenceEffects: "none" },
      workerPlan: {
        // The canary is a server-owned container health probe. It receives one fixed, dedicated
        // subtree so the broker's Landlock/project-quota proof never has to grant workspace-root or
        // sibling access. This is not a host path or a value accepted from the browser.
        workspaceRoot: "/workspace/system-canary",
        steps: [{
          label: "Report the Node.js runtime version",
          program: "node",
          args: ["--version"],
          cwd: ".",
          timeoutMs: 30_000,
        }],
        collect: [],
      },
    },
    acceptance: ["The fixed Node.js version probe exits successfully without collecting artifacts."],
  };
}
const SYNTHETIC_CANARY_SIGNATURE = requestHash(syntheticCanaryRecipe());
function isSyntheticCanaryTask(row) {
  // The exact primary-key namespace is the immutable origin marker. Generic queueTask callers do
  // not choose IDs and can only create gft_<uuid>, so matching the public recipe cannot acquire
  // the canary's lifecycle exemptions.
  if (!row || !/^gft_canary_[a-f0-9]{32}$/.test(String(row.id || ""))
      || row.capability !== SYNTHETIC_CANARY_CAPABILITY || row.title !== SYNTHETIC_CANARY_TITLE
      || String(row.buildId || "") || !row.safeToRetry || Number(row.maxAttempts) !== SYNTHETIC_CANARY_MAX_ATTEMPTS) return false;
  return requestHash({ payload: parse(row.payload, {}), acceptance: parse(row.acceptance, []) }) === SYNTHETIC_CANARY_SIGNATURE;
}
const SCHEMA_V1_CHECKSUM = createHash("sha256").update([
  "game_projects:v1", "game_builds:v1", "game_tasks:v1", "game_checkpoints:v1",
  "game_events:v1", "game_artifacts:v1", "game_artifact_copies:v1",
  "game_test_runs:v1", "game_approvals:v1", "game_releases:v1",
  "game_model_runs:v1", "command_idempotency:v1", "outbox_events:v1",
].join("|")).digest("hex");
const SCHEMA_VERSION = 2;
const SCHEMA_CHECKSUM = createHash("sha256").update([
  "game_projects:v1", "game_builds:v1", "game_tasks:v1", "game_checkpoints:v1",
  "game_events:v1", "game_artifacts:v1", "game_artifact_copies:v1", "game_artifact_native_evidence:v1",
  "game_test_runs:v1", "game_approvals:v1", "game_releases:v1",
  "game_model_runs:v1", "command_idempotency:v1", "outbox_events:v1",
].join("|")).digest("hex");

function asProject(row) {
  if (!row) return null;
  return {
    id: row.id, uid: row.uid, name: row.name, slug: row.slug, order: row.portfolioOrder,
    state: row.state, resumeState: row.resumeState || "", operation: row.operation || "",
    activeBuildId: row.activeBuildId || "", workspaceId: row.workspaceId || "",
    workspaceRoot: row.workspaceRoot || "", priority: row.priority, policyVersion: row.policyVersion,
    version: row.version, blocker: row.blocker || "", createdAt: row.createdAt, updatedAt: row.updatedAt,
    progress: stateProgress(row.state),
    allowedTransitions: allowedTransitions(row.state, { resumeState: row.resumeState }),
  };
}

function asTask(row) {
  if (!row) return null;
  return {
    id: row.id, uid: row.uid, projectId: row.projectId, buildId: row.buildId || "", capability: row.capability,
    title: row.title, status: row.status, payload: parse(row.payload, {}), acceptance: parse(row.acceptance, []),
    result: parse(row.result, null), priority: row.priority, attempt: row.attempt, maxAttempts: row.maxAttempts,
    safeToRetry: !!row.safeToRetry, workerId: row.workerId || "", leaseUntil: row.leaseUntil,
    heartbeatAt: row.heartbeatAt, cancelRequested: !!row.cancelRequested,
    createdAt: row.createdAt, startedAt: row.startedAt, endedAt: row.endedAt,
  };
}

export function createGameFactoryStore({
  dir, now = () => Date.now(), log = () => {}, requiredArtifactBackends = MANDATORY_ARTIFACT_BACKENDS,
  verifyReleaseEvidence = null,
} = {}) {
  if (!dir) throw new Error("createGameFactoryStore needs a dir");
  const requiredBackends = [...new Set((requiredArtifactBackends || []).map((value) => cleanText(value, 80).toLowerCase()).filter(Boolean))];
  if (!requiredBackends.length || requiredBackends.some((backend) => !KNOWN_ARTIFACT_BACKENDS.includes(backend))) {
    throw new Error("requiredArtifactBackends must name known, non-empty artifact backends");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
  const file = join(dir, "gamefactory.db");
  const db = new DatabaseSync(file);
  try { chmodSync(file, 0o600); } catch {}
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  const existingSchemaVersion = Number(db.prepare("PRAGMA user_version").get().user_version) || 0;
  if (existingSchemaVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error(`Game Factory database schema ${existingSchemaVersion} is newer than supported schema ${SCHEMA_VERSION}.`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_factory_schema (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      version INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      appliedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_projects (
      id TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      portfolioOrder INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'IDEA',
      resumeState TEXT NOT NULL DEFAULT '',
      operation TEXT NOT NULL DEFAULT '',
      activeBuildId TEXT NOT NULL DEFAULT '',
      workspaceId TEXT NOT NULL DEFAULT '',
      workspaceRoot TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0,
      policyVersion INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1,
      blocker TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE(uid, slug)
    );
    CREATE INDEX IF NOT EXISTS gf_projects_uid ON game_projects(uid, portfolioOrder, priority DESC);

    CREATE TABLE IF NOT EXISTS game_builds (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
      uid TEXT NOT NULL,
      sourceCommit TEXT NOT NULL DEFAULT '',
      toolchain TEXT NOT NULL DEFAULT '{}',
      targets TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'PLANNED',
      versionName TEXT NOT NULL DEFAULT '',
      versionCode INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gf_builds_project ON game_builds(projectId, createdAt DESC);

    CREATE TABLE IF NOT EXISTS game_tasks (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
      buildId TEXT NOT NULL DEFAULT '',
      uid TEXT NOT NULL,
      capability TEXT NOT NULL,
      title TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      acceptance TEXT NOT NULL DEFAULT '[]',
      result TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'QUEUED',
      priority INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      maxAttempts INTEGER NOT NULL DEFAULT 3,
      safeToRetry INTEGER NOT NULL DEFAULT 0,
      workerId TEXT NOT NULL DEFAULT '',
      leaseUntil INTEGER NOT NULL DEFAULT 0,
      heartbeatAt INTEGER NOT NULL DEFAULT 0,
      cancelRequested INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      startedAt INTEGER NOT NULL DEFAULT 0,
      endedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS gf_tasks_queue ON game_tasks(status, priority DESC, createdAt);
    CREATE INDEX IF NOT EXISTS gf_tasks_project ON game_tasks(projectId, createdAt DESC);

    CREATE TABLE IF NOT EXISTS game_checkpoints (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
      buildId TEXT NOT NULL DEFAULT '',
      taskId TEXT NOT NULL DEFAULT '',
      uid TEXT NOT NULL,
      state TEXT NOT NULL,
      sourceCommit TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      compatible INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gf_checkpoints_project ON game_checkpoints(projectId, createdAt DESC);

    CREATE TABLE IF NOT EXISTS game_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId TEXT NOT NULL,
      uid TEXT NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      causationId TEXT NOT NULL DEFAULT '',
      correlationId TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gf_events_project ON game_events(uid, projectId, id);

    CREATE TABLE IF NOT EXISTS game_artifacts (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
      uid TEXT NOT NULL,
      artifactKey TEXT NOT NULL,
      version INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      mimeType TEXT NOT NULL DEFAULT 'application/octet-stream',
      provenance TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL,
      UNIQUE(projectId, artifactKey, version)
    );
    CREATE INDEX IF NOT EXISTS gf_artifacts_project ON game_artifacts(projectId, artifactKey, version DESC);

    CREATE TABLE IF NOT EXISTS game_artifact_copies (
      id TEXT PRIMARY KEY,
      artifactId TEXT NOT NULL REFERENCES game_artifacts(id) ON DELETE CASCADE,
      backend TEXT NOT NULL,
      locator TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING',
      fingerprint TEXT NOT NULL DEFAULT '',
      algorithm TEXT NOT NULL DEFAULT 'sha256',
      attempts INTEGER NOT NULL DEFAULT 0,
      lastError TEXT NOT NULL DEFAULT '',
      verifiedAt INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL,
      UNIQUE(artifactId, backend)
    );

    /*
     * Native ChatGPT Project evidence cannot use the mutable copy-status projection above.  A
     * later observation must not relabel a prior claim.  This ledger is append-only in normal
     * code: an invalidation is a new row bound to the original evidence id, never an UPDATE or
     * DELETE.  RESTRICT also prevents an accidental project/artifact deletion from erasing the
     * audit history.
     */
    CREATE TABLE IF NOT EXISTS game_artifact_native_evidence (
      id TEXT PRIMARY KEY,
      artifactId TEXT NOT NULL REFERENCES game_artifacts(id) ON DELETE RESTRICT,
      projectId TEXT NOT NULL REFERENCES game_projects(id) ON DELETE RESTRICT,
      uid TEXT NOT NULL,
      kind TEXT NOT NULL,
      targetEvidenceId TEXT NOT NULL DEFAULT '',
      nativeProjectId TEXT NOT NULL,
      fingerprint TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      operator TEXT NOT NULL DEFAULT '',
      browserEvidenceRef TEXT NOT NULL DEFAULT '',
      manifestHash TEXT NOT NULL,
      manifest TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      UNIQUE(artifactId, kind, manifestHash)
    );
    CREATE INDEX IF NOT EXISTS gf_native_evidence_artifact ON game_artifact_native_evidence(artifactId, createdAt, id);
    CREATE INDEX IF NOT EXISTS gf_native_evidence_target ON game_artifact_native_evidence(targetEvidenceId, createdAt, id);
    /* The application never mutates evidence, and the database rejects accidental mutation too.
     * A filesystem/database administrator can always replace a SQLite file, so projections also
     * revalidate every record and fail closed; these triggers protect the ordinary store path. */
    CREATE TRIGGER IF NOT EXISTS gf_native_evidence_no_update
      BEFORE UPDATE ON game_artifact_native_evidence
      BEGIN SELECT RAISE(ABORT, 'native Project evidence is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS gf_native_evidence_no_delete
      BEFORE DELETE ON game_artifact_native_evidence
      BEGIN SELECT RAISE(ABORT, 'native Project evidence is append-only'); END;

    CREATE TABLE IF NOT EXISTS game_test_runs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
      buildId TEXT NOT NULL DEFAULT '',
      uid TEXT NOT NULL,
      suite TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      sourceHash TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '{}',
      metrics TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gf_tests_project ON game_test_runs(projectId, createdAt DESC);

    CREATE TABLE IF NOT EXISTS game_approvals (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
      buildId TEXT NOT NULL DEFAULT '',
      uid TEXT NOT NULL,
      gate TEXT NOT NULL,
      decision TEXT NOT NULL,
      approver TEXT NOT NULL,
      subjectHash TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL,
      invalidatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS gf_approvals_project ON game_approvals(projectId, gate, createdAt DESC);

    CREATE TABLE IF NOT EXISTS game_releases (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
      buildId TEXT NOT NULL DEFAULT '',
      uid TEXT NOT NULL,
      platform TEXT NOT NULL,
      packageId TEXT NOT NULL DEFAULT '',
      versionName TEXT NOT NULL DEFAULT '',
      versionCode INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      storeLocator TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gf_releases_project ON game_releases(projectId, platform, updatedAt DESC);

    CREATE TABLE IF NOT EXISTS game_model_runs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
      taskId TEXT NOT NULL DEFAULT '',
      uid TEXT NOT NULL,
      capability TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      policyRoute TEXT NOT NULL DEFAULT '',
      inputTokens INTEGER NOT NULL DEFAULT 0,
      outputTokens INTEGER NOT NULL DEFAULT 0,
      costUsd REAL NOT NULL DEFAULT 0,
      latencyMs INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS command_idempotency (
      uid TEXT NOT NULL,
      commandKey TEXT NOT NULL,
      requestHash TEXT NOT NULL,
      status INTEGER NOT NULL,
      response TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY(uid, commandKey)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS outbox_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId TEXT NOT NULL,
      uid TEXT NOT NULL,
      kind TEXT NOT NULL,
      effectKey TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      nextAttemptAt INTEGER NOT NULL DEFAULT 0,
      lastError TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      deliveredAt INTEGER NOT NULL DEFAULT 0,
      UNIQUE(uid, effectKey)
    );
  `);

  let schemaRow = db.prepare("SELECT version,checksum FROM game_factory_schema WHERE singleton=1").get();
  if (schemaRow && Number(schemaRow.version) === 1 && schemaRow.checksum === SCHEMA_V1_CHECKSUM && existingSchemaVersion === 1) {
    // The only supported migration is the known v1 schema.  In particular, old mutable
    // chatgpt_project rows are deliberately not copied into the new append-only ledger.
    db.prepare("UPDATE game_factory_schema SET version=?,checksum=?,appliedAt=? WHERE singleton=1")
      .run(SCHEMA_VERSION, SCHEMA_CHECKSUM, Number(now()) || Date.now());
    schemaRow = db.prepare("SELECT version,checksum FROM game_factory_schema WHERE singleton=1").get();
  }
  if ((schemaRow && (Number(schemaRow.version) !== SCHEMA_VERSION || schemaRow.checksum !== SCHEMA_CHECKSUM)) ||
      (!schemaRow && existingSchemaVersion !== 0)) {
    db.close();
    throw new Error("Game Factory database schema metadata does not match this build.");
  }
  if (!schemaRow) {
    db.prepare("INSERT INTO game_factory_schema (singleton,version,checksum,appliedAt) VALUES (1,?,?,?)")
      .run(SCHEMA_VERSION, SCHEMA_CHECKSUM, Number(now()) || Date.now());
  }
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);

  const q = {
    project: db.prepare("SELECT * FROM game_projects WHERE id=? AND uid=?"),
    projects: db.prepare("SELECT * FROM game_projects WHERE uid=? ORDER BY priority DESC, portfolioOrder, createdAt"),
    insertProject: db.prepare(`INSERT OR IGNORE INTO game_projects
      (id,uid,email,name,slug,portfolioOrder,state,priority,createdAt,updatedAt) VALUES (?,?,?,?,?,?,'IDEA',?,?,?)`),
    projectVersion: db.prepare("UPDATE game_projects SET version=version+1, updatedAt=? WHERE id=? AND uid=?"),
    events: db.prepare("SELECT * FROM game_events WHERE uid=? AND projectId=? AND id>? ORDER BY id LIMIT ?"),
    insertEvent: db.prepare("INSERT INTO game_events (projectId,uid,type,actor,causationId,correlationId,payload,createdAt) VALUES (?,?,?,?,?,?,?,?)"),
    insertOutbox: db.prepare("INSERT OR IGNORE INTO outbox_events (projectId,uid,kind,effectKey,payload,createdAt) VALUES (?,?,?,?,?,?)"),
    outboxPending: db.prepare("SELECT * FROM outbox_events WHERE status IN ('PENDING','RETRYABLE') AND nextAttemptAt<=? ORDER BY nextAttemptAt, id LIMIT ?"),
    outboxSettle: db.prepare("UPDATE outbox_events SET status=?, attempts=attempts+1, nextAttemptAt=?, lastError=?, deliveredAt=? WHERE id=?"),
    command: db.prepare("SELECT * FROM command_idempotency WHERE uid=? AND commandKey=?"),
    saveCommand: db.prepare("INSERT INTO command_idempotency (uid,commandKey,requestHash,status,response,createdAt) VALUES (?,?,?,?,?,?)"),
    tasks: db.prepare("SELECT * FROM game_tasks WHERE projectId=? AND uid=? ORDER BY createdAt DESC LIMIT ?"),
    task: db.prepare("SELECT * FROM game_tasks WHERE id=? AND uid=?"),
    activeTasks: db.prepare("SELECT COUNT(*) AS n FROM game_tasks WHERE projectId=? AND uid=? AND status='RUNNING'"),
    latestCheckpoint: db.prepare("SELECT * FROM game_checkpoints WHERE projectId=? AND uid=? AND compatible=1 ORDER BY createdAt DESC LIMIT 1"),
    latestBuild: db.prepare("SELECT * FROM game_builds WHERE projectId=? AND uid=? ORDER BY createdAt DESC LIMIT 1"),
    approvals: db.prepare("SELECT * FROM game_approvals WHERE projectId=? AND uid=? ORDER BY createdAt DESC"),
    tests: db.prepare("SELECT rowid AS sequence,* FROM game_test_runs WHERE projectId=? AND uid=? ORDER BY createdAt DESC,rowid DESC"),
    releases: db.prepare("SELECT rowid AS sequence,* FROM game_releases WHERE projectId=? AND uid=? ORDER BY updatedAt DESC,rowid DESC"),
    artifacts: db.prepare("SELECT * FROM game_artifacts WHERE projectId=? AND uid=? ORDER BY artifactKey, version DESC"),
    copies: db.prepare("SELECT * FROM game_artifact_copies WHERE artifactId=? ORDER BY backend"),
    nativeEvidence: db.prepare("SELECT rowid AS sequence,* FROM game_artifact_native_evidence WHERE artifactId=? ORDER BY rowid"),
    nativeEvidenceById: db.prepare("SELECT * FROM game_artifact_native_evidence WHERE id=?"),
    queued: db.prepare(`SELECT t.* FROM game_tasks t JOIN game_projects p ON p.id=t.projectId AND p.uid=t.uid
      WHERE t.status='QUEUED' AND t.cancelRequested=0 AND p.state NOT IN ('PAUSED','BLOCKED','FAILED','DEPLOYED')
        AND p.operation='' AND (?='' OR t.capability=?)
        AND NOT EXISTS (SELECT 1 FROM game_tasks r WHERE r.projectId=t.projectId AND r.status='RUNNING')
      ORDER BY t.priority DESC, t.createdAt LIMIT 1`),
    expired: db.prepare("SELECT * FROM game_tasks WHERE status='RUNNING' AND leaseUntil>0 AND leaseUntil<? ORDER BY leaseUntil LIMIT ?"),
  };

  const timestamp = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };

  // Native Project evidence is an append-only audit fact, so it may not inherit the store's
  // generic wall-clock fallback.  A non-numeric, unsafe, fractional, negative, or throwing clock
  // makes chronology unprovable and must fail before BEGIN IMMEDIATE (and before any append).
  function nativeEvidenceTimestamp() {
    try {
      const value = now();
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  function nativeEvidenceClockFailure() {
    return result(503, {
      error: "The durable native Project evidence clock is unavailable or invalid.",
      code: "native_project_clock_invalid",
    });
  }

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }

  function emit(project, type, payload = {}, meta = {}) {
    const at = timestamp();
    const actor = safeText(meta.actor || "system", 160) || "system";
    const causationId = safeText(meta.causationId, 160);
    const correlationId = safeText(meta.correlationId, 160);
    const p = json(payload || {});
    const result = q.insertEvent.run(project.id, project.uid, cleanText(type, 100), actor, causationId, correlationId, p, at);
    const eventId = Number(result.lastInsertRowid || 0);
    const effectKey = `${project.id}:event:${eventId}`;
    q.insertOutbox.run(project.id, project.uid, "domain_event", effectKey, json({ eventId, type, payload }), at);
    return eventId;
  }

  function seedPortfolio({ uid, email = "" }) {
    const who = cleanUid(uid) || "owner";
    const at = timestamp();
    tx(() => {
      for (const item of PORTFOLIO) {
        const id = projectIdFor(who, item.slug);
        const r = q.insertProject.run(id, who, cleanText(email, 320).toLowerCase(), item.name, item.slug, item.order, 1000 - item.order, at, at);
        if (r.changes) emit({ id, uid: who }, "project.created", { name: item.name, slug: item.slug, portfolioOrder: item.order }, { actor: "factory-seed" });
      }
    });
    return listProjects(who);
  }

  function listProjects(uid) {
    return q.projects.all(cleanUid(uid)).map(asProject);
  }

  function nativeEvidenceArtifact(row) {
    return {
      id: row.id, artifactKey: row.artifactKey, version: row.version, sha256: row.sha256,
      size: row.size, mimeType: row.mimeType, provenance: parse(row.provenance, {}),
    };
  }

  function nativeEvidenceState(row, legacyRows = []) {
    const artifact = nativeEvidenceArtifact(row);
    const entries = q.nativeEvidence.all(row.id);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const invalidated = new Set();
    const recorded = [];
    let corrupt = !Number.isSafeInteger(Number(row.createdAt));
    let lastObservedAt = null;
    let lastCreatedAt = null;

    for (const entry of entries) {
      try {
        if (!nativeProjectEvidenceIdValid(entry.id) || entry.artifactId !== row.id
            || entry.projectId !== row.projectId || entry.uid !== row.uid
            || entry.nativeProjectId !== LOCKED_NATIVE_CHATGPT_PROJECT_ID
            || !Number.isSafeInteger(Number(entry.createdAt)) || Number(entry.createdAt) < Number(row.createdAt)
            || (lastCreatedAt !== null && Number(entry.createdAt) < lastCreatedAt)) {
          throw new Error("native Project evidence row metadata is inconsistent");
        }
        const manifest = entry.kind === "INVALIDATED"
          ? normalizeNativeProjectInvalidationManifest(parse(entry.manifest, {}), { stored: true })
          : entry.kind === NATIVE_PROJECT_OWNER_ATTESTED_STATUS
            ? normalizeOwnerAttestedNativeProjectManifest(parse(entry.manifest, {}), artifact, { stored: true })
            : entry.kind === NATIVE_PROJECT_API_VERIFIED_STATUS
              ? normalizeNativeApiProjectManifest(parse(entry.manifest, {}), artifact, { stored: true })
              : null;
        if (!manifest) throw new Error("unknown native Project evidence kind");
        const observedAt = Date.parse(entry.kind === NATIVE_PROJECT_API_VERIFIED_STATUS ? manifest.verifiedAt : manifest.observedAt);
        if (!Number.isFinite(observedAt) || observedAt < Number(row.createdAt)
            || observedAt > Number(entry.createdAt) + NATIVE_PROJECT_EVIDENCE_CLOCK_SKEW_MS
            || (lastObservedAt !== null && observedAt <= lastObservedAt)) {
          throw new Error("native Project evidence chronology is inconsistent");
        }
        lastObservedAt = observedAt;
        lastCreatedAt = Number(entry.createdAt);

        if (entry.kind === "INVALIDATED") {
          const target = byId.get(manifest.evidenceId);
          if (!target || target.kind === "INVALIDATED" || Number(target.sequence) >= Number(entry.sequence)
              || entry.targetEvidenceId !== manifest.evidenceId || entry.fingerprint !== "" || Number(entry.size) !== 0
              || entry.manifestHash !== manifest.manifestHash || entry.operator !== manifest.operator
              || entry.browserEvidenceRef !== manifest.browserEvidenceRef || invalidated.has(manifest.evidenceId)) {
            throw new Error("native Project invalidation row is inconsistent");
          }
          invalidated.add(manifest.evidenceId);
          continue;
        }

        const ownerAttested = entry.kind === NATIVE_PROJECT_OWNER_ATTESTED_STATUS;
        const candidate = {
          id: entry.id, backend: "chatgpt_project", status: entry.kind, fingerprint: manifest.sha256,
          algorithm: "sha256", attempts: 1, lastError: "", verifiedAt: Number(entry.createdAt),
          provenance: ownerAttested ? "OWNER_ATTESTED_BROWSER_UPLOAD" : "NATIVE_API_VERIFIED",
          nativeProjectId: manifest.nativeProjectId, manifestHash: manifest.manifestHash,
          artifactId: manifest.artifactId, artifactKey: manifest.artifactKey,
          artifactVersion: manifest.artifactVersion, size: manifest.size, filename: manifest.filename,
          sourceCount: manifest.sourceCount,
          operator: ownerAttested ? manifest.operator : "",
          observedAt: ownerAttested ? manifest.observedAt : "",
          browserEvidenceRef: ownerAttested ? manifest.browserEvidenceRef : "",
          uploadMethod: ownerAttested ? manifest.uploadMethod : "",
          evidenceOrigin: ownerAttested ? manifest.evidenceOrigin : "",
          sourceListVisible: ownerAttested ? manifest.sourceListVisible : false,
          screenshotOnly: ownerAttested ? manifest.screenshotOnly : false,
          ownerAttestation: ownerAttested ? manifest.ownerAttestation : "",
          nativeVerifiedAt: ownerAttested ? "" : manifest.verifiedAt,
          apiVersion: ownerAttested ? "" : manifest.apiVersion,
          verificationReceiptRef: ownerAttested ? "" : manifest.verificationReceiptRef,
        };
        if (entry.targetEvidenceId !== "" || entry.manifestHash !== manifest.manifestHash
            || entry.fingerprint !== artifact.sha256 || Number(entry.size) !== Number(artifact.size)
            || entry.operator !== candidate.operator || entry.browserEvidenceRef !== candidate.browserEvidenceRef
            || !nativeProjectEvidenceCanComplete(candidate, artifact)) {
          throw new Error("native Project evidence row is inconsistent");
        }
        recorded.push(candidate);
      } catch {
        corrupt = true;
      }
    }

    const state = { entries, lastObservedAt, lastCreatedAt };
    const active = recorded.filter((candidate) => !invalidated.has(candidate.id));
    if (corrupt) {
      state.copy = {
        backend: "chatgpt_project", status: "EVIDENCE_CORRUPT", fingerprint: "", algorithm: "sha256", attempts: entries.length,
        lastError: "Append-only native Project evidence is malformed or internally inconsistent.", verifiedAt: 0,
        provenance: "NONE", nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
      };
    } else if (active.length > 1) {
      state.copy = {
        backend: "chatgpt_project", status: "AMBIGUOUS", fingerprint: "", algorithm: "sha256", attempts: entries.length,
        lastError: "More than one active native Project evidence record exists; explicit invalidation is required before completion.", verifiedAt: 0,
        provenance: "NONE", nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
      };
    } else if (active.length === 1) {
      state.copy = active[0];
    } else if (entries.some((entry) => entry.kind === "INVALIDATED")) {
      state.copy = {
        backend: "chatgpt_project", status: "INVALIDATED", fingerprint: "", algorithm: "sha256", attempts: entries.length,
        lastError: "The prior native Project evidence was invalidated by a later owner browser observation.", verifiedAt: 0,
        provenance: "NONE", nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
      };
    } else if (legacyRows.length) {
      state.copy = {
        backend: "chatgpt_project", status: "UNTRUSTED_LEGACY", fingerprint: "", algorithm: "sha256", attempts: legacyRows.length,
        lastError: "Legacy mutable native Project copy rows cannot satisfy completion without v2 append-only evidence.", verifiedAt: 0,
        provenance: "NONE", nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
      };
    } else {
      // chatgpt_project is a DEFERRED backend (see the comment at MANDATORY_ARTIFACT_BACKENDS in
      // gamefactory.mjs): no evidence yet is expected, informational, and never a blocker. It stays
      // reconcilable through the offline owner-attestation flow whenever Fred chooses to run it.
      state.copy = {
        backend: "chatgpt_project", status: "DEFERRED", fingerprint: "", algorithm: "sha256", attempts: 0,
        lastError: "ChatGPT Project sync is deferred; use the offline owner-attestation command when ready.",
        reason: "chatgpt_project has no API; this backend is deferred and does not block the game plan.",
        verifiedAt: 0, provenance: "NONE", nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
      };
    }
    return state;
  }

  function nativeEvidenceCopy(row, legacyRows = []) {
    return nativeEvidenceState(row, legacyRows).copy;
  }

  function copySatisfiesBackend(copy, artifact, backend) {
    if (!copy || copy.backend !== backend || copy.algorithm !== "sha256" || copy.fingerprint !== artifact.sha256) return false;
    return backend === "chatgpt_project" ? nativeProjectEvidenceCanComplete(copy, artifact) : copy.status === "VERIFIED";
  }

  // Completion-sensitive callers ask the store to re-project the durable rows by identity. They
  // never decide native Project completion from a copy object supplied by an HTTP/worker caller.
  function artifactCopyComplete({ uid, projectId, artifactId, backend } = {}) {
    const who = cleanUid(uid);
    const be = cleanText(backend, 80).toLowerCase();
    if (!KNOWN_ARTIFACT_BACKENDS.includes(be)) return false;
    const row = db.prepare("SELECT * FROM game_artifacts WHERE id=? AND projectId=? AND uid=?")
      .get(cleanText(artifactId, 180), cleanText(projectId, 180), who);
    if (!row) return false;
    if (be === "chatgpt_project") {
      const storedCopies = q.copies.all(row.id);
      const copy = nativeEvidenceCopy(row, storedCopies.filter((candidate) => candidate.backend === "chatgpt_project"));
      return copySatisfiesBackend(copy, nativeEvidenceArtifact(row), be);
    }
    const copy = q.copies.all(row.id).find((candidate) => candidate.backend === be) || null;
    return copySatisfiesBackend(copy, nativeEvidenceArtifact(row), be);
  }

  function artifactSummary(projectId, uid) {
    const rows = q.artifacts.all(projectId, cleanUid(uid));
    const latest = new Map();
    for (const row of rows) if (!latest.has(row.artifactKey)) latest.set(row.artifactKey, row);
    const artifacts = [];
    for (const [artifactKey, row] of latest) {
      const storedCopies = q.copies.all(row.id);
      const legacyNative = storedCopies.filter((copy) => copy.backend === "chatgpt_project");
      const copies = storedCopies.filter((copy) => copy.backend !== "chatgpt_project").map((copy) => ({
        id: copy.id, backend: copy.backend, locator: copy.locator, status: copy.status,
        fingerprint: copy.fingerprint, algorithm: copy.algorithm, attempts: copy.attempts,
        lastError: copy.lastError, verifiedAt: copy.verifiedAt,
      }));
      copies.push(nativeEvidenceCopy(row, legacyNative));
      const artifact = {
        id: row.id, artifactKey, version: row.version, sha256: row.sha256, size: row.size,
        mimeType: row.mimeType, provenance: parse(row.provenance, {}), createdAt: row.createdAt,
        copies,
      };
      artifact.complete = requiredBackends.every((backend) => copySatisfiesBackend(copies.find((copy) => copy.backend === backend), artifact, backend));
      artifacts.push(artifact);
    }
    const byKey = new Map(artifacts.map((artifact) => [artifact.artifactKey, artifact]));
    const missing = REQUIRED_GAME_ARTIFACTS.filter((key) => !byKey.get(key)?.complete);
    return { artifacts, required: [...REQUIRED_GAME_ARTIFACTS], missing, complete: missing.length === 0 };
  }

  const APPROVAL_ARTIFACTS = Object.freeze({
    SPECIFICATION: ["00_GAME_BRIEF", "01_MARKET_CASE", "02_RELEASE_ROADMAP", "03_BUILD_WORKFLOW"],
    VISUAL_SYSTEM: ["04_GAME_ARCHITECTURE", "05_VISUAL_SYSTEM"],
    LEGAL_AND_PRIVACY: ["06_MONETIZATION", "08_STORE_RELEASE"],
  });
  const BUILD_BOUND_GATES = new Set(["PLAYTEST", "RELEASE_CANDIDATE", "LEGAL_AND_PRIVACY", "STORE_SUBMISSION", "PRODUCTION_RELEASE"]);

  function approvalSubject(project, gate) {
    const normalizedGate = cleanText(gate, 80).toUpperCase();
    const summary = artifactSummary(project.id, project.uid);
    const artifactRows = summary.artifacts.slice().sort((a, b) => a.artifactKey.localeCompare(b.artifactKey));
    const artifactSet = artifactRows.map((artifact) => ({
      id: artifact.id, artifactKey: artifact.artifactKey, version: artifact.version,
      sha256: artifact.sha256, size: artifact.size,
    }));
    const artifactByKey = new Map(artifactRows.map((artifact) => [artifact.artifactKey, artifact]));
    const requiredArtifacts = APPROVAL_ARTIFACTS[normalizedGate] || [];
    const missingArtifacts = requiredArtifacts.filter((key) => !artifactByKey.has(key));
    if (missingArtifacts.length) {
      return { ok: false, code: "approval_subject_missing", error: `The ${normalizedGate} subject does not exist yet.`, missingArtifacts };
    }
    const missingSubjectCopies = requiredArtifacts.filter((key) => !artifactByKey.get(key)?.complete);
    if (missingSubjectCopies.length) {
      return { ok: false, code: "approval_artifact_copies_missing", error: `The ${normalizedGate} subject is not durably mirrored yet.`, missing: missingSubjectCopies };
    }

    const activeBuildId = project.activeBuildId || "";
    const build = activeBuildId ? db.prepare("SELECT * FROM game_builds WHERE id=? AND projectId=? AND uid=?").get(activeBuildId, project.id, project.uid) : null;
    if (BUILD_BOUND_GATES.has(normalizedGate) && !build) {
      return { ok: false, code: "approval_build_missing", error: `The ${normalizedGate} decision requires a current immutable build.` };
    }

    const latestTests = new Map();
    for (const row of q.tests.all(project.id, project.uid)) {
      if (row.buildId === activeBuildId && !latestTests.has(row.suite)) latestTests.set(row.suite, row);
    }
    const testSet = [...latestTests.values()].sort((a, b) => a.suite.localeCompare(b.suite)).map((row) => ({
      id: row.id, suite: row.suite, target: row.target, status: row.status, sourceHash: row.sourceHash,
    }));
    const passedSuites = new Set(testSet.filter((row) => row.status === "PASSED" && (!build?.sourceCommit || row.sourceHash === build.sourceCommit)).map((row) => row.suite));
    if (normalizedGate === "PLAYTEST" && passedSuites.size === 0) {
      return { ok: false, code: "approval_tests_missing", error: "Playtest approval requires passing automated evidence for the current build." };
    }
    const qaMissing = QA_REQUIRED_SUITES.filter((suite) => !passedSuites.has(suite));
    if (normalizedGate === "RELEASE_CANDIDATE" && qaMissing.length) {
      return { ok: false, code: "approval_qa_missing", error: "Release-candidate approval requires every QA suite for the current build.", missing: qaMissing };
    }

    const latestReleases = new Map();
    for (const row of q.releases.all(project.id, project.uid)) {
      if (row.buildId === activeBuildId && !latestReleases.has(row.platform)) latestReleases.set(row.platform, row);
    }
    const releaseRows = [...latestReleases.values()].sort((a, b) => a.platform.localeCompare(b.platform));
    const releaseSet = releaseRows.map((row) => ({
      id: row.id, platform: row.platform, packageId: row.packageId, versionName: row.versionName,
      versionCode: row.versionCode, status: row.status, storeLocator: row.storeLocator,
    }));
    const releaseIdentitySet = releaseRows.map((row) => ({
      platform: row.platform, packageId: row.packageId, versionName: row.versionName, versionCode: row.versionCode,
    }));
    const submissionSet = releaseRows.map((row) => ({
      platform: row.platform, submissionReceiptHash: cleanText(parse(row.evidence, {}).submissionReceiptHash, 128).toLowerCase(),
    }));
    if (normalizedGate === "STORE_SUBMISSION" || normalizedGate === "PRODUCTION_RELEASE") {
      if (!summary.complete) {
        return { ok: false, code: "approval_artifact_copies_missing", error: "Every mandatory artifact copy must be verified before this approval.", missing: summary.missing };
      }
      const allowed = normalizedGate === "STORE_SUBMISSION"
        ? new Set(["READY", "UPLOADED", "SUBMITTED", "RELEASED"])
        : new Set(["SUBMITTED", "RELEASED"]);
      const missingPlatforms = ["android", "ios"].filter((platform) => !allowed.has(latestReleases.get(platform)?.status));
      if (missingPlatforms.length) {
        return { ok: false, code: "approval_release_subject_missing", error: `The ${normalizedGate} release subject is incomplete.`, missingPlatforms };
      }
      if (normalizedGate === "PRODUCTION_RELEASE") {
        const missingReceipts = ["android", "ios"].filter((platform) => !/^[a-f0-9]{64}$/.test(
          cleanText(parse(latestReleases.get(platform)?.evidence, {}).submissionReceiptHash, 128).toLowerCase(),
        ));
        if (missingReceipts.length) {
          return { ok: false, code: "approval_submission_receipt_missing", error: "Production approval requires verified submission receipts for both stores.", missingPlatforms: missingReceipts };
        }
      }
    }

    const copyArtifacts = (normalizedGate === "STORE_SUBMISSION" || normalizedGate === "PRODUCTION_RELEASE")
      ? artifactRows
      : artifactRows.filter((artifact) => requiredArtifacts.includes(artifact.artifactKey));
    const copySet = copyArtifacts.length
      ? copyArtifacts.map((artifact) => ({ artifactId: artifact.id, copies: artifact.copies.slice().sort((a, b) => a.backend.localeCompare(b.backend)).map((copy) => ({
        backend: copy.backend, status: copy.status, fingerprint: copy.fingerprint, algorithm: copy.algorithm, verifiedAt: copy.verifiedAt,
      })) }))
      : [];
    const descriptor = {
      gate: normalizedGate, projectId: project.id, policyVersion: project.policyVersion,
      artifactSetHash: requestHash(artifactSet),
      relevantArtifacts: requiredArtifacts.map((key) => artifactByKey.get(key)?.id || ""),
      build: build ? {
        id: build.id, sourceCommit: build.sourceCommit, toolchainHash: requestHash(parse(build.toolchain, {})),
        targetsHash: requestHash(parse(build.targets, [])), versionName: build.versionName, versionCode: build.versionCode,
      } : null,
      testSetHash: BUILD_BOUND_GATES.has(normalizedGate) ? requestHash(testSet) : "",
      releaseSetHash: ["STORE_SUBMISSION", "PRODUCTION_RELEASE"].includes(normalizedGate) ? requestHash(releaseIdentitySet) : "",
      submissionSetHash: normalizedGate === "PRODUCTION_RELEASE" ? requestHash(submissionSet) : "",
      copySetHash: copySet.length ? requestHash(copySet) : "",
    };
    return { ok: true, hash: requestHash(descriptor), descriptor };
  }

  function approvalIsCurrent(rows, gate, project) {
    const subject = approvalSubject(project, gate);
    if (!subject.ok) return false;
    return rows.some((row) => row.gate === gate && row.decision === "APPROVED" && row.invalidatedAt === 0
      && row.buildId === (BUILD_BOUND_GATES.has(gate) ? (project.activeBuildId || "") : "")
      && row.subjectHash === subject.hash);
  }

  function evidenceFor(project) {
    const approvals = q.approvals.all(project.id, project.uid);
    const tests = q.tests.all(project.id, project.uid);
    const releases = q.releases.all(project.id, project.uid);
    const activeBuild = project.activeBuildId || "";
    const build = activeBuild ? db.prepare("SELECT * FROM game_builds WHERE id=? AND projectId=? AND uid=?").get(activeBuild, project.id, project.uid) : null;
    const latestTests = new Map();
    for (const row of tests) if (row.buildId === activeBuild && !latestTests.has(row.suite)) latestTests.set(row.suite, row);
    const boundPassedTests = [...latestTests.values()].filter((row) => row.status === "PASSED"
      && (!build?.sourceCommit || row.sourceHash === build.sourceCommit));
    const passedSuites = new Set(boundPassedTests.map((row) => row.suite));
    const qaMissing = QA_REQUIRED_SUITES.filter((suite) => !passedSuites.has(suite));
    const latestReleases = new Map();
    for (const row of releases) if (row.buildId === activeBuild && !latestReleases.has(row.platform)) latestReleases.set(row.platform, row);
    // READY means the package passed preflight and may be uploaded. DEPLOYED requires evidence
    // that both stores actually released the build; a preflight result must never masquerade as a launch.
    const readyPlatforms = new Set([...latestReleases.values()].filter((row) => row.status === "RELEASED").map((row) => row.platform));
    return {
      automatedTestsPassed: boundPassedTests.length > 0,
      qaReady: !!activeBuild && qaMissing.length === 0,
      qaMissing,
      specificationApproved: approvalIsCurrent(approvals, "SPECIFICATION", project),
      visualSystemApproved: approvalIsCurrent(approvals, "VISUAL_SYSTEM", project),
      playtestApproved: approvalIsCurrent(approvals, "PLAYTEST", project),
      releaseCandidateApproved: approvalIsCurrent(approvals, "RELEASE_CANDIDATE", project),
      legalAndPrivacyApproved: approvalIsCurrent(approvals, "LEGAL_AND_PRIVACY", project),
      storeSubmissionApproved: approvalIsCurrent(approvals, "STORE_SUBMISSION", project),
      productionReleaseApproved: approvalIsCurrent(approvals, "PRODUCTION_RELEASE", project),
      artifactsComplete: artifactSummary(project.id, project.uid).complete,
      releaseReady: !!activeBuild && ["android", "ios"].every((platform) => readyPlatforms.has(platform)),
    };
  }

  function getProject(uid, projectId, { eventLimit = 100 } = {}) {
    const who = cleanUid(uid);
    const row = q.project.get(cleanText(projectId, 180), who);
    if (!row) return null;
    const project = asProject(row);
    const build = q.latestBuild.get(row.id, who);
    const approvals = q.approvals.all(row.id, who).map((a) => ({
      id: a.id, buildId: a.buildId, gate: a.gate, decision: a.decision, approver: a.approver,
      subjectHash: a.subjectHash, rationale: a.rationale, evidence: parse(a.evidence, {}),
      createdAt: a.createdAt, invalidatedAt: a.invalidatedAt,
    }));
    const tests = q.tests.all(row.id, who).map((t) => ({
      id: t.id, buildId: t.buildId, suite: t.suite, target: t.target, status: t.status,
      sourceHash: t.sourceHash, evidence: parse(t.evidence, {}), metrics: parse(t.metrics, {}), createdAt: t.createdAt,
    }));
    const releases = q.releases.all(row.id, who).map((r) => ({
      id: r.id, buildId: r.buildId, platform: r.platform, packageId: r.packageId,
      versionName: r.versionName, versionCode: r.versionCode, status: r.status,
      storeLocator: r.storeLocator, evidence: parse(r.evidence, {}), createdAt: r.createdAt, updatedAt: r.updatedAt,
    }));
    const events = q.events.all(who, row.id, 0, Math.min(Math.max(Number(eventLimit) || 100, 1), 500)).map((e) => ({
      id: e.id, type: e.type, actor: e.actor, causationId: e.causationId,
      correlationId: e.correlationId, payload: parse(e.payload, {}), createdAt: e.createdAt,
    }));
    const approvalSubjects = Object.fromEntries(APPROVAL_GATES.map((gate) => {
      const subject = approvalSubject(row, gate);
      return [gate, subject.ok
        ? { ready: true, hash: subject.hash, descriptor: subject.descriptor }
        : { ready: false, code: subject.code, error: subject.error, missingArtifacts: subject.missingArtifacts || [], missing: subject.missing || [], missingPlatforms: subject.missingPlatforms || [] }];
    }));
    return {
      ...project,
      activeBuild: build ? {
        id: build.id, sourceCommit: build.sourceCommit, toolchain: parse(build.toolchain, {}),
        targets: parse(build.targets, []), status: build.status, versionName: build.versionName,
        versionCode: build.versionCode, createdAt: build.createdAt, updatedAt: build.updatedAt,
      } : null,
      tasks: q.tasks.all(row.id, who, 200).map(asTask),
      ...artifactSummary(row.id, who), approvals, approvalSubjects, tests, releases, events,
      evidence: evidenceFor(row),
    };
  }

  function result(status, body) { return { status, body }; }

  function saveCommand(uid, key, hash, response) {
    q.saveCommand.run(uid, key, hash, response.status, json(response.body), timestamp());
    return response;
  }

  function bump(row) {
    q.projectVersion.run(timestamp(), row.id, row.uid);
    return q.project.get(row.id, row.uid);
  }

  const REVISION_INVALIDATION_STATES = new Set(["PLAYTEST_READY", "RELEASE_CANDIDATE", "APPROVED", "STORE_PREP", "DEPLOYED"]);
  function invalidateMaterialChange(project, reason) {
    const at = timestamp();
    db.prepare("UPDATE game_approvals SET invalidatedAt=? WHERE projectId=? AND uid=? AND invalidatedAt=0").run(at, project.id, project.uid);
    if (REVISION_INVALIDATION_STATES.has(project.state)) {
      db.prepare("UPDATE game_projects SET state='REVISION',resumeState=?,operation='',blocker=?,version=version+1,updatedAt=? WHERE id=? AND uid=?")
        .run(project.state, cleanText(reason, 1000), at, project.id, project.uid);
      emit(project, "project.evidence_invalidated", { from: project.state, to: "REVISION", reason: cleanText(reason, 1000) });
      return true;
    }
    q.projectVersion.run(at, project.id, project.uid);
    return false;
  }

  function createCheckpoint(row, { taskId = "", reason = "", payload = {} } = {}) {
    const at = timestamp();
    const id = "gcp_" + randomUUID();
    const body = { reason, nextState: row.resumeState || row.state, ...payload };
    const build = row.activeBuildId ? db.prepare("SELECT sourceCommit FROM game_builds WHERE id=? AND projectId=? AND uid=?").get(row.activeBuildId, row.id, row.uid) : null;
    db.prepare(`INSERT INTO game_checkpoints (id,projectId,buildId,taskId,uid,state,sourceCommit,payload,compatible,createdAt)
      VALUES (?,?,?,?,?,?,?,?,1,?)`).run(id, row.id, row.activeBuildId || "", taskId, row.uid, row.state, cleanText(build?.sourceCommit, 120), json(body), at);
    emit(row, "checkpoint.created", { id, taskId, state: row.state, reason, payload: body });
    return id;
  }

  function finalizePause(row, reason = "pause requested") {
    const live = q.activeTasks.get(row.id, row.uid).n;
    if (live) return false;
    const current = q.project.get(row.id, row.uid);
    const resumeState = HOLD_STATES.has(current.state) ? current.resumeState : current.state;
    createCheckpoint(current, { reason, payload: { operation: current.operation || "PAUSE_REQUESTED" } });
    db.prepare("UPDATE game_tasks SET status='PAUSED', endedAt=?, workerId='', leaseUntil=0, heartbeatAt=0 WHERE projectId=? AND uid=? AND status IN ('QUEUED','CANCEL_REQUESTED')")
      .run(timestamp(), current.id, current.uid);
    db.prepare("UPDATE game_projects SET state='PAUSED', resumeState=?, operation='PAUSED', blocker='', version=version+1, updatedAt=? WHERE id=? AND uid=?")
      .run(resumeState, timestamp(), current.id, current.uid);
    emit(current, "project.paused", { from: resumeState, reason });
    return true;
  }

  function finalizeStop(row, reason = "stopped by owner") {
    const live = q.activeTasks.get(row.id, row.uid).n;
    if (live) return false;
    const current = q.project.get(row.id, row.uid);
    const resumeState = HOLD_STATES.has(current.state) ? current.resumeState : current.state;
    createCheckpoint(current, { reason, payload: { operation: current.operation || "STOP_REQUESTED" } });
    db.prepare("UPDATE game_tasks SET status='CANCELLED', endedAt=?, workerId='', leaseUntil=0, heartbeatAt=0 WHERE projectId=? AND uid=? AND status IN ('QUEUED','PAUSED','CANCEL_REQUESTED')")
      .run(timestamp(), current.id, current.uid);
    db.prepare("UPDATE game_projects SET state='FAILED', resumeState=?, operation='STOPPED', blocker=?, version=version+1, updatedAt=? WHERE id=? AND uid=?")
      .run(resumeState, reason, timestamp(), current.id, current.uid);
    emit(current, "project.stopped", { from: resumeState, reason });
    return true;
  }

  function executeCommand({ uid, email = "", projectId, key, expectedVersion = null, type, payload = {}, actor = "owner" }) {
    const who = cleanUid(uid);
    const commandKey = normalizeIdempotencyKey(key);
    if (!who) return result(401, { error: "sign in", code: "no_identity" });
    if (!commandKey) return result(400, { error: "An idempotency key is required.", code: "idempotency_required" });
    const request = { projectId, expectedVersion, type, payload };
    const hash = requestHash(request);
    const prior = q.command.get(who, commandKey);
    if (prior) {
      if (prior.requestHash !== hash) return result(409, { error: "That idempotency key was already used for a different command.", code: "idempotency_conflict" });
      return result(prior.status, { ...parse(prior.response, {}), replayed: true });
    }

    return tx(() => {
      const raced = q.command.get(who, commandKey);
      if (raced) {
        if (raced.requestHash !== hash) return result(409, { error: "That idempotency key was already used for a different command.", code: "idempotency_conflict" });
        return result(raced.status, { ...parse(raced.response, {}), replayed: true });
      }
      let row = q.project.get(cleanText(projectId, 180), who);
      if (!row) return saveCommand(who, commandKey, hash, result(404, { error: "No such game.", code: "not_found" }));
      if (expectedVersion != null && Number(expectedVersion) !== row.version) {
        return saveCommand(who, commandKey, hash, result(409, { error: "This game changed in another tab. Refresh before issuing the command.", code: "version_conflict", currentVersion: row.version }));
      }
      const command = cleanText(type, 80).toLowerCase();
      const meta = { actor: cleanText(actor || email || "owner", 160), causationId: commandKey, correlationId: commandKey };
      let response;

      if (command === "advance" || command === "transition") {
        const toState = command === "advance" ? defaultNextState(row.state) : cleanText(payload.toState, 80).toUpperCase();
        if (!toState) response = result(409, { error: "There is no automatic next state from here.", code: "no_next_state" });
        else if (command === "transition" && HOLD_STATES.has(toState)) {
          response = result(409, { error: "Use the dedicated pause, block, stop, or worker-failure path so durable lease and checkpoint semantics cannot be bypassed.", code: "hold_transition_requires_command" });
        }
        else {
          const decision = transitionDecision(row, toState, evidenceFor(row));
          if (!decision.ok) response = result(409, decision);
          else if (decision.noop) response = result(200, { ok: true, project: asProject(row), noop: true });
          else {
            const resumeState = HOLD_STATES.has(toState) ? row.state : "";
            db.prepare("UPDATE game_projects SET state=?, resumeState=?, operation='', blocker='', version=version+1, updatedAt=? WHERE id=? AND uid=?")
              .run(toState, resumeState, timestamp(), row.id, row.uid);
            emit(row, "project.transitioned", { from: row.state, to: toState }, meta);
            row = q.project.get(row.id, row.uid);
            response = result(200, { ok: true, project: asProject(row) });
          }
        }
      } else if (command === "pause") {
        if (row.state === "PAUSED") response = result(200, { ok: true, project: asProject(row), noop: true });
        else if (row.state === "DEPLOYED") response = result(409, { error: "A deployed game cannot be paused; create a revision instead.", code: "deployed" });
        else {
          const active = Number(q.activeTasks.get(row.id, row.uid).n) || 0;
          db.prepare("UPDATE game_projects SET operation='PAUSE_REQUESTED', version=version+1, updatedAt=? WHERE id=? AND uid=?").run(timestamp(), row.id, row.uid);
          db.prepare("UPDATE game_tasks SET cancelRequested=1 WHERE projectId=? AND uid=? AND status='RUNNING'").run(row.id, row.uid);
          emit(row, "project.pause_requested", { activeTasks: active }, meta);
          row = q.project.get(row.id, row.uid);
          if (!active) finalizePause(row);
          row = q.project.get(row.id, row.uid);
          response = result(active ? 202 : 200, { ok: true, project: asProject(row), waitingForSafeBoundary: active > 0 });
        }
      } else if (command === "resume") {
        if (row.state !== "PAUSED") response = result(409, { error: "Only a durably paused game can resume.", code: "not_paused" });
        else {
          const checkpoint = q.latestCheckpoint.get(row.id, row.uid);
          if (!checkpoint) response = result(409, { error: "No compatible checkpoint exists for this game.", code: "checkpoint_required" });
          else if ((checkpoint.buildId || "") !== (row.activeBuildId || "")) response = result(409, { error: "The latest checkpoint belongs to a different build.", code: "checkpoint_build_mismatch" });
          else if (!GAME_STATES.includes(row.resumeState) || HOLD_STATES.has(row.resumeState)) response = result(409, { error: "The checkpoint does not name a resumable lifecycle state.", code: "checkpoint_incompatible" });
          else {
            // Claiming the resumed task creates the new attempt. Incrementing here as well would
            // consume two attempts for one real execution and could exhaust retries without work.
            db.prepare("UPDATE game_tasks SET status='QUEUED', cancelRequested=0, endedAt=0 WHERE projectId=? AND uid=? AND status='PAUSED'").run(row.id, row.uid);
            db.prepare("UPDATE game_projects SET state=?, resumeState='', operation='', blocker='', version=version+1, updatedAt=? WHERE id=? AND uid=?")
              .run(row.resumeState, timestamp(), row.id, row.uid);
            emit(row, "project.resumed", { to: row.resumeState, checkpointId: checkpoint.id }, meta);
            row = q.project.get(row.id, row.uid);
            response = result(200, { ok: true, project: asProject(row), checkpointId: checkpoint.id });
          }
        }
      } else if (command === "stop") {
        if (row.state === "DEPLOYED") response = result(409, { error: "A deployed game cannot be stopped; create a revision instead.", code: "deployed" });
        else {
          const active = Number(q.activeTasks.get(row.id, row.uid).n) || 0;
          db.prepare("UPDATE game_projects SET operation='STOP_REQUESTED', version=version+1, updatedAt=? WHERE id=? AND uid=?").run(timestamp(), row.id, row.uid);
          db.prepare("UPDATE game_tasks SET cancelRequested=1 WHERE projectId=? AND uid=? AND status='RUNNING'").run(row.id, row.uid);
          db.prepare("UPDATE game_tasks SET status='CANCELLED', endedAt=? WHERE projectId=? AND uid=? AND status='QUEUED'").run(timestamp(), row.id, row.uid);
          emit(row, "project.stop_requested", { activeTasks: active }, meta);
          row = q.project.get(row.id, row.uid);
          if (!active) finalizeStop(row);
          row = q.project.get(row.id, row.uid);
          response = result(active ? 202 : 200, { ok: true, project: asProject(row), waitingForSafeBoundary: active > 0 });
        }
      } else if (command === "retry" || command === "unblock") {
        if (!HOLD_STATES.has(row.state) || row.state === "PAUSED") response = result(409, { error: "This game is not failed or blocked.", code: "not_retryable" });
        else {
          const to = GAME_STATES.includes(row.resumeState) && !HOLD_STATES.has(row.resumeState) ? row.resumeState : "REVISION";
          db.prepare("UPDATE game_projects SET state=?, resumeState='', operation='', blocker='', version=version+1, updatedAt=? WHERE id=? AND uid=?")
            .run(to, timestamp(), row.id, row.uid);
          emit(row, "project.retried", { from: row.state, to }, meta);
          row = q.project.get(row.id, row.uid);
          response = result(200, { ok: true, project: asProject(row) });
        }
      } else if (command === "revise") {
        const reason = safeText(payload.reason, 2000);
        if (!reason) response = result(400, { error: "Describe the revision in plain language.", code: "revision_reason_required" });
        else if (row.state === "REVISION") response = result(200, { ok: true, project: asProject(row), noop: true });
        else if (!allowedTransitions(row.state, { resumeState: row.resumeState }).includes("REVISION")) {
          response = result(409, { error: `A revision cannot begin while this game is ${row.state}.`, code: "revision_not_available" });
        } else {
          db.prepare("UPDATE game_approvals SET invalidatedAt=? WHERE projectId=? AND uid=? AND invalidatedAt=0").run(timestamp(), row.id, row.uid);
          db.prepare("UPDATE game_projects SET state='REVISION',resumeState=?,operation='',blocker=?,version=version+1,updatedAt=? WHERE id=? AND uid=?")
            .run(row.state, `Revision requested: ${reason}`, timestamp(), row.id, row.uid);
          emit(row, "project.revision_requested", { from: row.state, to: "REVISION", reason }, meta);
          row = q.project.get(row.id, row.uid);
          response = result(200, { ok: true, project: asProject(row) });
        }
      } else if (command === "block") {
        const reason = safeText(payload.reason, 1000) || "Blocked pending owner or platform action.";
        if (row.state !== "BLOCKED") {
          db.prepare("UPDATE game_projects SET state='BLOCKED', resumeState=?, operation='', blocker=?, version=version+1, updatedAt=? WHERE id=? AND uid=?")
            .run(row.state, reason, timestamp(), row.id, row.uid);
          emit(row, "project.blocked", { from: row.state, reason }, meta);
          row = q.project.get(row.id, row.uid);
        }
        response = result(200, { ok: true, project: asProject(row) });
      } else if (command === "attach_workspace") {
        const workspaceId = cleanText(payload.workspaceId, 180);
        const workspaceRoot = cleanText(payload.workspaceRoot, 600);
        if (!workspaceId && !workspaceRoot) response = result(400, { error: "Choose a workspace or provide its root.", code: "workspace_required" });
        else if (safeText(workspaceId, 180) !== workspaceId || safeText(workspaceRoot, 600) !== workspaceRoot) response = result(400, { error: "Workspace identifiers cannot contain credential material.", code: "workspace_contains_secret" });
        else {
          db.prepare("UPDATE game_projects SET workspaceId=?, workspaceRoot=?, version=version+1, updatedAt=? WHERE id=? AND uid=?")
            .run(workspaceId, workspaceRoot, timestamp(), row.id, row.uid);
          emit(row, "project.workspace_attached", { workspaceId, workspaceRoot }, meta);
          row = q.project.get(row.id, row.uid);
          response = result(200, { ok: true, project: asProject(row) });
        }
      } else if (command === "approve" || command === "reject") {
        const gate = cleanText(payload.gate, 80).toUpperCase();
        if (!APPROVAL_GATES.includes(gate)) response = result(400, { error: "Unknown approval gate.", code: "bad_gate" });
        else if (!approvalAllowed(row.state, gate)) response = result(409, { error: `The ${gate} decision is not available while this game is ${row.state}.`, code: "gate_not_available" });
        else {
          const subject = approvalSubject(row, gate);
          const suppliedHash = cleanText(payload.subjectHash, 128).toLowerCase();
          if (!subject.ok) response = result(409, subject);
          else if (suppliedHash && suppliedHash !== subject.hash) {
            response = result(409, { error: "The approval subject changed. Refresh and review the current evidence.", code: "approval_subject_changed", subjectHash: subject.hash });
          } else {
            const decision = command === "approve" ? "APPROVED" : "REJECTED";
            db.prepare("UPDATE game_approvals SET invalidatedAt=? WHERE projectId=? AND uid=? AND gate=? AND invalidatedAt=0")
              .run(timestamp(), row.id, row.uid, gate);
            const id = "gap_" + randomUUID();
            const boundBuildId = BUILD_BOUND_GATES.has(gate) ? (row.activeBuildId || "") : "";
            db.prepare(`INSERT INTO game_approvals (id,projectId,buildId,uid,gate,decision,approver,subjectHash,rationale,evidence,createdAt)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, row.id, boundBuildId, row.uid, gate, decision,
              safeText(actor || email || "owner", 320), subject.hash, safeText(payload.rationale, 2000),
              json({ ownerEvidence: payload.evidence || {}, subject: subject.descriptor }), timestamp());
            emit(row, "approval.recorded", { id, gate, decision, buildId: boundBuildId, subjectHash: subject.hash }, meta);
            if (decision === "REJECTED" && !HOLD_STATES.has(row.state) && row.state !== "IDEA") {
              db.prepare("UPDATE game_projects SET state='REVISION', resumeState=?, operation='', blocker=?, version=version+1, updatedAt=? WHERE id=? AND uid=?")
                .run(row.state, `${gate} was rejected.`, timestamp(), row.id, row.uid);
            } else row = bump(row);
            row = q.project.get(row.id, row.uid);
            response = result(200, { ok: true, approvalId: id, subjectHash: subject.hash, project: asProject(row) });
          }
        }
      } else {
        response = result(400, { error: "Unknown factory command.", code: "bad_command" });
      }
      return saveCommand(who, commandKey, hash, response);
    });
  }

  function createBuild({ uid, projectId, sourceCommit = "", toolchain = {}, targets = ["android", "ios"], versionName = "", versionCode = 0 }) {
    const who = cleanUid(uid);
    return tx(() => {
      const project = q.project.get(projectId, who);
      if (!project) return result(404, { error: "No such game.", code: "not_found" });
      if (HOLD_STATES.has(project.state) || project.state === "DEPLOYED" || project.operation) {
        return result(409, { error: "A new build cannot replace the resumable subject while the game is held, deployed, or stopping.", code: "project_not_runnable" });
      }
      const id = "gfb_" + randomUUID();
      const at = timestamp();
      db.prepare(`INSERT INTO game_builds (id,projectId,uid,sourceCommit,toolchain,targets,status,versionName,versionCode,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,'PLANNED',?,?,?,?)`).run(id, project.id, who, safeText(sourceCommit, 120), json(toolchain), json(targets), cleanText(versionName, 80), Number(versionCode) || 0, at, at);
      db.prepare("UPDATE game_checkpoints SET compatible=0 WHERE projectId=? AND uid=? AND compatible=1").run(project.id, who);
      db.prepare("UPDATE game_projects SET activeBuildId=?, updatedAt=? WHERE id=? AND uid=?").run(id, at, project.id, who);
      invalidateMaterialChange(project, "A new build invalidated evidence and approvals for the prior build.");
      emit(project, "build.created", { id, sourceCommit, targets });
      return result(201, { ok: true, buildId: id });
    });
  }

  function queueTask({ uid, projectId, buildId = "", capability, title, payload = {}, acceptance = [], priority = 0, safeToRetry = false, maxAttempts = 3 }) {
    const who = cleanUid(uid);
    const cap = cleanText(capability, 100);
    if (!TASK_CAPABILITIES.includes(cap)) return result(400, { error: "Unknown worker capability.", code: "bad_capability" });
    return tx(() => {
      const project = q.project.get(projectId, who);
      if (!project) return result(404, { error: "No such game.", code: "not_found" });
      if (HOLD_STATES.has(project.state) || project.state === "DEPLOYED" || project.operation) return result(409, { error: "This game is not accepting new work.", code: "project_not_runnable" });
      const boundBuildId = cleanText(buildId || project.activeBuildId, 240);
      if (boundBuildId && !db.prepare("SELECT 1 AS ok FROM game_builds WHERE id=? AND projectId=? AND uid=?").get(boundBuildId, project.id, who)) {
        return result(400, { error: "The task build does not belong to this game and tenant.", code: "bad_build" });
      }
      const id = "gft_" + randomUUID();
      const at = timestamp();
      db.prepare(`INSERT INTO game_tasks
        (id,projectId,buildId,uid,capability,title,payload,acceptance,status,priority,maxAttempts,safeToRetry,createdAt)
        VALUES (?,?,?,?,?,?,?,?, 'QUEUED',?,?,?,?)`).run(id, project.id, boundBuildId, who, cap,
        safeText(title, 240) || cap, json(payload), json(acceptance), Number(priority) || 0,
        Math.min(Math.max(Number(maxAttempts) || 3, 1), 10), safeToRetry ? 1 : 0, at);
      emit(project, "task.queued", { id, capability: cap, title: safeText(title, 240), safeToRetry: !!safeToRetry });
      return result(201, { ok: true, taskId: id });
    });
  }

  /*
   * This is deliberately not a configurable queueTask wrapper. The only caller-controlled values
   * are tenant/project identity and a replay key; executable, argv, cwd, capability, build binding,
   * artifact collection and retry policy are immutable server code. The command-idempotency row and
   * task/event inserts share one SQLite transaction, so a retry cannot create a second execution.
   */
  function queueSyntheticCanary({ uid, projectId, key, actor = "owner" } = {}) {
    const who = cleanUid(uid);
    if (!who) return result(401, { error: "sign in", code: "no_identity" });
    const rawProjectId = String(projectId == null ? "" : projectId);
    const exactProjectId = rawProjectId.trim();
    if (rawProjectId !== exactProjectId || !/^gf_[a-z0-9_-]{3,160}$/.test(exactProjectId)) {
      return result(400, { error: "A valid existing factory project is required.", code: "bad_project_id" });
    }
    const rawKey = String(key == null ? "" : key);
    const commandKeyPart = rawKey.trim();
    if (rawKey !== commandKeyPart || commandKeyPart.length < 16 || commandKeyPart.length > 128
        || !/^[A-Za-z0-9._:-]+$/.test(commandKeyPart) || normalizeIdempotencyKey(commandKeyPart) !== commandKeyPart) {
      return result(400, { error: "A 16-128 character canary idempotency key is required.", code: "bad_idempotency_key" });
    }
    const commandKey = `synthetic-canary:${commandKeyPart}`;
    const hash = requestHash({ schema: SYNTHETIC_CANARY_SCHEMA, projectId: exactProjectId });
    const fingerprint = createHash("sha256").update(commandKeyPart).digest("hex");
    const prior = q.command.get(who, commandKey);
    if (prior) {
      if (prior.requestHash !== hash) return result(409, { error: "That canary idempotency key was already used for a different project.", code: "idempotency_conflict" });
      return result(prior.status, { ...parse(prior.response, {}), replayed: true });
    }

    return tx(() => {
      const raced = q.command.get(who, commandKey);
      if (raced) {
        if (raced.requestHash !== hash) return result(409, { error: "That canary idempotency key was already used for a different project.", code: "idempotency_conflict" });
        return result(raced.status, { ...parse(raced.response, {}), replayed: true });
      }
      const project = q.project.get(exactProjectId, who);
      if (!project) return saveCommand(who, commandKey, hash, result(404, { error: "No such game.", code: "not_found" }));
      if (HOLD_STATES.has(project.state) || project.state === "DEPLOYED" || project.operation) {
        return saveCommand(who, commandKey, hash, result(409, { error: "This game is not accepting a synthetic canary.", code: "project_not_runnable" }));
      }
      const activeCanary = db.prepare(`SELECT * FROM game_tasks
        WHERE uid=? AND status IN ('QUEUED','RUNNING') AND capability=? AND title=? AND buildId=''`).all(
        who, SYNTHETIC_CANARY_CAPABILITY, SYNTHETIC_CANARY_TITLE,
      ).find(isSyntheticCanaryTask);
      if (activeCanary) {
        return saveCommand(who, commandKey, hash, result(409, {
          error: "A synthetic canary is already queued or running for this tenant.",
          code: "synthetic_canary_in_progress", taskId: activeCanary.id,
        }));
      }
      const recipe = syntheticCanaryRecipe();
      const id = `gft_canary_${requestHash({ who, commandKey, projectId: project.id }).slice(0, 32)}`;
      const at = timestamp();
      db.prepare(`INSERT INTO game_tasks
        (id,projectId,buildId,uid,capability,title,payload,acceptance,status,priority,maxAttempts,safeToRetry,createdAt)
        VALUES (?,?, '',?,?,?,?,?, 'QUEUED',1000,?,1,?)`).run(id, project.id, who,
        SYNTHETIC_CANARY_CAPABILITY, SYNTHETIC_CANARY_TITLE, json(recipe.payload), json(recipe.acceptance),
        SYNTHETIC_CANARY_MAX_ATTEMPTS, at);
      const eventId = emit(project, "synthetic_canary.queued", {
        schema: SYNTHETIC_CANARY_SCHEMA, taskId: id, capability: SYNTHETIC_CANARY_CAPABILITY,
        idempotencyFingerprint: fingerprint,
        effects: { qaEvidence: false, artifacts: false, mirrors: false, storeSubmission: false, release: false },
      }, { actor: safeText(actor, 160) || "owner", causationId: `canary:${fingerprint}`, correlationId: `canary:${fingerprint}` });
      return saveCommand(who, commandKey, hash, result(201, {
        ok: true, schema: SYNTHETIC_CANARY_SCHEMA, projectId: project.id, taskId: id,
        capability: SYNTHETIC_CANARY_CAPABILITY,
        audit: { eventId, idempotencyFingerprint: fingerprint },
        effects: { qaEvidence: false, artifacts: false, mirrors: false, storeSubmission: false, release: false },
      }));
    });
  }

  function claimNextTask({ workerId, capability = "", leaseMs = 120000 } = {}) {
    const worker = safeText(workerId, 160);
    if (!worker) return null;
    return tx(() => {
      const task = q.queued.get(cleanText(capability, 100), cleanText(capability, 100));
      if (!task) return null;
      const at = timestamp();
      const leaseUntil = at + Math.min(Math.max(Number(leaseMs) || 120000, 15000), 15 * 60 * 1000);
      const r = db.prepare("UPDATE game_tasks SET status='RUNNING', workerId=?, leaseUntil=?, heartbeatAt=?, startedAt=CASE WHEN startedAt=0 THEN ? ELSE startedAt END, attempt=attempt+1 WHERE id=? AND uid=? AND status='QUEUED'")
        .run(worker, leaseUntil, at, at, task.id, task.uid);
      if (!r.changes) return null;
      const project = q.project.get(task.projectId, task.uid);
      emit(project, "task.claimed", { taskId: task.id, workerId: worker, leaseUntil, attempt: task.attempt + 1 });
      return asTask(q.task.get(task.id, task.uid));
    });
  }

  function heartbeatTask({ uid, taskId, workerId, attempt = 0, leaseMs = 120000 }) {
    const who = cleanUid(uid), worker = safeText(workerId, 160);
    return tx(() => {
      const task = q.task.get(taskId, who);
      if (!task) return result(404, { error: "No such task.", code: "not_found" });
      if (Number(attempt) !== task.attempt) return result(409, { error: "This task attempt is no longer current.", code: "attempt_lost" });
      if (task.status !== "RUNNING" || task.workerId !== worker) return result(409, { error: "This worker no longer owns the task lease.", code: "lease_lost" });
      const at = timestamp();
      const leaseUntil = at + Math.min(Math.max(Number(leaseMs) || 120000, 15000), 15 * 60 * 1000);
      db.prepare("UPDATE game_tasks SET heartbeatAt=?, leaseUntil=? WHERE id=? AND uid=?").run(at, leaseUntil, task.id, who);
      return result(200, { ok: true, leaseUntil, stopRequested: !!task.cancelRequested });
    });
  }

  function completeTask({ uid, taskId, workerId, attempt = 0, result: taskResult = {}, checkpoint = null }) {
    const who = cleanUid(uid), worker = safeText(workerId, 160);
    return tx(() => {
      const task = q.task.get(taskId, who);
      if (!task) return result(404, { error: "No such task.", code: "not_found" });
      if (Number(attempt) !== task.attempt) return result(409, { error: "This task attempt is no longer current.", code: "attempt_lost" });
      if (task.status !== "RUNNING" || task.workerId !== worker) return result(409, { error: "This worker no longer owns the task lease.", code: "lease_lost" });
      const project = q.project.get(task.projectId, who);
      const at = timestamp();
      const syntheticCanary = isSyntheticCanaryTask(task);
      // A pause request may race with a worker that already crossed its final boundary. Preserve
      // that terminal success instead of re-queuing completed work on resume (which would execute
      // the same effect twice). PAUSED/CANCELLED remote truth still checkpoints and resumes safely.
      const terminalSuccess = ["SUCCEEDED", "COMPLETED"].includes(cleanText(taskResult?.status, 40).toUpperCase());
      const stopped = !!task.cancelRequested && !terminalSuccess;
      const ownerStopped = stopped && project.operation === "STOP_REQUESTED";
      db.prepare("UPDATE game_tasks SET status=?, result=?, endedAt=?, workerId='', leaseUntil=0, heartbeatAt=0 WHERE id=? AND uid=?")
        .run(ownerStopped ? "CANCELLED" : stopped ? "PAUSED" : "COMPLETED", json(taskResult), at, task.id, who);
      // A successful canary is observability, not resumable game progress. Ignore its ordinary
      // worker checkpoint so it cannot replace the project's latest compatible build checkpoint.
      // A concurrent owner pause/stop still needs a real safe-boundary checkpoint.
      if ((!syntheticCanary && checkpoint) || stopped || (task.cancelRequested && terminalSuccess)) createCheckpoint(project, {
        taskId: task.id,
        reason: stopped ? "worker reached a requested safe boundary" : task.cancelRequested ? "worker completed before the owner operation took effect" : "task checkpoint",
        payload: checkpoint || taskResult,
      });
      emit(project, ownerStopped ? "task.cancelled" : stopped ? "task.paused" : syntheticCanary ? "synthetic_canary.completed" : "task.completed", {
        taskId: task.id, result: taskResult,
        ...(syntheticCanary ? { schema: SYNTHETIC_CANARY_SCHEMA, evidenceEffects: "none" } : {}),
      });
      let finalized = false;
      const current = q.project.get(project.id, who);
      if (current.operation === "PAUSE_REQUESTED") finalized = finalizePause(current, "worker reached a safe boundary");
      else if (current.operation === "STOP_REQUESTED") finalized = finalizeStop(current, "worker reached a stop boundary");
      return result(200, { ok: true, paused: stopped, projectFinalized: finalized });
    });
  }

  function failTask({ uid, taskId, workerId = "", attempt = 0, error = "task failed", retryable = false }) {
    const who = cleanUid(uid), worker = safeText(workerId, 160);
    return tx(() => {
      const task = q.task.get(taskId, who);
      if (!task) return result(404, { error: "No such task.", code: "not_found" });
      if (Number(attempt) !== task.attempt) return result(409, { error: "This task attempt is no longer current.", code: "attempt_lost" });
      if (task.status !== "RUNNING" || !worker || task.workerId !== worker) return result(409, { error: "This worker no longer owns the task lease.", code: "lease_lost" });
      const project = q.project.get(task.projectId, who);
      const ownerOperation = !!task.cancelRequested && ["PAUSE_REQUESTED", "STOP_REQUESTED"].includes(project.operation);
      if (ownerOperation) {
        const requested = project.operation === "PAUSE_REQUESTED" ? "pause" : "stop";
        const blocker = `The worker failed before the requested ${requested} reached a confirmed safe boundary.`;
        db.prepare("UPDATE game_tasks SET status='FAILED', result=?, endedAt=?, workerId='', leaseUntil=0, heartbeatAt=0 WHERE id=? AND uid=?")
          .run(json({ error: safeText(error, 3000), ownerOperationUnconfirmed: true }), timestamp(), task.id, who);
        emit(project, "task.failed", { taskId: task.id, error: safeText(error, 3000), retryable: false, ownerOperationUnconfirmed: true });
        const resumeState = HOLD_STATES.has(project.state) ? project.resumeState : project.state;
        db.prepare("UPDATE game_projects SET state='BLOCKED', resumeState=?, operation='', blocker=?, version=version+1, updatedAt=? WHERE id=? AND uid=?")
          .run(resumeState, blocker, timestamp(), project.id, who);
        emit(project, `project.${requested}_unconfirmed`, { taskId: task.id, reason: blocker });
        return result(200, { ok: true, requeued: false, blocked: true });
      }
      const mayRetry = retryable && !!task.safeToRetry && task.attempt < task.maxAttempts;
      const syntheticCanary = isSyntheticCanaryTask(task);
      db.prepare("UPDATE game_tasks SET status=?, result=?, endedAt=?, workerId='', leaseUntil=0, heartbeatAt=0 WHERE id=? AND uid=?")
        .run(mayRetry ? "QUEUED" : "FAILED", json({ error: safeText(error, 3000) }), mayRetry ? 0 : timestamp(), task.id, who);
      emit(project, syntheticCanary ? (mayRetry ? "synthetic_canary.requeued" : "synthetic_canary.failed")
        : (mayRetry ? "task.requeued" : "task.failed"), {
        taskId: task.id, error: safeText(error, 3000), retryable: mayRetry,
        ...(syntheticCanary ? { schema: SYNTHETIC_CANARY_SCHEMA, projectLifecycleUnaffected: !mayRetry } : {}),
      });
      if (!mayRetry && !syntheticCanary) {
        const resumeState = HOLD_STATES.has(project.state) ? project.resumeState : project.state;
        db.prepare("UPDATE game_projects SET state='FAILED', resumeState=?, operation='', blocker=?, version=version+1, updatedAt=? WHERE id=? AND uid=?")
          .run(resumeState, safeText(error, 1000), timestamp(), project.id, who);
      }
      return result(200, { ok: true, requeued: mayRetry, ...(syntheticCanary ? { syntheticCanary: true, projectLifecycleUnaffected: !mayRetry } : {}) });
    });
  }

  /*
   * Isolation-proof loss is stronger than an ordinary worker failure. It is an absorbing stop for
   * the exact task attempt and is allowed to correct a stale completion that raced the security
   * latch. SQLite serializes this transaction with completeTask(): if the security stop wins first,
   * completion loses its RUNNING lease; if completion wins first, this method marks it FAILED and
   * invalidates every checkpoint that completion could have created.
   */
  function securityStopTask({ uid, taskId, attempt = 0, error = "worker isolation proof was lost" } = {}) {
    const who = cleanUid(uid);
    const reason = safeText(error, 3000) || "worker isolation proof was lost";
    return tx(() => {
      const task = q.task.get(taskId, who);
      if (!task) return result(404, { error: "No such task.", code: "not_found" });
      if (Number(attempt) !== task.attempt) {
        return result(409, { error: "This task attempt is no longer current.", code: "attempt_lost" });
      }
      const priorResult = parse(task.result, {});
      if (priorResult?.securityStopped === true) {
        return result(200, {
          ok: true, securityStopped: true, replayed: true,
          invalidatedCheckpoints: Number(priorResult.invalidatedCheckpoints) || 0,
          syntheticCanary: priorResult.syntheticCanary === true,
          projectLifecycleUnaffected: priorResult.projectLifecycleUnaffected === true,
        });
      }

      const project = q.project.get(task.projectId, who);
      if (!project) return result(404, { error: "No such game.", code: "not_found" });
      const syntheticCanary = isSyntheticCanaryTask(task);
      const at = timestamp();
      // A stale completeTask writes task.endedAt before its task-specific and owner-operation
      // checkpoints. Invalidating from that timestamp also removes the generic PAUSED checkpoint
      // that finalizePause may have appended after the unsafe completion.
      const staleCompletionAt = Number(task.endedAt) || 0;
      const invalidated = db.prepare(`UPDATE game_checkpoints SET compatible=0
        WHERE projectId=? AND uid=? AND compatible=1
          AND (taskId=? OR (? > 0 AND createdAt>=?))`)
        .run(project.id, who, task.id, staleCompletionAt, staleCompletionAt).changes;
      const pauseUnconfirmed = task.cancelRequested
        && (project.operation === "PAUSE_REQUESTED" || project.operation === "PAUSED" || project.state === "PAUSED");
      const stopUnconfirmed = task.cancelRequested
        && (project.operation === "STOP_REQUESTED" || project.operation === "STOPPED");
      const ownerOperationUnconfirmed = pauseUnconfirmed || stopUnconfirmed;
      const projectLifecycleUnaffected = syntheticCanary && !ownerOperationUnconfirmed;
      const securityResult = {
        error: reason,
        securityStopped: true,
        invalidatedCheckpoints: Number(invalidated) || 0,
        syntheticCanary,
        projectLifecycleUnaffected,
      };
      db.prepare(`UPDATE game_tasks SET status='FAILED',result=?,endedAt=?,workerId='',leaseUntil=0,
        heartbeatAt=0,cancelRequested=0 WHERE id=? AND uid=? AND attempt=?`)
        .run(json(securityResult), at, task.id, who, task.attempt);
      emit(project, syntheticCanary ? "synthetic_canary.security_stopped" : "task.security_stopped", {
        taskId: task.id, attempt: task.attempt, reason,
        invalidatedCheckpoints: Number(invalidated) || 0,
        projectLifecycleUnaffected,
        ...(syntheticCanary ? { schema: SYNTHETIC_CANARY_SCHEMA } : {}),
      });

      if (ownerOperationUnconfirmed) {
        const requested = pauseUnconfirmed ? "pause" : "stop";
        const blocker = `The worker lost its isolation proof before the requested ${requested} reached a confirmed safe boundary.`;
        const resumeState = HOLD_STATES.has(project.state) ? project.resumeState : project.state;
        db.prepare("UPDATE game_projects SET state='BLOCKED',resumeState=?,operation='',blocker=?,version=version+1,updatedAt=? WHERE id=? AND uid=?")
          .run(resumeState, blocker, at, project.id, who);
        emit(project, `project.${requested}_unconfirmed`, { taskId: task.id, reason: blocker, securityStop: true });
      } else if (!syntheticCanary) {
        const resumeState = HOLD_STATES.has(project.state) ? project.resumeState : project.state;
        db.prepare("UPDATE game_projects SET state='FAILED',resumeState=?,operation='',blocker=?,version=version+1,updatedAt=? WHERE id=? AND uid=?")
          .run(resumeState, reason, at, project.id, who);
        emit(project, "project.security_stopped", { taskId: task.id, reason });
      }
      return result(200, {
        ok: true, securityStopped: true, invalidatedCheckpoints: Number(invalidated) || 0,
        syntheticCanary, projectLifecycleUnaffected,
      });
    });
  }

  function recordArtifact({ uid, projectId, artifactKey, sha256, size = 0, mimeType = "application/octet-stream", provenance = {} }) {
    const who = cleanUid(uid), key = cleanText(artifactKey, 120).toUpperCase();
    const hash = cleanText(sha256, 128).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) return result(400, { error: "A full SHA-256 fingerprint is required.", code: "bad_hash" });
    return tx(() => {
      const project = q.project.get(projectId, who);
      if (!project) return result(404, { error: "No such game.", code: "not_found" });
      const prior = db.prepare("SELECT MAX(version) AS version FROM game_artifacts WHERE projectId=? AND artifactKey=?").get(project.id, key);
      const version = (Number(prior && prior.version) || 0) + 1;
      const id = "gfa_" + randomUUID();
      db.prepare(`INSERT INTO game_artifacts (id,projectId,uid,artifactKey,version,sha256,size,mimeType,provenance,createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, project.id, who, key, version, hash, Math.max(Number(size) || 0, 0), cleanText(mimeType, 160), json(provenance), timestamp());
      invalidateMaterialChange(project, `A new ${key} artifact version invalidated dependent evidence and approvals.`);
      emit(project, "artifact.version_created", { id, artifactKey: key, version, sha256: hash });
      return result(201, { ok: true, artifactId: id, version });
    });
  }

  function nativeEvidencePrerequisites(artifact) {
    const copies = q.copies.all(artifact.id);
    const verified = (backend) => copies.some((copy) => copy.backend === backend && copy.status === "VERIFIED"
      && copy.algorithm === "sha256" && copy.fingerprint === artifact.sha256);
    return ["primary", "google_drive"].filter((backend) => !verified(backend));
  }

  function currentArtifactRow(artifact) {
    return db.prepare("SELECT * FROM game_artifacts WHERE projectId=? AND artifactKey=? ORDER BY version DESC LIMIT 1")
      .get(artifact.projectId, artifact.artifactKey);
  }

  function nativeEvidenceTimeFailure({ artifact, bound, kind, at, state }) {
    const observedAt = Date.parse(kind === NATIVE_PROJECT_API_VERIFIED_STATUS ? bound.verifiedAt : bound.observedAt);
    if (!Number.isFinite(observedAt)) {
      return result(400, { error: "The native Project evidence timestamp is invalid.", code: "bad_native_project_manifest" });
    }
    if (observedAt < Number(artifact.createdAt)) {
      return result(409, { error: "Native Project evidence cannot predate the immutable artifact it claims to observe.", code: "native_project_evidence_before_artifact" });
    }
    if (observedAt > at + NATIVE_PROJECT_EVIDENCE_CLOCK_SKEW_MS) {
      return result(409, { error: "Native Project evidence cannot be recorded with a future observation timestamp.", code: "native_project_evidence_in_future" });
    }
    if ((state.lastObservedAt !== null && observedAt <= state.lastObservedAt)
        || (state.lastCreatedAt !== null && at < state.lastCreatedAt)) {
      return result(409, { error: "Native Project evidence must advance the append-only artifact chronology.", code: "native_project_evidence_not_monotonic" });
    }
    return null;
  }

  function appendNativeProjectEvidence({ uid, artifactId, manifest, kind }) {
    const who = cleanUid(uid);
    const at = nativeEvidenceTimestamp();
    if (at === null) return nativeEvidenceClockFailure();
    return tx(() => {
      const artifact = db.prepare("SELECT * FROM game_artifacts WHERE id=? AND uid=?").get(cleanText(artifactId, 180), who);
      if (!artifact) return result(404, { error: "No such artifact.", code: "not_found" });
      const current = currentArtifactRow(artifact);
      if (!current || current.id !== artifact.id) {
        return result(409, { error: "Native Project evidence can only bind the current immutable artifact version.", code: "native_project_artifact_not_current" });
      }
      const missingPrerequisites = nativeEvidencePrerequisites(artifact);
      if (missingPrerequisites.length) {
        const backend = missingPrerequisites[0];
        return result(409, {
          error: `The exact current ${backend === "primary" ? "primary" : "Google Drive"} copy must be SHA-256 verified before native Project evidence can be recorded.`,
          code: backend === "primary" ? "native_project_primary_unverified" : "native_project_drive_unverified",
          missing: missingPrerequisites,
        });
      }
      let bound;
      try {
        bound = kind === NATIVE_PROJECT_OWNER_ATTESTED_STATUS
          ? normalizeOwnerAttestedNativeProjectManifest(manifest, nativeEvidenceArtifact(artifact))
          : normalizeNativeApiProjectManifest(manifest, nativeEvidenceArtifact(artifact));
      } catch (error) {
        return result(400, { error: safeText(error?.message || "Invalid native Project evidence.", 1000), code: cleanText(error?.code || "bad_native_project_manifest", 120) });
      }
      const existing = db.prepare("SELECT * FROM game_artifact_native_evidence WHERE artifactId=? AND kind=? AND manifestHash=?")
        .get(artifact.id, kind, bound.manifestHash);
      if (existing) {
        const projection = nativeEvidenceState(artifact, q.copies.all(artifact.id).filter((copy) => copy.backend === "chatgpt_project")).copy;
        if (projection.status === "EVIDENCE_CORRUPT") {
          return result(409, { error: "Existing native Project evidence is malformed or internally inconsistent.", code: "native_project_evidence_unresolved" });
        }
        return result(200, {
          ok: projection.id === existing.id && nativeProjectEvidenceCanComplete(projection, nativeEvidenceArtifact(artifact)),
          replayed: true, evidenceId: existing.id,
          status: projection.status, manifestHash: bound.manifestHash,
        });
      }
      const state = nativeEvidenceState(artifact, q.copies.all(artifact.id).filter((copy) => copy.backend === "chatgpt_project"));
      const projection = state.copy;
      if (projection.status === "EVIDENCE_CORRUPT" || projection.status === "AMBIGUOUS") {
        return result(409, { error: "Existing native Project evidence is not unambiguous and valid.", code: "native_project_evidence_unresolved" });
      }
      if (nativeProjectEvidenceCanComplete(projection, nativeEvidenceArtifact(artifact))) {
        return result(409, { error: "A different native Project evidence record is already active; record an append-only invalidation before replacing it.", code: "native_project_evidence_already_active" });
      }
      const timeFailure = nativeEvidenceTimeFailure({ artifact, bound, kind, at, state });
      if (timeFailure) return timeFailure;
      const project = q.project.get(artifact.projectId, who);
      if (!project) return result(404, { error: "No such game.", code: "not_found" });
      const id = "gfn_" + randomUUID();
      const operator = kind === NATIVE_PROJECT_OWNER_ATTESTED_STATUS ? bound.operator : "";
      const browserEvidenceRef = kind === NATIVE_PROJECT_OWNER_ATTESTED_STATUS ? bound.browserEvidenceRef : "";
      db.prepare(`INSERT INTO game_artifact_native_evidence
        (id,artifactId,projectId,uid,kind,targetEvidenceId,nativeProjectId,fingerprint,size,operator,browserEvidenceRef,manifestHash,manifest,createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, artifact.id, artifact.projectId, who, kind, "", LOCKED_NATIVE_CHATGPT_PROJECT_ID,
        artifact.sha256, artifact.size, operator, browserEvidenceRef, bound.manifestHash, json(bound), at,
      );
      bump(project);
      emit(project, "artifact.native_project_evidence_recorded", {
        artifactId: artifact.id, evidenceId: id, status: kind, provenance: kind === NATIVE_PROJECT_OWNER_ATTESTED_STATUS ? "OWNER_ATTESTED_BROWSER_UPLOAD" : "NATIVE_API_VERIFIED",
        manifestHash: bound.manifestHash,
      }, { actor: operator || "native-project-api" });
      return result(201, { ok: true, evidenceId: id, status: kind, manifestHash: bound.manifestHash });
    });
  }

  function recordOwnerAttestedNativeProjectEvidence({ uid, artifactId, manifest } = {}) {
    return appendNativeProjectEvidence({ uid, artifactId, manifest, kind: NATIVE_PROJECT_OWNER_ATTESTED_STATUS });
  }

  function invalidateNativeProjectEvidence({ uid, artifactId, manifest } = {}) {
    const who = cleanUid(uid);
    const at = nativeEvidenceTimestamp();
    if (at === null) return nativeEvidenceClockFailure();
    return tx(() => {
      const artifact = db.prepare("SELECT * FROM game_artifacts WHERE id=? AND uid=?").get(cleanText(artifactId, 180), who);
      if (!artifact) return result(404, { error: "No such artifact.", code: "not_found" });
      let bound;
      try { bound = normalizeNativeProjectInvalidationManifest(manifest); }
      catch (error) { return result(400, { error: safeText(error?.message || "Invalid native Project invalidation.", 1000), code: cleanText(error?.code || "bad_native_project_invalidation", 120) }); }
      const state = nativeEvidenceState(artifact, q.copies.all(artifact.id).filter((copy) => copy.backend === "chatgpt_project"));
      if (state.copy.status === "EVIDENCE_CORRUPT") {
        return result(409, { error: "Existing native Project evidence is malformed or internally inconsistent.", code: "native_project_evidence_unresolved" });
      }
      const existing = db.prepare("SELECT * FROM game_artifact_native_evidence WHERE artifactId=? AND kind='INVALIDATED' AND manifestHash=?")
        .get(artifact.id, bound.manifestHash);
      if (existing) return result(200, { ok: true, replayed: true, evidenceId: existing.id, status: "INVALIDATED", manifestHash: bound.manifestHash });
      const target = q.nativeEvidenceById.get(bound.evidenceId);
      if (!target || target.artifactId !== artifact.id || target.projectId !== artifact.projectId || target.uid !== who
          || ![NATIVE_PROJECT_OWNER_ATTESTED_STATUS, NATIVE_PROJECT_API_VERIFIED_STATUS].includes(target.kind)) {
        return result(404, { error: "The native Project evidence to invalidate does not belong to this exact artifact.", code: "native_project_evidence_not_found" });
      }
      const priorInvalidation = db.prepare("SELECT id FROM game_artifact_native_evidence WHERE kind='INVALIDATED' AND targetEvidenceId=? LIMIT 1").get(target.id);
      if (priorInvalidation) return result(409, { error: "The native Project evidence has already been invalidated; it cannot be relabeled or edited.", code: "native_project_evidence_already_invalidated" });
      const timeFailure = nativeEvidenceTimeFailure({ artifact, bound, kind: "INVALIDATED", at, state });
      if (timeFailure) return timeFailure;
      const project = q.project.get(artifact.projectId, who);
      if (!project) return result(404, { error: "No such game.", code: "not_found" });
      const id = "gfn_" + randomUUID();
      db.prepare(`INSERT INTO game_artifact_native_evidence
        (id,artifactId,projectId,uid,kind,targetEvidenceId,nativeProjectId,fingerprint,size,operator,browserEvidenceRef,manifestHash,manifest,createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, artifact.id, artifact.projectId, who, "INVALIDATED", target.id, LOCKED_NATIVE_CHATGPT_PROJECT_ID,
        "", 0, bound.operator, bound.browserEvidenceRef, bound.manifestHash, json(bound), at,
      );
      bump(project);
      emit(project, "artifact.native_project_evidence_invalidated", {
        artifactId: artifact.id, evidenceId: target.id, invalidationId: id, reason: bound.reason, manifestHash: bound.manifestHash,
      }, { actor: bound.operator });
      return result(201, { ok: true, evidenceId: id, status: "INVALIDATED", manifestHash: bound.manifestHash });
    });
  }

  function recordArtifactCopy({ uid, artifactId, backend, locator = "", status = "PENDING", fingerprint = "", algorithm = "sha256", error = "" }) {
    const who = cleanUid(uid), be = cleanText(backend, 80).toLowerCase();
    if (!KNOWN_ARTIFACT_BACKENDS.includes(be)) return result(400, { error: "Unknown artifact storage backend.", code: "bad_backend" });
    if (be === "chatgpt_project") {
      return result(403, { error: "Native ChatGPT Project evidence can only be recorded through the append-only offline operator path or a future documented native API adapter.", code: "native_project_evidence_offline_only" });
    }
    return tx(() => {
      const artifact = db.prepare("SELECT * FROM game_artifacts WHERE id=? AND uid=?").get(artifactId, who);
      if (!artifact) return result(404, { error: "No such artifact.", code: "not_found" });
      const state = ["PENDING", "COPYING", "VERIFIED", "RETRYABLE", "CONFLICT", "FAILED"].includes(String(status).toUpperCase()) ? String(status).toUpperCase() : "FAILED";
      const alg = cleanText(algorithm, 32).toLowerCase() || "sha256";
      const fp = cleanText(fingerprint, 256).toLowerCase();
      const finalState = state === "VERIFIED" && alg === "sha256" && fp !== artifact.sha256 ? "CONFLICT" : state;
      const at = timestamp();
      const id = "gfc_" + randomUUID();
      db.prepare(`INSERT INTO game_artifact_copies (id,artifactId,backend,locator,status,fingerprint,algorithm,attempts,lastError,verifiedAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(artifactId,backend) DO UPDATE SET locator=excluded.locator,status=excluded.status,fingerprint=excluded.fingerprint,
          algorithm=excluded.algorithm,attempts=game_artifact_copies.attempts+1,lastError=excluded.lastError,
          verifiedAt=excluded.verifiedAt,updatedAt=excluded.updatedAt`).run(id, artifact.id, be, safeText(locator, 1000), finalState, fp, alg, 1,
          safeText(error || (finalState === "CONFLICT" ? "fingerprint does not match the registered artifact" : ""), 2000), finalState === "VERIFIED" ? at : 0, at);
      const project = q.project.get(artifact.projectId, who);
      bump(project);
      emit(project, "artifact.copy_updated", { artifactId, backend: be, status: finalState, locator: safeText(locator, 1000) });
      return result(finalState === "CONFLICT" ? 409 : 200, { ok: finalState === "VERIFIED", status: finalState });
    });
  }

  function recordTestRun({ uid, projectId, buildId = "", suite, target = "", status, sourceHash = "", evidence = {}, metrics = {} }) {
    const who = cleanUid(uid), suiteName = cleanText(suite, 160), state = cleanText(status, 40).toUpperCase();
    if (!QA_REQUIRED_SUITES.includes(suiteName)) return result(400, { error: "Unknown QA suite.", code: "bad_suite" });
    if (!["PASSED", "FAILED", "BLOCKED", "SKIPPED"].includes(state)) return result(400, { error: "Unknown test status.", code: "bad_status" });
    return tx(() => {
      const project = q.project.get(projectId, who);
      if (!project) return result(404, { error: "No such game.", code: "not_found" });
      const boundBuildId = cleanText(buildId || project.activeBuildId, 240);
      if (boundBuildId && !db.prepare("SELECT 1 AS ok FROM game_builds WHERE id=? AND projectId=? AND uid=?").get(boundBuildId, project.id, who)) {
        return result(400, { error: "The test build does not belong to this game and tenant.", code: "bad_build" });
      }
      const id = "gftest_" + randomUUID();
      db.prepare(`INSERT INTO game_test_runs (id,projectId,buildId,uid,suite,target,status,sourceHash,evidence,metrics,createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, project.id, boundBuildId, who, suiteName, cleanText(target, 80), state,
        cleanText(sourceHash, 128), json(evidence), json(metrics), timestamp());
      if (state === "FAILED" || state === "BLOCKED") invalidateMaterialChange(project, `The ${suiteName} QA suite did not pass.`);
      else bump(project);
      emit(project, "test.recorded", { id, suite: suiteName, target: cleanText(target, 80), status: state });
      return result(201, { ok: true, testRunId: id });
    });
  }

  function recordRelease({ uid, projectId, buildId = "", platform, packageId = "", versionName = "", versionCode = 0, status = "DRAFT", storeLocator = "", evidence = {} }) {
    const who = cleanUid(uid), target = cleanText(platform, 40).toLowerCase();
    if (!["android", "ios"].includes(target)) return result(400, { error: "Platform must be android or ios.", code: "bad_platform" });
    const state = cleanText(status, 40).toUpperCase();
    if (!["DRAFT", "VALIDATING", "READY", "UPLOADED", "SUBMITTED", "RELEASED", "BLOCKED", "FAILED"].includes(state)) return result(400, { error: "Unknown release status.", code: "bad_status" });
    return tx(() => {
      const project = q.project.get(projectId, who);
      if (!project) return result(404, { error: "No such game.", code: "not_found" });
      const boundBuildId = cleanText(buildId || project.activeBuildId, 240);
      const build = boundBuildId ? db.prepare("SELECT * FROM game_builds WHERE id=? AND projectId=? AND uid=?").get(boundBuildId, project.id, who) : null;
      if (!build || boundBuildId !== project.activeBuildId) return result(409, { error: "Release evidence must bind to the active build.", code: "active_build_required" });
      const identity = {
        packageId: cleanText(packageId, 240), versionName: cleanText(versionName, 80), versionCode: Number(versionCode) || 0,
      };
      if (!identity.packageId || !identity.versionName || identity.versionCode < 1) {
        return result(400, { error: "A package id, version name, and positive version code are required.", code: "release_identity_required" });
      }
      const prior = q.releases.all(project.id, who).find((row) => row.buildId === boundBuildId && row.platform === target) || null;
      if (prior && (prior.packageId !== identity.packageId || prior.versionName !== identity.versionName || prior.versionCode !== identity.versionCode)) {
        return result(409, { error: "The release package identity is immutable for an active build.", code: "release_identity_changed" });
      }
      const allowedAfter = {
        DRAFT: new Set(["DRAFT", "VALIDATING", "READY", "BLOCKED", "FAILED"]),
        VALIDATING: new Set(["VALIDATING", "READY", "BLOCKED", "FAILED"]),
        READY: new Set(["READY", "UPLOADED", "SUBMITTED", "BLOCKED", "FAILED"]),
        UPLOADED: new Set(["UPLOADED", "SUBMITTED", "BLOCKED", "FAILED"]),
        SUBMITTED: new Set(["SUBMITTED", "RELEASED", "BLOCKED", "FAILED"]),
        RELEASED: new Set(["RELEASED"]),
        BLOCKED: new Set(["BLOCKED", "VALIDATING", "READY", "FAILED"]),
        FAILED: new Set(["FAILED", "VALIDATING", "READY"]),
      };
      if (!prior && ["UPLOADED", "SUBMITTED", "RELEASED"].includes(state)) {
        return result(409, { error: "External release evidence cannot skip the durable preflight record.", code: "release_preflight_required" });
      }
      if (prior && !allowedAfter[prior.status]?.has(state)) {
        return result(409, { error: `A release cannot move from ${prior.status} to ${state}.`, code: "release_status_regression" });
      }
      const approvals = q.approvals.all(project.id, who);
      if (["UPLOADED", "SUBMITTED"].includes(state) && !approvalIsCurrent(approvals, "STORE_SUBMISSION", project)) {
        return result(409, { error: "A current human store-submission approval is required for this exact package set.", code: "store_submission_approval_required" });
      }
      if (state === "RELEASED" && !approvalIsCurrent(approvals, "PRODUCTION_RELEASE", project)) {
        return result(409, { error: "A current human production-release approval is required for this exact submitted package set.", code: "production_approval_required" });
      }

      const external = ["UPLOADED", "SUBMITTED", "RELEASED"].includes(state);
      const evidenceBody = safeValue(evidence || {});
      if (["SUBMITTED", "RELEASED"].includes(state) && !/^[a-f0-9]{64}$/.test(cleanText(evidenceBody.submissionReceiptHash, 128).toLowerCase())) {
        return result(409, { error: "A verified store submission receipt fingerprint is required.", code: "submission_receipt_required" });
      }
      if (state === "RELEASED" && !/^[a-f0-9]{64}$/.test(cleanText(evidenceBody.releaseReceiptHash, 128).toLowerCase())) {
        return result(409, { error: "A verified production release receipt fingerprint is required.", code: "release_receipt_required" });
      }
      if (state === "RELEASED" && cleanText(evidenceBody.submissionReceiptHash, 128).toLowerCase()
          !== cleanText(parse(prior?.evidence, {}).submissionReceiptHash, 128).toLowerCase()) {
        return result(409, { error: "The production receipt does not belong to the approved store submission.", code: "release_subject_changed" });
      }
      let verification = null;
      if (external) {
        if (typeof verifyReleaseEvidence !== "function") {
          return result(409, { error: "No trusted store receipt verifier is configured; external release status remains blocked.", code: "release_verifier_required" });
        }
        try { verification = verifyReleaseEvidence({ project: asProject(project), build: { id: build.id, sourceCommit: build.sourceCommit }, platform: target, status: state, identity, evidence: evidenceBody, prior: prior ? { id: prior.id, status: prior.status } : null }); }
        catch (error) { return result(409, { error: safeText(error && error.message, 1000) || "Store receipt verification failed.", code: "release_evidence_unverified" }); }
        if (!(verification === true || (verification && verification.ok === true))) {
          return result(409, { error: "The external store receipt could not be verified.", code: "release_evidence_unverified" });
        }
      }
      const persistedEvidence = external ? { ...evidenceBody, verification: verification === true ? { ok: true } : safeValue(verification) } : evidenceBody;
      if (prior && prior.status === state && requestHash(parse(prior.evidence, {})) === requestHash(persistedEvidence)
          && prior.storeLocator === safeText(storeLocator, 1000)) {
        return result(200, { ok: true, noop: true, releaseId: prior.id });
      }
      const id = "gfr_" + randomUUID(), at = timestamp();
      db.prepare(`INSERT INTO game_releases (id,projectId,buildId,uid,platform,packageId,versionName,versionCode,status,storeLocator,evidence,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, project.id, boundBuildId, who, target, identity.packageId, identity.versionName, identity.versionCode,
        state, safeText(storeLocator, 1000), json(persistedEvidence), at, at);
      if (["DRAFT", "VALIDATING", "READY", "BLOCKED", "FAILED"].includes(state)) {
        db.prepare("UPDATE game_approvals SET invalidatedAt=? WHERE projectId=? AND uid=? AND gate IN ('STORE_SUBMISSION','PRODUCTION_RELEASE') AND invalidatedAt=0")
          .run(at, project.id, who);
      } else if (["UPLOADED", "SUBMITTED"].includes(state)) {
        db.prepare("UPDATE game_approvals SET invalidatedAt=? WHERE projectId=? AND uid=? AND gate='PRODUCTION_RELEASE' AND invalidatedAt=0")
          .run(at, project.id, who);
      }
      bump(project);
      emit(project, "release.recorded", { id, platform: target, status: state, buildId: boundBuildId, verified: external });
      return result(201, { ok: true, releaseId: id });
    });
  }

  function events(uid, projectId, after = 0, limit = 200) {
    return q.events.all(cleanUid(uid), cleanText(projectId, 180), Math.max(Number(after) || 0, 0), Math.min(Math.max(Number(limit) || 200, 1), 1000)).map((e) => ({
      id: e.id, projectId: e.projectId, type: e.type, actor: e.actor, causationId: e.causationId,
      correlationId: e.correlationId, payload: parse(e.payload, {}), createdAt: e.createdAt,
    }));
  }

  function getApprovalSubject(uid, projectId, gate) {
    const row = q.project.get(cleanText(projectId, 180), cleanUid(uid));
    if (!row) return null;
    return approvalSubject(row, cleanText(gate, 80).toUpperCase());
  }

  function reconcile({ limit = 100 } = {}) {
    const at = timestamp();
    const report = { expired: 0, requeued: 0, failed: 0, blocked: 0, paused: 0, stopped: 0 };
    tx(() => {
      for (const task of q.expired.all(at, Math.min(Math.max(Number(limit) || 100, 1), 1000))) {
        const project = q.project.get(task.projectId, task.uid);
        const shouldPause = project.operation === "PAUSE_REQUESTED";
        const shouldStop = project.operation === "STOP_REQUESTED";
        const ownerOperationUnconfirmed = shouldPause || shouldStop;
        const mayRetry = !ownerOperationUnconfirmed && !!task.safeToRetry && task.attempt < task.maxAttempts;
        const syntheticCanary = isSyntheticCanaryTask(task);
        const status = mayRetry ? "QUEUED" : "FAILED";
        db.prepare("UPDATE game_tasks SET status=?, workerId='', leaseUntil=0, heartbeatAt=0, endedAt=?, result=? WHERE id=? AND status='RUNNING'")
          .run(status, status === "QUEUED" ? 0 : at, json({ error: "worker lease expired", recoveredAt: nowIso(at), ownerOperationUnconfirmed }), task.id);
        emit(project, "task.lease_expired", { taskId: task.id, priorWorkerId: task.workerId, status, safeToRetry: !!task.safeToRetry });
        report.expired++;
        if (mayRetry) report.requeued++;
        else if (ownerOperationUnconfirmed) {
          const resumeState = HOLD_STATES.has(project.state) ? project.resumeState : project.state;
          const requested = shouldPause ? "pause" : "stop";
          const blocker = `The worker lease expired before the requested ${requested} reached a confirmed safe boundary.`;
          db.prepare("UPDATE game_projects SET state='BLOCKED', resumeState=?, operation='', blocker=?, version=version+1, updatedAt=? WHERE id=? AND uid=?")
            .run(resumeState, blocker, at, project.id, project.uid);
          emit(project, `project.${requested}_unconfirmed`, { taskId: task.id, reason: blocker });
          report.blocked++;
        }
        else if (!shouldPause && !shouldStop && !syntheticCanary) {
          const resumeState = HOLD_STATES.has(project.state) ? project.resumeState : project.state;
          db.prepare("UPDATE game_projects SET state='FAILED', resumeState=?, operation='', blocker='A worker lease expired during a non-retryable task.', version=version+1, updatedAt=? WHERE id=? AND uid=?")
            .run(resumeState, at, project.id, project.uid);
          report.failed++;
        }
        else if (syntheticCanary) {
          emit(project, "synthetic_canary.failed", {
            schema: SYNTHETIC_CANARY_SCHEMA, taskId: task.id, error: "worker lease expired",
            projectLifecycleUnaffected: true,
          });
        }
      }
      const pending = db.prepare("SELECT * FROM game_projects WHERE operation IN ('PAUSE_REQUESTED','STOP_REQUESTED')").all();
      for (const project of pending) {
        if (Number(q.activeTasks.get(project.id, project.uid).n) > 0) continue;
        if (project.operation === "PAUSE_REQUESTED" && finalizePause(project, "reconciled after worker lease ended")) report.paused++;
        if (project.operation === "STOP_REQUESTED" && finalizeStop(project, "reconciled after worker lease ended")) report.stopped++;
      }
    });
    return report;
  }

  /*
   * The outbox is a durable record of intended external effects, not the effect itself. Every row
   * so far is kind="domain_event" (written by emit() above, in the same transaction as the durable
   * game_events row). The real fan-out for those events already happens independently: the SSE
   * /events handler (gamefactoryhttp.mjs) polls game_events directly, so a domain_event's delivery
   * is already durable and already live before this drainer ever looks at it. What genuinely never
   * happens today is a retry of a Google Drive mirror that failed or was skipped after the
   * synchronous attempt in gamefactoryplanner.mjs/startSpecification. classifyOutboxRow() checks
   * the durable copy-verification truth (never a caller's claim) so an artifact that is really still
   * unmirrored stays RETRYABLE instead of being marked DELIVERED by mistake.
   */
  function classifyOutboxRow(row, { env = process.env } = {}) {
    if (row.kind !== "domain_event") {
      // No second outbox kind exists anywhere in this codebase today (grep insertOutbox). Keep this
      // branch honest instead of silently dropping a future kind: deliver it to the local journal
      // (the row is already durable) and say plainly that no effect is wired up yet.
      // TODO(fred): give this kind a real external effect the day a second insertOutbox caller ships.
      return { status: "DELIVERED", note: "no external effect is defined for this outbox kind yet" };
    }
    const envelope = parse(row.payload, {});
    const type = cleanText(envelope?.type, 160);
    if (type !== "artifact.version_created") {
      return { status: "DELIVERED", note: "delivered via the durable game_events table and the live /events SSE poll; no separate push was required for this event type" };
    }
    const artifactId = cleanText(envelope?.payload?.id, 180);
    if (!artifactId) return { status: "DELIVERED", note: "malformed artifact.version_created payload carried no artifact id; nothing to mirror" };
    const alreadyMirrored = artifactCopyComplete({ uid: row.uid, projectId: row.projectId, artifactId, backend: "google_drive" });
    if (alreadyMirrored) return { status: "DELIVERED", note: "google_drive copy is already verified" };
    if (!MIRROR_WRITES_TRUE.has(cleanText(env.GAME_FACTORY_MIRROR_WRITES, 20).toLowerCase())) {
      return { status: "DELIVERED", note: "Drive mirror writes are disabled (GAME_FACTORY_MIRROR_WRITES is not enabled); no mirror action is possible from the outbox" };
    }
    return { status: "RETRYABLE", error: "google_drive copy is not yet verified", note: "awaiting a drive-mirror-capable outbox pass (pass deliver to drainOutbox to perform the real upload)" };
  }

  function settleOutboxRow(row, outcome, at) {
    const requested = ["DELIVERED", "RETRYABLE", "DEAD"].includes(outcome?.status) ? outcome.status : "RETRYABLE";
    const attempts = Number(row.attempts) || 0;
    const exhausted = requested === "RETRYABLE" && attempts + 1 >= OUTBOX_MAX_ATTEMPTS;
    const finalStatus = exhausted ? "DEAD" : requested;
    const nextAttemptAt = finalStatus === "RETRYABLE" ? at + outboxBackoffMs(attempts) : 0;
    const lastError = safeText(outcome?.error || (exhausted ? `outbox delivery did not succeed after ${OUTBOX_MAX_ATTEMPTS} attempts` : outcome?.note || ""), 2000);
    q.outboxSettle.run(finalStatus, nextAttemptAt, lastError, finalStatus === "DELIVERED" ? at : 0, row.id);
    return finalStatus;
  }

  function drainOutboxRows(rows, { deliver = null, env = process.env, at } = {}) {
    const report = { scanned: rows.length, delivered: 0, retried: 0, dead: 0 };
    return (async () => {
      for (const row of rows) {
        let outcome;
        try {
          outcome = deliver ? await deliver({ ...row, payload: parse(row.payload, {}) }) : null;
          if (!outcome || outcome.status === "SKIP") outcome = classifyOutboxRow(row, { env });
        } catch (error) {
          outcome = { status: "RETRYABLE", error: safeText(error?.message || error, 1000) || "outbox delivery threw" };
        }
        const finalStatus = settleOutboxRow(row, outcome, at);
        if (finalStatus === "DELIVERED") report.delivered++;
        else if (finalStatus === "DEAD") report.dead++;
        else report.retried++;
      }
      return report;
    })();
  }

  // Synchronous boot-time drain: no injected deliver, so only the pure-DB default classification
  // above can run (no network, safe to call from inside this synchronous constructor). This is what
  // actually clears the 132 pre-existing rows the first time this store opens after the fix ships.
  function drainOutboxSync({ limit = 1000, env = process.env } = {}) {
    const at = timestamp();
    const rows = q.outboxPending.all(at, Math.min(Math.max(Number(limit) || 1000, 1), 5000));
    const report = { scanned: rows.length, delivered: 0, retried: 0, dead: 0 };
    for (const row of rows) {
      let outcome;
      try { outcome = classifyOutboxRow(row, { env }); }
      catch (error) { outcome = { status: "RETRYABLE", error: safeText(error?.message || error, 1000) || "outbox classification failed" }; }
      const finalStatus = settleOutboxRow(row, outcome, at);
      if (finalStatus === "DELIVERED") report.delivered++;
      else if (finalStatus === "DEAD") report.dead++;
      else report.retried++;
    }
    return report;
  }

  // General drain, usable on a recurring tick. `deliver` is optional; when supplied (for example by
  // the orchestrator with a real artifact-mirror adapter) it may perform the actual network effect
  // for a row and return { status }, or return null/"SKIP" to fall through to the default classifier.
  function drainOutbox({ limit = 100, deliver = null, env = process.env } = {}) {
    const at = timestamp();
    const rows = q.outboxPending.all(at, Math.min(Math.max(Number(limit) || 100, 1), 1000));
    return drainOutboxRows(rows, { deliver, env, at });
  }

  // What the owner can still sync by hand: every current artifact version whose chatgpt_project
  // evidence has not reached a completing status. Purely a read of durable, already-computed truth;
  // it records nothing. See docs/NATIVE_CHATGPT_PROJECT_OWNER_ATTESTATION.md for the offline command.
  function chatgptProjectReconciliationQueue({ uid = "", limit = 200 } = {}) {
    const who = cleanUid(uid);
    const rows = who
      ? db.prepare(`SELECT a.* FROM game_artifacts a WHERE a.uid=?
          AND a.version=(SELECT MAX(version) FROM game_artifacts b WHERE b.projectId=a.projectId AND b.artifactKey=a.artifactKey)
          ORDER BY a.projectId, a.artifactKey`).all(who)
      : db.prepare(`SELECT a.* FROM game_artifacts a
          WHERE a.version=(SELECT MAX(version) FROM game_artifacts b WHERE b.projectId=a.projectId AND b.artifactKey=a.artifactKey)
          ORDER BY a.projectId, a.artifactKey`).all();
    const bound = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const out = [];
    for (const row of rows) {
      const artifact = nativeEvidenceArtifact(row);
      const storedCopies = q.copies.all(row.id).filter((candidate) => candidate.backend === "chatgpt_project");
      const copy = nativeEvidenceCopy(row, storedCopies);
      if (copySatisfiesBackend(copy, artifact, "chatgpt_project")) continue;
      out.push({
        projectId: row.projectId, artifactId: row.id, artifactKey: row.artifactKey, version: row.version,
        status: copy.status, reason: copy.reason || copy.lastError,
        readyForAttestation: nativeEvidencePrerequisites(artifact).length === 0,
        missingPrerequisites: nativeEvidencePrerequisites(artifact),
      });
      if (out.length >= bound) break;
    }
    return out;
  }

  // Clear whatever the outbox already holds the moment this store opens. Boot-time only, pure DB
  // reads, no network: this is what turns the 132 pre-existing PENDING rows into DELIVERED (or a
  // genuinely still-open RETRYABLE for an artifact that really never got mirrored).
  try { drainOutboxSync({}); } catch (error) { log("game-factory outbox boot drain failed: " + String(error?.message || error)); }

  function health() {
    const integrity = db.prepare("PRAGMA quick_check").get();
    const counts = {};
    for (const table of ["game_projects", "game_builds", "game_tasks", "game_events", "game_artifacts", "game_approvals", "game_releases", "outbox_events"]) {
      counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) || 0;
    }
    return {
      ok: String(integrity.quick_check || integrity.integrity_check || "").toLowerCase() === "ok",
      schema: { version: SCHEMA_VERSION, checksum: SCHEMA_CHECKSUM },
      counts,
    };
  }

  function stats() {
    const taskStatus = {};
    for (const row of db.prepare("SELECT status,COUNT(*) AS n FROM game_tasks GROUP BY status").all()) taskStatus[row.status] = Number(row.n) || 0;
    const projectState = {};
    for (const row of db.prepare("SELECT state,COUNT(*) AS n FROM game_projects GROUP BY state").all()) projectState[row.state] = Number(row.n) || 0;
    return {
      runningTasks: taskStatus.RUNNING || 0,
      queuedTasks: taskStatus.QUEUED || 0,
      pendingOperations: Number(db.prepare("SELECT COUNT(*) AS n FROM game_projects WHERE operation IN ('PAUSE_REQUESTED','STOP_REQUESTED')").get().n) || 0,
      taskStatus,
      projectState,
    };
  }

  return {
    file,
    seedPortfolio, listProjects, getProject, executeCommand,
    createBuild, queueTask, queueSyntheticCanary, claimNextTask, heartbeatTask, completeTask, failTask, securityStopTask,
    recordArtifact, recordArtifactCopy, artifactCopyComplete, recordOwnerAttestedNativeProjectEvidence,
    invalidateNativeProjectEvidence, recordTestRun, recordRelease,
    events, getApprovalSubject, reconcile, drainOutbox, drainOutboxSync, chatgptProjectReconciliationQueue,
    health, stats,
    close() { try { db.close(); } catch {} },
  };
}
