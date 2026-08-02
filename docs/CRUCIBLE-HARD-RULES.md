# Crucible Hard Rules

**Fred's ruling, 2026-08-02.** Non-compromising, engine-side, deterministic. Not model instructions
— a model can be persuaded. These are gates in code that no crew, reviewer, prose answer, or
provider can talk its way past.

Every rule below is traced to a real failure. The reference build is **Speak-Easy**
(`ide_656a18b1-254`, 2026-08-02, 149 min, $1.88) plus the **F:\ baseline snapshot** incident
(2026-07-22).

---

## The governing principle

> A step that fails must never be able to report success.
> A build that cannot be verified must never be able to claim it is finished.
> A terminal state must always reach the user.

All three were violated in the last week. Each violation was silent.

---

## Part 1 — Truthful termination

### R1. `checkpoint` must notify. *(confirmed defect)*

`idepush.mjs → escalationFor()` handles `need_input`, `done`, `error`, and returns `null` for
everything else. `checkpoint` is a **terminal** state and was never added. Its trailing comment
enumerates the intentionally-silent types — `move, plan, file, diff, run, cost, snapshot, stopped` —
and `checkpoint` is not among them, so this was an oversight, not a decision.

**Rule:** every terminal state notifies. `checkpoint` notifies at **high** urgency with the count of
remaining items. A terminal event that produces no notification is a bug, and the enumeration must
be exhaustive over `TERMINAL` by construction, not by hand.

*What Fred saw: the project fell off the interface with no notification of any kind.*

### R2. A checkpointed build must stay visible. *(confirmed defect)*

`idejobs.mjs → publish()` sets `job.done = true` for any terminal type, and
`activeFor = listFor(uid).filter(j => !j.done)`. A checkpoint therefore leaves the active rail
instantly and lands in no other bucket.

**Rule:** unfinished terminal states (`checkpoint`, `error`, `stopped`) belong to a distinct
**"needs attention"** bucket that persists until the user explicitly dismisses or resumes. `done` is
the only outcome permitted to disappear quietly.

### R3. No terminal state may be inferred from absence.

**Rule:** a journal that ends without a terminal event is `interrupted`, is surfaced as such, and
notifies. Already implemented for restarts; must hold for every path.

---

## Part 2 — "Fix it" must actually fix it

### R4. A repair move must be able to write the files that are missing. *(confirmed defect — this is the one)*

`server.mjs:4693`:

```js
const fixMove = { id: "furnace-fix",
  title: "Finish the unfinished pieces",
  why: "The honesty audit found: " + ...,
  files: written };        // ← the files ALREADY written
```

The furnace-fix move is scoped to `written`. The missing files are, by definition, **not** in
`written`. So when the audit says "MainActivity.kt does not exist" and the user says *fix it*, the
repair move is handed a file list that structurally excludes the thing to be fixed.

On Speak-Easy this produced exactly the observed behaviour: told to close 6 gaps, it rewrote 5 files
that already existed (`libs.versions.toml`, `app/build.gradle.kts`, `AndroidManifest.xml`,
`strings.xml`, `themes.xml`), created **none** of the 20 missing files, and marked the move `done`.

**Rule:** a repair move's file list is `written ∪ every path named by the findings it is repairing`.
A finding that names a path the build never wrote must put that path in the move's scope.

### R5. A repair is not complete until re-audited. *(confirmed defect)*

`server.mjs:4694-4697` runs the fix and checks only `fixed.ok` — the model's own report. The sweep
and fidelity audit are never re-run against the result.

**Rule:** after any repair move, re-run the deterministic sweep and the structural checks. Findings
that persist are appended to `knownIncomplete` verbatim. **A repair may never reduce the finding
count on the strength of the repairing model's own claim.**

### R6. A move may not be `done` if its declared outputs were not produced.

`furnace-fix` reported `state: "done", files: 5` while closing zero of its six findings.

