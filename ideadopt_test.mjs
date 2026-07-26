/*
 * Adopt Existing Project scan self-test. Run with: node ideadopt_test.mjs
 * Proves the wargame from docs/ADOPT-BUILD.md:
 *   W1  the walk never lists junk dirs and stays under the root it was given
 *   W2  every cap (dirs, files, per-read bytes, total bytes) holds against a monster tree
 *   W3  the brief only restates observed facts and says its read-only limits out loud
 *   W5  the brief never exceeds the chat sanitizer's clamp
 *   W6  an unreachable node reports offline instead of a raw throw
 * plus the stack/run detection the seeded planning depends on.
 */
import assert from "node:assert/strict";
import {
  createAdoptScanner, composeBrief,
  ADOPT_MAX_DIRS, ADOPT_MAX_FILES, ADOPT_MAX_READ_BYTES, ADOPT_MAX_TOTAL_BYTES, ADOPT_BRIEF_CHARS,
} from "./ideadopt.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); });
}

/*
 * A fake hands node over a nested plain object: subobjects are folders, strings are files.
 * Records every call so the tests can assert what the scan actually touched.
 */
function fakeHands(tree, { failOnCall = 0, refusePaths = [] } = {}) {
  const calls = [];
  const nodeAt = (path) => {
    const rel = path.replace(/^ROOT[\\/]?/, "");
    let cur = tree;
    for (const part of rel ? rel.split(/[\\/]+/) : []) {
      if (!cur || typeof cur !== "object" || !(part in cur)) return undefined;
      cur = cur[part];
    }
    return cur;
  };
  const hands = async (tool, args) => {
    calls.push({ tool, path: args.path });
    if (failOnCall && calls.length >= failOnCall) throw new Error("socket hung up");
    if (refusePaths.some((p) => args.path === p)) return { ok: false, refused: true, reason: "outside this node's allowed folders" };
    const node = nodeAt(args.path);
    if (tool === "fs_list") {
      if (node === undefined || typeof node === "string") return { ok: false, error: "not found: " + args.path };
      const entries = Object.entries(node).map(([name, v]) => ({
        name, type: typeof v === "object" ? "dir" : "file", size: typeof v === "string" ? v.length : null,
      }));
      return { ok: true, path: args.path, entries };
    }
    if (tool === "fs_read") {
      if (typeof node !== "string") return { ok: false, error: "not found: " + args.path };
      if (node.length > (args.maxBytes || Infinity)) return { ok: false, error: "file too big" };
      return { ok: true, path: args.path, bytes: node.length, text: node };
    }
    return { ok: false, error: "unknown tool " + tool };
  };
  hands.calls = calls;
  return hands;
}

const NODE_APP = {
  "package.json": JSON.stringify({ name: "half-app", main: "server.js",
    scripts: { start: "node server.js" }, dependencies: { express: "^4.18.0" } }),
  "package-lock.json": "{}",
  "README.md": "# Half App\nA start.",
  "server.js": "const app = require('express')();\n// TODO: wire the routes\napp.listen(3000);\n",
  "node_modules": { express: { "index.js": "should never be listed" } },
  ".git": { HEAD: "ref: refs/heads/main" },
  src: {
    "routes.js": "// FIXME: auth middleware\nmodule.exports = {};\n",
    "stub.js": "",
    "done.js": "exports.sum = (a, b) => a + b;\n",
  },
  tests: { "sum.test.js": "require('assert').equal(1, 1);\n" },
};

await t("happy path: a half-finished Express app is inventoried truthfully", async () => {
  const hands = fakeHands(NODE_APP);
  const r = await createAdoptScanner({ hands }).scan("ROOT");
  assert.equal(r.ok, true);
  const f = r.facts;
  assert.ok(f.frameworks.includes("Express"), "detects Express, got " + JSON.stringify(f.frameworks));
  assert.equal(f.runs.mode, "script");
  assert.match(f.runs.command, /npm run start/);
  assert.equal(f.depsInstalled, true, "node_modules presence means deps installed");
  assert.equal(f.git, true);
  assert.equal(f.readme, true);
  assert.equal(f.lockfile, true);
  assert.equal(f.tests.present, true);
  assert.ok(f.todos.count >= 2, "TODO + FIXME counted, got " + f.todos.count);
  assert.ok(f.stubs.some((s) => s.path === "src/stub.js"), "empty file surfaced as a stub");
  assert.ok(f.entries.some((e) => e.path === "server.js"), "entry point read");
});

