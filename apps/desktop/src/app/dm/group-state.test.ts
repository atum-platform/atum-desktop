import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumMessagingConversation } from '@/lib/atum-messaging-client'

import type { GroupDetail, GroupOperationResult, GroupRoom } from '../../../shared/atum-group-conversations'

const client = vi.hoisted(() => ({
  groupCapabilities: vi.fn(),
  groupDetail: vi.fn(),
  groupOperations: vi.fn(),
  groupOperate: vi.fn()
}))

vi.mock('@/lib/atum-messaging-client', () => ({ atumMessagingClient: () => client }))
vi.mock('@/store/atum-messaging', () => ({
  $atumAccountScopeId: atom<string | null>('account-a'),
  $atumRoster: atom<AtumMessagingConversation[]>([]),
  refreshAtumRoster: vi.fn().mockResolvedValue([])
}))

import { $atumAccountScopeId, $atumRoster } from '@/store/atum-messaging'

import {
  $groupDetails,
  $groupLoading,
  $groupOperations,
  $groupPendingCreate,
  $groupPendingManagement,
  loadGroupDetail,
  operateGroup,
  refreshGroupOperations
} from './group-state'

const writableAccountScopeId = $atumAccountScopeId as unknown as { set(value: string | null): void }

function room(membershipEpoch: number): GroupRoom {
  return {
    conversationId: 'room-1',
    title: 'Planning',
    revision: membershipEpoch,
    retiredAt: null,
    membershipEpoch,
    members: [{ userId: 'account-a', displayName: 'Minh', handle: 'minh', role: 'owner', membershipEpoch }],
    updatedAt: '2026-09-06T00:00:00.000Z'
  }
}

function roster(membershipEpoch: number): AtumMessagingConversation[] {
  return [
    {
      id: 'room-1',
      title: 'Planning',
      kind: 'group',
      group: room(membershipEpoch),
      participantIds: ['account-a'],
      updatedAt: '2026-09-06T00:00:00.000Z',
      lastMessageAt: null,
      unreadCount: 0,
      payload: {}
    }
  ]
}

function detail(membershipEpoch: number): GroupDetail {
  return { room: room(membershipEpoch), events: [], nextCursor: null, hasMore: false }
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(next => {
    resolve = next
  })

  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  writableAccountScopeId.set('account-a')
  $atumRoster.set([])
  $groupDetails.set({})
  $groupLoading.set({})
  $groupOperations.set([])
})

afterEach(() => {
  $atumRoster.set([])
})

describe('group detail lifecycle', () => {
  it('does not let a removed membership request block or overwrite a rejoined room', async () => {
    const prior = deferred<GroupDetail>()
    const rejoined = deferred<GroupDetail>()
    client.groupDetail.mockReturnValueOnce(prior.promise).mockReturnValueOnce(rejoined.promise)
    $atumRoster.set(roster(1))

    const first = loadGroupDetail('room-1')
    expect($groupLoading.get()).toEqual({ 'room-1': true })

    $atumRoster.set([])
    expect($groupLoading.get()).toEqual({})
    $atumRoster.set(roster(2))
    const second = loadGroupDetail('room-1')
    expect(client.groupDetail).toHaveBeenCalledTimes(2)

    rejoined.resolve(detail(2))
    await second
    expect($groupDetails.get()['room-1']?.room.membershipEpoch).toBe(2)
    expect($groupLoading.get()).toEqual({})

    prior.resolve(detail(1))
    await first
    expect($groupDetails.get()['room-1']?.room.membershipEpoch).toBe(2)
    expect($groupLoading.get()).toEqual({})
  })

  it('rehydrates the durable main-process operation ledger only for the current account', async () => {
    const operation: GroupOperationResult = {
      operationId: 'operation-1',
      state: 'queued',
      conversationId: 'room-1',
      errorCode: null
    }

    client.groupOperations.mockResolvedValue([operation])

    await refreshGroupOperations()

    expect($groupOperations.get()).toEqual([operation])
  })
})

