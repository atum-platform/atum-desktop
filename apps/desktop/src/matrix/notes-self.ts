import { EventType, type MatrixClient, Preset, type Room } from 'matrix-js-sdk'

import {
  MATRIX_NOTES_SELF_COMPANY_ID,
  MATRIX_NOTES_SELF_COMPANY_KEY,
  MATRIX_NOTES_SELF_ROOM_TYPE,
  MATRIX_NOTES_SELF_TAG,
  matrixNotesSelfAccountData,
  type MatrixNotesSelfDuplicate,
  type MatrixNotesSelfScopeSnapshot,
  type MatrixNotesSelfSnapshot,
  readMatrixNotesSelfPointer
} from '../../shared/matrix-notes-self'

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    'com.atum.notes_self': { version: 1; room_id: string }
  }
}

type NotesContent = 'empty' | 'notes' | 'unknown'

interface NotesRoom {
  content: NotesContent
  createdAt: number
  room: Room
}

interface NotesInspection {
  candidates: NotesRoom[]
  quarantined: Room[]
  retired: Room[]
  winner?: NotesRoom
}

const CREATE_WAIT_MS = 15_000

function creation(room: Room) {
  const event = room.currentState.getStateEvents(EventType.RoomCreate, '')

  return event && !Array.isArray(event) ? event : undefined
}

function tombstone(room: Room) {
  const event = room.currentState.getStateEvents(EventType.RoomTombstone, '')

  return event && !Array.isArray(event) ? event : undefined
}

function pendingEvents(room: Room): ReturnType<Room['getPendingEvents']> {
  try {
    return room.getPendingEvents()
  } catch {
    return []
  }
}

function roomContent(room: Room): NotesContent {
  const events = room.getLiveTimeline().getEvents()
  // The client runs with chronological pending-event ordering, where local echoes already sit in
  // the live timeline and Room.getPendingEvents() throws. That throw escaped startup inspection and
  // stopped the person's sync for good once a notes room existed. Read pending events only when the
  // client keeps a detached pending list.
  const pending = pendingEvents(room)

  if (
    events.some(event => event.getType() === EventType.RoomMessage && !event.isRedacted()) ||
    pending.some(event => event.getType() === EventType.RoomMessage && !event.isRedacted())
  ) {
    return 'notes'
  }

  // A limited timeline cannot prove absence. Retain it like a non-empty duplicate.
  return events[0]?.getType() === EventType.RoomCreate ? 'empty' : 'unknown'
}

function audienceChanged(room: Room, ownerId: string): boolean {
  const active = room
    .getMembers()
    .filter(member => ['join', 'invite'].includes(member.membership ?? ''))

  return active.length !== 1 || active[0]?.userId !== ownerId || active[0]?.membership !== 'join'
}

/**
 * Matrix-native authority inspection. The immutable create type and creator are the marker;
 * room name, tags, pointers and member count alone never establish notes ownership.
 */
