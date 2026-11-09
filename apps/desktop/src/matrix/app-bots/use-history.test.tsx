import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AppDescriptor } from '../../../shared/app-catalog'
import type { MatrixSnapshot } from '../../../shared/matrix'

import { useAppBotHistory } from './use-history'

const app: AppDescriptor = {
  app: 'moon',
  app_id: '00000000-0000-4000-8000-783b984047f5',
  app_version_id: '00000000-0000-4000-8000-6f604e7be5f9',
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
  has_history: true,
  link: { mode: 'external_account', state: 'linked' },
  bot: {
    v: 1,
    user_id: '@app-moon:atumplatform.com',
    handle: 'moon_bot',
    display_name: 'Moon',
    avatar: { url: '', sha256: 'a'.repeat(64) },
    device_generation: 1,
    device: { device_id: 'BOT', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
    state: 'active',
    groups: true,
    consent: 'accepted',
    disclosure_version: 2,
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
    { userId: app.bot!.user_id, membership: 'join' as const }
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
const history = vi.fn(async () => ({
  profile: 'atum.app-history/1' as const,
  appId: app.app_id,
  appVersionId: app.app_version_id,
  entries: [
    {
      id: 'remote-1',
      revision: 1,
      occurredAt: 100,
      role: 'owner' as const,
      source: { id: 'web', label: { en: 'Moon web', vi: 'Moon web' } },
      text: 'Earlier'
    }
  ],
  nextCursor: null,
  hasMore: false,
  freshnessMs: 0
}))

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { atumMatrix: { apps: { history } } })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

it('loads linked history only for the canonical private app room', async () => {
  let current = snapshot
  const { result, rerender } = renderHook(() => useAppBotHistory(current, room))
  await waitFor(() => expect(result.current.entries.map(entry => entry.id)).toEqual(['remote-1']))
  expect(history).toHaveBeenCalledWith(app.app_id, null)

  current = { ...snapshot, apps: { ...snapshot.apps!, apps: [{ ...app, link: { ...app.link, state: 'unlinked' } }] } }
  rerender()
  await waitFor(() => expect(result.current.entries).toEqual([]))
})

it('does not read private app history in a group or when capability is absent', () => {
  const group = { ...room, direct: false }
  const groupResult = renderHook(() => useAppBotHistory({ ...snapshot, rooms: [group] }, group))
  expect(groupResult.result.current.supported).toBe(false)
  expect(history).not.toHaveBeenCalled()

  const without = { ...app, has_history: false }
  const noCapability = renderHook(() =>
    useAppBotHistory({ ...snapshot, apps: { ...snapshot.apps!, apps: [without] } }, room)
  )
  expect(noCapability.result.current.supported).toBe(false)
  expect(history).not.toHaveBeenCalled()
})

it('uses Matrix history for an unknown app declared as Bot API', () => {
  const botApi = {
    ...app,
    app: 'future-orbit',
    app_id: '00000000-0000-4000-8000-b6a520472866',
    app_version_id: '00000000-0000-4000-8000-4209e8011434',
    bot: {
      ...app.bot!,
      user_id: '@app-future-orbit:atumplatform.com',
      transport_mode: 'bot_api' as const
    }
  }

  const botApiRoom = {
    ...room,
    id: '!future-orbit:test',
    participants: [
      { userId: '@owner:test', membership: 'join' as const },
      { userId: botApi.bot.user_id, membership: 'join' as const }
    ]
  }

  const result = renderHook(() =>
    useAppBotHistory(
      {
        ...snapshot,
        roomId: botApiRoom.id,
        rooms: [botApiRoom],
        apps: { ...snapshot.apps!, apps: [botApi] }
      },
      botApiRoom
    )
  )

  expect(result.result.current.supported).toBe(false)
  expect(result.result.current.ready).toBe(false)
  expect(result.result.current.error).toBeNull()
  expect(result.result.current.entries).toEqual([])
  expect(history).not.toHaveBeenCalled()
})

it('does not read history under consent to the pre-history disclosure', () => {
  const stale = { ...app, bot: { ...app.bot!, disclosure_version: 1 } }
  const result = renderHook(() => useAppBotHistory({ ...snapshot, apps: { ...snapshot.apps!, apps: [stale] } }, room))
  expect(result.result.current.supported).toBe(true)
  expect(history).not.toHaveBeenCalled()
})

it('reports a history read failure without changing linked readiness and clears it on retry', async () => {
  const failure = new Error('history_timeout')
  history.mockRejectedValueOnce(failure)
  const { result } = renderHook(() => useAppBotHistory(snapshot, room))

  await waitFor(() => expect(result.current.failed).toBe(true))
  expect(result.current.error).toBe(failure)
  expect(result.current.ready).toBe(true)
  expect(result.current.supported).toBe(true)

  await act(async () => {
    await result.current.retry()
  })
  expect(result.current.failed).toBe(false)
  expect(result.current.error).toBeNull()
  expect(result.current.entries.map(entry => entry.id)).toEqual(['remote-1'])
})

it('keeps confirmed history through a failed refresh and a later retry', async () => {
  const { result } = renderHook(() => useAppBotHistory(snapshot, room))
  await waitFor(() => expect(result.current.entries.map(entry => entry.id)).toEqual(['remote-1']))

  const failure = new Error('history_offline')
  history.mockRejectedValueOnce(failure)
  await act(async () => {
    await result.current.retry()
  })
  expect(result.current.entries.map(entry => entry.id)).toEqual(['remote-1'])
  expect(result.current.error).toBe(failure)

  await act(async () => {
    await result.current.retry()
  })
  expect(result.current.entries.map(entry => entry.id)).toEqual(['remote-1'])
  expect(result.current.error).toBeNull()
})

it('does not publish a late history failure after the app becomes unlinked', async () => {
  let rejectHistory: (error: unknown) => void = () => {}
  history.mockImplementationOnce(() => new Promise((_, reject) => { rejectHistory = reject }))
  let current = snapshot
  const { result, rerender } = renderHook(() => useAppBotHistory(current, room))
  await waitFor(() => expect(history).toHaveBeenCalledOnce())

  current = { ...snapshot, apps: { ...snapshot.apps!, apps: [{ ...app, link: { ...app.link, state: 'unlinked' } }] } }
  rerender()
  await act(async () => { rejectHistory(new Error('stale_history_failure')) })

  expect(result.current.ready).toBe(false)
  expect(result.current.failed).toBe(false)
  expect(result.current.error).toBeNull()
  expect(result.current.entries).toEqual([])
})
