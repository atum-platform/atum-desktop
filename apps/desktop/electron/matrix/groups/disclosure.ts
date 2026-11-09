import { createHash } from 'node:crypto'

import type { MatrixGroupMode } from '../../../shared/matrix-group-room'
import type { EncryptedStore } from '../../encrypted-store'

interface DisclosureStore extends Pick<
  EncryptedStore,
  'getItem' | 'failureCode' | 'assertEncryptionAvailable' | 'setItems'
> {}

export interface DisclosedAudience {
  members: string[]
  epoch: string
}

export interface GroupDisclosurePublication<T> {
  mode: MatrixGroupMode
  /** Fresh matrixGroupAudience, kept separate from the conversation's session identity. */
  audience: readonly string[]
  conversationKey: string
  /** matrixConversationKey for shared mode without audience: same owner/agent/device/room. */
  roomConversationKey: string
  invocationId: string
  store: DisclosureStore
  /** Re-read/validate mode and audience; shared returns groupDisclosureEpoch. */
  requireRoom(): Promise<string | undefined>
  publishDisclosure(transactionId: string): Promise<unknown>
  publishAnswer(): Promise<T>
}

const KEY = /^matrix-conversation-[a-f0-9]{64}$/
const audienceKey = (audience: readonly string[]) => JSON.stringify([...new Set(audience)].sort())

/** Fresh server membership event IDs distinguish a returning member's new join. */
export function groupDisclosureEpoch(
  members: readonly { userId: string; membershipEventId?: string }[],
  audience: readonly string[]
): string {
  const rows = [...new Set(audience)].sort().map(userId => {
    const event = members.find(member => member.userId === userId)?.membershipEventId

    if (!event?.startsWith('$')) {
      throw new Error('matrix_group_disclosure_unavailable')
    }

    return [userId, event]
  })

  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

function readRecord(store: DisclosureStore, key: string): Record<string, unknown> | undefined {
  const raw = store.getItem(key)

  if (store.failureCode()) {
    throw new Error('matrix_group_disclosure_unavailable')
  }

  if (raw === null) {
    return undefined
  }

  try {
    const value: unknown = JSON.parse(raw)

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid')
    }

    return value as Record<string, unknown>
  } catch {
    throw new Error('matrix_group_disclosure_unavailable')
  }
}

/** Called under the existing agent turn lock immediately before publishResult. */
export async function publishDisclosedGroupAnswer<T>(input: GroupDisclosurePublication<T>): Promise<T> {
  const epoch = await input.requireRoom()

  if (input.mode === 'meeting') {
    return input.publishAnswer()
  }

  if (
    !KEY.test(input.conversationKey) ||
    !KEY.test(input.roomConversationKey) ||
    !input.invocationId ||
    typeof epoch !== 'string' ||
    !/^[a-f0-9]{64}$/.test(epoch) ||
    input.audience.length === 0 ||
    input.audience.some(id => !/^@[^\s:]+:[^\s]+$/.test(id))
  ) {
    throw new Error('matrix_group_disclosure_unavailable')
  }

  const audience = [...new Set(input.audience)].sort()

  const requireRoom = async () => {
    if ((await input.requireRoom()) !== epoch) {
      throw new Error('matrix_group_changed')
    }
  }

  const link = readRecord(input.store, input.conversationKey)

  if (
    !link ||
    ![1, 2].includes(link.version as number) ||
    typeof link.storedSession !== 'string' ||
    !link.storedSession ||
    link.sharedRoom !== true
  ) {
    throw new Error('matrix_group_disclosure_unavailable')
  }

  // Sessions are per audience; a small room marker detects A -> B -> A instead
  // of treating A's old session link as proof that the latest audience was told.
  const markerKey = `${input.roomConversationKey}:disclosure`
  const marker = readRecord(input.store, markerKey)
  const disclosed = marker?.disclosedAudience as Partial<DisclosedAudience> | undefined

  if (
    marker &&
    (marker.v !== 1 ||
      !Array.isArray(disclosed?.members) ||
      disclosed.members.some(id => typeof id !== 'string') ||
      typeof disclosed.epoch !== 'string')
  ) {
    throw new Error('matrix_group_disclosure_unavailable')
  }

  if (!disclosed || disclosed.epoch !== epoch || audienceKey(disclosed.members!) !== audienceKey(audience)) {
    input.store.assertEncryptionAvailable()
    await requireRoom()

    // Recovery uses the same transaction for this admitted invocation; unlike
    // the old join transaction, a later audience change can post a new notice.
    const transactionId = `atum-gd-${createHash('sha256')
      .update(JSON.stringify([input.roomConversationKey, input.invocationId, audience, epoch]))
      .digest('hex')}`

    const posted = await input.publishDisclosure(transactionId)

    if (typeof posted !== 'string' || !posted.startsWith('$')) {
      throw new Error('matrix_group_disclosure_unavailable')
    }

    await requireRoom()
    // The session link and latest-audience marker land in the same encrypted write.
    input.store.setItems({
      [input.conversationKey]: JSON.stringify({ ...link, disclosedAudience: { members: audience, epoch } }),
      [markerKey]: JSON.stringify({ v: 1, disclosedAudience: { members: audience, epoch } })
    })
  }

  await requireRoom()

  return input.publishAnswer()
}
