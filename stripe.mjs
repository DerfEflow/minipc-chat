/*
 * Dominion AI — Stripe (zero-dependency). Hosted Checkout for credit top-ups that ALSO saves the card
 * (so auto-recharge can charge off-session later), off-session PaymentIntents for auto-recharge, a
 * server-side session verify for the redirect return, and optional webhook signature verification.
 *
 * HIGH blast radius (real money in production; sandbox keys here). Everything goes through the injected
 * `httpsRequest` so the request layer can be mocked in tests; the live default uses node:https to
 * api.stripe.com with the secret key as a Bearer token (Stripe's API is form-urlencoded).
 */
import https from "node:https";
import { createHmac, timingSafeEqual } from "node:crypto";

// Encode a nested object into Stripe's bracketed application/x-www-form-urlencoded form.
export function formEncode(obj, prefix = "") {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) parts.push(formEncode(v, key));
    else if (Array.isArray(v)) v.forEach((item, i) => parts.push(typeof item === "object" ? formEncode(item, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.filter(Boolean).join("&");
}

function liveRequest(secretKey) {
  return (method, path, params) =>
    new Promise((resolve) => {
      const body = params ? formEncode(params) : "";
      const req = https.request({
        host: "api.stripe.com", path: "/v1" + path, method,
        headers: {
          authorization: "Bearer " + secretKey,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
        },
      }, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { let j; try { j = JSON.parse(d); } catch { j = { error: { message: "bad json from Stripe" } }; } resolve({ status: res.statusCode, json: j }); }); });
      req.on("error", (e) => resolve({ status: 0, json: { error: { message: e.message } } }));
      if (body) req.write(body); req.end();
    });
}

export function createStripe({ secretKey = "", publishableKey = "", webhookSecret = "", httpsRequest = null, log = () => {} } = {}) {
  const enabled = !!secretKey;
  const request = httpsRequest || (enabled ? liveRequest(secretKey) : async () => ({ status: 0, json: { error: { message: "stripe disabled: no secret key" } } }));

  // Create a hosted Checkout Session for a credit top-up. Saves the card for future off-session
  // charges (auto-recharge). `credits` is metadata only, for the return handler to grant.
  async function checkout({ email, usd, credits, successUrl, cancelUrl }) {
    if (!enabled) return { error: "stripe not configured" };
    const cents = Math.round(Number(usd) * 100);
    const r = await request("POST", "/checkout/sessions", {
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: email,
      customer_creation: "always",
      client_reference_id: email,
      "payment_intent_data": { setup_future_usage: "off_session" },
      "line_items": [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: cents,
          product_data: { name: "Dominion AI credits", description: `${credits} credits` },
        },
      }],
      metadata: { email, credits: String(credits), usd: String(usd) },
    });
    if (r.json && r.json.id) return { ok: true, id: r.json.id, url: r.json.url };
    return { error: (r.json && r.json.error && r.json.error.message) || "checkout failed" };
  }

  // Verify a completed session on the redirect return. Returns paid status + the saved customer/PM so
  // the caller can grant credits (idempotently) and store the card for auto-recharge.
  async function verifySession(id) {
    if (!enabled) return { error: "stripe not configured" };
    const r = await request("GET", `/checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent`, null);
    const s = r.json || {};
    if (s.error) return { error: s.error.message };
    const pi = s.payment_intent && typeof s.payment_intent === "object" ? s.payment_intent : null;
    return {
      ok: true,
      paid: s.payment_status === "paid",
      email: (s.metadata && s.metadata.email) || s.customer_email || "",
      credits: Number(s.metadata && s.metadata.credits) || 0,
      usd: Number(s.metadata && s.metadata.usd) || 0,
      customer: s.customer || (pi && pi.customer) || "",
      paymentMethod: pi && pi.payment_method || "",
    };
  }

  // Off-session charge for auto-recharge (requires a saved customer + payment method).
  async function charge({ email, usd, customer, pm }) {
    if (!enabled) return { ok: false, error: "stripe not configured" };
    const r = await request("POST", "/payment_intents", {
      amount: Math.round(Number(usd) * 100),
      currency: "usd",
      customer, payment_method: pm,
      off_session: true, confirm: true,
      description: "Dominion AI auto-recharge",
      metadata: { email, kind: "auto-recharge" },
    });
    const j = r.json || {};
    if (j.status === "succeeded") return { ok: true, id: j.id };
    return { ok: false, error: (j.error && j.error.message) || j.status || "charge failed", code: j.error && j.error.code };
  }

  // Verify a Stripe webhook signature (t=,v1=). Only used when a webhook secret is configured.
  function verifyWebhook(rawBody, sigHeader) {
    if (!webhookSecret) return { ok: false, error: "no webhook secret" };
    const parts = Object.fromEntries(String(sigHeader || "").split(",").map((kv) => kv.split("=")));
    if (!parts.t || !parts.v1) return { ok: false, error: "bad signature header" };
    const expected = createHmac("sha256", webhookSecret).update(parts.t + "." + rawBody).digest("hex");
    try {
      if (expected.length === parts.v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) return { ok: true, event: JSON.parse(rawBody) };
    } catch {}
    return { ok: false, error: "signature mismatch" };
  }

  return { enabled, publishableKey, checkout, verifySession, charge, verifyWebhook };
}
