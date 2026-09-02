import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FULL_MASK_TEXT = "18446744073688842239";
const FULL_MASK = 0xfffffffffec3ffffn;
const REQUIRED = 0x10f00n;
const OPTIONAL = 0x13c0000n;

function load(role) {
  const path = new URL(`./seccomp-gx10-gamefactory-${role}.json`, import.meta.url);
  const raw = readFileSync(path, "utf8");
  assert.match(raw, new RegExp(`"value": ${FULL_MASK_TEXT}(?:,|\\s)`));
  assert.doesNotMatch(raw, /"value": (?:4274257919|18446744073688842000)(?:,|\s)/);
  // JSON.parse uses IEEE-754. Quote only the reviewed raw uint64 token for structural inspection.
  const parsed = JSON.parse(raw.replace(`"value": ${FULL_MASK_TEXT}`, `"value": "${FULL_MASK_TEXT}"`));
  const cloneRules = parsed.syscalls.filter((rule) => rule.names.includes("clone"));
  assert.equal(cloneRules.length, role === "broker" ? 2 : 1);
  const thread = cloneRules.find((rule) => rule.args?.[0]?.op === "SCMP_CMP_MASKED_EQ");
  assert.ok(thread);
  assert.equal(thread.args.length, 1, "runc ORs repeated arg-index predicates; exactly one is allowed");
  assert.equal(thread.args[0].value, FULL_MASK_TEXT);
  assert.equal(thread.args[0].valueTwo, Number(REQUIRED));
  if (role === "broker") {
    const child = cloneRules.find((rule) => rule.args?.[0]?.op === "SCMP_CMP_EQ");
    assert.deepEqual(child.args, [{ index: 0, value: 17, op: "SCMP_CMP_EQ" }]);
  }
  const clone3 = parsed.syscalls.filter((rule) => rule.names.includes("clone3"));
  assert.equal(clone3.length, 1);
  assert.equal(clone3[0].action, "SCMP_ACT_ERRNO");
  assert.equal(clone3[0].errnoRet, 38);
  const allowed = new Set(parsed.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW")
    .flatMap((rule) => rule.names));
  for (const forbidden of ["fork", "vfork", "socketpair", "unshare", "setns", "mount",
    "pivot_root", "listmount", "statmount", "bpf", "perf_event_open", "keyctl",
    "process_vm_readv", "process_vm_writev", "ptrace"]) assert.equal(allowed.has(forbidden), false);
  for (const syscall of ["landlock_add_rule", "landlock_create_ruleset", "landlock_restrict_self"]) {
    assert.equal(allowed.has(syscall), role === "broker", `${syscall} is setup-only in the broker profile`);
  }
  assert.equal(allowed.has("symlinkat"), role === "broker",
    "only the static broker may publish an exact retained-generation indirection link");
  return parsed;
}

const threadAllowed = (flags) => (BigInt(flags) & FULL_MASK) === REQUIRED;
assert.equal(threadAllowed(REQUIRED), true);
const optionalBits = Array.from({ length: 32 }, (_, bit) => 1n << BigInt(bit))
  .filter((bit) => (OPTIONAL & bit) !== 0n);
for (let subset = 0; subset < (1 << optionalBits.length); subset++) {
  let flags = REQUIRED;
  for (let bit = 0; bit < optionalBits.length; bit++) if (subset & (1 << bit)) flags |= optionalBits[bit];
  assert.equal(threadAllowed(flags), true, `reviewed pthread optional subset ${subset} must pass`);
}
assert.equal(threadAllowed(REQUIRED | OPTIONAL), true);
assert.equal(threadAllowed(0n), false);
assert.equal(threadAllowed(17n), false);
assert.equal(threadAllowed(OPTIONAL), false);
for (let bit = 0n; bit < 32n; bit++) {
  const mask = 1n << bit;
  if ((REQUIRED & mask) !== 0n) assert.equal(threadAllowed(REQUIRED & ~mask), false);
}
for (const forbiddenBit of [0x80n, 0x20000n, 0x02000000n, 0x04000000n, 0x08000000n,
  0x10000000n, 0x20000000n, 0x40000000n, 0x80000000n, 1n << 32n, 1n << 33n,
  1n << 63n]) assert.equal(threadAllowed(REQUIRED | forbiddenBit), false);
assert.equal(threadAllowed(0xffffffffffffffffn), false);

load("controller");
load("broker");
console.log("exact service seccomp structural and uint64 clone-mask tests passed");
