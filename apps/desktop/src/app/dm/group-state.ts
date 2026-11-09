import { atom } from 'nanostores'

import { atumMessagingClient } from '@/lib/atum-messaging-client'
import { $atumAccountScopeId, $atumRoster, refreshAtumRoster } from '@/store/atum-messaging'

import type {
  GroupCapabilities,
  GroupDetail,
  GroupOperationInput,
  GroupOperationResult
} from '../../../shared/atum-group-conversations'

export const $groupCapabilities = atom<GroupCapabilities | null>(null)
export const $groupDetails = atom<Record<string, GroupDetail>>({})
export const $groupLoading = atom<Record<string, boolean>>({})
export const $groupErrors = atom<Record<string, boolean>>({})
export const $groupOperations = atom<GroupOperationResult[]>([])
export const $groupPendingCreate = atom<Extract<GroupOperationInput, { action: 'create' }> | null>(null)
export const $groupPendingReports = atom<Record<string, Extract<GroupOperationInput, { action: 'report' }>>>({})
export const $groupPendingManagement = atom<
  Record<string, Exclude<GroupOperationInput, { action: 'create' | 'report' }>>
>({})
let generation = 0
let operationRead = 0
let nextDetailRequestId = 0

interface DetailRequest {
  account: string
  id: string
  membershipEpoch: number
  requestId: number
  generation: number
}

// A room can disappear and later reappear with a new membership epoch while
// its previous detail request is still in flight. The request map makes that
// old completion harmless and lets the new membership begin loading at once.
const detailRequests = new Map<string, DetailRequest>()

function withoutKey<T>(rows: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _removed, ...remaining } = rows

  return remaining
}

function mergeOperations(rows: GroupOperationResult[]): void {
  const unique = new Map<string, GroupOperationResult>()

  for (const row of rows) {
    if (!unique.has(row.operationId)) {
      unique.set(row.operationId, row)
    }
  }

  $groupOperations.set([...unique.values()].slice(0, 100))
}

$atumAccountScopeId.listen(() => {
  generation += 1
  detailRequests.clear()
  $groupCapabilities.set(null)
  $groupDetails.set({})
  $groupLoading.set({})
  $groupErrors.set({})
  $groupOperations.set([])
  $groupPendingCreate.set(null)
  $groupPendingReports.set({})
  $groupPendingManagement.set({})
})

$atumRoster.listen(roster => {
  const memberships = new Map(roster.flatMap(row => (row.group ? [[row.id, row.group.membershipEpoch] as const] : [])))

  const activePendingKey = (key: string) => [...memberships].some(([id, epoch]) => key.startsWith(`${id}:${epoch}:`))
  $groupPendingReports.set(
    Object.fromEntries(Object.entries($groupPendingReports.get()).filter(([key]) => activePendingKey(key)))
  )
  $groupPendingManagement.set(
    Object.fromEntries(Object.entries($groupPendingManagement.get()).filter(([key]) => activePendingKey(key)))
  )

  const details = Object.fromEntries(
    Object.entries($groupDetails.get()).filter(([id, detail]) => memberships.get(id) === detail.room.membershipEpoch)
  )

  $groupDetails.set(details)

  for (const [id, request] of detailRequests) {
    if (memberships.get(id) !== request.membershipEpoch) {
      detailRequests.delete(id)
    }
  }

  $groupLoading.set(Object.fromEntries(Object.entries($groupLoading.get()).filter(([id]) => detailRequests.has(id))))
  $groupErrors.set(Object.fromEntries(Object.entries($groupErrors.get()).filter(([id]) => memberships.has(id))))
})

export async function refreshGroupCapabilities(): Promise<void> {
  const epoch = generation
  const account = $atumAccountScopeId.get()

  if (!account) {
    return
  }

  const client = atumMessagingClient()

  // A previous installed main process does not expose the new bridge yet.
  const capabilities = client.groupCapabilities
    ? await client.groupCapabilities()
    : { available: false, creationEnabled: false, humanMemberLimit: 32 }

  if (epoch === generation && account === $atumAccountScopeId.get()) {
    $groupCapabilities.set(capabilities)
  }
}