await t("W1: junk dirs are never walked and never read", async () => {
  const hands = fakeHands(NODE_APP);
  await createAdoptScanner({ hands }).scan("ROOT");
  for (const c of hands.calls) {
    assert.ok(!/node_modules|\.git/i.test(c.path || ""), c.tool + " touched " + c.path);
    assert.ok(String(c.path).startsWith("ROOT"), "left the root: " + c.path);
  }
});

await t("W2: a monster tree stops at the dir and file caps and says truncated", async () => {
  const wide = {};
  for (let d = 0; d < 80; d++) {
    const dir = {};
    for (let i = 0; i < 40; i++) dir["f" + i + ".js"] = "x";
    wide["d" + String(d).padStart(2, "0")] = dir;
  }
  const hands = fakeHands(wide);
  const r = await createAdoptScanner({ hands }).scan("ROOT");
  assert.equal(r.ok, true);
  assert.ok(r.facts.counts.dirs <= ADOPT_MAX_DIRS, "dirs " + r.facts.counts.dirs);
  assert.ok(r.facts.counts.files <= ADOPT_MAX_FILES, "files " + r.facts.counts.files);
  assert.equal(r.facts.counts.truncated, true);
  const listCalls = hands.calls.filter((c) => c.tool === "fs_list").length;
  assert.ok(listCalls <= ADOPT_MAX_DIRS + 1, "fs_list spend " + listCalls);
  assert.match(composeBrief(r.facts), /at least /);
});

await t("W2: the total read budget holds even when every file is at the per-read cap", async () => {
  const big = "a".repeat(ADOPT_MAX_READ_BYTES - 1);
  const tree = { "package.json": JSON.stringify({ dependencies: { express: "1" }, scripts: { start: "node s.js" } }) };
  for (let i = 0; i < 40; i++) tree["s" + i + ".js"] = big;
  const hands = fakeHands(tree);
  await createAdoptScanner({ hands }).scan("ROOT");
  const reads = hands.calls.filter((c) => c.tool === "fs_read");
  // The budget admits the manifest plus a bounded number of big reads, never all forty.
  assert.ok(reads.length <= Math.ceil(ADOPT_MAX_TOTAL_BYTES / (ADOPT_MAX_READ_BYTES - 1)) + 8,
    "read calls " + reads.length);
});

await t("W6: an unreachable node is offline, said plainly", async () => {
  const hands = fakeHands(NODE_APP, { failOnCall: 1 });
  const r = await createAdoptScanner({ hands }).scan("ROOT");
  assert.equal(r.ok, false);
  assert.equal(r.offline, true);
  assert.match(r.error, /not reachable/);
});

await t("W6: a dispatcher that RETURNS a no-machine result (owner hub, seen live) is offline too", async () => {
  const hands = async () => ({ ok: false, error: "No machine is connected. Start your Dominion hands node on the computer you want to reach." });
  const r = await createAdoptScanner({ hands }).scan("ROOT");
  assert.equal(r.ok, false);
  assert.equal(r.offline, true, "connectivity-shaped ok:false must map to offline");
  assert.match(r.error, /No machine is connected/);
  // A genuinely missing folder is NOT offline: the path is wrong, the machine is fine.
  const hands2 = async () => ({ ok: false, error: "not found: C:/nope" });
  const r2 = await createAdoptScanner({ hands: hands2 }).scan("ROOT");
  assert.equal(r2.ok, false);
  assert.equal(!!r2.offline, false);
});