export function inspectMatrixNotesSelfRooms(
  rooms: readonly Room[],
  ownerId: string,
  companyId?: string
): NotesInspection {
  const candidates: NotesRoom[] = []
  const quarantined: Room[] = []
  const retired: Room[] = []

  for (const room of rooms) {
    try {
      if (room.getMyMembership() !== 'join') {
        continue
      }

      const created = creation(room)

      const content = created?.getContent()
      const hasCompanyId = Boolean(content && Object.hasOwn(content, MATRIX_NOTES_SELF_COMPANY_KEY))

      const createdCompanyId = typeof content?.[MATRIX_NOTES_SELF_COMPANY_KEY] === 'string'
        ? content[MATRIX_NOTES_SELF_COMPANY_KEY]
        : undefined

      const scopeMatches = companyId ? createdCompanyId === companyId : !hasCompanyId

      if (
        !created ||
        content?.type !== MATRIX_NOTES_SELF_ROOM_TYPE ||
        !scopeMatches ||
        created.getSender() !== ownerId
      ) {
        continue
      }

      if (audienceChanged(room, ownerId)) {
        quarantined.push(room)

        continue
      }

      const replacement = tombstone(room)?.getContent()?.replacement_room

      if (typeof replacement === 'string' && replacement.startsWith('!')) {
        retired.push(room)

        continue
      }

      let projectedContent: NotesContent = 'unknown'

      try {
        projectedContent = roomContent(room)
      } catch {
        // The immutable room marker and audience are still authoritative. Retain a room whose
        // timeline cannot currently be projected as unknown; only proven-empty duplicates retire.
      }

      candidates.push({
        room,
        createdAt: created.getTs(),
        content: projectedContent
      })
    } catch {
      // One corrupt or partially restored room must not abort inspection of every other room.
      // Without enough state to establish ownership and audience, skip it until a later sync.
    }
  }

  candidates.sort((left, right) => left.createdAt - right.createdAt || left.room.roomId.localeCompare(right.room.roomId))
  quarantined.sort((left, right) => left.roomId.localeCompare(right.roomId))
  retired.sort((left, right) => left.roomId.localeCompare(right.roomId))

  return { candidates, quarantined, retired, winner: candidates[0] }
}

function validCreatedRoom(value: unknown): value is { room_id: string } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { room_id?: unknown }).room_id === 'string' &&
    (value as { room_id: string }).room_id.startsWith('!')
  )
}

/**
 * One per-sdk-client notes controller. Sync remains the source of truth: create replies only name
 * a pending room, and a lost reply closes creation until a later sync discovers it or proves it absent.
 */