describe('group operation projection lifecycle', () => {
  const create = { action: 'create', clientOperationId: 'op', title: 'Planning', memberUserIds: ['peer'] } as const

  it.each(['queued', 'sent'] as const)('recovers a saved %s create after its IPC response is lost', async state => {
    const recorded: GroupOperationResult = {
      operationId: 'op',
      conversationId: state === 'sent' ? 'room-1' : null,
      state,
      errorCode: null
    }

    client.groupOperate.mockRejectedValueOnce(new Error('ipc_response_lost'))
    client.groupOperations.mockResolvedValueOnce([recorded])

    await expect(operateGroup({ ...create, memberUserIds: ['peer'] })).resolves.toEqual(recorded)
    expect($groupOperations.get()).toEqual([recorded])
    expect(client.groupOperate).toHaveBeenCalledTimes(1)
  })

  it('only reports an unsaved create after an authoritative empty ledger read', async () => {
    client.groupOperate.mockRejectedValueOnce(new Error('group_creation_disabled'))
    client.groupOperations.mockResolvedValueOnce([])

    await expect(operateGroup({ ...create, memberUserIds: ['peer'] })).rejects.toThrow('group_operation_not_queued')
    expect($groupOperations.get()).toEqual([])
  })

  it('does not treat an unreadable ledger as evidence the create was unsaved', async () => {
    client.groupOperate.mockRejectedValueOnce(new Error('ipc_response_lost'))
    client.groupOperations.mockRejectedValueOnce(new Error('ledger_unavailable'))

    await expect(operateGroup({ ...create, memberUserIds: ['peer'] })).rejects.toThrow('ledger_unavailable')
    expect($groupOperations.get()).toEqual([])
  })

  it('discards a create recovery when the account changes during its ledger read', async () => {
    const ledger = deferred<GroupOperationResult[]>()
    client.groupOperate.mockRejectedValueOnce(new Error('ipc_response_lost'))
    client.groupOperations.mockReturnValueOnce(ledger.promise)
    const result = operateGroup({ ...create, memberUserIds: ['peer'] })
    const rejected = expect(result).rejects.toThrow('stale_account')
    await vi.waitFor(() => expect(client.groupOperations).toHaveBeenCalledTimes(1))
    writableAccountScopeId.set('account-b')
    ledger.resolve([{ operationId: 'op', conversationId: 'room-1', state: 'sent', errorCode: null }])

    await rejected
    expect($groupOperations.get()).toEqual([])
  })

  it('keeps the latest operation result when a prior ledger read arrives late', async () => {
    const stale = deferred<GroupOperationResult[]>()
    const queued: GroupOperationResult = { operationId: 'op', conversationId: null, state: 'queued', errorCode: null }
    const sent: GroupOperationResult = { ...queued, conversationId: 'room-1', state: 'sent' }
    $groupOperations.set([queued])
    client.groupOperations.mockReturnValueOnce(stale.promise)
    const reading = refreshGroupOperations()
    client.groupOperate.mockResolvedValueOnce(sent)
    client.groupDetail.mockResolvedValueOnce(detail(1))
    await operateGroup({ action: 'create', clientOperationId: 'op', title: 'Planning', memberUserIds: ['peer'] })
    stale.resolve([queued])
    await reading
    expect($groupOperations.get()).toEqual([sent])
  })

  it('drops parent-held pending intents on account and membership changes', () => {
    $atumRoster.set(roster(1))
    $groupPendingManagement.set({
      'room-1:1:management': { action: 'retire', conversationId: 'room-1', clientOperationId: 'op' }
    })
    $atumRoster.set(roster(2))
    expect($groupPendingManagement.get()).toEqual({})
    $groupPendingCreate.set({
      action: 'create',
      clientOperationId: 'create',
      title: 'Private',
      memberUserIds: ['peer']
    })
    writableAccountScopeId.set('account-b')
    expect($groupPendingCreate.get()).toBe(null)
  })
})
