#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <linux/landlock.h>
#include <linux/fs.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/statfs.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define BROKER_UID 10003
#define CONTROLLER_UID 10001
#define SPOOL_GID 11000
#define MAX_PACKET 1000000U
#define MAX_ARGS 160U
#define MAX_ARG_BYTES 16000U
#define MAX_LOG_BYTES 1048576U
#define MAX_ARTIFACTS 32U
#define MAX_ARTIFACT_BYTES (64U * 1024U * 1024U)
#define MAX_TOTAL_ARTIFACT_BYTES (64U * 1024U * 1024U)
#define MAX_ARTIFACT_MANIFEST_BYTES 100000U
#define MAGIC_REQUEST "DGFBRQ01"
#define MAGIC_CANCEL "DGFBCN01"
#define MAGIC_RESULT "DGFRES01"
#define MAGIC_ACK "DGFACK01"
#define MAGIC_PRUNE "DGFPRN01"
#define READY_NAME "broker-ready.bin"
#define REQUESTS_PATH "/broker-requests"
#define RESULTS_PATH "/broker-results"
#define STATE_PATH "/broker-state"
#define WORKSPACE_PATH "/workspace"
#define PAYLOAD_RUNTIME_PATH "/runtime/payload"
#define WORKSPACE_PRIVATE_NAME ".projects"
#define WORKSPACE_DATA_NAME "data"
#define LOST_FOUND_GATE_NAME "lost-found-gate"
#define ACTIVE_RUNTIME_NAME "active"
#define RETAINED_RUNTIME_NAME "retained"
#define TEST_RUNTIME_SIBLING_NAME "system-canary-sibling"
#define RUNTIME_PRIVATE_NAME ".private"
#define RUNTIME_RETAINED_GATE_NAME "retained-gate"
#define RUNTIME_SIBLING_GATE_NAME "sibling-gate"
#define NODE_FILTER_PATH "/opt/dominion-broker/node-seccomp.bpf"
#define GODOT_FILTER_PATH "/opt/dominion-broker/godot-seccomp.bpf"
#define NODE_GUARD_PATH "/opt/dominion-broker/node-guard"
#define GODOT_GUARD_PATH "/opt/dominion-broker/godot-guard"
#define GUARD_DIRECTORY "/opt/dominion-broker/guards"
#define BROKER_BINARY_PATH "/opt/dominion-broker/launch-broker"
#define NODE_EXECUTABLE_PATH "/opt/dominion-payload/node"
#define GODOT_EXECUTABLE_PATH "/opt/dominion-payload/godot"
#define APPARMOR_POLICY_PATH "/opt/dominion-policy/dominion-gx10-gamefactory-broker.apparmor"
#define OUTER_SECCOMP_PATH "/opt/dominion-policy/seccomp-gx10-gamefactory-broker.json"
#define DEPLOYMENT_POLICY_PATH "/opt/dominion-policy/gamefactory-broker-policy.bin"
#define BOOT_ID_PATH "/proc/sys/kernel/random/boot_id"
#define MAX_SCAN_FILES 16384U
#define MAX_RETAINED_GENERATIONS 256U
#define MAX_RUNTIME_ENTRIES 131072U
#define RUNTIME_QUOTA_ID 12001U
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
#define LANDLOCK_HANDLED_ACCESS_FS (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE \
  | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR \
  | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR \
  | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO \
  | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER \
  | LANDLOCK_ACCESS_FS_TRUNCATE)
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif

extern int payload_launch_entry(int argc, char **argv);

/* Small self-contained SHA-256 implementation. */
struct sha256_ctx { uint32_t h[8]; uint64_t bits; unsigned char block[64]; size_t used; };
static uint32_t rr(uint32_t v, unsigned n) { return (v >> n) | (v << (32U - n)); }
static const uint32_t sha_k[64] = {
  0x428a2f98U,0x71374491U,0xb5c0fbcfU,0xe9b5dba5U,0x3956c25bU,0x59f111f1U,0x923f82a4U,0xab1c5ed5U,
  0xd807aa98U,0x12835b01U,0x243185beU,0x550c7dc3U,0x72be5d74U,0x80deb1feU,0x9bdc06a7U,0xc19bf174U,
  0xe49b69c1U,0xefbe4786U,0x0fc19dc6U,0x240ca1ccU,0x2de92c6fU,0x4a7484aaU,0x5cb0a9dcU,0x76f988daU,
  0x983e5152U,0xa831c66dU,0xb00327c8U,0xbf597fc7U,0xc6e00bf3U,0xd5a79147U,0x06ca6351U,0x14292967U,
  0x27b70a85U,0x2e1b2138U,0x4d2c6dfcU,0x53380d13U,0x650a7354U,0x766a0abbU,0x81c2c92eU,0x92722c85U,
  0xa2bfe8a1U,0xa81a664bU,0xc24b8b70U,0xc76c51a3U,0xd192e819U,0xd6990624U,0xf40e3585U,0x106aa070U,
  0x19a4c116U,0x1e376c08U,0x2748774cU,0x34b0bcb5U,0x391c0cb3U,0x4ed8aa4aU,0x5b9cca4fU,0x682e6ff3U,
  0x748f82eeU,0x78a5636fU,0x84c87814U,0x8cc70208U,0x90befffaU,0xa4506cebU,0xbef9a3f7U,0xc67178f2U };
static void sha_block(struct sha256_ctx *c, const unsigned char *p) {
  uint32_t w[64];
  for (unsigned i=0;i<16;i++) w[i]=((uint32_t)p[i*4]<<24)|((uint32_t)p[i*4+1]<<16)|((uint32_t)p[i*4+2]<<8)|p[i*4+3];
  for (unsigned i=16;i<64;i++) { uint32_t a=w[i-15],b=w[i-2]; w[i]=w[i-16]+(rr(a,7)^rr(a,18)^(a>>3))+w[i-7]+(rr(b,17)^rr(b,19)^(b>>10)); }
  uint32_t a=c->h[0],b=c->h[1],d=c->h[3],e=c->h[4],f=c->h[5],g=c->h[6],h=c->h[7],cc=c->h[2];
  for(unsigned i=0;i<64;i++){uint32_t s1=rr(e,6)^rr(e,11)^rr(e,25),ch=(e&f)^((~e)&g),t1=h+s1+ch+sha_k[i]+w[i];uint32_t s0=rr(a,2)^rr(a,13)^rr(a,22),maj=(a&b)^(a&cc)^(b&cc),t2=s0+maj;h=g;g=f;f=e;e=d+t1;d=cc;cc=b;b=a;a=t1+t2;}
  c->h[0]+=a;c->h[1]+=b;c->h[2]+=cc;c->h[3]+=d;c->h[4]+=e;c->h[5]+=f;c->h[6]+=g;c->h[7]+=h;
}
static void sha_init(struct sha256_ctx *c){static const uint32_t v[8]={0x6a09e667U,0xbb67ae85U,0x3c6ef372U,0xa54ff53aU,0x510e527fU,0x9b05688cU,0x1f83d9abU,0x5be0cd19U};memcpy(c->h,v,sizeof(v));c->bits=0;c->used=0;}
static void sha_update(struct sha256_ctx *c,const void *data,size_t n){const unsigned char*p=data;c->bits+=(uint64_t)n*8U;while(n){size_t take=64-c->used;if(take>n)take=n;memcpy(c->block+c->used,p,take);c->used+=take;p+=take;n-=take;if(c->used==64){sha_block(c,c->block);c->used=0;}}}
static void sha_final(struct sha256_ctx*c,unsigned char out[32]){c->block[c->used++]=0x80;if(c->used>56){while(c->used<64)c->block[c->used++]=0;sha_block(c,c->block);c->used=0;}while(c->used<56)c->block[c->used++]=0;for(int i=7;i>=0;i--)c->block[c->used++]=(unsigned char)(c->bits>>(i*8));sha_block(c,c->block);for(unsigned i=0;i<8;i++){out[i*4]=(unsigned char)(c->h[i]>>24);out[i*4+1]=(unsigned char)(c->h[i]>>16);out[i*4+2]=(unsigned char)(c->h[i]>>8);out[i*4+3]=(unsigned char)c->h[i];}}
static void sha_hex(const void *data,size_t n,char out[65]){static const char x[]="0123456789abcdef";unsigned char d[32];struct sha256_ctx c;sha_init(&c);sha_update(&c,data,n);sha_final(&c,d);for(unsigned i=0;i<32;i++){out[i*2]=x[d[i]>>4];out[i*2+1]=x[d[i]&15];}out[64]=0;}

struct bytes { unsigned char *p; size_t n; };
struct request { char generation[65], request_id[65], run_id[241], request_hash[65], policy_hash[65];
  char broker_instance_id[65], container_generation_id[65];
  char program[9], project[2001], cwd[2001], previous_generation[65], workspace_dev[33], workspace_ino[33];
  unsigned project_quota_id, timeout_ms, stdout_limit, stderr_limit, total_log_limit;
  unsigned step_index, total_steps, argc, collectc; char **argv, **collect; };
struct result_evidence {
  char measured_guard_label[256], expected_final_label[256], stdout_hash[65], stderr_hash[65];
  char cancel_hash[65], termination_reason[32], kill_outcome[16], artifact_manifest_hash[65];
  int final_transition_attested, no_new_privs, seccomp_filters, caps_zero;
  int wait_pid, wait_code, wait_status;
  size_t stdout_bytes, stderr_bytes, artifact_bytes;
  unsigned artifact_count;
  int stdout_truncated, stderr_truncated;
};

static int requests_fd=-1,results_fd=-1,state_fd=-1,workspace_fd=-1,workspace_private_fd=-1;
static int workspace_lost_gate_fd=-1,workspace_lost_found_fd=-1;
static int runtime_root_fd=-1,runtime_fd=-1,runtime_private_fd=-1;
static int runtime_active_fd=-1,runtime_retained_fd=-1,runtime_retained_gate_fd=-1;
static int runtime_sibling_gate_fd=-1,runtime_sibling_fd=-1,node_filter_fd=-1,godot_filter_fd=-1;
static int runtime_lost_gate_fd=-1,runtime_lost_found_fd=-1;
static int generation_lease_fd=-1;
static char generation_lease_name[96];
static char broker_instance[65], broker_boot_id_hash[65];
static char container_generation[65], broker_starttime[33];
static char broker_binary_hash[65], node_executable_hash[65], godot_executable_hash[65];
static char node_guard_hash[65], godot_guard_hash[65];
static char node_filter_hash[65], godot_filter_hash[65], apparmor_policy_hash[65], outer_seccomp_hash[65];
static char deployment_policy_hash[65];
static char pid_namespace_dev[33], pid_namespace_ino[33], cgroup_hash[65], cgroup_ino[33];
static char lease_dev[33], lease_ino[33], workspace_dev[33], workspace_ino[33], runtime_dev[33], runtime_ino[33];
static char workspace_mount_id[33], runtime_mount_id[33];
static char workspace_mount_identity_hash[65], runtime_mount_identity_hash[65];
static int landlock_abi;
static int broker_seccomp_filters, broker_caps_zero;
static unsigned long readiness_sequence;
static volatile sig_atomic_t termination_requested;
static const char reviewed_deployment_policy[] =
  "DGF-POLICY-01\n"
  "capabilities=quality_assurance,godot\n"
  "programs=node,godot\n"
  "project_subtree=fixed-portfolio-plus-system-canary\n"
  "max_steps=24\n"
  "max_timeout_ms=1800000\n"
  "max_total_log_bytes=1048576\n"
  "node_inline_eval=deny\n"
  "node_response_files=deny\n"
  "godot_export_preset=Web\n"
  "request_generation=exact-broker-instance-and-container\n"
  "retention_ack=durable-terminal-only\n"
  "retention_unresolved=preserve\n"
  "retention_artifacts=verify-before-prune\n"
  "android=disabled\n"
  "release_writes=disabled\n";
struct reviewed_project { const char *slug; unsigned quota_id; };
struct workspace_project_layout {
  const struct reviewed_project *project;
  int wrapper_fd;
  int project_fd;
  dev_t wrapper_dev;
  ino_t wrapper_ino;
  dev_t project_dev;
  ino_t project_ino;
};
static const struct reviewed_project reviewed_projects[] = {
  { "system-canary", 10001U },
  { "vector-vault", 10101U }, { "bolt-bloom", 10102U }, { "pocket-gravity", 10103U },
  { "chromalock", 10104U }, { "tiny-foundry", 10105U }, { "letter-loom", 10106U },
  { "pulse-path", 10107U }, { "shelf-shift", 10108U }, { "wobble-works", 10109U },
  { "signal-grid", 10110U },
};
static const struct reviewed_project workspace_layout_projects[] = {
  { "system-canary", 10001U }, { "system-canary-sibling", 10002U },
  { "vector-vault", 10101U }, { "bolt-bloom", 10102U }, { "pocket-gravity", 10103U },
  { "chromalock", 10104U }, { "tiny-foundry", 10105U }, { "letter-loom", 10106U },
  { "pulse-path", 10107U }, { "shelf-shift", 10108U }, { "wobble-works", 10109U },
  { "signal-grid", 10110U },
};
static struct workspace_project_layout workspace_project_layouts[
  sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0])];
static int active_workspace_project = -1;
static const struct reviewed_project *reviewed_project(const char *slug, unsigned quota_id) {
  for (unsigned index = 0; index < sizeof(reviewed_projects) / sizeof(reviewed_projects[0]); index++) {
    if (!strcmp(reviewed_projects[index].slug, slug) && reviewed_projects[index].quota_id == quota_id) {
      return &reviewed_projects[index];
    }
  }
  return NULL;
}
static const struct reviewed_project *workspace_layout_project(const char *slug) {
  for (unsigned index = 0; index < sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0]); index++) {
    if (!strcmp(workspace_layout_projects[index].slug, slug)) return &workspace_layout_projects[index];
  }
  return NULL;
}
static struct workspace_project_layout *workspace_project_layout(const char *slug) {
  for (unsigned index = 0; index < sizeof(workspace_project_layouts) / sizeof(workspace_project_layouts[0]); index++) {
    if (workspace_project_layouts[index].project
        && !strcmp(workspace_project_layouts[index].project->slug, slug)) {
      return &workspace_project_layouts[index];
    }
  }
  return NULL;
}
static int guard_path_for(const struct request *request, char out[256]) {
  const struct reviewed_project *project = reviewed_project(request->project, request->project_quota_id);
  if (!project || (strcmp(request->program, "node") && strcmp(request->program, "godot"))) return -1;
  int written = snprintf(out, 256, "%s/%s-%s-guard", GUARD_DIRECTORY, project->slug, request->program);
  return written > 0 && written < 256 ? 0 : -1;
}
static void request_termination(int signal_number) { (void) signal_number; termination_requested = 1; }
static void revoke_readiness_best_effort(void) {
  if (results_fd < 0) return;
  if (unlinkat(results_fd, READY_NAME, 0) == 0 || errno == ENOENT) (void) fsync(results_fd);
}
static void revoke_generation_lease_best_effort(void) {
  if (state_fd < 0 || !generation_lease_name[0]) return;
  if (unlinkat(state_fd, generation_lease_name, 0) == 0 || errno == ENOENT) (void) fsync(state_fd);
  generation_lease_name[0] = 0;
}
static void revoke_active_workspace_best_effort(void);
static void fatal(const char *m){revoke_readiness_best_effort();revoke_active_workspace_best_effort();revoke_generation_lease_best_effort();fprintf(stderr,"launch-broker: %s\n",m);exit(78);}
static int hex64(const char*s){if(!s||strlen(s)!=64)return 0;for(unsigned i=0;i<64;i++)if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return 0;return 1;}
static int write_all(int fd,const void*p,size_t n){const unsigned char*b=p;while(n){ssize_t k=write(fd,b,n);if(k<0&&errno==EINTR)continue;if(k<=0)return-1;b+=k;n-=(size_t)k;}return 0;}
static int require_artifact(const char *path, mode_t mode, const char *environment_name, char out[65]) {
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct stat before, after;
  if (fd < 0 || fstat(fd, &before) < 0 || !S_ISREG(before.st_mode) || before.st_uid != 0
      || before.st_gid != 0 || before.st_nlink != 1 || (before.st_mode & 07777) != mode
      || before.st_size <= 0 || before.st_size > 200000000) fatal("immutable broker artifact metadata is invalid");
  struct sha256_ctx digest;
  sha_init(&digest);
  unsigned char buffer[65536];
  for (;;) {
    ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) fatal("immutable broker artifact read failed");
    if (!count) break;
    sha_update(&digest, buffer, (size_t) count);
  }
  unsigned char bytes[32];
  sha_final(&digest, bytes);
  static const char hex[] = "0123456789abcdef";
  for (unsigned i = 0; i < 32; i++) { out[i * 2] = hex[bytes[i] >> 4]; out[i * 2 + 1] = hex[bytes[i] & 15]; }
  out[64] = 0;
  if (fstat(fd, &after) < 0 || before.st_dev != after.st_dev || before.st_ino != after.st_ino
      || before.st_size != after.st_size || after.st_nlink != 1 || (after.st_mode & 07777) != mode) {
    fatal("immutable broker artifact changed while hashing");
  }
  const char *expected = getenv(environment_name);
  if (!hex64(expected) || strcmp(expected, out)) fatal("immutable broker artifact digest mismatch");
  if (lseek(fd, 0, SEEK_SET) < 0) fatal("immutable broker artifact rewind failed");
  return fd;
}

