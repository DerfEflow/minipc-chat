/*
 * Dominion Works (IDE mode).
 *   SOW:        docs/IDE-MODE-ROADMAP.md
 *   Build pack: docs/IDE-MODE-BUILD.md
 *
 * Phase 0: the exposure gate. Phase 2: the workspace registry, per-user preferences, and the HTTP
 * surface over the durable job spine (idejobs.mjs). The router and build engine arrive in Phases
 * 3-5. Everything is dependency-injected the way images.mjs is, so this module needs no provider
 * or http imports and stays testable without a server.
 *
 * The gate exists so every later phase can deploy to the LIVE container while remaining invisible
 * to guests. Fred's ruling 2026-07-19: guests stay dark until Phase 8 (hardening), so the default
 * is owner-only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { routeMove, CLASS_INFO, TASK_CLASSES, DEFAULT_ASSIGNMENTS, IMAGE_ENGINE, PRESETS } from "./iderouter.mjs";
import { createPushStore } from "./idepush.mjs";
import { normalizeRegister, DEFAULT_REGISTER } from "./idelang.mjs";
import { normalizeMode } from "./idemodes.mjs";

export const IDE_MODE_DEFAULT = "owner";

// Ceilings. Generous enough that nobody sane hits them, low enough that a runaway client cannot
// turn the registry into a landfill.
export const MAX_WORKSPACES = 24;
export const MAX_NAME = 80;
export const MAX_ROOT = 400;

/*
 * Parse an IDE_MODE value into a gate.
 *   "owner" (default): Fred only
 *   "all" | "1":      every signed-in user (anon is never allowed)
 *   "off" | "0":      nobody
 *
 * An unrecognized value falls back to owner-only. A flag we cannot read must never WIDEN
 * exposure: the failure mode of a typo in a Railway env var is "Fred still sees it", never
 * "every guest just got a build surface".
 */
export function createIdeGate(raw) {
  const mode = String(raw ?? IDE_MODE_DEFAULT).trim().toLowerCase();
  const nobody = mode === "off" || mode === "0";
  const everyone = mode === "all" || mode === "1";
  return {
    mode,
    everyone,
    nobody,
    allowed(T) {
      if (nobody) return false;
      if (!T || T.role === "anon") return false;
      if (everyone) return true;
      return T.isOwner === true;
    },
  };
}

/* ============================================================================================
   Workspace registry + per-user preferences (Phase 2.2)

   One JSON file per account at <dir>/ide/state.json, where <dir> is the caller's own tenant root
   (the owner gets the global data dir). Same shape as the other zero-dep stores in this repo.

   A workspace is a POINTER, never a copy: {root} names a folder on the USER'S OWN machine that
   their hands node reaches. The server never holds project files. That is the whole reason this
   costs nothing per user to run, and it is why validation here is about refusing bad pointers
   rather than about managing storage.
   ============================================================================================ */
