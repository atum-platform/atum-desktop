import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { isCompanyConversationRoom } from '../../shared/matrix-company-channel-room'

import type { CompanyConfirmationScope } from './company-room-guard'

/**
 * A company conversation (a company DM or group DM) is whatever the platform's conversation directory
 * lists for this account, in the room it names. A room's own create event can be written by anyone, so a
 * room that merely claims the type is never shown to the window: not in the room list, not as the open
 * chat, not as a notification. This is the conversation counterpart of `CompanyChannelConfirmations`, with
 * one difference on purpose: a channel claim the directory does not back is shown as an ordinary room (it
 * can be declined or left like any invitation); a conversation claim is shown **nowhere**, because its
 * messages must never reach Home or Personal, not even when the directory cannot be read.
 *
 * Every answer is fenced by the signed-in session (`activate`), expires on its own, and is replaced
 * wholesale by the next read: a participant who was removed stops being confirmed at the next read.
 */
type Confirmation = { at: number; conversations: Map<string, string> | undefined }

/** The ready rooms of a conversation directory read, by conversation id; undefined when the shape is not one. */
function readyConversations(value: unknown, companyId: string): Map<string, string> | undefined {
  const list = value && typeof value === 'object' ? Reflect.get(value, 'conversations') : undefined

  if (!Array.isArray(list)) {
    return undefined
  }

  const rooms = new Map<string, string>()

  for (const item of list) {
    if (item?.companyId === companyId && typeof item.id === 'string' && item.room?.state === 'ready' && typeof item.room.roomId === 'string') {
      rooms.set(item.id, item.room.roomId)
    }
  }

  return rooms
}

const sameScope = (a: CompanyConfirmationScope | null, b: CompanyConfirmationScope | null) =>
  a?.accountKey === b?.accountKey && a?.generation === b?.generation

export class CompanyConversationConfirmations {
  private scope: CompanyConfirmationScope | null = null
  private epoch = 0
  private abort = new AbortController()
  private readonly known = new Map<string, Confirmation>()
  private readonly loading = new Set<string>()
  private readonly timers = new Map<string, { timer: ReturnType<typeof setTimeout>; due: number }>()
  private wanted = new Set<string>()
  /** Companies with a claim the last read did not list: they are looked at again on the short interval. */
  private unlisted = new Set<string>()

  constructor(
    private readonly ports: {
      read: (companyId: string, signal: AbortSignal) => Promise<unknown>
      /** Called when a read settles with a different answer than before. */
      changed: () => void
      now?: () => number
    },
    private readonly staleMs = 60_000,
    private readonly failedMs = 10_000,
    /** A claim the last read did not list is looked for again this soon: a new conversation's room may be listed a moment later. */
    private readonly unlistedMs = 5_000
  ) {}

  /** Binds the confirmations to one signed-in session; any other session starts from nothing. */
  activate(scope: CompanyConfirmationScope | null) {
    if (sameScope(scope, this.scope)) {
      return
    }

    this.scope = scope
    this.epoch += 1
    this.abort.abort()
    this.abort = new AbortController()
    this.known.clear()
    this.loading.clear()
    this.wanted = new Set()

    this.unlisted = new Set()

    for (const { timer } of this.timers.values()) {
      clearTimeout(timer)
    }

    this.timers.clear()
  }

  /** Quit: nothing reads or republishes afterwards. */
  stop() {
    this.activate(null)
  }

  /** Whether the directory, as last read for this session, lists this room as exactly this conversation. */
  confirms(room: Pick<MatrixRoom, 'id' | 'companyConversation'>): boolean {
    const binding = room.companyConversation

    return Boolean(this.scope && binding && this.known.get(binding.companyId)?.conversations?.get(binding.conversationId) === room.id)
  }

