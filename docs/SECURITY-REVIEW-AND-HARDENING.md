# Dominion AI — Security Review and Hardening Plan

Written 2026-07-18, after the day that connectors, browser/desktop reach, and a real
security incident all landed in the same session.

**Read this before touching identity, tenancy, connectors, or ingress.** It is written for
whoever picks this up next, including a future model with none of today's context. It records
what broke, what the fix actually was, and what is still soft. Where it says NEVER, it means
a specific thing went wrong once already.

---

## 0. What this system is

A multi-tenant AI assistant PWA. Live at `app.dominion.tools`, Railway-hosted, fronted by
Cloudflare Access. Stripe is in LIVE mode. **There are paying customers on it right now.**
Every decision below is made under that constraint: this is not a toy, and a mistake here
reads other people's chats.

Two identity classes:
- **Owner** (Fred). Full reach: Forge file tools, machine control, all connectors.
- **Guest** (paying tenants). Sandboxed to `SAFE_TOOLS`, own encrypted credential store,
  own Forge root, own connector state. Guests must never see owner data or owner env creds.

---

## 1. The incident (2026-07-18)

### What happened

While checking deployment state I ran `railway domain`. I believed it was a read command.
**It is not — it CREATES a domain.** It generated `dominion-production-c80e.up.railway.app`,
a public hostname pointed straight at the container, completely bypassing Cloudflare Access.

I then confirmed the damage by curling that hostname with a hand-written header:

```
curl -H "cf-access-authenticated-user-email: fredwolfe@gmail.com" https://<stray-domain>/...
→ isOwner: true
```

Owner privileges, from the open internet, with one forged header and no credential of any
kind. Exposure window roughly 5–10 minutes. Deleted via the GraphQL `serviceDomainDelete`
mutation. No evidence of third-party access in that window, but "no evidence" is not "no
access" — the request logs are not fine-grained enough to prove a negative.

### The real flaw the incident exposed

The stray domain was the trigger. It was not the vulnerability.

The vulnerability was that `tenancy.mjs` read `cf-access-authenticated-user-email` as raw
text and trusted it. Nothing verified it. That made **network topology the only security
control in the entire system** — the app was safe only for as long as every path to the
container ran through Cloudflare. One accidental hostname, one misconfigured proxy, one
Railway feature change, and the whole tenancy model is gone.

That is not a security model. That is a coincidence that had been holding.

### The fix

`accessjwt.mjs`. Cloudflare Access also sends `Cf-Access-Jwt-Assertion`, an RS256 JWT signed
by the team's keys. We now verify signature, audience, issuer, and expiry against the team
JWKS, and take the email from the **verified claims**. Zero npm dependencies — Node's builtin
`crypto` does RS256 against the JWKS.

Identity now rests on a signature instead of on a hostname.

Live state: `ACCESS_JWT=enforce`. The forged-header attack was re-run from the public
internet after the flip and returned nothing.

---

## 2. Rules that came out of this. Do not relearn these the hard way.

**NEVER run `railway domain` to inspect anything.** It is a create command with a read
command's name. To list domains, use the GraphQL `domains` query. This one cost us a live
exposure.

**A rejected JWT must yield NOTHING. It must never fall back to the header.** If a bad token
downgrades to header trust, forging is trivial again — an attacker just sends garbage
alongside their forged header. `accessjwt_test.mjs` has a test named exactly this. If that
test ever goes red, the vulnerability is back.

**A service token must NEVER resolve to a human account.** Service tokens carry `common_name`
and no email. They are a legitimate Access identity and they are not a user. They return
`identity:"service"` with `email:""`. If a node's service token could become the owner, the
mini-PC becomes a privilege escalation path. Also tested by name.

**`keys: 0` on `/admin/access` means the JWT layer is doing nothing.** In `prefer` mode a
wrong team domain degrades *silently* — every request quietly falls through to the header and
you believe you are protected. Check `keys > 0` before trusting anything about this layer.

