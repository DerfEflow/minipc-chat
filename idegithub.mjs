/*
 * Dominion Works: the GitHub half of the git lane.
 *
 * WHY THIS FILE EXISTS. Fred, 2026-08-01: "why can Dominion not create a GitHub repo?" It could
 * not because nobody ever wrote this. `idegit.mjs` plans the push and says so in its own comment,
 * that the remote is "created via the connector's API by the caller before this runs", and there
 * was no caller. `githubPushPlan()` sat fully written, unit-tested, imported by the engine and
 * never called. A build therefore cut branch build/<jobid>, committed the real work onto it, and
 * stopped on a local disk with no remote. To the person who asked for an app, that is a failed
 * build, and it is exactly what happened to TruSignal.
 *
 * WHAT IT DOES. One job: make sure a repository exists to push into, using the account's OWN
 * GitHub token from their connector. It never pushes (that is idegit's masked command plan, run
 * through the hands node) and it never writes to a repository's contents.
 *
 * THE RULES IT KEEPS.
 *   1. PRIVATE unless the person explicitly chose public. A repo created private by mistake is a
 *      one-line fix; a repo created public by mistake cannot be un-leaked.
 *   2. NEVER create over the top of something. An existing repo of that name is REUSED, and the
 *      answer says which of the two happened, because "we made you a repo" and "we pushed into the
 *      repo you already had" are different facts.
 *   3. The token appears in exactly one place, the Authorization header. It is never returned,
 *      never logged, and never interpolated into a message.
 *   4. `fetchImpl` is injected so the whole module tests with no network and no credential.
 */

export const GITHUB_API = "https://api.github.com";

/*
 * A GitHub repository name from a project name a human typed. GitHub accepts letters, digits,
 * dot, dash and underscore; everything else becomes a dash. Leading/trailing dashes and runs are
 * collapsed because "My App!! " should become "my-app", not "my-app---".
 */
export function repoNameFrom(name, fallback = "dominion-project") {
  const cleaned = String(name || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 100);
  return cleaned || fallback;
}

const bad = (r, fallback) => {
  const msg = (r && (r.message || r.error)) || fallback;
  return String(msg).slice(0, 300);
};

/*
 * Make sure `owner/repo` exists and is reachable with this token. Returns, on success:
 *   { ok, owner, repo, htmlUrl, created, private }
 * `created` is the fact the caller reports to the user. On failure: { error, code }.
 *
 * `code` values the caller can act on:
 *   no_token        nothing to authenticate with (connector not linked)
 *   bad_token       GitHub rejected the credential
 *   no_scope        the token authenticated but may not create repositories
 *   name_taken      a repo of that name exists and this token cannot see or use it
 *   unreachable     the network or the API failed
 */
export async function ensureRepo({ fetchImpl, token, name, description = "", private: wantPrivate = true } = {}) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { error: "No way to reach GitHub from this server.", code: "unreachable" };
  if (!token) return { error: "No GitHub account is connected, so there is nowhere to push.", code: "no_token" };

  const repo = repoNameFrom(name);
  const headers = {
    authorization: "Bearer " + token,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "dominion-works",
  };

  // 1. Who is this token? The login is the owner of anything we create.
  let owner = "";
  try {
    const r = await doFetch(GITHUB_API + "/user", { headers });
    if (r.status === 401 || r.status === 403) {
      return { error: "GitHub refused that account's token. Reconnect GitHub in Setup.", code: "bad_token" };
    }
    const j = await r.json().catch(() => ({}));
    owner = String((j && j.login) || "");
    if (!owner) return { error: "GitHub did not say who that token belongs to.", code: "bad_token" };
  } catch (e) {
    return { error: "GitHub could not be reached: " + bad(e, "network error"), code: "unreachable" };
  }

  // 2. Does it already exist? Reuse beats create, and a 404 here is the ordinary case.
  try {
    const r = await doFetch(GITHUB_API + "/repos/" + owner + "/" + repo, { headers });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      return { ok: true, owner, repo, htmlUrl: String(j.html_url || ("https://github.com/" + owner + "/" + repo)),
        created: false, private: j.private !== false };
    }
    if (r.status !== 404) {
      const j = await r.json().catch(() => ({}));
      return { error: "GitHub would not open " + owner + "/" + repo + ": " + bad(j, "status " + r.status), code: "name_taken" };
    }
  } catch (e) {
    return { error: "GitHub could not be reached: " + bad(e, "network error"), code: "unreachable" };
  }

  // 3. Create it. PRIVATE unless the person asked otherwise; see rule 1 above.
  try {
    const r = await doFetch(GITHUB_API + "/user/repos", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        name: repo,
        private: wantPrivate !== false,
        description: String(description || "").slice(0, 350),
        auto_init: false,        // an auto-init commit would fight the first push
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) {
      return { error: "That GitHub token cannot create repositories. It needs repo-creation permission.", code: "no_scope" };
    }
    if (r.status === 422) {
      return { error: "GitHub refused the name \"" + repo + "\": " + bad((j.errors && j.errors[0]) || j, "already exists"), code: "name_taken" };
    }
    if (!r.ok) return { error: "GitHub refused to create the repository: " + bad(j, "status " + r.status), code: "unreachable" };
    return { ok: true, owner, repo, htmlUrl: String(j.html_url || ("https://github.com/" + owner + "/" + repo)),
      created: true, private: j.private !== false };
  } catch (e) {
    return { error: "GitHub could not be reached: " + bad(e, "network error"), code: "unreachable" };
  }
}

/*
 * What the user is told after a ship. Written here so the engine, the tests and any future surface
 * say the same thing, and so the sentence names the repository rather than a git ref.
 */
export function shipSummary({ owner, repo, htmlUrl, created, branch, merged }) {
  const where = htmlUrl || ("https://github.com/" + owner + "/" + repo);
  return (created ? "Created " : "Pushed to ") + owner + "/" + repo +
    (created ? " (private) and pushed " : " on ") + branch +
    (merged ? ", then merged it into main" : "") + ". " + where;
}
