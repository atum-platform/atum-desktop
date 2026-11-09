/**
 * A file-triggered way to start the existing owner-bound home migration for ONE allow-listed agent,
 * for the one-off move of the owner's default assistant to the cloud. The in-app "Move to the
 * cloud" button was removed in 0.19.4b and nothing else can call `moveAgentToCloud` in a shipped
 * build (no renderer caller, no DevTools, no remote debugging), so an operator who has been given
 * access to this Mac starts the move by dropping a file. Everything the move does after that is
 * the migration's own: the writer holds, the other Mac's participation, the owner's native
 * confirmation dialog, the cloud commit.
 *
 * Contract:
 *  - the trigger is `operator/move-to-cloud.json` in the app's identity folder
 *    (`~/Library/Application Support/Atum Matrix Candidate/`, beside the operator's
 *    `public-config.json`: `operatorMoveDirectory`) =
 *    `{"v":1,"principal":"<uuid>","token":"<uuid>"}`, a regular file written by the person who
 *    owns this Mac's account (not a link, not writable by others), read on a 5 s tick. It is NOT
 *    in Electron's `userData`, which is the per-profile, per-configuration folder
 *    `<identity folder>/<profile>/<hash>/` that an operator cannot name without computing a hash;
 *  - it starts an agent only when that agent is ALSO in `config.cloudMigrationTestAgents`, the
 *    existing Mac-side gate of the migration, and only when the agent is ready for a move;
 *  - at most once: the file is renamed to `…consumed-<token>` BEFORE the move starts, so a crash
 *    or a quit in the middle cannot start a second one;
 *  - the outcome is written beside it as `…consumed-<token>.receipt.json`, with closed codes only
 *    (no path, no content, no free text);
 *  - an agent that is not ready yet keeps the file in place and is tried again on the next tick;
 *  - a malformed, unsafe or not-allow-listed trigger is set aside as `…refused-<time>-<why>`.
 *
 * There is no IPC and no renderer surface: the trigger cannot be pulled from the app's own UI
 * and no web page can reach it. It takes a file in the account owner's own folder, so anything
 * that runs as that user (a terminal tool included) could write one; the owner's native
 * confirmation dialog, and the allow-list, are what stand behind it.
 */
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { MATRIX_IDENTITY_NAME } from './app-identity'

export const OPERATOR_MOVE_DIRECTORY = 'operator'
export const OPERATOR_MOVE_FILE = 'move-to-cloud.json'
export const OPERATOR_MOVE_TICK_MS = 5_000

/** Where the trigger is read: `operator/` in the identity folder, next to the operator's
 * `public-config.json` (launch-config.ts), so an operator finds it without knowing the
 * per-configuration hash that Electron's `userData` ends in. `appData` is `app.getPath('appData')`. */
export function operatorMoveDirectory(appData: string): string {
  return path.join(appData, MATRIX_IDENTITY_NAME, OPERATOR_MOVE_DIRECTORY)
}

/** The trigger is two UUIDs; anything larger is not one. */
const MAX_TRIGGER_BYTES = 1024

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CLOSED = /^[a-z_:0-9]{1,64}$/

export interface OperatorMoveFiles {
  /** The file's text, or null when it is absent. Throws when it is there but not safe to read. */
  read(file: string): string | null
  rename(from: string, to: string): void
  /** Mode 0600; never replaces a file that exists. */
  write(file: string, text: string): void
}

export interface OperatorMoveDeps {
  directory: string
  allowed: readonly string[]
  files: OperatorMoveFiles
  /** The agent's runtime exists on this Mac, has a home, is ready, and no move of it is in flight. */
  ready(principal: string): boolean
  move(principal: string): Promise<{ state: string; step?: string; code?: string }>
  now(): number
  log(line: string): void
}

interface TriggerFile {
  v?: unknown
  principal?: unknown
  token?: unknown
}

export type OperatorMoveResult = 'idle' | 'waiting' | 'refused' | 'ran' | 'failed'

const closed = (value: unknown): string => (typeof value === 'string' && CLOSED.test(value) ? value : 'unexpected')

