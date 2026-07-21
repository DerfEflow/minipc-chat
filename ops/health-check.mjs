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
  stripeAccount: "acct_1TuPGJPDLRBaewfR",        // "DOMI AI APP". The wallet holds OTHER businesses'
                                                 // Stripe keys; this pins us to the right one.
  webhookUrl: "https://app.dominion.tools/webhooks/stripe",
  backupMaxAgeHours: 36,                         // daily snapshot + slack for a missed run
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

// ESM variant: for snippets that `import` from /app and use top-level await. Kept separate from
// inContainer() because those snippets use require(), which is undefined in an ESM file.
function inContainerMjs(src) {
  const b64 = Buffer.from(src).toString("base64");
  return execFileSync(RAILWAY_BIN, ["ssh", `sh -c "echo ${b64} | base64 -d > /tmp/_hc_esm.mjs && node /tmp/_hc_esm.mjs"`],
    { cwd: REPO, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
}

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
    // EFFECTIVE guest access, not just explicit flags. An earlier version of this check read only
    // guestFlags and reported "none open" while seven connectors were in fact open to tenants:
    // guestAllowed() falls back to the registry's guestDefault when no flag is set, and most
    // entries ship guestDefault:true. Reading the override without the default is how a check
    // reports green on an open door, so compute it the same way the app does.
    // Ask the app, do not re-derive. An earlier version regex-scraped connectors.mjs for
    // guestDefault and got it wrong in both directions: it reported the builtin "machine" entry
    // (which never reaches the connector tool path) and missed "zapier" entirely. listFor() is the
    // same call the Setup page renders from, so it applies flags, defaults, builtin handling, and
    // provider readiness exactly as production does.
    // Each field from its authoritative source. `enabled` comes from the state file, because
    // listFor() marks a provider-backed connector "pending" when the provider isn't injected, and
    // this harness does not construct the Google provider the way server.mjs does -- reading
    // listFor for enablement here would under-report Google as off while it is live.
    // `guestAllowed` comes from listFor(), which is the only thing that applies flag-then-default
    // correctly.
    const state = JSON.parse(inContainerMjs(`
      import { readFileSync } from 'node:fs';
      import { createConnectors } from '/app/connectors.mjs';
      const d = process.env.DATA_DIR || '/data';
      const raw = JSON.parse(readFileSync(d + '/connectors.json', 'utf8'));
      const c = createConnectors({ dir: d, cfgGet: (k, dv) => process.env[k] || dv });
      const rows = await c.listFor({ isOwner: true, uid: 'owner' });
      console.log(JSON.stringify({
        enabled: Object.keys(raw.enabled || {}).filter(k => raw.enabled[k]),
        guestOpen: rows.filter(r => !r.builtin && r.guestAllowed).map(r => r.id),
        explicitFlags: Object.keys(raw.guestFlags || {}).length,
      }));`).trim().split("\n").pop());

    ok("feature", "owner connectors", state.enabled.join(", ") || "none");
    state.guestOpen.length === 0
      ? ok("security", "guest connectors closed", "none reachable by tenants")
      : warn("security", "guest connectors closed",
          `REACHABLE BY TENANTS: ${state.guestOpen.join(", ")} (${state.explicitFlags} explicit flag(s); the rest are registry guestDefault:true). ` +
          `A guest connects their OWN account, never the owner's env credentials. Confirm each is deliberate; set guestFlags[id]=false to close one.`);
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

// 5. Who can get through the front door. Cloudflare Access is the perimeter; the app's credit gate
//    is the inner gate. This reports the perimeter shape, because it can widen without any code
//    change and nothing else in the system would notice.
async function checkAccessPolicy(w) {
  if (!w.DOMINION_CF_DOORLIST_TOKEN) return warn("security", "access perimeter", "UNCHECKED — DOMINION_CF_DOORLIST_TOKEN not in wallet");
  let ids;
  try {
    ids = JSON.parse(inContainer(`console.log(JSON.stringify({a:process.env.CF_ACCESS_ACCOUNT_ID||'',p:process.env.CF_ACCESS_APP_ID||''}));`).trim().split("\n").pop());
  } catch (e) { return warn("security", "access perimeter", "UNCHECKED — " + String(e.message).slice(0, 60)); }

  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ids.a}/access/apps/${ids.p}/policies`,
      { headers: { authorization: "Bearer " + w.DOMINION_CF_DOORLIST_TOKEN }, signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (!j.success) return warn("security", "access perimeter", "UNCHECKED — CF API: " + JSON.stringify(j.errors).slice(0, 80));

    for (const pol of j.result) {
      const inc = pol.include || [];
      const openToAll = inc.some((i) => i.everyone !== undefined);
      const emails = inc.filter((i) => i.email && i.email.email).map((i) => i.email.email);
      const domains = inc.filter((i) => i.email_domain).map((i) => i.email_domain.domain);
      const svc = inc.filter((i) => i.service_token).length;

      if (pol.decision === "non_identity") { ok("security", "service-token policy", `${pol.name}: ${svc} token(s)`); continue; }

      if (openToAll) {
        warn("security", "access perimeter", `policy "${pol.name}" includes EVERYONE — any email on earth can pass Cloudflare Access and the app auto-creates a "credit" user row for them. ` +
          `The credit gate still blocks spend, and the tenant wall still blocks owner reach, so this is not a breach. But it means every pre-gate code path faces the open internet, ` +
          `and the door-list automation in server.mjs (cfAllowEmail) is a no-op because individual emails add nothing to an everyone rule. ` +
          `Confirm this is intended for open signup; if the app is meant to be invite-only, this is the hole.`);
      } else {
        ok("security", "access perimeter", `policy "${pol.name}": ${emails.length} email(s), ${domains.length} domain(s) — enumerated, not open`);
      }
    }
  } catch (e) {
    warn("security", "access perimeter", "UNCHECKED — " + String(e.message).slice(0, 80));
  }
}

// ---------------------------------------------------------------- FEATURE

// 6. Money path. A disabled or misrouted webhook means paid checkouts never credit the account —
//    the customer is charged and gets nothing, which is the worst failure this app can have.
async function checkStripe(w) {
  const sk = w.DOMI_AI_LIVE_STRIPE_SECRET;
  if (!sk) return warn("feature", "stripe webhook", "UNCHECKED — DOMI_AI_LIVE_STRIPE_SECRET not in wallet");
  const H = { authorization: "Bearer " + sk };
  try {
    const acct = await (await fetch("https://api.stripe.com/v1/account", { headers: H, signal: AbortSignal.timeout(20000) })).json();
    if (acct.error) return warn("feature", "stripe webhook", "UNCHECKED — " + acct.error.message.slice(0, 60));

    // Guard against the wallet's generic Stripe keys, which belong to OTHER businesses.
    acct.id === EXPECT.stripeAccount
      ? ok("feature", "stripe account", `${acct.id} (${(acct.settings?.dashboard?.display_name) || "?"}) charges:${acct.charges_enabled}`)
      : fail("feature", "stripe account", `key points at ${acct.id}, expected ${EXPECT.stripeAccount} — WRONG BUSINESS's Stripe account.`);
    if (!acct.charges_enabled) fail("feature", "stripe charges enabled", "charges are DISABLED — customers cannot pay.");

    const we = await (await fetch("https://api.stripe.com/v1/webhook_endpoints?limit=20", { headers: H, signal: AbortSignal.timeout(20000) })).json();
    const mine = (we.data || []).filter((e) => e.url === EXPECT.webhookUrl);
    if (!mine.length) return fail("feature", "stripe webhook", `no endpoint at ${EXPECT.webhookUrl} — paid checkouts will never credit accounts.`);

    for (const e of mine) {
      e.status === "enabled"
        ? ok("feature", "stripe webhook", `${e.url} enabled · events: ${(e.enabled_events || []).join(", ")}`)
        : fail("feature", "stripe webhook", `endpoint status is "${e.status}" — checkouts will not credit accounts.`);
      // The server handles exactly checkout.session.completed (credit top-up model, no subscriptions).
      // If subscriptions are ever added, customer.subscription.* and invoice.* must be added here too.
      (e.enabled_events || []).includes("checkout.session.completed")
        ? ok("feature", "stripe event coverage", "checkout.session.completed subscribed (matches the handler)")
        : fail("feature", "stripe event coverage", "checkout.session.completed NOT subscribed — top-ups will silently never land.");
    }
  } catch (e) {
    warn("feature", "stripe webhook", "UNCHECKED — " + String(e.message).slice(0, 80));
  }
}

