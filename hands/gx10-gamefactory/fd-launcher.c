#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/openat2.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef CLOSE_RANGE_UNSHARE
#define CLOSE_RANGE_UNSHARE (1U << 1)
#endif
#ifndef STATX_MNT_ID
#define STATX_MNT_ID 0x00001000U
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
/* Linux UAPI: added in Landlock ABI 3; older libc headers can omit the name
 * even when the deployment kernel implements the access right. */
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
_Static_assert(LANDLOCK_ACCESS_FS_TRUNCATE == (1ULL << 14),
  "Landlock truncate access-right value does not match the Linux UAPI");

#define WORKSPACE_FD 3
#define RUNTIME_FD 4
#define CWD_FD 5
#define NODE_SECCOMP_FD 6
#define GODOT_SECCOMP_FD 7
#define READY_PIPE_FD 8
#define GO_PIPE_FD 9
#ifndef PAYLOAD_BROKER_UID
#define PAYLOAD_BROKER_UID 10003
#endif
#ifndef PAYLOAD_OUTER_PROFILE
#define PAYLOAD_OUTER_PROFILE "dominion-gx10-gamefactory-broker"
#endif
#ifndef PAYLOAD_LAUNCHER_PROFILE
#define PAYLOAD_LAUNCHER_PROFILE ""
#endif
#ifndef FD_LAUNCHER_ENTRY
#define FD_LAUNCHER_ENTRY main
#endif
#define MAX_FILTER_BYTES (1024U * 1024U)
#define MAX_CHILD_ARGS 192
#define MAX_ARG_BYTES 16000U
#define MAX_SCAN_ENTRIES 100000U
#define MAX_SCAN_DEPTH 64U

static const char *NODE_PATH = "/opt/dominion-payload/node";
static const char *GODOT_PATH = "/opt/dominion-payload/godot";
static const char *OUTER_PROFILE = PAYLOAD_OUTER_PROFILE;
static const char *LAUNCHER_PROFILE = PAYLOAD_LAUNCHER_PROFILE;

struct scan_state { uint64_t mount_id; uint64_t entries; };
static void die(const char *message) __attribute__((noreturn));

static void add_landlock_path(int ruleset_fd, int parent_fd, uint64_t access) {
  struct landlock_path_beneath_attr rule = { .allowed_access = access, .parent_fd = parent_fd };
  if (syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0) {
    die("could not add an exact Landlock path rule");
  }
}

static void apply_landlock(int project_fd, int runtime_fd, const char *guard_path) {
  int abi = (int) syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) die("Landlock ABI 3 or newer is required");
  uint64_t handled = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE
    | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR
    | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO
    | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER
    | LANDLOCK_ACCESS_FS_TRUNCATE;
  struct landlock_ruleset_attr ruleset = { .handled_access_fs = handled };
  int ruleset_fd = (int) syscall(SYS_landlock_create_ruleset, &ruleset, sizeof(ruleset), 0);
  if (ruleset_fd < 0) die("could not create the payload Landlock ruleset");
  const uint64_t mutable = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE
    | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE
    | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SYM
    | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
  add_landlock_path(ruleset_fd, project_fd, mutable);
  add_landlock_path(ruleset_fd, runtime_fd, mutable);
  const uint64_t readonly_directory = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE
    | LANDLOCK_ACCESS_FS_READ_DIR;
  const char *directories[] = {
    "/opt/dominion-payload", "/usr/lib", "/usr/lib/locale", "/usr/share/fonts",
    "/usr/share/fontconfig", "/usr/share/locale", "/etc/fonts", "/var/cache/fontconfig",
  };
  for (unsigned i = 0; i < sizeof(directories) / sizeof(directories[0]); i++) {
    int fd = open(directories[i], O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) die("required read-only Landlock runtime directory is unavailable");
    add_landlock_path(ruleset_fd, fd, readonly_directory); close(fd);
  }
  struct { const char *path; uint64_t access; } files[] = {
    { guard_path, LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE },
    { "/etc/ld.so.cache", LANDLOCK_ACCESS_FS_READ_FILE },
    { "/etc/ssl/openssl.cnf", LANDLOCK_ACCESS_FS_READ_FILE },
    { "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE },
    { "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE },
  };
  for (unsigned i = 0; i < sizeof(files) / sizeof(files[0]); i++) {
    int fd = open(files[i].path, O_PATH | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) die("required read-only Landlock runtime file is unavailable");
    add_landlock_path(ruleset_fd, fd, files[i].access); close(fd);
  }
  if (syscall(SYS_landlock_restrict_self, ruleset_fd, 0) < 0 || close(ruleset_fd) < 0) {
    die("could not enforce the payload Landlock ruleset");
  }
}

static int reviewed_project_slug(const char *project) {
  static const char *slugs[] = {
    "system-canary", "vector-vault", "bolt-bloom", "pocket-gravity", "chromalock",
    "tiny-foundry", "letter-loom", "pulse-path", "shelf-shift", "wobble-works", "signal-grid",
  };
  if (!project) return 0;
  for (unsigned index = 0; index < sizeof(slugs) / sizeof(slugs[0]); index++) {
    if (!strcmp(project, slugs[index])) return 1;
  }
  return 0;
}

static int reviewed_guard_path(const char *program, const char *project, const char *path) {
  char expected[256];
  if (!program || !path || !reviewed_project_slug(project)
      || (strcmp(program, "node") && strcmp(program, "godot"))) return 0;
  int length = snprintf(expected, sizeof(expected), "/opt/dominion-broker/guards/%s-%s-guard",
    project, program);
  return length > 0 && (size_t) length < sizeof(expected) && !strcmp(path, expected);
}

static void die(const char *message) {
  fprintf(stderr, "fd-launcher: %s\n", message);
  _exit(78);
}

static void require_exact_fd(const char *value, int expected) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno || !end || *end || parsed != expected) die("descriptor contract mismatch");
}

