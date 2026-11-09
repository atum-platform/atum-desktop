import { describe, expect, it, vi } from 'vitest'

import { AdvisoryHistorySource } from './advisory-history-source'

const input = { profile: 'moon', session_id: 'live', turn_id: 'turn', request_id: 'request' }
const assistant = { id: '00000000-0000-4000-8000-bd7662a5eeb4', identityId: 'identity', status: 'active' }

const scope = {
  ...input,
  identity_id: 'identity',
  source: 'desktop',
  durable_session_id: 'durable',
  query: 'move decision',
  reference: null,
  limit: 3
}

const empty = { status: 'empty', results: [], next_reference: null, previous_reference: null }

function fixture() {
  const client = {
    status: vi.fn().mockResolvedValue({ accountId: 'owner' }),
    listAssistants: vi.fn().mockResolvedValue([assistant]),
    advisorySearch: vi.fn().mockResolvedValue(empty)
  }

  const runner = { searchConversation: vi.fn().mockResolvedValue(null) }
  const read = vi.fn().mockResolvedValue(scope)
  const source = new AdvisoryHistorySource(client as never, runner, read)

  return { source, client, runner, read }
}

describe('main-owned advisory source authority', () => {
  it('discovers from live identity without completed job receipts or renderer identity', async () => {
    const { source, client } = fixture()
    expect(await source.search({ ...input, target_assistant_id: 'forged' } as typeof input)).toEqual(empty)
    expect(client.advisorySearch).toHaveBeenCalledWith({
      target_assistant_id: assistant.id,
      conversation_id: null,
      query: 'move decision',
      reference: null,
      limit: 3
    })
  })

  it('binds group reads to the current main-owned job room', async () => {
    const { source, client, runner, read } = fixture()
    read.mockResolvedValue({ ...scope, source: 'atum-private-advisory' })
    runner.searchConversation.mockResolvedValue('room')
    await source.search(input)
    expect(client.advisorySearch.mock.calls[0][0].conversation_id).toBe('room')
    expect(runner.searchConversation).toHaveBeenCalledTimes(2)
  })

  it('does not fetch when runtime identity is absent or not registered', async () => {
    const { source, client, read } = fixture()
    read.mockResolvedValue(null)
    expect((await source.search(input)).status).toBe('denied')
    read.mockResolvedValue({ ...scope, identity_id: 'other-profile' })
    expect((await source.search(input)).status).toBe('denied')
    expect(client.advisorySearch).not.toHaveBeenCalled()
  })

  it('drops a response after an account switch', async () => {
    const { source, client } = fixture()
    client.advisorySearch.mockImplementation(async () => {
      client.status.mockResolvedValue({ accountId: 'other' })

      return { ...empty, status: 'ok', results: ['private content'] }
    })
    expect(await source.search(input)).toEqual({ ...empty, status: 'denied' })
  })

  it('drops a response after profile identity changes or turn expires', async () => {
    const { source, read } = fixture()
    read.mockResolvedValueOnce(scope).mockResolvedValueOnce({ ...scope, identity_id: 'changed' })
    expect((await source.search(input)).status).toBe('denied')
    read.mockResolvedValueOnce(scope).mockResolvedValueOnce(null)
    expect((await source.search(input)).status).toBe('denied')
  })

  it('preserves denied for the real backend HTTP forbidden response', async () => {
    const { source, client, read } = fixture()
    read.mockRejectedValue(new Error('403: {"error":"pending scope missing"}'))
    expect((await source.search(input)).status).toBe('denied')
    expect(client.advisorySearch).not.toHaveBeenCalled()
  })

  it('keeps unavailable distinct from an empty authorized search', async () => {
    const { source, client } = fixture()
    client.advisorySearch.mockRejectedValue(new Error('network unavailable'))
    expect((await source.search(input)).status).toBe('unavailable')
  })
})
