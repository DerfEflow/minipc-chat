# Adopt Existing Project — SOW (Fred, 2026-07-26)

**Positioning (Fred's words, the why):** Replit/Base44 sold "all you need is an idea and BOOM the
app appears," omitting the real cost, the dozens of iterations, and the never-production-worthy
endings — so people give up. The Crucible makes no such promise while actually landing closer to
that result. Adoption is the sharpest proof: bring a partially completed app and the system maps
it honestly, then finishes it.

**Placement:** PROMINENT feature, available in the **Vibe Coder and Engineer interfaces ONLY**.
Never in Beginner. Engineer is still Coming-Soon for guests (ENGINEER_PUBLIC), so guests get it
through Vibe; Fred gets it in both.

## Flow
1. **Point**: user selects/creates a workspace whose root is the existing app's folder (all
   existing validateRoot + tenant hands-wall rules apply; guests scan only their own machine).
2. **Scan** (new server pass, through the same hands): walk the tree (bounded depth/count), read
   key manifests (package.json, requirements.txt, etc.) and entry points; detect frameworks, what
   runs, what is stubbed/TODO. All reads capped (sanitizer doctrine). Snapshot-first untouched —
   the scan is read-only.
3. **State-of-the-app brief**: honest inventory — built / half-built / missing / broken — shown to
   the user before anything else. No invented progress (honest-numbers doctrine).
4. **Seeded planning**: interviewer/plan-chat opens FROM the brief ("here is what you have; what
   should it become?"); planner writes tasks against reality, each marked finish / fix / build-new.
5. **Build** rides the existing machinery unchanged (disjoint tasks, snapshots, rollback, metering,
   session budgets).

## Build notes
- New endpoint (e.g. POST /ide/adopt {workspace}) — ide-gated, rate-limited (heavy tier if a model
  summarizes), caps on file count/bytes read; scan summary itself metered via ideChatOnce if a
  model is used.
- Vibe UI: prominent control in the vb-controls row (beside New), wired to the Save to: workspace
  selector; brief lands in the Main plan window as the opening context. Engineer placement rides
  the Engineer rebuild.
- Furnace doctrine: idehelp.mjs updated same commit.
- Marketing seed (Phase 3): "Bring your half-finished app. We read what is actually there, tell
  you the truth about it, and finish it."

Status: SPEC ONLY — build is the first item of the next session.
