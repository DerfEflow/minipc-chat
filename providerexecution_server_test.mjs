import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("./server.mjs", import.meta.url)),
  "utf8",
);

test("generic cloud transport applies provider execution shaping after payload construction", () => {
  const openAIEntry = source.indexOf('if (earlyProvider === "openai")');
  const genericShape = source.indexOf("payload = shapeProviderExecutionRequest(payload");
  const sendEntry = source.indexOf("send(payload, true)", genericShape);
  assert(openAIEntry >= 0, "OpenAI native branch is missing");
  assert(genericShape > openAIEntry, "provider shaping was not installed in the generic branch");
  assert(sendEntry > genericShape, "generic request is sent before provider shaping");
  assert.match(source.slice(genericShape, sendEntry), /capabilities:\s*catalogReasoningCapabilities\(rec\)/);
  assert.match(source.slice(genericShape, sendEntry), /sessionKey:\s*opts\.sessionId\s*\|\|\s*opts\.chatId/);
});

test("generic SSE parser treats top-level HTTP-200 errors as provider failures", () => {
  assert.match(source, /extractProviderStreamError\(j\)/);
  assert.match(source, /normalizeProviderTerminal\(\{\s*finishReason,/s);
  assert.match(source, /terminal\.state === "error"\s*\|\|\s*terminal\.blocked/);
  assert.match(source, /terminal\.reason === "insufficient_system_resource"/);
  assert.match(source, /prematureStreamEnd = !finishReason && !streamError/);
  assert.match(source, /response stream ended before the provider supplied a finish reason/i);
});

test("assistant tool replay uses the captured provider turn rather than rebuilding a lossy message", () => {
  assert.match(source, /accumulateAssistantDeltaInPlace\(assistantTurn,\s*delta\)/);
  assert.match(source, /reasoningContent:\s*assistantTurn\.reasoning_content/);
  assert.match(source, /reasoningDetails:\s*assistantTurn\.reasoning_details/);
  assert.match(source, /or\.assistantTurn\s*\?\s*projectAssistantToolTurn\(or\.assistantTurn\)/s);
  assert.match(source, /r\.assistantTurn\s*\?\s*projectAssistantToolTurn\(r\.assistantTurn\)/s);
});

test("OpenAI Responses stays stateless while replaying encrypted reasoning through tool rounds", () => {
  const nativeBranch = source.slice(
    source.indexOf('if (earlyProvider === "openai")'),
    source.indexOf('if (earlyProvider === "anthropic")'),
  );
  assert.match(nativeBranch, /store:\s*false/);
  assert.match(nativeBranch, /include:\s*openAIReasoningFamily\s*\?\s*\["reasoning\.encrypted_content"\]/);
  assert.match(source, /cloudProvider === "openai"[\s\S]{0,220}responsesOutput:\s*or\.responseItems/);
  assert.match(source, /providerName === "openai"[\s\S]{0,220}responsesOutput:\s*r\.responseItems/);
});

test("chat and Crucible calls provide durable session identity to the generic provider path", () => {
  assert.match(source, /executionPolicy,\s*sessionId:\s*chatId\s*\|\|\s*job\.id/);
  assert.match(source, /executionPolicy:\s*policy,\s*\n\s*sessionId:\s*job\.id/);
});

test("complex requests cannot be marked complete when the selected model has no required tools", () => {
  assert.match(source, /const requiredToolsUnavailable = taskContract\.requirements\.tools && !attachTools/);
  assert.match(source, /completionApproved = !completionRequired && !requiredToolsUnavailable/);
  assert.match(source, /decision:\s*"blocked_tools_unavailable"/);
  assert.match(source, /Work paused\. This task is not complete\./);
  assert.match(source, /reason:\s*"required tools were not attached to the local model"/);
});

test("cloud persistence has a finite resumable epoch and accounts nonterminal provider usage", () => {
  assert.match(source, /const cloudRoundLimit = SUP_HARD_CAP \* \(executionPolicy\.persistence\.checkpoint \? 8 : 4\)/);
  assert.match(source, /decision:\s*"finite_epoch_checkpoint"/);
  assert.match(source, /continue this same session from the saved goal and evidence ledger/);
  assert.match(source, /bumpUsage\(sv && sv\.usage, UTILITY_MODEL\)/, "supervisor calls can consume billable tokens");
  assert.match(source, /providerRetry\+\+\) \{[\s\S]{0,260}bumpUsage\(or && or\.usage\)/,
    "failed provider attempts must be counted before the retry replaces them");
  assert.match(source, /if \(!or\.ok\) \{\s*bumpUsage\(or && or\.usage\)/,
    "the final failed provider response must be counted before checkpointing");
  /*
   * The invariant is ORDER, not adjacency: the continuation's usage must be counted before the
   * `!cont.ok` branch can leave, or a failed continuation escapes unbilled. This used to require
   * the three statements to be neighbours, which broke on 2026-08-03 when the token-ceiling
   * instrumentation was wired in between them. The recorder cannot return early (it is guarded by
   * `if (cont && cont.ok)`), so the billing order it sits inside is unchanged. Allow intervening
   * statements, keep bumpUsage pinned immediately after workStop, and keep it ahead of the branch.
   */
  assert.match(source, /workStop\(\);\s*bumpUsage\(cont && cont\.usage\);[\s\S]{0,900}?if \(!cont\.ok\)/,
    "failed output continuations must be counted, and counted before the failure path returns");
  assert.match(source, /const liveCostUsd = \(\) => costTotal \+ catalogCostTotal/,
    "the live session guard must include provider-reported cost, not just reconstructed token cost");
  assert.match(source, /const roundOutputCap = affordableWorkerOutput\(outCap, messages,/,
    "the next worker call must be sized to the actual remaining session budget");
  assert.match(source, /num_predict: continuationOutputCap/,
    "automatic continuations must reserve budget too");
});

test("completion evidence must be connected to the requested targets, not merely successful", () => {
  assert.match(source, /const objectivePathTargets =/);
  assert.match(source, /objectiveTermsMatched:\s*objectiveTerms\.filter/);
  assert.match(source, /the cited mutation does not touch any file or target explicitly named in the request/);
  assert.match(source, /the cited mutation has no observed relationship to the request's distinguishing terms/);
  assert.match(source, /the cited mutation is not connected to any specifically inspected repository path/);
});
