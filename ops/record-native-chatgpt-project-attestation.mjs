#!/usr/bin/env node
/*
 * Offline-only native ChatGPT Project evidence recorder.
 *
 * This script has no HTTP server, browser automation, worker transport, Drive adapter, or
 * undocumented ChatGPT API call.  It records only an already-visible owner browser-upload
 * attestation in the local append-only Game Factory ledger.  It deliberately reads a regular
 * manifest file rather than accepting pasted JSON or stdin.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { createGameFactoryStore } from "../gamefactorystore.mjs";
import { LOCKED_NATIVE_CHATGPT_PROJECT_ID } from "../gamefactorynativeevidence.mjs";

const USAGE = `Usage:
  node ops/record-native-chatgpt-project-attestation.mjs attest --offline --commit --data-dir <absolute-game-factory-data-dir> --uid <owner-uid> --game-id <game-id> --artifact-id <artifact-id> --manifest <absolute-json-file>
  node ops/record-native-chatgpt-project-attestation.mjs invalidate --offline --commit --data-dir <absolute-game-factory-data-dir> --uid <owner-uid> --game-id <game-id> --artifact-id <artifact-id> --manifest <absolute-json-file>

The manifest must be a regular JSON file created after the owner visibly confirms the exact file
in native ChatGPT Project ${LOCKED_NATIVE_CHATGPT_PROJECT_ID}. This command never uploads a file,
opens a browser, calls an undocumented API, or accepts pasted JSON/stdin.`;

function fail(message) {
  process.stderr.write(`native-project-attestation: ${message}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h" || !action) return { help: true };
  if (!new Set(["attest", "invalidate"]).has(action)) return { error: "action must be attest or invalidate" };
  const values = {};
  const booleans = new Set(["offline", "commit"]);
  const known = new Set(["offline", "commit", "data-dir", "uid", "game-id", "artifact-id", "manifest"]);
  for (let index = 0; index < rest.length; index++) {
    const raw = rest[index];
    if (!raw.startsWith("--")) return { error: `unexpected argument ${raw}` };
    const key = raw.slice(2);
    if (!known.has(key) || Object.hasOwn(values, key)) return { error: `invalid or repeated option ${raw}` };
    if (booleans.has(key)) { values[key] = true; continue; }
    const value = rest[++index];
    if (value == null || value.startsWith("--")) return { error: `${raw} requires a value` };
    values[key] = value;
  }
  for (const key of ["offline", "commit", "data-dir", "uid", "game-id", "artifact-id", "manifest"]) {
    if (!values[key]) return { error: `--${key} is required` };
  }
  return { action, ...values };
}

function regularJsonManifest(input) {
  if (!isAbsolute(input)) throw new Error("--manifest must be an absolute path to a regular JSON file.");
  const requested = resolve(input);
  const beforeOpen = lstatSync(requested, { bigint: true });
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.size < 2n || beforeOpen.size > 64n * 1024n) {
    throw new Error("--manifest must be a non-symlink regular JSON file between 2 bytes and 64 KiB.");
  }
  const resolvedTarget = resolve(realpathSync(requested));
  const samePath = process.platform === "win32"
    ? resolvedTarget.toLowerCase() === requested.toLowerCase()
    : resolvedTarget === requested;
  if (!samePath) throw new Error("--manifest must not resolve through a link.");
  let flags = constants.O_RDONLY;
  if (Number.isInteger(constants.O_NOFOLLOW)) flags |= constants.O_NOFOLLOW;
  if (Number.isInteger(constants.O_CLOEXEC)) flags |= constants.O_CLOEXEC;
  let descriptor;
  let bytes;
  try {
    descriptor = openSync(requested, flags);
    const opened = fstatSync(descriptor, { bigint: true });
    const afterOpen = lstatSync(requested, { bigint: true });
    const afterResolved = resolve(realpathSync(requested));
    const sameResolvedPath = process.platform === "win32"
      ? afterResolved.toLowerCase() === requested.toLowerCase()
      : afterResolved === requested;
    if (!opened.isFile() || !afterOpen.isFile() || afterOpen.isSymbolicLink() || !sameResolvedPath
        || opened.dev !== beforeOpen.dev || opened.ino !== beforeOpen.ino
        || afterOpen.dev !== opened.dev || afterOpen.ino !== opened.ino
        || opened.size !== beforeOpen.size || opened.size < 2n || opened.size > 64n * 1024n) {
      throw new Error("--manifest changed identity or stopped being a non-symlink regular file while it was opened.");
    }
    bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino || afterRead.size !== opened.size
        || afterRead.mtimeNs !== opened.mtimeNs || afterRead.ctimeNs !== opened.ctimeNs
        || BigInt(bytes.length) !== opened.size) {
      throw new Error("--manifest changed while its bytes were being read.");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("--manifest must contain valid UTF-8 JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--manifest must contain a JSON object.");
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
} else if (args.error) {
  fail(args.error);
  process.stderr.write(`${USAGE}\n`);
} else {
  try {
    if (!isAbsolute(args["data-dir"])) throw new Error("--data-dir must be an explicit absolute path; this command never falls back to DATA_DIR or a production default.");
    const manifest = regularJsonManifest(args.manifest);
    const store = createGameFactoryStore({ dir: resolve(args["data-dir"]) });
    try {
      const detail = store.getProject(args.uid, args["game-id"]);
      const artifact = detail?.artifacts?.find((item) => item.id === args["artifact-id"]);
      if (!detail || !artifact) throw new Error("--uid, --game-id, and --artifact-id must name one current artifact in the selected owner game.");
      const outcome = args.action === "attest"
        ? store.recordOwnerAttestedNativeProjectEvidence({ uid: args.uid, artifactId: artifact.id, manifest })
        : store.invalidateNativeProjectEvidence({ uid: args.uid, artifactId: artifact.id, manifest });
      // Do not echo a browser reference or manifest content: the database is the durable audit
      // record, while the command result only gives the operator a bounded receipt.
      process.stdout.write(`${JSON.stringify({
        status: outcome.status,
        ok: outcome.body?.ok === true,
        replayed: outcome.body?.replayed === true,
        evidenceId: outcome.body?.evidenceId || "",
        evidenceStatus: outcome.body?.status || "",
        manifestHash: outcome.body?.manifestHash || "",
        code: outcome.body?.code || "",
      })}\n`);
      if (!outcome || outcome.status >= 300) process.exitCode = 1;
    } finally {
      store.close();
    }
  } catch (error) {
    fail(error?.message || "native Project attestation failed");
  }
}
