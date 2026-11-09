/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export interface MatrixFullHermesStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type MatrixFullHermesOutcome = 'already' | 'applied' | 'failed'

export const matrixFullHermesKey = (executorId: string) => `matrix-full-hermes:${executorId}`

export async function ensureMatrixFullHermes(input: {
  store: MatrixFullHermesStore
  executorId: string
  apply: () => Promise<void>
  signal: AbortSignal
  log: (line: string) => void
}): Promise<MatrixFullHermesOutcome> {
  const key = matrixFullHermesKey(input.executorId)

  try {
    if (input.store.getItem(key) === '1') {
      return 'already'
    }
  } catch {
    // An unreadable marker: apply again; the values are the same.
  }

  try {
    await input.apply()
  } catch (error) {
    input.signal.throwIfAborted()
    input.log(`[Matrix] full Hermes profile not applied yet (will retry): ${error instanceof Error ? error.name : 'error'}`)

    return 'failed'
  }

  try {
    input.store.setItem(key, '1')
  } catch {
    input.log('[Matrix] could not remember the full Hermes profile; it is applied again next launch')
  }

  return 'applied'
}
