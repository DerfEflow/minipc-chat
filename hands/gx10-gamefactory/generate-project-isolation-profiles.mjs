import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const policyPath = join(directory, "dominion-gx10-gamefactory-broker.apparmor");
const projects = [
  "system-canary", "vector-vault", "bolt-bloom", "pocket-gravity", "chromalock",
  "tiny-foundry", "letter-loom", "pulse-path", "shelf-shift", "wobble-works", "signal-grid",
];
const workspaceEntries = ["system-canary-sibling", ...projects];
const generationPattern = "?".repeat(64);
const begin = "  # BEGIN GENERATED FIXED PROJECT ISOLATION";
const end = "  # END GENERATED FIXED PROJECT ISOLATION";

function rulesFor(selected) {
  const lines = [
    begin,
    "  deny /workspace/ r,",
    "  /workspace/lost+found r,",
    "  deny /workspace/lost+found/ rwklmx,",
    "  deny /workspace/lost+found/** rwklmx,",
    "  deny /workspace/.projects/ r,",
    "  deny /workspace/.projects/lost-found-gate/ rwklmx,",
    "  deny /workspace/.projects/lost-found-gate/** rwklmx,",
  ];
  for (const sibling of workspaceEntries) {
    lines.push(`  /workspace/${sibling} r,`);
    if (sibling === selected) continue;
    lines.push(`  deny /workspace/${sibling}/ rwklmx,`);
    lines.push(`  deny /workspace/${sibling}/** rwklmx,`);
    lines.push(`  deny /workspace/.projects/${sibling}/ rwklmx,`);
    lines.push(`  deny /workspace/.projects/${sibling}/** rwklmx,`);
  }
  lines.push(`  /workspace/${selected}/ rw,`);
  lines.push(`  /workspace/${selected}/** rwk,`);
  lines.push(`  deny /workspace/.projects/${selected}/ wklmx,`);
  lines.push(`  /workspace/.projects/${selected}/data/ rw,`);
  lines.push(`  /workspace/.projects/${selected}/data/** rwk,`);
  lines.push("  deny /runtime/ r,");
  lines.push("  /runtime/lost+found r,");
  lines.push("  deny /runtime/lost+found/ rwklmx,");
  lines.push("  deny /runtime/lost+found/** rwklmx,");
  lines.push("  deny /runtime/payload/ r,");
  lines.push("  deny /runtime/payload/.private/ r,");
  lines.push("  deny /runtime/payload/.private/retained-gate/ rwklmx,");
  lines.push("  deny /runtime/payload/.private/retained-gate/** rwklmx,");
  lines.push("  deny /runtime/payload/.private/sibling-gate/ rwklmx,");
  lines.push("  deny /runtime/payload/.private/sibling-gate/** rwklmx,");
  lines.push("  deny /runtime/payload/.private/lost-found-gate/ rwklmx,");
  lines.push("  deny /runtime/payload/.private/lost-found-gate/** rwklmx,");
  lines.push("  /runtime/payload/retained r,");
  lines.push("  deny /runtime/payload/retained/ rwklmx,");
  lines.push("  deny /runtime/payload/retained/** rwklmx,");
  lines.push(`  /runtime/payload/${generationPattern} r,`);
  lines.push(`  deny /runtime/payload/${generationPattern}/ rwklmx,`);
  lines.push(`  deny /runtime/payload/${generationPattern}/** rwklmx,`);
  lines.push("  /runtime/payload/system-canary-sibling r,");
  lines.push("  deny /runtime/payload/system-canary-sibling/ rwklmx,");
  lines.push("  deny /runtime/payload/system-canary-sibling/** rwklmx,");
  lines.push("  deny /runtime/payload/active/ r,");
  lines.push("  deny /runtime/payload/active/system-canary-sibling/ rwklmx,");
  lines.push("  deny /runtime/payload/active/system-canary-sibling/** rwklmx,");
  for (const sibling of projects) {
    if (sibling === selected) continue;
    lines.push(`  deny /runtime/payload/active/${sibling}/ rwklmx,`);
    lines.push(`  deny /runtime/payload/active/${sibling}/** rwklmx,`);
  }
  lines.push(`  /runtime/payload/active/${selected}/ rw,`);
  lines.push(`  /runtime/payload/active/${selected}/** rwk,`);
  lines.push(end);
  return lines.join("\n");
}

function replaceProfile(policy, kind, program, project) {
  const profile = `profile dominion-gx10-${kind}-${program}-${project}`;
  const start = policy.indexOf(profile);
  if (start < 0) throw new Error(`missing profile: ${profile}`);
  const finish = policy.indexOf("\n}\n", start);
  if (finish < 0) throw new Error(`unterminated profile: ${profile}`);
  const block = policy.slice(start, finish);
  const generatedStart = block.indexOf(begin);
  let updated;
  if (generatedStart >= 0) {
    const generatedEnd = block.indexOf(end, generatedStart);
    if (generatedEnd < 0) throw new Error(`unterminated generated isolation block: ${profile}`);
    updated = block.slice(0, generatedStart) + rulesFor(project)
      + block.slice(generatedEnd + end.length);
  } else {
    const legacy = [
      `  /workspace/${project}/ rw,`,
      `  /workspace/${project}/** rwk,`,
      "  /runtime/payload/ rw,",
      "  /runtime/payload/** rwk,",
    ].join("\n");
    if (!block.includes(legacy)) throw new Error(`legacy mutable paths differ: ${profile}`);
    updated = block.replace(legacy, rulesFor(project));
  }
  return policy.slice(0, start) + updated + policy.slice(finish);
}

let policy = readFileSync(policyPath, "utf8");
for (const project of projects) {
  for (const program of ["node", "godot"]) {
    for (const kind of ["guard", "payload"]) policy = replaceProfile(policy, kind, program, project);
  }
}

if (process.argv.includes("--write")) writeFileSync(policyPath, policy);
else if (policy !== readFileSync(policyPath, "utf8")) {
  throw new Error("AppArmor project-isolation profiles are not generated from the fixed matrix");
}

console.log(`verified ${projects.length * 4} fixed project-isolation profile blocks`);
