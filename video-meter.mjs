/* Durable, at-most-once settlement for paid video work. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/;
const isoNow = () => new Date().toISOString();

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
  const insert = db.prepare("INSERT INTO settlements (settlementKey,tenantId,jobId,costUsd,kind,provider,status,createdAt) VALUES (?,?,?,?,?,?,?,?)");
  const finish = db.prepare("UPDATE settlements SET status=?, settledAt=?, error=? WHERE settlementKey=?");
  const remove = db.prepare("DELETE FROM settlements WHERE settlementKey=?");

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
      throw error;
    }
    // Claim before touching the credit ledger. A crash may undercharge this one item, but can never
    // double-charge it; failed/pending rows are visible for deliberate administrative repair.
    insert.run(key, tenantId, metadata.jobId || null, amount, String(metadata.kind || "video"), String(metadata.provider || ""), "pending", now());
    try {
      const result = await charge(tenant, amount, { ...metadata, settlementKey: key });
      finish.run("settled", now(), null, key);
      return { settled: true, settlementKey: key, costUsd: amount, result };
    } catch (error) {
      if (error?.safeToRetry === true) remove.run(key);
      else finish.run("failed", now(), String(error?.message || error).slice(0, 800), key);
      throw error;
    }
  }

  return { settle, get: (key) => get.get(String(key || "")), close: () => db.close() };
}