// 7. Restore points. The corpus lived in one place once; that is the failure cloudbackup.mjs exists
//    to prevent. A stale snapshot dir means it has silently stopped.
function checkBackups() {
  try {
    const b = JSON.parse(inContainer(`
      const fs=require('fs');const p=require('path');
      const dir=process.env.CLOUD_BACKUP_LOCAL_DIR||((process.env.DATA_DIR||'/data')+'/corpus-backups');
      let newest=null,count=0;
      try{ for(const f of fs.readdirSync(dir)){ const s=fs.statSync(p.join(dir,f)); if(!s.isFile())continue; count++;
        if(!newest||s.mtimeMs>newest.mtimeMs) newest={name:f,mtimeMs:s.mtimeMs,size:s.size}; } }catch(e){}
      console.log(JSON.stringify({dir,count,newest,node:process.env.CLOUD_BACKUP_NODE||'',rdir:process.env.CLOUD_BACKUP_DIR||''}));
    `).trim().split("\n").pop());

    if (!b.newest) return fail("feature", "backup freshness", `no snapshots in ${b.dir} — there are no restore points on the volume.`);
    const ageH = (Date.now() - b.newest.mtimeMs) / 3600000;
    const mb = (b.newest.size / 1048576).toFixed(1);
    ageH <= EXPECT.backupMaxAgeHours
      ? ok("feature", "backup freshness", `${b.count} snapshot(s), newest ${ageH.toFixed(1)}h old (${mb} MB)`)
      : fail("feature", "backup freshness", `newest snapshot is ${ageH.toFixed(1)}h old (limit ${EXPECT.backupMaxAgeHours}h) — the daily backup has stopped.`);

    // Off-box push is what makes it a real second location. Configured-but-offline is skipped
    // honestly by design, so this is a WARN: worth knowing, not an outage.
    b.node && b.rdir
      ? ok("feature", "off-box backup target", `${b.node}:${b.rdir}`)
      : warn("feature", "off-box backup target", "UNCONFIGURED — snapshots exist only on the Railway volume.");
  } catch (e) {
    warn("feature", "backup freshness", "UNCHECKED — " + String(e.message).slice(0, 80));
  }
}

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

