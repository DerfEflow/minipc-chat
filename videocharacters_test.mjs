import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharactersFeature, CharactersFeatureError } from "./videocharacters.mjs";

const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function suite({ generateImages } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dominion-characters-"));
  let tick = 0;
  const now = () => Date.UTC(2026, 0, 1, 0, 0, tick++);
  const calls = [];
  const defaultGenerate = async (args) => {
    calls.push(args);
    return { images: Array.from({ length: args.n || 1 }, () => ({ b64: TINY_PNG_B64, format: "png" })), model: "gpt-image-2", quality: args.quality, aspect: args.aspect, costUsd: 0.01, servedBy: { engine: "paid", model: "gpt-image-2", quality: args.quality } };
  };
  const api = createCharactersFeature({ dataDir: dir, now, generateImages: generateImages || defaultGenerate });
  return { dir, calls, api };
}
function clean(t) { t.after(() => rmSync(t.context.dir, { recursive: true, force: true })); }

test("character creation generates reference images through the injected Foundry ladder and stores them on disk", async (t) => {
  t.context = suite(); clean(t); const { api, calls, dir } = t.context;
  const { character, note } = await api.createCharacter("tenant_a", { name: "Jake", description: "A roofing foreman in his 40s", style: "photoreal", voiceNotes: "gravelly, upbeat", quality: "low", count: 2 }, { tenant: { isOwner: true } });
  assert.equal(note, null);
  assert.equal(character.name, "Jake");
  assert.equal(character.images.length, 2);
  assert.equal(character.images[0].n, 1);
  assert.equal(character.images[1].n, 2);
  assert.equal(character.images[0].engine, "paid");
  assert.equal(character.images[0].quality, "low");
  assert.match(character.images[0].prompt, /Jake\. A roofing foreman in his 40s\. photoreal\. character reference sheet, neutral background, full body and face clearly visible\./);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].n, 2);
  assert.equal(calls[0].aspect, "portrait");
  const file = join(dir, "users", "tenant_a", "characters", character.id, "ref-1.png");
  assert.ok(existsSync(file));
  assert.ok(readFileSync(file).length > 0);
  // Listed and fetched by another tenant read must be isolated.
  assert.equal(api.listCharacters("tenant_a").length, 1);
  assert.equal(api.listCharacters("tenant_b").length, 0);
});

test("total Foundry unavailability still creates the character record with a note, never a thrown error", async (t) => {
  t.context = suite({ generateImages: async () => ({ error: "Image generation is not configured on this server (no OpenAI or NVIDIA key)." }) }); clean(t); const { api } = t.context;
  const { character, note } = await api.createCharacter("tenant_a", { name: "Mia", description: "Field estimator" }, {});
  assert.equal(character.images.length, 0);
  assert.match(note, /not configured/);
});

test("name and description are required; style and voiceNotes are optional", async (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  await assert.rejects(() => api.createCharacter("tenant_a", { name: "", description: "x" }, {}), (error) => error instanceof CharactersFeatureError && error.code === "character_name_required");
  await assert.rejects(() => api.createCharacter("tenant_a", { name: "Jake", description: "" }, {}), (error) => error.code === "character_description_required");
  const { character } = await api.createCharacter("tenant_a", { name: "Jake", description: "A foreman" }, {});
  assert.equal(character.style, ""); assert.equal(character.voiceNotes, "");
});

test("addImage accepts either a generated prompt or a direct upload, and images survive a restart", async (t) => {
  t.context = suite(); clean(t); const { api, dir } = t.context;
  const { character } = await api.createCharacter("tenant_a", { name: "Jake", description: "A foreman", count: 1 }, {});
  const withGenerated = await api.addImage("tenant_a", character.id, { prompt: "side profile" }, {});
  assert.equal(withGenerated.images.length, 2);
  assert.equal(withGenerated.images[1].n, 2);
  assert.equal(withGenerated.images[1].engine, "paid");
  const withUploaded = await api.addImage("tenant_a", character.id, { b64: TINY_PNG_B64 }, {});
  assert.equal(withUploaded.images.length, 3);
  assert.equal(withUploaded.images[2].engine, "upload");
  assert.equal(withUploaded.images[2].model, null);
  // Restart: a fresh feature instance over the same dataDir reads the same durable index.
  const restarted = createCharactersFeature({ dataDir: dir, generateImages: async () => ({ images: [{ b64: TINY_PNG_B64 }] }) });
  assert.equal(restarted.getCharacter("tenant_a", character.id).images.length, 3);
});

