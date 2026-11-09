import { EventType, type MatrixClient, Method, RelationType } from 'matrix-js-sdk'

import type { MatrixIdentity } from '../../shared/matrix'
import {
  MATRIX_COMPANY_CHANNEL_TYPE,
  MATRIX_COMPANY_CONVERSATION_TYPE
} from '../../shared/matrix-company-channel-room'
import {
  defaultMatrixNotificationPolicy,
  MATRIX_NOTIFICATION_POLICY_ACCOUNT_DATA,
  MATRIX_NOTIFICATION_POLICY_TARGET_PREFIX,
  type MatrixNotificationPolicy,
  matrixNotificationPolicyChange,
  type MatrixNotificationPolicyChange,
  matrixNotificationPolicyTargetKey,
  mergeMatrixNotificationPolicyTargets,
  parseMatrixNotificationPolicy,
  parseMatrixNotificationPolicyTarget
} from '../../shared/matrix-notification-policy'
import { matrixTargetAccountDataType } from '../../shared/matrix-target-account-data'

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    'io.atum.notifications.v1': {
      version: 1
      accountLevel: 'all' | 'mentions' | 'nothing'
      quietHours: { enabled: boolean; startMinute: number; endMinute: number; timeZone: string }
      channelOverrides: Record<string, 'all' | 'mentions' | 'nothing'>
      threadOverrides: Record<string, Record<string, 'all' | 'mentions' | 'nothing'>>
      [key: string]: unknown
    }
  }
}

function requireTeamSpaceTarget(client: MatrixClient, input: MatrixNotificationPolicyChange): void {
  if (input.scope === 'account' || input.scope === 'quietHours') {
    return
  }

  const room = client.getRoom(input.roomId)

  if (
    !room ||
    room.getMyMembership() !== 'join' ||
    ![MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(room.getType() ?? '')
  ) {
    throw new Error('matrix_notification_policy_unavailable')
  }

  if (input.scope === 'thread') {
    const root = room.findEventById(input.rootId)
    const relation = root?.getOriginalContent()['m.relates_to']

    if (
      !root ||
      root.getRoomId() !== room.roomId ||
      root.getType() !== EventType.RoomMessage ||
      root.status != null ||
      root.isRedacted() ||
      root.isDecryptionFailure() ||
      relation?.rel_type === RelationType.Thread
    ) {
      throw new Error('matrix_notification_policy_unavailable')
    }
  }
}

/** Private Matrix account data is the portable authority. Push rules are not mutated here:
 * their `dont_notify` action also changes homeserver unread/highlight counts, while this policy
 * is required to change only banners, sounds and push presentation. */
export function matrixNotificationPolicy(
  client: MatrixClient,
  identity: MatrixIdentity,
  active: () => boolean,
  timeZone?: string
) {
  let confirmed = defaultMatrixNotificationPolicy(timeZone)
  let busy = false

  function read(ready: boolean): MatrixNotificationPolicy {
    const raw = client.getAccountData(MATRIX_NOTIFICATION_POLICY_ACCOUNT_DATA)?.getContent()
    const parsed = parseMatrixNotificationPolicy(raw)
    const targets = [...client.store.accountData.entries()]
      .filter(([type]) => type.startsWith(MATRIX_NOTIFICATION_POLICY_TARGET_PREFIX))
      .map(([, event]) => parseMatrixNotificationPolicyTarget(event.getContent()))
      .filter(value => value !== undefined)

    if (parsed || (ready && raw === undefined)) {
      confirmed = mergeMatrixNotificationPolicyTargets(
        parsed ?? defaultMatrixNotificationPolicy(timeZone),
        targets
      )
    }

    return {
      ...confirmed,
      quietHours: { ...confirmed.quietHours },
      channelOverrides: { ...confirmed.channelOverrides },
      threadOverrides: Object.fromEntries(
        Object.entries(confirmed.threadOverrides).map(([roomId, threads]) => [roomId, { ...threads }])
      ),
      writable: ready && (raw === undefined || Boolean(parsed))
    }
  }

  return {
    snapshot: read,
    async change(input: MatrixNotificationPolicyChange & { identity: MatrixIdentity }): Promise<void> {
      const change = matrixNotificationPolicyChange(input)

      if (
        !active() ||
        busy ||
        input.identity.userId !== identity.userId ||
        input.identity.deviceId !== identity.deviceId ||
        client.getUserId() !== identity.userId
      ) {
        throw new Error('matrix_notification_policy_stale')
      }

      requireTeamSpaceTarget(client, change)
      busy = true

      try {
        const eventType = await matrixTargetAccountDataType(
          MATRIX_NOTIFICATION_POLICY_TARGET_PREFIX,
          matrixNotificationPolicyTargetKey(change)
        )
        const raw = await client.http
          .authedRequest<unknown>(
            Method.Get,
            `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${eventType}`
          )
          .catch(error => {
            if (error?.errcode === 'M_NOT_FOUND') {
              return undefined
            }

            throw error
          })
        const current = raw === undefined ? undefined : parseMatrixNotificationPolicyTarget(raw)

        if (raw !== undefined && !current) {
          throw new Error('matrix_notification_policy_readonly')
        }

        if (raw === undefined) {
          const legacyRaw = await client.http
            .authedRequest<unknown>(
              Method.Get,
              `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${MATRIX_NOTIFICATION_POLICY_ACCOUNT_DATA}`
            )
            .catch(error => {
              if (error?.errcode === 'M_NOT_FOUND') {return undefined}
              throw error
            })

          if (legacyRaw !== undefined && !parseMatrixNotificationPolicy(legacyRaw)) {
            throw new Error('matrix_notification_policy_readonly')
          }
        }

        if (!active()) {
          throw new Error('matrix_notification_policy_stale')
        }

        const revision = current?.revision ?? 0
        const next = {
          version: 2 as const,
          revision: revision + 1,
          expected_revision: revision,
          change
        }
        if (!parseMatrixNotificationPolicyTarget(next)) {
          throw new Error('matrix_notification_policy_limit')
        }

        await (client.setAccountDataRaw as (type: string, content: unknown) => Promise<unknown>)(eventType, next)

        if (!active()) {
          throw new Error('matrix_notification_policy_stale')
        }

        const confirmed = parseMatrixNotificationPolicyTarget(await client.http.authedRequest<unknown>(
          Method.Get,
          `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${eventType}`
        ))

        if (
          confirmed?.revision !== next.revision ||
          matrixNotificationPolicyTargetKey(confirmed.change) !== matrixNotificationPolicyTargetKey(change) ||
          JSON.stringify(confirmed.change) !== JSON.stringify(change)
        ) {
          throw new Error('matrix_notification_policy_conflict')
        }
      } finally {
        busy = false
      }
    }
  }
}
