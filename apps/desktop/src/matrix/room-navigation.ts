import { APP_UUID } from '../../shared/app-shortcuts'
import type { MatrixDestination, MatrixRoom } from '../../shared/matrix'

/** Presentation only. Matrix tags remain the account's authoritative favourites. */
export const MATRIX_PIN_LIMIT = 5

export function sortConversations(rooms: readonly MatrixRoom[]): MatrixRoom[] {
  return [...rooms].sort((a, b) => {
    if (Boolean(a.favourite) !== Boolean(b.favourite)) {
      return a.favourite ? -1 : 1
    }

    if (a.favourite && b.favourite) {
      const order = (a.favouriteOrder ?? 2) - (b.favouriteOrder ?? 2)

      if (order) {
        return order
      }
    } else if (Boolean(a.lowPriority) !== Boolean(b.lowPriority)) {
      // Low priority (m.lowpriority) sinks below every other chat, by recency among themselves.
      return a.lowPriority ? 1 : -1
    } else if (Boolean(a.assistant) !== Boolean(b.assistant)) {
      return a.assistant ? -1 : 1
    }

    return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.id.localeCompare(b.id)
  })
}

/** One device-local pointer in the SDK's existing isolated partition, not a roster. */
export function roomSelection(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  userId: string,
  deviceId: string
) {
  const key = `io.atum.selected-room:${JSON.stringify([userId, deviceId])}`

  return {
    readDestination(): MatrixDestination | null {
      try {
        const value = storage.getItem(key)

        if (!value) {
          return null
        }

        if (value.startsWith('!') && value.length <= 1024) {
          return { kind: 'room', roomId: value }
        }

        const parsed = JSON.parse(value) as MatrixDestination

        if (parsed.kind === 'discover') {
          return { kind: 'discover' }
        }

        if (parsed.kind === 'app' && APP_UUID.test(parsed.appId)) {
          return { kind: 'app', appId: parsed.appId.toLowerCase() }
        }

        if (
          parsed.kind === 'room' &&
          typeof parsed.roomId === 'string' &&
          parsed.roomId.startsWith('!') &&
          parsed.roomId.length <= 1024
        ) {
          return { kind: 'room', roomId: parsed.roomId }
        }
      } catch {
        /* Optional navigation memory. */
      }

      return null
    },
    writeDestination(destination: MatrixDestination | null) {
      try {
        if (destination) {
          storage.setItem(key, JSON.stringify(destination))
        } else {
          storage.removeItem(key)
        }
      } catch {
        /* Optional navigation memory. */
      }
    },
    read(): string | null {
      try {
        const value = storage.getItem(key)

        return value?.startsWith('!') && value.length <= 1024 ? value : null
      } catch {
        return null
      }
    },
    write(roomId: string | null) {
      try {
        if (roomId) {
          storage.setItem(key, roomId)
        } else {
          storage.removeItem(key)
        }
      } catch {
        // Optional navigation memory must never block selecting a conversation.
      }
    }
  }
}
