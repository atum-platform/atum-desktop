import { EventEmitter } from 'node:events'

import { expect, it, vi } from 'vitest'

import type { MatrixSnapshot } from '../../shared/matrix'

import { MatrixCompanyPrivateCosNotificationAuthority } from './company-private-cos-notification-authority'
import { createMatrixNotifications } from './notifications'

function fixture() {
  const host = { identity: { userId: '@alice:test', deviceId: 'ONE' } }

  const current: { host?: typeof host; snapshot: MatrixSnapshot; focused: boolean; closing: boolean } = {
    host,
    focused: false,
    closing: false,
    snapshot: {
      state: 'ready',
      identity: host.identity,
      rooms: [{ id: '!room:test', name: 'private name', membership: 'join', encrypted: true }],
      messages: [],
      roomId: '!room:test',
      error: null,
      displayPreferences: {
        appearance: { value: 'system', writable: true },
        textSize: { value: 100, writable: true },
        language: { value: 'en', writable: true },
        notifications: { value: true, writable: true },
        sound: { value: true, writable: true }
      }
    }
  }

  const instances: Array<EventEmitter & { show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = []

  const create = vi.fn(() => {
    const instance = Object.assign(new EventEmitter(), { show: vi.fn(), close: vi.fn() })
    instances.push(instance)

    return instance
  })

  const open = vi.fn()
  const privateCos = new MatrixCompanyPrivateCosNotificationAuthority()
  const scope = { accountKey: 'alice-account', generation: 1 }
  const notifications = createMatrixNotifications({
    current: () => current,
    create,
    open,
    privateCosBoundRoom: roomId => privateCos.has(scope, roomId)
  })
  const hint = { roomId: '!room:test', eventId: '$fresh', sound: true }
  const offer = (input: unknown = hint, role = 'human', from = host) => notifications.offer(role, from, input)

  return { current, host, create, open, instances, notifications, hint, offer, privateCos, scope }
}

it('creates a generic native alert once, respects portable sound, and selects only through its current host on click', () => {
  const f = fixture()
  f.offer({ ...f.hint, body: 'secret', title: 'spoof', action: 'execute' })
  f.offer()
  expect(f.create).toHaveBeenCalledExactlyOnceWith({ title: 'Atum', body: 'You have a new message.', silent: false })
  expect(f.instances[0]!.show).toHaveBeenCalledOnce()
  f.instances[0]!.emit('click')
  expect(f.open).toHaveBeenCalledExactlyOnceWith(f.host, '!room:test')
  f.current.snapshot.displayPreferences!.sound!.value = false
  f.offer({ ...f.hint, eventId: '$silent' })
  expect(f.create).toHaveBeenLastCalledWith({ title: 'Atum', body: 'You have a new message.', silent: true })
})

it.each(['agent', 'app:moon'])('refuses %s SDKs even with human-like payloads', role => {
  const f = fixture()
  f.offer(f.hint, role)
  expect(f.create).not.toHaveBeenCalled()
})

it.each([
  ['exact marker', {
    companyPrivateCos: {
      v: 1 as const,
      classification: 'company_private_cos' as const,
      companyId: '00000000-0000-4000-8000-87c6455cae48',
      membershipIncarnation: '00000000-0000-4000-8000-f6c6b8bb709f',
      executorId: '00000000-0000-4000-8000-8a4e23bab81e'
    }
  }],
  ['malformed marker claim', { companyPrivateCosClaim: true as const }]
] as const)('defence-in-depth refuses native alerts for a private-CoS %s', (_label, claim) => {
  const f = fixture()
  Object.assign(f.current.snapshot.rooms[0]!, claim)
  f.offer()
  expect(f.create).not.toHaveBeenCalled()
})

it('refuses a marker-lag room from its authenticated platform binding without renderer annotation', () => {
  const f = fixture()
  const companyId = '00000000-0000-4000-8000-87c6455cae48'
  const pair = {
    companyPrincipal: companyId,
    memberPrincipal: '00000000-0000-4000-8000-f6c6b8bb709f',
    membershipIncarnation: '00000000-0000-4000-8000-8a4e23bab81e'
  }

  f.privateCos.observe(f.scope, {
    schemaVersion: 1,
    state: 'ready',
    pair,
    greetingState: 'published',
    binding: {
      scope: { pair, authorityEpoch: 1, contextEpoch: 1, homeGeneration: 1 },
      agentPrincipal: '00000000-0000-4000-8000-f9ae298d66d3',
      agentUserId: '@private-cos:atum.example',
      executorId: '00000000-0000-4000-8000-31ba7dd260e2',
      homeId: '00000000-0000-4000-8000-7886f5c6d975',
      roomId: f.hint.roomId,
      storeGeneration: 1,
      profileDigest: 'a'.repeat(64)
    }
  })

  expect(f.current.snapshot.rooms[0]).not.toHaveProperty('companyPrivateCosBound')
  f.offer()
  expect(f.create).not.toHaveBeenCalled()
})

it('refuses foreign host, malformed identifiers, missing projection, offline/closed/disabled/left and focused current room', () => {
  const f = fixture()
  f.offer(f.hint, 'human', { identity: f.host.identity })

  for (const input of [
    null,
    [],
    {},
    { ...f.hint, sound: 'yes' },
    { ...f.hint, roomId: 'bad' },
    { ...f.hint, eventId: '~local' },
    { ...f.hint, eventId: '$'.repeat(1025) }
  ]) {
    f.offer(input)
  }

  f.current.focused = true
  f.offer()
  f.current.focused = false
  f.current.snapshot.state = 'offline'
  f.offer()
  f.current.snapshot.state = 'ready'
  f.current.closing = true
  f.offer()
  f.current.closing = false
  f.current.snapshot.rooms[0]!.membership = 'leave'
  f.offer()
  f.current.snapshot.rooms[0]!.membership = 'join'
  const preferences = f.current.snapshot.displayPreferences!
  preferences.notifications!.value = false
  f.offer()
  preferences.notifications!.value = true
  f.current.snapshot.displayPreferences = undefined
  f.offer()
  expect(f.create).not.toHaveBeenCalled()
})

it.each(['account', 'device', 'host', 'stop', 'disabled', 'left', 'offline'])(
  'does not navigate after %s changes',
  change => {
    const f = fixture()
    f.offer()
    const banner = f.instances[0]!

    if (change === 'account') {
      f.current.snapshot.identity = { ...f.host.identity, userId: '@bob:test' }
    }

    if (change === 'device') {
      f.current.snapshot.identity = { ...f.host.identity, deviceId: 'TWO' }
    }

    if (change === 'host') {
      f.current.host = { identity: f.host.identity }
    }

    if (change === 'stop') {
      f.notifications.clear()
    }

    if (change === 'disabled') {
      f.current.snapshot.displayPreferences!.notifications!.value = false
    }

    if (change === 'left') {
      f.current.snapshot.rooms[0]!.membership = 'leave'
    }

    if (change === 'offline') {
      f.current.snapshot.state = 'offline'
    }

    f.notifications.reconcile()
    banner.emit('click')
    expect(f.open).not.toHaveBeenCalled()
  }
)

it('closes retained banners on host withdrawal and bounds handles without ending chat on unsupported/failed delivery', () => {
  const f = fixture()

  for (let i = 0; i < 10; i++) {
    f.offer({ ...f.hint, eventId: `$${i}` })
  }

  expect(f.instances[0]!.close).toHaveBeenCalledOnce()
  f.instances[0]!.emit('click')
  expect(f.open).not.toHaveBeenCalled()
  f.notifications.clear()
  expect(f.instances[9]!.close).toHaveBeenCalledOnce()
  f.create.mockImplementationOnce(() => {
    throw new Error('OS denied')
  })
  expect(() => f.offer({ ...f.hint, eventId: '$failed' })).not.toThrow()
  f.offer({ ...f.hint, eventId: '$new' })
  expect(f.instances.at(-1)!.show).toHaveBeenCalledOnce()
})

it('keeps an OS click harmless when the window closes during native focus/navigation', () => {
  const f = fixture()
  f.offer()
  f.open.mockImplementationOnce(() => { throw new Error('window destroyed') })
  expect(() => f.instances[0]!.emit('click')).not.toThrow()
})

it('supports background-room delivery, unsupported OS and missing sound/language without private previews', () => {
  const f = fixture()
  f.current.focused = true
  f.current.snapshot.roomId = '!other:test'
  f.current.snapshot.displayPreferences!.sound = undefined
  f.current.snapshot.displayPreferences!.language = undefined
  f.offer()
  expect(f.create).toHaveBeenCalledExactlyOnceWith({ title: 'Atum', body: 'Bạn có tin nhắn mới.', silent: true })
  f.create.mockReturnValueOnce(undefined as never)
  expect(() => f.offer({ ...f.hint, eventId: '$unsupported' })).not.toThrow()
  f.offer({ ...f.hint, eventId: '$working' })
  expect(f.instances.at(-1)!.show).toHaveBeenCalledOnce()
})

it('closes a banner once its conversation is read, here or on another device, and only that conversation’s', () => {
  const f = fixture()
  const room = f.current.snapshot.rooms[0]!
  f.current.snapshot.rooms.push({ id: '!second:test', name: 'second', membership: 'join', encrypted: true })
  const second = f.current.snapshot.rooms[1]!
  room.unreadNotifications = 1
  second.unreadNotifications = 1
  f.offer()
  f.offer({ ...f.hint, roomId: '!second:test', eventId: '$second' })
  const [banner, other] = f.instances

  f.notifications.reconcile()
  expect(banner!.close).not.toHaveBeenCalled()

  // The SDK's count for the room reaches zero once it is acknowledged (by any of this account's devices).
  room.unreadNotifications = 0
  f.notifications.reconcile()
  expect(banner!.close).toHaveBeenCalledOnce()
  expect(other!.close).not.toHaveBeenCalled()
  banner!.emit('click')
  expect(f.open).not.toHaveBeenCalled()
  other!.emit('click')
  expect(f.open).toHaveBeenCalledExactlyOnceWith(f.host, '!second:test')
})

it('does not mistake a count that has not arrived yet for a read conversation', () => {
  const f = fixture()
  const room = f.current.snapshot.rooms[0]!
  f.offer()
  const banner = f.instances[0]!

  f.notifications.reconcile()
  expect(banner.close).not.toHaveBeenCalled()
  room.unreadNotifications = 2
  f.notifications.reconcile()
  expect(banner.close).not.toHaveBeenCalled()
  room.unreadNotifications = 0
  f.notifications.reconcile()
  expect(banner.close).toHaveBeenCalledOnce()
})

it('DND suppresses Team space banners locally without suppressing ordinary chat or delivery state', () => {
  const f = fixture()
  const owner = f.current.snapshot.identity!.userId
  f.current.snapshot.presence = {
    users: [{ userId: owner, state: 'online', status: { dnd: true, expiresAt: Date.now() + 60_000 } }]
  }
  f.current.snapshot.rooms[0]!.companyChannel = { companyId: 'company', channelId: 'channel' }
  f.offer()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.current.snapshot.rooms[0]!.unreadNotifications).toBeUndefined()

  delete f.current.snapshot.rooms[0]!.companyChannel
  f.offer({ ...f.hint, eventId: '$personal' })
  expect(f.create).toHaveBeenCalledOnce()

  f.current.snapshot.rooms[0]!.companyConversation = { companyId: 'company', conversationId: 'dm' }
  f.offer({ ...f.hint, eventId: '$company-dm' })
  expect(f.create).toHaveBeenCalledOnce()
})

