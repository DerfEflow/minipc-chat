# Guest Forge node: self-serve, 2026-07-31

Before this change, a guest who wanted Dominion to write files onto their own computer had to ask
Fred for a shared Cloudflare Access service-token id/secret. `/forge/token` handed back a config
object with those two fields set to literal placeholder text: `"<ask Fred for the shared Dominion
node service-token id>"`. There was no self-serve path.

## Why the CF Access step existed, and why it was safe to remove

Cloudflare Access sat in front of the entire `/hands/*` path as one application (`app.dominion.tools/
hands`, policy `fb0a60dc`, non-identity, three named service tokens: laptop, mini-pc, one spare).
That blocked everything under `/hands/*`, including the three endpoints a guest's own node actually
needs (`/hands/stream`, `/hands/result`, `/hands/chunk`).

Reading `hands/hub.mjs` end to end shows the real access control was never Cloudflare Access — it was
already the per-user token:

- `/hands/run` and `/hands/nodes` (the two endpoints that can address ANY named machine — the
  dangerous ones) require `authed()`, the single shared owner secret. A per-user Forge token can
  never satisfy this check; `nodeAuthKey()` only returns `"owner"` for the real shared secret.
- `/hands/stream`, `/hands/result`, `/hands/chunk` accept either the owner secret OR a valid per-user
  token (minted by `forgeStore.generateToken`, a 192-bit random value stored only as a SHA-256 hash).
  A per-user token is forced into the `user:<uid>` namespace by `nodeAuthKey()` and can never register
  under another name, never complete another node's job (`handleResult`/`handleChunk` both check
  `j.node !== authKey`), and is never accepted by `/hands/run`.

So Cloudflare Access in front of the three stream/result/chunk endpoints was pure redundant
defense-in-depth for a boundary the app already enforced correctly, and it was the ONLY reason a
guest needed Fred in the loop.

## What changed (Cloudflare Zero Trust, account `d78b53b020856d24423b39a5577c45f2`)

1. Existing app `e86fc080-11ae-4567-a826-b835afe343af` ("Dominion hands (service token)") narrowed
   from domain `app.dominion.tools/hands` to two exact destinations: `app.dominion.tools/hands/run`
   and `app.dominion.tools/hands/nodes`. Same policy (`fb0a60dc`, same three service tokens),
   untouched.
2. New app `5ba17258-e403-441f-99e0-128583acdcb2` ("Dominion hands guest-node channel") created for
   `app.dominion.tools/hands/stream`, `/hands/result`, `/hands/chunk`, with a single `bypass` policy
   (`3cdace62-...`). Cloudflare skips authentication entirely for these three paths; the app's own
   bearer-token check (above) is the real gate, same as it always was for a valid per-user token.

Verified live: `/hands/run` and `/hands/nodes` still return Cloudflare's 403 Access-denied page with
no headers. `/hands/stream`, `/hands/result`, `/hands/chunk` now reach the app directly (401 JSON for
a missing bearer, 404 for a wrong method) — no CF Access redirect. Existing owner node SSE streams
(laptop, mini-pc) were not interrupted; Cloudflare Access is only evaluated on the initial connection,
not on an already-open stream, and no deploy/restart happened during the change.

Rollback: PUT app `e86fc080` back to `domain: "app.dominion.tools/hands"`, `self_hosted_domains:
["app.dominion.tools/hands"]`, `destinations: [{type:"public",uri:"app.dominion.tools/hands"}]`
(full original JSON captured in session scratchpad `cf_app_full.json`), then delete app `5ba17258`.

## What changed (app code)

- `/forge/token` (`server.mjs`): drops the two Cloudflare fields entirely. Response is now just
  `{ token, config: { HANDS_URL, HANDS_TOKEN, HANDS_NODE }, note }`.
- `/forge/installer` (new, POST, `server.mjs` + `forge.mjs`'s `buildInstallerZip`): mints a token and
  returns a zip — `Connect Me To Dominion.bat` (checks for Node, points to nodejs.org in plain English
  if missing, otherwise sets the two env vars and runs the node), `READ ME FIRST.txt`, `hands.mjs`,
  `snapshot.mjs`. One download, one right-click "Extract All", one double-click. No env vars to type,
  no Cloudflare fields, no elevation, no scheduled task — the node only needs to run while the black
  window is open, and a technical novice's roots are picked afterward through the existing folder
  picker (`/forge/browse` + `/forge/roots`), which pushes `set_roots` live once the node connects.
