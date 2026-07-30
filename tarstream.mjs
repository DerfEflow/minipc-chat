/*
 * Dominion AI — a STREAMING tar packer, for archives too big to hold in memory.
 *
 * WHY THIS EXISTS SEPARATELY FROM tarlite.mjs. tarlite builds a whole archive as one Buffer, which
 * is exactly right for its job: shipping a small code project into a build machine. The volume
 * backup is a different animal. /data is already 1.03GB of a 5GB disk and grows with every customer,
 * and a Railway container that tries to hold a gigabyte of archive in RAM does not throw a helpful
 * error, it gets killed. A backup that only works while the data is small is not a backup, because
 * it fails silently at exactly the moment the data became worth protecting.
 *
 * So this walks the file list and pushes bytes as the consumer pulls them: header, contents in
 * 64KB reads, padding, next file. Memory stays flat at roughly one chunk regardless of whether the
 * archive is one megabyte or one hundred gigabytes.
 *
 * The ustar header itself is imported from tarlite rather than reimplemented. Two ustar writers in
 * one codebase is two chances to produce an archive that only one of them can read, and tarlite's
 * long-path split already cost one live failure to get right.
 */
import { Readable } from "node:stream";
import { createReadStream, statSync } from "node:fs";
import { TAR_BLOCK, tarHeader, tarPadding } from "./tarlite.mjs";

const ZEROS = Buffer.alloc(TAR_BLOCK);

/*
 * files: [{ path, name, size?, mtime? }] where `path` is on disk and `name` is the archive-relative
 * "/"-separated name. size is read from disk when omitted.
 *
 * A file that vanishes or becomes unreadable mid-walk is SKIPPED and reported through onSkip rather
 * than aborting: /data is live, temp files come and go, and losing the whole night's backup because
 * one scratch file was deleted between the walk and the read would be a poor trade. A file that
 * shrinks or grows between stat and read is padded or truncated to the size in its header, because
 * a tar whose header disagrees with its payload is corrupt for every reader, not just ours.
 */
export function tarStream(files = [], { chunkBytes = 64 * 1024, onSkip = () => {}, onFile = () => {} } = {}) {
  return Readable.from(blocks(files, { chunkBytes, onSkip, onFile }), { objectMode: false });
}

/*
 * An async generator rather than a hand-written _read. The first draft implemented _read directly
 * and drove the file handles by hand; Node calls _read re-entrantly, two async pumps overlapped,
 * and the second pushed after the first had already pushed EOF (ERR_STREAM_PUSH_AFTER_EOF, caught
 * by the very first run of the test). A generator cannot have that bug: it is suspended at a yield
 * or it is running, never both, and backpressure is the consumer simply not asking for the next
 * value. Same output, one moving part instead of five.
 */
async function* blocks(files, { chunkBytes, onSkip, onFile }) {
  for (const f of files) {
    let size = f.size, mtime = f.mtime;
    try {
      if (size == null || mtime == null) { const st = statSync(f.path); size = st.size; mtime = Math.floor(st.mtimeMs / 1000); }
    } catch (e) { onSkip(f, String((e && e.message) || e)); continue; }

    let head;
    try { head = tarHeader({ name: f.name, size, mtime: mtime || 0 }); }
    catch (e) { onSkip(f, String((e && e.message) || e)); continue; }   // e.g. a path too long for ustar

    onFile(f, size);
    yield head;

    // Everything below this yield MUST emit exactly `size` bytes plus padding, whatever the file
    // does, because the header has already promised that number to the reader.
    let remaining = size;
    try {
      for await (const chunk of createReadStream(f.path, { highWaterMark: chunkBytes })) {
        if (remaining <= 0) break;                       // the file GREW after its header: ignore the tail
        const use = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        remaining -= use.length;
        yield use;
      }
    } catch (e) {
      // Unreadable partway through. Report it, then fall through to the zero-fill below so the
      // archive stays structurally sound for every file after this one.
      onSkip(f, String((e && e.message) || e));
    }
    /*
     * The file was SHORTER than its header claimed, because it was truncated while being read.
     * Pad the promised length with zeros. A short payload desynchronises the reader and quietly
     * ruins every remaining file in the archive, which is far worse than one file with a dead tail.
     */
    while (remaining > 0) {
      const n = Math.min(remaining, chunkBytes);
      remaining -= n;
      yield Buffer.alloc(n);
    }
    const pad = tarPadding(size);
    if (pad) yield Buffer.alloc(pad);
  }
  // Two zero blocks close a tar archive.
  yield ZEROS;
  yield ZEROS;
}

/*
 * The reading half, also streaming, for the restore drill.
 *
 * tarlite.unpack takes a whole archive as a Buffer, which is correct for the small project archives
 * it was written for and catastrophic for a volume backup: holding a gigabyte to check that a
 * gigabyte can be held is not a test anyone should run inside a production container. This walks the
 * byte stream, extracts only the entries a caller asks for, and discards the rest as it passes.
 *
 * `want(name)` decides what lands on disk. Everything else is counted and skipped.
 */
export async function extractStream(source, { want = () => true, onEntry = () => {}, maxEntryBytes = 512 * 1024 * 1024 } = {}) {
  const { createWriteStream } = await import("node:fs");
  let buf = Buffer.alloc(0);
  let seen = 0, extracted = 0;

  // Pull exactly n bytes out of the rolling buffer, waiting on the source as needed.
  const iterator = source[Symbol.asyncIterator]();
  async function fill(n) {
    while (buf.length < n) {
      const { value, done } = await iterator.next();
      if (done) return false;
      buf = buf.length ? Buffer.concat([buf, value]) : Buffer.from(value);
    }
    return true;
  }
  const take = (n) => { const out = buf.subarray(0, n); buf = buf.subarray(n); return out; };

  while (true) {
    if (!(await fill(TAR_BLOCK))) break;
    const head = take(TAR_BLOCK);
    if (head.every((b) => b === 0)) break;                       // the closing blocks

    const nameField = head.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = head.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const name = prefix ? prefix + "/" + nameField : nameField;
    const size = parseInt(head.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8) || 0;
    const type = String.fromCharCode(head[156] || 48);
    const pad = tarPadding(size);
    seen++;

    if (size > maxEntryBytes) throw new Error(`archive entry ${name} claims ${size} bytes, over the ${maxEntryBytes} limit`);

    const keep = type !== "5" && size > 0 && want(name);
    if (!keep) {
      let left = size + pad;
      while (left > 0) {
        if (buf.length === 0 && !(await fill(1))) throw new Error("archive ended mid-entry at " + name);
        const n = Math.min(left, buf.length);
        take(n); left -= n;
      }
      continue;
    }

    const dest = await onEntry({ name, size });               // caller returns a path to write to
    if (!dest) { let left = size + pad; while (left > 0) { if (buf.length === 0 && !(await fill(1))) break; const n = Math.min(left, buf.length); take(n); left -= n; } continue; }
    const out = createWriteStream(dest);
    let left = size;
    while (left > 0) {
      if (buf.length === 0 && !(await fill(1))) throw new Error("archive ended mid-entry at " + name);
      const n = Math.min(left, buf.length);
      const piece = take(n);
      if (!out.write(piece)) await new Promise((r) => out.once("drain", r));
      left -= n;
    }
    await new Promise((r, j) => { out.end(); out.once("finish", r); out.once("error", j); });
    extracted++;
    let p = pad;
    while (p > 0) { if (buf.length === 0 && !(await fill(1))) break; const n = Math.min(p, buf.length); take(n); p -= n; }
  }
  return { entries: seen, extracted };
}
