import { describe, expect, it } from 'vitest'

import { appBotDurableSync, appBotInviteSnapshot } from './sdk'
import { appBotPinnedShield } from './sdk-app-bot'

describe('app-bot durable sync filtering', () => {
  it('keeps encrypted wire events but never writes clear message or local-echo text', () => {
    const sync = {
      rooms: {
        join: {
          '!room:test': {
            timeline: {
              events: [
                { type: 'm.room.encrypted', content: { ciphertext: 'ciphertext-canary' } },
                { type: 'm.room.message', content: { body: 'plaintext-canary' } }
              ]
            }
          }
        }
      }
    }
    const filtered = appBotDurableSync(sync as never)
    expect(filtered.rooms?.join?.['!room:test']?.timeline?.events).toEqual([
      { type: 'm.room.encrypted', content: { ciphertext: 'ciphertext-canary' } }
    ])
    expect(JSON.stringify(filtered)).not.toContain('plaintext-canary')
    expect(JSON.stringify(sync)).toContain('plaintext-canary')
  })

  it('uses only stripped invite state before joining, including the signed direct hint', () => {
    const event = (stateKey: string, sender: string, content: Record<string, unknown>) => ({
      getStateKey: () => stateKey,
      getSender: () => sender,
      getContent: () => content
    })

    expect(appBotInviteSnapshot('invite', true, '@app-moon:atumplatform.com', [
      event('@app-moon:atumplatform.com', '@alice:atumplatform.com', { membership: 'invite', is_direct: true }),
      event('@alice:atumplatform.com', '@alice:atumplatform.com', { membership: 'join' }),
      event('@former:atumplatform.com', '@former:atumplatform.com', { membership: 'leave' })
    ])).toEqual({
      membership: 'invite',
      encrypted: true,
      inviter: '@alice:atumplatform.com',
      isDirect: true,
      members: [
        { userId: '@alice:atumplatform.com', membership: 'join' },
        { userId: '@app-moon:atumplatform.com', membership: 'invite' }
      ]
    })
  })

  it('does not infer directness from incomplete stripped state', () => {
    const event = (stateKey: string, sender: string, content: Record<string, unknown>) => ({
      getStateKey: () => stateKey,
      getSender: () => sender,
      getContent: () => content
    })

    expect(appBotInviteSnapshot('invite', true, '@app-andy:atumplatform.com', [
      event('@app-andy:atumplatform.com', '@alice:atumplatform.com', { membership: 'invite' })
    ])).toEqual({
      membership: 'invite',
      encrypted: true,
      inviter: '@alice:atumplatform.com',
      isDirect: null,
      members: [{ userId: '@app-andy:atumplatform.com', membership: 'invite' }]
    })
  })
})

it('uses a published bot pin only for direct, unsigned or historical device provenance', () => {
  expect([null, 1, 2, 3].every(appBotPinnedShield)).toBe(true)
  expect([undefined, 0, 4, 5, 6, 7, 8].some(appBotPinnedShield)).toBe(false)
})
