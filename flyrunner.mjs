/*
 * Dominion AI — the build runner (Fred, 2026-07-30, choosing the isolated-container option because
 * "This needs to be shown to potential partners").
 *
 * WHAT PROBLEM THIS SOLVES. guestsandbox.mjs gives a visitor a real folder to write code into, and
 * refuses to RUN any of it, because the only machine available was this server — the one holding
 * the production database, every provider key, and every other tenant's files. Running a stranger's
 * npm install in there is not a risk worth taking for any feature. So the code ran nowhere, and a
 * build could write a project it could never test.
 *
 * This module borrows the project for one command. A throwaway virtual machine is created, the
 * project is shipped into it, the command runs, the results come back, and the machine is destroyed.
 * The guest's code never executes on the machine that matters, and two guests never share one.
 *
 * THE COST SHAPE, which drove the design. There is NO persistent volume and NO always-on worker:
 * the project lives on Dominion's own disk between builds and is carried in at job start. Fly bills
 * a Machine by the second while it runs and nothing at all while none exists, so an idle month
 * costs zero. The orchestration runs inside the Dominion server, which is already paid for. A
 * five-minute build on 1 shared CPU with 1GB is a fraction of a cent — around one percent of what
 * the same build costs in model tokens.
 *
 * WHAT IS DELIBERATELY NOT HERE. No credentials of any kind are passed into the machine: no
 * provider keys, no database URL, no hands token. A build that needs a secret should fail loudly
 * rather than borrow one. The machine gets the project, a command, and a clock.
 *
 * HONEST STATUS. Written against Fly's Machines API v1 and exercised end to end against a mock of
 * it (flyrunner_test.mjs), because this account has no Fly token yet. Everything stays dark until
 * FLY_API_TOKEN is set: with no token, available() is false and the workshop keeps refusing shell
 * exactly as it does today. Nothing changes for anyone until Fred provisions the app.
 */

const API = "https://api.machines.dev/v1";
const DEFAULT_IMAGE = "docker.io/library/node:24-slim";
const DEFAULT_CPUS = 1;
const DEFAULT_MEMORY_MB = 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const HARD_TIMEOUT_MS = 30 * 60 * 1000;     // nothing runs longer than this, ever
const MAX_IN_BYTES = 64 * 1024 * 1024;      // project shipped in
const MAX_OUT_BYTES = 64 * 1024 * 1024;     // results shipped back
const POLL_MS = 700;
const CREATE_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * The script the machine runs. It is deliberately dumb and deliberately noisy: unpack, run, capture
 * the exit code, pack whatever the command changed, and print a single marker line so the caller can
 * tell a real result from a machine that died mid-sentence. `set +e` around the user command is the
 * point — a failing build is a RESULT, not an error, and its exit code has to survive.
 */
function bootScript({ command, workdir, keepAliveSec }) {
  return [
    "set -e",
    "mkdir -p " + workdir,
    "tar -xzf /project.tar.gz -C " + workdir + " 2>/dev/null || true",
    "cd " + workdir,
    "set +e",
    "(" + command + ") > /tmp/out.log 2> /tmp/err.log",
    "CODE=$?",
    "set -e",
    // Exclude the noise nobody wants shipped back across the wire.
    "tar -czf /tmp/result.tar.gz -C " + workdir + " --exclude=node_modules --exclude=.git . 2>/dev/null || true",
    // The finish line, written LAST so its existence proves everything above it completed.
    "echo \"$CODE\" > /tmp/done",
    /*
     * Then stay alive to be read. THIS IS THE WHOLE REASON THE FIRST DESIGN FAILED (2026-07-30,
     * first live run): the build was the machine's init command, so the machine stopped the instant
     * it finished — and Fly's exec endpoint answers 412 "machine not running" on a stopped machine,
     * which is the only way to get a file back out. Every result came back empty against a mock that
     * happily replied to exec regardless of state. The machine now idles here until the caller has
     * read what it wants and destroys it; if the caller dies first, this sleep ends and auto_destroy
     * collects the machine, so the worst case is bounded minutes of billing rather than forever.
     */
    "sleep " + keepAliveSec,
  ].join("\n");
}

