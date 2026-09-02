/*
 * Server-side adapter for the durable protocol implemented by the Hands static-broker controller.
 * The node is explicit and mandatory. This adapter never calls handsHub.pick(), never follows the
 * freshest node, and rejects a response that claims to come from a different machine.
 */

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
  if (typeof value !== "object") return redact(value);
  return Object.fromEntries(Object.entries(value).slice(0, 200).map(([name, item]) => [clean(name, 120), safeValue(item, depth + 1, name)]));
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function runReference(value) {
  const raw = String(value == null ? "" : value).trim();
  const normalized = clean(value, 240);
  return raw && raw === normalized && redact(raw, Math.max(raw.length, 1)) === raw && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : "";
}

export function createGameFactoryWorkerAdapter({
  dispatch, node, enabled = true, timeoutMs = 30_000, log = () => {},
} = {}) {
  const target = clean(node, 160).toLowerCase();
  const on = enabled === true && !!target && typeof dispatch === "function";
  const stats = { calls: 0, failures: 0, lastOkAt: 0, lastError: "" };

  async function call(tool, args = {}, cap = timeoutMs) {
    if (!on) {
      return {
        ok: false, disabled: true, retryable: false, node: target,
        error: target ? "game factory worker dispatch is disabled" : "GAME_FACTORY_NODE is not configured",
      };
    }
    const outbound = safeValue(args || {});
    // A build request containing a credential must not cross the Hands transport. Cancel reasons
    // are free text and may be safely redacted instead of blocking the owner's stop operation.
    if (new Set(["game_factory_start", "game_factory_authorization_absent"]).has(tool)
        && !sameJson(outbound, args || {})) {
      stats.failures++;
      stats.lastError = "worker request was refused because it contained credential material or exceeded protocol bounds";
      return { ok: false, refused: true, retryable: false, node: target, error: stats.lastError };
    }
    stats.calls++;
    let result;
    try {
      result = await dispatch(target, tool, outbound, {
        timeoutMs: Math.min(Math.max(Number(cap) || timeoutMs, 5_000), 120_000),
      });
    } catch (error) {
      stats.failures++;
      stats.lastError = redact(error && error.message, 1000).trim() || "worker dispatch failed";
      return { ok: false, offline: true, retryable: true, node: target, error: stats.lastError };
    }
    if (!result || typeof result !== "object") {
      stats.failures++;
      stats.lastError = "worker returned no structured result";
      return { ok: false, retryable: true, node: target, error: stats.lastError };
    }
    result = safeValue(result);
    const answeringNode = clean(result.node, 160).toLowerCase();
    if (answeringNode !== target) {
      stats.failures++;
      stats.lastError = answeringNode
        ? `configured node ${target} received a response claiming node ${answeringNode}`
        : `configured node ${target} received a response without node provenance`;
      log(`[game-factory] ${stats.lastError}`);
      return { ok: false, refused: true, retryable: false, node: target, error: stats.lastError };
    }
    if (result.ok === false) {
      stats.failures++;
      stats.lastError = redact(result.error || result.reason, 1000).trim() || "worker operation failed";
      return { ...result, node: target, retryable: result.offline === true || result.timedOut === true || result.retryable === true };
    }
    stats.lastOkAt = Date.now();
    stats.lastError = "";
    return { ...result, node: target };
  }

  return {
    enabled: on,
    node: target,
    probe() { return call("game_factory_probe", {}, 20_000); },
    start(request) { return call("game_factory_start", request, 30_000); },
    authorizationAbsent(request) { return call("game_factory_authorization_absent", request, 30_000); },
    status(runId) {
      const ref = runReference(runId);
      return ref ? call("game_factory_status", { runId: ref }, 20_000)
        : Promise.resolve({ ok: false, refused: true, retryable: false, node: target, error: "invalid game factory runId" });
    },
    cancel(runId, { mode = "safe", reason = "" } = {}) {
      const ref = runReference(runId);
      if (!ref) return Promise.resolve({ ok: false, refused: true, retryable: false, node: target, error: "invalid game factory runId" });
      return call("game_factory_cancel", {
        runId: ref, mode: mode === "immediate" ? "immediate" : "safe",
        reason: redact(reason, 1000).trim(),
      }, 20_000);
    },
    collect(runId) {
      const ref = runReference(runId);
      return ref ? call("game_factory_collect", { runId: ref }, 30_000)
        : Promise.resolve({ ok: false, refused: true, retryable: false, node: target, error: "invalid game factory runId" });
    },
    acknowledge(runId) {
      const ref = runReference(runId);
      return ref ? call("game_factory_acknowledge", { runId: ref }, 30_000)
        : Promise.resolve({ ok: false, refused: true, retryable: false, node: target, error: "invalid game factory runId" });
    },
    health() { return { enabled: on, node: target, ...stats }; },
  };
}
