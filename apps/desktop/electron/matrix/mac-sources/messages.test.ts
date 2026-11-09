import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import {
  MacMessagesReadError,
  readMessageConversations,
  readMessages
} from './messages'
import { createFixtureDatabase } from './test-fixtures'

const temporary: string[] = []
const fixture = (directory: string) => {
  temporary.push(directory)

  return createFixtureDatabase('messages', path.join(directory, 'chat.db'))
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')

  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('fixture-only Messages reads', () => {
  it('uses the Apple nanosecond epoch and returns bounded relationship metadata without handles', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const directory = await mkdtemp(path.join(tmpdir(), 'atum-messages-'))
    const result = readMessageConversations(
      { days: 10, limit: 40 },
      { databasePath: fixture(directory), now: () => Date.parse('2026-10-28T12:00:00.000Z') }
    )

    expect(result.conversations).toHaveLength(2)
    expect(result.conversations[0]).toMatchObject({
      id: '1',
      title: 'Family plans',
      isGroup: true,
      messageCount: 5,
      lastActivity: '2026-10-27T16:00:00.000Z'
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('+8490')
    expect(serialized).not.toContain('friend@example')
    expect(result.conversations[1]?.title).toBe('Conversation 2')
  })

  it('drops OTPs, redacts private details, marks attachments, and reports skipped attributed bodies', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const directory = await mkdtemp(path.join(tmpdir(), 'atum-message-read-'))
    const result = readMessages(
      { id: '1', days: 10, limit: 60 },
      { databasePath: fixture(directory), now: () => Date.parse('2026-10-28T12:00:00.000Z') }
    )

    expect(result.omittedAttributedBodies).toBe(1)
    expect(result.messages.map(message => message.text)).toEqual([
      'Photo',
      'Sounds good',
      'Dinner Sunday at 7. Address [private address]. Call [private number] or see [private link]'
    ])
    expect(JSON.stringify(result)).not.toContain('123456')
    expect(JSON.stringify(result)).not.toContain('?token=')
    expect(result.usage).toContain('never quote')
  })

  it('drops spaced OTPs and strips hostile URLs, Vietnamese phones, and suffix-free addresses', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const directory = await mkdtemp(path.join(tmpdir(), 'atum-message-hostile-'))
    const result = readMessages(
      { id: '99', days: 10, limit: 60 },
      { databasePath: fixture(directory), now: () => Date.parse('2026-10-28T12:00:00.000Z') }
    )
    const serialized = JSON.stringify(result)

    for (const secret of [
      'G-123456',
      '123 456',
      '123-456',
      'Mã OTP',
      '4 8 2 9 1 7',
      '090.123.4567',
      '+84 90 123 4567',
      '(028) 3823 4567',
      '090/123/4567',
      '123 Nguyen Trai',
      '45 Lê Lợi',
      '12/3 Nguyễn Huệ',
      'eyJhbGci',
      'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      '0123456789abcdef0123456789abcdef',
      'X-Amz',
      'access_token',
      '?code='
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(result.messages).toHaveLength(16)
    expect(result.messages.filter(message => message.text.includes('[private number]'))).toHaveLength(4)
    expect(result.messages.filter(message => message.text.includes('[private address]'))).toHaveLength(3)
    expect(result.messages.filter(message => message.text.includes('[private link]'))).toHaveLength(9)
  })

  it('distinguishes permission failures from unreadable schemas', async () => {
    const denied = () => {
      const error = new Error('permission denied') as Error & { code: string }
      error.code = 'EACCES'
      throw error
    }

    expect(() =>
      readMessageConversations(
        { days: 1, limit: 1 },
        { databasePath: '/fixture/denied.db', open: denied }
      )
    ).toThrowError(new MacMessagesReadError('permission_needed'))

    const database = new DatabaseSync(':memory:')
    expect(() =>
      readMessageConversations(
        { days: 1, limit: 1 },
        { databasePath: ':memory:', open: () => database }
      )
    ).toThrowError(new MacMessagesReadError('unavailable'))
  })
})
