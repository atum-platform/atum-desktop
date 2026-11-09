import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const scopeAliases = vi.hoisted(() => new Map<string, string>())

const nativeDocument = vi.hoisted(() => ({
  associateNativeDocument: vi.fn(),
  clearNativeDocument: vi.fn(),
  startNativeDocumentLifecycle: vi.fn()
}))

vi.mock('./action-panel-owner', async () => {
  const { atom } = await import('nanostores')
  const $actionPanelOwner = atom<{ accountId: string } | null>({ accountId: 'a' })

  return { $actionPanelEpoch: atom(0), $actionPanelOwner, panelOwnerKey: () => $actionPanelOwner.get()?.accountId ?? 'pending' }
})
vi.mock('./workbench-tabs', async () => {
  const { atom } = await import('nanostores')

  return { $workbenchScope: atom('chat:a'), ATUM_CHAT_WORKBENCH_SCOPE_PREFIX: 'chat:', resolveCaptureScope: (scope: string) => scopeAliases.get(scope) ?? scope }
})
vi.mock('./windows', () => ({ ownsActionPanel: () => true }))
vi.mock('./native-document', () => nativeDocument)

import { $actionPanelEpoch, $actionPanelOwner } from './action-panel-owner'
import { $nativeAppRecency } from './native-app-recency'
import { $nativeApps, endNativeApp, launchNativeApp, openNativeAppDocument, refreshNativeApps } from './native-apps'
import { $workbenchScope } from './workbench-tabs'

const app = { id: 'app', name: 'App', bundleId: 'test.app' }
const launch = vi.fn()
const end = vi.fn(async () => undefined)
const list = vi.fn(async () => [app])
const original = window.hermesDesktop

beforeEach(() => {
  scopeAliases.clear()
  vi.clearAllMocks()
  nativeDocument.associateNativeDocument.mockResolvedValue(undefined)
  window.hermesDesktop = { nativeApps: { list, launch, end, onEnded: () => () => undefined } } as never
  $workbenchScope.set('chat:a')
  $actionPanelEpoch.set(0)
  $actionPanelOwner.set({ accountId: 'a' } as never)
  $nativeApps.set({ apps: [], loading: false, error: null, result: null, scopeKey: '' })
  $nativeAppRecency.set({})
})
afterEach(async () => { await endNativeApp(); window.hermesDesktop = original })

it('uses cached discovery on drawer open and explicit refresh when requested', async () => {
  await refreshNativeApps(false)
  expect(list).toHaveBeenLastCalledWith(false)
  expect($nativeApps.get().apps).toEqual([app])
  await refreshNativeApps()
  expect(list).toHaveBeenLastCalledWith(true)
})

it('reissues a cached launcher refresh once the parent adopts its requested scope', async () => {
  let finish!: (value: typeof app[]) => void
  list.mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))

  const pending = refreshNativeApps(false, 'chat:b')

  expect($nativeApps.get()).toMatchObject({ loading: true, scopeKey: 'chat:b' })
  $workbenchScope.set('chat:b')

  expect(list).toHaveBeenNthCalledWith(1, false)
  expect(list).toHaveBeenNthCalledWith(2, false)
  finish([app])
  await pending

  expect($nativeApps.get()).toMatchObject({ apps: [app], loading: false, scopeKey: 'chat:b' })
})

it('can launch an app while the assistant capability handshake is unavailable', async () => {
  $actionPanelOwner.set(null)
  launch.mockImplementationOnce(async request => ({ id: request.requestId, app, status: 'opened' }))
  await expect(launchNativeApp(app, 'chat:a', { normal: true })).resolves.toMatchObject({ status: 'opened' })
  expect(launch).toHaveBeenCalledOnce()
})

it('ends a pending launch on conversation change and rejects its late result', async () => {
  let finish!: (value: unknown) => void
  launch.mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
  const pending = launchNativeApp(app, 'chat:a')
  const request = launch.mock.calls[0][0]
  $workbenchScope.set('chat:b')
  expect(end).toHaveBeenCalledWith(request.requestId)
  finish({ id: request.requestId, app, status: 'beside' })
  await expect(pending).resolves.toBeNull()
  expect($nativeApps.get().result).toBeNull()
  expect($nativeAppRecency.get()).toEqual({})
})

it('does not publish a launch or inventory reply after the account epoch changes', async () => {
  let finish!: (value: typeof app[]) => void
  list.mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
  const pending = refreshNativeApps()
  $actionPanelEpoch.set(1)
  finish([app])
  await pending
  expect($nativeApps.get().apps).toEqual([])
  expect($nativeApps.get().loading).toBe(false)
  await expect(launchNativeApp(app, 'chat:other')).resolves.toBeNull()
  expect(launch).not.toHaveBeenCalled()
})

