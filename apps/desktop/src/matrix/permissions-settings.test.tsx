// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixPermissionsBridge, MatrixPermissionsSnapshot } from '../../shared/matrix-permissions'

import { MatrixPermissionsSettings } from './permissions-settings'

const macos = (overrides: Partial<MatrixPermissionsSnapshot> = {}): MatrixPermissionsSnapshot => ({
  platform: 'macos',
  permissions: {
    accessibility: 'not-granted',
    screen: 'denied',
    microphone: 'not-determined',
    automation: 'manual-check',
    files: 'manual-check',
    fullDisk: 'not-granted',
    location: 'not-determined'
  },
  ...overrides
})

function bridge(
  status = macos()
): MatrixPermissionsBridge & { status: ReturnType<typeof vi.fn>; openSettings: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn().mockResolvedValue(status),
    openSettings: vi.fn().mockResolvedValue(undefined)
  }
}

function renderSettings(
  options: {
    active?: boolean
    bridge?: MatrixPermissionsBridge
    locale?: Locale
  } = {}
) {
  const active = options.active ?? true
  const permissions = Object.hasOwn(options, 'bridge') ? options.bridge : bridge()
  const locale = options.locale ?? 'en'

  const content = (next: { active: boolean; bridge?: MatrixPermissionsBridge }) => (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixPermissionsSettings {...next} />
    </I18nProvider>
  )

  const view = render(content({ active, bridge: permissions }))

  return {
    ...view,
    bridge: permissions,
    update: (next: { active: boolean; bridge?: MatrixPermissionsBridge }) => view.rerender(content(next))
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(next => {
    resolve = next
  })

  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('MatrixPermissionsSettings', () => {
  it('subscribes to passive permission polling only while the pane is visible', async () => {
    const permissions = bridge()
    const stop = vi.fn()
    permissions.watch = vi.fn(() => stop)
    const view = renderSettings({ active: false, bridge: permissions })

    expect(permissions.watch).not.toHaveBeenCalled()
    view.update({ active: true, bridge: permissions })
    await waitFor(() => expect(permissions.watch).toHaveBeenCalledOnce())
    view.update({ active: false, bridge: permissions })
    expect(stop).toHaveBeenCalledOnce()
  })

  it('reads only when active, then checks again by itself when the window comes back', async () => {
    const permissions = bridge()
    const view = renderSettings({ active: false, bridge: permissions })
    expect(permissions.status).not.toHaveBeenCalled()

    view.update({ active: true, bridge: permissions })
    await waitFor(() => expect(permissions.status).toHaveBeenCalledOnce())
    fireEvent.focus(window)
    await waitFor(() => expect(permissions.status).toHaveBeenCalledTimes(2))
    // No manual check to press: focus is the re-check.
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    view.update({ active: false, bridge: permissions })
    fireEvent.focus(window)
    expect(permissions.status).toHaveBeenCalledTimes(2)
  })

  it('retires stale reads when hidden, unmounted, or replaced by another bridge', async () => {
    const first = deferred<MatrixPermissionsSnapshot>()
    const oldBridge = bridge()
    oldBridge.status.mockReturnValue(first.promise)
    const view = renderSettings({ bridge: oldBridge })
    view.update({ active: false, bridge: oldBridge })
    await act(async () => first.resolve(macos({ permissions: { ...macos().permissions, accessibility: 'granted' } })))
    expect(screen.queryByText('Allowed')).toBeNull()

    const second = deferred<MatrixPermissionsSnapshot>()
    const nextBridge = bridge()
    nextBridge.status.mockReturnValue(second.promise)
    view.update({ active: true, bridge: nextBridge })
    view.unmount()
    await act(async () => second.resolve(macos({ permissions: { ...macos().permissions, screen: 'granted' } })))

    const stale = deferred<MatrixPermissionsSnapshot>()
    const thirdBridge = bridge()
    thirdBridge.status.mockReturnValue(stale.promise)
    const freshBridge = bridge(macos({ permissions: { ...macos().permissions, microphone: 'granted' } }))
    const replacement = renderSettings({ bridge: thirdBridge })
    replacement.update({ active: true, bridge: freshBridge })
    await screen.findByText('Allowed')
    await act(async () => stale.resolve(macos({ permissions: { ...macos().permissions, accessibility: 'granted' } })))
    expect(screen.getAllByText('Allowed')).toHaveLength(1)
  })

  it('shows Allowed with a tick, or one Allow… that opens only the fixed pane, and explains a failed open', async () => {
    const permissions = bridge(macos({ permissions: { ...macos().permissions, microphone: 'granted' } }))
    renderSettings({ bridge: permissions })
    const microphone = await screen.findByText('Allowed')
    expect(microphone.closest('[data-matrix-permission]')?.getAttribute('data-matrix-permission')).toBe('microphone')
    expect(screen.queryByRole('button', { name: 'Allow Microphone' })).toBeNull()
    expect(screen.getByText('Lets Atum see your screen when you ask.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Allow Accessibility' }))
    await waitFor(() => expect(permissions.openSettings).toHaveBeenCalledWith('accessibility'))
    expect(screen.getAllByText('Allowed')).toHaveLength(1)

    permissions.openSettings.mockRejectedValueOnce(new Error('private operating-system detail'))
    fireEvent.click(screen.getByRole('button', { name: 'Allow Screen recording' }))
    expect(await screen.findByText(/Couldn’t open System Settings/)).toBeTruthy()
    expect(screen.queryByText(/private operating-system detail/)).toBeNull()
  })

  it('is honest when the bridge is missing, unsupported, unreadable or restricted, with no jargon', async () => {
    renderSettings({ bridge: undefined })
    expect(await screen.findByText(/can’t show these/)).toBeTruthy()

    cleanup()
    const unsupported = bridge({ platform: 'unsupported', permissions: macos().permissions })
    renderSettings({ bridge: unsupported })
    expect(await screen.findByText(/available on a Mac/)).toBeTruthy()

    cleanup()
    const failing = bridge()
    failing.status.mockRejectedValueOnce(new Error('denied'))
    renderSettings({ bridge: failing })
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findAllByRole('button', { name: /^Allow / })).toHaveLength(7)

    cleanup()
    renderSettings({ bridge: bridge(macos({ permissions: { ...macos().permissions, automation: 'restricted' } })) })
    expect(await screen.findByText('Restricted by macOS')).toBeTruthy()
    expect(screen.queryByText(/CuaDriver/)).toBeNull()
    expect(screen.queryByText(/Computer use/)).toBeNull()
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)('lists all seven accesses in one group in %s', async locale => {
    const { container } = renderSettings({ bridge: bridge(), locale })
    await waitFor(() => expect(container.querySelectorAll('[data-matrix-permission]')).toHaveLength(7))
    expect(container.querySelectorAll('[data-matrix-permissions-list]')).toHaveLength(1)
  })
})
