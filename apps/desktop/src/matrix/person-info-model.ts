import { useCallback, useEffect, useRef, useState } from 'react'

import type { MatrixMessage, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import type {
  MatrixRoomSharedItem,
  MatrixRoomSharedPage,
  MatrixRoomSharedSection
} from '../../shared/matrix-room-shared'

import { personalChatActions } from './roster-model'

/**
 * Which side panel a chat's header toggle opens. A chat with people (a one-to-one chat with a
 * person, or a personal group) gets the conversation info panel: who they are, what was shared,
 * what you can do to the chat. Assistant, agent, app, Team Space and typed rooms are not personal
 * chats here and keep the workbench.
 */
export type MatrixConversationInfo = { kind: 'person'; userId?: string } | { kind: 'group' }

export function matrixConversationInfo(
  room: MatrixRoom | undefined,
  snapshot: MatrixSnapshot
): MatrixConversationInfo | null {
  if (!room) {
    return null
  }

  const actions = personalChatActions(room, snapshot)

  if (actions.end === 'delete') {
    return { kind: 'person', ...(actions.person ? { userId: actions.person } : {}) }
  }

  return actions.end === 'leave' ? { kind: 'group' } : null
}

/**
 * The Team Spaces you share with a person, as the rooms this device has synced say it: a company
 * channel or conversation both of you are joined to. Display only; the platform owns membership.
 */
export function matrixSharedCompanies(snapshot: MatrixSnapshot, userId: string | undefined): string[] {
  if (!userId) {
    return []
  }

  const companies = new Set<string>()

  for (const room of snapshot.rooms) {
    const companyId = room.companyChannel?.companyId ?? room.companyConversation?.companyId

    if (
      companyId &&
      room.membership === 'join' &&
      room.participants?.some(member => member.userId === userId && member.membership === 'join')
    ) {
      companies.add(companyId)
    }
  }

  return [...companies]
}

/**
 * What would make a section's first page stale: the newest loaded message that could have added
 * to it (an attachment for photos and files, a message with a web address for links). The panel
 * reads again only when this changes, never on every message.
 */
export function matrixSharedRevision(messages: readonly MatrixMessage[], section: MatrixRoomSharedSection): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!

    if (message.pending || message.failed || message.redacted) {
      continue
    }

    if (section === 'links' ? !message.attachment && /https?:\/\//iu.test(message.body) : message.attachment) {
      return message.id
    }
  }

  return ''
}

function sharedPage(value: unknown, section: MatrixRoomSharedSection): MatrixRoomSharedPage {
  const page = value as Partial<MatrixRoomSharedPage> | null

  if (
    !page ||
    page.section !== section ||
    !Array.isArray(page.items) ||
    (page.source !== 'server' && page.source !== 'device') ||
    !Number.isSafeInteger(page.unreadable) ||
    (page.next !== undefined && typeof page.next !== 'string')
  ) {
    throw new Error('matrix_room_shared_unavailable')
  }

  return page as MatrixRoomSharedPage
}

export interface MatrixRoomSharedState {
  items: MatrixRoomSharedItem[]
  state: 'loading' | 'ready' | 'failed'
  more: boolean
  loadingMore: boolean
  /** `device`: an encrypted chat, read and decrypted on this Mac. */
  source?: MatrixRoomSharedPage['source']
  unreadable: number
  loadMore(): void
  retry(): void
}

interface SharedValue {
  key: string
  items: MatrixRoomSharedItem[]
  state: 'loading' | 'ready' | 'failed'
  next?: string
  source?: MatrixRoomSharedPage['source']
  unreadable: number
  /** The newest page's share of `unreadable`, replaced when that page is read again. */
  headUnreadable: number
  loadingMore: boolean
}

/**
 * Loaded pages with a fresh read of the newest page laid over them. The fresh page is the truth for
 * the stretch it covers (new items appear, a deleted one goes); items older than anything it
 * returned stay, and so does the deepest cursor already reached, so "See all" keeps its place.
 * A fresh page that reached the room's start covers everything.
 */
