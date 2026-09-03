/*
 * SD Tech Mobile Game Factory — deterministic portfolio specification templates.
 *
 * This module contains product hypotheses and document renderers, not approvals or game code.
 * Keeping the package deterministic lets the factory test, version and mirror the exact same
 * artifact set before any game is admitted to implementation.
 */

import { PORTFOLIO, REQUIRED_GAME_ARTIFACTS } from "./gamefactory.mjs";

export const PORTFOLIO_PACKAGE_DATE = "2026-08-31";
export const PORTFOLIO_PUBLISHER = "SD Tech, LLC";

export const MARKET_RESEARCH_SOURCES = Object.freeze([
  {
    id: "sensor-tower-2026",
    title: "Sensor Tower State of Gaming 2026",
    organization: "Sensor Tower",
    url: "https://sensortower.com/press/press-release-sensor-tower-state-of-gaming-gaming-drove-52-billion-downloads-82b-iap-revenue-on-mobile-and-12b-premium-revenue-on-steam",
    note: "Reports that 2025 mobile-game IAP revenue reached about $82B while growth slowed, emphasizing retention, engagement and monetization in a mature market.",
  },
  {
    id: "sensor-tower-q2-2026",
    title: "Q2 2026 Digital Market Index",
    organization: "Sensor Tower",
    url: "https://sensortower.com/blog/q2-2026-digital-market-index-report",
    note: "Reports Puzzle as the only major mobile-game genre with positive year-over-year download growth in Q2 2026, at roughly 1%.",
  },
  {
    id: "sensor-tower-march-2026",
    title: "Top 10 Worldwide Mobile Games — March 2026",
    organization: "Sensor Tower",
    url: "https://sensortower.com/blog/top-10-worldwide-mobile-games-by-revenue-and-downloads-in-march-2026",
    note: "Describes simple, accessible formats, intuitive mechanics, short sessions and repeatable loops as recurring download-growth traits; this is directional evidence, not proof for these concepts.",
  },
  {
    id: "apple-product-page",
    title: "Product Page Optimization",
    organization: "Apple Developer",
    url: "https://developer.apple.com/app-store/product-page-optimization/",
    note: "Apple's official workflow supports testing icons, screenshots and previews, making a measurable store-page hypothesis practical after distribution eligibility.",
  },
  {
    id: "google-listing-experiments",
    title: "Run A/B tests on your store listing",
    organization: "Google Play Console Help",
    url: "https://support.google.com/googleplay/android-developer/answer/12053285?hl=en",
    note: "Google's official workflow supports controlled store-listing experiments using install/open outcomes.",
  },
  {
    id: "android-vitals",
    title: "Android vitals for games",
    organization: "Android Developers",
    url: "https://developer.android.com/games/optimize/vitals",
    note: "Google documents quality signals such as crashes, ANRs, memory, battery and slow sessions that may affect Play visibility.",
  },
  {
    id: "google-families",
    title: "Google Play Families Policies",
    organization: "Google Play Console Help",
    url: "https://support.google.com/googleplay/android-developer/answer/9893335?hl=en",
    note: "Official policy source for age targeting, child-directed monetization and advertising constraints; final audience declarations require publisher/legal review.",
  },
]);

const shared = Object.freeze({
  engine: "Godot 4.x cross-platform 2D candidate, admitted only after the factory toolchain probe pins a supported version",
  fps: "Sustained 60 FPS target on the agreed mid-tier device matrix; 30 FPS is a measured fallback, never a silent default",
  save: "Versioned local save with atomic replacement, corruption fallback and explicit migration tests; cloud sync is out of MVP unless separately approved",
  privacy: "Collect no direct identifiers in MVP; use event names with coarse, non-sensitive gameplay properties only after consent/legal configuration is approved",
  audience: "Broad-audience presentation is proposed. The target-age, child-directed status and rating answers remain unmade publisher/legal decisions.",
});

