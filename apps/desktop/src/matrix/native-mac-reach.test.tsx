import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixReachMac } from '../../shared/matrix-agent-sources'
import type { MatrixNativeMacBridge, MatrixNativeSshStatus, MatrixNativeSshView } from '../../shared/matrix-native-mac'
import { matrixNativeMacCopy } from '../../shared/matrix-native-mac-copy'

import { MatrixYourMacsSection } from './mac-reach-rows'

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
  it('shows only the quiet Ready state when native reach is connected', async () => {
    const { ssh, value } = bridge({ status: view('connected') })
    renderMacs(value)

    await waitFor(() => expect(thisRow().getAttribute('data-matrix-mac-native')).toBe('connected'))
    expect(ssh).toHaveBeenCalledWith('status')
    expect(within(thisRow()).getByRole('status').textContent).toContain('Ready')
    expect(within(thisRow()).queryByRole('button')).toBeNull()
    expect(screen.queryByText(words.remoteLogin)).toBeNull()
  })

  it('offers one Allow… for Remote Login, and that is the only thing that asks for the password', async () => {
    const { ssh, value } = bridge({ status: view('needs_remote_login'), enable_remote_login: view('connected') })
    renderMacs(value)

    const allow = await within(thisRow()).findByRole('button', { name: words.allow })
    expect(within(thisRow()).getByText(words.remoteLogin)).toBeTruthy()
    expect(ssh).not.toHaveBeenCalledWith('enable_remote_login')

    fireEvent.click(allow)

    await waitFor(() => expect(ssh).toHaveBeenCalledWith('enable_remote_login'))
    await waitFor(() => expect(within(thisRow()).queryByRole('button')).toBeNull())
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

  it('says nothing for the first tunnel-down read, then one line and Try again once it holds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { ssh, value } = bridge({ status: view('tunnel_down'), connect: view('connected') })
    renderMacs(value)

    await waitFor(() => expect(thisRow().getAttribute('data-matrix-mac-native')).toBe('tunnel_down'))
    expect(within(thisRow()).queryByRole('button')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })

    fireEvent.click(await within(thisRow()).findByRole('button', { name: words.tryAgain }))
    expect(within(thisRow()).getByText(words.unreachable)).toBeTruthy()
    await waitFor(() => expect(ssh).toHaveBeenCalledWith('connect'))
    await waitFor(() => expect(within(thisRow()).queryByRole('button')).toBeNull())
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
