import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import type { MatrixVerification } from '../../shared/matrix-security'

import { bindMatrixHandleOwner, rememberMatrixHandle, resetMatrixHandlesForTest } from './person-handles'
import { $matrixDeviceToShow, DevicesPanel, RecoveryKeyPanel, VerificationPrompt } from './security-panel'

afterEach(() => {
  resetMatrixHandlesForTest()
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@alice:test', deviceId: 'A' },
  rooms: [],
  messages: [],
  roomId: null,
  error: null,
  security: { recovery: 'idle' }
}

function fixture() {
  const command = vi.fn(async (_value: unknown): Promise<unknown> => null)
  const endDeviceSession = vi.fn(async () => {})
  window.atumMatrix = { command, endDeviceSession } as unknown as MatrixUiBridge

  return { command, endDeviceSession }
}

describe('Matrix device controls', () => {
  const emoji: [string, string][] = [
    ['🐶', 'Dog'],
    ['🐱', 'Cat'],
    ['🦁', 'Lion'],
    ['🐎', 'Horse'],
    ['🦄', 'Unicorn'],
    ['🐷', 'Pig'],
    ['🐘', 'Elephant']
  ]

  it.each([
    { emoji, decimals: undefined, canConfirm: true },
    { emoji: undefined, decimals: [1234, 5678, 9012], canConfirm: true },
    { emoji: emoji.slice(0, 2), decimals: [1234, 5678], canConfirm: false },
    { emoji: undefined, decimals: undefined, canConfirm: false }
  ])('requires a complete SDK comparison set: $canConfirm', async ({ emoji, decimals, canConfirm }) => {
    const { command } = fixture()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <VerificationPrompt
          snapshot={{
            ...snapshot,
            security: {
              recovery: 'idle',
              verification: {
                id: 'peer',
                userId: '@bob:test',
                deviceId: 'C',
                incoming: false,
                state: 'compare',
                emoji,
                decimals
              }
            }
          }}
        />
      </I18nProvider>
    )
    const confirm = screen.getByRole('button', { name: 'They match' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(!canConfirm)

    if (canConfirm) {
      if (emoji) {
        const items = within(screen.getByRole('list', { name: 'Compare emoji' })).getAllByRole('listitem')
        expect(items.map(item => item.textContent)).toEqual(emoji.map(pair => pair.join('')))
      } else {
        expect(screen.getByLabelText('Compare numbers').textContent).toBe(decimals!.join(' · '))
      }

      fireEvent.click(confirm)
      await waitFor(() =>
        expect(command).toHaveBeenCalledWith({ kind: 'verificationRespond', id: 'peer', action: 'confirm' })
      )
    } else {
      expect(screen.queryByLabelText('Compare emoji')).toBeNull()
      expect(command).not.toHaveBeenCalled()
    }
  })

  it('hides completed verification prompts while preserving a cancelled terminal notice', () => {
    fixture()

    const request = {
      id: 'peer',
      userId: '@bob:test',
      deviceId: 'C',
      incoming: false,
      state: 'done' as const
    }

    const view = render(
      <I18nProvider configClient={null} initialLocale="en">
        <VerificationPrompt snapshot={{ ...snapshot, security: { recovery: 'idle', verification: request } }} />
      </I18nProvider>
    )

    expect(screen.queryByRole('region', { name: 'Device verification' })).toBeNull()

    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <VerificationPrompt
          snapshot={{ ...snapshot, security: { recovery: 'idle', verification: { ...request, state: 'cancelled' } } }}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('region', { name: 'Device verification' }).textContent).toContain('Verification cancelled')
  })

  it('closes an ended verification: Close at once, or by itself, and says Verified when it watched it finish', () => {
    vi.useFakeTimers()
    fixture()

    const request: MatrixVerification = {
      id: 'peer',
      userId: '@bob:test',
      deviceId: 'C',
      incoming: true,
      state: 'compare',
      emoji
    }

    const draw = (verification: MatrixVerification) => (
      <I18nProvider configClient={null} initialLocale="en">
        <VerificationPrompt snapshot={{ ...snapshot, security: { recovery: 'idle', verification } }} />
      </I18nProvider>
    )

    const card = () => screen.queryByRole('region', { name: 'Device verification' })

    try {
      // Watched to the end: "Verified", then gone after a moment.
      const view = render(draw(request))
      view.rerender(draw({ ...request, state: 'done' }))
      expect(card()?.textContent).toContain('Verified')
      act(() => vi.advanceTimersByTime(3_100))
      expect(card()).toBeNull()

      // A cancel stays long enough to read, with Close.
      view.rerender(draw({ ...request, id: 'peer-2', state: 'cancelled' }))
      expect(card()?.textContent).toContain('Verification cancelled')
      fireEvent.click(within(card()!).getByRole('button', { name: 'Close' }))
      expect(card()).toBeNull()

      view.rerender(draw({ ...request, id: 'peer-3', state: 'cancelled' }))
      act(() => vi.advanceTimersByTime(7_000))
      expect(card()).not.toBeNull()
      act(() => vi.advanceTimersByTime(1_100))
      expect(card()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // 2026-10-06 check: every snapshot from main carries a new request object, and the card's
  // clock restarted on each one, so "Verified" and a cancel lingered while snapshots kept coming.
  it('keeps an ended card’s clock through snapshots that repeat the same request', () => {
    vi.useFakeTimers()
    fixture()

    const request: MatrixVerification = {
      id: 'peer',
      userId: '@bob:test',
      deviceId: 'C',
      incoming: true,
      state: 'compare',
      emoji
    }

    const draw = (verification: MatrixVerification) => (
      <I18nProvider configClient={null} initialLocale="en">
        <VerificationPrompt snapshot={{ ...snapshot, security: { recovery: 'idle', verification } }} />
      </I18nProvider>
    )

    const card = () => screen.queryByRole('region', { name: 'Device verification' })

    try {
      const view = render(draw(request))
      view.rerender(draw({ ...request, state: 'done' }))

      // A snapshot every half second, each with the same request as a new object.
      for (let at = 0; at < 6; at += 1) {
        act(() => vi.advanceTimersByTime(500))
        view.rerender(draw({ ...request, state: 'done' }))
      }

      act(() => vi.advanceTimersByTime(100))
      expect(card()).toBeNull()

      view.rerender(draw({ ...request, id: 'peer-2', state: 'cancelled' }))

      for (let at = 0; at < 16; at += 1) {
        act(() => vi.advanceTimersByTime(500))
        view.rerender(draw({ ...request, id: 'peer-2', state: 'cancelled' }))
      }

      act(() => vi.advanceTimersByTime(100))
      expect(card()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('names who is on the other side of a verification, never by a raw address or device ID', () => {
    fixture()

    const request = (userId: string) => ({
      id: 'peer',
      userId,
      deviceId: 'DEVICEXYZ',
      incoming: true,
      state: 'requested' as const
    })

    const view = render(
      <I18nProvider configClient={null} initialLocale="en">
        <VerificationPrompt
          snapshot={{ ...snapshot, security: { recovery: 'idle', verification: request('@bob:test') } }}
        />
      </I18nProvider>
    )

    const region = () => screen.getByRole('region', { name: 'Device verification' })
    // An early readable ID reads as a name; it is not presented as a handle or in full.
    expect(region().textContent).toContain('bob')
    expect(region().textContent).not.toContain('@bob')
    expect(region().textContent).not.toContain('DEVICEXYZ')

    // A new person's ID is opaque: their verified @handle, else "Atum user", never the ID.
    const lan = '@user-3f2a9c0d1e2b4a5f6c7d8e9f0a1b2c3d:test'

    const verify = () => (
      <I18nProvider configClient={null} initialLocale="en">
        <VerificationPrompt snapshot={{ ...snapshot, security: { recovery: 'idle', verification: request(lan) } }} />
      </I18nProvider>
    )

    view.rerender(verify())
    expect(region().textContent).toContain('Atum user')
    expect(region().textContent).not.toContain('user-3f2a')

    act(() => {
      bindMatrixHandleOwner(snapshot.identity!.userId)
      rememberMatrixHandle(lan, 'lan')
    })
    view.rerender(verify())
    expect(region().textContent).toContain('@lan')

    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <VerificationPrompt
          snapshot={{ ...snapshot, security: { recovery: 'idle', verification: request(snapshot.identity!.userId) } }}
        />
      </I18nProvider>
    )
    expect(region().textContent).toContain('Another device')
    expect(region().textContent).not.toContain('DEVICEXYZ')
  })

  it('presents numbers for the exact request and routes mismatch without granting local trust', async () => {
    const { command } = fixture()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <VerificationPrompt
          snapshot={{
            ...snapshot,
            security: {
              recovery: 'idle',
              verification: {
                id: 'one',
                userId: '@alice:test',
                deviceId: 'B',
                incoming: true,
                state: 'compare',
                decimals: [5, 6, 7]
              }
            }
          }}
        />
      </I18nProvider>
    )
    expect(screen.getByText('5 · 6 · 7')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'They do not match' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'verificationRespond', id: 'one', action: 'mismatch' })
    )
    expect(command.mock.calls.some(([value]) => (value as { kind: string }).kind === 'verify')).toBe(false)
  })
  it('shows a new key once, and turns recovery on only after a separate confirmation', async () => {
    const { command } = fixture()
    command.mockImplementation(async (value: unknown) =>
      (value as { kind: string }).kind === 'recoveryCreateKey'
        ? { id: 'key-request', key: 'synthetic-private-key' }
        : null
    )
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel snapshot={snapshot} />
      </I18nProvider>
    )
    fireEvent.click(screen.getByText('Recovery key'))
    fireEvent.click(screen.getByRole('button', { name: 'Set up recovery key' }))
    await screen.findByDisplayValue('synthetic-private-key')

    const turnOn = screen.getByRole('button', { name: 'Turn on recovery' }) as HTMLButtonElement
    expect(turnOn.disabled).toBe(true)
    fireEvent.click(turnOn)
    expect(command).not.toHaveBeenCalledWith({ kind: 'recoverySetUp', id: 'key-request' })

    fireEvent.click(screen.getByRole('checkbox', { name: 'I’ve saved it somewhere safe' }))
    fireEvent.click(turnOn)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'recoverySetUp', id: 'key-request' }))
    expect(screen.queryByDisplayValue('synthetic-private-key')).toBeNull()
  })

  it('forgets an unconfirmed key after two minutes, here and in main', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const { command } = fixture()
      command.mockImplementation(async (value: unknown) =>
        (value as { kind: string }).kind === 'recoveryCreateKey'
          ? { id: 'key-request', key: 'synthetic-private-key' }
          : null
      )
      render(
        <I18nProvider configClient={null} initialLocale="en">
          <RecoveryKeyPanel launch snapshot={snapshot} />
        </I18nProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: 'Set up recovery key' }))
      await screen.findByDisplayValue('synthetic-private-key')
      command.mockClear()

      act(() => void vi.advanceTimersByTime(120_000))
      expect(screen.queryByDisplayValue('synthetic-private-key')).toBeNull()
      expect(command).toHaveBeenCalledWith({ kind: 'recoveryDiscard' })
      expect(screen.getByRole('button', { name: 'Set up recovery key' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a key the person cancels, and on unmount', async () => {
    const { command } = fixture()
    command.mockImplementation(async (value: unknown) =>
      (value as { kind: string }).kind === 'recoveryCreateKey'
        ? { id: 'key-request', key: 'synthetic-private-key' }
        : null
    )

    const view = render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel launch snapshot={snapshot} />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Set up recovery key' }))
    await screen.findByDisplayValue('synthetic-private-key')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByDisplayValue('synthetic-private-key')).toBeNull()
    expect(command).toHaveBeenCalledWith({ kind: 'recoveryDiscard' })

    command.mockClear()
    await act(async () => view.unmount())
    expect(command).toHaveBeenCalledWith({ kind: 'recoveryDiscard' })
  })

  it('discards a key that main finishes making after the panel has gone, and never shows it', async () => {
    const { command } = fixture()

    let finish: (value: unknown) => void = () => {}

    command.mockImplementation((value: unknown) =>
      (value as { kind: string }).kind === 'recoveryCreateKey'
        ? new Promise(resolve => (finish = resolve))
        : Promise.resolve(null)
    )

    const view = render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel launch snapshot={snapshot} />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Set up recovery key' }))
    await act(async () => view.unmount())
    command.mockClear()

    await act(async () => finish({ id: 'late', key: 'synthetic-late-key' }))
    expect(command).toHaveBeenCalledWith({ kind: 'recoveryDiscard' })
    expect(screen.queryByDisplayValue('synthetic-late-key')).toBeNull()
  })

  it('forgets a typed key when the person cancels instead of sending it', () => {
    fixture()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel launch snapshot={snapshot} />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use my recovery key' }))
    fireEvent.change(screen.getByLabelText('Recovery key'), { target: { value: 'typed-then-abandoned' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use my recovery key' }))
    expect((screen.getByLabelText('Recovery key') as HTMLInputElement).value).toBe('')
  })

  it('says what to do when a new key cannot be made, without the diagnostic', async () => {
    const { command } = fixture()
    command.mockRejectedValue(new Error('matrix_recovery_exists'))
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel launch snapshot={snapshot} />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set up recovery key' }))
    expect(await screen.findByText(/If you’ve set one up before, choose Use my recovery key/)).toBeTruthy()
    expect(screen.queryByText(/matrix_recovery_exists/)).toBeNull()
  })

  it('clears the recovery key the moment it is sent, even when unlocking is rejected', async () => {
    const { command } = fixture()
    command.mockRejectedValue(new Error('private diagnostic must not render'))
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel snapshot={snapshot} />
      </I18nProvider>
    )
    fireEvent.click(screen.getByText('Recovery key'))
    fireEvent.click(screen.getByRole('button', { name: 'Use my recovery key' }))
    const input = screen.getByLabelText('Recovery key')
    fireEvent.change(input, { target: { value: 'secret-to-restore' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'recoveryRestore', key: 'secret-to-restore' }))
    expect((input as HTMLInputElement).value).toBe('')
    expect(screen.queryByText(/private diagnostic/)).toBeNull()
    expect(await screen.findByText(/That didn’t finish/)).toBeTruthy()
  })

  it('accepts a key pasted with tabs or non-breaking spaces, as notes and web pages carry them', async () => {
    const { command } = fixture()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel launch snapshot={snapshot} />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use my recovery key' }))
    fireEvent.change(screen.getByLabelText('Recovery key'), { target: { value: ' EsTc\u00a0Samp\tleKe  yNot ReaL ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'recoveryRestore', key: 'EsTc Samp leKe yNot ReaL' })
    )
  })

  it('shows only the status while main works and once it is done', () => {
    fixture()

    const view = render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel launch snapshot={{ ...snapshot, security: { recovery: 'working' } }} />
      </I18nProvider>
    )

    expect(screen.getByRole('status').textContent).toContain('Working on it…')
    expect(screen.queryByRole('button')).toBeNull()

    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel launch snapshot={{ ...snapshot, security: { recovery: 'failed' } }} />
      </I18nProvider>
    )
    expect(screen.getByRole('button', { name: 'Use my recovery key' })).toBeTruthy()
    expect(screen.getByText(/That didn’t finish/)).toBeTruthy()
  })

  it('tells a restored Mac apart from a new setup', () => {
    fixture()

    const view = render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel launch snapshot={{ ...snapshot, security: { recovery: 'ready', restored: 12 } }} />
      </I18nProvider>
    )

    expect(screen.getByText('Your encrypted history is unlocked on this Mac.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Set up recovery key' })).toBeNull()

    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel launch snapshot={{ ...snapshot, security: { recovery: 'ready' } }} />
      </I18nProvider>
    )
    expect(screen.getByText('Recovery is on. Keep your key safe.')).toBeTruthy()
  })

  it('lists your devices with this Mac first, and offers sign-out only for your other devices', async () => {
    const { command, endDeviceSession } = fixture()
    command.mockImplementation(async (value: unknown) => {
      const { userId } = value as { userId?: string }

      return userId === '@bob:test'
        ? [{ userId: '@bob:test', deviceId: 'C', verified: false }]
        : [
            { userId: '@alice:test', deviceId: 'B', verified: false },
            { userId: '@alice:test', deviceId: 'A', verified: true }
          ]
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DevicesPanel snapshot={snapshot} />
      </I18nProvider>
    )
    fireEvent.click(screen.getByText('Your devices'))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'devices', userId: '@alice:test' }))

    const [mine] = await screen.findAllByRole('list')
    const rows = within(mine!).getAllByRole('listitem')
    expect(rows[0]!.textContent).toContain('This Mac')
    expect(rows[0]!.textContent).toContain('Verified')
    expect(within(rows[0]!).queryByRole('button')).toBeNull()
    // Never a raw device ID: a device without a name of its own is "Another device".
    expect(rows[1]!.textContent).toContain('Another device')
    expect(rows[1]!.textContent).not.toContain('B')
    expect(rows[1]!.textContent).toContain('Not verified')

    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Verify' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'verificationStart', userId: '@alice:test', deviceId: 'B' })
    )
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Sign that device out' }))
    await waitFor(() => expect(endDeviceSession).toHaveBeenCalledExactlyOnceWith('B'))

    // Someone else is found by their @name (a whole address is accepted quietly), never typed as an ID.
    fireEvent.click(screen.getByRole('button', { name: 'Verify someone else’s device…' }))
    fireEvent.change(screen.getByLabelText('Their @name'), { target: { value: '@bob:test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Find' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show devices' }))
    await waitFor(() => expect(screen.getAllByRole('list')).toHaveLength(2))
    const theirs = within(screen.getAllByRole('list')[1]!).getByRole('listitem')
    expect(within(theirs).getByRole('button', { name: 'Verify' })).toBeTruthy()
    expect(within(theirs).queryByRole('button', { name: 'Sign that device out' })).toBeNull()

    // Only one device's own sign-out page is ever opened: no link to the server's session list.
    expect(screen.queryByRole('button', { name: /manage devices|quản lý thiết bị/i })).toBeNull()
    expect(endDeviceSession).toHaveBeenCalledTimes(1)
  })

  it('names a device by what it calls itself and when it was last active', async () => {
    const { command } = fixture()
    const now = Date.now()
    command.mockResolvedValue([
      { userId: '@alice:test', deviceId: 'A', verified: true },
      {
        userId: '@alice:test',
        deviceId: 'PHONE',
        verified: true,
        name: 'Element X: iPhone',
        lastSeenAt: now - 2 * 86_400_000
      }
    ])
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DevicesPanel snapshot={snapshot} />
      </I18nProvider>
    )
    const phone = await screen.findByText('Element X: iPhone')
    expect(phone.closest('li')?.textContent).toContain('Verified · Active 2 days ago')
    expect(phone.closest('li')?.textContent).not.toContain('PHONE')
  })

  it('opens at the device the title bar asked about, with its Verify focused, once', async () => {
    const { command } = fixture()
    command.mockResolvedValue([
      { userId: '@alice:test', deviceId: 'A', verified: true },
      { userId: '@alice:test', deviceId: 'MAC2', name: 'Atum · MacBook', verified: true },
      { userId: '@alice:test', deviceId: 'PHONE', name: 'iPhone 16 Pro', verified: false }
    ])
    $matrixDeviceToShow.set('PHONE')
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DevicesPanel snapshot={snapshot} />
      </I18nProvider>
    )

    const phone = (await screen.findByText('iPhone 16 Pro')).closest('li')!
    await waitFor(() => expect(window.document.activeElement).toBe(within(phone).getByRole('button', { name: 'Verify' })))
    expect(phone.hasAttribute('data-matrix-device-shown')).toBe(true)
    expect(screen.getByText('Atum · MacBook').closest('li')!.hasAttribute('data-matrix-device-shown')).toBe(false)
    // The ask is spent: opening Settings again later doesn't jump to it.
    expect($matrixDeviceToShow.get()).toBeNull()

    // Verify itself is the panel's existing comparison, unchanged.
    fireEvent.click(within(phone).getByRole('button', { name: 'Verify' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'verificationStart', userId: '@alice:test', deviceId: 'PHONE' })
    )
  })

  it('just shows the list when the device asked about is gone', async () => {
    const { command } = fixture()
    command.mockResolvedValue([{ userId: '@alice:test', deviceId: 'A', verified: true }])
    $matrixDeviceToShow.set('PHONE')
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DevicesPanel snapshot={snapshot} />
      </I18nProvider>
    )

    await screen.findByText('This Mac')
    await waitFor(() => expect($matrixDeviceToShow.get()).toBeNull())
  })

  it('never calls an unverified Mac verified, and points at the recovery key', async () => {
    const { command } = fixture()
    command.mockResolvedValue([{ userId: '@alice:test', deviceId: 'A', verified: false }])
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DevicesPanel snapshot={snapshot} />
      </I18nProvider>
    )
    expect(await screen.findByText('Not verified yet. Use your recovery key to verify it.')).toBeTruthy()
    expect(screen.queryByText('Verified')).toBeNull()
  })

  it('never lets an older device answer replace a newer one', async () => {
    const { command } = fixture()
    const answers: ((rows: unknown) => void)[] = []

    command.mockImplementation(() => new Promise(resolve => answers.push(resolve)))

    const element = (state: MatrixSnapshot['state']) => (
      <I18nProvider configClient={null} initialLocale="en">
        <DevicesPanel snapshot={{ ...snapshot, state }} />
      </I18nProvider>
    )

    const view = render(element('ready'))
    view.rerender(element('connecting'))
    view.rerender(element('ready'))
    await waitFor(() => expect(answers).toHaveLength(2))

    await act(async () => answers[1]!([{ userId: '@alice:test', deviceId: 'A', verified: false }]))
    await act(async () => answers[0]!([{ userId: '@alice:test', deviceId: 'A', verified: true }]))
    expect(screen.getByText('Not verified yet. Use your recovery key to verify it.')).toBeTruthy()
    expect(screen.queryByText('Verified')).toBeNull()
  })

  it('drops an answer about someone whose @name was edited while it was on its way', async () => {
    const { command } = fixture()

    let answer: (rows: unknown) => void = () => {}

    command.mockImplementation((value: unknown) =>
      (value as { userId?: string }).userId === '@bob:test'
        ? new Promise(resolve => (answer = resolve))
        : Promise.resolve([{ userId: '@alice:test', deviceId: 'A', verified: true }])
    )
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DevicesPanel snapshot={snapshot} />
      </I18nProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Verify someone else’s device…' }))
    fireEvent.change(screen.getByLabelText('Their @name'), { target: { value: '@bob:test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Find' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show devices' }))
    fireEvent.change(screen.getByLabelText('Their @name'), { target: { value: '@carol:test' } })

    await act(async () => answer([{ userId: '@bob:test', deviceId: 'BOBPHONE', verified: false }]))
    expect(screen.queryByText('Another device')).toBeNull()
  })

  it('offers a retry when devices cannot load', async () => {
    const { command } = fixture()
    command.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([])
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DevicesPanel snapshot={snapshot} />
      </I18nProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('Couldn’t load your devices.')).toBeNull())
  })
})

