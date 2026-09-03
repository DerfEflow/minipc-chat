/*
 * Dominion AI — the ONE heartbeat implementation for every long-lived HTTP stream this app
 * produces: the Crucible job attach (server.mjs /ide/job/attach), the chat reattach tail
 * (server.mjs /chat/attach), the Game Factory event feed (gamefactoryhttp.mjs), and the hands
 * node<->hub stream (hands/hub.mjs /hands/stream).
 *
 * WHY THIS EXISTS (streams lane, stabilization 2026-09-03, deficiency #11/#18/#25). Cloudflare
 * closes a proxied response that goes idle for about 100 seconds. A tiny rig build measured
 * silent gaps of 95, 41, 166 and 76 seconds between structural job events on /ide/job/attach —
 * comfortably enough to trip that close — and the 09-02 production build's attach stream was cut
 * 61 times in 41 minutes because of it. The Game Factory event feed had its own hand-rolled 20s
 * keepalive (already inside the 100s window but outside this file's 15s contract) and still
 * logged 14 cancels in the same window; standardizing on one well-under-threshold cadence, written
 * once, is cheaper to reason about than four different intervals that each have to be re-derived
 * from the same Cloudflare number.
 *
 * An SSE COMMENT frame (a line starting with ":") is invisible to a browser EventSource by spec —
 * it never reaches onmessage or fires an event — so every writer in this app can add it without
 * touching client-side event parsing. hands.mjs's own SSE reader is not EventSource; it treats ANY
 * received bytes (comment or not) as proof the hub is alive and resets its own lapse timer on
 * every chunk, so a comment frame keeps that liveness contract too.
 */

// Comfortably under both the "at least every 15s" requirement and Cloudflare's ~100s idle close,
// with margin for a slow write or a busy event loop tick.
export const SSE_HEARTBEAT_MS = 10000;

/*
 * Starts writing `frame` to `res` every `intervalMs`. Returns a stop() function — idempotent, safe
 * to call more than once (e.g. once from the terminal-event handler and once from res "close").
 * A write failure (the socket is already gone) stops the timer itself rather than throwing back
 * into whatever leftover interval tick triggered it; the caller's own close handling still runs.
 */
export function startSseHeartbeat(res, { intervalMs = SSE_HEARTBEAT_MS, frame = ": hb\n\n" } = {}) {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try { res.write(frame); }
    catch { stopped = true; clearInterval(timer); }
  }, intervalMs);
  // Never hold the process open for a heartbeat alone — every real caller also holds the response/
  // socket itself, which is what should keep (or not keep) the event loop alive.
  if (typeof timer.unref === "function") timer.unref();
  return () => { if (stopped) return; stopped = true; clearInterval(timer); };
}