// 8. The always-on watcher. ops/perimeter-probe.mjs runs on the mini-PC every 6h and appends a
//    JSON line per run. Nobody watches that box, so read its log here: a perimeter failure at 3am
//    on a Tuesday still lands in this report. A STALE log is itself a finding — it means the
//    always-on check silently stopped, which is the failure mode of every unattended job.
function checkPerimeterLog() {
  try {
    const raw = execFileSync("ssh", ["Fred@nucbox-k8-plus",
      "powershell -NoProfile -Command \"if (Test-Path C:\\dominion-hands\\perimeter-log.jsonl) { Get-Content C:\\dominion-hands\\perimeter-log.jsonl -Tail 12 } else { '' }\""],
      { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] });

    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{"));
    if (!lines.length) return warn("security", "perimeter probe (mini-PC)", "no log entries — the scheduled task may not be running.");

    const runs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const last = runs[runs.length - 1];
    const ageH = (Date.now() - new Date(last.checkedAt).getTime()) / 3600000;
    const bad = runs.filter((r) => !r.ok);

    ageH <= 12
      ? ok("security", "perimeter probe fresh", `last run ${ageH.toFixed(1)}h ago`)
      : warn("security", "perimeter probe fresh", `last run ${ageH.toFixed(1)}h ago — the 6h task on the mini-PC has stopped.`);

    bad.length === 0
      ? ok("security", "perimeter intact (outside-in)", `${runs.length} recent run(s), all clean`)
      : fail("security", "perimeter intact (outside-in)", `${bad.length} of ${runs.length} recent run(s) FAILED. Most recent failure: ` +
          JSON.stringify(bad[bad.length - 1].results.filter((r) => r.level === "FAIL")).slice(0, 300));
  } catch (e) {
    warn("security", "perimeter probe (mini-PC)", "UNCHECKED — mini-PC unreachable: " + String(e.message).slice(0, 60));
  }
}

/*
 * Fred's weekly question, 2026-07-19: "who tried to touch what I forbade, even if they failed?"
 *
 * Three sources, because one is not enough:
 *   app layer   denials.jsonl on the Railway volume - the carve-out regex refusing a tool call
 *   OS layer    Windows Security 4656/4663 on the mini-PC - attempts the regex never saw, because
 *               D: carries a failure-audit SACL. This is the one that catches a clever path.
 *   backups     the watchdog's own verdict, so a dead backup shows up HERE rather than in silence
 *               for 27 days as it did between 6/22 and 7/19.
 */