static int is_hex64(const char *value) {
  if (!value || strlen(value) != 64) return 0;
  for (unsigned i = 0; i < 64; i++) {
    if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return 0;
  }
  return 1;
}

static void require_directory_fd(int fd, struct stat *out) {
  if (fcntl(fd, F_GETFD) < 0 || fstat(fd, out) < 0 || !S_ISDIR(out->st_mode)) {
    die("required directory descriptor is invalid");
  }
}

static void require_stdio_contract(void) {
  struct stat input, output, error;
  if (fstat(STDIN_FILENO, &input) < 0 || fstat(STDOUT_FILENO, &output) < 0 || fstat(STDERR_FILENO, &error) < 0
      || !S_ISCHR(input.st_mode) || major(input.st_rdev) != 1 || minor(input.st_rdev) != 3
      || !S_ISFIFO(output.st_mode) || !S_ISFIFO(error.st_mode)) {
    die("payload standard I/O must be /dev/null input plus two anonymous pipes");
  }
}

static void require_launcher_apparmor_stack(void) {
  char label[1024];
  int fd = open("/proc/self/attr/current", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) die("AppArmor current label is unavailable");
  ssize_t count = read(fd, label, sizeof(label) - 1U);
  if (count <= 0 || close(fd) < 0) die("AppArmor current label could not be read");
  label[count] = '\0';
  char *mode = strstr(label, " (enforce)");
  if (!mode || (mode[10] != '\0' && mode[10] != '\n')) die("launcher AppArmor stack is not enforcing");
  *mode = '\0';
  int outer = 0, launcher = 0, components = 0;
  char *component = label;
  for (;;) {
    char *separator = strstr(component, "//&");
    if (separator) *separator = '\0';
    if (!strcmp(component, OUTER_PROFILE)) outer++;
    else if (*LAUNCHER_PROFILE && !strcmp(component, LAUNCHER_PROFILE)) launcher++;
    else die("launcher AppArmor stack has an unexpected component");
    components++;
    if (!separator) break;
    component = separator + 3;
  }
  const int expected_components = *LAUNCHER_PROFILE ? 2 : 1;
  if (components != expected_components || outer != 1 || launcher != (*LAUNCHER_PROFILE ? 1 : 0)) {
    die("launcher AppArmor component set is incomplete");
  }
}

static int safe_relative_path(const char *value) {
  if (!value || !*value || value[0] == '/' || strlen(value) > 4096) return 0;
  if (!strcmp(value, ".")) return 1;
  const char *cursor = value;
  while (*cursor) {
    const char *start = cursor;
    while (*cursor && *cursor != '/') cursor++;
    size_t length = (size_t) (cursor - start);
    if (!length || (length == 1 && start[0] == '.')
        || (length == 2 && start[0] == '.' && start[1] == '.')) return 0;
    if (*cursor == '/') cursor++;
  }
  return 1;
}