export function matrixRoomSharedRefreshed(
  previous: Pick<SharedValue, 'items' | 'next' | 'unreadable' | 'headUnreadable'>,
  fresh: MatrixRoomSharedPage
): Pick<SharedValue, 'items' | 'next' | 'unreadable' | 'headUnreadable'> {
  if (!fresh.next) {
    return { items: fresh.items, unreadable: fresh.unreadable, headUnreadable: fresh.unreadable }
  }

  const ids = new Set(fresh.items.map(item => item.id))
  const oldest = fresh.items.length ? Math.min(...fresh.items.map(item => item.at)) : Number.POSITIVE_INFINITY
  const older = previous.items.filter(item => !ids.has(item.id) && item.at < oldest)

  return {
    items: [...fresh.items, ...older],
    ...(previous.next ? { next: previous.next } : {}),
    unreadable: Math.max(0, previous.unreadable - previous.headUnreadable) + fresh.unreadable,
    headUnreadable: fresh.unreadable
  }
}

/**
 * One section of what a chat has shared, newest first: a bounded first read when the panel (or
 * "See all") opens, then one more bounded read per `loadMore`. When `revision` moves (something new
 * arrived in the open chat), the newest page is read again and merged into what is already loaded,
 * without a loading flash and without losing older pages. A read for another chat or section
 * never lands in this one (generation guard).
 */
