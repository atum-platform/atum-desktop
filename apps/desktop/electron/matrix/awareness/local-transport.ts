import type { MatrixLocalBrain, MatrixLocalBrainOwner } from '../local-brain'

import type { AwarenessTransport } from './types'

export interface AwarenessLocalTransportOptions {
  destination: 'local'
  brain: Pick<MatrixLocalBrain, 'ready' | 'call' | 'stop'>
  /** Captured native provider custody, never selected by a payload or renderer. */
  owner: MatrixLocalBrainOwner
  /** Null until native admission/control reconciliation is complete. */
  current(): MatrixLocalBrainOwner | null
}

/** The existing AW port over the existing native supervisor. This does not start
 * a provider, confer SDK read authority, reconcile policy, or expose recall/send.
 * Cancellation after dispatch is unknown: the provider has no per-RPC cancel.
 * Retire this adapter and its exact provider, retaining reader operation custody;
 * only explicit native activation plus a new adapter may resume. */
export function awarenessLocalTransport(options: AwarenessLocalTransportOptions): AwarenessTransport {
  if (options.destination !== 'local' ||
    !/^[a-f0-9]{64}$/i.test(options.owner?.accountKey) ||
    !Number.isSafeInteger(options.owner?.generation) || options.owner.generation < 0) {
    throw new Error('awareness_local_transport_invalid')
  }

  const owner = { ...options.owner, accountKey: options.owner.accountKey.toLowerCase() }
  let retired = false

  const admitted = () => {
    if (retired) { return false }

    try {
      const current = options.current()

      return current?.accountKey.toLowerCase() === owner.accountKey &&
        current.generation === owner.generation && options.brain.ready(owner)
    } catch {
      return false
    }
  }

  const retire = () => {
    retired = true

    // ready is checked synchronously, without an await before stop() fences the
    // native supervisor. An outgoing request must never stop a successor owner.
    try {
      if (options.brain.ready(owner)) {
        void options.brain.stop().catch(() => {})
      }
    } catch {
      // Unknown custody cannot justify stopping a possible successor. Stay
      // retired and require explicit native lifecycle recovery instead.
    }
  }

  const call = (method: string, params: unknown, signal: AbortSignal): Promise<unknown> => {
    if (signal.aborted) {
      return Promise.reject(new Error('awareness_local_transport_aborted'))
    }

    if (!admitted()) {
      return Promise.reject(new Error('awareness_local_transport_unavailable'))
    }

    if (signal.aborted) {
      return Promise.reject(new Error('awareness_local_transport_aborted'))
    }

    return new Promise((resolve, reject) => {
      let settled = false

      const finish = (error?: Error, result?: unknown) => {
        if (settled) { return }
        settled = true
        signal.removeEventListener('abort', aborted)

        if (error) { reject(error) } else { resolve(result) }
      }

      const unknown = () => {
        retire()
        finish(new Error('awareness_local_transport_outcome_unknown'))
      }

      const aborted = () => unknown()
      signal.addEventListener('abort', aborted, { once: true })

      // No await between current native custody check and actual RPC dispatch.
      try {
        options.brain.call(owner, method, params).then(result => {
          if (settled) { return }

          if (!admitted()) {
            unknown()
          } else {
            finish(undefined, result)
          }
        }, () => {
          if (!settled) { unknown() }
        })
      } catch {
        unknown()
      }
    })
  }

  return {
    async prepare(signal) {
      const info = await call('brain.info', undefined, signal) as { contract?: unknown; status?: unknown } | null

      if (info?.contract !== 'atum.awareness/1' || info?.status !== 'ready') {
        retire()
        throw new Error('awareness_local_transport_invalid')
      }
    },
    ingest: (envelope, signal) => call('brain.ingest', envelope, signal),
    withdraw: (request, signal) => call('brain.withdraw', request, signal),
    fence: (notice, signal) => call('brain.fence', notice, signal),
    async coverage(report, signal) {
      await call('brain.reportCoverage', report, signal)
    }
  }
}