static int open_beneath(int root_fd, const char *relative, uint64_t flags) {
  struct open_how how = {
    .flags = flags,
    .mode = 0,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV | RESOLVE_NO_SYMLINKS,
  };
  return (int) syscall(SYS_openat2, root_fd, relative, &how, sizeof(how));
}

static uint64_t mount_id_for_fd(int fd) {
  struct statx metadata;
  memset(&metadata, 0, sizeof(metadata));
  if (syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
      STATX_TYPE | STATX_MODE | STATX_NLINK | STATX_MNT_ID, &metadata) < 0
      || !(metadata.stx_mask & STATX_MNT_ID)) die("mount identity could not be measured");
  return metadata.stx_mnt_id;
}

static void scan_tree(int directory_fd, struct scan_state *state, unsigned depth) {
  if (depth > MAX_SCAN_DEPTH) die("prelaunch tree exceeds its depth bound");
  /* dup() would share the directory cursor and let the next launch observe EOF. A fresh
     open-file description is mandatory so every launch rescans the complete tree. */
  int scan_fd = open_beneath(directory_fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (scan_fd < 0) die("prelaunch tree descriptor duplication failed");
  DIR *directory = fdopendir(scan_fd);
  if (!directory) { close(scan_fd); die("prelaunch tree could not be enumerated"); }
  errno = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++state->entries > MAX_SCAN_ENTRIES) { closedir(directory); die("prelaunch tree exceeds its entry bound"); }
    int item_fd = open_beneath(directory_fd, entry->d_name, O_PATH | O_CLOEXEC | O_NOFOLLOW);
    struct stat metadata;
    if (item_fd < 0 || fstat(item_fd, &metadata) < 0) {
      if (item_fd >= 0) close(item_fd);
      closedir(directory); die("prelaunch tree contains an unresolvable entry");
    }
    if (mount_id_for_fd(item_fd) != state->mount_id) {
      close(item_fd); closedir(directory); die("prelaunch tree contains a descendant mount");
    }
    if (S_ISLNK(metadata.st_mode) || S_ISFIFO(metadata.st_mode) || S_ISSOCK(metadata.st_mode)
        || S_ISCHR(metadata.st_mode) || S_ISBLK(metadata.st_mode)) {
      close(item_fd); closedir(directory); die("prelaunch tree contains a forbidden file type");
    }
    if (S_ISREG(metadata.st_mode) && metadata.st_nlink != 1) {
      close(item_fd); closedir(directory); die("prelaunch tree contains a hard-linked file");
    }
    if (S_ISDIR(metadata.st_mode)) {
      int child_fd = open_beneath(directory_fd, entry->d_name,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      struct stat child_metadata;
      if (child_fd < 0 || fstat(child_fd, &child_metadata) < 0
          || child_metadata.st_dev != metadata.st_dev || child_metadata.st_ino != metadata.st_ino) {
        if (child_fd >= 0) close(child_fd);
        close(item_fd); closedir(directory); die("prelaunch directory identity changed while scanning");
      }
      close(item_fd);
      scan_tree(child_fd, state, depth + 1U);
      close(child_fd);
    } else if (S_ISREG(metadata.st_mode)) close(item_fd);
    else { close(item_fd); closedir(directory); die("prelaunch tree entry is not a regular file or directory"); }
    errno = 0;
  }
  if (errno) { closedir(directory); die("prelaunch tree enumeration failed"); }
  if (closedir(directory) < 0) die("prelaunch tree descriptor close failed");
}

static void scan_root(int fd) {
  struct scan_state state = { .mount_id = mount_id_for_fd(fd), .entries = 0 };
  scan_tree(fd, &state, 0);
}

static void set_limit(int resource, rlim_t soft, rlim_t hard) {
  const struct rlimit limit = { .rlim_cur = soft, .rlim_max = hard };
  if (setrlimit(resource, &limit) < 0) die("could not apply a payload rlimit");
}

static void require_filter_fd(int fd, struct stat *expected) {
  if (fstat(fd, expected) < 0 || !S_ISREG(expected->st_mode) || expected->st_uid != 0
      || expected->st_gid != 0 || expected->st_nlink != 1 || (expected->st_mode & 07777) != 0444
      || expected->st_size <= 0 || (uint64_t) expected->st_size > MAX_FILTER_BYTES
      || expected->st_size % (off_t) sizeof(struct sock_filter) != 0) {
    die("child seccomp descriptor identity is invalid");
  }
}

