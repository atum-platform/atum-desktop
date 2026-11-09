import { afterEach, expect, it } from 'vitest'

import {
  authorizeAutomaticWordBinding,
  recordPendingWordTurn,
  resetWordTurnLedgerForTests,
  settleWordTurn,
  startWordTurn,
  wordBindingForTurn
} from './word-turn-ledger'

afterEach(resetWordTurnLedgerForTests)

it('authorizes only the first binding of an authenticated Automatic turn', () => {
  recordPendingWordTurn('default', 'session', 'submission', { mode: 'automatic', revision: 'automatic' })
  startWordTurn('default', 'session', 'turn', 'submission')
  expect(authorizeAutomaticWordBinding('default', 'session', 'unknown', 'A')).toBe(false)
  expect(authorizeAutomaticWordBinding('default', 'session', 'turn', 'A')).toBe(true)
  expect(wordBindingForTurn('default', 'session', 'turn')).toBe('A')
  expect(authorizeAutomaticWordBinding('default', 'session', 'turn', 'B')).toBe(false)
  settleWordTurn('session', 'turn', 'default')
  expect(authorizeAutomaticWordBinding('default', 'session', 'turn', 'B')).toBe(false)
})

it('revokes old authority when missing settle events exceed the bounded ledger', () => {
  recordPendingWordTurn('default', 'session', 'old', { mode: 'linked', revision: 'a', wordBindingId: 'A' })
  startWordTurn('default', 'session', 'old', 'old')

  for (let i = 0; i < 130; i++) {startWordTurn('default', 'session', `unknown-${i}`)}
  expect(wordBindingForTurn('default', 'session', 'old')).toBeNull()
})

it('pins A for its dispatched turn after the next submit records B', () => {
  recordPendingWordTurn('default', 'session', 'a', { mode: 'linked', revision: 'a', wordBindingId: 'A' })
  recordPendingWordTurn('default', 'session', 'b', { mode: 'linked', revision: 'b', wordBindingId: 'B' })
  startWordTurn('default', 'session', 'turn-a', 'a')
  startWordTurn('default', 'session', 'turn-b', 'b')

  expect(wordBindingForTurn('default', 'session', 'turn-a')).toBe('A')
  expect(wordBindingForTurn('default', 'session', 'turn-b')).toBe('B')
})

it('fails closed for unknown and explicit no-document turns', () => {
  startWordTurn('default', 'session', 'unknown')
  recordPendingWordTurn('default', 'session', 'none', { mode: 'removed', revision: 'removed' })
  startWordTurn('default', 'session', 'without-document', 'none')

  expect(wordBindingForTurn('default', 'session', 'unknown')).toBeNull()
  expect(wordBindingForTurn('default', 'session', 'without-document')).toBeNull()
  settleWordTurn('session', 'without-document', 'default')
  expect(wordBindingForTurn('default', 'session', 'without-document')).toBeNull()
})

it('ignores autonomous and reordered starts without spending another submission', () => {
  recordPendingWordTurn('default', 'session', 'a', { mode: 'linked', revision: 'a', wordBindingId: 'A' })
  recordPendingWordTurn('default', 'session', 'b', { mode: 'linked', revision: 'b', wordBindingId: 'B' })
  startWordTurn('default', 'session', 'autonomous')
  startWordTurn('default', 'session', 'turn-b', 'b')
  startWordTurn('default', 'session', 'turn-a', 'a')
  expect(wordBindingForTurn('default', 'session', 'autonomous')).toBeNull()
  expect(wordBindingForTurn('default', 'session', 'turn-b')).toBe('B')
  expect(wordBindingForTurn('default', 'session', 'turn-a')).toBe('A')
})
