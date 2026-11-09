import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { AppDescriptor } from '../../shared/app-catalog'
import type { AppViewBridge } from '../../shared/app-view/ipc'
import type { MatrixAppMenu, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { MatrixApps } from './apps'
import { matrixChatCopy } from './chat-copy'
import { matrixChatFailure, matrixChatFailureCopy, matrixFailureRetry, matrixFailureSubject } from './chat-error'

const river: AppDescriptor = {
  app: 'river',
  app_id: '00000000-0000-4000-8000-11e594f48195',
  app_version_id: '00000000-0000-4000-8000-e79acd97ac88',
  name: { en: 'River' },
  subtitle: null,
  description: { en: 'Explore the current.' },
  icon: null,
  accent: '#12A4DE',
  affiliation: 'partner',
  verified: true,
  availability: 'available',
  roster_default: true,
  roster_order: 0,
  supported_modes: ['direct'],
  matrix_room_context: 'addressed_only',
  has_surface: true,
  link: { mode: 'external_account', state: 'never_linked' }
}

const moon: AppDescriptor = {
  ...river,
  app: 'moon',
  name: { en: 'Moon' },
  link: { ...river.link, state: 'linked' },
  bot: {
    v: 1,
    user_id: '@app-moon:atumplatform.com',
    handle: 'moon_bot',
    display_name: 'Moon',
    avatar: { url: 'data:image/png;base64,cG9ydHJhaXQ=', sha256: 'a'.repeat(64) },
    device_generation: 1,
    device: { device_id: 'MOON_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
    state: 'active',
    groups: true,
    consent: 'accepted',
    disclosure_version: 1,
    open_route_id: 'chat',
    open_shared_memory: true,
    purchase_route_id: 'chat'
  }
}

const base: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@river:test', deviceId: 'RIVER' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null,
  destination: { kind: 'app', appId: river.app_id },
  apps: {
    state: 'ready',
    apps: [river],
    connections: {
      river: {
        phase: 'idle',
        connection: { state: 'never_linked', connectionRequired: true, available: true, readiness: 'not_linked' }
      }
    }
  },
  appShortcuts: { [river.app_id]: { visibility: 'default', status: 'ready' } }
}

function menu(): MatrixAppMenu {
  return {
    app: river,
    routes: [{ id: 'explore', label: { en: 'Open River', vi: 'Mở River' }, icon: 'globe', session: 'none' }]
  }
}

function fixture(snapshot: MatrixSnapshot = base) {
  let returnToHost: (() => void) | undefined
  // The window's failure band (app.tsx `fail`): what a failed action is handed.
  const fail = vi.fn<(cause?: unknown) => void>()

  const view: AppViewBridge = {
    open: vi.fn(async () => ({ viewId: 'river-view' })),
    setBounds: vi.fn(async () => ({ ok: true as const })),
    setVisibility: vi.fn(async () => ({ ok: true as const })),
    focus: vi.fn(async () => ({ ok: true as const })),
    reload: vi.fn(async () => ({ ok: true as const })),
    close: vi.fn(async () => ({ ok: true as const })),
    onState: vi.fn(() => vi.fn())
  }

  const apps = {
    onReturn: vi.fn(listener => {
      returnToHost = listener

      return vi.fn()
    }),
    refresh: vi.fn(async () => {}),
    menu: vi.fn(async () => menu()),
    connection: vi.fn(async () => {}),
    chat: vi.fn(async () => '!app:test'),
    group: vi.fn(async () => '!group:test'),
    withdraw: vi.fn(async () => {}),
    view
  }

  const command = vi.fn(async () => null)

  window.atumMatrix = { apps, command } as unknown as MatrixUiBridge

  const rendered = render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixApps fail={fail} obstructed={false} snapshot={snapshot} />
    </I18nProvider>
  )

  return { apps, command, fail, rendered, returnToHost: () => returnToHost?.(), view }
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  vi.stubGlobal('IntersectionObserver', undefined)
})

