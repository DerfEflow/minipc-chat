/*
 * gamefactorykit/reference/vector-vault/render.js -- draw(ctx, state, layout, theme, t).
 * Canvas 2D subset only (see the kit contract in GAME-FACTORY-BUILD.md section 2 and the recording
 * context in qa/run.mjs's launch-smoke suite, which throws on anything outside that subset): this
 * file uses only fillRect, beginPath/moveTo/lineTo/arc/fill/stroke, setLineDash, fillText, and the
 * fillStyle/strokeStyle/lineWidth/font/textAlign/textBaseline/globalAlpha properties, plus
 * save/restore. No drawImage, no clip, no shadow -- none of those are on the allowed list.
 *
 * Deliberately does its own tiny path/world-to-screen math rather than importing rules.js: this
 * file only needs to know WHERE things are for display, not the rules for what a legal move is,
 * and keeping it decoupled from rules.js means a rendering change can never accidentally change
 * game logic (or vice versa).
 */
import content from "./content.js";

function worldToScreen(board, grid, wx, wy) {
  const scale = Math.min(board.w / grid.cols, board.h / grid.rows);
  const offX = board.x + (board.w - grid.cols * scale) / 2;
  const offY = board.y + (board.h - grid.rows * scale) / 2;
  return { x: offX + wx * scale, y: offY + wy * scale };
}

function previewPath(start, vectors) {
  const pts = [{ x: start.x, y: start.y }];
  let cur = { x: start.x, y: start.y };
  for (const v of vectors) {
    const rad = (v.angle * Math.PI) / 180;
    cur = { x: cur.x + v.magnitude * Math.cos(rad), y: cur.y + v.magnitude * Math.sin(rad) };
    pts.push({ x: cur.x, y: cur.y });
  }
  return pts;
}

export function draw(ctx, state, layoutInfo, theme, t) {
  const level = content.levels[state.levelIndex];
  const board = layoutInfo.board;
  const palette = (theme && theme.palette && theme.palette.length >= 5) ? theme.palette : ["#0B1020", "#38E8FF", "#FFC857", "#FF5D73", "#F5F7FF"];
  const [bg, pulseColor, gold, coral, paper] = palette;
  const grid = level.grid;
  const scale = Math.min(board.w / grid.cols, board.h / grid.rows);
  const toScreen = (wx, wy) => worldToScreen(board, grid, wx, wy);

  ctx.save();
  ctx.fillStyle = bg;
  ctx.fillRect(board.x, board.y, board.w, board.h);

  ctx.globalAlpha = 0.55;
  ctx.fillStyle = coral;
  for (const w of level.walls) {
    const p0 = toScreen(w.x, w.y);
    ctx.fillRect(p0.x, p0.y, w.w * scale, w.h * scale);
  }
  ctx.globalAlpha = 1;

  const reduced = !!(theme && theme.reducedMotion);
  const breathe = reduced ? 1 : 0.65 + 0.35 * Math.sin((Number(t) || 0) / 320);
  const vaultScreen = toScreen(level.vault.x, level.vault.y);
  ctx.globalAlpha = breathe;
  ctx.strokeStyle = gold;
  ctx.lineWidth = Math.max(2, scale * 0.06);
  ctx.beginPath();
  ctx.arc(vaultScreen.x, vaultScreen.y, Math.max(2, level.vault.tolerance * scale), 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  const startScreen = toScreen(level.start.x, level.start.y);
  ctx.fillStyle = paper;
  ctx.beginPath();
  ctx.arc(startScreen.x, startScreen.y, Math.max(3, scale * 0.08), 0, Math.PI * 2);
  ctx.fill();

  const path = previewPath(level.start, state.vectors);
  ctx.strokeStyle = pulseColor;
  ctx.lineWidth = Math.max(2, scale * 0.05);
  ctx.setLineDash(reduced ? [] : [Math.max(2, scale * 0.15), Math.max(2, scale * 0.1)]);
  ctx.beginPath();
  const p0 = toScreen(path[0].x, path[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < path.length; i++) {
    const p = toScreen(path[i].x, path[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  for (let i = 1; i < path.length; i++) {
    const p = toScreen(path[i].x, path[i].y);
    ctx.fillStyle = (i - 1 === state.selected) ? gold : pulseColor;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(4, scale * 0.1), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = paper;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = Math.max(12, Math.round(scale * 0.4)) + "px sans-serif";
  ctx.fillText(level.name + " - " + state.status, board.x + 6, board.y + 6);

  ctx.restore();
}
