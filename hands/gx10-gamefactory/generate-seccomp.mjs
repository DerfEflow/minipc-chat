#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const expectedSha256 = "01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28";
const input = process.argv[2];
const output = process.argv[3];
const role = process.argv[4];
if (!input || !output || !["controller", "executor", "broker"].includes(role)) {
  throw new Error("usage: node generate-seccomp.mjs MOBY_DEFAULT_JSON OUTPUT_JSON controller|executor|broker");
}
const bytes = /^https:\/\//i.test(input)
  ? Buffer.from(await (await fetch(input)).arrayBuffer())
  : readFileSync(input);
if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
  throw new Error("Moby 29.2.1 seccomp baseline checksum mismatch");
}
const profile = JSON.parse(bytes);
if (profile.defaultAction !== "SCMP_ACT_ERRNO" || !Array.isArray(profile.syscalls)) {
  throw new Error("unexpected Moby seccomp baseline structure");
}
const commonBlocked = new Set([
  "bpf", "clone3", "fork", "fsconfig", "fsmount", "fsopen", "fspick", "kexec_file_load", "kexec_load",
  "keyctl", "mount", "mount_setattr", "move_mount", "name_to_handle_at", "open_by_handle_at",
  "open_tree", "perf_event_open", "pivot_root", "process_vm_readv", "process_vm_writev", "ptrace",
  "request_key", "add_key", "sethostname", "setns", "socket", "socketcall", "socketpair", "statmount", "listmount",
  "umount", "umount2", "unshare", "userfaultfd", "vfork",
]);
const networkBlocked = new Set([
  "accept", "accept4", "bind", "connect", "getpeername", "getsockname", "getsockopt", "listen",
  "recv", "recvfrom", "recvmmsg", "recvmsg", "send", "sendmmsg", "sendmsg", "sendto", "setsockopt",
  "shutdown", "socket", "socketcall", "socketpair",
]);
profile.syscalls = profile.syscalls.flatMap((rule) => {
  if (rule.includes?.caps?.length || rule.excludes?.caps?.length) return [];
  const blocked = role === "controller" ? commonBlocked : new Set([...commonBlocked, ...networkBlocked]);
  if (role !== "broker") for (const name of ["pidfd_getfd", "pidfd_open", "pidfd_send_signal"]) blocked.add(name);
  const names = (rule.names || []).filter((name) => !blocked.has(name));
  return names.length ? [{ ...rule, names }] : [];
});
if (role === "broker") {
  profile.syscalls.unshift({
    names: ["clone"], action: "SCMP_ACT_ALLOW",
    args: [{ index: 0, value: 17, op: "SCMP_CMP_EQ" }],
    comment: "static broker fork-child primitive only: clone(flags=SIGCHLD)",
  });
} else {
  profile.syscalls.unshift({
    names: ["clone"], action: "SCMP_ACT_ALLOW",
    args: [{ index: 0, value: 4274257919, valueTwo: 69376, op: "SCMP_CMP_MASKED_EQ" }],
    comment: "pthread clone only: required VM|FS|FILES|SIGHAND|THREAD with only TLS/tid/SYSVSEM option bits",
  });
}
if (role === "controller") {
  for (const family of [2, 10, 16]) {
    profile.syscalls.unshift({
      names: ["socket"], action: "SCMP_ACT_ALLOW",
      args: [{ index: 0, value: family, op: "SCMP_CMP_EQ" }],
      comment: `controller network family ${family}; AF_UNIX, AF_ALG, AF_XDP and all others stay denied`,
    });
  }
}
profile.syscalls.unshift({
  names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38,
  comment: "return ENOSYS so glibc safely falls back to the masked clone rule",
});
if (profile.syscalls.some((rule) => rule.action === "SCMP_ACT_ALLOW" && (rule.names || []).includes("clone") && !(rule.args || []).length)) {
  throw new Error("generated profile contains a fail-open unconditional clone allowance");
}
for (const forbidden of ["fork", "vfork", "unshare", "setns", "mount", "pivot_root", "socketpair", "listmount", "statmount"]) {
  if (profile.syscalls.some((rule) => rule.action === "SCMP_ACT_ALLOW" && (rule.names || []).includes(forbidden))) {
    throw new Error(`generated ${role} profile permits forbidden syscall ${forbidden}`);
  }
}
writeFileSync(output, JSON.stringify(profile, null, 2) + "\n", { mode: 0o644 });
