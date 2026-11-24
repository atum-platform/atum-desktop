import { describe, expect, it } from 'vitest'

import type { MatrixRoom } from '../../shared/matrix'
import type { MatrixDriveView } from '../../shared/matrix-drive'

import { matrixChatRailBadge, matrixDriveRailBadge, matrixStoreRailBadge, matrixWorkRailBadge } from './rail-badges'

const labels = { waiting: 'Waiting for you', new: 'New' }

function room(over: Partial<MatrixRoom>): MatrixRoom {
  return { id: over.id ?? '!r', name: 'r', membership: 'join', ...over } as MatrixRoom
}

describe('matrixChatRailBadge', () => {
  it('counts conversations waiting for the person, not messages, plus assistant asks', () => {
    const badge = matrixChatRailBadge(
      [room({ id: '!a', unreadNotifications: 5 }), room({ id: '!b', highlights: 1, unreadNotifications: 1 })],
      1,
      labels
    )

    expect(badge).toEqual({ kind: 'waiting', count: 3, label: labels.waiting })
  })

  it('agrees with the roster row: quiet activity and marks are an ink dot', () => {
    expect(matrixChatRailBadge([room({ unread: true, muted: true })], 0, labels)?.kind).toBe('new')
    expect(matrixChatRailBadge([room({ markedUnread: true })], 0, labels)?.kind).toBe('new')
  })

  it('leaves Team Space rooms and rooms not joined to their own badges', () => {
    const company = room({ unreadNotifications: 2, companyChannel: { companyId: 'c', channelId: 'x' } })
    const invited = room({ membership: 'invite', unreadNotifications: 2 })

    expect(matrixChatRailBadge([company, invited], 0, labels)).toBeUndefined()
  })
})

describe('matrixDriveRailBadge', () => {
  const view = (over: Partial<MatrixDriveView>) =>
    ({ state: 'ready', revision: 1, canGoBack: false, rows: [], truncated: false, ...over }) as MatrixDriveView

  it('is a red dot only for a problem the person must fix', () => {
    expect(matrixDriveRailBadge(view({ state: 'error' }), 'Drive problem')?.kind).toBe('problem')
    expect(matrixDriveRailBadge(view({ issues: [{ id: '1', code: 'conflicts', count: 2 }] }), 'p')?.kind).toBe('problem')
    expect(matrixDriveRailBadge(view({ state: 'disconnected', problem: 'folder_changed' }), 'p')?.kind).toBe('problem')
  })

  it('stays quiet while Drive is fine, off, or syncing', () => {
    expect(matrixDriveRailBadge(view({ state: 'syncing' }), 'p')).toBeUndefined()
    expect(matrixDriveRailBadge(view({ state: 'disconnected' }), 'p')).toBeUndefined()
    expect(matrixDriveRailBadge(null, 'p')).toBeUndefined()
  })
})

describe('Work and Store badges (layout r2 G)', () => {
  const labels = { waiting: 'Waiting for you', new: 'Something new' }

  it('Work: a red count while threads ask for the person, else an ink dot for one that finished', () => {
    expect(matrixWorkRailBadge(null, labels)).toBeUndefined()
    expect(matrixWorkRailBadge({ waiting: 0, finished: 0 }, labels)).toBeUndefined()
    expect(matrixWorkRailBadge({ waiting: 2, finished: 3 }, labels)).toEqual({ kind: 'waiting', count: 2, label: labels.waiting })
    expect(matrixWorkRailBadge({ waiting: 0, finished: 1 }, labels)).toEqual({ kind: 'new', label: labels.new })
  })

  it('Store: an ink dot only for something that arrived after the Store was last opened', () => {
    const grant = (grantedAt: string, state: 'active' | 'revoked' = 'active') => ({
      id: grantedAt,
      itemId: 'skill/a',
      kind: 'skill' as const,
      state,
      assistantId: null,
      delivery: 'cloud' as const,
      grantedAt,
      subscription: null
    })

    const store = (entitlements: ReturnType<typeof grant>[]) => ({
      state: 'ready' as const,
      items: [],
      entitlements,
      purchases: [],
      pending: []
    })

    const seen = Date.parse('2026-11-24T10:00:00Z')

    expect(matrixStoreRailBadge(store([grant('2026-11-24T09:00:00Z')]), seen, 'Arrived')).toBeUndefined()
    expect(matrixStoreRailBadge(store([grant('2026-11-24T11:00:00Z')]), seen, 'Arrived')).toEqual({ kind: 'new', label: 'Arrived' })
    expect(matrixStoreRailBadge(store([grant('2026-11-24T11:00:00Z', 'revoked')]), seen, 'Arrived')).toBeUndefined()
    // No record yet: nothing already there counts as new.
    expect(matrixStoreRailBadge(store([grant('2026-11-24T11:00:00Z')]), null, 'Arrived')).toBeUndefined()
  })
})
