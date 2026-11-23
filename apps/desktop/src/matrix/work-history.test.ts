import type { MatrixClient } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import { readWorkHistory } from './work-history'

function fixture() {
  const e = (id: string, sender = '@owner:test', text = id) => ({
    event_id: id,
    type: 'm.room.message',
    sender,
    content: { msgtype: 'm.text', body: text }
  })

  const request = vi
    .fn()
    .mockResolvedValueOnce({
      chunk: [e('$later'), e('$current'), e('$answer', '@agent:test'), e('$prior')],
      end: 'server-cursor'
    })
    .mockResolvedValueOnce({ chunk: [e('$floor'), e('$cleared')], end: null })

  const client = {
    getRoom: () => ({
      roomId: '!dm:test',
      hasEncryptionStateEvent: () => false,
      getJoinedMembers: () => [{ userId: '@owner:test' }, { userId: '@agent:test' }]
    }),
    getCrypto: () => ({ isEncryptionEnabledInRoom: async () => false }),
    getUserId: () => '@owner:test',
    createMessagesRequest: request,
    setRoom: vi.fn(),
    scrollback: vi.fn()
  } as unknown as MatrixClient

  return { client, request }
}

describe('main-owned background SDK paging', () => {
  it('uses native page cursors, upper cutoff and floor without UI room mutation', async () => {
    const f = fixture()

    const result = await readWorkHistory(f.client, {
      roomId: '!dm:test',
      before: '$current',
      after: null,
      floor: '$floor'
    })

    expect(result.messages.map(m => m.itemId)).toEqual(['$prior', '$answer'])
    expect(result.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(f.request.mock.calls[1][1]).toBe('server-cursor')
    expect(f.client.scrollback).not.toHaveBeenCalled()
  })
  it('refuses an unreached boundary rather than resurrect cleared history', async () => {
    const f = fixture()
    await expect(
      readWorkHistory(f.client, { roomId: '!dm:test', before: '$current', after: null, floor: '$missing' })
    ).rejects.toThrow('boundary')
  })
  it('refuses encrypted rooms before paging', async () => {
    const f = fixture()
    vi.spyOn(f.client, 'getCrypto').mockReturnValue({ isEncryptionEnabledInRoom: async () => true } as never)
    await expect(
      readWorkHistory(f.client, { roomId: '!dm:test', before: '$current', after: null, floor: null })
    ).rejects.toThrow('not_plain')
    expect(f.request).not.toHaveBeenCalled()
  })
})

it('G4 bounds a long room after finding the cutoff and reports truncation', async () => {
  const f = fixture()
  let page = 0
  f.request.mockReset().mockImplementation(async () => ({
    chunk: Array.from({ length: 100 }, (_, n) => ({ event_id: page === 0 && n === 0 ? '$current' : `$old${page}-${n}`, type: 'm.room.message', sender: '@owner:test', content: { msgtype: 'm.text', body: 'history' } })),
    end: `page${++page}`
  }))
  const result = await readWorkHistory(f.client, { roomId: '!dm:test', before: '$current', after: null, floor: null })
  expect(result.messages).toHaveLength(1999)
  expect(result.truncated).toBe(true)
  expect(f.request).toHaveBeenCalledTimes(20)
})

it('G4 counts whole-message omissions at the byte budget; G5 retains threaded replies and drops edits', async () => {
  const f = fixture()
  const e = (id: string, body: string, relation?: object) => ({ event_id: id, type: 'm.room.message', sender: '@agent:test', content: { msgtype: 'm.text', body, 'm.relates_to': relation } })
  f.request.mockReset().mockResolvedValue({ chunk: [e('$current', ''), e('$reply', 'answer', { 'm.in_reply_to': { event_id: '$owner' } }), e('$edit', 'edit', { rel_type: 'm.replace' }), e('$large', 'x'.repeat(1_000_000))], end: null })
  const result = await readWorkHistory(f.client, { roomId: '!dm:test', before: '$current', after: null, floor: null })
  expect(result.messages).toMatchObject([{ itemId: '$reply', replyTo: '$owner' }])
  expect(result.omittedMessages).toBe(1)
  expect(result.omittedBytes).toBe(1_000_000)
})

it('G6 captures the newest native event as reset boundary and seeds nothing at that boundary', async () => {
  const f = fixture()
  const boundary = await readWorkHistory(f.client, { roomId: '!dm:test', before: '', after: null, floor: null, boundaryOnly: true })
  expect(boundary.boundary).toBe('$later')
  const next = fixture()
  expect((await readWorkHistory(next.client, { roomId: '!dm:test', before: '$current', after: null, floor: '$current' })).messages).toEqual([])
})
