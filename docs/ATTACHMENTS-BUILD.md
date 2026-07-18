# Attachments Build (2026-07-18)

FITS pack for adding picture + file attachments to the Dominion AI chat, both the owner
surface and the guest/tenant surface. Blast radius: HIGH on the /chat pipeline (live,
billed, customer-facing since Stripe went live 2026-07-18), LOW on docs/copy.

## Mission line

Fred and his paying guests can attach pictures and text files to a chat message from the
composer, see them in the transcript, and have the chosen model actually receive them.
Models that cannot see images refuse honestly, before any provider call or charge, and
never silently drop or substitute.

## Wire protocol (additive, backward compatible)

Client message shape stays `{ role, content: string }` everywhere, with an OPTIONAL
`attachments` array on user turns:

```
{ role: "user", content: "what is this?", attachments: [
  { kind: "image", name: "roof.jpg", mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,..." },
  { kind: "text",  name: "notes.md", text: "..." } ] }
```

- `content` remains a plain string, so screening, routing, titles, search, chatlog,
  training sink, and episodic memory all keep working untouched.
- The SERVER builds provider multimodal parts only at the model-call boundary
  (cloudChatStream). Old clients that never send `attachments` exercise byte-identical
  code paths.
- Attachments are never persisted server-side. The chatlog stores text markers only.

## Verified capability facts (no guessing, per the standing catalog-audit rule)

- [verified 2026-07-18, live OpenRouter /api/v1/models pull] image input supported:
  kimi-k3, kimi-k2.6, minimax-m3, qwen3-vl-8b-instruct, grok-4.20, llama-4-maverick,
  gemma-4-31b-it:free, mistral-small-3.2-24b-instruct, perplexity/sonar-pro.
  Text-only confirmed for every other OpenRouter model in the catalog, including
  minimax-m2.5, glm-5.2, qwen3-235b (owner default), and all direct DeepSeek ids.
- [verified 2026-07-18, LIVE PROBE with real pixels] a generated solid-orange PNG sent as
  our exact streamed payload was correctly named "orange" by qwen3-vl-8b via OpenRouter
  ($0.0000114) and by claude-haiku-4-5 on Anthropic's OpenAI-compat endpoint (data-URL
  image_url confirmed working there). OpenAI gpt-4o / gpt-5.5 / gpt-5.6 remain
  documentation-verified (same wire format).
- [verified: PROVIDERS table in server.mjs] local qwen3 tiers are supportsVision:false.
- [verified 2026-07-18, LIVE PROBE] DeepSeek's chat API REJECTS image parts outright
  (HTTP 400: unknown variant `image_url`, expected `text`). vision:false is fact, and
  since DeepSeek V4 Flash is the GUEST DEFAULT model, the vision gate is exactly what
  stands between every guest and that raw 400.
- The weekly catalog audit now checks vision drift the same way it checks tool drift.

## Wargamed risks and their mitigations

1. Text-only regression on /chat (breaks the live product for everyone).
   Mitigation: `attachments` is optional; absent means identical behavior. Existing e2e
   suite must stay green; new no-attachment regression test included.
2. Provider 400s or silent drops when images reach non-vision models.
   Mitigation: vision flags seeded from live data; server-side gate refuses image
   attachments on the LAST user turn for non-vision targets with an honest message and
   error code `attachments_unsupported`, before any provider call or metering. Older
   in-history images flatten to text markers for non-vision models so a conversation
   stays usable after switching models. Client mirrors the gate with a composer hint.
3. Payload and storage blowups (base64 in localStorage, request bodies, logs, SSE replay).
   Mitigation: client downscales images to <=1568px JPEG (PNG kept when small), max 4
   images + ~2.5MB per message, text files capped at 200KB. Server caps the /chat body at
   32MB and validates every attachment (mime allowlist, per-item + per-message caps,
   unknown fields stripped). Server logs and chatlog only ever carry markers. localStorage
   keeps full attachment data only for the 12 most recent chats and retries a failed save
   with attachment data stripped.
