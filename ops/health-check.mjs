/*
 * Dominion AI — biweekly security + feature health check.
 *
 * WHY (2026-07-18): after the stray-domain incident, the things that keep this app safe are
 * config values and invariants that can drift silently. A wrong team domain, a public service
 * domain, a reverted ACCESS_JWT mode, or a guest connector flag flipped on are all invisible
 * until something goes wrong. This checks them on a schedule instead of on an incident.
 *
 * Run:  node ops/health-check.mjs            (from the repo root, laptop, railway CLI logged in)
 *       node ops/health-check.mjs --json     (machine-readable, for piping into a report)
 *
 * It is READ-ONLY. It never creates, deletes, or modifies anything. In particular it uses the
 * GraphQL `domains` query and NEVER `railway domain`, which is a CREATE command wearing a read
 * command's name — that is exactly what caused the incident this file exists because of.
 *
 * Exit code 0 = all clear, 1 = at least one FAIL. WARNs do not fail the run.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_OUT = process.argv.includes("--json");

// --- expected invariants. Change these deliberately, never to make a check pass. ---
const EXPECT = {
  accessMode: "enforce",
  teamDomain: "domi-ai.cloudflareaccess.com",   // the AUTH domain, not the org display name
  audCount: 2,                                   // main app + hands service token
  publicHost: "app.dominion.tools",
  railwayProjectId: "42e60c2b-26c9-4dda-8934-bff746e15896",
  suites: ["accessjwt_test.mjs", "connectors_test.mjs", "wave3_test.mjs"],
  catalogMaxAgeDays: 10,                         // weekly audit + boot audits; 10d means it stalled
};

const results = [];
const add = (level, area, name, detail) => results.push({ level, area, name, detail });
const ok = (a, n, d) => add("PASS", a, n, d);
const warn = (a, n, d) => add("WARN", a, n, d);
const fail = (a, n, d) => add("FAIL", a, n, d);

function wallet() {
  const out = {};
  try {
    for (const l of readFileSync(join(homedir(), ".app-secrets.env"), "utf8").split(/\r?\n/)) {
      const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
    }
  } catch { /* wallet absent: checks that need it will report UNCHECKED */ }
  return out;
}

// Run a node script inside the Railway container. Base64 avoids every shell-quoting trap on the
// container side.
//
// On the LAUNCH side, resolve the real railway.exe and pass shell:false. Two Windows traps, both
// hit while writing this: `shell:true` routes through cmd.exe, whose quoting mangles the nested
// sh -c "..."; and modern Node refuses to spawn a .cmd shim at all without a shell (EINVAL). Going
// straight to the .exe sidesteps both — argv reaches the process with no reinterpretation.
// Either failure surfaces as "container unreachable", which reads like an outage rather than a
// launch bug, so check this first if the container checks all go UNCHECKED at once.
const RAILWAY_BIN = process.platform === "win32"
  ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
         "npm", "node_modules", "@railway", "cli", "bin", "railway.exe")
  : "railway";

function inContainer(src) {
  const b64 = Buffer.from(src).toString("base64");
  // .cjs, not .mjs: these snippets use require(), and the container's package.json makes a bare
  // .mjs ESM, where require is undefined.
  return execFileSync(RAILWAY_BIN, ["ssh", `sh -c "echo ${b64} | base64 -d > /tmp/_hc.cjs && node /tmp/_hc.cjs"`],
    { cwd: REPO, encoding: "utf8", timeout: 90000, stdio: ["ignore", "pipe", "pipe"] });
}

// ---------------------------------------------------------------- SECURITY

