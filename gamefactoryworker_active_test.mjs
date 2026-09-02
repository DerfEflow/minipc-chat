import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createGameFactoryWorkerAdapter } from "./gamefactoryworker.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

await test("adapter dispatches every active operation only to the exact configured node", async () => {
  const calls = [];
  const adapter = createGameFactoryWorkerAdapter({
    node: "GX10-GameFactory",
    dispatch: async (node, tool, args, options) => {
      calls.push({ node, tool, args, options });
      if (tool === "game_factory_authorization_absent") return {
        ok: true, node, runId: args.runId, status: "INTERRUPTED", cancellationResolved: true,
        dispatchAuthorityAbsent: true,
        dispatchAuthorityAbsenceProof: { protocol: "game-factory-controller-authorization-absence-proof/1" },
      };
      return {
        ok: true, node, runId: args.runId || "run-1", status: "RUNNING",
        secureForUntrustedCode: true, externalBroker: true, separateBrokerCgroup: true,
        maxConcurrent: 1, programs: ["node", "godot"], capabilities: ["quality_assurance", "godot"],
      };
    },
  });
  assert.equal((await adapter.probe()).ok, true);
  assert.equal((await adapter.start({ runId: "run-1", recipe: "fixed" })).ok, true);
  const absent = await adapter.authorizationAbsent({ runId: "run-absent", recipe: "fixed" });
  assert.equal(absent.ok, true);
  assert.equal(absent.dispatchAuthorityAbsent, true);
  assert.equal(absent.dispatchAuthorityAbsenceProof.protocol,
    "game-factory-controller-authorization-absence-proof/1");
  assert.equal((await adapter.status("run-1")).ok, true);
  assert.equal((await adapter.cancel("run-1", { mode: "immediate", reason: "owner stop" })).ok, true);
  assert.equal((await adapter.collect("run-1")).ok, true);
  assert.equal((await adapter.acknowledge("run-1")).ok, true);
  assert.deepEqual(calls.map((call) => call.node), Array(7).fill("gx10-gamefactory"));
  assert.deepEqual(calls.map((call) => call.tool), [
    "game_factory_probe", "game_factory_start", "game_factory_authorization_absent", "game_factory_status",
    "game_factory_cancel", "game_factory_collect", "game_factory_acknowledge",
  ]);
  assert.equal(adapter.health().calls, 7);
});

await test("adapter rejects missing or mismatched node provenance", async () => {
  const mismatch = createGameFactoryWorkerAdapter({
    node: "gx10-gamefactory", dispatch: async () => ({ ok: true, node: "another-node" }),
  });
  const wrong = await mismatch.probe();
  assert.equal(wrong.ok, false); assert.equal(wrong.refused, true);
  assert.match(wrong.error, /claiming node another-node/);
  const missing = createGameFactoryWorkerAdapter({
    node: "gx10-gamefactory", dispatch: async () => ({ ok: true }),
  });
  assert.equal((await missing.probe()).refused, true);
});

await test("adapter blocks secret-bearing starts and redacts cancellation and result text", async () => {
  const marker = "adapter-secret-marker-991";
  const calls = [];
  const adapter = createGameFactoryWorkerAdapter({
    node: "gx10-gamefactory", dispatch: async (node, tool, args) => {
      calls.push({ node, tool, args });
      return { ok: true, node, runId: args.runId || "run-1", status: "CANCELLED",
        stdout: `api_key=${marker}\n{\"password\":\"${marker}\"}\nAuthorization: Basic ${marker}` };
    },
  });
  const refused = await adapter.start({ runId: "run-secret", apiKey: marker });
  assert.equal(refused.ok, false); assert.equal(refused.refused, true); assert.equal(calls.length, 0);
  const refusedAbsence = await adapter.authorizationAbsent({ runId: "run-secret", apiKey: marker });
  assert.equal(refusedAbsence.ok, false); assert.equal(refusedAbsence.refused, true); assert.equal(calls.length, 0);
  const cancelled = await adapter.cancel("run-1", { mode: "safe", reason: `Bearer ${marker}` });
  assert.equal(cancelled.ok, true);
  assert.equal(JSON.stringify(calls[0]).includes(marker), false);
  const collected = await adapter.collect("run-1");
  assert.equal(JSON.stringify(collected).includes(marker), false);
  assert.match(collected.stdout, /redacted/);
});

await test("adapter refuses invalid run references and reports transport failures without node drift", async () => {
  let dispatches = 0;
  const adapter = createGameFactoryWorkerAdapter({
    node: "gx10-gamefactory", dispatch: async () => { dispatches++; throw new Error("transport unavailable"); },
  });
  assert.equal((await adapter.status("r".repeat(241))).refused, true);
  assert.equal((await adapter.cancel("bad\nrun", {})).refused, true);
  assert.equal((await adapter.collect("bad\u0000run")).refused, true);
  assert.equal((await adapter.acknowledge("bad\u0000run")).refused, true);
  assert.equal(dispatches, 0);
  const offline = await adapter.probe();
  assert.equal(offline.ok, false); assert.equal(offline.offline, true); assert.equal(offline.node, "gx10-gamefactory");
  const disabled = createGameFactoryWorkerAdapter({ node: "", dispatch: async () => { throw new Error("must not call"); } });
  assert.equal((await disabled.probe()).disabled, true);
});

await test("Hands active wiring exposes only the controller to the static broker", () => {
  const source = readFileSync(new URL("./hands/hands.mjs", import.meta.url), "utf8");
  assert.match(source, /createGameFactoryBrokerController/);
  assert.doesNotMatch(source, /import\(["'][.]\/gamefactory-(?:worker|executor|runner)[.]mjs["']\)/);
  for (const operation of ["game_factory_probe", "game_factory_start", "game_factory_authorization_absent",
    "game_factory_status", "game_factory_cancel", "game_factory_collect", "game_factory_acknowledge"]) {
    assert.match(source, new RegExp(`"${operation}"`));
  }
  assert.match(source, /token-bearing Hands process is restricted to the game-factory controller protocol/);
});

console.log(`\n${passed} active game factory worker-adapter tests passed`);
