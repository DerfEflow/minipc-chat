# Lane B wiring spec: model dropdown reformat (RELAUNCH)

**Date:** 2026-08-03. **Lane:** B (RELAUNCH). **Owner of this doc:** Lane B.

Fred, verbatim: *"The way the text has been formatted made it look really messy and amateur."*
This spec makes the picker's row markup produce a name, a plain-language purpose, and the facts
that matter (context, speed tier, price tier) each on their own line, instead of the current
one-line run-on string.

Lane B does **not** edit `public/app.js`, `public/index.html`, `server.mjs`, or `tools.mjs` (out
of ownership for this lane). This document hands the exact edit to whichever lane/integrator
applies it.

## 1. What Lane B actually shipped

- `models.catalog.mjs`: `REASONING_FLOOR` (was `const`, line ~445) and `OUT_MODE_CEIL` (was
  `const`, line ~429) are now both `export const`. No values changed in either table.
  **[verified]** by `node -e "import('./models.catalog.mjs').then(m=>{...})"`: both import as
  objects, `OUT_MODE_CEIL.fast === 2048`, `REASONING_FLOOR` still has its 13 keys, `MODELS.length
  === 25` (unchanged catalog size).
- `public/dominion-models.css` (new): row-content styling, described below.
- `models_dropdown_test.mjs` (new): data-contract and stylesheet tests, described below.

## 2. Why the current row looks amateur: the actual code

The row shell lives in `public/dominion-cinematic-06.css` (`.model-row`, `.mr-name`, `.mr-meta`,
`.mr-tag`, `.mr-price`, `.mr-note`, lines 24-73 of that file). Lane B does not own that file and
does not edit it. The row *content* is built in `public/app.js` by two functions that Lane B also
does not edit, but must specify the replacement for:

- `modelRowHtml(o, cur, mode)`, which builds one row's HTML.
- The call site inside `renderModelPanel()` that constructs the object passed to it.

**The defect, precisely:** `modelRowHtml` renders `o.meta` (built by the caller as
`[params, ctx].filter(Boolean).join(" · ")`, e.g. `"671B (MoE·37B active) · 1M"`) as one string on
one line, and `o.price` as a raw `$in/$out` figure with no comparison point. **The catalog's
`specialty` field, the plain-language purpose Lane B already rewrote for all 25 seats, is never
rendered in the picker at all.** Separately, `models.catalog.mjs`'s `finalize()` already computes
`priceTier` ("Free"/"Budget"/"Standard"/"Premium") and `speedTier` ("Reasons first"/"Replies fast")
on every model record and ships them in the `/api/models` payload (`catalogPayload()` serves
`MODELS` directly). **These fields already exist on the wire and are simply unused by the
picker.** No new server-side computation is needed; the fix is entirely markup and CSS.

**[verified]**: confirmed by reading `public/app.js` lines 1171-1203 and cross-checking against
`models.catalog.mjs`'s `finalize()` (lines 336-348) and `catalogPayload()` (lines 546-548).

## 3. Exact anchor strings in `public/app.js` today

### Anchor A: `modelRowHtml` (lines 1171-1180 as read 2026-08-03)

```js
function modelRowHtml(o, cur, mode) {
  const disabled = o.noKey || o.blocked, sel = o.id === cur;
  const cls = ["model-row"]; if (sel) cls.push("is-selected"); if (disabled) cls.push("is-disabled"); if (o.blocked) cls.push("is-blocked");
  const price = o.free ? `<span class="mr-price is-free">Free</span>` : (o.price ? `<span class="mr-price">${escapeHtml(o.price)}</span>` : "");
  const note = o.blocked ? `<span class="mr-note">blocked · ${escapeHtml(mode)}</span>` : (o.noKey ? `<span class="mr-note">key needed</span>` : "");
  return `<div class="${cls.join(" ")}" data-value="${escapeHtml(o.id)}" ${disabled ? 'aria-disabled="true"' : 'role="option"'}${sel ? ' aria-selected="true"' : ""}>
    <span class="mr-name"><span class="mr-bench">${o.tool ? "🔧" : "💬"}${o.vis ? "👁" : ""}</span><span class="mr-text${o.broadAccess ? " has-machine-grant" : ""}">${escapeHtml(o.name)}</span></span>
    <span class="mr-meta">${escapeHtml(o.meta || "")}</span>
    <span class="mr-tag">${price}${note}</span></div>`;
}
```

### Anchor B: the `renderModelPanel()` call site (lines 1190-1199 as read 2026-08-03)

