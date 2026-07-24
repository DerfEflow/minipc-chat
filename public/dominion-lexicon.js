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
    use_folder: ["Save this folder", "Register workspace", "Register (save this folder)"],
    folder_ph: ["The folder's address, for example C:\\Apps\\MyApp", "Workspace root path", "Workspace root (the folder's full address)"],
    no_folder_yet: ["No folder yet. Add one.", "No workspace registered.", "No workspace (project folder) yet. Add one."],
    lang_label: ["How should Dominion talk to you?", "Terminology register", "Terminology register (how Dominion talks to you)"],
    lang_plain: ["Plain English", "Plain English", "Plain English"],
    lang_technical: ["Proper technical terms", "Technical terminology", "Technical terminology"],
    lang_hybrid: ["Tech speak, explained in English", "Technical with glosses", "Technical terms, each explained in English"],

    // ---- one shared journey ---------------------------------------------------------------
    journey_kicker: ["Where you are", "Current phase", "Current phase (where you are)"],
    journey_idea_title: ["Shape the idea", "Define target", "Shape the idea (define the target)"],
    journey_idea_note: ["Tell Dominion what you want to make.", "Specify the intended artifact.", "Tell Dominion what you want to make (the target artifact)."],
    journey_clarify_title: ["Make the plan clear", "Resolve requirements", "Clarify the plan (resolve requirements)"],
    journey_clarify_note: ["One useful question at a time.", "Resolve one material ambiguity at a time.", "One material ambiguity (important unanswered detail) at a time."],
    journey_ready_title: ["Approve the plan", "Approve specification", "Approve the specification (the build plan)"],
    journey_ready_note: ["Review what will be built before work starts.", "Review the accepted scope before execution.", "Review the accepted scope (what will be built) before execution."],
    journey_build_title: ["Build the app", "Execute build", "Execute the build (make the app)"],
    journey_build_note: ["Your AI crew is working on your computer.", "Agents are executing against the local workspace.", "The agents (AI workers) are building in your local workspace (project folder)."],
    journey_verify_title: ["Prove it works", "Verify completion", "Verify completion (prove it works)"],
    journey_verify_note: ["Tests, a live tryout, and repairs decide whether it is done.", "Tests, preview, and repair determine completion.", "Tests, preview, and repair determine completion (whether it is truly done)."],
    journey_ship_title: ["Use it or share it", "Preview or deploy", "Preview or deploy (use it or put it online)"],
    journey_ship_note: ["Try the finished app, improve it, or put it online.", "Exercise the artifact, refine it, or deploy it.", "Use the finished artifact (app), refine it, or deploy it (put it online)."],

    // ---- Vibe Studio Drawer ---------------------------------------------------------------
    studio_toolbar_title: ["Your studio", "Workspace layout", "Your studio (workspace layout)"],
    studio_open: ["Choose my tools", "Configure workspace", "Customize workspace (choose your tools)"],
    studio_kicker: ["Vibe workspace", "Vibe workspace", "Vibe workspace"],
    studio_title: ["Make the studio yours", "Configure workspace", "Make the workspace yours"],
    studio_intro: [
      "Chat and build progress always stay here. Pick the extra tools you want around them.",
      "Chat and job state remain fixed. Select the additional workspace modules.",
      "Chat and build state always remain. Select the extra modules (workspace tools) around them.",
    ],
    studio_immediate: ["Changes happen right away.", "Changes apply immediately.", "Changes apply immediately (right away)."],
    studio_done: ["Done", "Done", "Done"],
    studio_preset_minimal: ["Simple", "Minimal", "Minimal (simple)"],
    studio_preset_design: ["Design studio", "Design Studio", "Design Studio"],
    studio_preset_fullstack: ["Full app", "Full Stack", "Full Stack (the complete app workspace)"],
    studio_preset_ship: ["Finish and share", "Ship It", "Ship It (finish and deploy)"],
    studio_preset_custom: ["My setup", "Custom", "Custom (your setup)"],
    studio_tools_count: ["tools", "modules", "modules (tools)"],
    studio_workspace_title: ["Project folder", "Workspace", "Workspace (project folder)"],
    studio_workspace_note: ["Where the app lives on your computer.", "Local workspace root.", "The local workspace root (where the app lives)."],
    studio_brief_title: ["Build plan", "Build brief", "Build brief (the living plan)"],
    studio_brief_note: ["The living description of what Dominion is making.", "Current accepted build specification.", "The accepted build specification (what Dominion is making)."],
    studio_crew_title: ["AI crew", "Agent crew", "Agent crew (AI workers)"],
    studio_crew_note: ["Choose the AIs, their jobs, and how many work at once.", "Models, task assignments, and parallel agent count.", "Models, task assignments, and agent count (how many work at once)."],
    studio_cost_title: ["Cost", "Cost", "Cost"],
    studio_cost_note: ["What the build has spent and its best estimate.", "Actual spend and current estimate.", "Actual spend and the current estimate."],
    studio_preview_title: ["Try the app", "Live preview", "Live preview (try the app)"],
    studio_preview_note: ["Open and use the app while it is being built.", "Run and exercise the current artifact.", "Run and exercise the current artifact (the app being built)."],
    studio_checks_title: ["Tests and results", "Tests and output", "Tests and output (results)"],
    studio_checks_note: ["See what ran and whether it passed.", "Inspect commands, output, and pass/fail state.", "Inspect commands, output, and pass/fail state."],
    studio_code_title: ["Files and changes", "Files and diffs", "Files and diffs (line-by-line changes)"],
    studio_code_note: ["See the files Dominion touched and what changed.", "Inspect file tree, diffs, and implementation detail.", "Inspect the file tree, diffs (line changes), and implementation detail."],
    studio_history_title: ["Past builds", "Build history", "Build history (past builds)"],
    studio_history_note: ["Open a build again without losing its story.", "Replay durable build journals.", "Replay durable build journals (reopen saved build history)."],

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

    // ---- iteration 2.3: the beginner's front door (Fred's beginner roleplay, 2026-07-22) ----
    st_name_ph: ["What should we call this app? (you can skip this)", "Name (optional)", "Name (optional; used for the workspace label)"],
    folder_saved: ["Saved. Your app will live there.", "Workspace registered.", "Workspace registered (your app will live there)."],
    pick_folder_first: ["Pick a folder first, or tap Browse my computer.", "Select a workspace first.", "Select a workspace (a project folder) first."],
    type_path_first: ["Tap Browse my computer, or paste the folder's address here first.", "Enter the workspace root path first.", "Enter the workspace root (the folder's full address) first."],

    // ---- the conversation surface (Fred's ruling 2026-07-22: the conversation IS the surface).
    // The beginner journey opens with canned beats in the owner's voice: zero model spend until
    // the user actually answers. Order per register: [plain, technical, hybrid]. ----------------
    howdy: [
      "Howdy! What can I help you build?",
      "Ready. Describe the build.",
      "Ready when you are. Tell me what you want built and I will scope it with you.",
    ],
    dream_ph: ["Tell me what you're dreaming up...", "Describe the target...", "Describe what you want built..."],
    node_offline_explain: [
      "One thing before we start. I need somewhere to keep your app while we work on it, and this app uses YOUR computer for that. If you are reading this on your phone, go turn your computer on, open a web browser there, and type in app.dominion.tools. Install this same app on the computer. Once that is done, the two of them talk to each other, and you can build from anywhere, even right here on your phone. Let me know when it is set up. And if you get stuck, just ask me for help.",
      "No build node connected. Install the app from app.dominion.tools on the machine that should host the workspace; the node pairs automatically and this session detects it.",
      "No build machine is connected yet. Your apps are stored on your own computer (the build node). On that computer, open app.dominion.tools in a browser and install this app; it pairs automatically and I will pick this up the moment it connects.",
    ],
    node_watching: [
      "I'll keep an eye out for your computer. Take your time.",
      "Polling for node...",
      "Watching for the node (your computer) to connect...",
    ],
    node_connected_celebrate: [
      "OK, I see you got my buddy all set up on the computer. And while you were doing that, we already had a conversation, and we have decided we like you. Now, where were we...",
      "Build node connected. Resuming.",
      "Build node connected (your computer and this app are talking now). Picking up right where we left off.",
    ],

    // ---- the folder picker --------------------------------------------------------------------
    browse_btn: ["Browse my computer", "Browse", "Browse (pick from your computer's folders)"],
    browse_up: ["Go back", "Up", "Up (go back one folder)"],
    browse_here: ["Put my app here", "Select this folder", "Select (put the app here)"],
    browse_empty: ["Nothing inside this folder yet. You can still build here.", "Empty directory.", "Empty directory (nothing inside; you can still build here)."],
    browse_loading: ["Looking...", "Listing...", "Listing (looking inside)..."],

    // ---- AF: the agentic workflow window (Fred's design 2026-07-22; vibe + engineer only) -----
    af_btn: ["AF", "AF", "AF"],
    af_title: ["Your agent crew", "Agentic workflow", "Agentic workflow (your agent crew)"],
    af_hint: [
      "A crew of AIs splits the work and builds the parts at the same time. Each row is one job in the relay.",
      "Partition pipeline: divider writes contracts, workers build disjoint parts in parallel, reviewer fixes, QC verifies. One model per row.",
      "A partition pipeline (a relay of AI agents): one divides the work into parts with contracts, several build the parts at the same time, one reviews and fixes, one does the final check. One model per row.",
    ],
    af_col_task: ["What to do", "Task", "Task (what to do)"],
    af_col_model: ["Which AI", "Model", "Model (which AI)"],
    af_col_n: ["How many", "Number", "Number (how many agents)"],
    af_add: ["Add a row", "Add row", "Add row"],
    af_on: ["Use this crew for builds", "Enable agentic workflow", "Enable (use this crew for builds)"],
    af_reset: ["Back to the standard crew", "Reset to template", "Reset to the default template"],
    af_custom_title: ["Build it your way", "Full custom sections", "Full custom (own every section)"],
    af_custom_hint: [
      "Let the planner split your idea into sections, then pick any AI and how many helpers for each. The time and cost update as you choose. Anything is allowed; a red note warns you when a pick is a stretch, but it is yours to try.",
      "Divide the build into sections and assign a model and agent count to each. Estimates recompute live; inadequate picks are flagged red but never blocked.",
      "Divide the build into sections, then assign a model and agent count (helpers) to each. Estimates update live; a red note flags a stretch pick without blocking it.",
    ],
    af_divide: ["Plan the sections", "Divide the build", "Divide into sections"],
    af_dividing: ["Planning...", "Dividing...", "Dividing..."],
    af_divide_failed: ["Could not plan the sections. Try again.", "Divide failed. Retry.", "Divide failed; try again."],
    af_need_brief: ["Say what you want built first, up in the conversation.", "Enter a brief first.", "Enter a brief first (say what to build)."],
    af_agents: ["helpers", "agents", "agents (helpers)"],
    af_est_pending: ["Pick an AI to see time and cost", "Select a model for estimates", "Pick a model to estimate time and cost"],
    af_est_prior: ["(rough guess)", "(prior estimate)", "(rough prior, not yet measured)"],
    af_plan_total: ["Whole build:", "Total:", "Whole build (total):"],
    af_plan_tasks: ["Plan the tasks", "Plan tasks", "Plan the tasks (numbered roadmap)"],
    af_planning: ["Planning...", "Planning...", "Planning..."],
    af_plan_failed: ["Could not plan the tasks. Try again.", "Planning failed. Retry.", "Planning failed; try again."],
    af_tasks_hint: [
      "Let the orchestrator lay out the build as numbered tasks. Give any task its own AI and helpers; tasks with the same group name share a setup. Put more than one helper on a task and Dominion checks whether it can be split; if it cannot, it says so and keeps it to one.",
      "The build as a numbered task list. Assign a model and agents per task; shared group names share config. Multi-agent tasks are checked for reducibility.",
      "The build as a numbered task list (a roadmap). Assign a model and agents (helpers) per task; a shared group name shares the setup. Adding helpers triggers a split check; irreducible tasks stay single.",
    ],
    af_group_ph: ["group (optional)", "group", "group tag (optional)"],
    af_reduce_checking: ["Checking whether this can be split...", "Checking reducibility...", "Checking whether this can be split..."],

    // ---- Plan Pipeline (Phase 2A) -------------------------------------------------------------
    plan_drawer: ["Start from a plan", "Start from a plan", "Start from a plan (a roadmap you made)"],
    plan_from_saved: ["Load a plan you saved from a chat:", "Load a saved plan:", "Load a saved plan (from a chat):"],
    plan_load: ["Load", "Load", "Load"],
    plan_none: ["Choose a saved plan...", "Select a plan...", "Choose a saved plan..."],
    plan_paste_ph: ["...or paste a plan here (a roadmap, phases, task list, or MVP)", "...or paste a plan (roadmap/phases/tasks/MVP)", "...or paste a plan here (roadmap, phases, tasks, MVP)"],
    plan_name_ph: ["Name this project", "Project name", "Name this project"],
    plan_start: ["Start this project", "Start project", "Start this project"],
    plan_pick_first: ["Choose a saved plan first.", "Select a plan first.", "Choose a saved plan first."],
    plan_loaded: ["Plan loaded. Name it and start, or edit it first.", "Plan loaded.", "Plan loaded (name it and start, or edit first)."],
    plan_load_failed: ["That plan could not be loaded.", "Load failed.", "That plan could not be loaded."],
    plan_empty: ["Paste or load a plan first.", "No plan yet.", "Paste or load a plan first."],
    plan_started: ["Project set up from the plan. Pick a folder, then build.", "Project seeded. Choose a folder and build.", "Project set up from the plan (pick a folder, then build)."],

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
    fresh_start: ["Start fresh", "Reset build", "Start fresh (clear this build)"],
    fresh_done: ["Clean slate. What are we building?", "State cleared.", "Cleared (a clean slate). What are we building?"],
    intake_recall: ["Show the conversation", "Restore chat", "Restore chat (show the conversation)"],

    // ---- the guided tour ----------------------------------------------------------------------
    tour_skip: ["Skip the walkthrough", "Skip tour", "Skip tour (the walkthrough)"],
    tour_next: ["Next", "Next", "Next"],
    tour_begin: ["Begin", "Begin", "Begin"],
    tour_recall: ["Show me around", "Tour", "Tour (show me around)"],
    tour_s1_t: ["How Dominion talks", "Register", "Register (how Dominion talks)"],
    tour_s1_b: [
      "Pick how Dominion speaks to you: plain English, full technical terms, or technical terms explained as it goes. You can change this anytime.",
      "Choose the terminology register for this surface. Changeable at any time.",
      "Choose the register (the kind of language used everywhere here): plain, technical, or technical-with-explanations. Changeable anytime.",
    ],
    tour_s2_t: ["Where it gets built", "Workspace", "Workspace (where it gets built)"],
    tour_s2_b: [
      "Your app is built inside a folder on YOUR computer. Pick one here, or tap Browse to walk through your computer's folders. A save point is made before anything is touched.",
      "Select or register the workspace root on the build machine. Browse lists the node's drives. A snapshot precedes all writes.",
      "Pick the workspace (the folder on your computer where files land), or Browse your machine's folders. A snapshot (save point) is taken before anything is touched.",
    ],
    tour_s3_t: ["Say what you want", "The brief", "The brief (say what you want)"],
    tour_s3_b: [
      "Just talk to it. Type what you are dreaming of making, in your own words, right here in the conversation. Dominion will ask you a few easy questions, one at a time, and show you its plan before anything starts.",
      "Describe the target. An intake pass interviews you, then presents the agreed scope for approval before any spend.",
      "Describe the app in your own words. An intake pass (a short interview) follows, and the agreed scope is shown for approval before any spend.",
    ],
    tour_s4_t: ["The tools", "Assignments", "Assignments (the tools)"],
    tour_s4_b: [
      "Dominion already knows which AI is best for each kind of work, so 'Use all the default tools' is the right choice for almost everyone. Customize is there if you want to pick each one yourself.",
      "Default model assignments are curated per task class. Customize exposes the full assignment board.",
      "Default assignments (which AI handles which kind of work) are curated; Customize opens the full board if you want to choose each model yourself.",
    ],
    tour_s5_t: ["Start it", "Run", "Run (start it)"],
    tour_s5_b: [
      "This starts the build. You can close the app or put your phone away: the work keeps going and Dominion calls you back if it has a question. When it finishes, you get the invitation to put it online.",
      "Starts the job. Jobs persist server-side across disconnects; push notifications fire on input requests and completion. Deploy is offered post-build.",
      "Starts the job (the running build). It keeps going even if you close the app, and a notification calls you back for questions. Deploy (putting it online) is offered when it finishes.",
    ],
    tour_go_folder: ["First: pick or add your folder here", "Step 1: select a workspace", "Step 1: select a workspace (pick or add your folder)"],
    tour_go_prompt: ["Tell Dominion what you want to build, right here", "Step 2: write the brief", "Step 2: write the brief (describe what you want)"],
    tour_go_start: ["When the plan looks right, just say: build it", "Step 3: run the build", "Step 3: run the build (tap to start)"],
    tour_done_t: ["That's the whole loop", "Tour complete", "Tour complete (that's the whole loop)"],
    tour_done_b: [
      "You now know everything you need. Tap the compass question mark any time to see this again.",
      "Recall the tour any time from the ? control.",
      "Recall the tour (this walkthrough) any time from the ? control.",
    ],

    // ---- the three modes ------------------------------------------------------------------
    mode_q: ["Which sounds most like you?", "Select working mode", "Select working mode (which sounds most like you?)"],
    mode_note: [
      "This shapes how everything here looks and talks. Change it any time with the switch above.",
      "Sets layout density, terminology and defaults. Switchable at any time.",
      "Sets layout, terminology and defaults; switch any time with the control above.",
    ],
    mode_beginner_t: ["I'm new to this", "Beginner", "Beginner (new to this)"],
    mode_beginner_b: [
      "You describe it, we talk it through, and it gets built. No technical words, ever.",
      "Chat-first surface, curated defaults, zero configuration.",
      "Chat-first surface with curated defaults (no configuration, no jargon).",
    ],
    mode_vibe_t: ["I build with AI", "Vibe coder", "Vibe coder (builds with AI)"],
    mode_vibe_b: [
      "You know what you want and roughly how this works. Clear options, honest costs, no clutter.",
      "Intentional feature set with upfront cost and complexity.",
      "Intentional features with upfront cost and complexity (no clutter).",
    ],
    mode_engineer_t: ["I'm a software engineer", "Software engineer", "Software engineer"],
    mode_engineer_b: [
      "Full control in labelled drawers: models, budgets, code, diffs. Terse and precise.",
      "Full control surface: assignments, budgets, diffs, code. Terse.",
      "Full control surface in drawers (assignments, budgets, diffs, code). Terse.",
    ],
    mode_name_beginner: ["New to this", "Beginner", "Beginner"],
    mode_name_vibe: ["Vibe coder", "Vibe coder", "Vibe coder"],
    mode_name_engineer: ["Engineer", "Engineer", "Engineer"],

    // ---- the vibe coder model line + honesty card -------------------------------------------
    model_line_intro: ["Who does the work:", "Assignments:", "Assignments (who does the work):"],
    model_line_change: ["Change", "Edit", "Edit (change who does what)"],
    involves_title: ["What this involves", "Scope implications", "Scope implications (what this involves)"],
    involves_cost: ["Building it should cost", "Estimated build cost", "Estimated build cost (what building it should cost)"],
    involves_none: [
      "Nothing complicated: no accounts, no database, no outside services.",
      "No external dependencies implied.",
      "No external dependencies implied (no accounts, database, or outside services).",
    ],

    // ---- mockups in the chat -----------------------------------------------------------------
    mockup_making: ["Painting that for you...", "Rendering mockup...", "Rendering mockup (painting that for you)..."],
    mockup_pick: ["That one", "Select", "Select (that one)"],
    mockup_failed: ["That picture could not be made. Describe it in words and we keep going.", "Mockup render failed; continue textually.", "Mockup render failed (the picture could not be made); continue in words."],

    // ---- the workshop code toggle + closing flow ----------------------------------------------
    code_show: ["Show me the code", "Show code", "Show code (the files being written)"],
    code_hide: ["Hide the code", "Hide code", "Hide code"],
    drawer_folder: ["Where it gets built", "Workspace", "Workspace (where it gets built)"],
    drawer_brief: ["What to build", "Brief", "Brief (what to build)"],
    drawer_models: ["The tools", "Assignments", "Assignments (the tools)"],
    drawer_session: ["How Dominion talks", "Register", "Register (how Dominion talks)"],
    preview_title: ["Try your app", "Live preview", "Live preview (try your app)"],
    preview_open: ["See it working", "Start preview", "Start preview (see it working)"],
    preview_wait: ["Starting it up...", "Launching...", "Launching (starting it up)..."],
    preview_close: ["Close the preview", "Stop preview", "Stop preview (close it)"],
    preview_fail: ["It could not be started. Try again in a moment.", "Preview launch failed.", "Preview launch failed (it could not be started)."],
    // ---- iteration 2.1: Fred's first phone pass (2026-07-21 late night) ---------------------
    divider_label: ["App Builder", "Dominion Works", "App Builder (Dominion Works)"],
    flame_working: ["Working", "Working", "Working"],
    err_timeout: [
      "That took too long, so I stopped waiting. Nothing was lost. Tap send to try again.",
      "Request timed out; state preserved. Retry.",
      "Request timed out (took too long); nothing was lost. Retry.",
    ],
    err_network: [
      "I could not reach the server. Check your connection and try again; nothing was lost.",
      "Network unreachable; state preserved. Retry.",
      "Network unreachable (could not reach the server); nothing was lost. Retry.",
    ],
    mode_dontshow: ["Don't show this again", "Don't show again", "Don't show again"],
    chat_build_started: [
      "I've started building. You can watch it work, or put the phone down: I'll call you if I need you, and everything we talked about is saved.",
      "Build started. Job persists server-side; notifications on input requests.",
      "Build started; the job (running build) persists even if you leave, and I'll call you if I need you.",
    ],
    start_talk: ["Continue", "Begin intake", "Begin intake (continue)"],
    draft_restored: [
      "Picked up right where you left off.",
      "Draft restored.",
      "Draft restored (right where you left off).",
    ],
    ask_title: ["Your build needs you", "Input required", "Input required (your build needs you)"],
    log_title: ["Past builds", "Build log", "Build log (past builds)"],
    log_empty: ["Nothing here yet. Your finished builds will be listed here.", "No completed jobs.", "No completed jobs (finished builds appear here)."],
    tour_halt_t: ["It's building!", "Build running", "Build running (it's building)"],
    tour_halt_b: [
      "That's everything: your app is being built right now. Watch it work below, and I'll pop up if it needs you.",
      "Tour ended: job started. Monitor below; notifications fire on input requests.",
      "Tour ended: the job (your build) is running. Watch below; you'll be called if it needs you.",
    ],
    closing_line: [
      "It is built and working. The next step, whenever you are ready, is putting it online so everyone can use it.",
      "Build complete. Next step: deployment.",
      "Build complete. Next step: deployment (putting it online so everyone can use it).",
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
