#!/usr/bin/env bash
# N4-N6 one-occurrence end-to-end acceptance (review 2026-11-01), one command:
#
#   ATUM_N6_PLATFORM=/path/to/atum-platform-checkout bash scripts/test-native-scheduling-e2e.sh
#
# Disposable native PostgreSQL 17 with every platform migration through 0385, the platform Shell's
# real controller routes in process, the controller's real scheduling/sweep/turn/outbox code, and a
# local task sandbox running the image's own hydrate/export helpers plus `hermes serve`
# (packages/cloud-controller/test/native-scheduling-seam.test.ts). Local only: no container, no
# network service beyond loopback, no paid model, no dependency install.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
platform="${ATUM_N6_PLATFORM:?Set ATUM_N6_PLATFORM to an atum-platform checkout containing 0385}"
pg_bin="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
port="${ATUM_N6_E2E_PORT:-55531}"
[[ -f "$platform/supabase/migrations/0385_native_sweep_arm_liveness.sql" ]] || { echo 'platform checkout lacks 0385' >&2; exit 1; }
[[ -x "$root/node_modules/.bin/vitest" && -x "$root/.venv/bin/python" && -d "$platform/node_modules" ]] || {
  echo 'Link app node_modules + .venv and platform node_modules (worker rules); nothing is installed here.' >&2; exit 1; }
[[ "$(df -k /System/Volumes/Data | awk 'NR==2 {print $4}')" -ge 5242880 ]] || { echo 'Below 5 GiB disk floor' >&2; exit 1; }

scratch="$(mktemp -d "${TMPDIR:-/tmp}/atum-n6-e2e.XXXXXX")"
started=false
overlay=()
cleanup() {
  if [[ "$started" == true ]]; then "$pg_bin/pg_ctl" -D "$scratch/data" -m immediate stop >/dev/null 2>&1 || true; fi
  for path in "${overlay[@]:-}"; do [[ -n "$path" ]] && rm -rf "$path"; done
  find "$scratch" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# The Shell must import this checkout's protocol build, not the older one linked in shared-deps.
shared_root="$(cd "$platform/node_modules" && pwd -P)/.."
shared_shell="$shared_root/apps/shell/node_modules"
if [[ ! -e "$platform/apps/shell/node_modules" && -d "$shared_shell" ]]; then
  mkdir -p "$platform/apps/shell/node_modules/@atum"; overlay+=("$platform/apps/shell/node_modules")
  for entry in "$shared_shell"/* "$shared_shell"/.bin; do
    name="$(basename "$entry")"; [[ "$name" == '@atum' ]] && continue
    ln -s "$entry" "$platform/apps/shell/node_modules/$name"
  done
  ln -s "$platform/packages/protocol" "$platform/apps/shell/node_modules/@atum/protocol"
fi
shared_protocol="$shared_root/packages/protocol/node_modules"
if [[ ! -e "$platform/packages/protocol/node_modules" && -d "$shared_protocol" ]]; then
  ln -s "$shared_protocol" "$platform/packages/protocol/node_modules"; overlay+=("$platform/packages/protocol/node_modules")
fi

if "$pg_bin/pg_isready" -h 127.0.0.1 -p "$port" >/dev/null 2>&1; then echo "refusing occupied port $port" >&2; exit 1; fi
export LC_ALL=C
"$pg_bin/initdb" -D "$scratch/data" -A trust --no-locale -E UTF8 >"$scratch/init.log" 2>&1
"$pg_bin/pg_ctl" -D "$scratch/data" -l "$scratch/start.log" -o "-h 127.0.0.1 -p $port -c timezone=UTC" -w start >/dev/null
started=true
psql=("$pg_bin/psql" -X -q -h 127.0.0.1 -p "$port" -d postgres -v ON_ERROR_STOP=1)
"${psql[@]}" -f "$platform/scripts/cloud-native-bootstrap.sql" >"$scratch/bootstrap.log"
count=0
for source in "$platform"/supabase/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  name="$(basename "$source")"; [[ "${name:0:4}" > 0385 ]] && continue
  # This controller build vendors cloud-execution/1.14 (managed line-up policy 2026-10-17.1). The 64K/140K
  # successor policy (0366, no rollback) needs the separate controller fix on fix/controller-model-limits,
  # which is not part of N4-N6. Replay without it unless ATUM_N6_KEEP_0366=1.
  if [[ "$name" == 0366_* && "${ATUM_N6_KEEP_0366:-}" != 1 ]]; then echo "N6_E2E_SKIPPED $name"; continue; fi
  migration="$source"
  if [[ "$name" == 0013_specialist_turn_dispatch.sql ]]; then
    sed '/^create extension if not exists pg_net /d; /^create extension if not exists pg_cron;/d' "$source" >"$scratch/0013.sql"
    migration="$scratch/0013.sql"
  fi
  "${psql[@]}" -1 -f "$migration" >"$scratch/replay.log" 2>&1 || { echo "replay failed: $name" >&2; tail -60 "$scratch/replay.log" >&2; exit 1; }
  count=$((count + 1))
done
echo "N6_E2E_REPLAY_OK migrations=$count max=0385"

report="$scratch/report.md"
status=0
(cd "$root" && ATUM_N6_SEAM_DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$port/postgres" ATUM_N6_SEAM_PLATFORM="$platform" \
  ATUM_N6_SEAM_REPORT="$report" ATUM_N6_SEAM_TRACE="${ATUM_N6_SEAM_TRACE:-}" node_modules/.bin/vitest run --root packages/cloud-controller test/native-scheduling-seam.test.ts \
  --maxWorkers=1) || status=$?
echo
echo 'N4-N6 one-occurrence end-to-end (PG17 → Shell → controller → real Hermes → outbox):'
[[ -f "$report" ]] && cat "$report" || echo '(no report written)'
[[ "$status" == 0 ]] && echo 'N6_E2E_OK' || echo "N6_E2E_FAILED exit=$status"
exit "$status"
