/*
 * Dominion AI - Google Maps tools (Lane H, Wave "Google callable tools", 2026-08-03).
 *
 * BLAST RADIUS: LOW per Fred's wargame for this wave. These are read-only lookups against Google's
 * Maps Platform. No account data, no writes, no money movement. The only real risk is API spend on
 * a per-request billing model, which is bounded by keeping result sizes small and by the server's
 * own key-level quota in Google Cloud console (owner's responsibility, not this module's).
 *
 * AUTH MODEL, deliberately NOT OAuth. Gmail/Calendar/Drive/Sheets/Docs in google.mjs are gated
 * behind a per-account Google OAuth connection because they touch a person's own account data.
 * Geocoding, place search, distance and directions touch no account at all -- they are public Maps
 * Platform lookups keyed to a project-level API key. Wiring them into the SAME "google" connector
 * (see the WIRING SPEC at docs/wiring/lane-h-google.md) means, in practice, that they only become
 * offered to the model once the account has completed Google OAuth connect for Workspace, even
 * though Maps itself needs none of that -- a real limitation, flagged loudly in the wiring spec,
 * not hidden. Fixing it properly needs a standalone connector registry row, which lives in
 * connectors.mjs (owned by a different lane this wave).
 *
 * TWO DIFFERENT KEYS ON PURPOSE. The wallet carries GOOGLE_MAPS_API_KEY (legacy Maps Platform:
 * Geocoding, Distance Matrix, Directions) and GOOGLE_MAPS_PLACES_SEARCH_API_KEY (Places API New:
 * Text Search). Both were verified live on 2026-08-03 against the real endpoints below; using the
 * wallet's own naming rather than guessing which key covers which product.
 *
 * Every live call below is cited to the doc page read for this build and was exercised for real
 * during this build (see google-tools_test.mjs and the build report) -- not recalled from memory.
 */

const clamp = (n, lo, hi, dflt) => { const x = Number(n); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : dflt; };

