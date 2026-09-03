/*
 * Dominion AI — permanent, tenant-scoped video characters (LANE-video-characters.md).
 *
 * A character is created once through the Foundry image pipeline and then lives in the account
 * forever: no project scoping, no expiry, survives project deletion (required behavior #1). This
 * module deliberately has no dependency on images.mjs or video.mjs — server.mjs wires a
 * programmatic image-generation entry point in as `generateImages`, and video-http.mjs wires an
 * attachment check in as `isAttached` when deleting — keeping this store's own file/atomic-write
 * discipline the only thing it owns, the same seam philosophy video.mjs uses for the project store.
 *
 * Storage: DATA_DIR/video/users/<tenantId>/characters/index.json plus
 * characters/<id>/ref-<n>.png, exactly as specified. `n` is a stable per-character monotonic
 * sequence number stored on each image record (not an array position), so deleting image 2 of 3
 * never renumbers image 3 to 2 out from under a client that just fetched its URL.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import { randomUUID } from "node:crypto";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const CHARACTER_ID = /^[a-f0-9-]{36}$/i;
const MAX_CHARACTERS_PER_TENANT = 200;
const MAX_IMAGES_PER_CHARACTER = 24;
const MAX_NAME = 160, MAX_DESCRIPTION = 4000, MAX_STYLE = 2000, MAX_VOICE_NOTES = 2000;

export class CharactersFeatureError extends Error {
  constructor(code, message, status = 400, details = null) { super(message); this.name = "CharactersFeatureError"; this.code = code; this.status = status; this.details = details; }
  toJSON() { return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } }; }
}
export function safeCharactersError(err) {
  return err instanceof CharactersFeatureError ? err.toJSON() : { error: { code: "character_internal", message: "Character operation could not be completed." } };
}
const fail = (code, message, status, details) => { throw new CharactersFeatureError(code, message, status, details); };
const clone = (v) => structuredClone(v);
const iso = (now) => new Date(Number(now())).toISOString();
const cleanText = (value, max) => String(value ?? "").trim().slice(0, max);

function validPart(value, label) {
  const s = String(value || "").trim();
  if (!SAFE_ID.test(s) || s === "." || s === "..") fail("character_invalid_" + label, "Invalid " + label + ".");
  return s;
}
function within(root, target) {
  const r = resolve(root), t = resolve(target), rel = relative(r, t);
  return !rel || (!rel.startsWith(".." + "\\") && rel !== ".." && !rel.startsWith("../"));
}
function atomicJson(file, value) {
  const tmp = file + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}
function atomicBytes(file, value) {
  const tmp = file + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, value);
  renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return fallback; }
}

export function createCharactersFeature({
  dataDir, now = Date.now,
  // (args) => Promise<{ images:[{b64,format}], model, quality, aspect, costUsd, servedBy, note } | { error }>
  // The Foundry ladder's programmatic entry point (images.mjs `generateImagesInternal`), injected
  // so this module never imports images.mjs directly — server.mjs is the only place that wires the
  // two together (LANE-video-characters.md "files you own").
  generateImages,
} = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  const root = resolve(dataDir); mkdirSync(root, { recursive: true });
  const tenantRoot = (tenantId) => {
    const id = validPart(tenantId, "tenant");
    const path = join(root, "users", id, "characters");
    if (!within(root, path)) fail("character_path_invalid", "Invalid character path.");
    mkdirSync(path, { recursive: true });
    return path;
  };
  const indexFile = (tenantId) => join(tenantRoot(tenantId), "index.json");
  const characterDir = (tenantId, id) => {
    const cid = String(id || ""); if (!CHARACTER_ID.test(cid)) fail("character_invalid", "Invalid character id.");
    const path = join(tenantRoot(tenantId), cid);
    if (!within(tenantRoot(tenantId), path)) fail("character_path_invalid", "Invalid character path.");
    return path;
  };
  function loadIndex(tenantId) {
    const data = readJson(indexFile(tenantId), { characters: [] });
    return Array.isArray(data.characters) ? data.characters : [];
  }
  function saveIndex(tenantId, characters) { atomicJson(indexFile(tenantId), { characters }); }
  function findIndex(list, id) { return list.findIndex((c) => c.id === id); }

  function getCharacter(tenantId, id) {
    const tenant = validPart(tenantId, "tenant");
    const found = loadIndex(tenant).find((c) => c.id === String(id || ""));
    if (!found) fail("character_missing", "Character not found.", 404);
    return clone(found);
  }
  function listCharacters(tenantId) {
    const tenant = validPart(tenantId, "tenant");
    return loadIndex(tenant).map((c) => clone(c)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function saveImageBytes(tenantId, id, n, b64) {
    const dir = characterDir(tenantId, id); mkdirSync(dir, { recursive: true });
    let buf;
    try { buf = Buffer.from(String(b64 || ""), "base64"); } catch { fail("character_image_invalid", "The character image could not be decoded."); }
    if (!buf.length || buf.length > 16 * 1024 * 1024) fail("character_image_invalid", "The character image is invalid or too large.");
    const file = join(dir, `ref-${n}.png`);
    if (!within(dir, file)) fail("character_path_invalid", "Invalid character image path.");
    atomicBytes(file, buf);
    return basename(file);
  }
  function removeImageBytes(tenantId, id, file) {
    const dir = characterDir(tenantId, id);
    const target = join(dir, basename(String(file || "")));
    if (!within(dir, target)) return;
    try { rmSync(target, { force: true }); } catch { /* best-effort cleanup; the index record is the source of truth */ }
  }

  const REFERENCE_SUFFIX = "character reference sheet, neutral background, full body and face clearly visible.";

  /*
   * Required behavior #1: POST /characters generates the reference images through the Foundry
   * pipeline itself — an image is ALWAYS produced when either engine is configured (the ladder's
   * last rung is the free draft engine). The one case the ladder truly cannot serve is neither
   * OpenAI nor NVIDIA configured at all; rather than fail the whole character creation over that,
   * the record is still created (a viable result: the character exists and can be given an image
   * later) and the failure rides back as a plain `note`, never a thrown error. See the TODO below.
   */
  async function createCharacter(tenantId, input = {}, context = {}) {
    const tenant = validPart(tenantId, "tenant");
    const list = loadIndex(tenant);
    if (list.length >= MAX_CHARACTERS_PER_TENANT) fail("character_limit", `An account can keep at most ${MAX_CHARACTERS_PER_TENANT} characters. Delete an unneeded character before creating another.`, 409);
    const name = cleanText(input.name, MAX_NAME);
    if (!name) fail("character_name_required", "A character name is required.");
    const description = cleanText(input.description, MAX_DESCRIPTION);
    if (!description) fail("character_description_required", "A character description is required.");
    const style = cleanText(input.style, MAX_STYLE);
    const voiceNotes = cleanText(input.voiceNotes, MAX_VOICE_NOTES);
    const quality = ["low", "medium"].includes(input.quality) ? input.quality : "medium";
    const count = Math.min(3, Math.max(1, Number.parseInt(input.count, 10) || 1));
    const id = randomUUID();
    const at = iso(now);
    const record = { id, name, description, style, voiceNotes, images: [], nextImageSeq: 1, createdAt: at, updatedAt: at };

    const prompt = [name, description, style].filter(Boolean).join(". ") + ". " + REFERENCE_SUFFIX;
    const generation = typeof generateImages === "function"
      ? await generateImages({ tenant: context.tenant || null, prompt, quality, aspect: "portrait", n: count })
      : { error: "Image generation is not configured on this server." };
    let note = null;
    // TODO(fred): total Foundry unavailability (no OpenAI AND no NVIDIA key) is the one case the
    // ladder cannot serve at all. Chose to still create the character (viable partial result) with
    // a plain-language note rather than refuse the whole request; revisit if you want creation to
    // hard-fail instead when reference images are mandatory for your workflow.
    if (generation?.error) {
      note = String(generation.error).slice(0, 800);
    } else {
      for (const image of generation.images || []) {
        const n = record.nextImageSeq++;
        const file = saveImageBytes(tenant, id, n, image.b64);
        record.images.push({ n, file, engine: generation.servedBy?.engine || null, model: generation.servedBy?.model || generation.model || null, quality: generation.quality || quality, prompt, createdAt: at });
      }
      if (generation.note) note = generation.note;
    }
    list.push(record);
    saveIndex(tenant, list);
    return { character: clone(record), note };
  }

  async function addImage(tenantId, id, input = {}, context = {}) {
    const tenant = validPart(tenantId, "tenant");
    const list = loadIndex(tenant);
    const index = findIndex(list, String(id || ""));
    if (index < 0) fail("character_missing", "Character not found.", 404);
    const record = list[index];
    if (record.images.length >= MAX_IMAGES_PER_CHARACTER) fail("character_image_limit", `A character can keep at most ${MAX_IMAGES_PER_CHARACTER} images.`, 409);
    const at = iso(now);
    let entry;
    if (input.b64) {
      const n = record.nextImageSeq++;
      const file = saveImageBytes(tenant, record.id, n, input.b64);
      entry = { n, file, engine: "upload", model: null, quality: null, prompt: cleanText(input.prompt, MAX_DESCRIPTION) || null, createdAt: at };
    } else {
      const prompt = cleanText(input.prompt, MAX_DESCRIPTION);
      if (!prompt) fail("character_image_prompt_required", "Provide a prompt or an uploaded image.");
      const quality = ["low", "medium"].includes(input.quality) ? input.quality : "medium";
      const generation = typeof generateImages === "function"
        ? await generateImages({ tenant: context.tenant || null, prompt: `${record.name}. ${prompt}. ${REFERENCE_SUFFIX}`, quality, aspect: "portrait", n: 1 })
        : { error: "Image generation is not configured on this server." };
      if (generation?.error || !generation.images?.length) fail("character_image_generation_failed", String(generation?.error || "Image generation returned no images."), 502);
      const n = record.nextImageSeq++;
      const file = saveImageBytes(tenant, record.id, n, generation.images[0].b64);
      entry = { n, file, engine: generation.servedBy?.engine || null, model: generation.servedBy?.model || generation.model || null, quality: generation.quality || quality, prompt, createdAt: at };
    }
    record.images.push(entry);
    record.updatedAt = at;
    saveIndex(tenant, list);
    return clone(record);
  }

  function deleteImage(tenantId, id, n) {
    const tenant = validPart(tenantId, "tenant");
    const list = loadIndex(tenant);
    const index = findIndex(list, String(id || ""));
    if (index < 0) fail("character_missing", "Character not found.", 404);
    const record = list[index];
    const seq = Number(n);
    const imageIndex = record.images.findIndex((image) => image.n === seq);
    if (imageIndex < 0) fail("character_image_missing", "Character image not found.", 404);
    const [removed] = record.images.splice(imageIndex, 1);
    removeImageBytes(tenant, record.id, removed.file);
    record.updatedAt = iso(now);
    saveIndex(tenant, list);
    return clone(record);
  }

  function updateCharacter(tenantId, id, patch = {}) {
    const tenant = validPart(tenantId, "tenant");
    const list = loadIndex(tenant);
    const index = findIndex(list, String(id || ""));
    if (index < 0) fail("character_missing", "Character not found.", 404);
    const record = list[index];
    if (patch.name !== undefined) { const name = cleanText(patch.name, MAX_NAME); if (!name) fail("character_name_required", "A character name is required."); record.name = name; }
    if (patch.description !== undefined) { const description = cleanText(patch.description, MAX_DESCRIPTION); if (!description) fail("character_description_required", "A character description is required."); record.description = description; }
    if (patch.style !== undefined) record.style = cleanText(patch.style, MAX_STYLE);
    if (patch.voiceNotes !== undefined) record.voiceNotes = cleanText(patch.voiceNotes, MAX_VOICE_NOTES);
    record.updatedAt = iso(now);
    saveIndex(tenant, list);
    return clone(record);
  }

  // `isAttached(tenantId, id) => boolean|Promise<boolean>` is injected from video-http.mjs (backed
  // by videoFeature's project store) so this module never has to know about projects at all.
  async function deleteCharacter(tenantId, id, { force = false, isAttached } = {}) {
    const tenant = validPart(tenantId, "tenant");
    const list = loadIndex(tenant);
    const index = findIndex(list, String(id || ""));
    if (index < 0) fail("character_missing", "Character not found.", 404);
    if (!force && typeof isAttached === "function" && await isAttached(tenant, id)) {
      fail("character_attached", "This character is attached to a project. Detach it first, or delete with force to detach everywhere.", 409);
    }
    const [removed] = list.splice(index, 1);
    saveIndex(tenant, list);
    try { rmSync(characterDir(tenant, id), { recursive: true, force: true }); } catch { /* index is already updated; a leftover directory does not corrupt state */ }
    return { deleted: true, id, forced: force, name: removed.name };
  }

  function imagePath(tenantId, id, n) {
    const tenant = validPart(tenantId, "tenant");
    const character = getCharacter(tenant, id);
    const image = character.images.find((item) => item.n === Number(n));
    if (!image) fail("character_image_missing", "Character image not found.", 404);
    const dir = characterDir(tenant, id);
    const path = join(dir, image.file);
    if (!within(dir, path) || !existsSync(path)) fail("character_image_missing", "Character image not found.", 404);
    return path;
  }

  return {
    listCharacters, getCharacter, createCharacter, addImage, deleteImage, updateCharacter, deleteCharacter, imagePath,
    safeError: safeCharactersError,
  };
}