const games = [
  {
    order: 1,
    name: "Vector Vault",
    slug: "vector-vault",
    status: "PILOT_CANDIDATE — PRE-ADMISSION",
    genre: "one-screen spatial logic puzzle",
    logline: "Rotate and scale a small set of arrow vectors so one launched pulse lands exactly inside a guarded vault.",
    player: "Puzzle players who enjoy compact spatial reasoning, clean diagrams and satisfying single-solution reveals.",
    session: "45 seconds to 4 minutes per vault; a three-vault daily set targets a 6–10 minute return session.",
    input: "Tap a vector to select it; drag its handle to rotate; pinch or use accessible step buttons to change magnitude; tap Launch to simulate.",
    loop: ["Read the vault layout and destination", "Adjust direction and magnitude of limited vectors", "Preview the composed trajectory", "Launch the pulse", "Earn efficiency stars and open the next vault"],
    differentiator: "The path is built from visible vector addition rather than hidden physics, turning mathematical motion into a tactile lock-picking fantasy.",
    mvp: ["60 authored vaults across four mechanics", "Undo, restart, deterministic hint and color-independent vector labels", "Three-star efficiency score", "Daily seed drawn from a verified offline set", "Local progress and settings"],
    notMvp: ["User-authored levels", "Competitive leaderboards", "Real-money economy", "Cloud accounts", "Procedural levels without a solver proof"],
    expansion: "New vector operators, weekly vault packs, asynchronous efficiency challenges and a level editor only after solver coverage and retention evidence.",
    marketSignal: "Puzzle remained a relative bright spot in Q2 2026 research. Vector Vault tests whether an instantly readable trajectory screenshot can distinguish a logic title without borrowing a known puzzle's protected expression.",
    hypothesis: "A 12-second store preview showing adjust → launch → exact vault hit will communicate the payoff without narration and earn qualified installs from spatial-puzzle players.",
    comparables: "Vector-composition exercises, ricochet puzzles and one-screen route planners are mechanic references only; layouts, art, names and progression must be original.",
    acquisition: "A high-contrast before/after trajectory and the phrase “make every arrow add up.”",
    risks: ["The vector concept can feel educational or intimidating", "Precision dragging can fail on small screens", "Authored levels may be costly to balance"],
    mitigations: ["Teach through animation before terminology", "Provide coarse nudge controls and large handles", "Require an automated solver and difficulty telemetry for every level"],
    kill: "Revise or reject admission if five uncoached target users cannot explain the goal after the first interactive screen, or if the level solver cannot verify every MVP vault.",
    visual: {
      premise: "A dark museum-security blueprint crossed with luminous scientific notation.",
      palette: [["Vault Navy", "#0B1020"], ["Pulse Cyan", "#38E8FF"], ["Vector Gold", "#FFC857"], ["Lock Coral", "#FF5D73"], ["Paper White", "#F5F7FF"]],
      type: "Geometric sans for UI; tabular mono numerals for magnitude and angle; never rely on mathematical symbols alone.",
      ui: "Sparse instrument panel, thick selectable handles, numbered vectors and one dominant Launch control.",
      motion: "Vectors snap in 5° increments, trajectory previews draw left-to-right, exact hits compress then bloom.",
      icon: "A cyan arrow entering a gold keyhole on navy, with no text.",
      thumbnail: "One obvious zig-zag trajectory terminating in a glowing vault ring.",
      audio: "Dry mechanical ticks, a rising synthesized launch tone and a short resonant unlock chord.",
      accessibility: "Shape and number encode every color role; step buttons mirror gestures; reduced-motion mode draws the completed path without travel animation.",
    },
    mechanics: {
      score: "Base clear score minus vector moves and hints, plus exactness and par bonuses; time is informational, not punitive.",
      progression: "15-vault chapters introduce rotate, magnitude, locked vectors and one-way gates; mastery stars unlock optional challenge vaults.",
      difficulty: "Solver-derived minimum move count plus playtest error rate; introduce one variable at a time before combining operators.",
      win: "The deterministic composed path ends within the vault tolerance using the permitted launch count.",
      fail: "A launch hits a barrier, exits bounds or exhausts the vault's launch allowance; failure immediately permits undo/retry.",
      haptics: "Selection tick, boundary warning and one firm unlock pulse; fully disableable.",
      analytics: ["vault_start", "vector_adjust", "hint_used", "launch_result", "vault_complete", "session_end"],
      specialQa: ["Floating-point determinism across ARM64 and simulator", "Touch-handle separation at minimum supported viewport", "Solver minimum-move agreement", "Color-blind and reduced-motion paths"],
    },
    monetization: {
      model: "Free trial chapter plus one-time Full Vault purchase; no ads in the pilot candidate.",
      offers: ["Free: first 15 vaults and daily sampler", "Proposed one-time unlock: remaining 45 MVP vaults and future balance updates", "Future paid level packs only when content is complete and separately approved"],
      guardrails: "No lives, timers, randomized rewards, consumable hint sales or purchase prompts during a vault.",
    },
    store: {
      subtitle: "Make every arrow add up",
      keywords: "spatial logic,vector puzzle,trajectory,brain teaser,offline puzzle",
      shots: ["Adjust two numbered vectors", "Launch a clean composed path", "Unlock a gold vault", "Compare efficient solutions", "Use a shape-coded accessible theme"],
    },
  },
  {
    order: 2,
    name: "Bolt Bloom",
    slug: "bolt-bloom",
    status: "PRE-ADMISSION",
    genre: "mechanical sequence-and-sort puzzle",
    logline: "Unscrew colored fasteners in the right order so a folded metal sculpture opens into a living mechanical flower.",
    player: "Casual sort-puzzle players who want tactile cause-and-effect and a strong visual completion reward.",
    session: "30 seconds to 3 minutes per sculpture.",
    input: "Tap a reachable bolt, then tap a matching tray slot; long-press previews which panels it restrains.",
    loop: ["Inspect layered plates and bolt colors", "Choose a legally reachable bolt", "Place it into a limited matching tray", "Watch freed panels unfold", "Complete the bloom with spare tray space"],
    differentiator: "Every solved ordering visibly transforms cold sheet metal into an original kinetic flower, making the end state the product-page hook.",
    mvp: ["80 deterministic sculptures", "Four bolt colors plus symbol encoding", "Limited trays and one reversible undo", "Layer-preview accessibility mode", "Local chapter progression"],
    notMvp: ["Realistic branded hardware", "Physics-dependent outcomes", "Infinite generated levels", "Energy system", "Social competitions"],
    expansion: "New materials, garden collections, timed-free expert boards and seasonal cosmetic workbench themes.",
    marketSignal: "Current puzzle evidence supports testing visually legible, repeatable loops, but the crowded sort/unscrew field raises acquisition risk; the bloom transformation must prove distinct in store tests.",
    hypothesis: "A split-screen preview of a dense bolted plate unfolding into a flower can communicate both problem and reward within one second.",
    comparables: "Unscrew, obstruction-order and color-sort genres are demand references; all sculptures, tray rules and transformation choreography remain original.",
    acquisition: "A dramatic metal-to-flower reveal with the line “free the bloom.”",
    risks: ["Mechanic may look derivative in a crowded category", "Occlusion can make legal moves feel arbitrary", "Tray pressure can become frustrating"],
    mitigations: ["Lead with the transformation fantasy and original silhouettes", "Expose restrained layers on demand", "Guarantee solver-verified boards and a non-monetized recovery path"],
    kill: "Reject or substantially redesign if blinded store-creative tests cannot distinguish the concept from generic unscrew titles, or if legal moves cannot be explained by visible geometry.",
    visual: {
      premise: "Precision workshop miniatures that unfold into optimistic kinetic botany.",
      palette: [["Graphite", "#20242B"], ["Petal Pink", "#FF6F91"], ["Leaf Mint", "#4DE1A8"], ["Bolt Blue", "#4A8CFF"], ["Workshop Cream", "#FFF4DE"]],
      type: "Rounded industrial sans with stamped numeric labels.",
      ui: "Workbench tray along the thumb edge; bolts carry color, shape and numeral; restrained layers show subtle hinge traces.",
      motion: "Quarter-turn bolt pops, spring-soft panel unfolding and a restrained celebratory bloom rotation.",
      icon: "A pink mechanical petal held by one blue bolt on graphite.",
      thumbnail: "Half-closed metal plate becoming a bright six-petal bloom.",
      audio: "Ratchet clicks, light steel taps and marimba-like blossom notes.",
      accessibility: "Symbols duplicate bolt colors, layer-preview removes occlusion, animations can accelerate or be skipped.",
    },
    mechanics: {
      score: "Three petals for clear, no overflow recovery and par moves; no time penalty in the base campaign.",
      progression: "Flat plates → hinged layers → shared restraints → tray locks, in 20-level greenhouse chapters.",
      difficulty: "Solver branch factor and tray occupancy peak, calibrated with undo frequency.",
      win: "All required bolts are legally removed and every sculpture panel reaches its authored open state.",
      fail: "No legal tray placement remains; present rewind, restart and earned hint without an ad wall.",
      haptics: "Fine ratchet ticks and one soft bloom pulse.",
      analytics: ["sculpture_start", "bolt_selected", "tray_full", "rewind_used", "sculpture_complete"],
      specialQa: ["Solver proves at least one solution and par", "Occlusion layer hit testing", "Symbol distinction under grayscale", "No unsalvageable tray state after rewind"],
    },
    monetization: {
      model: "Free campaign with conservative rewarded hints and one-time ad removal; interstitials remain disabled until retention evidence and explicit approval.",
      offers: ["Optional rewarded hint only from a player-initiated help sheet", "One-time ad-removal plus permanent daily hint", "Cosmetic workbench skins as non-random purchases after launch evidence"],
      guardrails: "Never interrupt a sculpture, never sell tray capacity, never randomize rewards and never make failure the purchase trigger.",
    },
    store: { subtitle: "Unscrew. Unfold. Bloom.", keywords: "unscrew puzzle,sort puzzle,mechanical flower,offline brain game", shots: ["See a folded sculpture", "Choose a symbol-coded bolt", "Manage the thumb-side tray", "Watch panels unfold", "Complete a kinetic garden"] },
  },
  {
    order: 3,
    name: "Pocket Gravity",
    slug: "pocket-gravity",
    status: "PRE-ADMISSION",
    genre: "diorama gravity-routing puzzle",
    logline: "Place tiny gravity wells around a pocket-sized world, then release a courier and bend its path safely to the beacon.",
    player: "Physics-puzzle players drawn to toy-like spaces, experimentation and graceful near-misses.",
    session: "1–5 minutes per diorama.",
    input: "Drag limited gravity wells onto valid sockets, rotate directional wells, then hold Release to preview and let go to run.",
    loop: ["Survey hazards and beacon", "Place limited wells", "Preview the predicted arc", "Release the courier", "Refine placement or collect the beacon"],
    differentiator: "Players arrange gravity before motion rather than steering mid-flight, preserving a readable deterministic puzzle in a warm miniature world.",
    mvp: ["48 authored dioramas", "Attract, repel and directional wells", "Deterministic trajectory preview", "Optional collectible on each route", "Offline local progress"],
    notMvp: ["Free-form orbital simulation", "Procedural worlds", "Character upgrades", "Online leaderboards", "Narrative cutscenes"],
    expansion: "New planet materials, moving gates, weekly route challenges and cosmetic courier shells.",
    marketSignal: "Accessible short-session mechanics remain visible in 2026 download-growth analysis; Pocket Gravity tests whether a miniature-world visual can make a more deliberate physics puzzle store-readable.",
    hypothesis: "A preview that visibly curves around a hazard into a beacon will generate curiosity while still making the interaction understandable.",
    comparables: "Orbital, marble-route and pre-placement physics puzzles are genre references only; simulation parameters, worlds and art are original.",
    acquisition: "A tiny courier arcing around a thumb-sized planet with “place gravity, then let go.”",
    risks: ["Physics can vary by device or frame rate", "Predicted paths can clutter small screens", "Near misses may feel unfair"],
    mitigations: ["Use fixed-step deterministic simulation", "Offer simplified and high-contrast path previews", "Display collision radius and support immediate repositioning"],
    kill: "Do not admit if fixed-step replay hashes diverge across the device matrix or if trajectory preview cannot match release outcomes within the documented tolerance.",
    visual: {
      premise: "Hand-painted space dioramas assembled from enamel toys and soft cosmic light.",
      palette: [["Deep Space", "#11152F"], ["Comet Peach", "#FF9B71"], ["Well Violet", "#8B7CFF"], ["Beacon Lime", "#C8F560"], ["Starlight", "#F7F2E8"]],
      type: "Friendly humanist sans with large numerals and minimal copy.",
      ui: "Radial well tray, thick predicted arc and one press-and-release launch affordance.",
      motion: "Slow orbital idles, elastic well placement and a smooth fixed-speed courier trail.",
      icon: "A peach capsule curving around a violet gravity well.",
      thumbnail: "One luminous curved route threading two toy planets.",
      audio: "Soft synth plucks, airy orbit hum and a warm beacon chime.",
      accessibility: "High-contrast route option, motion-trail reduction, no tilt requirement and numeric well strength labels.",
    },
    mechanics: {
      score: "Beacon clear plus optional parcel and well-efficiency medals; no score for real-time reflex.",
      progression: "Static attractors → repellers → directional wells → timed gates, with simulation rules frozen per level version.",
      difficulty: "Required placements, trajectory sensitivity and hazard clearance measured by solver sampling.",
      win: "Courier reaches the beacon and comes to rest or exits through its capture volume.",
      fail: "Courier collides, exits bounds or times out; the exact initial setup remains for one-tap adjustment.",
      haptics: "Soft socket snap, low collision bump and beacon double pulse.",
      analytics: ["diorama_start", "well_placed", "preview_shown", "release_result", "parcel_collected", "diorama_complete"],
      specialQa: ["Cross-platform deterministic replay hashes", "Preview-to-outcome tolerance", "Thermal and frame-pacing run", "Collision at extreme aspect ratios"],
    },
    monetization: {
      model: "Paid download candidate with a free platform test build; final price is an owner decision after willingness-to-pay testing.",
      offers: ["One complete premium MVP with no ads", "Optional future authored world packs", "Cosmetic courier shells bundled with content, never loot boxes"],
      guardrails: "No consumables, no forced ads, no precision advantage and no paid well strength.",
    },
    store: { subtitle: "Bend a tiny universe", keywords: "gravity puzzle,physics puzzle,space diorama,offline game", shots: ["Place a violet gravity well", "Preview a curved route", "Thread a miniature hazard", "Collect the side parcel", "Reach the lime beacon"] },
  },
  {
    order: 4,
    name: "Chromalock",
    slug: "chromalock",
    status: "PRE-ADMISSION",
    genre: "color-and-symbol ring logic puzzle",
    logline: "Rotate nested stained-glass rings until overlapping windows mix into the exact symbol-and-color key that opens the lock.",
    player: "Pattern solvers who like color mixing, elegant symmetry and untimed deduction.",
    session: "45 seconds to 4 minutes per lock.",
    input: "Swipe a ring clockwise or counterclockwise; tap a ring for accessible one-step controls; long-press compares the target key.",
    loop: ["Study the target key", "Rotate one of two to four rings", "Observe overlap colors and aligned glyphs", "Lock matched segments", "Open the complete seal"],
    differentiator: "Color mixing and glyph alignment are equal parts of the key, so the puzzle stays playable without relying on hue perception alone.",
    mvp: ["72 handcrafted locks", "Two mixing models introduced separately", "Glyph/texture redundancy for every color", "Unlimited undo and target overlay", "Local streak-free progression"],
    notMvp: ["Daily pressure streaks", "Competitive timer", "User-generated locks", "Camera color input", "Randomized boosters"],
    expansion: "New glass families, mirrored rings, community-authored candidates after automated solvability checks and themed premium lockbooks.",
    marketSignal: "Puzzle's relative 2026 resilience supports a measured prototype, while Chromalock's accessible color-plus-symbol language supplies a store-visible identity rather than a claim of proven demand.",
    hypothesis: "A looping icon-to-gameplay animation of three rings snapping into a luminous seal will improve qualified store engagement over a static abstract grid.",
    comparables: "Ring rotation, color mixing and pattern-lock puzzles are mechanic references; exact key grammar and art must be independently authored.",
    acquisition: "A jewel-like lock visibly changing color as rings turn.",
    risks: ["Color mechanics can exclude color-vision-deficient players", "Abstract rings may appear decorative rather than playable", "Solutions may permit brute force"],
    mitigations: ["Pair color with texture and glyph from the first tutorial", "Show finger action in preview", "Measure solution-space ambiguity and provide deduction-focused par"],
    kill: "Reject if any essential state is ambiguous in monochrome screenshots or if authored locks lack solver-confirmed intended solution classes.",
    visual: {
      premise: "Stained glass, optical filters and precision watchmaking on a black velvet table.",
      palette: [["Velvet", "#15121B"], ["Cyan Glass", "#00C2D1"], ["Magenta Glass", "#E44DAD"], ["Amber Glass", "#F2B134"], ["Frost", "#F1F4F8"]],
      type: "High-legibility neo-grotesk; glyph legend uses generous tracking.",
      ui: "Concentric rings dominate; target key remains pinned; every hue carries a hatch or dot pattern.",
      motion: "Weighted watch-like rotation, refracted overlap shimmer and crisp locking detents.",
      icon: "Three cyan, magenta and amber ring segments forming a white keyhole.",
      thumbnail: "A nearly aligned luminous seal with one obvious mismatched wedge.",
      audio: "Glass taps, quiet detents and a harmonic chord assembled one note per matched segment.",
      accessibility: "Texture, glyph and text labels duplicate hue; high-contrast and monochrome themes; reduced shimmer.",
    },
    mechanics: {
      score: "Clear plus move-par and no-overlay medals; elapsed time never blocks progress.",
      progression: "Two rings → additive overlaps → subtractive lesson → locks and mirrored coupling.",
      difficulty: "State-space size, symmetric duplicates and required look-ahead from exhaustive solver output.",
      win: "All target segments match both glyph and mixed-color class.",
      fail: "No hard failure; invalid alignments give local feedback and undo remains available.",
      haptics: "Detent tick and segment-lock pulse.",
      analytics: ["lock_start", "ring_rotated", "target_opened", "segment_locked", "lock_complete"],
      specialQa: ["Monochrome completion path", "Exhaustive solution count", "Ring gesture conflicts", "Color-space rendering snapshots"],
    },
    monetization: {
      model: "Free first lockbook with a one-time complete-edition unlock.",
      offers: ["24-lock free book", "One-time unlock for all launch books", "Future premium lockbooks as transparent fixed-price content"],
      guardrails: "No ads in puzzle flow, no randomized palette sales and no paid undo or target access.",
    },
    store: { subtitle: "Turn color into the key", keywords: "color puzzle,ring puzzle,pattern logic,offline brain game", shots: ["Compare the target glyph", "Rotate nested glass rings", "Mix hue plus texture", "Lock matching segments", "Open the complete seal"] },
  },
  {
    order: 5,
    name: "Tiny Foundry",
    slug: "tiny-foundry",
    status: "PRE-ADMISSION",
    genre: "compact factory-routing puzzle",
    logline: "Fit a miniature production line onto a pocket board and route raw cubes through machines to fulfill an exact order.",
    player: "Optimization players who like automation systems but want a complete problem in a short session.",
    session: "2–7 minutes per contract.",
    input: "Drag machines onto grid cells, rotate with a tap, connect adjacent ports and press Run to simulate one deterministic batch.",
    loop: ["Read the order and board constraints", "Place and rotate limited machines", "Connect material flow", "Run the deterministic batch", "Refine throughput and fulfill the contract"],
    differentiator: "It compresses the satisfaction of a factory chain into authored one-screen contracts without idle timers or sprawling management UI.",
    mvp: ["40 contracts", "Cutter, painter, combiner, splitter and packer", "Step-through simulation and bottleneck highlight", "Three efficiency medals", "Versioned local progress"],
    notMvp: ["Idle earnings", "Persistent online economy", "Unlimited sandbox", "Worker characters", "Real-time production timers"],
    expansion: "New machine packs, weekly optimization contracts, a solver-gated sandbox and shareable layout seeds.",
    marketSignal: "The mature market rewards retention and differentiated quality; Tiny Foundry deliberately narrows a systems fantasy into a lower-burden puzzle whose comprehension must be validated before admission.",
    hypothesis: "A 10-second preview showing raw cube → cutter → painter → packed toy makes a complex automation fantasy immediately legible.",
    comparables: "Factory automation, pipe routing and space-optimization puzzles are system references, not level or art references.",
    acquisition: "A tiny board visibly turning one gray cube into a bright packed rocket.",
    risks: ["Factory notation can overwhelm casual players", "Simulation errors may feel opaque", "The board can become visually dense"],
    mitigations: ["Introduce one machine per contract set", "Step-through mode traces each item", "Cap MVP board size and use high-contrast port shapes"],
    kill: "Do not admit if uncoached testers cannot predict the first two-machine output or if the reference simulator and game simulation disagree on any contract fixture.",
    visual: {
      premise: "A cheerful desktop micro-factory built from painted tin toys and graph paper.",
      palette: [["Ink", "#263238"], ["Machine Orange", "#FF8A3D"], ["Conveyor Teal", "#17BEBB"], ["Order Yellow", "#FFD166"], ["Paper", "#F7F3E8"]],
      type: "Friendly technical sans with tabular counts and pictographic machine labels.",
      ui: "One grid, bottom machine belt and an order card; ports use unique shapes as well as color.",
      motion: "Clockwork part movement at a readable cadence, paused step mode and small completion stamp.",
      icon: "An orange press turning a gray cube into a teal star.",
      thumbnail: "A three-machine line feeding one boxed object.",
      audio: "Toy motor hum, wooden clicks and a compact shift-complete whistle.",
      accessibility: "Speed control, full pause/step, shape-coded materials and no information conveyed by motion alone.",
    },
    mechanics: {
      score: "Contract clear plus footprint, machine-count and cycle medals; players may continue after first valid output.",
      progression: "Single transform → chained transforms → branching → combining → throughput constraints.",
      difficulty: "Reference solver evaluates minimum machines, occupied cells and cycle count.",
      win: "The simulated batch produces the required item counts with no wrong output.",
      fail: "Jam, wrong product or exhausted batch; simulation stops with the first causal path highlighted.",
      haptics: "Grid snap, machine stamp and jam warning.",
      analytics: ["contract_start", "machine_placed", "simulation_run", "jam_detected", "contract_complete"],
      specialQa: ["Reference-simulator parity", "Cycle and deadlock detection", "Port-shape readability", "Save migration of layouts"],
    },
    monetization: {
      model: "Premium complete game candidate with fixed-price expansion contract packs.",
      offers: ["One paid base game with all 40 contracts", "Future themed contract packs with disclosed counts", "No ads or consumable efficiency tools"],
      guardrails: "Never monetize simulation speed, undo, machine capacity or idle time.",
    },
    store: { subtitle: "A whole factory in one screen", keywords: "factory puzzle,automation game,logic routing,offline strategy", shots: ["Read a tiny order card", "Place shape-coded machines", "Trace a material path", "Find a highlighted bottleneck", "Earn a compact efficiency stamp"] },
  },
  {
    order: 6,
    name: "Letter Loom",
    slug: "letter-loom",
    status: "PRE-ADMISSION",
    genre: "word-weaving grid puzzle",
    logline: "Weave words across horizontal warp threads and vertical weft threads so shared letters complete a patterned textile.",
    player: "Word-puzzle players seeking calm, finite daily play and satisfying cross-letter deductions.",
    session: "2–8 minutes per weave.",
    input: "Drag a word spool onto a row or column; tap to reverse; use accessible arrow controls to place without dragging.",
    loop: ["Review word spools and textile clues", "Place a word on a row or column", "Use crossings to confirm shared letters", "Reposition conflicting spools", "Complete the woven motif"],
    differentiator: "Every crossword-style intersection is expressed as visible warp/weft weaving, with authored word sets rather than an opaque dictionary scramble.",
    mvp: ["120 authored English weaves", "Four grid sizes", "Definition and category clue modes", "Offline daily archive", "Validated answer lexicon and local progress"],
    notMvp: ["Open dictionary generation", "Competitive spelling", "Chat", "Unreviewed AI clues", "Multiple languages before editorial workflow"],
    expansion: "Curated theme books, localization with native editorial review, accessibility fonts and a solver-validated creator pipeline.",
    marketSignal: "Puzzle remains comparatively resilient, but word content brings editorial and localization cost. Admission depends on proving the weaving metaphor improves discovery and comprehension.",
    hypothesis: "An icon and first screenshot showing two word ribbons interlacing at a shared letter can separate the title from generic letter grids.",
    comparables: "Crossword crossings, word placement and category grouping are genre references; word sets, clues, grids and textile expression must be original.",
    acquisition: "Two readable word ribbons crossing to reveal a bright woven motif.",
    risks: ["English-only content limits reach", "Ambiguous words or clues damage trust", "Text can be inaccessible at small sizes"],
    mitigations: ["Treat localization as separate reviewed content", "Require editorial source and solver validation", "Set minimum type size and support dyslexia-friendly option"],
    kill: "Do not admit beyond English MVP if native editorial review is unavailable; reject any generated weave with multiple unintended solutions or untraceable clue provenance.",
    visual: {
      premise: "Modern fiber art: paper word ribbons weaving into bold geometric textiles.",
      palette: [["Loom Indigo", "#302B63"], ["Thread Coral", "#FF6B6B"], ["Thread Aqua", "#4ECDC4"], ["Sun Thread", "#FFE66D"], ["Canvas", "#FFF9EC"]],
      type: "Large humanist serif for letters with a high-legibility sans UI option and dyslexia-friendly alternate.",
      ui: "Word spools surround a centered loom; crossings enlarge on focus; clues never depend on decorative script.",
      motion: "Ribbons slide under/over with gentle depth; reduced mode uses instant layer changes.",
      icon: "Coral and aqua word ribbons crossing at one gold letter.",
      thumbnail: "A nearly complete woven square with two readable crossing words.",
      audio: "Soft shuttle taps, fiber swishes and a warm plucked-string cadence.",
      accessibility: "Scalable type, screen-reader word/spell controls, contrast themes and no timed base mode.",
    },
    mechanics: {
      score: "Completion, no-hint and clean-placement badges; streaks never gate content.",
      progression: "3×3 placement → longer crossings → category clues → decoy spool sets.",
      difficulty: "Crossing density, clue obscurity and solver branch count, editorially reviewed.",
      win: "Every required row/column word matches its crossings and clue set.",
      fail: "No terminal failure; conflicts are shown locally and all moves remain reversible.",
      haptics: "Crossing snap and motif-complete pulse.",
      analytics: ["weave_start", "spool_placed", "crossing_conflict", "clue_opened", "weave_complete"],
      specialQa: ["Unique-solution solver", "Dictionary/editorial allowlist", "Dynamic type at minimum viewport", "Screen-reader spelling flow"],
    },
    monetization: {
      model: "Free rotating sampler plus fixed-price theme books; no advertising in the reading surface.",
      offers: ["Free starter and rotating daily weave", "Clearly counted premium theme books", "Complete-edition bundle after enough reviewed content exists"],
      guardrails: "No paid letters, streak repair, randomized hints or subscription until recurring editorial value is proven.",
    },
    store: { subtitle: "Words cross. Patterns emerge.", keywords: "word puzzle,crossword,word grid,offline words,daily puzzle", shots: ["Choose an authored word spool", "Cross words at a shared letter", "Resolve a visible conflict", "Reveal a woven motif", "Use large-type clue mode"] },
  },
  {
    order: 7,
    name: "Pulse Path",
    slug: "pulse-path",
    status: "PRE-ADMISSION",
    genre: "one-touch rhythm-routing arcade puzzle",
    logline: "Tap at junctions in time with a traveling pulse to switch its route, chain beats and light an entire circuit.",
    player: "Players who enjoy rhythm feedback but prefer one-thumb pattern learning over music-game complexity.",
    session: "20–90 seconds per circuit; 3–6 minute chapter sessions.",
    input: "Tap anywhere on each approach beat to toggle the highlighted junction; optional visual-only timing and wider timing windows.",
    loop: ["Preview the circuit rhythm", "Follow the moving pulse", "Tap to switch upcoming junctions", "Chain correctly timed branches", "Light every endpoint and improve the timing grade"],
    differentiator: "Routing choices and rhythm timing share one tap, producing a readable circuit puzzle that remains playable without licensed music.",
    mvp: ["50 authored circuits", "Original adaptive music stems", "Three timing-window presets", "Visual and haptic metronome modes", "Offline score history"],
    notMvp: ["Licensed songs", "Online battles", "User audio import", "Endless ad-funded continues", "Mandatory vibration"],
    expansion: "New original soundtrack packs, daily seeded circuit set and accessibility-first practice tools.",
    marketSignal: "Simple, repeatable loops remain a download-growth trait in 2026 analysis, but rhythm can narrow audience. Pulse Path tests whether strong audiovisual clarity can broaden the mechanic.",
    hypothesis: "A preview with one finger tap redirecting a neon pulse exactly on a beat can explain the entire fantasy before audio is enabled.",
    comparables: "Rhythm timing, rail switching and circuit routing are mechanic references; music, charts and layouts must be original.",
    acquisition: "One neon pulse hits a junction, branches on beat and lights a whole circuit.",
    risks: ["Audio latency differs across devices", "Rhythm mechanics can exclude hearing-impaired players", "One mistake may feel too punishing"],
    mitigations: ["Calibrate and record device latency", "Offer visual/haptic beat channels", "Practice mode and recoverable chains preserve learning"],
    kill: "Do not admit if timing calibration cannot produce consistent grades on the target device matrix or if visual-only mode cannot support a full clear.",
    visual: {
      premise: "Night-city transit diagrams animated as living musical circuitry.",
      palette: [["Night", "#090B1A"], ["Pulse Electric", "#00F5D4"], ["Beat Violet", "#9B5DE5"], ["Alert Pink", "#F15BB5"], ["Signal White", "#F8F9FA"]],
      type: "Wide geometric sans with large grade numerals.",
      ui: "Circuit fills the screen; next junction halos in advance; pause/calibration always reachable.",
      motion: "Constant-speed pulse, beat-synced expansion and restrained endpoint cascade.",
      icon: "An electric teal pulse branching through a violet junction on black.",
      thumbnail: "One glowing circuit with three endpoints lighting in sequence.",
      audio: "Original percussive synth stems that add layers as endpoints light; no licensed samples.",
      accessibility: "Visual metronome, haptic metronome, latency calibration, reduced flash and adjustable windows.",
    },
    mechanics: {
      score: "Route completion plus timing accuracy and uninterrupted endpoint chain; practice clears progression without leaderboard grade.",
      progression: "Single switch → alternating routes → hold junctions → syncopation → multi-endpoint circuits.",
      difficulty: "BPM, junction density, decision lead time and syncopation, never visual clutter alone.",
      win: "All authored endpoints receive the pulse in required order before the circuit sequence ends.",
      fail: "Pulse reaches a dead end or required endpoint window expires; restart is immediate and practice can continue from a phrase checkpoint.",
      haptics: "Optional beat tick and stronger junction confirmation, calibrated independently from audio.",
      analytics: ["circuit_start", "junction_tap", "timing_grade", "route_miss", "calibration_changed", "circuit_complete"],
      specialQa: ["Audio/visual/haptic latency matrix", "Visual-only full completion", "Photosensitivity flash budget", "Pause/resume beat resynchronization"],
    },
    monetization: {
      model: "Free core circuits plus fixed-price original soundtrack/circuit packs and a complete bundle.",
      offers: ["Free 15-circuit core set", "Theme packs containing disclosed circuits and original stems", "Complete bundle; soundtrack download only if rights and delivery are approved"],
      guardrails: "No ads during rhythm play, no paid timing advantage, no licensed music assumptions and no consumable continues.",
    },
    store: { subtitle: "Route the beat with one tap", keywords: "rhythm game,circuit puzzle,one touch,offline music game", shots: ["See the next junction halo", "Tap on the approach beat", "Redirect the neon pulse", "Light every endpoint", "Choose visual-only timing"] },
  },
  {
    order: 8,
    name: "Shelf Shift",
    slug: "shelf-shift",
    status: "PRE-ADMISSION",
    genre: "sliding shelf organization puzzle",
    logline: "Slide whole shelf rows and lift one object at a time to assemble tidy themed displays under tight move limits.",
    player: "Casual organization-puzzle players who enjoy visible order, collections and low-pressure spatial planning.",
    session: "45 seconds to 4 minutes per display.",
    input: "Swipe a shelf row left/right; tap one front object to lift it into the single staging hook; accessible arrow buttons mirror swipes.",
    loop: ["Read the target display silhouette", "Shift rows to expose objects", "Use the one-item staging hook", "Group each themed set", "Complete the tidy display within par"],
    differentiator: "The player moves shelves as systems, not arbitrary individual pieces, creating a predictable sliding puzzle with an organization payoff.",
    mvp: ["90 authored displays", "Three shelf widths", "One staging hook", "Silhouette target and high-contrast object labels", "Local room progression"],
    notMvp: ["Real product brands", "Home-decoration shop", "Energy timer", "Random object gacha", "Photo scanning"],
    expansion: "Seasonal rooms using original objects, daily compact displays and optional cosmetic room themes.",
    marketSignal: "Accessible short loops and clear transformation creatives fit current download-growth observations; admission still depends on proving the row-shift rule is distinctive and not confused with generic sorting.",
    hypothesis: "A cluttered-to-tidy shelf transformation with one obvious row swipe can communicate both control and reward in a silent preview.",
    comparables: "Sliding-block, organization and set-collection mechanics are genre references; objects, layouts and room art remain original.",
    acquisition: "One swipe turns a cluttered shelf into three perfect themed sets.",
    risks: ["Organization fantasy may imply copied real products", "Objects can be hard to recognize", "Move limits can undermine a relaxing tone"],
    mitigations: ["Use original abstract object families", "Strong silhouettes and text labels", "Par is optional mastery; completion is never blocked by move count"],
    kill: "Reject any art pipeline that depends on branded likenesses, and redesign if object silhouettes fail recognition tests at store-thumbnail size.",
    visual: {
      premise: "A bright editorial still life made from original ceramic, paper and wooden objects.",
      palette: [["Shelf Walnut", "#6B4F3A"], ["Ceramic Sky", "#6EC5E9"], ["Paper Apricot", "#FFB38A"], ["Plant Green", "#67B26F"], ["Wall Linen", "#FAF2E7"]],
      type: "Soft editorial sans with clear object-family labels.",
      ui: "Shelf is full bleed; target silhouette floats above; staging hook remains a distinct side pocket.",
      motion: "Rows glide with physical easing, objects hop gently, completion settles rather than explodes.",
      icon: "Three original objects snapping into a perfectly aligned shelf.",
      thumbnail: "Half-cluttered, half-tidy shelf with a visible swipe arrow.",
      audio: "Wood slides, ceramic taps and a quiet room-complete brush chord.",
      accessibility: "Object labels and shapes duplicate color, controls have button alternatives, no timed requirement.",
    },
    mechanics: {
      score: "Completion plus par-move and no-hint ribbons; excess moves never prevent progress.",
      progression: "Single row → linked rows → staging hook → blockers → multi-family target patterns.",
      difficulty: "Solver minimum moves, blocker depth and staging-hook dependency.",
      win: "Every target set occupies its required contiguous shelf positions.",
      fail: "No terminal failure; detect repeated state and offer undo, hint or restart.",
      haptics: "Row-end stop, hook placement and tidy-set confirmation.",
      analytics: ["display_start", "row_shift", "hook_used", "repeat_state", "display_complete"],
      specialQa: ["Unique original asset audit", "Thumbnail silhouette recognition", "Solver par verification", "Gesture/button equivalence"],
    },
    monetization: {
      model: "Free starter room plus fixed-price room packs and one-time complete edition; no gameplay ads in MVP.",
      offers: ["30-display free room", "Transparent room packs with 30 displays", "Complete-edition bundle and optional original wallpaper cosmetics"],
      guardrails: "No randomized objects, inventory pressure, branded goods, paid staging slots or forced interstitials.",
    },
    store: { subtitle: "Slide clutter into calm", keywords: "sorting puzzle,organizing game,sliding puzzle,offline relaxing", shots: ["See the target silhouette", "Swipe an entire shelf row", "Use the staging hook", "Group original object families", "Finish a calm tidy room"] },
  },
  {
    order: 9,
    name: "Wobble Works",
    slug: "wobble-works",
    status: "PRE-ADMISSION",
    genre: "balance-and-build physics puzzle",
    logline: "Place odd workshop parts onto a swaying platform and keep the contraption balanced until its tiny motor completes a job.",
    player: "Physics-toy players who enjoy expressive failures, short retries and constructive experimentation.",
    session: "30 seconds to 3 minutes per job.",
    input: "Drag a part above the platform, rotate with two accessible buttons, release to place, then tap Start Motor.",
    loop: ["Read the required parts and job", "Plan weight distribution", "Place and rotate parts", "Run a short deterministic stability test", "Hold balance long enough to complete the job"],
    differentiator: "Success is not just stacking high: each original contraption must remain balanced while a visible machine performs a useful miniature job.",
    mvp: ["50 authored jobs", "Eight shape/weight families", "Deterministic fixed-step physics", "Center-of-mass learning overlay", "Instant retry and ghost of last setup"],
    notMvp: ["Destructible environments", "Online level sharing", "Ragdoll characters", "Real-world branded tools", "Random parts economy"],
    expansion: "New workshop stations, expert constraints, daily fixed-part challenge and cosmetic material sets.",
    marketSignal: "Simple, intuitive and repeatable loops feature in current growth analysis, but physics quality and store differentiation must be proved on device.",
    hypothesis: "A contraption wobbling dramatically, stabilizing and stamping one tiny box provides an immediately understandable near-fail/payoff loop.",
    comparables: "Balance, stacking and construction physics are mechanic references; jobs, part sets, shapes and visual identity are original.",
    acquisition: "An absurd but stable machine wobbling over a clearly marked balance line.",
    risks: ["Cross-platform physics divergence", "Failure can seem random", "Chaotic motion may hurt performance or comfort"],
    mitigations: ["Fixed-step replay fixtures", "Center-of-mass and force overlays", "Strict body count, sleep rules and reduced-motion camera"],
    kill: "Do not admit if replay hashes diverge or if five repeated runs of an unchanged setup produce different pass/fail outcomes on any target device.",
    visual: {
      premise: "A handmade invention bench combining painted wood, rubber, brass and graph-paper plans.",
      palette: [["Bench Blue", "#274C77"], ["Rubber Red", "#EF476F"], ["Brass", "#E9C46A"], ["Motor Mint", "#52B788"], ["Blueprint White", "#F1FAEE"]],
      type: "Bold workshop sans with stencil-like weight numerals.",
      ui: "Platform and balance meter centered; required parts appear as large silhouette cards.",
      motion: "Readable soft-body-like squash is visual only; physics bodies remain simple and deterministic.",
      icon: "A red wheel and brass block balanced on a blue plank.",
      thumbnail: "A visibly tilted contraption moments before a tiny stamp lands.",
      audio: "Wood clacks, rubber squeaks, small motor buzz and a relieved completion bell.",
      accessibility: "Static balance vector overlay, camera shake off, slow simulation option and shape/weight labels.",
    },
    mechanics: {
      score: "Job clear plus material count, stability margin and no-fall badges; speed is not scored.",
      progression: "Static balance → motor vibration → moving payload → narrow platform → asymmetric required parts.",
      difficulty: "Center-of-mass margin, contact count and disturbance profile from simulation fixtures.",
      win: "Required parts remain on the platform and stability stays within tolerance through the complete job timer.",
      fail: "A required part falls, tilt exceeds safety angle or motor stalls; return instantly to unchanged placement.",
      haptics: "Placement tap, increasing tilt warning and completion thump.",
      analytics: ["job_start", "part_placed", "motor_started", "tilt_failure", "job_complete"],
      specialQa: ["Cross-platform replay hashes", "Unchanged-setup repeatability", "Body-count performance", "Reduced motion and slow simulation"],
    },
    monetization: {
      model: "Free first bench with optional rewarded cosmetic blueprint and one-time full-workshop unlock.",
      offers: ["15 free jobs", "One-time unlock for all launch benches", "Optional player-initiated rewarded ad for a cosmetic blueprint only if policy and consent gates pass"],
      guardrails: "No paid stabilizers, retries, lighter parts, forced ads or randomized tool crates.",
    },
    store: { subtitle: "Build it. Wobble. Make it work.", keywords: "physics puzzle,balance game,building game,offline puzzle", shots: ["Choose required odd parts", "Place around the balance line", "Start a tiny motor", "Watch the platform wobble", "Complete the workshop job"] },
  },
  {
    order: 10,
    name: "Signal Grid",
    slug: "signal-grid",
    status: "PRE-ADMISSION",
    genre: "network deduction puzzle",
    logline: "Rotate antenna tiles and assign limited frequencies so every station connects without crossing or interference.",
    player: "Logic-grid players who enjoy deterministic deduction, quiet concentration and elegant network completion.",
    session: "2–8 minutes per grid.",
    input: "Tap to rotate a tile, long-press to cycle its frequency, and use accessible contextual buttons for both actions.",
    loop: ["Read station requirements and interference zones", "Rotate network tiles", "Assign limited frequencies", "Trace live signal coverage", "Connect all stations with zero interference"],
    differentiator: "Connectivity and frequency coloring create two linked, fully visible constraints without simulating real radio engineering.",
    mvp: ["75 authored grids", "Three frequency symbols", "Relay, splitter and shield tiles", "Deterministic contradiction hint", "Offline progress and notes mode"],
    notMvp: ["Real radio frequencies", "Location or network scanning", "Multiplayer", "Procedural daily grids without uniqueness proof", "Competitive timers"],
    expansion: "Larger grids, weekly solver-verified challenge, theme packs and a creator pipeline gated by uniqueness checks.",
    marketSignal: "Puzzle's relative 2026 strength justifies a prototype, not a forecast. Signal Grid's admission case depends on a distinctive network screenshot and tutorial completion evidence.",
    hypothesis: "A dark grid that lights from one transmitter through a clean, symbol-coded network can communicate the satisfaction of a solved logic system.",
    comparables: "Pipe connection, network rotation and graph-coloring puzzles are mechanic references; grid grammar, levels, terms and art remain original.",
    acquisition: "One tap lights an entire interference-free signal network.",
    risks: ["Two constraint layers may overload onboarding", "Frequency colors can exclude users", "Technical theme may feel dry"],
    mitigations: ["Teach connectivity before frequency", "Use waveform symbols and labels", "Give stations distinct personalities through animation without adding narrative burden"],
    kill: "Do not admit if the tutorial cannot teach connectivity and frequency in separate observable steps, or if any MVP grid lacks solver-proven uniqueness.",
    visual: {
      premise: "A midnight cartography table where radio waves draw luminous geometric maps.",
      palette: [["Grid Black", "#0A0F14"], ["Signal Green", "#5CFF9D"], ["Frequency Blue", "#4CC9F0"], ["Frequency Violet", "#B07CFF"], ["Station Amber", "#FFCA58"]],
      type: "Technical humanist sans with mono coordinate labels.",
      ui: "Grid first; connectivity uses line shape, frequency uses waveform symbol and hue; contradictions have text explanations.",
      motion: "Signals propagate in one calm sweep; interference pulses locally with reduced-flash alternative.",
      icon: "A green signal branching across three black grid cells into an amber station.",
      thumbnail: "Half-dark grid becoming one clean luminous network.",
      audio: "Shortwave-inspired original tones, soft relay ticks and a resolved station chord.",
      accessibility: "Waveform symbols duplicate color, notes mode, full keyboard/switch path and reduced-flash propagation.",
    },
    mechanics: {
      score: "Clear plus no-hint and rotation-par badges; notes and accessibility features never reduce score.",
      progression: "Connectivity → branches → limited frequencies → interference zones → shields and relays.",
      difficulty: "Solver branch count, constraint propagation depth and number of frequency conflicts.",
      win: "Every required station has one valid transmitter path and no adjacent/intersecting interference violation.",
      fail: "No terminal failure; contradictions are localized and moves remain undoable.",
      haptics: "Tile detent, interference warning and network-complete sweep.",
      analytics: ["grid_start", "tile_rotated", "frequency_changed", "contradiction_seen", "hint_used", "grid_complete"],
      specialQa: ["Unique-solution solver", "Symbol-only frequency path", "Contradiction explanation fixtures", "Large-grid memory and frame budget"],
    },
    monetization: {
      model: "Premium base game or free starter plus one-time unlock; choose only after price and conversion tests, with no ads in logic play.",
      offers: ["Proposed 20-grid starter", "One-time full-grid archive unlock", "Future fixed-price, solver-verified signal books"],
      guardrails: "No paid frequency capacity, randomized hints, time pressure, data scanning or subscription without proven recurring value.",
    },
    store: { subtitle: "Connect every station. Clear every signal.", keywords: "logic grid,network puzzle,connect puzzle,offline brain game", shots: ["Rotate a network tile", "Assign waveform-coded frequency", "Spot a local interference conflict", "Trace the live path", "Light every station"] },
  },
];

