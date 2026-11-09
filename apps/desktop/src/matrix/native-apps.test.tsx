import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $nativeAppRecency } from '@/store/native-app-recency'

import type { AppDescriptor } from '../../shared/app-catalog'
import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixNativeAppsBridge } from '../../shared/matrix-native-apps'
import type { NativeAppLaunchResult } from '../../shared/skills-launcher'

import { featuredLauncherTiles, type LauncherAtumApps, MatrixLauncherApps } from './native-apps'

const word = {
  id: 'word',
  name: 'Microsoft Word',
  bundleId: 'com.microsoft.Word',
  icon: 'data:image/png;base64,fixture'
}
const WORD_LABEL = 'Word'

const notes = { id: 'notes', name: 'Notes', bundleId: 'com.apple.Notes' }
const other = { id: 'other', name: 'Another app', bundleId: 'test.other' }

const moon: AppDescriptor = {
  app: 'moon',
  app_id: '00000000-0000-4000-8000-bd7662a5eeb4',
  app_version_id: '00000000-0000-4000-8000-b454f82c5857',
  name: { en: 'Moon' },
  subtitle: null,
  description: null,
  icon: null,
  accent: null,
  affiliation: null,
  verified: true,
  availability: 'available',
  roster_default: true,
  roster_order: 0,
  supported_modes: ['direct'],
  matrix_room_context: null,
  has_surface: true,
  link: { mode: 'none', state: 'never_linked' }
}

let atumApps: LauncherAtumApps

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@human:test', deviceId: 'D' },
  roomId: '!one:test',
  rooms: [],
  messages: [],
  error: null
}

const skills = [{ name: 'docx', enabled: true, description: 'Read Word', category: 'productivity' }]

const support = {
  runtime: { kind: 'local', generation: 'one' },
  commands: {},
  bundled: [],
  verified_bundled: ['docx'],
  routes: { docx: { operations: { read: { state: 'ready' as const, reasons: [] } } } }
}

let ended: (id: string) => void
let bridge: MatrixNativeAppsBridge
let stopped: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  // The "More" popover is positioned by Radix, which measures with ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  $nativeAppRecency.set({})
  stopped = vi.fn()
  bridge = {
    list: vi.fn(async () => [notes, word, other]),
    readiness: vi.fn(async () => ({ skills, support })),
    launch: vi.fn(async request => ({ id: request.requestId, app: word, status: 'beside' as const })),
    end: vi.fn(async () => {}),
    openArrangementSettings: vi.fn(async () => {}),
    onEnded(listener) {
      ended = listener

      return stopped
    }
  }
  Object.assign(window, { atumMatrix: { nativeApps: bridge } })
  atumApps = { apps: [moon], status: null, onOpen: vi.fn(), onStore: vi.fn() }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'atumMatrix')
  $nativeAppRecency.set({})
})

function frame(state = snapshot, active = true) {
  return (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixLauncherApps active={active} atumApps={atumApps} snapshot={state} />
    </I18nProvider>
  )
}

function openMore() {
  fireEvent.click(screen.getByRole('button', { name: 'More apps' }))

  return screen.getByRole('dialog', { name: 'More apps' })
}

const nativeLabels = (root: HTMLElement = window.document.body) =>
  Array.from(root.querySelectorAll('button[data-launcher-status]')).map(button => button.getAttribute('aria-label'))

async function ready() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: WORD_LABEL }).getAttribute('data-launcher-status')).toBe('ready')
  )
}

it('shows the Office apps Atum works in as tiles under "Apps" and every other Mac app behind "More"', async () => {
  render(frame())
  await ready()
  expect(screen.getByRole('heading', { name: 'Apps' })).toBeTruthy()
  // Only Word is a tile: Notes and the other app wait in the popover, not on the page.
  expect(nativeLabels()).toEqual([WORD_LABEL])
  expect(screen.getByRole('button', { name: WORD_LABEL }).querySelector('img')?.getAttribute('src')).toBe(word.icon)
  const more = openMore()
  expect(within(more).getByText('On this Mac')).toBeTruthy()
  expect(nativeLabels(more)).toEqual([other.name, notes.name])
  // A muted app still opens with one click; it is never a detour through a capability card.
  fireEvent.click(within(more).getByRole('button', { name: notes.name }))
  await waitFor(() =>
    expect(bridge.launch).toHaveBeenCalledWith(expect.objectContaining({ appId: notes.id, mode: 'beside' }))
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(await screen.findByText('Atum can’t read this app’s content yet.')).toBeTruthy()
})

it('keeps the other choices in a hover "…" on a tile and in the context menu of a "More" row', async () => {
  render(frame())
  await ready()
  const options = screen.getByRole('button', { name: 'Options for Word' })
  // Out of the grid's tab order: keyboard users have Shift-F10 on the tile itself.
  expect(options.getAttribute('tabindex')).toBe('-1')
  fireEvent.pointerDown(options, { button: 0 })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Open normally' }))
  await waitFor(() =>
    expect(bridge.launch).toHaveBeenCalledWith(expect.objectContaining({ appId: word.id, mode: 'normal' }))
  )
  await waitFor(() => expect(screen.getByRole('button', { name: WORD_LABEL }).hasAttribute('disabled')).toBe(false))
  fireEvent.contextMenu(within(openMore()).getByRole('button', { name: notes.name }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'App capability' }))
  expect((await screen.findByRole('dialog')).textContent).toContain('No supported skill')
  fireEvent.click(screen.getByRole('button', { name: 'Open normally' }))
  await waitFor(() =>
    expect(bridge.launch).toHaveBeenLastCalledWith(expect.objectContaining({ appId: notes.id, mode: 'normal' }))
  )
})