  /**
   * The one projection of a snapshot for any renderer (push, pull, notifications): an unconfirmed claim is
   * removed, and a chat open on one loses its transcript and its power to post.
   */
  project<T extends MatrixSnapshot>(snapshot: T): T {
    const rooms = this.view(snapshot.rooms)

    if (rooms === snapshot.rooms) {
      return snapshot
    }

    const open = snapshot.roomId !== null && !rooms.some(room => room.id === snapshot.roomId)
      && snapshot.rooms.some(room => room.id === snapshot.roomId)

    return open
      ? {
          ...snapshot,
          rooms,
          roomId: null,
          destination: null,
          messages: [],
          members: [],
          canSend: false,
          typing: [],
          threads: [],
          membershipLines: []
        }
      : { ...snapshot, rooms }
  }

  view(rooms: MatrixRoom[]): MatrixRoom[] {
    if (!rooms.some(room => isCompanyConversationRoom(room))) {
      this.wanted = new Set()
      this.unlisted = new Set()

      return rooms
    }

    const wanted = new Set<string>()
    const unlisted = new Set<string>()

    const next = rooms.filter(room => {
      if (!isCompanyConversationRoom(room)) {
        return true
      }

      const binding = room.companyConversation

      // No readable binding, or no session: there is nothing to ask the directory about, so it is not shown.
      if (!binding || !this.scope) {
        return false
      }

      wanted.add(binding.companyId)
      const known = this.known.get(binding.companyId)
      const listed = known?.conversations?.get(binding.conversationId) === room.id
      this.refresh(binding.companyId, known, listed)

      if (!listed) {
        unlisted.add(binding.companyId)
      }

      return listed
    })

    this.wanted = wanted
    this.unlisted = unlisted

    // A claim that turned up after the last read is looked for on the short interval, not only on the long one.
    for (const companyId of unlisted) {
      const known = this.known.get(companyId)

      if (known && !this.loading.has(companyId)) {
        this.expireLater(companyId, known)
      }
    }

    return next
  }

  private refresh(companyId: string, known: Confirmation | undefined, listed: boolean) {
    const now = this.ports.now?.() ?? Date.now()

    if (this.loading.has(companyId) || (known && now - known.at < (listed ? this.ttl(known) : Math.min(this.ttl(known), this.unlistedMs)))) {
      return
    }

    this.read(companyId)
  }

  private ttl(known: Confirmation) {
    return known.conversations ? this.staleMs : this.failedMs
  }

  private read(companyId: string) {
    const epoch = this.epoch
    this.loading.add(companyId)
    clearTimeout(this.timers.get(companyId)?.timer)
    this.timers.delete(companyId)

    void this.ports.read(companyId, this.abort.signal).then(
      value => readyConversations(value, companyId),
      () => undefined
    ).then(conversations => {
      // A different session or a quit: this answer is void.
      if (epoch !== this.epoch) {
        return
      }

      this.loading.delete(companyId)
      const before = this.known.get(companyId)
      const known = { at: this.ports.now?.() ?? Date.now(), conversations }
      this.known.set(companyId, known)
      this.expireLater(companyId, known)

      if (!before || JSON.stringify([...(before.conversations ?? [])]) !== JSON.stringify([...(conversations ?? [])])) {
        this.ports.changed()
      }
    })
  }

  /**
   * Re-reads while some room of this company still claims a conversation; republishes only on a change. The wait is the
   * long one while every claim is listed and the short one while any is not: a new conversation's room is listed a
   * moment after it appears, and nothing else in the window asks again. A shorter wait already set is never lengthened.
   */
  private expireLater(companyId: string, known: Confirmation) {
    const epoch = this.epoch
    const now = this.ports.now?.() ?? Date.now()
    const wait = this.unlisted.has(companyId) ? Math.min(this.ttl(known), this.unlistedMs) : this.ttl(known)
    const due = Math.max(known.at, 0) + wait
    const pending = this.timers.get(companyId)

    if (pending && pending.due <= due) {
      return
    }

    clearTimeout(pending?.timer)

    const timer = setTimeout(() => {
      this.timers.delete(companyId)

      if (epoch !== this.epoch) {
        return
      }

      if (!this.wanted.has(companyId)) {
        this.known.delete(companyId)
        this.unlisted.delete(companyId)

        return
      }

      this.read(companyId)
    }, Math.max(0, due - now))

    timer.unref?.()
    this.timers.set(companyId, { timer, due })
  }
}
