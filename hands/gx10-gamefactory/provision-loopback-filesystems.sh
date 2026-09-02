#!/bin/sh
# REVIEWED ADDITIVE PROVISIONING ONLY. This script never deletes, reformats, truncates, or
# replaces an existing file or filesystem. Run as root on GX10 only after profile review.
set -eu

workspace_image=${GX10_WORKSPACE_IMAGE:-/srv/dominion-game-factory/workspace.ext4}
runtime_image=${GX10_RUNTIME_IMAGE:-/srv/dominion-game-factory/runtime.ext4}
commands_image=${GX10_COMMANDS_IMAGE:-/srv/dominion-game-factory/commands.ext4}
state_image=${GX10_BROKER_STATE_IMAGE:-/srv/dominion-game-factory/broker-state.ext4}
results_image=${GX10_RESULTS_IMAGE:-/srv/dominion-game-factory/broker-results.ext4}
workspace_mount=${GX10_GAME_FACTORY_WORKSPACE:-/srv/dominion-game-factory/workspace-loop}
runtime_mount=${GX10_GAME_FACTORY_RUNTIME:-/srv/dominion-game-factory/runtime-loop}
commands_mount=${GX10_GAME_FACTORY_COMMANDS:-/srv/dominion-game-factory/commands-loop}
state_mount=${GX10_GAME_FACTORY_BROKER_STATE:-/srv/dominion-game-factory/broker-state-loop}
results_mount=${GX10_GAME_FACTORY_RESULTS:-/srv/dominion-game-factory/broker-results-loop}
workspace_bytes=8589934592
runtime_bytes=1073741824
commands_bytes=134217728
state_bytes=268435456
results_bytes=1073741824
controller_uid=10001
spool_gid=11000
broker_uid=10003
broker_gid=10003

[ "$(id -u)" -eq 0 ] || { echo "root is required" >&2; exit 78; }
for tool in fallocate findmnt losetup mkfs.ext4 mount mountpoint stat blkid dumpe2fs \
  chattr lsattr setquota quotaon repquota; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing prerequisite: $tool" >&2; exit 78; }
done

for path in "$workspace_image" "$runtime_image" "$commands_image" "$state_image" "$results_image" \
  "$workspace_mount" "$runtime_mount" "$commands_mount" "$state_mount" "$results_mount"; do
  case "$path" in
    /srv/dominion-game-factory/*) ;;
    *) echo "all fixed storage paths must be absolute children of /srv/dominion-game-factory" >&2; exit 78 ;;
  esac
done
all_paths="$workspace_image $runtime_image $commands_image $state_image $results_image $workspace_mount $runtime_mount $commands_mount $state_mount $results_mount"
for left in $all_paths; do
  matches=0
  for right in $all_paths; do [ "$left" != "$right" ] || matches=$((matches + 1)); done
  [ "$matches" -eq 1 ] || { echo "every image and mount target must be distinct" >&2; exit 78; }
done
install -d -o root -g root -m 0755 /srv/dominion-game-factory

prepare_image() {
  image=$1 bytes=$2 label=$3
  if [ ! -e "$image" ]; then
    (umask 077; fallocate -l "$bytes" "$image")
    [ "$(stat -c %s "$image")" = "$bytes" ] || { echo "new image has unexpected size: $image" >&2; exit 78; }
    mkfs.ext4 -q -F -O quota,project -E quotatype=prjquota -L "$label" "$image"
  else
    [ -f "$image" ] && [ ! -L "$image" ] || { echo "existing image is not a regular non-symlink file: $image" >&2; exit 78; }
    [ "$(stat -c %s "$image")" = "$bytes" ] || { echo "existing image size differs; refusing to resize: $image" >&2; exit 78; }
    [ "$(blkid -s TYPE -o value "$image")" = ext4 ] || { echo "existing image is not ext4; refusing to format: $image" >&2; exit 78; }
  fi
  features=$(dumpe2fs -h "$image" 2>/dev/null | sed -n 's/^Filesystem features:[[:space:]]*//p')
  for feature in quota project; do
    case " $features " in *" $feature "*) ;; *) echo "$image lacks ext4 feature $feature" >&2; exit 78 ;; esac
  done
  chmod 0600 "$image"
}