static void hash_boot_id(void) {
  int fd = open(BOOT_ID_PATH, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  char bytes[128];
  if (fd < 0) fatal("kernel boot identity is unavailable");
  ssize_t count = read(fd, bytes, sizeof(bytes));
  if (count <= 0 || count == (ssize_t) sizeof(bytes) || close(fd) < 0) {
    fatal("kernel boot identity is invalid");
  }
  while (count > 0 && (bytes[count - 1] == '\n' || bytes[count - 1] == '\r')) count--;
  if (count != 36) fatal("kernel boot identity has an unexpected shape");
  sha_hex(bytes, (size_t) count, broker_boot_id_hash);
}
static struct bytes read_owned_at(int dir, const char *name, uid_t owner, gid_t group,
    mode_t mode, size_t max) {
  struct bytes value = { 0 };
  int fd = openat(dir, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return value;
  struct stat before, after;
  if (fstat(fd, &before) < 0 || !S_ISREG(before.st_mode) || before.st_uid != owner
      || before.st_gid != group || before.st_nlink != 1 || (before.st_mode & 07777) != mode
      || before.st_size <= 0 || (uint64_t) before.st_size > max) {
    close(fd); errno = EPERM; return value;
  }
  value.n = (size_t) before.st_size;
  value.p = malloc(value.n);
  if (!value.p) { close(fd); return (struct bytes) { 0 }; }
  size_t offset = 0;
  while (offset < value.n) {
    ssize_t count = read(fd, value.p + offset, value.n - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { free(value.p); value = (struct bytes) { 0 }; break; }
    offset += (size_t) count;
  }
  if (value.p && (fstat(fd, &after) < 0 || before.st_dev != after.st_dev
      || before.st_ino != after.st_ino || before.st_size != after.st_size
      || after.st_nlink != 1 || after.st_uid != owner || after.st_gid != group
      || (after.st_mode & 07777) != mode)) {
    free(value.p); value = (struct bytes) { 0 }; errno = EPERM;
  }
  close(fd);
  return value;
}
static struct bytes read_trusted_at(int dir, const char *name, uid_t owner, size_t max) {
  return read_owned_at(dir, name, owner, SPOOL_GID, 0640, max);
}
static unsigned long publication_sequence;

static int same_file_at(int dir, const char *name, const void *p, size_t n,
    uid_t owner, gid_t group, mode_t mode) {
  int fd = openat(dir, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 0;
  struct stat a, b;
  int same = fstat(fd, &a) == 0 && S_ISREG(a.st_mode) && a.st_uid == owner && a.st_gid == group
    && a.st_nlink == 1 && (a.st_mode & 07777) == mode && (size_t) a.st_size == n;
  unsigned char *bytes = same && n ? malloc(n) : NULL;
  size_t offset = 0;
  while (same && offset < n) {
    ssize_t count = read(fd, bytes + offset, n - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { same = 0; break; }
    offset += (size_t) count;
  }
  if (same && (fstat(fd, &b) < 0 || a.st_dev != b.st_dev || a.st_ino != b.st_ino
      || a.st_size != b.st_size || b.st_nlink != 1 || b.st_uid != owner || b.st_gid != group
      || (b.st_mode & 07777) != mode || (n && memcmp(bytes, p, n)))) same = 0;
  free(bytes);
  close(fd);
  return same;
}

static int durable_owned(int dir, const char *name, const void *p, size_t n,
    mode_t mode, uid_t owner, gid_t group) {
  char tmp[128], pending[160];
  unsigned long sequence = ++publication_sequence;
  if (snprintf(tmp, sizeof(tmp), ".tmp-%ld-%lu", (long) getpid(), sequence) >= (int) sizeof(tmp)
      || snprintf(pending, sizeof(pending), ".pending-%s", name) >= (int) sizeof(pending)) {
    errno = ENAMETOOLONG; return -1;
  }
  int marker = openat(dir, pending, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (marker < 0) return -1;
  if (fchmod(marker, 0600) < 0 || fchown(marker, owner, group) < 0
      || write_all(marker, name, strlen(name)) < 0 || fsync(marker) < 0 || close(marker) < 0
      || fsync(dir) < 0) return -1;
  int fd = openat(dir, tmp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, mode);
  if (fd < 0) return -1;
  if (fchmod(fd, mode) < 0 || fchown(fd, owner, group) < 0 || write_all(fd, p, n) < 0
      || fsync(fd) < 0 || close(fd) < 0) return -1;
  int renamed = (int) syscall(SYS_renameat2, dir, tmp, dir, name, RENAME_NOREPLACE);
  if (renamed < 0 && errno == EEXIST) {
    if (!same_file_at(dir, name, p, n, owner, group, mode)) return -1;
    if (unlinkat(dir, tmp, 0) < 0) return -1;
  } else if (renamed < 0) return -1;
  if (fsync(dir) < 0 || unlinkat(dir, pending, 0) < 0 || fsync(dir) < 0) return -1;
  return renamed < 0 ? 1 : 0;
}

static int durable_at(int dir, const char *name, const void *p, size_t n) {
  return durable_owned(dir, name, p, n, 0640, BROKER_UID, SPOOL_GID);
}
static int durable_state(const char *name, const void *p, size_t n) {
  return durable_owned(state_fd, name, p, n, 0600, BROKER_UID, BROKER_UID);
}
static int durable_replace_owned(int dir, const char *name, const void *p, size_t n,
    mode_t mode, uid_t owner, gid_t group) {
  char temp[128];
  if (snprintf(temp, sizeof(temp), ".replace-%ld-%lu", (long) getpid(), ++publication_sequence)
      >= (int) sizeof(temp)) return -1;
  int fd = openat(dir, temp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, mode);
  if (fd < 0) return -1;
  if (fchmod(fd, mode) < 0 || fchown(fd, owner, group) < 0 || write_all(fd, p, n) < 0
      || fsync(fd) < 0 || close(fd) < 0 || renameat(dir, temp, dir, name) < 0
      || fsync(dir) < 0) return -1;
  return 0;
}

static int fresh_directory_scan_fd(int directory_fd) {
  struct open_how how = {
    .flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV,
  };
  return (int) syscall(SYS_openat2, directory_fd, ".", &how, sizeof(how));
}

static int generation_lease_filename(const char *name, char generation[65]) {
  if (strlen(name) != 75U || strncmp(name, "lease-", 6)
      || strcmp(name + 70, ".lock")) return 0;
  memcpy(generation, name + 6, 64); generation[64] = 0;
  return hex64(generation);
}

static void cleanup_old_generation_leases(void) {
  int scan = fresh_directory_scan_fd(state_fd);
  DIR *directory = fdopendir(scan);
  if (!directory) fatal("generation lease cleanup directory unavailable");
  unsigned count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (++count > MAX_SCAN_FILES) fatal("generation lease cleanup exceeds file bound");
    if (strncmp(entry->d_name, "lease-", 6)) continue;
    char generation[65];
    if (!generation_lease_filename(entry->d_name, generation)) {
      fatal("broker state contains an invalid generation lease filename");
    }
    if (!strcmp(entry->d_name, generation_lease_name)) continue;
    int fd = openat(state_fd, entry->d_name, O_RDWR | O_CLOEXEC | O_NOFOLLOW);
    struct stat before, after;
    char stored[64];
    ssize_t bytes = fd < 0 ? -1 : pread(fd, stored, sizeof(stored), 0);
    if (fd < 0 || fstat(fd, &before) < 0 || !S_ISREG(before.st_mode)
        || before.st_uid != BROKER_UID || before.st_gid != BROKER_UID
        || before.st_nlink != 1 || (before.st_mode & 07777) != 0600
        || before.st_size != 64 || bytes != 64 || memcmp(stored, generation, 64)
        || flock(fd, LOCK_EX | LOCK_NB) < 0 || unlinkat(state_fd, entry->d_name, 0) < 0
        || fsync(state_fd) < 0 || fstat(fd, &after) < 0
        || before.st_dev != after.st_dev || before.st_ino != after.st_ino
        || after.st_nlink != 0) {
      if (fd >= 0) close(fd);
      fatal("stale generation lease cleanup failed closed");
    }
    if (close(fd) < 0) fatal("stale generation lease close failed");
  }
  if (closedir(directory) < 0) fatal("generation lease cleanup directory close failed");
}

static void recover_publications(int dir, uid_t owner, gid_t group) {
  int scan = fresh_directory_scan_fd(dir);
  DIR *directory = fdopendir(scan);
  if (!directory) fatal("publication recovery directory unavailable");
  unsigned count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (++count > MAX_SCAN_FILES) fatal("publication recovery exceeds file bound");
    if (!strncmp(entry->d_name, ".tmp-", 5) || !strncmp(entry->d_name, ".replace-", 9)) {
      int fd = openat(dir, entry->d_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
      struct stat metadata;
      if (fd < 0 || fstat(fd, &metadata) < 0 || !S_ISREG(metadata.st_mode)
          || metadata.st_uid != owner || metadata.st_gid != group || metadata.st_nlink != 1) {
        if (fd >= 0) close(fd);
        fatal("untrusted durable-publication temp file");
      }
      close(fd);
      if (unlinkat(dir, entry->d_name, 0) < 0) fatal("could not remove broker-owned crash temp");
    } else if (!strncmp(entry->d_name, ".pending-", 9)) {
      int fd = openat(dir, entry->d_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
      struct stat metadata;
      if (fd < 0 || fstat(fd, &metadata) < 0 || !S_ISREG(metadata.st_mode)
          || metadata.st_uid != owner || metadata.st_gid != group || metadata.st_nlink != 1
          || metadata.st_size <= 0 || metadata.st_size > 128) {
        if (fd >= 0) close(fd);
        fatal("untrusted durable-publication marker");
      }
      close(fd);
      if (unlinkat(dir, entry->d_name, 0) < 0) fatal("could not resolve broker-owned publication marker");
    }
  }
  if (closedir(directory) < 0 || fsync(dir) < 0) fatal("publication recovery fsync failed");
}
static uint32_t be32(const unsigned char*p){return((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3];}
struct cursor { const unsigned char*p;size_t n,o; };
static int next_field(struct cursor*c,size_t max,struct bytes*out){if(c->o+4>c->n)return-1;uint32_t n=be32(c->p+c->o);c->o+=4;if(n>max||c->o+n>c->n)return-1;out->p=(unsigned char*)c->p+c->o;out->n=n;c->o+=n;return 0;}
static int valid_utf8(const unsigned char *bytes, size_t length) {
  size_t index = 0;
  while (index < length) {
    unsigned char first = bytes[index++];
    if (first < 0x80U) continue;
    unsigned needed;
    uint32_t codepoint;
    if (first >= 0xc2U && first <= 0xdfU) { needed = 1U; codepoint = first & 0x1fU; }
    else if (first >= 0xe0U && first <= 0xefU) { needed = 2U; codepoint = first & 0x0fU; }
    else if (first >= 0xf0U && first <= 0xf4U) { needed = 3U; codepoint = first & 0x07U; }
    else return 0;
    if (index + needed > length) return 0;
    for (unsigned offset = 0; offset < needed; offset++) {
      unsigned char continuation = bytes[index++];
      if ((continuation & 0xc0U) != 0x80U) return 0;
      codepoint = (codepoint << 6U) | (uint32_t) (continuation & 0x3fU);
    }
    if ((needed == 2U && codepoint < 0x800U) || (needed == 3U && codepoint < 0x10000U)
        || codepoint > 0x10ffffU || (codepoint >= 0xd800U && codepoint <= 0xdfffU)) return 0;
  }
  return 1;
}
static int copy_text(struct bytes b,char*out,size_t cap,int empty){if(b.n>=cap||(!empty&&!b.n)||memchr(b.p,0,b.n)||!valid_utf8(b.p,b.n))return-1;for(size_t i=0;i<b.n;i++)if(b.p[i]<0x20||b.p[i]==0x7f)return-1;memcpy(out,b.p,b.n);out[b.n]=0;return 0;}
static int decimal(const char*s,unsigned long long min,unsigned long long max,unsigned long long*out){if(!s||!*s||(s[0]=='0'&&s[1]))return-1;for(const unsigned char*p=(const unsigned char*)s;*p;p++)if(*p<'0'||*p>'9')return-1;char*e=NULL;errno=0;unsigned long long v=strtoull(s,&e,10);if(errno||!e||*e||v<min||v>max)return-1;*out=v;return 0;}
static int canonical_run_id(const char *value) {
  if (!value || !*value || strlen(value) > 240) return 0;
  for (const unsigned char *cursor = (const unsigned char *) value; *cursor; cursor++) {
    int allowed = (*cursor >= 'A' && *cursor <= 'Z') || (*cursor >= 'a' && *cursor <= 'z')
      || (*cursor >= '0' && *cursor <= '9') || *cursor == '.' || *cursor == '_'
      || *cursor == ':' || *cursor == '-';
    if (!allowed || (cursor == (const unsigned char *) value
        && !((*cursor >= 'A' && *cursor <= 'Z') || (*cursor >= 'a' && *cursor <= 'z')
          || (*cursor >= '0' && *cursor <= '9')))) return 0;
  }
  return 1;
}
static int safe_relative(const char*s){if(!s||!*s||s[0]=='/'||strchr(s,'\\'))return 0;if(!strcmp(s,"."))return 1;const char*p=s;while(*p){const char*q=strchr(p,'/');size_t n=q?(size_t)(q-p):strlen(p);if(!n||(n==1&&p[0]=='.')||(n==2&&p[0]=='.'&&p[1]=='.'))return 0;if(!q)break;p=q+1;}return 1;}
static int safe_artifact_relative(const char *value) {
  if (!safe_relative(value) || !strcmp(value, ".") || value[strlen(value) - 1U] == '/') return 0;
  for (const unsigned char *cursor = (const unsigned char *) value; *cursor; cursor++) {
    int allowed = (*cursor >= 'A' && *cursor <= 'Z') || (*cursor >= 'a' && *cursor <= 'z')
      || (*cursor >= '0' && *cursor <= '9') || *cursor == '.' || *cursor == '_' || *cursor == '-'
      || *cursor == '/';
    if (!allowed) return 0;
  }
  return 1;
}
static int unsigned_suffix(const char *value, const char *prefix) {
  size_t prefix_length = strlen(prefix);
  if (strncmp(value, prefix, prefix_length) || !value[prefix_length]) return 0;
  for (const unsigned char *cursor = (const unsigned char *) value + prefix_length; *cursor; cursor++) {
    if (*cursor < '0' || *cursor > '9') return 0;
  }
  return 1;
}
static int positive_decimal(const char *value) {
  if (!value || *value < '1' || *value > '9') return 0;
  for (const unsigned char *cursor = (const unsigned char *) value + 1; *cursor; cursor++) {
    if (*cursor < '0' || *cursor > '9') return 0;
  }
  return 1;
}
static int node_test_shard(const char *value) {
  static const char prefix[] = "--test-shard=";
  if (strncmp(value, prefix, sizeof(prefix) - 1U)) return 0;
  const char *slash = strchr(value + sizeof(prefix) - 1U, '/');
  if (!slash || strchr(slash + 1, '/')) return 0;
  size_t left_length = (size_t) (slash - (value + sizeof(prefix) - 1U));
  if (!left_length || left_length >= 24U) return 0;
  char left[24];
  memcpy(left, value + sizeof(prefix) - 1U, left_length); left[left_length] = 0;
  if (!positive_decimal(left) || !positive_decimal(slash + 1)) return 0;
  errno = 0;
  unsigned long long index = strtoull(left, NULL, 10);
  unsigned long long total = strtoull(slash + 1, NULL, 10);
  return errno == 0 && index <= total;
}
static int safe_argument_value(const char *value) {
  if (!value || !*value || value[0] == '@' || value[0] == '/' || strchr(value, '\\')
      || strstr(value, "://") || !strncmp(value, "file:", 5)) return 0;
  const char *cursor = value;
  while (*cursor) {
    const char *slash = strchr(cursor, '/');
    size_t length = slash ? (size_t) (slash - cursor) : strlen(cursor);
    if (!length || (length == 1U && cursor[0] == '.')
        || (length == 2U && cursor[0] == '.' && cursor[1] == '.')) return 0;
    if (!slash) break;
    cursor = slash + 1;
  }
  return 1;
}
static int semantic_policy_allows(const struct request *request) {
  if (!strcmp(request->program, "node")) {
    int saw_script = 0, end_options = 0, check_only = 0, saw_version = 0;
    int saw_test = 0, saw_test_isolation_none = 0;
    if (!request->argc) return 0; /* Never admit the stdin/REPL execution mode. */
    for (unsigned index = 0; index < request->argc; index++) {
      const char *argument = request->argv[index];
      if (argument[0] == '@') return 0;
      if (saw_script) {
        if (!safe_argument_value(argument)) return 0;
        continue;
      }
      if (end_options) {
        if (argument[0] == '-' || !safe_relative(argument) || !strcmp(argument, ".")) return 0;
        saw_script = 1; continue;
      }
      if (!strcmp(argument, "--")) { end_options = 1; continue; }
      if (argument[0] != '-') {
        if (!safe_relative(argument) || !strcmp(argument, ".")) return 0;
        saw_script = 1; continue;
      }
      if (!strcmp(argument, "-") || !strcmp(argument, "-e") || !strcmp(argument, "--eval")
          || !strncmp(argument, "-e", 2) || !strncmp(argument, "--eval=", 7)
          || !strcmp(argument, "-p") || !strcmp(argument, "--print")
          || !strncmp(argument, "-p", 2) || !strncmp(argument, "--print=", 8)) return 0;
      if (!strcmp(argument, "-c") || !strcmp(argument, "--check")) check_only = 1;
      if (!strcmp(argument, "--version")) saw_version = 1;
      if (!strcmp(argument, "--test")) saw_test = 1;
      if (!strcmp(argument, "--test-isolation=none")) saw_test_isolation_none = 1;
      int exact = !strcmp(argument, "-c") || !strcmp(argument, "--check") || !strcmp(argument, "--test")
        || !strcmp(argument, "--test-only") || !strcmp(argument, "--no-warnings")
        || !strcmp(argument, "--trace-warnings") || !strcmp(argument, "--enable-source-maps")
        || !strcmp(argument, "--version") || !strcmp(argument, "--test-isolation=none")
        || !strcmp(argument, "--unhandled-rejections=strict")
        || !strcmp(argument, "--unhandled-rejections=throw")
        || !strcmp(argument, "--unhandled-rejections=warn")
        || !strcmp(argument, "--unhandled-rejections=none");
      int patterned = unsigned_suffix(argument, "--test-concurrency=")
        || unsigned_suffix(argument, "--stack-trace-limit=");
      int pattern = !strncmp(argument, "--test-name-pattern=", 20) && argument[20];
      if (!exact && !patterned && !pattern && !node_test_shard(argument)) return 0;
    }
    if (end_options && !saw_script) return 0;
    if (check_only && !saw_script) return 0;
    if (saw_version && (request->argc != 1U || saw_script || check_only)) return 0;
    if (saw_test != saw_test_isolation_none) return 0;
    return 1;
  }
  if (strcmp(request->program, "godot")) return 0;
  int export_count = 0;
  for (unsigned index = 0; index < request->argc; index++) {
    const char *argument = request->argv[index];
    if (argument[0] == '@' || !strcmp(argument, "--") || strchr(argument, '\\')) return 0;
    if (!strcmp(argument, "--headless") || !strcmp(argument, "--editor")
        || !strcmp(argument, "--quit") || !strcmp(argument, "--verbose")
        || !strcmp(argument, "--import")) continue;
    if (!strcmp(argument, "--path")) {
      if (++index >= request->argc || !safe_relative(request->argv[index])) return 0;
      continue;
    }
    if (!strcmp(argument, "--export-release") || !strcmp(argument, "--export-debug")) {
      if (index + 2 >= request->argc || strcmp(request->argv[index + 1], "Web")
          || !safe_relative(request->argv[index + 2]) || !strcmp(request->argv[index + 2], ".")) return 0;
      export_count++; index += 2; continue;
    }
    if (!strcmp(argument, "--rendering-method")) {
      if (++index >= request->argc || strcmp(request->argv[index], "gl_compatibility")) return 0;
      continue;
    }
    if (!strcmp(argument, "--audio-driver")) {
      if (++index >= request->argc || strcmp(request->argv[index], "Dummy")) return 0;
      continue;
    }
    if (!strcmp(argument, "--display-driver")) {
      if (++index >= request->argc || strcmp(request->argv[index], "headless")) return 0;
      continue;
    }
    return 0;
  }
  return export_count <= 1;
}
static void free_request(struct request*r){
  if(r->argv){for(unsigned i=0;i<r->argc;i++)free(r->argv[i]);free(r->argv);}
  if(r->collect){for(unsigned i=0;i<r->collectc;i++)free(r->collect[i]);free(r->collect);}
  memset(r,0,sizeof(*r));
}
static int parse_request(const unsigned char *packet, size_t size, struct request *r) {
  memset(r, 0, sizeof(*r));
  if (size < 8 || memcmp(packet, MAGIC_REQUEST, 8)) return -1;
  struct cursor outer = { packet, size, 8 };
  struct bytes gen, unsigned_packet;
  if (next_field(&outer, 64, &gen) || next_field(&outer, MAX_PACKET, &unsigned_packet)
      || outer.o != outer.n || copy_text(gen, r->generation, sizeof(r->generation), 0)
      || !hex64(r->generation)) return -1;
  char calculated[65];
  sha_hex(unsigned_packet.p, unsigned_packet.n, calculated);
  if (strcmp(calculated, r->generation) || unsigned_packet.n < 8
      || memcmp(unsigned_packet.p, MAGIC_REQUEST, 8)) return -1;
  struct cursor c = { unsigned_packet.p, unsigned_packet.n, 8 };
  struct bytes b;
  char count[8], collect_count[8], project_quota[20], timeout[20], stdout_limit[20], stderr_limit[20];
  char total_log_limit[20], index[8], total[8];
#define TXT(field,max,empty) do { \
  if (next_field(&c, (max), &b) || copy_text(b, (field), sizeof(field), (empty))) goto bad; \
} while (0)
  TXT(r->request_id, 64, 0);
  TXT(r->run_id, 960, 0);
  TXT(r->request_hash, 64, 0);
  TXT(r->policy_hash, 64, 0);
  TXT(r->broker_instance_id, 64, 0);
  TXT(r->container_generation_id, 64, 0);
  TXT(r->program, 8, 0);
  TXT(r->project, 8000, 0);
  TXT(project_quota, 16, 0);
  TXT(r->cwd, 8000, 0);
  TXT(timeout, 16, 0);
  TXT(stdout_limit, 16, 0);
  TXT(stderr_limit, 16, 0);
  TXT(total_log_limit, 16, 0);
  TXT(index, 4, 0);
  TXT(total, 4, 0);
  TXT(r->previous_generation, 64, 1);
  TXT(r->workspace_dev, 32, 0);
  TXT(r->workspace_ino, 32, 0);
  TXT(count, 4, 0);
#undef TXT
  if (!hex64(r->request_id) || !canonical_run_id(r->run_id)
      || !hex64(r->request_hash) || !hex64(r->policy_hash)
      || !hex64(r->broker_instance_id) || !hex64(r->container_generation_id)
      || (strcmp(r->program, "node") && strcmp(r->program, "godot"))
      || !safe_relative(r->project) || !strcmp(r->project, ".") || !safe_relative(r->cwd)) goto bad;
  unsigned long long v;
  if (decimal(project_quota, 10000, 2147483647, &v)) goto bad;
  r->project_quota_id = (unsigned) v;
  if (!reviewed_project(r->project, r->project_quota_id)) goto bad;
  if (decimal(timeout, 1000, 1800000, &v)) goto bad;
  r->timeout_ms = (unsigned) v;
  if (decimal(stdout_limit, 0, MAX_LOG_BYTES, &v)) goto bad;
  r->stdout_limit = (unsigned) v;
  if (decimal(stderr_limit, 0, MAX_LOG_BYTES, &v)) goto bad;
  r->stderr_limit = (unsigned) v;
  if (decimal(total_log_limit, 0, MAX_LOG_BYTES, &v)) goto bad;
  r->total_log_limit = (unsigned) v;
  if (r->stdout_limit > r->total_log_limit || r->stderr_limit > r->total_log_limit) goto bad;
  if (decimal(index, 0, 23, &v)) goto bad;
  r->step_index = (unsigned) v;
  if (decimal(total, 1, 24, &v)) goto bad;
  r->total_steps = (unsigned) v;
  if (r->step_index >= r->total_steps || ((r->step_index == 0) != (r->previous_generation[0] == 0))
      || (r->previous_generation[0] && !hex64(r->previous_generation))) goto bad;
  if (decimal(count, 0, MAX_ARGS, &v)) goto bad;
  r->argc = (unsigned) v;
  if (decimal(r->workspace_dev, 1, UINT64_MAX, &v)
      || decimal(r->workspace_ino, 1, UINT64_MAX, &v)) goto bad;
  r->argv = calloc(r->argc + 1U, sizeof(char *));
  if (!r->argv) goto bad;
  for (unsigned i = 0; i < r->argc; i++) {
    if (next_field(&c, MAX_ARG_BYTES, &b) || memchr(b.p, 0, b.n) || !valid_utf8(b.p, b.n)) goto bad;
    for (size_t j = 0; j < b.n; j++) if (b.p[j] < 0x20 || b.p[j] == 0x7f) goto bad;
    r->argv[i] = malloc(b.n + 1U);
    if (!r->argv[i]) goto bad;
    memcpy(r->argv[i], b.p, b.n);
    r->argv[i][b.n] = 0;
  }
  if (next_field(&c, 4, &b) || copy_text(b, collect_count, sizeof(collect_count), 0)
      || decimal(collect_count, 0, MAX_ARTIFACTS, &v)) goto bad;
  r->collectc = (unsigned) v;
  if (r->collectc) {
    r->collect = calloc(r->collectc, sizeof(char *));
    if (!r->collect) goto bad;
  }
  for (unsigned i = 0; i < r->collectc; i++) {
    if (next_field(&c, 2000, &b) || memchr(b.p, 0, b.n) || !valid_utf8(b.p, b.n)) goto bad;
    r->collect[i] = malloc(b.n + 1U);
    if (!r->collect[i] || copy_text(b, r->collect[i], b.n + 1U, 0)
        || !safe_artifact_relative(r->collect[i])
        || (i && strcmp(r->collect[i - 1U], r->collect[i]) >= 0)) goto bad;
  }
  if (c.o != c.n || !semantic_policy_allows(r)) goto bad;
  return 0;
bad:
  free_request(r);
  return -1;
}
static int open_beneath(int root,const char*rel,int flags){struct open_how h={.flags=(uint64_t)flags,.resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV};return(int)syscall(SYS_openat2,root,rel,&h,sizeof(h));}

static int reviewed_project_slug(const char *slug) {
  for (unsigned index = 0; index < sizeof(reviewed_projects) / sizeof(reviewed_projects[0]); index++) {
    if (!strcmp(reviewed_projects[index].slug, slug)) return 1;
  }
  return 0;
}

static int exact_quota_directory_fd(int fd, unsigned quota_id, dev_t expected_device,
    struct stat *metadata_out) {
  struct stat metadata;
  struct fsxattr attributes;
  memset(&attributes, 0, sizeof(attributes));
  if (fd < 0 || fstat(fd, &metadata) < 0 || !S_ISDIR(metadata.st_mode)
      || metadata.st_uid != BROKER_UID || metadata.st_gid != BROKER_UID
      || (metadata.st_mode & 07777) != 0700 || metadata.st_dev != expected_device
      || ioctl(fd, FS_IOC_FSGETXATTR, &attributes) < 0
      || attributes.fsx_projid != quota_id
      || !(attributes.fsx_xflags & FS_XFLAG_PROJINHERIT)) {
    errno = EPERM;
    return -1;
  }
  if (metadata_out) *metadata_out = metadata;
  return 0;
}

static int exact_quota_directory_at(int parent, const char *name, unsigned quota_id,
    dev_t expected_device, int *out) {
  int fd = open_beneath(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0 || exact_quota_directory_fd(fd, quota_id, expected_device, NULL) < 0) {
    if (fd >= 0) close(fd);
    return -1;
  }
  if (out) *out = fd;
  else if (close(fd) < 0) return -1;
  return 0;
}

static int exact_lost_found_fd(int fd, dev_t expected_device, struct stat *out) {
  struct stat metadata;
  if (fd < 0 || fstat(fd, &metadata) < 0 || !S_ISDIR(metadata.st_mode)
      || metadata.st_uid != 0 || metadata.st_gid != 0
      || (metadata.st_mode & 07777) != 0700 || metadata.st_dev != expected_device) {
    errno = EPERM;
    return -1;
  }
  if (out) *out = metadata;
  return 0;
}

static int duplicate_directory_scan_fd(int directory_fd) {
  int scan = fcntl(directory_fd, F_DUPFD_CLOEXEC, 20);
  if (scan < 0 || lseek(scan, 0, SEEK_SET) < 0) {
    if (scan >= 0) close(scan);
    return -1;
  }
  return scan;
}

static int exact_symlink_at(int parent, const char *name, const char *target,
    dev_t expected_device) {
  struct stat metadata;
  size_t target_length = strlen(target);
  char measured[4096];
  if (!target_length || target_length >= sizeof(measured)
      || fstatat(parent, name, &metadata, AT_SYMLINK_NOFOLLOW) < 0
      || !S_ISLNK(metadata.st_mode) || metadata.st_uid != BROKER_UID
      || metadata.st_gid != BROKER_UID || metadata.st_nlink != 1
      || metadata.st_dev != expected_device || (metadata.st_mode & 07777) != 0777
      || metadata.st_size != (off_t) target_length) {
    errno = EPERM;
    return -1;
  }
  ssize_t count = readlinkat(parent, name, measured, sizeof(measured));
  if (count != (ssize_t) target_length || memcmp(measured, target, target_length)) {
    errno = EPERM;
    return -1;
  }
  return 0;
}

static int exact_private_directory_at(int parent, const char *name, mode_t mode,
    dev_t expected_device, int *out) {
  int fd = open_beneath(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat metadata;
  if (fd < 0 || fstat(fd, &metadata) < 0 || !S_ISDIR(metadata.st_mode)
      || metadata.st_uid != BROKER_UID || metadata.st_gid != BROKER_UID
      || metadata.st_dev != expected_device || (metadata.st_mode & 07777) != mode) {
    if (fd >= 0) close(fd);
    errno = EPERM;
    return -1;
  }
  if (out) *out = fd;
  else if (close(fd) < 0) return -1;
  return 0;
}

static int directory_has_exact_names(int directory_fd, const char *const *names,
    unsigned expected_count) {
  int scan = duplicate_directory_scan_fd(directory_fd);
  DIR *directory = fdopendir(scan);
  if (!directory) return -1;
  uint64_t seen = 0;
  unsigned count = 0;
  int valid = expected_count <= 63U;
  for (struct dirent *entry = readdir(directory); valid && entry; entry = readdir(directory)) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++count > expected_count) { valid = 0; break; }
    unsigned index;
    for (index = 0; index < expected_count; index++) if (!strcmp(entry->d_name, names[index])) break;
    if (index == expected_count || (seen & (1ULL << index))) { valid = 0; break; }
    seen |= 1ULL << index;
  }
  if (closedir(directory) < 0) return -1;
  uint64_t expected = expected_count == 64U ? UINT64_MAX : ((1ULL << expected_count) - 1ULL);
  if (!valid || count != expected_count || seen != expected) { errno = EPERM; return -1; }
  return 0;
}

static int exact_workspace_wrapper(const struct workspace_project_layout *layout,
    mode_t expected_mode, int verify_data_binding) {
  struct stat path_metadata, wrapper_metadata, project_metadata, opened_metadata;
  if (!layout || !layout->project || layout->wrapper_fd < 0 || layout->project_fd < 0
      || fstatat(workspace_private_fd, layout->project->slug, &path_metadata,
        AT_SYMLINK_NOFOLLOW) < 0
      || fstat(layout->wrapper_fd, &wrapper_metadata) < 0
      || !S_ISDIR(path_metadata.st_mode) || !S_ISDIR(wrapper_metadata.st_mode)
      || path_metadata.st_uid != BROKER_UID || path_metadata.st_gid != BROKER_UID
      || path_metadata.st_nlink != 3 || (path_metadata.st_mode & 07777) != expected_mode
      || path_metadata.st_dev != layout->wrapper_dev || path_metadata.st_ino != layout->wrapper_ino
      || wrapper_metadata.st_dev != layout->wrapper_dev || wrapper_metadata.st_ino != layout->wrapper_ino
      || wrapper_metadata.st_nlink != 3 || (wrapper_metadata.st_mode & 07777) != expected_mode
      || exact_quota_directory_fd(layout->project_fd, layout->project->quota_id,
        layout->project_dev, &project_metadata) < 0
      || project_metadata.st_dev != layout->project_dev || project_metadata.st_ino != layout->project_ino) {
    errno = EPERM;
    return -1;
  }
  const char *only_data[] = { WORKSPACE_DATA_NAME };
  if (directory_has_exact_names(layout->wrapper_fd, only_data, 1U) < 0) return -1;
  if (verify_data_binding) {
    int opened = open_beneath(layout->wrapper_fd, WORKSPACE_DATA_NAME,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    int valid = opened >= 0 && fstat(opened, &opened_metadata) == 0
      && opened_metadata.st_dev == layout->project_dev && opened_metadata.st_ino == layout->project_ino
      && exact_quota_directory_fd(opened, layout->project->quota_id, layout->project_dev, NULL) == 0;
    if (opened >= 0 && close(opened) < 0) valid = 0;
    if (!valid) { errno = EPERM; return -1; }
  }
  return 0;
}

static int exact_lost_found_gate(int parent_fd, int gate_fd, int data_fd,
    dev_t expected_device, mode_t expected_mode) {
  struct stat path_metadata, gate_metadata;
  const char *only_data[] = { WORKSPACE_DATA_NAME };
  if (fstatat(parent_fd, LOST_FOUND_GATE_NAME, &path_metadata, AT_SYMLINK_NOFOLLOW) < 0
      || fstat(gate_fd, &gate_metadata) < 0 || !S_ISDIR(path_metadata.st_mode)
      || !S_ISDIR(gate_metadata.st_mode) || path_metadata.st_uid != BROKER_UID
      || path_metadata.st_gid != BROKER_UID || path_metadata.st_nlink != 3
      || path_metadata.st_dev != expected_device || gate_metadata.st_dev != path_metadata.st_dev
      || gate_metadata.st_ino != path_metadata.st_ino || gate_metadata.st_nlink != 3
      || (path_metadata.st_mode & 07777) != expected_mode
      || (gate_metadata.st_mode & 07777) != expected_mode
      || directory_has_exact_names(gate_fd, only_data, 1U) < 0
      || exact_lost_found_fd(data_fd, expected_device, NULL) < 0) {
    errno = EPERM;
    return -1;
  }
  return 0;
}

static void initialize_lost_found_gate(int parent_fd, dev_t expected_device,
    int *gate_fd_out, int *data_fd_out) {
  struct stat before;
  if (fstatat(parent_fd, LOST_FOUND_GATE_NAME, &before, AT_SYMLINK_NOFOLLOW) < 0
      || !S_ISDIR(before.st_mode) || before.st_uid != BROKER_UID || before.st_gid != BROKER_UID
      || before.st_nlink != 3 || before.st_dev != expected_device
      || ((before.st_mode & 07777) != 0000 && (before.st_mode & 07777) != 0700)
      || fchmodat(parent_fd, LOST_FOUND_GATE_NAME, 0700, 0) < 0) {
    fatal("lost+found DAC gate reset failed");
  }
  int gate_fd = open_beneath(parent_fd, LOST_FOUND_GATE_NAME,
    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  int data_fd = gate_fd >= 0 ? open_beneath(gate_fd, WORKSPACE_DATA_NAME,
    O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW) : -1;
  if (gate_fd < 0 || data_fd < 0 || exact_lost_found_fd(data_fd, expected_device, NULL) < 0
      || exact_lost_found_gate(parent_fd, gate_fd, data_fd, expected_device, 0700) < 0
      || fchmod(gate_fd, 0000) < 0 || fsync(gate_fd) < 0 || fsync(parent_fd) < 0
      || exact_lost_found_gate(parent_fd, gate_fd, data_fd, expected_device, 0000) < 0) {
    fatal("lost+found DAC gate identity or startup revocation failed");
  }
  *gate_fd_out = gate_fd;
  *data_fd_out = data_fd;
}

static void initialize_workspace_layout(void) {
  struct stat root, private_metadata;
  if (fstat(workspace_fd, &root) < 0
      || exact_private_directory_at(workspace_fd, WORKSPACE_PRIVATE_NAME, 0700,
        root.st_dev, &workspace_private_fd) < 0
      || fstat(workspace_private_fd, &private_metadata) < 0) {
    fatal("workspace private project root identity is invalid");
  }
  const char *names[sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0]) + 1U];
  for (unsigned index = 0; index < sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0]); index++) {
    names[index] = workspace_layout_projects[index].slug;
  }
  names[sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0])] = LOST_FOUND_GATE_NAME;
  if (directory_has_exact_names(workspace_private_fd, names,
      sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0]) + 1U) < 0) {
    fatal("workspace private root differs from the fixed project map");
  }
  for (unsigned index = 0; index < sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0]); index++) {
    struct workspace_project_layout *layout = &workspace_project_layouts[index];
    const struct reviewed_project *project = &workspace_layout_projects[index];
    struct stat before, wrapper, data;
    if (fstatat(workspace_private_fd, project->slug, &before, AT_SYMLINK_NOFOLLOW) < 0
        || !S_ISDIR(before.st_mode) || before.st_uid != BROKER_UID || before.st_gid != BROKER_UID
        || before.st_nlink != 3 || before.st_dev != root.st_dev
        || ((before.st_mode & 07777) != 0000 && (before.st_mode & 07777) != 0700)
        || fchmodat(workspace_private_fd, project->slug, 0700, 0) < 0) {
      fatal("workspace project wrapper reset failed");
    }
    int wrapper_fd = open_beneath(workspace_private_fd, project->slug,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (wrapper_fd < 0 || fstat(wrapper_fd, &wrapper) < 0
        || wrapper.st_dev != before.st_dev || wrapper.st_ino != before.st_ino
        || wrapper.st_uid != BROKER_UID || wrapper.st_gid != BROKER_UID
        || wrapper.st_nlink != 3 || (wrapper.st_mode & 07777) != 0700) {
      fatal("workspace project wrapper identity changed during reset");
    }
    layout->project = project;
    layout->wrapper_fd = wrapper_fd;
    layout->wrapper_dev = wrapper.st_dev;
    layout->wrapper_ino = wrapper.st_ino;
    const char *only_data[] = { WORKSPACE_DATA_NAME };
    if (directory_has_exact_names(wrapper_fd, only_data, 1U) < 0
        || exact_quota_directory_at(wrapper_fd, WORKSPACE_DATA_NAME, project->quota_id,
          root.st_dev, &layout->project_fd) < 0
        || fstat(layout->project_fd, &data) < 0) {
      fatal("workspace project wrapper content or quota identity is invalid");
    }
    layout->project_dev = data.st_dev;
    layout->project_ino = data.st_ino;
    for (unsigned previous = 0; previous < index; previous++) {
      if ((workspace_project_layouts[previous].wrapper_dev == layout->wrapper_dev
          && workspace_project_layouts[previous].wrapper_ino == layout->wrapper_ino)
          || (workspace_project_layouts[previous].project_dev == layout->project_dev
          && workspace_project_layouts[previous].project_ino == layout->project_ino)) {
        fatal("workspace wrapper or project inode is reused across fixed projects");
      }
    }
    if (fchmod(layout->wrapper_fd, 0000) < 0 || fsync(layout->wrapper_fd) < 0
        || exact_workspace_wrapper(layout, 0000, 0) < 0) {
      fatal("workspace project wrapper startup revocation failed");
    }
  }
  initialize_lost_found_gate(workspace_private_fd, root.st_dev,
    &workspace_lost_gate_fd, &workspace_lost_found_fd);
  if (fsync(workspace_private_fd) < 0) fatal("workspace wrapper reset was not durable");
  active_workspace_project = -1;
}

