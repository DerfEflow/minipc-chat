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

## Ledger

- L-A1 OPEN (low): PDF attachments deferred. OpenRouter file parts + Anthropic document
  blocks can carry PDFs later; v1 is images + text-like files. Composer says so honestly
  (the picker filters to supported types).
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
