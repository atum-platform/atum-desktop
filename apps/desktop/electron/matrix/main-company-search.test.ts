import { describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyChannelDirectory } from '../../shared/matrix-company'
import type { CompanyConversationDirectory15Response } from '../../shared/matrix-company-team-space'

import {
  handleMatrixCompanySearch,
  handleMatrixCompanySearchOpen,
  type MatrixCompanySearchContext
} from './main-company-search'

const companyId = '00000000-0000-4000-8000-4423c334534f'
const channelId = '00000000-0000-4000-8000-a6350151b493'
const roomId = '!company-search:test'
const conversationId = '00000000-0000-4000-8000-8c031eadb7f3'

function directory(channels = 1): MatrixCompanyChannelDirectory {
  return {
    schemaVersion: 1,
    channels: channels ? [{
      schemaVersion: 1,
      channel: { id: channelId, companyId, displayName: 'general', visibility: 'company', state: 'active',
        projectId: null, authorityGeneration: 3, channelGeneration: 2 },
      memberPrincipals: ['00000000-0000-4000-8000-01670d853f95'],
      room: { state: 'ready', roomId }
    }] : []
  }
}

function searchValue(query = 'launch') {
  return {
    schemaVersion: 1,
    companyId,
    query,
    coverage: { eligibleRooms: 1, searchedRooms: 1, truncated: false },
    results: [{ channelId, roomId, channelName: 'general', eventId: '$message', sender: '@avery:test',
      snippet: 'Exact launch needle', at: 100 }]
  }
}

function fixture(): MatrixCompanySearchContext {
  const ui = { mainFrame: { url: 'atum-matrix://ui/matrix.html' } }

  return {
    event: { sender: ui, senderFrame: ui.mainFrame }, ui, uiUrl: ui.mainFrame.url,
    enabled: true, closing: false, available: vi.fn(() => true),
    channels: vi.fn(async () => directory()),
    sdk: vi.fn(async command => command.kind === 'companyMessageSearch' ? searchValue(command.query) : null)
  }
}

