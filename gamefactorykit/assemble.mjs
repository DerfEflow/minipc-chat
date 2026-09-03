/*
 * gamefactorykit/assemble.mjs -- assembleBundle + verifyBundle. See GAME-FACTORY-BUILD.md section
 * 2 for the frozen bundle layout and LANE-gfkit.md section E for this file's exact contract.
 *
 * Deliberately does NOT import kit.mjs (kit.mjs imports assembleBundle/verifyBundle FROM this
 * file, so the reverse import would be circular). The three static kit files this needs to embed
 * into every bundle (kit/runtime.js, kit/ports.js, qa/run.mjs) are read directly off disk here,
 * relative to this file's own location -- kit.mjs's public kitFiles() reads the exact same three
 * files independently, for the same reason. A few duplicated lines beats a cycle.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { pngSize } from "./png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Bumped only if the bundle layout or a kit file's contract changes in a way old bundles would not
// tolerate. Recorded in every build.json's toolchain.kit so a supervisor can tell which kit
// generation produced a given bundle.
export const KIT_VERSION = "1";

const GENERATED_KEYS = Object.freeze(["game/rules.js", "game/render.js", "game/content.js", "qa/fixtures.json"]);
const ASSET_KEYS = Object.freeze(["assets/icon-512.png", "assets/icon-192.png", "assets/splash.png", "assets/provenance.json"]);

function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

function walkFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, base, out);
    else out.push(full.slice(base.length + 1).split(sep).join("/"));
  }
  return out;
}

function readKitStaticFiles() {
  return {
    "kit/runtime.js": readFileSync(join(HERE, "runtime.js"), "utf8"),
    "kit/ports.js": readFileSync(join(HERE, "ports.js"), "utf8"),
    "qa/run.mjs": readFileSync(join(HERE, "qa", "run.mjs"), "utf8"),
  };
}

function writeBundleFile(outDir, relPath, content) {
  const full = join(outDir, ...relPath.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * assembleBundle({ outDir, generated, meta, assets }) -> build.json object (also written to disk).
 * See LANE-gfkit.md section E for the exact shape of each argument. Refuses a non-empty outDir and
 * any missing/empty generated file or asset -- this function only WRITES what it is given; picking
 * a fallback (e.g. gamefactorykit.fallbackIconPng for missing art) is the caller's job.
 */
