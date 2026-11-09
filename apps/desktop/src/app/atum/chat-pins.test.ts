import type { WritableAtom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/atum-messaging', async () => {
  const { atom } = await import('nanostores')

  return { $atumAccountScopeId: atom<null | string>('account-a') }
})

const { $atumAccountScopeId } = await import('@/store/atum-messaging')
const accountScope = $atumAccountScopeId as WritableAtom<string | null>

const { $atumChatPins, $chatPinsByAccount, setAtumChatPinned, setAtumChatPinsForAccount, sortHostedChats } =
  await import('./chat-pins')

import type { AtumRosterEntry } from './roster'

beforeEach(() => {
  $chatPinsByAccount.set({})
  accountScope.set('account-a')
})

describe('chat pin preferences', () => {
  it('refuses a sixth pin but allows an existing pin and unpinning at the limit', () => {
    for (let i = 0; i < 5; i++) {
      expect(setAtumChatPinned(`chat-${i}`, true)).toBe(true)
    }

    expect(setAtumChatPinned('sixth', true)).toBe(false)
    expect(setAtumChatPinned('chat-0', true)).toBe(true)
    expect($atumChatPins.get()).toHaveLength(5)
    expect(setAtumChatPinned('chat-1', false)).toBe(true)
    expect(setAtumChatPinned('sixth', true)).toBe(true)
    expect($atumChatPins.get()).toHaveLength(5)
  })

  it('isolates account switches and refuses signed-out pin writes', () => {
    setAtumChatPinned('private-chat', true)
    accountScope.set('account-b')
    expect($atumChatPins.get()).toEqual([])
    setAtumChatPinned('other-chat', true)
    accountScope.set('account-a')
    expect($atumChatPins.get()).toEqual(['private-chat'])
    accountScope.set(null)
    expect(setAtumChatPinned('anonymous', true)).toBe(false)
    expect($atumChatPins.get()).toEqual([])
  })

  it('does not let a stale remote account write the foreground pins', () => {
    expect(setAtumChatPinsForAccount('account-b', ['foreign-chat'])).toBe(false)
    expect($atumChatPins.get()).toEqual([])

    expect(setAtumChatPinsForAccount('account-a', ['current-chat'])).toBe(true)
    expect($atumChatPins.get()).toEqual(['current-chat'])
  })

  it('sorts apps and people together by latest activity, with pins first', () => {
    const entries = [
      { id: 'old-app', kind: 'app', activityAt: '2026-01-01T00:00:00Z' },
      { id: 'new-person', kind: 'direct', activityAt: '2026-03-01T00:00:00Z' },
      { id: 'middle-group', kind: 'group', activityAt: '2026-02-01T00:00:00Z' }
    ] as AtumRosterEntry[]

    expect(sortHostedChats(entries, []).map(row => row.id)).toEqual(['new-person', 'middle-group', 'old-app'])
    expect(sortHostedChats(entries, ['old-app']).map(row => row.id)).toEqual(['old-app', 'new-person', 'middle-group'])
    expect(entries[0]!.id).toBe('old-app')
  })
})