static int open_workspace_project(const char *slug, int *project_fd) {
  struct workspace_project_layout *layout = workspace_project_layout(slug);
  if (!layout || active_workspace_project != -1 || exact_workspace_wrapper(layout, 0000, 0) < 0) {
    errno = EPERM;
    return -1;
  }
  if (fchmod(layout->wrapper_fd, 0700) < 0) return -1;
  if (fsync(layout->wrapper_fd) < 0 || fsync(workspace_private_fd) < 0
      || exact_workspace_wrapper(layout, 0700, 1) < 0) {
    int saved = errno;
    if (fchmod(layout->wrapper_fd, 0000) < 0 || fsync(layout->wrapper_fd) < 0
        || fsync(workspace_private_fd) < 0) fatal("workspace wrapper admission rollback failed");
    errno = saved;
    return -1;
  }
  active_workspace_project = (int) (layout - workspace_project_layouts);
  int duplicate = fcntl(layout->project_fd, F_DUPFD_CLOEXEC, 20);
  if (duplicate < 0) {
    if (fchmod(layout->wrapper_fd, 0000) < 0 || fsync(layout->wrapper_fd) < 0
        || fsync(workspace_private_fd) < 0) fatal("workspace wrapper rollback failed");
    active_workspace_project = -1;
    return -1;
  }
  *project_fd = duplicate;
  return 0;
}

static void close_workspace_project_or_fatal(const char *slug) {
  struct workspace_project_layout *layout = workspace_project_layout(slug);
  int index = layout ? (int) (layout - workspace_project_layouts) : -1;
  if (!layout || active_workspace_project != index
      || exact_workspace_wrapper(layout, 0700, 1) < 0
      || fchmod(layout->wrapper_fd, 0000) < 0 || fsync(layout->wrapper_fd) < 0
      || fsync(workspace_private_fd) < 0 || exact_workspace_wrapper(layout, 0000, 0) < 0) {
    fatal("selected workspace wrapper revocation failed");
  }
  active_workspace_project = -1;
}

static void revoke_active_workspace_best_effort(void) {
  if (active_workspace_project < 0
      || (unsigned) active_workspace_project >= sizeof(workspace_project_layouts) / sizeof(workspace_project_layouts[0])) {
    return;
  }
  struct workspace_project_layout *layout = &workspace_project_layouts[active_workspace_project];
  if (layout->wrapper_fd >= 0) {
    (void) fchmod(layout->wrapper_fd, 0000);
    (void) fsync(layout->wrapper_fd);
  }
  if (workspace_private_fd >= 0) (void) fsync(workspace_private_fd);
  active_workspace_project = -1;
}

static void verify_workspace_root_layout(void) {
  struct stat root, private_metadata;
  if (active_workspace_project != -1 || fstat(workspace_fd, &root) < 0
      || fstat(workspace_private_fd, &private_metadata) < 0
      || !S_ISDIR(private_metadata.st_mode) || private_metadata.st_uid != BROKER_UID
      || private_metadata.st_gid != BROKER_UID || private_metadata.st_dev != root.st_dev
      || (private_metadata.st_mode & 07777) != 0700) {
    fatal("workspace root or wrapper concurrency identity is invalid");
  }
  int scan = fresh_directory_scan_fd(workspace_fd);
  DIR *directory = fdopendir(scan);
  if (!directory) fatal("workspace root preflight scan is unavailable");
  uint64_t seen = 0;
  unsigned count = 0, private_seen = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++count > sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0]) + 2U) {
      fatal("workspace root contains entries outside the fixed indirection map");
    }
    if (!strcmp(entry->d_name, "lost+found")) {
      if (seen & (1ULL << 63)) fatal("workspace lost+found entry is duplicated");
      if (exact_symlink_at(workspace_fd, "lost+found",
          WORKSPACE_PRIVATE_NAME "/" LOST_FOUND_GATE_NAME "/" WORKSPACE_DATA_NAME,
          root.st_dev) < 0
          || exact_lost_found_gate(workspace_private_fd, workspace_lost_gate_fd,
            workspace_lost_found_fd, root.st_dev, 0000) < 0) {
        fatal("workspace lost+found DAC indirection identity is invalid");
      }
      seen |= 1ULL << 63;
      continue;
    }
    if (!strcmp(entry->d_name, WORKSPACE_PRIVATE_NAME)) {
      if (private_seen++) fatal("workspace private project root is duplicated");
      continue;
    }
    const struct reviewed_project *project = workspace_layout_project(entry->d_name);
    if (!project) fatal("workspace root contains an unknown public project entry");
    unsigned index = (unsigned) (project - workspace_layout_projects);
    char target[4096];
    int length = snprintf(target, sizeof(target), "%s/%s/%s", WORKSPACE_PRIVATE_NAME,
      project->slug, WORKSPACE_DATA_NAME);
    if (seen & (1ULL << index) || length <= 0 || (size_t) length >= sizeof(target)
        || exact_symlink_at(workspace_fd, project->slug, target, root.st_dev) < 0
        || exact_workspace_wrapper(&workspace_project_layouts[index], 0000, 0) < 0) {
      fatal("workspace fixed public link or private wrapper identity is invalid");
    }
    seen |= 1ULL << index;
  }
  if (closedir(directory) < 0) fatal("workspace root preflight scan close failed");
  uint64_t expected = (1ULL << 63)
    | ((1ULL << (sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0]))) - 1ULL);
  if (seen != expected || private_seen != 1U) fatal("workspace indirection map is incomplete");
  const char *private_names[sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0]) + 1U];
  for (unsigned index = 0; index < sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0]); index++) {
    private_names[index] = workspace_layout_projects[index].slug;
  }
  private_names[sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0])] = LOST_FOUND_GATE_NAME;
  if (directory_has_exact_names(workspace_private_fd, private_names,
      sizeof(workspace_layout_projects) / sizeof(workspace_layout_projects[0]) + 1U) < 0) {
    fatal("workspace private root contains an unknown wrapper");
  }
}

static void verify_runtime_directory_at(int parent, const char *name, dev_t runtime_device) {
  if (exact_quota_directory_at(parent, name, RUNTIME_QUOTA_ID, runtime_device, NULL) < 0) {
    fatal("payload runtime directory identity is invalid");
  }
}

static unsigned scan_active_runtime(int allow_active, dev_t runtime_device) {
  int scan = fresh_directory_scan_fd(runtime_active_fd);
  DIR *directory = fdopendir(scan);
  if (!directory) fatal("active runtime preflight scan is unavailable");
  unsigned count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++count > 1U || !reviewed_project_slug(entry->d_name)
        || (allow_active && fchmodat(runtime_active_fd, entry->d_name, 0700, 0) < 0)
        || exact_quota_directory_at(runtime_active_fd, entry->d_name, RUNTIME_QUOTA_ID,
          runtime_device, NULL) < 0) {
      fatal("active runtime contains an invalid project entry");
    }
  }
  if (closedir(directory) < 0) fatal("active runtime preflight scan close failed");
  if (count && !allow_active) fatal("active runtime was not empty before payload admission");
  return count;
}

static unsigned scan_retained_runtime(dev_t runtime_device) {
  int scan = fresh_directory_scan_fd(runtime_retained_fd);
  DIR *directory = fdopendir(scan);
  if (!directory) fatal("retained runtime preflight scan is unavailable");
  unsigned count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++count > MAX_RETAINED_GENERATIONS || !hex64(entry->d_name)
        || exact_quota_directory_at(runtime_retained_fd, entry->d_name, RUNTIME_QUOTA_ID,
          runtime_device, NULL) < 0) {
      fatal("retained runtime contains an invalid generation entry");
    }
    char target[4096];
    int length = snprintf(target, sizeof(target), "%s/%s/%s/%s", RUNTIME_PRIVATE_NAME,
      RUNTIME_RETAINED_GATE_NAME, WORKSPACE_DATA_NAME, entry->d_name);
    if (length <= 0 || (size_t) length >= sizeof(target)
        || exact_symlink_at(runtime_fd, entry->d_name, target, runtime_device) < 0) {
      fatal("retained runtime generation lacks its exact public indirection link");
    }
  }
  if (closedir(directory) < 0) fatal("retained runtime preflight scan close failed");
  return count;
}

