# Dominion AI — Stripe go-live runbook

Everything else is launched and verified. This is the LAST step: swapping the sandbox Stripe keys
for the live Dominion keys so real cards can be charged. Claude executes steps 2-5; Fred does step 1.

## Current state (2026-07-17)
- App LIVE at app.dominion.tools behind Cloudflare Access (email-code sign-in, ~monthly per device).
- MULTI_TENANT=1, pay-before-access, invite codes + door-listing, content wall, weekly catalog audit.
- Stripe env on Railway = the "Dominion AI UI sandbox" (acct_1TuHF1APY6zicFF9): TEST MODE, cannot
  charge real cards. Whole money loop verified end to end against it.
- HARD RULE: the wallet's generic STRIPE_SECRET_KEY is DELTA LOG's live key (acct_1Tjq0bAI1a0SLsEf).
  Never use it for Dominion; ops/go-live-stripe.mjs hard-blocks that account id.

## Step 1 — Fred: get the LIVE Dominion keys (~5 minutes, one time)
1. Go to dashboard.stripe.com and sign in.
2. Top-left account picker: pick (or create) the real account Dominion revenue belongs to
   (Dominion / SD Tech — Fred's call which business entity). If new: complete "Activate payments"
   (business details + bank account for payouts).
3. Developers → API keys → copy the LIVE Secret key (sk_live_…) and Publishable key (pk_live_…).
4. Open `C:\Users\rjfla\.app-secrets.env` in Notepad and add two lines at the bottom, then save:
   DOMI_AI_STRIPE_LIVE_SECRET_KEY=sk_live_PASTE_HERE
   DOMI_AI_STRIPE_LIVE_PUBLISHABLE_KEY=pk_live_PASTE_HERE
5. Tell Claude "keys are in".

## Step 2 — preflight + webhook (Claude)
    node ops/go-live-stripe.mjs
Verifies live mode + right account + charges enabled; creates the checkout webhook and saves
DOMI_AI_STRIPE_LIVE_WEBHOOK_SECRET to the wallet. Refuses loudly on any mismatch.

## Step 3 — point Railway at the live keys (Claude)
    SK=$(grep '^DOMI_AI_STRIPE_LIVE_SECRET_KEY=' ~/.app-secrets.env | cut -d= -f2-)
    PK=$(grep '^DOMI_AI_STRIPE_LIVE_PUBLISHABLE_KEY=' ~/.app-secrets.env | cut -d= -f2-)
    WH=$(grep '^DOMI_AI_STRIPE_LIVE_WEBHOOK_SECRET=' ~/.app-secrets.env | cut -d= -f2-)
    railway variables --set "STRIPE_SECRET_KEY=$SK" --set "STRIPE_PUBLISHABLE_KEY=$PK" \
      --set "STRIPE_WEBHOOK_SECRET=$WH" --skip-deploys
    railway up --detach   # then wait for Healthcheck succeeded

## Step 4 — reset the sandbox test users (Claude, via railway ssh + node:sqlite)
The two test identities (fredwolfe+test@gmail.com, fred@trulineroofing.com) carry SANDBOX credits and
a SANDBOX saved card; under live keys that card would fail auto-recharge and lock them. Reset in
/data/billing/billing.db: balance→0, autorecharge→0, stripeCustomer/defaultPm→NULL for both emails
(keep users invited; chats untouched).

## Step 5 — live smoke (Claude, from inside the container)
    POST localhost /billing/topup as a test identity (header cf-access-authenticated-user-email)
    → the returned URL must contain "cs_live_". Do NOT complete a payment.
Then Fred makes the first real $12.50 purchase himself if he wants the full ceremony.

## Rollback
Set the three Railway vars back to the sandbox values (wallet: DOMI_AI_STRIPE_SANDBOX_*) and
redeploy. Credits already granted are data, unaffected by key direction.