describe('company message search IPC', () => {
  it('derives room filters from current platform authority and rechecks after Matrix search', async () => {
    const context = fixture()
    await expect(handleMatrixCompanySearch({ companyId, query: 'launch', limit: 25 }, context))
      .resolves.toEqual({ ok: true, value: searchValue() })
    expect(context.channels).toHaveBeenCalledTimes(2)
    expect(context.sdk).toHaveBeenCalledWith({
      kind: 'companyMessageSearch', companyId, query: 'launch', limit: 25,
      rooms: [{ channelId, roomId, channelName: 'general', state: 'active',
        authorityGeneration: 3, channelGeneration: 2 }]
    })
  })

  it('drops the whole result if authority changes during search', async () => {
    const context = fixture()
    vi.mocked(context.channels).mockResolvedValueOnce(directory()).mockResolvedValueOnce(directory(0))
    await expect(handleMatrixCompanySearch({ companyId, query: 'launch', limit: 25 }, context))
      .resolves.toEqual({ ok: false, error: 'cancelled' })
  })

  it('resolves a public from:@handle in main and gives only its Matrix user to the trusted SDK', async () => {
    const context = fixture()
    context.resolveHandle = vi.fn(async () => '@avery:test')

    await expect(handleMatrixCompanySearch({ companyId, query: 'launch from:@avery', limit: 25,
      tab: 'messages', fileType: 'all' }, context)).resolves.toMatchObject({ ok: true })
    expect(context.resolveHandle).toHaveBeenCalledExactlyOnceWith('avery')
    expect(context.sdk).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'companyMessageSearch', query: 'launch from:@avery', senderUserId: '@avery:test'
    }))
  })

  it('reauthorizes the channel before opening the exact SDK event', async () => {
    const context = fixture()
    await expect(handleMatrixCompanySearchOpen({ companyId, channelId, roomId, eventId: '$message' }, context))
      .resolves.toEqual({ ok: true })
    expect(context.channels).toHaveBeenCalledTimes(2)
    expect(context.sdk).toHaveBeenNthCalledWith(1, {
      kind: 'companyMessageOpen', companyId, channelId, roomId, eventId: '$message'
    })
    expect(context.sdk).toHaveBeenNthCalledWith(2, {
      kind: 'companyMessageSelect', companyId, channelId, roomId
    })
    const channelOrder = vi.mocked(context.channels).mock.invocationCallOrder
    const sdkOrder = vi.mocked(context.sdk).mock.invocationCallOrder
    expect(channelOrder[0]).toBeLessThan(sdkOrder[0]!)
    expect(sdkOrder[0]).toBeLessThan(channelOrder[1]!)
    expect(channelOrder[1]).toBeLessThan(sdkOrder[1]!)
  })

  it('authorizes company DMs from the existing conversation directory', async () => {
    const context = fixture()
    vi.mocked(context.channels).mockResolvedValue(directory(0))
    context.conversations = vi.fn(async (): Promise<CompanyConversationDirectory15Response> => ({ schemaVersion: 6, conversations: [{
      id: conversationId, companyId, kind: 'dm', state: 'active', participantSetDigest: 'a'.repeat(64),
      authorityGeneration: 4, conversationGeneration: 2, hidden: false,
      participants: [
        { memberRef: '00000000-0000-4000-8000-6b8e755910f9', admissionEpoch: 1, handle: 'avery', displayName: 'Avery' },
        { memberRef: '00000000-0000-4000-8000-16b7785de2e4', admissionEpoch: 1, handle: 'me', displayName: 'Me' }
      ],
      room: { state: 'ready', roomId }
    }] }))
    context.sdk = vi.fn(async command => command.kind === 'companyMessageSearch' ? {
      ...searchValue(command.query),
      results: [{ ...searchValue(command.query).results[0], channelId: conversationId, channelName: 'Avery, Me' }]
    } : null)

    await expect(handleMatrixCompanySearch({ companyId, query: 'launch', limit: 25 }, context))
      .resolves.toMatchObject({ ok: true })
    expect(context.sdk).toHaveBeenCalledWith(expect.objectContaining({ rooms: [expect.objectContaining({
      targetType: 'conversation', channelId: conversationId, roomId, channelName: 'Avery, Me'
    })] }))

    await expect(handleMatrixCompanySearchOpen({ companyId, channelId: conversationId, roomId,
      eventId: '$message' }, context)).resolves.toEqual({ ok: true })
    expect(context.sdk).toHaveBeenCalledWith(expect.objectContaining({ kind: 'companyMessageOpen',
      targetType: 'conversation' }))
    expect(context.sdk).toHaveBeenCalledWith(expect.objectContaining({ kind: 'companyMessageSelect',
      targetType: 'conversation' }))
  })

  it('does not select when platform authority disappears during exact-event validation', async () => {
    const context = fixture()
    vi.mocked(context.channels).mockResolvedValueOnce(directory()).mockResolvedValueOnce(directory(0))

    await expect(handleMatrixCompanySearchOpen({ companyId, channelId, roomId, eventId: '$message' }, context))
      .resolves.toEqual({ ok: false, error: 'denied' })
    expect(context.sdk).toHaveBeenCalledExactlyOnceWith({
      kind: 'companyMessageOpen', companyId, channelId, roomId, eventId: '$message'
    })
  })

  it('rejects renderer authority and wrong callers before either backend', async () => {
    const context = fixture()
    await expect(handleMatrixCompanySearch({ companyId, query: 'launch', limit: 25, rooms: [roomId] }, context))
      .resolves.toEqual({ ok: false, error: 'invalid' })
    expect(context.channels).not.toHaveBeenCalled()
    context.event.senderFrame = {}
    await expect(handleMatrixCompanySearch({ companyId, query: 'launch', limit: 25 }, context))
      .rejects.toThrow('matrix_ipc_denied')
    expect(context.sdk).not.toHaveBeenCalled()
  })
})
