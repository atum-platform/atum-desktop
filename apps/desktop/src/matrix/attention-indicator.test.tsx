import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'

import { MatrixAttentionSection, useMatrixAttentionSummary } from './attention-indicator'

const base: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'MAC' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null,
  agents: []
}

/** The account face's red dot and its words, as the rail draws them. */
function Summary({ snapshot }: { snapshot: MatrixSnapshot }) {
  const summary = useMatrixAttentionSummary(snapshot, () => 'Moon')

  return <span data-count={summary.count}>{summary.label ?? ''}</span>
}

function draw(snapshot: MatrixSnapshot, onOpen = vi.fn(), onDone = vi.fn(), locale: Locale = 'en') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <Summary snapshot={snapshot} />
      <MatrixAttentionSection agentName={() => 'Moon'} onDone={onDone} onOpen={onOpen} snapshot={snapshot} />
    </I18nProvider>
  )
}

const summary = () => window.document.querySelector<HTMLElement>('[data-count]')!

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

// The bell is gone (owner, 2026-11-24): its items sit at the top of the rail's account face, which
// wears a red dot whose words are said to assistive tech (colour is never the only cue).
describe('the account face says what waits', () => {
  it.each([
    [
      'several items',
      {
        deviceDamaged: true,
        security: { recovery: 'idle', approval: { role: 'approve', state: 'asked', since: Date.now() } }
      },
      '2 things need you'
    ],
    ['a damaged device', { deviceDamaged: true }, 'Sign in again on this Mac'],
    [
      'one item that opens its place',
      { security: { recovery: 'idle', approval: { role: 'approve', state: 'asked', since: Date.now() } } },
      'Confirm new device'
    ]
  ] as const)('names %s', (_, extra, label) => {
    draw({ ...base, ...(extra as Partial<MatrixSnapshot>) })

    expect(summary().textContent).toBe(`Needs you: ${label}`)
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeTruthy()
  })

  it('is quiet with nothing waiting: no words, no list', () => {
    draw(base)

    expect(summary().textContent).toBe('')
    expect(window.document.querySelector('[data-matrix-attention-list]')).toBeNull()
  })
})

describe('a nearly full disk (layout r1/r2, owner 2026-11-24: the "Mac is full" alert goes)', () => {
  it('is not an item', () => {
    draw({ ...base, disk: { state: 'critical', freeGb: 1.6 } })

    expect(summary().getAttribute('data-count')).toBe('0')
  })
})

// In 0.20 chats are plain and nobody refuses a device: the old "verify your device" reminder raises nothing.
describe('a device of the person’s that isn’t verified (0.20)', () => {
  it('raises nothing, even when a snapshot lists one', () => {
    const phone = { deviceId: 'PHONE', name: 'iPhone 16 Pro', lastSeenAt: Date.now() - 60_000 }

    draw({ ...base, security: { recovery: 'idle', unverifiedDevices: [phone] } })

    expect(summary().getAttribute('data-count')).toBe('0')
  })
})

describe('an assistant whose ChatGPT sign-in ended', () => {
  it('says so by name and opens that sign-in from its row, closing the face', () => {
    const onOpen = vi.fn()
    const onDone = vi.fn()

    draw(
      {
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
      },
      onOpen,
      onDone
    )

    expect(summary().textContent).toBe('Needs you: Moon: connect ChatGPT')
    fireEvent.click(screen.getByRole('button', { name: /^Moon: connect ChatGPT/ }))
    expect(onOpen).toHaveBeenCalledWith({ kind: 'plan_sign_in', principal: 'moon', tone: 'warn' })
    expect(onDone).toHaveBeenCalledOnce()
  })
})

it('routes the damaged-device item to owner repair without signing out', async () => {
  const native = { repairOwnerDevice: vi.fn(async () => ({ state: 'repaired' })), signOut: vi.fn(), signIn: vi.fn() }
  Object.defineProperty(window, 'atumMatrix', { configurable: true, value: native })
  draw({ ...base, deviceDamaged: true })
  fireEvent.click(await screen.findByRole('button', { name: 'Re-verify' }))
  await waitFor(() => expect(native.repairOwnerDevice).toHaveBeenCalledOnce())
  expect(native.signOut).not.toHaveBeenCalled()
  expect(native.signIn).not.toHaveBeenCalled()
  Reflect.deleteProperty(window, 'atumMatrix')
})

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

  it('answers for that device from its row', async () => {
    draw({ ...base, newSignIn: signIn })

    expect(summary().textContent).toBe('Needs you: New sign-in on an iPhone')
    expect(screen.getByText('New sign-in on an iPhone')).toBeTruthy()
    expect(screen.getByText('Was this you?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign it out' }))
    await waitFor(() => expect(endDeviceSession).toHaveBeenCalledExactlyOnceWith('PHONE'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'It was me' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'It was me' }))
    await waitFor(() => expect(dismissNewSignIn).toHaveBeenCalledExactlyOnceWith('PHONE'))
  })

  it('says its label once in a list of several', () => {
    draw({ ...base, newSignIn: signIn, deviceDamaged: true })

    expect(screen.getByText('New sign-in on an iPhone')).toBeTruthy()
    expect(screen.getByText('Was this you?')).toBeTruthy()
    expect(screen.queryByText('New sign-in on an iPhone. Was this you?')).toBeNull()
  })

  it('goes away when main has accounted for the device', () => {
    const { rerender } = draw({ ...base, newSignIn: signIn })
    expect(screen.getByText('New sign-in on an iPhone')).toBeTruthy()

    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <Summary snapshot={base} />
        <MatrixAttentionSection agentName={() => 'Moon'} onOpen={vi.fn()} snapshot={base} />
      </I18nProvider>
    )
    expect(screen.queryByText('New sign-in on an iPhone')).toBeNull()
    expect(summary().textContent).toBe('')
  })
})

describe('another device asking to be approved', () => {
  it('opens the approval from its own row', () => {
    const onOpen = vi.fn()

    draw(
      { ...base, security: { recovery: 'idle', approval: { role: 'approve', state: 'asked', since: Date.now() } } },
      onOpen,
      vi.fn(),
      'vi'
    )

    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Xác nhận máy mới/ }))
    expect(onOpen).toHaveBeenCalledWith({ kind: 'approval', tone: 'warn' })
  })
})