static void initialize_runtime_gate(const char *name, dev_t runtime_device,
    int *gate_fd_out, int *data_fd_out) {
  struct stat before, gate, data;
  if (fstatat(runtime_private_fd, name, &before, AT_SYMLINK_NOFOLLOW) < 0
      || !S_ISDIR(before.st_mode) || before.st_uid != BROKER_UID || before.st_gid != BROKER_UID
      || before.st_nlink != 3 || before.st_dev != runtime_device
      || ((before.st_mode & 07777) != 0000 && (before.st_mode & 07777) != 0700)
      || fchmodat(runtime_private_fd, name, 0700, 0) < 0) {
    fatal("runtime private gate reset failed");
  }
  int gate_fd = open_beneath(runtime_private_fd, name,
    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (gate_fd < 0 || fstat(gate_fd, &gate) < 0 || gate.st_dev != before.st_dev
      || gate.st_ino != before.st_ino || gate.st_uid != BROKER_UID || gate.st_gid != BROKER_UID
      || gate.st_nlink != 3 || (gate.st_mode & 07777) != 0700) {
    fatal("runtime private gate identity changed during reset");
  }
  const char *only_data[] = { WORKSPACE_DATA_NAME };
  int data_fd = -1;
  if (directory_has_exact_names(gate_fd, only_data, 1U) < 0
      || exact_quota_directory_at(gate_fd, WORKSPACE_DATA_NAME, RUNTIME_QUOTA_ID,
        runtime_device, &data_fd) < 0
      || fstat(data_fd, &data) < 0 || data.st_dev != runtime_device
      || fchmod(gate_fd, 0000) < 0 || fsync(gate_fd) < 0 || fsync(runtime_private_fd) < 0
      || fstat(gate_fd, &gate) < 0 || (gate.st_mode & 07777) != 0000
      || gate.st_dev != before.st_dev || gate.st_ino != before.st_ino) {
    fatal("runtime private gate content or startup revocation failed");
  }
  *gate_fd_out = gate_fd;
  *data_fd_out = data_fd;
}

static void reconcile_runtime_generation_links(dev_t runtime_device) {
  int scan = fresh_directory_scan_fd(runtime_retained_fd);
  DIR *directory = fdopendir(scan);
  if (!directory) fatal("runtime generation-link reconciliation scan is unavailable");
  unsigned count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++count > MAX_RETAINED_GENERATIONS || !hex64(entry->d_name)
        || exact_quota_directory_at(runtime_retained_fd, entry->d_name, RUNTIME_QUOTA_ID,
          runtime_device, NULL) < 0) {
      fatal("runtime generation-link reconciliation found invalid retained state");
    }
    char target[4096];
    int length = snprintf(target, sizeof(target), "%s/%s/%s/%s", RUNTIME_PRIVATE_NAME,
      RUNTIME_RETAINED_GATE_NAME, WORKSPACE_DATA_NAME, entry->d_name);
    struct stat public_metadata;
    if (length <= 0 || (size_t) length >= sizeof(target)) {
      fatal("runtime generation-link target exceeds its fixed bound");
    }
    if (fstatat(runtime_fd, entry->d_name, &public_metadata, AT_SYMLINK_NOFOLLOW) < 0) {
      if (errno != ENOENT || symlinkat(target, runtime_fd, entry->d_name) < 0
          || fsync(runtime_fd) < 0) {
        fatal("runtime generation-link crash recovery failed");
      }
    }
    if (exact_symlink_at(runtime_fd, entry->d_name, target, runtime_device) < 0) {
      fatal("runtime generation-link crash recovery found a conflicting public entry");
    }
  }
  if (closedir(directory) < 0) fatal("runtime generation-link reconciliation close failed");

  scan = fresh_directory_scan_fd(runtime_fd);
  directory = fdopendir(scan);
  if (!directory) fatal("runtime public generation-link reconciliation scan is unavailable");
  count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..") || !hex64(entry->d_name)) continue;
    if (++count > MAX_RETAINED_GENERATIONS
        || exact_quota_directory_at(runtime_retained_fd, entry->d_name, RUNTIME_QUOTA_ID,
          runtime_device, NULL) < 0) {
      fatal("runtime public generation link has no exact retained backing directory");
    }
  }
  if (closedir(directory) < 0) fatal("runtime public generation-link reconciliation close failed");
}

static void initialize_runtime_layout(void) {
  struct stat root, private_metadata, retained_data, sibling_data, retained_gate, sibling_gate, lost_gate;
  if (fstat(runtime_root_fd, &root) < 0
      || exact_private_directory_at(runtime_fd, RUNTIME_PRIVATE_NAME, 0700,
        root.st_dev, &runtime_private_fd) < 0
      || fstat(runtime_private_fd, &private_metadata) < 0) {
    fatal("runtime private gate root identity is invalid");
  }
  const char *gate_names[] = { RUNTIME_RETAINED_GATE_NAME, RUNTIME_SIBLING_GATE_NAME,
    LOST_FOUND_GATE_NAME };
  if (directory_has_exact_names(runtime_private_fd, gate_names, 3U) < 0) {
    fatal("runtime private root differs from the fixed gate map");
  }
  initialize_runtime_gate(RUNTIME_RETAINED_GATE_NAME, root.st_dev,
    &runtime_retained_gate_fd, &runtime_retained_fd);
  initialize_runtime_gate(RUNTIME_SIBLING_GATE_NAME, root.st_dev,
    &runtime_sibling_gate_fd, &runtime_sibling_fd);
  initialize_lost_found_gate(runtime_private_fd, root.st_dev,
    &runtime_lost_gate_fd, &runtime_lost_found_fd);
  if (fstat(runtime_retained_fd, &retained_data) < 0 || fstat(runtime_sibling_fd, &sibling_data) < 0
      || (retained_data.st_dev == sibling_data.st_dev && retained_data.st_ino == sibling_data.st_ino)
      || fstat(runtime_retained_gate_fd, &retained_gate) < 0
      || fstat(runtime_sibling_gate_fd, &sibling_gate) < 0
      || fstat(runtime_lost_gate_fd, &lost_gate) < 0
      || (retained_gate.st_dev == sibling_gate.st_dev && retained_gate.st_ino == sibling_gate.st_ino)
      || (retained_gate.st_dev == lost_gate.st_dev && retained_gate.st_ino == lost_gate.st_ino)
      || (sibling_gate.st_dev == lost_gate.st_dev && sibling_gate.st_ino == lost_gate.st_ino)) {
    fatal("runtime private gate/data identities overlap");
  }
  if (exact_symlink_at(runtime_fd, RETAINED_RUNTIME_NAME,
      RUNTIME_PRIVATE_NAME "/" RUNTIME_RETAINED_GATE_NAME "/" WORKSPACE_DATA_NAME,
      root.st_dev) < 0
      || exact_symlink_at(runtime_fd, TEST_RUNTIME_SIBLING_NAME,
        RUNTIME_PRIVATE_NAME "/" RUNTIME_SIBLING_GATE_NAME "/" WORKSPACE_DATA_NAME,
        root.st_dev) < 0
      || exact_symlink_at(runtime_root_fd, "lost+found",
        "payload/" RUNTIME_PRIVATE_NAME "/" LOST_FOUND_GATE_NAME "/" WORKSPACE_DATA_NAME,
        root.st_dev) < 0) {
    fatal("runtime fixed public DAC indirection links are invalid");
  }
  reconcile_runtime_generation_links(root.st_dev);
}

static void verify_runtime_root_layout(int allow_active) {
  struct stat root, payload;
  if (fstat(runtime_root_fd, &root) < 0 || fstat(runtime_fd, &payload) < 0
      || root.st_dev != payload.st_dev) fatal("runtime root identity is unavailable");
  int scan = fresh_directory_scan_fd(runtime_root_fd);
  DIR *directory = fdopendir(scan);
  if (!directory) fatal("runtime mount root preflight scan is unavailable");
  unsigned seen_payload = 0, seen_lost = 0, count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++count > 2U) fatal("runtime mount root contains an unknown entry");
    if (!strcmp(entry->d_name, "payload")) {
      if (seen_payload++) fatal("runtime payload root is duplicated");
      verify_runtime_directory_at(runtime_root_fd, "payload", root.st_dev);
    } else if (!strcmp(entry->d_name, "lost+found")) {
      if (seen_lost++ || exact_symlink_at(runtime_root_fd, "lost+found",
          "payload/" RUNTIME_PRIVATE_NAME "/" LOST_FOUND_GATE_NAME "/" WORKSPACE_DATA_NAME,
          root.st_dev) < 0
          || exact_lost_found_gate(runtime_private_fd, runtime_lost_gate_fd,
            runtime_lost_found_fd, root.st_dev, 0000) < 0) {
        fatal("runtime lost+found DAC indirection identity is invalid");
      }
    } else fatal("runtime mount root contains an unknown entry");
  }
  if (closedir(directory) < 0 || seen_payload != 1U || seen_lost != 1U) {
    fatal("runtime mount root layout is incomplete");
  }

  scan = fresh_directory_scan_fd(runtime_fd);
  directory = fdopendir(scan);
  if (!directory) fatal("payload runtime root preflight scan is unavailable");
  unsigned seen_active = 0, seen_retained = 0, seen_sibling = 0, seen_private = 0;
  unsigned public_generations = 0;
  count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++count > MAX_RETAINED_GENERATIONS + 4U) fatal("payload runtime root exceeds its entry bound");
    if (!strcmp(entry->d_name, ACTIVE_RUNTIME_NAME)) {
      if (seen_active++) fatal("active runtime root is duplicated");
      verify_runtime_directory_at(runtime_fd, ACTIVE_RUNTIME_NAME, root.st_dev);
    } else if (!strcmp(entry->d_name, RETAINED_RUNTIME_NAME)) {
      if (seen_retained++) fatal("retained runtime root is duplicated");
      if (exact_symlink_at(runtime_fd, RETAINED_RUNTIME_NAME,
          RUNTIME_PRIVATE_NAME "/" RUNTIME_RETAINED_GATE_NAME "/" WORKSPACE_DATA_NAME,
          root.st_dev) < 0) fatal("retained runtime public indirection is invalid");
    } else if (!strcmp(entry->d_name, TEST_RUNTIME_SIBLING_NAME)) {
      if (seen_sibling++) fatal("runtime isolation sibling is duplicated");
      if (exact_symlink_at(runtime_fd, TEST_RUNTIME_SIBLING_NAME,
          RUNTIME_PRIVATE_NAME "/" RUNTIME_SIBLING_GATE_NAME "/" WORKSPACE_DATA_NAME,
          root.st_dev) < 0) fatal("runtime isolation sibling public indirection is invalid");
    } else if (!strcmp(entry->d_name, RUNTIME_PRIVATE_NAME)) {
      if (seen_private++) fatal("runtime private gate root is duplicated");
    } else if (hex64(entry->d_name)) {
      char target[4096];
      int length = snprintf(target, sizeof(target), "%s/%s/%s/%s", RUNTIME_PRIVATE_NAME,
        RUNTIME_RETAINED_GATE_NAME, WORKSPACE_DATA_NAME, entry->d_name);
      if (++public_generations > MAX_RETAINED_GENERATIONS || length <= 0
          || (size_t) length >= sizeof(target)
          || exact_symlink_at(runtime_fd, entry->d_name, target, root.st_dev) < 0
          || exact_quota_directory_at(runtime_retained_fd, entry->d_name, RUNTIME_QUOTA_ID,
            root.st_dev, NULL) < 0) {
        fatal("payload runtime generation indirection is invalid");
      }
    } else fatal("payload runtime root contains an unknown entry");
  }
  if (closedir(directory) < 0 || seen_active != 1U || seen_retained != 1U
      || seen_sibling != 1U || seen_private != 1U) {
    fatal("payload runtime root layout is incomplete");
  }
  struct stat private_metadata, retained_gate, sibling_gate, retained_data, sibling_data;
  const char *private_names[] = { RUNTIME_RETAINED_GATE_NAME, RUNTIME_SIBLING_GATE_NAME,
    LOST_FOUND_GATE_NAME };
  const char *only_data[] = { WORKSPACE_DATA_NAME };
  if (fstat(runtime_private_fd, &private_metadata) < 0 || !S_ISDIR(private_metadata.st_mode)
      || private_metadata.st_uid != BROKER_UID || private_metadata.st_gid != BROKER_UID
      || private_metadata.st_dev != root.st_dev || (private_metadata.st_mode & 07777) != 0700
      || directory_has_exact_names(runtime_private_fd, private_names, 3U) < 0
      || fstat(runtime_retained_gate_fd, &retained_gate) < 0
      || fstat(runtime_sibling_gate_fd, &sibling_gate) < 0
      || !S_ISDIR(retained_gate.st_mode) || !S_ISDIR(sibling_gate.st_mode)
      || retained_gate.st_uid != BROKER_UID || retained_gate.st_gid != BROKER_UID
      || sibling_gate.st_uid != BROKER_UID || sibling_gate.st_gid != BROKER_UID
      || retained_gate.st_nlink != 3 || sibling_gate.st_nlink != 3
      || retained_gate.st_dev != root.st_dev || sibling_gate.st_dev != root.st_dev
      || (retained_gate.st_mode & 07777) != 0000 || (sibling_gate.st_mode & 07777) != 0000
      || directory_has_exact_names(runtime_retained_gate_fd, only_data, 1U) < 0
      || directory_has_exact_names(runtime_sibling_gate_fd, only_data, 1U) < 0
      || exact_quota_directory_fd(runtime_retained_fd, RUNTIME_QUOTA_ID, root.st_dev,
        &retained_data) < 0
      || exact_quota_directory_fd(runtime_sibling_fd, RUNTIME_QUOTA_ID, root.st_dev,
        &sibling_data) < 0) {
    fatal("runtime private DAC gate identity is invalid");
  }
  (void) scan_active_runtime(allow_active, root.st_dev);
  if (scan_retained_runtime(root.st_dev) != public_generations) {
    fatal("retained runtime public/private generation sets differ");
  }
}

static int remove_runtime_tree_contents(int directory_fd, unsigned depth, unsigned *entries,
    dev_t runtime_device) {
  if (depth > 64U) { errno = EOVERFLOW; return -1; }
  int scan = fresh_directory_scan_fd(directory_fd);
  DIR *directory = fdopendir(scan);
  if (!directory) return -1;
  int failed = 0;
  for (struct dirent *entry = readdir(directory); !failed && entry; entry = readdir(directory)) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++*entries > MAX_RUNTIME_ENTRIES) { errno = EOVERFLOW; failed = 1; break; }
    struct stat metadata;
    if (fstatat(directory_fd, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) < 0
        || metadata.st_dev != runtime_device || metadata.st_uid != BROKER_UID
        || metadata.st_gid != BROKER_UID) { errno = EPERM; failed = 1; break; }
    if (S_ISDIR(metadata.st_mode)) {
      int child = open_beneath(directory_fd, entry->d_name,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      if (child < 0 && errno == EACCES) {
        if (fchmodat(directory_fd, entry->d_name, 0700, 0) < 0) { failed = 1; break; }
        child = open_beneath(directory_fd, entry->d_name,
          O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      }
      if (child < 0 || remove_runtime_tree_contents(child, depth + 1U, entries, runtime_device) < 0
          || close(child) < 0 || unlinkat(directory_fd, entry->d_name, AT_REMOVEDIR) < 0) {
        if (child >= 0) close(child);
        failed = 1;
      }
    } else if (S_ISREG(metadata.st_mode) || S_ISLNK(metadata.st_mode)) {
      if (unlinkat(directory_fd, entry->d_name, 0) < 0) failed = 1;
    } else {
      errno = EPERM;
      failed = 1;
    }
  }
  if (closedir(directory) < 0) failed = 1;
  if (!failed && fsync(directory_fd) < 0) failed = 1;
  return failed ? -1 : 0;
}

static int remove_named_runtime_tree(int parent, const char *name) {
  struct stat root, metadata;
  if (fstat(runtime_root_fd, &root) < 0) return -1;
  if (fstatat(parent, name, &metadata, AT_SYMLINK_NOFOLLOW) < 0) return errno == ENOENT ? 0 : -1;
  if (!S_ISDIR(metadata.st_mode) || metadata.st_dev != root.st_dev
      || metadata.st_uid != BROKER_UID || metadata.st_gid != BROKER_UID) {
    errno = EPERM; return -1;
  }
  if ((metadata.st_mode & 0700) != 0700 && fchmodat(parent, name, 0700, 0) < 0) return -1;
  int fd = open_beneath(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  unsigned entries = 0;
  if (fd < 0 || remove_runtime_tree_contents(fd, 0, &entries, root.st_dev) < 0
      || close(fd) < 0 || unlinkat(parent, name, AT_REMOVEDIR) < 0 || fsync(parent) < 0) {
    if (fd >= 0) close(fd);
    return -1;
  }
  return 0;
}

static int directory_mentions_generation(int directory_fd, const char *generation) {
  int scan = fresh_directory_scan_fd(directory_fd);
  DIR *directory = fdopendir(scan);
  if (!directory) return -1;
  unsigned count = 0;
  int found = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (++count > MAX_SCAN_FILES) { found = -1; break; }
    if (strstr(entry->d_name, generation)) { found = 1; break; }
  }
  if (closedir(directory) < 0) return -1;
  return found;
}

static int runtime_generation_referenced(const char *generation) {
  const int directories[] = { requests_fd, results_fd, state_fd };
  for (unsigned index = 0; index < sizeof(directories) / sizeof(directories[0]); index++) {
    int found = directory_mentions_generation(directories[index], generation);
    if (found) return found;
  }
  return 0;
}

static int runtime_directory_exists(int parent, const char *name) {
  struct stat metadata;
  if (fstatat(parent, name, &metadata, AT_SYMLINK_NOFOLLOW) < 0) return errno == ENOENT ? 0 : -1;
  if (!S_ISDIR(metadata.st_mode) || metadata.st_uid != BROKER_UID || metadata.st_gid != BROKER_UID) {
    errno = EPERM; return -1;
  }
  return 1;
}

static int runtime_generation_link_state(const char *generation) {
  struct stat root, metadata;
  char target[4096];
  int length = snprintf(target, sizeof(target), "%s/%s/%s/%s", RUNTIME_PRIVATE_NAME,
    RUNTIME_RETAINED_GATE_NAME, WORKSPACE_DATA_NAME, generation);
  if (fstat(runtime_root_fd, &root) < 0 || length <= 0 || (size_t) length >= sizeof(target)) return -1;
  if (fstatat(runtime_fd, generation, &metadata, AT_SYMLINK_NOFOLLOW) < 0) {
    return errno == ENOENT ? 0 : -1;
  }
  return exact_symlink_at(runtime_fd, generation, target, root.st_dev) == 0 ? 1 : -1;
}

static int ensure_runtime_generation_link(const char *generation) {
  int state = runtime_generation_link_state(generation);
  if (state < 0) return -1;
  if (!state) {
    char target[4096];
    int length = snprintf(target, sizeof(target), "%s/%s/%s/%s", RUNTIME_PRIVATE_NAME,
      RUNTIME_RETAINED_GATE_NAME, WORKSPACE_DATA_NAME, generation);
    if (length <= 0 || (size_t) length >= sizeof(target)
        || symlinkat(target, runtime_fd, generation) < 0 || fsync(runtime_fd) < 0) return -1;
  }
  return runtime_generation_link_state(generation) == 1 ? 0 : -1;
}

static int remove_runtime_generation_link(const char *generation) {
  int state = runtime_generation_link_state(generation);
  if (state < 0) return -1;
  if (state && (unlinkat(runtime_fd, generation, 0) < 0 || fsync(runtime_fd) < 0)) return -1;
  return 0;
}

static int retain_active_runtime(const char *project, const char *generation, int allow_absent) {
  if (!reviewed_project_slug(project) || !hex64(generation)) { errno = EINVAL; return -1; }
  int active = runtime_directory_exists(runtime_active_fd, project);
  int retained = runtime_directory_exists(runtime_retained_fd, generation);
  int public_link = runtime_generation_link_state(generation);
  if (active < 0 || retained < 0 || public_link < 0 || (active && (retained || public_link))
      || (public_link && !retained)) return -1;
  if (active) {
    if (fchmodat(runtime_active_fd, project, 0700, 0) < 0
        || syscall(SYS_renameat2, runtime_active_fd, project, runtime_retained_fd, generation,
          RENAME_NOREPLACE) < 0
        || fsync(runtime_active_fd) < 0 || fsync(runtime_retained_fd) < 0
        || ensure_runtime_generation_link(generation) < 0) return -1;
    retained = 1;
  }
  if (retained) {
    struct stat root;
    if (fstat(runtime_root_fd, &root) < 0
        || exact_quota_directory_at(runtime_retained_fd, generation, RUNTIME_QUOTA_ID,
          root.st_dev, NULL) < 0 || ensure_runtime_generation_link(generation) < 0) return -1;
    return 0;
  }
  return allow_absent ? 0 : -1;
}

static int cleanup_generation_runtime(const char *generation) {
  if (!hex64(generation)) { errno = EINVAL; return -1; }
  if (remove_runtime_generation_link(generation) < 0) return -1;
  return remove_named_runtime_tree(runtime_retained_fd, generation);
}

static void sweep_orphan_runtime_generations(void) {
  int scan = fresh_directory_scan_fd(runtime_retained_fd);
  DIR *directory = fdopendir(scan);
  if (!directory) fatal("runtime orphan sweep scan is unavailable");
  unsigned count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++count > MAX_RETAINED_GENERATIONS || !hex64(entry->d_name)) {
      fatal("runtime orphan sweep exceeds its fixed retained-generation map");
    }
    int referenced = runtime_generation_referenced(entry->d_name);
    if (referenced < 0) fatal("runtime lineage reference scan failed closed");
    if (!referenced && cleanup_generation_runtime(entry->d_name) < 0) {
      fatal("unreferenced runtime lineage cleanup failed closed");
    }
  }
  if (closedir(directory) < 0) fatal("runtime orphan sweep scan close failed");
}

static unsigned long long starttime_for(pid_t pid){char path[64],buf[4096];snprintf(path,sizeof(path),"/proc/%ld/stat",(long)pid);int fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(fd<0)return 0;ssize_t n=read(fd,buf,sizeof(buf)-1);close(fd);if(n<=0)return 0;buf[n]=0;char*p=strrchr(buf,')');if(!p||p[1]!=' ')return 0;p+=2;for(int field=3;field<22;field++){p=strchr(p,' ');if(!p)return 0;p++;}char*e=NULL;unsigned long long v=strtoull(p,&e,10);return(e&&e!=p)?v:0;}
struct payload_measurement {
  char label[256];
  int no_new_privs;
  int seccomp_filters;
  int caps_zero;
};

