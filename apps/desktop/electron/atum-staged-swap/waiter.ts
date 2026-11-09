import { type ChildProcess, spawn } from 'node:child_process'

/**
 * The launcher that outlives the old main process.
 *
 * Arguments: PARENT_PID TARGET BACKUP STARTED SHOWN RELAUNCH OPENER NO_START_SECONDS LIVE_SECONDS
 *
 * It never changes either bundle. It only waits for the old process, reopens the target, and, if the new
 * version fails to put a window up, reopens the signed backup, which restores itself (recovery.ts).
 */
export const WAITER_SCRIPT = `
parent=$1
target=$2
backup=$3
started=$4
shown=$5
relaunch=$6
opener=$7
no_start_limit=$8
live_limit=$9

# 1. Wait for the old main process to exit. Both renames happen before it does.
while kill -0 "$parent" 2>/dev/null; do
  sleep 0.1
done

# 2. Ordinary Quit: the swap is done and nothing reopens the app. Unless the app is gone (the process
#    died between the two renames): then the signed backup is the only complete app, so open it.
if [ "$relaunch" != 1 ]; then
  if [ ! -d "$target" ] && [ -d "$backup" ]; then
    "$opener" -n "$backup"
  fi
  exit 0
fi

# 3. Open the target. -W keeps "open" alive for as long as the app runs, so its pid says
#    "the app is still running".
"$opener" -n -W "$target" &
launch=$!

waited=0
while [ ! -f "$shown" ]; do
  # The app exited before it showed a window.
  kill -0 "$launch" 2>/dev/null || break

  if [ -f "$started" ]; then
    # The new version owns the instance lock. A slow launch on a loaded Mac is healthy as long as the
    # process it recorded is alive, so give it the long limit.
    pid=$(cat "$started" 2>/dev/null)
    kill -0 "$pid" 2>/dev/null || break
    limit=$live_limit
  else
    # Nothing started at all: the bundle cannot launch.
    limit=$no_start_limit
  fi

  [ "$waited" -lt "$limit" ] || break
  sleep 1
  waited=$((waited + 1))
done

if [ -f "$shown" ]; then
  kill "$launch" 2>/dev/null
  exit 0
fi

# 4. The new version never showed a window. Reopen the old one; it swaps itself back.
if [ -d "$backup" ]; then
  "$opener" -n "$backup"
fi
exit 0
`

export interface WaiterOptions {
  parentPid: number
  target: string
  backup: string
  startedMarker: string
  shownMarker: string
  relaunch: boolean
  opener?: string
  noStartSeconds?: number
  liveSeconds?: number
}

export function waiterArguments(options: WaiterOptions): string[] {
  return [
    '-c', WAITER_SCRIPT, 'atum-staged-launch',
    String(options.parentPid), options.target, options.backup, options.startedMarker, options.shownMarker,
    options.relaunch ? '1' : '0', options.opener ?? '/usr/bin/open',
    String(options.noStartSeconds ?? 60), String(options.liveSeconds ?? 300)
  ]
}

/** Start the launcher detached and resolve once it exists. A launcher that cannot start means the
 * installed app is still untouched, so the caller can stop before changing anything. */
export async function spawnWaiter(options: WaiterOptions): Promise<ChildProcess> {
  const waiter = spawn('/bin/sh', waiterArguments(options), { detached: true, stdio: 'ignore' })

  await new Promise<void>((resolve, reject) => {
    waiter.once('spawn', resolve)
    waiter.once('error', reject)
  })
  waiter.unref()

  return waiter
}