// 1. Identity posture. Checks CONFIG rather than a live counter: config is what drifts, and all
//    three bugs that nearly shipped on 2026-07-18 were config, not code.
async function checkAccessConfig() {
  let env;
  try {
    env = JSON.parse(inContainer(`
      console.log(JSON.stringify({
        mode: process.env.ACCESS_JWT || "(unset)",
        team: process.env.CF_ACCESS_TEAM_DOMAIN || "(unset)",
        aud: (process.env.CF_ACCESS_AUD || "").split(",").filter(Boolean).length,
      }));`).trim().split("\n").pop());
  } catch (e) {
    return warn("security", "access config", "UNCHECKED — container unreachable: " + String(e.message).slice(0, 80));
  }

  env.mode === EXPECT.accessMode
    ? ok("security", "ACCESS_JWT mode", env.mode)
    : fail("security", "ACCESS_JWT mode", `is "${env.mode}", expected "${EXPECT.accessMode}". Anything but enforce means a caller who omits the JWT is trusted on the raw header.`);

  env.team === EXPECT.teamDomain
    ? ok("security", "CF team domain", env.team)
    : fail("security", "CF team domain", `is "${env.team}", expected "${EXPECT.teamDomain}". The org DISPLAY name 404s the JWKS and the JWT layer silently does nothing.`);

  env.aud >= EXPECT.audCount
    ? ok("security", "CF audience tags", env.aud + " configured")
    : fail("security", "CF audience tags", `${env.aud} configured, expected ${EXPECT.audCount} (main app + hands service token). A missing aud takes the mini-PC node dark.`);

  // Tunnel-only ingress is the other half of the boundary: if cloudflared or its token ever went
  // missing and a Railway domain were added to "fix" the outage, the app would be public and
  // unauthenticated. Check the tunnel is the intended path, not an accident.
  try {
    const t = JSON.parse(inContainer(`
      const cp=require('child_process');
      let bin='none'; try{bin=cp.execSync('which cloudflared 2>/dev/null || echo none').toString().trim();}catch(e){}
      console.log(JSON.stringify({ token: !!process.env.TUNNEL_TOKEN, bin, pub: process.env.RAILWAY_PUBLIC_DOMAIN || "" }));
    `).trim().split("\n").pop());
    t.token && t.bin !== "none" && !t.pub
      ? ok("security", "tunnel-only ingress", "cloudflared present, TUNNEL_TOKEN set, no public domain")
      : warn("security", "tunnel-only ingress", `token:${t.token} bin:${t.bin} publicDomain:${t.pub || "none"} — expected all-tunnel.`);
  } catch (e) {
    warn("security", "tunnel-only ingress", "UNCHECKED — " + String(e.message).slice(0, 60));
  }

  // Independently prove the JWKS actually loads. keys:0 is the signal that verification is inert.
  try {
    const r = await fetch(`https://${env.team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const n = (j.keys || []).length;
    n > 0 ? ok("security", "JWKS reachable", `${n} signing key(s) live`)
          : fail("security", "JWKS reachable", "0 keys — JWT verification is inert regardless of mode.");
  } catch (e) {
    fail("security", "JWKS reachable", "could not load certs: " + String(e.message).slice(0, 80));
  }
}

// 2. Ingress. Any service domain other than the Access-gated host is an open door to the container.
async function checkDomains(w) {
  // Verified 2026-07-18: only RAILWAY_ACCOUNT_TOKEN authorizes against backboard, and only as a
  // Bearer header. RAILWAY_API_TOKEN returns "Not Authorized" either way.
  const token = w.RAILWAY_ACCOUNT_TOKEN;
  if (!token) return warn("security", "ingress domains", "UNCHECKED — RAILWAY_ACCOUNT_TOKEN not in wallet");
  const q = `query($id:String!){ project(id:$id){ services{ edges{ node{ name serviceInstances{ edges{ node{ domains{ serviceDomains{ domain } customDomains{ domain } } } } } } } } } }`;
  try {
    const r = await fetch("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token,
                 "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },  // CF bans the default UA
      body: JSON.stringify({ query: q, variables: { id: EXPECT.railwayProjectId } }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json();
    if (j.errors) return warn("security", "ingress domains", "UNCHECKED — GraphQL: " + j.errors[0].message.slice(0, 80));

    const gen = [], custom = [];
    for (const s of j.data.project.services.edges)
      for (const si of s.node.serviceInstances.edges) {
        for (const d of (si.node.domains.serviceDomains || [])) gen.push(d.domain);
        for (const d of (si.node.domains.customDomains || [])) custom.push(d.domain);
      }

    // Ingress is a Cloudflare TUNNEL (cloudflared in-container, TUNNEL_TOKEN set,
    // RAILWAY_PUBLIC_DOMAIN unset). The container holds no public hostname and dials out. So the
    // only correct expectation here is ZERO domains of either kind — a custom domain would not
    // appear even when everything is healthy, and any generated domain is a live Access bypass.
    const all = [...gen, ...custom];
    all.length === 0
      ? ok("security", "no public origin", "zero Railway domains — ingress is tunnel-only, no bypass path exists")
      : fail("security", "no public origin", `STRAY DOMAIN: ${all.join(", ")} — bypasses Cloudflare Access entirely. Delete via GraphQL serviceDomainDelete. Do NOT run "railway domain", which CREATES one.`);
  } catch (e) {
    warn("security", "ingress domains", "UNCHECKED — " + String(e.message).slice(0, 80));
  }
}

// 3. The tests that encode the incident. A red accessjwt suite means header trust is back.
function checkSuites() {
  for (const s of EXPECT.suites) {
    try {
      const out = execFileSync("node", [s], { cwd: REPO, encoding: "utf8", timeout: 120000 });
      const m = out.match(/(\d+) passed, (\d+) failed/);
      if (!m) { warn("feature", "suite " + s, "ran but no summary line found"); continue; }
      Number(m[2]) === 0
        ? ok("feature", "suite " + s, `${m[1]} passed`)
        : fail("feature", "suite " + s, `${m[2]} FAILED — do not deploy`);
    } catch (e) {
      fail("feature", "suite " + s, "crashed: " + String(e.message).slice(0, 100));
    }
  }
}

// 4. Tenant wall. Guest connector flags are a deliberate decision each time; drift here is silent.
function checkTenantWall() {
  try {
    const state = JSON.parse(inContainer(`
      const fs=require('fs');const d=process.env.DATA_DIR||'/data';
      const j=JSON.parse(fs.readFileSync(d+'/connectors.json','utf8'));
      console.log(JSON.stringify({
        enabled: Object.keys(j.enabled||{}).filter(k=>j.enabled[k]),
        guestOpen: Object.keys(j.guestFlags||{}).filter(k=>j.guestFlags[k]),
      }));`).trim().split("\n").pop());

    ok("feature", "owner connectors", state.enabled.join(", ") || "none");
    state.guestOpen.length === 0
      ? ok("security", "guest connectors closed", "none open")
      : warn("security", "guest connectors closed", `OPEN TO TENANTS: ${state.guestOpen.join(", ")} — confirm each was a deliberate decision.`);
  } catch (e) {
    warn("security", "tenant wall", "UNCHECKED — " + String(e.message).slice(0, 80));
  }

  // browser_control / desktop_control must never appear in FORGE_TOOLS: that is the single switch
  // that would hand real mouse/keyboard reach to paying guests.
  try {
    const src = readFileSync(join(REPO, "tenantstores.mjs"), "utf8");
    const forge = (src.match(/FORGE_TOOLS\s*=\s*\[([^\]]*)\]/) || [])[1] || "";
    /browser_control|desktop_control/.test(forge)
      ? fail("security", "machine reach owner-only", "browser_control/desktop_control found in FORGE_TOOLS — guests can drive a real mouse and keyboard.")
      : ok("security", "machine reach owner-only", "absent from FORGE_TOOLS");
  } catch (e) {
    warn("security", "machine reach owner-only", "UNCHECKED — " + String(e.message).slice(0, 60));
  }
}

// ---------------------------------------------------------------- FEATURE

// 5. The app answers at all.
async function checkLive() {
  try {
    const r = await fetch(`https://${EXPECT.publicHost}/api/version`, { signal: AbortSignal.timeout(20000) });
    const t = (await r.text()).slice(0, 120);
    r.ok ? ok("feature", "app responding", t) : warn("feature", "app responding", "HTTP " + r.status);
  } catch (e) {
    fail("feature", "app responding", String(e.message).slice(0, 80));
  }
}

// 6. Model catalog. The weekly self-audit already runs in-server; this checks it is still FIRING
//    and still clean, because a stalled audit looks identical to a passing one from outside.
function checkCatalog() {
  try {
    const a = JSON.parse(inContainer(`
      const fs=require('fs');const d=process.env.DATA_DIR||'/data';
      console.log(fs.readFileSync(d+'/catalog-audit.json','utf8'));`).trim().split("\n").slice(-40).join("\n").match(/\{[\s\S]*\}/)[0]);
    const ageDays = (Date.now() - new Date(a.checkedAt).getTime()) / 86400000;

    ageDays <= EXPECT.catalogMaxAgeDays
      ? ok("feature", "catalog audit fresh", `${ageDays.toFixed(1)}d old (trigger: ${a.trigger})`)
      : warn("feature", "catalog audit fresh", `${ageDays.toFixed(1)}d old — the weekly interval may have stalled.`);

    a.ok
      ? ok("feature", "model catalog clean", `providers: ${Object.keys(a.providers || {}).join(", ")}`)
      : fail("feature", "model catalog clean", `${a.problems.length} problem(s): ${a.problems.map(p => p.id || p).join("; ").slice(0, 200)}`);
  } catch (e) {
    warn("feature", "model catalog", "UNCHECKED — " + String(e.message).slice(0, 80));
  }
}

// ---------------------------------------------------------------- report

await checkAccessConfig();
await checkDomains(wallet());
checkSuites();
checkTenantWall();
await checkLive();
checkCatalog();

const fails = results.filter((r) => r.level === "FAIL");
const warns = results.filter((r) => r.level === "WARN");

if (JSON_OUT) {
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), ok: fails.length === 0, results }, null, 1));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log("\nDominion AI — security + feature health check");
  console.log("=".repeat(78));
  for (const area of ["security", "feature"]) {
    console.log(`\n[${area.toUpperCase()}]`);
    for (const r of results.filter((x) => x.area === area))
      console.log(`  ${pad(r.level, 5)} ${pad(r.name, 30)} ${r.detail}`);
  }
  console.log("\n" + "=".repeat(78));
  console.log(fails.length === 0
    ? `ALL CLEAR — ${results.length} checks, ${warns.length} warning(s)`
    : `${fails.length} FAILURE(S) — ${warns.length} warning(s)`);
  if (fails.length) console.log("\nSee docs/SECURITY-REVIEW-AND-HARDENING.md for what each invariant protects.");
}

process.exitCode = fails.length ? 1 : 0;
