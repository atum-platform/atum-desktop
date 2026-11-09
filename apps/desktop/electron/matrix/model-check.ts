import { createHash } from 'node:crypto'

import { matrixFullHermesKey } from './full-hermes'

/**
 * Whether the launch-time model check still has work to do (plan G1-13).
 *
 * The check (main's configureManagedModel) starts a separate Hermes backend only to read
 * and, when needed, repair the agent's model: Atum's model through the loopback proxy,
 * unless the person chose their own. It ran at every launch and at every re-enrollment,
 * and cost a whole Hermes start before the agent's own backend could start.
 *
 * After a check that left Atum's model in place, nothing it wrote can change without the
 * profile's `config.yaml` changing: the endpoint, its key and the selected model all live
 * there (Hermes's `/api/providers/custom-endpoints` writes them into the file). So while
 * that file, and everything the check was given, are exactly as the last successful check
 * left them, the check is skipped.
 *
 * The stamp lives in the agent's own vault, beside its own-model and full-Hermes markers,
 * and binds:
 * - the app build: a new build checks once, since its Hermes may read settings differently;
 * - what the check writes (`writes`, from hermes-setup.ts);
 * - the proxy's address, the model, and a digest of the agent's key (never the key);
 * - a digest of `config.yaml` as the check left it.
 *
 * The person's own model, a failed or unfinished check, the full-Hermes profile not yet
 * applied, and any vault or file that cannot be read all run the check as before.
 */
export const MATRIX_MODEL_CHECK_VERSION = 1

export const matrixModelCheckKey = (executorId: string) => `matrix-model-checked:${executorId}`

export interface MatrixModelCheckStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface MatrixModelCheckContext {
  store: MatrixModelCheckStore
  executorId: string
  /** The app version and build revision. */
  build: string
  /** What the check writes into the profile, as data. */
  writes: unknown
  proxy: { baseUrl: string; model: string; apiKey: string }
  /** The profile's `config.yaml`, read afresh. */
  readConfig(): Buffer | string
}

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

/** The stamp for the profile as it is now; the key only ever enters as a digest. */
export function matrixModelCheckStamp(context: MatrixModelCheckContext): string {
  const inputs = sha256(
    JSON.stringify([
      MATRIX_MODEL_CHECK_VERSION,
      context.build,
      context.writes,
      context.proxy.baseUrl,
      context.proxy.model,
      sha256(context.proxy.apiKey)
    ])
  )

  return JSON.stringify({ v: MATRIX_MODEL_CHECK_VERSION, inputs, config: sha256(context.readConfig()) })
}

/** True only when the last successful check left Atum's model in this very profile. */
export function matrixModelCheckCurrent(context: MatrixModelCheckContext & { ownModel: boolean }): boolean {
  if (context.ownModel) {
    return false
  }

  try {
    const stored = context.store.getItem(matrixModelCheckKey(context.executorId))

    return (
      stored !== null &&
      context.store.getItem(matrixFullHermesKey(context.executorId)) === '1' &&
      stored === matrixModelCheckStamp(context)
    )
  } catch {
    // An unreadable vault or profile: check, as before.
    return false
  }
}

/**
 * After a check: stamp the profile when the check left Atum's model ready and the full
 * Hermes profile applied, and forget any stamp otherwise. Called after the check's own
 * backend has exited, so the file is read as that backend left it. Never fails setup.
 */
export function rememberMatrixModelCheck(
  context: MatrixModelCheckContext & { current: boolean },
  log: (line: string) => void
): void {
  const key = matrixModelCheckKey(context.executorId)

  try {
    if (context.current && context.store.getItem(matrixFullHermesKey(context.executorId)) === '1') {
      context.store.setItem(key, matrixModelCheckStamp(context))
    } else {
      context.store.removeItem(key)
    }
  } catch {
    try {
      context.store.removeItem(key)
    } catch {
      /* The next launch checks again: a stamp that cannot be read is never current. */
    }

    log('[Matrix] could not remember the model check; the next launch checks again')
  }
}

/** A check that failed or was cancelled: the next launch checks again. */
export function forgetMatrixModelCheck(store: MatrixModelCheckStore, executorId: string): void {
  try {
    store.removeItem(matrixModelCheckKey(executorId))
  } catch {
    /* A stamp left behind still matches only the profile exactly as a passing check left it. */
  }
}

/** What one model check did: ran (`checked`), or found the profile as its last pass left it. */
export type MatrixModelCheckRun = 'checked' | 'unchanged'

/**
 * One model check for one agent (main's configureManagedModel), in this order:
 * 1. When the stamp still matches, skip it: nothing starts, and the agent's running backend
 *    is left alone.
 * 2. Otherwise `begin` it. Main stops the agent's backend, starts the check's own Hermes and
 *    takes the agent's turn slot, all before `begin` returns, so no turn starts meanwhile.
 * 3. Stamp what a passing check left, or forget the stamp when the check fails or is
 *    cancelled. The stamp is skipped for an agent stopped for good, whose vault scope is
 *    being cleared.
 * 4. Only then `end` it and release the slot, so nothing touches the profile before it is
 *    read for the stamp.
 */
export async function runMatrixModelCheck(input: {
  context: MatrixModelCheckContext
  ownModel: boolean
  begin(): Promise<{ ready: boolean; atum: boolean }>
  end(): void
  alive(): boolean
  log(line: string): void
}): Promise<MatrixModelCheckRun> {
  if (matrixModelCheckCurrent({ ...input.context, ownModel: input.ownModel })) {
    return 'unchanged'
  }

  try {
    const result = await input.begin()

    if (!result.ready) {
      throw new Error('matrix_setup_failed')
    }

    if (input.alive()) {
      rememberMatrixModelCheck({ ...input.context, current: result.atum }, input.log)
    }

    return 'checked'
  } catch (error) {
    forgetMatrixModelCheck(input.context.store, input.context.executorId)

    throw error
  } finally {
    input.end()
  }
}