function matrixNotesSelfScope(
  client: MatrixClient,
  ownerId: string,
  companyId: string | undefined,
  active: () => boolean,
  changed: () => void,
  createWaitMs = CREATE_WAIT_MS
) {
  let stopped = false
  let syncRevision = 0
  let uncertainAt: number | undefined
  let pendingRoomId: string | undefined
  let opening: Promise<string> | undefined
  let reconciling: Promise<MatrixNotesSelfSnapshot> | undefined
  const tagged = new Set<string>()
  const redirected = new Set<string>()
  const waiters = new Set<() => void>()

  const live = () => !stopped && active() && client.getUserId() === ownerId

  const accountDataType = matrixNotesSelfAccountData(companyId)
  const pointer = () => readMatrixNotesSelfPointer(client.getAccountData(accountDataType as never)?.getContent())
  // SDK methods require their MatrixClient receiver (credentials + HTTP transport).
  const writePointer = client.setAccountDataRaw.bind(client) as unknown as (
    eventType: string,
    content: { version: 1; room_id: string }
  ) => Promise<unknown>

  const inspection = () => inspectMatrixNotesSelfRooms(client.getRooms(), ownerId, companyId)

  const view = (): MatrixNotesSelfScopeSnapshot => {
    const rooms = inspection()
    const read = pointer()
    const duplicates: MatrixNotesSelfDuplicate[] = rooms.candidates.slice(1).flatMap(candidate =>
      candidate.content === 'empty' ? [] : [{ roomId: candidate.room.roomId, content: candidate.content }]
    )

    const common = {
      duplicates,
      quarantinedRoomIds: rooms.quarantined.map(room => room.roomId),
      retiredRoomIds: rooms.retired.map(room => room.roomId),
      pointerWritable: read.state !== 'readonly'
    }

    if (rooms.winner) {
      return { ...common, state: 'ready', roomId: rooms.winner.room.roomId }
    }

    if (uncertainAt !== undefined || pendingRoomId) {
      return { ...common, state: 'uncertain' }
    }

    if (rooms.quarantined.length > 0) {
      return { ...common, state: 'quarantined' }
    }

    if (read.state === 'readonly') {
      return { ...common, state: 'readonly' }
    }

    return { ...common, state: 'uncreated' }
  }

  const wake = () => {
    for (const waiter of [...waiters]) {
      waiter()
    }
  }

  const converge = async (): Promise<MatrixNotesSelfScopeSnapshot> => {
    const rooms = inspection()
    const winner = rooms.winner
    const read = pointer()

    if (winner) {
      uncertainAt = undefined
      pendingRoomId = undefined

      if (live() && read.state !== 'readonly' && (read.state !== 'known' || read.value.room_id !== winner.room.roomId)) {
        await writePointer(accountDataType, {
          version: 1,
          room_id: winner.room.roomId
        })
      }

      if (live() && !tagged.has(winner.room.roomId) && !Object.hasOwn(winner.room.tags, MATRIX_NOTES_SELF_TAG)) {
        await client.setRoomTag(winner.room.roomId, MATRIX_NOTES_SELF_TAG, { order: 0 })
        tagged.add(winner.room.roomId)
      }

      for (const duplicate of rooms.candidates.slice(1)) {
        if (
          !live() ||
          duplicate.content !== 'empty' ||
          redirected.has(duplicate.room.roomId) ||
          tombstone(duplicate.room)
        ) {
          continue
        }

        try {
          await client.sendStateEvent(
            duplicate.room.roomId,
            EventType.RoomTombstone,
            {
              body: 'Personal notes moved to the earlier room.',
              replacement_room: winner.room.roomId
            },
            ''
          )
          redirected.add(duplicate.room.roomId)
        } catch {
          // Retiring an empty duplicate is housekeeping, never a gate on opening the winner.
          // Leave it intact and retry on later discovery (e.g. after connectivity recovers).
        }
      }
    } else if (uncertainAt !== undefined && syncRevision > uncertainAt) {
      // One later successful sync did not contain the uncertain create. A retry may now create.
      uncertainAt = undefined
      pendingRoomId = undefined
    }

    const next = view()
    changed()
    wake()

    return next
  }

  const reconcile = () => {
    if (reconciling) {
      return reconciling
    }

    reconciling = converge().finally(() => {
      reconciling = undefined
    })

    return reconciling
  }

  const waitForDiscovery = (roomId: string) => new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = () => {
      if (stopped) {
        finish(new Error('matrix_notes_self_stale'))

        return
      }

      const snapshot = view()

      if (snapshot.state === 'ready' && snapshot.roomId) {
        finish(undefined, snapshot.roomId)
      } else if (uncertainAt === undefined && pendingRoomId === undefined) {
        finish(new Error('matrix_notes_self_create_unconfirmed'))
      }
    }

    const finish = (error?: Error, value?: string) => {
      waiters.delete(settle)

      if (timer) {
        clearTimeout(timer)
      }

      if (error) {
        reject(error)
      } else {
        resolve(value ?? roomId)
      }
    }

    waiters.add(settle)
    timer = setTimeout(() => finish(new Error('matrix_notes_self_uncertain')), createWaitMs)
    settle()
  })

  const canUse = (roomId: string): boolean => {
    const snapshot = view()

    return snapshot.state === 'ready' && snapshot.roomId === roomId
  }

  return {
    snapshot: view,

    async observedSync(): Promise<void> {
      syncRevision += 1
      await reconcile()
    },

    async observedRoom(): Promise<void> {
      await reconcile()
    },

    ensure(): Promise<string> {
      if (opening) {
        return opening
      }

      opening = (async () => {
        let snapshot = await reconcile()

        if (snapshot.state === 'ready' && snapshot.roomId) {
          return snapshot.roomId
        }

        // A changed audience disqualifies that room, not the owner's ability to keep notes.
        if (snapshot.state !== 'uncreated' && snapshot.state !== 'quarantined') {
          throw new Error(`matrix_notes_self_${snapshot.state}`)
        }

        if (!live()) {
          throw new Error('matrix_notes_self_offline')
        }

        uncertainAt = syncRevision
        changed()

        let created: unknown

        try {
          created = await client.createRoom({
            preset: Preset.PrivateChat,
            creation_content: {
              type: MATRIX_NOTES_SELF_ROOM_TYPE,
              ...(companyId ? { [MATRIX_NOTES_SELF_COMPANY_KEY]: companyId } : {})
            },
            initial_state: [
              {
                type: EventType.RoomHistoryVisibility,
                state_key: '',
                content: { history_visibility: 'joined' }
              },
              {
                type: EventType.RoomGuestAccess,
                state_key: '',
                content: { guest_access: 'forbidden' }
              }
            ]
          })
        } catch {
          changed()
          throw new Error('matrix_notes_self_uncertain')
        }

        if (!validCreatedRoom(created)) {
          throw new Error('matrix_notes_self_uncertain')
        }

        pendingRoomId = created.room_id
        snapshot = await reconcile()

        if (snapshot.state === 'ready' && snapshot.roomId) {
          return snapshot.roomId
        }

        return waitForDiscovery(created.room_id)
      })().finally(() => {
        opening = undefined
      })

      return opening
    },

    canUse,

    assertSend(roomId: string): void {
      if (!canUse(roomId)) {
        throw new Error('matrix_notes_self_quarantined')
      }
    },

    stop(): void {
      stopped = true
      pendingRoomId = undefined
      uncertainAt = undefined
      wake()
      waiters.clear()
    }
  }
}