/** Rehydrate the durable main-process operation ledger for this account. */
export async function refreshGroupOperations(): Promise<void> {
  const epoch = generation
  const read = ++operationRead
  const account = $atumAccountScopeId.get()

  if (!account) {
    return
  }

  const client = atumMessagingClient()
  // A pre-G2 desktop main process has no persisted group-operation bridge.
  const rows = client.groupOperations ? await client.groupOperations() : []

  if (read === operationRead && epoch === generation && account === $atumAccountScopeId.get()) {
    mergeOperations(rows)
  }
}

export async function loadGroupDetail(id: string, older = false): Promise<void> {
  const epoch = generation
  const account = $atumAccountScopeId.get()
  const membership = $atumRoster.get().find(row => row.id === id)?.group?.membershipEpoch
  const active = detailRequests.get(id)

  if (
    !account ||
    !membership ||
    (active && active.generation === epoch && active.membershipEpoch === membership && active.account === account)
  ) {
    return
  }

  const previous = $groupDetails.get()[id]

  if (older && (!previous || !previous.hasMore)) {
    return
  }

  const request: DetailRequest = {
    account,
    id,
    membershipEpoch: membership,
    generation: epoch,
    requestId: ++nextDetailRequestId
  }

  detailRequests.set(id, request)
  $groupLoading.set({ ...$groupLoading.get(), [id]: true })
  $groupErrors.set({ ...$groupErrors.get(), [id]: false })

  const current = () =>
    detailRequests.get(id)?.requestId === request.requestId &&
    request.generation === generation &&
    request.account === $atumAccountScopeId.get() &&
    $atumRoster.get().find(row => row.id === id)?.group?.membershipEpoch === request.membershipEpoch

  try {
    const detail = await atumMessagingClient().groupDetail(id, older ? previous?.nextCursor : null)

    if (!current()) {
      return
    }

    const events = [
      ...new Map(
        [...(older ? (previous?.events ?? []) : []), ...detail.events].map(event => [event.id, event])
      ).values()
    ]

    $groupDetails.set({ ...$groupDetails.get(), [id]: { ...detail, events } })
  } catch {
    if (current()) {
      $groupErrors.set({ ...$groupErrors.get(), [id]: true })
    }
  } finally {
    if (current()) {
      detailRequests.delete(id)
      $groupLoading.set(withoutKey($groupLoading.get(), id))
    }
  }
}

export async function operateGroup(input: GroupOperationInput): Promise<GroupOperationResult> {
  const epoch = generation
  const client = atumMessagingClient()
  let result: GroupOperationResult

  try {
    result = await client.groupOperate(input)
  } catch (error) {
    if (epoch !== generation) {
      throw new Error('stale_account')
    }

    // Main can save the operation before its IPC response is lost. Resolve
    // against its durable ledger; an unreadable ledger must preserve exact retry.
    if (!client.groupOperations) {
      throw error
    }

    const rows = await client.groupOperations()

    if (epoch !== generation) {
      throw new Error('stale_account')
    }

    const recorded = rows.find(row => row.operationId === input.clientOperationId)

    if (!recorded) {
      throw new Error('group_operation_not_queued', { cause: error })
    }

    result = recorded
  }

  if (epoch !== generation) {
    throw new Error('stale_account')
  }

  operationRead += 1
  mergeOperations([result, ...$groupOperations.get()])
  await refreshAtumRoster()

  if (epoch !== generation) {
    throw new Error('stale_account')
  }

  if (result.state === 'sent' && result.conversationId && input.action !== 'leave') {
    await loadGroupDetail(result.conversationId)
  }

  return result
}
