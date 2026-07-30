/*
 * Dominion AI — the guest workshop (Fred, 2026-07-30).
 *
 * THE FAILURE THIS FIXES. The Crucible reaches a real folder through a hands node, and a hands node
 * is a program the OWNER installs on his own machines. A guest has no such program, so every guest
 * hit the same wall: no folder to pick, "New app" did nothing, and Adopt reported that the node was
 * "asleep or off" — an accurate sentence about a node that was never going to exist. Fred's ruling:
 * "All guests should be able to choose a folder on their own machine, if we need to set up some
 * kind of virtual sandbox temporarily, we can."
 *
 * WHAT THIS IS. A per-guest folder tree on the SERVER's own disk, presented through exactly the
 * hands tool surface the Crucible already speaks, so nothing upstream needs to know whether a call
 * landed on a laptop in Fred's office or in a directory beside the database. One guest, one root,
 * enforced on every single call by realpath containment rather than by string prefix, because a
 * symlink is a string that lies.
 *
 * WHAT IT DELIBERATELY IS NOT. It does not run shell commands. The server container holds the
 * production database, every provider key, and every other tenant's data; handing model-authored
 * shell a foothold in it is a decision with a blast radius far past one guest's project, and it is
 * Fred's to make deliberately rather than mine to slip in under a UI fix. shell_run therefore
 * returns an honest, specific refusal, and the surfaces that need it say what is missing instead of
 * blaming an absent node. Preview hosting and browser control are refused for the same reason.
 *
 * THE HONEST LIMIT, stated plainly to the user elsewhere: this is a workshop on Dominion's server,
 * not on the guest's own computer. Files written here are real and downloadable; they are not
 * sitting in the guest's Documents folder. A guest who wants that installs the node like the owner.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  mkdirSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync,
  realpathSync, rmSync, renameSync,
} from "node:fs";
import { join, resolve, dirname, sep, normalize } from "node:path";
import { packGz, unpackGz, safeEntryPath } from "./tarlite.mjs";

const MAX_READ_BYTES = 2_000_000;
const MAX_ENTRIES = 500;
const MAX_TREE_LINES = 800;
const MAX_UID = 64;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const refuse = (reason) => ({ ok: false, refused: true, error: reason, reason });

/*
 * Containment. Every path a caller supplies is resolved against the guest's root and then checked
 * with the REAL path of its nearest existing ancestor, so a symlink planted inside the sandbox
 * cannot walk out of it. A path that escapes is refused, never clamped: silently rewriting a
 * caller's path to something else is how a "safe" sandbox writes the wrong file.
 */
