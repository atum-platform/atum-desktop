#!/usr/bin/env bash
# A-GUARD/SP-5: real kernel + installed binary + public package proxy proof.
# Writes only throwaway canaries and ignored build/proof output. No owner keys.
set -euo pipefail

task_repo_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$task_repo_root/apps/desktop"
[[ $(uname -s) == Darwin ]] || { echo 'seatbelt proof requires macOS' >&2; exit 1; }
command -v node >/dev/null
command -v npm >/dev/null
[[ -x /usr/bin/sandbox-exec ]] || { echo 'sandbox-exec missing' >&2; exit 1; }

# Refuse the scratch symlink called out in the coordinator handoff, drifted
# versions, and missing dependencies; the proof never installs them implicitly.
node --input-type=module <<'JS'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('proof requires Node 24')
const require = createRequire(resolve('electron/matrix/device/seatbelt.ts'))
// require.resolve follows package symlinks; inspect the lexical lookup entry first.
const root = require.resolve.paths('@anthropic-ai/sandbox-runtime')
  .map(dir => join(dir, '@anthropic-ai/sandbox-runtime'))
  .find(dir => existsSync(join(dir, 'package.json')))
if (!root || lstatSync(root).isSymbolicLink()) throw new Error('srt scratch symlink is not a pinned install')
const file = require.resolve('@anthropic-ai/sandbox-runtime/package.json')
if (JSON.parse(readFileSync(file, 'utf8')).version !== '0.0.78') throw new Error('srt must be exactly 0.0.78')
JS

task_app=${ATUM_SEATBELT_APP:-/Applications/Atum Matrix Candidate.app/Contents/MacOS/Atum Matrix Candidate}
[[ -x "$task_app" ]] || { echo 'set ATUM_SEATBELT_APP to the installed candidate executable' >&2; exit 1; }
[[ -n ${SSH_AUTH_SOCK:-} && -S "$SSH_AUTH_SOCK" ]] || { echo 'proof requires a live SSH agent socket' >&2; exit 1; }
node scripts/stage-atum-disclaim-launcher.mjs
task_launcher="$PWD/dist/atum-disclaim-launcher"
[[ -x "$task_launcher" ]] || { echo 'disclaim launcher not staged' >&2; exit 1; }
"$task_launcher" --disclaim 1 -- /usr/bin/true

task_proof_report=${ATUM_SEATBELT_REPORT:-$PWD/build/seatbelt-proof.json}
mkdir -p "$(dirname "$task_proof_report")"
ATUM_SEATBELT_PROOF=1 ATUM_SEATBELT_APP="$task_app" ATUM_SEATBELT_LAUNCHER="$task_launcher" \
  npx --no-install vitest run --project electron \
  electron/matrix/device/seatbelt.test.ts \
  electron/matrix/device/seatbelt.boundary.test.ts \
  electron/matrix/device/egress-proxy.test.ts \
  electron/matrix/device/guard/*.test.ts \
  --reporter=default --reporter=json --outputFile="$task_proof_report"
node --input-type=module - "$task_proof_report" <<'JS'
import { readFileSync } from 'node:fs'
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'))
if (!result.success || result.numFailedTests || result.numPendingTests || result.numTodoTests) {
  throw new Error('strict proof must have no failures or skipped/todo cases')
}
console.log(`SP-5 proof: ${result.numPassedTests}/${result.numTotalTests} passed; no skips`)
JS
