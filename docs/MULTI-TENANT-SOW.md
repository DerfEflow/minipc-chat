# Dominion AI — Multi-Tenant + Credit Billing + Per-User Forge: SOW

Written 2026-07-16 under Forge Mode (FITS, HIGH blast radius). This is the anti-silent-simplification
record: every decision Fred made is here verbatim. If the build ever diverges from this, that is a bug.

## Mission line

Turn single-user Dominion AI into a multi-tenant service where Fred's friends and family sign in,
each fully walled off from each other and from Fred's machines, pay with prepaid credits (or a
sponsored free pass), and can build on their OWN computers exactly as Fred does — while every
conversation quietly trains the shared logic.

## Locked decisions (Fred, 2026-07-16) — do not re-litigate

### Identity + tenancy
- **Sign-on** = Cloudflare Access. Each person's email added to the Access policy; they get their own
  email-PIN / Google login. The app reads `Cf-Access-Authenticated-User-Email` as the user id.
  `[user-stated]` Trustworthy because the Cloudflare Tunnel is the only ingress and Access gates it.
- **Per-user walls:** every server-side store (chatlog, memory, artifacts, flywheel, sandbox, usage)
  is namespaced per user at `/data/users/<userId>/…`. No user sees another's anything. Owner (Fred)
  keeps his existing root data.

### Persona (REFINED 2026-07-16)
- Non-owners get **titles + a summary of what the corpus contributes ONLY — never the actual
  contents.** `[user-stated]` This protects Fred's private writing (the L-017 concern). Concretely:
  - `search_persona` (returns raw text) is BLOCKED for non-owners.
  - The "As Fred" voice for non-owners is shaped by the **distilled profile summary**, never by
    injecting Fred's raw exemplars (no raw text reaches their prompt or the provider).
  - A non-owner persona panel is read-only: titles + kinds + the profile summary.
- Owner keeps full corpus access (raw text, exemplars, search). Persona WRITE (`add_to_persona`,
  `scrape_to_persona`, Forge write UI) is owner-only.

### Models
- **No user but Fred may use the local model.** The picker hides it and the server refuses it for
  non-owners. `[user-stated]`
- All users get the cloud catalog (with credit pricing, below).

### Tiers
1. **owner** — Fred. Full access, his machines, local model, dollars, no billing, no caps.
2. **sponsored** (his kids + coupon holders) — Fred covers cost. No card. No local model.
   **Cost ceiling = $20** `[user-stated]`. INTERPRETATION `[assumed]`: a **monthly** $20 ceiling on
   the account's total cost to Fred, adjustable/resettable per-user by Fred; when hit, the account
   pauses until Fred resets or the user adds a card. CONFIRM with Fred (money number).
3. **credit** — everyone else. Prepaid credits, mandatory auto-recharge, no local model.

### Credit billing
- **100 credits = $1.00 of real token cost.** Users buy at **$1.25 per $1.00 of value** (25% markup).
  So **1,000 credits = $12.50.** `[user-stated]`
- **Deduction** per turn = `realCostUsd × 100` credits (cost already computed in usage logging).
- **Packs:** $12.50 / $25 / $50, plus **custom any amount ≥ $12.50.** `[user-stated]`
- **Mandatory auto-recharge:** to send at all, the user must have a saved card + auto-recharge on.
  When balance drops to **≤ 100 credits ($1)**, Stripe charges the chosen pack off-session. `[user-stated]`
- **On auto-recharge failure:** the app **locks** (can't send) until manually topped off. Retry the
  auto-charge **every few days for one week, then stop retrying.** `[user-stated]`
- **Dropdown pricing:** credit users see **credits per million tokens** (= dollars/M × 100), e.g.
  GPT-4o `250 / 1,000 cr`, Claude Opus `500 / 2,500 cr`. Owner still sees dollars. `[user-stated]`

### Coupons (free/sponsored pass)
- A **non-descript coupon field** at sign-up AND in the dashboard. `[user-stated]`
- A valid coupon **auto-activates the sponsored (free) tier** — no card ever needed. `[user-stated]`
- **10 codes to start.** Single-use: once redeemed it is **burned**, never reusable. Fred can add
  more codes anytime and revoke a user's free access anytime. `[user-stated]`

### Per-user Forge (users act as Fred does)
- Each user can **build real code and run commands on THEIR OWN machine**, in the folders they pick
  (**one to twenty+, their choice**), via their own dial-out hands node. `[user-stated]`
- Hard wall: a user's Forge reaches ONLY their own node + granted folders + their own credits + their
  own cloud model. **Never** Fred's machines, keys, Claude Code, local model, or another user. Same
  carve-outs (D:/backups/customer-DBs/pg_dump) apply on their side.
- **Sponsored Forge cost** draws on Fred's wallet → covered by the $20 monthly ceiling above.

### Wolfe Logic + Forge Mode
- **"Wolfe Logic"** = Dominion's reasoning discipline (plan by blast radius, verify instead of guess,
  ledger unknowns, adversarial self-check) — what makes it different/better. **Explained from the
  first sign-in** and always in help. `[user-stated]`
