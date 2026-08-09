/*
 * A SECOND WIRE FOR A DEAD SEAT.
 *
 * BATTALION's whole roster rides one host (see BATTALION_FAILOVER in models.catalog.mjs). When that
 * host has a bad minute, every seat and every in-module "replacement" dies with it, because the
 * replacement varies the model NAME and not the WIRE. This wrapper is the missing half: on a
 * transport death it re-posts the same work to a $0 route on a different host, exactly once.
 *
 * It lives in its own module for two reasons. server.mjs cannot be imported by a test — it starts a
 * listener — so a failover buried in the callSeat lambda would be untestable, and this is precisely
 * the kind of code that must be tested, since it runs only when something else is already broken.
 * And battalion.mjs is pure orchestration by contract: it must not learn provider names to survive
 * an outage. So the policy sits between them, injected into one and knowing nothing of the other.
 *
 * Deliberately NOT a retry loop. One alternate wire, one attempt. A seat that cannot be reached on
 * two independent hosts is a real outage, and the server already has an honest answer for that:
 * say the free lane is down and offer the user's normal model.
 */

/*
 * The guards below are each here because the naive version of this wrapper is actively harmful.
 *
 * A PARTIAL ANSWER IS NEVER RETRIED. If the first wire streamed 200 words and then died, those words
 * already reached the screen through onDelta; re-posting would stream a second, different answer
 * underneath the first. Losing the tail of an answer is bad, printing two answers is worse.
 *
 * AN ABORT IS NOT A FAILURE. The user pressing stop must not summon a fresh call on another host.
 *
 * ONLY TRANSPORT DEATHS. A 400, a refused model id, a content filter, an out-of-funds - those get
 * the same reply from any host, so a second call just doubles the latency before the same error.
 */
export function createSeatFailover({ call, map = {}, keyPresent = () => true, isTransportDeath, log = () => {} }) {
  if (typeof call !== "function") throw new Error("seatfailover: call is required");
  if (typeof isTransportDeath !== "function") throw new Error("seatfailover: isTransportDeath is required");

  return async function callSeatWithFailover(catalogId, messages, opts = {}, onDelta) {
    const r = await call(catalogId, messages, opts, onDelta);
    if (!r || r.ok || r.aborted) return r;
    if (opts && opts.signal && opts.signal.aborted) return r;
    if (String(r.content || "").trim()) return r;      // never stream a second answer under the first
    if (!isTransportDeath(r)) return r;
    const alt = map[catalogId];
    if (!alt || !keyPresent()) return r;

    log("battalion seat " + catalogId + " died on its own wire (" + String(r.error || "no answer").slice(0, 70)
      + ") — retrying " + alt + " on the backup wire");
    const r2 = await call(alt, messages, { ...opts, __forceProvider: "openrouter" }, onDelta);
    if (r2 && r2.ok) return { ...r2, failoverFrom: catalogId, failoverTo: alt };
    /*
     * Both wires are down. Report the ORIGINAL death, because that is the one the user's chosen lane
     * actually suffered, and name the backup's failure inside it so the log is not misleading about
     * how hard we tried. Returning the backup's error alone would blame OpenRouter for an outage
     * that started somewhere else.
     */
    return { ...r, failoverTried: alt,
      error: String(r.error || "no answer") + " (the backup wire also failed: "
        + String((r2 && r2.error) || "no answer").slice(0, 90) + ")" };
  };
}
