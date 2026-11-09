export const MATRIX_AWAY_IDLE_SECONDS = 5 * 60

export type MatrixOwnPresence = 'online' | 'away' | 'offline'

export function matrixOwnPresenceForActivity(input: {
  focused: boolean
  idleSeconds: number
  closing?: boolean
}): MatrixOwnPresence {
  if (input.closing) {return 'offline'}

  return input.focused && input.idleSeconds < MATRIX_AWAY_IDLE_SECONDS ? 'online' : 'away'
}

/** Native owns focus and idle facts; the SDK owns the actual Matrix write. */
export function createMatrixPresenceLifecycle(dependencies: {
  current(): { scope: string; focused: boolean; idleSeconds: number; closing: boolean } | undefined
  send(value: MatrixOwnPresence): Promise<void>
  interval?(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>
}) {
  let last: { scope: string; value: MatrixOwnPresence } | undefined
  const interval = dependencies.interval ?? setInterval
  const timer = interval(() => void refresh(), 30_000)

  if (typeof timer !== 'number') {timer.unref()}

  async function write(value: MatrixOwnPresence, force = false): Promise<void> {
    const current = dependencies.current()

    if (!current?.scope || !force && last?.scope === current.scope && last.value === value) {return}

    try {
      await dependencies.send(value)
      last = { scope: current.scope, value }
    } catch {
      if (last?.scope === current.scope) {last = undefined}
    }
  }

  async function refresh(): Promise<void> {
    const current = dependencies.current()

    if (!current) {return}

    await write(matrixOwnPresenceForActivity(current))
  }

  return {
    refresh,
    away: () => write('away'),
    offline: () => write('offline', true),
    reset() {last = undefined},
    stop() {clearInterval(timer)}
  }
}