```js
    for (const m of g.models) {
      const keyed = m.provider === "openrouter" ? availCache.openrouter : m.provider === "openai" ? availCache.openai : m.provider === "deepseek" ? availCache.deepseek : m.provider === "anthropic" ? availCache.anthropic : true;
      html += modelRowHtml({
        id: m.id, name: m.name, tool: m.toolCapable, vis: !!m.vision, free: (!m.inCost && !m.outCost), price: fmtPriceShort(m),
        // Owner-only red/bold: the server only sends broadAccess to Fred's payload, so a guest's
        // rows can never carry the class no matter what the client does.
        broadAccess: m.broadAccess === true,
        meta: [(m.params && m.params !== "undisclosed") ? m.params : null, fmtCtxShort(m.ctx)].filter(Boolean).join(" · "),
        noKey: keyed === false, blocked: !providerAllowedClient(mode, m.provider),
      }, cur, mode);
    }
```

Both blocks are unique in `public/app.js` (verified: each is a single grep match against the
whole file).

## 4. Exact replacement code

### Replace Anchor A with:

```js
function modelRowHtml(o, cur, mode) {
  const disabled = o.noKey || o.blocked, sel = o.id === cur;
  const cls = ["model-row"]; if (sel) cls.push("is-selected"); if (disabled) cls.push("is-disabled"); if (o.blocked) cls.push("is-blocked");
  const tierCls = "mr-price--" + String(o.priceTier || "").toLowerCase();
  const price = `<span class="mr-price ${tierCls}">${escapeHtml(o.priceTier || "")}</span>`;
  const note = o.blocked ? `<span class="mr-note">blocked · ${escapeHtml(mode)}</span>` : (o.noKey ? `<span class="mr-note">key needed</span>` : "");
  const facts = [o.ctxLabel ? o.ctxLabel + " context" : "", o.speedTier || ""].filter(Boolean)
    .map((f) => `<span class="mr-fact">${escapeHtml(f)}</span>`).join("");
  return `<div class="${cls.join(" ")}" data-value="${escapeHtml(o.id)}" ${disabled ? 'aria-disabled="true"' : 'role="option"'}${sel ? ' aria-selected="true"' : ""}>
    <div class="mr-head">
      <span class="mr-name"><span class="mr-bench">${o.tool ? "🔧" : "💬"}${o.vis ? "👁" : ""}</span><span class="mr-text${o.broadAccess ? " has-machine-grant" : ""}">${escapeHtml(o.name)}</span></span>
      ${price}
    </div>
    <p class="mr-specialty">${escapeHtml(o.specialty || "")}</p>
    <div class="mr-facts">${facts}</div>
    ${note}
  </div>`;
}
```

Note the `.mr-name > .mr-bench` / `.mr-name > .mr-text` nesting is preserved exactly. This is
required: `public/dominion-tenant.css` (line 572) selects `.mr-name .mr-text.has-machine-grant` for
the red/bold "this model can act on your machines" mark, and Lane B does not own that file either.
Changing the nesting would silently break that mark for every owner-only model.

### Replace Anchor B with:

```js
    for (const m of g.models) {
      const keyed = m.provider === "openrouter" ? availCache.openrouter : m.provider === "openai" ? availCache.openai : m.provider === "deepseek" ? availCache.deepseek : m.provider === "anthropic" ? availCache.anthropic : true;
      html += modelRowHtml({
        id: m.id, name: m.name, tool: m.toolCapable, vis: !!m.vision,
        // Owner-only red/bold: the server only sends broadAccess to Fred's payload, so a guest's
        // rows can never carry the class no matter what the client does.
        broadAccess: m.broadAccess === true,
        specialty: m.specialty || "",
        priceTier: m.priceTier || ((!m.inCost && !m.outCost) ? "Free" : "Standard"),
        speedTier: m.speedTier || "",
        ctxLabel: fmtCtxShort(m.ctx),
        noKey: keyed === false, blocked: !providerAllowedClient(mode, m.provider),
      }, cur, mode);
    }
```

`m.specialty`, `m.priceTier`, and `m.speedTier` already arrive on every model in `g.models`. They
are stamped onto every record by `models.catalog.mjs`'s `finalize()` and ride the existing
`/api/models` response unchanged. No server edit is needed for this lane's part of the fix.

