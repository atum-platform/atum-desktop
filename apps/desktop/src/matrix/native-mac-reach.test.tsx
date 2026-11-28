import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixReachMac } from '../../shared/matrix-agent-sources'
import type { MatrixNativeMacBridge, MatrixNativeSshStatus, MatrixNativeSshView } from '../../shared/matrix-native-mac'
import { matrixNativeMacCopy } from '../../shared/matrix-native-mac-copy'

import { MatrixYourMacsSection } from './mac-reach-rows'
import { useMatrixNativeMac } from './native-mac-reach'

const SETTINGS = 'x-apple.systempreferences:test'
const words = matrixNativeMacCopy.en.mac
const view = (status: MatrixNativeSshStatus): MatrixNativeSshView => ({ status, settingsUrl: SETTINGS })
const THIS_MAC: MatrixReachMac = { id: 'air', name: 'Test Air', thisMac: true, state: 'ready' }
const OTHER_MAC: MatrixReachMac = { id: 'mini', name: 'Test mini', thisMac: false, state: 'ready' }

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function bridge(answers: Partial<Record<string, MatrixNativeSshView | Error>> & { status: MatrixNativeSshView }) {
  const ssh = vi.fn(async (action: string) => {
    const answer = answers[action] ?? answers.status

    if (answer instanceof Error) {
      throw answer
    }

    return answer
  })

  return { ssh, value: { ssh, confirmCommand: vi.fn() } as unknown as MatrixNativeMacBridge }
}

function renderMacs(native: MatrixNativeMacBridge | undefined, macs: MatrixReachMac[] = [THIS_MAC, OTHER_MAC]) {
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixYourMacsSection macs={macs} nativeMac={native} />
    </I18nProvider>
  )
}

const thisRow = () => window.document.querySelector('[data-matrix-mac="this"]') as HTMLElement

