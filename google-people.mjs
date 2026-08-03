/*
 * Dominion AI - Google People (Contacts) tools (Lane H, Wave "Google callable tools", 2026-08-03).
 *
 * BLAST RADIUS: LOW per Fred's wargame. The DATA is still real PII (name, email, phone). The
 * defense is structural: the only tool this module offers is a QUERY-required search capped at a
 * small page size. There is deliberately NO "list all contacts" tool here (People API's
 * connections.list, which pages through the WHOLE address book), so the assistant cannot dump the
 * contact list because the dump verb was never built. A future session that wants a bulk-export
 * tool has to make that call on purpose and cannot find it already wired.
 *
 * RESIDUAL RISK, MEASURED, NOT CLOSED (adversarial review, 2026-08-03). Google's own searchContacts
 * reference says the query "is used to match PREFIX phrases of the fields on a person" (fetched
 * live from the people:v1 discovery document, 2026-08-03). A 2-character query is therefore a
 * prefix sweep: "aa" through "zz" is 676 calls at up to 10 results each, which walks a normal-sized
 * address book. The minimum length stays at 2 because real lookups genuinely need it ("Jo", "Li"),
 * so this is a cost barrier and NOT a wall. What actually bounds it is that a model has to choose
 * to run hundreds of tool calls in one turn. If Fred ever wants a wall, the place for it is a
 * per-turn call budget in the connectors layer, not a longer minimum here.
 *
 * AUTH: same per-account Google OAuth as Gmail/Calendar/Drive in google.mjs (accessToken(T) is
 * injected in from there so this module never touches token storage itself). Needs the
 * contacts.readonly scope added to google.mjs's SCOPES -- see google.mjs and the wiring spec.
 * A stale (never-reconnected) account will fail with an insufficient-scope error from Google until
 * it goes through Setup -> Disconnect -> Connect again, which is expected and reported honestly.
 */

const clamp = (n, lo, hi, dflt) => { const x = Number(n); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : dflt; };
const READ_MASK = "names,emailAddresses,phoneNumbers,organizations";

export function createPeopleTools({ accessToken }) {
  async function peopleGet(T, path) {
    const tok = await accessToken(T);
    const r = await fetch("https://people.googleapis.com/v1/" + path, { headers: { authorization: "Bearer " + tok } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.message) || ("HTTP " + r.status));
    return d;
  }

  const TOOLS = [
    /*
     * [verified] people.searchContacts: https://developers.google.com/people/api/rest/v1/people/searchContacts
     * GET https://people.googleapis.com/v1/people:searchContacts?query=...&readMask=...&pageSize=...
     * Scope: contacts.readonly (or contacts). query is REQUIRED here -- both in Google's own schema
     * and as this tool's own hard rule, because a required query is what keeps this from becoming a
     * full contact-list dump. pageSize is capped well under Google's own 30-result ceiling.
     *
     * [verified] The search index is a lazy cache: a query sent cold can come back empty even when
     * matching contacts exist. https://github.com/googleapis/google-api-nodejs-client/issues/3277
     * and Google's own guidance is to send one throwaway warmup call with an empty query first. That
     * warmup fires here on every call and its result is discarded; it is cheap (same endpoint, tiny
     * page) next to the alternative of a false "no contacts found."
     */
    { name: "people_search_contacts",
      description: "Find a contact in a connected Google account by name, email, phone or company. A search term is required; no bulk contact listing exists.",
      parameters: { type: "object", properties: {
        query: { type: "string", description: "Name, email, phone, or company to search for. Must be a real term, not empty." },
        max: { type: "number", description: "Max results, default 5, cap 10." },
      }, required: ["query"] },
      run: async (T, a) => {
        const q = String(a.query || "").trim();
        if (q.length < 2) return "Give a real search term (at least 2 characters) -- this tool cannot list every contact, only find ones matching a query.";
        const max = clamp(a.max, 1, 10, 5);
        try { await peopleGet(T, "people:searchContacts?query=&readMask=" + READ_MASK + "&pageSize=1"); } catch {}   // warmup, result discarded
        const d = await peopleGet(T, "people:searchContacts?query=" + encodeURIComponent(q) + "&readMask=" + READ_MASK + "&pageSize=" + max);
        const results = d.results || [];
        if (!results.length) return "No contacts matched \"" + q + "\".";
        // ADVERSARIAL REVIEW FIX (2026-08-03): destructuring `person` out of every row threw
        // "Cannot read properties of undefined" on a row that carried no person object, and
        // google.mjs's call() turns that into "Tool people_search_contacts failed: ..." for a
        // search that actually succeeded. Skip malformed rows instead.
        return results.map((row) => {
          const p = (row && row.person) || {};
          const name = (p.names && p.names[0] && p.names[0].displayName) || "(no name)";
          const emails = (p.emailAddresses || []).map((e) => e.value).join(", ") || "-";
          const phones = (p.phoneNumbers || []).map((ph) => ph.value).join(", ") || "-";
          const org = (p.organizations && p.organizations[0] && p.organizations[0].name) || "";
          return `- ${name}${org ? " (" + org + ")" : ""} | email: ${emails} | phone: ${phones}`;
        }).join("\n");
      } },
  ];

  return { TOOLS };
}
