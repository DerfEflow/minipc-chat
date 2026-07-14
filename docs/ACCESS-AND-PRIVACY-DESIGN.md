# Dominion AI — Access + Privacy Architecture

Companion to `CLOUD-MIGRATION.md`. This is the design for keeping Dominion's near-total access to
Fred's machines and online projects AFTER the brain moves to the cloud, plus a **Max Privacy** mode
that guarantees sensitive data can be kept off cloud providers.

Status: **design (pre-build).** The build is high blast radius (credentials + near-total access +
production), so it runs through the full build discipline with a numbered SOW when Fred says go.

---

## 1. The key insight: three independent layers

Dominion is really three layers, and they can each live in a different place:

1. **Brain (the model).** Decides *what to do*. It never touches a file directly; it emits a tool
   call like `read_file(path)` and waits for the result. Provider API or local model. **The brain's
   location is irrelevant to access.**
2. **Orchestrator (`server.mjs`).** Runs the agent loop, holds memory, routes turns, dispatches tool
   calls. Moves to Railway (always-on, reliable; kills the fragile `tailscale serve` phone bridge).
3. **Hands (the tools).** Actually execute on Fred's machines and online projects, under the
   carve-out rules. This is where **all** the access lives.

Access is entirely a layer-3 property. A provider-API brain and a self-hosted-GPU brain have the
exact same hands. So dropping the paid GPU costs zero access.

---

## 2. Access: the MCP hands

Today the hands work because `server.mjs` runs ON the mini-PC (direct local reach + SSH to the
laptop). Moving the orchestrator to Railway removes that line of sight into the home network. The
fix (this design) restores it robustly and retires the flaky bridge:

- **One MCP tool server per machine.** A small service (Docker container) on the **mini-PC**
  (always-on = the critical one) and the **laptop** (when it is on). It exposes the current
  `tools.mjs` capability set: filesystem read/write, shell, git, deploy, sandbox, deck/forge
  equivalents.