static void load_filter(int fd) {
  struct stat before, after;
  require_filter_fd(fd, &before);
  size_t size = (size_t) before.st_size;
  struct sock_filter *instructions = calloc(1, size);
  if (!instructions) die("could not allocate child seccomp filter");
  if (lseek(fd, 0, SEEK_SET) < 0) die("could not rewind child seccomp filter");
  size_t offset = 0;
  while (offset < size) {
    ssize_t count = read(fd, (char *) instructions + offset, size - offset);
    if (count <= 0) die("could not read complete child seccomp filter");
    offset += (size_t) count;
  }
  require_filter_fd(fd, &after);
  if (before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_size != after.st_size) {
    die("child seccomp descriptor changed while reading");
  }
  struct sock_fprog program = { .len = (unsigned short) (size / sizeof(struct sock_filter)), .filter = instructions };
  if (program.len == 0 || (size_t) program.len * sizeof(struct sock_filter) != size) die("child seccomp filter instruction count is invalid");
  if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) die("no-new-privileges was lost before seccomp load");
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program) < 0) die("could not load child seccomp filter");
  free(instructions);
}

static int open_executable(const char *path, struct stat *identity) {
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0 || fstat(fd, identity) < 0 || !S_ISREG(identity->st_mode) || identity->st_uid != 0
      || identity->st_gid != 0 || identity->st_nlink != 1 || (identity->st_mode & 07777) != 0555) {
    if (fd >= 0) close(fd);
    die("payload executable identity is invalid");
  }
  return fd;
}

static int open_guard(const char *path, struct stat *identity) {
  int fd = open(path, O_PATH | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0 || fstat(fd, identity) < 0 || !S_ISREG(identity->st_mode) || identity->st_uid != 0
      || identity->st_gid != 0 || identity->st_nlink != 1 || (identity->st_mode & 07777) != 0555) {
    if (fd >= 0) close(fd);
    die("payload guard identity is invalid");
  }
  return fd;
}

static void prepare_guard_descriptors(int executable_fd, int filter_fd, int guard_fd) {
  const int sources[5] = { executable_fd, filter_fd, READY_PIPE_FD, GO_PIPE_FD, guard_fd };
  int copies[5];
  for (unsigned i = 0; i < 5; i++) {
    copies[i] = fcntl(sources[i], F_DUPFD_CLOEXEC, 20);
    if (copies[i] < 20) die("could not isolate payload-guard descriptor sources");
  }
  for (unsigned i = 0; i < 5; i++) {
    if (dup2(copies[i], 3 + (int) i) != 3 + (int) i) die("could not install payload-guard descriptor");
  }
  if (fcntl(7, F_SETFD, FD_CLOEXEC) < 0) die("payload-guard exec descriptor cannot be close-on-exec");
  if (syscall(SYS_close_range, 8U, ~0U, CLOSE_RANGE_UNSHARE) < 0) {
    die("could not close non-guard inherited descriptors");
  }
}