export const GAME_PORTFOLIO_SPECS = Object.freeze(games.map((game) => Object.freeze(game)));

const bullets = (items) => items.map((item) => `- ${item}`).join("\n");
const numbered = (items) => items.map((item, index) => `${index + 1}. ${item}`).join("\n");
const field = (label, value) => `- **${label}:** ${value}`;

function header(game, artifact, purpose) {
  return `# ${game.name} — ${artifact}\n\n` +
    `> **Package status:** ${game.status}  \n` +
    `> **Publisher:** ${PORTFOLIO_PUBLISHER}  \n` +
    `> **Prepared:** ${PORTFOLIO_PACKAGE_DATE}  \n` +
    `> **Evidence rule:** This is a proposed specification. No product, legal, store, playtest, release or production approval is recorded.\n\n` +
    `${purpose}\n`;
}

function sources(ids = MARKET_RESEARCH_SOURCES.map((source) => source.id)) {
  return ids.map((id) => {
    const source = MARKET_RESEARCH_SOURCES.find((candidate) => candidate.id === id);
    return `- [${source.title}](${source.url}) — ${source.organization}. ${source.note}`;
  }).join("\n");
}

function renderBrief(game) {
  return header(game, "Game Brief", "A bounded product hypothesis for portfolio admission; it does not authorize implementation.") + `
## Plain-language concept

${game.logline}

${field("Genre", game.genre)}
${field("Target player", game.player)}
${field("Target session", game.session)}
${field("Primary interaction", game.input)}

## Core loop

${numbered(game.loop)}

## Why it is different

${game.differentiator}

## MVP boundary

### Included

${bullets(game.mvp)}

### Explicitly excluded

${bullets(game.notMvp)}

## Expansion path

${game.expansion}

## Admission decision

${game.name === "Vector Vault" ? "Vector Vault is the provisional pilot candidate." : `${game.name} remains a later portfolio candidate.`} It is still pre-admission. Specification approval, visual-system approval, toolchain capability, workspace assignment and a measured prototype gate remain outstanding.
`;
}

