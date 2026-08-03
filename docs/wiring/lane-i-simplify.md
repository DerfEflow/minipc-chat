# Lane I wiring: Simplify My Chat

Written 2026-08-03. Branch `iter/assistant-build-core`.

Lane I does not own `server.mjs`, `tools.mjs`, `toolschema.mjs`, `public/app.js`, `public/index.html`,
`models.catalog.mjs`, `sequential.mjs`, `wolfe-logic.mjs`, `execution-policy.mjs`, `connectors.mjs`,
`altana.mjs`, `google*.mjs`, `public/dominion-ui.css`, `public/dominion-ui.js`, or
`public/dominion-cinematic.js`. Everything below is an exact instruction for whoever does.

Every anchor quoted below was taken from the working tree today (2026-08-03) and verified with
`grep -c` to appear **exactly once** in its file — see the shell output at the end of this document's
authoring session if you want to re-verify before editing.

Lane I owns and shipped: `simplify.mjs`, `simplify_test.mjs`, `public/dominion-simplify.css`,
`public/dominion-simplify.js`. All four are finished and self-tested (`node simplify_test.mjs`,
50/50 passing). Nothing below requires editing any of those four files — only the three files this
lane cannot touch.

---

## 1. The route registration in `server.mjs`

### 1a. Import

**Anchor** (`server.mjs`, appears once, currently at line 153):

```js
import { createForgeStore, buildInstallerZip } from "./forge.mjs";
```

**Insert immediately after it:**

```js
import { createSimplifyChatHandler } from "./simplify.mjs";
```

Then, near wherever the other feature singletons are constructed at module scope (alongside
`guestSandbox`, `handsHub`, etc. — Lane I did not chase an exact line for this since it is a
one-line constant with no ordering dependency on anything else in the file):

```js
const simplifyChat = createSimplifyChatHandler({ env: process.env });
```

`createSimplifyChatHandler` reads its own provider keys from `env` at construction time (see
`simplify.mjs`'s file-header note on why it cannot import `server.mjs`'s private `PROVIDER_CFG`);
it needs nothing else from this file.

### 1b. The route

**Anchor** (`server.mjs`, appears once, currently at line 10066):

```js
    if (path === "/chat" && req.method === "POST") return handleChat(req, res);
```

**Insert immediately after it:**

```js
    if (path === "/api/simplify/chat" && req.method === "POST") {
      /*
       * Same identity/billing gate as /chat (handleChat, lines ~7278-7297 today): refuse
       * T.role === "anon", refuse a paused/locked account, refuse a credit-role account with no
       * balance. Simplify is a thinner surface, not an ungated one — a guest still needs an
       * account and credits to spend, exactly like the main chat. Copy that gate's shape rather
       * than re-deriving it; simplifyChat(req, res) assumes the caller already decided this
       * request may proceed and does not repeat the check itself.
       */
      const T = resolveTenant(req);
      if (T.role === "anon") return sjson(res, 401, { error: "sign in" });
      if (T.status === "paused" || T.status === "locked") return sjson(res, 403, { error: "account " + T.status });
      if (!T.isOwner && !T.invited) return sjson(res, 403, { error: "needs_invite" });
      if (!T.isOwner && T.role === "credit" && !billing.canChat(T.email)) return sjson(res, 402, { error: "needs_credits" });
      return simplifyChat(req, res);
    }
```

`resolveTenant`, `sjson`, and `billing` are already in scope in `server.mjs` (they gate `/chat`
today). `/api/simplify/chat` rather than reusing `/chat` on purpose: Simplify's request/response
shape is intentionally simpler than the main chat's (see `simplify.mjs`'s own SSE frames:
`route`/`notice`/`delta`/`error`/`done` — no attachments, no job/attach/resume machinery, no model
field), and giving it its own path means a bug in one surface's wire format cannot silently corrupt
the other's.

---

## 2. The `<link>` and `<script>` lines

This app has two existing patterns for loading a feature's own CSS/JS:

1. **Direct `<link>`/`<script>` tags in `index.html`** — used by every named feature module
   (`dominion-forge.css/js`, `dominion-images.css/js`, `dominion-ide.css/js`, and most recently
   **Altana**, added 2026-08-01ish as `<link rel="stylesheet" href="/altana.css?v=1" />` and
   `<script type="module" src="/altana.js?v=1"></script>`).
2. **`@import`/injection** — used ONLY for the cinematic decoration layer: `dominion-ui.css`
   `@import`s the `dominion-cinematic-0X.css` sheets, and `dominion-ui.js` injects
   `dominion-cinematic.js` via a dynamically created `<script>` tag.