/**
 * One Matrix-native controller per notes scope. The legacy unscoped room stays readable for
 * compatibility while each company gets an independent immutable room and account-data pointer.
 */
export function matrixNotesSelf(
  client: MatrixClient,
  ownerId: string,
  active: () => boolean,
  changed: () => void,
  createWaitMs = CREATE_WAIT_MS
) {
  const personal = matrixNotesSelfScope(client, ownerId, undefined, active, changed, createWaitMs)
  const companies = new Map<string, ReturnType<typeof matrixNotesSelfScope>>()

  const controller = (companyId: string) => {
    if (!MATRIX_NOTES_SELF_COMPANY_ID.test(companyId)) {
      throw new Error('matrix_notes_self_company_invalid')
    }

    let value = companies.get(companyId)
    if (!value) {
      value = matrixNotesSelfScope(client, ownerId, companyId, active, changed, createWaitMs)
      companies.set(companyId, value)
    }

    return value
  }

  const discover = () => {
    for (const room of client.getRooms()) {
      try {
        const event = creation(room)
        const content = event?.getContent()
        const companyId = content?.[MATRIX_NOTES_SELF_COMPANY_KEY]

        if (
          content?.type === MATRIX_NOTES_SELF_ROOM_TYPE &&
          typeof companyId === 'string' &&
          MATRIX_NOTES_SELF_COMPANY_ID.test(companyId)
        ) {
          controller(companyId)
        }
      } catch {
        // Discovery is advisory until a room's state is readable. Keep projecting other scopes.
      }
    }
  }

  const all = () => {
    discover()

    return [personal, ...companies.values()]
  }

  return {
    snapshot(): MatrixNotesSelfSnapshot {
      discover()
      const companySnapshots = Object.fromEntries(
        [...companies].map(([companyId, value]) => [companyId, value.snapshot()])
      )

      return {
        ...personal.snapshot(),
        ...(companies.size > 0 ? { companies: companySnapshots } : {})
      }
    },

    async observedSync(): Promise<void> {
      await Promise.all(all().map(value => value.observedSync()))
    },

    async observedRoom(): Promise<void> {
      await Promise.all(all().map(value => value.observedRoom()))
    },

    ensure(companyId?: string): Promise<string> {
      return companyId ? controller(companyId).ensure() : personal.ensure()
    },

    canUse(roomId: string): boolean {
      return all().some(value => value.canUse(roomId))
    },

    assertSend(roomId: string): void {
      if (!all().some(value => value.canUse(roomId))) {
        throw new Error('matrix_notes_self_quarantined')
      }
    },

    stop(): void {
      for (const value of all()) {
        value.stop()
      }
      companies.clear()
    }
  }
}
