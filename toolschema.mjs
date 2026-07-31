/*
 * Dominion AI — making third-party tool schemas safe to send to any provider.
 *
 * THE LIVE FAILURE (Fred, 2026-07-31). A long TruSignal build died mid-run with:
 *
 *   Moonshot (direct): Invalid request: tools.function.parameters is not a valid moonshot
 *   flavored json schema, details: <At path 'properties.migrations.items.required': required
 *   property 'tag' is not defined in properties>
 *
 * Nothing in this codebase defines that schema. It arrives from a connected MCP server (the
 * Supabase connector's migration tools) and connectors.mjs forwarded it to the model verbatim:
 * `parameters: t.inputSchema`. The schema names "tag" in `required` without ever defining it in
 * `properties`, which is malformed by the JSON Schema spec. OpenAI and Anthropic quietly tolerate
 * it. Moonshot validates strictly and rejects THE ENTIRE REQUEST, so one malformed tool from one
 * connector took down every Moonshot turn for that account, and the failure named a path in a
 * schema the user has never seen and cannot fix.
 *
 * So Moonshot is right and we were wrong. Repairing the schema is more correct everywhere, not a
 * workaround for one provider.
 *
 * WHY THE FLEET PROBE DID NOT CATCH THIS. It verified that each model id resolves, answers, and
 * reports tool and vision capability. It never sent a real connector's schema. "Every model was
 * checked" was true of the models and false of what we send them, which is the more useful claim
 * and the one that now has a test.
 *
 * WHAT THIS DOES, and deliberately no more: it repairs schemas that are INVALID, and leaves valid
 * ones untouched. It does not reshape, simplify, or opinionate. A tool whose schema is already
 * legal must reach the model byte-identical, because quietly rewriting a working tool definition
 * is a far worse bug than the one being fixed.
 */

const MAX_DEPTH = 12;   // deep enough for any real tool, shallow enough that a cyclic schema cannot hang

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/*
 * Repair one schema node, recursively. Returns a NEW object; the input is never mutated, because
 * connector tool lists are cached and reused and mutating one would corrupt every later request.
 */
function repair(node, depth, report) {
  if (!isObj(node) || depth > MAX_DEPTH) return node;
  const out = Array.isArray(node) ? [] : {};

  for (const [k, v] of Object.entries(node)) {
    if (k === "properties" && isObj(v)) {
      const props = {};
      for (const [pk, pv] of Object.entries(v)) props[pk] = repair(pv, depth + 1, report);
      out.properties = props;
    } else if (k === "items") {
      out.items = Array.isArray(v) ? v.map((x) => repair(x, depth + 1, report)) : repair(v, depth + 1, report);
    } else if ((k === "anyOf" || k === "oneOf" || k === "allOf") && Array.isArray(v)) {
      out[k] = v.map((x) => repair(x, depth + 1, report));
    } else if ((k === "$defs" || k === "definitions") && isObj(v)) {
      const defs = {};
      for (const [dk, dv] of Object.entries(v)) defs[dk] = repair(dv, depth + 1, report);
      out[k] = defs;
    } else if (k === "additionalProperties" && isObj(v)) {
      out[k] = repair(v, depth + 1, report);
    } else {
      out[k] = v;
    }
  }

  /*
   * THE ACTUAL FIX. `required` may only name properties that exist. An entry that does not is
   * dropped and reported, never silently. If a tool really needs that argument, the report is how
   * anyone finds out, rather than the model being handed a promise the schema cannot keep.
   */
  if (Array.isArray(out.required)) {
    const known = isObj(out.properties) ? Object.keys(out.properties) : [];
    const kept = out.required.filter((r) => typeof r === "string" && known.includes(r));
    if (kept.length !== out.required.length) {
      for (const missing of out.required) {
        if (!kept.includes(missing)) report.dropped.push(String(missing));
      }
      // An empty `required` is legal but noisy; drop the key entirely when nothing survives.
      if (kept.length) out.required = kept; else delete out.required;
    }
  }

  /*
   * An object schema with no `properties` at all is rejected by some validators. Only added when
   * the node actually claims to be an object, so a plain {type:"string"} is left alone.
   */
  if (out.type === "object" && !isObj(out.properties)) {
    out.properties = {};
    report.filledProperties++;
  }

  return out;
}

/*
 * Repair one tool's `parameters`. Returns { parameters, changed, dropped[] }.
 * `changed` is false for an already-valid schema, and callers rely on that to leave good tools
 * untouched rather than round-tripping every schema through JSON.
 */
export function sanitizeToolParameters(parameters) {
  const report = { dropped: [], filledProperties: 0 };
  const base = isObj(parameters) ? parameters : { type: "object", properties: {} };
  const fixed = repair(base, 0, report);
  const changed = report.dropped.length > 0 || report.filledProperties > 0 || !isObj(parameters);
  return { parameters: changed ? fixed : parameters, changed, dropped: report.dropped };
}

/*
 * Repair a whole tool list in the OpenAI function-calling shape:
 *   [{ type:"function", function:{ name, description, parameters } }]
 *
 * A tool that cannot be repaired into something sendable is DROPPED rather than allowed to poison
 * the request, because one bad tool otherwise costs the user every turn on that provider. Each
 * drop is reported by name so it shows up in a log instead of as a mystery.
 */
export function sanitizeToolList(tools, { log = () => {} } = {}) {
  if (!Array.isArray(tools)) return { tools: [], repaired: 0, dropped: [] };
  const out = [];
  let repaired = 0;
  const dropped = [];

  for (const t of tools) {
    if (!isObj(t) || !isObj(t.function) || !t.function.name) { dropped.push("(unnamed tool)"); continue; }
    const r = sanitizeToolParameters(t.function.parameters);
    if (r.changed) {
      repaired++;
      log(`tool schema repaired for "${t.function.name}"` +
          (r.dropped.length ? `: dropped required ${r.dropped.map((d) => `"${d}"`).join(", ")} (named but never defined)` : ": filled in an empty object schema"));
      out.push({ ...t, function: { ...t.function, parameters: r.parameters } });
    } else {
      out.push(t);   // untouched, byte-identical: a valid schema must reach the model as written
    }
  }
  return { tools: out, repaired, dropped };
}

/*
 * A pure check, for tests and for the health sweep: does this schema still contain the fault that
 * broke the live run? Returns the offending paths, so a regression names itself.
 */
export function findUndefinedRequired(schema, path = "", depth = 0, found = []) {
  if (!isObj(schema) || depth > MAX_DEPTH) return found;
  if (Array.isArray(schema.required)) {
    const known = isObj(schema.properties) ? Object.keys(schema.properties) : [];
    for (const r of schema.required) {
      if (!known.includes(r)) found.push(`${path || "(root)"}.required: "${r}" is not defined in properties`);
    }
  }
  if (isObj(schema.properties)) for (const [k, v] of Object.entries(schema.properties)) findUndefinedRequired(v, `${path}.properties.${k}`, depth + 1, found);
  if (schema.items) {
    const arr = Array.isArray(schema.items) ? schema.items : [schema.items];
    arr.forEach((v, i) => findUndefinedRequired(v, `${path}.items${Array.isArray(schema.items) ? "[" + i + "]" : ""}`, depth + 1, found));
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[key])) schema[key].forEach((v, i) => findUndefinedRequired(v, `${path}.${key}[${i}]`, depth + 1, found));
  }
  for (const key of ["$defs", "definitions"]) {
    if (isObj(schema[key])) for (const [k, v] of Object.entries(schema[key])) findUndefinedRequired(v, `${path}.${key}.${k}`, depth + 1, found);
  }
  return found;
}