export function useMatrixRoomShared(
  roomId: string,
  section: MatrixRoomSharedSection,
  limit: number,
  revision = ''
): MatrixRoomSharedState {
  const [value, setValue] = useState<SharedValue>({
    key: '',
    items: [],
    state: 'loading',
    unreadable: 0,
    headUnreadable: 0,
    loadingMore: false
  })

  const [attempt, setAttempt] = useState(0)
  const key = `${roomId}\u0000${section}\u0000${limit}\u0000${attempt}`
  const live = useRef(key)
  live.current = key
  // The revision the newest page was last read at, and whether a re-read is under way.
  const readAt = useRef(revision)
  const refreshing = useRef(false)

  useEffect(() => {
    let current = true

    readAt.current = revision
    refreshing.current = false
    setValue({ key, items: [], state: 'loading', unreadable: 0, headUnreadable: 0, loadingMore: false })
    window.atumMatrix
      .command({ kind: 'roomShared', roomId, section, limit })
      .then(raw => {
        const page = sharedPage(raw, section)

        if (current) {
          setValue({
            key,
            items: page.items,
            state: 'ready',
            ...(page.next ? { next: page.next } : {}),
            source: page.source,
            unreadable: page.unreadable,
            headUnreadable: page.unreadable,
            loadingMore: false
          })
        }
      })
      .catch(() => {
        if (current) {
          setValue({ key, items: [], state: 'failed', unreadable: 0, headUnreadable: 0, loadingMore: false })
        }
      })

    return () => {
      current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` is read, not followed: a new one re-reads the newest page below
  }, [key, limit, roomId, section])

  const ready = value.key === key && value.state === 'ready'

  useEffect(() => {
    if (!ready || refreshing.current || readAt.current === revision) {
      return
    }

    const at = revision
    refreshing.current = true
    readAt.current = at
    window.atumMatrix
      .command({ kind: 'roomShared', roomId, section, limit })
      .then(raw => {
        const page = sharedPage(raw, section)

        setValue(previous => {
          if (previous.key !== key || live.current !== key || previous.state !== 'ready') {
            return previous
          }

          // `next` comes from the merge alone: absent there means the room's start was reached.
          const { next: _next, ...rest } = previous

          return { ...rest, ...matrixRoomSharedRefreshed(previous, page), source: page.source }
        })
      })
      // A failed re-read keeps what is shown; the next revision tries again.
      .catch(() => {})
      .finally(() => {
        if (live.current === key) {
          refreshing.current = false
          // Something newer may have arrived while this read was out: read once more.
          setValue(previous => (previous.key === key ? { ...previous } : previous))
        }
      })
  }, [key, limit, ready, revision, roomId, section, value])

  const scoped: SharedValue =
    value.key === key
      ? value
      : { key, items: [], state: 'loading', unreadable: 0, headUnreadable: 0, loadingMore: false }

  const loadMore = useCallback(() => {
    if (value.key !== key || !value.next || value.loadingMore) {
      return
    }

    const from = value.next
    setValue(previous => (previous.key === key ? { ...previous, loadingMore: true } : previous))
    window.atumMatrix
      .command({ kind: 'roomShared', roomId, section, limit, from })
      .then(raw => {
        const page = sharedPage(raw, section)

        setValue(previous => {
          // A re-read of the newest page may have landed meanwhile; only the cursor this read
          // started from may be advanced.
          if (previous.key !== key || live.current !== key || previous.next !== from) {
            return previous.key === key ? { ...previous, loadingMore: false } : previous
          }

          const seen = new Set(previous.items.map(item => item.id))

          return {
            ...previous,
            items: [...previous.items, ...page.items.filter(item => !seen.has(item.id))],
            next: page.next,
            unreadable: previous.unreadable + page.unreadable,
            loadingMore: false
          }
        })
      })
      .catch(() => setValue(previous => (previous.key === key ? { ...previous, loadingMore: false } : previous)))
  }, [key, limit, roomId, section, value])

  return {
    items: scoped.items,
    state: scoped.state,
    more: Boolean(scoped.next),
    loadingMore: scoped.loadingMore,
    ...(scoped.source ? { source: scoped.source } : {}),
    unreadable: scoped.unreadable,
    loadMore,
    retry: () => setAttempt(count => count + 1)
  }
}

/** Pictures already read this window, by room and event: a small in-memory cache, never disk. */
const THUMBNAIL_LIMIT = 96
const THUMBNAIL_PARALLEL = 4
const thumbnails = new Map<string, string | null>()
const thumbnailReads = new Map<string, Promise<string | null>>()
const waiting: Array<() => void> = []
let reading = 0

function remember(key: string, value: string | null) {
  if (thumbnails.size >= THUMBNAIL_LIMIT) {
    const oldest = thumbnails.keys().next().value

    if (oldest !== undefined) {
      thumbnails.delete(oldest)
    }
  }

  thumbnails.set(key, value)
}

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (reading >= THUMBNAIL_PARALLEL) {
    await new Promise<void>(resolve => waiting.push(resolve))
  }

  reading++

  try {
    return await run()
  } finally {
    reading--
    waiting.shift()?.()
  }
}

function readThumbnail(roomId: string, eventId: string): Promise<string | null> {
  const key = `${roomId}\u0000${eventId}`

  if (thumbnails.has(key)) {
    return Promise.resolve(thumbnails.get(key)!)
  }

  const pending = thumbnailReads.get(key)

  if (pending) {
    return pending
  }

  const request = slot(() => window.atumMatrix.command({ kind: 'roomSharedThumbnail', roomId, eventId }))
    .then(value => {
      const url = typeof value === 'string' && value.startsWith('data:image/') ? value : null
      remember(key, url)

      return url
    })
    .finally(() => thumbnailReads.delete(key))

  thumbnailReads.set(key, request)

  return request
}

/** Test seam: forget every picture, as a new window would. */
export function resetMatrixRoomSharedThumbnailsForTest() {
  thumbnails.clear()
  thumbnailReads.clear()
  waiting.length = 0
  reading = 0
}

/** A shared photo's or video's picture: undefined while it loads, null when there is none. */
export function useMatrixRoomSharedThumbnail(roomId: string, item: MatrixRoomSharedItem): string | null | undefined {
  const key = `${roomId}\u0000${item.eventId}`

  const [value, setValue] = useState<{ key: string; url: string | null | undefined }>(() => ({
    key,
    url: item.preview ? thumbnails.get(key) : null
  }))

  useEffect(() => {
    if (!item.preview) {
      return
    }

    let current = true

    readThumbnail(roomId, item.eventId).then(
      url => current && setValue({ key, url }),
      () => current && setValue({ key, url: null })
    )

    return () => {
      current = false
    }
  }, [item.eventId, item.preview, key, roomId])

  return !item.preview ? null : value.key === key ? value.url : thumbnails.get(key)
}