mount_image() {
  image=$1 target=$2 owner=$3 group=$4 mode=$5
  install -d -o root -g root -m 0755 "$target"
  if mountpoint -q "$target"; then
    source=$(findmnt -rn -M "$target" -o SOURCE)
    backing=$(losetup -j "$image" | sed -n '1{s/:.*//;p;}')
    [ -n "$backing" ] && [ "$source" = "$backing" ] || { echo "mount target is already occupied by another source: $target" >&2; exit 78; }
  else
    loop=$(losetup -j "$image" | sed -n '1{s/:.*//;p;}')
    [ -n "$loop" ] || loop=$(losetup --find --show "$image")
    mount -o rw,noexec,nosuid,nodev,prjquota "$loop" "$target"
  fi
  [ "$(findmnt -rn -M "$target" -o TARGET)" = "$target" ] || {
    echo "$target is not an exact mountpoint" >&2; exit 78;
  }
  options=$(findmnt -rn -M "$target" -o OPTIONS)
  for required in rw noexec nosuid nodev prjquota; do
    case ",$options," in *,$required,*) ;; *) echo "$target lacks mount flag $required" >&2; exit 78 ;; esac
  done
  [ "$(findmnt -rn -M "$target" -o FSTYPE)" = ext4 ] || { echo "$target is not ext4" >&2; exit 78; }
  chown "$owner:$group" "$target"
  chmod "$mode" "$target"
}

prepare_image "$workspace_image" "$workspace_bytes" dominion-gf-work
prepare_image "$runtime_image" "$runtime_bytes" dominion-gf-run
prepare_image "$commands_image" "$commands_bytes" dom-gf-cmd
prepare_image "$state_image" "$state_bytes" dom-gf-state
prepare_image "$results_image" "$results_bytes" dom-gf-results
mount_image "$workspace_image" "$workspace_mount" "$broker_uid" "$broker_gid" 0700
mount_image "$runtime_image" "$runtime_mount" "$broker_uid" "$broker_gid" 0700
mount_image "$commands_image" "$commands_mount" "$controller_uid" "$spool_gid" 2750
mount_image "$state_image" "$state_mount" "$broker_uid" "$broker_gid" 0700
mount_image "$results_image" "$results_mount" "$broker_uid" "$spool_gid" 2750

for left in "$workspace_mount" "$runtime_mount" "$commands_mount" "$state_mount" "$results_mount"; do
  left_device=$(stat -c %d "$left")
  for right in "$workspace_mount" "$runtime_mount" "$commands_mount" "$state_mount" "$results_mount"; do
    [ "$left" = "$right" ] && continue
    [ "$left_device" != "$(stat -c %d "$right")" ] || {
      echo "bounded storage targets do not have distinct filesystem devices: $left and $right" >&2; exit 78;
    }
  done
done

configure_project() {
  volume=$1 relative=$2 project_id=$3 block_limit=$4 inode_limit=$5
  project_path=$volume/$relative
  install -d -o "$broker_uid" -g "$broker_gid" -m 0700 "$project_path"
  chattr -p "$project_id" +P "$project_path"
  attributes=$(lsattr -dp "$project_path")
  # e2fsprogs `lsattr -p` prepends the numeric project ID, followed by flags.
  # Keep the columns explicit so a valid projid+P directory cannot fail closed
  # (or, worse, let a malformed output be compared against the wrong field).
  actual_id=$(printf '%s\n' "$attributes" | awk '{print $1}')
  flags=$(printf '%s\n' "$attributes" | awk '{print $2}')
  case "$flags" in *P*) ;; *) echo "$project_path lacks inherited project quota attribute P" >&2; exit 78 ;; esac
  [ "$actual_id" = "$project_id" ] || { echo "$project_path has project ID $actual_id, expected $project_id" >&2; exit 78; }
  setquota -P "$project_id" "$block_limit" "$block_limit" "$inode_limit" "$inode_limit" "$volume"
}

ensure_relative_link() {
  parent=$1 name=$2 target=$3
  link_path=$parent/$name
  if [ ! -e "$link_path" ] && [ ! -L "$link_path" ]; then
    ln -s "$target" "$link_path"
    chown -h "$broker_uid:$broker_gid" "$link_path"
  fi
  [ -L "$link_path" ] && [ "$(readlink "$link_path")" = "$target" ] \
    && [ "$(stat -c %u:%g:%a:%h "$link_path")" = "$broker_uid:$broker_gid:777:1" ] || {
    echo "fixed public indirection link differs: $link_path" >&2; exit 78;
  }
}