function renderMarket(game) {
  return header(game, "Market Case", "Current evidence and a falsifiable concept-specific thesis; market evidence is not a revenue promise.") + `
## Evidence snapshot as of ${PORTFOLIO_PACKAGE_DATE}

Sensor Tower's 2026 report describes a mature mobile-game market: approximately $82B in 2025 mobile IAP revenue, but only modest growth. Its Q2 2026 index identifies Puzzle as a relative bright spot. A separate March 2026 analysis highlights simple, intuitive, short and repeatable formats among download-growth examples. These signals justify disciplined prototype testing; they do **not** validate this game, its pricing, retention or unit economics.

## Concept-specific thesis

${game.marketSignal}

**Testable acquisition hypothesis:** ${game.hypothesis}

**Comparable genres/mechanics:** ${game.comparables}

**Store-page hook:** ${game.acquisition}

## Risks and mitigations

| Risk | Planned mitigation |
|---|---|
${game.risks.map((risk, i) => `| ${risk} | ${game.mitigations[i]} |`).join("\n")}

## Pre-admission evidence plan

1. Run an originality/name/trademark screen before public branding; this package is not legal clearance.
2. Test a silent 12-second animatic and icon at phone size with target players; record comprehension, appeal and confusion, not compliments.
3. Build only the smallest interaction prototype after specification and visual approvals.
4. Measure first-screen goal comprehension, tutorial completion, first-session completion and day-return intent in a bounded test cohort.
5. After a distributable build exists, use Apple Product Page Optimization and Google Play listing experiments where account eligibility and traffic allow; change one creative variable per test.

## Kill/revise criterion

${game.kill}

## Sources

${sources()}
`;
}