- **Forge Mode** = a per-turn **toggle** that engages full Wolfe Logic + the build power. Default OFF.
  Warning shown on the toggle `[user-stated verbatim]`: "Performs much better with fewer errors and
  higher-quality output, but takes longer on the smaller models and burns credits faster than normal.
  Use when quality counts."

### Onboarding
- **One-time notice at first sign-in**, shown once, never repeated `[user-stated]`: the consent line
  (their conversations train the shared model) + a short Wolfe Logic intro.

### Training
- Every user's transcripts flow into ONE shared training sink, separate from their private views.

## Wargame — the four moves most likely to fail (and the counter)

1. **Identity spoofing.** If any path reaches the app without Access, a user could forge the
   `Cf-Access-*` header and read another tenant. COUNTER: trust the header ONLY on requests proven to
   come through Access (verify the `Cf-Access-Jwt-Assertion` signature against the team's public keys,
   or rely on the fact that the tunnel + `/hands` service-token app are the only non-Access routes and
   they carry no user data). Default-deny: no verified email → owner-less guest with zero stored state.
2. **Credit accounting drift / double-spend.** A race between concurrent turns could over- or
   under-charge, or a turn could complete without deducting. COUNTER: deduct in ONE place (post-turn,
   from the authoritative usage number), append-only ledger, balance = sum(ledger). Check balance
   BEFORE a paid turn; refuse at zero. Auto-recharge idempotent by Stripe idempotency key.
3. **Tool-wall breach.** A non-owner reaching Fred's node/machine or local model. COUNTER: the tool
   dispatcher resolves capabilities from the CALLER's role; machine hands are bound to the caller's
   OWN node id only; a hard assertion blocks any cross-user or owner-node dispatch; local model
   refused server-side for non-owners. Test each denial explicitly.
4. **Coupon reuse / race.** Two people redeem the last use of one code at once. COUNTER: atomic
   compare-and-set on redeem (single-writer SQLite transaction), status flips used→burned in the same
   txn that grants the tier; a burned or unknown code returns the same generic "invalid" message.

## Success criteria (ship line = grade 4)

- Two different users' chats/memory/artifacts are provably separate (create in A, absent in B).
- A non-owner cannot select or invoke the local model (refused, evidence).
- A non-owner's Forge reaches only their own node; a dispatch aimed at Fred's node is denied (evidence).
- Credits deduct exactly `cost×100` per turn; balance can't go negative; a zero-balance turn is refused.
- Auto-recharge charges the right pack at ≤100; a simulated failure locks the account and schedules the
  week of retries then stops.
- A coupon activates the free tier with no card; a second redeem of the same code is refused.
- Sponsored account pauses at the $20 monthly ceiling; owner can reset/lift it.
- Forge Mode toggle shows the warning; on = deeper Wolfe Logic + build power, off = normal.
- First sign-in shows the consent + Wolfe Logic notice exactly once.
- All existing single-user behavior for Fred is byte-for-byte unchanged.

## The build list (flat, dependency-ordered)

1. Identity resolver — `Cf-Access-Authenticated-User-Email` → userId + role, on every request. Owner = Fred.
2. Users + roles store — email, role (owner/sponsored/credit), status, caps, joined; owner bootstrap.
3. Per-user data isolation — lazy per-user store instances at `/data/users/<id>/…`; owner unchanged.
4. Persona shared read-only — all read/"As Fred"; write tools + panel owner-only.
5. Tool-access wall by role — capability set per role; machine hands bound to caller's own node; deny cross-user/owner.
6. Local-model lockout for non-owners — picker + server refuse.
7. One-time notice — consent + Wolfe Logic intro, shown once, recorded per user.
8. Credit ledger — append-only per user; balance = sum; pre-turn gate; post-turn deduct `cost×100`.
9. Credit metering — wire deduction to the existing usage number; refuse at zero.
10. Stripe — saved card, off-session auto-recharge at ≤100, packs 12.50/25/50/custom≥12.50; usage gated on auto-recharge enabled; failure → lock + week of retries then stop.
11. Coupons — 10 single-use codes, redeem = atomic burn + grant sponsored; add/revoke by owner.
12. Sponsored $20 ceiling — monthly cost cap, pause at limit, owner reset/adjust. (CONFIRM the number/period.)
13. Dropdown credit pricing — credits/M for credit users; dollars for owner.
14. Per-user Forge — build/hands on the user's OWN node + chosen folders; role-gated; sponsored Forge under the $20 cap.
15. Folder point-and-click — the user picks 1..N folders their node may access (node installer picker + optional browser File System Access fallback).
16. Wolfe Logic + Forge Mode toggle — per-turn toggle engaging deeper discipline + build power, with the warning; discipline on by default.
17. Admin view (owner) — users, tiers, balances/cost, activity; add/remove, set family, set caps, manage coupons.
18. Shared training sink — all transcripts → one dataset, separate from private views.

Owner's existing experience is never altered; every new behavior is gated behind role != owner.
