import { ClientEvent, type MatrixClient, type MatrixEvent, Method } from 'matrix-js-sdk'

import type { MatrixIdentity } from '../../shared/matrix'
import {
  MATRIX_GOOGLE_FENCE_ACCOUNT_DATA,
  type MatrixGoogleFence,
  type MatrixGoogleFenceObservation,
  parseMatrixGoogleFence
} from '../../shared/matrix-google-fence'
import { createMatrixSyncHealth, matrixSyncedAfter } from '../../shared/matrix-sync-health'

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    'io.atum.google_fence': Record<string, unknown>
  }
}

/** Main invokes this before consent. A write acknowledgement is not a fabricated
 * sync echo; normal account-data observation remains the reader's authority. */
export function matrixGoogleFencePublisher(client: MatrixClient, identity: MatrixIdentity, active: () => boolean) {
  let pending = false
  let earliest: number | undefined

  const current = (input: MatrixIdentity) => active() &&
    input.userId === identity.userId && input.deviceId === identity.deviceId &&
    client.getUserId() === identity.userId && client.getDeviceId() === identity.deviceId

  return async (input: MatrixIdentity): Promise<MatrixGoogleFence> => {
    if (!current(input)) { throw new Error('matrix_google_fence_stale') }
    if (pending) { throw new Error('matrix_google_fence_pending') }
    pending = true
    const started = Date.now()

    try {
      const raw = await client.http.authedRequest<unknown>(Method.Get,
        `/user/${encodeURIComponent(identity.userId)}/account_data/${MATRIX_GOOGLE_FENCE_ACCOUNT_DATA}`)
        .catch(error => {
          if (error?.errcode === 'M_NOT_FOUND') { return undefined }
          throw new Error('matrix_google_fence_unavailable')
        })
      if (!current(input)) { throw new Error('matrix_google_fence_stale') }
      const previous = raw === undefined ? undefined : parseMatrixGoogleFence(raw)
      if (previous === null) { throw new Error('matrix_google_fence_readonly') }
      const cached = client.getAccountData(MATRIX_GOOGLE_FENCE_ACCOUNT_DATA)
      const known = cached ? parseMatrixGoogleFence(cached.getContent()) : undefined
      if (cached && !known) { throw new Error('matrix_google_fence_readonly') }
      const since = Math.min(started, earliest ?? started, previous?.since ?? started, known?.since ?? started)
      const fence: MatrixGoogleFence = { v: 1, since }
      // Retain the earliest attempted boundary even if PUT has an ambiguous result.
      earliest = since
      if (previous?.since !== since) {
        await client.setAccountDataRaw(MATRIX_GOOGLE_FENCE_ACCOUNT_DATA, { v: fence.v, since: fence.since })
        if (!current(input)) { throw new Error('matrix_google_fence_stale') }
      }
      return fence
    } catch (error) {
      if (error instanceof Error && ['matrix_google_fence_stale', 'matrix_google_fence_readonly',
        'matrix_google_fence_unavailable'].includes(error.message)) { throw error }
      throw new Error('matrix_google_fence_unavailable')
    } finally { pending = false }
  }
}

/**
 * Observes the owner's frozen Google fence after a real SDK sync. This only
 * projects account data: it never writes it, makes admission decisions, or
 * turns an unavailable account-data cache into an absent fence.
 */
export function observeMatrixGoogleFence(
  client: MatrixClient,
  offer: (observation: MatrixGoogleFenceObservation) => void
): () => void {
  let synced = false
  let stopped = false
  let earliest: number | undefined

  const unknown = () => offer({ state: 'unknown' })

  const observe = () => {
    if (stopped || !synced) {
      unknown()

      return
    }

    let event: MatrixEvent | undefined

    try {
      event = client.getAccountData(MATRIX_GOOGLE_FENCE_ACCOUNT_DATA)
    } catch {
      unknown()

      return
    }

    if (!event) {
      offer({ state: 'current', since: earliest ?? null })

      return
    }

    const fence = parseMatrixGoogleFence(event.getContent())

    if (!fence) {
      unknown()

      return
    }

    earliest = earliest === undefined ? fence.since : Math.min(earliest, fence.since)
    offer({ state: 'current', since: earliest })
  }

  // Only a real sync makes the fence known, and a reconnecting one does not unmake it: the
  // account data cannot change while the long-poll is down, so a blip publishes nothing. An
  // outage that outlasts its grace (by timer: no sync event says so) is unknown again.
  const health = createMatrixSyncHealth({
    onChange: next => {
      if (next === 'offline' && synced && !stopped) {
        synced = false
        unknown()
      }
    }
  })

  const sync = (state: string, _previous?: unknown, data?: unknown) => {
    synced = matrixSyncedAfter(synced, state, health.observe(state, data))

    if (!synced) {
      unknown()

      return
    }

    if (state === 'SYNCING') {
      observe()
    }
  }

  const accountData = (event: MatrixEvent) => {
    if (event.getType() === MATRIX_GOOGLE_FENCE_ACCOUNT_DATA && synced) {
      observe()
    }
  }

  client.on(ClientEvent.Sync, sync)
  client.on(ClientEvent.AccountData, accountData)
  unknown()

  return () => {
    if (stopped) {
      return
    }

    stopped = true
    synced = false
    health.dispose()
    client.off(ClientEvent.Sync, sync)
    client.off(ClientEvent.AccountData, accountData)
    unknown()
  }
}
