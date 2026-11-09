import { type MatrixClient, SetPresence, UserEvent } from 'matrix-js-sdk'

import type { MatrixPresenceSnapshot, MatrixStatusInput, MatrixUserPresence } from '../../shared/matrix-presence'
import {
  matrixPresenceState,
  matrixStatusMessage,
  parseMatrixStatusMessage,
  validMatrixStatusInput
} from '../../shared/matrix-presence'

type OwnPresence = 'online' | 'away' | 'offline'

const sdkPresence = (value: OwnPresence): SetPresence =>
  value === 'away' ? SetPresence.Unavailable : value === 'offline' ? SetPresence.Offline : SetPresence.Online

const wirePresence = (value: OwnPresence) => (value === 'away' ? 'unavailable' as const : value)

export function matrixPresenceDisabledError(error: unknown): boolean {
  const value = error as { errcode?: unknown; data?: { errcode?: unknown }; httpStatus?: unknown } | null
  const code = value?.errcode ?? value?.data?.errcode

  return code === 'M_FORBIDDEN' || code === 'M_UNRECOGNIZED' || code === 'M_NOT_FOUND' || value?.httpStatus === 404
}

/**
 * Matrix m.presence projection and writes. A user is projected only after an actual presence event;
 * the SDK model's default `offline` value is not evidence that the homeserver supports presence.
 */
export function matrixPresence(
  client: MatrixClient,
  ownUserId: string,
  active: () => boolean,
  changed: () => void
) {
  let availability: OwnPresence = 'online'
  let presenceDisabled = false
  let stagedOwnStatus: { event: unknown; wire: string } | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined

  const observed = (event: unknown, user: { userId: string }) => {
    if (user.userId === ownUserId) {
      presenceDisabled = false

      if (stagedOwnStatus && event !== stagedOwnStatus.event) {
        stagedOwnStatus = undefined
      }
    }

    changed()
  }

  // LastPresenceTs fires for every m.presence event, including status_msg-only changes.
  client.on(UserEvent.LastPresenceTs, observed)

  const scheduleExpiry = (users: readonly MatrixUserPresence[], now: number) => {
    clearTimeout(expiryTimer)

    const next = users
      .flatMap(user => user.status?.expiresAt ? [user.status.expiresAt] : [])
      .filter(expiresAt => expiresAt > now)
      .sort((left, right) => left - right)[0]

    if (next !== undefined) {
      expiryTimer = setTimeout(changed, Math.min(next - now + 1, 2_147_483_647))
    }
  }

  const snapshot = (userIds: ReadonlySet<string>, now = Date.now()): MatrixPresenceSnapshot => {
    const users: MatrixUserPresence[] = []

    for (const userId of [...userIds].sort()) {
      const user = client.getUser(userId)
      const event = user?.events.presence
      const content = event?.getContent()
      const state = matrixPresenceState(content?.presence, Boolean(event))

      const statusWire = userId === ownUserId && stagedOwnStatus
        ? stagedOwnStatus.wire
        : content?.status_msg

      const status = parseMatrixStatusMessage(statusWire, now)

      if (!state && !status) {
        continue
      }

      users.push({
        userId,
        ...(state ? { state } : {}),
        ...(typeof user?.displayName === 'string' && user.displayName !== userId
          ? { displayName: user.displayName }
          : {}),
        ...(typeof user?.avatarUrl === 'string' ? { avatarMxc: user.avatarUrl } : {}),
        ...(status ? { status } : {})
      })
    }

    scheduleExpiry(users, now)

    return { users }
  }

  return {
    snapshot,
    async setAvailability(next: OwnPresence): Promise<void> {
      if (!active()) {
        throw new Error('matrix_presence_unavailable')
      }

      availability = next
      await client.setSyncPresence(sdkPresence(next))
      if (presenceDisabled) {return}

      try {
        await client.setPresence({ presence: wirePresence(next) })
      } catch (error) {
        if (matrixPresenceDisabledError(error)) {
          presenceDisabled = true

          return
        }

        throw error
      }
    },
    async setStatus(status: MatrixStatusInput | null): Promise<void> {
      if (!active() || presenceDisabled || status && !validMatrixStatusInput(status)) {
        throw new Error('matrix_status_invalid')
      }

      const user = client.getUser(ownUserId)
      const previous = user?.events.presence
      const wire = status ? matrixStatusMessage(status) : ''

      await client.setPresence({ presence: wirePresence(availability), status_msg: wire })
      stagedOwnStatus = { event: previous, wire }
      changed()
    },
    stop() {
      clearTimeout(expiryTimer)
      client.off(UserEvent.LastPresenceTs, observed)
    }
  }
}
