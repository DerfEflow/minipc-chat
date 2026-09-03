/*
 * gamefactorykit/reference/vector-vault/content.js -- GENERATED shape (hand-authored here since
 * this is the reference game, not forge output). 12 levels. Every level's `vault` position is the
 * EXACT vector-sum endpoint of its own `solution` array (computed with the same formula rules.js
 * uses: cur += magnitude * [cos(angle), sin(angle)] per vector, angle in degrees), verified with a
 * throwaway script before being pasted here -- see the lane report for the method. That removes
 * hand-arithmetic risk: every level's solution is GUARANTEED to land within tolerance of its vault
 * (dist ~0, well inside the smallest tolerance used, 0.4).
 *
 * `walls` are axis-aligned rectangles { x, y, w, h } in the same grid units as start/vault -- see
 * rules.js segmentIntersectsRect (Liang-Barsky line clipping) for how a launch path is tested
 * against them. Levels v5, v6, v8, v10 and v12 carry a wall; each one was verified to (a) never
 * intersect its own level's solution path and (b) actually block that level's `vectors` (the
 * initial, wrong, values used as the QA "fail" fixture), so the wall mechanic is genuinely
 * exercised, not decorative.
 */
export default {
  schemaVersion: 1,
  tutorial: [
    "Select a vector with the vector buttons.",
    "Rotate it and set its magnitude with the step controls.",
    "Launch. The pulse follows the sum of every vector, in order.",
    "Land inside the vault, clear of every wall, to win.",
  ],
  levels: [
    {
      id: "v1", name: "First Pulse", grid: { cols: 16, rows: 14 },
      start: { x: 1, y: 6 }, vault: { x: 6, y: 6, tolerance: 0.6 }, walls: [],
      vectors: [{ angle: 90, magnitude: 3 }],
      solution: [{ angle: 0, magnitude: 5 }],
      maxLaunches: 1,
    },
    {
      id: "v2", name: "Diagonal", grid: { cols: 16, rows: 14 },
      start: { x: 1, y: 1 }, vault: { x: 4.536, y: 4.536, tolerance: 0.6 }, walls: [],
      vectors: [{ angle: 45, magnitude: 2 }],
      solution: [{ angle: 45, magnitude: 5 }],
      maxLaunches: 1,
    },
    {
      id: "v3", name: "Reach Back", grid: { cols: 16, rows: 14 },
      start: { x: 8, y: 8 }, vault: { x: 4.241, y: 6.632, tolerance: 0.6 }, walls: [],
      vectors: [{ angle: 200, magnitude: 1 }],
      solution: [{ angle: 200, magnitude: 4 }],
      maxLaunches: 1,
    },
    {
      id: "v4", name: "Two Legs", grid: { cols: 16, rows: 14 },
      start: { x: 1, y: 1 }, vault: { x: 5, y: 4, tolerance: 0.6 }, walls: [],
      vectors: [{ angle: 0, magnitude: 1 }, { angle: 90, magnitude: 1 }],
      solution: [{ angle: 0, magnitude: 4 }, { angle: 90, magnitude: 3 }],
      maxLaunches: 1,
    },
    {
      id: "v5", name: "First Wall", grid: { cols: 16, rows: 14 },
      start: { x: 1, y: 1 }, vault: { x: 6, y: 5, tolerance: 0.6 },
      walls: [{ x: 2.5, y: 0, w: 2, h: 2.5 }],
      vectors: [{ angle: 45, magnitude: 3 }, { angle: 45, magnitude: 3 }],
      solution: [{ angle: 90, magnitude: 4 }, { angle: 0, magnitude: 5 }],
      maxLaunches: 1,
    },
    {
      id: "v6", name: "Steady Aim", grid: { cols: 16, rows: 14 },
      start: { x: 1, y: 8 }, vault: { x: 5.924, y: 7.132, tolerance: 0.6 },
      walls: [{ x: 2, y: 5.5, w: 2, h: 1 }],
      vectors: [{ angle: 300, magnitude: 5 }],
      solution: [{ angle: 350, magnitude: 5 }],
      maxLaunches: 1,
    },
    {
      id: "v7", name: "Long Reach", grid: { cols: 16, rows: 14 },
      start: { x: 1, y: 1 }, vault: { x: 6.567, y: 7.634, tolerance: 0.6 }, walls: [],
      vectors: [{ angle: 20, magnitude: 1 }, { angle: 80, magnitude: 1 }],
      solution: [{ angle: 20, magnitude: 5 }, { angle: 80, magnitude: 5 }],
      maxLaunches: 1,
    },
    {
      id: "v8", name: "Around The Block", grid: { cols: 16, rows: 14 },
      start: { x: 1, y: 9 }, vault: { x: 9.457, y: 8.658, tolerance: 0.6 },
      walls: [{ x: 6, y: 6, w: 2.2, h: 1 }],
      vectors: [{ angle: 340, magnitude: 5 }, { angle: 340, magnitude: 4 }],
      solution: [{ angle: 340, magnitude: 5 }, { angle: 20, magnitude: 4 }],
      maxLaunches: 1,
    },
    {
      id: "v9", name: "Triple Step", grid: { cols: 16, rows: 14 },
      start: { x: 1, y: 1 }, vault: { x: 4.68, y: 6.046, tolerance: 0.6 }, walls: [],
      vectors: [{ angle: 10, magnitude: 1 }, { angle: 70, magnitude: 1 }, { angle: 130, magnitude: 1 }],
      solution: [{ angle: 10, magnitude: 4 }, { angle: 70, magnitude: 3 }, { angle: 130, magnitude: 2 }],
      maxLaunches: 1,
    },
    {
      id: "v10", name: "Tight Corridor", grid: { cols: 16, rows: 14 },
      start: { x: 1, y: 1 }, vault: { x: 7.309, y: 8.713, tolerance: 0.55 },
      walls: [{ x: 0, y: 6.5, w: 3, h: 1 }],
      vectors: [{ angle: 15, magnitude: 1 }, { angle: 60, magnitude: 1 }, { angle: 270, magnitude: 5 }],
      solution: [{ angle: 15, magnitude: 5 }, { angle: 60, magnitude: 4 }, { angle: 100, magnitude: 3 }],
      maxLaunches: 1,
    },
    {
      id: "v11", name: "Precision", grid: { cols: 16, rows: 14 },
      start: { x: 2, y: 2 }, vault: { x: 6.27, y: 7.102, tolerance: 0.4 }, walls: [],
      vectors: [{ angle: 25, magnitude: 1 }, { angle: 95, magnitude: 1 }],
      solution: [{ angle: 25, magnitude: 5 }, { angle: 95, magnitude: 3 }],
      maxLaunches: 1,
    },
    {
      id: "v12", name: "The Vault", grid: { cols: 16, rows: 14 },
      start: { x: 1, y: 5 }, vault: { x: 12.123, y: 8.44, tolerance: 0.5 },
      walls: [{ x: 6, y: 1, w: 2, h: 2 }],
      vectors: [{ angle: 350, magnitude: 1 }, { angle: 20, magnitude: 1 }, { angle: 350, magnitude: 5 }],
      solution: [{ angle: 350, magnitude: 5 }, { angle: 20, magnitude: 5 }, { angle: 60, magnitude: 3 }],
      maxLaunches: 1,
    },
  ],
};