describe("this Mac's native reach in Your Macs", () => {
  it('shows this Mac\'s one off switch when native reach is connected, and off disconnects it', async () => {
    const { ssh, value } = bridge({ status: view('connected'), disconnect: view('tunnel_down') })
    renderMacs(value)

    await waitFor(() => expect(thisRow().getAttribute('data-matrix-mac-native')).toBe('connected'))
    expect(ssh).toHaveBeenCalledWith('status')
    const toggle = within(thisRow()).getByRole('switch', { name: 'Assistants can use this Mac' })
    expect(toggle.getAttribute('data-state')).toBe('checked')
    expect(within(thisRow()).queryByRole('button')).toBeNull()
    expect(screen.queryByText(words.remoteLogin)).toBeNull()

    fireEvent.click(toggle)
    await waitFor(() => expect(ssh).toHaveBeenCalledWith('disconnect'))
  })

  it('offers one Allow… for Remote Login, and that is the only thing that asks for the password', async () => {
    const { ssh, value } = bridge({ status: view('needs_remote_login'), enable_remote_login: view('connected') })
    renderMacs(value)

    const allow = await within(thisRow()).findByRole('button', { name: words.allow })
    expect(within(thisRow()).getByText(words.remoteLogin)).toBeTruthy()
    expect(ssh).not.toHaveBeenCalledWith('enable_remote_login')

    fireEvent.click(allow)

    await waitFor(() => expect(ssh).toHaveBeenCalledWith('enable_remote_login'))
    await waitFor(() => expect(within(thisRow()).getByRole('switch', { name: 'Assistants can use this Mac' })).toBeTruthy())
    expect(screen.queryByText(words.remoteLogin)).toBeNull()
  })

  it('sends the owner to System Settings when the password prompt did not turn it on', async () => {
    const { ssh, value } = bridge({ status: view('needs_remote_login'), enable_remote_login: new Error('refused') })
    renderMacs(value)

    fireEvent.click(await within(thisRow()).findByRole('button', { name: words.allow }))

    const open = await within(thisRow()).findByRole('button', { name: words.openSettings })
    expect(within(thisRow()).getByText(words.remoteLoginManual)).toBeTruthy()

    fireEvent.click(open)
    await waitFor(() => expect(ssh).toHaveBeenCalledWith('open_settings'))
  })

  it('points at the full disk access option with one Open Settings', async () => {
    const { ssh, value } = bridge({ status: view('needs_full_disk_access_hint') })
    renderMacs(value)

    fireEvent.click(await within(thisRow()).findByRole('button', { name: words.openSettings }))

    expect(within(thisRow()).getByText(words.fullDisk)).toBeTruthy()
    await waitFor(() => expect(ssh).toHaveBeenCalledWith('open_settings'))
  })

  it('offers Try again for a failed setup result and refreshes on focus', async () => {
    const { ssh, value } = bridge({ status: view('tunnel_down'), connect: view('connected'), refresh: view('connected') })
    renderMacs(value)
    fireEvent.click(await within(thisRow()).findByRole('button', { name: words.tryAgain }))
    await waitFor(() => expect(ssh).toHaveBeenCalledWith('connect'))
    await waitFor(() => expect(within(thisRow()).getByRole('switch', { name: 'Assistants can use this Mac' })).toBeTruthy())
    fireEvent.focus(window)
    await waitFor(() => expect(ssh).toHaveBeenCalledWith('refresh'))
    expect(ssh.mock.calls.filter(([action]) => action === 'connect')).toHaveLength(1)
  })

  it('names the step and gives a plain-language reason for a known code', async () => {
    const refused = bridge({ status: { ...view('error'), step: 'start_tunnel', code: 'EACCES' } })
    renderMacs(refused.value)
    expect(await within(thisRow()).findByText(`${words.failure.atStep(words.failure.steps.start_tunnel)} ${words.failure.files}`)).toBeTruthy()
  })

  it('names the step for a code it does not know, and offers the reset beside Try again', async () => {
    const { value } = bridge({ status: { ...view('error'), step: 'start_tunnel', code: 'ETIMEDOUT' } })
    renderMacs(value)
    const line = await within(thisRow()).findByText(words.failure.atStep(words.failure.steps.start_tunnel, 'ETIMEDOUT'))
    expect(line).toBeTruthy()
    expect(within(thisRow()).getByRole('button', { name: words.tryAgain })).toBeTruthy()
    expect(within(thisRow()).getByRole('button', { name: words.disconnect })).toBeTruthy()
  })

  it('says the key list was refused in plain words, without the internal code', async () => {
    const { value } = bridge({ status: { ...view('error'), step: 'authorized_keys', code: 'device_registry_400_invalid' } })
    renderMacs(value)
    expect(await within(thisRow()).findByText(`${words.failure.atStep(words.failure.steps.authorized_keys)} ${words.failure.details}`)).toBeTruthy()
  })

  it('explains a saved route that needs a reset', async () => {
    const { value } = bridge({ status: { ...view('error'), step: 'prepare', code: 'native_ssh_route_recovery_required' } })
    renderMacs(value)
    expect(await within(thisRow()).findByText(`${words.failure.atStep(words.failure.steps.prepare)} ${words.failure.recovery}`)).toBeTruthy()
  })

  it('disconnects this Mac in one action and returns the row to Connect from scratch', async () => {
    const { ssh, value } = bridge({
      status: { ...view('error'), step: 'prepare', code: 'native_ssh_setup_failed' },
      disconnect: view('not_connected'),
      refresh: view('not_connected'),
      connect: view('connected')
    })

    renderMacs(value)

    fireEvent.click(await within(thisRow()).findByRole('button', { name: words.disconnect }))
    await waitFor(() => expect(ssh).toHaveBeenCalledWith('disconnect'))
    expect(await within(thisRow()).findByText(words.notConnected)).toBeTruthy()
    // Regaining focus never reconnects a Mac the owner just disconnected.
    fireEvent.focus(window)
    await waitFor(() => expect(ssh).toHaveBeenCalledWith('refresh'))
    expect(ssh).not.toHaveBeenCalledWith('connect')

    fireEvent.click(within(thisRow()).getByRole('button', { name: words.connect }))
    await waitFor(() => expect(ssh).toHaveBeenCalledWith('connect'))
    await waitFor(() => expect(within(thisRow()).getByRole('switch', { name: 'Assistants can use this Mac' })).toBeTruthy())
  })

  it('shows Try again working while it retries, and the new reason afterwards', async () => {
    const ssh = vi.fn(async (action: string) =>
      action === 'status' ? view('error') : new Promise<MatrixNativeSshView>(() => undefined)
    )

    renderMacs({ ssh, confirmCommand: vi.fn() } as unknown as MatrixNativeMacBridge)

    const retry = await within(thisRow()).findByRole('button', { name: words.tryAgain })
    fireEvent.click(retry)
    const working = await within(thisRow()).findByRole('button', { name: words.working })
    expect(working.hasAttribute('disabled')).toBe(true)
  })

  it("leaves a fix of this Mac's own first, and other Macs untouched", async () => {
    const { value } = bridge({ status: view('error') })
    renderMacs(value, [{ ...THIS_MAC, state: 'not_connected' }, OTHER_MAC])

    await waitFor(() => expect(thisRow().getAttribute('data-matrix-mac-native')).toBe('error'))
    expect(screen.queryByText(words.unreachable)).toBeNull()
    expect(within(thisRow()).getAllByRole('button')).toHaveLength(1)

    const other = window.document.querySelector('[data-matrix-mac="other"]') as HTMLElement
    expect(other.hasAttribute('data-matrix-mac-native')).toBe(false)
  })

  it('stays the plain row where main offers no native reach', () => {
    renderMacs(undefined)

    expect(thisRow().hasAttribute('data-matrix-mac-native')).toBe(false)
    expect(within(thisRow()).queryByRole('button')).toBeNull()
  })
})

describe('useMatrixNativeMac actions', () => {
  it('an owner action queues behind a focus refresh instead of being dropped, and settles when main answers', async () => {
    const calls: string[] = []
    let finishRefresh: (() => void) | undefined

    const ssh = vi.fn((action: string) => {
      calls.push(action)

      if (action === 'refresh') {
        return new Promise<MatrixNativeSshView>(resolve => {
          finishRefresh = () => resolve({ status: 'needs_remote_login', settingsUrl: 'x' } as MatrixNativeSshView)
        })
      }

      return Promise.resolve({ status: action === 'enable_remote_login' ? 'connected' : 'needs_remote_login', settingsUrl: 'x' } as MatrixNativeSshView)
    })

    const bridge = { ssh, confirmCommand: vi.fn() } as unknown as MatrixNativeMacBridge
    const { result } = renderHook(() => useMatrixNativeMac(true, bridge))

    await waitFor(() => expect(calls).toContain('status'))
    // The window regains focus after a macOS prompt: a quiet refresh is in flight.
    act(() => void window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(calls).toContain('refresh'))

    let settled = false

    const done = result.current.run('enable_remote_login').then(() => {
      settled = true
    })

    expect(calls).not.toContain('enable_remote_login')
    await act(async () => finishRefresh!())
    await act(async () => done)

    expect(calls.at(-1)).toBe('enable_remote_login')
    expect(settled).toBe(true)
    expect(result.current.view?.status).toBe('connected')

    // A second press while one runs shares it rather than starting twice.
    await act(async () => Promise.all([result.current.run('connect'), result.current.run('connect')]))
    expect(calls.filter(call => call === 'connect')).toHaveLength(1)
  })
})