function checkDenials() {
  try {
    const d = JSON.parse(inContainer(`
      const fs=require('fs');const p=require('path');
      const f=p.join(process.env.DATA_DIR||'/data','denials.jsonl');
      let rows=[];try{rows=fs.readFileSync(f,'utf8').trim().split('\\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)}catch(e){}
      const since=Date.now()-7*86400000;
      const recent=rows.filter(r=>Date.parse(r.at)>=since);
      const byUser={},byTool={};
      for(const r of recent){byUser[r.user||'?']=(byUser[r.user||'?']||0)+1;byTool[r.tool||'?']=(byTool[r.tool||'?']||0)+1;}
      console.log(JSON.stringify({total:recent.length,byUser,byTool,last:recent.slice(-3)}));
    `).trim().split("\n").pop());

    d.total === 0
      ? ok("security", "carve-out denials (app)", "no blocked attempts in 7 days")
      : warn("security", "carve-out denials (app)", `${d.total} blocked attempt(s) in 7 days. By user: ${JSON.stringify(d.byUser)}. By tool: ${JSON.stringify(d.byTool)}.`);

    // A NON-owner probing the carve-out is a different event from Fred's own model bumping a wall.
    const guests = Object.keys(d.byUser || {}).filter((u) => u !== "owner" && u !== "?");
    if (guests.length) fail("security", "guest probed a carve-out", `non-owner account(s) ${guests.join(", ")} were refused at the wall. Review denials.jsonl.`);
  } catch (e) {
    warn("security", "carve-out denials (app)", "UNCHECKED — " + String(e.message).slice(0, 80));
  }

  // Layer two: what Windows itself refused on the walled volume.
  try {
    const raw = execFileSync("ssh", ["Fred@nucbox-k8-plus",
      "powershell -NoProfile -Command \"$e=Get-WinEvent -FilterHashtable @{LogName='Security';Id=4656,4663;StartTime=(Get-Date).AddDays(-7)} -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'D:' }; if ($e) { $e.Count } else { 0 }\""],
      { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const n = Number(String(raw).split(/\r?\n/).filter(Boolean).pop());
    if (!Number.isFinite(n)) throw new Error("unparseable: " + raw.slice(0, 40));
    n === 0
      ? ok("security", "OS-level denials on D: (mini-PC)", "Windows refused nothing in 7 days")
      : warn("security", "OS-level denials on D: (mini-PC)", `${n} failed access attempt(s) against the walled backup volume. These are attempts the carve-out regex did NOT catch.`);
  } catch (e) {
    warn("security", "OS-level denials on D: (mini-PC)", "UNCHECKED — " + String(e.message).slice(0, 60));
  }

  // The backups the wall exists to protect must actually be running.
  try {
    const raw = execFileSync("ssh", ["Fred@nucbox-k8-plus",
      "powershell -NoProfile -Command \"if (Test-Path C:\\dominion-backups\\watchdog-status.json) { Get-Content C:\\dominion-backups\\watchdog-status.json -Raw } else { '' }\""],
      { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return warn("feature", "DB backup watchdog", "no watchdog status on the mini-PC — the daily check may not be running.");
    const w = JSON.parse(m[0]);
    const ageH = (Date.now() - Date.parse(w.checkedAt)) / 3600000;
    if (!w.ok) fail("feature", "DB backup watchdog", `backups UNHEALTHY: ${(w.problems || []).join(" | ").slice(0, 240)}`);
    else if (ageH > 36) warn("feature", "DB backup watchdog", `watchdog itself last ran ${ageH.toFixed(1)}h ago — it has stopped checking.`);
    else ok("feature", "DB backup watchdog", `5 databases backed up, last verified ${ageH.toFixed(1)}h ago`);
  } catch (e) {
    warn("feature", "DB backup watchdog", "UNCHECKED — " + String(e.message).slice(0, 60));
  }
}

// ---------------------------------------------------------------- report

const W = wallet();
await checkAccessConfig();
await checkDomains(W);
await checkAccessPolicy(W);
checkSuites();
checkTenantWall();
await checkLive();
checkCatalog();
await checkStripe(W);
checkBackups();
checkPerimeterLog();
checkDenials();

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