export function createIdeStore({ dir, isProtectedPath = () => false, now = () => Date.now() } = {}) {
  if (!dir) throw new Error("createIdeStore needs a dir");
  const home = join(dir, "ide");
  const file = join(home, "state.json");
  mkdirSync(home, { recursive: true });

  // mode "" means "never chosen": the client shows the three-cards picker exactly once.
  const blank = () => ({ prefs: { engaged: false, language: DEFAULT_REGISTER, mode: "" }, workspaces: [], subs: [] });

  function read() {
    if (!existsSync(file)) return blank();
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      return {
        prefs: {
          engaged: !!(j && j.prefs && j.prefs.engaged),
          language: normalizeRegister(j && j.prefs && j.prefs.language),
          // Model assignments made before the first workspace exists, so the board is usable on
          // day one and the first workspace inherits them.
          assignments: (j && j.prefs && j.prefs.assignments && typeof j.prefs.assignments === "object") ? j.prefs.assignments : {},
        },
        workspaces: Array.isArray(j && j.workspaces) ? j.workspaces : [],
        subs: Array.isArray(j && j.subs) ? j.subs : [],
      };
    } catch {
      // A corrupt state file must not take the surface down with it. Start clean; the previous
      // bytes stay on disk under .bad for inspection rather than being destroyed.
      try { writeFileSync(file + ".bad", readFileSync(file)); } catch {}
      return blank();
    }
  }
  function write(s) { writeFileSync(file, JSON.stringify(s, null, 2), "utf8"); return s; }

  /*
   * Validate a workspace root. Refuses rather than repairs, and says which rule it broke.
   * The carve-outs are checked HERE as well as on the node, because a refusal the user can read
   * at pick time beats a mystery failure three moves into a build.
   */
  function validateRoot(raw) {
    // Windows "Copy as path" wraps in quotes; phones paste them too. Parse, never punish.
    const root = String(raw == null ? "" : raw).trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (!root) return { ok: false, error: "Pick a folder for this workspace.", code: "root_required" };
    if (root.length > MAX_ROOT) return { ok: false, error: "That path is too long.", code: "root_too_long" };
    const absolute = /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith("/") || root.startsWith("\\\\");
    if (!absolute) return { ok: false, error: "Use a full path, for example C:\\Projects\\my-app.", code: "root_not_absolute" };
    if (isProtectedPath(root)) {
      return { ok: false, code: "root_protected",
        error: "That folder is inside a hard carve-out (backup drive or database backups). Dominion never touches those, so pick a different folder." };
    }
    return { ok: true, root };
  }

  const publicShape = (w) => ({
    id: w.id, name: w.name, root: w.root, node: w.node || "",
    createdAt: w.createdAt, updatedAt: w.updatedAt, lastMoveAt: w.lastMoveAt || 0,
    snapshotDir: w.snapshotDir || "", assignments: w.assignments || {}, budget: w.budget || null,
  });

  return {
    file,
    prefs: () => read().prefs,
    setPrefs(patch) {
      const s = read();
      if (patch && typeof patch.engaged === "boolean") s.prefs.engaged = patch.engaged;
      if (patch && patch.assignments && typeof patch.assignments === "object") s.prefs.assignments = patch.assignments;
      if (patch && typeof patch.language === "string") s.prefs.language = normalizeRegister(patch.language);
      // "" stays "": that is the never-chosen state that makes the picker appear exactly once.
      if (patch && typeof patch.mode === "string") s.prefs.mode = patch.mode === "" ? "" : normalizeMode(patch.mode);
      write(s);
      return s.prefs;
    },
    list: () => read().workspaces.map(publicShape),
    get(id) {
      const w = read().workspaces.find((x) => x.id === String(id || ""));
      return w ? publicShape(w) : null;
    },
    create({ name, root, node = "", assignments = {}, budget = null } = {}) {
      const s = read();
      if (s.workspaces.length >= MAX_WORKSPACES) {
        return { error: "You already have " + MAX_WORKSPACES + " workspaces. Remove one first.", code: "too_many" };
      }
      const v = validateRoot(root);
      if (!v.ok) return { error: v.error, code: v.code };
      const clean = String(name == null ? "" : name).trim().slice(0, MAX_NAME) || v.root.split(/[\\/]/).filter(Boolean).pop() || "Workspace";
      if (s.workspaces.some((w) => w.root.toLowerCase() === v.root.toLowerCase())) {
        return { error: "A workspace already points at that folder.", code: "root_duplicate" };
      }
      const at = now();
      const w = { id: "ws_" + randomUUID().slice(0, 10), name: clean, root: v.root, node: String(node || ""),
                  createdAt: at, updatedAt: at, lastMoveAt: 0,
                  snapshotDir: "", assignments: assignments && typeof assignments === "object" ? assignments : {},
                  budget: budget && typeof budget === "object" ? budget : null };
      s.workspaces.push(w);
      write(s);
      return { ok: true, workspace: publicShape(w) };
    },
    update(id, patch = {}) {
      const s = read();
      const w = s.workspaces.find((x) => x.id === String(id || ""));
      if (!w) return { error: "No such workspace.", code: "not_found" };
      if (typeof patch.name === "string") w.name = patch.name.trim().slice(0, MAX_NAME) || w.name;
      if (typeof patch.root === "string") {
        const v = validateRoot(patch.root);
        if (!v.ok) return { error: v.error, code: v.code };
        w.root = v.root;
      }
      if (typeof patch.node === "string") w.node = patch.node;
      if (patch.assignments && typeof patch.assignments === "object") w.assignments = patch.assignments;
      if (patch.budget === null || (patch.budget && typeof patch.budget === "object")) w.budget = patch.budget;
      if (typeof patch.lastMoveAt === "number") w.lastMoveAt = patch.lastMoveAt;
      w.updatedAt = now();
      write(s);
      return { ok: true, workspace: publicShape(w) };
    },
    remove(id) {
      const s = read();
      const i = s.workspaces.findIndex((x) => x.id === String(id || ""));
      if (i < 0) return { error: "No such workspace.", code: "not_found" };
      // Removing a workspace forgets the POINTER. It never deletes the user's folder, and the
      // wording in the UI must keep saying so.
      const [gone] = s.workspaces.splice(i, 1);
      write(s);
      return { ok: true, removed: publicShape(gone) };
    },
    validateRoot,
    // Push subscriptions live beside workspaces in the same per-account file: one device that
    // subscribed is one row here, and a question reaches every device on the account.
    push: createPushStore({
      read: () => { const st = read(); return { subs: Array.isArray(st.subs) ? st.subs : [] }; },
      write: (p) => { const st = read(); st.subs = p.subs || []; write(st); },
      now,
    }),
  };
}

