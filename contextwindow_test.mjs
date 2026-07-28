import assert from "node:assert/strict";
import { approxMessageTokens, selectHistoryWindow, compactExecutionMessages } from "./contextwindow.mjs";

const many = Array.from({ length: 80 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user",
  content: i === 0 ? "Build the complete application" : `turn ${i} ` + "x".repeat(500),
}));

const wide = selectHistoryWindow(many, { contextTokens: 128_000, goal: "Build the complete application" });
assert.equal(wide.messages.length, 80, "large-context models should not be forced to 16 messages");
assert.equal(wide.anchor, "");

const narrow = selectHistoryWindow(many, {
  contextTokens: 8_000, reservedTokens: 2_000, fraction: 0.75,
  goal: "Build the complete application",
});
assert.ok(narrow.messages.length < many.length);
assert.match(narrow.anchor, /CURRENT TASK ANCHOR/);
assert.match(narrow.anchor, /Build the complete application/);
assert.ok(narrow.usedTokens <= narrow.budgetTokens || narrow.messages.length === 1);

const orphaned = selectHistoryWindow([
  { role: "user", content: "old " + "x".repeat(12_000) },
  { role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "read", arguments: "{}" } }] },
  { role: "tool", content: "result " + "x".repeat(8_000) },
  { role: "user", content: "continue" },
], { contextTokens: 5_000, reservedTokens: 1_000, fraction: 0.8, goal: "old task" });
assert.notEqual(orphaned.messages[0]?.role, "tool", "history cannot begin with an orphaned tool result");

const compacted = compactExecutionMessages([
  { role: "system", content: "base rules" },
  ...many,
], { contextTokens: 8_000, goal: "Build the complete application", evidence: ["tests passed"] });
assert.equal(compacted[0].content, "base rules");
assert.match(compacted[1].content, /context rollover, not completion/i);
assert.match(compacted[1].content, /tests passed/);
assert.ok(approxMessageTokens({ role: "user", content: "1234" }) >= 1);
assert.ok(
  approxMessageTokens({ role: "assistant", content: "", reasoning_content: "r".repeat(4_000) }) >= 1_000,
  "DeepSeek reasoning replay must count against the context budget",
);
assert.ok(
  approxMessageTokens({ role: "assistant", content: "", reasoning_details: [{ data: "r".repeat(4_000) }] }) >= 1_000,
  "OpenRouter reasoning-detail replay must count against the context budget",
);

let repeatedlyCompacted = [
  { role: "system", content: "base rules" },
  { role: "system", content: "genuine supervisor policy" },
  ...many,
];
for (let i = 1; i <= 30; i++) {
  repeatedlyCompacted = compactExecutionMessages(repeatedlyCompacted, {
    contextTokens: 8_000,
    goal: `Build iteration ${i}`,
    evidence: [`verification iteration ${i}`],
  });
}
const rolloverCheckpoints = repeatedlyCompacted.filter((m) => (
  m?.role === "system"
  && String(m.content || "").startsWith("EXECUTION CHECKPOINT. Continue working; this is context rollover, not completion.")
));
assert.equal(rolloverCheckpoints.length, 1, "successive compactions must replace the generated checkpoint");
assert.ok(repeatedlyCompacted.some((m) => m?.role === "system" && m.content === "base rules"));
assert.ok(repeatedlyCompacted.some((m) => m?.role === "system" && m.content === "genuine supervisor policy"));
assert.match(rolloverCheckpoints[0].content, /Build iteration 30/);
assert.match(rolloverCheckpoints[0].content, /verification iteration 30/);
assert.doesNotMatch(rolloverCheckpoints[0].content, /verification iteration 29/);

console.log("contextwindow: 18 assertions passed, 0 failed");