preflight_relative_link_slot() {
  parent=$1 name=$2 target=$3
  link_path=$parent/$name
  if [ -e "$link_path" ] || [ -L "$link_path" ]; then
    [ -L "$link_path" ] && [ "$(readlink "$link_path")" = "$target" ] || {
      echo "public indirection slot is occupied by a non-reviewed entry: $link_path" >&2; exit 78;
    }
  fi
}

configure_workspace_project() {
  slug=$1 project_id=$2 block_limit=$3 inode_limit=$4
  install -d -o "$broker_uid" -g "$broker_gid" -m 0700 "$workspace_mount/.projects/$slug"
  configure_project "$workspace_mount" ".projects/$slug/data" "$project_id" "$block_limit" "$inode_limit"
  ensure_relative_link "$workspace_mount" "$slug" ".projects/$slug/data"
}

prepare_lost_found_gate() {
  volume=$1 private_parent=$2 public_parent=$3 public_target=$4
  gate=$private_parent/lost-found-gate
  data=$gate/data
  install -d -o "$broker_uid" -g "$broker_gid" -m 0700 "$gate"
  if [ ! -e "$data" ]; then
    source=$volume/lost+found
    [ -d "$source" ] && [ ! -L "$source" ] \
      && [ "$(stat -c %u:%g:%a "$source")" = "0:0:700" ] \
      && [ -z "$(find "$source" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
      echo "lost+found is not an exact empty fresh-filesystem directory: $source" >&2; exit 78;
    }
    mv -T "$source" "$data"
  fi
  [ -d "$data" ] && [ ! -L "$data" ] \
    && [ "$(stat -c %u:%g:%a "$data")" = "0:0:700" ] || {
    echo "private lost+found data identity differs: $data" >&2; exit 78;
  }
  ensure_relative_link "$public_parent" lost+found "$public_target"
}

# Every reviewed project is provisioned here with a fixed ext4 project ID. The immutable canary and
# its inaccessible sibling retain a separate 1-GiB boundary; each portfolio project is capped at
# 512 MiB/65536 inodes. The runtime payload subtree also gets its own project-quota identity on the
# separate bounded runtime volume. The static broker refuses any unlisted ID or subtree.
quotaon -P "$workspace_mount" 2>/dev/null || true
quotaon -P "$runtime_mount" 2>/dev/null || true
for slug in system-canary system-canary-sibling vector-vault bolt-bloom pocket-gravity \
  chromalock tiny-foundry letter-loom pulse-path shelf-shift wobble-works signal-grid; do
  preflight_relative_link_slot "$workspace_mount" "$slug" ".projects/$slug/data"
done
preflight_relative_link_slot "$runtime_mount/payload" retained ".private/retained-gate/data"
preflight_relative_link_slot "$runtime_mount/payload" system-canary-sibling ".private/sibling-gate/data"
install -d -o "$broker_uid" -g "$broker_gid" -m 0700 "$workspace_mount/.projects"
configure_workspace_project system-canary 10001 1048576 131072
configure_workspace_project system-canary-sibling 10002 1048576 131072
configure_workspace_project vector-vault 10101 524288 65536
configure_workspace_project bolt-bloom 10102 524288 65536
configure_workspace_project pocket-gravity 10103 524288 65536
configure_workspace_project chromalock 10104 524288 65536
configure_workspace_project tiny-foundry 10105 524288 65536
configure_workspace_project letter-loom 10106 524288 65536
configure_workspace_project pulse-path 10107 524288 65536
configure_workspace_project shelf-shift 10108 524288 65536
configure_workspace_project wobble-works 10109 524288 65536
configure_workspace_project signal-grid 10110 524288 65536
prepare_lost_found_gate "$workspace_mount" "$workspace_mount/.projects" "$workspace_mount" \
  ".projects/lost-found-gate/data"
workspace_isolation_sentinel=$workspace_mount/.projects/system-canary-sibling/data/isolation-sentinel.txt
if [ ! -e "$workspace_isolation_sentinel" ]; then
  (umask 077; printf '%s\n' 'GX10_GAME_FACTORY_WORKSPACE_SIBLING_DENY' > "$workspace_isolation_sentinel")
  chown "$broker_uid:$broker_gid" "$workspace_isolation_sentinel"
fi
[ -f "$workspace_isolation_sentinel" ] && [ ! -L "$workspace_isolation_sentinel" ] \
  && [ "$(stat -c %u:%g:%a "$workspace_isolation_sentinel")" = "$broker_uid:$broker_gid:600" ] || {
  echo "workspace isolation sentinel metadata differs from the reviewed fixture" >&2; exit 78;
}
configure_project "$runtime_mount" payload 12001 1048576 131072
configure_project "$runtime_mount" payload/active 12001 1048576 131072
install -d -o "$broker_uid" -g "$broker_gid" -m 0700 "$runtime_mount/payload/.private"
install -d -o "$broker_uid" -g "$broker_gid" -m 0700 \
  "$runtime_mount/payload/.private/retained-gate" \
  "$runtime_mount/payload/.private/sibling-gate"
