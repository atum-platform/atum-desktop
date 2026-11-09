import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'

import { MatrixAttentionIndicator } from './attention-indicator'

const base: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'MAC' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null,
  agents: []
}

function draw(snapshot: MatrixSnapshot) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixAttentionIndicator agentName={() => 'Moon'} onOpen={vi.fn()} snapshot={snapshot} />
    </I18nProvider>
  )
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

// 2026-10-06 check, now at every width (Atum Kit): the mark is only its dot, so its words must still be one
// hover or focus away (colour is never the only cue), for every kind of item it can hold.
describe('the indicator is a dot at every width', () => {
  it.each([
    [
      'several items',
      {
        disk: { state: 'low', freeGb: 8 },
        security: { recovery: 'idle', approval: { role: 'approve', state: 'asked', since: Date.now() } }
      },
      '2 things need you'
    ],
    ['a disk item', { disk: { state: 'low', freeGb: 8 } }, 'Mac almost full'],
    ['a damaged device', { deviceDamaged: true }, 'Sign in again on this Mac'],
    [
      'one item that opens its place',
      { security: { recovery: 'idle', approval: { role: 'approve', state: 'asked', since: Date.now() } } },
      'Confirm new device'
    ]
  ] as const)('names %s in a tip, not by colour alone', async (_, extra, label) => {
    draw({ ...base, ...(extra as Partial<MatrixSnapshot>) })

    const pill = screen.getByRole('button', { name: `Needs you: ${label}` })
    expect(pill.textContent).toBe('')
    fireEvent.pointerMove(pill, { pointerType: 'mouse' })
    expect((await screen.findByRole('tooltip')).textContent).toContain(label)
  })

  it('still opens its list from the tip’s trigger', async () => {
    draw({
      ...base,
      disk: { state: 'low', freeGb: 8 },
      security: { recovery: 'idle', approval: { role: 'approve', state: 'asked', since: Date.now() } }
    })

    const pill = screen.getByRole('button', { name: 'Needs you: 2 things need you' })
    fireEvent.pointerDown(pill, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(pill)
    expect(await screen.findByRole('button', { name: /Confirm new device/ })).toBeTruthy()
  })
})

// Preserve user-visible identity, state and recovery behavior across connection changes.
// a "Storage critical" pill there that broke the panel and stayed after it was dismissed).
describe('a nearly full disk', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'atumMatrix')
  })

  it('is the indicator’s item, and its popover says so with the Storage action', async () => {
    const openStorageSettings = vi.fn(async () => {})
    Object.defineProperty(window, 'atumMatrix', { configurable: true, value: { openStorageSettings } })
    draw({ ...base, disk: { state: 'critical', freeGb: 1.6 } })

    const pill = screen.getByRole('button', { name: /Mac is out of space/ })
    fireEvent.pointerDown(pill, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(pill)

    expect(await screen.findByText(/Your Mac is nearly out of space \(1\.6 GB free\)/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Storage settings' }))
    await waitFor(() => expect(openStorageSettings).toHaveBeenCalledOnce())
  })
})

// Owner finding 1a (2026-10-06) added a reminder to verify the person's devices; in 0.20 chats are
// plain, nobody refuses a device there, and the reminder's words would be false (no pill at all).
describe('a device of the person’s that isn’t verified (0.20)', () => {
  it('raises nothing, even when a snapshot lists one', () => {
    const phone = { deviceId: 'PHONE', name: 'iPhone 16 Pro', lastSeenAt: Date.now() - 60_000 }

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixAttentionIndicator
          agentName={() => 'Moon'}
          onOpen={vi.fn()}
          snapshot={{ ...base, security: { recovery: 'idle', unverifiedDevices: [phone] } }}
        />
      </I18nProvider>
    )

    expect(screen.queryByRole('button', { name: /Needs you/ })).toBeNull()
  })
})