**Out of scope, left alone on purpose:** `optionLabel()` (native `<select>` labels, line ~999) and
`updateModelTrigger()` (the trigger button's own price badge, line ~1157) still use
`fmtPriceShort`/raw meta strings. Fred's complaint was specifically about the dropdown's row list.
The native select is a keyboard/accessibility fallback most users never see, and the trigger shows
one already-chosen model, not a list to scan. Reformatting those is a separate, smaller call if
Fred wants it. Flagged here rather than silently expanded.

## 5. The `<link>` line and where it goes in `public/index.html`

Add, as the **last** stylesheet `<link>` in the `<head>`, after the existing
`<link rel="stylesheet" href="/altana.css?v=1" />` (line 28 as read 2026-08-03):

```html
<link rel="stylesheet" href="/dominion-models.css?v=1" />
```

**Why a raw tag, not an `@import` inside `dominion-ui.css`:** this follows the house pattern
another lane already established after the touch-css defect (`project_dominion_touch_css` in
persistent memory). This app once had **no navigation at all between 721px and 1180px for four
days** because the sheet that built it was pulled in only via an `@import` inside
`dominion-ui.css`, which made it invisible to both `grep` and `document.styleSheets`. A raw
`<link>` at the `index.html` level is grep-able and shows up in `document.styleSheets` directly.

**Why last in load order, specifically:** `.model-row`, `.mr-name`, `.mr-price`, and `.mr-note` are
all already declared once in `public/dominion-cinematic-06.css` (loaded near the top via
`dominion-ui.css`'s own `@import` chain). `public/dominion-models.css` redeclares the same
selectors at the same specificity (single class, no `!important`) to restructure the row from a
2-track grid to a stacked flex layout. CSS resolves same-specificity conflicts by source order, so
this sheet must load strictly after every sheet it overrides. Loading it last guarantees that,
regardless of what else is added between now and then.

## 6. What the new CSS does (`public/dominion-models.css`)

- `.model-row` becomes a flex column: head line, specialty line, facts line, optional note line.
  This replaces cinematic-06's 2-track grid tuned for a single line of name plus a single line of
  meta.
- `.mr-head`: bench glyph plus name (unchanged nesting) plus a `.mr-price` tier badge, pushed
  right.
- `.mr-specialty`: the catalog's plain-language purpose string, its own line, muted
  (`--ink-soft`), 2-line clamp as a safety net on the narrowest panel width (mobile pins the panel
  to `left:10px; right:10px`, about 355px on a 375px phone). Not a length limit the copy is
  expected to hit.
- `.mr-facts`: context window and speed tier as separate small chips (`flex-wrap`, no column
  count) instead of one comma-joined string.
- `.mr-price--free/--budget/--standard/--premium`: tier-colored badges reusing the same
  green/cyan/copper/red language `dominion-ui.css`'s `.cost-chip` already uses, so the same color
  means the same thing in the pre-send cost chip and in the model picker.
- No hard-coded grid column count anywhere (Fred's standing rule). Every layout is a single flex
  row with `flex-wrap`.
- Only `transform` and `opacity` are transitioned/animated (the price badge's hover lift, disabled
  under `prefers-reduced-motion`).
- No `position: fixed` anywhere in this file, so the ancestor transform/filter trap that can break
  fixed positioning never applies to anything Lane B added. (The panel's own `position: fixed` at
  the 900px breakpoint lives in `dominion-cinematic-06.css` and is untouched.)
- The 375px query only tightens font sizes. It introduces no second breakpoint number that has to
  stay in sync with cinematic-06's existing 900px panel breakpoint, the exact failure shape of the
  touch-css defect (two edges, 721px and 1180px, that quietly stopped matching).

## 7. Tests

Command: `node models_dropdown_test.mjs`

Real output:

```
  PASS  REASONING_FLOOR and OUT_MODE_CEIL are exported (Lane D's unblock)
  PASS  the catalog is non-empty and CATEGORIES covers every model's category
  PASS  every catalog seat produces a complete display record: no undefined, no empty field
  PASS  no two seats collide on the display name a user actually reads
  PASS  no two seats collide on catalog id (the value the row actually selects)
  PASS  price formatting is stable: fmtPrice is always "Free" or "$in / $out" with at most 2 decimals
  PASS  fmtCtx never returns a raw byte-count string (K/M suffix, not a 6-7 digit number)
  PASS  priceTier is consistent with the model's own inCost/outCost (no drift between the two)
  PASS  public/dominion-models.css exists and is non-trivial
  PASS  public/dominion-models.css has balanced braces (a cheap but real parse check)
  PASS  public/dominion-models.css declares no hard-coded grid column count
  PASS  public/dominion-models.css never transitions a layout-shifting property
  PASS  public/dominion-models.css never uses position:fixed (avoids the transform/filter ancestor trap)

13 checks passed - the picker's data contract and stylesheet are sound
```

The test imports `models.catalog.mjs` directly (no server, no `/api/models` fetch) and separately
reads `public/dominion-models.css` from disk. It does not and cannot exercise the actual DOM output
of `modelRowHtml()`, because that function lives in `public/app.js`, which this lane does not edit
and did not change. **[unverified]**: the rendered picker in a real browser, since the app.js edit
in section 4 has not been applied by this lane. Whoever applies Anchor A/B's replacement should
re-run a visual check at 375px and desktop after wiring it in.

## 8. Assumptions

- **[assumed]** `priceTier`/`speedTier` naming and values (`"Free"/"Budget"/"Standard"/"Premium"`,
  `"Reasons first"/"Replies fast"`) are stable. They are computed once in `finalize()` and shipped
  as-is; a future edit to `priceTierOf()`/`speedTierOf()` would change the badge text without any
  markup change needed, which is the intended behavior.
- **[assumed]** the integrator applying Anchor A/B is a different lane or a follow-up pass, per the
  ownership rule that this lane must not touch `public/app.js`.