**Lane I recommends pattern 1 (direct tags), following the Altana precedent exactly**, because
Simplify is a standalone alternate surface the user opens deliberately, not a decoration layered
onto the existing cinematic chat shell the way the rail/dock/vault are. It should load once, up
front, the same way Altana does, rather than being injected asynchronously by a script this lane
does not own.

**Anchor** (`public/index.html`, appears once, currently at line 28):

```html
<link rel="stylesheet" href="/altana.css?v=1" />
```

**Insert immediately after it:**

```html
<link rel="stylesheet" href="/dominion-simplify.css?v=1" />
```

**Anchor** (`public/index.html`, appears once, currently around line 591):

```html
<script type="module" src="/altana.js?v=1"></script>
```

**Insert immediately after it:**

```html
<script src="/dominion-simplify.js?v=1"></script>
```

Note: `dominion-simplify.js` is a **classic script, not a module** (matching the majority pattern —
`dominion-images.js`, `dominion-ide.js`, etc. — rather than Altana's `type="module"`), because it is
a self-contained IIFE with no imports/exports of its own; it only needs to run once and set
`window.DominionSimplify`. No `defer` either: it must finish building `window.DominionSimplify`
before a user can possibly click the hamburger-menu button that calls it, and since it does no DOM
querying at load time (it lazily builds its panel on first `open()`), there is no ordering hazard
running it eagerly.

Also add `/dominion-simplify.css?v=1` and `/dominion-simplify.js?v=1` to `public/sw.js`'s asset list
(it already lists `/dominion-vault.css?v=5` etc. the same way) so the PWA offline cache picks them
up. Lane I does not own `public/sw.js` either; this is a one-line addition to an existing array.

---

## 3. The hamburger menu change

**The guest signal.** This app already exposes exactly the flag needed, client-side, today:

**Anchor** (`public/app.js`, appears once, currently around line 3076):

```js
fetch("/account").then((r) => r.json()).then((a) => {
  if (a && a.multiTenant && !a.isOwner && privacyModeSel) {
```

`GET /account` (`server.mjs`, `handleAccount`, line 4965) returns
`{ email, role, status, isOwner, invited, multiTenant, ... }`. `isOwner` is the exact signal: false
for every guest, true only for Fred. This is the same flag app.js already uses to strip the
Private/Local privacy option from a guest's picker two lines below the anchor above — Simplify's
guest-only swap should use the identical fetch, not a new endpoint.

**The section to remove/replace.** The Knowledge Vault rail section is built in
`public/dominion-cinematic.js`, inside `buildCinematicShell()`:

**Anchor** (`public/dominion-cinematic.js`, appears once, currently at lines 22-36):

```js
      const chatlist = document.getElementById("chatlist");
      chatlist?.insertAdjacentHTML("afterend", `
        <section class="vault-module" aria-label="Knowledge vault">
          <div class="rail-cap">Knowledge Vault</div>
          <div class="vault-grid">
            <button type="button"><svg class="glyph"><use href="#i-artifact"></use></svg><span>Corporate Intelligence</span></button>
            <button type="button"><svg class="glyph"><use href="#i-context"></use></svg><span>Technology Archive</span></button>
            <button type="button"><svg class="glyph"><use href="#i-memory"></use></svg><span>Personal Playbook</span></button>
          </div>
        </section>
        <section class="prime-module">
          <span class="prime-core"><svg class="glyph"><use href="#i-core"></use></svg><i></i></span>
          <div><b>Dominion Prime</b><small>Core link: stable</small></div>
          <span class="prime-bars"><i></i><i></i><i></i><i></i></span>
        </section>`);
    }
```

**Change:** leave this block exactly as it is (the owner still sees the real Knowledge Vault), and
add a guest-only swap immediately after it, inside the same `if (sidebar && ...)` block, right
before its closing `}`:

```js
      // GUEST-ONLY: Simplify My Chat replaces the Knowledge Vault section (Fred, 2026-08-03: "we
      // could remove that section from the guest versions completely, and then add a big button
      // for SIMPLIFY MY CHAT"). isOwner is server-verified (GET /account, handleAccount); this is
      // display-only, matching the existing pattern at app.js's own /account fetch (~line 3076).
      fetch("/account").then((r) => r.json()).then((a) => {
        if (!a || a.isOwner) return;   // owner keeps the real Knowledge Vault, unchanged
        const vault = sidebar.querySelector(".vault-module");
        if (!vault) return;
        vault.innerHTML = `<button type="button" class="simplify-launch">SIMPLIFY MY CHAT</button>`;
        vault.querySelector(".simplify-launch").addEventListener("click", () => {
          // window.DominionSimplify is set by public/dominion-simplify.js (Lane I). Guarded rather
          // than assumed present, in case script load order ever changes.
          if (window.DominionSimplify) window.DominionSimplify.open();
        });
      }).catch(() => {});
```

This replaces the vault section's **contents** in place (same `<section class="vault-module">`
wrapper, so the rail's spacing/layout rules in `dominion-cinematic-02.css` — which this lane does
not own — keep applying without needing a CSS edit there) rather than removing the section
outright, which is simpler and lower-risk than deleting a DOM node another sheet targets by class.

