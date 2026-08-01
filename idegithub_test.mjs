/*
 * Ship to GitHub: the half of the git lane that never existed. Run: node idegithub_test.mjs
 *
 * Fred, 2026-08-01: "why can Dominion not create a GitHub repo?" Because nothing created one.
 * These pin the rules that make creating one on someone else's behalf safe:
 *   - PRIVATE unless explicitly told otherwise (a public mistake cannot be un-leaked)
 *   - REUSE an existing repo, never clobber it, and say which of the two happened
 *   - the token appears ONLY in the Authorization header, never in a result or a message
 *   - every failure is named so the engine can tell the user what to actually do about it
 *   - the whole path is wired into the build engine, which is the bug that started this
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureRepo, repoNameFrom, shipSummary, GITHUB_API } from "./idegithub.mjs";
import { githubPushPlan, mergePlan, buildBranch } from "./idegit.mjs";

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + ((e && e.message) || e)); }
}

// A fake GitHub. Records every request so the tests can assert on what was actually sent.
function fakeHub({ login = "fred", existing = null, createStatus = 201, userStatus = 200, throwOn = "" } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: (opts.method || "GET").toUpperCase(), headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    if (throwOn && String(url).includes(throwOn)) throw new Error("socket hang up");
    if (String(url).endsWith("/user")) {
      return { ok: userStatus < 400, status: userStatus, json: async () => (userStatus < 400 ? { login } : { message: "Bad credentials" }) };
    }
    if (/\/repos\//.test(String(url))) {
      if (existing) return { ok: true, status: 200, json: async () => existing };
      return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
    }
    if (String(url).endsWith("/user/repos")) {
      if (createStatus >= 400) return { ok: false, status: createStatus, json: async () => ({ message: "nope", errors: [{ message: "name already exists on this account" }] }) };
      const body = JSON.parse(opts.body);
      return { ok: true, status: createStatus, json: async () => ({ html_url: "https://github.com/" + login + "/" + body.name, private: body.private }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  return { impl, calls };
}

await t("a project name a human typed becomes a legal repo name", () => {
  assert.equal(repoNameFrom("Bird Counter"), "Bird-Counter");
  assert.equal(repoNameFrom("  My App!!  "), "My-App");
  assert.equal(repoNameFrom("a//b\\c"), "a-b-c");
  assert.equal(repoNameFrom("---"), "dominion-project", "an empty result falls back rather than sending garbage");
  assert.equal(repoNameFrom(""), "dominion-project");
  assert.ok(repoNameFrom("x".repeat(300)).length <= 100);
});

await t("a missing repo is CREATED, and private unless told otherwise", async () => {
  const hub = fakeHub();
  const r = await ensureRepo({ fetchImpl: hub.impl, token: "ghp_SECRET", name: "Bird Counter" });
  assert.ok(r.ok);
  assert.equal(r.created, true, "the caller must be able to say 'created' rather than 'pushed to'");
  assert.equal(r.owner, "fred");
  assert.equal(r.repo, "Bird-Counter");
  const create = hub.calls.find((c) => c.method === "POST");
  assert.equal(create.body.private, true, "PRIVATE is the default and the safe direction");
  assert.equal(create.body.auto_init, false, "an auto-init commit would fight the first push");
});

await t("public happens only when explicitly asked for", async () => {
  const hub = fakeHub();
  await ensureRepo({ fetchImpl: hub.impl, token: "t", name: "x", private: false });
  assert.equal(hub.calls.find((c) => c.method === "POST").body.private, false);
  const hub2 = fakeHub();
  await ensureRepo({ fetchImpl: hub2.impl, token: "t", name: "x", private: undefined });
  assert.equal(hub2.calls.find((c) => c.method === "POST").body.private, true, "undefined must mean private, never public");
});

await t("an existing repo is REUSED and never created over the top of", async () => {
  const hub = fakeHub({ existing: { html_url: "https://github.com/fred/Bird-Counter", private: true } });
  const r = await ensureRepo({ fetchImpl: hub.impl, token: "t", name: "Bird Counter" });
  assert.ok(r.ok);
  assert.equal(r.created, false, "reuse must be reported as reuse");
  assert.ok(!hub.calls.some((c) => c.method === "POST"), "nothing may be created when it already exists");
});

await t("the token rides ONLY in the Authorization header", async () => {
  const hub = fakeHub();
  const token = "ghp_DO_NOT_LEAK_ME";
  const r = await ensureRepo({ fetchImpl: hub.impl, token, name: "app" });
  assert.ok(JSON.stringify(r).indexOf(token) < 0, "the result must not carry the token");
  for (const c of hub.calls) {
    assert.equal(c.headers.authorization, "Bearer " + token);
    assert.ok(!c.url.includes(token), "never in a URL");
    assert.ok(!JSON.stringify(c.body || {}).includes(token), "never in a body");
  }
});

await t("every failure is named so the engine can say what to do about it", async () => {
  const noToken = await ensureRepo({ fetchImpl: fakeHub().impl, token: "", name: "x" });
  assert.equal(noToken.code, "no_token");
  const badToken = await ensureRepo({ fetchImpl: fakeHub({ userStatus: 401 }).impl, token: "t", name: "x" });
  assert.equal(badToken.code, "bad_token");
  const noScope = await ensureRepo({ fetchImpl: fakeHub({ createStatus: 403 }).impl, token: "t", name: "x" });
  assert.equal(noScope.code, "no_scope");
  const taken = await ensureRepo({ fetchImpl: fakeHub({ createStatus: 422 }).impl, token: "t", name: "x" });
  assert.equal(taken.code, "name_taken");
  const dead = await ensureRepo({ fetchImpl: fakeHub({ throwOn: "/user" }).impl, token: "t", name: "x" });
  assert.equal(dead.code, "unreachable");
  for (const r of [noToken, badToken, noScope, taken, dead]) {
    assert.ok(r.error && r.error.length > 10, "every failure carries a sentence a person can read");
    assert.ok(!r.ok);
  }
});

await t("the push plan can target main, which is what makes the repo look built", () => {
  const p = githubPushPlan({ root: "C:/p", jobId: "j1", owner: "fred", repo: "app", token: "tok", branch: "main" });
  assert.ok(p.cmds[0].includes(" main"), "main must be pushable, not only build/<jobid>");
  assert.equal(p.branch, "main");
  const d = githubPushPlan({ root: "C:/p", jobId: "j1", owner: "fred", repo: "app", token: "tok" });
  assert.equal(d.branch, buildBranch("j1"), "with no override it still pushes the job's own branch");
  const evil = githubPushPlan({ root: "C:/p", jobId: "j1", owner: "fred", repo: "app", token: "tok", branch: "main; rm -rf /" });
  assert.ok(!evil.cmds[0].includes(";"), "a branch name cannot smuggle a second command");
});

await t("the summary names the repository and tells created from reused", () => {
  const made = shipSummary({ owner: "fred", repo: "app", htmlUrl: "https://github.com/fred/app", created: true, branch: "build/j1", merged: true });
  assert.ok(/^Created fred\/app/.test(made));
  assert.ok(/private/.test(made));
  assert.ok(/merged it into main/.test(made));
  assert.ok(made.includes("https://github.com/fred/app"), "the link is the point");
  const reused = shipSummary({ owner: "fred", repo: "app", htmlUrl: "u", created: false, branch: "build/j1", merged: false });
  assert.ok(/^Pushed to fred\/app/.test(reused));
  assert.ok(!/merged/.test(reused), "an unmerged ship must not claim a merge");
});

/* ---- the wiring, which is the actual bug Fred reported -------------------------------------- */
const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const ideSrc = readFileSync(new URL("./ide.mjs", import.meta.url), "utf8");
const conn = readFileSync(new URL("./connectors.mjs", import.meta.url), "utf8");

