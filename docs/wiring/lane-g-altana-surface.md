# Lane G wiring spec: Altana presence surface

**Owner of this spec:** Lane G (Altana surface). **Applies to:** the INTEGRATOR only. Lane G does
not edit `public/index.html`, `server.mjs`, `tools.mjs`, or `public/app.js`. This document is the
exact, copy-pasteable instruction for whoever does.

**Files Lane G owns and shipped:** `public/altana.js`, `public/altana.css`, `ops/altana-preview.html`,
`ops/altana-preview.mjs`, `altana_test.mjs`.

---

## 1. Why a raw `<link>`/`<script>` tag, not `@import` or injection

`public/index.html` was checked directly before writing this spec. Two patterns already exist in
this codebase and they are NOT interchangeable:

- `public/dominion-ui.css` uses `@import url(...)` **internally**, to pull in the six
  `dominion-cinematic-0N.css` sheets and `dominion-rendered-v2.css`. But `dominion-ui.css` ITSELF
  is loaded into `index.html` via a plain `<link rel="stylesheet" href="/dominion-ui.css?v=43" />`
  `[verified]` at `public/index.html:14`.
- `public/dominion-ui.js` **injects** `dominion-cinematic.js` at runtime via
  `document.createElement("script")`, but `dominion-ui.js` ITSELF is loaded into `index.html` via
  a plain `<script src="/dominion-ui.js?v=40"></script>` `[verified]` at `public/index.html:587`.

So the pattern at the `index.html` level, for every one of the 14 stylesheets and 13 scripts
already wired there, is a **raw versioned tag**. `@import`/injection only happens ONE LEVEL DOWN,
inside a file that is itself raw-tagged, and only when that file is bundling several sibling
sheets/scripts under one conceptual name. Altana is a single CSS file and a single JS module with
no siblings to bundle, so there is nothing to gain from an inner `@import` and a real cost: the
07-28 touch-CSS incident (`docs/project_dominion_touch_css` in memory) happened because an
`@import` inside `dominion-ui.css` made a stylesheet invisible to `grep` and to
`document.styleSheets` for four days. Altana gets a raw tag specifically so it stays greppable.

**Chosen: raw `<link>` and raw `<script type="module">` tags, following the `index.html`-level
convention exactly.**

---

## 2. Exact lines to add

### 2.1 Stylesheet

Anchor (exact, unique string in `public/index.html`):

```html
<!-- Last on purpose: touch corrections must outrank the width-based sheets above. -->
<link rel="stylesheet" href="/dominion-mobile.css?v=1" />
```

Insert **immediately after** that anchor. `altana.css` loads after the mobile touch corrections
here purely to keep this diff additive rather than reshuffling existing lines; ordering does not
affect correctness since `altana.css` only sets rules under its own `#altana` id and cannot
conflict with anything width-based:

```html
<link rel="stylesheet" href="/altana.css?v=1" />
```

### 2.2 Script

Anchor (exact, unique string in `public/index.html`):

```html
<script src="/dominion-tenant.js?v=5" defer></script>
<script src="/dominion-orders.js?v=1" defer></script>
```

Insert **immediately after** `dominion-orders.js` and **before** the inline
`DOMContentLoaded`/`DominionTenant.init()` script tag that currently ends the file:

```html
<script type="module" src="/altana.js?v=1"></script>
```

`type="module"` is required: `altana.js` uses `export`/`import` syntax (see `altana_test.mjs`'s own
import line), and a plain `<script src>` tag would throw a `SyntaxError` on the `export` keyword
and take the rest of that tag's execution down with it. That is exactly the class of failure this
brief warned against ("a past session shipped `altana.js` that threw on load").

### 2.3 Mount call

`altana.js` exports `altanaMount(opts)` but never calls it itself. Mounting is the integrator's
decision, because `enabled` must come from a real feature flag rather than a hardcoded `true`. Add
one inline script **after** the `altana.js` module tag from section 2.2:

```html
<script type="module">
  import { altanaMount, recordSignIn } from "/altana.js";
  // `enabled` gates the whole feature. Leave this false until Lane F's brain (altana.mjs,
  // altana-context.mjs) exists and is wired: see docs/ALTANA-WAVE-BUILD-PLAN.md lane F.
  // Flip source TBD by the integrator: a tenant flag, a query param, or a hardcoded `true` once
  // Lane F ships. Do not flip this without Lane F's endpoint live; see SHIPPED DARK note atop
  // altana.js for why (the Knowledge Vault precedent: three buttons that opened three empty rooms).
  altanaMount({ enabled: false });
</script>
```

