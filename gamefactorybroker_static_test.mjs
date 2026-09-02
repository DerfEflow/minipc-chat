import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const hands = join(root, "hands");
const text = (path) => readFileSync(join(hands, path), "utf8");
const compose = text("docker-compose.gx10-worker.yml");
const legacyCompose = text("docker-compose.yml");
const dockerfile = text("gx10-gamefactory/Dockerfile");
const envExample = text("gx10-worker.env.example");
const provision = text("gx10-gamefactory/provision-loopback-filesystems.sh");
const handsSource = text("hands.mjs");
const entrypoint = text("gx10-controller-entrypoint.mjs");
const broker = text("gx10-gamefactory/launch-broker.c");
const brokerProtocol = text("gamefactory-broker-protocol.mjs");
const launcher = text("gx10-gamefactory/fd-launcher.c");
const childSeccomp = text("gx10-gamefactory/generate-child-seccomp.c");
const appArmor = text("gx10-gamefactory/dominion-gx10-gamefactory-broker.apparmor");
const profileGenerator = text("gx10-gamefactory/generate-project-isolation-profiles.mjs");
const liveGate = readFileSync(join(root, "ops", "gx10-gamefactory-live-gate.mjs"), "utf8");
const quotaFixture = text("gx10-gamefactory/live-gates/live-quota.mjs");
const controllerAppArmor = text("gx10-gamefactory/dominion-gx10-gamefactory-controller.apparmor");
const policy = text("gx10-gamefactory/gamefactory-broker-policy.bin");
const brokerSeccomp = JSON.parse(text("gx10-gamefactory/seccomp-gx10-gamefactory-broker.json"));
const controllerSeccomp = JSON.parse(text("gx10-gamefactory/seccomp-gx10-gamefactory-controller.json"));
const controllerStart = compose.indexOf("  gx10-game-factory-controller:");
const brokerStart = compose.indexOf("  gx10-game-factory-broker:");
const controller = compose.slice(controllerStart, brokerStart);
const brokerService = compose.slice(brokerStart);
const controllerStage = dockerfile.slice(dockerfile.indexOf(" AS controller"), dockerfile.indexOf(" AS retired_executor_inert"));
const brokerStage = dockerfile.slice(dockerfile.lastIndexOf("FROM ${NODE_IMAGE} AS broker"));
const slugs = ["system-canary", "vector-vault", "bolt-bloom", "pocket-gravity", "chromalock", "tiny-foundry",
  "letter-loom", "pulse-path", "shelf-shift", "wobble-works", "signal-grid"];
const workspaceRootEntries = ["system-canary-sibling", ...slugs];
const legacyGenerationPath = `/runtime/payload/${"?".repeat(64)}`;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

test("active compose excludes the retired JS executor", () => {
  assert.ok(controllerStart >= 0 && brokerStart > controllerStart);
  assert.equal(compose.includes("gx10-game-factory-executor"), false);
  assert.equal(compose.includes("dominion-hands-gx10"), false);
  assert.match(controller, /HANDS_TOKEN:/);
  assert.match(brokerService, /network_mode:\s*none/);
  assert.match(brokerService, /cgroup:\s*host/);
  assert.doesNotMatch(brokerService, /\bHANDS_[A-Z0-9_]+\s*:/);
  assert.equal(handsSource.includes('import("./gamefactory-worker.mjs")'), false);
  assert.equal(handsSource.includes('import("./gamefactory-controller.mjs")'), false);
  assert.match(handsSource, /createGameFactoryBrokerController/);
  assert.match(legacyCompose, /container_name:\s*dominion-hands/);
  assert.match(legacyCompose, /- \/:\/host:rw/);
});

test("active images expose only the reviewed controller and static PID1 broker", () => {
  for (const module of ["hands.mjs", "gamefactory-broker-controller.mjs", "gamefactory-broker-protocol.mjs",
    "gamefactory-broker-projects.mjs", "gamefactory-ipc.mjs", "gx10-controller-entrypoint.mjs"]) {
    assert.match(controllerStage, new RegExp(module.replaceAll(".", "[.]")), `controller omits ${module}`);
    assert.match(controllerAppArmor, new RegExp(`/app/${module.replaceAll(".", "[.]")} r,`),
      `controller AppArmor omits ${module}`);
  }
  assert.match(controllerAppArmor, /\/app\/ r,/);
  for (const forbidden of ["gamefactory-worker.mjs", "gamefactory-executor.mjs", "gamefactory-runner.mjs",
    "browser.mjs", "desktop.mjs", "/usr/bin/bwrap", "/opt/godot"]) {
    assert.doesNotMatch(controllerStage, new RegExp(forbidden.replaceAll(".", "[.]")), `controller includes ${forbidden}`);
  }
  assert.match(controllerStage, /USER 10001:10001/);
  assert.match(controllerStage, /ENTRYPOINT \["node", "\/app\/gx10-controller-entrypoint[.]mjs"\]/);
  assert.match(brokerStage, /USER 10003:10003/);
  assert.match(brokerStage, /ENTRYPOINT \["\/opt\/dominion-broker\/launch-broker"\]/);
  assert.doesNotMatch(brokerStage, /gamefactory-(?:worker|executor|controller)[.]mjs|HANDS_TOKEN|sdkmanager|--licenses/i);
  assert.doesNotMatch(brokerStage, /COPY[^\n]*(?:android-sdk|openjdk|gradle)/i);
  assert.match(brokerStage, /test ! -d \/opt\/android-sdk/);
});

