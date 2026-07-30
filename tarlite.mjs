/*
 * Dominion AI — just enough tar, with no dependencies (2026-07-30).
 *
 * The build runner ships a project into a throwaway machine and reads the results back out, and
 * both directions want one stream rather than a thousand round trips. This app has never taken a
 * runtime dependency and is not going to start for a format whose entire specification is a
 * 512-byte header followed by 512-byte blocks: `npm i tar` would pull a subtree of packages into
 * the process that holds every provider key, to do arithmetic that fits on one screen.
 *
 * Scope, deliberately narrow: ustar, regular files and directories, paths under 100 characters
 * handled inline and longer ones through the standard prefix field. No symlinks (a sandbox has no
 * business recreating one), no device nodes, no sparse files, no PAX extensions. Anything it
 * cannot represent is refused by name rather than silently dropped, because a backup that quietly
 * omits a file is worse than no backup.
 *
 * Reading is the security-sensitive direction, since the bytes come back from a machine that just
 * ran a stranger's code: every extracted path is checked to land inside the destination, absolute
 * paths and traversal are refused, and totals are capped.
 */
import { gzipSync, gunzipSync } from "node:zlib";

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

const pad = (s, n) => { const b = Buffer.alloc(n); b.write(String(s), 0, "utf8"); return b; };
const octal = (n, len) => String(n).length > len ? "" : n.toString(8).padStart(len - 1, "0") + "\0";

function checksum(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum;
}

function header({ name, size, mode = 0o644, type = "0", mtime = 0 }) {
  /*
   * ustar splits a long path at a "/" into prefix (<=155) + name (<=100). A valid split is any
   * separator where BOTH halves fit; the first draft guessed one position from the total length and
   * threw on paths that split perfectly one slash earlier. Walk the separators and take the split
   * that puts the most into prefix, since prefix is the larger field.
   */
  let n = name, prefix = "";
  if (Buffer.byteLength(n) > NAME_MAX) {
    let best = -1;
    for (let i = 0; i < n.length; i++) {
      if (n[i] !== "/") continue;
      if (Buffer.byteLength(n.slice(0, i)) <= PREFIX_MAX && Buffer.byteLength(n.slice(i + 1)) <= NAME_MAX) best = i;
    }
    if (best <= 0) throw new Error("path too long for tar: " + name);
    prefix = n.slice(0, best);
    n = n.slice(best + 1);
  }
  const h = Buffer.alloc(BLOCK);
  pad(n, NAME_MAX).copy(h, 0);
  pad(octal(mode, 8), 8).copy(h, 100);
  pad(octal(0, 8), 8).copy(h, 108);                 // uid
  pad(octal(0, 8), 8).copy(h, 116);                 // gid
  pad(octal(size, 12), 12).copy(h, 124);
  pad(octal(mtime, 12), 12).copy(h, 136);
  pad("        ", 8).copy(h, 148);                  // checksum placeholder: spaces, per spec
  h.write(type, 156);
  pad("ustar\0", 6).copy(h, 257);
  pad("00", 2).copy(h, 263);
  if (prefix) pad(prefix, PREFIX_MAX).copy(h, 345);
  pad(octal(checksum(h), 8), 8).copy(h, 148);
  return h;
}

const padding = (size) => (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));

/*
 * entries: [{ name, data?: Buffer, dir?: true, mode? }]. Names are relative, "/" separated.
 */
export function pack(entries = []) {
  const parts = [];
  for (const e of entries) {
    const name = String(e.name || "").replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!name) continue;
    if (e.dir) { parts.push(header({ name: name.endsWith("/") ? name : name + "/", size: 0, mode: e.mode ?? 0o755, type: "5" })); continue; }
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ""), "utf8");
    parts.push(header({ name, size: data.length, mode: e.mode ?? 0o644, type: "0" }));
    parts.push(data);
    const p = padding(data.length);
    if (p) parts.push(Buffer.alloc(p));
  }
  parts.push(Buffer.alloc(BLOCK * 2));              // two zero blocks end the archive
  return Buffer.concat(parts);
}

export const packGz = (entries) => gzipSync(pack(entries));

/*
 * Returns [{ name, data, dir }]. `maxTotalBytes` caps what a hostile archive can make this process
 * allocate; `maxEntries` caps how many objects it can make it create.
 */
export function unpack(buf, { maxTotalBytes = 128 * 1024 * 1024, maxEntries = 20_000 } = {}) {
  const out = [];
  let off = 0, total = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;             // end of archive
    const raw = h.subarray(0, NAME_MAX).toString("utf8").replace(/\0.*$/, "");
    const prefix = h.subarray(345, 345 + PREFIX_MAX).toString("utf8").replace(/\0.*$/, "");
    const name = (prefix ? prefix + "/" : "") + raw;
    const sizeStr = h.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr || "0", 8) || 0;
    const type = String.fromCharCode(h[156]) || "0";
    off += BLOCK;
    if (type === "0" || type === "\0" || type === "") {
      total += size;
      if (total > maxTotalBytes) throw new Error("archive exceeds the size cap");
      out.push({ name, data: buf.subarray(off, off + size), dir: false });
      off += size + padding(size);
    } else if (type === "5") {
      out.push({ name, data: Buffer.alloc(0), dir: true });
    } else {
      // Anything exotic (symlink, device, PAX) is skipped over rather than half-understood.
      off += size + padding(size);
    }
    if (out.length > maxEntries) throw new Error("archive exceeds the entry cap");
  }
  return out;
}

export const unpackGz = (buf, opts) => unpack(gunzipSync(buf), opts);

/*
 * The containment check for extraction. Returns a normalized RELATIVE path, or "" when the entry
 * tries to leave the destination — absolute paths, drive letters, and any traversal that escapes.
 * The caller refuses on "", it does not clamp: an archive aiming outside its folder is hostile or
 * broken, and either way writing it somewhere else is not the fix.
 */
export function safeEntryPath(name) {
  const n = String(name || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!n || n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return "";
  const parts = [];
  for (const seg of n.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (!parts.length) return ""; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join("/");
}
