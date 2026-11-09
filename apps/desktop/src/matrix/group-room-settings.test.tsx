import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { $groupRoomPolicies, useGroupRoomPolicy } from './group-room-policy'
import { groupRoomCopy, GroupRoomSettings } from './group-room-settings'

beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
)

afterEach(() => {
  cleanup()
  $groupRoomPolicies.set({})
  vi.unstubAllGlobals()
})

function fixture(locale: Locale = 'en', shared = false) {
  const owner = { userId: '@owner:test', deviceId: 'D' }

  const room: MatrixRoom = {
    id: `!${locale}-${shared}:${crypto.randomUUID()}`,
    name: 'Meeting',
    membership: 'join',
    encrypted: true,
    participants: [
      { userId: owner.userId, membership: 'join' },
      { userId: '@mochi:test', membership: 'join' },
      ...(shared ? [{ userId: '@foreign:test', membership: 'join' as const }] : [])
    ]
  }

  const snapshot = {
    state: 'ready',
    error: null,
    identity: owner,
    roomId: room.id,
    rooms: [room],
    messages: [],
    agents: [
      {
        principal: 'mochi',
        userId: '@mochi:test',
        name: 'Mochi',
        ready: true,
        isDefault: false,
        hermes: 'ready',
        atumModel: true
      }
    ]
  } as MatrixSnapshot

  const value = {
    policy: { v: 1, agents: { '@mochi:test': { mode: 'joins' } }, dailyTurns: 30 },
    usage: { v: 1, day: new Date().toISOString().slice(0, 10), turns: 30 }
  }

  const command = vi.fn(async () => value)
  window.atumMatrix = { command } as unknown as MatrixUiBridge
  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <GroupRoomSettings room={room} snapshot={snapshot} />
    </I18nProvider>
  )

  return { room, owner, snapshot, command, value, copy: groupRoomCopy(locale) }
}

it('shares one refresh timer across consumers and ignores a late read after the last unmount', async () => {
  const timer = vi.spyOn(window, 'setInterval')
  const f = fixture()

  function Mirror() {
    useGroupRoomPolicy(f.room, f.snapshot)

    return null
  }

  render(
    <>
      <Mirror />
      <Mirror />
    </>
  )
  await waitFor(() => expect(f.command).toHaveBeenCalledOnce())
  expect(timer.mock.calls.filter(call => call[1] === 30_000)).toHaveLength(1)
  await waitFor(() => expect(Object.values($groupRoomPolicies.get())[0]?.pending).not.toBe(true))
  let finish!: (value: typeof f.value) => void
  f.command.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  fireEvent.click(screen.getByRole('button', { name: f.copy.title }))
  await waitFor(() => expect(f.command).toHaveBeenCalledTimes(2))
  cleanup()
  await act(async () => {
    finish(f.value)
  })
  expect($groupRoomPolicies.get()).toEqual({})
  timer.mockRestore()
})

it.each(['vi', 'en', 'ja', 'zh', 'zh-hant'] as const)(
  'shows daily usage, paused state and settings in %s',
  async locale => {
    const f = fixture(locale)
    fireEvent.click(screen.getByRole('button', { name: f.copy.title }))
    expect(await screen.findByText(f.copy.today(30, 30))).toBeTruthy()
    expect(screen.getByText(f.copy.paused)).toBeTruthy()
    expect(screen.getByRole('option', { name: f.copy.joins })).toBeTruthy()
    expect(f.command).toHaveBeenCalledWith({ kind: 'groupPolicy', roomId: f.room.id, identity: f.owner })
  }
)

it('rolls back the optimistic mode visibly when the owner write fails', async () => {
  const f = fixture()
  fireEvent.click(screen.getByRole('button', { name: f.copy.title }))
  const control = await screen.findByRole('combobox', { name: 'Mochi' })
  await waitFor(() => expect((control as HTMLSelectElement).disabled).toBe(false))
  f.command.mockRejectedValueOnce(new Error('closed write failure'))
  fireEvent.change(control, { target: { value: 'off' } })
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', f.copy.failed)
  expect((control as HTMLSelectElement).value).toBe('joins')
  expect(f.command).toHaveBeenLastCalledWith({
    kind: 'groupPolicy',
    roomId: f.room.id,
    identity: f.owner,
    change: { agentId: '@mochi:test', mode: 'off' }
  })
})

it('rolls back a failed cap change and retires the scope when the editor unmounts', async () => {
  const f = fixture()
  fireEvent.click(screen.getByRole('button', { name: f.copy.title }))
  const control = await screen.findByRole('spinbutton', { name: f.copy.cap })
  await waitFor(() => expect((control as HTMLInputElement).disabled).toBe(false))
  f.command.mockRejectedValueOnce(new Error('closed write failure'))
  fireEvent.change(control, { target: { value: '60' } })
  fireEvent.blur(control)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', f.copy.failed)
  expect((screen.getByRole('spinbutton', { name: f.copy.cap }) as HTMLInputElement).value).toBe('30')
  cleanup()
  expect($groupRoomPolicies.get()).toEqual({})
})

it('projects a stored joins preference at the shared-room ceiling and never offers joins', async () => {
  const f = fixture('en', true)
  fireEvent.click(screen.getByRole('button', { name: f.copy.title }))
  const control = await screen.findByRole('combobox', { name: 'Mochi' })
  expect((control as HTMLSelectElement).value).toBe('addressed')
  expect(screen.queryByRole('option', { name: f.copy.joins })).toBeNull()
})

it('saves a bounded daily limit through the owner command and resets yesterday’s usage', async () => {
  const f = fixture()
  f.value.usage.day = '2026-01-01'
  fireEvent.click(screen.getByRole('button', { name: f.copy.title }))
  const control = await screen.findByRole('spinbutton', { name: f.copy.cap })
  expect(screen.getByText(f.copy.today(0, 30))).toBeTruthy()
  await waitFor(() => expect((control as HTMLInputElement).disabled).toBe(false))
  f.command.mockResolvedValueOnce({ ...f.value, policy: { ...f.value.policy, dailyTurns: 60 } })
  fireEvent.change(control, { target: { value: '60' } })
  fireEvent.blur(control)
  await waitFor(() =>
    expect(f.command).toHaveBeenLastCalledWith({
      kind: 'groupPolicy',
      roomId: f.room.id,
      identity: f.owner,
      change: { dailyTurns: 60 }
    })
  )
  await act(async () => {})
  expect(screen.getByText(f.copy.today(0, 60))).toBeTruthy()
})
