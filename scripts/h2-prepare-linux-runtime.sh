#!/usr/bin/env bash
# Prepare, but never start, the real Linux controller and sandbox inputs for H2.
#
# This is intentionally a host-only operator.  It rejects every machine except the
# disposable H2 executor and requires --apply before it writes node_modules, Docker
# images, or the non-secret input receipt.  It never reads custody/configuration files,
# starts a controller, pushes an image, or receives a credential as an argument.
set -euo pipefail

readonly H2_INSTANCE_ID='i-00000000000000000'
readonly H2_ROOT='/opt/atum/h2-37bb'
readonly MIN_FREE_KIB=$((20 * 1024 * 1024)) # Hermes whole + Chromium need several GiB of build space.
readonly SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: h2-prepare-linux-runtime.sh --source <atum-app-source> --revision <git-sha> [--node <node>] [--source-archive <tar> --archive-sha256 <sha256>] [--apply]

Without --apply, validates this is the H2 executor and prints the exact build inputs.
With --apply, builds only local H2 controller/sandbox artifacts; it does not start a
controller, register a Cloudflare tunnel, push to ECR, or render custody/config files.
EOF
}

die() { printf 'h2-linux-inputs: %s\n' "$*" >&2; exit 2; }

source_dir=''
revision=''
source_archive=''
archive_sha256=''
node_bin="${H2_NODE_BIN:-$H2_ROOT/node-v24.14.0-linux-x64/bin/node}"
apply=0

while (($#)); do
  case "$1" in
    --source) source_dir=${2-}; shift 2 ;;
    --revision) revision=${2-}; shift 2 ;;
    --source-archive) source_archive=${2-}; shift 2 ;;
    --archive-sha256) archive_sha256=${2-}; shift 2 ;;
    --node) node_bin=${2-}; shift 2 ;;
    --apply) apply=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "unknown argument" ;;
  esac
done

[[ -n "$source_dir" && -n "$revision" ]] || { usage >&2; die 'source and revision are required'; }
[[ "$revision" =~ ^[0-9a-f]{10,64}$ ]] || die 'revision must be a lowercase git SHA'
[[ -z "$source_archive" && -z "$archive_sha256" || -n "$source_archive" && -n "$archive_sha256" ]] || die 'source archive and SHA-256 are required together'
[[ -z "$archive_sha256" || "$archive_sha256" =~ ^[0-9a-f]{64}$ ]] || die 'archive SHA-256 must be lowercase hex'
[[ $EUID -eq 0 ]] || die 'run as root through the H2 SSM command path'

assert_h2_instance() {
  command -v curl >/dev/null || die 'curl is required for the H2 identity assertion'
  local token instance
  token=$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    -X PUT 'http://169.254.169.254/latest/api/token' \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60') || die 'cannot obtain H2 IMDSv2 token'
  instance=$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    -H "X-aws-ec2-metadata-token: $token" \
    'http://169.254.169.254/latest/meta-data/instance-id') || die 'cannot read H2 instance identity'
  unset token
  [[ "$instance" == "$H2_INSTANCE_ID" ]] || die 'refusing non-H2 instance'
}

assert_host_prerequisites() {
  [[ $(uname -m) == x86_64 ]] || die 'H2 needs the proven x86_64 runtime'
  [[ -x "$node_bin" ]] || die "Node runtime missing: $node_bin"
  local node_major
  node_major=$($node_bin -p 'process.versions.node.split(".")[0]')
  [[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 22 ]] || die 'Node 22 or newer is required'
  command -v docker >/dev/null || die 'Docker is required'
  docker version --format '{{.Server.Arch}}' 2>/dev/null | grep -qx 'amd64' || die 'Docker server is not amd64'
  [[ -x /usr/bin/runsc ]] || die 'runsc is not installed'
  /usr/bin/runsc --version | grep -qx 'runsc version release-20260921.0' || die 'runsc release differs from the H2 pin'
  docker info --format '{{json .Runtimes}}' | grep -q '"runsc"' || die 'runsc is not registered with Docker'
  [[ $(docker network inspect atum-task --format '{{.Internal}}' 2>/dev/null) == true ]] || die 'the internal atum-task network is absent'
  local free_kib
  free_kib=$(df -Pk /var/lib/docker | awk 'NR == 2 { print $4 }')
  [[ "$free_kib" =~ ^[0-9]+$ && "$free_kib" -ge "$MIN_FREE_KIB" ]] || die 'need at least 20 GiB free under Docker storage'
}

assert_source() {
  [[ -d "$source_dir" ]] || die 'source directory is absent'
  source_dir=$(cd "$source_dir" && pwd -P)
  for file in Dockerfile package.json package-lock.json packages/cloud-controller/package.json \
    packages/cloud-controller/build.mjs packages/cloud-sandbox/Dockerfile; do
    [[ -f "$source_dir/$file" ]] || die "not an atum-app runtime source: missing $file"
  done
  local source_head
  if [[ -n "$source_archive" ]]; then
    [[ ! -e "$source_dir/.git" ]] || die 'archive source must not carry Git metadata'
    python3 "$SCRIPT_DIRECTORY/h2-verify-source-archive.py" \
      "$source_archive" "$archive_sha256" "$source_dir"
  elif [[ -e "$source_dir/.git" ]]; then
    source_head=$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)
    [[ "$source_head" == "$revision" ]] || die 'source Git HEAD does not match requested revision'
    git -C "$source_dir" diff --quiet || die 'source Git worktree has unstaged changes'
    git -C "$source_dir" diff --cached --quiet || die 'source Git worktree has staged changes'
    [[ -z $(git -C "$source_dir" status --porcelain --untracked-files=all) ]] || die 'source Git worktree has untracked changes'
  else
    die 'source must be a clean Git checkout or a SHA-256-verified archive input'
  fi
}

