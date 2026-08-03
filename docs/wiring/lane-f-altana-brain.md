# Lane F wiring spec: Altana's brain

**Branch:** `iter/assistant-build-core`. **Written:** 2026-08-03. **Blast radius:** HIGH.
**Applied by:** the INTEGRATOR only. Lane F did not touch `server.mjs`.

**Files Lane F owns and shipped:** `altana.mjs` (new), `altana-context.mjs` (new),
`altana_brain_test.mjs` (new), `docs/ALTANA-KNOWLEDGE.md` (new), `guide.mjs` (replaced behaviour).

**Anchor freshness.** `server.mjs` has a concurrent writer in this wave and was modified while this
spec was being written. All four anchors below were re-verified against the file afterwards and
were still exact and still unique (lines 153, 1310-1311, 5291-5360, 9808). Re-grep each one before
applying anyway; a line number in this document is a convenience and the quoted string is the
contract.

**Tests:** `node altana_brain_test.mjs` → 46 passed, 0 failed, live proofs included.
`node guide_test.mjs` → 12 passed, 0 failed (the legacy surface still behaves identically).

---

## 0. The one-paragraph version

Altana replaces the Guide. `guide.mjs` now delegates its shared machinery to `altana.mjs` and its
store is a literal alias, so **nothing breaks before this spec is applied and nothing breaks after
it**. The three `/guide/*` routes become `/altana/*` with the old paths kept as aliases. The
complaint database is not moved, renamed or migrated: same directory, same `guide.db`, same
`complaints` table.

---

## 1. The import

**Anchor (exact, `server.mjs` line 153 today, unique in the file):**

```js
import { createGuide, createGuideStore, GUIDE_MODEL } from "./guide.mjs";
```

**Replace with:**

```js
import {
  createAltana, createAltanaStore, altanaChatTools, wrapToolResult,
  ALTANA_SETTABLE_SETTINGS, ALTANA_TOOLS, runAltanaTurn, confirmationToken,
} from "./altana.mjs";
import { assembleContext } from "./altana-context.mjs";
```

`GUIDE_MODEL` and `createGuide` disappear from `server.mjs` with this edit. Both are still exported
by `guide.mjs`, so any other importer keeps working; grep confirms `server.mjs` was the only one.

---

## 2. The instantiation

**Anchor (exact, `server.mjs` lines 1309-1311 today, unique):**

```js
// The Guide: read-only in-app support. Knowledge is a curated file, reloaded on a short TTL so a
// deploy updates what it knows without a restart. See guide.mjs for why the limits are structural.
const guideStore = createGuideStore({ dir: dataPath("guide") });
const guide = createGuide({ knowledgePath: join(HERE, "docs", "GUIDE-KNOWLEDGE.md"), store: guideStore, log: (m) => console.log(m) });
```

**Replace with:**

```js
// Altana: the executive assistant, successor to the Guide. Knowledge is a curated file reloaded on
// a short TTL so a deploy updates what she knows without a restart. Her limits are STRUCTURAL and
// live in altana.mjs and altana-context.mjs: an allow-listed toolset, a redacting context
// assembler, a confirmation gate and an injection guard. Read those files before changing this.
//
// dataPath("guide") IS DELIBERATE AND MUST NOT BE "altana". The complaint book is live user data;
// pointing this at a new directory would silently orphan every complaint ever filed.
const altanaStore = createAltanaStore({ dir: dataPath("guide") });
const altana = createAltana({ knowledgePath: join(HERE, "docs", "ALTANA-KNOWLEDGE.md"), store: altanaStore, log: (m) => console.log(m) });
```

`docs/GUIDE-KNOWLEDGE.md` stays on disk. `guide_test.mjs` still reads it and still passes.

---

## 3. The dispatch

**Anchor (exact, `server.mjs` line 9808 today, unique):**

```js
    if (path.startsWith("/guide/")) return handleGuide(req, res, u);
```

**Replace with:**

```js
    if (path.startsWith("/altana/") || path.startsWith("/guide/")) return handleAltana(req, res, u);
```

The `/guide/` prefix is kept on purpose. A cached client, a bookmarked owner page or a half-deployed
asset must not 404 on a support surface.

---

## 4. The routes

**Anchor:** the whole block from the comment `/*\n * THE GUIDE (Fred, 2026-07-31).` at line 5290
through the closing `}` of `async function handleGuide` at line 5360. Unique: `async function
handleGuide(req, res, u) {` appears once.

**Replace the entire block with:**

