import type { MatrixIdentity, MatrixSnapshot } from '../../shared/matrix'
import { isCompanyPrivateCosClaim } from '../../shared/matrix-company-private-cos-claim'
import { matrixEffectiveDoNotDisturb } from '../../shared/matrix-notification-policy'

interface Notification {
  once(event: 'click' | 'close' | 'failed', listener: () => void): unknown
  show(): void
  close(): void
}

const bodies = {
  en: 'You have a new message.',
  vi: 'Bạn có tin nhắn mới.',
  ja: '新しいメッセージがあります。',
  zh: '你有一条新消息。',
  'zh-hant': '你有一則新訊息。'
}

/** One thin native adapter. The current trusted human host supplies SDK push
 * hints; no content, bearer credential, notification action or agent authority crosses.
 * A banner leaves once its conversation is read, here or on another device. */
export function createMatrixNotifications<Host extends { identity: MatrixIdentity }>(dependencies: {
  current(): { host?: Host; snapshot: MatrixSnapshot; focused: boolean; closing: boolean }
  create(options: { title: string; body: string; silent: boolean }): Notification | undefined
  open(host: Host, roomId: string): void
  /** Authenticated native private-CoS view authority, independent of renderer annotations. */
  privateCosBoundRoom?(roomId: string): boolean
}) {
  // `armed`: its room has been seen with unread notifications since the banner went up, so a
  // later zero means it was read, never that the count simply had not arrived yet.
  const shown = new Map<Notification, { roomId: string; armed: boolean }>()
  const seen = new Set<string>()
  let owner: Host | undefined
  let generation = 0

  function dismiss(notification: Notification) {
    shown.delete(notification)

    try {
      notification.close()
    } catch {
      /* Unsupported/failed OS delivery does not interrupt chat. */
    }
  }

  function clear() {
    generation++

    for (const notification of [...shown.keys()]) {
      dismiss(notification)
    }

    shown.clear()
    seen.clear()
    owner = undefined
  }

  const unread = (snapshot: MatrixSnapshot, roomId: string) => {
    const room = snapshot.rooms.find(value => value.id === roomId && value.membership === 'join')

    return room ? (room.unreadNotifications ?? 0) : undefined
  }

  function live(host: Host) {
    const current = dependencies.current(),
      identity = current.snapshot.identity

    return (
      !current.closing &&
      current.host === host &&
      current.snapshot.state === 'ready' &&
      identity?.userId === host.identity.userId &&
      identity.deviceId === host.identity.deviceId
    )
  }

  return {
    clear,
    reconcile() {
      const current = dependencies.current()

      if (owner && (!live(owner) || current.snapshot.displayPreferences?.notifications?.value !== true)) {
        clear()

        return
      }

      // The SDK's count drops to zero once the conversation is acknowledged (a private
      // receipt from any of this account's devices): its banners are then stale.
      for (const [notification, banner] of [...shown]) {
        const count = unread(current.snapshot, banner.roomId)

        if (count === undefined || (banner.armed && count === 0)) {
          dismiss(notification)
        } else if (count > 0) {
          banner.armed = true
        }
      }
    },
    offer(role: string, host: Host, input: unknown) {
      if (role !== 'human' || !live(host) || !input || typeof input !== 'object' || Array.isArray(input)) {
        return
      }

      const { roomId, eventId, sound } = input as Record<string, unknown>

      if (
        typeof roomId !== 'string' ||
        !roomId.startsWith('!') ||
        roomId.length > 1024 ||
        roomId.length < 2 ||
        typeof eventId !== 'string' ||
        !eventId.startsWith('$') ||
        eventId.length > 1024 ||
        eventId.length < 2 ||
        typeof sound !== 'boolean'
      ) {
        return
      }

      const { snapshot, focused } = dependencies.current()
      const target = snapshot.rooms.find(room => room.id === roomId && room.membership === 'join')

      if (
        snapshot.displayPreferences?.notifications?.value !== true ||
        !target ||
        dependencies.privateCosBoundRoom?.(roomId) ||
        isCompanyPrivateCosClaim(target) ||
        (matrixEffectiveDoNotDisturb(snapshot) && Boolean(target.companyChannel || target.companyConversation)) ||
        (focused && snapshot.roomId === roomId)
      ) {
        return
      }

      if (owner !== host) {
        clear()
        owner = host
      }

      const key = JSON.stringify([roomId, eventId])

      if (seen.has(key)) {
        return
      }

      seen.add(key)

      if (seen.size > 256) {
        seen.delete(seen.values().next().value!)
      }

      const locale = snapshot.displayPreferences.language?.value ?? 'vi'
      const issued = generation
      let notification: Notification | undefined

      try {
        notification = dependencies.create({
          title: 'Atum',
          body: bodies[locale] ?? bodies.vi,
          silent: !(sound && snapshot.displayPreferences.sound?.value === true)
        })

        if (!notification) {
          return
        }

        const currentNotification = notification
        const forget = () => shown.delete(currentNotification)
        notification.once('close', forget)
        notification.once('failed', forget)
        notification.once('click', () => {
          // An old OS banner must never navigate a replacement account or host.
          if (
            issued === generation &&
            shown.has(currentNotification) &&
            live(host) &&
            dependencies.current().snapshot.displayPreferences?.notifications?.value === true &&
            dependencies.current().snapshot.rooms.some(room => room.id === roomId && room.membership === 'join')
          ) {
            try {
              dependencies.open(host, roomId)
            } catch {
              // A window closing during an OS click must not crash the chat process.
            }
          }

          forget()
        })
        shown.set(notification, { roomId, armed: (unread(snapshot, roomId) ?? 0) > 0 })

        // Bound retained native handles, not Matrix history or push rules.
        if (shown.size > 8) {
          dismiss(shown.keys().next().value!)
        }

        notification.show()
      } catch {
        if (notification) {
          shown.delete(notification)
        }
        // Never surface OS details or raw SDK payloads to the chat error state.
      }
    }
  }
}