function renderRoadmap(game) {
  return header(game, "Release Roadmap", "A gate-based sequence with no promised dates and no implied admission.") + `
## Phase 0 — Admission

- Reconcile all 11 specification artifacts and two-copy status.
- Run name/originality review and the market-comprehension test in **01_MARKET_CASE.md**.
- Obtain durable owner decisions for specification and visual system.
- Confirm toolchain capability, target device matrix and an isolated workspace.
- **Exit:** recorded approvals and evidence only; silence is not approval.

## Phase 1 — Vertical slice

- Implement one tutorial and three representative ${game.genre} challenges.
- Use placeholder/original generated assets that satisfy provenance rules.
- Add deterministic replay fixtures, save skeleton and the first analytics contract.
- **Exit:** core loop launches, is understandable, and passes concept-specific fixtures.

## Phase 2 — MVP content

${bullets(game.mvp.map((item) => `Deliver and validate: ${item}`))}

- **Exit:** content manifest complete, automated solver/reference checks pass, and no critical accessibility path is missing.

## Phase 3 — Integration and automated QA

- Integrate consent/configuration, analytics, crash reporting and the approved monetization adapter behind test doubles.
- Run unit, fixture, launch, crash, persistence, viewport, performance, offline, privacy and store-readiness suites.
- Repair failures and repeat the affected suite plus regression set.
- **Exit:** immutable build has complete required QA evidence. Failed suites cannot be waived by a generated report.

## Phase 4 — Owner playtest and revision

- Present the exact build, known issues and plain-language test summary.
- Capture revisions as versioned requests; re-enter the appropriate lifecycle state.
- **Exit:** owner playtest approval bound to the exact build hash.

## Phase 5 — Release candidate

- Produce signed-test artifacts through the approved worker/keychain path; the control plane stores references and hashes only.
- Generate screenshots from verified game states and draft metadata/declarations.
- Re-run full QA on the release configuration.
- **Exit:** release-candidate, QA, legal/privacy and provenance evidence are current for one immutable build.

## Phase 6 — Store preparation and launch

- Complete publisher-only identity, agreements, banking/tax, rating, privacy, encryption and signing steps.
- Stage Google Play testing and Apple TestFlight before production.
- Require explicit store-submission and production-release approvals.
- **Exit:** store APIs confirm accepted/released state; preparation alone never becomes **DEPLOYED**.

## Phase 7 — Early operations

- Monitor crash/ANR, slow-session, store feedback, funnel and monetization integrity.
- Roll back or halt acquisition on release-blocking regressions.
- Prioritize the first update from observed evidence, not roadmap inertia.
`;
}