it('opens generic app chat only after explicit action on a linked app, never on view load', async () => {
  const selected = { ...river, link: { ...river.link, state: 'linked' as const } }
  const f = fixture({ ...base, apps: { ...base.apps!, apps: [selected] } })
  expect(f.apps.chat).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: 'New app chat' }))
  await waitFor(() => expect(f.apps.chat).toHaveBeenCalledWith(river.app_id, 'en'))
  fireEvent.click(screen.getByRole('button', { name: 'Remove app from chats' }))
  await waitFor(() => expect(f.apps.withdraw).toHaveBeenCalledWith(river.app_id))
})

it('starts a fresh shared app conversation only after a named form submission', async () => {
  const selected = { ...river, link: { ...river.link, state: 'linked' as const } }
  const f = fixture({ ...base, apps: { ...base.apps!, apps: [selected] } })
  fireEvent.click(await screen.findByRole('button', { name: 'New shared app conversation' }))
  const name = await screen.findByRole('textbox', { name: 'Group name' })
  expect(f.apps.group).not.toHaveBeenCalled()
  fireEvent.change(name, { target: { value: 'Team' } })
  fireEvent.submit(name.closest('form')!)
  await waitFor(() => expect(f.apps.group).toHaveBeenCalledWith(river.app_id, 'Team', 'en'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(f.apps.chat).not.toHaveBeenCalled()
})

it('does not enroll an unlinked app from the chat affordance', async () => {
  const f = fixture()
  expect(screen.getByRole('button', { name: 'New app chat' }).hasAttribute('disabled')).toBe(true)
  expect(f.apps.chat).not.toHaveBeenCalled()
})

it.each([undefined, null])(
  'hides unsupported native chat without removing app panes or withdrawal (%s)',
  async context => {
    const selected = { ...river, matrix_room_context: context, link: { ...river.link, state: 'linked' as const } }
    const f = fixture({ ...base, apps: { ...base.apps!, apps: [selected] } })
    expect(screen.queryByRole('button', { name: 'New app chat' })).toBeNull()
    expect(await screen.findByRole('button', { name: 'Open River' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove app from chats' }))
    await waitFor(() => expect(f.apps.withdraw).toHaveBeenCalledWith(river.app_id))
    expect(f.apps.chat).not.toHaveBeenCalled()
  }
)

it('offers Matrix chat without legacy direct mode', async () => {
  const selected = { ...river, supported_modes: [], link: { ...river.link, state: 'linked' as const } }
  const f = fixture({ ...base, apps: { ...base.apps!, apps: [selected] } })
  fireEvent.click(screen.getByRole('button', { name: 'New app chat' }))
  await waitFor(() => expect(f.apps.chat).toHaveBeenCalledWith(river.app_id, 'en'))
})

it('does not present an official Matrix identity as a second app chat', async () => {
  const moon: AppDescriptor = {
    ...river,
    app: 'moon',
    name: { en: 'Moon' },
    link: { ...river.link, state: 'linked' },
    bot: {
      v: 1,
      user_id: '@app-moon:atumplatform.com',
      handle: 'moon_bot',
      display_name: 'Moon',
      avatar: { url: 'data:image/png;base64,cG9ydHJhaXQ=', sha256: 'a'.repeat(64) },
      device_generation: 1,
      device: { device_id: 'MOON_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
      state: 'active',
      groups: true,
      consent: 'accepted',
      disclosure_version: 1,
      open_route_id: 'chat',
      open_shared_memory: true,
      purchase_route_id: 'chat'
    }
  }

  const f = fixture({ ...base, apps: { ...base.apps!, apps: [moon] } })
  expect(screen.queryByRole('button', { name: 'New app chat' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'New shared app conversation' })).toBeNull()
  expect(f.apps.chat).not.toHaveBeenCalled()
  expect(f.apps.group).not.toHaveBeenCalled()

  f.rendered.unmount()
  cleanup()
  fixture({ ...base, destination: { kind: 'discover' }, apps: { ...base.apps!, apps: [moon] } })
  const card = within(window.document.querySelector<HTMLElement>('[data-store-app]')!)
  fireEvent.pointerDown(card.getByRole('button', { name: 'More for Moon' }), { button: 0 })
  await screen.findByRole('menuitem', { name: 'Remove from sidebar' })
  expect(screen.queryByRole('menuitem', { name: 'New app chat' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'New shared app conversation' })).toBeNull()
})

it('shows and connects a chat-only app without requesting or launching a browser manifest', async () => {
  const chat = { ...river, supported_modes: [], has_surface: false }
  const selected = { ...base, apps: { ...base.apps!, apps: [chat] } }
  const f = fixture({ ...selected, destination: { kind: 'discover' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  await waitFor(() => expect(f.command).toHaveBeenCalledWith({ kind: 'selectApp', appId: river.app_id }))
  f.rendered.rerender(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixApps fail={f.fail} obstructed={false} snapshot={selected} />
    </I18nProvider>
  )
  await waitFor(() => expect(f.apps.connection).toHaveBeenCalledWith(river.app_id, 'read'))
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await waitFor(() => expect(f.apps.connection).toHaveBeenCalledWith(river.app_id, 'begin'))
  expect(f.apps.menu).not.toHaveBeenCalled()
  expect(f.view.open).not.toHaveBeenCalled()
})

it('keeps disconnect reachable for a linked chat-only app after its chat capability is removed', async () => {
  const chat = {
    ...river,
    has_surface: false,
    matrix_room_context: null,
    link: { ...river.link, state: 'linked' as const }
  }

  const selected = { ...base, apps: { ...base.apps!, apps: [chat] } }
  const f = fixture({ ...selected, destination: { kind: 'discover' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  await waitFor(() => expect(f.command).toHaveBeenCalledWith({ kind: 'selectApp', appId: river.app_id }))
  f.rendered.rerender(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixApps fail={f.fail} obstructed={false} snapshot={selected} />
    </I18nProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
  await waitFor(() => expect(f.apps.connection).toHaveBeenCalledWith(river.app_id, 'disconnect'))
  expect(screen.queryByRole('button', { name: 'New app chat' })).toBeNull()
  expect(f.apps.chat).not.toHaveBeenCalled()
  expect(f.apps.menu).not.toHaveBeenCalled()
  expect(f.view.open).not.toHaveBeenCalled()
})

it('offers no Connect for an account that is already linked, only for one that is not or cannot be served', async () => {
  const linked = {
    ...base,
    apps: {
      ...base.apps!,
      apps: [{ ...river, link: { ...river.link, state: 'linked' as const } }],
      connections: {
        river: {
          phase: 'idle' as const,
          connection: { state: 'linked' as const, connectionRequired: true, available: true, readiness: 'ready' as const }
        }
      }
    }
  }

  const first = fixture(linked)
  await screen.findByText('Connected')
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
  first.rendered.unmount()
  cleanup()

  // Main's read wins over the catalog's older copy of the link.
  fixture({ ...linked, apps: { ...linked.apps, apps: [river] } })
  await screen.findByText('Connected')
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
  cleanup()

  // A link the app cannot serve any more is how a person gets back in: Connect again.
  fixture({
    ...linked,
    apps: {
      ...linked.apps,
      connections: {
        river: {
          phase: 'idle' as const,
          connection: { state: 'linked' as const, connectionRequired: true, available: true, readiness: 'unavailable' as const }
        }
      }
    }
  })
  expect(await screen.findByRole('button', { name: 'Connect' })).toBeTruthy()
})

it('does not offer Connect again for a linked account whose readiness is still pending', async () => {
  const pending = {
    ...base,
    apps: {
      ...base.apps!,
      apps: [{ ...river, link: { ...river.link, state: 'linked' as const } }],
      connections: {
        river: {
          phase: 'idle' as const,
          connection: { state: 'linked' as const, connectionRequired: true, available: true, readiness: 'pending' as const }
        }
      }
    }
  }

  fixture(pending)
  expect(await screen.findByText('Connection pending')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
})

it("opens an official bot's chat from its Store card, not an app page with a Connect that has nothing left to do", async () => {
  const f = fixture({ ...base, destination: { kind: 'discover' }, apps: { ...base.apps!, apps: [moon] } })
  const card = within(window.document.querySelector<HTMLElement>('[data-store-app]')!)
  fireEvent.click(card.getByRole('button', { name: 'Open' }))
  await waitFor(() => expect(f.apps.chat).toHaveBeenCalledWith(moon.app_id, 'en'))
  expect(f.command).not.toHaveBeenCalled()
})

// A Store card's Open is the same action as the sidebar row's: a chat that does not open is said by name,
// with the Retry that opens it again, in the window's failure band (app.tsx `fail`) - not as a catalog notice
// that names no cause and has no way to try the same chat again.
it('hands a Store Open that fails to the window by name, with a Retry that opens the same chat again', async () => {
  const f = fixture({ ...base, destination: { kind: 'discover' }, apps: { ...base.apps!, apps: [moon] } })
  f.apps.chat.mockRejectedValueOnce(new Error("Error invoking remote method 'matrix:ui': Error: matrix_app_bot_syncing"))

  const card = within(window.document.querySelector<HTMLElement>('[data-store-app]')!)
  fireEvent.click(card.getByRole('button', { name: 'Open' }))

  await waitFor(() => expect(f.fail).toHaveBeenCalledOnce())
  const cause = f.fail.mock.calls[0]![0]

  // What the band reads from it: the cause (the chat is taking long to open), the bot's name, and Retry.
  expect(matrixChatFailure(cause)).toBe('app_bot_syncing')
  expect(matrixFailureSubject(cause)).toBe('Moon')
  expect(matrixChatFailureCopy('app_bot_syncing', matrixChatCopy('en'), 'en', matrixFailureSubject(cause))).toBe(
    'The chat with Moon is taking longer than usual to open. Try again.'
  )

  // The page keeps no second, generic notice of its own.
  expect(screen.queryByText('Apps are unavailable right now.')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh apps' })).toBeNull()

  // Retry is the same open again, for the same app.
  const retry = matrixFailureRetry(cause)
  expect(retry).toBeTypeOf('function')
  retry!()
  await waitFor(() => expect(f.apps.chat).toHaveBeenCalledTimes(2))
  expect(f.apps.chat).toHaveBeenNthCalledWith(1, moon.app_id, 'en')
  expect(f.apps.chat).toHaveBeenNthCalledWith(2, moon.app_id, 'en')
  expect(f.fail).toHaveBeenCalledOnce()
})

it('says a Store Open is under way and takes no second click until it has ended', async () => {
  const f = fixture({ ...base, destination: { kind: 'discover' }, apps: { ...base.apps!, apps: [moon] } })

  let finish: (roomId: string) => void = () => {}

  f.apps.chat.mockImplementationOnce(
    () =>
      new Promise<string>(resolve => {
        finish = resolve
      })
  )

  const card = within(window.document.querySelector<HTMLElement>('[data-store-app]')!)
  const open = card.getByRole('button', { name: 'Open' })
  fireEvent.click(open)

  await waitFor(() => expect(open.hasAttribute('disabled')).toBe(true))
  // It says so, as the sidebar row does, rather than sitting there dead.
  expect(open.textContent).toBe('Opening chat…')
  fireEvent.click(open)
  expect(f.apps.chat).toHaveBeenCalledOnce()

  finish('!moon:test')
  await waitFor(() => expect(open.hasAttribute('disabled')).toBe(false))
  expect(open.textContent).toBe('Open')
  expect(f.fail).not.toHaveBeenCalled()

  // And again after a failure: the failure is the window's, and the card can be asked once more.
  f.apps.chat.mockRejectedValueOnce(new Error('matrix_app_bot_resting'))
  fireEvent.click(open)
  await waitFor(() => expect(f.fail).toHaveBeenCalledOnce())
  await waitFor(() => expect(open.hasAttribute('disabled')).toBe(false))
})

it('keeps the catalog notice for an app page a Store Open could not show', async () => {
  const f = fixture({ ...base, destination: { kind: 'discover' }, apps: { ...base.apps!, apps: [river] } })
  f.command.mockRejectedValueOnce(new Error('matrix_app_unavailable'))

  const card = within(window.document.querySelector<HTMLElement>('[data-store-app]')!)
  fireEvent.click(card.getByRole('button', { name: 'Open' }))

  // Not a passing toast: the notice and its Refresh stay until the person acts.
  const notice = await screen.findByText('Apps are unavailable right now.')
  expect(notice.closest('[role="status"]')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Refresh apps' })).toBeTruthy()
  expect(f.fail).not.toHaveBeenCalled()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('MatrixApps', () => {
  it('restores an app menu without opening a view or beginning a connection', async () => {
    const { apps, view } = fixture()

    await screen.findByRole('button', { name: 'Open River' })
    expect(apps.menu).toHaveBeenCalledWith(river.app_id)
    expect(apps.connection).toHaveBeenCalledWith(river.app_id, 'read')
    expect(apps.connection).not.toHaveBeenCalledWith(river.app_id, 'begin')
    expect(view.open).not.toHaveBeenCalled()
  })

  it('opens the injected native view only for an explicit menu route', async () => {
    const { apps, view } = fixture()

    fireEvent.click(await screen.findByRole('button', { name: 'Open River' }))
    await waitFor(() => expect(view.open).toHaveBeenCalledWith({ app: 'river', route_id: 'explore' }))
    expect(apps.connection).not.toHaveBeenCalledWith(river.app_id, 'begin')
  })

  it('hides a shortcut through Matrix account data without disconnecting the app', async () => {
    const { apps, command } = fixture()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove from sidebar' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'appShortcut', appId: river.app_id, visibility: 'hidden' })
    )
    expect(apps.connection).not.toHaveBeenCalledWith(river.app_id, 'disconnect')
  })

  it('detaches a launched guest for a room and retains it when returning to the app', async () => {
    const { fail, rendered, view } = fixture()

    fireEvent.click(await screen.findByRole('button', { name: 'Open River' }))
    await waitFor(() => expect(view.open).toHaveBeenCalledOnce())
    vi.mocked(view.setVisibility).mockClear()

    rendered.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixApps
          fail={fail}
          obstructed={false}
          snapshot={{ ...base, destination: { kind: 'room', roomId: '!room:test' } }}
        />
      </I18nProvider>
    )
    await waitFor(() =>
      expect(view.setVisibility).toHaveBeenCalledWith(expect.objectContaining({ viewId: 'river-view', visible: false }))
    )
    expect(view.close).not.toHaveBeenCalled()

    rendered.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixApps fail={fail} obstructed={false} snapshot={base} />
      </I18nProvider>
    )
    await waitFor(() =>
      expect(view.setVisibility).toHaveBeenCalledWith(expect.objectContaining({ viewId: 'river-view', visible: true }))
    )
    expect(view.open).toHaveBeenCalledOnce()
  })

  it('refuses launch for an unavailable catalog but retains explicit disconnect', async () => {
    const unavailable: MatrixSnapshot = {
      ...base,
      apps: { ...base.apps!, state: 'unavailable' }
    }

    const { apps, view } = fixture(unavailable)

    await screen.findByText('Apps are unavailable right now.')
    expect(apps.menu).not.toHaveBeenCalled()
    expect(view.open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(apps.connection).toHaveBeenCalledWith(river.app_id, 'disconnect'))
  })

  it('sends confirmation only after the person explicitly confirms', async () => {
    const confirming: MatrixSnapshot = {
      ...base,
      apps: {
        ...base.apps!,
        connections: {
          river: {
            phase: 'confirm',
            connection: { state: 'never_linked', connectionRequired: true, available: true, readiness: 'pending' }
          }
        }
      }
    }

    const { apps } = fixture(confirming)

    await screen.findByText('Connect this account?')
    expect(apps.connection).not.toHaveBeenCalledWith(river.app_id, 'confirm')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(apps.connection).toHaveBeenCalledWith(river.app_id, 'confirm'))
  })

  it('returns focus to the non-destructive app header without closing, launching, or linking', async () => {
    const { apps, rendered, returnToHost, view } = fixture()

    await screen.findByRole('button', { name: 'Open River' })
    vi.mocked(apps.connection).mockClear()
    act(returnToHost)

    expect(globalThis.document.activeElement).toBe(rendered.container.querySelector('[data-matrix-app-header]'))
    expect(view.close).not.toHaveBeenCalled()
    expect(view.open).not.toHaveBeenCalled()
    expect(apps.connection).not.toHaveBeenCalled()
  })
})

describe('apps for a person, not an operator', () => {
  it('gives a Discover card one Open and keeps the rest in a "…" that works before any preference is saved', async () => {
    const linked = { ...river, link: { ...river.link, state: 'linked' as const } }

    const f = fixture({
      ...base,
      destination: { kind: 'discover' },
      apps: { ...base.apps!, apps: [linked] },
      appShortcuts: undefined
    })

    const card = within(window.document.querySelector<HTMLElement>('[data-store-app]')!)
    expect(card.getByRole('button', { name: 'Open' })).toBeTruthy()
    expect(card.queryByRole('button', { name: 'New app chat' })).toBeNull()
    expect(card.queryByRole('button', { name: 'Add to sidebar' })).toBeNull()

    const more = card.getByRole('button', { name: 'More for River' })
    fireEvent.pointerDown(more, { button: 0 })
    const add = await screen.findByRole('menuitem', { name: 'Add to sidebar' })
    // No saved preference is "not added yet", never a disabled item with no reason.
    expect(add.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(add)
    await waitFor(() =>
      expect(f.command).toHaveBeenCalledWith({ kind: 'appShortcut', appId: river.app_id, visibility: 'shown' })
    )

    fireEvent.pointerDown(more, { button: 0 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove app from chats' }))
    await waitFor(() => expect(f.apps.withdraw).toHaveBeenCalledWith(river.app_id))

    fireEvent.pointerDown(more, { button: 0 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New shared app conversation' }))
    const name = await screen.findByRole('textbox', { name: 'Group name' })
    fireEvent.change(name, { target: { value: 'Team' } })
    fireEvent.submit(name.closest('form')!)
    await waitFor(() => expect(f.apps.group).toHaveBeenCalledWith(river.app_id, 'Team', 'en'))
  })

  it('says an app with nothing to show has no screens yet, with a real way back to the Store', async () => {
    const chatOnly = { ...river, has_surface: false }
    const f = fixture({ ...base, apps: { ...base.apps!, apps: [chatOnly] } })
    expect(await screen.findByText('This app has no screens yet.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(f.command).toHaveBeenCalledWith({ kind: 'discoverApps' }))
  })

  it('writes the way back to Atum as a Mac shortcut once a screen is open, and only then offers Close', async () => {
    fixture()
    await screen.findByRole('button', { name: 'Open River' })
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open River' }))
    expect(await screen.findByText('Return to Atum: ⌘⇧H')).toBeTruthy()
    expect(screen.queryByText(/Ctrl/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })
})