describe('the recovery key in Settings', () => {
  it('says recovery is on and offers only using the key when the account already has one', () => {
    fixture()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel snapshot={{ ...snapshot, security: { recovery: 'idle', storage: 'present' } }} />
      </I18nProvider>
    )
    expect(window.document.querySelector('[data-matrix-recovery-status="on"]')?.textContent).toBe('On')
    expect(screen.getByRole('button', { name: 'Use my recovery key' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Set up recovery key' })).toBeNull()
  })

  it('puts the one action beside the recovery row it acts on', () => {
    fixture()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel snapshot={{ ...snapshot, security: { recovery: 'idle', storage: 'present' } }} />
      </I18nProvider>
    )
    const row = screen.getByText('Recovery key').closest('.atum-settings-row') as HTMLElement
    expect(within(row).getByRole('button', { name: 'Use my recovery key' })).toBeTruthy()
    expect(within(row).getByText('On')).toBeTruthy()
  })

  it('says it is not set up and offers setting it up as the one main action', () => {
    fixture()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel snapshot={{ ...snapshot, security: { recovery: 'idle', storage: 'absent' } }} />
      </I18nProvider>
    )
    expect(window.document.querySelector('[data-matrix-recovery-status="off"]')?.textContent).toBe('Not set up')
    expect(screen.getByRole('button', { name: 'Set up recovery key' }).getAttribute('data-variant')).toBe('default')
    expect(screen.queryByRole('button', { name: 'Use my recovery key' })).toBeNull()
  })

  it('counts down the two minutes a new key stays on screen', async () => {
    const { command } = fixture()
    command.mockImplementation(async (value: unknown) =>
      (value as { kind: string }).kind === 'recoveryCreateKey' ? { id: 'key', key: 'synthetic-key' } : null
    )
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel snapshot={{ ...snapshot, security: { recovery: 'idle', storage: 'absent' } }} />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set up recovery key' }))
    await screen.findByDisplayValue('synthetic-key')
    expect(window.document.querySelector('[data-matrix-key-countdown]')?.textContent).toMatch(/^Hidden in [12]:\d\d$/)
  })

  it('shows a key the person already has, kept on this Mac, without asking them to write it down', async () => {
    const { command } = fixture()
    // A sample, never a real key.
    const reveal = vi.fn(async () => 'EsTc Samp leKe yNot ReaL 0000 1111 2222 3333 4444 5555 6666')
    const written = vi.fn(async () => {})
    window.atumMatrix = { ...window.atumMatrix, recoveryKey: { reveal, written } } as MatrixUiBridge

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel snapshot={{ ...snapshot, security: { recovery: 'idle', storage: 'present', kept: true } }} />
      </I18nProvider>
    )

    expect(screen.getByText('Saved on this Mac')).toBeTruthy()
    // This Mac unlocks by itself: no "use my key" to offer.
    expect(screen.queryByRole('button', { name: 'Use my recovery key' })).toBeNull()
    expect(screen.getByText(/signing in again here unlocks by itself/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show key…' }))
    const key = (await screen.findByLabelText('Recovery key')) as HTMLTextAreaElement
    expect(key.value).toMatch(/^EsTc/)
    expect(screen.queryByRole('checkbox', { name: 'I’ve written it down' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByLabelText('Recovery key')).toBeNull())
    expect(written).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'recoveryRestore' }))
  })

  it('keeps the key in iCloud Keychain when this build can, and asks before removing it everywhere', async () => {
    fixture()
    const icloudKeychain = vi.fn(async () => {})
    window.atumMatrix = {
      ...window.atumMatrix,
      icloudKeychain,
      recoveryKey: { reveal: vi.fn(), written: vi.fn() }
    } as unknown as MatrixUiBridge

    const view = render(
      <I18nProvider configClient={null} initialLocale="vi">
        <RecoveryKeyPanel
          snapshot={{ ...snapshot, security: { recovery: 'idle', storage: 'present', kept: true, icloud: 'on' } }}
        />
      </I18nProvider>
    )

    const toggle = screen.getByRole('switch', { name: 'Lưu khóa trong iCloud Keychain' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/Apple và Atum đều không đọc được khóa/)).toBeTruthy()

    fireEvent.click(toggle)
    expect(icloudKeychain).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Xóa' }))
    await waitFor(() => expect(icloudKeychain).toHaveBeenCalledWith(false))

    view.rerender(
      <I18nProvider configClient={null} initialLocale="vi">
        <RecoveryKeyPanel
          snapshot={{ ...snapshot, security: { recovery: 'idle', storage: 'present', kept: true, icloud: 'off' } }}
        />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Lưu khóa trong iCloud Keychain' }))
    await waitFor(() => expect(icloudKeychain).toHaveBeenCalledWith(true))
  })

  it('shows no iCloud row in a build without the helper', () => {
    fixture()
    window.atumMatrix = {
      ...window.atumMatrix,
      recoveryKey: { reveal: vi.fn(), written: vi.fn() }
    } as unknown as MatrixUiBridge

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel snapshot={{ ...snapshot, security: { recovery: 'idle', storage: 'present', kept: true } }} />
      </I18nProvider>
    )

    expect(screen.queryByRole('switch')).toBeNull()
  })
})