it('Enter in the "More" search requires a query, ignores composition and Option-Enter opens normally', async () => {
  render(frame())
  await ready()
  const search = within(openMore()).getByRole('textbox', { name: 'Search' })
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(bridge.launch).not.toHaveBeenCalled()
  // The search looks through every Mac app, the tiles' too.
  fireEvent.change(search, { target: { value: 'Word' } })
  fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
  expect(bridge.launch).not.toHaveBeenCalled()
  fireEvent.keyDown(search, { key: 'Enter', altKey: true })
  await waitFor(() =>
    expect(bridge.launch).toHaveBeenCalledWith(expect.objectContaining({ appId: word.id, mode: 'normal' }))
  )
})
it('searches Atum apps with the Mac apps, says when nothing matches, and opens Atum apps and the Store', async () => {
  render(frame())
  await ready()
  let more = openMore()
  const search = within(more).getByRole('textbox', { name: 'Search' })
  fireEvent.change(search, { target: { value: 'moo' } })
  expect(nativeLabels(more)).toEqual([])
  expect(within(more).queryByText('On this Mac')).toBeNull()
  fireEvent.change(search, { target: { value: 'zzz' } })
  expect(within(more).getByRole('status').textContent).toBe('No apps match your search.')
  fireEvent.change(search, { target: { value: '' } })
  fireEvent.click(within(more).getByRole('button', { name: 'Moon' }))
  expect(atumApps.onOpen).toHaveBeenCalledWith(moon)
  expect(screen.queryByRole('dialog', { name: 'More apps' })).toBeNull()
  more = openMore()
  fireEvent.click(within(more).getByRole('button', { name: 'Store' }))
  expect(atumApps.onStore).toHaveBeenCalledOnce()
})
it('keeps "More" without Mac apps: Atum apps, their catalog state, and the Store', () => {
  Object.assign(window, { atumMatrix: {} })
  atumApps = { apps: [], status: <p>Loading apps…</p>, onOpen: vi.fn() }
  render(frame())
  const more = openMore()
  expect(within(more).getByText('Loading apps…')).toBeTruthy()
  expect(within(more).queryByRole('textbox')).toBeNull()
  expect((within(more).getByRole('button', { name: 'Store' }) as HTMLButtonElement).disabled).toBe(true)
})
it('features the Office apps in suite order, else only the Mac apps this person opened from Atum', () => {
  const tile = (app: { id: string; name: string; bundleId: string }) => ({ id: `app:${app.id}`, app }) as never
  const excel = { id: 'excel', name: 'Microsoft Excel', bundleId: 'com.microsoft.Excel' }
  const ids = (tiles: { app: { id: string } }[]) => tiles.map(value => value.app.id)

  expect(ids(featuredLauncherTiles([tile(notes), tile(excel), tile(word)], {}))).toEqual(['word', 'excel'])
  expect(ids(featuredLauncherTiles([tile(notes), tile(other)], {}))).toEqual([])
  expect(ids(featuredLauncherTiles([tile(notes), tile(other)], { [other.bundleId]: 5 }))).toEqual(['other'])
})

it('Shift-F10 opens the existing context menu for a muted focused "More" row', async () => {
  render(frame())
  await ready()
  fireEvent.keyDown(within(openMore()).getByRole('button', { name: notes.name }), { key: 'F10', shiftKey: true })
  expect(await screen.findByRole('menuitem', { name: 'Open normally' })).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open normally' }))
  await waitFor(() =>
    expect(bridge.launch).toHaveBeenCalledWith(expect.objectContaining({ appId: notes.id, mode: 'normal' }))
  )
})

