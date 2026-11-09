import { ClientEvent, type MatrixClient, Method } from 'matrix-js-sdk'

import type { MatrixIdentity, MatrixSnapshot } from '../../shared/matrix'
import { createMatrixSyncHealth, matrixSyncedAfter } from '../../shared/matrix-sync-health'

export const MATRIX_STARTER_MARKER = 'io.atum.onboarding.starter'

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    'io.atum.onboarding.starter': Record<string, unknown>
  }
}

function validMarker(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false }
  const row = value as Record<string, unknown>

  return row.v === 1 && Number.isSafeInteger(row.seenAt) && Number(row.seenAt) >= 0
}

/** One cosmetic account marker through the real human SDK; no arbitrary data writer. */
export function matrixStarterOnboarding(
  client: MatrixClient,
  identity: MatrixIdentity,
  active: () => boolean,
  changed: () => void,
  now: () => number = Date.now
) {
  let synced = false
  let stopped = false
  let seen = false
  let pending: Promise<void> | undefined
  const live = () => !stopped && active() && client.getUserId() === identity.userId && client.getDeviceId() === identity.deviceId

  function snapshot(): NonNullable<MatrixSnapshot['starterMarker']> {
    if (!live() || !synced) { return 'unknown' }

    if (seen) { return 'seen' }

    try {
      const event = client.getAccountData(MATRIX_STARTER_MARKER)

      if (!event) { return 'unseen' }

      if (!validMarker(event.getContent())) { return 'unknown' }
      seen = true

      return 'seen'
    } catch { return 'unknown' }
  }

  // Known after a real sync, and a reconnecting one does not unmake it (matrix-sync-health.ts);
  // an outage that outlasts its grace does, by timer, since no sync event says so.
  const health = createMatrixSyncHealth({
    onChange: next => { if (next === 'offline' && synced && !stopped) { synced = false; changed() } }
  })
  const sync = (state: string, _previous?: unknown, data?: unknown) => {
    synced = matrixSyncedAfter(synced, state, health.observe(state, data))
    changed()
  }
  client.on(ClientEvent.Sync, sync)

  async function write(input: MatrixIdentity) {
    if (!live() || !synced || input.userId !== identity.userId || input.deviceId !== identity.deviceId) {
      throw new Error('matrix_starter_stale')
    }

    // A new-schema or already-seen record can have arrived on another Mac since sync.
    const raw = await client.http.authedRequest<unknown>(Method.Get,
      `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${MATRIX_STARTER_MARKER}`)
      .catch(error => { if (error?.errcode === 'M_NOT_FOUND') { return undefined }; throw error })

    if (!live() || !synced) { throw new Error('matrix_starter_stale') }

    if (raw !== undefined && !validMarker(raw)) { throw new Error('matrix_starter_readonly') }

    if (raw === undefined) {
      const seenAt = now()

      if (!Number.isSafeInteger(seenAt) || seenAt < 0) { throw new Error('matrix_starter_unavailable') }
      await client.setAccountDataRaw(MATRIX_STARTER_MARKER, { v: 1, seenAt })

      if (!live() || !synced) { throw new Error('matrix_starter_stale') }
    }

    // This is a successful HTTP receipt, not an optimistic SDK cache mutation.
    seen = true
    changed()
  }

  return {
    snapshot,
    acknowledge(input: MatrixIdentity): Promise<void> {
      if (!live() || input.userId !== identity.userId || input.deviceId !== identity.deviceId) {
        return Promise.reject(new Error('matrix_starter_stale'))
      }

      if (snapshot() === 'seen') { return Promise.resolve() }

      if (snapshot() !== 'unseen') { return Promise.reject(new Error('matrix_starter_unavailable')) }
      pending ??= write(input).finally(() => { pending = undefined })

      return pending
    },
    stop() { stopped = true; synced = false; health.dispose(); client.off(ClientEvent.Sync, sync) }
  }
}
