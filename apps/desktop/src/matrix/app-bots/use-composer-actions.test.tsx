import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AppDescriptor } from '../../../shared/app-catalog'
import type { MatrixSnapshot } from '../../../shared/matrix'

import { useAppBotComposerActions } from './use-composer-actions'

const app: AppDescriptor = {
  app: 'moon',
  app_id: 'moon-id',
  app_version_id: 'moon-v1',
  name: { en: 'Moon' },
  subtitle: null,
  description: null,
  icon: null,
  accent: null,
  affiliation: 'first_party',
  verified: true,
  availability: 'available',
  roster_default: true,
  roster_order: 1,
  supported_modes: ['direct'],
  has_surface: true,
  link: { mode: 'external_account', state: 'linked' },
  bot: {
    v: 1,
    user_id: '@moon:test',
    handle: 'moon',
    display_name: 'Moon',
    avatar: { url: '', sha256: 'a'.repeat(64) },
    device_generation: 1,
    device: { device_id: 'BOT', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
    state: 'active',
    groups: true,
    consent: 'accepted',
    disclosure_version: 1,
    open_route_id: 'chat',
    open_shared_memory: true,
    purchase_route_id: 'top-up'
  }
}

const room = {
  id: '!moon:test',
  name: 'Moon',
  direct: true,
  encrypted: false,
  membership: 'join' as const,
  participants: [
    { userId: '@owner:test', membership: 'join' as const },
    { userId: '@moon:test', membership: 'join' as const }
  ]
}

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'OWNER' },
  roomId: room.id,
  rooms: [room],
  messages: [],
  error: null,
  petScope: 'owner-generation',
  apps: { state: 'ready', apps: [app], connections: {} }
}

const menu = vi.fn(async () => ({
  app,
  routes: [],
  actions: [
    { id: 'chat', label: { en: 'Chat', vi: 'Trò chuyện' }, icon: 'chat', session: 'required' as const },
    { id: 'readings', label: { en: 'Readings', vi: 'Luận giải' }, icon: 'yin-yang', session: 'required' as const },
    { id: 'tarot', label: { en: 'Tarot', vi: 'Tarot' }, icon: 'cards', session: 'required' as const },
    { id: 'match', label: { en: 'Match', vi: 'Nhân duyên' }, icon: 'heart', session: 'required' as const },
    { id: 'top-up', label: { en: 'Top up', vi: 'Nạp tin nhắn' }, icon: 'wallet', session: 'required' as const }
  ]
}))

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { atumMatrix: { apps: { menu } } })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

it('loads Moon-style plus actions without duplicating its canonical chat route', async () => {
  let current = snapshot
  const { result, rerender } = renderHook(() => useAppBotComposerActions(current, room, false))

  await waitFor(() => expect(result.current.actions.map(action => action.id)).toEqual([
    'readings', 'tarot', 'match', 'top-up'
  ]))
  expect(menu).toHaveBeenCalledWith(app.app_id)

  current = { ...snapshot, apps: { ...snapshot.apps!, apps: [{ ...app, link: { ...app.link, state: 'unlinked' } }] } }
  rerender()
  await waitFor(() => expect(result.current.actions).toEqual([]))
})

it('shows declared plus actions for an unlinked Bot API room', async () => {
  const unlinked = {
    ...snapshot,
    apps: { ...snapshot.apps!, apps: [{ ...app, link: { ...app.link, state: 'never_linked' as const } }] }
  }
  const { result } = renderHook(() => useAppBotComposerActions(unlinked, room, true))

  await waitFor(() => expect(result.current.actions.map(action => action.id)).toEqual([
    'readings', 'tarot', 'match', 'top-up'
  ]))
  expect(menu).toHaveBeenCalledWith(app.app_id)
})

it('drops a menu from another app version', async () => {
  menu.mockResolvedValueOnce({
    app: { ...app, app_version_id: 'moon-v2' },
    routes: [],
    actions: []
  })
  const { result } = renderHook(() => useAppBotComposerActions(snapshot, room, false))

  await waitFor(() => expect(menu).toHaveBeenCalledOnce())
  expect(result.current.actions).toEqual([])
})

it('does not request private app actions for a group', () => {
  const group = { ...room, direct: false }
  const { result } = renderHook(() => useAppBotComposerActions({ ...snapshot, rooms: [group] }, group, false))

  expect(result.current.app).toBeUndefined()
  expect(result.current.actions).toEqual([])
  expect(menu).not.toHaveBeenCalled()
})

it('asks for the menu again by itself after the platform could not build it', async () => {
  vi.useFakeTimers()

  try {
    menu.mockRejectedValueOnce(new Error('503')).mockRejectedValueOnce(new Error('timeout'))
    const { result } = renderHook(() => useAppBotComposerActions(snapshot, room, false))

    await act(async () => {})
    expect(menu).toHaveBeenCalledTimes(1)
    expect(result.current.actions).toEqual([])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(menu).toHaveBeenCalledTimes(2)
    expect(result.current.actions).toEqual([])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(menu).toHaveBeenCalledTimes(3)
    expect(result.current.actions.map(action => action.id)).toEqual(['readings', 'tarot', 'match', 'top-up'])

    // Resolved: no further looks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(menu).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})

it('gives up after the last look rather than asking forever', async () => {
  vi.useFakeTimers()

  try {
    menu.mockRejectedValue(new Error('offline'))
    renderHook(() => useAppBotComposerActions(snapshot, room, false))
    for (const gap of [0, 3_000, 10_000, 30_000, 120_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(gap)
      })
    }

    // The first ask and one per gap (3 s, 10 s, 30 s); the 120 s after the last finds nothing waiting.
    expect(menu).toHaveBeenCalledTimes(4)
  } finally {
    vi.useRealTimers()
    menu.mockReset()
  }
})

it('reads one menu for many snapshots that only replace the app object identity', async () => {
  const { result, rerender } = renderHook(
    ({ current }: { current: MatrixSnapshot }) => useAppBotComposerActions(current, room, false),
    { initialProps: { current: snapshot } }
  )

  await waitFor(() => expect(result.current.actions.map(action => action.id)).toEqual([
    'readings', 'tarot', 'match', 'top-up'
  ]))

  for (let emission = 0; emission < 49; emission++) {
    rerender({
      current: {
        ...snapshot,
        apps: { ...snapshot.apps!, apps: [{ ...app, bot: { ...app.bot! } }] }
      }
    })
  }

  await act(async () => {})
  expect(menu).toHaveBeenCalledOnce()
  expect(result.current.actions.map(action => action.id)).toEqual(['readings', 'tarot', 'match', 'top-up'])
})