`recordSignIn()` is imported here only because whichever code owns the login success path
(`[assumed]` somewhere in `app.js` or `server.mjs`'s session bootstrap) should call it exactly once
per sign-in, not once per page load. Lane G does not know where that path is; the integrator wires
one call to `recordSignIn()` at the true sign-in moment and passes the return value into
`altanaMount({ signins })`, or lets `altanaMount` call `recordSignIn()` itself (its default
behavior when `opts.signins` is omitted) if once-per-page-load semantics is acceptable in practice.
**This is the one place Lane G is genuinely unsure of the right wiring, flagged rather than
guessed.**

---

## 3. Client-to-server contract (for Lane F / the integrator)

`altana.js` makes **zero network calls**. Every hazard note in the file explains why: a presence
widget that can fail on a fetch is a presence widget that can take the whole page's chrome down
with it. Everything below is a proposal for how Lane F's brain and the integrator should drive this
surface. None of it is wired or verified live today.

### 3.1 State reflection: function calls, not HTTP (this part IS real, today)

```js
import { altanaState } from "/altana.js";
altanaState("thinking");   // a turn was just sent to the model
altanaState("speaking");   // tokens are streaming back (or TTS is playing, if voice exists)
altanaState("attention");  // a proactive nudge; self-clears after 2.9s, recall it if the
                            // condition that triggered it is still true after that
altanaState("idle");       // or altanaState(null); the turn is done
```

`[assumed]` the integrator adds these four calls at the existing chat send/stream/complete/error
call sites already in `app.js` and/or `server.mjs`'s SSE handling. This costs nothing new on the
wire: Altana just reflects state the app already has.

### 3.2 Proactive nudge channel: proposed, NOT built, NOT verified

If Lane F's brain wants Altana to flag something with nobody mid-turn (a budget warning, "your
build finished while you were away"), the surface needs a way to hear about it independent of an
active chat turn. Proposed shape, for Lane F to implement or reject:

- **Endpoint:** `GET /api/altana/nudges` (Server-Sent Events, `Content-Type: text/event-stream`).
- **Event:** `event: nudge` / `data: {"id":"<uuid>","kind":"attention","message":"<text>"}`.
- **Streaming:** yes, SSE, one event per nudge, connection held open. This matches the pattern the
  rest of this app already uses for chat streaming, so no new client machinery is needed.
- **Client responsibility:** on receipt, call `altanaState("attention")` only. **The dot never
  renders the message text itself**; that stays inside whatever surface already renders assistant
  text. This keeps `altana.js`'s job to exactly one thing: presence, not content.
- **Non-streaming fallback**, if Lane F decides SSE is overkill for something this infrequent:
  `GET /api/altana/nudges/poll?since=<lastId>` returning `{ "nudges": [{ "id", "kind", "message" }] }`,
  polled by whatever interval timer the app already runs elsewhere. Do not add a new poll loop just
  for this.
- **Redaction:** per wargame F2 in `docs/ALTANA-WAVE-BUILD-PLAN.md`, no secret or PII may reach this
  channel. That is Lane F's assembler's job, not the surface's, since the surface cannot inspect
  content it never receives (only `kind`/`message` strings for display elsewhere).

Nothing in `public/altana.js` currently calls this endpoint. It does not exist. This section is the
contract Lane F should build against if the proactive-nudge feature is prioritized, tagged
`[assumed]`/`[guessed]` throughout because it was designed from the mission line, not from a spec
Fred wrote.

### 3.3 What is explicitly not in scope for the surface

- No chat UI, no message rendering, no history: that is the app's existing composer.
- No auth, no session handling: `altana.js` never touches cookies, tokens, or `fetch`.
- No click-to-open behavior yet. Today, clicking the dot (when not a drag) does nothing beyond
  suppressing the click when a drag just happened. Wiring a click handler to open a mini-chat panel
  is a `public/app.js` change (integrator-owned) once Lane F's brain has an endpoint to open onto.

---

## 4. What was verified before writing this spec

- `[verified]` `public/index.html` has no existing reference to `altana` anywhere (`grep -ri altana
  public/index.html public/app.js server.mjs tools.mjs` returned nothing). This is a clean add, not
  a merge.
- `[verified]` Exact anchor line numbers as of this session: CSS anchor at `index.html:27`, script
  anchor at `index.html:588-589`.
- `[verified]` `node altana_test.mjs`: 11/11 passing (see Lane G final report for full output).
- `[verified]` Preview loaded live in the browser at desktop width (961x830 and 1440x900) and mobile
  width (375x812), dragged via dispatched PointerEvents, resized down to 200x150 to force
  reclamping, reloaded to confirm the dragged position persisted. No console errors at any step.