```js
/*
 * ALTANA (Fred, 2026-08-03), successor to the Guide. She knows the state of the app and can work
 * its levers. Metered like any turn, and normally free: her primary seat is NVIDIA's developer
 * lane. When that seat 529s, 404s or times out she falls to Luna on /v1/responses and the reply
 * SAYS SO, because a free turn silently becoming a billed one is the surprise this app refuses.
 *
 * WHAT MAKES HER SAFE IS NOT IN THIS FUNCTION. Her toolset is allow-listed and load-time verified
 * against Fred's four exclusions (billing/budgets/PII/secrets/IP) in altana.mjs; her context is
 * field-filtered and redacted in altana-context.mjs; irreversible tools need a token from the
 * user; tool results are structurally treated as data. This handler assembles and dispatches.
 *
 * TOOL CALLS ARE NOT EXECUTED BY altana.mjs. It returns the calls it has cleared, and the switch
 * below is the only place they turn into effects. Client-owned preferences come back as
 * `clientActions` for public/app.js to apply, because the server does not own them.
 */
async function handleAltana(req, res, u) {
  const T = resolveTenant(req);
  if (T.role === "anon") return sjson(res, 401, { error: "sign in" });
  const p = u.pathname.replace(/^\/guide\//, "/altana/");

  // The owner's complaint book. Guests can file; only Fred can read.
  if (req.method === "GET" && p === "/altana/complaints") {
    if (!T.isOwner) return sjson(res, 403, { error: "owner only" });
    return sjson(res, 200, { complaints: altanaStore.recent(100), open: altanaStore.openCount() });
  }
  const body = (await readJsonBody(req)) || {};
  if (req.method === "POST" && p === "/altana/complaint/resolve") {
    if (!T.isOwner) return sjson(res, 403, { error: "owner only" });
    return sjson(res, 200, altanaStore.resolve(body.id));
  }

  if (req.method === "POST" && p === "/altana/ask") {
    const question = String(body.question || "").trim();
    if (!question) return sjson(res, 400, { error: "ask something" });
    if (!altana.ready()) return sjson(res, 200, { reply: "My notes are not loaded right now, so I would only be guessing. Try again in a moment." });

    /*
     * THE ONLY PLACE APP STATE ENTERS HER WORLD. Everything the client sent is filtered to a named
     * field list and then redacted. Do not add a second path that builds messages without this.
     */
    const ctx = assembleContext({
      app: { name: "Dominion", version: BUILD_ID, interfaceMode: body.mode, privacyMode: body.privacyMode },
      screen: { id: body.surface, title: body.screenTitle },
      activity: Array.isArray(body.activity) ? body.activity : [],
      settings: body.settings || {},
      settableKeys: ALTANA_SETTABLE_SETTINGS,
      tools: ALTANA_TOOLS,
    });
    if (Object.keys(ctx.hits).length) console.log("[altana] context redactions: " + JSON.stringify(ctx.hits));

    // A tool result from a previous round rides back fenced. wrapToolResult picks the wire shape:
    // role "tool" when it answers a real call id, a fenced user message otherwise. A bare
    // role:"tool" with no tool_call_id is HTTP 400 on the NVIDIA endpoint (measured 2026-08-03).
    const toolMessages = (Array.isArray(body.toolResults) ? body.toolResults : [])
      .slice(0, 4)
      .map((tr) => wrapToolResult(tr.name, tr.result, { toolCallId: tr.callId || "" }).message);

    const r = await runAltanaTurn({
      messages: altana.messagesFor(question, { history: body.history, context: ctx.text, toolMessages }),
      tools: altanaChatTools(),
      keys: { NVIDIA_API_KEY: NVIDIA_KEY, OPENAI_API_KEY: OPENAI_KEY },
      confirmations: Array.isArray(body.confirm) ? body.confirm : (body.confirm ? [String(body.confirm)] : []),
      log: (m) => console.log(m),
    });

    // F7: meter against the lane that ACTUALLY served the turn, not the one we hoped for.
    const costUsd = r.usage && r.usage.billed ? ideCloudCost(r.usage.model, { usage: r.usage.tokens }) : 0;
    if (costUsd) { try { await meterTurn(T, costUsd, "altana:" + r.usage.lane, ""); } catch {} }
    if (!r.ok) return sjson(res, 200, { reply: "I could not reach my own brain just then. Ask me again?", fallback: r.fallback || null });

    // The Guide's marker still works, so a model that writes it instead of calling the tool does
    // not lose the user's complaint.
    const { reply, complaint } = altana.extractComplaint(r.reply || "");
    const clientActions = [];
    let logged = null;

    for (const call of r.toolCalls) {
      switch (call.name) {
        // Client-owned preferences. The server does not hold them, so it relays the intent and
        // public/app.js applies it. Already screened against the settings allow-list.
        case "set_setting":
          clientActions.push({ type: "set_setting", setting: call.args.setting, value: call.args.value });
          break;
        case "open_screen":
          clientActions.push({ type: "open_screen", screen: String(call.args.screen || "").slice(0, 40) });
          break;
        case "list_settings":
          clientActions.push({ type: "echo_settings" });
          break;
        case "search_help":
          clientActions.push({ type: "help", text: (altana.knowledge().find((s) => s.title) || {}).body || "" });
          break;
        case "list_work":
          clientActions.push({ type: "work_list", items: (T.artifacts || artifacts).list({}).slice(0, 20).map((a) => ({ id: a.id, title: a.title })) });
          break;
        case "log_complaint": {
          const saved = altanaStore.log({
            uid: T.uid || "", userEmail: T.email || "", contactEmail: String(call.args.reply_to || ""),
            summary: String(call.args.summary || ""), surface: String(body.surface || "").slice(0, 60),
          });
          if (saved.ok) logged = { id: saved.id, contactEmail: String(call.args.reply_to || "") };
          break;
        }
        // Irreversible. These only ever arrive here having already carried a matching confirmation
        // token; screenToolCall in altana.mjs would have returned "confirm" otherwise.
        // (T.artifacts || artifacts): the module-scope store at server.mjs:325 is the OWNER's. The
        // per-tenant one is T.artifacts, as the /artifacts handler already does at line 6382.
        // Altana must only ever delete the caller's own record.
        case "delete_saved_work":
          try { (T.artifacts || artifacts).remove(String(call.args.id)); } catch (e) { console.warn("[altana] delete failed: " + (e && e.message)); }
          break;
        case "delete_work_order":
          try { workOrders.remove(T.uid || "", String(call.args.id)); } catch (e) { console.warn("[altana] work-order delete failed: " + (e && e.message)); }
          break;
        default:
          console.warn("[altana] cleared a tool with no dispatch: " + call.name);
      }
    }

    if (complaint && complaint.summary && !logged) {
      const saved = altanaStore.log({
        uid: T.uid || "", userEmail: T.email || "", contactEmail: complaint.email || "",
        summary: complaint.summary, surface: String(body.surface || "").slice(0, 60),
      });
      if (saved.ok) logged = { id: saved.id, contactEmail: complaint.email || "" };
    }

    if (logged) {
      console.log(`[altana] complaint #${logged.id} from ${T.email || T.uid || "unknown"}`);
      // Alert the owner by email. Fire-and-forget on purpose: a mail failure must never cost the
      // user their complaint or their reply, because the record is already safely written.
      // Never mails anyone but the owner.
      (async () => {
        try {
          const prov = connectors.provider("google");
          if (!prov || !prov.connected || !prov.connected(OWNER_T)) { console.warn("[altana] complaint alert skipped: Google not connected"); return; }
          const lines = [
            "A Dominion user filed a complaint through Altana.",
            "", "WHAT THEY SAID:", (complaint && complaint.summary) || "(logged via tool)",
            "", "FROM: " + (T.email || T.uid || "unknown") + (T.isOwner ? " (owner)" : ""),
            "REPLY TO: " + (logged.contactEmail || "they did not leave an address"),
            "WHERE: " + (String(body.surface || "unknown")),
            "COMPLAINT #" + logged.id,
          ].join("\n");
          await prov.call(OWNER_T, "gmail_send", { to: OWNER_EMAIL, subject: "Dominion complaint #" + logged.id, body: lines });
          altanaStore.markAlerted(logged.id);
          console.log("[altana] complaint #" + logged.id + " emailed to the owner");
        } catch (e) { console.warn("[altana] complaint alert failed: " + (e && e.message)); }
      })();
    }

    return sjson(res, 200, {
      reply, logged, clientActions,
      model: r.usage.model, lane: r.usage.lane, billed: r.usage.billed,
      // F7: the SAME { type:"model_fallback", from, to, text } shape the SSE path already emits.
      fallback: r.fallback || null,
      // F1: nothing was deleted. Show the question, then POST /altana/ask again with
      // { confirm: [token] } and the identical question to let it through.
      confirm: r.confirmations.map((c) => ({ token: c.token, tool: c.tool, question: c.question })),
      // F3: what was refused and why. Surface it; a silent block teaches the user nothing.
      blocked: r.blocked.map((b) => ({ tool: b.name, reason: b.reason })),
    });
  }
  return sjson(res, 404, { error: "not found" });
}
```

**Integrator checks before applying:**

- `BUILD_ID`: if that identifier does not exist under that name, substitute whatever `server.mjs`
  already uses for the build/version string, or drop the field. It is cosmetic.
- **`artifacts` has two bindings and the wrong one is a cross-tenant leak.** `server.mjs:325` is
  the owner's store; `server.mjs:6382` uses `T.artifacts` inside the `/artifacts` handler. The code
  above uses `(T.artifacts || artifacts)` for the same reason. Verify this before applying.
- `workOrders.remove(uid, id)` matches `server.mjs:5082`, which resolves `uid` from the caller and
  checks ownership with `mine(body.id)` first. If a cheap ownership check is available at this call
  site, add it; otherwise `workOrders.remove` receiving the caller's own uid is the scope wall.
- `ideCloudCost(model, r)` reads `r.usage`, verified at its definition, so `{ usage: r.usage.tokens }`
  is the right argument. The only hard requirement is that the metered record names `r.usage.lane`.
- Verified present under these exact names: `BUILD_ID`, `OPENAI_KEY`, `NVIDIA_KEY`, `OWNER_T`,
  `OWNER_EMAIL`, `connectors`, `workOrders`, `sjson` (line 1719), `resolveTenant` (line 1490),
  `readJsonBody`, `meterTurn` (line 1698).

---

## 5. What each Guide route became (wargame F5)

| Was | Now | Behaviour |
|---|---|---|
| `POST /guide/ask` | `POST /altana/ask` | Replaced. Same request field `question`, same response field `reply`. New optional request fields: `settings`, `activity`, `mode`, `privacyMode`, `screenTitle`, `toolResults`, `confirm`. New response fields: `clientActions`, `fallback`, `confirm`, `blocked`, `lane`, `billed`. `/guide/ask` still routes here. |
| `GET /guide/complaints` | `GET /altana/complaints` | Unchanged behaviour, owner-only, same payload. `/guide/complaints` still routes here. |
| `POST /guide/complaint/resolve` | `POST /altana/complaint/resolve` | Unchanged behaviour, owner-only. `/guide/complaint/resolve` still routes here. |

**How the complaint data survives.** It is not migrated, because it never moves.
`createAltanaStore` opens `join(dir, "guide.db")` and `CREATE TABLE IF NOT EXISTS complaints`, with
`dir` still `dataPath("guide")`. `guide.mjs` now exports `createGuideStore = createAltanaStore`, so
the two names are the same function object. Proven by test: a record written through
`createGuideStore` is read back through `createAltanaStore`, and a resolution written by one is
seen by the other.

---

## 6. The Lane G contract (`docs/wiring/lane-g-altana-surface.md`)

Read and met.

- **§3.1 state reflection**: real today. The call sites belong to the integrator, inside `app.js`. Suggested mapping for `/altana/ask`: `altanaState("thinking")` on send,
  `altanaState("idle")` on response or error. `speaking` has no meaning on a non-streaming route.
- **§3.2 proactive nudges**: **Lane F declines to build this in this pass.** `public/altana.js`
  calls the endpoint nowhere, and this repo's 08-01 lesson was that machinery here gets built and
  never called. When a consumer exists, the redaction requirement it names is already satisfied:
  route the nudge text through `assembleContext` (or `redact` from `altana-context.mjs`) before it
  reaches the wire. Logged as an open ledger item, not as a silent omission.
- **§3.3 out of scope**: agreed. `/altana/ask` returns `reply` as text and `clientActions` as
  intents. The dot renders neither.

---

## 6b. An operational finding the integrator should carry to Fred

`[verified 2026-08-03]` NVIDIA's free developer lane returns **HTTP 429 Too Many Requests** after
roughly eight calls in a few minutes on this account. It was hit repeatedly while running this
lane's live proofs. 429 is treated as a failover signal, so Altana keeps working, and every turn
after the limit rides Luna and **bills**.

Consequences worth stating plainly:

- Altana on every screen for every user against one free seat will hit that ceiling under real
  load, and the paid seat is the shock absorber. The `model_fallback` announcement exists exactly
  so nobody is surprised by that.
- If the billed volume matters, the lever is a third seat between the two (another free NVIDIA
  model that is genuinely invokable on this account) rather than removing the failover. Adding a
  seat is one entry in `ALTANA_SEATS` in `altana.mjs`, and the engine walks the list in order.
- **Not fixed in this lane** because it needs Fred's call on cost. Logged as an open ledger item.

---

## 7. Verification after applying

```
node altana_brain_test.mjs     # 46 passed, 0 failed
node guide_test.mjs            # 12 passed, 0 failed
node -e "import('./server.mjs')"   # DO NOT. Importing server.mjs in a test is a known scar in this repo.
```

Boot the server and check, in this order:

1. `POST /altana/ask` `{"question":"what can you change for me?"}` → 200, `lane` is
   `nvidia-deepseek-v4-pro`, `billed` false.
2. `POST /guide/ask` with the same body → identical result. The alias is the no-404 guarantee.
3. `GET /altana/complaints` as owner → the complaints filed before this deploy are all present.
   **If that list is short or empty, STOP and roll back**: that is the F5 failure and it is the one
   unacceptable outcome in this lane.
4. `POST /altana/ask` `{"question":"delete my roof proposal artifact"}` → `confirm` is non-empty and
   nothing was deleted.
