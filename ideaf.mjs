/*
 * AF pipeline: the Agentic Workflow window logic (Fred's design 2026-07-22, APPROVED).
 *
 * The AF (Agentic Workflow) is a crew pipeline the user composes as rows of Task / Model / Number,
 * running divide-and-conquer builds across multiple agents. This module is the pure logic: row
 * sanitization, classification, divider message formatting, plan parsing, file overlap detection,
 * and model assignment resolution. No HTTP, no providers, test-first.
 *
 * Contract with the divider (parsed by parseDividerPlan):
 *   For each part, the divider writes exactly:
 *   PART <k>: <title>
 *   FILES: <comma-separated paths>
 *   CONTRACT: <promises>
 *   Where k is 1-based, paths are relative (never absolute, never contain ".."), and
 *   contract may span multiple lines (anything after CONTRACT: on that line, plus all lines
 *   until the next PART or end). No two parts may claim the same file (the referee verifies
 *   this in code and refuses overlaps).
 */

import { plannerVoice, normalizeRegister } from "./idelang.mjs";

/*
 * Sanitize a client-supplied AF row into {task, model, n}: clamp task to 160 chars, model to
 * 80 chars (may be empty string to mean "follow the main model"), and n to integer 1..25.
 * Non-worker rows (divider/reviewer/qc) are forced to n=1. Returns the cleaned row or null
 * if the input is garbage.
 */
function sanitizeAfRow(row, classifyTask) {
  if (!row || typeof row !== "object") return null;
  const task = String((row && row.task) || "").slice(0, 160).trim();
  const model = String((row && row.model) || "").slice(0, 80).trim();
  const n = Math.max(1, Math.min(25, Math.floor(Number(row && row.n) || 1)));
  if (!task) return null;
  const role = classifyTask(task);
  const finalN = (role === "worker") ? n : 1;
  return { task, model, n: finalN };
}

/*
 * Classify a task string by its first matching keyword pattern.
 * Patterns are tested in order: divider, reviewer, qc, else worker.
 */
export function classifyAfRow(task) {
  const lower = String(task || "").toLowerCase();
  if (/divide|split|contract/.test(lower)) return "divider";
  if (/review|fix/.test(lower)) return "reviewer";
  if (/check|qc|quality/.test(lower)) return "qc";
  return "worker";
}

/*
 * Sanitize a client-supplied array of AF rows, clamping to at most 8 rows.
 * Returns the cleaned array; garbage in yields [].
 */
export function sanitizeAfRows(rows) {
  if (!Array.isArray(rows)) return [];
  const cleaned = [];
  for (const row of rows.slice(0, 8)) {
    const san = sanitizeAfRow(row, classifyAfRow);
    if (san) cleaned.push(san);
  }
  return cleaned;
}

/*
 * Classify an array of AF rows into roles.
 * Returns {divider, workers, reviewer, qc, error}.
 * divider/reviewer/qc are the FIRST row of that role (null if absent).
 * workers is an array of every worker row in order.
 * error (string) if there is no divider or no worker row.
 * Total worker n is capped at 25 across all worker rows.
 */
export function classifyAfRows(rows) {
  const cleaned = sanitizeAfRows(rows);
  const result = { divider: null, workers: [], reviewer: null, qc: null, error: null };
  let workerNTotal = 0;

  for (const row of cleaned) {
    const role = classifyAfRow(row.task);
    if (role === "divider" && !result.divider) {
      result.divider = row;
    } else if (role === "reviewer" && !result.reviewer) {
      result.reviewer = row;
    } else if (role === "qc" && !result.qc) {
      result.qc = row;
    } else if (role === "worker") {
      workerNTotal += row.n;
      result.workers.push(row);
    }
  }

  if (!result.divider) {
    result.error = "no divider row";
  } else if (result.workers.length === 0) {
    result.error = "no worker row";
  }

  if (workerNTotal > 25) {
    result.error = "total worker n exceeds 25";
  }

  return result;
}

/*
 * Build the system and history messages for a divider call.
 * The divider is asked to partition the build into at most maxParts independent chunks,
 * each with exclusive file ownership and explicit contracts with the other parts.
 */
export function dividerMessages({ goal = "", maxParts = 5, register = "plain", persona = "" } = {}) {
  const r = normalizeRegister(register);
  const systemPrompt = [
    "You are the divider, the first step of a parallel build pipeline.",
    "",
    "Your job: take one build goal and partition it into AT MOST " + maxParts + " independent parts.",
    "Each part gets EXCLUSIVE ownership of named files (relative paths, no file may be claimed by",
    "two parts), and each part gets a CONTRACT stating what it promises the other parts.",
    "",
    "Reply in EXACTLY this format, nothing else:",
    "For each part, write a line 'PART <k>: <title>' where k is 1-based and title is the part's",
    "focus. Then 'FILES: <comma separated relative paths>'. Then one or more lines",
    "'CONTRACT: <the promises this part makes to the others>'.",
    "",
    "Example format:",
    "PART 1: Core backend API",
    "FILES: src/api/server.mjs, src/api/routes.mjs, src/db/schema.sql",
    "CONTRACT: Provides /api/data endpoint returning JSON; schema supports 1000+ records.",
    "PART 2: Frontend UI",
    "FILES: public/index.html, public/app.js, public/style.css",
    "CONTRACT: Consumes /api/data and renders a filterable table; compatible with touch.",
    "",
    "RULES:",
    "1. Every file must have an owner (no unassigned files, no ambiguity).",
    "2. No file may be claimed by two parts (the referee will verify and refuse overlaps).",
    "3. Write contracts plainly so the other parts know exactly what to expect.",
    "4. At most " + maxParts + " parts (fewer is fine, more will fail).",
    "",
    "VOICE: " + plannerVoice(r),
    ...(persona ? ["", persona] : []),
  ].join("\n");

  const msgs = [{ role: "system", content: systemPrompt }];
  if (goal) {
    msgs.push({ role: "user", content: "Goal: " + goal });
  }
  return msgs;
}

