# Dominion AI: front-end design brief (for GPT)

## Role and mission
You are the UI designer and front-end builder for Dominion AI, a private multi-user AI assistant PWA. The backend is finished, deployed, and tested; every endpoint you need is listed below with exact request and response shapes. Your job is the styled user-facing layer for the multi-tenant features: onboarding, account, billing, invite codes, owner admin, and the Forge folder picker. Do not rebuild the chat surface; it exists and works.

## Hard constraints
1. Deliver exactly three files, complete, nothing partial:
   - `public/setup.html` (full replacement): a self-contained page, all CSS and JS inline in the one file.
   - `public/dominion-tenant.css` and `public/dominion-tenant.js`: a drop-in pair for the chat app shell (modals and toasts only).
2. Vanilla HTML/CSS/JS only. No frameworks, no build step, no CDN links, no external fonts or images, no web requests except the same-origin API below. The app runs offline-capable behind a strict gateway; an external reference will simply fail.
3. Do not edit or assume edits to any existing file. If something you build needs a hook in the existing app (one line to call your init, a container id to mount a button), list it under "INTEGRATION NOTES" at the end and the maintainer will wire it.
4. Prefix every id and class you introduce with `dt-` so nothing collides with the existing app.
5. Mobile-first. Most users are on phones as an installed PWA. Every surface must be comfortable at 375px wide and scale up gracefully. Dark theme only.
6. All fetches are same-origin with no auth headers; the gateway (Cloudflare Access) has already identified the user before any request reaches the page.
7. `dominion-tenant.js` must expose one global entry point: `window.DominionTenant.init()`. It fetches `/account`, then decides what to show (consent, tutorial, top-up toast). It must be safe to call on every page load.

## Match the existing app (this matters as much as function)
The app's current design is approved and final. Your only aesthetic job is to make every new element look like it has always been part of it.

Attached to this chat is `dominion-style-reference.css`: the app's real stylesheets bundled into one file, in load order. It is the single source of truth for the look.

Rules:
- Derive everything from those files: colors, tokens, borders, corner treatments, shadows, spacing, type sizes and weights, state colors, hover and active treatments. Do not invent, reinterpret, or "improve" the style. No new palettes, no new visual ideas.
- Where a comparable component already exists in those files (panel, button, chip, table, input, header label), replicate its exact treatment under your own `dt-` class names.
- Never restyle or override existing selectors; duplicate what you need under `dt-` names so the existing app is untouched.
- If the stylesheets leave something genuinely unspecified, choose the most conservative option consistent with them and note it in INTEGRATION NOTES.

## Copy rules
- All long-form copy (tutorial, consent, Forge warning) comes from the server and must be rendered verbatim; you never write or paraphrase it.
- You write only microcopy: labels, buttons, empty states, confirmations. Style: plain, confident, short. No hype, no exclamation marks, no emoji, and never use em dashes in any text you write.

## The API contract (verified against the running server)
Branch all UI off `GET /account` first.

- `GET /account` → `{ email, role: "owner"|"credit"|"sponsored", status: "active"|"paused"|"locked", isOwner, invited, consented, tutorialSeen, multiTenant, pricing: { CREDITS_PER_USD:100, MARKUP:1.25, RECHARGE_THRESHOLD:100, MIN_TOPUP_USD:12.5, TOPUP_TIERS:[12.5,25,50,100], FREE_CAP_USD:20 }, stripeConfigured, publishableKey }` plus, for credit users, `credits: { balance, usdValue, autorecharge, topupUsd, hasCard, rechargeFails, pendingPromo, hasPaid }` and, for sponsored users, `sponsored: { capUsd, spentUsd }`. Returns 401 `{error}` when unidentified.
- `POST /account/redeem` `{code}` → `{ ok, type, role, credits, pendingPromo }` or 400 `{ error: "invalid_code"|"code_used"|"code_revoked" }`.
- `POST /account/consent` → `{ok}`. `POST /account/tutorial-seen` → `{ok}`.
- `GET /content/tutorial` → `{ tutorial: { title, sections: [ { id, title, body, points?, tiers? } ] }, consent, forgeModeWarning }`. Section ids: features, tools, as-fred, wolfe-logic, forge-mode (has `tiers: [{id,name,desc}]` for Ember/Flame/Furnace, render as three cards), credits. Render body as a paragraph and points as a list, defensively (any field may be absent).
- `POST /billing/topup` `{usd}` → `{url}` (redirect the browser there; it is Stripe hosted Checkout) or 503 `{error:"billing not configured"}`. Stripe returns the user to `/?topup=done` or `/?topup=cancel`.
- `POST /billing/autorecharge` `{on, topupUsd?}` → `{ok, topupUsd}`.
- Owner only (403 otherwise):
  - `GET /admin/users` → `{ users: [ { email, role, status, invited, consented, sponsoredCapUsd, sponsoredSpentUsd, credits } ] }`.
  - `GET /admin/codes?limit=200` → `{ codes: [ { code, type, status, capUsd, credits, note, createdAt, redeemedBy, redeemedAt } ] }`.
  - `POST /admin/codes/mint` `{ type:"invite"|"free", credits?, capUsd?, email? }` → `{ codes:[{code,...}], email?, doorListed?, doorError? }`. When an email is supplied and `doorListed` is true, that email can now sign in; surface this clearly.
  - `POST /admin/codes/revoke` `{code}` → `{ok}`.
  - `POST /admin/user` `{ email, role?, status?, capUsd?, adjustCredits? }` → `{ok}`.
