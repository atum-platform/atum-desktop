#!/usr/bin/env bash
# Local-only layered acceptance. Does not activate an agent or contact paid providers.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
platform="${ATUM_N6_PLATFORM:?Set ATUM_N6_PLATFORM to a disposable checkout of bb2020225d}"
[[ "$(git -C "$platform" rev-parse HEAD)" == bb2020225ddb595b85b301227e72e376fecb7b59 ]] || {
  echo 'Wrong platform revision' >&2; exit 1;
}
# Dependencies are supplied by the worker environment; never install or change shared-deps.
[[ -x "$root/node_modules/.bin/vitest" && -x "$root/.venv/bin/python" ]] || {
  echo 'Link shared-deps/node_modules and the shared .venv as documented in the N6e session log.' >&2; exit 1;
}
check_disk() {
  df -k /System/Volumes/Data
  [[ "$(df -k /System/Volumes/Data | awk 'NR==2 {print $4}')" -ge 5242880 ]] || {
    echo 'Below 5 GiB worker disk floor' >&2; exit 1;
  }
}
cd "$root"
check_disk
node_modules/.bin/tsc -p packages/cloud-controller --noEmit
node_modules/.bin/tsc -p apps/desktop --noEmit
check_disk
ATUM_N6_REAL_HERMES=1 node_modules/.bin/vitest run --root packages/cloud-controller --maxWorkers=4
check_disk
bash scripts/run_tests.sh tests/cron tests/tui_gateway/test_native_cloud_job.py \
  tests/tui_gateway/test_host_request.py tests/tui_gateway/test_background_sweep.py -j 2
check_disk
(cd "$platform" && bash scripts/test-native-sweep-recovery-native.sh)
check_disk
(cd "$platform" && node --experimental-strip-types --test \
  apps/shell/src/lib/cloud-controller-jobs.test.ts apps/shell/src/lib/cloud-controller-sweeps.test.ts)
echo 'N6_LAYERED_ACCEPTANCE_OK (see session log for remaining cross-system/live gates)'