it('keeps the newer launch result when an older request finishes last', async () => {
  let finish!: (value: unknown) => void
  launch.mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
  const pending = launchNativeApp(app, 'chat:a')
  const oldRequest = launch.mock.calls[0][0]
  launch.mockImplementationOnce(async request => ({ id: request.requestId, app, status: 'opened' }))
  const newer = await launchNativeApp(app, 'chat:a', { normal: true })
  finish({ id: oldRequest.requestId, app, status: 'beside' })
  await pending
  expect(end).toHaveBeenCalledWith(oldRequest.requestId)
  expect($nativeApps.get().result).toEqual(newer)
})

it('mints saved-file context only after a terminal native document launch', async () => {
  launch.mockImplementationOnce(async request => ({ id: request.requestId, app, status: 'opened' }))

  await expect(openNativeAppDocument(app, '/home/example/Documents/Budget.xlsx', 'chat:a')).resolves.toMatchObject({ status: 'opened' })
  expect(nativeDocument.associateNativeDocument).toHaveBeenCalledWith(expect.any(String), '/home/example/Documents/Budget.xlsx', 'chat:a')
  expect($nativeApps.get()).toMatchObject({ documentPath: '/home/example/Documents/Budget.xlsx', documentContextError: undefined })
})

it('keeps a terminally launched app open when its saved-file card grant is refused', async () => {
  launch.mockImplementationOnce(async request => ({ id: request.requestId, app, status: 'opened' }))
  nativeDocument.associateNativeDocument.mockRejectedValueOnce(new Error('CONSUMER_FILES_OUTSIDE_HOME'))

  await expect(openNativeAppDocument(app, '/home/example/Documents/Budget.xlsx', 'chat:a')).resolves.toMatchObject({ status: 'opened' })
  expect($nativeApps.get()).toMatchObject({ documentContextError: 'CONSUMER_FILES_OUTSIDE_HOME', documentPath: '/home/example/Documents/Budget.xlsx' })
  expect(end).not.toHaveBeenCalled()
})

it('keeps a completed native file association when its draft is promoted to its own chat', async () => {
  launch.mockImplementationOnce(async request => ({ id: request.requestId, app, status: 'beside' }))
  await openNativeAppDocument(app, '/home/example/Deck.pptx', 'chat:a')
  end.mockClear()
  nativeDocument.clearNativeDocument.mockClear()
  scopeAliases.set('chat:a', 'chat:promoted')
  $workbenchScope.set('chat:promoted')
  expect($nativeApps.get()).toMatchObject({ scopeKey: 'chat:promoted', documentPath: '/home/example/Deck.pptx', result: { status: 'beside' } })
  expect(end).not.toHaveBeenCalled()
  expect(nativeDocument.clearNativeDocument).not.toHaveBeenCalled()
})


it('mints a file grant only after choosing a window and preserves its request and document', async () => {
  launch.mockImplementationOnce(async request => ({ id: request.requestId, app, status: 'choose-window', windows: [{ id: 42, title: 'Workbook' }] }))
  const choice = await openNativeAppDocument(app, '/home/example/Documents/Budget.xlsx', 'chat:a')
  expect(nativeDocument.associateNativeDocument).not.toHaveBeenCalled()
  expect($nativeAppRecency.get()).toEqual({})
  launch.mockImplementationOnce(async request => ({ id: request.requestId, app, status: 'beside' }))
  await launchNativeApp(app, 'chat:a', { windowId: 42 })
  expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: choice?.id, documentPath: '/home/example/Documents/Budget.xlsx', windowId: 42 }))
  expect(nativeDocument.associateNativeDocument).toHaveBeenCalledExactlyOnceWith(choice?.id, '/home/example/Documents/Budget.xlsx', 'chat:a')
  expect($nativeAppRecency.get().a?.[app.bundleId]).toBeGreaterThan(0)
})

it('records accepted normal and beside opens but not failed launches or another account’s late reply', async () => {
  launch.mockRejectedValueOnce(new Error('launch failed'))
  await launchNativeApp(app, 'chat:a')
  expect($nativeAppRecency.get()).toEqual({})

  launch.mockImplementationOnce(async request => ({ id: request.requestId, app, status: 'opened' }))
  await launchNativeApp(app, 'chat:a', { normal: true })
  const used = $nativeAppRecency.get().a?.[app.bundleId]
  expect(used).toBeGreaterThan(0)

  let finish!: (value: unknown) => void
  launch.mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
  const pending = launchNativeApp(app, 'chat:a')
  $actionPanelOwner.set({ accountId: 'b' } as never)
  finish({ id: 'late', app, status: 'beside' })
  await pending
  expect($nativeAppRecency.get()).toEqual({ a: { [app.bundleId]: used } })

  launch.mockImplementationOnce(async request => ({ id: request.requestId, app, status: 'beside' }))
  await launchNativeApp(app, 'chat:a')
  expect($nativeAppRecency.get().b?.[app.bundleId]).toBeGreaterThan(0)
})