describe('an assistant whose ChatGPT sign-in ended', () => {
  it('says so by name and opens that sign-in in one click', () => {
    const onOpen = vi.fn()

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixAttentionIndicator
          agentName={() => 'Moon'}
          onOpen={onOpen}
          snapshot={{
            ...base,
            agents: [
              {
                principal: 'moon',
                userId: '@moon:test',
                isDefault: false,
                ready: false,
                hermes: 'ready',
                atumModel: false,
                setup: 'failed',
                readiness: { phase: 'blocked', step: 'assistant', code: 'plan_sign_in', since: 1 }
              }
            ]
          }}
        />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Needs you: Moon: connect ChatGPT' }))
    expect(onOpen).toHaveBeenCalledWith({ kind: 'plan_sign_in', principal: 'moon', tone: 'warn' })
  })
})

it('routes the damaged-device popover to owner repair without signing out', async () => {
  const native = { repairOwnerDevice: vi.fn(async () => ({ state: 'repaired' })), signOut: vi.fn(), signIn: vi.fn() }
  Object.defineProperty(window, 'atumMatrix', { configurable: true, value: native })
  draw({ ...base, deviceDamaged: true })
  fireEvent.click(screen.getByRole('button', { name: 'Needs you: Sign in again on this Mac' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Re-verify' }))
  await waitFor(() => expect(native.repairOwnerDevice).toHaveBeenCalledOnce())
  expect(native.signOut).not.toHaveBeenCalled()
  expect(native.signIn).not.toHaveBeenCalled()
  Reflect.deleteProperty(window, 'atumMatrix')
})

// Preserve user-visible identity, state and recovery behavior across connection changes.
// down. It is the indicator's item now: a dot in the title bar, its line a click away.
describe('a new sign-in on another device', () => {
  const dismissNewSignIn = vi.fn(async () => {})
  const endDeviceSession = vi.fn(async () => {})

  beforeEach(() => {
    Object.defineProperty(window, 'atumMatrix', {
      configurable: true,
      value: { dismissNewSignIn, endDeviceSession }
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'atumMatrix')
    dismissNewSignIn.mockClear()
    endDeviceSession.mockClear()
  })

  const signIn = { deviceId: 'PHONE', name: 'Atum for iPhone on Unknown device' }

  it('is one dot, its words in a tip, and its popover answers for that device', async () => {
    draw({ ...base, newSignIn: signIn })

    const pill = screen.getByRole('button', { name: 'Needs you: New sign-in on an iPhone' })
    expect(pill.textContent).toBe('')
    expect(screen.queryByText(/Was this you/)).toBeNull()

    fireEvent.pointerDown(pill, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(pill)

    expect(await screen.findByText('New sign-in on an iPhone. Was this you?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign it out' }))
    await waitFor(() => expect(endDeviceSession).toHaveBeenCalledExactlyOnceWith('PHONE'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'It was me' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'It was me' }))
    await waitFor(() => expect(dismissNewSignIn).toHaveBeenCalledExactlyOnceWith('PHONE'))
  })

  it('says its label once in a list of several', async () => {
    draw({ ...base, newSignIn: signIn, disk: { state: 'low', freeGb: 8 } })

    const pill = screen.getByRole('button', { name: 'Needs you: 2 things need you' })
    fireEvent.pointerDown(pill, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(pill)

    expect(await screen.findByText('New sign-in on an iPhone')).toBeTruthy()
    expect(screen.getByText('Was this you?')).toBeTruthy()
    expect(screen.queryByText('New sign-in on an iPhone. Was this you?')).toBeNull()
  })

  it('goes away when main has accounted for the device', () => {
    const { rerender } = draw({ ...base, newSignIn: signIn })
    expect(screen.getByRole('button', { name: /New sign-in/ })).toBeTruthy()

    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixAttentionIndicator agentName={() => 'Moon'} onOpen={vi.fn()} snapshot={base} />
      </I18nProvider>
    )
    expect(screen.queryByRole('button', { name: /Needs you/ })).toBeNull()
  })
})