4. Stale PWA clients after deploy.
   Mitigation: shape is additive both directions (old client + new server, new client +
   new server both fine). sw.js cache name bumped; the existing /api/version watcher
   reloads long-lived tabs within ~90s.

## Success criteria (ship line: all green)

- [x] Mock-provider e2e proves the exact OpenAI multimodal payload leaves the server
      (image part + text part), tokens stream, done meta arrives. (attachments_e2e #2)
- [x] Non-vision model + image = SSE error `attachments_unsupported`, zero provider
      calls, zero metering (provider hit-counter asserted 0). (attachments_e2e #4, #5)
- [x] Text-file attachment reaches any model inlined as a fenced block. (attachments_e2e #3)
- [x] Invite/credit gates still fire before the vision gate for guests. (attachments_e2e #7)
- [x] Oversized/malformed attachments are rejected or stripped honestly. (attachments_e2e #8)
- [x] No-attachment chat behaves exactly as before. (attachments_e2e #6 + all 19 existing
      suites green 2026-07-18, incl. multitenant_e2e 11/11)
- [x] Visual: composer attach + preview + thumbnail + honest non-vision hint verified on
      owner (8095) AND guest (8094) devboot surfaces via live DOM drive; full send round
      trip with a file chip confirmed. (Pixel screenshot skipped: known pane timeout.)
- [x] Deployed via railway up 2026-07-18 (commit 4f11062); /api/version build flipped
      1784347357945 -> 1784376123662 in ~40s; boot log clean (4 providers keyed, corpus
      885/14696 intact, mini-pc hands node reconnected). The 90s post-boot catalog audit
      line had not yet appeared in the pulled log window; the identical audit ran green
      locally against live OpenRouter data this session (0 problems, 0 vision drift) and
      its verdict lands in the owner console at /setup.
- Live provider probe DONE 2026-07-18 (Fred's pick, option 2): real pixels against real
  providers using the exact deployed payload shape. Two vision-positive answers, one
  expected rejection, total spend under a cent. The only remaining unexercised span is
  Fred's phone -> Cloudflare Access -> the deployed /chat plumbing in one motion, and the
  byte-level e2e already pins that plumbing's output to the probed shape. First casual
  photo Fred sends closes it as a side effect.

## Round 2 (2026-07-18): PDF + DOCX for everyone

Fred's directive: pdf, docx, txt, and md attachments for every user. txt/md already
worked; this round adds PDF + DOCX by extracting text ON THE DEVICE at attach time, so
documents ride the existing {kind:"text"} wire and work with EVERY model (local Qwen and
the DeepSeek guest default included), with no binary parsing added to the server and no
provider-specific token surprises (extracted text bills as ordinary prompt tokens, so the
cost chip stays honest via the new attachChars preflight field).

- PDF engine: vendored Mozilla pdf.js 4.10.38 legacy (public/vendor/pdfjs, Apache-2.0,
  lazy-loaded only when a document is attached; never precached). Real-world font/CMap
  handling is exactly where homegrown extractors produce garbage.
- DOCX: dependency-free central-directory zip reader + DecompressionStream in
  public/attach-extract.mjs. Old binary .doc refuses with "save it as .docx first".
- Honest refusals: scanned/image-only PDFs ("no extractable text"), password PDFs,
  exotic-font garbage (readable-ratio check), zip64, non-docx bytes.
- Server touches: .mjs MIME type (dynamic import() refuses non-JS types; found live in
  devboot when the module fetch failed), attachChars in /estimate, attachment text
  lengths in the context-window math. Nothing else.
- Proof: attach_extract_test.mjs (6 round-trip/refusal tests using docwriters.mjs's own
  generated PDF+DOCX against the same extractor code phones run, via the vendored
  pdf.js); all 16 server suites re-run green; devboot browser drive extracted both
  formats in 98ms, chips staged and rendered, marker text verified in storage, send
  round-tripped. Deployed same day.

## Round 3 (2026-07-18): OCR for scanned PDFs + Excel .xlsx

Fred's picks 2+3. Both ride the round-2 architecture.

- **Scanned-PDF OCR**: when extractPdf finds no text layer, the device renders the pages
  to JPEGs (pdf.js, <=12 pages, per-page hard timeouts so a pathological file can never
  wedge the composer) and POST /api/ocr transcribes them with a vision model; the text
  returns as a normal {kind:"text"} attachment, so a scanned document then works with
  EVERY chat model. Gates mirror /chat exactly (identity, invite, credits before any
  spend); privacy is refuse-not-substitute (Private = refused honestly, Trusted = Claude
  Haiku, Normal = Qwen3-VL, env-overridable OCR_MODEL/OCR_MODEL_TRUSTED); non-owner cost
  charges credits like a turn (no training-sink write); every run lands in usage.jsonl
  (mode "ocr"). Output carries an in-band honesty note ("verify critical numbers").
- **XLSX**: on-device extraction to "[Sheet: Name]" blocks of tab-separated rows.
  Handles shared strings (incl. rich-text runs), inline strings, booleans, formula
  cached values, and date cells (styles numFmt -> ISO dates, 1900 and 1904 systems).
  Old .xls refuses with "save it as .xlsx first".
- Bugs caught by verification, fixed: (1) pdf.js TRANSFERS (detaches) the ArrayBuffer it
  is given — extract-then-render on the same buffer crashed; the module now always takes
  a private copy. (2) The OCR endpoint initially reused the chat sanitizer whose
  4-images-per-MESSAGE cap silently trimmed 12-page jobs to 4 — pages now validate
  against the OCR cap. (3) My first xlsx date test asserted the WRONG date (the
  extractor's calendar math was right). (4) The embedded test pane cannot rasterize
  pdf.js renders at all (renders never resolve — same pane defect as its screenshot
  timeouts); verification moved to REAL headless Chrome over raw CDP, where the full
  scanned path runs in ~0.4s and page render in 59ms.
- Proof: 9 extractor tests (xlsx round trip via docwriters' own writer + hand-built
  Excel-shape fixture with sharedStrings/dates), 14 attachments e2e (4 new /api/ocr
  cases: per-page provider calls + page tags asserted against the mock, Private-mode
  refusal with zero calls, invite gate before spend, page cap + junk stripping), full
  suite green, real-Chrome CDP drive of the scanned pipeline end to end.
- LIVE PROBE 2026-07-18 (deployed same day, build 1784383906119): the page JPEG that
  real Chrome rendered from the scanned fixture, sent to the REAL production OCR model
  (qwen3-vl via OpenRouter) with the exact server prompt, returned exactly "(blank
  page)" for the text-free page — verbatim prompt-following on the live provider,
  $0.000067. Every link in the OCR chain now has at least one real observation.

## Ledger

- L-A1 CLOSED 2026-07-18 (round 3): scanned/image-only PDFs now transcribe via /api/ocr.
  Remaining niche: scans BEYOND 12 pages transcribe only the first 12 (said honestly in
  the attachment text); raise OCR_MAX_PAGES if Fred ever needs more.
- L-A5 OPEN (low): raw PHOTOS of documents attached as images still require a vision
  model; a "read text from this picture" action reusing /api/ocr would let them reach
  text-only models too. Small follow-up.
- L-A6 NOTE: the content wall does not screen OCR'd text (same scope as L-A2).
- L-A2 OPEN (low): the content wall screens text only; image content is not screened
  locally. Providers' own abuse filters are the only image-side backstop. Acceptable per
  current safety.mjs scope; revisit if guests misuse it.
- L-A3 CLOSED 2026-07-18: live probe settled it. DeepSeek rejects image parts at the API
  boundary (400 deserialization error), so vision:false stays and no flag flips.
- L-A4 CLOSED 2026-07-18: image tokens are billed by providers inside prompt_tokens, so
  metering/credits needed no change; verified usage rows carry the higher token counts.

## Rollback

Single commit on main; `railway up` redeploys the previous commit cleanly. No schema, no
env, no data migration. Mini-PC fallback deployment untouched by this change.
