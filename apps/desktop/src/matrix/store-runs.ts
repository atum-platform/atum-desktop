import { type MatrixClient, Method } from 'matrix-js-sdk'

import type { MatrixIdentity } from '../../shared/matrix'
import {
  type MatrixStoreRunLedger,
  matrixStoreRunsAssistant,
  matrixStoreRunsEvent,
  parseMatrixStoreRunLedger
} from '../../shared/matrix-store-runs'

/**
 * Paid assistants' Store-run ledgers in the owner's account data (shared/matrix-store-runs.ts),
 * one event per assistant, through the real human SDK. Only main reads and writes them,
 * holding the assistant's lease; a read is always fresh from the server, so a Mac whose last
 * sync is behind never decides on an old claim, and a newer schema is refused rather than
 * overwritten.
 */
export function matrixStoreRuns(client: MatrixClient, identity: MatrixIdentity, active: () => boolean) {
  const busy = new Set<string>()
  const live = () => active() && client.getUserId() === identity.userId

  const event = (assistantId: string) => {
    if (!matrixStoreRunsAssistant(assistantId)) {
      throw new Error('matrix_store_runs_invalid')
    }

    return matrixStoreRunsEvent(assistantId)
  }

  async function read(assistantId: string): Promise<MatrixStoreRunLedger> {
    const type = event(assistantId)

    if (!live()) {
      throw new Error('matrix_store_runs_stale')
    }

    const raw = await client.http
      .authedRequest<unknown>(Method.Get, `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${type}`)
      .catch(error => {
        if (error?.errcode === 'M_NOT_FOUND') {
          return undefined
        }

        throw error
      })

    const ledger = parseMatrixStoreRunLedger(raw)

    if (!ledger) {
      throw new Error('matrix_store_runs_readonly')
    }

    return ledger
  }

  return {
    read,

    async write(assistantId: string, ledger: MatrixStoreRunLedger): Promise<void> {
      const type = event(assistantId)
      const value = parseMatrixStoreRunLedger(ledger)

      if (!value || !live()) {
        throw new Error('matrix_store_runs_invalid')
      }

      if (busy.has(type)) {
        throw new Error('matrix_store_runs_pending')
      }

      busy.add(type)

      try {
        // A newer schema on the server is never overwritten by this build.
        await read(assistantId)

        if (!live()) {
          throw new Error('matrix_store_runs_stale')
        }

        // An HTTP acknowledgement, never an optimistic cache write: sync brings it back.
        await client.http.authedRequest(
          Method.Put,
          `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${type}`,
          undefined,
          { ...value, version: 2 }
        )
      } finally {
        busy.delete(type)
      }
    }
  }
}