it('readiness failure leaves inventory and normal launch available with no fabricated ready tile', async () => {
  vi.mocked(bridge.readiness).mockRejectedValue(new Error('withdrawn'))
  render(frame())
  await waitFor(() =>
    expect(screen.getByRole('button', { name: WORD_LABEL }).getAttribute('data-launcher-status')).toBe('unavailable')
  )
  fireEvent.click(screen.getByRole('button', { name: WORD_LABEL }))
  await waitFor(() =>
    expect(bridge.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ appId: word.id, mode: 'beside' }))
  )
})
it('shows honest permission fallback; opening settings is an explicit second action', async () => {
  vi.mocked(bridge.launch).mockImplementation(async request => ({
    id: request.requestId,
    app: word,
    status: 'opened',
    reason: 'permission'
  }))
  render(frame())
  await ready()
  fireEvent.click(screen.getByRole('button', { name: WORD_LABEL }))
  expect(await screen.findByText(/Opened normally because window arrangement needs permission/)).toBeTruthy()
  expect(bridge.openArrangementSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Open Accessibility settings' }))
  expect(bridge.openArrangementSettings).toHaveBeenCalledOnce()
})
it('records accepted opens only, holds ordering until reopen and keeps other account history isolated', async () => {
  $nativeAppRecency.set({ '@other:test': { [other.bundleId]: 900 } })
  vi.mocked(bridge.launch).mockImplementation(async request => ({
    id: request.requestId,
    app: notes,
    status: 'opened'
  }))
  const view = render(frame())
  await ready()
  const row = within(openMore()).getByRole('button', { name: notes.name })
  fireEvent.focus(row)
  fireEvent.keyDown(row, { key: 'Enter', altKey: true })
  await waitFor(() => expect($nativeAppRecency.get()['@human:test']?.[notes.bundleId]).toBeGreaterThan(0))
  expect(nativeLabels(openMore())).toEqual([other.name, notes.name])
  expect($nativeAppRecency.get()['@other:test']).toEqual({ [other.bundleId]: 900 })
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'More apps' }), { key: 'Escape' })
  view.rerender(frame(snapshot, false))
  view.rerender(frame())
  await ready()
  // The Office tile keeps its place; only the popover's order follows use.
  expect(nativeLabels()).toEqual([WORD_LABEL])
  expect(nativeLabels(openMore())).toEqual([notes.name, other.name])
})

it('window-choice continuation uses the same request id and ignores the controller cleanup event', async () => {
  vi.mocked(bridge.launch).mockImplementation(async request => {
    if (request.windowId === undefined) {
      return { id: request.requestId, app: word, status: 'choose-window', windows: [{ id: 41, title: 'Document one' }] }
    }

    ended(request.requestId)

    return { id: request.requestId, app: word, status: 'beside' }
  })
  render(frame())
  await ready()
  fireEvent.click(screen.getByRole('button', { name: WORD_LABEL }))
  expect(await screen.findByRole('button', { name: 'Document one' })).toBeTruthy()
  expect($nativeAppRecency.get()['@human:test']).toBeUndefined()
  const first = vi.mocked(bridge.launch).mock.calls[0][0]
  fireEvent.click(screen.getByRole('button', { name: 'Document one' }))
  await screen.findByText(/Opened beside chat/)
  expect(bridge.launch).toHaveBeenLastCalledWith({ ...first, windowId: 41 })
  expect($nativeAppRecency.get()['@human:test']?.[word.bundleId]).toBeGreaterThan(0)
})
it('hiding preserves a paired app, explicit exit restores it, and unmount ends pending work', async () => {
  const view = render(frame())
  await ready()
  fireEvent.click(screen.getByRole('button', { name: WORD_LABEL }))
  await screen.findByText(/Opened beside chat/)
  const request = vi.mocked(bridge.launch).mock.calls[0][0]
  view.rerender(frame(snapshot, false))
  expect(bridge.end).not.toHaveBeenCalled()
  view.rerender(frame())
  const launches = vi.mocked(bridge.launch).mock.calls.length
  fireEvent.keyDown(screen.getByRole('button', { name: 'Exit side by side' }), { key: 'Enter' })
  expect(bridge.launch).toHaveBeenCalledTimes(launches)
  fireEvent.click(screen.getByRole('button', { name: 'Exit side by side' }))
  expect(bridge.end).toHaveBeenCalledWith(request.requestId)
  view.unmount()
  expect(stopped).toHaveBeenCalledOnce()
})
it.each(['room', 'account'])('retires %s-scoped pending results and never records their recency', async kind => {
  let release!: (value: NativeAppLaunchResult) => void
  vi.mocked(bridge.launch).mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve
      })
  )
  const view = render(frame())
  await ready()
  fireEvent.click(screen.getByRole('button', { name: WORD_LABEL }))
  const request = vi.mocked(bridge.launch).mock.calls[0][0]

  const next =
    kind === 'room'
      ? { ...snapshot, roomId: '!two:test' }
      : { ...snapshot, identity: { userId: '@other:test', deviceId: 'B' } }

  view.rerender(frame(next))
  expect(bridge.end).toHaveBeenCalledWith(request.requestId)
  await act(async () => release({ id: request.requestId, app: word, status: 'beside' }))
  expect(screen.queryByText(/Opened beside chat/)).toBeNull()
  expect($nativeAppRecency.get()['@human:test']).toBeUndefined()
})
it('inventory failure offers retry without claiming an empty or successful inventory', async () => {
  vi.mocked(bridge.list).mockRejectedValue(new Error('failed'))
  render(frame())
  expect(await screen.findByText('Could not complete that action. Try again.')).toBeTruthy()
  expect(screen.queryByText('No apps match your search.')).toBeNull()
})