static int payload_measured(pid_t pid, unsigned long long expected_start, const struct request *request,
    struct payload_measurement *measurement) {
  if (starttime_for(pid) != expected_start) return 0;
  char path[96], status[8192];
  snprintf(path, sizeof(path), "/proc/%ld/attr/current", (long) pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 0;
  ssize_t count = read(fd, measurement->label, sizeof(measurement->label) - 1U);
  close(fd);
  if (count <= 0) return 0;
  measurement->label[count] = 0;
  while (count > 0 && (measurement->label[count - 1] == '\n' || measurement->label[count - 1] == '\r')) {
    measurement->label[--count] = 0;
  }
  char expected[256];
  int expected_length = snprintf(expected, sizeof(expected),
    "dominion-gx10-gamefactory-broker//&dominion-gx10-guard-%s-%s (enforce)",
    request->program, request->project);
  if (expected_length <= 0 || (size_t) expected_length >= sizeof(expected)
      || strcmp(measurement->label, expected)) return 0;
  snprintf(path, sizeof(path), "/proc/%ld/status", (long) pid);
  fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 0;
  count = read(fd, status, sizeof(status) - 1U);
  close(fd);
  if (count <= 0) return 0;
  status[count] = 0;
  measurement->no_new_privs = strstr(status, "NoNewPrivs:\t1\n") != NULL;
  char *filters = strstr(status, "Seccomp_filters:\t");
  measurement->seccomp_filters = filters ? atoi(filters + strlen("Seccomp_filters:\t")) : 0;
  measurement->caps_zero = 1;
  const char *names[] = { "CapInh:\t0000000000000000", "CapPrm:\t0000000000000000",
    "CapEff:\t0000000000000000", "CapBnd:\t0000000000000000", "CapAmb:\t0000000000000000" };
  for (unsigned i = 0; i < 5; i++) if (!strstr(status, names[i])) measurement->caps_zero = 0;
  return measurement->no_new_privs == 1 && measurement->seccomp_filters >= 2
    && measurement->caps_zero == 1 && starttime_for(pid) == expected_start;
}
static int read_exact_file(const char *path, char *out, size_t capacity, ssize_t *length) {
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 0;
  ssize_t count = read(fd, out, capacity - 1U);
  int saved = errno;
  if (close(fd) < 0 || count <= 0 || count == (ssize_t) (capacity - 1U)) return 0;
  errno = saved; out[count] = 0; *length = count; return 1;
}
static int guard_executable_and_cgroup_measured(pid_t pid, unsigned long long expected_start,
    const char *guard_path) {
  char path[96], target[512], self_cgroup[4096], child_cgroup[4096];
  snprintf(path, sizeof(path), "/proc/%ld/exe", (long) pid);
  ssize_t target_length = readlink(path, target, sizeof(target) - 1U);
  if (target_length <= 0 || target_length == (ssize_t) (sizeof(target) - 1U)) return 0;
  target[target_length] = 0;
  if (strcmp(target, guard_path)) return 0;
  ssize_t self_length = 0, child_length = 0;
  snprintf(path, sizeof(path), "/proc/%ld/cgroup", (long) pid);
  if (!read_exact_file("/proc/self/cgroup", self_cgroup, sizeof(self_cgroup), &self_length)
      || !read_exact_file(path, child_cgroup, sizeof(child_cgroup), &child_length)
      || self_length != child_length || memcmp(self_cgroup, child_cgroup, (size_t) self_length)) return 0;
  return starttime_for(pid) == expected_start;
}
static int hex_to_bytes(const char *hex, unsigned char out[32]) {
  if (!hex64(hex)) return 0;
  for (unsigned i = 0; i < 32; i++) {
    unsigned high = (unsigned) (hex[i * 2] <= '9' ? hex[i * 2] - '0' : hex[i * 2] - 'a' + 10);
    unsigned low = (unsigned) (hex[i * 2 + 1] <= '9' ? hex[i * 2 + 1] - '0' : hex[i * 2 + 1] - 'a' + 10);
    out[i] = (unsigned char) ((high << 4) | low);
  }
  return 1;
}
static void iso_now(char out[40]) {
  struct timespec ts;
  if (clock_gettime(CLOCK_REALTIME, &ts) < 0) fatal("clock_gettime failed");
  struct tm tm;
  if (!gmtime_r(&ts.tv_sec, &tm) || strftime(out, 24, "%Y-%m-%dT%H:%M:%S", &tm) != 19) {
    fatal("UTC timestamp formatting failed");
  }
  unsigned millis = (unsigned) (ts.tv_nsec / 1000000L);
  if (snprintf(out + 19, 21, ".%03uZ", millis) != 5) fatal("millisecond timestamp formatting failed");
}
static void append_field(struct bytes*b,const void*p,size_t n){size_t old=b->n;b->p=realloc(b->p,old+4+n);if(!b->p)fatal("result allocation failed");b->p[old]=(unsigned char)(n>>24);b->p[old+1]=(unsigned char)(n>>16);b->p[old+2]=(unsigned char)(n>>8);b->p[old+3]=(unsigned char)n;memcpy(b->p+old+4,p,n);b->n=old+4+n;}
static void add_text(struct bytes*b,const char*s){append_field(b,s,strlen(s));}
static void format_identity(const struct stat *metadata, char dev[33], char ino[33]) {
  snprintf(dev, 33, "%llu", (unsigned long long) metadata->st_dev);
  snprintf(ino, 33, "%llu", (unsigned long long) metadata->st_ino);
}
static void format_mount_identity(int fd, char mount_id[33], char digest[65]) {
  struct statx metadata;
  memset(&metadata, 0, sizeof(metadata));
  if (statx(fd, "", AT_EMPTY_PATH | AT_NO_AUTOMOUNT, STATX_MNT_ID, &metadata) < 0
      || !(metadata.stx_mask & STATX_MNT_ID) || !metadata.stx_mnt_id) {
    fatal("exact mount identity is unavailable");
  }
  struct stat identity;
  if (fstat(fd, &identity) < 0) fatal("exact mount stat is unavailable");
  char text[128];
  int length = snprintf(text, sizeof(text), "%llu:%llu:%llu", (unsigned long long) metadata.stx_mnt_id,
    (unsigned long long) identity.st_dev, (unsigned long long) identity.st_ino);
  if (length <= 0 || (size_t) length >= sizeof(text)) fatal("exact mount identity formatting failed");
  snprintf(mount_id, 33, "%llu", (unsigned long long) metadata.stx_mnt_id);
  sha_hex(text, (size_t) length, digest);
}
static void require_broker_kernel_security(void) {
  char status[16384]; ssize_t length = 0;
  if (!read_exact_file("/proc/self/status", status, sizeof(status), &length)) {
    fatal("broker kernel security status is unavailable");
  }
  (void) length;
  if (!strstr(status, "NoNewPrivs:\t1\n") || !strstr(status, "Seccomp:\t2\n")) {
    fatal("broker no-new-privileges/raw seccomp proof is absent");
  }
  char *filters = strstr(status, "Seccomp_filters:\t");
  broker_seccomp_filters = filters ? atoi(filters + strlen("Seccomp_filters:\t")) : 0;
  broker_caps_zero = 1;
  const char *names[] = { "CapInh:\t0000000000000000", "CapPrm:\t0000000000000000",
    "CapEff:\t0000000000000000", "CapBnd:\t0000000000000000", "CapAmb:\t0000000000000000" };
  for (unsigned index = 0; index < sizeof(names) / sizeof(names[0]); index++) {
    if (!strstr(status, names[index])) broker_caps_zero = 0;
  }
  if (broker_seccomp_filters < 1 || !broker_caps_zero) fatal("broker capability/seccomp contract is invalid");
}
static void capture_broker_runtime_identity(int lease_fd) {
  struct stat pid_namespace, cgroup, lease, workspace, runtime;
  if (stat("/proc/self/ns/pid", &pid_namespace) < 0 || fstat(lease_fd, &lease) < 0
      || fstat(workspace_fd, &workspace) < 0 || fstat(runtime_root_fd, &runtime) < 0) {
    fatal("broker runtime identity metadata is unavailable");
  }
  format_identity(&pid_namespace, pid_namespace_dev, pid_namespace_ino);
  format_identity(&lease, lease_dev, lease_ino);
  format_identity(&workspace, workspace_dev, workspace_ino);
  format_identity(&runtime, runtime_dev, runtime_ino);
  format_mount_identity(workspace_fd, workspace_mount_id, workspace_mount_identity_hash);
  format_mount_identity(runtime_root_fd, runtime_mount_id, runtime_mount_identity_hash);
  char cgroup_text[4096]; ssize_t length = 0;
  if (!read_exact_file("/proc/self/cgroup", cgroup_text, sizeof(cgroup_text), &length)) {
    fatal("broker cgroup identity is unavailable");
  }
  sha_hex(cgroup_text, (size_t) length, cgroup_hash);
  char *line = strstr(cgroup_text, "0::");
  if (!line) fatal("unified cgroup v2 is required");
  line += 3; char *newline = strchr(line, '\n'); if (newline) *newline = 0;
  if (*line != '/' || !strcmp(line, "/")) fatal("broker must run in a dedicated non-root cgroup v2 path");
  char path[4608];
  if (snprintf(path, sizeof(path), "/sys/fs/cgroup%s", line) >= (int) sizeof(path)
      || stat(path, &cgroup) < 0 || !S_ISDIR(cgroup.st_mode)) fatal("broker cgroup directory is unavailable");
  snprintf(cgroup_ino, sizeof(cgroup_ino), "%llu", (unsigned long long) cgroup.st_ino);
  landlock_abi = (int) syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (landlock_abi < 3) fatal("Landlock ABI 3 or newer is required");
}
static int publish_readiness(void) {
  char updated[40], landlock[32], filters[16], handled[32], sequence[32];
  iso_now(updated); snprintf(landlock, sizeof(landlock), "%d", landlock_abi);
  snprintf(filters, sizeof(filters), "%d", broker_seccomp_filters);
  snprintf(handled, sizeof(handled), "%llu", (unsigned long long) LANDLOCK_HANDLED_ACCESS_FS);
  snprintf(sequence, sizeof(sequence), "%lu", ++readiness_sequence);
  struct bytes packet = { (unsigned char *) strdup("DGFRDY01"), 8 };
  if (!packet.p) return -1;
#define READY(value) add_text(&packet, (value))
  READY("game-factory-broker/1"); READY(broker_instance); READY(container_generation); READY(broker_boot_id_hash);
  READY(broker_starttime); READY(pid_namespace_dev); READY(pid_namespace_ino); READY(cgroup_hash); READY(cgroup_ino);
  READY(lease_dev); READY(lease_ino); READY(workspace_dev); READY(workspace_ino);
  READY(workspace_mount_id); READY(workspace_mount_identity_hash); READY(runtime_dev); READY(runtime_ino);
  READY(runtime_mount_id); READY(runtime_mount_identity_hash); READY(broker_binary_hash); READY(node_guard_hash);
  READY(godot_guard_hash); READY(node_executable_hash); READY(godot_executable_hash); READY(node_filter_hash);
  READY(godot_filter_hash); READY(apparmor_policy_hash); READY(outer_seccomp_hash); READY(deployment_policy_hash);
  READY("dominion-gx10-gamefactory-broker (enforce)"); READY("1"); READY(filters); READY("1");
  READY(landlock); READY(handled); READY("1"); READY("node,godot"); READY("quality_assurance,godot");
  READY(sequence); READY(updated);
#undef READY
  int result = durable_replace_owned(results_fd, READY_NAME, packet.p, packet.n,
    0640, BROKER_UID, SPOOL_GID);
  free(packet.p);
  if (result == 0) cleanup_old_generation_leases();
  return result;
}
static int publish_result(const struct request *request, const char *state, int exit_code,
    const char *payload_state, pid_t pid, unsigned long long start, const char *decision,
    const struct result_evidence *evidence, const char *error) {
  char name[96], code[24], pidtext[24], starttext[32], observed[40], step[8], total[8];
  char no_new_privs[4], filters[16], caps[4], wait_pid[24], wait_code[16], wait_status[16];
  char stdout_limit[24], stderr_limit[24], total_limit[24], stdout_bytes[24], stderr_bytes[24];
  char artifact_count[8], artifact_bytes[24];
  snprintf(name, sizeof(name), "result-%s.bin", request->generation);
  snprintf(code, sizeof(code), "%d", exit_code);
  snprintf(pidtext, sizeof(pidtext), "%ld", (long) pid);
  snprintf(starttext, sizeof(starttext), "%llu", start);
  snprintf(step, sizeof(step), "%u", request->step_index);
  snprintf(total, sizeof(total), "%u", request->total_steps);
  snprintf(no_new_privs, sizeof(no_new_privs), "%d", evidence->no_new_privs);
  snprintf(filters, sizeof(filters), "%d", evidence->seccomp_filters);
  snprintf(caps, sizeof(caps), "%d", evidence->caps_zero);
  snprintf(wait_pid, sizeof(wait_pid), "%d", evidence->wait_pid);
  snprintf(wait_code, sizeof(wait_code), "%d", evidence->wait_code);
  snprintf(wait_status, sizeof(wait_status), "%d", evidence->wait_status);
  snprintf(stdout_limit, sizeof(stdout_limit), "%u", request->stdout_limit);
  snprintf(stderr_limit, sizeof(stderr_limit), "%u", request->stderr_limit);
  snprintf(total_limit, sizeof(total_limit), "%u", request->total_log_limit);
  snprintf(stdout_bytes, sizeof(stdout_bytes), "%zu", evidence->stdout_bytes);
  snprintf(stderr_bytes, sizeof(stderr_bytes), "%zu", evidence->stderr_bytes);
  snprintf(artifact_count, sizeof(artifact_count), "%u", evidence->artifact_count);
  snprintf(artifact_bytes, sizeof(artifact_bytes), "%zu", evidence->artifact_bytes);
  iso_now(observed);
  struct bytes packet = { (unsigned char *) strdup(MAGIC_RESULT), 8 };
  if (!packet.p) return -1;
#define ADD(value) add_text(&packet, (value))
  ADD(request->generation); ADD(request->run_id); ADD(step); ADD(total); ADD(request->previous_generation);
  ADD(request->request_id); ADD(request->request_hash); ADD(request->policy_hash); ADD(broker_instance);
  ADD(broker_boot_id_hash); ADD(deployment_policy_hash);
  ADD(state); ADD(code); ADD(payload_state); ADD(pid ? pidtext : "0"); ADD(start ? starttext : "");
  ADD(observed); ADD(decision ? decision : "");
  ADD(broker_binary_hash); ADD(node_guard_hash); ADD(godot_guard_hash);
  ADD(node_executable_hash); ADD(godot_executable_hash);
  ADD(node_filter_hash); ADD(godot_filter_hash); ADD(apparmor_policy_hash); ADD(outer_seccomp_hash);
  ADD(evidence->measured_guard_label); ADD(evidence->expected_final_label);
  ADD(evidence->final_transition_attested ? "1" : "0");
  ADD(no_new_privs); ADD(filters); ADD(caps);
  ADD(wait_pid); ADD(wait_code); ADD(wait_status);
  ADD(evidence->cancel_hash); ADD(evidence->termination_reason); ADD(evidence->kill_outcome);
  ADD(stdout_limit); ADD(stderr_limit); ADD(total_limit);
  ADD(evidence->stdout_hash); ADD(stdout_bytes); ADD(evidence->stdout_truncated ? "1" : "0");
  ADD(evidence->stderr_hash); ADD(stderr_bytes); ADD(evidence->stderr_truncated ? "1" : "0");
  ADD(evidence->artifact_manifest_hash); ADD(artifact_count); ADD(artifact_bytes);
  ADD(error ? error : "");
#undef ADD
  int result = durable_at(results_fd, name, packet.p, packet.n);
  free(packet.p);
  return result;
}

static void empty_evidence(struct result_evidence *evidence) {
  memset(evidence, 0, sizeof(*evidence));
  sha_hex("", 0, evidence->stdout_hash);
  sha_hex("", 0, evidence->stderr_hash);
  evidence->caps_zero = 0;
}

/* The payload never writes directly to a controller-visible path.  A successful final generation
   can ferry only the controller-bound `collect` files through this broker-owned result spool. */
static const char *artifact_mime_for(const char *path) {
  const char *extension = strrchr(path, '.');
  if (!extension || extension == path) return NULL;
  extension++;
  if (!strcmp(extension, "html")) return "text/html";
  if (!strcmp(extension, "js")) return "text/javascript";
  if (!strcmp(extension, "css")) return "text/css";
  if (!strcmp(extension, "json") || !strcmp(extension, "map")) return "application/json";
  if (!strcmp(extension, "wasm")) return "application/wasm";
  if (!strcmp(extension, "pck")) return "application/octet-stream";
  if (!strcmp(extension, "zip")) return "application/zip";
  if (!strcmp(extension, "png")) return "image/png";
  if (!strcmp(extension, "jpg") || !strcmp(extension, "jpeg")) return "image/jpeg";
  if (!strcmp(extension, "webp")) return "image/webp";
  if (!strcmp(extension, "svg")) return "image/svg+xml";
  if (!strcmp(extension, "ico")) return "image/x-icon";
  if (!strcmp(extension, "txt")) return "text/plain";
  return NULL;
}

static int append_manifest_bytes(struct bytes *manifest, const void *bytes, size_t length) {
  if (length > MAX_ARTIFACT_MANIFEST_BYTES - manifest->n) return -1;
  unsigned char *next = realloc(manifest->p, manifest->n + length);
  if (!next && length) return -1;
  manifest->p = next;
  if (length) memcpy(manifest->p + manifest->n, bytes, length);
  manifest->n += length;
  return 0;
}

static int read_collected_artifact(int project_fd, const char *path, struct bytes *content,
    char digest[65]) {
  *content = (struct bytes) { 0 };
  int fd = open_beneath(project_fd, path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct stat before, after;
  if (fd < 0 || fstat(fd, &before) < 0 || !S_ISREG(before.st_mode) || before.st_uid != BROKER_UID
      || before.st_gid != BROKER_UID || before.st_nlink != 1 || before.st_size < 0
      || (uint64_t) before.st_size > MAX_ARTIFACT_BYTES) goto bad;
  content->n = (size_t) before.st_size;
  content->p = malloc(content->n ? content->n : 1U);
  if (!content->p) goto bad;
  size_t offset = 0;
  while (offset < content->n) {
    ssize_t count = read(fd, content->p + offset, content->n - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) goto bad;
    offset += (size_t) count;
  }
  if (fstat(fd, &after) < 0 || before.st_dev != after.st_dev || before.st_ino != after.st_ino
      || before.st_size != after.st_size || after.st_uid != BROKER_UID || after.st_gid != BROKER_UID
      || after.st_nlink != 1 || !S_ISREG(after.st_mode)) goto bad;
  if (close(fd) < 0) { fd = -1; goto bad; }
  sha_hex(content->p, content->n, digest);
  return 0;
bad:
  if (fd >= 0) close(fd);
  free(content->p); *content = (struct bytes) { 0 };
  errno = EPERM;
  return -1;
}

static int publish_artifact_ferry(const struct request *request, struct result_evidence *evidence) {
  evidence->artifact_manifest_hash[0] = 0;
  evidence->artifact_count = 0;
  evidence->artifact_bytes = 0;
  if (request->collectc > MAX_ARTIFACTS) return -1;
  struct workspace_project_layout *layout = workspace_project_layout(request->project);
  int project = layout ? fcntl(layout->project_fd, F_DUPFD_CLOEXEC, 20) : -1;
  struct stat workspace, metadata;
  struct fsxattr attributes;
  memset(&attributes, 0, sizeof(attributes));
  if (!layout || layout->project->quota_id != request->project_quota_id || project < 0
      || active_workspace_project != -1
      || fstat(workspace_fd, &workspace) < 0 || fstat(project, &metadata) < 0
      || !S_ISDIR(metadata.st_mode) || metadata.st_uid != BROKER_UID || metadata.st_gid != BROKER_UID
      || (metadata.st_mode & 07777) != 0700 || metadata.st_dev != workspace.st_dev
      || metadata.st_dev != layout->project_dev || metadata.st_ino != layout->project_ino
      || ioctl(project, FS_IOC_FSGETXATTR, &attributes) < 0
      || attributes.fsx_projid != request->project_quota_id
      || !(attributes.fsx_xflags & FS_XFLAG_PROJINHERIT)) {
    if (project >= 0) close(project);
    return -1;
  }

  struct bytes manifest = { 0 };
  char header[4096];
  int header_length = snprintf(header, sizeof(header),
    "{\"protocol\":\"game-factory-broker-artifacts/1\",\"generationId\":\"%s\",\"runId\":\"%s\",\"requestHash\":\"%s\",\"stepIndex\":%u,\"totalSteps\":%u,\"projectRelative\":\"%s\",\"artifacts\":[",
    request->generation, request->run_id, request->request_hash, request->step_index,
    request->total_steps, request->project);
  if (header_length <= 0 || (size_t) header_length >= sizeof(header)
      || append_manifest_bytes(&manifest, header, (size_t) header_length) < 0) goto bad;

  size_t total = 0;
  for (unsigned index = 0; index < request->collectc; index++) {
    const char *path = request->collect[index];
    const char *mime = artifact_mime_for(path);
    struct bytes content = { 0 };
    char hash[65], spool_name[128], item[4096];
    if (!mime || read_collected_artifact(project, path, &content, hash) < 0
        || content.n > MAX_TOTAL_ARTIFACT_BYTES - total
        || snprintf(spool_name, sizeof(spool_name), "artifact-%s-%u.bin", request->generation, index) >= (int) sizeof(spool_name)
        || durable_at(results_fd, spool_name, content.p, content.n) < 0) {
      free(content.p); goto bad;
    }
    int item_length = snprintf(item, sizeof(item), "%s{\"path\":\"%s\",\"mimeType\":\"%s\",\"bytes\":%zu,\"sha256\":\"%s\",\"spoolName\":\"%s\"}",
      index ? "," : "", path, mime, content.n, hash, spool_name);
    free(content.p);
    if (item_length <= 0 || (size_t) item_length >= sizeof(item)
        || append_manifest_bytes(&manifest, item, (size_t) item_length) < 0) goto bad;
    total += content.n;
  }
  char tail[64];
  int tail_length = snprintf(tail, sizeof(tail), "],\"totalBytes\":%zu}", total);
  if (tail_length <= 0 || (size_t) tail_length >= sizeof(tail)
      || append_manifest_bytes(&manifest, tail, (size_t) tail_length) < 0) goto bad;
  char manifest_name[128];
  if (snprintf(manifest_name, sizeof(manifest_name), "artifacts-%s.json", request->generation) >= (int) sizeof(manifest_name)
      || durable_at(results_fd, manifest_name, manifest.p, manifest.n) < 0) goto bad;
  sha_hex(manifest.p, manifest.n, evidence->artifact_manifest_hash);
  evidence->artifact_count = request->collectc;
  evidence->artifact_bytes = total;
  free(manifest.p);
  if (close(project) < 0) return -1;
  return 0;
bad:
  free(manifest.p);
  close(project);
  evidence->artifact_manifest_hash[0] = 0;
  evidence->artifact_count = 0;
  evidence->artifact_bytes = 0;
  return -1;
}

static int publish_without_payload_reason(const struct request *request, const char *state,
    const char *error, const char *reason, const char *cancel_hash) {
  struct result_evidence evidence;
  empty_evidence(&evidence);
  snprintf(evidence.termination_reason, sizeof(evidence.termination_reason), "%s", reason);
  if (cancel_hash) snprintf(evidence.cancel_hash, sizeof(evidence.cancel_hash), "%s", cancel_hash);
  snprintf(evidence.kill_outcome, sizeof(evidence.kill_outcome), "%s", "none");
  char decision_material[512], decision[65];
  int length = snprintf(decision_material, sizeof(decision_material), "%s\n%s\n%s",
    broker_instance, request->generation, error ? error : "");
  if (length <= 0 || (size_t) length >= sizeof(decision_material)) return -1;
  sha_hex(decision_material, (size_t) length, decision);
  return publish_result(request, state, -1, "never_started", 0, 0, decision, &evidence, error);
}
static int publish_without_payload(const struct request *request, const char *state, const char *error) {
  return publish_without_payload_reason(request, state, error, "never_started", NULL);
}
static int predecessor_succeeded(const struct request *request) {
  if (request->step_index == 0) return 1;
  char name[96];
  snprintf(name, sizeof(name), "result-%s.bin", request->previous_generation);
  struct bytes packet = read_trusted_at(results_fd, name, BROKER_UID, MAX_PACKET);
  if (!packet.p) return errno == ENOENT ? 0 : -1;
  struct cursor cursor = { packet.p, packet.n, 8 };
  struct bytes generation, run_id, step, total, previous, ignored, policy, state;
  int valid = packet.n >= 8 && !memcmp(packet.p, MAGIC_RESULT, 8)
    && !next_field(&cursor, 64, &generation) && !next_field(&cursor, 960, &run_id)
    && !next_field(&cursor, 4, &step) && !next_field(&cursor, 4, &total)
    && !next_field(&cursor, 64, &previous)
    && !next_field(&cursor, 64, &ignored) /* requestId */
    && !next_field(&cursor, 64, &ignored) /* requestHash */
    && !next_field(&cursor, 64, &policy)
    && !next_field(&cursor, 64, &ignored) /* broker instance */
    && !next_field(&cursor, 64, &ignored) /* boot identity */
    && !next_field(&cursor, 64, &ignored) /* deployment policy */
    && !next_field(&cursor, 24, &state);
  char step_text[8], total_text[8];
  snprintf(step_text, sizeof(step_text), "%u", request->step_index - 1U);
  snprintf(total_text, sizeof(total_text), "%u", request->total_steps);
  valid = valid && generation.n == 64 && !memcmp(generation.p, request->previous_generation, 64)
    && run_id.n == strlen(request->run_id) && !memcmp(run_id.p, request->run_id, run_id.n)
    && step.n == strlen(step_text) && !memcmp(step.p, step_text, step.n)
    && total.n == strlen(total_text) && !memcmp(total.p, total_text, total.n)
    && policy.n == 64 && !memcmp(policy.p, request->policy_hash, 64)
    && state.n == 9 && !memcmp(state.p, "SUCCEEDED", 9);
  free(packet.p);
  return valid ? 1 : -1;
}
struct retention_ack {
  char generation[65], result_hash[65], artifact_manifest_hash[65], acknowledgement_hash[65];
};
static int parse_retention_ack(const unsigned char *packet, size_t size, struct retention_ack *ack) {
  if (!packet || size < 8 || memcmp(packet, MAGIC_ACK, 8)) return -1;
  struct cursor cursor = { packet, size, 8 };
  struct bytes generation, result_hash, artifact_hash;
  if (next_field(&cursor, 64, &generation) || next_field(&cursor, 64, &result_hash)
      || next_field(&cursor, 64, &artifact_hash) || cursor.o != cursor.n
      || generation.n != 64 || result_hash.n != 64 || (artifact_hash.n != 0 && artifact_hash.n != 64)) return -1;
  memcpy(ack->generation, generation.p, 64); ack->generation[64] = 0;
  memcpy(ack->result_hash, result_hash.p, 64); ack->result_hash[64] = 0;
  if (artifact_hash.n) memcpy(ack->artifact_manifest_hash, artifact_hash.p, 64);
  ack->artifact_manifest_hash[artifact_hash.n] = 0;
  if (!hex64(ack->generation) || !hex64(ack->result_hash)
      || (artifact_hash.n && !hex64(ack->artifact_manifest_hash))) return -1;
  sha_hex(packet, size, ack->acknowledgement_hash);
  return 0;
}
static int result_is_acknowledgeable(const struct retention_ack *ack) {
  char name[96];
  if (snprintf(name, sizeof(name), "result-%s.bin", ack->generation) >= (int) sizeof(name)) return -1;
  struct bytes packet = read_trusted_at(results_fd, name, BROKER_UID, MAX_PACKET);
  if (!packet.p) return -1;
  char digest[65]; sha_hex(packet.p, packet.n, digest);
  struct cursor cursor = { packet.p, packet.n, 8 };
  struct bytes fields[52]; memset(fields, 0, sizeof(fields));
  int valid = packet.n >= 8 && !memcmp(packet.p, MAGIC_RESULT, 8) && !strcmp(digest, ack->result_hash);
  for (unsigned index = 0; valid && index < 52; index++) {
    if (next_field(&cursor, MAX_PACKET, &fields[index])) valid = 0;
  }
  valid = valid && cursor.o == cursor.n && fields[0].n == 64
    && !memcmp(fields[0].p, ack->generation, 64)
    && ((fields[11].n == 9 && !memcmp(fields[11].p, "SUCCEEDED", 9))
      || (fields[11].n == 6 && !memcmp(fields[11].p, "FAILED", 6))
      || (fields[11].n == 9 && !memcmp(fields[11].p, "CANCELLED", 9))
      || (fields[11].n == 11 && !memcmp(fields[11].p, "INTERRUPTED", 11)))
    && ((fields[13].n == 6 && !memcmp(fields[13].p, "reaped", 6))
      || (fields[13].n == 23 && !memcmp(fields[13].p, "child_reaped_unmeasured", 23))
      || (fields[13].n == 13 && !memcmp(fields[13].p, "never_started", 13)))
    && fields[48].n == strlen(ack->artifact_manifest_hash)
    && !memcmp(fields[48].p, ack->artifact_manifest_hash, fields[48].n);
  if (valid && ack->artifact_manifest_hash[0]) {
    char manifest_name[128];
    snprintf(manifest_name, sizeof(manifest_name), "artifacts-%s.json", ack->generation);
    struct bytes manifest = read_trusted_at(results_fd, manifest_name, BROKER_UID, MAX_ARTIFACT_MANIFEST_BYTES);
    char manifest_hash[65];
    if (!manifest.p) valid = 0;
    else {
      sha_hex(manifest.p, manifest.n, manifest_hash);
      if (strcmp(manifest_hash, ack->artifact_manifest_hash)) valid = 0;
      free(manifest.p);
    }
  }
  free(packet.p);
  return valid ? 1 : -1;
}
static int unlink_owned_optional(int dir, const char *name, uid_t owner, gid_t group, mode_t mode) {
  int fd = openat(dir, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return errno == ENOENT ? 0 : -1;
  struct stat before, after;
  if (fstat(fd, &before) < 0 || !S_ISREG(before.st_mode) || before.st_uid != owner
      || before.st_gid != group || before.st_nlink != 1 || (before.st_mode & 07777) != mode
      || unlinkat(dir, name, 0) < 0 || fsync(dir) < 0 || fstat(fd, &after) < 0
      || before.st_dev != after.st_dev || before.st_ino != after.st_ino || after.st_nlink != 0) {
    close(fd); return -1;
  }
  return close(fd);
}
static int owned_regular_state(int dir, const char *name, uid_t owner, gid_t group, mode_t mode) {
  struct stat metadata;
  if (fstatat(dir, name, &metadata, AT_SYMLINK_NOFOLLOW) < 0) {
    return errno == ENOENT ? 0 : -1;
  }
  return S_ISREG(metadata.st_mode) && metadata.st_uid == owner && metadata.st_gid == group
    && metadata.st_nlink == 1 && (metadata.st_mode & 07777) == mode ? 1 : -1;
}
static int generation_has_ready_reference(const char *generation) {
  char name[160];
  const char *request_prefixes[] = { "request", "ack", "cancel" };
  for (unsigned index = 0; index < sizeof(request_prefixes) / sizeof(request_prefixes[0]); index++) {
    snprintf(name, sizeof(name), "%s-%s.bin", request_prefixes[index], generation);
    int state = owned_regular_state(requests_fd, name, CONTROLLER_UID, SPOOL_GID, 0640);
    if (state) return state;
  }
  const char *state_prefixes[] = { "accepted", "started" };
  const char *state_suffixes[] = { ".bin", ".txt" };
  for (unsigned index = 0; index < 2U; index++) {
    snprintf(name, sizeof(name), "%s-%s%s", state_prefixes[index], generation, state_suffixes[index]);
    int state = owned_regular_state(state_fd, name, BROKER_UID, BROKER_UID, 0600);
    if (state) return state;
  }
  const char *result_prefixes[] = { "result", "pruned", "artifacts", "stdout", "stderr" };
  const char *result_suffixes[] = { ".bin", ".bin", ".json", ".log", ".log" };
  for (unsigned index = 0; index < 5U; index++) {
    snprintf(name, sizeof(name), "%s-%s%s", result_prefixes[index], generation, result_suffixes[index]);
    int state = owned_regular_state(results_fd, name, BROKER_UID, SPOOL_GID, 0640);
    if (state) return state;
  }
  for (unsigned index = 0; index < MAX_ARTIFACTS; index++) {
    snprintf(name, sizeof(name), "artifact-%s-%u.bin", generation, index);
    int state = owned_regular_state(results_fd, name, BROKER_UID, SPOOL_GID, 0640);
    if (state) return state;
  }
  /* The ready record and retained runtime are both derived from one admitted payload. They must
     never keep each other alive after all independent request/state/result evidence is gone.
     Every in-flight or unresolved generation retains request + accepted/started evidence; every
     verified terminal generation retains its result/prune/artifact evidence until acknowledgement. */
  return 0;
}
static void cleanup_orphan_ready_records(void) {
  int scan = fresh_directory_scan_fd(state_fd);
  DIR *directory = fdopendir(scan);
  if (!directory) fatal("ready-record cleanup scan unavailable");
  unsigned count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (++count > MAX_SCAN_FILES) fatal("broker state exceeds file bound during ready cleanup");
    if (strncmp(entry->d_name, "ready-", 6)) continue;
    size_t length = strlen(entry->d_name);
    if (length != 6 + 64 + 4 || strcmp(entry->d_name + length - 4, ".txt")) {
      fatal("broker state has an invalid ready filename");
    }
    char generation[65];
    memcpy(generation, entry->d_name + 6, 64); generation[64] = 0;
    if (!hex64(generation)) fatal("broker state has an invalid ready generation");
    int referenced = generation_has_ready_reference(generation);
    if (referenced < 0) fatal("ready-record lineage reference is invalid");
    if (!referenced
        && unlink_owned_optional(state_fd, entry->d_name, BROKER_UID, BROKER_UID, 0600) < 0) {
      fatal("orphan ready-record cleanup failed closed");
    }
  }
  if (closedir(directory) < 0) fatal("ready-record cleanup scan close failed");
}
static int cleanup_acknowledged_generation(const struct retention_ack *ack) {
  char name[160];
  /* Runtime bytes are removed while durable spool evidence still references the lineage. A
     crash can therefore only cause replay, never turn unresolved or artifact-bound state into
     an apparent orphan that the generic sweep is permitted to erase. */
  if (cleanup_generation_runtime(ack->generation) < 0) return -1;
  for (unsigned index = 0; index < MAX_ARTIFACTS; index++) {
    snprintf(name, sizeof(name), "artifact-%s-%u.bin", ack->generation, index);
    if (unlink_owned_optional(results_fd, name, BROKER_UID, SPOOL_GID, 0640) < 0) return -1;
  }
  const char *result_prefixes[] = { "artifacts", "stdout", "stderr", "result" };
  const char *result_suffixes[] = { ".json", ".log", ".log", ".bin" };
  for (unsigned index = 0; index < 4; index++) {
    snprintf(name, sizeof(name), "%s-%s%s", result_prefixes[index], ack->generation, result_suffixes[index]);
    if (unlink_owned_optional(results_fd, name, BROKER_UID, SPOOL_GID, 0640) < 0) return -1;
  }
  const char *state_prefixes[] = { "accepted", "started", "ready" };
  const char *state_suffixes[] = { ".bin", ".txt", ".txt" };
  for (unsigned index = 0; index < 3U; index++) {
    snprintf(name, sizeof(name), "%s-%s%s", state_prefixes[index], ack->generation,
      state_suffixes[index]);
    if (unlink_owned_optional(state_fd, name, BROKER_UID, BROKER_UID, 0600) < 0) return -1;
  }
  return 0;
}
static int publish_prune_receipt(const struct retention_ack *ack) {
  char name[96]; snprintf(name, sizeof(name), "pruned-%s.bin", ack->generation);
  struct bytes packet = { (unsigned char *) strdup(MAGIC_PRUNE), 8 };
  if (!packet.p) return -1;
  add_text(&packet, ack->generation); add_text(&packet, ack->acknowledgement_hash);
  add_text(&packet, ack->result_hash); add_text(&packet, ack->artifact_manifest_hash);
  int result = durable_at(results_fd, name, packet.p, packet.n);
  free(packet.p); return result < 0 ? -1 : 0;
}
static int parse_prune_receipt(const unsigned char *packet, size_t size, struct retention_ack *ack);
static int process_ack_file(const char *name) {
  size_t length = strlen(name);
  if (length != 4 + 64 + 4 || strncmp(name, "ack-", 4)
      || strcmp(name + length - 4, ".bin")) return 0;
  char generation[65]; memcpy(generation, name + 4, 64); generation[64] = 0;
  if (!hex64(generation)) return -1;
  struct bytes packet = read_trusted_at(requests_fd, name, CONTROLLER_UID, 1024);
  struct retention_ack ack;
  if (!packet.p || parse_retention_ack(packet.p, packet.n, &ack)
      || strcmp(ack.generation, generation)) { free(packet.p); return -1; }
  free(packet.p);
  char receipt_name[96]; snprintf(receipt_name, sizeof(receipt_name), "pruned-%s.bin", generation);
  if (faccessat(results_fd, receipt_name, F_OK, AT_EACCESS) == 0) {
    struct bytes receipt = read_trusted_at(results_fd, receipt_name, BROKER_UID, 1024);
    struct retention_ack recorded;
    if (!receipt.p || parse_prune_receipt(receipt.p, receipt.n, &recorded)
        || strcmp(recorded.generation, ack.generation)
        || strcmp(recorded.acknowledgement_hash, ack.acknowledgement_hash)
        || strcmp(recorded.result_hash, ack.result_hash)
        || strcmp(recorded.artifact_manifest_hash, ack.artifact_manifest_hash)) {
      free(receipt.p); return -1;
    }
    free(receipt.p);
  } else {
    if (errno != ENOENT || result_is_acknowledgeable(&ack) <= 0 || publish_prune_receipt(&ack) < 0) return -1;
  }
  return cleanup_acknowledged_generation(&ack);
}
static int parse_prune_receipt(const unsigned char *packet, size_t size, struct retention_ack *ack) {
  if (!packet || size < 8 || memcmp(packet, MAGIC_PRUNE, 8)) return -1;
  struct cursor cursor = { packet, size, 8 };
  struct bytes generation, acknowledgement_hash, result_hash, artifact_hash;
  if (next_field(&cursor, 64, &generation) || next_field(&cursor, 64, &acknowledgement_hash)
      || next_field(&cursor, 64, &result_hash) || next_field(&cursor, 64, &artifact_hash)
      || cursor.o != cursor.n || generation.n != 64 || acknowledgement_hash.n != 64
      || result_hash.n != 64 || (artifact_hash.n != 0 && artifact_hash.n != 64)) return -1;
  memcpy(ack->generation, generation.p, 64); ack->generation[64] = 0;
  memcpy(ack->acknowledgement_hash, acknowledgement_hash.p, 64); ack->acknowledgement_hash[64] = 0;
  memcpy(ack->result_hash, result_hash.p, 64); ack->result_hash[64] = 0;
  if (artifact_hash.n) memcpy(ack->artifact_manifest_hash, artifact_hash.p, 64);
  ack->artifact_manifest_hash[artifact_hash.n] = 0;
  return hex64(ack->generation) && hex64(ack->acknowledgement_hash) && hex64(ack->result_hash)
    && (!artifact_hash.n || hex64(ack->artifact_manifest_hash)) ? 0 : -1;
}
static int generation_is_pruned(const char *generation) {
  char receipt_name[96];
  if (snprintf(receipt_name, sizeof(receipt_name), "pruned-%s.bin", generation) >= (int) sizeof(receipt_name)) {
    return -1;
  }
  struct bytes packet = read_trusted_at(results_fd, receipt_name, BROKER_UID, 1024);
  if (!packet.p) return errno == ENOENT ? 0 : -1;
  struct retention_ack receipt;
  int valid = !parse_prune_receipt(packet.p, packet.n, &receipt)
    && !strcmp(receipt.generation, generation);
  free(packet.p);
  return valid ? 1 : -1;
}
static void cleanup_consumed_prune_receipts(void) {
  int scan = fresh_directory_scan_fd(results_fd); DIR *directory = fdopendir(scan);
  if (!directory) fatal("prune-receipt scan unavailable");
  unsigned count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (++count > MAX_SCAN_FILES) fatal("result spool exceeds absolute file bound");
    size_t length = strlen(entry->d_name);
    if (length != 7 + 64 + 4 || strncmp(entry->d_name, "pruned-", 7)
        || strcmp(entry->d_name + length - 4, ".bin")) continue;
    char generation[65], ack_name[96], request_name[96];
    memcpy(generation, entry->d_name + 7, 64); generation[64] = 0;
    if (!hex64(generation)) fatal("prune receipt has an invalid generation filename");
    snprintf(ack_name, sizeof(ack_name), "ack-%s.bin", generation);
    if (faccessat(requests_fd, ack_name, F_OK, AT_EACCESS) == 0) continue;
    if (errno != ENOENT) fatal("prune acknowledgement state is unavailable");
    /* The controller durably removes requests before acknowledgements. Keep the broker-owned
       receipt as an admission tombstone if an interrupted or nonconforming cleanup leaves the
       request behind; otherwise a pruned first generation could replay and a later generation
       could fail closed after its predecessor result had already been removed. */
    snprintf(request_name, sizeof(request_name), "request-%s.bin", generation);
    if (faccessat(requests_fd, request_name, F_OK, AT_EACCESS) == 0) continue;
    if (errno != ENOENT) fatal("pruned request state is unavailable");
    struct bytes packet = read_trusted_at(results_fd, entry->d_name, BROKER_UID, 1024);
    struct retention_ack ack;
    if (!packet.p || parse_prune_receipt(packet.p, packet.n, &ack)
        || strcmp(ack.generation, generation)) { free(packet.p); fatal("prune receipt is invalid"); }
    free(packet.p);
    if (cleanup_acknowledged_generation(&ack) < 0
        || unlink_owned_optional(results_fd, entry->d_name, BROKER_UID, SPOOL_GID, 0640) < 0) {
      fatal("consumed prune receipt cleanup failed");
    }
  }
  if (closedir(directory) < 0) fatal("prune-receipt scan close failed");
}
static unsigned retained_generation_count(void) {
  int scan = fresh_directory_scan_fd(state_fd); DIR *directory = fdopendir(scan);
  if (!directory) fatal("retention state scan unavailable");
  unsigned files = 0, retained = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (++files > MAX_SCAN_FILES) fatal("retention state exceeds absolute file bound");
    if (!strncmp(entry->d_name, "accepted-", 9)) retained++;
  }
  if (closedir(directory) < 0) fatal("retention state scan close failed");
  return retained;
}
static void process_retention_acks(void) {
  int scan = fresh_directory_scan_fd(requests_fd); DIR *directory = fdopendir(scan);
  if (!directory) fatal("retention acknowledgement scan unavailable");
  unsigned count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (++count > MAX_SCAN_FILES) fatal("request spool exceeds absolute file bound");
    if (!strncmp(entry->d_name, "ack-", 4) && process_ack_file(entry->d_name) < 0) {
      fatal("retention acknowledgement failed closed");
    }
  }
  if (closedir(directory) < 0) fatal("retention acknowledgement scan close failed");
}
struct cancellation_observation { int state; char hash[65]; };
static struct cancellation_observation observe_cancellation(const char *generation) {
  struct cancellation_observation observation = { 0 };
  char name[96]; snprintf(name, sizeof(name), "cancel-%s.bin", generation);
  struct bytes packet = read_trusted_at(requests_fd, name, CONTROLLER_UID, 65536);
  if (!packet.p) { observation.state = errno == ENOENT ? 0 : -1; return observation; }
  struct cursor cursor = { packet.p, packet.n, 8 };
  struct bytes encoded_generation, mode, reason;
  int valid = packet.n >= 8 && !memcmp(packet.p, MAGIC_CANCEL, 8)
    && !next_field(&cursor, 64, &encoded_generation) && !next_field(&cursor, 16, &mode)
    && !next_field(&cursor, 4000, &reason) && cursor.o == cursor.n
    && encoded_generation.n == 64 && !memcmp(encoded_generation.p, generation, 64)
    && mode.n == 9 && !memcmp(mode.p, "immediate", 9);
  if (valid) {
    for (size_t i = 0; i < reason.n; i++) if (reason.p[i] < 0x20 || reason.p[i] == 0x7f) valid = 0;
  }
  if (valid) sha_hex(packet.p, packet.n, observation.hash);
  free(packet.p); observation.state = valid ? 1 : -1; return observation;
}
static int open_log_pipe(int pipefd[2]) {
  if (pipe2(pipefd, O_CLOEXEC) < 0) return -1;
  int flags = fcntl(pipefd[0], F_GETFL, 0);
  if (flags < 0 || fcntl(pipefd[0], F_SETFL, flags | O_NONBLOCK) < 0) {
    int saved = errno; close(pipefd[0]); close(pipefd[1]); errno = saved; return -1;
  }
  return 0;
}
static int drain_fd(int fd, unsigned char **buffer, size_t *used, int *open_flag,
    size_t stream_limit, size_t total_limit, size_t other_used, int *truncated) {
  unsigned char temporary[65536];
  for (;;) {
    ssize_t count = read(fd, temporary, sizeof(temporary));
    if (count > 0) {
      size_t keep = (size_t) count;
      size_t stream_left = stream_limit > *used ? stream_limit - *used : 0;
      size_t total_used = *used + other_used;
      size_t total_left = total_limit > total_used ? total_limit - total_used : 0;
      if (keep > stream_left) keep = stream_left;
      if (keep > total_left) keep = total_left;
      if (keep < (size_t) count) *truncated = 1;
      if (keep) {
        unsigned char *next = realloc(*buffer, *used + keep);
        if (!next) fatal("log allocation failed");
        *buffer = next; memcpy(*buffer + *used, temporary, keep); *used += keep;
      }
      continue;
    }
    if (!count) { close(fd); *open_flag = 0; }
    else if (errno != EAGAIN && errno != EINTR) { close(fd); *open_flag = 0; }
    break;
  }
  return *truncated;
}
static uint64_t monotonic_millis(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) < 0) fatal("monotonic clock failed");
  return (uint64_t) value.tv_sec * 1000U + (uint64_t) value.tv_nsec / 1000000U;
}