- Forge (any signed-in user; each user only ever sees their own machine):
  - `GET /forge/status` → `{ enabled, hasToken, roots:[], nodeConnected, isOwner }`.
  - `POST /forge/token` → `{ token:"dfk_...", config:{...} }`. Show the token once with a copy button and offer the config as a downloadable text file built client-side.
  - `GET /forge/browse?path=` → `{ ok, path, dirs:[{name,path}] }`; empty path lists drives; 409 `{error}` when their node is not connected; may return `{ok:false,error}` for protected locations.
  - `POST /forge/roots` `{roots:[...]}` (max 20) → `{roots, capped?}`.
  - `POST /forge/enable` `{on}` → status.

## Business rules the UI must make obvious
1. Pay-before-access: a credit user who has never purchased cannot chat. Their promo credits appear as a held "welcome bonus" (`pendingPromo`) released by the first purchase. The primary call to action for a redeemed-but-never-paid user is buying the first credits; say plainly that their bonus is added on top.
2. Credits: 100 credits equal $1 of usage value; the minimum purchase is $12.50 (1000 credits); tiers 12.50 / 25 / 50 / 100. After the first purchase auto-recharge is on; the toggle exists to turn it off.
3. Sponsored (free plan) users never see cards or purchases; show a monthly usage meter (`spentUsd` against `capUsd`).
4. Codes are single use. Minting with an email also opens the sign-in door for that email; the intended flow is: owner types their email, mints, then emails the code.
5. Account states: `paused` (sponsored cap reached) and `locked` (recharge failed) need clear full-width banners with what to do next.

## Deliverable 1: setup.html
A control room page titled "Dominion AI: Setup". Sections, in order, each a glass module, shown or hidden by role:
1. Your account: identity, role, status, credits with dollar value, welcome bonus if pending, sponsored meter if sponsored.
2. Access code: redeem input plus result. After a credit-user redeem, pivot the page's emphasis to the first purchase.
3. Credits and billing (credit users and owner): tier buttons, buy button (redirect to `{url}`), auto-recharge toggle, saved-card indicator (`hasCard`), lock/recharge-failure state.
4. Owner console (owner only): mint form (email, type invite/free, bonus credits, cap for free), minted-code display with copy button and door-list confirmation, codes table (status, revoke), users table (role, status, credits, adjust credits, pause/activate).
5. Forge, your machine: enable toggle, node token issue/copy/download, connected indicator, and the folder picker: browse drives, drill into folders, add up to 20 chosen folders as removable chips, save. Handle the 409 not-connected case with instructions to install and start the node first.
6. A quiet footer link back to the app: "Open Dominion".

## Deliverable 2: dominion-tenant.css + dominion-tenant.js
Modal and toast layer for the main app shell:
1. Consent notice: first thing a new user ever sees (when `consented` is false and `multiTenant` is true): server `consent` text verbatim, one accept button, POST `/account/consent`, then continue to the tutorial.
2. Tutorial: an obvious, welcoming modal on first login (`tutorialSeen` false), rendering the server tutorial sections with a left rail or top tabs per section, the forge-mode section showing the three tier cards. Close marks `/account/tutorial-seen`. Also render a small persistent "Guide" pill that reopens it anytime.
3. Top-up toasts: on `?topup=done` show a success toast (and refresh `/account`); on `?topup=cancel` a neutral one. Clean the query string afterward.
4. Keep it dependency-free and idempotent; everything mounts from `DominionTenant.init()`.

## Output format
Return the three files complete, each in its own fenced code block, preceded by a line with its exact path. Then a short "INTEGRATION NOTES" list: any hooks you need (for example, where `DominionTenant.init()` should be called and where the Guide pill mounts). Nothing else.

(To the person pasting this brief: attach the file `docs/dominion-style-reference.css` along with it.)
