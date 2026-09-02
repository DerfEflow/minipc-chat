import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true, mode: 0o700 });
writeFileSync("dist/index.html", "<!doctype html><meta charset=utf-8><title>GX10 Game Factory Canary</title>\n", { mode: 0o600 });
writeFileSync("dist/manifest.json", JSON.stringify({ protocol: "gx10-game-factory-live/1", ok: true }) + "\n", { mode: 0o600 });
console.log("GX10_GAME_FACTORY_ARTIFACT_OK");