function renderWorkflow(game) {
  return header(game, "Build Workflow", "The factory/local-worker contract for producing this game after admission.") + `
## Responsibility map

| Role | Bounded responsibility | Evidence returned |
|---|---|---|
| Supervising AI | Plan next task, choose capability, enforce gates, reconcile state | Task decision, acceptance criteria, validation result |
| Product-planning capability | Maintain brief, level/content rules and acceptance fixtures | Versioned artifact patch and rationale |
| Gameplay-engineering capability | Implement one isolated task in the attached workspace | Commit/build identifiers, tests and checkpoint |
| Visual-design capability | Generate original, reproducible assets from approved visual tokens | Source recipe, license/provenance record and export manifest |
| QA capability | Run independent fixtures and device/emulator suites | Structured test results with logs and hashes |
| Release-coordination capability | Draft metadata and stage approved release operations | Release record and human-action checklist |

No model name is part of the game contract. The orchestrator selects an available capability on the explicitly configured worker; it must not silently fall back to an arbitrary machine.

## Production sequence

${numbered([
  "Load durable project state, artifact versions, approvals and last checkpoint.",
  `Translate the next ${game.genre} acceptance criterion into one bounded task.`,
  "Dispatch with workspace, branch, input hashes, allowed tools, timeout and safe-cancel boundary.",
  "Persist worker-run ID before waiting; heartbeat and reattach after restarts.",
  "Collect result into quarantine, verify hashes and scan for unexpected files/secrets.",
  "Run independent acceptance fixtures and code/art review.",
  "Accept and checkpoint, or reject with a minimal repair task and unchanged lifecycle state.",
  "Mirror changed persistent artifacts and verify both required copy records.",
  "Advance only when durable evidence satisfies the lifecycle gate.",
])}

## Game-specific validation focus

${bullets(game.mechanics.specialQa)}

## Checkpoint contract

Every safe checkpoint records lifecycle state, task ID/attempt, workspace and branch, commit/build hash if present, input/output artifact hashes, test-run IDs, decision summary, open errors, next task and cancel/pause acknowledgement. Pause requests stop new work immediately; an active task becomes paused only after the worker reaches a safe boundary and the checkpoint is durable.

## Repair loop

1. Classify failure as specification, implementation, asset, environment, test, policy or external-account.
2. Preserve failed evidence; never rewrite a failure as success.
3. Retry transient infrastructure failures with bounded backoff and a new attempt record.
4. For product/code failures, issue the smallest repair task and re-run affected plus regression suites.
5. Move to **BLOCKED** for missing human/external prerequisites, or **FAILED** after the configured retry budget.

## Human interventions

- Approve specification and visual system.
- Perform subjective playtest and approve the exact candidate.
- Decide age-rating/privacy/legal declarations and monetization activation.
- Control store accounts, agreements, tax/banking and sensitive signing material.
- Approve store submission and production release.
`;
}

function renderArchitecture(game) {
  return header(game, "Game Architecture", "A technology-neutral gameplay contract to refine after the shared toolchain is admitted.") + `
## Shared technical baseline

${field("Engine candidate", shared.engine)}
${field("Performance", shared.fps)}
${field("Persistence", shared.save)}
${field("Privacy posture", shared.privacy)}

## Core system

${field("Loop", game.loop.join(" → "))}
${field("Controls", game.input)}
${field("Scoring", game.mechanics.score)}
${field("Progression", game.mechanics.progression)}
${field("Difficulty", game.mechanics.difficulty)}
${field("Win", game.mechanics.win)}
${field("Failure", game.mechanics.fail)}

## Runtime state model

- **Boot:** load immutable content manifest, settings and versioned save.
- **Menu:** chapter/level selection and settings; no simulation runs behind dialogs.
- **Briefing:** display objective and initialize a deterministic level seed/version.
- **Planning:** accept reversible player actions and persist an in-level checkpoint where appropriate.
- **Resolving:** lock conflicting input and run the deterministic evaluation.
- **Result:** expose success/failure cause, score and retry/next actions.
- **Suspended:** pause audio/haptics/timers, atomically persist, and recover to a documented state.

## Content and asset strategy

- Authored content lives in versioned data separate from presentation, validated by schema and a game-specific reference solver.
- Original vector/shape-first art is derived from the approved tokens in **05_VISUAL_SYSTEM.md**; source recipe, tool/version, prompt where applicable, license and output hash accompany every asset.
- Avoid protected characters, brand likenesses, copied levels, unlicensed fonts/audio and unexplained generated assets.
- Audio uses original or explicitly licensed sources with a provenance manifest; all functional audio has a visual equivalent.

## Audio and haptics

${field("Audio", game.visual.audio)}
${field("Haptics", game.mechanics.haptics)}
Both have independent volume/toggle settings and respect platform interruption, silent-mode and reduced-motion expectations.

## Analytics contract

Proposed gameplay events: ${game.mechanics.analytics.map((event) => `\`${event}\``).join(", ")}. Every event receives a schema, allowed-property list and test fixture before activation. No free text, advertising identifier, precise location, contacts or direct identifier belongs in these events.

## Monetization hooks