/** The real files: a regular file owned by this user and not writable by others, never a link. */
export function nodeOperatorFiles(): OperatorMoveFiles {
  return {
    read: file => {
      let stat: ReturnType<typeof lstatSync>

      try {
        stat = lstatSync(file)
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          return null
        }

        throw error
      }

      const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid()

      if (!stat.isFile() || stat.size > MAX_TRIGGER_BYTES || (stat.mode & 0o022) !== 0 || !owned) {
        throw new Error('operator_move_unsafe')
      }

      return readFileSync(file, 'utf8')
    },
    rename: renameSync,
    write: (file, text) => writeFileSync(file, text, { mode: 0o600, flag: 'wx' })
  }
}

export async function runOperatorMove(deps: OperatorMoveDeps): Promise<OperatorMoveResult> {
  const trigger = path.join(deps.directory, OPERATOR_MOVE_FILE)

  const refuse = (why: string): OperatorMoveResult => {
    // Set aside under a name that cannot match the trigger again.
    try {
      deps.files.rename(trigger, `${trigger}.refused-${deps.now()}-${why}`)
    } catch {
      deps.log('[Device] operator move: the refused trigger could not be set aside')
    }

    deps.log(`[Device] operator move refused: ${why}`)

    return 'refused'
  }

  let text: string | null

  try {
    text = deps.files.read(trigger)
  } catch {
    return refuse('unsafe')
  }

  if (text === null) {
    return 'idle'
  }

  let value: TriggerFile | null = null

  try {
    value = JSON.parse(text) as TriggerFile | null
  } catch {
    value = null
  }

  const principal = value?.principal
  const token = value?.token

  if (value?.v !== 1 || typeof principal !== 'string' || typeof token !== 'string' || !UUID.test(principal) || !UUID.test(token)) {
    return refuse('invalid')
  }

  if (!deps.allowed.includes(principal)) {
    return refuse('not_allow_listed')
  }

  if (!deps.ready(principal)) {
    return 'waiting'
  }

  // Consumed first: from here on the move runs at most once, whatever happens to it.
  const consumed = `${trigger}.consumed-${token}`

  try {
    deps.files.rename(trigger, consumed)
  } catch {
    deps.log('[Device] operator move not started: the trigger could not be consumed')

    return 'failed'
  }

  deps.log(`[Device] operator move of ${principal.slice(0, 8)} started`)

  let receipt: Record<string, unknown>

  try {
    const outcome = await deps.move(principal)

    receipt = {
      state: closed(outcome.state),
      ...(outcome.step ? { step: closed(outcome.step) } : {}),
      ...(outcome.code ? { code: closed(outcome.code) } : {})
    }
  } catch (error) {
    receipt = { state: 'error', code: closed(error instanceof Error ? error.message : undefined) }
  }

  try {
    deps.files.write(
      `${consumed}.receipt.json`,
      `${JSON.stringify({ v: 1, principal, token, at: deps.now(), ...receipt })}\n`
    )
  } catch {
    deps.log('[Device] operator move: the receipt could not be written')
  }

  deps.log(`[Device] operator move of ${principal.slice(0, 8)} ended: ${String(receipt.state)}`)

  return 'ran'
}

/**
 * One tick of the poll. A tick that arrives while the previous one is still running (a move takes
 * as long as the owner's confirmation) returns `busy` and does nothing; `prepare` returns null
 * while this Mac is not in a position to start a move (no allow-list, signed out, quitting). A
 * trigger that is waiting for its agent says so once, not on every tick, so the log shows why a
 * dropped file has not been picked up yet.
 */
export function operatorMoveTicker(
  prepare: () => OperatorMoveDeps | null
): () => Promise<OperatorMoveResult | 'busy' | 'off'> {
  let running: Promise<OperatorMoveResult> | undefined
  let waiting = false

  return () => {
    if (running) {
      return Promise.resolve('busy' as const)
    }

    const deps = prepare()

    if (!deps) {
      return Promise.resolve('off' as const)
    }

    running = runOperatorMove(deps)
      .catch((): OperatorMoveResult => 'failed')
      .then(result => {
        if (result === 'waiting' && !waiting) {
          deps.log('[Device] operator move waiting: the agent is not ready for a move yet')
        }

        waiting = result === 'waiting'

        return result
      })
      .finally(() => {
        running = undefined
      })

    return running
  }
}