test("compose applies exact identity, resource, privilege, and restart boundaries", () => {
  for (const [service, uid, profile] of [[controller, "10001", "controller"], [brokerService, "10003", "broker"]]) {
    assert.match(service, new RegExp(`user:\\s*"${uid}:${uid}"`));
    assert.match(service, /group_add:\s*\n\s*- "11000"/);
    assert.match(service, /privileged:\s*false/);
    assert.match(service, /read_only:\s*true/);
    assert.match(service, /cap_drop:\s*\n\s*- ALL/);
    assert.match(service, /no-new-privileges:true/);
    assert.match(service, new RegExp(`apparmor=dominion-gx10-gamefactory-${profile}`));
    assert.match(service, new RegExp(`seccomp=\\$\\{GX10_GAME_FACTORY_${profile.toUpperCase()}_SECCOMP_PROFILE`));
    assert.match(service, /ipc:\s*private/);
    assert.match(service, /pids_limit:\s*\d+/);
    assert.match(service, /mem_limit:/);
    assert.match(service, /memswap_limit:/);
    assert.match(service, /restart:\s*unless-stopped/);
    assert.match(service, /ulimits:\s*[\s\S]*?core:\s*0/);
  }
  assert.match(controller, /HANDS_TOKEN:/);
  assert.match(controller, /HANDS_NODE:\s*gx10-gamefactory/);
  assert.match(controller, /GAME_FACTORY_CONTROLLER_ONLY:\s*"1"/);
  assert.match(brokerService, /network_mode:\s*none/);
  assert.doesNotMatch(brokerService, /\bHANDS_[A-Z0-9_]+\s*:/);
  assert.doesNotMatch(compose, /\bcap_add\s*:|docker[.]sock|\bpid:\s*host\b|\bipc:\s*host\b|\bnetwork_mode:\s*host\b/);
});

