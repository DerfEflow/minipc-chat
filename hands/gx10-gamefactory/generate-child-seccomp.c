/* Build architecture-native, runtime-specific, default-deny filters consumed by fd-launcher. */
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <seccomp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <unistd.h>

static void allow_name(scmp_filter_ctx context, const char *name) {
  int number = seccomp_syscall_resolve_name(name);
  if (number != __NR_SCMP_ERROR && seccomp_rule_add(context, SCMP_ACT_ALLOW, number, 0) < 0) {
    fprintf(stderr, "could not allow syscall %s\n", name);
    exit(2);
  }
}

static void allow_arg0_zero(scmp_filter_ctx context, const char *name) {
  int number = seccomp_syscall_resolve_name(name);
  if (number != __NR_SCMP_ERROR
      && seccomp_rule_add(context, SCMP_ACT_ALLOW, number, 1, SCMP_A0(SCMP_CMP_EQ, 0)) < 0) exit(2);
}

static void allow_prctl(scmp_filter_ctx context, unsigned long option) {
  int number = seccomp_syscall_resolve_name("prctl");
  if (number != __NR_SCMP_ERROR
      && seccomp_rule_add(context, SCMP_ACT_ALLOW, number, 1, SCMP_A0(SCMP_CMP_EQ, option)) < 0) exit(2);
}

static void allow_prctl_arg1(scmp_filter_ctx context, unsigned long option, unsigned long value) {
  int number = seccomp_syscall_resolve_name("prctl");
  if (number != __NR_SCMP_ERROR
      && seccomp_rule_add(context, SCMP_ACT_ALLOW, number, 2,
        SCMP_A0(SCMP_CMP_EQ, option), SCMP_A1(SCMP_CMP_EQ, value)) < 0) exit(2);
}

static void allow_stdio_nonblock(scmp_filter_ctx context, int descriptor) {
  int number = seccomp_syscall_resolve_name("ioctl");
  if (number != __NR_SCMP_ERROR
      && seccomp_rule_add(context, SCMP_ACT_ALLOW, number, 2,
        SCMP_A0(SCMP_CMP_EQ, descriptor), SCMP_A1(SCMP_CMP_EQ, FIONBIO)) < 0) exit(2);
}

static void allow_list(scmp_filter_ctx context, const char *const *names, size_t count) {
  for (size_t index = 0; index < count; index++) allow_name(context, names[index]);
}