export function createMapsTools({ cfgGet }) {
  const mapsKey = () => cfgGet("GOOGLE_MAPS_API_KEY", "");
  const placesKey = () => cfgGet("GOOGLE_MAPS_PLACES_SEARCH_API_KEY", "") || mapsKey();

  /*
   * The legacy Maps endpoints take the API key as a QUERY PARAMETER, so the key sits in every URL
   * this function fetches. google.mjs's call() returns String(e.message) straight to the model, so
   * any error message that carries the URL would hand the model a live API key.
   *
   * Verified 2026-08-03 that Node's own fetch does not do this: a DNS failure gives message "fetch
   * failed" and cause "getaddrinfo ENOTFOUND <host>", with no query string anywhere in message,
   * cause, or stack. The redaction below is therefore belt-and-braces against a future transport
   * (a proxy agent, an undici upgrade, a retry wrapper) that decides to be more helpful.
   */
  const redact = (s) => String(s == null ? "" : s).replace(/([?&]key=)[^&\s]+/gi, "$1<redacted>");
  async function getJson(url) {
    let r;
    try { r = await fetch(url); }
    catch (e) { throw new Error(redact(e && e.message || e)); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("HTTP " + r.status + (d.error_message ? ": " + redact(d.error_message) : ""));
    return d;
  }

  const TOOLS = [
    /*
     * [verified] Geocoding API v3: https://developers.google.com/maps/documentation/geocoding/guides-v3/requests-geocoding
     * GET https://maps.googleapis.com/maps/api/geocode/json?address=...&key=API_KEY (forward)
     * GET https://maps.googleapis.com/maps/api/geocode/json?latlng=lat,lng&key=API_KEY (reverse)
     * Live-exercised 2026-08-03 against 1600 Amphitheatre Parkway -> OK, one result, lat/lng returned.
     */
    { name: "maps_geocode",
      description: "Geocode a street address into latitude and longitude, or reverse-geocode lat+lng into a street address.",
      parameters: { type: "object", properties: {
        address: { type: "string", description: "Street address or place name to geocode." },
        lat: { type: "number", description: "Latitude, for reverse geocoding (pair with lng)." },
        lng: { type: "number", description: "Longitude, for reverse geocoding (pair with lat)." },
      }, required: [] },
      run: async (_T, a) => {
        if (!mapsKey()) return "Maps is not set up on this server (GOOGLE_MAPS_API_KEY missing).";
        let url;
        if (a.address) url = "https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(String(a.address)) + "&key=" + mapsKey();
        else if (a.lat != null && a.lng != null) url = "https://maps.googleapis.com/maps/api/geocode/json?latlng=" + encodeURIComponent(a.lat + "," + a.lng) + "&key=" + mapsKey();
        else return "Give either address, or both lat and lng.";
        const d = await getJson(url);
        if (d.status !== "OK") return "Geocoding returned " + d.status + (d.error_message ? ": " + d.error_message : "") + ".";
        const results = (d.results || []).slice(0, 5);
        if (!results.length) return "No match.";
        return results.map((r) => `- ${r.formatted_address} | lat ${r.geometry.location.lat}, lng ${r.geometry.location.lng}`).join("\n");
      } },

    /*
     * [verified] Places API (New) Text Search: https://developers.google.com/maps/documentation/places/web-service/text-search
     * POST https://places.googleapis.com/v1/places:searchText
     * Auth via X-Goog-Api-Key header (NOT a query param, unlike the legacy Maps APIs); a
     * X-Goog-FieldMask header is REQUIRED or the response comes back with no fields at all.
     * Live-exercised 2026-08-03: "coffee near Mountain View CA" -> 20 places, HTTP 200.
     */
    { name: "maps_place_search",
      description: "Search Google Maps for places, businesses or landmarks by free text, e.g. 'coffee near downtown Boise'. Returns name, address, place id.",
      parameters: { type: "object", properties: {
        query: { type: "string", description: "Free-text search, e.g. 'pizza in Nampa ID'." },
        max: { type: "number", description: "Max results, default 8, cap 20." },
      }, required: ["query"] },
      run: async (_T, a) => {
        const key = placesKey();
        if (!key) return "Places search is not set up on this server (GOOGLE_MAPS_PLACES_SEARCH_API_KEY / GOOGLE_MAPS_API_KEY missing).";
        const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.id,places.rating" },
          body: JSON.stringify({ textQuery: String(a.query), pageSize: clamp(a.max, 1, 20, 8) }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return "Place search failed: HTTP " + r.status + (d.error ? ": " + d.error.message : "");
        const places = d.places || [];
        if (!places.length) return "No places matched.";
        return places.map((p) => `- ${(p.displayName && p.displayName.text) || "(unnamed)"} [${p.id}] ${p.formattedAddress || ""}${p.rating ? " (rated " + p.rating + ")" : ""}`).join("\n");
      } },

    /*
     * [verified] Distance Matrix API: https://developers.google.com/maps/documentation/distance-matrix/distance-matrix
     * GET https://maps.googleapis.com/maps/api/distancematrix/json?origins=...&destinations=...&key=API_KEY
     * Live-exercised 2026-08-03: San Francisco, CA -> Mountain View, CA -> OK, 59.9 km, 45 mins.
     */
    { name: "maps_distance", description: "Driving, walking, cycling or transit distance and travel time between origins and destinations.",
      parameters: { type: "object", properties: {
        origins: { type: "string", description: "One or more addresses, separated by |." },
        destinations: { type: "string", description: "One or more addresses, separated by |." },
        mode: { type: "string", enum: ["driving", "walking", "bicycling", "transit"] },
      }, required: ["origins", "destinations"] },
      run: async (_T, a) => {
        if (!mapsKey()) return "Maps is not set up on this server (GOOGLE_MAPS_API_KEY missing).";
        const url = "https://maps.googleapis.com/maps/api/distancematrix/json?origins=" + encodeURIComponent(String(a.origins))
          + "&destinations=" + encodeURIComponent(String(a.destinations)) + "&mode=" + encodeURIComponent(a.mode || "driving") + "&key=" + mapsKey();
        const d = await getJson(url);
        if (d.status !== "OK") return "Distance Matrix returned " + d.status + (d.error_message ? ": " + d.error_message : "") + ".";
        const oa = d.origin_addresses || [], da = d.destination_addresses || [];
        const lines = [];
        (d.rows || []).forEach((row, i) => (row.elements || []).forEach((el, j) => {
          if (el.status !== "OK") { lines.push(`- ${oa[i]} -> ${da[j]}: ${el.status}`); return; }
          lines.push(`- ${oa[i]} -> ${da[j]}: ${el.distance.text}, ${el.duration.text}`);
        }));
        return lines.join("\n") || "No routes returned.";
      } },

    /*
     * [verified] Directions API: https://developers.google.com/maps/documentation/directions/get-directions
     * GET https://maps.googleapis.com/maps/api/directions/json?origin=...&destination=...&key=API_KEY
     * Live-exercised 2026-08-03: San Francisco, CA -> Mountain View, CA -> OK, US-101 S, 37.2 mi, 45 mins.
     */
    { name: "maps_directions", description: "Route between two points: total distance, duration, road summary. Optional waypoints. Driving by default.",
      parameters: { type: "object", properties: {
        origin: { type: "string" }, destination: { type: "string" },
        mode: { type: "string", enum: ["driving", "walking", "bicycling", "transit"] },
        waypoints: { type: "string", description: "Optional intermediate stops, separated by |." },
      }, required: ["origin", "destination"] },
      run: async (_T, a) => {
        if (!mapsKey()) return "Maps is not set up on this server (GOOGLE_MAPS_API_KEY missing).";
        let url = "https://maps.googleapis.com/maps/api/directions/json?origin=" + encodeURIComponent(String(a.origin))
          + "&destination=" + encodeURIComponent(String(a.destination)) + "&mode=" + encodeURIComponent(a.mode || "driving") + "&key=" + mapsKey();
        if (a.waypoints) url += "&waypoints=" + encodeURIComponent(String(a.waypoints));
        const d = await getJson(url);
        if (d.status !== "OK") return "Directions returned " + d.status + (d.error_message ? ": " + d.error_message : "") + ".";
        const route = (d.routes || [])[0];
        if (!route) return "No route found.";
        const leg = route.legs[0];
        const steps = route.legs.reduce((n, l) => n + l.steps.length, 0);
        return `Route via ${route.summary || "(unnamed road)"}: ${leg.distance.text}, ${leg.duration.text}, ${route.legs.length} leg(s), ${steps} step(s).`;
      } },
  ];

  return { TOOLS };
}
