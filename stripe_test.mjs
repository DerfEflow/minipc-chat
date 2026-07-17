/*
 * stripe self-test — run: node stripe_test.mjs
 * Exercises the parts that can be verified offline: bracket form-encoding, webhook HMAC verification,
 * and checkout/verify/charge against a mock request layer (no live Stripe).
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createStripe, formEncode } from "./stripe.mjs";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

await t("formEncode: nested objects + arrays use Stripe bracket notation", () => {
  const s = formEncode({ mode: "payment", line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 1250 } }], metadata: { email: "a@b.com" } });
  assert.ok(s.includes("mode=payment"));
  assert.ok(s.includes("line_items%5B0%5D%5Bquantity%5D=1"));
  assert.ok(s.includes("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1250"));
  assert.ok(s.includes("metadata%5Bemail%5D=a%40b.com"));
});

await t("checkout builds a payment session that saves the card", async () => {
  let captured = null;
  const mock = async (method, path, params) => { captured = { method, path, params }; return { status: 200, json: { id: "cs_test_1", url: "https://checkout.stripe.com/cs_test_1" } }; };
  const stripe = createStripe({ secretKey: "sk_test_x", httpsRequest: mock });
  const r = await stripe.checkout({ email: "u@x.com", usd: 12.5, credits: 1000, successUrl: "https://app/x", cancelUrl: "https://app/y" });
  assert.equal(r.ok, true); assert.equal(r.url, "https://checkout.stripe.com/cs_test_1");
  assert.equal(captured.path, "/checkout/sessions");
  assert.equal(captured.params.payment_intent_data.setup_future_usage, "off_session");
  assert.equal(captured.params.metadata.credits, "1000");
});

await t("verifySession reports paid + returns customer and payment method", async () => {
  const mock = async () => ({ status: 200, json: { payment_status: "paid", customer: "cus_1", metadata: { email: "u@x.com", credits: "1000", usd: "12.5" }, payment_intent: { customer: "cus_1", payment_method: "pm_1" } } });
  const stripe = createStripe({ secretKey: "sk_test_x", httpsRequest: mock });
  const r = await stripe.verifySession("cs_test_1");
  assert.equal(r.paid, true); assert.equal(r.customer, "cus_1"); assert.equal(r.paymentMethod, "pm_1"); assert.equal(r.credits, 1000);
});

await t("charge off-session succeeds and surfaces decline errors", async () => {
  const ok = createStripe({ secretKey: "sk", httpsRequest: async () => ({ status: 200, json: { status: "succeeded", id: "pi_1" } }) });
  assert.equal((await ok.charge({ email: "u@x.com", usd: 25, customer: "cus_1", pm: "pm_1" })).ok, true);
  const bad = createStripe({ secretKey: "sk", httpsRequest: async () => ({ status: 402, json: { error: { message: "Your card was declined.", code: "card_declined" } } }) });
  const r = await bad.charge({ email: "u@x.com", usd: 25, customer: "cus_1", pm: "pm_1" });
  assert.equal(r.ok, false); assert.equal(r.code, "card_declined");
});

await t("verifyWebhook accepts a correct signature and rejects a bad one", () => {
  const secret = "whsec_test";
  const stripe = createStripe({ secretKey: "sk", webhookSecret: secret });
  const payload = JSON.stringify({ type: "checkout.session.completed", id: "evt_1" });
  const ts = "1700000000";
  const good = createHmac("sha256", secret).update(ts + "." + payload).digest("hex");
  assert.equal(stripe.verifyWebhook(payload, `t=${ts},v1=${good}`).ok, true);
  assert.equal(stripe.verifyWebhook(payload, `t=${ts},v1=deadbeef`).ok, false);
});

await t("disabled stripe (no key) fails cleanly, never throws", async () => {
  const stripe = createStripe({});
  assert.equal(stripe.enabled, false);
  assert.equal((await stripe.checkout({ email: "u@x.com", usd: 12.5, credits: 1000, successUrl: "a", cancelUrl: "b" })).error, "stripe not configured");
});

console.log(`\nstripe_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