The core loop depends only on a **MonetizationPort** interface with fake, disabled and approved-platform adapters. Default is disabled. Entitlement restore, interrupted purchase, offline state, refund/revocation and duplicate-callback tests are mandatory before activation. Proposed model: ${game.monetization.model}

## Error handling

- Unknown/corrupt content fails to a safe level-selection screen and records a local diagnostic.
- Save migration uses backup → migrate → validate → atomic replace; validation failure restores the backup.
- Platform-service failure never blocks offline core play unless an explicitly purchased online feature requires it.
- Ads/IAP/analytics failures degrade to disabled service without faking a reward or purchase.

## Platform-specific considerations

- Respect safe areas, lifecycle/background events, system back/navigation, text scaling and controller/keyboard accessibility where supported.
- Android builds must be profiled for crashes, ANRs, memory, battery and slow sessions; release format and SDK/ABI requirements are verified at build time.
- iOS builds require current Xcode/SDK, StoreKit sandbox, privacy manifest/declarations and signing on an approved Mac/keychain path.

## Update path

Content and save schemas are independently versioned. Updates may add content but cannot silently change a released level's rules or score; changed rules get a new content version. Remote configuration can disable broken optional content/monetization but may not inject executable code or bypass store review.

## Test approach

${bullets(game.mechanics.specialQa)}
These supplement shared launch, crash, controls, save, viewport, performance, monetization, offline, analytics, privacy and store-readiness suites.
`;
}

function renderVisual(game) {
  return header(game, "Visual System", "Proposed reproducible art direction. Owner approval is required before asset generation.") + `
## Identity

${field("Working name", game.name)}
${field("Visual premise", game.visual.premise)}
${field("Typography", game.visual.type)}
${field("UI language", game.visual.ui)}
${field("Motion language", game.visual.motion)}
${field("Audio personality", game.visual.audio)}

## Palette

| Token | Hex | Intended role |
|---|---|---|
${game.visual.palette.map(([name, hex], index) => `| ${name} | \`${hex}\` | ${index === 0 ? "Background/anchor" : index === game.visual.palette.length - 1 ? "Text/high contrast" : "Interactive/state accent"} |`).join("\n")}

Color tokens are provisional until contrast is measured in the actual UI. No functional state may rely on hue alone.

## Store identity

${field("Icon direction", game.visual.icon)}
${field("Thumbnail direction", game.visual.thumbnail)}
The icon must remain recognizable at the smallest store rendition, contain no tiny text and pass an originality/trademark review before publication.

## Accessibility

${game.visual.accessibility}

Minimum shared rules: 44×44-point-equivalent touch targets, readable type at minimum viewport, screen-reader labels for controls, visible focus, non-color state encoding, captions/visual equivalents, independent sound/haptic controls and a reduced-motion/flash path.

## Automation recipe

1. Freeze approved design tokens as machine-readable data.
2. Produce vector-first source components on a fixed grid with named layers.
3. Record generator/tool version, source inputs, license/provenance and SHA-256.
4. Export deterministic platform sizes through one reviewed script.
5. Compare screenshots against golden scenes at required viewports and accessibility themes.
6. Quarantine any asset with missing provenance, protected-expression concern or inconsistent token use.

## Approval gate

No approval is recorded. Asset generation remains blocked until the owner approves this exact visual-system artifact version.
`;
}

function renderMonetization(game) {
  return header(game, "Monetization", "A proposed commercial model behind disabled-by-default adapters; pricing and activation are not approved.") + `
## Proposed model

${game.monetization.model}

### Candidate offers

${bullets(game.monetization.offers)}

### Non-negotiable guardrails

${game.monetization.guardrails}

- The game remains complete and understandable with monetization adapters disabled.
- Never fabricate scarcity, countdowns, social pressure, value comparisons or a purchase confirmation.
- No loot boxes, wagering, cash-out, crypto/NFT, manipulative streak repair or pay-to-pass QA.
- Restore purchases and revocations are tested on both platforms before release.
- Ads, if later approved, are player-initiated at documented safe boundaries and have failure/closure/duplicate-reward tests.

## Measurement plan

Measure tutorial completion, level completion, return rate, offer view, purchase start/result, restore result, ad request/result and post-monetization retention with coarse non-sensitive events. Set experiment hypotheses and stop rules before exposure. Never optimize revenue while crash, consent, refund or gameplay-integrity metrics are failing.

## Audience and policy gate

${shared.audience} The publisher must approve target-audience, content-rating, privacy, ad-SDK and purchase declarations. If children are included or users' ages are unknown, Google Families and applicable child-privacy rules materially change allowed ads/data behavior; the safe default is no ad or tracking activation.

## Human decisions still required

- Business model and exact localized price tiers.
- Audience/child-directed status and legal/privacy review.
- Store agreements, tax, banking and merchant configuration.
- Ad/IAP SDK selection and data-safety/privacy declarations.
- Explicit approval for production activation on an immutable build.

No approval is recorded in this document.
`;
}

function renderQa(game) {
  return header(game, "QA and Testing", "Evidence requirements for a build; a plan is not a passing test result.") + `
## Automated suites

| Suite | Minimum evidence |
|---|---|
| Core loop | Deterministic fixture reaches win and every documented failure/recovery path |
| Launch/crash | Cold/warm launch and repeated background/foreground with no launch-blocking crash |
| Controls | Gesture and accessible alternative produce equivalent state transitions |
| Save state | Atomic write, corruption recovery, migration, suspend/resume and fresh-install fixtures |
| Viewport | Golden scenes at agreed phone/tablet aspect ratios, safe areas and text scaling |
| Performance | Frame-time, memory, startup, thermal and battery sample on the device matrix |
| Monetization | Disabled, purchase, cancel, fail, duplicate callback, restore and revocation using sandbox/fakes |
| Offline | Full core loop without network; queued optional telemetry has bounded storage |
| Analytics | Event names/properties exactly match the approved schema with no sensitive/free-text data |
| Privacy/consent | Default-off adapters and approved consent transitions match declarations |
| Store readiness | Package identifiers, version, assets, metadata, provenance and release hashes complete |

## Game-specific suites

${bullets(game.mechanics.specialQa)}

## Human gates

1. Uncoached first-use comprehension on the supported smallest phone.
2. Accessibility pass using non-color controls, largest supported text and reduced-motion path.
3. Owner playtest of the exact immutable build with known issues visible.
4. Release-candidate review of feel, art originality, audio, copy and monetization boundaries.

## Severity and release rules

- **Blocker:** launch failure, data loss, purchase/reward error, privacy mismatch, inaccessible core control, deterministic-rule divergence or store rejection risk. Must be fixed.
- **Major:** core-loop confusion, frequent soft lock, severe frame/thermal regression or incorrect progress. Must be fixed or explicitly returned to revision; cannot be hidden.
- **Minor:** bounded presentation issue with documented workaround. May remain only when surfaced in the owner approval record.

No game moves to **PLAYTEST_READY** without a passing current automated run. No game moves to **APPROVED** without all required QA suites and owner approvals bound to the exact build. A retry creates new evidence; it never edits the failed record.

## Current result

**NOT RUN — no game build exists.** This package contains no passing QA claim.
`;
}

function renderStore(game) {
  return header(game, "Store Release", "Draft release inputs and human gates; it does not submit or publish anything.") + `
## Draft store position

${field("Working title", game.name)}
${field("Draft subtitle", game.store.subtitle)}
${field("Draft keyword themes", game.store.keywords)}

### Screenshot story

${numbered(game.store.shots)}

Store copy must describe only behavior verified in the release candidate. Screenshots must be captured from that build or clearly identified as non-submittable concept art.

## Automatable preparation

- Validate name length, metadata fields and localization schema.
- Generate platform icon/screenshot sizes from approved sources and verify pixels, alpha and safe areas.
- Build Android App Bundle and iOS archive on admitted workers; record hashes, tool versions and signing references without exporting private keys.
- Run store-policy/static checks, sandbox purchase tests, privacy-manifest/data-safety consistency and release QA.
- Draft description, release notes, reviewer instructions and support/privacy URLs.
- Stage to Play internal/closed testing and TestFlight only after account and signing gates permit.

## Publisher-only or legally sensitive steps

- Confirm developer-account ownership, agreements, tax and banking.
- Provide truthful age/content ratings, target-audience, privacy/data-safety, encryption/export and advertising declarations.
- Control certificates, profiles, App Store Connect/Play Console roles and sensitive signing material.
- Approve the exact release candidate, store submission and production rollout.

## Release gates

1. All 11 required artifacts have the mandated verified copies or an explicitly surfaced storage blocker.
2. Current build passes every required QA suite and provenance scan.
3. Visual, playtest, release-candidate, legal/privacy, store-submission and production approvals are durable and build-bound.
4. Signing and store-account capabilities are healthy; test tracks/TestFlight validate install, launch, purchase restore and upgrade.
5. Rollout and rollback criteria are written before production.

## Post-release watch

Monitor Android vitals, Apple crash/organizer signals, support feedback, store status, purchase integrity and funnel health. Halt rollout on crash/data-loss/purchase/privacy blockers. Use staged release where available; never infer acceptance from an API timeout.

## Current result

**BLOCKED — no approved build, account declarations, signing evidence or submission approval exists.**
`;
}

function renderHandoff(game) {
  return header(game, "Handoff Prompt", "A self-contained start prompt for the admitted factory. Reading this prompt is not permission to bypass gates.") + `
## Start-build prompt