export function createFlyRunner({
  token = "",
  app = "",
  region = "iad",
  image = DEFAULT_IMAGE,
  cpus = DEFAULT_CPUS,
  memoryMb = DEFAULT_MEMORY_MB,
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  const enabled = !!(token && app);

  async function api(path, { method = "GET", body = null, timeoutMs = 30_000 } = {}) {
    const r = await fetchImpl(API + path, {
      method,
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) {
      const err = new Error("Fly API " + r.status + ": " + String((json && (json.error || json.message)) || text).slice(0, 300));
      err.status = r.status;
      throw err;
    }
    return json;
  }

  const destroy = async (id) => {
    if (!id) return;
    // force=true because a machine that is still running must still die; a leaked machine bills by
    // the second, which is the one failure mode that costs real money rather than a wasted request.
    try { await api(`/apps/${app}/machines/${id}?force=true`, { method: "DELETE", timeoutMs: 20_000 }); }
    catch (e) { log(`[runner] could not destroy machine ${id}: ${e && e.message}`); }
  };

  /*
   * One command, one machine, one lifetime. Returns an honest result in every case:
   *   { ok, exitCode, stdout, stderr, resultBase64, ms, machineId, timedOut? }
   * ok describes whether the RUN happened, not whether the command succeeded — a failing test suite
   * is ok:true with a nonzero exitCode, because that is a true fact about the project and the caller
   * needs to be able to tell it apart from "the machine never started".
   */
  async function run({ projectBase64 = "", command = "", timeoutMs = DEFAULT_TIMEOUT_MS, workdir = "/workspace", onLog = null } = {}) {
    if (!enabled) return { ok: false, error: "The build runner is not configured on this server.", unconfigured: true };
    const cmd = String(command || "").trim();
    if (!cmd) return { ok: false, error: "no command" };
    const inBytes = Buffer.byteLength(String(projectBase64 || ""), "base64");
    if (inBytes > MAX_IN_BYTES) {
      return { ok: false, error: `project is ${Math.round(inBytes / 1e6)}MB, over the ${Math.round(MAX_IN_BYTES / 1e6)}MB the runner will carry` };
    }
    const cap = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 5_000), HARD_TIMEOUT_MS);
    const started = Date.now();
    let id = "";
    try {
      // The machine is born with the project already inside it and its whole life written in its
      // start command, so there is no window where an idle machine sits waiting to be told what to
      // do. auto_destroy is the belt; the finally-block destroy below is the braces.
      const created = await api(`/apps/${app}/machines`, {
        method: "POST",
        timeoutMs: CREATE_TIMEOUT_MS,
        body: {
          region,
          config: {
            image,
            auto_destroy: true,
            restart: { policy: "no" },
            guest: { cpu_kind: "shared", cpus, memory_mb: memoryMb },
            // No env: the machine gets no secret of ours, on purpose.
            env: { DOMINION_SANDBOX: "1" },
            files: projectBase64 ? [{ guest_path: "/project.tar.gz", raw_value: projectBase64 }] : [],
            init: { cmd: ["/bin/sh", "-lc", bootScript({ command: cmd, workdir, keepAliveSec: Math.ceil(cap / 1000) + 120 })] },
          },
        },
      });
      id = (created && created.id) || "";
      if (!id) return { ok: false, error: "Fly did not return a machine id" };
      log(`[runner] machine ${id} started (${cpus} cpu / ${memoryMb}MB, cap ${Math.round(cap / 1000)}s)`);

      const deadline = started + cap;

      // First, the machine has to actually be running before anything can be asked of it.
      let state = "created";
      while (Date.now() < deadline) {
        let m = null;
        try { m = await api(`/apps/${app}/machines/${id}`, { timeoutMs: 15_000 }); }
        catch (e) { if (e.status === 404) { state = "gone"; break; } throw e; }
        state = (m && m.state) || state;
        if (state === "started" || state === "stopped" || state === "failed" || state === "destroyed") break;
        await sleep(POLL_MS);
      }
      if (state === "failed" || state === "gone" || state === "destroyed") {
        return { ok: false, machineId: id, ms: Date.now() - started, error: "the build machine did not start" };
      }

      /*
       * Then wait for the FINISH FILE, not for the machine to stop. The machine deliberately idles
       * after the build so it can still be read; watching its state would therefore wait forever.
       * /tmp/done is written last and holds the exit code, so its appearance is proof the command
       * ran to completion rather than a guess from the outside.
       */
      let doneRaw = "";
      while (Date.now() < deadline) {
        const d = await readFile(id, "/tmp/done", 32);
        doneRaw = String(d.text || "").trim();
        if (doneRaw) break;
        if (onLog) { try { onLog({ state: "running", ms: Date.now() - started }); } catch {} }
        await sleep(POLL_MS);
      }
      if (!doneRaw) {
        return { ok: false, timedOut: true, machineId: id, ms: Date.now() - started,
                 error: `the build ran past its ${Math.round(cap / 1000)}s limit and was stopped` };
      }

      // Everything the run produced, read off the still-running machine before it is destroyed.
      const outs = await Promise.all([
        readFile(id, "/tmp/out.log", 400_000),
        readFile(id, "/tmp/err.log", 400_000),
        readFile(id, "/tmp/result.tar.gz", MAX_OUT_BYTES, true),
      ]);
      const parsedCode = Number(doneRaw);
      return {
        ok: true,
        exitCode: Number.isFinite(parsedCode) ? parsedCode : null,
        stdout: outs[0].text || "",
        stderr: outs[1].text || "",
        resultBase64: outs[2].base64 || "",
        machineId: id,
        ms: Date.now() - started,
      };
    } catch (e) {
      return { ok: false, machineId: id, ms: Date.now() - started, error: String((e && e.message) || e) };
    } finally {
      await destroy(id);
    }
  }

  // Fly exposes no file-read endpoint, so the machine reads its own file out through exec. Base64 so
  // a tarball survives the trip; capped so a runaway log cannot be used to exhaust this process.
  async function readFile(id, path, maxBytes, wantBase64 = false) {
    try {
      const r = await api(`/apps/${app}/machines/${id}/exec`, {
        method: "POST", timeoutMs: 60_000,
        body: { command: ["/bin/sh", "-lc", `[ -f ${path} ] && head -c ${maxBytes} ${path} | base64 -w0 || true`], timeout: 55 },
      });
      const b64 = String((r && (r.stdout ?? r.StdOut)) || "").trim();
      if (!b64) return wantBase64 ? { base64: "" } : { text: "" };
      return wantBase64 ? { base64: b64 } : { text: Buffer.from(b64, "base64").toString("utf8") };
    } catch (e) {
      log(`[runner] could not read ${path} from ${id}: ${e && e.message}`);
      return wantBase64 ? { base64: "" } : { text: "" };
    }
  }

  return {
    available: () => enabled,
    app, region, image, cpus, memoryMb,
    run,
    // Exposed for the health sweep: a leaked machine is the one failure that bills by the second.
    async listMachines() {
      if (!enabled) return [];
      try { return (await api(`/apps/${app}/machines`, { timeoutMs: 20_000 })) || []; } catch { return []; }
    },
    async reap(olderThanMs = HARD_TIMEOUT_MS) {
      if (!enabled) return { checked: 0, destroyed: 0 };
      const list = await this.listMachines();
      let destroyed = 0;
      for (const m of list) {
        const age = Date.now() - new Date(m.created_at || m.createdAt || 0).getTime();
        if (age > olderThanMs) { await destroy(m.id); destroyed++; }
      }
      return { checked: list.length, destroyed };
    },
  };
}