int FD_LAUNCHER_ENTRY(int argc, char **argv) {
  const char *program_name = NULL, *cwd_relative = NULL, *guard_path = NULL, *project = NULL;
  const char *generation = NULL, *nonce = NULL;
  int separator = -1;
  int saw_workspace = 0, saw_runtime = 0, saw_cwd = 0, saw_node_filter = 0, saw_godot_filter = 0;
  int saw_ready = 0, saw_go = 0;
  if (getuid() != PAYLOAD_BROKER_UID || geteuid() != PAYLOAD_BROKER_UID
      || getgid() != PAYLOAD_BROKER_UID || getegid() != PAYLOAD_BROKER_UID) {
    die("fixed payload-broker UID/GID is required");
  }
  if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) die("launcher requires no-new-privileges at entry");
  require_launcher_apparmor_stack();
  require_stdio_contract();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) < 0 || getppid() != 1) die("broker PID1 parent liveness is unavailable");

  for (int index = 1; index < argc; index++) {
    if (!strcmp(argv[index], "--")) { separator = index; break; }
    if (index + 1 >= argc) die("launcher option lacks a value");
    const char *option = argv[index], *value = argv[++index];
    if (!strcmp(option, "--program") && !program_name) program_name = value;
    else if (!strcmp(option, "--workspace-fd") && !saw_workspace) { require_exact_fd(value, WORKSPACE_FD); saw_workspace = 1; }
    else if (!strcmp(option, "--runtime-fd") && !saw_runtime) { require_exact_fd(value, RUNTIME_FD); saw_runtime = 1; }
    else if (!strcmp(option, "--cwd-fd") && !saw_cwd) { require_exact_fd(value, CWD_FD); saw_cwd = 1; }
    else if (!strcmp(option, "--node-seccomp-fd") && !saw_node_filter) { require_exact_fd(value, NODE_SECCOMP_FD); saw_node_filter = 1; }
    else if (!strcmp(option, "--godot-seccomp-fd") && !saw_godot_filter) { require_exact_fd(value, GODOT_SECCOMP_FD); saw_godot_filter = 1; }
    else if (!strcmp(option, "--cwd-relative") && !cwd_relative) cwd_relative = value;
    else if (!strcmp(option, "--guard-path") && !guard_path) guard_path = value;
    else if (!strcmp(option, "--project") && !project) project = value;
    else if (!strcmp(option, "--generation") && !generation) generation = value;
    else if (!strcmp(option, "--nonce") && !nonce) nonce = value;
    else if (!strcmp(option, "--ready-fd") && !saw_ready) { require_exact_fd(value, READY_PIPE_FD); saw_ready = 1; }
    else if (!strcmp(option, "--go-fd") && !saw_go) { require_exact_fd(value, GO_PIPE_FD); saw_go = 1; }
    else die("unknown or duplicate launcher option");
  }
  if (separator < 0 || !program_name || !cwd_relative || !guard_path || !project || !generation || !nonce
      || !is_hex64(generation) || !is_hex64(nonce) || !safe_relative_path(cwd_relative)
      || !reviewed_project_slug(project)
      || !saw_workspace || !saw_runtime || !saw_cwd || !saw_node_filter || !saw_godot_filter
      || !saw_ready || !saw_go) die("launcher contract is incomplete");
  int child_count = argc - separator - 1;
  if (child_count < 0 || child_count > MAX_CHILD_ARGS) die("payload argument count is invalid");
  for (int index = separator + 1; index < argc; index++) if (strlen(argv[index]) > MAX_ARG_BYTES) die("payload argument exceeds its byte bound");

  const char *program_path = NULL;
  int filter_fd = -1;
  if (!strcmp(program_name, "node")) { program_path = NODE_PATH; filter_fd = NODE_SECCOMP_FD; }
  else if (!strcmp(program_name, "godot")) { program_path = GODOT_PATH; filter_fd = GODOT_SECCOMP_FD; }
  else die("payload program is not allowlisted");
  if (!reviewed_guard_path(program_name, project, guard_path)) die("payload guard path is not in the fixed reviewed project map");
  struct stat executable_identity;
  int executable_fd = open_executable(program_path, &executable_identity);
  struct stat guard_identity;
  int guard_fd = open_guard(guard_path, &guard_identity);

  struct stat workspace_before, workspace_after, runtime_before, runtime_after, cwd_metadata, opened_cwd_metadata;
  require_directory_fd(WORKSPACE_FD, &workspace_before);
  require_directory_fd(RUNTIME_FD, &runtime_before);
  require_directory_fd(CWD_FD, &cwd_metadata);
  if (workspace_before.st_dev == runtime_before.st_dev && workspace_before.st_ino == runtime_before.st_ino) die("workspace and runtime descriptors overlap");
  if (mount_id_for_fd(WORKSPACE_FD) == mount_id_for_fd(RUNTIME_FD)) die("workspace and runtime require distinct mount identities");
  int opened_cwd = open_beneath(WORKSPACE_FD, cwd_relative, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (opened_cwd < 0 || fstat(opened_cwd, &opened_cwd_metadata) < 0
      || opened_cwd_metadata.st_dev != cwd_metadata.st_dev || opened_cwd_metadata.st_ino != cwd_metadata.st_ino) {
    if (opened_cwd >= 0) close(opened_cwd);
    die("cwd descriptor is not the requested workspace descendant");
  }
  close(opened_cwd);
  scan_root(WORKSPACE_FD);
  scan_root(RUNTIME_FD);
  require_directory_fd(WORKSPACE_FD, &workspace_after);
  require_directory_fd(RUNTIME_FD, &runtime_after);
  if (workspace_before.st_dev != workspace_after.st_dev || workspace_before.st_ino != workspace_after.st_ino
      || runtime_before.st_dev != runtime_after.st_dev || runtime_before.st_ino != runtime_after.st_ino) {
    die("workspace or runtime identity changed during prelaunch scan");
  }

  char **child_argv = calloc((size_t) child_count + 7U, sizeof(char *));
  if (!child_argv) die("could not allocate payload argv");
  child_argv[0] = (char *) guard_path;
  child_argv[1] = "--generation"; child_argv[2] = (char *) generation;
  child_argv[3] = "--nonce"; child_argv[4] = (char *) nonce; child_argv[5] = "--";
  for (int index = 0; index < child_count; index++) child_argv[index + 6] = argv[separator + 1 + index];
  child_argv[child_count + 6] = NULL;

  if (setsid() < 0) die("could not create an isolated payload session");
  set_limit(RLIMIT_CORE, 0, 0);
  set_limit(RLIMIT_NOFILE, 256, 256);
  set_limit(RLIMIT_NPROC, 64, 64);
  set_limit(RLIMIT_FSIZE, 512U * 1024U * 1024U, 512U * 1024U * 1024U);
  set_limit(RLIMIT_CPU, 1800, 1800);
#ifdef RLIMIT_AS
  /* The executor's 2-GiB cgroup is the physical-memory boundary. The larger virtual limit leaves
     room for V8's pointer-compression cage and Godot's mapped libraries without weakening it. */
  set_limit(RLIMIT_AS, (rlim_t) 16ULL * 1024ULL * 1024ULL * 1024ULL,
    (rlim_t) 16ULL * 1024ULL * 1024ULL * 1024ULL);
#endif
  umask(0077);
  if (fchdir(CWD_FD) < 0) die("could not enter verified payload cwd");
  apply_landlock(WORKSPACE_FD, RUNTIME_FD, guard_path);
  load_filter(filter_fd);
  struct stat executable_after;
  if (fstat(executable_fd, &executable_after) < 0 || executable_after.st_dev != executable_identity.st_dev
      || executable_after.st_ino != executable_identity.st_ino || executable_after.st_nlink != 1
      || (executable_after.st_mode & 07777) != 0555) die("payload executable changed before exec");
  struct stat guard_after;
  if (fstat(guard_fd, &guard_after) < 0 || guard_after.st_dev != guard_identity.st_dev
      || guard_after.st_ino != guard_identity.st_ino || guard_after.st_nlink != 1
      || (guard_after.st_mode & 07777) != 0555) die("payload guard changed before exec");
  prepare_guard_descriptors(executable_fd, filter_fd, guard_fd);

  if (clearenv() < 0) die("could not clear the payload environment");
  char home[128], tmp[160], temp[160], tmpdir[160], config[160], cache[160], data[160];
  if (snprintf(home, sizeof(home), "HOME=/runtime/payload/active/%s", project) >= (int) sizeof(home)
      || snprintf(tmp, sizeof(tmp), "TMP=/runtime/payload/active/%s/tmp", project) >= (int) sizeof(tmp)
      || snprintf(temp, sizeof(temp), "TEMP=/runtime/payload/active/%s/tmp", project) >= (int) sizeof(temp)
      || snprintf(tmpdir, sizeof(tmpdir), "TMPDIR=/runtime/payload/active/%s/tmp", project) >= (int) sizeof(tmpdir)
      || snprintf(config, sizeof(config), "XDG_CONFIG_HOME=/runtime/payload/active/%s/config", project) >= (int) sizeof(config)
      || snprintf(cache, sizeof(cache), "XDG_CACHE_HOME=/runtime/payload/active/%s/cache", project) >= (int) sizeof(cache)
      || snprintf(data, sizeof(data), "XDG_DATA_HOME=/runtime/payload/active/%s/data", project) >= (int) sizeof(data)) {
    die("payload runtime environment exceeds its fixed bound");
  }
  char *const child_env[] = {
    "PATH=/opt/dominion-payload",
    home, tmp, temp, tmpdir, config, cache, data,
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    "CI=1",
    "GAME_FACTORY_WORKER=1",
    NULL,
  };
  syscall(SYS_execveat, 7, "", child_argv, child_env, AT_EMPTY_PATH);
  die("exact payload guard execveat failed");
  return 78;
}