await t("a refused root surfaces the node's reason instead of a fake inventory", async () => {
  const hands = fakeHands(NODE_APP, { refusePaths: ["ROOT"] });
  const r = await createAdoptScanner({ hands }).scan("ROOT");
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.error, /allowed folders/);
});

await t("a connection drop mid-scan is admitted in the facts and the brief", async () => {
  const hands = fakeHands(NODE_APP, { failOnCall: 3 });
  const r = await createAdoptScanner({ hands }).scan("ROOT");
  assert.equal(r.ok, true, "a partial walk is still a walk");
  assert.match(r.facts.counts.aborted, /dropped mid-scan/);
  assert.match(composeBrief(r.facts), /Scan limits/);
});

await t("static site: index.html and no manifests still gets an honest verdict", async () => {
  const hands = fakeHands({ "index.html": "<h1>hi</h1>", "style.css": "body{}" });
  const r = await createAdoptScanner({ hands }).scan("ROOT");
  assert.equal(r.facts.runs.mode, "static");
  const brief = composeBrief(r.facts);
  assert.match(brief, /no framework I recognize/);
});

await t("a zero-dep repo with underscore tests is never told it lacks what it has (learned on this very repo)", async () => {
  const hands = fakeHands({
    "package.json": JSON.stringify({ name: "zerodep", scripts: { start: "node server.mjs" } }),
    "server.mjs": "export const x = 1;\n",
    "server_test.mjs": "import assert from 'node:assert';\n",
    ".git": { HEAD: "ref" },
    ".claude": { "launch.json": "{}" },
    docs: { "README-ish.md": "notes" },
  });
  const r = await createAdoptScanner({ hands }).scan("ROOT");
  const f = r.facts;
  assert.equal(f.tests.present, true, "_test.mjs naming counts as tests");
  assert.equal(f.declaresDeps, false);
  const brief = composeBrief(f);
  assert.ok(!brief.includes("dependencies not installed"), "zero declared deps means nothing is missing");
  assert.ok(!brief.includes("no lockfile"), "a lockfile for zero deps is not a gap");
  assert.ok(!f.topDirs.includes(".git") && !f.topDirs.includes(".claude"), "machinery dirs stay off the layout line");
  assert.ok(f.topDirs.includes("docs"));
});

await t("python app: requirements.txt names Flask", async () => {
  const hands = fakeHands({ "requirements.txt": "flask==3.0.0\nrequests\n", "app.py": "# TODO routes\n" });
  const r = await createAdoptScanner({ hands }).scan("ROOT");
  assert.ok(r.facts.frameworks.includes("Flask"), JSON.stringify(r.facts.frameworks));
});

await t("W3: the brief admits it read files without running them, and invites the plan", async () => {
  const hands = fakeHands(NODE_APP);
  const r = await createAdoptScanner({ hands }).scan("ROOT");
  const brief = composeBrief(r.facts, { name: "Half App" });
  assert.match(brief, /reading the files, not from running/);
  assert.match(brief, /What should it become\?/);
  assert.match(brief, /Half-built:/);
  assert.match(brief, /Missing:/);
});

await t("W5 + style: the brief fits the sanitizer and carries no em dashes", async () => {
  const facts = {
    root: "R", counts: { dirs: 5, files: 700, truncated: true },
    topDirs: Array.from({ length: 20 }, (_, i) => "a-very-long-directory-name-" + i),
    manifests: ["package.json"], frameworks: ["Next.js", "React"],
    runs: { mode: "script", command: "npm run dev", why: "package.json defines a dev script" },
    entries: Array.from({ length: 6 }, (_, i) => ({ path: "src/deeply/nested/entry-file-" + i + ".tsx", bytes: 900 })),
    git: false, readme: false, lockfile: false, depsInstalled: false, envExample: false,
    tests: { present: false },
    todos: { count: 400, files: Array.from({ length: 8 }, (_, i) => ({ path: "src/very/long/path/component-" + i + ".tsx", count: 50 })) },
    stubs: Array.from({ length: 8 }, (_, i) => ({ path: "src/stub-" + i + ".ts", reason: "says it is not implemented yet" })),
    languages: { tsx: 300, ts: 200, css: 100, js: 50, html: 20 },
  };
  const brief = composeBrief(facts, { name: "A ".repeat(30) });
  assert.ok(brief.length <= ADOPT_BRIEF_CHARS, "brief length " + brief.length);
  assert.ok(!brief.includes("—"), "no em dashes in product prose");
});

