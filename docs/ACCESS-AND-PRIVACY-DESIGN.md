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

## 3. Privacy: three explicit modes, user-controlled (DECIDED)

**Fred sets the mode. There is NO auto-detection of sensitivity and NO ability for the system to
re-route or override his choice.** The mode is a hard allow-list of which brains may be called;
within that allow-list, whatever model Fred picks is used exactly, never substituted.

The hard truth that makes the modes meaningful: if a cloud model *reads* something, that content is
*sent to that provider*. So "keep it off the cloud" can only mean "use a local brain." The modes make
that a deliberate, visible switch instead of a guess.

| Mode | Brains allowed | Use |
|---|---|---|
| **Normal** (default) | All providers: OpenRouter, DeepSeek, OpenAI direct, plus local | Everyday work. Cheapest, most powerful, the full model picker. |
| **Trusted** | Direct no-train providers (OpenAI direct; optionally Anthropic direct) **plus local**. **No OpenRouter, no DeepSeek.** | Work you want in the cloud but only with providers that do not train on your data and retain briefly / offer ZDR (see §4). |
| **Private** | **Local model ONLY** (mini-PC Qwen; optional on-demand local GPU) | Sensitive work. Nothing leaves your hardware. Zero cloud calls. |

**Rules (hard requirements):**
- **Default = Normal.**
- **No auto-detection.** The system never inspects content to guess a privacy level.
- **No re-routing, no override.** The mode filters the selectable models, and the server *also*
  enforces the allow-list. If a picked model is not allowed in the current mode, the system
  **refuses** with a clear message (e.g. "Private mode allows local models only") rather than
  silently substituting. Fred's explicit pick within the allowed set is honored exactly.
- The mode is a **visible switch** in the UI (beside Model / Mode), persisted like the model pick.
- Redaction/scrubbing of outbound payloads is deliberately **NOT** part of this: it would be the
  system altering what Fred chose to send. If ever wanted, it is a separate opt-in toggle, off by
  default. The three modes are the whole privacy control.

Net effect: the privacy level is always exactly what Fred selected, with zero surprises. Normal =
everything; Trusted = only no-train direct providers or local; Private = local only.

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
                          │  privacy mode (Fred's pick) gates the callable brains:
                          │  ├─ Normal ──▶ any provider (OpenRouter / DeepSeek / OpenAI direct) + local
                          │  ├─ Trusted ─▶ OpenAI direct (opt. Anthropic direct) + local ONLY
                          │  ├─ Private ─▶ LOCAL model ONLY (mini-PC Qwen; optional GPU)
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
2. **Privacy layer:** the three modes (Normal / Trusted / Private), Normal default, as a UI switch +
   server-side allow-list enforcement. No auto-detection, no re-routing, refuse-not-substitute.
3. **Railway orchestrator wiring** + take the phone off the `tailscale serve` bridge.
4. **Laptop MCP server** (adds F:\ + `C:\Users\rjfla` reach when the laptop is on).
5. **Optional:** on-demand local GPU for a stronger private brain (spin-up / delete, kill-switch).

---

## 7. Decisions and remaining questions

**Decided by Fred 2026-07-14 (do not re-litigate):**

- **MCP transport = dial-out.** Each machine's hands node dials OUT to the cloud orchestrator over
  an authenticated channel. No inbound ports on Fred's PCs, and the hands do not ride the tailnet.
- **Tailscale survives, scoped to two uses only:** the Railway container joins the tailnet to reach
  the mini-PC Qwen (Ollama binds the tailnet interface, ledger L-016), and update/deploy access to
  the boxes. Nothing else.
- **Trusted roster includes Anthropic direct.** Anthropic joins the catalog; Trusted = OpenAI
  direct + Anthropic direct + local.
- **Private brain = mini-PC Qwen** for now. An on-demand local GPU stays an optional later upgrade.
- **UI baseline = the dominion-cinematic version**, including the branch's paint fix and cost chip.
  Frozen from this baseline forward.

**Still open (non-blocking):**

- **ZDR:** pursue a Zero Data Retention agreement with Anthropic/OpenAI to close even the short
  retention window?

**Decided earlier (do not re-litigate):** three modes Normal/Trusted/Private; default Normal; no
auto-detection; no re-routing or override (refuse, do not substitute).
