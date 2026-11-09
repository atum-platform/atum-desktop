import { describe, expect, it } from 'vitest'

import { petChatAnswered, petChatUnsaved } from './pet-chat-thread'
import type { AtumPetChatTurn } from './pet-chat/atum-pet-chat'

const user = (text: string, at = '2026-11-01T08:00:00.000Z'): AtumPetChatTurn => ({ role: 'user', text, at })
const pet = (text: string, at = '2026-11-01T08:00:01.000Z'): AtumPetChatTurn => ({ role: 'pet', text, at })
const sent = (text: string) => ({ text, at: '2026-11-01T08:38:26.000Z' })
const answer = (text: string) => ({ text, at: '2026-11-01T08:38:27.000Z' })

describe('pet chat thread', () => {
  it('shows the answer and the sent words when the reply carries no history', () => {
    expect(petChatUnsaved([], petChatAnswered([], sent('hello'), answer('Gâu!')))).toEqual([
      { role: 'user', text: 'hello', at: '2026-11-01T08:38:26.000Z' },
      { role: 'pet', text: 'Gâu!', at: '2026-11-01T08:38:27.000Z' }
    ])
  })

  it('adds nothing the returned history already holds, whatever its clock says', () => {
    const recent = [
      user('earlier'),
      pet('Chào!'),
      user('hello', '2020-01-01T00:00:00Z'),
      pet('Gâu!', '2020-01-01T00:00:01Z')
    ]

    expect(petChatUnsaved(recent, petChatAnswered([], sent('hello'), answer('Gâu!')))).toEqual([])
  })

  it('keeps an exchange the history lags behind until it holds it', () => {
    const session = petChatAnswered(
      petChatAnswered([], sent('hungry?'), answer('Mình đói.')),
      sent('dinner'),
      answer('Ăn thôi!')
    )

    // The history skipped the first exchange (the platform's fallback) but holds the second.
    expect(petChatUnsaved([pet('Earlier.'), user('dinner'), pet('Ăn thôi!')], session).map(turn => turn.text)).toEqual([
      'hungry?',
      'Mình đói.'
    ])
    // Later the history holds both.
    const caughtUp = [pet('Earlier.'), user('hungry?'), pet('Mình đói.'), user('dinner'), pet('Ăn thôi!')]
    expect(petChatUnsaved(caughtUp, session)).toEqual([])
  })

  it('does not take an old turn with the same words further back for today’s', () => {
    const recent = [user('hi'), pet('Chào!'), user('how are you'), pet('Khoẻ!')]
    expect(petChatUnsaved(recent, petChatAnswered([], sent('hi'), answer('Chào!'))).map(turn => turn.text)).toEqual([
      'hi',
      'Chào!'
    ])
  })

  it('keeps only the sent words when a reply has no words of its own', () => {
    expect(petChatAnswered([], sent('hello'), answer('  ')).map(turn => turn.role)).toEqual(['user'])
  })
})
