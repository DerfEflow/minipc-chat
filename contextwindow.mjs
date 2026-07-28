/*
 * Context selection for long-running chat.
 *
 * A fixed "last 16 messages" cap discarded the actual task on ordinary coding sessions even when
 * the selected model had hundreds of thousands of tokens available. Select by the model's token
 * budget instead, retain complete recent turns, and return an explicit task anchor when older
 * context had to be omitted.
 */
export function approxMessageTokens(message) {
  if (!message || typeof message !== "object") return 0;
  let chars = typeof message.content === "string"
    ? message.content.length
    : JSON.stringify(message.content ?? "").length;
  if (Array.isArray(message.attachments)) {
    for (const a of message.attachments) {
      if (a && a.kind === "text" && typeof a.text === "string") chars += a.text.length;
      else if (a && a.kind === "image") chars += 4_000 * 4;
    }
  }
  if (Array.isArray(message.tool_calls)) chars += JSON.stringify(message.tool_calls).length;
  // Provider-native continuation state is part of the real context budget.
  // DeepSeek requires reasoning_content replay and OpenRouter requires
  // reasoning_details replay across tool rounds; undercounting either can push
  // an otherwise valid long task past the model's physical window.
  for (const key of ["reasoning", "reasoning_content", "reasoning_details"]) {
    if (typeof message[key] === "string") chars += message[key].length;
    else if (message[key] != null) chars += JSON.stringify(message[key]).length;
  }
  // Native OpenAI Responses output (including encrypted reasoning state) is
  // replayed verbatim across stateless tool rounds and consumes real context.
  if (Array.isArray(message.responsesOutput)) chars += JSON.stringify(message.responsesOutput).length;
  return Math.max(1, Math.ceil(chars / 4));
}

export function selectHistoryWindow(history, {
  contextTokens = 128_000,
  reservedTokens = 16_000,
  fraction = 0.58,
  maxMessages = 400,
  goal = "",
} = {}) {
  const source = Array.isArray(history) ? history : [];
  const cap = Math.max(4_000, Math.floor(Number(contextTokens) || 128_000));
  const reserve = Math.max(1_000, Math.floor(Number(reservedTokens) || 16_000));
  const budget = Math.max(2_000, Math.floor(cap * fraction) - reserve);
  const chosen = [];
  let used = 0;

  for (let i = source.length - 1; i >= 0 && chosen.length < maxMessages; i--) {
    const tokens = approxMessageTokens(source[i]);
    if (chosen.length && used + tokens > budget) break;
    chosen.unshift(source[i]);
    used += tokens;
  }

  // Never begin replay with an orphaned tool result. Walk forward to a user/system boundary.
  while (chosen.length && chosen[0] && chosen[0].role === "tool") {
    used -= approxMessageTokens(chosen.shift());
  }

  const omitted = Math.max(0, source.length - chosen.length);
  const firstUser = source.find((m) => m && m.role === "user" && String(m.content || "").trim());
  const anchorText = String(goal || (firstUser && firstUser.content) || "").trim();
  const selectedContainsAnchor = !anchorText || chosen.some((m) => m && m.role === "user" && String(m.content || "").trim() === anchorText);

  return {
    messages: chosen,
    omitted,
    usedTokens: Math.max(0, used),
    budgetTokens: budget,
    anchor: omitted > 0 && !selectedContainsAnchor && anchorText
      ? `CURRENT TASK ANCHOR (older transcript was compacted):\n${anchorText}\nContinue this task from the recent evidence below. Do not treat omitted transcript as permission to reduce scope or claim completion.`
      : "",
  };
}

export function compactExecutionMessages(messages, {
  contextTokens = 128_000,
  goal = "",
  evidence = [],
} = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const checkpointPrefix = "EXECUTION CHECKPOINT. Continue working; this is context rollover, not completion.";
  // A rollover can itself be present in the next rollover's input. Keep only genuine system
  // instructions here and replace our generated checkpoint below; otherwise a long task grows
  // one permanent system message on every compaction.
  const systems = source.filter((m) => (
    m
    && m.role === "system"
    && !String(m.content || "").startsWith(checkpointPrefix)
  ));
  const dialogue = source.filter((m) => !m || m.role !== "system");
  const fixedTokens = systems.reduce((n, m) => n + approxMessageTokens(m), 0);
  const recent = selectHistoryWindow(dialogue, {
    contextTokens,
    reservedTokens: Math.max(8_000, fixedTokens + 8_000),
    fraction: 0.52,
    goal,
  });
  const checkpoint = {
    role: "system",
    content: [
      checkpointPrefix,
      goal ? `Original task: ${goal}` : "",
      evidence.length ? "Verified tool evidence so far:\n" + evidence.slice(-40).map((x) => "- " + String(x)).join("\n") : "",
      "Re-read current state before any uncertain edit. Finish all remaining scope, verify it, then report completion.",
    ].filter(Boolean).join("\n\n"),
  };
  return [...systems, checkpoint, ...recent.messages];
}
