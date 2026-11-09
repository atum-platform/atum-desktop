import { computed } from 'nanostores'

import { persistentAtom } from '@/lib/persisted'
import { $atumAccountScopeId } from '@/store/atum-messaging'

import type { AtumRosterEntry } from './roster'

export const MAX_CHAT_PINS = 5

function normalizePins(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, MAX_CHAT_PINS)
    : []
}

// Presentation preference, isolated by account. Local assistant session pins
// belong to their existing store and are deliberately unrelated to chat pins.
export const $chatPinsByAccount = persistentAtom<Record<string, string[]>>(
  'atum.desktop.chatPinsByAccount.v1',
  {},
  {
    decode(raw) {
      try {
        const value: unknown = JSON.parse(raw)

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return {}
        }

        return Object.fromEntries(Object.entries(value).map(([key, pins]) => [key, normalizePins(pins)]))
      } catch {
        return {}
      }
    },
    encode: JSON.stringify
  }
)

export const $atumChatPins = computed([$chatPinsByAccount, $atumAccountScopeId], (accounts, accountId) =>
  accountId ? (accounts[accountId] ?? []) : []
)

export function setAtumChatPinned(id: string, pinned: boolean): boolean {
  const accountId = $atumAccountScopeId.get()

  if (!accountId || !id) {
    return false
  }

  const current = $atumChatPins.get()

  if (pinned && !current.includes(id) && current.length >= MAX_CHAT_PINS) {
    return false
  }

  const pins = current.filter(candidate => candidate !== id)
  $chatPinsByAccount.set({ ...$chatPinsByAccount.get(), [accountId]: pinned ? [id, ...pins] : pins })

  return true
}

/** Apply a remote account snapshot only if it still names the foreground account. */
export function setAtumChatPinsForAccount(accountId: string, pins: readonly string[]): boolean {
  if ($atumAccountScopeId.get() !== accountId) {
    return false
  }

  $chatPinsByAccount.set({ ...$chatPinsByAccount.get(), [accountId]: normalizePins(pins) })

  return true
}

export function sortHostedChats(entries: AtumRosterEntry[], pins: readonly string[]): AtumRosterEntry[] {
  const timestamp = (entry: AtumRosterEntry) => {
    const value = Date.parse(entry.activityAt ?? '')

    return Number.isFinite(value) ? value : 0
  }

  return [...entries].sort((a, b) => {
    const left = pins.indexOf(a.id)
    const right = pins.indexOf(b.id)

    if (left !== -1 || right !== -1) {
      return left === -1 ? 1 : right === -1 ? -1 : left - right
    }

    return timestamp(b) - timestamp(a)
  })
}