function contain(root, raw) {
  const want = String(raw == null ? "" : raw).trim().replace(/^["'“”]+|["'“”]+$/g, "");
  if (!want) return { ok: false, error: "a path is required" };
  // Accept both an absolute path inside the sandbox and a path relative to the guest's root, since
  // the model is told the absolute one but a client may still send a bare name.
  const abs = normalize(want.startsWith(root) ? want : resolve(root, want.replace(/^[/\\]+/, "")));
  let probe = abs, realRoot;
  try { realRoot = realpathSync(root); } catch { realRoot = root; }
  while (probe && !existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let realProbe = probe;
  try { realProbe = realpathSync(probe); } catch {}
  const inside = (p) => p === realRoot || p.startsWith(realRoot + sep);
  if (!inside(realProbe)) return { ok: false, error: "that path is outside your workshop" };
  return { ok: true, path: abs };
}

export function createGuestSandbox({ rootDir, log = () => {}, runner = null } = {}) {
  if (!rootDir) throw new Error("createGuestSandbox needs a rootDir");
  /*
   * No dots. A uid is hex in production, so nothing legitimate is lost, and allowing them meant a
   * uid of ".." scrubbed to ".." and joined to the PARENT of the whole workshop directory — an
   * escape hatch sitting in the one function whose entire job is that there is no escape hatch.
   * Caught by the test that walks the scrubber rather than by reading the regex and nodding.
   */
  const safeUid = (uid) => String(uid || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, MAX_UID);

  // One root per guest, created on first touch. Kept out of the caller's hands: a guest cannot name
  // this directory, so no uid can ever address another's.
  function rootFor(uid) {
    const u = safeUid(uid);
    if (!u) return "";
    const dir = join(rootDir, u);
    try { mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
  }

  function nodeInfo(root) {
    const canRun = !!(runner && runner.available());
    return {
      ok: true, node: "workshop", host: "dominion-workshop",
      // A workshop that CAN run commands runs them on Linux, whatever this server happens to be, so
      // callers writing shell (ideengine's snapshot and verify) must not read Windows into it.
      platform: canRun ? "linux" : process.platform,
      roots: [root], sandbox: true, shell: canRun, protectedDirs: 0,
      // Named so a model reading its own environment description cannot mistake this for the
      // owner's machine and promise things it has no way to do here.
      note: "A server-side workshop for this account. Files are real; there is no shell, no preview host, and no access to the visitor's own computer.",
      version: "workshop/1",
    };
  }

  const NO_SHELL = "This account builds in a server-side workshop, which has no command line. "
    + "File work (reading, writing, and organising the project) works normally; anything that needs to RUN "
    + "a command — installing packages, running tests, starting a dev server — needs a Dominion node "
    + "installed on your own computer.";

  /*
   * The dispatcher. Same shape as handsHub.dispatch's result so every caller upstream is unchanged:
   * { ok, ...payload } on success, { ok:false, error } on failure, { refused:true } when a rule said no.
   */
  function dispatch(uid) {
    const root = rootFor(uid);
    return async (tool, args = {}) => {
      if (!root) return { ok: false, error: "This account has no workshop." };
      const a = args || {};
      try {
        switch (tool) {
          case "node_info": return nodeInfo(root);

          // The picker. With no path it offers the workshop root itself, which is what makes a
          // folder choosable at all for someone with no machine attached.
          case "fs_browse": {
            if (!a.path) return { ok: true, path: root, dirs: listDirs(root, root) };
            const c = contain(root, a.path);
            if (!c.ok) return refuse(c.error);
            if (!existsSync(c.path)) return { ok: false, error: "not found: " + c.path };
            return { ok: true, path: c.path, dirs: listDirs(c.path, root) };
          }

          // Creating the folder a new project lives in. The picker's "new folder" and the
          // Crucible's "new app" both land here.
          case "fs_mkdir": {
            const c = contain(root, a.path);
            if (!c.ok) return refuse(c.error);
            mkdirSync(c.path, { recursive: true });
            return { ok: true, path: c.path, created: true };
          }

          case "fs_list": {
            const c = contain(root, a.path);
            if (!c.ok) return refuse(c.error);
            if (!existsSync(c.path)) return { ok: false, error: "not found: " + c.path };
            const entries = readdirSync(c.path, { withFileTypes: true }).slice(0, MAX_ENTRIES).map((e) => {
              let size = null;
              try { if (e.isFile()) size = statSync(join(c.path, e.name)).size; } catch {}
              return { name: e.name, type: e.isDirectory() ? "dir" : "file", size };
            });
            return { ok: true, path: c.path, entries };
          }

          case "fs_tree": {
            const c = contain(root, a.path);
            if (!c.ok) return refuse(c.error);
            const depth = Math.min(Math.max(Number(a.depth) || 3, 1), 6);
            const lines = [];
            const walk = (dir, pre, d) => {
              if (d > depth || lines.length >= MAX_TREE_LINES) return;
              let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
              for (const e of ents) {
                if (lines.length >= MAX_TREE_LINES) return;
                lines.push(pre + e.name + (e.isDirectory() ? "/" : ""));
                if (e.isDirectory()) walk(join(dir, e.name), pre + "  ", d + 1);
              }
            };
            walk(c.path, "", 1);
            return { ok: true, path: c.path, tree: lines, truncated: lines.length >= MAX_TREE_LINES };
          }

          // Paged reads, byte-for-byte the same contract the real node offers, so the adopt scanner
          // and the analysis pass page through a large file here exactly as they do on a machine.
          case "fs_read": {
            const c = contain(root, a.path);
            if (!c.ok) return refuse(c.error);
            if (!existsSync(c.path)) return { ok: false, error: "not found: " + c.path };
            const st = statSync(c.path);
            if (st.isDirectory()) return { ok: false, error: "that is a directory — use fs_list" };
            const max = Math.min(Number(a.maxBytes) || MAX_READ_BYTES, 20_000_000);
            if (a.partial === true || a.offset != null) {
              const offset = Math.max(0, Math.min(Math.floor(Number(a.offset) || 0), st.size));
              const want = Math.max(0, Math.min(max, st.size - offset));
              const whole = readFileSync(c.path);
              const page = whole.subarray(offset, offset + want);
              const nextOffset = offset + page.length;
              const base = { ok: true, path: c.path, bytes: page.length, offset, nextOffset,
                             totalBytes: st.size, eof: nextOffset >= st.size };
              return a.base64 ? { ...base, base64: page.toString("base64") } : { ...base, text: page.toString("utf8") };
            }
            if (st.size > max) return { ok: false, error: `file is ${st.size} bytes (> ${max} cap)` };
            const buf = readFileSync(c.path);
            return a.base64
              ? { ok: true, path: c.path, bytes: buf.length, base64: buf.toString("base64") }
              : { ok: true, path: c.path, bytes: buf.length, text: buf.toString("utf8") };
          }

          case "fs_write": {
            const c = contain(root, a.path);
            if (!c.ok) return refuse(c.error);
            const buf = a.base64 ? Buffer.from(String(a.content || ""), "base64")
                                 : Buffer.from(String(a.content ?? ""), "utf8");
            let before = null;
            try { if (existsSync(c.path)) before = readFileSync(c.path); } catch {}
            const beforeHash = before ? sha256(before) : null;
            const afterHash = sha256(buf);
            if (before && before.equals(buf)) {
              return { ok: true, path: c.path, bytes: buf.length, changed: false, beforeHash, afterHash };
            }
            mkdirSync(dirname(c.path), { recursive: true });
            writeFileSync(c.path, buf);
            return { ok: true, path: c.path, bytes: buf.length, changed: true, beforeHash, afterHash };
          }

          case "fs_append": {
            const c = contain(root, a.path);
            if (!c.ok) return refuse(c.error);
            const add = Buffer.from(String(a.content ?? ""), "utf8");
            const before = existsSync(c.path) ? readFileSync(c.path) : Buffer.alloc(0);
            mkdirSync(dirname(c.path), { recursive: true });
            writeFileSync(c.path, Buffer.concat([before, add]));
            return { ok: true, path: c.path, bytes: before.length + add.length, changed: true };
          }

          // Exact-string replacement, same contract as the node: a find that does not appear, or
          // appears more than once, is refused rather than guessed at.
          case "fs_edit": {
            const c = contain(root, a.path);
            if (!c.ok) return refuse(c.error);
            if (!existsSync(c.path)) return { ok: false, error: "not found: " + c.path };
            const text = readFileSync(c.path, "utf8");
            const find = String(a.find ?? "");
            if (!find) return { ok: false, error: "fs_edit needs the exact text to replace" };
            const first = text.indexOf(find);
            if (first < 0) return { ok: false, error: "that exact text does not appear in the file" };
            if (!a.all && text.indexOf(find, first + find.length) >= 0) {
              return { ok: false, error: "that text appears more than once — pass all:true or use a longer, unique excerpt" };
            }
            const next = a.all ? text.split(find).join(String(a.replace ?? "")) : text.replace(find, String(a.replace ?? ""));
            writeFileSync(c.path, next, "utf8");
            return { ok: true, path: c.path, bytes: Buffer.byteLength(next), changed: next !== text,
                     beforeHash: sha256(Buffer.from(text)), afterHash: sha256(Buffer.from(next)) };
          }

          case "fs_delete": {
            const c = contain(root, a.path);
            if (!c.ok) return refuse(c.error);
            if (c.path === root) return refuse("the workshop root itself is not deletable");
            if (!existsSync(c.path)) return { ok: true, path: c.path, changed: false };
            rmSync(c.path, { recursive: true, force: true });
            return { ok: true, path: c.path, changed: true };
          }

          case "fs_move": {
            const from = contain(root, a.from || a.path), to = contain(root, a.to);
            if (!from.ok) return refuse(from.error);
            if (!to.ok) return refuse(to.error);
            mkdirSync(dirname(to.path), { recursive: true });
            renameSync(from.path, to.path);
            return { ok: true, from: from.path, to: to.path, changed: true };
          }

          /*
           * A REAL restore point without a shell. The engine's rule is that no rollback path means
           * no write, and it earns that rule by refusing to build otherwise — so the workshop has
           * to offer a genuine one rather than a promise. This copies the project tree beside
           * itself, skipping the snapshot folder and dependency dumps, and refuses honestly if the
           * project is larger than a copy should be rather than filling the disk quietly.
           */
          case "fs_snapshot": {
            const c = contain(root, a.path);
            if (!c.ok) return refuse(c.error);
            if (!existsSync(c.path)) return { ok: false, error: "not found: " + c.path };
            const stamp = String(a.stamp || randomUUID().slice(0, 10)).replace(/[^a-z0-9_-]/gi, "");
            const dest = join(c.path, ".dominion-snapshots", stamp);
            const SKIP = new Set([".dominion-snapshots", "node_modules", ".git", ".next", "dist", "build"]);
            let files = 0, bytes = 0;
            const MAX_FILES = 4000, MAX_BYTES = 80 * 1024 * 1024;
            const copy = (from, to) => {
              let ents; try { ents = readdirSync(from, { withFileTypes: true }); } catch { return; }
              for (const e of ents) {
                if (SKIP.has(e.name)) continue;
                const src = join(from, e.name), dst = join(to, e.name);
                if (e.isDirectory()) { mkdirSync(dst, { recursive: true }); copy(src, dst); continue; }
                if (!e.isFile()) continue;
                let st; try { st = statSync(src); } catch { continue; }
                files++; bytes += st.size;
                if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error("project too large to snapshot in the workshop");
                mkdirSync(dirname(dst), { recursive: true });
                writeFileSync(dst, readFileSync(src));
              }
            };
            mkdirSync(dest, { recursive: true });
            copy(c.path, dest);
            return { ok: true, path: dest, files, bytes, kind: "copy" };
          }

          case "set_roots":
            // The root is not the caller's to choose here; say so rather than pretend it changed.
            return { ok: true, roots: [root], dropped: 0, fixed: true };

          // Everything that needs a real machine. Named individually so the message can be specific
          // about what is missing instead of the old "your node is asleep or off", which described
          // a node the visitor never had.
          /*
           * A command runs in a THROWAWAY machine, never here. The project is carried out, the
           * command runs somewhere expendable, whatever it changed is carried back, and the machine
           * is destroyed (flyrunner.mjs). With no runner configured this is the honest refusal it
           * has always been, so the feature is dark until Fred provisions it.
           */
          case "shell_run": {
            if (!runner || !runner.available()) return refuse(NO_SHELL);
            const cwd = a.cwd || a.path || root;
            const c = contain(root, cwd);
            if (!c.ok) return refuse(c.error);
            // root travels explicitly: runRemote is a sibling of dispatch(), not a closure inside
            // it, and the first draft read a `root` that was not in its scope.
            const out = await runRemote(root, c.path, String(a.command || ""), Number(a.timeoutMs) || 0);
            return out;
          }
          case "preview_fetch":
          case "browser_control":
          case "desktop_control":
            return refuse("Previewing a running app needs a Dominion node on your own computer. The workshop can write and read the project's files, but it cannot run it.");
          case "claude_code":
            return refuse(NO_SHELL);

          default:
            return { ok: false, error: "The workshop does not support " + String(tool || "that") + "." };
        }
      } catch (e) {
        log(`[workshop] ${tool} failed for ${safeUid(uid)}: ${e && e.message}`);
        return { ok: false, error: String((e && e.message) || e) };
      }
    };
  }

  /*
   * Carry a project out to a throwaway machine, run one command, carry the changes back.
   *
   * The write-back is the delicate half: those bytes were produced by a machine that just executed
   * a stranger's code, so every path is re-checked against BOTH the archive rule (no absolute, no
   * traversal) and the workshop's own containment before a single byte lands. Deletions are not
   * mirrored: a command that removes a file leaves it here, because letting remote output delete
   * local work is a much worse failure than a stale file, and the snapshot exists for the rest.
   */
  async function runRemote(root, cwd, command, timeoutMs) {
    if (!command.trim()) return { ok: false, error: "empty command" };
    let entries;
    try { entries = collect(cwd); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

    const r = await runner.run({
      projectBase64: packGz(entries).toString("base64"),
      command,
      timeoutMs: timeoutMs || undefined,
    });
    if (!r || r.ok === false) {
      return { ok: false, error: (r && r.error) || "The build machine could not be reached.",
               timedOut: !!(r && r.timedOut), stdout: "", stderr: "" };
    }

    let wrote = 0, rejected = 0;
    if (r.resultBase64) {
      let back = [];
      try { back = unpackGz(Buffer.from(r.resultBase64, "base64")); }
      catch (e) { log(`[workshop] unreadable result archive: ${e && e.message}`); }
      for (const ent of back) {
        if (ent.dir) continue;
        const rel = safeEntryPath(ent.name);
        if (!rel) { rejected++; continue; }
        const dest = contain(root, join(cwd, rel));
        if (!dest.ok) { rejected++; continue; }
        try { mkdirSync(dirname(dest.path), { recursive: true }); writeFileSync(dest.path, ent.data); wrote++; }
        catch { rejected++; }
      }
      if (rejected) log(`[workshop] ${rejected} result path(s) refused on the way back in`);
    }
    // shell_run's established shape, so callers that read code/stdout/stderr need no special case.
    return { ok: r.exitCode === 0, code: r.exitCode, stdout: r.stdout || "", stderr: r.stderr || "",
             ms: r.ms, filesWritten: wrote, filesRejected: rejected, sandboxRun: true };
  }

  // The project as tar entries, skipping what should never ride the wire.
  function collect(dir) {
    const SKIP = new Set([".dominion-snapshots", "node_modules", ".git", ".next", "dist", "build"]);
    const MAX_FILES = 4000, MAX_BYTES = 48 * 1024 * 1024;
    const out = [];
    let bytes = 0;
    const walk = (from, rel) => {
      let ents; try { ents = readdirSync(from, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (SKIP.has(e.name)) continue;
        const src = join(from, e.name), r = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) { out.push({ name: r, dir: true }); walk(src, r); continue; }
        if (!e.isFile()) continue;
        let st; try { st = statSync(src); } catch { continue; }
        bytes += st.size;
        if (out.length > MAX_FILES || bytes > MAX_BYTES) throw new Error("project is too large to run in the workshop");
        out.push({ name: r, data: readFileSync(src) });
      }
    };
    walk(dir, "");
    return out;
  }

  function listDirs(dir, root) {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return ents
      .filter((e) => { try { return e.isDirectory(); } catch { return false; } })
      .map((e) => e.name)
      .filter((n) => !n.startsWith("."))
      .slice(0, MAX_ENTRIES)
      .map((n) => ({ name: n, path: join(dir, n) }))
      .filter((d) => contain(root, d.path).ok);
  }

  return {
    enabled: true,
    rootDir,
    rootFor,
    dispatch,
    // A fresh project folder, name-collision-safe, returned as the absolute path a workspace stores.
    newProjectDir(uid, name) {
      const root = rootFor(uid);
      if (!root) return { ok: false, error: "This account has no workshop." };
      const base = String(name || "").trim().replace(/[^A-Za-z0-9 ._-]/g, "").replace(/\s+/g, "-").slice(0, 48)
        || ("project-" + randomUUID().slice(0, 6));
      let dir = join(root, base), n = 2;
      while (existsSync(dir)) { dir = join(root, base + "-" + n); n++; if (n > 200) return { ok: false, error: "too many folders with that name" }; }
      try { mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      return { ok: true, path: dir, name: base };
    },
  };
}