The `.simplify-launch` button class is already styled in `public/dominion-simplify.css` (Lane I's
own file, loaded per section 2 above) — neon-outlined, full-width within the rail, CRT-styled to
match the surface it opens. No edit needed to any cinematic stylesheet.

`window.DominionSimplify.open()` is the only call this integration needs to make. It lazily builds
the full Simplify panel on first call and appends it directly to `document.body`.

---

## 4. What Lane I verified so the integrator does not have to re-derive it

- **The websearch route is real, not faked.** `tools.mjs` defines `web_search` (SerpApi-backed,
  gated on `ctx.serpKey`, i.e. the `SERP_API_KEY` env var) and `simplify.mjs` calls the exported
  `runTool("web_search", ...)` directly — the same function `server.mjs` calls for the main chat's
  tool loop. Proven in `simplify_test.mjs` by asserting `web_search` is present in `toolDefs()`.
- **Two of Fred's ten named routes (safety, empathetic) do not have a live catalog seat.**
  `docs/SIMPLIFY-ROUTING-TABLE.md` measured both alive on NVIDIA's endpoint directly, but neither
  model id was ever added as a row in `models.catalog.mjs`. `simplify.mjs`'s `resolveRouteModel`
  detects this (`isCatalogModel` returns false) and falls back to the "chat" route's own model
  (Claude Haiku 4.5) rather than inventing a substitute — `blocked: true` rides the diagnostic
  `route` SSE frame. This is an **open item for Fred**, not something Lane I resolved unilaterally:
  either seat the two ids for real, or accept the fallback.
- **Provider dispatch inside `simplify.mjs` is a documented, necessary duplication.**
  `PROVIDER_CFG`/`resolveProviderCfg` in `server.mjs` are module-private with no export, and this
  lane cannot edit `server.mjs`. `simplify.mjs`'s own transport code mirrors that logic's observable
  behavior exactly (same env var names, same default URLs, same OpenRouter-fallback provider set),
  verified read-only against `server.mjs` lines 612-663. If `server.mjs` ever exports
  `resolveProviderCfg`, that duplicate block in `simplify.mjs` should be deleted in favor of the
  real one — filed as an open item below.
- **The Anthropic route reuses the app's real streaming client.** `simplify.mjs` imports
  `anthropicMessagesStream` from `anthropicmessages.mjs` directly (a genuinely shared, exported
  function — no duplication there).

---

## 5. Open items for whoever picks this up

| # | Item | State |
|---|---|---|
| W1 | Seat `nvidia/nemotron-3.5-content-safety` and/or `meta/llama-3.1-70b-instruct` in `models.catalog.mjs`, or accept the Claude Haiku fallback Lane I shipped | `[open]`, needs Fred |
| W2 | `simplify.mjs`'s provider-transport block duplicates `server.mjs`'s private `PROVIDER_CFG` logic because there is nothing exported to import. If `resolveProviderCfg` / the provider key map are ever exported from `server.mjs`, delete the duplicate in `simplify.mjs` | `[open]`, low priority, no user-facing effect either way |
| W3 | `/api/simplify/chat` is gated identically to `/chat` per section 1b above, but Lane I could not add the actual gate (owns neither file it would touch) — confirm the integrator's version matches before shipping | `[open]`, blocks nothing but should be checked at review |
| W4 | Section 3's guest/owner swap fires an extra `/account` fetch. If this proves wasteful under real traffic, it can instead listen for the `dominion-owner-known` CustomEvent app.js already dispatches (`document.dispatchEvent(new CustomEvent("dominion-owner-known"))`, right after it sets `window.dominionIsOwner`) and read `window.dominionIsOwner` instead of fetching `/account` a second time | `[open]`, a minor efficiency, not correctness |

---

## 6. Verification this lane could actually run

`node simplify_test.mjs` — 50/50 passing (route-to-catalog resolution, sample-question routing,
hostile-input fuzzing of the classifier wrapper, the websearch tool's real existence, the absence of
a model picker, CSS structural sanity). Visual proof (browser screenshots, console log, typed
interaction) is in this lane's final report — this doc is the wiring instructions, not the QA record.