- **Same carve-out rules, ported verbatim.** `assertNotProtected` stays the hard wall: block `D:\`
  (backups), `app-backups`/`db-backups` paths, customer databases, `pg_dump`/`pg_restore`. Keep the
  specific-first root ordering so Dominion cannot delete its own host or the bridge. Keep the
  confirm / 9-state lifecycle / audit-log machinery. **Access stays "almost everything, with the
  same exceptions and rules."**
- **Transport = machine dials OUT to the cloud** (recommended) over an authenticated, encrypted
  channel, so there is no public inbound port on Fred's PCs. (Alternative: cloud reaches in over
  Tailscale. Dial-out is simpler and safer.)
- **Online projects reached DIRECTLY from Railway** by API token (GitHub, Railway, Vercel,
  Supabase). This is *better* than today: no mini-PC bridge hop, so it is more reliable, and it works
  even when the home PCs are off.

**Consequence for the plan:** the mini-PC is **not** retired at cutover. It stops being the brain
host and becomes the always-on **hands node** (a small footprint Fred already runs). The laptop
joins when it is on.

---

## 3. Privacy: the honest rule and the Max Privacy toggle

**The hard truth:** if a cloud model *reads* something, that content is *sent to that provider*.
There is no cloud-side trick that lets a cloud brain read sensitive data without transmitting it.
So the only real guarantee of "not sent" is to keep the **brain local** for those turns.

### Provider trust tiers

| Tier | Backend | Privacy posture |
|---|---|---|
| **Private** | Local model (mini-PC Qwen now; optional on-demand local GPU later) | Nothing leaves the box. Absolute. |
| **Trusted cloud** | **Anthropic** / **OpenAI** direct API | No training on your data by default; short retention then deleted (Anthropic 7 days, OpenAI up to 30); Zero Data Retention available. Strong, not absolute (see §4). |
| **Convenience** | DeepSeek, OpenRouter | Non-sensitive only. Different jurisdiction / middleman that can log. |

### Controls (build these)

1. **Max Privacy toggle** (global switch + per-session override). ON = the brain is **locked to the
   local model** for the whole session; cloud providers are simply not called; nothing in context
   leaves Fred's hardware. This is where a local model earns its keep: as the *private brain for
   sensitive work*, not an always-on box for everything.
2. **Auto-sensitivity routing** (works even with the toggle OFF). The router already sniffs for
   secrets/PII (`PRIVACY_RE` / `privacyRiskOf`). Extend it so a tool result or prompt that trips the
   sensitive-content or carve-out-category detector **auto-routes that turn to the local brain** (or
   redacts before any cloud call). Sensitive reads never silently egress.
3. **Redaction pass on cloud-bound payloads.** `mentor.mjs` already redacts email/phone/api-key/jwt/
   secret before external calls. Generalize it into a single egress filter every cloud call passes
   through.
4. **Provider allow-list per privacy level.** Content that is sensitive-but-cloud-acceptable is
   restricted to the **trusted-cloud** tier (Anthropic/OpenAI direct), never DeepSeek/OpenRouter.

Net effect: **Max Privacy ON = local only.** Max Privacy OFF = cloud for normal work, but flagged
content still auto-stays local or is redacted, and only trusted-direct providers ever see anything
borderline.

---

## 4. "Can I trust Anthropic / OpenAI not to save it?" (grounded, 2026)

- **Anthropic API:** does **not** train on your API data by default; default retention reduced to
  **7 days** (Sept 2025) then auto-deleted; **Zero Data Retention** arrangements store nothing at
  rest after the response. Currently the stricter of the two.
- **OpenAI API:** does **not** train on API data by default (since Mar 2023); default retention
  **up to 30 days** for abuse monitoring then deleted; **ZDR** available for eligible endpoints.

**The honest caveats:**
- "Deleted after N days" is a policy, not physics. A **legal order can override it** (the ongoing
  OpenAI / NYT case forced retention beyond OpenAI's own policy). Anthropic's 7-day default is more
  privacy-protective.
- The only *absolute* guarantee is local inference. Everything cloud is "trusting a good policy that
  a court can still pierce."
- If Fred wants the residual window closed, the path is a **Zero Data Retention agreement** with
  Anthropic and/or OpenAI (both offer it for qualifying accounts).

**Recommendation:** treat Anthropic/OpenAI direct as the trusted-cloud tier; keep DeepSeek/OpenRouter
for non-sensitive convenience only; route anything sensitive to the **local** brain via Max Privacy /
auto-sensitivity. This is not legal advice; verify current terms before relying on them for anything
regulated.

---

## 5. Deployment topology (target)

```
   Phone PWA ─HTTPS─▶ Railway: server.mjs + PWA  (brain orchestrator, always-on)
                          │  ├─ normal turns ─────▶ Provider APIs (Anthropic/OpenAI direct = trusted;
                          │  │                        OpenRouter/DeepSeek = convenience)
                          │  ├─ Max Privacy / flagged ─▶ LOCAL model (mini-PC Qwen; optional GPU)
                          │  └─ online projects ──▶ GitHub / Railway / Vercel / Supabase (direct API)
                          │
                          └─ tool calls ─▶ MCP tool server(s)   ── mini-PC (always-on hands)
                             (dial-out, authenticated)          └─ laptop (when on)
                                                                  [same carve-outs: D:/backups/
                                                                   customer-DBs/pg_dump blocked]
```

- No always-on paid GPU. The private brain is the free mini-PC Qwen; a stronger private brain (an
  on-demand local GPU, spun up and **deleted** when done, with a hard max-runtime kill-switch) is an
  optional later upgrade, never an idling box.
- Provider APIs cost pennies at personal volume.

---

## 6. Build phases (SOW to follow when Fred says go)

1. **MCP tool server (mini-PC)** mirroring `tools.mjs` + carve-outs; the cloud orchestrator connects
   over an authenticated dial-out channel. Prove the cloud-brain to local-hands loop.
2. **Privacy layer:** Max Privacy toggle + auto-sensitivity router + provider trust tiers + the
   single egress redaction filter.
3. **Railway orchestrator wiring** + take the phone off the `tailscale serve` bridge.
4. **Laptop MCP server** (adds F:\ + `C:\Users\rjfla` reach when the laptop is on).
5. **Optional:** on-demand local GPU for a stronger private brain (spin-up / delete, kill-switch).

---

## 7. Open questions for Fred

- **MCP transport:** machine dials out to the cloud (simpler, safer), or cloud reaches in via
  Tailscale? Recommend dial-out.
- **Private brain:** mini-PC Qwen (free, modest) is the default now. Upgrade to an on-demand local
  GPU later for stronger private reasoning, or is the mini-PC enough?
- **ZDR:** pursue a Zero Data Retention agreement with Anthropic/OpenAI to close even the short
  retention window?
- **Default posture:** Max Privacy OFF with auto-sensitivity routing on (convenient + safe), or Max
  Privacy ON by default (maximally private, cloud only when Fred flips it off)?
