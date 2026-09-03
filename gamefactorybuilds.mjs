/*
 * Game Factory build bundles: the server-side view of what the forge produced for a build.
 *
 * A build's bundle lives at <dataDir>/game-factory/builds/<buildId>/bundle/ with build.json beside
 * it (written by gamefactorykit's assembleBundle) and qa/results.json (written by the server QA
 * runner). This module answers three questions for the HTTP surface without letting a request name
 * a path: does a bundle exist for this game's build, which file inside it does a play URL refer to,
 * and what is the one-card summary (version, fingerprint, QA tally). Every buildId is checked
 * against the store so a build from another game or tenant can never be served under this one.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const MIME = Object.freeze({
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", webmanifest: "application/manifest+json; charset=utf-8",
  css: "text/css; charset=utf-8", png: "image/png", svg: "image/svg+xml", ico: "image/x-icon", txt: "text/plain; charset=utf-8",
  wasm: "application/wasm", woff2: "font/woff2", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
});
const clean = (value, max = 240) => String(value == null ? "" : value).trim().slice(0, max);
const BUILD_ID = /^gfb_[a-f0-9-]{8,80}$/;

function parseJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function isUnder(child, parent) {
  const c = resolve(child), p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export function createGameFactoryBuilds({ dataDir, store } = {}) {
  if (!dataDir) throw new Error("createGameFactoryBuilds needs dataDir");
  if (!store || typeof store.getProject !== "function") throw new Error("createGameFactoryBuilds needs the game factory store");
  const root = resolve(dataDir, "game-factory", "builds");

  // A build belongs to the game when the store says so: the active build, or any build listed for
  // the project when the store exposes listBuilds (added by the supervisor lane). Nothing else.
  function buildBelongs({ uid, projectId, buildId }) {
    const id = clean(buildId, 120);
    if (!BUILD_ID.test(id)) return false;
    const detail = store.getProject(uid, projectId, { eventLimit: 1 });
    if (!detail) return false;
    if (detail.activeBuild && detail.activeBuild.id === id) return true;
    if (typeof store.listBuilds === "function") {
      try { return (store.listBuilds(uid, projectId) || []).some((build) => build && build.id === id); } catch { return false; }
    }
    return false;
  }

  function bundleDir(buildId) { return join(root, clean(buildId, 120), "bundle"); }

  function exists({ uid, projectId, buildId } = {}) {
    if (!buildBelongs({ uid, projectId, buildId })) return false;
    const dir = bundleDir(buildId);
    try { return statSync(join(dir, "index.html")).isFile(); } catch { return false; }
  }

  function resolveFile({ uid, projectId, buildId, relPath } = {}) {
    if (!buildBelongs({ uid, projectId, buildId })) return null;
    const raw = String(relPath == null ? "" : relPath);
    const rel = raw.replace(/^\/+/, "") || "index.html";
    if (rel.includes("\\") || rel.includes("\0") || rel.split("/").some((part) => part === ".." || part === "" || part.startsWith("."))) return null;
    const dir = bundleDir(buildId);
    const absolute = resolve(dir, rel);
    if (!isUnder(absolute, dir)) return null;
    let real;
    try { real = realpathSync(absolute); } catch { return null; }
    let realDir;
    try { realDir = realpathSync(dir); } catch { return null; }
    if (!isUnder(real, realDir)) return null;
    let st;
    try { st = statSync(real); } catch { return null; }
    if (!st.isFile()) return null;
    const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
    return { absolute: real, mime: MIME[ext] || "application/octet-stream", size: st.size };
  }

  function summary({ uid, projectId, buildId } = {}) {
    if (!buildBelongs({ uid, projectId, buildId })) return null;
    const base = join(root, clean(buildId, 120));
    // The kit's assembleBundle writes build.json INSIDE the bundle it assembles; an older layout kept it
    // beside the bundle. Read whichever exists so the card never goes blank for a build that is there.
    const build = parseJson(join(base, "bundle", "build.json")) || parseJson(join(base, "build.json"));
    const results = parseJson(join(base, "qa", "results.json"));
    if (!build && !results) return null;
    const suites = results && results.suites && typeof results.suites === "object" ? results.suites : {};
    const names = Object.keys(suites);
    const passed = names.filter((name) => suites[name] && suites[name].status === "PASSED");
    const failed = names.filter((name) => suites[name] && suites[name].status !== "PASSED");
    // The store's own build status wins when it knows this build (the supervisor marks BUILT/TESTED);
    // otherwise the evidence on disk speaks: QA recorded -> TESTED, bundle present -> BUILT, else PLANNED.
    let status = "";
    try {
      const detail = store.getProject(uid, projectId, { eventLimit: 1 });
      if (detail && detail.activeBuild && detail.activeBuild.id === clean(buildId, 120)) status = clean(detail.activeBuild.status, 40);
    } catch {}
    if (!status || status === "PLANNED") status = results ? "TESTED" : existsSync(join(base, "bundle", "index.html")) ? "BUILT" : status || "PLANNED";
    return {
      buildId: clean(buildId, 120),
      status,
      versionName: build ? clean(build.versionName, 40) : "",
      bundleSha256: build ? clean(build.bundleSha256, 64) : "",
      fileCount: build && Array.isArray(build.files) ? build.files.length : 0,
      toolchain: build && build.toolchain ? build.toolchain : null,
      createdAt: build ? build.createdAt || "" : "",
      playable: existsSync(join(base, "bundle", "index.html")),
      qa: results ? {
        runner: clean(results.runner, 40), passed: passed.length, failed: failed.length, total: names.length,
        failedSuites: failed, endedAt: results.endedAt || "",
        suites: Object.fromEntries(names.map((name) => [name, { status: suites[name].status, summary: clean(suites[name].summary, 300) }])),
      } : null,
    };
  }

  return { root, exists, resolveFile, summary, MIME };
}