print_plan() {
  cat <<EOF
H2 Linux runtime preparation
  host: $H2_INSTANCE_ID (x86_64)
  source: $source_dir
  revision: $revision
  archive: ${source_archive:-clean Git checkout}${archive_sha256:+ (SHA-256: $archive_sha256)}
  node: $node_bin ($($node_bin --version))
  controller: packages/cloud-controller/dist/{cloud-controller,engine-host,engine-child}.mjs
  Hermes base tag: atum/h2-hermes:$revision
  sandbox tag: atum/h2-cloud-sandbox:$revision

Build inputs are the source root's exact package-lock.json, the controller workspace's
external production dependencies under source/node_modules, and the root Dockerfile plus
packages/cloud-sandbox/Dockerfile.  The sandbox has no host bind mounts, Docker socket,
privileges, or published ports.  It must use Docker runtime runsc and the internal atum-task
network; the trusted controller is the only process with Docker-socket access.

Remaining first-turn inputs are deliberately outside this script: synthetic-realm public
Matrix TLS endpoint, H2 DA/gateway URLs, private 0600 controller custody files, a pinned local
sandbox image ID in the H2 controller configuration, and the e2e harness's ephemeral CA/S3
stand-in settings.  Do not use production endpoints or a tagged image in configuration.
EOF
}

build_inputs() {
  local npm_bin=${node_bin%/node}/npm
  [[ -x "$npm_bin" ]] || die "npm beside selected Node is missing: $npm_bin"
  export PATH="${node_bin%/node}:$PATH"
  local hermes_tag="atum/h2-hermes:$revision"
  local sandbox_tag="atum/h2-cloud-sandbox:$revision"

  # The controller build keeps matrix-js-sdk, crypto WASM and AWS SDK packages external.
  # This focused workspace install is therefore a prerequisite, not an optional dev cache.
  (
    cd "$source_dir"
    "$npm_bin" ci --ignore-scripts --workspace @atum/cloud-controller --include-workspace-root
    "$npm_bin" run build --workspace @atum/cloud-controller
  )
  for artifact in cloud-controller.mjs engine-host.mjs engine-child.mjs; do
    [[ -s "$source_dir/packages/cloud-controller/dist/$artifact" ]] || die "controller bundle missing: $artifact"
  done

  docker build --build-arg "HERMES_GIT_SHA=$revision" --tag "$hermes_tag" "$source_dir"
  docker build -f "$source_dir/packages/cloud-sandbox/Dockerfile" \
    --build-arg "HERMES_IMAGE=$hermes_tag" --tag "$sandbox_tag" "$source_dir"

  local image_id image_platform receipt archive_field=''
  image_id=$(docker image inspect --format '{{.Id}}' "$sandbox_tag")
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'sandbox image did not yield a content ID'
  image_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$sandbox_tag")
  [[ "$image_platform" == linux/amd64 ]] || die "sandbox image platform is $image_platform, expected linux/amd64"

  # This starts no Hermes process: it only proves the pinned gVisor image can exec its fixed
  # Python entrypoint dependencies on the exact Docker runtime and internal bridge.
  docker run --rm --runtime runsc --network atum-task --read-only \
    --tmpfs /task:exec,nosuid,nodev,mode=0700,uid=10001,gid=10001 \
    --tmpfs /tmp:exec,nosuid,nodev,mode=1777 \
    --entrypoint /bin/sh "$sandbox_tag" -c \
    'test -x /opt/hermes/.venv/bin/python3 && test -f /opt/atum/task_entrypoint.py && test -s /opt/atum/agent-browser-executable'

  umask 077
  mkdir -p -m 0700 "$H2_ROOT/runtime/linux-inputs"
  receipt="$H2_ROOT/runtime/linux-inputs/$revision.json"
  if [[ -n "$source_archive" ]]; then
    archive_field=$(printf ',\n  "sourceArchiveSha256": "%s"' "$archive_sha256")
  fi
  printf '{\n  "revision": "%s",\n  "source": "%s",\n  "node": "%s",\n  "sandboxImage": "%s",\n  "sandboxPlatform": "%s"%s\n}\n' \
    "$revision" "$source_dir" "$node_bin" "$image_id" "$image_platform" "$archive_field" >"$receipt"
  printf 'H2 Linux inputs ready; local pinned sandbox image: %s\n' "$image_id"
  printf 'Receipt (no credential material): %s\n' "$receipt"
}

assert_h2_instance
assert_host_prerequisites
assert_source
print_plan
if ((apply)); then
  build_inputs
else
  printf 'Plan only. Re-run with --apply only in the parent-serialized H2 build window.\n'
fi