**Never flip to `enforce` without evidence.** Watch `/admin/access` until you see real traffic
with `jwt > 0` and `rejected: 0`, including every service token. Flipping blind locks out
every user and every node at once.

---

## 3. The three config bugs that nearly shipped

All three were caught by checking `/admin/access` health before flipping modes. This is why
that endpoint exists — it was built specifically to make misconfiguration loud.

1. **Wrong team domain.** `misty-queen-8e41.cloudflareaccess.com` is the Cloudflare
   *organization display name*. The actual auth domain is **`domi-ai.cloudflareaccess.com`**.
   The wrong one returns 404 HTML at `/cdn-cgi/access/certs`, so zero keys load. In `prefer`
   that fails silently; in `enforce` it would have locked out every user.

2. **Missing second audience.** `CF_ACCESS_AUD` needs **both** the main app tag and the hands
   service-token app tag. With only the first, the mini-PC node logged "audience mismatch" and
   would have gone dark on the enforce flip.

3. **Google OAuth `redirect_uri_mismatch`** — a trailing `.` on the registered redirect URI in
   the Google console, hidden by field overflow so it was invisible without clicking into the
   field. Worth remembering as a class: Google echoes back the URI *it received*, not the one
   you registered, so eyeballing the error against your config shows two identical strings.
   When a URI mismatch makes no sense, click into the field and check for invisible trailing
   characters before assuming propagation delay.

---

## 4. Windows Session 0 (the hands node)

The mini-PC hands node ran as SYSTEM via a scheduled task. Services and SYSTEM tasks live in
**Session 0**, which has no interactive desktop. Consequences: `desktop_control screenshot`
returned raw CLIXML errors, `windows` returned `[]`, and the browser Chrome launched was
invisible to Fred.

Fixed by re-pointing the task to `UserId 'Fred', LogonType Interactive, RunLevel Highest`,
trigger `AtLogOn`, with auto-restart. Verified `sessionId 1`.

Rollback XML: `C:\dominion-hands\task-backup-session0.xml`.

**Rule: anything that touches the desktop must run in the interactive session.** If desktop
tools start returning empty lists rather than errors, check the session ID first.

---

## 5. Current security posture — honest assessment

### Solid

- **Identity is cryptographic.** RS256 JWT verified against team JWTS, audience and issuer
  checked, expiry enforced. 18 tests in `accessjwt_test.mjs` including the exact attack.
- **Tenant wall.** `SAFE_TOOLS` / `FORGE_TOOLS` with `filterToolDefs(defs, role, extra)`.
  Guests cannot reach Forge, machine, browser, or desktop tools.
- **Credential isolation.** Per-account AES-256-GCM encryption at rest. Owner env credentials
  fall through to `ownerEnv` **only** when `T.isOwner` — a guest cannot inherit owner keys.