configure_project "$runtime_mount" payload/.private/retained-gate/data 12001 1048576 131072
configure_project "$runtime_mount" payload/.private/sibling-gate/data 12001 1048576 131072
ensure_relative_link "$runtime_mount/payload" retained ".private/retained-gate/data"
ensure_relative_link "$runtime_mount/payload" system-canary-sibling ".private/sibling-gate/data"
prepare_lost_found_gate "$runtime_mount" "$runtime_mount/payload/.private" "$runtime_mount" \
  "payload/.private/lost-found-gate/data"
runtime_isolation_sentinel=$runtime_mount/payload/.private/sibling-gate/data/isolation-sentinel.txt
if [ ! -e "$runtime_isolation_sentinel" ]; then
  (umask 077; printf '%s\n' 'GX10_GAME_FACTORY_RUNTIME_SIBLING_DENY' > "$runtime_isolation_sentinel")
  chown "$broker_uid:$broker_gid" "$runtime_isolation_sentinel"
fi
[ -f "$runtime_isolation_sentinel" ] && [ ! -L "$runtime_isolation_sentinel" ] \
  && [ "$(stat -c %u:%g:%a "$runtime_isolation_sentinel")" = "$broker_uid:$broker_gid:600" ] || {
  echo "runtime isolation sentinel metadata differs from the reviewed fixture" >&2; exit 78;
}
quota_report=$(repquota -P -n -O csv "$workspace_mount")
for project_id in 10001 10002 10101 10102 10103 10104 10105 10106 10107 10108 10109 10110; do
  printf '%s\n' "$quota_report" | grep -Eq "(^|,)#?$project_id(,|$)" || {
    echo "project quota $project_id is absent from the enforced quota report" >&2; exit 78;
  }
done
runtime_quota_report=$(repquota -P -n -O csv "$runtime_mount")
printf '%s\n' "$runtime_quota_report" | grep -Eq "(^|,)#?12001(,|$)" || {
  echo "runtime project quota 12001 is absent from the enforced quota report" >&2; exit 78;
}

# Command, broker-state, and result spools are separate bounded ext4 filesystems. Their capacity is
# the retention backstop: the broker refuses new work at its file-count bound and no spool can fill
# the host root filesystem or either mutable payload filesystem.

probe=$workspace_mount/.projects/system-canary/data/.project-quota-boundary-probe
if [ ! -e "$probe" ]; then
  (umask 077; : > "$probe")
  chown "$broker_uid:$broker_gid" "$probe"
fi
if ln "$probe" "$workspace_mount/.projects/system-canary-sibling/data/forbidden-hardlink" 2>/dev/null; then
  echo "cross-project hardlink unexpectedly succeeded" >&2; exit 78
fi
# GNU mv otherwise converts the kernel's EXDEV isolation result into a copy+unlink
# and returns success. `--no-copy` makes this a true rename-boundary assertion.
if mv --no-copy -T "$probe" "$workspace_mount/.projects/system-canary-sibling/data/forbidden-rename" 2>/dev/null; then
  echo "cross-project rename unexpectedly succeeded" >&2; exit 78
fi
[ -f "$probe" ] || { echo "project quota rename test lost its source" >&2; exit 78; }

# These broker-owned gates are the metadata-isolation boundary for same-UID payloads. They are
# opened and inode-bound only by PID1 before startup resets them to mode 0000; public names remain
# fixed relative symlinks whose targets contain no secret material.
for gate in "$workspace_mount/.projects"/* "$runtime_mount/payload/.private"/*; do
  [ -d "$gate" ] && [ ! -L "$gate" ] || { echo "DAC gate is not an exact directory: $gate" >&2; exit 78; }
  chown "$broker_uid:$broker_gid" "$gate"
  chmod 0000 "$gate"
done

echo "GX10 fixed storage is mounted: workspace=8GiB runtime=1GiB commands=128MiB broker-state=256MiB results=1GiB; all five are distinct ext4 devices with rw,noexec,nosuid,nodev,prjquota; fixed portfolio IDs 10101-10110 and system-canary 10001 are enforced" >&2