/*
 * Parse a divider's response into {ok, parts, error}.
 * Parts is [{title, files: [path, ...], contract: string}].
 * Paths are normalized (backslashes to forward slashes, trimmed).
 * Error if any path is absolute or contains "..", if a part lacks FILES line,
 * if file count per part is not 1..40, if part count exceeds maxParts, etc.
 */
export function parseDividerPlan(text, maxParts = 5) {
  const raw = String(text == null ? "" : text).trim();
  const lines = raw.split(/\r?\n/);
  const parts = [];
  let currentPart = null;
  let currentContract = "";

  for (const line of lines) {
    const partMatch = line.match(/^PART\s+(\d+):\s*(.+)$/);
    if (partMatch) {
      if (currentPart) {
        currentPart.contract = currentContract.trim();
        parts.push(currentPart);
      }
      currentPart = {
        title: partMatch[2].trim(),
        files: [],
        contract: "",
      };
      currentContract = "";
      continue;
    }

    if (!currentPart) continue;

    const filesMatch = line.match(/^FILES:\s*(.*)$/);
    if (filesMatch) {
      const fileStr = filesMatch[1].trim();
      if (fileStr) {
        const filePaths = fileStr.split(",").map((f) => {
          let p = f.trim().replace(/\\/g, "/");
          return p;
        });
        currentPart.files = filePaths;
      }
      continue;
    }

    const contractMatch = line.match(/^CONTRACT:\s*(.*)$/);
    if (contractMatch) {
      // A part may state several promises across several CONTRACT lines; they accumulate.
      // Overwriting here silently discarded every promise except the last one.
      currentContract = currentContract
        ? currentContract + "\n" + contractMatch[1].trim()
        : contractMatch[1].trim();
      continue;
    }

    if (currentPart && line.trim()) {
      if (!currentContract && !line.match(/^(PART|FILES|CONTRACT)/i)) {
        continue;
      }
      if (currentContract) {
        currentContract += "\n" + line;
      }
    }
  }

  if (currentPart) {
    currentPart.contract = currentContract.trim();
    parts.push(currentPart);
  }

  if (parts.length === 0) {
    return { ok: false, parts: [], error: "no parts found" };
  }

  if (parts.length > maxParts) {
    return { ok: false, parts: [], error: "more than " + maxParts + " parts" };
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.files.length === 0) {
      return { ok: false, parts: [], error: "part " + (i + 1) + " has no FILES line" };
    }
    if (part.files.length > 40) {
      return { ok: false, parts: [], error: "part " + (i + 1) + " has more than 40 files" };
    }

    for (const file of part.files) {
      if (file.startsWith("/") || file.match(/^[a-zA-Z]:/)) {
        return { ok: false, parts: [], error: "part " + (i + 1) + " has absolute path: " + file };
      }
      if (file.includes("..")) {
        return { ok: false, parts: [], error: "part " + (i + 1) + " has dot-dot in path: " + file };
      }
    }
  }

  return { ok: true, parts, error: null };
}

/*
 * Verify that no file is claimed by more than one part.
 * Returns {ok, overlaps: [{file, a, b}]} where a and b are 1-based part numbers.
 * Case-insensitive comparison, backslashes normalized. Every colliding pair of parts is
 * reported: a file claimed by three parts yields all three pairs (1,2), (1,3), (2,3),
 * never just the first collision.
 */
export function verifyDisjoint(parts) {
  const fileMap = new Map();

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || !part.files) continue;
    for (const file of part.files) {
      const normalized = String(file || "").toLowerCase().replace(/\\/g, "/");
      if (!fileMap.has(normalized)) fileMap.set(normalized, []);
      fileMap.get(normalized).push(i + 1);
    }
  }

  const overlaps = [];
  for (const [file, claimants] of fileMap) {
    if (claimants.length < 2) continue;
    for (let a = 0; a < claimants.length; a++) {
      for (let b = a + 1; b < claimants.length; b++) {
        overlaps.push({ file, a: claimants[a], b: claimants[b] });
      }
    }
  }

  return { ok: overlaps.length === 0, overlaps };
}

/*
 * Return a resolved assignments object forcing one model for all text classes when modelId
 * is not empty. When modelId is "", return null (caller falls back to the standard board).
 */
export function afAssignFor(modelId) {
  if (modelId === "" || modelId == null) return null;
  const m = String(modelId).trim();
  if (!m) return null;
  return {
    design_visual: m,
    design_code: m,
    build_code: m,
    mechanical: m,
    review: m,
    allInOne: m,
  };
}
