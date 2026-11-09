import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import type { JsonRpcGatewayClient } from '../../../shared/src/json-rpc-gateway'

/** Read-only decision: only a session still at the old default follows the new workspace. */
export function rebaseLegacyCwd(cwd: unknown, legacy: string, workspace: string): string | undefined {
  if (typeof cwd !== 'string' || ![cwd, legacy, workspace].every(value => path.isAbsolute(value))) {
    return undefined
  }

  try {
    const previous = realpathSync(cwd)
    const oldDefault = realpathSync(legacy)
    const next = realpathSync(workspace)
    let drive = path.join(oldDefault, 'Drive')

    try {
      drive = realpathSync(drive)
    } catch {
      // The default Drive need not have been created yet.
    }

    if (
      previous !== oldDefault ||
      next === oldDefault ||
      next === drive ||
      next.startsWith(`${drive}${path.sep}`) ||
      !statSync(next).isDirectory()
    ) {
      return undefined
    }

    return workspace
  } catch {
    // A missing or changed directory cannot authorize a cwd rewrite.
    return undefined
  }
}

export interface MatrixLegacySessionRebase {
  cwd: unknown
  legacy: string
  workspace: string
  sessionId: string
  gateway: Pick<JsonRpcGatewayClient, 'request'>
  signal?: AbortSignal
}

/** Called once after resume on its own executor connection. Failure waits for the next resume. */
export async function rebaseLegacySessionCwd(
  input: MatrixLegacySessionRebase
): Promise<'rebased' | 'unchanged' | 'deferred'> {
  const cwd = rebaseLegacyCwd(input.cwd, input.legacy, input.workspace)

  if (!cwd || typeof input.sessionId !== 'string' || !input.sessionId) {
    return 'unchanged'
  }

  if (input.signal?.aborted) {
    return 'deferred'
  }

  try {
    await input.gateway.request('session.cwd.set', { session_id: input.sessionId, cwd }, 5_000, input.signal)

    return 'rebased'
  } catch {
    // Busy (4009), a lost connection and other errors never recreate or retry the session here.
    return 'deferred'
  }
}