static int kill_pidfd(int pidfd) {
  if (pidfd < 0) return -1;
  if (syscall(SYS_pidfd_send_signal, pidfd, SIGKILL, NULL, 0) == 0) return 1;
  return errno == ESRCH ? 2 : -1;
}

/* Return 1 only when this exact event successfully linearized by signalling the live child.
   ESRCH means the child completed first; callers must retain ordinary completion semantics. */
static int linearize_termination(int pidfd, const char *candidate, char reason[32], int *outcome) {
  int result = kill_pidfd(pidfd);
  *outcome = result;
  if (result == 1) {
    snprintf(reason, 32, "%s", candidate);
    return 1;
  }
  if (result < 0) snprintf(reason, 32, "%s", "kill_failed");
  return result;
}

static int execute_request(struct request *r) {
  if (strcmp(r->policy_hash, deployment_policy_hash)) {
    return publish_without_payload(r, "FAILED", "deployment policy digest mismatch");
  }
  char guard_path[256];
  if (!reviewed_project(r->project, r->project_quota_id) || guard_path_for(r, guard_path)) {
    return publish_without_payload(r, "FAILED", "project identity is not in the reviewed static broker map");
  }
  /* Repeat both root-content checks immediately before opening the selected subtrees. Unknown
     siblings or a leftover active runtime stop admission before any payload process exists. */
  verify_workspace_root_layout();
  verify_runtime_root_layout(0);
  struct stat ws;
  if (fstat(workspace_fd, &ws) < 0) {
    return publish_without_payload(r, "FAILED", "workspace identity unavailable");
  }
  char dev[32], ino[32];
  snprintf(dev, sizeof(dev), "%llu", (unsigned long long) ws.st_dev);
  snprintf(ino, sizeof(ino), "%llu", (unsigned long long) ws.st_ino);
  if (strcmp(dev, r->workspace_dev) || strcmp(ino, r->workspace_ino)) {
    return publish_without_payload(r, "FAILED", "workspace identity mismatch");
  }
  struct cancellation_observation before_launch_cancel = observe_cancellation(r->generation);
  if (before_launch_cancel.state < 0) {
    return publish_without_payload_reason(r, "FAILED", "cancellation envelope validation failed",
      "cancel_invalid", NULL);
  }
  if (before_launch_cancel.state > 0) {
    return publish_without_payload_reason(r, "CANCELLED", "cancelled before payload start",
      "cancel", before_launch_cancel.hash);
  }
  int project = -1;
  if (open_workspace_project(r->project, &project) < 0) {
    return publish_without_payload(r, "FAILED", "dedicated project DAC wrapper refused");
  }
  struct stat project_metadata;
  struct fsxattr project_attributes;
  memset(&project_attributes, 0, sizeof(project_attributes));
  if (fstat(project, &project_metadata) < 0 || !S_ISDIR(project_metadata.st_mode)
      || project_metadata.st_uid != BROKER_UID || project_metadata.st_gid != BROKER_UID
      || (project_metadata.st_mode & 07777) != 0700 || project_metadata.st_dev != ws.st_dev
      || ioctl(project, FS_IOC_FSGETXATTR, &project_attributes) < 0
      || project_attributes.fsx_projid != r->project_quota_id
      || !(project_attributes.fsx_xflags & FS_XFLAG_PROJINHERIT)) {
    close(project);
    close_workspace_project_or_fatal(r->project);
    return publish_without_payload(r, "FAILED", "dedicated project quota identity refused");
  }
  int cwd = open_beneath(project, r->cwd, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (cwd < 0) {
    close(project); close_workspace_project_or_fatal(r->project);
    return publish_without_payload(r, "FAILED", "cwd refused");
  }
  if (mkdirat(runtime_active_fd, r->project, 0700) < 0 || fsync(runtime_active_fd) < 0) {
    close(project); close(cwd); close_workspace_project_or_fatal(r->project); return -1;
  }
  int generation_runtime = open_beneath(runtime_active_fd, r->project,
    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (generation_runtime < 0) {
    close(project); close(cwd); close_workspace_project_or_fatal(r->project); return -1;
  }
  const char *runtime_directories[] = { "tmp", "config", "cache", "data" };
  for (unsigned i = 0; i < sizeof(runtime_directories) / sizeof(runtime_directories[0]); i++) {
    if (mkdirat(generation_runtime, runtime_directories[i], 0700) < 0) {
      close(project); close(cwd); close(generation_runtime);
      close_workspace_project_or_fatal(r->project); return -1;
    }
  }
  if (fsync(generation_runtime) < 0) {
    close(project); close(cwd); close(generation_runtime);
    close_workspace_project_or_fatal(r->project); return -1;
  }

  int outp[2], errp[2], syncp[2], readyp[2], gop[2];
  if (open_log_pipe(outp) || open_log_pipe(errp) || pipe2(syncp, O_CLOEXEC)
      || pipe2(readyp, O_CLOEXEC) || pipe2(gop, O_CLOEXEC)) {
    close(project); close(cwd); close(generation_runtime);
    close_workspace_project_or_fatal(r->project); return -1;
  }
  unsigned char nonce_random[32]; char nonce[65];
  if (syscall(SYS_getrandom, nonce_random, sizeof(nonce_random), 0) != (ssize_t) sizeof(nonce_random)) {
    close(project); close(cwd); close(generation_runtime);
    close_workspace_project_or_fatal(r->project); return -1;
  }
  sha_hex(nonce_random, sizeof(nonce_random), nonce);
  /* Use the one reviewed ABI directly; libc fork may add implementation-specific clone flags. */
  pid_t pid = (pid_t) syscall(SYS_clone, SIGCHLD, 0, NULL, NULL, 0);
  if (pid < 0) {
    close(project); close(cwd); close(generation_runtime);
    close_workspace_project_or_fatal(r->project); return -1;
  }
  if (pid == 0) {
    close(outp[0]); close(errp[0]); close(syncp[1]); close(readyp[0]); close(gop[1]);
    struct sigaction default_pipe;
    memset(&default_pipe, 0, sizeof(default_pipe)); default_pipe.sa_handler = SIG_DFL;
    if (sigemptyset(&default_pipe.sa_mask) < 0
        || sigaction(SIGPIPE, &default_pipe, NULL) < 0) _exit(78);
    pid_t parent = getppid();
    if (parent != 1 || prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) < 0 || getppid() != 1) _exit(78);
    char gate = 0;
    ssize_t gate_count;
    do { gate_count = read(syncp[0], &gate, 1); } while (gate_count < 0 && errno == EINTR);
    close(syncp[0]);
    if (gate_count != 1 || gate != '1' || getppid() != parent) _exit(78);
    int nullfd = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (nullfd < 0 || dup2(nullfd, 0) < 0 || dup2(outp[1], 1) < 0 || dup2(errp[1], 2) < 0
        || dup2(project, 3) < 0 || dup2(generation_runtime, 4) < 0 || dup2(cwd, 5) < 0
        || dup2(node_filter_fd, 6) < 0 || dup2(godot_filter_fd, 7) < 0
        || dup2(readyp[1], 8) < 0 || dup2(gop[0], 9) < 0) _exit(78);
    char **av = calloc(r->argc + 29U, sizeof(char *));
    if (!av) _exit(78);
    unsigned a = 0;
    av[a++] = "launch-broker"; av[a++] = "--program"; av[a++] = r->program;
    av[a++] = "--workspace-fd"; av[a++] = "3"; av[a++] = "--runtime-fd"; av[a++] = "4";
    av[a++] = "--cwd-fd"; av[a++] = "5"; av[a++] = "--node-seccomp-fd"; av[a++] = "6";
    av[a++] = "--godot-seccomp-fd"; av[a++] = "7"; av[a++] = "--cwd-relative";
    av[a++] = r->cwd; av[a++] = "--guard-path"; av[a++] = guard_path;
    av[a++] = "--project"; av[a++] = r->project;
    av[a++] = "--generation"; av[a++] = r->generation;
    av[a++] = "--nonce"; av[a++] = nonce; av[a++] = "--ready-fd"; av[a++] = "8";
    av[a++] = "--go-fd"; av[a++] = "9"; av[a++] = "--";
    for (unsigned i = 0; i < r->argc; i++) av[a++] = r->argv[i];
    av[a] = NULL;
    payload_launch_entry((int) a, av);
    _exit(78);
  }

  close(outp[1]); close(errp[1]); close(syncp[0]); close(project); close(cwd);
  close(generation_runtime); close(readyp[1]); close(gop[0]);
  int pidfd = (int) syscall(SYS_pidfd_open, pid, 0);
  unsigned long long start = starttime_for(pid);
  if (pidfd < 0 || !start) {
    close(syncp[1]); close(readyp[0]); close(gop[1]);
    if (pidfd >= 0) { (void) kill_pidfd(pidfd); close(pidfd); waitpid(pid, NULL, 0); }
    else {
      close_workspace_project_or_fatal(r->project);
      fatal("pidfd_open failed; broker PID-namespace teardown is required");
    }
    close_workspace_project_or_fatal(r->project);
    return -1;
  }
  char started_name[96], started[160];
  snprintf(started_name, sizeof(started_name), "started-%s.txt", r->generation);
  int sn = snprintf(started, sizeof(started), "%ld %llu\n", (long) pid, start);
  if (sn <= 0 || (size_t) sn >= sizeof(started) || durable_state(started_name, started, (size_t) sn) < 0) {
    kill_pidfd(pidfd); close(syncp[1]); close(readyp[0]); close(gop[1]);
    waitpid(pid, NULL, 0); close(pidfd); close_workspace_project_or_fatal(r->project); return -1;
  }
  if (write_all(syncp[1], "1", 1) < 0) kill_pidfd(pidfd);
  close(syncp[1]);

  unsigned char expected_ready[72], actual_ready[72];
  memcpy(expected_ready, "DGFGRD01", 8);
  if (!hex_to_bytes(r->generation, expected_ready + 8) || !hex_to_bytes(nonce, expected_ready + 40)) {
    kill_pidfd(pidfd); close(readyp[0]); close(gop[1]); waitpid(pid, NULL, 0); close(pidfd);
    close_workspace_project_or_fatal(r->project); return -1;
  }
  size_t ready_used = 0;
  uint64_t guard_deadline = monotonic_millis() + 10000U;
  while (ready_used < sizeof(actual_ready) && monotonic_millis() < guard_deadline) {
    struct pollfd guard_poll[2] = { { readyp[0], POLLIN | POLLHUP, 0 }, { pidfd, POLLIN, 0 } };
    int polled = poll(guard_poll, 2, 50);
    if (polled < 0 && errno == EINTR) continue;
    if (polled < 0 || (guard_poll[1].revents & POLLIN)) break;
    if (guard_poll[0].revents & (POLLIN | POLLHUP)) {
      ssize_t count = read(readyp[0], actual_ready + ready_used, sizeof(actual_ready) - ready_used);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) break;
      ready_used += (size_t) count;
    }
  }
  close(readyp[0]);
  struct payload_measurement measurement;
  memset(&measurement, 0, sizeof(measurement));
  int measured = ready_used == sizeof(actual_ready)
    && !memcmp(actual_ready, expected_ready, sizeof(actual_ready))
    && guard_executable_and_cgroup_measured(pid, start, guard_path)
    && payload_measured(pid, start, r, &measurement);
  char ready_name[96], ready_record[1024];
  snprintf(ready_name, sizeof(ready_name), "ready-%s.txt", r->generation);
  int ready_length = snprintf(ready_record, sizeof(ready_record),
    "generation=%s\nnonce=%s\nbrokerInstance=%s\npid=%ld\nstarttime=%llu\nlabel=%s\nnnp=%d\nseccompFilters=%d\ncapsZero=%d\n",
    r->generation, nonce, broker_instance, (long) pid, start, measurement.label,
    measurement.no_new_privs, measurement.seccomp_filters, measurement.caps_zero);
  int guard_failed = !measured || ready_length <= 0 || (size_t) ready_length >= sizeof(ready_record);
  char termination_reason[32] = { 0 };
  int kill_result = 0;
  uint64_t kill_failure_deadline = 0;
  if (termination_requested) guard_failed = 1;
  if (guard_failed
      || durable_state(ready_name, ready_record, (size_t) ready_length) < 0
      || write_all(gop[1], "G", 1) < 0) {
    guard_failed = 1;
    int guard_outcome = linearize_termination(pidfd, "guard_failed", termination_reason, &kill_result);
    if (guard_outcome == 2) snprintf(termination_reason, sizeof(termination_reason), "%s", "guard_failed");
    if (guard_outcome < 0) kill_failure_deadline = monotonic_millis() + 5000U;
  }
  close(gop[1]);

  unsigned char *out = NULL, *err = NULL;
  size_t outn = 0, errn = 0;
  int oo = 1, eo = 1, output_overrun = 0;
  char cancel_hash[65] = { 0 };
  int stdout_truncated = 0, stderr_truncated = 0;
  uint64_t deadline = monotonic_millis() + r->timeout_ms;
  for (;;) {
    struct pollfd fds[3] = {
      { outp[0], POLLIN | POLLHUP, 0 }, { errp[0], POLLIN | POLLHUP, 0 }, { pidfd, POLLIN, 0 },
    };
    int poll_result = poll(fds, 3, 50);
    if (poll_result < 0 && errno == EINTR) continue;
    if (oo && (fds[0].revents & (POLLIN | POLLHUP))) {
      if (drain_fd(outp[0], &out, &outn, &oo, r->stdout_limit, r->total_log_limit,
          errn, &stdout_truncated)) output_overrun = 1;
    }
    if (eo && (fds[1].revents & (POLLIN | POLLHUP))) {
      if (drain_fd(errp[0], &err, &errn, &eo, r->stderr_limit, r->total_log_limit,
          outn, &stderr_truncated)) output_overrun = 1;
    }
    /* pidfd readiness is checked before observing any new termination request. A late cancel,
       timeout, output cap, or shutdown can never relabel an already-completed payload. */
    if (poll_result >= 0 && (fds[2].revents & (POLLIN | POLLHUP))) break;
    if (!termination_reason[0]) {
      const char *candidate = NULL;
      struct cancellation_observation cancellation = { 0 };
      if (poll_result < 0) candidate = "poll_fault";
      else if (output_overrun) candidate = "output_limit";
      else if (termination_requested) candidate = "broker_shutdown";
      else {
        cancellation = observe_cancellation(r->generation);
        if (cancellation.state < 0) candidate = "cancel_invalid";
        else if (cancellation.state > 0) candidate = "cancel";
        else if (monotonic_millis() >= deadline) candidate = "timeout";
      }
      if (candidate) {
        int linearized = linearize_termination(pidfd, candidate, termination_reason, &kill_result);
        if (linearized == 2) { termination_reason[0] = 0; kill_result = 0; break; }
        if (linearized == 1 && !strcmp(candidate, "cancel")) {
          snprintf(cancel_hash, sizeof(cancel_hash), "%s", cancellation.hash);
        }
        if (linearized < 0) kill_failure_deadline = monotonic_millis() + 5000U;
      }
    }
    if (kill_failure_deadline && monotonic_millis() >= kill_failure_deadline) {
      close_workspace_project_or_fatal(r->project);
      fatal("pidfd termination failed while a payload remained live");
    }
  }

  siginfo_t info;
  memset(&info, 0, sizeof(info));
  if (waitid(P_PIDFD, (id_t) pidfd, &info, WEXITED | WNOWAIT) < 0
      || info.si_pid != pid || info.si_code == 0) {
    free(out); free(err); close(pidfd); close_workspace_project_or_fatal(r->project); return -1;
  }
  int status = 0;
  if (waitpid(pid, &status, 0) != pid) {
    free(out); free(err); close(pidfd); close_workspace_project_or_fatal(r->project); return -1;
  }
  int wait_matches = (info.si_code == CLD_EXITED && WIFEXITED(status)
      && info.si_status == WEXITSTATUS(status))
    || ((info.si_code == CLD_KILLED || info.si_code == CLD_DUMPED)
      && WIFSIGNALED(status) && info.si_status == WTERMSIG(status));
  if (!wait_matches) {
    free(out); free(err); close(pidfd); close_workspace_project_or_fatal(r->project); return -1;
  }
  close(pidfd);
  while (oo) drain_fd(outp[0], &out, &outn, &oo, r->stdout_limit,
    r->total_log_limit, errn, &stdout_truncated);
  while (eo) drain_fd(errp[0], &err, &errn, &eo, r->stderr_limit,
    r->total_log_limit, outn, &stderr_truncated);

  /* Exact reap is the linearization point for revoking path traversal. The broker retains only
     its inode-bound project descriptor for the bounded artifact ferry below. */
  close_workspace_project_or_fatal(r->project);

  /* Only a broker that obtained exact death proof may make this runtime inaccessible to all
     future payload profiles. The rename and directory fsyncs are replay-safe across crashes. */
  if (retain_active_runtime(r->project, r->generation, 0) < 0) {
    free(out); free(err); return -1;
  }

  struct result_evidence evidence;
  empty_evidence(&evidence);
  if (measured) {
    char final_label[256];
    int final_length = snprintf(final_label, sizeof(final_label),
      "dominion-gx10-gamefactory-broker//&dominion-gx10-guard-%s-%s//&dominion-gx10-payload-%s-%s (enforce)",
      r->program, r->project, r->program, r->project);
    if (final_length <= 0 || (size_t) final_length >= sizeof(final_label)) {
      free(out); free(err); return -1;
    }
    snprintf(evidence.measured_guard_label, sizeof(evidence.measured_guard_label), "%s", measurement.label);
    snprintf(evidence.expected_final_label, sizeof(evidence.expected_final_label), "%s", final_label);
    evidence.final_transition_attested = 1;
    evidence.no_new_privs = measurement.no_new_privs;
    evidence.seccomp_filters = measurement.seccomp_filters;
    evidence.caps_zero = measurement.caps_zero;
  }
  evidence.wait_pid = info.si_pid;
  evidence.wait_code = info.si_code;
  evidence.wait_status = info.si_status;
  snprintf(evidence.cancel_hash, sizeof(evidence.cancel_hash), "%s", cancel_hash);
  if (!termination_reason[0]) snprintf(termination_reason, sizeof(termination_reason), "%s", "completion");
  snprintf(evidence.termination_reason, sizeof(evidence.termination_reason), "%s", termination_reason);
  const char *kill_outcome = kill_result == 1 ? "signalled" : kill_result == 2 ? "already_dead"
    : kill_result < 0 ? "failed" : "none";
  snprintf(evidence.kill_outcome, sizeof(evidence.kill_outcome), "%s", kill_outcome);
  evidence.stdout_bytes = outn;
  evidence.stderr_bytes = errn;
  evidence.stdout_truncated = stdout_truncated;
  evidence.stderr_truncated = stderr_truncated;
  sha_hex(out ? (const void *) out : (const void *) "", outn, evidence.stdout_hash);
  sha_hex(err ? (const void *) err : (const void *) "", errn, evidence.stderr_hash);

  char logname[96];
  snprintf(logname, sizeof(logname), "stdout-%s.log", r->generation);
  if (durable_at(results_fd, logname, out ? (const void *) out : (const void *) "", outn) < 0) {
    free(out); free(err); return -1;
  }
  snprintf(logname, sizeof(logname), "stderr-%s.log", r->generation);
  if (durable_at(results_fd, logname, err ? (const void *) err : (const void *) "", errn) < 0) {
    free(out); free(err); return -1;
  }
  free(out); free(err);
  const char *state = !strcmp(termination_reason, "cancel") ? "CANCELLED"
    : (!strcmp(termination_reason, "timeout") || !strcmp(termination_reason, "broker_shutdown"))
      ? "INTERRUPTED"
    : strcmp(termination_reason, "completion") ? "FAILED"
    : (WIFEXITED(status) && WEXITSTATUS(status) == 0 && measured) ? "SUCCEEDED" : "FAILED";
  int code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  const char *result_error = !strcmp(termination_reason, "output_limit")
      ? "payload output exceeded its authorized byte cap"
    : measured ? "" : "final payload security identity was not measured";
  if (!strcmp(state, "SUCCEEDED") && r->step_index + 1U == r->total_steps
      && publish_artifact_ferry(r, &evidence) < 0) {
    /* Never report a successful user-visible build if its bounded broker ferry did not become
       durable and fully bound.  Partial broker-owned files remain inert without a manifest. */
    state = "FAILED";
    result_error = "bounded broker artifact ferry failed closed";
  }
  const char *payload_state = measured ? "reaped" : "child_reaped_unmeasured";
  return publish_result(r, state, code, payload_state, pid, start, NULL, &evidence,
    result_error);
}
static int process_file(const char *name) {
  size_t length = strlen(name);
  if (length != 12 + 64 || strncmp(name, "request-", 8)
      || strcmp(name + length - 4, ".bin")) return 0;
  char generation[65];
  memcpy(generation, name + 8, 64); generation[64] = 0;
  if (!hex64(generation)) return -1;
  /* A durable broker-owned prune receipt is a terminal admission tombstone. It must win over
     stale request bytes until the controller has durably removed those bytes, including across
     a PID1 restart in the middle of two-phase retention cleanup. */
  int pruned = generation_is_pruned(generation);
  if (pruned != 0) return pruned > 0 ? 0 : -1;
  char result[96];
  snprintf(result, sizeof(result), "result-%s.bin", generation);
  if (faccessat(results_fd, result, F_OK, AT_EACCESS) == 0) return 0;
  if (errno != ENOENT) return -1;

  struct bytes packet = read_trusted_at(requests_fd, name, CONTROLLER_UID, MAX_PACKET);
  if (!packet.p) return -1;
  struct request request;
  if (parse_request(packet.p, packet.n, &request) || strcmp(request.generation, generation)) {
    free(packet.p);
    return -1; /* Unvalidated controller bytes can never cause a plausible broker result. */
  }
  if (strcmp(request.broker_instance_id, broker_instance)
      || strcmp(request.container_generation_id, container_generation)) {
    free(packet.p);
    int refused = publish_without_payload_reason(&request, "INTERRUPTED",
      "request targeted a broker generation that is no longer active",
      "broker_generation_mismatch", NULL);
    free_request(&request);
    return refused < 0 ? -1 : 0;
  }
  if (retained_generation_count() >= MAX_RETAINED_GENERATIONS) {
    free(packet.p);
    int refused = publish_without_payload(&request, "FAILED",
      "broker retention backlog reached its acknowledged-generation bound");
    free_request(&request);
    return refused < 0 ? -1 : 0;
  }
  int predecessor = predecessor_succeeded(&request);
  if (predecessor <= 0) {
    free(packet.p); free_request(&request);
    return predecessor;
  }
  char accepted[96];
  snprintf(accepted, sizeof(accepted), "accepted-%s.bin", generation);
  int publication = durable_state(accepted, packet.p, packet.n);
  free(packet.p);
  if (publication != 0) {
    free_request(&request);
    return -1; /* Startup recovery owns accepted-without-result generations. */
  }
  int rc = execute_request(&request);
  free_request(&request);
  return rc < 0 ? -1 : 0;
}
static void recover_inflight(void) {
  int scan = fresh_directory_scan_fd(state_fd);
  DIR *directory = fdopendir(scan);
  if (!directory) fatal("state recovery directory unavailable");
  unsigned count = 0;
  for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
    if (++count > MAX_SCAN_FILES) fatal("broker state exceeds file bound");
    if (strncmp(entry->d_name, "accepted-", 9)) continue;
    size_t length = strlen(entry->d_name);
    if (length != 9 + 64 + 4 || strcmp(entry->d_name + length - 4, ".bin")) continue;
    char generation[65];
    memcpy(generation, entry->d_name + 9, 64); generation[64] = 0;
    if (!hex64(generation)) fatal("broker state has an invalid generation filename");
    char result[96];
    snprintf(result, sizeof(result), "result-%s.bin", generation);
    if (faccessat(results_fd, result, F_OK, AT_EACCESS) == 0) continue;
    struct bytes accepted = read_owned_at(state_fd, entry->d_name, BROKER_UID, BROKER_UID, 0600,
      MAX_PACKET);
    struct request request;
    if (!accepted.p || parse_request(accepted.p, accepted.n, &request)
        || strcmp(request.generation, generation)) {
      free(accepted.p);
      fatal("accepted broker request is invalid during recovery");
    }
    free(accepted.p);
    /* If a previous broker died after creating or running the payload, first move the fixed
       active project directory behind the generation-keyed retained boundary. This is
       idempotent when the preceding broker completed the rename but not the result publish. */
    if (retain_active_runtime(request.project, generation, 1) < 0) {
      free_request(&request);
      fatal("in-flight runtime lineage could not be retained during recovery");
    }
    char started[96];
    snprintf(started, sizeof(started), "started-%s.txt", generation);
    struct bytes value = read_owned_at(state_fd, started, BROKER_UID, BROKER_UID, 0600, 160);
    long pid = 0; unsigned long long starttime = 0;
    if (value.p) {
      char text[161];
      memcpy(text, value.p, value.n); text[value.n] = 0; free(value.p);
      if (sscanf(text, "%ld %llu", &pid, &starttime) != 2 || pid <= 0 || !starttime) {
        fatal("broker started-state identity is invalid");
      }
      /* A fresh container generation means the old cgroup was torn down, but this process did
         not pidfd-wait/reap that child. Preserve the identity and explicitly leave death unresolved. */
      struct result_evidence evidence;
      empty_evidence(&evidence);
      snprintf(evidence.termination_reason, sizeof(evidence.termination_reason), "%s", "broker_restart");
      snprintf(evidence.kill_outcome, sizeof(evidence.kill_outcome), "%s", "none");
      if (publish_result(&request, "INTERRUPTED", -1, "unresolved", (pid_t) pid, starttime,
          NULL, &evidence,
          "broker restart observed an in-flight generation; payload death requires external cgroup proof") < 0) {
        fatal("could not publish unresolved restart recovery");
      }
    } else {
      if (errno != ENOENT || publish_without_payload_reason(&request, "INTERRUPTED",
          "broker restart recovered an accepted generation before payload start",
          "broker_generation_mismatch", NULL) < 0) {
        fatal("could not publish never-started restart recovery");
      }
    }
    free_request(&request);
  }
  if (closedir(directory) < 0) fatal("state recovery directory close failed");
}
static void require_dir(const char*path,int*fd,uid_t owner,gid_t group,mode_t mode){*fd=open(path,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);struct stat s;if(*fd<0||fstat(*fd,&s)<0||!S_ISDIR(s.st_mode)||s.st_uid!=owner||s.st_gid!=group||(s.st_mode&07777)!=mode)fatal("broker directory ownership/mode contract failed");}
static int mount_option(const char *options, const char *needle) {
  size_t length = strlen(needle);
  for (const char *cursor = options; cursor && *cursor;) {
    const char *end = strchr(cursor, ','); size_t item = end ? (size_t) (end - cursor) : strlen(cursor);
    if (item == length && !memcmp(cursor, needle, length)) return 1;
    cursor = end ? end + 1 : NULL;
  }
  return 0;
}
static unsigned long long mount_id_value(int fd) {
  struct statx metadata;
  memset(&metadata, 0, sizeof(metadata));
  if (statx(fd, "", AT_EMPTY_PATH | AT_NO_AUTOMOUNT, STATX_MNT_ID, &metadata) < 0
      || !(metadata.stx_mask & STATX_MNT_ID) || !metadata.stx_mnt_id) fatal("mount ID is unavailable");
  return (unsigned long long) metadata.stx_mnt_id;
}
static void require_exact_mount(const char *target, int fd, int require_project_quota, int read_only) {
  struct statfs filesystem;
  if (fstatfs(fd, &filesystem) < 0 || (unsigned long) filesystem.f_type != 0xEF53UL) {
    fatal("broker storage mount must be ext4");
  }
  FILE *input = fopen("/proc/self/mountinfo", "re");
  if (!input) fatal("mountinfo is unavailable");
  char line[8192]; int found = 0;
  while (fgets(line, sizeof(line), input)) {
    char *items[96] = { 0 }; unsigned count = 0;
    char *save = NULL;
    for (char *token = strtok_r(line, " ", &save); token && count < 96; token = strtok_r(NULL, " ", &save)) {
      items[count++] = token;
    }
    unsigned separator = 0;
    while (separator < count && strcmp(items[separator], "-")) separator++;
    if (count < 8 || separator + 3 >= count || strcmp(items[4], target)) continue;
    found = 1;
    char *super_options = items[separator + 3];
    super_options[strcspn(super_options, "\r\n")] = 0;
    if (strcmp(items[separator + 1], "ext4")
        || !mount_option(items[5], read_only ? "ro" : "rw")
        || !mount_option(items[5], "noexec") || !mount_option(items[5], "nosuid")
        || !mount_option(items[5], "nodev")
        || (require_project_quota && !mount_option(items[5], "prjquota")
          && !mount_option(super_options, "prjquota"))) {
      fclose(input); fatal("broker storage mount flags do not meet the reviewed contract");
    }
    break;
  }
  fclose(input);
  if (!found) fatal("broker storage path is not an exact mounted target");
}
static void require_broker_label(void) {
  int fd = open("/proc/self/attr/current", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  char label[256];
  if (fd < 0) fatal("broker AppArmor label is unavailable");
  ssize_t count = read(fd, label, sizeof(label) - 1U);
  if (count <= 0 || close(fd) < 0) fatal("broker AppArmor label read failed");
  label[count] = 0;
  while (count > 0 && (label[count - 1] == '\n' || label[count - 1] == '\r')) label[--count] = 0;
  if (strcmp(label, "dominion-gx10-gamefactory-broker (enforce)")) {
    fatal("broker AppArmor profile is not exact and enforcing");
  }
}

static void close_verified_artifact(const char *path, mode_t mode, const char *environment_name,
    char digest[65]) {
  int fd = require_artifact(path, mode, environment_name, digest);
  if (close(fd) < 0) fatal("immutable broker artifact close failed");
}

static void verify_fixed_project_guards(void) {
  for (unsigned index = 0; index < sizeof(reviewed_projects) / sizeof(reviewed_projects[0]); index++) {
    for (unsigned program = 0; program < 2; program++) {
      const char *name = program == 0 ? "node" : "godot";
      const char *environment = program == 0 ? "GAME_FACTORY_NODE_GUARD_SHA256" : "GAME_FACTORY_GODOT_GUARD_SHA256";
      const char *expected = program == 0 ? node_guard_hash : godot_guard_hash;
      char path[256], measured[65];
      int written = snprintf(path, sizeof(path), "%s/%s-%s-guard", GUARD_DIRECTORY,
        reviewed_projects[index].slug, name);
      if (written <= 0 || (size_t) written >= sizeof(path)) fatal("fixed project guard path is invalid");
      close_verified_artifact(path, 0555, environment, measured);
      if (strcmp(measured, expected)) fatal("fixed project guard digest differs from the reviewed base guard");
    }
  }
}

static void verify_reviewed_deployment_policy(void) {
  int fd = require_artifact(DEPLOYMENT_POLICY_PATH, 0444,
    "GAME_FACTORY_DEPLOYMENT_POLICY_SHA256", deployment_policy_hash);
  unsigned char bytes[sizeof(reviewed_deployment_policy)];
  size_t used = 0;
  while (used < sizeof(bytes)) {
    ssize_t count = read(fd, bytes + used, sizeof(bytes) - used);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) fatal("reviewed deployment policy read failed");
    if (!count) break;
    used += (size_t) count;
  }
  unsigned char extra;
  ssize_t tail;
  do { tail = read(fd, &extra, 1); } while (tail < 0 && errno == EINTR);
  if (close(fd) < 0 || tail != 0 || used != sizeof(reviewed_deployment_policy) - 1U
      || memcmp(bytes, reviewed_deployment_policy, used)) {
    fatal("deployment policy bytes differ from the compiled reviewed semantics");
  }
}