- **Carve-outs.** `PROTECTED_RE` blocks `D:\`, app-backups, db-backups, `pg_dump`/`pg_restore`
  across connector args, browser ops, and desktop typing. Verified firing against the live node.
- **Browser `file:` scheme refused outright**, so browser control cannot become filesystem reach.

### Soft — know these before widening the circle

- **Desktop control sits BELOW the tool-boundary carve-outs.** It drives a real mouse and
  keyboard. `protectedHit()` scans typed text and window titles, but a carve-out enforced by
  string-matching what gets typed is fundamentally weaker than one enforced at a function
  boundary. This was surfaced to Fred and accepted knowingly. It is owner-only and must stay
  owner-only. `browser_control` and `desktop_control` are DELIBERATELY ABSENT from
  `FORGE_TOOLS` — adding them there is the only switch needed to open them to guests, and
  that switch should not be flipped without a real threat model.

- **Credentials were not rotated after the incident.** Fred's call, made with the exposure
  window and low-traffic-window facts in hand. If anything anomalous ever surfaces in Stripe,
  Supabase, GitHub, or Railway, rotate first and ask questions second.

- **`prefer` mode still exists in the code.** Correct for migration, dangerous as a
  destination. Production is `enforce`. If it ever silently reverts to `prefer`, header trust
  is back for any caller who omits the JWT.

- **Guest connector switches are all OFF.** Nothing has been opened to tenants. Opening any
  one of them is a real decision, not a toggle.

- **No audit log of tool calls per tenant.** Today you cannot answer "what did account X's
  agent actually do last Tuesday." That gap matters more with every user added.

---

## 6. When the circle widens — hardening in priority order

Fred's stated plan is to harden in triplicate and bring in outside developers before going
beyond close friends. This is the list to hand them.

1. **Per-tenant audit log.** Every tool call: account, tool, args-digest, timestamp, outcome.
   Append-only, off the main volume. Without this there is no incident response, only guessing.

2. **Rotate every credential and move to short-lived tokens where the provider supports it.**
   Long-lived provider keys sitting in a volume-backed encrypted store is acceptable at this
   scale and not at the next one.

3. **Ingress lockdown that does not depend on remembering.** Cloudflare Tunnel with the
   container refusing any request whose JWT does not verify — which `enforce` now gives —
   plus a Railway-level check that no service domain exists. Consider a startup assertion that
   hard-fails the boot if an unexpected public domain is attached. The stray-domain incident
   should be impossible rather than merely unlikely.

4. **Threat-model desktop control properly, or drop it.** Right now its safety rests on the
   fact that exactly one trusted person can invoke it. That is a real control at n=1 and not a
   control at all at n=50.

5. **Secrets out of the volume and into a real secret manager.** The AES key currently sits
   co-located with the data it protects. That is honest-to-goodness defense-in-depth theater
   if the volume is ever exfiltrated whole.

6. **Independent review of the tenant wall.** `filterToolDefs` and `configFor` are the two
   functions standing between tenants. They should be read closely by someone who did not
   write them, with the specific question: can any path reach `ownerEnv` without `T.isOwner`?

7. **Penetration test against the live surface** before any public launch, with the forged
   header attack and the service-token-becomes-owner attack explicitly in scope, since both
   are known-real failure modes for this codebase rather than hypotheticals.

---

## 7. Tests that must stay green

```
node accessjwt_test.mjs      # 18 — identity. The forged-header test IS the incident.
node connectors_test.mjs     # 20 — connector registry, tenant wall, credential isolation
node wave3_test.mjs          #  9 — browser/desktop carve-outs
```

If `accessjwt_test.mjs` fails, **do not deploy**. A red test in that file means the app has
returned to trusting whatever a caller claims to be.

---

## 8. Standing operational rules

- Snapshot before any commit or deploy. Preserve the original. Keep a rollback path.
- Never inline secrets in scripts. Read at runtime from `~/.app-secrets.env`.
- The generic wallet `STRIPE_SECRET_KEY` is **Delta Log's live key** and is hard-blocked for
  Dominion. Do not "fix" that block.
- The wallet `GOOGLE_CLIENT_ID`/`SECRET` belong to **Command Deck's live client**
  (project 1091642929024). Dominion uses its own client in project **Dominion AI UI**. Never
  repoint Command Deck's client or widen its scopes to make something here work.
- Live DB changes land in repo migrations in the same session. No exceptions.
- One writer per repo tree. Serialize agents or use worktrees.

---

## 9. A note on how today went wrong

The incident was not caused by a hard problem. It was caused by me running a command whose
name implied it was read-only, and by an underlying design where that one mistake was
sufficient to expose everything.

The lesson worth carrying is the second half. The stray domain was recoverable in minutes.
What made it dangerous was that identity had no independent verification, so a single
networking mistake escalated straight to full owner access. Systems should be built so that
one error is survivable — assume the mistake happens, and make sure it costs you a hostname
rather than the tenancy model.

Verify before asserting. I twice concluded a cause today that fit the evidence without being
checked — "it was propagation" on the Google URI, which was actually a trailing period Fred
found himself. Both times a two-minute check would have given the real answer. In a security
context that habit is worse than useless, because a confident wrong diagnosis closes the
investigation.