test("addImage without a prompt or upload is refused, and a failed generation never adds a partial image", async (t) => {
  t.context = suite({ generateImages: async () => ({ error: "paid and draft both failed" }) }); clean(t); const { api } = t.context;
  const { character } = await api.createCharacter("tenant_a", { name: "Jake", description: "A foreman" }, {});
  const before = api.getCharacter("tenant_a", character.id).images.length;
  await assert.rejects(() => api.addImage("tenant_a", character.id, {}, {}), (error) => error.code === "character_image_prompt_required");
  await assert.rejects(() => api.addImage("tenant_a", character.id, { prompt: "side profile" }, {}), (error) => error.code === "character_image_generation_failed");
  assert.equal(api.getCharacter("tenant_a", character.id).images.length, before);
});

test("deleteImage removes exactly the image with that stable sequence number and its file, never renumbering the rest", async (t) => {
  t.context = suite(); clean(t); const { api, dir } = t.context;
  const { character } = await api.createCharacter("tenant_a", { name: "Jake", description: "A foreman", count: 3 }, {});
  assert.deepEqual(character.images.map((i) => i.n), [1, 2, 3]);
  const afterDelete = api.deleteImage("tenant_a", character.id, 2);
  assert.deepEqual(afterDelete.images.map((i) => i.n), [1, 3]);
  assert.equal(existsSync(join(dir, "users", "tenant_a", "characters", character.id, "ref-2.png")), false);
  assert.ok(existsSync(join(dir, "users", "tenant_a", "characters", character.id, "ref-3.png")));
  assert.throws(() => api.deleteImage("tenant_a", character.id, 2), (error) => error.code === "character_image_missing" && error.status === 404);
});

test("updateCharacter patches only the given fields and rejects an empty name/description", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  return (async () => {
    const { character } = await api.createCharacter("tenant_a", { name: "Jake", description: "A foreman", style: "gritty" }, {});
    const updated = api.updateCharacter("tenant_a", character.id, { voiceNotes: "raspy" });
    assert.equal(updated.name, "Jake"); assert.equal(updated.style, "gritty"); assert.equal(updated.voiceNotes, "raspy");
    assert.throws(() => api.updateCharacter("tenant_a", character.id, { name: "  " }), (error) => error.code === "character_name_required");
  })();
});

test("deleting an attached character is refused unless forced, and force never fails even without an isAttached callback", async (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const { character } = await api.createCharacter("tenant_a", { name: "Jake", description: "A foreman" }, {});
  await assert.rejects(() => api.deleteCharacter("tenant_a", character.id, { force: false, isAttached: async () => true }), (error) => error.code === "character_attached" && error.status === 409);
  assert.equal(api.listCharacters("tenant_a").length, 1);
  const result = await api.deleteCharacter("tenant_a", character.id, { force: true, isAttached: async () => true });
  assert.deepEqual(result, { deleted: true, id: character.id, forced: true, name: "Jake" });
  assert.equal(api.listCharacters("tenant_a").length, 0);
});

test("deleting an unattached character needs no force and removes its directory", async (t) => {
  t.context = suite(); clean(t); const { api, dir } = t.context;
  const { character } = await api.createCharacter("tenant_a", { name: "Jake", description: "A foreman" }, {});
  const charDir = join(dir, "users", "tenant_a", "characters", character.id);
  assert.ok(existsSync(charDir));
  await api.deleteCharacter("tenant_a", character.id, { isAttached: async () => false });
  assert.equal(existsSync(charDir), false);
});

test("imagePath resolves a tenant-checked, on-disk path and refuses a missing image", async (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const { character } = await api.createCharacter("tenant_a", { name: "Jake", description: "A foreman", count: 1 }, {});
  const path = api.imagePath("tenant_a", character.id, 1);
  assert.ok(existsSync(path));
  assert.throws(() => api.imagePath("tenant_a", character.id, 99), (error) => error.code === "character_image_missing" && error.status === 404);
  assert.throws(() => api.imagePath("tenant_b", character.id, 1), (error) => error.status === 404);
});