int main(int argc, char **argv) {
  if (argc != 3 || (strcmp(argv[1], "node") && strcmp(argv[1], "godot"))) return 64;
  const int is_node = !strcmp(argv[1], "node");
  scmp_filter_ctx context = seccomp_init(SCMP_ACT_ERRNO(EPERM));
  if (!context) return 2;
  if (seccomp_attr_set(context, SCMP_FLTATR_CTL_NNP, 0) < 0
      || seccomp_attr_set(context, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_KILL_PROCESS) < 0) return 2;

  const char *common[] = {
    "access", "arch_prctl", "brk", "capget", "chdir", "clock_getres", "clock_gettime",
    "clock_nanosleep", "close", "close_range", "copy_file_range", "dup", "dup2", "dup3", "execveat",
    "exit", "exit_group", "faccessat", "faccessat2", "fadvise64", "fallocate", "fchdir",
    "fcntl", "fdatasync", "fstat", "fstatfs", "fsync", "ftruncate", "futex",
    "futex_waitv", "getcwd", "getdents64", "getegid", "geteuid", "getgid", "getgroups", "getitimer",
    "getpid", "getppid", "getrandom", "getresgid", "getresuid", "getrlimit", "getrusage", "gettid",
    "gettimeofday", "getuid", "lgetxattr", "listxattr", "llistxattr", "lseek", "madvise",
    "membarrier", "mincore", "mkdir", "mkdirat", "mmap", "mprotect", "mremap", "msync", "munmap",
    "nanosleep", "newfstatat", "openat", "openat2", "pipe", "pipe2", "poll", "ppoll", "pread64",
    "preadv", "preadv2", "pselect6", "pwrite64", "pwritev", "pwritev2", "read", "readahead", "readlink",
    "readlinkat", "readv", "rename", "renameat", "renameat2", "restart_syscall", "rseq", "rt_sigaction",
    "rt_sigpending", "rt_sigprocmask", "rt_sigreturn", "rt_sigsuspend", "rt_sigtimedwait", "sched_yield",
    "set_robust_list", "set_tid_address", "setitimer", "setrlimit", "sigaltstack", "stat", "statfs", "statx",
    "sysinfo", "tgkill", "time", "times", "tkill", "truncate", "umask", "uname", "unlink", "unlinkat",
    "wait4", "waitid", "write", "writev",
  };
  const char *node_only[] = {
    "epoll_create", "epoll_create1", "epoll_ctl", "epoll_pwait", "epoll_pwait2", "epoll_wait",
    "eventfd", "eventfd2",
  };
  const char *godot_only[] = {
    "getxattr", "inotify_add_watch", "inotify_init", "inotify_init1", "inotify_rm_watch", "sendfile",
  };
  allow_list(context, common, sizeof(common) / sizeof(common[0]));
  if (is_node) allow_list(context, node_only, sizeof(node_only) / sizeof(node_only[0]));
  else allow_list(context, godot_only, sizeof(godot_only) / sizeof(godot_only[0]));

  /* Linux libuv adopts Node's inherited anonymous stdout/stderr pipes with
     ioctl(FIONBIO). Keep ioctl default-denied for every other descriptor and request. */
  if (is_node) {
    allow_stdio_nonblock(context, STDOUT_FILENO);
    allow_stdio_nonblock(context, STDERR_FILENO);
  }

  /* Peer-targeted inspection/control is unavailable; these runtime queries are self-only. */
  const char *self_only[] = { "get_robust_list", "getsid", "prlimit64", "sched_getaffinity",
    "sched_getattr", "sched_getparam", "sched_getscheduler" };
  for (size_t index = 0; index < sizeof(self_only) / sizeof(self_only[0]); index++) {
    allow_arg0_zero(context, self_only[index]);
  }

  /* pthread-style clone only: five thread semantics are mandatory; only observed TLS,
     tid bookkeeping and SYSVSEM flags may vary. Process clones, fork and vfork stay denied. */
  const unsigned long long required = CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD;
  const unsigned long long optional = CLONE_SETTLS | CLONE_PARENT_SETTID | CLONE_CHILD_SETTID
    | CLONE_CHILD_CLEARTID | CLONE_SYSVSEM;
  const unsigned long long permitted = required | optional;
  const unsigned long long required_and_forbidden_mask = required | ~permitted;
  int clone_number = seccomp_syscall_resolve_name("clone");
  if (clone_number != __NR_SCMP_ERROR
      && seccomp_rule_add(context, SCMP_ACT_ALLOW, clone_number, 1,
        SCMP_A0(SCMP_CMP_MASKED_EQ, required_and_forbidden_mask, required)) < 0) return 2;
  int clone3_number = seccomp_syscall_resolve_name("clone3");
  if (clone3_number != __NR_SCMP_ERROR
      && seccomp_rule_add(context, SCMP_ACT_ERRNO(ENOSYS), clone3_number, 0) < 0) return 2;

  allow_prctl(context, PR_GET_DUMPABLE);
  allow_prctl_arg1(context, PR_SET_DUMPABLE, 0);
  allow_prctl(context, PR_GET_NAME);
  allow_prctl(context, PR_SET_NAME);
  allow_prctl(context, PR_GET_NO_NEW_PRIVS);
  allow_prctl(context, PR_GET_SECCOMP);

  int descriptor = open(argv[2], O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (descriptor < 0) { perror("open"); return 2; }
  if (seccomp_export_bpf(context, descriptor) < 0) { perror("seccomp_export_bpf"); return 2; }
  if (fchmod(descriptor, 0444) < 0 || fsync(descriptor) < 0 || close(descriptor) < 0) return 2;
  seccomp_release(context);
  return 0;
}