int main(void) {
  if (getpid() != 1) fatal("broker must be the container PID-namespace init process");
  if (getuid() != BROKER_UID || geteuid() != BROKER_UID
      || getgid() != BROKER_UID || getegid() != BROKER_UID) {
    fatal("fixed broker UID/GID 10003 is required");
  }
  gid_t groups[8];
  int group_count = getgroups(8, groups);
  int primary_group = 0, spool_group = 0;
  for (int index = 0; index < group_count; index++) {
    if (groups[index] == BROKER_UID) primary_group++;
    else if (groups[index] == SPOOL_GID) spool_group++;
  }
  /* Docker/runc retains the fixed primary GID in the kernel supplementary set and then adds the
     one Compose group. Require that measured two-member set exactly, independent of ordering. */
  if (group_count != 2 || primary_group != 1 || spool_group != 1) {
    fatal("broker supplementary-group contract is not exact");
  }
  if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) {
    fatal("no-new-privileges is required");
  }
  if (getsid(0) != getpid() && setsid() < 0) fatal("broker must own its session");
  struct sigaction action;
  memset(&action, 0, sizeof(action)); action.sa_handler = request_termination;
  if (sigemptyset(&action.sa_mask) < 0 || sigaction(SIGTERM, &action, NULL) < 0
      || sigaction(SIGINT, &action, NULL) < 0) fatal("broker termination handler setup failed");
  struct sigaction ignore_pipe;
  memset(&ignore_pipe, 0, sizeof(ignore_pipe)); ignore_pipe.sa_handler = SIG_IGN;
  if (sigemptyset(&ignore_pipe.sa_mask) < 0
      || sigaction(SIGPIPE, &ignore_pipe, NULL) < 0) fatal("broker SIGPIPE policy setup failed");
  require_broker_label();
  require_broker_kernel_security();

  require_dir(REQUESTS_PATH, &requests_fd, CONTROLLER_UID, SPOOL_GID, 02750);
  require_dir(RESULTS_PATH, &results_fd, BROKER_UID, SPOOL_GID, 02750);
  require_dir(WORKSPACE_PATH, &workspace_fd, BROKER_UID, BROKER_UID, 0700);
  require_dir("/runtime", &runtime_root_fd, BROKER_UID, BROKER_UID, 0700);
  require_dir(STATE_PATH, &state_fd, BROKER_UID, BROKER_UID, 0700);
  require_exact_mount(REQUESTS_PATH, requests_fd, 0, 1);
  require_exact_mount(RESULTS_PATH, results_fd, 0, 0);
  /* Revoke any predecessor heartbeat as soon as this exact bounded result mount is trusted. */
  revoke_readiness_best_effort();
  require_exact_mount(STATE_PATH, state_fd, 0, 0);
  require_exact_mount(WORKSPACE_PATH, workspace_fd, 1, 0);
  require_exact_mount("/runtime", runtime_root_fd, 1, 0);
  const int storage_fds[] = { requests_fd, results_fd, state_fd, workspace_fd, runtime_root_fd };
  for (unsigned left = 0; left < sizeof(storage_fds) / sizeof(storage_fds[0]); left++) {
    struct stat left_metadata;
    if (fstat(storage_fds[left], &left_metadata) < 0) fatal("bounded storage identity is unavailable");
    unsigned long long left_mount = mount_id_value(storage_fds[left]);
    for (unsigned right = left + 1U; right < sizeof(storage_fds) / sizeof(storage_fds[0]); right++) {
      struct stat right_metadata;
      if (fstat(storage_fds[right], &right_metadata) < 0) fatal("bounded storage identity is unavailable");
      if (left_mount == mount_id_value(storage_fds[right]) || left_metadata.st_dev == right_metadata.st_dev) {
        fatal("requests, results, broker-state, workspace, and runtime must be distinct bounded filesystems");
      }
    }
  }
  if (mkdir(PAYLOAD_RUNTIME_PATH, 0700) < 0 && errno != EEXIST) fatal("payload runtime creation failed");
  require_dir(PAYLOAD_RUNTIME_PATH, &runtime_fd, BROKER_UID, BROKER_UID, 0700);
  if ((mkdirat(runtime_fd, ACTIVE_RUNTIME_NAME, 0700) < 0 && errno != EEXIST)
      || fsync(runtime_fd) < 0) fatal("fixed active payload runtime root could not be created");
  struct stat runtime_metadata;
  if (fstat(runtime_root_fd, &runtime_metadata) < 0
      || exact_quota_directory_at(runtime_fd, ACTIVE_RUNTIME_NAME, RUNTIME_QUOTA_ID,
        runtime_metadata.st_dev, &runtime_active_fd) < 0) {
    fatal("fixed active payload runtime root does not inherit the reviewed project quota");
  }
  /* Provisioning supplies the reviewed symlink/DAC topology. Startup opens every private gate
     while no payload exists, binds exact inodes, and durably revokes all wrappers before the
     first readiness record can be published. */
  initialize_workspace_layout();
  initialize_runtime_layout();
  verify_workspace_root_layout();
  verify_runtime_root_layout(1);

  close_verified_artifact(BROKER_BINARY_PATH, 0555, "GAME_FACTORY_BROKER_BINARY_SHA256",
    broker_binary_hash);
  close_verified_artifact(NODE_GUARD_PATH, 0555, "GAME_FACTORY_NODE_GUARD_SHA256",
    node_guard_hash);
  close_verified_artifact(GODOT_GUARD_PATH, 0555, "GAME_FACTORY_GODOT_GUARD_SHA256",
    godot_guard_hash);
  verify_fixed_project_guards();
  close_verified_artifact(NODE_EXECUTABLE_PATH, 0555, "GAME_FACTORY_PAYLOAD_NODE_SHA256",
    node_executable_hash);
  close_verified_artifact(GODOT_EXECUTABLE_PATH, 0555, "GAME_FACTORY_PAYLOAD_GODOT_SHA256",
    godot_executable_hash);
  node_filter_fd = require_artifact(NODE_FILTER_PATH, 0444,
    "GAME_FACTORY_NODE_FILTER_SHA256", node_filter_hash);
  godot_filter_fd = require_artifact(GODOT_FILTER_PATH, 0444,
    "GAME_FACTORY_GODOT_FILTER_SHA256", godot_filter_hash);
  close_verified_artifact(APPARMOR_POLICY_PATH, 0444, "GAME_FACTORY_APPARMOR_POLICY_SHA256",
    apparmor_policy_hash);
  close_verified_artifact(OUTER_SECCOMP_PATH, 0444, "GAME_FACTORY_OUTER_SECCOMP_SHA256",
    outer_seccomp_hash);
  verify_reviewed_deployment_policy();
  hash_boot_id();

  int lock = openat(state_fd, "broker.lock", O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB) < 0) {
    fatal("singleton broker lifetime flock is unavailable");
  }
  unsigned char random[64];
  if (syscall(SYS_getrandom, random, sizeof(random), 0) != (ssize_t) sizeof(random)) {
    fatal("broker instance randomness unavailable");
  }
  sha_hex(random, sizeof(random) / 2U, broker_instance);
  sha_hex(random + sizeof(random) / 2U, sizeof(random) / 2U, container_generation);
  unsigned long long self_starttime = starttime_for(getpid());
  if (!self_starttime) fatal("broker starttime identity is unavailable");
  snprintf(broker_starttime, sizeof(broker_starttime), "%llu", self_starttime);
  if (snprintf(generation_lease_name, sizeof(generation_lease_name), "lease-%s.lock",
      container_generation) >= (int) sizeof(generation_lease_name)) {
    fatal("per-generation broker lease name is invalid");
  }
  generation_lease_fd = openat(state_fd, generation_lease_name,
    O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  struct stat generation_lease_metadata;
  if (generation_lease_fd < 0 || fchmod(generation_lease_fd, 0600) < 0
      || write_all(generation_lease_fd, container_generation, 64) < 0
      || fsync(generation_lease_fd) < 0 || fsync(state_fd) < 0
      || fstat(generation_lease_fd, &generation_lease_metadata) < 0
      || !S_ISREG(generation_lease_metadata.st_mode)
      || generation_lease_metadata.st_uid != BROKER_UID
      || generation_lease_metadata.st_gid != BROKER_UID
      || (generation_lease_metadata.st_mode & 07777) != 0600
      || generation_lease_metadata.st_nlink != 1 || generation_lease_metadata.st_size != 64
      || flock(generation_lease_fd, LOCK_EX | LOCK_NB) < 0) {
    fatal("per-generation durable broker lifetime flock is unavailable");
  }
  capture_broker_runtime_identity(generation_lease_fd);
  recover_publications(results_fd, BROKER_UID, SPOOL_GID);
  recover_publications(state_fd, BROKER_UID, BROKER_UID);
  process_retention_acks();
  cleanup_consumed_prune_receipts();
  recover_inflight();
  cleanup_orphan_ready_records();
  verify_runtime_root_layout(0);
  sweep_orphan_runtime_generations();
  verify_runtime_root_layout(0);

  uint64_t next_readiness = 0;
  while (!termination_requested) {
    verify_workspace_root_layout();
    verify_runtime_root_layout(0);
    uint64_t now = monotonic_millis();
    if (now >= next_readiness) {
      if (publish_readiness() < 0) fatal("broker readiness publication failed");
      next_readiness = now + 1000U;
    }
    /* Retention acknowledgements are always handled before ordinary requests. This reserved
       control path remains available even when the admitted-generation bound has been reached. */
    process_retention_acks();
    cleanup_consumed_prune_receipts();
    int scan = fresh_directory_scan_fd(requests_fd);
    DIR *directory = fdopendir(scan);
    if (!directory) fatal("request directory unavailable");
    unsigned count = 0;
    for (struct dirent *entry = readdir(directory); entry; entry = readdir(directory)) {
      if (++count > MAX_SCAN_FILES) fatal("request spool exceeds absolute file bound");
      if (process_file(entry->d_name) < 0) fatal("request processing failed closed");
    }
    if (closedir(directory) < 0) fatal("request directory close failed");
    struct timespec pause = { 0, 100000000L };
    while (!termination_requested && nanosleep(&pause, &pause) < 0 && errno == EINTR) { }
  }
  revoke_readiness_best_effort();
  revoke_generation_lease_best_effort();
  return 0;
}