/* ============================================================================================
   The door and the voice. Source checks pin the server wiring the way guest_wall_test.mjs does
   (a wall nobody calls passes every behavioural test), and the intake/planchat checks prove the
   adopt voice reaches exactly the conversations that plan, never the ones that advise.
   ============================================================================================ */
import { readFileSync } from "node:fs";
import { intakeSystem, intakeMessages, planchatMessages, adoptVoice } from "./ideintake.mjs";

const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");

await t("W4 source: server.mjs wires /ide/adopt behind the wall, the invite check, and the beginner refusal", () => {
  assert.match(server, /import\s*\{[^}]*createAdoptScanner[^}]*\}\s*from\s*["']\.\/ideadopt\.mjs["']/,
    "server.mjs must import the scanner");
  assert.match(server, /path === "\/ide\/adopt"/, "the route must exist");
  const door = server.slice(server.indexOf('path === "/ide/adopt"'));
  assert.match(door.slice(0, 2200), /ideFeature\.wall\(T\)/, "the ide wall guards the door");
  assert.match(door.slice(0, 2200), /needs_invite/, "an access code is required for guests");
  assert.match(door.slice(0, 2200), /adopt_not_beginner/, "beginner mode is refused server-side");
  assert.match(door.slice(0, 2200), /not_found/, "an unknown workspace 404s");
});

await t("source: the heavy rate tier covers adopt (a scan spends dozens of hands calls)", () => {
  assert.match(server, /IDE_RL_HEAVY = \/[^\n]*\badopt\b/, "adopt must sit in the heavy tier regex");
});

await t("source: both conversation doors forward the adopt flag to the message builders", () => {
  assert.match(server, /intakeMessages\(\{[^}]*adopt: !!body\.adopt/, "/ide/intake forwards adopt");
  assert.match(server, /planchatMessages\(\{[^}]*adopt: !!body\.adopt/, "/ide/planchat forwards adopt");
});

await t("the adopt voice reaches the interviewer and the Main plan window only", () => {
  assert.ok(intakeSystem("hybrid", "vibe", "desktop", { adopt: true }).includes("ADOPTED PROJECT"));
  assert.ok(!intakeSystem("hybrid", "vibe", "desktop").includes("ADOPTED PROJECT"), "off by default");
  const main = planchatMessages({ window: "main", mode: "vibe", adopt: true, history: [] });
  assert.ok(main[0].content.includes("ADOPTED PROJECT"), "Main window gets the voice");
  const second = planchatMessages({ window: "second", mode: "vibe", adopt: true, history: [] });
  assert.ok(!second[0].content.includes("ADOPTED PROJECT"), "advisors keep their own job");
});

await t("the adopt voice touches intake only, never the review or stuck conversations", () => {
  for (const phase of ["review", "stuck"]) {
    const m = intakeMessages({ phase, adopt: true, history: [{ role: "user", content: "hi" }] });
    assert.ok(!m[0].content.includes("ADOPTED PROJECT"), phase + " must not carry it");
  }
  const m = intakeMessages({ phase: "intake", adopt: true, history: [{ role: "user", content: "hi" }] });
  assert.ok(m[0].content.includes("ADOPTED PROJECT"));
});

await t("the adopt voice demands the finish/fix/new tags and forbids invented progress", () => {
  const v = adoptVoice();
  for (const needle of ["[finish]", "[fix]", "[new]", "ground truth"]) {
    assert.ok(v.includes(needle), "voice must carry " + needle);
  }
  assert.ok(!v.includes("—"), "no em dashes in prompt prose");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