test("controller preflight is credentialed but workspace/toolchain blind", () => {
  for (const path of ["/workspace", "/runtime", "/state"]) assert.doesNotMatch(controller, new RegExp(`target:\\s*${path}`));
  assert.match(controller, /target:\s*\/broker-requests[\s\S]*?read_only:\s*false/);
  assert.match(controller, /target:\s*\/broker-results[\s\S]*?read_only:\s*true/);
  for (const gate of ["exact static-broker controller identity is required", "controller-only dispatch mode is required",
    "controller must not mount workspace, runtime, or worker state", "controller AppArmor profile is not enforced",
    "controller spools must be dedicated ext4 filesystems"]) {
    assert.match(entrypoint, new RegExp(gate));
  }
  assert.match(entrypoint, /GAME_FACTORY_WORKER_EXTERNAL_BROKER !== "1"/);
  assert.match(entrypoint, /requireExt4LostFound:\s*true,\s*flat:\s*true/);
  assert.doesNotMatch(entrypoint, /node:child_process|\bspawn\s*\(/,
    "thread-only controller seccomp must not be widened for a child Hands process");
  assert.match(entrypoint, /await import\("[.]\/hands[.]mjs"\)[\s\S]*?await runHands\(\)/);
  assert.match(handsSource, /export async function runHands\(\)/);
  assert.match(controller, /GAME_FACTORY_WORKER_ISOLATION_ATTESTED:\s*"\$\{GAME_FACTORY_WORKER_ISOLATION_ATTESTED:-0\}"/);
  assert.match(controller, /GAME_FACTORY_WORKER_TOOLCHAIN_ATTESTED:\s*"\$\{GAME_FACTORY_WORKER_TOOLCHAIN_ATTESTED:-0\}"/);
  assert.match(envExample, /^GAME_FACTORY_WORKER_ISOLATION_ATTESTED=0$/m);
  assert.match(envExample, /^GAME_FACTORY_WORKER_TOOLCHAIN_ATTESTED=0$/m);
  for (const procFile of ["status", "attr/current", "mountinfo"]) {
    assert.match(controllerAppArmor, new RegExp(`owner /proc/\\[0-9\\]\\*/${procFile.replace("/", "\\/")} r,`),
      `controller AppArmor omits Docker-resolved numeric self ${procFile}`);
  }
});

test("directional mounts are exact, non-creating, and keep mutable payload storage from the controller", () => {
  assert.match(controller, /GX10_GAME_FACTORY_COMMANDS[\s\S]*?target:\s*\/broker-requests[\s\S]*?read_only:\s*false/);
  assert.match(controller, /GX10_GAME_FACTORY_RESULTS[\s\S]*?target:\s*\/broker-results[\s\S]*?read_only:\s*true/);
  assert.doesNotMatch(controller, /target:\s*\/(?:workspace|runtime|broker-state)\b/);
  assert.match(brokerService, /GX10_GAME_FACTORY_COMMANDS[\s\S]*?target:\s*\/broker-requests[\s\S]*?read_only:\s*true/);
  for (const target of ["broker-state", "broker-results", "workspace", "runtime"]) {
    assert.match(brokerService, new RegExp(`target:\\s*/${target}`));
  }
  assert.equal((compose.match(/^\s+create_host_path:\s*false\s*$/gm) || []).length, 10);
});

test("static broker is the only active payload authority", () => {
  assert.match(brokerStage, /ENTRYPOINT \["\/opt\/dominion-broker\/launch-broker"\]/);
  assert.doesNotMatch(brokerStage, /gamefactory-(?:worker|executor|controller)[.]mjs/);
  assert.match(brokerService, /target:\s*\/broker-state/);
  assert.match(brokerService, /target:\s*\/workspace/);
  assert.match(brokerService, /target:\s*\/runtime/);
  assert.match(broker, /broker must be the container PID-namespace init process/);
  assert.match(broker, /broker no-new-privileges\/raw seccomp proof is absent/);
  assert.match(broker, /Landlock ABI 3 or newer is required/);
  assert.match(broker, /requests, results, broker-state, workspace, and runtime must be distinct bounded filesystems/);
  assert.match(broker, /group_count != 2 \|\| primary_group != 1 \|\| spool_group != 1/);
  assert.match(appArmor, /\/proc\/\[0-9\]\*\/mountinfo r,/,
    "broker AppArmor must allow Docker-resolved numeric self mountinfo");
  const landlockTruncateCompatibility = /#ifndef LANDLOCK_ACCESS_FS_TRUNCATE[\s\S]*?#define LANDLOCK_ACCESS_FS_TRUNCATE \(1ULL << 14\)[\s\S]*?_Static_assert\(LANDLOCK_ACCESS_FS_TRUNCATE == \(1ULL << 14\)/;
  assert.match(launcher, landlockTruncateCompatibility);
  assert.match(broker, landlockTruncateCompatibility);
  assert.match(launcher, /\{ "\/etc\/ssl\/openssl[.]cnf", LANDLOCK_ACCESS_FS_READ_FILE \}/);
  assert.equal((appArmor.match(/^  \/etc\/ssl\/openssl[.]cnf r,$/gm) || []).length, 45,
    "every stacked broker, guard, and payload profile must allow only the exact immutable OpenSSL config");
});

test("known project profiles and release gates are static", () => {
  for (const slug of slugs) {
    assert.match(broker, new RegExp(`"${slug}"`));
    for (const program of ["node", "godot"]) {
      assert.match(appArmor, new RegExp(`profile dominion-gx10-guard-${program}-${slug} /opt/dominion-broker/guards/${slug}-${program}-guard `));
      assert.match(appArmor, new RegExp(`profile dominion-gx10-payload-${program}-${slug} `));
      assert.match(appArmor, new RegExp(`/opt/dominion-broker/guards/${slug}-${program}-guard mr,`),
        `the selected static ${program} guard must be executable-mapped after its profile transition`);
    }
  }
  assert.match(appArmor,
    /\/opt\/dominion-broker\/guards\/\*-guard rpx -> &dominion-gx10-gamefactory-broker,/);
  assert.equal((appArmor.match(
    /\/opt\/dominion-broker\/guards\/\*-guard rpx -> &dominion-gx10-gamefactory-broker,/g) || []).length, 1);
  assert.doesNotMatch(appArmor, /rpx -> &,/,
    "a bare relative-stack target parses but names a missing profile at exec time");
  assert.match(appArmor, /ptrace \(read,readby\) peer=dominion-gx10-gamefactory-broker,/);
  assert.match(appArmor, /signal \(receive\) set=\(term kill\) peer=unconfined,/);
  assert.match(appArmor, /\/usr\/share\/zoneinfo\/Etc\/UTC r,/);
  assert.match(controllerAppArmor, /signal \(receive\) set=\(term kill\) peer=unconfined,/);
  assert.equal((appArmor.match(/guards\/[a-z-]+-(?:node|godot)-guard px ->/g) || []).length, 0,
    "the broker parent must not exceed the kernel's directed-transition table");
  assert.match(policy, /^android=disabled$/m);
  assert.match(policy, /^release_writes=disabled$/m);
  assert.match(policy, /^project_subtree=fixed-portfolio-plus-system-canary$/m);
});

for (const selected of slugs) {
  test(`fixed sibling deny matrix is exact for ${selected}`, () => {
    for (const program of ["node", "godot"]) {
      for (const kind of ["guard", "payload"]) {
        const name = `profile dominion-gx10-${kind}-${program}-${selected}`;
        const start = appArmor.indexOf(name);
        const end = appArmor.indexOf("\n}\n", start);
        assert.ok(start >= 0 && end > start, `missing profile body: ${name}`);
        const body = appArmor.slice(start, end);
        assert.ok(body.includes("# BEGIN GENERATED FIXED PROJECT ISOLATION"));
        assert.ok(body.includes("  deny /workspace/ r,"));
        assert.ok(body.includes("  /workspace/lost+found r,"));
        assert.ok(body.includes("  deny /workspace/lost+found/ rwklmx,"));
        assert.ok(body.includes("  deny /workspace/lost+found/** rwklmx,"));
        assert.ok(body.includes("  deny /workspace/.projects/ r,"));
        assert.ok(body.includes("  deny /workspace/.projects/lost-found-gate/ rwklmx,"));
        for (const sibling of workspaceRootEntries.filter((slug) => slug !== selected)) {
          assert.ok(body.includes(`  /workspace/${sibling} r,`), `${name} hides non-sensitive link target ${sibling}`);
          assert.ok(body.includes(`  deny /workspace/${sibling}/ rwklmx,`), `${name} metadata-leaks ${sibling}`);
          assert.ok(body.includes(`  deny /workspace/${sibling}/** rwklmx,`), `${name} content-leaks ${sibling}`);
          assert.ok(body.includes(`  deny /workspace/.projects/${sibling}/ rwklmx,`),
            `${name} canonical-wrapper-leaks ${sibling}`);
          assert.ok(body.includes(`  deny /workspace/.projects/${sibling}/** rwklmx,`),
            `${name} canonical-content-leaks ${sibling}`);
        }
        assert.ok(body.includes(`  /workspace/${selected} r,`));
        assert.ok(body.includes(`  /workspace/${selected}/ rw,`));
        assert.ok(body.includes(`  /workspace/${selected}/** rwk,`));
        assert.ok(body.includes(`  deny /workspace/.projects/${selected}/ wklmx,`));
        assert.ok(body.includes(`  /workspace/.projects/${selected}/data/ rw,`));
        assert.ok(body.includes(`  /workspace/.projects/${selected}/data/** rwk,`));
        assert.ok(body.includes("  deny /runtime/ r,"));
        assert.ok(body.includes("  /runtime/lost+found r,"));
        assert.ok(body.includes("  deny /runtime/lost+found/ rwklmx,"));
        assert.ok(body.includes("  deny /runtime/payload/ r,"));
        assert.ok(body.includes("  deny /runtime/payload/.private/ r,"));
        for (const gate of ["retained-gate", "sibling-gate", "lost-found-gate"]) {
          assert.ok(body.includes(`  deny /runtime/payload/.private/${gate}/ rwklmx,`));
          assert.ok(body.includes(`  deny /runtime/payload/.private/${gate}/** rwklmx,`));
        }
        assert.ok(body.includes("  /runtime/payload/retained r,"));
        assert.ok(body.includes("  deny /runtime/payload/retained/ rwklmx,"));
        assert.ok(body.includes("  deny /runtime/payload/retained/** rwklmx,"));
        assert.ok(body.includes(`  /runtime/payload/${"?".repeat(64)} r,`));
        assert.ok(body.includes(`  deny ${legacyGenerationPath}/ rwklmx,`));
        assert.ok(body.includes(`  deny ${legacyGenerationPath}/** rwklmx,`));
        assert.ok(body.includes("  /runtime/payload/system-canary-sibling r,"));
        assert.ok(body.includes("  deny /runtime/payload/system-canary-sibling/ rwklmx,"));
        assert.ok(body.includes("  deny /runtime/payload/active/system-canary-sibling/ rwklmx,"));
        for (const sibling of slugs.filter((slug) => slug !== selected)) {
          assert.ok(body.includes(`  deny /runtime/payload/active/${sibling}/ rwklmx,`),
            `${name} runtime-metadata-leaks ${sibling}`);
          assert.ok(body.includes(`  deny /runtime/payload/active/${sibling}/** rwklmx,`),
            `${name} runtime-content-leaks ${sibling}`);
        }
        assert.ok(body.includes(`  /runtime/payload/active/${selected}/ rw,`));
        assert.ok(body.includes(`  /runtime/payload/active/${selected}/** rwk,`));
        assert.equal(body.includes("  /runtime/payload/ rw,"), false, `${name} retains broad runtime authority`);
        assert.equal(body.includes("  /runtime/payload/** rwk,"), false, `${name} retains broad runtime subtree authority`);
      }
    }
  });
}

test("broker preflights exact root contents and retains runtime only after death proof", () => {
  assert.equal((appArmor.match(/# BEGIN GENERATED FIXED PROJECT ISOLATION/g) || []).length, 44);
  assert.match(profileGenerator, /for \(const project of projects\)[\s\S]*for \(const program of \["node", "godot"\]\)[\s\S]*for \(const kind of \["guard", "payload"\]\)/);
  for (const entry of workspaceRootEntries) assert.match(broker, new RegExp(`\\{? \\"${entry}\\"`));
  for (const failure of ["workspace root contains an unknown public project entry",
    "runtime mount root contains an unknown entry", "payload runtime root contains an unknown entry",
    "active runtime was not empty before payload admission"]) assert.ok(broker.includes(failure), failure);
  assert.match(broker, /retain_active_runtime\(r->project, r->generation, 0\)/);
  assert.match(broker, /waitpid\(pid, &status, 0\)[\s\S]*retain_active_runtime\(r->project, r->generation, 0\)/);
  assert.match(broker, /cleanup_generation_runtime\(ack->generation\)[\s\S]*artifact-%s-%u[.]bin/);
  assert.match(broker, /retain_active_runtime\(request[.]project, generation, 1\)/);
  assert.match(launcher, /--project/);
  assert.match(launcher, /HOME=\/runtime\/payload\/active\/%s/);
  for (const relative of ["payload/active", "payload/.private/retained-gate/data",
    "payload/.private/sibling-gate/data"]) assert.ok(
    provision.includes(`configure_project "$runtime_mount" ${relative} 12001`), relative);
  assert.match(provision, /runtime_isolation_sentinel=.*isolation-sentinel[.]txt/);
});

test("DAC indirection binds exact wrappers, truthful public links, and concurrency one", () => {
  for (const constant of ["WORKSPACE_PRIVATE_NAME \".projects\"", "WORKSPACE_DATA_NAME \"data\"",
    "LOST_FOUND_GATE_NAME \"lost-found-gate\"", "RUNTIME_PRIVATE_NAME \".private\"",
    "RUNTIME_RETAINED_GATE_NAME \"retained-gate\"", "RUNTIME_SIBLING_GATE_NAME \"sibling-gate\""]) {
    assert.ok(broker.includes(constant), constant);
  }
  for (const field of ["wrapper_dev", "wrapper_ino", "project_dev", "project_ino"]) {
    assert.ok(broker.includes(field), field);
  }
  assert.match(broker, /path_metadata[.]st_uid != BROKER_UID[\s\S]*path_metadata[.]st_gid != BROKER_UID[\s\S]*path_metadata[.]st_nlink != 3/);
  assert.match(broker, /active_workspace_project != -1[\s\S]*fchmod\(layout->wrapper_fd, 0700\)/);
  assert.match(broker, /active_workspace_project = \(int\) \(layout - workspace_project_layouts\)/);
  assert.match(broker, /close_workspace_project_or_fatal\(r->project\);[\s\S]*retain_active_runtime\(r->project, r->generation, 0\)/);
  assert.match(broker, /fatal\(const char \*m\)\{revoke_readiness_best_effort\(\);revoke_active_workspace_best_effort\(\)/);
  const startup = broker.indexOf("initialize_workspace_layout();");
  const runtimeStartup = broker.indexOf("initialize_runtime_layout();");
  const readiness = broker.lastIndexOf("if (publish_readiness()");
  assert.ok(startup >= 0 && runtimeStartup > startup && readiness > runtimeStartup,
    "all mode000 startup resets must precede readiness");
  assert.match(broker, /fchmod\(layout->wrapper_fd, 0000\)[\s\S]*fsync\(workspace_private_fd\)/);
  assert.match(broker, /exact_symlink_at\(workspace_fd, "lost\+found"[\s\S]*exact_lost_found_gate/);
  assert.match(broker, /exact_symlink_at\(runtime_root_fd, "lost\+found"[\s\S]*exact_lost_found_gate/);
  const lostFoundInitializer = broker.match(
    /static void initialize_lost_found_gate\([\s\S]*?\n}\n\nstatic void initialize_workspace_layout/,
  )?.[0] || "";
  assert.match(lostFoundInitializer,
    /data_fd < 0 \|\| exact_lost_found_fd\(data_fd, expected_device, NULL\) < 0/);
  assert.match(lostFoundInitializer,
    /open_beneath\(gate_fd, WORKSPACE_DATA_NAME,\s*O_PATH \| O_DIRECTORY \| O_CLOEXEC \| O_NOFOLLOW\)/,
    "the broker must bind inaccessible root-owned lost+found data with metadata-only O_PATH");
  assert.match(lostFoundInitializer,
    /exact_lost_found_gate\(parent_fd, gate_fd, data_fd, expected_device, 0700\)/);
  assert.doesNotMatch(lostFoundInitializer, /exact_lost_found_at|"lost\+found"/,
    "the private gate contains exactly data; startup must not require a nested lost+found entry");
  assert.match(broker,
    /static int exact_lost_found_gate[\s\S]*directory_has_exact_names\(gate_fd, only_data, 1U\)/,
    "lost+found gates must reject missing or extra entries");
  assert.match(broker, /reconcile_runtime_generation_links[\s\S]*symlinkat\(target, runtime_fd, entry->d_name\)/);
  assert.match(broker, /remove_runtime_generation_link\(generation\)[\s\S]*remove_named_runtime_tree\(runtime_retained_fd, generation\)/);
  for (const fixture of ["lstatSync", "readlinkSync", "statSync", "accessSync", "readdirSync",
    "selected-wrapper-lstat-mode-owner", "sibling-wrapper-lstat-mode-owner",
    "workspace-lost-found-shell", "runtime-lost-found-shell", "nonselected-active-runtime-lstat"]) {
    assert.ok(text("gx10-gamefactory/live-gates/live-isolation.mjs").includes(fixture), fixture);
  }
  assert.match(provision, /ensure_relative_link[\s\S]*REVIEWED_RELATIVE_TARGET|ensure_relative_link/);
  assert.match(provision, /chmod 0000 "\$gate"/);
});

test("broker filter and durable artifact ferry remain fail-closed", () => {
  const allows = brokerSeccomp.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW").flatMap((rule) => rule.names || []);
  assert.equal(allows.includes("socket"), false);
  for (const syscall of ["landlock_create_ruleset", "landlock_add_rule", "landlock_restrict_self", "pidfd_open", "pidfd_send_signal", "waitid"]) {
    assert.equal(allows.includes(syscall), true, syscall);
  }
  assert.equal(allows.includes("symlinkat"), true,
    "the broker must be able to publish/recover exact generation indirection links");
  for (const required of ["MAX_ARTIFACTS 32U", "MAX_ARTIFACT_BYTES (64U * 1024U * 1024U)",
    "MAX_TOTAL_ARTIFACT_BYTES (64U * 1024U * 1024U)", "publish_artifact_ferry", "artifact-%s-%u.bin",
    "bounded broker artifact ferry failed closed", "durable_at(results_fd, manifest_name"]) {
    assert.ok(broker.includes(required), required);
  }
});

test("payload ioctl surface is limited to Node's inherited output pipes", () => {
  assert.match(childSeccomp,
    /seccomp_rule_add\(context, SCMP_ACT_ALLOW, number, 2,[\s\S]*?SCMP_A0\(SCMP_CMP_EQ, descriptor\), SCMP_A1\(SCMP_CMP_EQ, FIONBIO\)/);
  assert.match(childSeccomp, /allow_stdio_nonblock\(context, STDOUT_FILENO\)/);
  assert.match(childSeccomp, /allow_stdio_nonblock\(context, STDERR_FILENO\)/);
  assert.doesNotMatch(childSeccomp, /"ioctl"[^;\n]*[,}]/,
    "ioctl must not enter an unconditional syscall allowlist");
});

test("service seccomp profiles constrain clone and deny process inspection and broker networking", () => {
  for (const profile of [controllerSeccomp, brokerSeccomp]) {
    const allows = profile.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW");
    assert.equal(allows.some((rule) => rule.names?.includes("clone") && !(rule.args || []).length), false);
    assert.equal(allows.some((rule) => rule.names?.includes("clone") && rule.args?.some((arg) => arg.op === "SCMP_CMP_MASKED_EQ")), true);
    const clone3 = profile.syscalls.find((rule) => rule.names?.includes("clone3"));
    assert.equal(clone3?.action, "SCMP_ACT_ERRNO");
    assert.equal(clone3?.errnoRet, 38);
    for (const forbidden of ["ptrace", "process_vm_readv", "process_vm_writev", "socketcall", "keyctl", "add_key", "request_key"]) {
      assert.equal(allows.some((rule) => rule.names?.includes(forbidden)), false, `${forbidden} is allowed`);
    }
  }
  const brokerAllows = brokerSeccomp.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW");
  assert.equal(brokerAllows.some((rule) => rule.names?.includes("socket")), false);
  const controllerFamilies = controllerSeccomp.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW"
    && rule.names?.includes("socket")).map((rule) => rule.args?.[0]?.value).sort((a, b) => a - b);
  assert.deepEqual(controllerFamilies, [2, 10, 16]);
});

test("compiled policy bytes, spool bounds, and additive provisioning stay explicit", () => {
  const expectedPolicy = "DGF-POLICY-01\n"
    + "capabilities=quality_assurance,godot\nprograms=node,godot\n"
    + "project_subtree=fixed-portfolio-plus-system-canary\nmax_steps=24\nmax_timeout_ms=1800000\n"
    + "max_total_log_bytes=1048576\nnode_inline_eval=deny\nnode_response_files=deny\n"
    + "godot_export_preset=Web\nrequest_generation=exact-broker-instance-and-container\n"
    + "retention_ack=durable-terminal-only\n"
    + "retention_unresolved=preserve\nretention_artifacts=verify-before-prune\n"
    + "android=disabled\nrelease_writes=disabled\n";
  assert.equal(policy, expectedPolicy);
  assert.match(broker, /memcmp\(bytes, reviewed_deployment_policy, used\)/);
  assert.match(broker, /MAX_SCAN_FILES\s+16384U/);
  assert.match(broker, /MAX_RETAINED_GENERATIONS\s+256U/);
  assert.match(broker, /process_retention_acks\(\);[\s\S]*cleanup_consumed_prune_receipts\(\);[\s\S]*process_file/);
  assert.match(broker, /result_is_acknowledgeable[\s\S]*child_reaped_unmeasured[\s\S]*never_started/);
  assert.match(broker, /publish_prune_receipt[\s\S]*cleanup_acknowledged_generation/);
  assert.match(broker,
    /state_prefixes\[\] = \{ "accepted", "started", "ready" \}[\s\S]*unlink_owned_optional\(state_fd/,
    "terminal acknowledgement must prune its measured ready record");
  assert.match(broker,
    /generation_has_ready_reference[\s\S]*"request", "ack", "cancel"[\s\S]*"accepted", "started"[\s\S]*"result", "pruned", "artifacts", "stdout", "stderr"[\s\S]*ready record and retained runtime are both derived/,
    "startup ready cleanup must preserve every exact unresolved/current/artifact lineage reference");
  const readyReferenceBody = /static int generation_has_ready_reference[\s\S]*?\n}/.exec(broker)?.[0] || "";
  assert.doesNotMatch(readyReferenceBody, /runtime_directory_exists|runtime_generation_link_state/,
    "derived ready and runtime records must not circularly pin one another");
  assert.match(broker,
    /recover_inflight\(\);[\s\S]*cleanup_orphan_ready_records\(\);[\s\S]*sweep_orphan_runtime_generations\(\);/,
    "legacy orphan ready records must be bounded before readiness publication");
  assert.match(broker,
    /static int generation_is_pruned[\s\S]*parse_prune_receipt[\s\S]*strcmp\(receipt[.]generation, generation\)/);
  assert.match(broker,
    /process_file[\s\S]*generation_is_pruned\(generation\)[\s\S]*if \(pruned != 0\) return pruned > 0 \? 0 : -1;[\s\S]*result-%s[.]bin/,
    "a durable prune receipt must block stale request re-admission before result lookup");
  assert.match(broker,
    /ack-%s[.]bin[\s\S]*request-%s[.]bin[\s\S]*if \(faccessat\(requests_fd, request_name, F_OK, AT_EACCESS\) == 0\) continue;/,
    "a prune receipt must remain durable while either acknowledgement or request bytes remain");
  assert.match(broker, /request spool exceeds absolute file bound/);
  assert.match(broker, /broker state exceeds file bound/);
  assert.match(broker, /lease-%s[.]lock[\s\S]*O_CREAT \| O_EXCL[\s\S]*per-generation durable broker lifetime flock/);
  assert.match(broker, /cleanup_old_generation_leases[\s\S]*after[.]st_nlink != 0/);
  assert.match(broker, /strcmp\(request[.]broker_instance_id, broker_instance\)[\s\S]*strcmp\(request[.]container_generation_id, container_generation\)/);
  assert.match(broker, /broker_generation_mismatch/);
  assert.match(broker, /revoke_readiness_best_effort\(\);[\s\S]*return 0;/);
  assert.match(provision, /REVIEWED ADDITIVE PROVISIONING ONLY/);
  for (const capacity of ["commands_bytes=134217728", "state_bytes=268435456", "results_bytes=1073741824"]) {
    assert.match(provision, new RegExp(capacity));
  }
  assert.match(provision, /bounded storage targets do not have distinct filesystem devices/);
  assert.match(provision, /actual_id=.*awk '\{print \$1\}'/);
  assert.match(provision, /flags=.*awk '\{print \$2\}'/);
  assert.match(provision, /mv --no-copy -T "\$probe"/);
  const executableProvision = provision.split("\n")
    .filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(executableProvision, /\brm\b|\btruncate\b/);
  assert.match(executableProvision, /if \[ ! -e "\$image" \]; then[\s\S]*?mkfs[.]ext4[\s\S]*?\n\s*else\n/);
});

test("live quota probes cross the exact provisioned canary limits while remaining bounded", () => {
  const provisioned = /configure_workspace_project system-canary 10001 (\d+) (\d+)/.exec(provision);
  const fixtureBlocks = /REVIEWED_PROJECT_BLOCK_LIMIT_KIB = ([\d_]+);/.exec(quotaFixture);
  const fixtureInodes = /REVIEWED_PROJECT_INODE_LIMIT = ([\d_]+);/.exec(quotaFixture);
  assert.ok(provisioned && fixtureBlocks && fixtureInodes);
  const numeric = (value) => Number(value.replaceAll("_", ""));
  assert.equal(numeric(fixtureBlocks[1]), Number(provisioned[1]));
  assert.equal(numeric(fixtureInodes[1]), Number(provisioned[2]));
  assert.match(quotaFixture,
    /BLOCK_WRITE_LIMIT = Math[.]ceil\(\(REVIEWED_PROJECT_BLOCK_LIMIT_KIB \* 1024\) \/ BLOCK_CHUNK_BYTES\) \+ 1/);
  assert.match(quotaFixture, /INODE_CREATE_LIMIT = REVIEWED_PROJECT_INODE_LIMIT \+ 1/);
  assert.doesNotMatch(quotaFixture, /count < (?:128|20_000)/);
  assert.match(quotaFixture, /\["EDQUOT", "ENOSPC"\][.]includes\(code\)/);
  assert.match(quotaFixture, /\[-122, -28, 122, 28\][.]includes\(errno\)/);
  assert.match(quotaFixture, /UNKNOWN alone is[\s\S]*never accepted as quota evidence/);
  assert.equal((liveGate.match(/args: \["live-quota[.]mjs"/g) || []).length, 2);
  assert.equal((liveGate.match(/args: \["live-quota[.]mjs"[\s\S]{0,120}?timeoutMs: 600_000/g) || []).length, 2);
  assert.match(liveGate, /name === "quota_blocks" \|\| name === "quota_inodes"/);
  assert.match(liveGate,
    /command === "ack-once"[\s\S]*controller[.]acknowledge\(name\)[\s\S]*if \(!value[.]ok\) process[.]exitCode = 1/,
    "the live crash-window gate needs a single non-polling acknowledgement transition");
  assert.match(liveGate,
    /"--path", "godot-canary", "--export-release", "Web",\s*"dist\/index[.]html"[\s\S]*collect: \[[\s\S]*"godot-canary\/dist\/index[.]wasm"/,
    "the Godot export target is project-relative while collection remains workspace-relative");
  for (const artifact of ["index.apple-touch-icon.png", "index.audio.position.worklet.js",
    "index.audio.worklet.js", "index.html", "index.icon.png", "index.js", "index.pck",
    "index.png", "index.wasm"]) {
    assert.ok(liveGate.includes(`godot-canary/dist/${artifact}`), `missing Godot Web artifact ${artifact}`);
  }
  assert.match(brokerProtocol,
    /BROKER_MAX_ARTIFACT_BYTES = 64 \* 1024 \* 1024;[\s\S]*BROKER_MAX_TOTAL_ARTIFACT_BYTES = 64 \* 1024 \* 1024;/,
    "controller and broker must share the bounded full Godot Web bundle cap");
  assert.doesNotMatch(liveGate,
    /"--path", "godot-canary"[\s\S]{0,160}"godot-canary\/dist\/index[.]html"\], cwdRelative/);
});

console.log(`\n${passed} active broker static checks passed`);
