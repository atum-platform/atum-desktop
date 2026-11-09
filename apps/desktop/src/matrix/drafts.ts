import { EventType, type MatrixClient, Method, type Room } from 'matrix-js-sdk'

import type { MatrixIdentity } from '../../shared/matrix'
import {
  companyChannelRoomBinding,
  companyConversationRoomBinding
} from '../../shared/matrix-company-channel-room'
import {
  boundedMatrixDraftText,
  MATRIX_DRAFT_ACCOUNT_DATA_PREFIX,
  MATRIX_DRAFTS_ACCOUNT_DATA,
  matrixDraftKey,
  type MatrixDraftsContent,
  type MatrixDraftsSnapshot,
  type MatrixDraftTarget,
  mergeMatrixDraftTargets,
  parseMatrixDrafts,
  parseMatrixDraftTarget
} from '../../shared/matrix-drafts'
import { matrixTargetAccountDataType } from '../../shared/matrix-target-account-data'

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    'com.atum.drafts': MatrixDraftsContent
  }
}

export function joinedTeamSpaceRoom(room: Room | null | undefined): room is Room {
  if (!room || room.getMyMembership() !== 'join') {
    return false
  }

  const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')

  if (!creation || Array.isArray(creation)) {
    return false
  }

  const content = creation.getContent()
  const sender = creation.getSender()

  return Boolean(companyChannelRoomBinding(content, sender) || companyConversationRoomBinding(content, sender))
}

function current(active: () => boolean, client: MatrixClient, identity: MatrixIdentity): boolean {
  return active() && client.getUserId() === identity.userId && client.getDeviceId() === identity.deviceId
}

/** Private cross-device Team space drafts. Each target is its own revisioned account-data record. */
export function matrixDrafts(
  client: MatrixClient,
  identity: MatrixIdentity,
  active: () => boolean,
  now: () => number = Date.now,
  additionalRoom: (room: Room) => boolean = () => false
) {
  let tail = Promise.resolve()

  const fresh = (eventType: string) => client.http
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

  const legacy = () => parseMatrixDrafts(client.getAccountData(MATRIX_DRAFTS_ACCOUNT_DATA)?.getContent())

  const targets = () => [...client.store.accountData.entries()]
    .filter(([type]) => type.startsWith(MATRIX_DRAFT_ACCOUNT_DATA_PREFIX))
    .map(([, event]) => parseMatrixDraftTarget(event.getContent()))
    .filter(value => value !== null)

  const requireCurrent = () => {
    if (!current(active, client, identity)) {
      throw new Error('matrix_drafts_stale')
    }
  }

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation)
    tail = result.then(() => undefined, () => undefined)

    return result
  }

  const changeOne = async (target: MatrixDraftTarget, text: string) => {
    requireCurrent()

    const room = client.getRoom(target.roomId)

    if (text && !joinedTeamSpaceRoom(room) && !(room && additionalRoom(room))) {
      throw new Error('matrix_draft_room_unavailable')
    }

    const key = matrixDraftKey(target)
    const eventType = await matrixTargetAccountDataType(MATRIX_DRAFT_ACCOUNT_DATA_PREFIX, key)
    const raw = await fresh(eventType)
    const existing = raw === undefined ? null : parseMatrixDraftTarget(raw)

    if (raw !== undefined && !existing) {
      throw new Error('matrix_drafts_readonly')
    }

    const bounded = boundedMatrixDraftText(text)
    const legacyText = legacy()?.drafts.find(draft =>
      matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id }) === key
    )?.text ?? ''
    const currentText = existing?.target.text ?? legacyText

    if (currentText === bounded) {
      return
    }

    const revision = existing?.revision ?? 0
    const next = {
      version: 2 as const,
      revision: revision + 1,
      expected_revision: revision,
      target: {
        room_id: target.roomId,
        ...(target.threadRootId ? { thread_root_id: target.threadRootId } : {}),
        text: bounded,
        updated_at: now()
      }
    }

    if (!parseMatrixDraftTarget(next)) {
      throw new Error('matrix_draft_invalid')
    }

    requireCurrent()
    await (client.setAccountDataRaw as (type: string, content: unknown) => Promise<unknown>)(eventType, next)
    requireCurrent()
    const confirmed = parseMatrixDraftTarget(await fresh(eventType))

    if (
      confirmed?.revision !== next.revision ||
      matrixDraftKey({ roomId: confirmed.target.room_id, threadRootId: confirmed.target.thread_root_id }) !== key ||
      confirmed.target.text !== next.target.text
    ) {
      throw new Error('matrix_draft_revision_conflict')
    }
  }

  return {
    snapshot(ready: boolean): MatrixDraftsSnapshot {
      const content = mergeMatrixDraftTargets(legacy(), targets())

      return { records: content?.drafts ?? [], writable: ready }
    },

    change(target: MatrixDraftTarget, text: string): Promise<void> {
      return serialize(() => changeOne(target, text))
    },

    prune(): Promise<void> {
      return serialize(async () => {
        requireCurrent()
        const joined = new Set(
          client.getRooms().filter(room => joinedTeamSpaceRoom(room) || additionalRoom(room)).map(room => room.roomId)
        )
        const content = mergeMatrixDraftTargets(legacy(), targets())

        for (const draft of content?.drafts ?? []) {
          if (!joined.has(draft.room_id)) {
            await changeOne({ roomId: draft.room_id, ...(draft.thread_root_id ? { threadRootId: draft.thread_root_id } : {}) }, '')
          }
        }
      })
    }
  }
}
