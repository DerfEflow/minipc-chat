# Dominion AI — Network Coordinator: Scope of Work (single source of truth)

_Started 2026-07-08. Branch: `claude/2026-07-08-network-coordinator`. Owner: Fred. This document is the target the build is measured against. If a line here is wrong, fix the line first, then the code._

---

## 1. The goal, in one sentence

A control surface (Dominion) Fred opens **from his phone on any network**, picks a **fast cloud model**, and uses that model to **act across his entire home network** — the mini-PC and both laptops — reliably, without the thing dying.

## 2. Acceptance test (what "does what I want" means)

1. Opens from the phone on any network — stable public URL, **no Tailscale-on-phone required**.
2. Pick a fast model → replies in **seconds**, not minutes.
3. Plain-English task **acts on the named machine**:
   - "Summarize `F:\...\notes.md` on the mini-PC" → done.
   - "On the Strix laptop, open `C:\dev\alpha-estimator` and run the tests" → done.
   - "On the other laptop, …" → done.
4. Each machine's hands reach **that machine's** files, commands, network. User names the machine; sensible default if not.
5. Can hand a coding job to Claude on a branch; Fred reviews + pushes.
6. A sleeping machine returns a clean **"that machine is offline"** — never a hang, never "bridge not reachable".
7. **Stays up on its own.** No daily babysitting.
8. Sandbox/branch work runs free; **production deploys, external email/SMS, and prod-DB changes stop for Fred's confirmation.**

## 3. Why the old design failed (root cause)

- **Couldn't reach the laptops:** tools only ever ran against the mini-PC's own disk (+ the Command Deck bridge). No code path reached *out* to another machine.
- **Died constantly:** the "bridge" was a hand-rolled poller stack — poll loops, localhost pokes (`:8088→:8188`), `tailscale serve` mappings, and a 5-minute self-heal task band-aiding it. Every piece a failure point.

Tailscale and SSH are **not** the weak link — the custom bridge is. Fred already reaches the mini-PC reliably via **SSH over Tailscale** (his deploy path). Build on that; delete the bridge.

## 4. Architecture

```
  Phone / any browser
        |  (public HTTPS — works on any network)
        v
  ┌─────────────────────────┐        OpenRouter (fast cloud model = the "brain")
  │   COORDINATOR           │  <-->  reasons, decides which tool to call on which machine
  │   - Dominion UI         │
  │   - model orchestration │        SSH over Tailscale (the "hands", per machine)
  │   - tool dispatcher     │  ───────────────┬───────────────┬───────────────┐
  │   - joined to tailnet   │                 v               v               v
  └─────────────────────────┘           mini-PC          Strix laptop     laptop-2
                                      (OpenSSH target) (OpenSSH target) (OpenSSH target)
```

- **Coordinator:** small always-on node (recommended: ~$5/mo VPS) joined to Fred's tailnet, exposed to the phone on a stable public URL. Holds no critical local state (chat history is client-side; tools execute on the machines) → it can restart freely.
- **Brain:** a fast cloud model via OpenRouter (Fred's buffet pick — see `models.catalog.mjs`). **Key change from the current app:** cloud models get tool-calling ON (today `attachTools=false` for cloud in `server.mjs` — that one flag is what blocks the whole goal).
- **Hands / transport:** `machines.mjs` — every machine is an OpenSSH target on the tailnet. One proven mechanism, no bridge. A down machine → clean offline result, never a hang.
- **Deleted:** the Command Deck bridge poller, localhost pokes, `tailscale serve` glue, and the 5-minute self-heal task.

## 5. Security posture

- SSH is **key-based** (no passwords); the coordinator's private key is read at runtime from config/env, **never inlined or logged**.
- The existing confirm-gate + protected-resource carve-outs in `tools.mjs` still apply.
- Free reign in sandbox and on branches. **Gated behind Fred's confirmation:** production deploys, external comms (email/SMS/QuickBooks), and production DB migrations. Backups protect files; they do not undo a live side-effect.

## 6. Phases

- **Phase 1 — Foundation (solo, no Fred input needed):**
  - [x] Lock this spec into the repo.
  - [x] `machines.mjs` — SSH-over-Tailscale transport + machine registry (offline-safe, no throws).
  - [x] `setup-openssh.ps1` — one-command enable of OpenSSH + key install on a Windows machine.
  - [x] `models.catalog.mjs` — the fast-model buffet (brain selector), big-three excluded.
  - [ ] Integrate: cloud-model tool-calling loop in `server.mjs` (flip `attachTools` on for cloud; run tool_calls through the existing `runTool` machinery); add "which machine" targeting; expose a machine registry + liveness endpoint; rebuild the model picker from the catalog.
- **Phase 2 — Stand it up (with Fred, ~15 min):**
  - Provision the coordinator node; join it to the tailnet (needs a Tailscale auth key + host).
  - Run `setup-openssh.ps1` on both laptops; confirm the coordinator reaches each.
  - Register all three machines in `machines.json`; smoke-test reaching each from the phone.
- **Phase 3 — Prove + widen:**
  - Real tasks on each machine from the phone; Claude hand-off on a branch.
  - Delete the old bridge/poller/self-heal machinery once the new path is proven.
  - Widen the tool set per Fred's appetite (more of the network reach).

## 7. What I need from Fred (Phase 2)

1. A **Tailscale auth key** (generated in the Tailscale admin console) so the coordinator joins the tailnet.
2. A **green light on the coordinator's home** — recommended: a ~$5/mo always-on VPS (bulletproof, native tailnet join) vs. squeezing it onto something already running.
3. The **Tailscale names of the two laptops** (mini-PC known = `nucbox-k8-plus`).

## 8. Open decisions

- Coordinator host: small VPS (recommended) vs. Fly.io vs. reuse existing. Decide in Phase 2.
- Whether this stays a branch of `minipc-chat` or graduates to its own repo once it deploys to the cloud node (lean: own repo at Phase 2, since deploy target changes).
