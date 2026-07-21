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

    // ---- the folder picker --------------------------------------------------------------------
    browse_btn: ["Browse my computer", "Browse", "Browse (pick from your computer's folders)"],
    browse_up: ["Back up one level", "Up", "Up (back one level)"],
    browse_here: ["Build in this folder", "Select this folder", "Select (build in this folder)"],
    browse_empty: ["Nothing inside this folder yet. You can still build here.", "Empty directory.", "Empty directory (nothing inside; you can still build here)."],
    browse_loading: ["Looking...", "Listing...", "Listing (looking inside)..."],

    // ---- tools choice (assignment board is opt-in) --------------------------------------------
    tools_label: ["Which tools should Dominion use?", "Model assignments", "Model assignments (which AI does which work)"],
    tools_default: ["Use all the default tools (recommended)", "Defaults (recommended)", "Defaults (recommended; Dominion's standard picks)"],
    tools_customize: ["Customize", "Customize", "Customize (choose each model yourself)"],

    // ---- the intake conversation --------------------------------------------------------------
    intake_title: ["Let's get this exactly right", "Scope conversation", "Scope conversation (getting the plan exactly right)"],
    intake_hint: [
      "Before spending anything, Dominion asks a few questions so it builds what you actually pictured.",
      "Pre-build requirements pass: the model interviews you before any spend.",
      "A requirements pass (a few questions first) so the build matches what you pictured, before anything is spent.",
    ],
    intake_ph: ["Type your answer...", "Reply...", "Reply (type your answer)..."],
    intake_send: ["Send", "Send", "Send"],
    intake_thinking: ["Thinking about your answer...", "Processing...", "Processing (thinking about your answer)..."],
    intake_vision_title: ["Here is what I will build:", "Agreed scope:", "Agreed scope (what will be built):"],
    intake_build: ["Build this", "Build this", "Build this"],
    intake_more: ["Keep talking first", "Refine further", "Refine further (keep talking first)"],
    intake_skip: ["Skip the questions and build now", "Skip intake, build now", "Skip intake (no questions, build now)"],
    intake_min: ["Hide this conversation", "Minimize", "Minimize (hide this conversation)"],
    intake_recall: ["Show the conversation", "Restore chat", "Restore chat (show the conversation)"],

    // ---- the guided tour ----------------------------------------------------------------------
    tour_skip: ["Skip the walkthrough", "Skip tour", "Skip tour (the walkthrough)"],
    tour_next: ["Next", "Next", "Next"],
    tour_begin: ["Begin", "Begin", "Begin"],
    tour_recall: ["Show me around", "Tour", "Tour (show me around)"],
    tour_s1_t: ["1. How Dominion talks", "1. Register", "1. Register (how Dominion talks)"],
    tour_s1_b: [
      "Pick how Dominion speaks to you: plain English, full technical terms, or technical terms explained as it goes. You can change this anytime.",
      "Choose the terminology register for this surface. Changeable at any time.",
      "Choose the register (the kind of language used everywhere here): plain, technical, or technical-with-explanations. Changeable anytime.",
    ],
    tour_s2_t: ["2. Where it gets built", "2. Workspace", "2. Workspace (where it gets built)"],
    tour_s2_b: [
      "Your app is built inside a folder on YOUR computer. Pick one here, or tap Browse to walk through your computer's folders. A save point is made before anything is touched.",
      "Select or register the workspace root on the build machine. Browse lists the node's drives. A snapshot precedes all writes.",
      "Pick the workspace (the folder on your computer where files land), or Browse your machine's folders. A snapshot (save point) is taken before anything is touched.",
    ],
    tour_s3_t: ["3. Say what you want", "3. The brief", "3. The brief (say what you want)"],
    tour_s3_b: [
      "Describe the app in your own words. Dominion will then ask you a few questions, one at a time, and show you exactly what it plans to build before it starts. Nothing is spent until you approve.",
      "Describe the target. An intake pass interviews you, then presents the agreed scope for approval before any spend.",
      "Describe the app in your own words. An intake pass (a short interview) follows, and the agreed scope is shown for approval before any spend.",
    ],
    tour_s4_t: ["4. The tools", "4. Assignments", "4. Assignments (the tools)"],
    tour_s4_b: [
      "Dominion already knows which AI is best for each kind of work, so 'Use all the default tools' is the right choice for almost everyone. Customize is there if you want to pick each one yourself.",
      "Default model assignments are curated per task class. Customize exposes the full assignment board.",
      "Default assignments (which AI handles which kind of work) are curated; Customize opens the full board if you want to choose each model yourself.",
    ],
    tour_s5_t: ["5. Start it", "5. Run", "5. Run (start it)"],
    tour_s5_b: [
      "This starts the build. You can close the app or put your phone away: the work keeps going and Dominion calls you back if it has a question. When it finishes, you get the invitation to put it online.",
      "Starts the job. Jobs persist server-side across disconnects; push notifications fire on input requests and completion. Deploy is offered post-build.",
      "Starts the job (the running build). It keeps going even if you close the app, and a notification calls you back for questions. Deploy (putting it online) is offered when it finishes.",
    ],
    tour_go_folder: ["First: pick or add your folder here", "Step 1: select a workspace", "Step 1: select a workspace (pick or add your folder)"],
    tour_go_prompt: ["Now describe what you want built", "Step 2: write the brief", "Step 2: write the brief (describe what you want)"],
    tour_go_start: ["Ready. Tap here to start", "Step 3: run the build", "Step 3: run the build (tap to start)"],
    tour_done_t: ["That's the whole loop", "Tour complete", "Tour complete (that's the whole loop)"],
    tour_done_b: [
      "You now know everything you need. Tap the compass question mark any time to see this again.",
      "Recall the tour any time from the ? control.",
      "Recall the tour (this walkthrough) any time from the ? control.",
    ],
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