**Rule:** a move whose declared `files` were not all returned is `partial`, never `done`. The
completion gate already detects this after the fact ("Planned file was never returned by its
assigned implementation step") — that detection must run **per move, at the move boundary**, and
change the move's own reported state.

---

## Part 3 — Verification is mandatory

### R7. Unverifiable ⇒ incomplete. Always. *(Fred's ruling, 2026-08-02)*

`server.mjs:4829`:

```js
status: uniqueRemaining.length || (finalVerification.ran && !finalVerification.ok)
  ? "partial" : "completed"
```

When verification never ran, `finalVerification.ran` is `false`, so a build with no other findings
evaluates to **`"completed"`** — unverified, uncompiled, unexecuted.

**Rule:** `finalVerification.ran === false` is itself a completion blocker. A build that executed no
check may never reach `done`. It terminates as `checkpoint` with the reason stated plainly:
*"Nothing was compiled, run, or tested, so this build cannot be called finished."*

### R8. Verification must discover the project it is actually in. *(confirmed defect)*

`ideengine.mjs:307 → verificationPlanFor()` parses one root `package.json` and nothing else.
Speak-Easy is a Gradle project with a Node server in `server/`. Result, three times in the journal:

> `"Nothing to verify: no package.json scripts, so there is nothing to run."`

Nothing was ever compiled. A single `tsc` in `server/` would have caught the dead transcribe route.

**Rule:** discovery walks the tree (bounded depth) and recognises at minimum:

| Marker | Checks |
|---|---|
| `package.json` (any depth) | declared check/lint/test/build scripts, run in that directory |
| `settings.gradle[.kts]`, `build.gradle[.kts]` | `gradlew assembleDebug` / `gradlew build` |
| `tsconfig.json` | `tsc --noEmit` |
| `Cargo.toml` | `cargo check` |
| `go.mod` | `go build ./...` |
| `pyproject.toml` / `requirements.txt` | declared test runner |
| `*.csproj`/`*.sln` | `dotnet build` |

An unrecognised stack is **not** a pass — it is R7.

### R9. A missing toolchain is a blocker, not a pass.

Already correct (`isMissingToolFailure`, `toolingBroken`). Extended: a *missing build tool* —
no Gradle wrapper, no `gradlew` — is reported as a blocker naming the missing tool. Speak-Easy
shipped with no wrapper at all, so no Gradle build was ever possible.

---

## Part 4 — Structural truth (extending the Furnace past text patterns)

The Furnace's placeholder sweep passed Speak-Easy **cleanly and correctly** — there are genuinely
zero TODOs in ~4,980 lines. Every real defect was *structural*. `brokenReferenceFindings()` already
does exactly this kind of analysis for HTML `src`/`href`; it needs siblings.

### R10. A declared component must exist.

`AndroidManifest.xml` declared `.ui.MainActivity`, `.overlay.PillService`, and
`.access.SpeakEasyAccessibilityService`. **None of the three existed.** The app cannot launch,
cannot host the pill, cannot detect a keyboard.

**Rule:** every class named in a manifest/registry/config must resolve to a written or pre-existing
source file. Applies to: Android manifest components, `main`/`bin` entrypoints in `package.json`,
service registrations, and plugin declarations.

### R11. An exported route/handler that is never registered is a finding.

`server/src/routes/transcribe.ts` exports `transcribeRoutes` — 660 lines, plus a 710-line OpenAI
service behind it. `app.ts` registers auth, profile, and saved-texts, **and not transcribe**.
Verified live: `POST /api/transcribe` → **404**. The app's entire reason for existing was
unreachable.

**Rule:** an exported route-plugin/handler module in the project that no entrypoint imports is
reported as dead-on-arrival.

### R12. Client and server must agree on paths.

Retrofit declared `transcribe`, `auth/login`, `profile`, `saved-texts`. The server serves
`/api/transcribe`, `/api/auth/login`, … Every client call would 404 — a whole-app failure invisible
to both halves in isolation.

**Rule:** when a build produces both a client and a server, cross-check declared client routes
against declared server routes. A client path with no server counterpart is a finding.

### R13. A referenced resource must exist.

The manifest referenced `@mipmap/ic_launcher` and `@mipmap/ic_launcher_round`; there is no
`res/mipmap*` directory. `build.gradle.kts` referenced `proguard-rules.pro`; absent. Resource
linking fails before any code compiles.

**Rule:** generalise `brokenReferenceFindings` beyond HTML to resource references
(`@mipmap`, `@drawable`, `@style`, `@string`) and build-config file references.

### R14. Package and namespace must cohere.

`namespace = "app.speakeasy.dictation"`; every source file is `package com.speakeasy.*`. The
manifest's relative names (`.ui.MainActivity`) resolve against the namespace, so they would not have
resolved **even once the classes were written**.

**Rule:** declared namespace/module root must match the package structure actually written.

### R15. Every import must map to a declared dependency.

`ApiClient.kt` registers `MoshiConverterFactory` while neither `moshi-kotlin` nor
`moshi-kotlin-codegen` is a dependency — a guaranteed runtime crash on the first API call. (The
server side was clean; this check would have passed it.)

**Rule:** cross-check imports against declared dependencies per ecosystem. Flag both missing
dependencies and the mutually-exclusive-adapter case.

### R16. Placeholder infrastructure is unfinished work.

The existing sweep looks for `PLACEHOLDER`, `your-api-key`, `<REPLACE`. It does not look for:

- `example.com` base URLs — `BASE_URL = "https://api.speakeasy.example.com/"`
- non-existent provider models — `DEFAULT_MODEL = 'gpt-transcribe'` is not an OpenAI model
- a required env var absent from `.env.example` — `OPENAI_API_KEY`, the one variable the core
  feature cannot run without, is undocumented
- **secrets with working defaults** — `requireEnv('JWT_ACCESS_SECRET', 'dev-access-secret-change-me')`
  can never throw, so production boots on a known signing secret and anyone can forge tokens

**Rule:** all four are sweep findings.

---

## Part 5 — Orchestration honesty

### R17. A failed task poisons the whole build's claim.

Task 7 ("Implement recording and the floating pill UI") **failed after adaptive retries**. Tasks 8,
11 and 12 depended on it and never ran. Nine of twelve tasks succeeded — and the app still cannot
launch, because the three that didn't owned every runtime entry point.

**Rule:** any task ending `failed`, plus every task skipped for depending on it, is an absolute bar
to `done`. Percentage-complete is never a proxy for working.

### R18. Skipped work must be as loud as failed work.

`"Tasks 8, 11, 12 were skipped because a task they need did not finish"` appears once, as a `run`
event, at the same visual weight as a routine log line.

**Rule:** skipped-by-dependency is surfaced with the same prominence as failure, in the summary and
in the notification.

---

## Part 6 — Snapshots must be real *(the F:\ incident)*

### R19. A baseline commit must be verified non-empty. *(confirmed defect — no rollback existed)*

`hands/hands.mjs:569-579`:

```js
await gitIn(dir, ["init"]);
await gitIn(dir, ["add", "-A"]);
await gitIn(dir, ["commit", "--allow-empty", "-m", "hands: baseline snapshot"]);
```

On 2026-07-22 `git add -A` was interrupted mid-sweep. `--allow-empty` then let the commit **succeed
with git's canonical empty tree** (`4b825dc6…`). The baseline reported success and contained zero
files. Every `claude_code` run that trusted it as a rollback point **had no rollback point**.

**Rule:** `--allow-empty` is banned from baseline snapshots. After committing, verify
`git rev-parse HEAD^{tree}` is not the empty tree and that the entry count is plausible against the
work tree. A baseline that cannot be verified **blocks the job** — the mutation does not proceed.

### R20. Never snapshot an unbounded root. *(confirmed defect — 28 GB)*

Nothing stopped `claudeBaseline()` from being pointed at `F:\` itself. `git add -A` swept the whole
drive: `$RECYCLE.BIN`, browser profiles containing `Login Data` and `Cookies`, pgsql binaries —
48,212 loose objects. On exFAT with a 512 KB allocation unit that cost **28 GB on disk for 4.40 GiB
of content**.

**Rule:** refuse to `git init` at a filesystem root or a drive letter. Refuse above a file-count and
byte ceiling; report the refusal as a blocker rather than proceeding unsnapshotted. Write a
`.gitignore` excluding `$RECYCLE.BIN`, `System Volume Information`, browser profiles,
`node_modules`, build outputs, and package caches **before** the first `add`.

### R21. A snapshot must never capture credential stores.

The object store held browser `Login Data`, `Cookies`, and `Trust Tokens` — ~507 credential-ish
paths. It had no remote, so nothing left the machine. That was luck, not design.

**Rule:** a hard deny-list of credential stores, enforced before `add`, independent of `.gitignore`.

---

## Implementation order

1. **R1, R2** — notification and visibility. Smallest change, directly fixes the vanishing build.
2. **R4, R5, R6** — repair scope and re-audit. Fixes "fix it" fixing nothing.
3. **R7, R8** — unverifiable ⇒ incomplete, plus project-type discovery.
4. **R19, R20, R21** — hands baseline. Restores the rollback guarantee.
5. **R10-R16** — structural checks, highest-signal first (R10, R11, R13).
6. **R17, R18** — orchestration surfacing.

Every rule ships with a test that fails without it.
