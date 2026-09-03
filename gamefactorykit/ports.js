/*
 * gamefactorykit/ports.js -- browser AND node ports (pure JS, zero deps, importable in the QA
 * harness directly). See LANE-gfkit.md section B for the exact contract.
 *
 * Design notes (mine, since the contract leaves the exact internal wiring to the implementer):
 *
 * analytics: `sink` is what has actually been "delivered" (what a real game would eventually
 * flush to a backend). A bounded internal `pending` queue (cap 200, drop-oldest) absorbs track()
 * calls made while consent is denied, purely as a safety net -- the real gate is that runtime.js
 * is only supposed to CALL track() at all once consent is granted (see runtime.js section A), so
 * in the normal flow `pending` should stay empty. grant() flushes any pending backlog into sink in
 * FIFO order; revoke() clears the pending backlog (does not erase already-sunk/delivered events --
 * revoking consent stops future collection, it does not retroactively un-send what already went
 * out, matching typical consent semantics).
 *
 * monetization: a fake, fully synchronous adapter. purchase(id) succeeds immediately and entitles
 * (this is a TEST double, not a real store integration). cancel()/fail() model the two ways an
 * attempted purchase can end without entitlement (user backs out of the sheet, or the store
 * declines) -- they never touch `entitled`. callback(receipt) is the idempotent apply-a-receipt
 * primitive purchase() itself uses internally, also exposed directly so a caller (e.g. a platform
 * webhook simulation) can apply the same receipt twice safely. revoke() clears only the CURRENT
 * entitlement (e.g. "this session no longer thinks it owns the SKU") but keeps the last receipt of
 * record, so restore() can still recover it -- that is what makes "revoke clears it" and "restore
 * returns entitlement" both true statements about the same adapter instance.
 */

export function createPorts({ consent = "denied" } = {}) {
  let consentState = consent === "granted" ? "granted" : "denied";
  const sink = [];
  let pending = [];
  const PENDING_CAP = 200;

  const consentPort = {
    state() { return consentState; },
    grant() {
      if (consentState === "granted") return;
      consentState = "granted";
      if (pending.length) { sink.push(...pending); pending = []; }
    },
    revoke() {
      consentState = "denied";
      pending = [];
    },
  };

  const analytics = {
    track(name, props = {}) {
      const event = { name: String(name), props: props && typeof props === "object" ? props : {}, at: Date.now() };
      if (consentState === "granted") sink.push(event);
      else {
        pending.push(event);
        if (pending.length > PENDING_CAP) pending = pending.slice(pending.length - PENDING_CAP);
      }
      return event;
    },
    queue() { return pending.slice(); },
    sink,
    revoke() { pending = []; }, // convenience alias; consent.revoke() also does this
  };

  let disabled = true;
  let entitled = false;
  let lastReceipt = null;
  const appliedReceiptIds = new Set();
  let receiptCounter = 0;

  function applyReceipt(receipt) {
    if (!receipt || typeof receipt.id !== "string" || !receipt.id) return false;
    if (appliedReceiptIds.has(receipt.id)) return false; // idempotent: already applied, no-op
    appliedReceiptIds.add(receipt.id);
    entitled = true;
    lastReceipt = receipt;
    return true;
  }

  const monetization = {
    enabled() { return !disabled; },
    state() { return disabled ? "disabled" : (entitled ? "entitled" : "unentitled"); },
    enable() { disabled = false; },
    purchase(id) {
      if (disabled) return { ok: false, receipt: null };
      receiptCounter += 1;
      const receipt = { id: "rcpt_" + String(id) + "_" + receiptCounter, productId: String(id) };
      applyReceipt(receipt);
      return { ok: true, receipt };
    },
    cancel() { return { ok: false, reason: "cancelled" }; },
    fail() { return { ok: false, reason: "failed" }; },
    callback(receipt) { return { ok: applyReceipt(receipt) }; },
    restore() {
      if (!lastReceipt) return { ok: false, receipt: null };
      entitled = true;
      return { ok: true, receipt: lastReceipt };
    },
    revoke() { entitled = false; },
  };

  const pulses = [];
  const haptics = {
    pulse(kind) { pulses.push({ kind: String(kind), at: Date.now() }); },
    history() { return pulses.slice(); },
  };

  return { analytics, consent: consentPort, monetization, haptics };
}