> You are the supervising AI for the SD Tech Mobile Game Factory. Prepare **${game.name}** for ${PORTFOLIO_PUBLISHER}. Current status is **${game.status}**; no approval is implied.
>
> Product contract: ${game.logline} Target player: ${game.player} Session: ${game.session} Primary control: ${game.input}
>
> Core loop: ${game.loop.join(" → ")}.
>
> MVP: ${game.mvp.join("; ")}.
>
> Exclude: ${game.notMvp.join("; ")}.
>
> Visual premise: ${game.visual.premise} Use the approved version of **05_VISUAL_SYSTEM.md**; if it is not durably approved, stop at the visual gate. All assets must be original or licensed and carry provenance.
>
> Architecture: use the admitted shared cross-platform stack and capability-based worker routing. Do not expose model selection to the owner. Attach an isolated workspace before code work. Persist task/run/checkpoint/build IDs. Make simulation/content deterministic where specified. Never keep secrets or signing keys in source, artifacts or control-plane records.
>
> Begin by reconciling the 11 artifacts and current factory records. Do not enter **ARCHITECTURE** without specification approval. Do not enter **ASSET_GENERATION** without visual approval. Do not enter **IMPLEMENTATION** without portfolio admission, toolchain capability and workspace assignment. At every task, define acceptance criteria, dispatch one bounded capability, independently validate output, checkpoint at a safe boundary, and preserve failed evidence.
>
> Required special QA: ${game.mechanics.specialQa.join("; ")}. Also require core-loop, launch/crash, controls, save, viewport, performance, monetization, offline, analytics, privacy and store-readiness suites.
>
> Monetization is disabled by default. Proposed model: ${game.monetization.model} Guardrails: ${game.monetization.guardrails} Do not activate ads/IAP until audience, legal/privacy, sandbox and owner gates pass.
>
> Pause means request cancellation, reach a worker-safe boundary, persist a durable checkpoint, then mark paused. Resume must reattach to that checkpoint rather than regenerate work. Never fabricate legal, tax, banking, rating, privacy, encryption, signing, playtest, store submission or production release approval. Surface each human requirement in plain language.
>
> The deliverable is a tested, previewable release candidate with reproducible artifacts and honest blockers—not an optimistic completion message. Start with the next unblocked gate and report its evidence.

## First expected action

Load the durable project detail and artifact manifests. If the exact specification and visual-system versions are not approved, return a concise approval checklist and perform no implementation. ${game.name === "Vector Vault" ? "This is the provisional pilot candidate, but pilot status is not admission." : "This title follows the pilot and must not be started merely because its package exists."}
`;
}

function renderCompleteness(game) {
  return header(game, "Completeness Review", "A specification coherence audit, not a game/release certification.") + `
## Structural audit

| Requirement | Result | Evidence |
|---|---|---|
| Plain-language brief and bounded MVP | PASS | 00_GAME_BRIEF.md |
| Current, cited market hypothesis and risks | PASS | 01_MARKET_CASE.md |
| Gate-based path through early operations | PASS | 02_RELEASE_ROADMAP.md |
| Capability workflow, validation, repair and checkpoint rules | PASS | 03_BUILD_WORKFLOW.md |
| Controls, state, scoring, progression, persistence, services and update path | PASS | 04_GAME_ARCHITECTURE.md |
| Distinct palette, motion, icon, audio and accessibility | PASS | 05_VISUAL_SYSTEM.md |
| Game-specific model and policy guardrails | PASS | 06_MONETIZATION.md |
| Automated and human QA gates | PASS | 07_QA_AND_TESTING.md |
| Store preparation, human-only steps and release gates | PASS | 08_STORE_RELEASE.md |
| Self-contained gate-aware start prompt | PASS | 09_HANDOFF_PROMPT.md |
| Empty output locations are truthfully marked | PASS | assets/README.md, build/README.md, release/README.md |

## Cross-artifact consistency

- Name is consistently **${game.name}**; slug is **${game.slug}**.
- Core interaction remains: ${game.input}
- MVP scope is identical in brief, roadmap and handoff.
- Visual and monetization systems remain proposals and default-disabled where required.
- Special QA follows the concept's primary failure risks: ${game.mechanics.specialQa.join("; ")}.
- Store screenshots follow real gameplay states and cannot be treated as complete before a verified build exists.

## Open evidence and blockers

${bullets([
  "Owner specification approval not recorded",
  "Owner visual-system approval not recorded",
  "Name/trademark and protected-expression review not completed",
  "Market-comprehension and prototype evidence not collected",
  "Workspace/toolchain admission not bound to this game",
  "No source, game build, automated test run or playtest exists",
  "Target-audience, legal/privacy, store, signing and release decisions not completed",
  "Mandatory artifact-copy verification must be recorded by the factory storage adapters",
])}

## Review decision

**SPECIFICATION PACKAGE COMPLETE; GAME PRE-ADMISSION BLOCKED.** No approval is recorded. ${game.name === "Vector Vault" ? "Vector Vault remains the provisional pilot candidate and should be evaluated first." : `${game.name} must wait for portfolio sequencing after the pilot.`}
`;
}

export const ARTIFACT_RENDERERS = Object.freeze({
  "00_GAME_BRIEF": renderBrief,
  "01_MARKET_CASE": renderMarket,
  "02_RELEASE_ROADMAP": renderRoadmap,
  "03_BUILD_WORKFLOW": renderWorkflow,
  "04_GAME_ARCHITECTURE": renderArchitecture,
  "05_VISUAL_SYSTEM": renderVisual,
  "06_MONETIZATION": renderMonetization,
  "07_QA_AND_TESTING": renderQa,
  "08_STORE_RELEASE": renderStore,
  "09_HANDOFF_PROMPT": renderHandoff,
  "10_COMPLETENESS_REVIEW": renderCompleteness,
});

export function validatePortfolioSpecs() {
  const errors = [];
  const domain = new Map(PORTFOLIO.map((game) => [game.slug, game]));
  if (GAME_PORTFOLIO_SPECS.length !== PORTFOLIO.length) errors.push(`Expected ${PORTFOLIO.length} specs, found ${GAME_PORTFOLIO_SPECS.length}.`);
  for (const game of GAME_PORTFOLIO_SPECS) {
    const expected = domain.get(game.slug);
    if (!expected || expected.name !== game.name || expected.order !== game.order) errors.push(`Portfolio mismatch for ${game.slug}.`);
    for (const key of ["name", "slug", "status", "genre", "logline", "player", "session", "input", "differentiator", "marketSignal", "hypothesis", "kill"]) {
      if (!String(game[key] || "").trim()) errors.push(`${game.slug}.${key} is empty.`);
    }
    for (const key of ["loop", "mvp", "notMvp", "risks", "mitigations"]) if (!Array.isArray(game[key]) || !game[key].length) errors.push(`${game.slug}.${key} is empty.`);
    if (game.risks.length !== game.mitigations.length) errors.push(`${game.slug} risk/mitigation counts differ.`);
    if (!game.visual || game.visual.palette?.length !== 5) errors.push(`${game.slug} needs five palette tokens.`);
    if (!game.mechanics?.specialQa?.length || !game.mechanics.analytics?.length) errors.push(`${game.slug} lacks mechanics evidence contracts.`);
    if (!game.monetization?.model || !game.store?.shots?.length) errors.push(`${game.slug} lacks commercial/store data.`);
  }
  for (const key of REQUIRED_GAME_ARTIFACTS) if (!ARTIFACT_RENDERERS[key]) errors.push(`Missing renderer for ${key}.`);
  for (const key of Object.keys(ARTIFACT_RENDERERS)) if (!REQUIRED_GAME_ARTIFACTS.includes(key)) errors.push(`Unexpected renderer ${key}.`);
  if (new Set(GAME_PORTFOLIO_SPECS.map((game) => game.name)).size !== GAME_PORTFOLIO_SPECS.length) errors.push("Duplicate game name.");
  if (new Set(GAME_PORTFOLIO_SPECS.map((game) => game.slug)).size !== GAME_PORTFOLIO_SPECS.length) errors.push("Duplicate game slug.");
  const pilots = GAME_PORTFOLIO_SPECS.filter((game) => game.status.includes("PILOT_CANDIDATE"));
  if (pilots.length !== 1 || pilots[0].slug !== "vector-vault") errors.push("Vector Vault must be the only provisional pilot candidate.");
  return errors;
}

export function renderGameArtifact(gameOrSlug, artifactKey) {
  const game = typeof gameOrSlug === "string"
    ? GAME_PORTFOLIO_SPECS.find((candidate) => candidate.slug === gameOrSlug)
    : gameOrSlug;
  if (!game) throw new Error(`Unknown game: ${String(gameOrSlug)}`);
  const renderer = ARTIFACT_RENDERERS[artifactKey];
  if (!renderer) throw new Error(`Unknown artifact: ${artifactKey}`);
  return `${renderer(game).trim()}\n`;
}

export function createPortfolioSpecificationManifest() {
  const errors = validatePortfolioSpecs();
  if (errors.length) throw new Error(`Invalid portfolio specification:\n- ${errors.join("\n- ")}`);
  const files = [];
  for (const game of GAME_PORTFOLIO_SPECS) {
    for (const key of REQUIRED_GAME_ARTIFACTS) {
      files.push(Object.freeze({ game: game.slug, relativePath: `${game.name}/${key}.md`, content: renderGameArtifact(game, key) }));
    }
    for (const directory of ["assets", "build", "release"]) {
      const purpose = directory === "assets" ? "approved, provenance-tracked source and exported game assets"
        : directory === "build" ? "locally generated test/build outputs"
          : "immutable release-candidate packages and store-ready exports";
      files.push(Object.freeze({
        game: game.slug,
        relativePath: `${game.name}/${directory}/README.md`,
        content: `# ${game.name} — ${directory}\n\nThis directory is reserved for ${purpose}.\n\n**Current status: EMPTY BY DESIGN.** No game implementation, build, release, approval or store submission exists. Generated files must carry build/task IDs and hashes; assets must also carry license/provenance. Secrets and private signing material must never be stored here.\n`,
      }));
    }
  }
  return Object.freeze(files);
}

/*
 * Lane gfforge (LANE-gfforge.md, additive-only export in this file): the forge's product_planning
 * and visual_design tasks need the catalog entry for a game (logline, loop, mvp, visual copy,
 * mechanics, monetization guardrails, store copy) to prompt the design/asset models and to compose
 * meta.json. GAME_PORTFOLIO_SPECS is already frozen per-entry (line ~581), so these are read-only
 * lookups, never a mutable copy — a caller that tries to edit the returned object throws in strict
 * mode instead of silently corrupting the shared catalog singleton.
 */
export function portfolioGame(slug) {
  const clean = String(slug || "").trim().toLowerCase();
  if (!clean) return null;
  return GAME_PORTFOLIO_SPECS.find((game) => game.slug === clean) || null;
}

export function portfolioGames() {
  return GAME_PORTFOLIO_SPECS;
}
