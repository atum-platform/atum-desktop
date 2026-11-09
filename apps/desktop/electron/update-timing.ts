import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import os from 'node:os'

/** Squirrel emits local wall-clock timestamps. Ignore earlier updates and incomplete phases. */
export function restartPhases(text: string, startedAt: number, shownAt: number): Record<string, number> {
  const phases: Record<string, number> = {}
  let began: number | undefined
  let firstMove: number | undefined
  let lastMove: number | undefined
  let installed: number | undefined
  let launched: number | undefined

  for (const line of text.split(/\r?\n/u)) {
    const stamp = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)/u.exec(line)

    if (!stamp) {continue}
    const at = new Date(`${stamp[1]}T${stamp[2]}`).getTime()

    if (!Number.isFinite(at) || at < startedAt || at > shownAt) {continue}

    if (began === undefined && /Beginning installation|Resuming installation attempt/u.test(line)) {began = at}

    if (began !== undefined && installed === undefined && /Moving bundle from/u.test(line)) {firstMove ??= at; lastMove = at}

    if (firstMove !== undefined && installed === undefined && /Installation completed successfully/u.test(line)) {installed = at}

    if (installed !== undefined && launched === undefined && /Successfully launched application|Application launched at/u.test(line)) {launched = at}
  }

  const duration = (key: string, from?: number, to?: number) => {
    if (from !== undefined && to !== undefined && to >= from) {phases[key] = to - from}
  }

  duration('teardown', startedAt, began)
  duration('prepare', began, firstMove)
  // Log boundaries approximate rename work; no fabricated zero for missing milestones.
  duration('swap', firstMove, lastMove)
  duration('cleanup', lastMove, installed)
  duration('relaunch', installed, launched)
  duration('window', launched, shownAt)

  return phases
}

/** Local diagnostics only. Never delays Restart or sends host metrics to telemetry. */
export async function restartEnvironment(directory: string): Promise<string> {
  const free = await statfs(directory).then(value => Number(value.bavail) * Number(value.bsize), () => null)

  const swap = await new Promise<string>(resolve => execFile('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 1000 },
    (error, stdout) => resolve(error ? 'unknown' : stdout.trim().replace(/\s+/gu, '_'))))

  return `load=${os.loadavg().map(value => value.toFixed(2)).join(',')} free_bytes=${free ?? 'unknown'} swap=${swap}`
}