it('expired DND does not suppress Team space banners and needs no clearing write', () => {
  const f = fixture()
  const owner = f.current.snapshot.identity!.userId
  f.current.snapshot.presence = {
    users: [{ userId: owner, state: 'away', status: { dnd: true, expiresAt: Date.now() - 1 } }]
  }
  f.current.snapshot.rooms[0]!.companyChannel = { companyId: 'company', channelId: 'channel' }
  f.offer()
  expect(f.create).toHaveBeenCalledOnce()
})

it('quiet hours feed the same effective DND gate while badges and delivery remain untouched', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-30T15:30:00Z')) // 22:30 in Vietnam

  try {
    const f = fixture()
    f.current.snapshot.notificationPolicy = {
      version: 1,
      accountLevel: 'all',
      quietHours: {
        enabled: true,
        startMinute: 22 * 60,
        endMinute: 7 * 60,
        timeZone: 'Asia/Ho_Chi_Minh'
      },
      channelOverrides: {},
      threadOverrides: {},
      writable: true
    }
    f.current.snapshot.rooms[0]!.companyChannel = { companyId: 'company', channelId: 'channel' }
    f.current.snapshot.rooms[0]!.unreadNotifications = 4
    f.current.snapshot.rooms[0]!.highlights = 1
    f.offer()

    expect(f.create).not.toHaveBeenCalled()
    expect(f.current.snapshot.rooms[0]).toMatchObject({ unreadNotifications: 4, highlights: 1 })
    expect(f.current.snapshot.messages).toEqual([])

    f.current.snapshot.notificationPolicy.quietHours.enabled = false
    f.offer({ ...f.hint, eventId: '$after-hours' })
    expect(f.create).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})