export async function assembleBundle({ outDir, generated, meta, assets }) {
  if (!outDir) throw new Error("assembleBundle: outDir is required");
  if (existsSync(outDir)) {
    if (readdirSync(outDir).length > 0) throw new Error(`assembleBundle: outDir is not empty: ${outDir}`);
  } else {
    mkdirSync(outDir, { recursive: true });
  }

  for (const key of GENERATED_KEYS) {
    const v = generated && generated[key];
    if (typeof v !== "string" || v.trim().length === 0) throw new Error(`assembleBundle: generated file missing or empty: ${key}`);
  }
  for (const key of ASSET_KEYS) {
    const v = assets && assets[key];
    const empty = v === undefined || v === null || (Buffer.isBuffer(v) && v.length === 0) || (typeof v === "string" && v.trim().length === 0);
    if (empty) throw new Error(`assembleBundle: asset missing or empty: ${key}`);
  }
  if (!meta || !meta.name || !meta.slug) throw new Error("assembleBundle: meta.name and meta.slug are required");

  const name = String(meta.name);
  const slug = String(meta.slug);
  const versionName = String(meta.versionName || "0.1.0");
  const buildId = String(meta.buildId || ("build_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)));
  const subtitle = String(meta.subtitle || "");
  const keywords = String(meta.keywords || "");
  // `meta.palette` is expected to already be the FLAT hex-string form (see kit.mjs's
  // themeFromVisual, which converts the portfolio catalog's [name, hex] pairs into exactly this
  // shape) -- render.js and the theme baked into index.html both expect palette[i] to be a hex
  // string, not a [name, hex] pair.
  const palette = Array.isArray(meta.palette) ? meta.palette : [];
  const events = Array.isArray(meta.events) ? meta.events : [];
  const actions = Array.isArray(meta.actions) ? meta.actions : [];
  const themeColor = palette[0] || "#000000";

  for (const [rel, content] of Object.entries(readKitStaticFiles())) writeBundleFile(outDir, rel, content);
  for (const key of GENERATED_KEYS) writeBundleFile(outDir, key, generated[key]);
  for (const key of ASSET_KEYS) writeBundleFile(outDir, key, assets[key]);

  const indexTemplate = readFileSync(join(HERE, "templates", "index.html"), "utf8");
  const themeJson = JSON.stringify({ palette, reducedMotion: false });
  const indexHtml = indexTemplate.replaceAll("{{NAME}}", name).replaceAll("{{SLUG}}", slug).replace("{{THEME_JSON}}", themeJson);
  writeBundleFile(outDir, "index.html", indexHtml);

  const icon192Size = pngSize(assets["assets/icon-192.png"]);
  const icon512Size = pngSize(assets["assets/icon-512.png"]);
  const manifestTemplate = readFileSync(join(HERE, "templates", "manifest.webmanifest"), "utf8");
  const manifest = manifestTemplate
    .replaceAll("{{NAME}}", name)
    .replaceAll("{{THEME_COLOR}}", themeColor)
    .replace("{{ICON_192_SIZE}}", `${icon192Size.width}x${icon192Size.height}`)
    .replace("{{ICON_512_SIZE}}", `${icon512Size.width}x${icon512Size.height}`);
  writeBundleFile(outDir, "manifest.webmanifest", manifest);

  const metaJson = { name, slug, versionName, buildId, subtitle, keywords, palette, analytics: events, actions, toolchain: "web-canvas", kit: KIT_VERSION };
  writeBundleFile(outDir, "game/meta.json", JSON.stringify(metaJson, null, 2));

  // sw.js precache is computed from everything written SO FAR (sw.js and build.json are, by
  // definition, never in their own precache list) -- write it before the final build.json pass.
  const filesBeforeSw = walkFiles(outDir).filter((f) => f !== "sw.js" && f !== "build.json").sort();
  const swTemplate = readFileSync(join(HERE, "templates", "sw.js"), "utf8");
  const sw = swTemplate.replace("{{PRECACHE_JSON}}", JSON.stringify(filesBeforeSw));
  writeBundleFile(outDir, "sw.js", sw);

  // build.json is written LAST: it hashes every other file, including sw.js.
  const allFiles = walkFiles(outDir).filter((f) => f !== "build.json").sort();
  const files = allFiles.map((f) => {
    const buf = readFileSync(join(outDir, ...f.split("/")));
    return { path: f, sha256: sha256(buf), size: buf.length };
  });
  const bundleSha256 = sha256(Buffer.from(files.map((f) => f.path + "\n" + f.sha256 + "\n").join(""), "utf8"));
  const buildJson = {
    buildId, versionName, bundleSha256, files,
    toolchain: { lane: "web-canvas", kit: KIT_VERSION, node: process.version },
    createdAt: new Date().toISOString(),
  };
  writeBundleFile(outDir, "build.json", JSON.stringify(buildJson, null, 2));
  return buildJson;
}

/**
 * verifyBundle(dir) -> { ok, bundleSha256, problems: [] }. Re-hashes every file in build.json
 * against the file on disk, recomputes bundleSha256 from files[], and checks sw.js's precache
 * list against the file list (minus sw.js and build.json).
 */
export function verifyBundle(dir) {
  const problems = [];
  let buildJson;
  try { buildJson = JSON.parse(readFileSync(join(dir, "build.json"), "utf8")); }
  catch (e) { return { ok: false, bundleSha256: "", problems: ["build.json missing or invalid: " + e.message] }; }

  const files = Array.isArray(buildJson.files) ? buildJson.files : [];
  for (const f of files) {
    const full = join(dir, ...String(f.path).split("/"));
    if (!existsSync(full)) { problems.push(`missing file: ${f.path}`); continue; }
    const buf = readFileSync(full);
    if (buf.length !== f.size) problems.push(`size mismatch for ${f.path}: expected ${f.size}, got ${buf.length}`);
    if (sha256(buf) !== f.sha256) problems.push(`sha256 mismatch for ${f.path}`);
  }
  const sortedFiles = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const recomputed = sha256(Buffer.from(sortedFiles.map((f) => f.path + "\n" + f.sha256 + "\n").join(""), "utf8"));
  if (recomputed !== buildJson.bundleSha256) problems.push("bundleSha256 does not match the recomputed hash of files[]");

  try {
    const swText = readFileSync(join(dir, "sw.js"), "utf8");
    const m = /^const\s+PRECACHE\s*=\s*(\[[\s\S]*?\]);\s*$/m.exec(swText);
    if (!m) problems.push("sw.js has no `const PRECACHE = [...]` list");
    else {
      const precache = JSON.parse(m[1]).slice().sort();
      const expected = files.map((f) => f.path).filter((p) => p !== "sw.js" && p !== "build.json").sort();
      if (JSON.stringify(precache) !== JSON.stringify(expected)) problems.push("sw.js precache does not equal the bundle file list");
    }
  } catch (e) { problems.push("sw.js missing or unreadable: " + e.message); }

  return { ok: problems.length === 0, bundleSha256: buildJson.bundleSha256 || "", problems };
}
