#!/usr/bin/env node
/* Generate scratch-built outer profiles. No Moby allowlist is inherited. */
import { writeFileSync } from "node:fs";

// OCI seccomp arguments are uint64. JavaScript Number cannot exactly represent this mask, so the
// serializer replaces one quoted sentinel with the reviewed unquoted decimal token. Never parse
// and re-stringify the generated artifact in JavaScript.
const THREAD_CLONE_MASK_SENTINEL = "__DOMINION_THREAD_CLONE_MASK_UINT64__";
const THREAD_CLONE_MASK_DECIMAL = "18446744073688842239"; // 0xfffffffffec3ffff
const THREAD_CLONE_REQUIRED = 69376; // 0x00010f00

const output = process.argv[2], role = process.argv[3];
if (!output || !["controller", "broker"].includes(role)) {
  throw new Error("usage: node generate-exact-service-seccomp.mjs OUTPUT controller|broker");
}
const common = [
  "access", "arch_prctl", "brk", "capget", "chdir", "chmod", "clock_getres", "clock_gettime",
  "clock_nanosleep", "close", "close_range", "copy_file_range", "dup", "dup2", "dup3", "execveat",
  "execve", "exit", "exit_group", "faccessat", "faccessat2", "fadvise64", "fallocate", "fchdir", "fchmod",
  "fchmodat", "fcntl", "fdatasync", "flock", "fstat", "fstatfs", "fsync", "ftruncate", "futex",
  "futex_waitv", "getcwd", "getdents64", "getegid", "geteuid", "getgid", "getgroups", "getitimer",
  "getpid", "getppid", "getrandom", "getresgid", "getresuid", "getrlimit", "getrusage", "gettid",
  "gettimeofday", "getuid", "ioctl", "lgetxattr", "listxattr", "llistxattr", "lseek", "madvise",
  "membarrier", "mincore", "mkdir", "mkdirat", "mmap", "mprotect", "mremap", "msync", "munmap",
  "nanosleep", "newfstatat", "openat", "openat2", "pipe", "pipe2", "poll", "ppoll", "pread64",
  "preadv", "preadv2", "pselect6", "pwrite64", "pwritev", "pwritev2", "read", "readahead", "readlink",
  "readlinkat", "readv", "rename", "renameat", "renameat2", "restart_syscall", "rseq", "rt_sigaction",
  "rt_sigpending", "rt_sigprocmask", "rt_sigreturn", "rt_sigsuspend", "rt_sigtimedwait", "sched_yield",
  "set_robust_list", "set_tid_address", "setitimer", "setrlimit", "sigaltstack", "stat", "statfs", "statx",
  "sysinfo", "tgkill", "time", "times", "tkill", "truncate", "umask", "uname", "unlink", "unlinkat",
  "utimensat", "wait4", "waitid", "write", "writev", "epoll_create", "epoll_create1", "epoll_ctl",
  "epoll_pwait", "epoll_pwait2", "epoll_wait", "eventfd", "eventfd2", "get_robust_list", "getsid",
  "prlimit64", "sched_getaffinity", "sched_getattr", "sched_getparam", "sched_getscheduler", "prctl",
];
const godot = ["getxattr", "inotify_add_watch", "inotify_init", "inotify_init1", "inotify_rm_watch",
  "removexattr", "sendfile", "setxattr"];
const controllerNetwork = ["accept", "accept4", "bind", "connect", "getpeername", "getsockname", "getsockopt",
  "listen", "recv", "recvfrom", "recvmmsg", "recvmsg", "send", "sendmmsg", "sendmsg", "sendto", "setsockopt", "shutdown"];
const brokerOnly = ["fchown", "fchownat", "landlock_add_rule", "landlock_create_ruleset",
  "landlock_restrict_self", "pidfd_open", "pidfd_send_signal", "seccomp", "setsid", "symlinkat"];
// Node 24 implements fs.linkSync() with linkat(AT_FDCWD, ..., AT_FDCWD, ..., 0) on the
// production arm64/glibc runtime. Keep both ABI spellings controller-only so the durable
// no-replace publisher works across the reviewed architectures without granting the static broker
// another namespace mutation primitive.
const names = [...new Set([...common, ...(role === "broker" ? [...godot, ...brokerOnly] : [...controllerNetwork, "link", "linkat"])])].sort();
const profile = { defaultAction: "SCMP_ACT_ERRNO", defaultErrnoRet: 1,
  archMap: [
    { architecture: "SCMP_ARCH_AARCH64", subArchitectures: ["SCMP_ARCH_ARM"] },
    { architecture: "SCMP_ARCH_X86_64", subArchitectures: ["SCMP_ARCH_X86", "SCMP_ARCH_X32"] },
  ], syscalls: [
    { names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38,
      comment: "force known clone ABI; glibc falls back to clone" },
    { names: ["clone"], action: "SCMP_ACT_ALLOW", args: [
      { index: 0, value: THREAD_CLONE_MASK_SENTINEL, valueTwo: THREAD_CLONE_REQUIRED,
        op: "SCMP_CMP_MASKED_EQ" },
    ], comment: "pthread semantics only" },
    ...(role === "broker" ? [{ names: ["clone"], action: "SCMP_ACT_ALLOW",
      args: [{ index: 0, value: 17, op: "SCMP_CMP_EQ" }], comment: "raw broker child clone(SIGCHLD) only" }] : []),
    { names, action: "SCMP_ACT_ALLOW" },
    ...(role === "controller" ? [2, 10, 16].map((family) => ({ names: ["socket"], action: "SCMP_ACT_ALLOW",
      args: [{ index: 0, value: family, op: "SCMP_CMP_EQ" }], comment: `controller AF ${family}` })) : []),
  ] };
const forbidden = ["fork", "vfork", "socketpair", "socketcall", "unshare", "setns", "mount", "pivot_root",
  "listmount", "statmount", "bpf", "perf_event_open", "keyctl", "process_vm_readv", "process_vm_writev", "ptrace"];
for (const name of forbidden) if (profile.syscalls.some((rule) => rule.action === "SCMP_ACT_ALLOW" && rule.names.includes(name))) {
  throw new Error(`scratch-built ${role} profile unexpectedly allows ${name}`);
}
const quotedSentinel = JSON.stringify(THREAD_CLONE_MASK_SENTINEL);
const serialized = JSON.stringify(profile, null, 2);
if (serialized.split(quotedSentinel).length !== 2) {
  throw new Error("thread-clone uint64 mask sentinel was not serialized exactly once");
}
const exact = serialized.replace(quotedSentinel, THREAD_CLONE_MASK_DECIMAL) + "\n";
if (!exact.includes(`"value": ${THREAD_CLONE_MASK_DECIMAL}`)
    || exact.includes("4274257919") || exact.includes("18446744073688842000")) {
  throw new Error("thread-clone uint64 mask was corrupted during serialization");
}
writeFileSync(output, exact, { mode: 0o644 });