await t("source: the build engine actually CALLS the push it has always imported", () => {
  assert.match(server, /async function shipToGithub\(\)/, "the ship step must exist");
  assert.match(server, /await ensureRepo\(\{/, "something must create the repository");
  const ship = server.slice(server.indexOf("async function shipToGithub()"), server.indexOf("async function salvage("));
  assert.match(ship, /githubPushPlan\(\{/, "the push plan must be CALLED, not merely imported");
  assert.match(ship, /mergePlan\(\{/, "a successful build merges into main");
  assert.match(ship, /branch: "main"/, "and main reaches the remote");
  assert.match(server, /shipped = await shipToGithub\(\)/, "the success path must run it");
});

await t("source: shipping is opt-in per project and never a global default", () => {
  assert.match(ideSrc, /const cleanShip = \(raw\)/, "the ship block is normalized, not stored raw");
  assert.match(ideSrc, /private: raw\.private !== false/, "private is the default at the store too");
  const ship = server.slice(server.indexOf("async function shipToGithub()"), server.indexOf("async function salvage("));
  assert.match(ship, /if \(!ship \|\| !ship\.github\) return null/, "off by default, checked first");
  assert.match(ship, /connectors\.secretFor\(T, "github", "token"\)/, "the USER'S own token, never a server one");
});

await t("source: a ship failure never turns a finished build into a failed one", () => {
  const ship = server.slice(server.indexOf("async function shipToGithub()"), server.indexOf("async function salvage("));
  for (const bail of ["is not a git repository", "no GitHub account is connected", "The push to "]) {
    assert.ok(ship.includes(bail), "the ship path must explain the bail-out: " + bail);
  }
  assert.match(ship, /return null;[\s\S]{0,400}The work is safe on branch/, "and must say the work survived");
  assert.match(server, /try \{ shipped = await shipToGithub\(\); \} catch/, "a throw here cannot fail the build");
});

await t("source: a refused merge never strands the working copy on a conflicted main", () => {
  const ship = server.slice(server.indexOf("async function shipToGithub()"), server.indexOf("async function salvage("));
  assert.match(ship, /merge --abort/, "a half-applied merge must be undone");
  assert.match(ship, /checkout ' \+ onGitBranch/, "and the person is put back on the branch holding their work");
  assert.match(ship, /Main could not be updated automatically/, "and told plainly, rather than silently");
});

await t("source: the credential accessor is narrow and runs the same wall as a tool call", () => {
  assert.match(conn, /function secretFor\(T, id, field\)/);
  assert.match(conn, /if \(!usable\(T, id\)\.ok\) return "";/, "the guest wall applies to the raw credential too");
  const body = conn.slice(conn.indexOf("function secretFor"), conn.indexOf("function secretFor") + 400);
  assert.ok(!/loadState|stateFile/.test(body), "it must not become a general way to sweep an account's state");
});

console.log("\nidegithub: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