/* ============================================================================================
   HTTP surface (Phase 2.3 / 2.5 / 2.6)

   createIdeFeature is dependency-injected exactly like createImagesFeature: no http, no fs, no
   provider imports reach in here, so the whole surface is testable with plain objects.

   THE GATE STACK, copied from the OCR template (server.mjs) on purpose rather than reinvented:
     anon                      -> 401 no_identity
     paused / locked           -> 403 account_<status>
     IDE not allowed for them  -> 403 ide_disabled      (the server half of the Phase 0 gate)
     not invited               -> 403 needs_invite      (billable actions only)
     credit user, no balance   -> 402 needs_credits     (billable actions only)

   Reading your own workspace list is NOT billable, so it stops at the ide_disabled check. This
   mirrors the deliberate decision in /chats/sync: syncing things you already own is not billable
   work. Starting a job IS billable, so it takes the full wall.
   ============================================================================================ */
export function createIdeFeature({ gate, storeFor, jobs, billing, multiTenant = false, log = () => {}, vapidPublicKey = "" } = {}) {
  if (!gate) throw new Error("createIdeFeature needs a gate");
  if (!storeFor) throw new Error("createIdeFeature needs storeFor(T)");
  if (!jobs) throw new Error("createIdeFeature needs a job spine");

  const ok = (body) => ({ status: 200, body });
  const err = (status, code, error) => ({ status, code, body: { error, code } });

  // Identity + account state + exposure. Everything below this line assumes a real, allowed user.
  // Workspace assignments win, else the account-level board, exactly as /ide/route/preview reads
  // them. One source of truth: the build must never route differently from what the board shows.
  function assignmentsFor(T, workspace) {
    const store = storeFor(T);
    const ws = workspace && workspace.assignments && Object.keys(workspace.assignments).length ? workspace.assignments : null;
    return ws || ((store.prefs() || {}).assignments || {});
  }

  function wall(T) {
    if (!T || T.role === "anon") return err(401, "no_identity", "Sign in to use Dominion.");
    if (T.status === "paused" || T.status === "locked") {
      return err(403, "account_" + T.status, "Account " + T.status + ".");
    }
    if (!gate.allowed(T)) {
      return err(403, "ide_disabled", "Dominion Works is not switched on for this account.");
    }
    return null;
  }

  // The extra wall for anything that can spend money. Owner and single-tenant never pay.
  function billableWall(T) {
    if (!multiTenant || !T || T.isOwner) return null;
    if (!T.invited) return err(403, "needs_invite", "You need an access code before a build can run.");
    if (T.role === "credit" && billing && !billing.canChat(T.email)) {
      return err(402, "needs_credits", "A build needs credits. Add credits in Setup first.");
    }
    return null;
  }

  return {
    wall,
    billableWall,

    // GET /ide/state: everything the surface needs to paint itself in one round trip.
    state(T) {
      const blocked = wall(T); if (blocked) return blocked;
      const store = storeFor(T);
      return ok({
        allowed: true,
        isOwner: !!T.isOwner,
        prefs: store.prefs(),
        workspaces: store.list(),
        jobs: jobs.listFor(T.uid),
        limits: { maxWorkspaces: MAX_WORKSPACES },
        // Everything the Assignment Board needs to paint itself. Prices and availability come from
        // the existing GET /api/models, so there is one catalog, not two.
        routing: { classes: CLASS_INFO, order: TASK_CLASSES, defaults: DEFAULT_ASSIGNMENTS, imageEngine: IMAGE_ENGINE, presets: PRESETS },
      });
    },

    // POST /ide/prefs {engaged}: the per-ACCOUNT toggle memory, so flipping IDE Mode on the
    // laptop is remembered on the phone (ledger L-5). The device still keeps its own copy for a
    // paint with no network wait; the server value is the one that travels.
    setPrefs(T, body) {
      const blocked = wall(T); if (blocked) return blocked;
      const store = storeFor(T);
      return ok({ prefs: store.setPrefs({
        engaged: !!(body && body.engaged),
        assignments: body && body.assignments,
        language: body && body.language,
      }) });
    },

    listWorkspaces(T) {
      const blocked = wall(T); if (blocked) return blocked;
      return ok({ workspaces: storeFor(T).list() });
    },

    createWorkspace(T, body) {
      const blocked = wall(T); if (blocked) return blocked;
      const r = storeFor(T).create({
        name: body && body.name, root: body && body.root,
        node: body && body.node, assignments: body && body.assignments, budget: body && body.budget,
      });
      if (r.error) return { status: 400, code: r.code, body: r };
      log("[ide] workspace created " + r.workspace.id + " for " + (T.uid || "owner"));
      return ok(r);
    },

    updateWorkspace(T, body) {
      const blocked = wall(T); if (blocked) return blocked;
      /*
       * Accept the patch nested OR flat. create() takes flat fields, so callers reasonably send
       * update() the same shape, and the old strict form silently changed NOTHING when they did:
       * a budget "set" this way never armed, which is a terrible failure mode for the one field
       * that guards spending. Sibling endpoints get sibling shapes.
       */
      const b = body || {};
      const patch = (b.patch && typeof b.patch === "object") ? b.patch : {
        name: b.name, root: b.root, node: b.node, assignments: b.assignments,
        budget: "budget" in b ? b.budget : undefined,
      };
      const r = storeFor(T).update(b.id, patch);
      if (r.error) return { status: r.code === "not_found" ? 404 : 400, code: r.code, body: r };
      return ok(r);
    },

    removeWorkspace(T, body) {
      const blocked = wall(T); if (blocked) return blocked;
      const r = storeFor(T).remove(body && body.id);
      if (r.error) return { status: 404, code: r.code, body: r };
      return ok(r);
    },

    // GET /ide/jobs: the multi-job registry. Independent of whatever the user is looking at, which
    // is the whole point (chat's single view-bound job is the limitation Phase 4 removes).
    listJobs(T) {
      const blocked = wall(T); if (blocked) return blocked;
      return ok({ jobs: jobs.listFor(T.uid), active: jobs.activeFor(T.uid).length });
    },

    /*
     * POST /ide/job: start one.
     *
     * Phase 2 ships exactly one kind, "probe": it emits a short, real sequence of structural
     * events and completes. No model is called and nothing is charged. It exists to prove the
     * spine end to end (journal on disk, replay, reattach, restart recovery) BEFORE the build
     * engine in Phase 5 depends on it. It is deliberately labelled as a probe rather than dressed
     * up as a build, because a fake build would be a lie in the UI.
     */
    startJob(T, body, { runner } = {}) {
      const blocked = wall(T); if (blocked) return blocked;
      const billBlocked = billableWall(T); if (billBlocked) return billBlocked;

      const kind = String((body && body.kind) || "probe");
      if (kind !== "probe" && kind !== "build") {
        return err(400, "unknown_kind", "A job is either a probe or a build.");
      }
      const workspaceId = String((body && body.workspaceId) || "");
      const workspace = workspaceId ? storeFor(T).get(workspaceId) : null;
      if (workspaceId && !workspace) return err(404, "not_found", "No such workspace.");

      const prompt = String((body && body.prompt) || "").trim().slice(0, 4000);
      if (kind === "build") {
        // A build writes real files on a real machine, so it needs to know WHERE before it starts.
        if (!workspace) return err(400, "workspace_required", "Pick a workspace folder before starting a build.");
        if (!prompt) return err(400, "prompt_required", "Say what you want built.");
        // One build per workspace. Two builds writing the same tree is the concurrency bug that
        // this whole design exists to avoid, so it is refused at the door rather than survived.
        const busy = jobs.activeFor(T.uid).find((j) => j.workspaceId === workspaceId && !j.done);
        if (busy) return err(409, "workspace_busy", "That workspace already has a build running. Let it finish or stop it first.");
      }

      const job = jobs.create({ uid: T.uid, workspaceId, kind, isOwner: !!T.isOwner });
      log("[ide] job " + job.id + " (" + kind + ") started by " + (T.uid || "owner"));
      if (typeof runner === "function") {
        try { const prefs = storeFor(T).prefs() || {};
          runner(job, { workspace, prompt, assignments: assignmentsFor(T, workspace),
          register: prefs.language, mode: prefs.mode }); }
        catch (e) { jobs.emit(job.id, { type: "error", message: String(e && e.message || e) }); }
      }
      return ok({ jobId: job.id, kind, workspaceId });
    },

    stopJob(T, body) {
      const blocked = wall(T); if (blocked) return blocked;
      const id = String((body && body.jobId) || "");
      const job = jobs.get(id);
      // Never let one account stop another's job, and never confirm existence across the wall:
      // a stranger's job id gets the same answer as a nonexistent one.
      if (!job || job.uid !== T.uid) return err(404, "not_found", "Unknown or expired job.");
      return ok(jobs.stop(id));
    },

    /*
     * POST /ide/route/preview {title, description, files, workspaceId}
     * Answers "where would this go, and why" WITHOUT running anything or spending a cent. The
     * deterministic table decides; no classifier is called here, because a preview that costs
     * money the moment you type would defeat the purpose. It is what lets the surface show its
     * reasoning up front rather than after the bill.
     */
    previewRoute(T, body) {
      const blocked = wall(T); if (blocked) return blocked;
      const store = storeFor(T);
      const ws = body && body.workspaceId ? store.get(String(body.workspaceId)) : null;
      // Same precedence the board itself uses: a workspace's own assignments win, otherwise the
      // account-level ones set before any workspace existed. Reading only the workspace made the
      // preview answer with defaults while the board displayed something else, which is worse than
      // no preview at all: it shows a decision the engine would not actually make.
      const stored = (ws && ws.assignments && Object.keys(ws.assignments).length)
        ? ws.assignments
        : ((store.prefs() || {}).assignments || {});
      const decision = routeMove(
        { title: body && body.title, description: body && body.description, files: (body && body.files) || [] },
        stored,
        { allInOne: stored.allInOne || "", fallback: (ws && ws.model) || (body && body.fallback) || "" },
      );
      return ok({
        taskClass: decision.taskClass,
        label: CLASS_INFO[decision.taskClass].label,
        model: decision.model,
        isImage: decision.isImage,
        why: decision.why,
        confidence: decision.confidence,
        wouldAskClassifier: decision.needsClassifier,
      });
    },

    /*
     * POST /ide/job/answer {jobId, questionId, answer}
     * Releases a frozen build. The freeze is the point: between need_input and this call the job
     * spends NOTHING, so a question left unanswered overnight costs nothing but time. Any device
     * on the account can answer, because the job lives on the server rather than in the tab that
     * started it.
     */
    answerJob(T, body) {
      const blocked = wall(T); if (blocked) return blocked;
      const id = String((body && body.jobId) || "");
      const job = jobs.get(id);
      if (!job || job.uid !== T.uid) return err(404, "not_found", "Unknown or expired job.");
      if (job.done) return err(409, "already_done", "That build has already finished.");
      const answer = String((body && body.answer) || "").slice(0, 2000);
      if (!answer) return err(400, "answer_required", "Say what you want it to do.");
      jobs.emit(id, { type: "answer", id: String((body && body.questionId) || ""), answer });
      return ok({ ok: true });
    },

    // ---- push: how a build reaches a user who is not looking at it ------------------------
    // The key is public by design (it is the applicationServerKey the browser subscribes with).
    pushKey(T) {
      const blocked = wall(T); if (blocked) return blocked;
      return ok({ publicKey: vapidPublicKey || "", configured: !!vapidPublicKey });
    },

    subscribePush(T, body) {
      const blocked = wall(T); if (blocked) return blocked;
      if (!vapidPublicKey) return err(503, "push_unconfigured", "Push is not configured on this server yet.");
      const r = storeFor(T).push.add(body && body.subscription, { label: (body && body.label) || "" });
      if (r.error) return { status: 400, code: r.code, body: r };
      log("[ide] push subscribed: " + (T.uid || "owner") + " (" + r.count + " device(s))");
      return ok(r);
    },

    unsubscribePush(T, body) {
      const blocked = wall(T); if (blocked) return blocked;
      return ok(storeFor(T).push.remove((body && body.endpoint) || ""));
    },

    // Ownership check for the SSE attach route, which the server wires to the raw response.
    canAttach(T, jobId) {
      const blocked = wall(T); if (blocked) return blocked;
      const job = jobs.get(String(jobId || ""));
      if (!job || job.uid !== T.uid) return err(404, "not_found", "Unknown or expired job.");
      return ok({ job });
    },
  };
}
