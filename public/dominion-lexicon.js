/*
 * The Crucible's client dictionary: one idea, three registers.
 *   plain      Plain English, no jargon, the default.
 *   technical  Proper terminology for people who already speak it.
 *   hybrid     The technical term, taught in the same breath.
 *
 * Fred's ruling 2026-07-21: a real customer asked what "deploy" means. Words like commit, push
 * and PR cost customers purely on language, so the register is chosen by the user at the front
 * door and every string on this surface goes through here. The server's sentences (questions,
 * endings) come already phrased from idelang.mjs; this file covers the chrome around them.
 *
 * Writers' rule: plain never assumes; technical never translates; hybrid does both.
 */
(() => {
  "use strict";
  const KEY = "dominion.crucible.lang.v1";
  const REGISTERS = ["plain", "technical", "hybrid"];

  const DICT = {
    // ---- front door -------------------------------------------------------------------------
    start_heading: ["Start a build", "New build", "New build (start something)"],
    start_prompt_ph: [
      "Say what you want built. Plain words work: “a page that lists my invoices and lets me mark them paid”",
      "Describe the target. Scope tightly for a single pass.",
      "Describe what to build (plain words work; scope small for one pass).",
    ],
    start_go: ["Start the build", "Run build", "Run build (start it)"],
    add_folder: ["Add a folder", "Add workspace", "Add workspace (a project folder)"],
    use_folder: ["Use this folder", "Register workspace", "Register (use this folder)"],
    folder_ph: ["Full folder path, for example C:\\Projects\\my-app", "Workspace root path", "Workspace root (the project folder's full path)"],
    no_folder_yet: ["No folder yet. Add one.", "No workspace registered.", "No workspace (project folder) yet. Add one."],
    lang_label: ["How should Dominion talk to you?", "Terminology register", "Terminology register (how Dominion talks to you)"],
    lang_plain: ["Plain English", "Plain English", "Plain English"],
    lang_technical: ["Proper technical terms", "Technical terminology", "Technical terminology"],
    lang_hybrid: ["Tech speak, explained in English", "Technical with glosses", "Technical terms, each explained in English"],

    // ---- the intro card (first open) --------------------------------------------------------
    intro_title: ["Before your first build", "How this works", "How this works (read once)"],
    intro_body: [
      "Dominion builds on YOUR computer. The files land in a folder you pick, a save point is made before anything is changed, and your computer has to be on for a build to run. When a build finishes, the app works on your machine. Putting it on the internet so other people can use it is a separate step, and Dominion will offer it when the build is done.",
      "Builds execute on your own machine via the hands node. Files are written to the selected workspace with a snapshot taken pre-write; the node must be online. Deployment is a separate post-build step.",
      "Builds run on YOUR computer through the hands node (a small Dominion helper). Files land in your chosen workspace (project folder) with a snapshot (save point) taken first, and the machine must be on. Deployment (putting it on the internet) is a separate step offered after the build.",
    ],
    intro_ok: ["Got it", "Acknowledged", "Got it"],

    // ---- lens chrome ------------------------------------------------------------------------
    lens_blueprint: ["Blueprint", "Blueprint", "Blueprint (the plan view)"],
    lens_workshop: ["Workshop", "Workshop", "Workshop (files and logs)"],
    cost_label: ["Cost", "Cost", "Cost"],
    cost_none: ["nothing yet", "0", "0 (nothing yet)"],
    cost_zero: ["nothing spent", "$0 spent", "$0 spent (nothing yet)"],
    stop_build: ["Stop this build", "Abort build", "Abort (stop this build)"],

    // move states, the words on every card
    st_planned: ["Waiting", "Queued", "Queued (waiting its turn)"],
    st_running: ["Working", "Running", "Running (working now)"],
    st_done: ["Done", "Complete", "Complete (done)"],
    st_failed: ["Stopped", "Failed", "Failed (stopped)"],
    st_blocked: ["Refused", "Blocked", "Blocked (refused by a safety wall)"],
    st_warned: ["Done with a note", "Completed with warnings", "Completed with warnings (done, with a note)"],
    st_repairing: ["Fixing a problem", "Repairing", "Repairing (fixing a problem)"],

    outcome_done: ["Finished.", "Build complete.", "Build complete (finished)."],
    outcome_stopped: ["Stopped by you.", "Aborted by user.", "Aborted (stopped by you)."],
    outcome_error: ["Stopped before it finished.", "Build failed.", "Build failed (stopped early)."],
    outcome_interrupted: [
      "This build was interrupted when the server restarted. Its work up to that point is on disk.",
      "Interrupted by server restart; partial work persisted to disk.",
      "Interrupted by a server restart; the partial work is persisted (saved) on disk.",
    ],
    snapshot_note_one: [
      "A restore point was made before anything was written.",
      "Snapshot committed before writes.",
      "A snapshot (restore point) was committed before any writes.",
    ],
    files_touched: ["Files touched", "Files touched", "Files touched"],
    changes: ["Changes", "Diffs", "Diffs (line-by-line changes)"],
    checks: ["Checks", "Checks", "Checks (the project's own tests)"],
    check_passed: ["passed", "passed", "passed"],
    check_failed: ["failed", "failed", "failed"],
    no_builds_title: ["No builds yet", "No builds yet", "No builds yet"],
    no_builds_body: [
      "When you start one, it appears here. You can close the app while it runs; it keeps going and calls you back if it needs an answer.",
      "Builds appear here. Jobs persist server-side across client disconnects; push notifications fire on input requests.",
      "Builds appear here. A job (a running build) persists on the server even if you close the app, and a notification calls you back when it needs an answer.",
    ],

    // ---- the publish invitation -------------------------------------------------------------
    publish_cta: [
      "Put this online so everyone can use it",
      "Deploy this build",
      "Deploy (put this online so everyone can use it)",
    ],
    publish_done_line: [
      "Your build is finished and working on your computer.",
      "Build complete; artifact functional on the local machine.",
      "Build complete; it works on your machine (locally).",
    ],
    publish_explain: [
      "Right now this app lives on your computer and works there. Putting it online means renting it a home on the internet so anyone with the link can use it. That involves an account with a hosting company and usually a few dollars a month. Dominion will walk you through it step by step in an upcoming update; until then, everything you built is safe in its folder and nothing needs doing.",
      "The build currently runs locally. Deployment requires a hosting target (e.g. a PaaS account), DNS if you want a custom domain, and typically a small monthly cost. A guided deploy flow ships in an upcoming update.",
      "The build runs locally (on your computer). Deployment means hosting it on a server (a computer that is always on, rented from a hosting company) so anyone with the link can reach it; expect an account signup and a few dollars a month. A guided deploy (step-by-step publish) ships in an upcoming update.",
    ],
    publish_show: ["Show me what that involves", "Details", "Details (what deploying involves)"],
    publish_later: ["Later", "Dismiss", "Dismiss (maybe later)"],
  };

  let register = (() => {
    try { const v = localStorage.getItem(KEY); return REGISTERS.includes(v) ? v : "plain"; } catch { return "plain"; }
  })();

  const IDX = { plain: 0, technical: 1, hybrid: 2 };

  window.DominionLexicon = {
    REGISTERS,
    get register() { return register; },
    set(reg) {
      if (!REGISTERS.includes(reg)) return register;
      register = reg;
      try { localStorage.setItem(KEY, reg); } catch {}
      document.dispatchEvent(new CustomEvent("dominion-register-changed", { detail: { register: reg } }));
      return register;
    },
    // Unknown keys return the key itself: a typo shows up on screen instead of vanishing.
    L(key) {
      const e = DICT[key];
      if (!e) return key;
      return e[IDX[register]] != null ? e[IDX[register]] : e[0];
    },
    DICT,
  };
})();
