/* Durable, at-most-once settlement for paid video work. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/;
const SAFE_SETTLEMENT_KEY = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,639}$/;
const REPAIR_ACTIONS = new Set(["mark_settled", "retry_not_charged"]);
const isoNow = () => new Date().toISOString();

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactSettlementKey(value) {
  if (typeof value !== "string" || value !== value.trim() || !SAFE_SETTLEMENT_KEY.test(value)) {
    throw codedError("VIDEO_SETTLEMENT_KEY_INVALID", "An exact valid settlement key is required.");
  }
  return value;
}

function repairConfirmation(action, settlementKey) {
  if (action === "mark_settled") return `MARK_SETTLED ${settlementKey} OPERATOR_VERIFIED_CHARGE_OCCURRED`;
  if (action === "retry_not_charged") return `RETRY_NOT_CHARGED ${settlementKey} OPERATOR_VERIFIED_NO_CHARGE`;
  throw codedError("VIDEO_SETTLEMENT_REPAIR_ACTION_INVALID", "The settlement repair action is invalid.");
}

function publicSettlement(row) {
  if (!row) return null;
  return {
    settlementKey: row.settlementKey,
    tenantId: row.tenantId,
    jobId: row.jobId || null,
    costUsd: Number(row.costUsd),
    kind: row.kind || null,
    provider: row.provider || null,
    status: row.status,
    createdAt: row.createdAt,
    settledAt: row.settledAt || null,
    hasRecordedError: !!row.error,
  };
}

export function createVideoMeter({ dir, charge, now = isoNow } = {}) {
  if (!dir) throw new TypeError("video meter dir is required");
  if (typeof charge !== "function") throw new TypeError("video meter charge callback is required");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "video-settlements.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS settlements (
    settlementKey TEXT PRIMARY KEY, tenantId TEXT NOT NULL, jobId TEXT,
    costUsd REAL NOT NULL, kind TEXT, provider TEXT, status TEXT NOT NULL,
    createdAt TEXT NOT NULL, settledAt TEXT, error TEXT
  )`);
  const get = db.prepare("SELECT * FROM settlements WHERE settlementKey=?");
  const listHeldRows = db.prepare("SELECT * FROM settlements WHERE status IN ('pending','failed') ORDER BY createdAt ASC, settlementKey ASC");
  const insert = db.prepare("INSERT INTO settlements (settlementKey,tenantId,jobId,costUsd,kind,provider,status,createdAt) VALUES (?,?,?,?,?,?,?,?)");
  const finish = db.prepare("UPDATE settlements SET status=?, settledAt=?, error=? WHERE settlementKey=?");
  const remove = db.prepare("DELETE FROM settlements WHERE settlementKey=?");
  const repairSettled = db.prepare("UPDATE settlements SET status='settled', settledAt=?, error=NULL WHERE settlementKey=? AND status IN ('pending','failed')");
  const repairRemove = db.prepare("DELETE FROM settlements WHERE settlementKey=? AND status IN ('pending','failed')");
  const activeSettlements = new Set();

  function tenantKey(tenant) {
    const raw = String(tenant?.uid || tenant?.tenantId || tenant?.email || "").trim().toLowerCase();
    if (!raw) throw new Error("video settlement tenant is required");
    return SAFE_KEY.test(raw) ? raw : "tenant_" + createHash("sha256").update(raw).digest("hex").slice(0, 32);
  }

  function settlementKey(tenantId, metadata = {}) {
    const jobId = String(metadata.jobId || "").trim();
    if (jobId && SAFE_KEY.test(jobId)) return `${tenantId}:job:${jobId}`;
    const billingId = String(metadata.billingId || randomUUID()).trim();
    return `${tenantId}:call:${SAFE_KEY.test(billingId) ? billingId : randomUUID()}`;
  }

  async function settle(tenant, costUsd, metadata = {}) {
    const amount = Number(costUsd);
    if (!Number.isFinite(amount) || amount <= 0) return { skipped: true, reason: "no_cost" };
    const tenantId = tenantKey(tenant); const key = settlementKey(tenantId, metadata);
    const prior = get.get(key);
    if (prior?.status === "settled") return { already: true, status: prior.status, settlementKey: key, costUsd: prior.costUsd };
    if (prior) {
      const error = new Error("This video charge is held for administrative settlement repair; media was not released or charged again.");
      error.code = "VIDEO_SETTLEMENT_REPAIR_REQUIRED";
      error.settlementKey = key;
      throw error;
    }
    // Claim before touching the credit ledger. A crash may undercharge this one item, but can never
    // double-charge it; failed/pending rows are visible for deliberate administrative repair.
    insert.run(key, tenantId, metadata.jobId || null, amount, String(metadata.kind || "video"), String(metadata.provider || ""), "pending", now());
    activeSettlements.add(key);
    try {
      const result = await charge(tenant, amount, { ...metadata, settlementKey: key });
      finish.run("settled", now(), null, key);
      return { settled: true, settlementKey: key, costUsd: amount, result };
    } catch (error) {
      if (error?.safeToRetry === true) remove.run(key);
      else finish.run("failed", now(), String(error?.message || error).slice(0, 800), key);
      if (error && typeof error === "object") error.settlementKey = key;
      throw error;
    } finally {
      activeSettlements.delete(key);
    }
  }

  function listHeld() {
    return listHeldRows.all().map(publicSettlement);
  }

  function inspect(settlementKey) {
    return publicSettlement(get.get(exactSettlementKey(settlementKey)));
  }

  function repair(input = {}) {
    const request = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const action = typeof request.action === "string" ? request.action : "";
    if (!REPAIR_ACTIONS.has(action)) {
      throw codedError("VIDEO_SETTLEMENT_REPAIR_ACTION_INVALID", "The settlement repair action is invalid.");
    }
    const settlementKey = exactSettlementKey(request.settlementKey);
    const expectedConfirmation = repairConfirmation(action, settlementKey);
    if (request.confirmation !== expectedConfirmation) {
      throw codedError("VIDEO_SETTLEMENT_REPAIR_CONFIRMATION_REQUIRED", "The exact operator settlement repair confirmation is required.");
    }
    if (activeSettlements.has(settlementKey)) {
      throw codedError("VIDEO_SETTLEMENT_ACTIVE", "This settlement is still active and cannot be repaired.");
    }
    const prior = get.get(settlementKey);
    if (!prior) throw codedError("VIDEO_SETTLEMENT_NOT_FOUND", "The settlement claim was not found.");

    if (action === "mark_settled") {
      if (prior.status === "settled") {
        return { action, changed: false, already: true, settlement: publicSettlement(prior) };
      }
      if (!new Set(["pending", "failed"]).has(prior.status)) {
        throw codedError("VIDEO_SETTLEMENT_REPAIR_STATE_INVALID", "This settlement state cannot be marked settled.");
      }
      const changed = repairSettled.run(now(), settlementKey).changes;
      if (changed !== 1) throw codedError("VIDEO_SETTLEMENT_REPAIR_CONFLICT", "The settlement changed while the repair was being applied.");
      return { action, changed: true, already: false, settlement: publicSettlement(get.get(settlementKey)) };
    }

    if (prior.status === "settled") {
      throw codedError("VIDEO_SETTLEMENT_ALREADY_SETTLED", "A settled charge cannot be released for retry.");
    }
    if (!new Set(["pending", "failed"]).has(prior.status)) {
      throw codedError("VIDEO_SETTLEMENT_REPAIR_STATE_INVALID", "This settlement state cannot be released for retry.");
    }
    const changed = repairRemove.run(settlementKey).changes;
    if (changed !== 1) throw codedError("VIDEO_SETTLEMENT_REPAIR_CONFLICT", "The settlement changed while the repair was being applied.");
    return { action, changed: true, removed: true, settlementKey, previousStatus: prior.status };
  }

  return {
    settle,
    get: (key) => get.get(String(key || "")),
    listHeld,
    inspect,
    repair,
    close: () => db.close(),
  };
}
